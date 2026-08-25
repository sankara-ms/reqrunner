/**
 * Status bar entry. Idle text is exactly `ReqRunner Ready`; clicking it creates
 * a new `.reqrunner` file from a starter template.
 */
import * as vscode from 'vscode';
import { formatDuration, statusCategory } from '../core/format';

const IDLE_TEXT = 'ReqRunner Ready';
const RESET_DELAY_MS = 6000;

export class StatusBar {
  private readonly item: vscode.StatusBarItem;
  private resetTimer: NodeJS.Timeout | undefined;

  public constructor() {
    this.item = vscode.window.createStatusBarItem(
      'reqrunner.status',
      vscode.StatusBarAlignment.Left,
      100
    );
    this.item.name = 'ReqRunner';
    this.item.command = 'reqrunner.newFile';
    this.setIdle();
    this.item.show();
  }

  /** Current text, exposed for the integration tests. */
  public get text(): string {
    return this.item.text;
  }

  public setIdle(): void {
    this.clearTimer();
    this.item.text = IDLE_TEXT;
    this.item.tooltip = 'ReqRunner: click to create a new .reqrunner file';
    this.item.backgroundColor = undefined;
  }

  public setSending(label: string): void {
    this.clearTimer();
    this.item.text = `$(sync~spin) ReqRunner: ${label}`;
    this.item.tooltip = `Sending ${label}`;
    this.item.backgroundColor = undefined;
  }

  public setResult(status: number, timeMs: number): void {
    this.clearTimer();
    const category = statusCategory(status);
    const isError = category === 'client-error' || category === 'server-error';
    const icon = isError ? '$(error)' : '$(check)';
    this.item.text = `${icon} ReqRunner: ${status} · ${formatDuration(timeMs)}`;
    this.item.tooltip = `Last response: ${status} in ${formatDuration(timeMs)}`;
    this.item.backgroundColor = undefined;
    this.scheduleReset();
  }

  public setFailed(message: string): void {
    this.clearTimer();
    this.item.text = '$(error) ReqRunner: failed';
    this.item.tooltip = message;
    this.item.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
    this.scheduleReset();
  }

  private scheduleReset(): void {
    this.resetTimer = setTimeout(() => this.setIdle(), RESET_DELAY_MS);
  }

  private clearTimer(): void {
    if (this.resetTimer) {
      clearTimeout(this.resetTimer);
      this.resetTimer = undefined;
    }
  }

  public dispose(): void {
    this.clearTimer();
    this.item.dispose();
  }
}
