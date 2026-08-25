/** `reqrunner.openRequest`: opens a file and scrolls to a request block. */
import * as vscode from 'vscode';

export interface OpenRequestArgs {
  uri: string;
  line: number;
}

export async function openRequestCommand(args: OpenRequestArgs | undefined): Promise<void> {
  if (!args?.uri) {
    return;
  }
  try {
    const document = await vscode.workspace.openTextDocument(vscode.Uri.parse(args.uri));
    const line = Math.min(Math.max(args.line ?? 0, 0), Math.max(document.lineCount - 1, 0));
    const position = new vscode.Position(line, 0);
    const editor = await vscode.window.showTextDocument(document, { preview: false });
    editor.selection = new vscode.Selection(position, position);
    editor.revealRange(
      new vscode.Range(position, position),
      vscode.TextEditorRevealType.InCenterIfOutsideViewport
    );
  } catch (error) {
    void vscode.window.showErrorMessage(
      `ReqRunner: could not open the request — ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
}
