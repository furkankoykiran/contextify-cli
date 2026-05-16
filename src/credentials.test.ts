import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { credentialsPath, resolveApiKey, saveCredentials } from './credentials.js';

const SAVE_HOME_ENV = '__SAVED_HOME__';

describe('credentials resolver', () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'ctx-creds-'));
    process.env[SAVE_HOME_ENV] = process.env.HOME ?? '';
    process.env.HOME = home;
  });

  afterEach(() => {
    process.env.HOME = process.env[SAVE_HOME_ENV] || undefined;
    delete process.env[SAVE_HOME_ENV];
    delete process.env.CONTEXTIFY_API_KEY;
  });

  it('returns null when no key is present anywhere', () => {
    expect(resolveApiKey({})).toBeNull();
  });

  it('reads CONTEXTIFY_API_KEY from env first', () => {
    saveCredentials({ apiKey: 'ctx_live_aaaaaaaa_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' }, home);
    const result = resolveApiKey({
      CONTEXTIFY_API_KEY: 'ctx_live_zzzzzzzz_yyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyy',
    });
    expect(result?.source).toBe('env');
    expect(result?.apiKey).toBe('ctx_live_zzzzzzzz_yyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyy');
  });

  it('falls back to the file when env is unset', () => {
    saveCredentials({ apiKey: 'ctx_live_aaaaaaaa_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' }, home);
    const result = resolveApiKey({});
    expect(result?.source).toBe('file');
    expect(result?.apiKey).toBe('ctx_live_aaaaaaaa_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
  });

  it('writes the credentials file with restrictive permissions (0o600)', () => {
    const path = saveCredentials(
      { apiKey: 'ctx_live_aaaaaaaa_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', name: 'laptop' },
      home,
    );
    expect(path).toBe(credentialsPath(home));
    const mode = statSync(path).mode & 0o777;
    expect(mode).toBe(0o600);
    const json = JSON.parse(readFileSync(path, 'utf8'));
    expect(json.apiKey).toMatch(/^ctx_live_/);
    expect(json.name).toBe('laptop');
    expect(typeof json.savedAt).toBe('string');
  });

  it('ignores a corrupt credentials file silently', () => {
    saveCredentials({ apiKey: 'ctx_live_aaaaaaaa_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' }, home);
    writeFileSync(credentialsPath(home), '{ this is not json');
    expect(resolveApiKey({})).toBeNull();
  });

  it('ignores a file whose apiKey is not ctx_live_*', () => {
    mkdirSync(join(home, '.contextify'), { recursive: true });
    writeFileSync(credentialsPath(home), JSON.stringify({ apiKey: 'not-our-format' }));
    expect(resolveApiKey({})).toBeNull();
  });
});
