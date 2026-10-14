# Month 3: the mobile app — architecture notes before any code

Month 3 builds a React Native app that talks to the daemon over the WebSocket
interface shipped in v0.2.0. This is what has to be decided first, written
before the app exists so the decisions are arguable rather than accidental.

The protocol it talks to is real and tested: `packages/daemon/src/ws-server.ts`,
37 tests, port 8472.

## Four things the build guide gets wrong

### 1. The guide's app cannot authenticate

Its WebSocket client sends:

```ts
headers: {
  'x-vigyl-device': this.workspace.deviceId,
  'x-vigyl-signature': this.workspace.deviceId, // simplified for now
}
```

It signs with the device id — which is the same non-authentication the Month 2
guide had on the server side, and which v0.2.0 replaced with HMAC-SHA256 over
device id, timestamp and nonce. **The app as written will be refused with 4001
on every connection**, which is the right outcome.

The app must send all four headers and compute a real signature:

```
x-vigyl-device     the device id from `vigyl device add`
x-vigyl-timestamp  Date.now(), within 2 minutes of the server's clock
x-vigyl-nonce      16+ random hex characters, never reused
x-vigyl-signature  HMAC-SHA256(secret, `${deviceId}\n${timestamp}\n${nonce}`)
```

**React Native has no HMAC.** `expo-crypto` does SHA-256 digests but not HMAC,
and `node:crypto` does not exist on device. Use
[`@noble/hashes`](https://github.com/paulmillr/noble-hashes) — audited, pure
TypeScript, works in RN without a native module:

```ts
import { hmac } from '@noble/hashes/hmac';
import { sha256 } from '@noble/hashes/sha2';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils';

const signature = bytesToHex(
  hmac(sha256, utf8ToBytes(secret), utf8ToBytes(`${deviceId}\n${timestamp}\n${nonce}`)),
);
```

The secret belongs in `expo-secure-store` (Keychain / Keystore), never in
AsyncStorage and never in app state that gets logged.

### 2. There is no `agent_state` event

The guide's Digital Twin screen — the "wow" screen, the one that makes the
invisible visible — subscribes to an event the daemon does not send:

```ts
| { type: 'agent_state'; id: string; payload: AgentState }
```

The daemon emits `progress`, `hitl_request`, `success`, `error`, `ping` and
`hello`. Nothing publishes per-agent state, and the daemon does not model
itself as four agents internally; it has a supervisor, an executor, a monitor
and an MCP hub, which is close but not the same thing.

**So Month 3 week 2 is daemon work before it is app work.** Either:

- **add an `agent_state` event** to the WS protocol, emitted as the daemon moves
  through parse → execute → classify → patch → tool-call, or
- **derive the pipeline view from `progress` messages** the app already
  receives, which needs no daemon change but means the screen is inferring
  state from prose.

The first is honest and costs a protocol addition. The second is cheaper and
will drift the moment a progress string changes. **Recommend the first**, with
the event marked additive so an older app ignores it.

### 3. A phone cannot reach a loopback socket

The daemon binds `127.0.0.1` by default, deliberately: a process that runs shell
commands should not listen on every interface because a field was left unset.
The guide's app connects to `ws://${host}:${port}` from a phone, which means the
daemon must be reachable from the phone's network.

This is the decision Month 3 must not fudge. Three options:

| | What it means | Honest assessment |
|---|---|---|
| **LAN binding** | set `ws.host` to `0.0.0.0`, phone and server on one network | Fine at home. The HMAC is the only thing between the network and a shell, and there is no TLS, so anyone on that network sees the traffic. |
| **SSH tunnel** | `ssh -L 8472:127.0.0.1:8472`, app connects to localhost | Secure and needs no new code, but a phone running an SSH tunnel is not a thing most people will do. |
| **Relay** | daemon dials out to a hosted relay; app connects to the relay | The only one that works over mobile data, and it means running a service and being trusted with a connection into someone's server. |

For Month 3, **LAN binding with a documented warning** is the realistic start,
and the app should refuse to connect to a non-loopback host over plain `ws://`
without the user explicitly accepting it once. A relay is a Month 4+ decision
with real operational weight, not a detail.

TLS deserves its own line: `wss://` needs a certificate, and a self-signed one
means certificate pinning in the app. That is worth doing before anything
reaches a hostile network.

### 4. The stack versions are two years stale

The guide specifies Expo SDK 51 and React Native 0.74, which were current in
mid-2024. Use whatever Expo's current SDK is at the time, and take the RN
version it pins. The guide's list of libraries is otherwise sound.

## Where the app lives

The guide puts it at `packages/app`. That fights the existing setup: this is an
npm workspace with hoisting, and Metro resolves modules differently from Node —
a hoisted `node_modules` at the repo root is a well-known source of "unable to
resolve module" errors in Expo monorepos.

**Use `apps/mobile`**, kept out of the `packages/*` glob that the publishable
libraries use:

```
vigyl/
├── packages/        # published to npm
│   ├── daemon/  slm/  mcp-servers/  cli/
└── apps/            # not published
    └── mobile/      # the Expo app
```

`apps/*` is in the workspaces list so the app can depend on `@vigylx/daemon` for
its protocol types — `ServerEvent`, `ClientMessage`, `AuthorizedDevice` are
already exported, and duplicating them in the app is how the two ends drift
apart. Metro needs `watchFolders` pointed at the repo root and
`nodeModulesPaths` including both, which is the standard Expo monorepo config.

## What the app can rely on today

Already built and tested, no daemon changes needed:

| Need | What exists |
|---|---|
| connect, authenticated | HMAC headers, 4001 on failure |
| send a command | `{ id, type: 'command', payload: { text } }` |
| stream output | `progress` events, same `id` |
| approve or deny | `hitl_request` carries `approvalId`, `reasons`, `expiresAt`; reply `approve` / `deny` |
| know the connection is alive | `ping` every 30s; the server drops anything that misses one |
| provision a device | `vigyl device add` prints id and secret once |
| multiple servers | each is a device on that daemon; the app stores one secret per workspace |

**Approvals are already scoped to the device**, so one phone cannot approve
another phone's request. That falls out of the same owner check Telegram chats
get.

## Open questions for Ankith

1. **`agent_state` event, or infer the pipeline from progress messages?**
   Affects whether week 2 starts in the daemon or the app.
2. **How does the phone reach the daemon** — LAN only for now, or is a relay in
   scope for Month 3?
3. **Does the app replace Telegram for you personally**, or run beside it? The
   guide says "replaces Telegram as the primary interface" while also keeping
   the bot; those are different products and it changes what gets polished.
4. **iOS, Android, or both?** TestFlight needs an Apple Developer account at
   $99/year. Android internal testing is $25 once. Doing one well beats two
   badly.
5. **Biometric HITL (week 3)** — Face ID in front of the approve button is a
   nice demo, but the approval is already scoped and expiring. Is it worth the
   week, or is multi-workspace the better use of it?

## What this does not decide

Nothing here is built. No app code exists, `apps/mobile` is an empty placeholder
with a README, and nothing in the daemon has changed. The first Month 3 go
decides questions 1–5 and then starts.
