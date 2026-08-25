/**
 * Parser for `.reqrunner` documents.
 *
 * Grammar (deliberately forgiving):
 *
 *   ###  <optional request name>
 *   @name = value                 <- optional block variables
 *   GET https://host/path         <- request line (method optional, defaults to GET)
 *   Header-Name: value            <- zero or more headers
 *                                 <- first non-header, non-blank line starts the body
 *   { "json": true }
 *
 * Blank lines and `//` / `#` comment lines are ignored until the body begins,
 * which is what allows the spaced-out style from the README to parse the same
 * way as the compact `.http` style.
 */
import { ParsedDocument, ParsedHeader, ParsedRequest, SUPPORTED_METHODS } from './types';

const SEPARATOR_RE = /^[ \t]*###(.*)$/;
const COMMENT_RE = /^[ \t]*(?:\/\/|#(?!##))/;
const VARIABLE_DEF_RE = /^[ \t]*@([A-Za-z0-9_.-]+)[ \t]*=[ \t]*(.*)$/;
const REQUEST_LINE_RE = /^[ \t]*([A-Za-z]+)[ \t]+(.+?)(?:[ \t]+HTTP\/[0-9.]+)?[ \t]*$/;
const BARE_URL_RE = /^[ \t]*(\S+)[ \t]*$/;
// A header name is HTTP token characters, but a `{{variable}}` may stand in for
// any part of it. Requiring a doubled brace keeps a JSON body line such as
// `{"a": 1}` from being mistaken for a header.
const HEADER_RE =
  /^[ \t]*((?:\{\{[^{}]*\}\}|[A-Za-z0-9])(?:\{\{[^{}]*\}\}|[A-Za-z0-9_.-])*)[ \t]*:[ \t]*(.*)$/;

const METHODS: ReadonlySet<string> = new Set<string>(SUPPORTED_METHODS);

/** Splits text into lines, tolerating CRLF and CR line endings. */
export function splitLines(text: string): string[] {
  return text.split(/\r\n|\n|\r/);
}

/** True when the line looks like something that could be a URL or URL template. */
function looksLikeUrl(value: string): boolean {
  return (
    /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(value) ||
    value.startsWith('{{') ||
    value.startsWith('/')
  );
}

/**
 * A bare URL on its own line matches the header pattern (`http` + `:` + `//x`).
 * Reject that specific shape so a text body containing only a URL is not eaten
 * as a header.
 */
function isSchemeLookingHeader(name: string, value: string): boolean {
  return value.startsWith('//') && /^https?$/i.test(name);
}

interface BlockRange {
  /** Zero-based line of the `###` separator, or -1 for an implicit leading block. */
  separatorLine: number;
  /** Name captured from the separator line (already trimmed). */
  name: string;
  /** Zero-based index of the first content line. */
  from: number;
  /** Zero-based index after the last content line. */
  to: number;
}

/** Parses a `.reqrunner` document. Never throws: problems land in `errors`. */
export function parseDocument(text: string): ParsedDocument {
  const lines = splitLines(text);
  const fileVariables: Record<string, string> = {};
  const blocks: BlockRange[] = [];

  // Locate every separator line first so each block gets an exact line range.
  const separatorIndexes: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (SEPARATOR_RE.test(lines[i])) {
      separatorIndexes.push(i);
    }
  }

  const firstSeparator = separatorIndexes.length > 0 ? separatorIndexes[0] : lines.length;

  // Everything before the first `###` is the preamble: file-level variables,
  // comments, and optionally one implicit request for single-request files.
  let preambleHasRequest = false;
  for (let i = 0; i < firstSeparator; i++) {
    const line = lines[i];
    if (line.trim() === '' || COMMENT_RE.test(line)) {
      continue;
    }
    const varMatch = VARIABLE_DEF_RE.exec(line);
    if (varMatch) {
      fileVariables[varMatch[1]] = varMatch[2].trim();
      continue;
    }
    preambleHasRequest = true;
    break;
  }

  if (preambleHasRequest) {
    blocks.push({ separatorLine: -1, name: '', from: 0, to: firstSeparator });
  }

  for (let s = 0; s < separatorIndexes.length; s++) {
    const separatorLine = separatorIndexes[s];
    const nextSeparator =
      s + 1 < separatorIndexes.length ? separatorIndexes[s + 1] : lines.length;
    const nameMatch = SEPARATOR_RE.exec(lines[separatorLine]);
    blocks.push({
      separatorLine,
      // Strip decorative trailing hashes, e.g. `### Get users ###`.
      name: (nameMatch ? nameMatch[1] : '').replace(/#+[ \t]*$/, '').trim(),
      from: separatorLine + 1,
      to: nextSeparator
    });
  }

  const requests = blocks.map((block, index) =>
    parseBlock(lines, block, index, fileVariables)
  );

  return { requests, fileVariables };
}

function parseBlock(
  lines: string[],
  block: BlockRange,
  index: number,
  fileVariables: Record<string, string>
): ParsedRequest {
  const variables: Record<string, string> = {};
  const headers: ParsedHeader[] = [];
  const errors: string[] = [];

  let method = '';
  let url = '';
  let requestLine = -1;
  let bodyStart = -1;

  // Phase 1: variables and comments until the request line.
  let i = block.from;
  for (; i < block.to; i++) {
    const line = lines[i];
    if (line.trim() === '' || COMMENT_RE.test(line)) {
      continue;
    }
    const varMatch = VARIABLE_DEF_RE.exec(line);
    if (varMatch) {
      variables[varMatch[1]] = varMatch[2].trim();
      continue;
    }

    requestLine = i;
    const parsed = parseRequestLine(line);
    method = parsed.method;
    url = parsed.url;
    if (parsed.error) {
      errors.push(parsed.error);
    }
    i++;
    break;
  }

  if (requestLine === -1) {
    errors.push('No request line found. Expected something like `GET https://example.com`.');
  }

  // Phase 2: headers, then everything else is the body.
  for (; i < block.to; i++) {
    const line = lines[i];
    if (line.trim() === '') {
      continue;
    }
    if (COMMENT_RE.test(line)) {
      continue;
    }
    const varMatch = VARIABLE_DEF_RE.exec(line);
    if (varMatch) {
      variables[varMatch[1]] = varMatch[2].trim();
      continue;
    }
    const headerMatch = HEADER_RE.exec(line);
    if (headerMatch && !isSchemeLookingHeader(headerMatch[1], headerMatch[2])) {
      headers.push({ name: headerMatch[1], value: headerMatch[2].trim(), line: i });
      continue;
    }
    bodyStart = i;
    break;
  }

  let body: string | undefined;
  if (bodyStart !== -1) {
    let bodyEnd = block.to - 1;
    while (bodyEnd > bodyStart && lines[bodyEnd].trim() === '') {
      bodyEnd--;
    }
    const raw = lines.slice(bodyStart, bodyEnd + 1).join('\n');
    body = raw.trim() === '' ? undefined : raw;
  }

  // Trim trailing blank lines from the block range so folding / reveal ranges
  // do not include the gap before the next `###`.
  let endLine = block.to - 1;
  const rangeStart = block.separatorLine === -1 ? block.from : block.separatorLine;
  while (endLine > rangeStart && (lines[endLine] === undefined || lines[endLine].trim() === '')) {
    endLine--;
  }

  const name = block.name || defaultName(method, url, index);

  return {
    index,
    name,
    method,
    url,
    headers,
    body,
    startLine: rangeStart,
    endLine: Math.max(endLine, rangeStart),
    requestLine,
    variables: { ...fileVariables, ...variables },
    errors
  };
}

function parseRequestLine(line: string): { method: string; url: string; error?: string } {
  const match = REQUEST_LINE_RE.exec(line);
  if (match) {
    const candidate = match[1].toUpperCase();
    const rest = match[2].trim();
    if (METHODS.has(candidate)) {
      if (rest === '') {
        return { method: candidate, url: '', error: 'Request line is missing a URL.' };
      }
      return { method: candidate, url: rest };
    }
    // The first token is not a method we support. Only call it a bad method when
    // what follows actually looks like a URL, so that a line of prose does not
    // produce a confusing "unsupported method" message.
    if (looksLikeUrl(rest) && !looksLikeUrl(line.trim())) {
      return {
        method: '',
        url: '',
        error:
          `Unsupported HTTP method "${match[1]}". ` +
          `Use one of: ${SUPPORTED_METHODS.join(', ')}.`
      };
    }
  }

  const bare = BARE_URL_RE.exec(line);
  if (bare && looksLikeUrl(bare[1])) {
    // No method given: default to GET, which matches how `.http` files behave.
    return { method: 'GET', url: bare[1] };
  }

  return {
    method: '',
    url: '',
    error: `Could not read a request line from "${line.trim()}".`
  };
}

function defaultName(method: string, url: string, index: number): string {
  if (method && url) {
    return `${method} ${url}`;
  }
  return `Request ${index + 1}`;
}

/** True when the block has enough information to be sent. */
export function isSendable(request: ParsedRequest): boolean {
  return request.errors.length === 0 && request.method !== '' && request.url !== '';
}

/**
 * Returns the request whose block contains `line`, preferring the block the
 * cursor is inside. Falls back to the last block that starts at or before the
 * line so a cursor in the trailing whitespace still resolves.
 */
export function findRequestAtLine(
  doc: ParsedDocument,
  line: number
): ParsedRequest | undefined {
  let candidate: ParsedRequest | undefined;
  for (const request of doc.requests) {
    if (request.startLine <= line) {
      candidate = request;
    }
  }
  return candidate;
}
