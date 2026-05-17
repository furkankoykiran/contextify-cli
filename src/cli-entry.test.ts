/**
 * Regression test for the CLI auto-run guard.
 *
 * The bin entry must trigger main() both when invoked as
 *   node ./dist/index.js
 * AND when invoked through a symlink installed by `npm link` / `npm i -g`:
 *   node /usr/local/bin/contextify
 *
 * The naïve `import.meta.url === \`file://${process.argv[1]}\`` form
 * fails the symlink case because argv[1] is the link path while
 * import.meta.url is the resolved module path. We resolve both via
 * fs.realpathSync before comparing.
 */
import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);

const here = dirname(fileURLToPath(import.meta.url));
const distEntry = resolve(here, '..', 'dist', 'index.js');

describe('@contextify/cli auto-run guard', () => {
  let tmp: string;
  let linkPath: string;

  beforeAll(() => {
    if (!existsSync(distEntry)) {
      // The CLI must be built before this test runs (vitest doesn't trigger tsc).
      throw new Error(`dist entry not found at ${distEntry} — run \`pnpm build\` first`);
    }
    tmp = mkdtempSync(join(tmpdir(), 'contextify-bin-'));
    linkPath = join(tmp, 'contextify');
    symlinkSync(distEntry, linkPath);
  });

  afterAll(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('runs main() when invoked directly as `node dist/index.js`', async () => {
    const { stdout } = await execFileAsync(process.execPath, [distEntry, '--version']);
    expect(stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('runs main() when invoked through a symlink (npm link / npm i -g)', async () => {
    const { stdout } = await execFileAsync(process.execPath, [linkPath, '--version']);
    expect(stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('prints help when invoked through a symlink with no args', async () => {
    const { stdout } = await execFileAsync(process.execPath, [linkPath]);
    expect(stdout).toContain('Usage:');
    expect(stdout).toContain('contextify init');
  });
});
