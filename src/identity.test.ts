import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  findConfigAncestor,
  hash12,
  normalizeGitRemote,
  resolveIdentity,
  slugify,
} from './identity.js';

const NULL_GIT = {
  gitRemoteUrl: async () => null,
  gitToplevel: async () => null,
};

describe('@contextify/cli identity — pure helpers', () => {
  it('normalizes ssh, https, port, .git, and case', () => {
    expect(normalizeGitRemote('git@github.com:FurkanKoykiran/contextify.git')).toBe(
      'github.com/furkankoykiran/contextify',
    );
    expect(normalizeGitRemote('https://github.com/furkankoykiran/contextify.git')).toBe(
      'github.com/furkankoykiran/contextify',
    );
    expect(normalizeGitRemote('ssh://git@github.com/furkankoykiran/contextify.git/')).toBe(
      'github.com/furkankoykiran/contextify',
    );
    expect(normalizeGitRemote('http://gitlab.example.com:8080/group/sub/repo.git')).toBe(
      'gitlab.example.com/group/sub/repo',
    );
  });

  it('returns null for non-url-shaped input', () => {
    expect(normalizeGitRemote('')).toBeNull();
    expect(normalizeGitRemote('not-a-remote')).toBeNull();
  });

  it('slugify lowercases, collapses, and bounds length', () => {
    expect(slugify('Contextify')).toBe('contextify');
    expect(slugify('My Cool Project!')).toBe('my-cool-project');
    expect(slugify('---trim---')).toBe('trim');
    expect(slugify('')).toBe('project');
    expect(slugify('x'.repeat(200)).length).toBe(64);
  });

  it('hash12 is deterministic and 12 hex chars', () => {
    const a = hash12('github.com/x/y');
    const b = hash12('github.com/x/y');
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{12}$/);
  });
});

describe('@contextify/cli identity — resolution stack', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'contextify-id-'));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('env override wins above all', async () => {
    // Write a config too — env must still win.
    writeFileSync(
      join(root, '.contextify.json'),
      JSON.stringify({ projectId: 'from-config', serverUrl: 'http://x' }),
    );
    const out = await resolveIdentity({
      cwd: root,
      env: { CONTEXTIFY_PROJECT_ID: 'env_pid', CONTEXTIFY_PROJECT_NAME: 'Env Project' },
      ...NULL_GIT,
    });
    expect(out.source).toBe('env');
    expect(out.projectId).toBe('env_pid');
    expect(out.projectName).toBe('Env Project');
  });

  it('rejects unsafe env id', async () => {
    await expect(
      resolveIdentity({
        cwd: root,
        env: { CONTEXTIFY_PROJECT_ID: "x'; DROP" },
        ...NULL_GIT,
      }),
    ).rejects.toThrow();
  });

  it('falls through env → config when env is missing', async () => {
    writeFileSync(
      join(root, '.contextify.json'),
      JSON.stringify({ projectId: 'configured', projectName: 'Cfg', serverUrl: 'http://x' }),
    );
    const out = await resolveIdentity({ cwd: root, env: {}, ...NULL_GIT });
    expect(out.source).toBe('config');
    expect(out.projectId).toBe('configured');
    expect(out.projectName).toBe('Cfg');
    expect(out.anchor).toBe(root);
  });

  it('finds .contextify.json in an ancestor directory', async () => {
    writeFileSync(
      join(root, '.contextify.json'),
      JSON.stringify({ projectId: 'ancestor', serverUrl: 'http://x' }),
    );
    const sub = join(root, 'a', 'b', 'c');
    mkdirSync(sub, { recursive: true });
    expect(findConfigAncestor(sub)).toBe(root);
    const out = await resolveIdentity({ cwd: sub, env: {}, ...NULL_GIT });
    expect(out.source).toBe('config');
    expect(out.projectId).toBe('ancestor');
  });

  it('falls through env+config → git when neither is present', async () => {
    const out = await resolveIdentity({
      cwd: root,
      env: {},
      gitToplevel: async () => root,
      gitRemoteUrl: async () => 'git@github.com:FurkanKoykiran/contextify.git',
    });
    expect(out.source).toBe('git-remote');
    expect(out.projectId.startsWith('contextify-')).toBe(true);
    // Same input → same id, proves stability across machines.
    const out2 = await resolveIdentity({
      cwd: root,
      env: {},
      gitToplevel: async () => '/c/src/contextify',
      gitRemoteUrl: async () => 'https://github.com/furkankoykiran/contextify',
    });
    expect(out2.projectId).toBe(out.projectId);
  });

  it('falls through to folder when env+config+git all miss', async () => {
    const out = await resolveIdentity({
      cwd: root,
      env: {},
      gitRemoteUrl: async () => null,
      gitToplevel: async () => null,
    });
    expect(out.source).toBe('folder');
    expect(out.projectId.length).toBeGreaterThan(0);
    // Re-running on the same path yields the same id.
    const out2 = await resolveIdentity({
      cwd: root,
      env: {},
      gitRemoteUrl: async () => null,
      gitToplevel: async () => null,
    });
    expect(out2.projectId).toBe(out.projectId);
  });
});
