#!/usr/bin/env node
/**
 * @gbrain/cli entrypoint.
 *
 * PR #1: prints help only. PR #6 introduces `gbrain init`, `gbrain wrap`, and
 * the PTY capture path that ships telemetry to the webhook.
 */

const HELP_TEXT = `gbrain — telemetry CLI (PR #1 stub)

Usage:
  gbrain --help      Show this message
  gbrain --version   Print version

Commands (coming in PR #6):
  gbrain init <project>   Bind cwd to a project
  gbrain wrap -- <cmd>    Spawn cmd in a PTY and ship telemetry
`;

export function main(argv: readonly string[]): number {
  if (argv.includes('--version') || argv.includes('-v')) {
    process.stdout.write('0.1.0\n');
    return 0;
  }
  process.stdout.write(HELP_TEXT);
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main(process.argv.slice(2)));
}
