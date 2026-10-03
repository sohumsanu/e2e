import { access, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DeviceRequest } from '@e2e-dev/mobile';
import { command } from '../../src/cli.ts';
import { ramus } from '../../src/index.ts';

vi.mock('../../src/cli.ts', () => ({ command: vi.fn() }));
const run = vi.mocked(command);
const request = (extra: Partial<DeviceRequest> = {}): DeviceRequest => ({
  platform: 'android', runId: 'run', targetName: 'android', slot: 0, slots: 1,
  agentDeviceVersion: '0.21.18', app: 'dev.example', appPath: '/tmp/example.apk',
  projectRoot: '/tmp', env: { RAMUS_API_KEY: 'test-key' }, signal: new AbortController().signal,
  log: vi.fn(), ...extra,
});
const context = () => ({ runId: 'run', targetName: 'android', env: {}, signal: new AbortController().signal, log: vi.fn() });

/** Scripts the CLI contract with distinct remote sessions for parallel acquisitions. */
function successfulCli() {
  let next = 0;
  run.mockImplementation(async (args) => {
    if (args[0] === 'session' && args[1] === 'start') return { session: `session-${++next}`, status: 'requested' };
    if (args[0] === 'session' && args[1] === 'status') return { session: args[3], status: 'active' };
    if (args[0] === 'adb' && args[1] !== '--close') return { serial: `127.0.0.1:${5000 + next}`, state: 'device' };
    return {};
  });
}

afterEach(() => vi.resetAllMocks());

describe('ramus device provider', () => {
  it('returns an explicit Android serial and avoids reinstalling the uploaded APK', async () => {
    successfulCli();
    const provider = ramus();
    const lease = await provider.acquire(request());
    expect(lease).toEqual({ id: 'session-1', deviceId: '127.0.0.1:5001', client: {}, installedApp: 'dev.example' });
    const directory = run.mock.calls[0]![1].RAMUS_CONFIG_DIR!;
    expect(run.mock.calls[0]![0]).toEqual(['session', 'start', '--apk', '/tmp/example.apk']);
    await provider.release(lease, context());
    expect(run.mock.calls.slice(-3).map(([args]) => args)).toEqual([
      ['adb', '--close', '--session', 'session-1'], ['session', 'end', '--session', 'session-1'], ['daemon', '--stop'],
    ]);
    await expect(access(directory)).rejects.toThrow();
    const count = run.mock.calls.length;
    await provider.release(lease, context());
    expect(run).toHaveBeenCalledTimes(count);
  });

  it('isolates CLI state and captures credentials for each concurrently acquired lease', async () => {
    successfulCli();
    const provider = ramus();
    const leases = await Promise.all([provider.acquire(request()), provider.acquire(request({ slot: 1 }))]);
    const starts = run.mock.calls.filter(([args]) => args[1] === 'start');
    expect(starts[0]![1].RAMUS_CONFIG_DIR).not.toBe(starts[1]![1].RAMUS_CONFIG_DIR);
    await Promise.all(leases.map((lease) => provider.release(lease, context())));
    expect(run.mock.calls.every(([, env]) => env.RAMUS_API_KEY === 'test-key')).toBe(true);
  });

  it.each([
    [{ platform: 'ios' }, 'Android only'],
    [{ env: {} }, 'RAMUS_API_KEY'],
    [{ appPath: undefined }, 'app.appPath'],
    [{ app: undefined }, 'app.bundleId'],
  ] as const)('rejects unsupported configuration before provisioning: %o', async (extra, message) => {
    await expect(ramus().acquire(request(extra))).rejects.toThrow(message);
    expect(run).not.toHaveBeenCalled();
  });

  it('ends a session when ADB is unavailable', async () => {
    successfulCli();
    const implementation = run.getMockImplementation()!;
    run.mockImplementation((args, ...rest) => args[0] === 'adb' && args[1] !== '--close'
      ? Promise.resolve({ serial: '127.0.0.1:5555', adb: 'not found' }) : implementation(args, ...rest));
    await expect(ramus().acquire(request())).rejects.toThrow('platform-tools');
    expect(run.mock.calls.some(([args]) => args[1] === 'end')).toBe(true);
  });

  it('cleans up a failed boot', async () => {
    successfulCli();
    const implementation = run.getMockImplementation()!;
    run.mockImplementation((args, ...rest) => args[1] === 'status'
      ? Promise.resolve({ session: 'session-1', status: 'failed' }) : implementation(args, ...rest));
    await expect(ramus().acquire(request())).rejects.toThrow('before it became active');
    expect(run.mock.calls.some(([args]) => args[1] === 'end')).toBe(true);
  });

  it('polls the actual Ramus requested and assigned states before opening ADB', async () => {
    successfulCli();
    const implementation = run.getMockImplementation()!;
    const states = ['requested', 'assigned', 'active'];
    run.mockImplementation((args, ...rest) => args[1] === 'status'
      ? Promise.resolve({ session: 'session-1', status: states.shift() }) : implementation(args, ...rest));
    const provider = ramus();
    const pending = provider.acquire(request());
    const lease = await pending;
    expect(states).toHaveLength(0);
    await provider.release(lease, context());
  });

  it('times out readiness and releases the created session', async () => {
    successfulCli();
    const implementation = run.getMockImplementation()!;
    run.mockImplementation((args, ...rest) => args[1] === 'status'
      ? Promise.resolve({ session: 'session-1', status: 'requested' }) : implementation(args, ...rest));
    await expect(ramus({ startupTimeout: 20 }).acquire(request())).rejects.toThrow();
    expect(run.mock.calls.some(([args]) => args[1] === 'end')).toBe(true);
  });

  it('learns the created session id before handling cancellation and uses a fresh cleanup signal', async () => {
    successfulCli();
    const controller = new AbortController();
    const implementation = run.getMockImplementation()!;
    run.mockImplementation(async (args, ...rest) => {
      const result = await implementation(args, ...rest);
      if (args[1] === 'start') controller.abort();
      else expect(rest[1].aborted).toBe(false);
      return result;
    });
    await expect(ramus().acquire(request({ signal: controller.signal }))).rejects.toThrow();
    expect(run.mock.calls.some(([args]) => args[1] === 'end' && args[3] === 'session-1')).toBe(true);
  });

  it('recovers the remote session from private CLI state when creation loses stdout', async () => {
    successfulCli();
    const implementation = run.getMockImplementation()!;
    run.mockImplementation(async (args, env, signal) => {
      if (args[1] !== 'start') return implementation(args, env, signal);
      await writeFile(path.join(env.RAMUS_CONFIG_DIR!, 'state.json'), JSON.stringify({ lastSession: { id: 'recovered' } }));
      throw new Error('lost stdout');
    });
    await expect(ramus().acquire(request())).rejects.toThrow('lost stdout');
    expect(run.mock.calls.some(([args]) => args[1] === 'end' && args[3] === 'recovered')).toBe(true);
  });

  it('attempts remote teardown even if tunnel cleanup fails, and allows release to be retried', async () => {
    successfulCli();
    const provider = ramus();
    const lease = await provider.acquire(request());
    const implementation = run.getMockImplementation()!;
    run.mockImplementation((args, ...rest) => args[1] === '--close' ? Promise.reject(new Error('tunnel failed')) : implementation(args, ...rest));
    await expect(provider.release(lease, context())).rejects.toThrow('cleanup failed');
    expect(run.mock.calls.some(([args]) => args[1] === 'end')).toBe(true);
    run.mockImplementation(implementation);
    await provider.release(lease, context());
  });

  it('rejects invalid startup timeouts and unknown options', () => {
    expect(() => ramus({ startupTimeout: 0 })).toThrow('positive integer');
    expect(() => ramus({ surprise: true } as never)).toThrow('unknown option');
  });
});
