/**
 * HTTP execution built on Node's native `http` / `https` modules.
 *
 * No third-party HTTP client is used. Responses with any status code (including
 * 4xx and 5xx) resolve normally; only transport-level problems reject, and they
 * always reject with an {@link HttpError} so callers can render a clean message
 * instead of leaking a raw Node error.
 */
import * as http from 'http';
import * as https from 'https';
import * as zlib from 'zlib';
import { HttpErrorKind, HttpRequestOptions, HttpResponse } from './types';

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_REDIRECTS = 5;
const USER_AGENT = 'ReqRunner/1.0 (VS Code)';

/** Transport failure. Carries a coarse `kind` plus the original Node error code. */
export class HttpError extends Error {
  public readonly kind: HttpErrorKind;
  public readonly code?: string;

  public constructor(kind: HttpErrorKind, message: string, code?: string) {
    super(message);
    this.name = 'HttpError';
    this.kind = kind;
    this.code = code;
  }
}

/**
 * Methods that must never carry a request body. Only HEAD is listed: if the
 * author wrote a body under any other method, honour it rather than silently
 * dropping it.
 */
const BODYLESS_METHODS = new Set(['HEAD']);

/** Status codes that trigger a redirect when following is enabled. */
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

function headerLookup(
  headers: Record<string, string>,
  name: string
): string | undefined {
  return headers[name.toLowerCase()];
}

function hasHeader(headers: Record<string, string> | undefined, name: string): boolean {
  if (!headers) {
    return false;
  }
  const target = name.toLowerCase();
  return Object.keys(headers).some((key) => key.toLowerCase() === target);
}

/** Validates and normalises the target URL. */
export function parseRequestUrl(rawUrl: string): URL {
  const trimmed = (rawUrl ?? '').trim();
  if (trimmed === '') {
    throw new HttpError('invalid-url', 'The request URL is empty.');
  }

  let candidate = trimmed;
  if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(candidate)) {
    // Bare host or path: assume https rather than failing outright.
    candidate = `https://${candidate.replace(/^\/+/, '')}`;
  }

  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    throw new HttpError('invalid-url', `"${trimmed}" is not a valid URL.`);
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new HttpError(
      'unsupported-protocol',
      `Protocol "${url.protocol}" is not supported. Use http:// or https://.`
    );
  }
  if (url.hostname === '') {
    throw new HttpError('invalid-url', `"${trimmed}" is missing a host name.`);
  }
  return url;
}

/** Decompresses a payload according to `Content-Encoding`. Falls back to raw bytes. */
function decompress(buffer: Buffer, encoding: string | undefined): Buffer {
  if (!encoding || buffer.length === 0) {
    return buffer;
  }
  // Only the last applied encoding matters for the common single-encoding case.
  const scheme = encoding.split(',').map((part) => part.trim().toLowerCase()).pop();
  try {
    switch (scheme) {
      case 'gzip':
      case 'x-gzip':
        return zlib.gunzipSync(buffer);
      case 'deflate':
        return zlib.inflateSync(buffer);
      case 'br':
        return zlib.brotliDecompressSync(buffer);
      default:
        return buffer;
    }
  } catch {
    // A truncated or mislabelled body should still be shown, not swallowed.
    return buffer;
  }
}

/** True when the content type describes something we should not render as text. */
function isBinaryContentType(contentType: string | undefined): boolean {
  if (!contentType) {
    return false;
  }
  const value = contentType.toLowerCase();
  if (
    value.startsWith('text/') ||
    value.includes('json') ||
    value.includes('xml') ||
    value.includes('javascript') ||
    value.includes('x-www-form-urlencoded') ||
    value.includes('csv')
  ) {
    return false;
  }
  return (
    value.startsWith('image/') ||
    value.startsWith('audio/') ||
    value.startsWith('video/') ||
    value.startsWith('font/') ||
    value.includes('octet-stream') ||
    value.includes('pdf') ||
    value.includes('zip')
  );
}

function decodeBody(
  buffer: Buffer,
  contentType: string | undefined
): { body: string; isBinary: boolean } {
  if (isBinaryContentType(contentType)) {
    return {
      body: `<binary ${contentType ?? 'content'}, ${buffer.length} bytes not displayed>`,
      isBinary: true
    };
  }

  const charsetMatch = contentType ? /charset=["']?([\w-]+)/i.exec(contentType) : null;
  const charset = charsetMatch ? charsetMatch[1].toLowerCase() : 'utf-8';
  const encoding: BufferEncoding =
    charset === 'utf-8' || charset === 'utf8'
      ? 'utf8'
      : charset === 'iso-8859-1' || charset === 'latin1' || charset === 'ascii'
        ? 'latin1'
        : charset === 'utf-16le' || charset === 'utf-16'
          ? 'utf16le'
          : 'utf8';

  try {
    return { body: buffer.toString(encoding), isBinary: false };
  } catch {
    return { body: buffer.toString('utf8'), isBinary: false };
  }
}

function normaliseHeaders(
  incoming: http.IncomingHttpHeaders
): { headers: Record<string, string>; rawHeaders: Array<[string, string]> } {
  const headers: Record<string, string> = {};
  const rawHeaders: Array<[string, string]> = [];
  for (const [name, value] of Object.entries(incoming)) {
    if (value === undefined) {
      continue;
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        rawHeaders.push([name, item]);
      }
      headers[name.toLowerCase()] = value.join(', ');
    } else {
      rawHeaders.push([name, value]);
      headers[name.toLowerCase()] = value;
    }
  }
  return { headers, rawHeaders };
}

/** Maps a Node socket/DNS error onto a message a developer can act on. */
function toHttpError(error: NodeJS.ErrnoException, url: URL): HttpError {
  const code = error.code;
  switch (code) {
    case 'ENOTFOUND':
    case 'EAI_AGAIN':
      return new HttpError(
        'network',
        `Host not found: ${url.hostname}. Check the URL or your network connection.`,
        code
      );
    case 'ECONNREFUSED':
      return new HttpError(
        'network',
        `Connection refused by ${url.host}. Is the server running?`,
        code
      );
    case 'ECONNRESET':
      return new HttpError('network', `Connection reset by ${url.host}.`, code);
    case 'EPIPE':
      return new HttpError('network', `Connection closed while sending to ${url.host}.`, code);
    case 'ETIMEDOUT':
      return new HttpError('timeout', `Connection to ${url.host} timed out.`, code);
    case 'CERT_HAS_EXPIRED':
    case 'DEPTH_ZERO_SELF_SIGNED_CERT':
    case 'SELF_SIGNED_CERT_IN_CHAIN':
    case 'UNABLE_TO_VERIFY_LEAF_SIGNATURE':
      return new HttpError(
        'network',
        `TLS certificate for ${url.host} could not be verified (${code}). ` +
          'Set "reqrunner.rejectUnauthorized" to false for trusted local servers.',
        code
      );
    default:
      return new HttpError(
        'network',
        error.message || `Request to ${url.host} failed.`,
        code
      );
  }
}

/**
 * Resolves a redirect target and decides which method/body carry over.
 * Returns `undefined` when the response is not a followable redirect.
 */
function resolveRedirect(
  status: number,
  location: string | undefined,
  currentUrl: URL,
  method: string,
  body: string | undefined
): { url: URL; method: string; body: string | undefined } | undefined {
  if (!REDIRECT_STATUSES.has(status) || !location) {
    return undefined;
  }
  let target: URL;
  try {
    target = new URL(location, currentUrl);
  } catch {
    return undefined;
  }
  if (target.protocol !== 'http:' && target.protocol !== 'https:') {
    return undefined;
  }
  // 303 always downgrades to GET; 301/302 do so for non-GET/HEAD by convention.
  const downgrade =
    status === 303 || ((status === 301 || status === 302) && method !== 'GET' && method !== 'HEAD');
  return {
    url: target,
    method: downgrade ? 'GET' : method,
    body: downgrade ? undefined : body
  };
}

/** Performs a single request without following redirects. */
function performRequest(options: {
  url: URL;
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
  timeoutMs: number;
  rejectUnauthorized: boolean;
}): Promise<{
  status: number;
  statusText: string;
  httpVersion: string;
  headers: Record<string, string>;
  rawHeaders: Array<[string, string]>;
  buffer: Buffer;
}> {
  const { url, method, headers, body, timeoutMs, rejectUnauthorized } = options;
  const isHttps = url.protocol === 'https:';
  const transport = isHttps ? https : http;

  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn: () => void): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      fn();
    };

    const requestOptions: https.RequestOptions = {
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port !== '' ? Number(url.port) : isHttps ? 443 : 80,
      path: `${url.pathname}${url.search}`,
      method,
      headers
    };
    if (isHttps) {
      requestOptions.rejectUnauthorized = rejectUnauthorized;
    }

    let request: http.ClientRequest;
    // Guard the whole exchange, including a slow body, not just connect time.
    const timer = setTimeout(() => {
      finish(() => {
        request?.destroy();
        reject(
          new HttpError(
            'timeout',
            `Request timed out after ${timeoutMs} ms.`,
            'ETIMEDOUT'
          )
        );
      });
    }, timeoutMs);

    try {
      request = transport.request(requestOptions, (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => {
          chunks.push(chunk);
        });
        response.on('error', (error: NodeJS.ErrnoException) => {
          finish(() => reject(toHttpError(error, url)));
        });
        response.on('end', () => {
          const { headers: normalised, rawHeaders } = normaliseHeaders(response.headers);
          finish(() =>
            resolve({
              status: response.statusCode ?? 0,
              statusText: response.statusMessage ?? '',
              httpVersion: response.httpVersion ?? '1.1',
              headers: normalised,
              rawHeaders,
              buffer: Buffer.concat(chunks)
            })
          );
        });
      });
    } catch (error) {
      finish(() => reject(toHttpError(error as NodeJS.ErrnoException, url)));
      return;
    }

    request.on('error', (error: NodeJS.ErrnoException) => {
      finish(() => reject(toHttpError(error, url)));
    });

    request.setTimeout(timeoutMs, () => {
      finish(() => {
        request.destroy();
        reject(
          new HttpError('timeout', `Request timed out after ${timeoutMs} ms.`, 'ETIMEDOUT')
        );
      });
    });

    if (body !== undefined && body !== '' && !BODYLESS_METHODS.has(method)) {
      request.write(body, 'utf8');
    }
    request.end();
  });
}

/** Sends a request and returns the full response. Rejects only on transport errors. */
export async function sendHttpRequest(
  options: HttpRequestOptions
): Promise<HttpResponse> {
  const method = (options.method || 'GET').toUpperCase();
  const timeoutMs =
    typeof options.timeoutMs === 'number' && options.timeoutMs > 0
      ? options.timeoutMs
      : DEFAULT_TIMEOUT_MS;
  const followRedirects = options.followRedirects !== false;
  const maxRedirects =
    typeof options.maxRedirects === 'number' && options.maxRedirects >= 0
      ? options.maxRedirects
      : DEFAULT_MAX_REDIRECTS;
  const rejectUnauthorized = options.rejectUnauthorized !== false;

  let url = parseRequestUrl(options.url);
  let currentMethod = method;
  let currentBody = options.body;

  const baseHeaders: Record<string, string> = {};
  for (const [name, value] of Object.entries(options.headers ?? {})) {
    baseHeaders[name] = value;
  }
  if (!hasHeader(baseHeaders, 'user-agent')) {
    baseHeaders['User-Agent'] = USER_AGENT;
  }
  if (!hasHeader(baseHeaders, 'accept')) {
    baseHeaders['Accept'] = '*/*';
  }

  const redirects: string[] = [];
  const startedAt = process.hrtime.bigint();

  for (let attempt = 0; ; attempt++) {
    const headers: Record<string, string> = { ...baseHeaders };
    if (!hasHeader(headers, 'host')) {
      headers['Host'] = url.host;
    } else {
      // A manual Host header from a previous hop must not leak across redirects.
      for (const key of Object.keys(headers)) {
        if (key.toLowerCase() === 'host' && attempt > 0) {
          headers[key] = url.host;
        }
      }
    }

    const sendsBody =
      currentBody !== undefined && currentBody !== '' && !BODYLESS_METHODS.has(currentMethod);
    if (sendsBody) {
      if (!hasHeader(headers, 'content-length')) {
        headers['Content-Length'] = String(Buffer.byteLength(currentBody!, 'utf8'));
      }
      if (!hasHeader(headers, 'content-type')) {
        headers['Content-Type'] = 'text/plain; charset=utf-8';
      }
    } else {
      for (const key of Object.keys(headers)) {
        const lower = key.toLowerCase();
        if (lower === 'content-length' || lower === 'transfer-encoding') {
          delete headers[key];
        }
      }
    }

    const result = await performRequest({
      url,
      method: currentMethod,
      headers,
      body: sendsBody ? currentBody : undefined,
      timeoutMs,
      rejectUnauthorized
    });

    if (followRedirects) {
      const next = resolveRedirect(
        result.status,
        headerLookup(result.headers, 'location'),
        url,
        currentMethod,
        currentBody
      );
      if (next) {
        if (attempt >= maxRedirects) {
          throw new HttpError(
            'too-many-redirects',
            `Stopped after ${maxRedirects} redirect(s). Last location: ${next.url.href}`
          );
        }
        redirects.push(url.href);
        url = next.url;
        currentMethod = next.method;
        currentBody = next.body;
        continue;
      }
    }

    const timeMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
    const decompressed = decompress(
      result.buffer,
      headerLookup(result.headers, 'content-encoding')
    );
    const contentType = headerLookup(result.headers, 'content-type');
    const decoded = decodeBody(decompressed, contentType);

    return {
      method: currentMethod,
      url: url.href,
      status: result.status,
      statusText: result.statusText,
      httpVersion: result.httpVersion,
      headers: result.headers,
      rawHeaders: result.rawHeaders,
      body: decoded.body,
      isBinary: decoded.isBinary,
      sizeBytes: decompressed.length,
      timeMs: Math.round(timeMs * 100) / 100,
      redirects
    };
  }
}
