# @e2e-dev/ramus

Run e2e Android tests on [Ramus](https://ramus.dev) through its ADB tunnel.
The CI runner runs agent-device and needs Android platform-tools on PATH.
The emulator runs on Ramus, so the test runner needs no KVM or emulator image.

```sh
npm install --save-dev e2e @e2e-dev/mobile @e2e-dev/ramus ramus-cli
```

```ts
import type { E2EConfig } from 'e2e';
import { mobile } from '@e2e-dev/mobile';
import { ramus } from '@e2e-dev/ramus';

export default {
  workers: 1,
  targets: [{
    name: 'android',
    engine: mobile({ platform: 'android', device: ramus() }),
    app: { bundleId: 'com.example.app', appPath: './build/app.apk' },
  }],
} satisfies E2EConfig;
```

Set `RAMUS_API_KEY` to a signed-in account's key. Trial credentials cannot open
ADB tunnels. The provider requires a local APK and its Android package name.
It uploads and installs the APK once per worker, waits for readiness, opens
the ADB tunnel, and ends its sessions when the run finishes. Each acquisition
has its own Ramus CLI state directory. Existing personal CLI state is untouched.

`ramus({ startupTimeout: 180_000 })` controls the readiness and tunnel budget
after creation. Upload and creation have a separate four-minute budget.
Cancellation during creation waits for the CLI to return the session id so
the provider can release it. CLI state is also checked for an id after a failed
creation. A server-side creation whose response and local state are both lost
cannot be recovered by this adapter; Ramus's idle expiry is the backstop.

Use one worker to start, then raise `workers` within your account's capacity.
Concurrent e2e processes sharing the same agent-device daemon must set distinct
`mobile({ session: '...' })` names, as with local devices. Keep the ADB tunnel
open for the run; a trial key, expired session, missing adb, or exhausted
capacity fails the run. The provider does not fall back to a local emulator.

Tests that use `agent` still need an e2e model configuration. Deterministic
locator tests do not. Screenshots and video use agent-device through ADB.
Ramus share links are not emitted to CI logs. Cleanup retains the private
state directory and reports the session id if teardown fails.

Ramus supports Android. Keep a separate provider for iOS tests.
