/**
 * The `reqrunner.sendRequest` implementation: parse, resolve variables, send,
 * render. Every failure path ends in the response panel with a readable
 * message; nothing here is allowed to throw out to the host.
 */
import * as path from 'path';
import * as vscode from 'vscode';
import { getConfig } from '../config';
import { loadEnvironment } from '../core/envFile';
import { HttpError, sendHttpRequest } from '../core/httpClient';
import { findRequestAtLine, isSendable, parseDocument } from '../core/parser';
import { ParsedRequest } from '../core/types';
import { findPlaceholders, resolveRequest } from '../core/variables';
import { ResponsePanel } from '../ui/responsePanel';
import { StatusBar } from '../ui/statusBar';

export interface SendRequestArgs {
  /** Document URI as a string (CodeLens arguments must be JSON-serialisable). */
  uri?: string;
  /** Zero-based request index inside the document. */
  requestIndex?: number;
}

export interface SendDependencies {
  statusBar: StatusBar;
  panel: ResponsePanel;
}

/** Directory used as the starting point for env-file lookup. */
function environmentStartDir(uri: vscode.Uri): string | undefined {
  if (uri.scheme === 'file') {
    return path.dirname(uri.fsPath);
  }
  const folder = vscode.workspace.workspaceFolders?.[0];
  return folder && folder.uri.scheme === 'file' ? folder.uri.fsPath : undefined;
}

function workspaceRootFor(uri: vscode.Uri): string | undefined {
  const folder = vscode.workspace.getWorkspaceFolder(uri) ?? vscode.workspace.workspaceFolders?.[0];
  return folder && folder.uri.scheme === 'file' ? folder.uri.fsPath : undefined;
}

function hintsFor(error: unknown): string[] {
  if (error instanceof HttpError) {
    switch (error.kind) {
      case 'invalid-url':
        return [
          'Check the URL on the request line.',
          'If the URL uses {{variables}}, make sure they are defined in .reqrunner.env.json.'
        ];
      case 'unsupported-protocol':
        return ['ReqRunner supports http:// and https:// only.'];
      case 'timeout':
        return [
          'The server did not answer in time.',
          'Increase the "reqrunner.timeout" setting if the endpoint is simply slow.'
        ];
      case 'too-many-redirects':
        return [
          'Raise "reqrunner.maxRedirects", or set "reqrunner.followRedirects" to false to inspect the 3xx response directly.'
        ];
      case 'network':
        return [
          'Verify the host name and that the server is reachable from this machine.',
          'For a local server over HTTPS with a self-signed certificate, set "reqrunner.rejectUnauthorized" to false.'
        ];
      default:
        return [];
    }
  }
  return [];
}

/** Resolves which request the command should send. */
async function locateRequest(
  args: SendRequestArgs | undefined
): Promise<{ document: vscode.TextDocument; request: ParsedRequest } | undefined> {
  let document: vscode.TextDocument | undefined;

  if (args?.uri) {
    try {
      document = await vscode.workspace.openTextDocument(vscode.Uri.parse(args.uri));
    } catch {
      void vscode.window.showErrorMessage('ReqRunner: could not open the request file.');
      return undefined;
    }
  } else {
    document = vscode.window.activeTextEditor?.document;
  }

  if (!document) {
    void vscode.window.showWarningMessage(
      'ReqRunner: open a .reqrunner file to send a request.'
    );
    return undefined;
  }

  const parsed = parseDocument(document.getText());
  if (parsed.requests.length === 0) {
    void vscode.window.showWarningMessage(
      'ReqRunner: no request found. Start a block with "### My request".'
    );
    return undefined;
  }

  let request: ParsedRequest | undefined;
  if (typeof args?.requestIndex === 'number') {
    request = parsed.requests[args.requestIndex];
  } else {
    const line =
      vscode.window.activeTextEditor?.document === document
        ? vscode.window.activeTextEditor.selection.active.line
        : 0;
    request = findRequestAtLine(parsed, line);
  }

  if (!request) {
    void vscode.window.showWarningMessage('ReqRunner: could not identify the request to send.');
    return undefined;
  }

  return { document, request };
}

export async function sendRequestCommand(
  args: SendRequestArgs | undefined,
  deps: SendDependencies
): Promise<void> {
  const located = await locateRequest(args);
  if (!located) {
    return;
  }
  const { document, request } = located;

  if (!isSendable(request)) {
    const message =
      request.errors.length > 0
        ? request.errors.join(' ')
        : 'The request block is incomplete.';
    deps.panel.render({
      kind: 'error',
      requestName: request.name,
      method: request.method,
      url: request.url,
      message,
      hints: ['A request block needs a line such as `GET https://api.example.com/items`.']
    });
    deps.statusBar.setFailed(message);
    return;
  }

  const config = getConfig(document.uri);

  // Load variables from .reqrunner.env.json next to the file and above it.
  const startDir = environmentStartDir(document.uri);
  const environment = startDir
    ? loadEnvironment(startDir, config.envFileName, workspaceRootFor(document.uri))
    : { variables: {}, files: [], errors: [] };

  if (environment.errors.length > 0) {
    void vscode.window.showWarningMessage(`ReqRunner: ${environment.errors[0]}`);
  }

  const { request: resolved, missing } = resolveRequest(request, environment.variables);

  // An unresolved placeholder in the URL cannot produce a meaningful request.
  const urlPlaceholders = findPlaceholders(resolved.url);
  if (urlPlaceholders.length > 0) {
    const message = `Unresolved variable(s) in the URL: ${urlPlaceholders
      .map((name) => `{{${name}}}`)
      .join(', ')}.`;
    deps.panel.render({
      kind: 'error',
      requestName: request.name,
      method: resolved.method,
      url: resolved.url,
      message,
      hints: [
        environment.files.length > 0
          ? `Add the value to ${environment.files[0]}.`
          : `Create a ${config.envFileName} file next to this request file (ReqRunner: Create Environment File).`,
        'Variables can also be declared in the document with `@name = value`.'
      ]
    });
    deps.statusBar.setFailed(message);
    return;
  }

  deps.statusBar.setSending(request.name);
  deps.panel.render({
    kind: 'loading',
    requestName: request.name,
    method: resolved.method,
    url: resolved.url
  });

  try {
    const response = await sendHttpRequest({
      method: resolved.method,
      url: resolved.url,
      headers: resolved.headers,
      body: resolved.body,
      timeoutMs: config.timeout,
      followRedirects: config.followRedirects,
      maxRedirects: config.maxRedirects,
      rejectUnauthorized: config.rejectUnauthorized
    });

    deps.panel.render({
      kind: 'response',
      requestName: request.name,
      sent: resolved,
      response,
      missingVariables: missing,
      envFiles: environment.files
    });
    deps.statusBar.setResult(response.status, response.timeMs);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    deps.panel.render({
      kind: 'error',
      requestName: request.name,
      method: resolved.method,
      url: resolved.url,
      message,
      hints: hintsFor(error)
    });
    deps.statusBar.setFailed(message);
  }
}
