/**
 * Sidebar tree of every `.reqrunner` file in the workspace and the requests
 * inside them.
 */
import * as path from 'path';
import * as vscode from 'vscode';
import { isSendable, parseDocument } from '../core/parser';
import { ParsedRequest } from '../core/types';

const FILE_GLOB = '**/*.reqrunner';
const EXCLUDE_GLOB = '**/{node_modules,.git,out,dist,vendor}/**';

export class FileNode {
  public readonly kind = 'file' as const;
  public constructor(
    public readonly uri: vscode.Uri,
    public readonly requests: ParsedRequest[]
  ) {}
}

export class RequestNode {
  public readonly kind = 'request' as const;
  public constructor(
    public readonly uri: vscode.Uri,
    public readonly request: ParsedRequest
  ) {}
}

export type SavedRequestNode = FileNode | RequestNode;

export class SavedRequestsProvider
  implements vscode.TreeDataProvider<SavedRequestNode>
{
  private readonly changeEmitter = new vscode.EventEmitter<
    SavedRequestNode | undefined
  >();
  public readonly onDidChangeTreeData = this.changeEmitter.event;

  private cache: FileNode[] | undefined;

  public constructor(disposables: vscode.Disposable[]) {
    const watcher = vscode.workspace.createFileSystemWatcher(FILE_GLOB);
    disposables.push(
      watcher,
      watcher.onDidCreate(() => this.refresh()),
      watcher.onDidDelete(() => this.refresh()),
      watcher.onDidChange(() => this.refresh()),
      vscode.workspace.onDidSaveTextDocument((document) => {
        if (document.uri.fsPath.endsWith('.reqrunner')) {
          this.refresh();
        }
      }),
      vscode.workspace.onDidChangeWorkspaceFolders(() => this.refresh()),
      this.changeEmitter
    );
  }

  public refresh(): void {
    this.cache = undefined;
    this.changeEmitter.fire(undefined);
  }

  public getTreeItem(element: SavedRequestNode): vscode.TreeItem {
    if (element.kind === 'file') {
      const label = path.basename(element.uri.fsPath);
      const item = new vscode.TreeItem(
        label,
        element.requests.length > 0
          ? vscode.TreeItemCollapsibleState.Expanded
          : vscode.TreeItemCollapsibleState.None
      );
      item.resourceUri = element.uri;
      item.iconPath = new vscode.ThemeIcon('file-code');
      item.contextValue = 'reqrunner.file';
      item.description =
        element.requests.length === 1 ? '1 request' : `${element.requests.length} requests`;
      item.tooltip = vscode.workspace.asRelativePath(element.uri, false);
      return item;
    }

    const { request } = element;
    const item = new vscode.TreeItem(request.name, vscode.TreeItemCollapsibleState.None);
    const sendable = isSendable(request);
    item.iconPath = new vscode.ThemeIcon(sendable ? 'arrow-right' : 'warning');
    item.description = sendable ? request.method : 'invalid';
    item.tooltip = new vscode.MarkdownString(
      sendable
        ? `**${request.method}** ${request.url}`
        : `**Cannot send**\n\n${request.errors.map((e) => `- ${e}`).join('\n')}`
    );
    item.contextValue = 'reqrunner.request';
    item.command = {
      command: 'reqrunner.openRequest',
      title: 'Open Request',
      arguments: [{ uri: element.uri.toString(), line: request.startLine }]
    };
    return item;
  }

  public async getChildren(element?: SavedRequestNode): Promise<SavedRequestNode[]> {
    if (!element) {
      const files = await this.loadFiles();
      return files;
    }
    if (element.kind === 'file') {
      return element.requests.map((request) => new RequestNode(element.uri, request));
    }
    return [];
  }

  public getParent(element: SavedRequestNode): SavedRequestNode | undefined {
    if (element.kind === 'request') {
      return this.cache?.find((file) => file.uri.toString() === element.uri.toString());
    }
    return undefined;
  }

  private async loadFiles(): Promise<FileNode[]> {
    if (this.cache) {
      return this.cache;
    }
    if (!vscode.workspace.workspaceFolders?.length) {
      this.cache = [];
      return this.cache;
    }

    let uris: vscode.Uri[];
    try {
      uris = await vscode.workspace.findFiles(FILE_GLOB, EXCLUDE_GLOB, 500);
    } catch {
      this.cache = [];
      return this.cache;
    }

    uris.sort((a, b) => a.fsPath.localeCompare(b.fsPath));

    const nodes: FileNode[] = [];
    for (const uri of uris) {
      const text = await this.readText(uri);
      if (text === undefined) {
        continue;
      }
      const parsed = parseDocument(text);
      nodes.push(new FileNode(uri, parsed.requests));
    }

    this.cache = nodes;
    return nodes;
  }

  /** Prefers in-editor content so unsaved edits still show up in the tree. */
  private async readText(uri: vscode.Uri): Promise<string | undefined> {
    const open = vscode.workspace.textDocuments.find(
      (document) => document.uri.toString() === uri.toString()
    );
    if (open) {
      return open.getText();
    }
    try {
      const bytes = await vscode.workspace.fs.readFile(uri);
      return Buffer.from(bytes).toString('utf8');
    } catch {
      return undefined;
    }
  }
}
