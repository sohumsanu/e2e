import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import manifest from 'ramus-cli/package.json' with { type: 'json' };

const exec = promisify(execFile);

/** Runs the installed CLI without a shell. Never forwards output that may contain credentials or share links. */
export async function command(args: readonly string[], env: NodeJS.ProcessEnv, signal: AbortSignal): Promise<Record<string, unknown>> {
  signal.throwIfAborted();
  const executable = fileURLToPath(new URL(manifest.bin.ramus, import.meta.resolve('ramus-cli/package.json')));
  let stdout: string;
  try {
    ({ stdout } = await exec(process.execPath, [executable, ...args], {
      env,
      signal,
      timeout: 240_000,
      maxBuffer: 1024 * 1024,
      encoding: 'utf8',
    }));
  } catch {
    signal.throwIfAborted();
    throw new Error(`Ramus CLI ${args.slice(0, 2).join(' ')} failed; check the API key, account capacity, and Android platform-tools`);
  }
  let result: unknown;
  try { result = JSON.parse(stdout); } catch { throw new Error('Ramus CLI returned invalid JSON'); }
  if (typeof result !== 'object' || result === null || Array.isArray(result)) throw new Error('Ramus CLI returned an invalid result');
  return result as Record<string, unknown>;
}
