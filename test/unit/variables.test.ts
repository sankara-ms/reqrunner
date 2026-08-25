import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseDocument } from '../../src/core/parser';
import { findPlaceholders, resolveRequest, resolveText } from '../../src/core/variables';

describe('resolveText', () => {
  it('replaces an existing variable', () => {
    const result = resolveText('{{baseUrl}}/users', { baseUrl: 'https://api.example.com' });

    assert.equal(result.text, 'https://api.example.com/users');
    assert.deepEqual(result.missing, []);
  });

  it('leaves a missing variable in place and reports it', () => {
    const result = resolveText('{{baseUrl}}/users', {});

    assert.equal(result.text, '{{baseUrl}}/users');
    assert.deepEqual(result.missing, ['baseUrl']);
  });

  it('replaces multiple variables in one string', () => {
    const result = resolveText('{{scheme}}://{{host}}/{{path}}', {
      scheme: 'https',
      host: 'api.example.com',
      path: 'users'
    });

    assert.equal(result.text, 'https://api.example.com/users');
    assert.deepEqual(result.missing, []);
  });

  it('replaces every occurrence of the same variable', () => {
    const result = resolveText('{{a}}-{{a}}-{{a}}', { a: 'x' });
    assert.equal(result.text, 'x-x-x');
  });

  it('reports each missing name only once', () => {
    const result = resolveText('{{a}} {{a}} {{b}}', {});
    assert.deepEqual(result.missing, ['a', 'b']);
  });

  it('tolerates whitespace inside the braces', () => {
    const result = resolveText('{{  baseUrl  }}/x', { baseUrl: 'https://h' });
    assert.equal(result.text, 'https://h/x');
  });

  it('resolves values that reference other variables', () => {
    const result = resolveText('{{usersUrl}}', {
      baseUrl: 'https://api.example.com',
      usersUrl: '{{baseUrl}}/users'
    });

    assert.equal(result.text, 'https://api.example.com/users');
    assert.deepEqual(result.missing, []);
  });

  it('does not loop forever on a self-referencing variable', () => {
    const result = resolveText('{{a}}', { a: '{{a}}' });
    assert.equal(result.text, '{{a}}');
  });

  it('does not loop forever on a cycle between two variables', () => {
    const result = resolveText('{{a}}', { a: '{{b}}', b: '{{a}}' });
    assert.equal(typeof result.text, 'string');
  });

  it('leaves text without placeholders untouched', () => {
    const result = resolveText('plain text { not a placeholder }', { a: '1' });
    assert.equal(result.text, 'plain text { not a placeholder }');
  });

  it('treats an empty-string value as defined', () => {
    const result = resolveText('[{{empty}}]', { empty: '' });

    assert.equal(result.text, '[]');
    assert.deepEqual(result.missing, []);
  });
});

describe('findPlaceholders', () => {
  it('lists distinct placeholder names', () => {
    assert.deepEqual(findPlaceholders('{{a}}/{{b}}/{{a}}'), ['a', 'b']);
  });

  it('returns an empty list when there are none', () => {
    assert.deepEqual(findPlaceholders('https://api.example.com'), []);
  });
});

describe('resolveRequest', () => {
  const parse = (text: string) => parseDocument(text).requests[0];

  it('resolves a variable inside the URL', () => {
    const request = parse('### x\nGET {{baseUrl}}/users\n');
    const { request: resolved, missing } = resolveRequest(request, {
      baseUrl: 'https://api.example.com'
    });

    assert.equal(resolved.url, 'https://api.example.com/users');
    assert.deepEqual(missing, []);
  });

  it('resolves a variable inside a header value', () => {
    const request = parse('### x\nGET https://h/users\nAuthorization: Bearer {{token}}\n');
    const { request: resolved } = resolveRequest(request, { token: 'secret-value' });

    assert.equal(resolved.headers['Authorization'], 'Bearer secret-value');
  });

  it('resolves a variable used as a header name', () => {
    const request = parse('### x\nGET https://h/users\n{{headerName}}: on\n');
    const { request: resolved } = resolveRequest(request, { headerName: 'X-Feature' });

    assert.equal(resolved.headers['X-Feature'], 'on');
  });

  it('resolves variables inside the body', () => {
    const request = parse(
      ['### x', 'POST https://h/users', 'Content-Type: application/json', '', '{"name": "{{name}}"}'].join(
        '\n'
      )
    );
    const { request: resolved } = resolveRequest(request, { name: 'Ada' });

    assert.equal(resolved.body, '{"name": "Ada"}');
    assert.deepEqual(JSON.parse(resolved.body!), { name: 'Ada' });
  });

  it('collects missing names from URL, headers and body together', () => {
    const request = parse(
      ['### x', 'POST {{baseUrl}}/users', 'Authorization: Bearer {{token}}', '', '{"id": "{{id}}"}'].join(
        '\n'
      )
    );
    const { missing } = resolveRequest(request, {});

    assert.deepEqual(missing, ['baseUrl', 'token', 'id']);
  });

  it('lets document variables override the environment', () => {
    const request = parse('### x\n@token = from-document\nGET https://h/x\nAuthorization: {{token}}\n');
    const { request: resolved } = resolveRequest(request, { token: 'from-env' });

    assert.equal(resolved.headers['Authorization'], 'from-document');
  });

  it('uses file-level document variables', () => {
    const doc = parseDocument('@baseUrl = https://from-file\n\n### x\nGET {{baseUrl}}/x\n');
    const { request: resolved } = resolveRequest(doc.requests[0], {});

    assert.equal(resolved.url, 'https://from-file/x');
  });

  it('combines repeated header names instead of dropping one', () => {
    const request = parse('### x\nGET https://h/x\nX-Tag: a\nX-Tag: b\n');
    const { request: resolved } = resolveRequest(request, {});

    assert.equal(resolved.headers['X-Tag'], 'a, b');
  });

  it('keeps an undefined body undefined', () => {
    const request = parse('### x\nGET https://h/x\n');
    const { request: resolved } = resolveRequest(request, {});

    assert.equal(resolved.body, undefined);
  });

  it('works with no environment argument at all', () => {
    const request = parse('### x\nGET https://h/x\n');
    const { request: resolved, missing } = resolveRequest(request);

    assert.equal(resolved.url, 'https://h/x');
    assert.deepEqual(missing, []);
  });
});
