/**
 * Shared types for the ReqRunner core.
 *
 * Nothing in `src/core` may import `vscode`: these modules are plain Node.js so
 * they can be unit tested without an extension host.
 */

/** HTTP methods ReqRunner knows how to send. */
export const SUPPORTED_METHODS = [
  'GET',
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
  'HEAD',
  'OPTIONS'
] as const;

export type HttpMethod = (typeof SUPPORTED_METHODS)[number];

/** A single `Name: value` header line inside a request block. */
export interface ParsedHeader {
  name: string;
  value: string;
  /** Zero-based line in the source document. */
  line: number;
}

/** One `###` block of a `.reqrunner` document. */
export interface ParsedRequest {
  /** Zero-based position of this request within the document. */
  index: number;
  /** Title taken from the `###` line, or a generated fallback. */
  name: string;
  /** Uppercased method. Empty when the block has no usable request line. */
  method: string;
  /** Raw URL, still containing any `{{variable}}` placeholders. */
  url: string;
  headers: ParsedHeader[];
  /** Raw body, still containing placeholders. `undefined` when there is none. */
  body?: string;
  /** Zero-based line of the `###` separator (or of the request line for an implicit block). */
  startLine: number;
  /** Zero-based last line that belongs to this block. */
  endLine: number;
  /** Zero-based line holding `METHOD URL`. `-1` when the block is malformed. */
  requestLine: number;
  /** `@name = value` definitions declared inside this block. */
  variables: Record<string, string>;
  /** Reasons why this block cannot be sent. Empty for valid requests. */
  errors: string[];
}

/** Result of parsing a whole `.reqrunner` document. */
export interface ParsedDocument {
  requests: ParsedRequest[];
  /** `@name = value` definitions declared before the first `###` block. */
  fileVariables: Record<string, string>;
}

/** A request with every `{{placeholder}}` already substituted. */
export interface ResolvedRequest {
  name: string;
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: string;
}

/** Kinds of transport failure ReqRunner reports distinctly. */
export type HttpErrorKind =
  | 'invalid-url'
  | 'unsupported-protocol'
  | 'timeout'
  | 'network'
  | 'too-many-redirects'
  | 'aborted';

/** Options accepted by {@link sendHttpRequest}. */
export interface HttpRequestOptions {
  method: string;
  url: string;
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
  followRedirects?: boolean;
  maxRedirects?: number;
  rejectUnauthorized?: boolean;
}

/** A successfully received HTTP response (any status code counts as success). */
export interface HttpResponse {
  method: string;
  /** Final URL the response came from, after any redirects. */
  url: string;
  status: number;
  statusText: string;
  httpVersion: string;
  /** Lower-cased header names mapped to their value(s). */
  headers: Record<string, string>;
  /** Header order as received, as `[name, value]` pairs. */
  rawHeaders: Array<[string, string]>;
  /** Decoded text body, or a placeholder note for binary payloads. */
  body: string;
  /** True when the payload was not decodable text. */
  isBinary: boolean;
  /** Byte length of the decoded (post-decompression) payload. */
  sizeBytes: number;
  /** Wall-clock duration in milliseconds. */
  timeMs: number;
  /** URLs visited before the final one, in order. */
  redirects: string[];
}
