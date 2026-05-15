import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { configPath, readConfig, resolveConfig, writeConfig } from './config.js';

describe('@gbrain/cli config', () => {
  let cwd: string;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'gbrain-cfg-'));
  });
  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  it('writeConfig round-trips via readConfig', async () => {
    await writeConfig(cwd, {
      projectId: 'divimero',
      projectName: 'Divimero',
      serverUrl: 'http://localhost:3000',
    });
    const out = await readConfig(cwd);
    expect(out).toEqual({
      projectId: 'divimero',
      projectName: 'Divimero',
      serverUrl: 'http://localhost:3000',
    });
  });

  it('writeConfig rejects unsafe project ids', async () => {
    await expect(
      writeConfig(cwd, { projectId: "x'; DROP TABLE", serverUrl: '' }),
    ).rejects.toThrow();
  });

  it('readConfig returns null when no file exists', async () => {
    expect(await readConfig(cwd)).toBeNull();
  });

  it('readConfig throws on malformed JSON', async () => {
    const { writeFileSync } = await import('node:fs');
    writeFileSync(configPath(cwd), '{ bad json', 'utf8');
    await expect(readConfig(cwd)).rejects.toThrow();
  });

  it('readConfig throws when projectId is missing', async () => {
    const { writeFileSync } = await import('node:fs');
    writeFileSync(configPath(cwd), JSON.stringify({ serverUrl: 'x' }), 'utf8');
    await expect(readConfig(cwd)).rejects.toThrow();
  });

  describe('resolveConfig', () => {
    it('reads from file when no env overrides are set', async () => {
      await writeConfig(cwd, {
        projectId: 'divimero',
        serverUrl: 'http://localhost:3000',
      });
      const resolved = await resolveConfig(cwd, {});
      expect(resolved.source).toBe('file');
      expect(resolved.projectId).toBe('divimero');
    });

    it('env overrides win over file', async () => {
      await writeConfig(cwd, {
        projectId: 'divimero',
        serverUrl: 'http://localhost:3000',
      });
      const resolved = await resolveConfig(cwd, {
        GBRAIN_PROJECT_ID: 'rival_empires',
        GBRAIN_SERVER_URL: 'https://example.com',
      });
      expect(resolved.projectId).toBe('rival_empires');
      expect(resolved.serverUrl).toBe('https://example.com');
      expect(resolved.source).toBe('mixed');
    });

    it('falls back to env-only when no file', async () => {
      const resolved = await resolveConfig(cwd, {
        GBRAIN_PROJECT_ID: 'rival_empires',
      });
      expect(resolved.source).toBe('env');
      expect(resolved.projectId).toBe('rival_empires');
    });

    it('rejects unsafe env project id', async () => {
      await expect(resolveConfig(cwd, { GBRAIN_PROJECT_ID: "x'; DROP TABLE" })).rejects.toThrow();
    });

    it('throws when no source provides a project id', async () => {
      await expect(resolveConfig(cwd, {})).rejects.toThrow();
    });
  });
});
