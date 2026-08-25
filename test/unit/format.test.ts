import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  escapeHtml,
  formatBody,
  formatBytes,
  formatDuration,
  isSensitiveHeader,
  maskValue,
  statusCategory
} from '../../src/core/format';

describe('formatBody', () => {
  it('pretty-prints valid JSON', () => {
    const result = formatBody('{"a":1,"b":[1,2]}', 'application/json');

    assert.equal(result.language, 'json');
    assert.equal(result.prettified, true);
    assert.equal(result.text, '{\n  "a": 1,\n  "b": [\n    1,\n    2\n  ]\n}');
    assert.equal(result.warning, undefined);
  });

  it('detects JSON from the body when the content type is missing', () => {
    const result = formatBody('[1,2]');

    assert.equal(result.language, 'json');
    assert.equal(result.prettified, true);
  });

  it('returns invalid JSON untouched and warns when JSON was declared', () => {
    const result = formatBody('{ "oops": ', 'application/json');

    assert.equal(result.text, '{ "oops": ');
    assert.equal(result.prettified, false);
    assert.match(result.warning!, /declared JSON/);
  });

  it('does not warn when JSON was only guessed', () => {
    const result = formatBody('{ not json', 'text/plain');

    assert.equal(result.warning, undefined);
    assert.equal(result.prettified, false);
  });

  it('leaves plain text alone', () => {
    const result = formatBody('hello world', 'text/plain; charset=utf-8');

    assert.equal(result.language, 'text');
    assert.equal(result.text, 'hello world');
    assert.equal(result.prettified, false);
  });

  it('recognises html and xml', () => {
    assert.equal(formatBody('<html></html>', 'text/html').language, 'html');
    assert.equal(formatBody('<a/>', 'application/xml').language, 'xml');
    assert.equal(formatBody('<?xml version="1.0"?>').language, 'xml');
  });

  it('handles an empty body', () => {
    const result = formatBody('', 'application/json');

    assert.equal(result.text, '');
    assert.equal(result.prettified, false);
  });

  it('pretty-prints a JSON scalar', () => {
    assert.equal(formatBody('123', 'application/json').text, '123');
    assert.equal(formatBody('"hi"', 'application/json').text, '"hi"');
  });
});

describe('formatBytes', () => {
  it('formats bytes, kilobytes and megabytes', () => {
    assert.equal(formatBytes(0), '0 B');
    assert.equal(formatBytes(512), '512 B');
    assert.equal(formatBytes(2048), '2.0 KB');
    assert.equal(formatBytes(5 * 1024 * 1024), '5.00 MB');
  });

  it('guards against nonsense input', () => {
    assert.equal(formatBytes(-1), '0 B');
    assert.equal(formatBytes(Number.NaN), '0 B');
  });
});

describe('formatDuration', () => {
  it('uses milliseconds below a second and seconds above', () => {
    assert.equal(formatDuration(0), '0 ms');
    assert.equal(formatDuration(87.4), '87 ms');
    assert.equal(formatDuration(1500), '1.50 s');
  });

  it('guards against nonsense input', () => {
    assert.equal(formatDuration(-5), '0 ms');
    assert.equal(formatDuration(Number.NaN), '0 ms');
  });
});

describe('statusCategory', () => {
  it('buckets status codes', () => {
    assert.equal(statusCategory(100), 'informational');
    assert.equal(statusCategory(200), 'success');
    assert.equal(statusCategory(302), 'redirect');
    assert.equal(statusCategory(404), 'client-error');
    assert.equal(statusCategory(503), 'server-error');
    assert.equal(statusCategory(0), 'unknown');
  });
});

describe('escapeHtml', () => {
  it('escapes every character that could break out of the webview markup', () => {
    assert.equal(
      escapeHtml('<script>alert("x" & \'y\')</script>'),
      '&lt;script&gt;alert(&quot;x&quot; &amp; &#39;y&#39;)&lt;/script&gt;'
    );
  });
});

describe('sensitive headers', () => {
  it('flags credential headers regardless of case', () => {
    assert.equal(isSensitiveHeader('Authorization'), true);
    assert.equal(isSensitiveHeader('set-cookie'), true);
    assert.equal(isSensitiveHeader('Content-Type'), false);
  });

  it('masks values without revealing the start of the secret', () => {
    assert.equal(maskValue('short'), '••••••••');
    const masked = maskValue('Bearer abcdefghijklmnop');
    assert.equal(masked.endsWith('mnop'), true);
    assert.equal(masked.includes('Bearer'), false);
  });
});
