import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { after, before, describe, it } from 'node:test';
import {
  DEFAULT_ENV_FILE_NAME,
  findEnvironmentFiles,
  loadEnvironment,
  parseEnvironmentJson
} from '../../src/core/envFile';

describe('parseEnvironmentJson', () => {
  it('reads string values', () => {
    const result = parseEnvironmentJson('{"baseUrl":"https://api.example.com","token":"abc"}');

    assert.deepEqual(result.variables, {
      baseUrl: 'https://api.example.com',
      token: 'abc'
    });
    assert.equal(result.error, undefined);
  });

  it('stringifies numbers and booleans', () => {
    const result = parseEnvironmentJson('{"port":8080,"debug":true}');

    assert.deepEqual(result.variables, { port: '8080', debug: 'true' });
  });

  it('serialises nested objects so they can still be interpolated', () => {
    const result = parseEnvironmentJson('{"payload":{"a":1}}');

    assert.equal(result.variables.payload, '{"a":1}');
  });

  it('skips null values', () => {
    const result = parseEnvironmentJson('{"a":null,"b":"1"}');

    assert.deepEqual(result.variables, { b: '1' });
  });

  it('reports invalid JSON without throwing', () => {
    const result = parseEnvironmentJson('{ not json ');

    assert.deepEqual(result.variables, {});
    assert.match(result.error!, /Invalid JSON/);
  });

  it('rejects a top-level array', () => {
    const result = parseEnvironmentJson('[1,2,3]');

    assert.match(result.error!, /Expected a JSON object/);
  });

  it('treats an empty file as no variables', () => {
    assert.deepEqual(parseEnvironmentJson('').variables, {});
    assert.equal(parseEnvironmentJson('   \n').error, undefined);
  });

  it('tolerates a UTF-8 BOM', () => {
    const result = parseEnvironmentJson('\uFEFF{"a":"1"}');

    assert.deepEqual(result.variables, { a: '1' });
  });
});

describe('environment file lookup', () => {
  let root: string;
  let nested: string;

  before(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'reqrunner-env-'));
    nested = path.join(root, 'api', 'v2');
    fs.mkdirSync(nested, { recursive: true });
    fs.writeFileSync(
      path.join(root, DEFAULT_ENV_FILE_NAME),
      JSON.stringify({ baseUrl: 'https://root.example.com', token: 'root-token' })
    );
    fs.writeFileSync(
      path.join(nested, DEFAULT_ENV_FILE_NAME),
      JSON.stringify({ baseUrl: 'https://nested.example.com' })
    );
  });

  after(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('finds env files from the request folder upwards, nearest first', () => {
    const files = findEnvironmentFiles(nested, DEFAULT_ENV_FILE_NAME, root);

    assert.equal(files.length, 2);
    assert.equal(files[0], path.join(nested, DEFAULT_ENV_FILE_NAME));
    assert.equal(files[1], path.join(root, DEFAULT_ENV_FILE_NAME));
  });

  it('lets the nearest file override values from a parent', () => {
    const result = loadEnvironment(nested, DEFAULT_ENV_FILE_NAME, root);

    assert.equal(result.variables.baseUrl, 'https://nested.example.com');
    assert.equal(result.variables.token, 'root-token');
    assert.deepEqual(result.errors, []);
  });

  it('stops walking at the given root', () => {
    const files = findEnvironmentFiles(root, DEFAULT_ENV_FILE_NAME, root);

    assert.deepEqual(files, [path.join(root, DEFAULT_ENV_FILE_NAME)]);
  });

  it('returns nothing when no env file exists', () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'reqrunner-empty-'));
    try {
      const result = loadEnvironment(empty, DEFAULT_ENV_FILE_NAME, empty);

      assert.deepEqual(result.variables, {});
      assert.deepEqual(result.files, []);
      assert.deepEqual(result.errors, []);
    } finally {
      fs.rmSync(empty, { recursive: true, force: true });
    }
  });

  it('reports a malformed env file as an error and keeps going', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reqrunner-bad-'));
    try {
      fs.writeFileSync(path.join(dir, DEFAULT_ENV_FILE_NAME), '{ broken');
      const result = loadEnvironment(dir, DEFAULT_ENV_FILE_NAME, dir);

      assert.deepEqual(result.variables, {});
      assert.equal(result.errors.length, 1);
      assert.match(result.errors[0], /Invalid JSON/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('honours a custom env file name', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reqrunner-custom-'));
    try {
      fs.writeFileSync(path.join(dir, 'custom.env.json'), '{"a":"1"}');
      const result = loadEnvironment(dir, 'custom.env.json', dir);

      assert.deepEqual(result.variables, { a: '1' });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not throw for a directory that does not exist', () => {
    const result = loadEnvironment(path.join(os.tmpdir(), 'reqrunner-missing-dir-xyz'));

    assert.deepEqual(result.variables, {});
  });
});
