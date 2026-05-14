import { describe, expect, it, vi } from 'vitest';
import { main } from './index.js';

describe('@gbrain/cli smoke', () => {
  it('--version returns 0', () => {
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    expect(main(['--version'])).toBe(0);
    expect(spy).toHaveBeenCalledWith('0.1.0\n');
    spy.mockRestore();
  });

  it('default invocation prints help and returns 0', () => {
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    expect(main([])).toBe(0);
    expect(spy.mock.calls[0]?.[0]).toContain('telemetry CLI');
    spy.mockRestore();
  });
});
