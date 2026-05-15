import { resolveConfig } from '../config.js';
import { flushSpool } from '../shipper.js';

export interface ShipArgs {
  readonly cwd: string;
  readonly env?: NodeJS.ProcessEnv;
}

export async function runShip(args: ShipArgs): Promise<number> {
  let config;
  try {
    config = await resolveConfig(args.cwd, args.env);
  } catch (err) {
    process.stderr.write(`gbrain: ${(err as Error).message}\n`);
    return 2;
  }
  const result = await flushSpool({ serverUrl: config.serverUrl, cwd: args.cwd });
  process.stdout.write(
    `${JSON.stringify({
      attempted: result.attempted,
      sent: result.sent,
      remaining: result.remaining,
    })}\n`,
  );
  return result.remaining === 0 ? 0 : 1;
}
