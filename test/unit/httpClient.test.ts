import assert from 'node:assert/strict';
import * as http from 'node:http';
import * as net from 'node:net';
import { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import * as zlib from 'node:zlib';
import { HttpError, parseRequestUrl, sendHttpRequest } from '../../src/core/httpClient';

interface CapturedRequest {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: string;
}

/** Requests the test server received, newest last. */
const captured: CapturedRequest[] = [];

let server: http.Server;
let origin: string;

/** Finds a port with nothing listening on it, for connection-failure tests. */
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

function readBody(request: http.IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}

before(async () => {
  server = http.createServer(async (request, response) => {
    const body = await readBody(request);
    captured.push({
      method: request.method ?? '',
      url: request.url ?? '',
      headers: request.headers,
      body
    });

    const url = new URL(request.url ?? '/', 'http://localhost');

    switch (url.pathname) {
      case '/json':
        response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        response.end(JSON.stringify({ id: 1, name: 'Ada', tags: ['a', 'b'] }));
        return;

      case '/text':
        response.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
        response.end('plain text response');
        return;

      case '/broken-json':
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end('{ "unterminated": ');
        return;

      case '/empty':
        response.writeHead(204);
        response.end();
        return;

      case '/echo':
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(
          JSON.stringify({
            method: request.method,
            contentType: request.headers['content-type'] ?? null,
            received: body
          })
        );
        return;

      case '/not-found':
        response.writeHead(404, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ error: 'not found' }));
        return;

      case '/server-error':
        response.writeHead(500, { 'Content-Type': 'text/plain' });
        response.end('boom');
        return;

      case '/gzip': {
        const payload = zlib.gzipSync(Buffer.from(JSON.stringify({ compressed: true })));
        response.writeHead(200, {
          'Content-Type': 'application/json',
          'Content-Encoding': 'gzip'
        });
        response.end(payload);
        return;
      }

      case '/binary':
        response.writeHead(200, { 'Content-Type': 'image/png' });
        response.end(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]));
        return;

      case '/multi-header':
        response.setHeader('Set-Cookie', ['a=1; Path=/', 'b=2; Path=/']);
        response.writeHead(200, { 'Content-Type': 'text/plain' });
        response.end('cookies');
        return;

      case '/redirect-once':
        response.writeHead(302, { Location: '/json' });
        response.end();
        return;

      case '/redirect-303':
        response.writeHead(303, { Location: '/echo' });
        response.end();
        return;

      case '/redirect-loop':
        response.writeHead(302, { Location: '/redirect-loop' });
        response.end();
        return;

      case '/slow':
        // Never answers, so the client-side timeout has to fire.
        return;

      default:
        response.writeHead(404, { 'Content-Type': 'text/plain' });
        response.end('unknown path');
    }
  });

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address() as AddressInfo;
  origin = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  server.closeAllConnections?.();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('parseRequestUrl', () => {
  it('accepts http and https URLs', () => {
    assert.equal(parseRequestUrl('http://a.example.com/x').protocol, 'http:');
    assert.equal(parseRequestUrl('https://a.example.com/x').protocol, 'https:');
  });

  it('assumes https for a bare host', () => {
    assert.equal(parseRequestUrl('api.example.com/users').href, 'https://api.example.com/users');
  });

  it('rejects an empty URL', () => {
    assert.throws(() => parseRequestUrl('   '), (error: unknown) => {
      assert.ok(error instanceof HttpError);
      assert.equal(error.kind, 'invalid-url');
      return true;
    });
  });

  it('rejects an unsupported protocol', () => {
    assert.throws(() => parseRequestUrl('ftp://example.com/x'), (error: unknown) => {
      assert.ok(error instanceof HttpError);
      assert.equal(error.kind, 'unsupported-protocol');
      return true;
    });
  });

  it('rejects a malformed URL', () => {
    assert.throws(() => parseRequestUrl('http://'), (error: unknown) => {
      assert.ok(error instanceof HttpError);
      assert.equal(error.kind, 'invalid-url');
      return true;
    });
  });
});

describe('sendHttpRequest', () => {
  it('returns a successful JSON response', async () => {
    const response = await sendHttpRequest({ method: 'GET', url: `${origin}/json` });

    assert.equal(response.status, 200);
    assert.equal(response.statusText, 'OK');
    assert.equal(response.method, 'GET');
    assert.match(response.headers['content-type'], /application\/json/);
    assert.deepEqual(JSON.parse(response.body), { id: 1, name: 'Ada', tags: ['a', 'b'] });
    assert.equal(response.isBinary, false);
    assert.ok(response.sizeBytes > 0);
    assert.ok(response.timeMs >= 0);
    assert.deepEqual(response.redirects, []);
  });

  it('returns a plain-text response as text', async () => {
    const response = await sendHttpRequest({ method: 'GET', url: `${origin}/text` });

    assert.equal(response.status, 200);
    assert.equal(response.body, 'plain text response');
  });

  it('returns invalid JSON verbatim rather than failing', async () => {
    const response = await sendHttpRequest({ method: 'GET', url: `${origin}/broken-json` });

    assert.equal(response.status, 200);
    assert.equal(response.body, '{ "unterminated": ');
  });

  it('handles a 204 with no body', async () => {
    const response = await sendHttpRequest({ method: 'GET', url: `${origin}/empty` });

    assert.equal(response.status, 204);
    assert.equal(response.body, '');
    assert.equal(response.sizeBytes, 0);
  });

  it('resolves normally for a 4xx response', async () => {
    const response = await sendHttpRequest({ method: 'GET', url: `${origin}/not-found` });

    assert.equal(response.status, 404);
    assert.deepEqual(JSON.parse(response.body), { error: 'not found' });
  });

  it('resolves normally for a 5xx response', async () => {
    const response = await sendHttpRequest({ method: 'GET', url: `${origin}/server-error` });

    assert.equal(response.status, 500);
    assert.equal(response.body, 'boom');
  });

  it('sends a POST body and the headers it was given', async () => {
    const payload = JSON.stringify({ customer: 'John' });
    const response = await sendHttpRequest({
      method: 'POST',
      url: `${origin}/echo`,
      headers: { 'Content-Type': 'application/json', 'X-Trace-Id': 'abc-123' },
      body: payload
    });

    assert.equal(response.status, 200);
    const echoed = JSON.parse(response.body);
    assert.equal(echoed.method, 'POST');
    assert.equal(echoed.contentType, 'application/json');
    assert.equal(echoed.received, payload);

    const sent = captured[captured.length - 1];
    assert.equal(sent.headers['x-trace-id'], 'abc-123');
    assert.equal(sent.headers['content-length'], String(Buffer.byteLength(payload)));
  });

  it('sends PUT, PATCH and DELETE with bodies', async () => {
    for (const method of ['PUT', 'PATCH', 'DELETE']) {
      const response = await sendHttpRequest({
        method,
        url: `${origin}/echo`,
        headers: { 'Content-Type': 'application/json' },
        body: `{"m":"${method}"}`
      });
      const echoed = JSON.parse(response.body);
      assert.equal(echoed.method, method);
      assert.equal(echoed.received, `{"m":"${method}"}`);
    }
  });

  it('sends HEAD without a body and receives none', async () => {
    const response = await sendHttpRequest({ method: 'HEAD', url: `${origin}/json` });

    assert.equal(response.status, 200);
    assert.equal(response.body, '');
  });

  it('preserves the query string', async () => {
    await sendHttpRequest({ method: 'GET', url: `${origin}/echo?a=1&b=two%20words` });

    assert.equal(captured[captured.length - 1].url, '/echo?a=1&b=two%20words');
  });

  it('adds a default User-Agent but does not override one that is given', async () => {
    await sendHttpRequest({ method: 'GET', url: `${origin}/text` });
    assert.match(String(captured[captured.length - 1].headers['user-agent']), /^ReqRunner\//);

    await sendHttpRequest({
      method: 'GET',
      url: `${origin}/text`,
      headers: { 'User-Agent': 'custom-agent' }
    });
    assert.equal(captured[captured.length - 1].headers['user-agent'], 'custom-agent');
  });

  it('decodes a gzip response', async () => {
    const response = await sendHttpRequest({ method: 'GET', url: `${origin}/gzip` });

    assert.deepEqual(JSON.parse(response.body), { compressed: true });
  });

  it('reports a binary payload instead of dumping bytes', async () => {
    const response = await sendHttpRequest({ method: 'GET', url: `${origin}/binary` });

    assert.equal(response.isBinary, true);
    assert.match(response.body, /binary image\/png, 6 bytes/);
  });

  it('keeps repeated response headers in rawHeaders', async () => {
    const response = await sendHttpRequest({ method: 'GET', url: `${origin}/multi-header` });

    const cookies = response.rawHeaders.filter(([name]) => name.toLowerCase() === 'set-cookie');
    assert.equal(cookies.length, 2);
    assert.equal(response.headers['set-cookie'], 'a=1; Path=/, b=2; Path=/');
  });

  it('follows a redirect and records it', async () => {
    const response = await sendHttpRequest({ method: 'GET', url: `${origin}/redirect-once` });

    assert.equal(response.status, 200);
    assert.equal(response.url, `${origin}/json`);
    assert.equal(response.redirects.length, 1);
  });

  it('does not follow redirects when told not to', async () => {
    const response = await sendHttpRequest({
      method: 'GET',
      url: `${origin}/redirect-once`,
      followRedirects: false
    });

    assert.equal(response.status, 302);
    assert.equal(response.headers['location'], '/json');
  });

  it('downgrades a 303 redirect to GET and drops the body', async () => {
    const response = await sendHttpRequest({
      method: 'POST',
      url: `${origin}/redirect-303`,
      headers: { 'Content-Type': 'application/json' },
      body: '{"a":1}'
    });

    const echoed = JSON.parse(response.body);
    assert.equal(echoed.method, 'GET');
    assert.equal(echoed.received, '');
  });

  it('stops after the redirect limit', async () => {
    await assert.rejects(
      sendHttpRequest({ method: 'GET', url: `${origin}/redirect-loop`, maxRedirects: 2 }),
      (error: unknown) => {
        assert.ok(error instanceof HttpError);
        assert.equal(error.kind, 'too-many-redirects');
        return true;
      }
    );
  });

  it('times out when the server never answers', async () => {
    await assert.rejects(
      sendHttpRequest({ method: 'GET', url: `${origin}/slow`, timeoutMs: 300 }),
      (error: unknown) => {
        assert.ok(error instanceof HttpError);
        assert.equal(error.kind, 'timeout');
        assert.match(error.message, /timed out/);
        return true;
      }
    );
  });

  it('reports a refused connection', async () => {
    const port = await findClosedPort();

    await assert.rejects(
      sendHttpRequest({ method: 'GET', url: `http://127.0.0.1:${port}/x`, timeoutMs: 4000 }),
      (error: unknown) => {
        assert.ok(error instanceof HttpError);
        assert.equal(error.kind, 'network');
        assert.match(error.message, /refused|reset/i);
        return true;
      }
    );
  });

  it('reports an unknown host', async () => {
    await assert.rejects(
      sendHttpRequest({
        method: 'GET',
        url: 'http://this-host-should-not-exist.reqrunner.invalid/x',
        timeoutMs: 8000
      }),
      (error: unknown) => {
        assert.ok(error instanceof HttpError);
        assert.ok(error.kind === 'network' || error.kind === 'timeout');
        return true;
      }
    );
  });

  it('rejects an invalid URL before opening a socket', async () => {
    await assert.rejects(
      sendHttpRequest({ method: 'GET', url: 'not a url at all' }),
      (error: unknown) => {
        assert.ok(error instanceof HttpError);
        assert.equal(error.kind, 'invalid-url');
        return true;
      }
    );
  });

  it('rejects an unsupported protocol', async () => {
    await assert.rejects(
      sendHttpRequest({ method: 'GET', url: 'ftp://example.com/x' }),
      (error: unknown) => {
        assert.ok(error instanceof HttpError);
        assert.equal(error.kind, 'unsupported-protocol');
        return true;
      }
    );
  });

  it('defaults to GET when no method is given', async () => {
    const response = await sendHttpRequest({ method: '', url: `${origin}/echo` });

    assert.equal(JSON.parse(response.body).method, 'GET');
  });
});
