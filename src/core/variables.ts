/**
 * `{{variable}}` substitution.
 *
 * Values may themselves reference other variables (`@usersUrl = {{baseUrl}}/users`),
 * so substitution runs repeatedly until it stabilises. Unknown placeholders are
 * left untouched and reported instead of throwing, so a request with a typo
 * still shows a useful error rather than crashing the extension.
 */
import { ParsedRequest, ResolvedRequest } from './types';

const PLACEHOLDER_RE = /\{\{\s*([^{}]+?)\s*\}\}/g;
const MAX_PASSES = 8;

export interface TextResolution {
  text: string;
  /** Placeholder names that had no value, de-duplicated, in first-seen order. */
  missing: string[];
}

/** Returns every distinct placeholder name used in `text`. */
export function findPlaceholders(text: string): string[] {
  const names: string[] = [];
  const seen = new Set<string>();
  for (const match of text.matchAll(PLACEHOLDER_RE)) {
    const name = match[1].trim();
    if (!seen.has(name)) {
      seen.add(name);
      names.push(name);
    }
  }
  return names;
}

/** Substitutes `{{name}}` placeholders in `text` using `variables`. */
export function resolveText(
  text: string,
  variables: Record<string, string>
): TextResolution {
  const missing: string[] = [];
  const missingSeen = new Set<string>();

  let current = text;
  for (let pass = 0; pass < MAX_PASSES; pass++) {
    let changed = false;
    const next = current.replace(PLACEHOLDER_RE, (whole, rawName: string) => {
      const name = rawName.trim();
      const value = variables[name];
      if (value === undefined || value === null) {
        if (!missingSeen.has(name)) {
          missingSeen.add(name);
          missing.push(name);
        }
        return whole;
      }
      const replacement = String(value);
      // Guard against `@a = {{a}}` style self-reference producing an endless loop.
      if (replacement === whole) {
        return whole;
      }
      changed = true;
      return replacement;
    });
    current = next;
    if (!changed) {
      break;
    }
  }

  return { text: current, missing };
}

export interface RequestResolution {
  request: ResolvedRequest;
  /** Placeholder names that could not be resolved anywhere in the request. */
  missing: string[];
}

/**
 * Resolves URL, header values, header names and body of a parsed request.
 *
 * `environment` holds values from the env file; variables declared in the
 * document (`@name = value`) take precedence over it.
 */
export function resolveRequest(
  request: ParsedRequest,
  environment: Record<string, string> = {}
): RequestResolution {
  const variables: Record<string, string> = { ...environment, ...request.variables };
  const missing: string[] = [];
  const missingSeen = new Set<string>();

  const track = (result: TextResolution): string => {
    for (const name of result.missing) {
      if (!missingSeen.has(name)) {
        missingSeen.add(name);
        missing.push(name);
      }
    }
    return result.text;
  };

  const url = track(resolveText(request.url, variables));

  const headers: Record<string, string> = {};
  for (const header of request.headers) {
    const name = track(resolveText(header.name, variables)).trim();
    const value = track(resolveText(header.value, variables));
    if (name === '') {
      continue;
    }
    const existing = headers[name];
    // Repeating a header name appends rather than overwrites.
    headers[name] = existing === undefined ? value : `${existing}, ${value}`;
  }

  const body =
    request.body === undefined ? undefined : track(resolveText(request.body, variables));

  return {
    request: {
      name: request.name,
      method: request.method,
      url,
      headers,
      body
    },
    missing
  };
}
