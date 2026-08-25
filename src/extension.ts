/** Extension entry point: wires providers, commands and UI together. */
import * as vscode from 'vscode';
import { createEnvFileCommand } from './commands/createEnvFile';
import { newFileCommand } from './commands/newFile';
import { openRequestCommand, OpenRequestArgs } from './commands/openRequest';
import { SendRequestArgs, sendRequestCommand } from './commands/sendRequest';
import {
  REQRUNNER_DOCUMENT_SELECTOR,
  ReqRunnerCodeLensProvider
} from './providers/codeLensProvider';
import { SavedRequestsProvider } from './providers/savedRequestsProvider';
import { ResponsePanel } from './ui/responsePanel';
import { StatusBar } from './ui/statusBar';

/** Surface used by the integration tests to observe extension state. */
export interface ReqRunnerApi {
  statusBar: StatusBar;
  responsePanel: ResponsePanel;
  savedRequests: SavedRequestsProvider;
  codeLensProvider: ReqRunnerCodeLensProvider;
}

/** Wraps a command handler so a thrown error becomes a message, not a crash. */
function safeCommand<T extends unknown[]>(
  name: string,
  handler: (...args: T) => unknown | Promise<unknown>
): (...args: T) => Promise<void> {
  return async (...args: T) => {
    try {
      await handler(...args);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[ReqRunner] ${name} failed:`, error);
      void vscode.window.showErrorMessage(`ReqRunner: ${message}`);
    }
  };
}

export function activate(context: vscode.ExtensionContext): ReqRunnerApi {
  const statusBar = new StatusBar();
  context.subscriptions.push(statusBar);

  const responsePanel = ResponsePanel.initialize(context.extensionUri);
  context.subscriptions.push({ dispose: () => responsePanel.dispose() });

  const codeLensProvider = new ReqRunnerCodeLensProvider(context.subscriptions);
  context.subscriptions.push(
    vscode.languages.registerCodeLensProvider(REQRUNNER_DOCUMENT_SELECTOR, codeLensProvider)
  );

  const savedRequests = new SavedRequestsProvider(context.subscriptions);
  context.subscriptions.push(
    vscode.window.registerTreeDataProvider('reqrunner.savedRequests', savedRequests)
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      'reqrunner.sendRequest',
      safeCommand('sendRequest', (args?: SendRequestArgs) =>
        sendRequestCommand(args, { statusBar, panel: responsePanel })
      )
    ),
    vscode.commands.registerCommand(
      'reqrunner.sendRequestAtCursor',
      safeCommand('sendRequestAtCursor', () =>
        sendRequestCommand(undefined, { statusBar, panel: responsePanel })
      )
    ),
    vscode.commands.registerCommand('reqrunner.newFile', safeCommand('newFile', newFileCommand)),
    vscode.commands.registerCommand(
      'reqrunner.openRequest',
      safeCommand('openRequest', (args?: OpenRequestArgs) => openRequestCommand(args))
    ),
    vscode.commands.registerCommand(
      'reqrunner.refreshSavedRequests',
      safeCommand('refreshSavedRequests', () => savedRequests.refresh())
    ),
    vscode.commands.registerCommand(
      'reqrunner.createEnvFile',
      safeCommand('createEnvFile', createEnvFileCommand)
    )
  );

  // A saved env file changes what the next request resolves to; refresh lenses
  // so tooltips stay accurate.
  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument((document) => {
      if (document.fileName.endsWith('.json') && document.fileName.includes('reqrunner')) {
        codeLensProvider.refresh();
      }
    })
  );

  return { statusBar, responsePanel, savedRequests, codeLensProvider };
}

export function deactivate(): void {
  // All resources are registered in context.subscriptions.
}
