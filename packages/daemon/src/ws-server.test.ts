/**
 * The WebSocket interface, and mostly its authentication.
 *
 * The guide's version accepted any signature as long as the device id was in a
 * list, so these tests spend their effort on the thing that replaced it: a real
 * HMAC, a freshness window, and a nonce that cannot be reused.
 */
import { strict as assert } from 'node:assert';
import { randomBytes } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { after, before, describe, it } from 'node:test';

import {
  HEADER_DEVICE,
  HEADER_NONCE,
  HEADER_SIGNATURE,
  HEADER_TIMESTAMP,
  NonceCache,
  SIGNATURE_WINDOW_MS,
  VigylWebSocketServer,
  addDevice,
  authenticate,
  canonicalString,
  devicesPath,
  isValidDeviceId,
  parseClientMessage,
  parseDevices,
  sign,
  signaturesMatch,
  toEvent,
  type AuthHeaders,
  type AuthorizedDevice,
  type WsDaemonLike,
} from './ws-server';

const NL = String.fromCharCode(10);

const DEVICE: AuthorizedDevice = {
  deviceId: 'phone-abc123',
  secret: 'a'.repeat(64),
  label: "Ankith's phone",
};

const devices = new Map([[DEVICE.deviceId, DEVICE]]);

function headersFor(
  overrides: Partial<Record<string, string>> = {},
  at: number = Date.now(),
): AuthHeaders {
  const timestamp = String(at);
  const nonce = randomBytes(12).toString('hex');
  const base: Record<string, string> = {
    [HEADER_DEVICE]: DEVICE.deviceId,
    [HEADER_TIMESTAMP]: timestamp,
    [HEADER_NONCE]: nonce,
    [HEADER_SIGNATURE]: sign(DEVICE.secret, DEVICE.deviceId, timestamp, nonce),
  };
  return { ...base, ...overrides };
}

describe('signing', () => {
  it('binds the signature to device, time and nonce', () => {
    const base = sign(DEVICE.secret, 'd', '1000', 'n');
    assert.notEqual(base, sign(DEVICE.secret, 'other', '1000', 'n'));
    assert.notEqual(base, sign(DEVICE.secret, 'd', '1001', 'n'));
    assert.notEqual(base, sign(DEVICE.secret, 'd', '1000', 'other'));
    assert.notEqual(base, sign('other-secret', 'd', '1000', 'n'));
  });

  it('is a 64-character hex digest', () => {
    assert.match(sign(DEVICE.secret, 'd', '1', 'n'), /^[0-9a-f]{64}$/);
  });

  it('separates the fields so they cannot be shifted between each other', () => {
    // Without a separator, ("ab","c") and ("a","bc") would sign identically.
    assert.notEqual(canonicalString('ab', 'c', 'n'), canonicalString('a', 'bc', 'n'));
    assert.equal(canonicalString('a', 'b', 'c'), `a${NL}b${NL}c`);
  });

  it('refuses anything that is not a hex signature of the right length', () => {
    const expected = sign(DEVICE.secret, 'd', '1', 'n');
    assert.equal(signaturesMatch(expected, expected), true);
    assert.equal(signaturesMatch(expected, expected.toUpperCase()), true);
    assert.equal(signaturesMatch(expected, ''), false);
    assert.equal(signaturesMatch(expected, 'not-hex'), false);
    assert.equal(signaturesMatch(expected, expected.slice(0, 32)), false);
    assert.equal(signaturesMatch(expected, expected.replace(/.$/, '0')), false);
  });
});

describe('authentication', () => {
  it('accepts a correctly signed connection', () => {
    const result = authenticate(headersFor(), devices, new NonceCache());
    assert.equal(result.ok, true);
    assert.equal(result.ok && result.device.deviceId, DEVICE.deviceId);
  });

  it('refuses a device id with no signature — the guide accepted this', () => {
    // The guide's check was `authorizedKeys.has(deviceId)`, so knowing an id
    // was enough. A device id is not a secret.
    const result = authenticate(
      { [HEADER_DEVICE]: DEVICE.deviceId },
      devices,
      new NonceCache(),
    );
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.failure, 'missing_headers');
  });

  it('refuses a signature made with the wrong secret', () => {
    const at = Date.now();
    const nonce = randomBytes(12).toString('hex');
    const headers = headersFor(
      {
        [HEADER_NONCE]: nonce,
        [HEADER_SIGNATURE]: sign('wrong-secret', DEVICE.deviceId, String(at), nonce),
      },
      at,
    );
    const result = authenticate(headers, devices, new NonceCache(), at);
    assert.equal(result.ok === false && result.failure, 'bad_signature');
  });

  it('refuses a signature for a different device', () => {
    const at = Date.now();
    const nonce = randomBytes(12).toString('hex');
    const headers = {
      [HEADER_DEVICE]: DEVICE.deviceId,
      [HEADER_TIMESTAMP]: String(at),
      [HEADER_NONCE]: nonce,
      // Correct secret, wrong device in the signed string.
      [HEADER_SIGNATURE]: sign(DEVICE.secret, 'someone-else', String(at), nonce),
    };
    assert.equal(authenticate(headers, devices, new NonceCache(), at).ok, false);
  });

  it('refuses an unknown device', () => {
    const result = authenticate(
      headersFor({ [HEADER_DEVICE]: 'unknown-device' }),
      devices,
      new NonceCache(),
    );
    assert.equal(result.ok === false && result.failure, 'unknown_device');
  });

  it('refuses a device id that could not be one', () => {
    for (const id of ['', 'ab', 'has space', 'a'.repeat(65), 'with/slash', `line${NL}break`]) {
      assert.equal(isValidDeviceId(id), false, id);
      assert.equal(authenticate(headersFor({ [HEADER_DEVICE]: id }), devices, new NonceCache()).ok, false);
    }
  });

  it('refuses a signature from outside the freshness window', () => {
    const now = Date.now();
    const old = now - SIGNATURE_WINDOW_MS - 1_000;
    const future = now + SIGNATURE_WINDOW_MS + 1_000;

    const stale = authenticate(headersFor({}, old), devices, new NonceCache(), now);
    assert.equal(stale.ok === false && stale.failure, 'stale_timestamp');

    const ahead = authenticate(headersFor({}, future), devices, new NonceCache(), now);
    assert.equal(ahead.ok === false && ahead.failure, 'stale_timestamp');
  });

  it('accepts a small clock difference, because real clocks drift', () => {
    const now = Date.now();
    const slightlyOff = now - 30_000;
    assert.equal(authenticate(headersFor({}, slightlyOff), devices, new NonceCache(), now).ok, true);
  });

  it('refuses a replay of a signature it has already seen', () => {
    // Everything about this connection is valid. It is simply the second time.
    const nonces = new NonceCache();
    const headers = headersFor();

    assert.equal(authenticate(headers, devices, nonces).ok, true);
    const replay = authenticate(headers, devices, nonces);
    assert.equal(replay.ok === false && replay.failure, 'replayed_nonce');
  });

  it('does not let an unsigned request burn a nonce for a real device', () => {
    // Otherwise anyone could lock a device out by replaying its nonces first.
    const nonces = new NonceCache();
    const at = Date.now();
    const nonce = randomBytes(12).toString('hex');

    const forged = {
      [HEADER_DEVICE]: DEVICE.deviceId,
      [HEADER_TIMESTAMP]: String(at),
      [HEADER_NONCE]: nonce,
      [HEADER_SIGNATURE]: 'f'.repeat(64),
    };
    assert.equal(authenticate(forged, devices, nonces, at).ok, false);

    const genuine = {
      ...forged,
      [HEADER_SIGNATURE]: sign(DEVICE.secret, DEVICE.deviceId, String(at), nonce),
    };
    assert.equal(authenticate(genuine, devices, nonces, at).ok, true, 'the real request still works');
  });

  it('refuses a nonce that is too short to be unpredictable', () => {
    assert.equal(authenticate(headersFor({ [HEADER_NONCE]: 'abc' }), devices, new NonceCache()).ok, false);
  });

  it('forgets old nonces so the cache cannot grow forever', () => {
    const cache = new NonceCache(1_000);
    assert.equal(cache.claim('a', 0), true);
    assert.equal(cache.claim('b', 0), true);
    assert.equal(cache.claim('a', 0), false);
    // Well past twice the window: the old entries are swept.
    assert.equal(cache.claim('c', 10_000), true);
    assert.equal(cache.size, 1);
  });
});

describe('the device file', () => {
  it('reads valid devices', () => {
    const parsed = parseDevices(
      JSON.stringify([{ deviceId: 'phone-abc123', secret: 'b'.repeat(64), label: 'phone' }]),
    );
    assert.equal(parsed.size, 1);
    assert.equal(parsed.get('phone-abc123')?.label, 'phone');
  });

  it('ignores a device with a short secret rather than trusting it', () => {
    // A short secret is worse than none: it looks like security.
    const parsed = parseDevices(JSON.stringify([{ deviceId: 'phone-abc123', secret: 'hunter2' }]));
    assert.equal(parsed.size, 0);
  });

  it('ignores malformed entries and malformed files without throwing', () => {
    assert.equal(parseDevices('not json').size, 0);
    assert.equal(parseDevices('{"not":"an array"}').size, 0);
    assert.equal(parseDevices(JSON.stringify([{ deviceId: 'bad id!' , secret: 'c'.repeat(64) }])).size, 0);
    assert.equal(parseDevices(JSON.stringify([{ secret: 'c'.repeat(64) }])).size, 0);
  });

  it('lives under the workspace, not wherever the daemon was started', () => {
    // The guide used process.cwd().
    const expected = path.join('/srv/app', '.vigyl', 'authorized_devices.json');
    assert.equal(devicesPath('/srv/app'), expected);
  });

  it('mints a device with a secret long enough to matter, owner-readable only', async () => {
    const root = path.join(tmpdir(), `vigyl-ws-${Date.now()}`);
    try {
      const device = await addDevice(root, 'test phone');
      assert.equal(device.secret.length, 64);
      assert.equal(isValidDeviceId(device.deviceId), true);

      const reloaded = parseDevices(await fsp.readFile(devicesPath(root), 'utf8'));
      assert.equal(reloaded.get(device.deviceId)?.secret, device.secret);

      const second = await addDevice(root, 'tablet');
      assert.notEqual(second.deviceId, device.deviceId);
      assert.notEqual(second.secret, device.secret);
      assert.equal(parseDevices(await fsp.readFile(devicesPath(root), 'utf8')).size, 2);
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });
});

describe('client messages', () => {
  it('reads a command', () => {
    const { message } = parseClientMessage(
      JSON.stringify({ id: 'a1', type: 'command', payload: { text: 'run the tests' } }),
    );
    assert.equal(message?.type, 'command');
    assert.equal(message?.payload.text, 'run the tests');
  });

  it('reads an approval', () => {
    const { message } = parseClientMessage(
      JSON.stringify({ id: 'a2', type: 'approve', payload: { approvalId: 'tok' } }),
    );
    assert.equal(message?.payload.approvalId, 'tok');
  });

  it('refuses what it cannot act on, with a reason', () => {
    const cases: Array<[string, RegExp]> = [
      ['not json', /not valid JSON/],
      ['[]', /not an object/],
      [JSON.stringify({ type: 'command' }), /missing id/],
      [JSON.stringify({ id: 'a', type: 'nonsense' }), /unknown type/],
      [JSON.stringify({ id: 'a', type: 'command', payload: {} }), /no text/],
      [JSON.stringify({ id: 'a', type: 'command', payload: { text: '   ' } }), /no text/],
      [JSON.stringify({ id: 'a', type: 'approve', payload: {} }), /no approvalId/],
    ];
    for (const [raw, pattern] of cases) {
      const { message, reason } = parseClientMessage(raw);
      assert.equal(message, undefined, raw);
      assert.match(reason ?? '', pattern);
    }
  });

  it('refuses an oversized frame without parsing it', () => {
    const { reason } = parseClientMessage(JSON.stringify({ id: 'a', type: 'command', payload: { text: 'x'.repeat(100_000) } }));
    assert.match(reason ?? '', /too large/);
  });
});

describe('daemon results become events', () => {
  it('turns an approval into a hitl_request with what the app needs', () => {
    const event = toEvent('m1', {
      status: 'approval_required',
      approvalId: 'tok-1',
      description: 'Deploy to production',
      reasons: ['the action is destructive'],
      expiresAt: 1234,
    });
    assert.equal(event.type, 'hitl_request');
    assert.equal(event.payload.approvalId, 'tok-1');
    assert.deepEqual(event.payload.reasons, ['the action is destructive']);
    assert.equal(event.payload.expiresAt, 1234);
  });

  it('maps the other statuses', () => {
    assert.equal(toEvent('m', { status: 'completed', description: 'Built' }).type, 'success');
    assert.equal(toEvent('m', { status: 'failed', reason: 'exit 1' }).type, 'error');
    assert.equal(toEvent('m', { status: 'busy', reason: 'busy' }).type, 'error');
    assert.equal(toEvent('m', { status: 'rejected', reason: 'no' }).type, 'error');
    assert.equal(toEvent('m', { status: 'tool_result', text: 'rows', isError: false }).type, 'success');
    assert.equal(toEvent('m', { status: 'tool_result', text: 'nope', isError: true }).type, 'error');
  });

  it('keeps the message id so the app can match request to reply', () => {
    assert.equal(toEvent('abc', { status: 'completed' }).id, 'abc');
  });
});

/** A daemon that records what it was asked and answers immediately. */
function fakeDaemon(): WsDaemonLike & { commands: string[]; owners: Array<string | undefined> } {
  const commands: string[] = [];
  const owners: Array<string | undefined> = [];
  return {
    commands,
    owners,
    async handleCommand(text, onProgress, options) {
      commands.push(text);
      owners.push(options?.owner);
      onProgress('working...');
      if (text.includes('production')) {
        return {
          status: 'approval_required',
          approvalId: 'tok-1',
          description: 'Deploy to production',
          reasons: ['the action is destructive'],
          expiresAt: Date.now() + 60_000,
        };
      }
      return { status: 'completed', description: 'Done', output: 'ok', attempts: 1, patches: [] };
    },
    async approve(approvalId, _onProgress, options) {
      owners.push(options?.owner);
      return { status: 'completed', description: `approved ${approvalId}`, attempts: 1, patches: [] };
    },
    deny: (approvalId) => approvalId === 'tok-1',
  };
}

describe('a live server', () => {
  let server: VigylWebSocketServer;
  let daemon: ReturnType<typeof fakeDaemon>;
  let port: number;
  let WebSocket: typeof import('ws').WebSocket;

  before(async () => {
    ({ WebSocket } = await import('ws'));
    daemon = fakeDaemon();
    server = new VigylWebSocketServer(daemon, {
      port: 0,
      host: '127.0.0.1',
      workspaceRoot: tmpdir(),
      devices,
      keepaliveMs: 60_000,
    });
    port = await server.start();
  });

  after(async () => {
    await server.stop();
  });

  const connect = (headers: AuthHeaders): import('ws').WebSocket =>
    new WebSocket(`ws://127.0.0.1:${port}`, { headers: headers as Record<string, string> });

  const nextMessage = (socket: import('ws').WebSocket): Promise<Record<string, unknown>> =>
    new Promise((resolve, reject) => {
      socket.once('message', (data) => resolve(JSON.parse(String(data))));
      socket.once('error', reject);
    });

  it('refuses a connection with no credentials', async () => {
    const socket = connect({});
    const code = await new Promise<number>((resolve) => socket.on('close', resolve));
    assert.equal(code, 4001);
  });

  it('refuses a connection with a device id but no signature', async () => {
    const socket = connect({ [HEADER_DEVICE]: DEVICE.deviceId });
    const code = await new Promise<number>((resolve) => socket.on('close', resolve));
    assert.equal(code, 4001);
  });

  it('accepts a signed connection and says hello', async () => {
    const socket = connect(headersFor());
    const hello = await nextMessage(socket);
    assert.equal(hello.type, 'hello');
    socket.close();
  });

  it('runs a command and streams progress before the result', async () => {
    const socket = connect(headersFor());
    await nextMessage(socket); // hello

    const events: Array<Record<string, unknown>> = [];
    const done = new Promise<void>((resolve) => {
      socket.on('message', (data) => {
        const event = JSON.parse(String(data)) as Record<string, unknown>;
        events.push(event);
        if (event.type === 'success' || event.type === 'error') resolve();
      });
    });

    socket.send(JSON.stringify({ id: 'm1', type: 'command', payload: { text: 'run the tests' } }));
    await done;

    assert.equal(events[0]?.type, 'progress');
    assert.equal(events.at(-1)?.type, 'success');
    assert.equal(events.at(-1)?.id, 'm1');
    assert.ok(daemon.commands.includes('run the tests'));
    socket.close();
  });

  it('sends a hitl_request instead of running something destructive', async () => {
    const socket = connect(headersFor());
    await nextMessage(socket);

    const events: Array<Record<string, unknown>> = [];
    const done = new Promise<void>((resolve) => {
      socket.on('message', (data) => {
        const event = JSON.parse(String(data)) as Record<string, unknown>;
        events.push(event);
        if (event.type === 'hitl_request') resolve();
      });
    });

    socket.send(JSON.stringify({ id: 'm2', type: 'command', payload: { text: 'deploy to production' } }));
    await done;

    const request = events.find((event) => event.type === 'hitl_request');
    assert.equal((request?.payload as Record<string, unknown>).approvalId, 'tok-1');
    socket.close();
  });

  it('scopes approvals to the device, so one cannot approve another"s', async () => {
    const socket = connect(headersFor());
    await nextMessage(socket);

    const reply = new Promise<Record<string, unknown>>((resolve) => {
      socket.on('message', (data) => {
        const event = JSON.parse(String(data)) as Record<string, unknown>;
        if (event.type === 'success') resolve(event);
      });
    });

    socket.send(JSON.stringify({ id: 'm3', type: 'approve', payload: { approvalId: 'tok-1' } }));
    await reply;

    assert.ok(daemon.owners.includes(DEVICE.deviceId), 'the device id is the approval owner');
    socket.close();
  });

  it('answers a malformed frame without dropping the connection', async () => {
    const socket = connect(headersFor());
    await nextMessage(socket);

    socket.send('this is not json');
    const event = await nextMessage(socket);

    assert.equal(event.type, 'error');
    assert.match(String((event.payload as Record<string, unknown>).message), /not valid JSON/);
    assert.equal(socket.readyState, WebSocket.OPEN, 'still connected');
    socket.close();
  });

  it('refuses the same signature twice, even though it worked once', async () => {
    const headers = headersFor();

    const first = connect(headers);
    await nextMessage(first);
    first.close();

    const second = connect(headers);
    const code = await new Promise<number>((resolve) => second.on('close', resolve));
    assert.equal(code, 4001, 'a replayed signature must not connect');
  });

  it('counts its connections', async () => {
    const socket = connect(headersFor());
    await nextMessage(socket);
    assert.equal(server.connectionCount, 1);

    await new Promise<void>((resolve) => {
      socket.on('close', () => resolve());
      socket.close();
    });
    // The close handler runs on the server side; give the loop a turn.
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(server.connectionCount, 0);
  });
});
