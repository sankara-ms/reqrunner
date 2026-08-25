/** Typed access to the `reqrunner.*` settings. */
import * as vscode from 'vscode';
import { DEFAULT_ENV_FILE_NAME } from './core/envFile';

export interface ReqRunnerConfig {
  timeout: number;
  followRedirects: boolean;
  maxRedirects: number;
  rejectUnauthorized: boolean;
  envFileName: string;
  showCodeLens: boolean;
}

/** Reads the effective configuration, scoped to `resource` when provided. */
export function getConfig(resource?: vscode.Uri): ReqRunnerConfig {
  const section = vscode.workspace.getConfiguration('reqrunner', resource ?? null);
  const envFileName = section.get<string>('envFileName', DEFAULT_ENV_FILE_NAME).trim();

  return {
    timeout: Math.max(1000, section.get<number>('timeout', 30_000)),
    followRedirects: section.get<boolean>('followRedirects', true),
    maxRedirects: Math.max(0, section.get<number>('maxRedirects', 5)),
    rejectUnauthorized: section.get<boolean>('rejectUnauthorized', true),
    envFileName: envFileName === '' ? DEFAULT_ENV_FILE_NAME : envFileName,
    showCodeLens: section.get<boolean>('showCodeLens', true)
  };
}
