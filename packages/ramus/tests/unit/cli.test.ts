import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { command } from '../../src/cli.ts';

const directories: string[] = [];

/** The real published CLI, isolated from personal credentials and configured without any API key. */
async function environment() {
  const directory = await mkdtemp(path.join(tmpdir(), 'ramus-cli-test-'));
  directories.push(directory);
  return { RAMUS_CONFIG_DIR: directory };
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

it('executes the installed CLI and parses JSON using only the supplied environment', async () => {
  const env = await environment();
  const result = await command(['status'], env, AbortSignal.timeout(10_000));
  expect(result.key).toBe('missing');
  expect(result.configDir).toBe(env.RAMUS_CONFIG_DIR);
});

it('reports command failure without echoing CLI output or arguments containing app data', async () => {
  await expect(command(['session', 'start', '--apk', '/private/sensitive-app.apk'], await environment(), AbortSignal.timeout(10_000)))
    .rejects.toThrow('Ramus CLI session start failed');
});

it('refuses an already cancelled command', async () => {
  const controller = new AbortController();
  controller.abort(new Error('cancelled before spawn'));
  await expect(command(['status'], await environment(), controller.signal)).rejects.toThrow('cancelled before spawn');
});
