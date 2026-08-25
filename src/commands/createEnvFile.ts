/**
 * `reqrunner.createEnvFile`: creates (or opens) the environment file for the
 * current workspace folder.
 */
import * as vscode from 'vscode';
import { getConfig } from '../config';

const TEMPLATE = `{
  "baseUrl": "https://jsonplaceholder.typicode.com",
  "token": "replace-me"
}
`;

export async function createEnvFileCommand(): Promise<void> {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    void vscode.window.showWarningMessage(
      'ReqRunner: open a folder first so the environment file has somewhere to live.'
    );
    return;
  }

  const folder =
    folders.length === 1
      ? folders[0]
      : await vscode.window.showWorkspaceFolderPick({
          placeHolder: 'Where should the ReqRunner environment file be created?'
        });
  if (!folder) {
    return;
  }

  const fileName = getConfig(folder.uri).envFileName;
  const target = vscode.Uri.joinPath(folder.uri, fileName);

  try {
    // Never clobber an existing file: open it instead.
    let exists = true;
    try {
      await vscode.workspace.fs.stat(target);
    } catch {
      exists = false;
    }

    if (!exists) {
      await vscode.workspace.fs.writeFile(target, Buffer.from(TEMPLATE, 'utf8'));
    }

    const document = await vscode.workspace.openTextDocument(target);
    await vscode.window.showTextDocument(document, { preview: false });
    if (!exists) {
      void vscode.window.showInformationMessage(`ReqRunner: created ${fileName}.`);
    }
  } catch (error) {
    void vscode.window.showErrorMessage(
      `ReqRunner: could not create ${fileName} — ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
}
