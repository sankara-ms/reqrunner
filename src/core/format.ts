/**
 * Presentation helpers shared by the webview and the status bar.
 * Kept free of `vscode` so they can be unit tested directly.
 */

export type BodyLanguage = 'json' | 'xml' | 'html' | 'text';

export interface FormattedBody {
  text: string;
  language: BodyLanguage;
  /** True when the text was re-indented (valid JSON only). */
  prettified: boolean;
  /** Set when the payload claimed to be JSON but could not be parsed. */
  warning?: string;
}

/** Guesses the payload language from the content type and the text itself. */
function detectLanguage(body: string, contentType: string | undefined): BodyLanguage {
  const type = (contentType ?? '').toLowerCase();
  if (type.includes('json')) {
    return 'json';
  }
  if (type.includes('html')) {
    return 'html';
  }
  if (type.includes('xml')) {
    return 'xml';
  }

  const trimmed = body.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    return 'json';
  }
  if (trimmed.startsWith('<?xml')) {
    return 'xml';
  }
  if (/^<!doctype html/i.test(trimmed) || trimmed.startsWith('<html')) {
    return 'html';
  }
  return 'text';
}

/**
 * Pretty-prints a response body when it is valid JSON, otherwise returns it
 * untouched. Invalid JSON is reported through `warning` rather than thrown, so a
 * malformed payload still gets displayed.
 */
export function formatBody(
  body: string,
  contentType?: string
): FormattedBody {
  const language = detectLanguage(body, contentType);

  if (language !== 'json' || body.trim() === '') {
    return { text: body, language, prettified: false };
  }

  try {
    const parsed: unknown = JSON.parse(body);
    return { text: JSON.stringify(parsed, null, 2), language: 'json', prettified: true };
  } catch (error) {
    const claimedJson = (contentType ?? '').toLowerCase().includes('json');
    return {
      text: body,
      language: claimedJson ? 'json' : 'text',
      prettified: false,
      warning: claimedJson
        ? `Response declared JSON but could not be parsed: ${
            error instanceof Error ? error.message : String(error)
          }`
        : undefined
    };
  }
}

/** Human readable byte size. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) {
    return '0 B';
  }
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

/** Human readable duration. */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) {
    return '0 ms';
  }
  if (ms < 1000) {
    return `${Math.round(ms)} ms`;
  }
  return `${(ms / 1000).toFixed(2)} s`;
}

export type StatusCategory =
  | 'informational'
  | 'success'
  | 'redirect'
  | 'client-error'
  | 'server-error'
  | 'unknown';

/** Buckets a status code so the UI can colour it. */
export function statusCategory(status: number): StatusCategory {
  if (status >= 100 && status < 200) {
    return 'informational';
  }
  if (status >= 200 && status < 300) {
    return 'success';
  }
  if (status >= 300 && status < 400) {
    return 'redirect';
  }
  if (status >= 400 && status < 500) {
    return 'client-error';
  }
  if (status >= 500 && status < 600) {
    return 'server-error';
  }
  return 'unknown';
}

/** Escapes text for safe interpolation into the webview HTML. */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Header names whose values should never be rendered in full. */
const SENSITIVE_HEADERS = new Set(['authorization', 'proxy-authorization', 'cookie', 'set-cookie']);

/** True when a header value should be masked in the UI. */
export function isSensitiveHeader(name: string): boolean {
  return SENSITIVE_HEADERS.has(name.toLowerCase());
}

/** Masks all but the last few characters of a secret-ish value. */
export function maskValue(value: string): string {
  if (value.length <= 8) {
    return '••••••••';
  }
  return `${'•'.repeat(8)}${value.slice(-4)}`;
}
