import { describe, expect, it, vi } from 'vitest';
import { main, stripGlobalFlag, VERSION } from './index.js';

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

describe('@contextify/cli stripGlobalFlag', () => {
  it('strips the flag when it appears before the subcommand', () => {
    const argv = ['--no-update-check', 'init', '--name', 'foo'];
    expect(stripGlobalFlag(argv, '--no-update-check')).toBe(true);
    expect(argv).toEqual(['init', '--name', 'foo']);
  });

  it('returns false when the flag is absent', () => {
    const argv = ['init', '--name', 'foo'];
    expect(stripGlobalFlag(argv, '--no-update-check')).toBe(false);
    expect(argv).toEqual(['init', '--name', 'foo']);
  });

  it('does NOT strip the flag when it appears after the subcommand', () => {
    // A subcommand may legitimately accept --no-update-check itself.
    const argv = ['init', '--no-update-check'];
    expect(stripGlobalFlag(argv, '--no-update-check')).toBe(false);
    expect(argv).toEqual(['init', '--no-update-check']);
  });

  it('does NOT strip the flag past a `--` separator (wrap regression)', () => {
    // `contextify wrap -- mycmd --no-update-check` must pass the flag to mycmd,
    // not silently swallow it.
    const argv = ['wrap', '--', 'mycmd', '--no-update-check'];
    expect(stripGlobalFlag(argv, '--no-update-check')).toBe(false);
    expect(argv).toEqual(['wrap', '--', 'mycmd', '--no-update-check']);
  });

  it('strips multiple occurrences appearing before the subcommand', () => {
    const argv = ['--no-update-check', '--no-update-check', 'ship'];
    expect(stripGlobalFlag(argv, '--no-update-check')).toBe(true);
    expect(argv).toEqual(['ship']);
  });
});
