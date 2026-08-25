import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { findRequestAtLine, isSendable, parseDocument } from '../../src/core/parser';

describe('parseDocument', () => {
  it('parses a single request with no headers or body', () => {
    const doc = parseDocument('### Get users\nGET https://api.example.com/users\n');

    assert.equal(doc.requests.length, 1);
    const request = doc.requests[0];
    assert.equal(request.name, 'Get users');
    assert.equal(request.method, 'GET');
    assert.equal(request.url, 'https://api.example.com/users');
    assert.deepEqual(request.headers, []);
    assert.equal(request.body, undefined);
    assert.deepEqual(request.errors, []);
    assert.equal(isSendable(request), true);
  });

  it('parses multiple requests and keeps their order and indexes', () => {
    const text = [
      '### First',
      'GET https://api.example.com/a',
      '',
      '### Second',
      'POST https://api.example.com/b',
      '',
      '### Third',
      'DELETE https://api.example.com/c'
    ].join('\n');

    const doc = parseDocument(text);

    assert.equal(doc.requests.length, 3);
    assert.deepEqual(
      doc.requests.map((r) => [r.index, r.name, r.method]),
      [
        [0, 'First', 'GET'],
        [1, 'Second', 'POST'],
        [2, 'Third', 'DELETE']
      ]
    );
  });

  it('parses headers in the compact style', () => {
    const text = [
      '### Get users',
      'GET https://api.example.com/users',
      'Accept: application/json',
      'X-Trace-Id: abc-123'
    ].join('\n');

    const request = parseDocument(text).requests[0];

    assert.deepEqual(
      request.headers.map((h) => [h.name, h.value]),
      [
        ['Accept', 'application/json'],
        ['X-Trace-Id', 'abc-123']
      ]
    );
    assert.equal(request.body, undefined);
  });

  it('parses headers separated from the request line by blank lines', () => {
    // This is the spaced-out style used in the README.
    const text = [
      '### Get all bookings',
      '',
      'GET https://api.example.com/bookings',
      '',
      'Authorization: Bearer {{token}}',
      ''
    ].join('\n');

    const request = parseDocument(text).requests[0];

    assert.equal(request.method, 'GET');
    assert.equal(request.url, 'https://api.example.com/bookings');
    assert.deepEqual(
      request.headers.map((h) => [h.name, h.value]),
      [['Authorization', 'Bearer {{token}}']]
    );
    assert.equal(request.body, undefined);
  });

  it('parses a JSON body and preserves its formatting', () => {
    const text = [
      '### Create booking',
      '',
      'POST https://api.example.com/bookings',
      '',
      'Content-Type: application/json',
      '',
      '{',
      '  "customer": "John",',
      '  "route": "Chennai-Bangalore"',
      '}',
      ''
    ].join('\n');

    const request = parseDocument(text).requests[0];

    assert.equal(request.method, 'POST');
    assert.deepEqual(
      request.headers.map((h) => h.name),
      ['Content-Type']
    );
    assert.equal(
      request.body,
      '{\n  "customer": "John",\n  "route": "Chennai-Bangalore"\n}'
    );
    assert.deepEqual(JSON.parse(request.body!), {
      customer: 'John',
      route: 'Chennai-Bangalore'
    });
  });

  it('keeps blank lines inside a body', () => {
    const text = ['### Text', 'POST https://api.example.com/text', '', 'line one', '', 'line two', ''].join(
      '\n'
    );

    const request = parseDocument(text).requests[0];

    assert.equal(request.body, 'line one\n\nline two');
  });

  it('treats a body of only whitespace as no body', () => {
    const text = ['### Empty', 'POST https://api.example.com/empty', '', '   ', '', ''].join('\n');

    const request = parseDocument(text).requests[0];

    assert.equal(request.body, undefined);
  });

  it('reports a malformed block instead of throwing', () => {
    const text = ['### Broken', 'this is not a request line', ''].join('\n');

    const doc = parseDocument(text);
    const request = doc.requests[0];

    assert.equal(request.method, '');
    assert.equal(request.url, '');
    assert.equal(request.requestLine, 1);
    assert.equal(request.errors.length, 1);
    assert.match(request.errors[0], /Could not read a request line/);
    assert.equal(isSendable(request), false);
  });

  it('reports an empty block', () => {
    const doc = parseDocument('### Nothing here\n\n');
    const request = doc.requests[0];

    assert.equal(request.requestLine, -1);
    assert.match(request.errors[0], /No request line found/);
    assert.equal(isSendable(request), false);
  });

  it('reports an unsupported method', () => {
    const doc = parseDocument('### Weird\nFETCH https://api.example.com/x\n');
    const request = doc.requests[0];

    assert.equal(isSendable(request), false);
    assert.match(request.errors[0], /Unsupported HTTP method "FETCH"/);
  });

  it('reports a request line without a URL', () => {
    const doc = parseDocument('### No url\nGET\n');
    const request = doc.requests[0];

    assert.equal(isSendable(request), false);
  });

  it('keeps a malformed block from breaking the blocks around it', () => {
    const text = [
      '### Good one',
      'GET https://api.example.com/a',
      '',
      '### Broken',
      'nonsense here',
      '',
      '### Good two',
      'GET https://api.example.com/b'
    ].join('\n');

    const doc = parseDocument(text);

    assert.equal(doc.requests.length, 3);
    assert.deepEqual(doc.requests.map(isSendable), [true, false, true]);
  });

  it('supports every documented HTTP method', () => {
    const methods = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];
    const text = methods
      .map((method) => `### ${method}\n${method} https://api.example.com/x`)
      .join('\n\n');

    const doc = parseDocument(text);

    assert.deepEqual(
      doc.requests.map((r) => r.method),
      methods
    );
    assert.equal(doc.requests.every(isSendable), true);
  });

  it('uppercases a lower-case method', () => {
    const request = parseDocument('### x\npost https://api.example.com/x\n').requests[0];
    assert.equal(request.method, 'POST');
  });

  it('defaults to GET when only a URL is given', () => {
    const request = parseDocument('### Bare\nhttps://api.example.com/bare\n').requests[0];

    assert.equal(request.method, 'GET');
    assert.equal(request.url, 'https://api.example.com/bare');
    assert.equal(isSendable(request), true);
  });

  it('ignores a trailing HTTP version on the request line', () => {
    const request = parseDocument('### v\nGET https://api.example.com/v HTTP/1.1\n').requests[0];

    assert.equal(request.method, 'GET');
    assert.equal(request.url, 'https://api.example.com/v');
  });

  it('reads file-level and block-level variables', () => {
    const text = [
      '@baseUrl = https://api.example.com',
      '@token = abc',
      '',
      '### One',
      '@token = block-override',
      'GET {{baseUrl}}/one',
      '',
      '### Two',
      'GET {{baseUrl}}/two'
    ].join('\n');

    const doc = parseDocument(text);

    assert.deepEqual(doc.fileVariables, {
      baseUrl: 'https://api.example.com',
      token: 'abc'
    });
    assert.equal(doc.requests[0].variables.token, 'block-override');
    assert.equal(doc.requests[0].variables.baseUrl, 'https://api.example.com');
    assert.equal(doc.requests[1].variables.token, 'abc');
  });

  it('ignores comment lines but never treats ### as a comment', () => {
    const text = [
      '# a leading comment',
      '// another comment',
      '### Named',
      '# comment inside the block',
      'GET https://api.example.com/x',
      '// comment between headers',
      'Accept: application/json'
    ].join('\n');

    const doc = parseDocument(text);

    assert.equal(doc.requests.length, 1);
    assert.equal(doc.requests[0].name, 'Named');
    assert.deepEqual(
      doc.requests[0].headers.map((h) => h.name),
      ['Accept']
    );
  });

  it('handles CRLF line endings', () => {
    const text = '### Get\r\nGET https://api.example.com/x\r\nAccept: application/json\r\n';

    const request = parseDocument(text).requests[0];

    assert.equal(request.url, 'https://api.example.com/x');
    assert.deepEqual(
      request.headers.map((h) => h.value),
      ['application/json']
    );
  });

  it('parses a file with no separator as one implicit request', () => {
    const request = parseDocument('GET https://api.example.com/only\n').requests[0];

    assert.equal(request.method, 'GET');
    assert.equal(request.startLine, 0);
    assert.equal(isSendable(request), true);
  });

  it('returns no requests for an empty or comment-only document', () => {
    assert.deepEqual(parseDocument('').requests, []);
    assert.deepEqual(parseDocument('\n\n   \n').requests, []);
    assert.deepEqual(parseDocument('# just a note\n').requests, []);
  });

  it('strips decorative trailing hashes from the name', () => {
    const request = parseDocument('### Get users ###\nGET https://api.example.com/u\n').requests[0];
    assert.equal(request.name, 'Get users');
  });

  it('falls back to method and URL when the block has no name', () => {
    const request = parseDocument('###\nGET https://api.example.com/u\n').requests[0];
    assert.equal(request.name, 'GET https://api.example.com/u');
  });

  it('falls back to a numbered name when the block is unusable', () => {
    const doc = parseDocument('### \n\n### \n');
    assert.equal(doc.requests[0].name, 'Request 1');
    assert.equal(doc.requests[1].name, 'Request 2');
  });

  it('does not mistake a bare URL body for a header', () => {
    const text = ['### Text body', 'POST https://api.example.com/x', '', 'http://example.com/page'].join(
      '\n'
    );

    const request = parseDocument(text).requests[0];

    assert.deepEqual(request.headers, []);
    assert.equal(request.body, 'http://example.com/page');
  });

  it('records line numbers for lenses and reveal', () => {
    const text = [
      '### First', // 0
      'GET https://api.example.com/a', // 1
      'Accept: text/plain', // 2
      '', // 3
      '### Second', // 4
      'GET https://api.example.com/b', // 5
      '' // 6
    ].join('\n');

    const doc = parseDocument(text);

    assert.equal(doc.requests[0].startLine, 0);
    assert.equal(doc.requests[0].requestLine, 1);
    assert.equal(doc.requests[0].headers[0].line, 2);
    assert.equal(doc.requests[0].endLine, 2);
    assert.equal(doc.requests[1].startLine, 4);
    assert.equal(doc.requests[1].requestLine, 5);
  });
});

describe('findRequestAtLine', () => {
  const text = [
    '### First', // 0
    'GET https://api.example.com/a', // 1
    '', // 2
    '### Second', // 3
    'GET https://api.example.com/b', // 4
    'Accept: text/plain' // 5
  ].join('\n');
  const doc = parseDocument(text);

  it('finds the block the cursor sits in', () => {
    assert.equal(findRequestAtLine(doc, 0)?.name, 'First');
    assert.equal(findRequestAtLine(doc, 1)?.name, 'First');
    assert.equal(findRequestAtLine(doc, 2)?.name, 'First');
    assert.equal(findRequestAtLine(doc, 3)?.name, 'Second');
    assert.equal(findRequestAtLine(doc, 5)?.name, 'Second');
  });

  it('returns undefined when the document has no requests', () => {
    assert.equal(findRequestAtLine(parseDocument(''), 0), undefined);
  });
});
