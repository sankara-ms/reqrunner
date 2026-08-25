/**
 * Loading of `.reqrunner.env.json` files.
 *
 * Lookup starts in the folder holding the request file and walks upwards,
 * optionally stopping at the workspace root. Files closer to the request win,
 * which lets a project-wide file be overridden per folder.
 */
import * as fs from 'fs';
import * as path from 'path';

export const DEFAULT_ENV_FILE_NAME = '.reqrunner.env.json';

export interface EnvironmentLoadResult {
  variables: Record<string, string>;
  /** Env files that were read, nearest first. */
  files: string[];
  /** Human readable problems, e.g. malformed JSON. Never thrown. */
  errors: string[];
}

/** Converts a JSON value into the string form used for substitution. */
function toVariableValue(value: unknown): string | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }
  switch (typeof value) {
    case 'string':
      return value;
    case 'number':
    case 'boolean':
      return String(value);
    case 'object':
      try {
        return JSON.stringify(value);
      } catch {
        return undefined;
      }
    default:
      return undefined;
  }
}

/** Parses env-file JSON into flat string variables. */
export function parseEnvironmentJson(
  content: string
): { variables: Record<string, string>; error?: string } {
  const variables: Record<string, string> = {};
  const trimmed = content.replace(/^\uFEFF/, '').trim();
  if (trimmed === '') {
    return { variables };
  }

  let data: unknown;
  try {
    data = JSON.parse(trimmed);
  } catch (error) {
    return {
      variables,
      error: `Invalid JSON: ${error instanceof Error ? error.message : String(error)}`
    };
  }

  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    return { variables, error: 'Expected a JSON object of key/value pairs.' };
  }

  for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
    const converted = toVariableValue(value);
    if (converted !== undefined) {
      variables[key] = converted;
    }
  }
  return { variables };
}

/** Candidate env-file paths for `startDir`, nearest first. */
export function findEnvironmentFiles(
  startDir: string,
  fileName: string = DEFAULT_ENV_FILE_NAME,
  stopDir?: string
): string[] {
  const found: string[] = [];
  const normalizedStop = stopDir ? path.resolve(stopDir) : undefined;

  let current = path.resolve(startDir);
  // Hard cap keeps a symlink loop or odd mount from spinning forever.
  for (let depth = 0; depth < 64; depth++) {
    const candidate = path.join(current, fileName);
    try {
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
        found.push(candidate);
      }
    } catch {
      // Unreadable directory: skip it and keep walking up.
    }

    if (normalizedStop && current === normalizedStop) {
      break;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }
  return found;
}

/** Reads and merges every env file above `startDir`. Nearest file wins. */
export function loadEnvironment(
  startDir: string,
  fileName: string = DEFAULT_ENV_FILE_NAME,
  stopDir?: string
): EnvironmentLoadResult {
  const files = findEnvironmentFiles(startDir, fileName, stopDir);
  const variables: Record<string, string> = {};
  const errors: string[] = [];

  // Apply farthest first so nearer definitions overwrite them.
  for (const file of [...files].reverse()) {
    let content: string;
    try {
      content = fs.readFileSync(file, 'utf8');
    } catch (error) {
      errors.push(
        `Could not read ${file}: ${error instanceof Error ? error.message : String(error)}`
      );
      continue;
    }
    const parsed = parseEnvironmentJson(content);
    if (parsed.error) {
      errors.push(`${file}: ${parsed.error}`);
      continue;
    }
    Object.assign(variables, parsed.variables);
  }

  return { variables, files, errors };
}
