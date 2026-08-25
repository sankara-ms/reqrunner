/**
 * Integration suite executed inside the VS Code extension host.
 *
 * A local HTTP server is started in-process so the send flow is exercised
 * end-to-end without depending on the internet.
 */
import assert from 'assert/strict';
import * as dns from 'dns/promises';
import * as fs from 'fs';
import * as http from 'http';
import { AddressInfo } from 'net';
import * as net from 'net';
import * as path from 'path';
import * as vscode from 'vscode';
import type { ReqRunnerApi } from '../../src/extension';

const EXTENSION_ID = 'sankara-ms.reqrunner';

interface Case {
  name: string;
  run: () => Promise<void> | void;
}

const cases: Case[] = [];
/** Reasons a test could not be executed in this environment. */
const skipped: string[] = [];

function test(name: string, run: () => Promise<void> | void): void {
  cases.push({ name, run });
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Polls until `predicate` holds or the budget runs out. */
async function waitFor(
  predicate: () => boolean,
  description: string,
  timeoutMs = 5000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await sleep(50);
  }
  throw new Error(`Timed out waiting for: ${description}`);
}

function workspaceUri(fileName: string): vscode.Uri {
  const folder = vscode.workspace.workspaceFolders?.[0];
  assert.ok(folder, 'A workspace folder must be open for the integration tests.');
  return vscode.Uri.joinPath(folder.uri, fileName);
}

async function writeWorkspaceFile(fileName: string, content: string): Promise<vscode.Uri> {
  const uri = workspaceUri(fileName);
  await vscode.workspace.fs.writeFile(uri, Buffer.from(content, 'utf8'));
  return uri;
}

async function findClosedPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const port = (probe.address() as AddressInfo).port;
      probe.close(() => resolve(port));
    });
  });
}

let api: ReqRunnerApi;
let server: http.Server;
let serverOrigin: string;
const receivedRequests: Array<{ method: string; url: string; body: string; auth?: string }> = [];

async function startLocalServer(): Promise<void> {
  server = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      receivedRequests.push({
        method: request.method ?? '',
        url: request.url ?? '',
        body: Buffer.concat(chunks).toString('utf8'),
        auth: request.headers.authorization
      });

      if (request.url === '/slow') {
        return; // never answers; used for the timeout path
      }
      if (request.url === '/text') {
        response.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
        response.end('hello from the test server');
        return;
      }
      if (request.url === '/missing') {
        response.writeHead(404, { 'Content-Type': 'application/json' });
        response.end('{"error":"nope"}');
        return;
      }
      response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      response.end(
        JSON.stringify({ ok: true, method: request.method, path: request.url })
      );
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  serverOrigin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

// ---------------------------------------------------------------- activation

test('extension is present and activates', async () => {
  const extension = vscode.extensions.getExtension<ReqRunnerApi>(EXTENSION_ID);
  assert.ok(extension, `${EXTENSION_ID} should be installed in the test host`);

  api = await extension.activate();
  assert.equal(extension.isActive, true);
  assert.ok(api.statusBar, 'status bar should be created');
  assert.ok(api.savedRequests, 'saved requests provider should be created');
  assert.ok(api.responsePanel, 'response panel should be created');
});

test('all contributed commands are registered', async () => {
  const registered = await vscode.commands.getCommands(true);
  for (const command of [
    'reqrunner.sendRequest',
    'reqrunner.sendRequestAtCursor',
    'reqrunner.newFile',
    'reqrunner.openRequest',
    'reqrunner.refreshSavedRequests',
    'reqrunner.createEnvFile'
  ]) {
    assert.ok(registered.includes(command), `${command} should be registered`);
  }
});

test('the reqrunner language is applied to .reqrunner files', async () => {
  const document = await vscode.workspace.openTextDocument(workspaceUri('users.reqrunner'));
  assert.equal(document.languageId, 'reqrunner');
});

// ------------------------------------------------------------------ status bar

test('status bar starts as "ReqRunner Ready"', () => {
  assert.equal(api.statusBar.text, 'ReqRunner Ready');
});

// -------------------------------------------------------------------- CodeLens

test('CodeLens shows "▶ Send Request" above every valid block', async () => {
  const uri = workspaceUri('bookings.reqrunner');
  await vscode.workspace.openTextDocument(uri);

  const lenses = await vscode.commands.executeCommand<vscode.CodeLens[]>(
    'vscode.executeCodeLensProvider',
    uri
  );

  assert.ok(lenses, 'CodeLens provider should return a result');
  assert.equal(lenses.length, 5, 'bookings.reqrunner has five requests');
  for (const lens of lenses) {
    assert.equal(lens.command?.title, '▶ Send Request');
    assert.equal(lens.command?.command, 'reqrunner.sendRequest');
  }
  assert.equal(lenses[0].range.start.line, 3);
});

test('CodeLens skips malformed blocks', async () => {
  const uri = await writeWorkspaceFile(
    'lens-malformed.reqrunner',
    ['### Good', 'GET https://example.com/a', '', '### Bad', 'total nonsense here', ''].join('\n')
  );
  // The built-in command needs a loaded text model, so open the document first.
  await vscode.workspace.openTextDocument(uri);

  const lenses = await vscode.commands.executeCommand<vscode.CodeLens[]>(
    'vscode.executeCodeLensProvider',
    uri
  );

  assert.equal(lenses?.length, 1, 'only the valid block gets a lens');
});

// --------------------------------------------------------------- send request

test('Send Request executes the request and shows the response', async () => {
  await writeWorkspaceFile(
    '.reqrunner.env.json',
    JSON.stringify({ baseUrl: serverOrigin, token: 'integration-token' }, null, 2)
  );
  const uri = await writeWorkspaceFile(
    'local.reqrunner',
    [
      '### Local JSON',
      '',
      'GET {{baseUrl}}/api/items',
      '',
      'Authorization: Bearer {{token}}',
      '',
      '### Local POST',
      '',
      'POST {{baseUrl}}/api/items',
      '',
      'Content-Type: application/json',
      '',
      '{',
      '  "customer": "John"',
      '}',
      ''
    ].join('\n')
  );

  const before = receivedRequests.length;
  await vscode.commands.executeCommand('reqrunner.sendRequest', {
    uri: uri.toString(),
    requestIndex: 0
  });

  assert.equal(receivedRequests.length, before + 1, 'the server should have been called once');
  const sent = receivedRequests[receivedRequests.length - 1];
  assert.equal(sent.method, 'GET');
  assert.equal(sent.url, '/api/items', 'the {{baseUrl}} variable should be resolved');
  assert.equal(sent.auth, 'Bearer integration-token', 'header variables should be resolved');

  assert.equal(api.responsePanel.isVisible, true, 'the response webview should be open');
  await waitFor(
    () => api.statusBar.text.includes('200'),
    `status bar to report 200 (was "${api.statusBar.text}")`
  );

  const view = api.responsePanel.renderedView;
  assert.ok(view && view.kind === 'response', 'a response view should have been rendered');
  assert.equal(view.response.status, 200);
  assert.equal(view.response.statusText, 'OK');
  assert.ok(view.response.timeMs >= 0, 'response time should be recorded');
  assert.ok(view.response.sizeBytes > 0, 'response size should be recorded');
  assert.match(view.response.headers['content-type'], /application\/json/);
  assert.deepEqual(JSON.parse(view.response.body), {
    ok: true,
    method: 'GET',
    path: '/api/items'
  });

  const html = api.responsePanel.renderedHtml;
  assert.match(html, /200 OK/, 'the webview should show the status');
  assert.match(html, /Response Headers/, 'the webview should show a headers tab');
  assert.match(html, /pretty JSON/, 'the JSON body should be pretty-printed');
  assert.match(html, /&quot;ok&quot;: true/, 'the pretty-printed body should be escaped into the HTML');
  assert.match(html, /content-type/, 'response headers should be listed');
  assert.ok(
    !html.includes('Bearer integration-token'),
    'the Authorization value must be masked in the webview'
  );
});

test('Send Request sends a JSON body', async () => {
  const uri = workspaceUri('local.reqrunner');
  const before = receivedRequests.length;

  await vscode.commands.executeCommand('reqrunner.sendRequest', {
    uri: uri.toString(),
    requestIndex: 1
  });

  assert.equal(receivedRequests.length, before + 1);
  const sent = receivedRequests[receivedRequests.length - 1];
  assert.equal(sent.method, 'POST');
  assert.deepEqual(JSON.parse(sent.body), { customer: 'John' });
});

test('Send Request At Cursor uses the block the cursor is in', async () => {
  const document = await vscode.workspace.openTextDocument(workspaceUri('local.reqrunner'));
  const editor = await vscode.window.showTextDocument(document);
  // Line 8 sits inside the second block.
  editor.selection = new vscode.Selection(new vscode.Position(8, 0), new vscode.Position(8, 0));

  const before = receivedRequests.length;
  await vscode.commands.executeCommand('reqrunner.sendRequestAtCursor');

  assert.equal(receivedRequests.length, before + 1);
  assert.equal(receivedRequests[receivedRequests.length - 1].method, 'POST');
});

test('a 404 response is reported as a normal result', async () => {
  const uri = await writeWorkspaceFile(
    'notfound.reqrunner',
    ['### Missing', 'GET {{baseUrl}}/missing', ''].join('\n')
  );

  await vscode.commands.executeCommand('reqrunner.sendRequest', {
    uri: uri.toString(),
    requestIndex: 0
  });

  await waitFor(
    () => api.statusBar.text.includes('404'),
    `status bar to report 404 (was "${api.statusBar.text}")`
  );
  assert.equal(api.responsePanel.isVisible, true);
});

test('a plain-text response is handled', async () => {
  const uri = await writeWorkspaceFile(
    'text.reqrunner',
    ['### Text', 'GET {{baseUrl}}/text', ''].join('\n')
  );

  await vscode.commands.executeCommand('reqrunner.sendRequest', {
    uri: uri.toString(),
    requestIndex: 0
  });

  await waitFor(
    () => api.statusBar.text.includes('200'),
    `status bar to report 200 (was "${api.statusBar.text}")`
  );
});

// ------------------------------------------------------------- failure flows

test('a connection failure is reported without crashing', async () => {
  const port = await findClosedPort();
  const uri = await writeWorkspaceFile(
    'refused.reqrunner',
    ['### Refused', `GET http://127.0.0.1:${port}/x`, ''].join('\n')
  );

  await vscode.commands.executeCommand('reqrunner.sendRequest', {
    uri: uri.toString(),
    requestIndex: 0
  });

  await waitFor(
    () => api.statusBar.text.includes('failed'),
    `status bar to report a failure (was "${api.statusBar.text}")`
  );
  assert.equal(api.responsePanel.isVisible, true, 'the error should be shown in the webview');

  const view = api.responsePanel.renderedView;
  assert.ok(view && view.kind === 'error');
  assert.match(view.message, /refused|reset/i);
  assert.ok(view.hints.length > 0, 'the error view should offer something to check');
  assert.match(api.responsePanel.renderedHtml, /Request could not be completed/);
});

test('a missing variable in the URL is reported instead of being sent', async () => {
  const uri = await writeWorkspaceFile(
    'missing-var.reqrunner',
    ['### Missing variable', 'GET {{notDefinedAnywhere}}/x', ''].join('\n')
  );

  const before = receivedRequests.length;
  await vscode.commands.executeCommand('reqrunner.sendRequest', {
    uri: uri.toString(),
    requestIndex: 0
  });

  assert.equal(receivedRequests.length, before, 'nothing should be sent');
  await waitFor(
    () => api.statusBar.text.includes('failed'),
    `status bar to report a failure (was "${api.statusBar.text}")`
  );
});

test('a malformed block is reported instead of being sent', async () => {
  const uri = await writeWorkspaceFile(
    'malformed.reqrunner',
    ['### Broken', 'this is not a request', ''].join('\n')
  );

  const before = receivedRequests.length;
  await vscode.commands.executeCommand('reqrunner.sendRequest', {
    uri: uri.toString(),
    requestIndex: 0
  });

  assert.equal(receivedRequests.length, before);
  await waitFor(
    () => api.statusBar.text.includes('failed'),
    `status bar to report a failure (was "${api.statusBar.text}")`
  );
});

test('a timeout is reported', async () => {
  const uri = await writeWorkspaceFile(
    'slow.reqrunner',
    ['### Slow', `GET ${serverOrigin}/slow`, ''].join('\n')
  );
  const configuration = vscode.workspace.getConfiguration('reqrunner');
  await configuration.update('timeout', 1000, vscode.ConfigurationTarget.Workspace);

  try {
    await vscode.commands.executeCommand('reqrunner.sendRequest', {
      uri: uri.toString(),
      requestIndex: 0
    });
    await waitFor(
      () => api.statusBar.text.includes('failed'),
      `status bar to report a failure (was "${api.statusBar.text}")`
    );
  } finally {
    await configuration.update('timeout', undefined, vscode.ConfigurationTarget.Workspace);
  }
});

test('sending with no editor and no arguments does not throw', async () => {
  await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  await vscode.commands.executeCommand('reqrunner.sendRequestAtCursor');
});

// -------------------------------------------------- real public API over TLS

const PUBLIC_API_HOST = 'jsonplaceholder.typicode.com';

/** True when the public test API is reachable from this machine. */
async function isPublicApiReachable(): Promise<boolean> {
  try {
    await dns.lookup(PUBLIC_API_HOST);
    return true;
  } catch {
    return false;
  }
}

test('a real HTTPS request against a public API completes end to end', async () => {
  if (!(await isPublicApiReachable())) {
    skipped.push(`public API ${PUBLIC_API_HOST} is not reachable from this machine`);
    return;
  }

  const uri = await writeWorkspaceFile(
    'public-api.reqrunner',
    [
      `@apiBase = https://${PUBLIC_API_HOST}`,
      '',
      '### Get one post',
      '',
      'GET {{apiBase}}/posts/1',
      '',
      'Accept: application/json',
      ''
    ].join('\n')
  );

  await vscode.commands.executeCommand('reqrunner.sendRequest', {
    uri: uri.toString(),
    requestIndex: 0
  });

  const view = api.responsePanel.renderedView;
  assert.ok(view && view.kind === 'response', `expected a response, got ${view?.kind}`);
  assert.equal(view.response.status, 200);
  assert.equal(view.response.url, `https://${PUBLIC_API_HOST}/posts/1`);

  const payload = JSON.parse(view.response.body);
  assert.equal(payload.id, 1);
  assert.equal(typeof payload.title, 'string');
  assert.ok(view.response.timeMs > 0);

  await waitFor(
    () => api.statusBar.text.includes('200'),
    `status bar to report 200 (was "${api.statusBar.text}")`
  );
  assert.match(api.responsePanel.renderedHtml, /pretty JSON/);
});

test('a real HTTPS POST against a public API sends the JSON body', async () => {
  if (!(await isPublicApiReachable())) {
    skipped.push(`public API ${PUBLIC_API_HOST} is not reachable from this machine`);
    return;
  }

  const uri = await writeWorkspaceFile(
    'public-api-post.reqrunner',
    [
      `@apiBase = https://${PUBLIC_API_HOST}`,
      '',
      '### Create a post',
      '',
      'POST {{apiBase}}/posts',
      '',
      'Content-Type: application/json',
      '',
      '{',
      '  "title": "ReqRunner",',
      '  "body": "sent from the integration suite",',
      '  "userId": 1',
      '}',
      ''
    ].join('\n')
  );

  await vscode.commands.executeCommand('reqrunner.sendRequest', {
    uri: uri.toString(),
    requestIndex: 0
  });

  const view = api.responsePanel.renderedView;
  assert.ok(view && view.kind === 'response', `expected a response, got ${view?.kind}`);
  assert.equal(view.response.status, 201, 'the public API returns 201 for a created post');
  const payload = JSON.parse(view.response.body);
  assert.equal(payload.title, 'ReqRunner');
});

test('an unknown host is reported cleanly', async () => {
  const uri = await writeWorkspaceFile(
    'bad-host.reqrunner',
    ['### Bad host', 'GET https://this-host-should-not-exist.reqrunner.invalid/x', ''].join('\n')
  );

  await vscode.commands.executeCommand('reqrunner.sendRequest', {
    uri: uri.toString(),
    requestIndex: 0
  });

  const view = api.responsePanel.renderedView;
  assert.ok(view && view.kind === 'error', `expected an error view, got ${view?.kind}`);
  assert.ok(view.message.length > 0);
});

// ---------------------------------------------------------------- sidebar

test('the sidebar lists .reqrunner files and their requests', async () => {
  api.savedRequests.refresh();
  const files = await api.savedRequests.getChildren();

  const names = files.map((node) => path.basename((node as { uri: vscode.Uri }).uri.fsPath));
  assert.ok(names.includes('bookings.reqrunner'), `expected bookings.reqrunner in ${names.join(', ')}`);
  assert.ok(names.includes('users.reqrunner'), `expected users.reqrunner in ${names.join(', ')}`);

  const bookings = files.find(
    (node) => path.basename((node as { uri: vscode.Uri }).uri.fsPath) === 'bookings.reqrunner'
  );
  assert.ok(bookings);

  const item = api.savedRequests.getTreeItem(bookings);
  assert.equal(item.description, '5 requests');

  const requests = await api.savedRequests.getChildren(bookings);
  assert.equal(requests.length, 5);

  const first = api.savedRequests.getTreeItem(requests[0]);
  assert.equal(first.label, 'Get all bookings');
  assert.equal(first.command?.command, 'reqrunner.openRequest');
});

test('clicking a sidebar request opens the file at that line', async () => {
  const files = await api.savedRequests.getChildren();
  const users = files.find(
    (node) => path.basename((node as { uri: vscode.Uri }).uri.fsPath) === 'users.reqrunner'
  );
  assert.ok(users);
  const requests = await api.savedRequests.getChildren(users);
  const target = api.savedRequests.getTreeItem(requests[2]);

  await vscode.commands.executeCommand(
    target.command!.command,
    ...(target.command!.arguments ?? [])
  );

  const editor = vscode.window.activeTextEditor;
  assert.ok(editor, 'an editor should be open');
  assert.equal(path.basename(editor.document.uri.fsPath), 'users.reqrunner');
  const expectedLine = (target.command!.arguments![0] as { line: number }).line;
  assert.equal(editor.selection.active.line, expectedLine);
  assert.match(editor.document.lineAt(expectedLine).text, /^###/);
});

// ------------------------------------------------------------- file creation

test('the status bar command creates a new file from the starter template', async () => {
  await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  await vscode.commands.executeCommand('reqrunner.newFile');

  await waitFor(
    () => vscode.window.activeTextEditor !== undefined,
    'a new editor to be opened'
  );
  const editor = vscode.window.activeTextEditor!;
  const text = editor.document.getText();

  assert.equal(editor.document.languageId, 'reqrunner');
  assert.match(text, /### Get all posts/);
  assert.match(text, /@baseUrl = https:\/\/jsonplaceholder\.typicode\.com/);
  assert.match(text, /POST \{\{baseUrl\}\}\/posts/);

  const lenses = await vscode.commands.executeCommand<vscode.CodeLens[]>(
    'vscode.executeCodeLensProvider',
    editor.document.uri
  );
  assert.equal(lenses?.length, 5, 'the template should produce five lenses');
});

test('the create environment file command produces a usable env file', async () => {
  const target = workspaceUri('.reqrunner.env.json');
  await vscode.workspace.fs.delete(target, { useTrash: false });

  await vscode.commands.executeCommand('reqrunner.createEnvFile');

  const bytes = await vscode.workspace.fs.readFile(target);
  const parsed = JSON.parse(Buffer.from(bytes).toString('utf8'));
  assert.equal(typeof parsed.baseUrl, 'string');

  // Restore the env file the send tests rely on.
  await writeWorkspaceFile(
    '.reqrunner.env.json',
    JSON.stringify({ baseUrl: serverOrigin, token: 'integration-token' }, null, 2)
  );
});

// -------------------------------------------------------------------- runner

export async function run(): Promise<void> {
  await startLocalServer();

  const failures: Array<{ name: string; error: unknown }> = [];
  let passed = 0;

  console.log('\n  ReqRunner integration tests\n');
  for (const testCase of cases) {
    try {
      await testCase.run();
      passed++;
      console.log(`  ✓ ${testCase.name}`);
    } catch (error) {
      failures.push({ name: testCase.name, error });
      console.log(`  ✗ ${testCase.name}`);
    }
  }

  server.closeAllConnections?.();
  await new Promise<void>((resolve) => server.close(() => resolve()));

  // out/test/integration -> out/test -> out -> project root
  const summaryPath =
    process.env.REQRUNNER_TEST_SUMMARY ??
    path.resolve(__dirname, '../../..', '.vscode-test', 'integration-summary.json');
  {
    const summary = {
      total: cases.length,
      passed,
      failed: failures.length,
      skippedChecks: [...new Set(skipped)],
      results: cases.map((testCase) => ({
        name: testCase.name,
        status: failures.some((failure) => failure.name === testCase.name) ? 'fail' : 'pass'
      })),
      failures: failures.map((failure) => ({
        name: failure.name,
        error: failure.error instanceof Error ? failure.error.message : String(failure.error)
      }))
    };
    try {
      fs.mkdirSync(path.dirname(summaryPath), { recursive: true });
      fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2), 'utf8');
    } catch (error) {
      console.error('Could not write the integration summary:', error);
    }
  }

  console.log(`\n  ${passed} passing, ${failures.length} failing`);
  if (skipped.length > 0) {
    console.log(`  ${skipped.length} check(s) skipped:`);
    for (const reason of new Set(skipped)) {
      console.log(`    - ${reason}`);
    }
  }
  console.log('');

  if (failures.length > 0) {
    for (const failure of failures) {
      console.error(`\n  ✗ ${failure.name}`);
      console.error(failure.error);
    }
    throw new Error(`${failures.length} integration test(s) failed`);
  }
}
