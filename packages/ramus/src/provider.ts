import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import type { DeviceLease, DeviceProvider } from '@e2e-dev/mobile';
import { command } from './cli.ts';

/** Options for Android sessions provisioned through ramus-cli. */
export interface RamusOptions {
  /** Time to wait for a created device to become active and its ADB tunnel to connect. Default: 180000 ms. */
  readonly startupTimeout?: number | undefined;
}

interface Session {
  id?: string;
  readonly directory: string;
  readonly env: NodeJS.ProcessEnv;
}

/** Recovers a session created before the CLI failed or its stdout was lost. The directory belongs only to this acquisition. */
async function recoverId(session: Session): Promise<void> {
  if (session.id !== undefined) return;
  try {
    const state: unknown = JSON.parse(await readFile(path.join(session.directory, 'state.json'), 'utf8'));
    if (typeof state !== 'object' || state === null || !('lastSession' in state)) return;
    const last = state.lastSession;
    if (typeof last === 'object' && last !== null && 'id' in last && typeof last.id === 'string') session.id = last.id;
  } catch { /* No session was persisted. */ }
}

/** Attempts every cleanup action, including after a tunnel-close failure, and preserves state if cleanup fails. */
async function cleanup(session: Session, signal: AbortSignal): Promise<void> {
  await recoverId(session);
  const failures: unknown[] = [];
  if (session.id !== undefined) {
    for (const args of [
      ['adb', '--close', '--session', session.id],
      ['session', 'end', '--session', session.id],
    ]) {
      try { await command(args, session.env, signal); } catch (error) { failures.push(error); }
    }
  }
  try { await command(['daemon', '--stop'], session.env, signal); } catch (error) { failures.push(error); }
  if (failures.length > 0) {
    throw new Error(`Ramus cleanup failed for session ${session.id ?? 'unknown'}; state retained at ${session.directory}`, { cause: new AggregateError(failures) });
  }
  await rm(session.directory, { recursive: true, force: true });
}

/** Leases one Ramus Android emulator per worker and exposes it to the local agent-device daemon through ADB. */
export function ramus(options: RamusOptions = {}): DeviceProvider {
  for (const key of Object.keys(options)) if (key !== 'startupTimeout') throw new Error(`ramus: unknown option ${key}`);
  const startupTimeout = options.startupTimeout ?? 180_000;
  if (!Number.isSafeInteger(startupTimeout) || startupTimeout <= 0) throw new Error('ramus: startupTimeout must be a positive integer');
  const sessions = new Map<string, Session>();
  return {
    name: 'ramus',
    async acquire(request): Promise<DeviceLease> {
      if (request.platform !== 'android') throw new Error('Ramus supports Android only');
      if (!request.env.RAMUS_API_KEY?.trim()) throw new Error('RAMUS_API_KEY is required; trial credentials cannot open ADB tunnels');
      if (!request.appPath || !request.app) throw new Error('ramus requires app.appPath pointing to an APK and app.bundleId');
      request.signal.throwIfAborted();
      const directory = await mkdtemp(path.join(tmpdir(), 'e2e-ramus-'));
      const session: Session = { directory, env: { ...request.env, RAMUS_CONFIG_DIR: directory } };
      try {
        // Learn the created id even when the run is interrupted during upload or creation.
        const created = await command(['session', 'start', '--apk', request.appPath], session.env, AbortSignal.timeout(240_000));
        if (typeof created.session !== 'string' || created.session === '') throw new Error('Ramus did not return a session id');
        session.id = created.session;
        request.log(`session ${session.id}`);
        const signal = AbortSignal.any([request.signal, AbortSignal.timeout(startupTimeout)]);
        for (;;) {
          signal.throwIfAborted();
          const status = await command(['session', 'status', '--session', session.id], session.env, signal);
          if (status.session !== session.id) throw new Error('Ramus replaced the leased session unexpectedly');
          if (status.status === 'active') break;
          if (status.status !== 'requested' && status.status !== 'assigned' && status.status !== 'preparing') {
            throw new Error('Ramus session ended or returned an unsupported status before it became active');
          }
          await sleep(1_000, undefined, { signal });
        }
        const tunnel = await command(['adb', '--session', session.id], session.env, signal);
        if (tunnel.state !== 'device' || typeof tunnel.serial !== 'string' || !/^127\.0\.0\.1:\d+$/.test(tunnel.serial)) {
          throw new Error('Ramus ADB tunnel is not connected; install Android platform-tools and put adb on PATH');
        }
        signal.throwIfAborted();
        sessions.set(session.id, session);
        return { id: session.id, deviceId: tunnel.serial, client: {}, installedApp: request.app };
      } catch (cause) {
        try { await cleanup(session, AbortSignal.timeout(30_000)); } catch (error) {
          throw new AggregateError([cause, error], `Ramus acquisition and cleanup failed; state retained at ${directory}`, { cause: error });
        }
        throw cause;
      }
    },
    async release(lease, context): Promise<void> {
      const session = sessions.get(lease.id);
      if (session === undefined) return;
      await cleanup(session, context.signal);
      sessions.delete(lease.id);
    },
  };
}
