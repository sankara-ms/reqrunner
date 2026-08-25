/** Puts a `▶ Send Request` lens above every request block. */
import * as vscode from 'vscode';
import { getConfig } from '../config';
import { isSendable, parseDocument } from '../core/parser';

export const REQRUNNER_DOCUMENT_SELECTOR: vscode.DocumentSelector = [
  { language: 'reqrunner' },
  { pattern: '**/*.reqrunner' }
];

export class ReqRunnerCodeLensProvider implements vscode.CodeLensProvider {
  private readonly changeEmitter = new vscode.EventEmitter<void>();
  public readonly onDidChangeCodeLenses = this.changeEmitter.event;

  public constructor(private readonly disposables: vscode.Disposable[]) {
    // The lens can be switched off, so react to configuration changes.
    this.disposables.push(
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration('reqrunner.showCodeLens')) {
          this.changeEmitter.fire();
        }
      }),
      this.changeEmitter
    );
  }

  public refresh(): void {
    this.changeEmitter.fire();
  }

  public provideCodeLenses(
    document: vscode.TextDocument,
    token: vscode.CancellationToken
  ): vscode.CodeLens[] {
    if (!getConfig(document.uri).showCodeLens) {
      return [];
    }
    if (token.isCancellationRequested) {
      return [];
    }

    const parsed = parseDocument(document.getText());
    const lenses: vscode.CodeLens[] = [];

    for (const request of parsed.requests) {
      if (!isSendable(request)) {
        continue;
      }
      const anchor = Math.min(Math.max(request.startLine, 0), document.lineCount - 1);
      const range = document.lineAt(anchor).range;
      lenses.push(
        new vscode.CodeLens(range, {
          title: '▶ Send Request',
          tooltip: `${request.method} ${request.url}`,
          command: 'reqrunner.sendRequest',
          arguments: [{ uri: document.uri.toString(), requestIndex: request.index }]
        })
      );
    }

    return lenses;
  }
}
