import { describe, expect, it, vi } from 'vitest';
import { main, VERSION } from './index.js';

describe('@contextify/cli entry', () => {
  it('--version prints semver and exits 0', async () => {
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    expect(await main({ argv: ['--version'] })).toBe(0);
    expect(spy).toHaveBeenCalledWith(`${VERSION}\n`);
    spy.mockRestore();
  });

  it('no args prints help and exits 0', async () => {
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    expect(await main({ argv: [] })).toBe(0);
    expect(spy.mock.calls[0]?.[0]).toContain('Usage:');
    spy.mockRestore();
  });

  it('--help prints help and exits 0', async () => {
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    expect(await main({ argv: ['--help'] })).toBe(0);
    spy.mockRestore();
  });

  it('unknown command exits 2', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    expect(await main({ argv: ['nope'] })).toBe(2);
    stderr.mockRestore();
  });
});
