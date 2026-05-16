/**
 * `contextify login --key <ctx_live_...> [--server <url>] [--name <label>]`
 *
 * Writes ~/.contextify/credentials.json (chmod 600) so subsequent
 * `contextify wrap`, `contextify prompt`, and `contextify ship` calls
 * send `Authorization: Bearer <key>`.
 *
 * Per the P3.5 codex consult, env var still takes precedence over the
 * file at request time, so this command can be safely run on machines
 * that ALSO set CONTEXTIFY_API_KEY — the env wins.
 */
import { saveCredentials, credentialsPath } from '../credentials.js';

export interface LoginArgs {
  readonly apiKey?: string;
  readonly serverUrl?: string;
  readonly name?: string;
}

const KEY_RE = /^ctx_live_[a-z2-9]{8}_[a-z2-9]{32}$/;

export async function runLogin(args: LoginArgs): Promise<number> {
  if (!args.apiKey) {
    process.stderr.write(
      'contextify login: --key <ctx_live_...> required.\n' +
        'Get a key from /dashboard/keys on your contextify server.\n',
    );
    return 2;
  }
  if (!KEY_RE.test(args.apiKey)) {
    process.stderr.write(
      'contextify login: --key does not look like a contextify api key.\n' +
        'Expected format: ctx_live_<8>_<32>\n',
    );
    return 2;
  }
  const path = saveCredentials({
    apiKey: args.apiKey,
    name: args.name,
    serverUrl: args.serverUrl,
  });
  process.stdout.write(`saved credentials to ${path} (chmod 600)\n`);
  return 0;
}

export function logoutPath(): string {
  return credentialsPath();
}
