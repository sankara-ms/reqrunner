/**
 * The response viewer. A single reusable webview panel shows the outcome of the
 * most recent request: status, timing, headers, body and any error detail.
 */
import * as vscode from 'vscode';
import {
  BodyLanguage,
  escapeHtml,
  formatBody,
  formatBytes,
  formatDuration,
  isSensitiveHeader,
  maskValue,
  statusCategory
} from '../core/format';
import { HttpResponse, ResolvedRequest } from '../core/types';

export interface LoadingView {
  kind: 'loading';
  requestName: string;
  method: string;
  url: string;
}

export interface ResponseView {
  kind: 'response';
  requestName: string;
  sent: ResolvedRequest;
  response: HttpResponse;
  /** Placeholders that had no value; shown as a warning banner. */
  missingVariables: string[];
  /** Env files that contributed variables, for troubleshooting. */
  envFiles: string[];
}

export interface ErrorView {
  kind: 'error';
  requestName: string;
  method: string;
  url: string;
  message: string;
  hints: string[];
}

export type ResponsePanelView = LoadingView | ResponseView | ErrorView;

interface WebviewMessage {
  type: string;
  text?: string;
  language?: string;
}

const VIEW_TYPE = 'reqrunner.response';

function nonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let value = '';
  for (let i = 0; i < 32; i++) {
    value += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return value;
}

function languageId(language: BodyLanguage): string {
  switch (language) {
    case 'json':
      return 'json';
    case 'xml':
      return 'xml';
    case 'html':
      return 'html';
    default:
      return 'plaintext';
  }
}

export class ResponsePanel {
  private static instance: ResponsePanel | undefined;

  private panel: vscode.WebviewPanel | undefined;
  private lastBody = '';
  private lastLanguage: BodyLanguage = 'text';
  private lastView: ResponsePanelView | undefined;
  private lastHtml = '';

  private constructor(private readonly extensionUri: vscode.Uri) {}

  public static initialize(extensionUri: vscode.Uri): ResponsePanel {
    if (!ResponsePanel.instance) {
      ResponsePanel.instance = new ResponsePanel(extensionUri);
    }
    return ResponsePanel.instance;
  }

  public static get current(): ResponsePanel | undefined {
    return ResponsePanel.instance;
  }

  /** True while a panel is open. Used by the integration tests. */
  public get isVisible(): boolean {
    return this.panel !== undefined;
  }

  /** The most recent view model. Exposed so the integration tests can assert it. */
  public get renderedView(): ResponsePanelView | undefined {
    return this.lastView;
  }

  /** The most recent webview HTML. Exposed for the integration tests. */
  public get renderedHtml(): string {
    return this.lastHtml;
  }

  public dispose(): void {
    this.panel?.dispose();
    this.panel = undefined;
    ResponsePanel.instance = undefined;
  }

  public render(view: ResponsePanelView): void {
    const panel = this.ensurePanel();
    panel.title = this.titleFor(view);
    this.lastView = view;
    this.lastHtml = this.html(panel.webview, view);
    panel.webview.html = this.lastHtml;
  }

  private titleFor(view: ResponsePanelView): string {
    switch (view.kind) {
      case 'loading':
        return 'ReqRunner: sending…';
      case 'error':
        return 'ReqRunner: failed';
      default:
        return `ReqRunner: ${view.response.status} ${view.response.statusText}`.trim();
    }
  }

  private ensurePanel(): vscode.WebviewPanel {
    if (this.panel) {
      // Do not steal focus from the editor on every send.
      this.panel.reveal(this.panel.viewColumn ?? vscode.ViewColumn.Beside, true);
      return this.panel;
    }

    const panel = vscode.window.createWebviewPanel(
      VIEW_TYPE,
      'ReqRunner Response',
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'media')]
      }
    );

    panel.onDidDispose(() => {
      this.panel = undefined;
    });

    panel.webview.onDidReceiveMessage(async (message: WebviewMessage) => {
      try {
        if (message.type === 'copyBody') {
          await vscode.env.clipboard.writeText(this.lastBody);
          void vscode.window.setStatusBarMessage('ReqRunner: response body copied', 2000);
        } else if (message.type === 'openInEditor') {
          const document = await vscode.workspace.openTextDocument({
            content: this.lastBody,
            language: languageId(this.lastLanguage)
          });
          await vscode.window.showTextDocument(document, { preview: false });
        }
      } catch (error) {
        void vscode.window.showErrorMessage(
          `ReqRunner: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    });

    this.panel = panel;
    return panel;
  }

  private html(webview: vscode.Webview, view: ResponsePanelView): string {
    const n = nonce();
    const csp =
      `default-src 'none'; ` +
      `img-src ${webview.cspSource} data:; ` +
      `style-src 'nonce-${n}'; ` +
      `script-src 'nonce-${n}';`;

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="${csp}" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>ReqRunner Response</title>
<style nonce="${n}">${STYLES}</style>
</head>
<body>
${this.bodyHtml(view)}
<script nonce="${n}">${SCRIPT}</script>
</body>
</html>`;
  }

  private bodyHtml(view: ResponsePanelView): string {
    if (view.kind === 'loading') {
      return `
<header class="summary">
  <div class="row">
    <span class="badge pending">Sending</span>
    <span class="method">${escapeHtml(view.method)}</span>
    <span class="url">${escapeHtml(view.url)}</span>
  </div>
  <div class="name">${escapeHtml(view.requestName)}</div>
</header>
<div class="spinner-wrap"><div class="spinner"></div><span>Waiting for response…</span></div>`;
    }

    if (view.kind === 'error') {
      const hints =
        view.hints.length > 0
          ? `<ul class="hints">${view.hints
              .map((hint) => `<li>${escapeHtml(hint)}</li>`)
              .join('')}</ul>`
          : '';
      return `
<header class="summary">
  <div class="row">
    <span class="badge error">Failed</span>
    <span class="method">${escapeHtml(view.method || '—')}</span>
    <span class="url">${escapeHtml(view.url || '—')}</span>
  </div>
  <div class="name">${escapeHtml(view.requestName)}</div>
</header>
<section class="error-box">
  <div class="error-title">Request could not be completed</div>
  <div class="error-message">${escapeHtml(view.message)}</div>
  ${hints}
</section>`;
    }

    const { response, sent } = view;
    const contentType = response.headers['content-type'];
    const formatted = formatBody(response.body, contentType);
    this.lastBody = formatted.text;
    this.lastLanguage = formatted.language;

    const category = statusCategory(response.status);
    const statusLabel = `${response.status}${
      response.statusText ? ` ${response.statusText}` : ''
    }`;

    const warnings: string[] = [];
    if (view.missingVariables.length > 0) {
      warnings.push(
        `Unresolved variable(s): ${view.missingVariables
          .map((name) => `{{${name}}}`)
          .join(', ')}. ` +
          (view.envFiles.length > 0
            ? `Checked ${view.envFiles.join(', ')}.`
            : 'No .reqrunner.env.json file was found.')
      );
    }
    if (formatted.warning) {
      warnings.push(formatted.warning);
    }
    if (response.redirects.length > 0) {
      warnings.push(`Followed ${response.redirects.length} redirect(s): ${response.redirects.join(' → ')}`);
    }

    const warningHtml =
      warnings.length > 0
        ? `<section class="warnings">${warnings
            .map((text) => `<div class="warning">${escapeHtml(text)}</div>`)
            .join('')}</section>`
        : '';

    const responseHeaderRows = response.rawHeaders
      .map(([name, value]) => {
        const shown = isSensitiveHeader(name) ? maskValue(value) : value;
        return `<tr><td class="key">${escapeHtml(name)}</td><td>${escapeHtml(shown)}</td></tr>`;
      })
      .join('');

    const requestHeaderRows = Object.entries(sent.headers)
      .map(([name, value]) => {
        const shown = isSensitiveHeader(name) ? maskValue(value) : value;
        return `<tr><td class="key">${escapeHtml(name)}</td><td>${escapeHtml(shown)}</td></tr>`;
      })
      .join('');

    const bodyPane =
      formatted.text.trim() === ''
        ? '<div class="empty">Response body is empty.</div>'
        : `<pre class="code"><code>${escapeHtml(formatted.text)}</code></pre>`;

    const requestBodyPane =
      sent.body === undefined || sent.body.trim() === ''
        ? '<div class="empty">No request body.</div>'
        : `<pre class="code"><code>${escapeHtml(sent.body)}</code></pre>`;

    return `
<header class="summary">
  <div class="row">
    <span class="badge ${category}">${escapeHtml(statusLabel)}</span>
    <span class="method">${escapeHtml(response.method)}</span>
    <span class="url">${escapeHtml(response.url)}</span>
  </div>
  <div class="meta">
    <span title="Response time">⏱ ${escapeHtml(formatDuration(response.timeMs))}</span>
    <span title="Response size">⇩ ${escapeHtml(formatBytes(response.sizeBytes))}</span>
    <span title="HTTP version">HTTP/${escapeHtml(response.httpVersion)}</span>
    ${
      formatted.prettified
        ? '<span title="Body was pretty-printed">pretty JSON</span>'
        : ''
    }
    <span class="name">${escapeHtml(view.requestName)}</span>
  </div>
</header>
${warningHtml}
<nav class="tabs" role="tablist">
  <button class="tab active" data-pane="pane-body" role="tab">Body</button>
  <button class="tab" data-pane="pane-headers" role="tab">Response Headers (${
    response.rawHeaders.length
  })</button>
  <button class="tab" data-pane="pane-request" role="tab">Request</button>
</nav>
<div class="actions">
  <button id="copy-body" class="action">Copy body</button>
  <button id="open-editor" class="action">Open in editor</button>
</div>
<section id="pane-body" class="pane active">${bodyPane}</section>
<section id="pane-headers" class="pane">
  <table class="kv">${responseHeaderRows}</table>
</section>
<section id="pane-request" class="pane">
  <table class="kv">
    <tr><td class="key">Method</td><td>${escapeHtml(sent.method)}</td></tr>
    <tr><td class="key">URL</td><td>${escapeHtml(sent.url)}</td></tr>
  </table>
  <h3>Headers sent</h3>
  <table class="kv">${
    requestHeaderRows || '<tr><td colspan="2" class="empty">No headers.</td></tr>'
  }</table>
  <h3>Body sent</h3>
  ${requestBodyPane}
</section>`;
  }
}

const STYLES = `
:root { color-scheme: light dark; }
body {
  font-family: var(--vscode-font-family);
  font-size: var(--vscode-font-size);
  color: var(--vscode-foreground);
  background: var(--vscode-editor-background);
  padding: 0 16px 24px;
  margin: 0;
}
.summary { padding-top: 16px; }
.summary .row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.badge {
  font-weight: 600;
  padding: 2px 10px;
  border-radius: 10px;
  white-space: nowrap;
  color: #fff;
  background: var(--vscode-badge-background);
}
.badge.success { background: #1f883d; }
.badge.redirect { background: #9a6700; }
.badge.informational { background: #0969da; }
.badge.client-error { background: #bc4c00; }
.badge.server-error { background: #cf222e; }
.badge.unknown { background: #6e7781; }
.badge.error { background: #cf222e; }
.badge.pending { background: #6e7781; }
.method { font-weight: 700; letter-spacing: .04em; }
.url { opacity: .9; word-break: break-all; }
.meta {
  display: flex; gap: 16px; flex-wrap: wrap;
  margin-top: 8px; font-size: 12px; opacity: .8;
}
.meta .name { margin-left: auto; font-style: italic; }
.name { opacity: .85; }
.warnings { margin-top: 12px; display: flex; flex-direction: column; gap: 6px; }
.warning {
  border-left: 3px solid var(--vscode-editorWarning-foreground, #9a6700);
  background: var(--vscode-inputValidation-warningBackground, rgba(154,103,0,.12));
  padding: 6px 10px; font-size: 12px; border-radius: 2px;
}
.tabs { display: flex; gap: 4px; margin-top: 16px; border-bottom: 1px solid var(--vscode-panel-border, rgba(128,128,128,.35)); }
.tab {
  background: none; border: none; border-bottom: 2px solid transparent;
  color: var(--vscode-foreground); opacity: .7;
  padding: 6px 10px; cursor: pointer; font-size: 12px;
}
.tab:hover { opacity: 1; }
.tab.active { opacity: 1; border-bottom-color: var(--vscode-focusBorder, #0969da); }
.tab:focus-visible { outline: 1px solid var(--vscode-focusBorder); }
.actions { display: flex; gap: 8px; margin: 10px 0; }
.action {
  font-size: 12px; padding: 4px 10px; cursor: pointer;
  color: var(--vscode-button-secondaryForeground, var(--vscode-button-foreground));
  background: var(--vscode-button-secondaryBackground, var(--vscode-button-background));
  border: none; border-radius: 2px;
}
.action:hover { background: var(--vscode-button-secondaryHoverBackground, var(--vscode-button-hoverBackground)); }
.action:focus-visible { outline: 1px solid var(--vscode-focusBorder); }
.pane { display: none; }
.pane.active { display: block; }
pre.code {
  background: var(--vscode-textCodeBlock-background, rgba(128,128,128,.1));
  padding: 12px; border-radius: 4px; overflow: auto; max-height: 65vh;
  font-family: var(--vscode-editor-font-family); font-size: var(--vscode-editor-font-size);
  white-space: pre; margin: 0;
}
table.kv { border-collapse: collapse; width: 100%; font-size: 12px; }
table.kv td { padding: 4px 8px; border-bottom: 1px solid var(--vscode-panel-border, rgba(128,128,128,.25)); vertical-align: top; word-break: break-all; }
table.kv td.key { width: 30%; font-weight: 600; opacity: .85; }
h3 { font-size: 12px; text-transform: uppercase; letter-spacing: .06em; opacity: .7; margin: 18px 0 6px; }
.empty { opacity: .6; font-style: italic; padding: 8px 0; }
.error-box {
  margin-top: 16px; padding: 12px 14px; border-radius: 4px;
  border-left: 3px solid #cf222e;
  background: var(--vscode-inputValidation-errorBackground, rgba(207,34,46,.12));
}
.error-title { font-weight: 600; margin-bottom: 6px; }
.error-message { font-family: var(--vscode-editor-font-family); font-size: 12px; word-break: break-word; }
.hints { margin: 10px 0 0; padding-left: 18px; font-size: 12px; opacity: .85; }
.spinner-wrap { display: flex; align-items: center; gap: 10px; margin-top: 24px; font-size: 12px; opacity: .8; }
.spinner {
  width: 14px; height: 14px; border-radius: 50%;
  border: 2px solid var(--vscode-panel-border, rgba(128,128,128,.4));
  border-top-color: var(--vscode-focusBorder, #0969da);
  animation: spin 0.8s linear infinite;
}
@keyframes spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .spinner { animation: none; } }
`;

const SCRIPT = `
(function () {
  const vscodeApi = acquireVsCodeApi();
  const tabs = Array.prototype.slice.call(document.querySelectorAll('.tab'));
  tabs.forEach(function (tab) {
    tab.addEventListener('click', function () {
      tabs.forEach(function (other) {
        other.classList.remove('active');
        other.setAttribute('aria-selected', 'false');
      });
      Array.prototype.forEach.call(document.querySelectorAll('.pane'), function (pane) {
        pane.classList.remove('active');
      });
      tab.classList.add('active');
      tab.setAttribute('aria-selected', 'true');
      const pane = document.getElementById(tab.dataset.pane);
      if (pane) { pane.classList.add('active'); }
    });
  });
  const copyButton = document.getElementById('copy-body');
  if (copyButton) {
    copyButton.addEventListener('click', function () {
      vscodeApi.postMessage({ type: 'copyBody' });
    });
  }
  const openButton = document.getElementById('open-editor');
  if (openButton) {
    openButton.addEventListener('click', function () {
      vscodeApi.postMessage({ type: 'openInEditor' });
    });
  }
}());
`;
