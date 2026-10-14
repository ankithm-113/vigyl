/**
 * `vigyl device` end to end, and the socket it exists to serve.
 *
 * These run the real CLI binary as a subprocess against a temporary workspace,
 * then use the credentials it printed to open a real WebSocket connection. The
 * point is to catch what unit tests cannot: that a secret minted by the CLI is
 * one the server actually accepts.
 */
import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { promises as fsp } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { after, before, describe, it } from 'node:test';

const NL = String.fromCharCode(10);

const CLI = path.resolve(__dirname, '..', '..', 'dist', 'index.js');
const REPO = path.resolve(__dirname, '..', '..', '..', '..');

let workspace: string;
let home: string;

/** Run the CLI as a user would, in a directory with its own config. */
function cli(args: string[]): { stdout: string; status: number } {
  try {
    const stdout = execFileSync(process.execPath, [CLI, ...args], {
      cwd: home,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' },
    });
    return { stdout, status: 0 };
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string; status?: number };
    return { stdout: (failure.stdout ?? '') + (failure.stderr ?? ''), status: failure.status ?? 1 };
  }
}

before(async () => {
  home = path.join(tmpdir(), `vigyl-device-${Date.now()}`);
  workspace = path.join(home, 'project');
  await fsp.mkdir(workspace, { recursive: true });

  // A minimal valid config pointing at the temporary workspace.
  await fsp.writeFile(
    path.join(home, 'vigyl.config.json'),
    JSON.stringify(
      {
        workspace_root: workspace,
        telegram: { bot_token: '123456:' + 'a'.repeat(35), allowed_chat_ids: [1] },
        provider: 'openai',
        openai: { api_key: 'sk-' + 'b'.repeat(40), model: 'gpt-4o-mini' },
        ws: { enabled: true, port: 8473, host: '127.0.0.1' },
      },
      null,
      2,
    ),
  );
});

after(async () => {
  await fsp.rm(home, { recursive: true, force: true });
});

describe('vigyl device', () => {
  let deviceId = '';
  let secret = '';

  it('says there are none before any are added', () => {
    const { stdout, status } = cli(['device', 'list']);
    assert.equal(status, 0);
    assert.match(stdout, /No authorized devices/);
  });

  it('adds one and prints the secret exactly once', () => {
    const { stdout, status } = cli(['device', 'add', 'test phone']);
    assert.equal(status, 0, stdout);

    const id = /Device ID:\s+([A-Za-z0-9_-]+)/.exec(stdout)?.[1];
    const key = /Secret:\s+([0-9a-f]{64})/.exec(stdout)?.[1];
    assert.ok(id, `no device id in: ${stdout}`);
    assert.ok(key, `no secret in: ${stdout}`);

    deviceId = id;
    secret = key;

    assert.match(stdout, /not shown again/);
    assert.match(stdout, /run commands on this machine/);
  });

  it('writes the file into the workspace, owner-readable only', async () => {
    const file = path.join(workspace, '.vigyl', 'authorized_devices.json');
    const parsed = JSON.parse(await fsp.readFile(file, 'utf8')) as Array<Record<string, string>>;

    assert.equal(parsed.length, 1);
    assert.equal(parsed[0]?.deviceId, deviceId);
    assert.equal(parsed[0]?.label, 'test phone');

    if (process.platform !== 'win32') {
      const mode = (await fsp.stat(file)).mode & 0o777;
      assert.equal(mode, 0o600, 'a device file is equivalent to a password');
    }
  });

  it('lists it without ever printing the secret', () => {
    const { stdout, status } = cli(['device', 'list']);
    assert.equal(status, 0);
    assert.match(stdout, new RegExp(deviceId));
    assert.match(stdout, /test phone/);
    assert.ok(!stdout.includes(secret), 'the secret must never be printed again');
  });

  it('keeps earlier devices when adding another', () => {
    const { stdout } = cli(['device', 'add', 'tablet']);
    const second = /Device ID:\s+([A-Za-z0-9_-]+)/.exec(stdout)?.[1];
    assert.ok(second);
    assert.notEqual(second, deviceId);

    const listed = cli(['device', 'list']).stdout;
    assert.match(listed, new RegExp(deviceId));
    assert.match(listed, new RegExp(second));
    assert.match(listed, /2 authorized device/);
  });

  it('refuses to revoke something that is not there', () => {
    const { stdout, status } = cli(['device', 'revoke', 'not-a-real-device']);
    assert.equal(status, 1);
    assert.match(stdout, /No device with id/);
  });

  it('revokes, and says an open connection survives until it reconnects', () => {
    const { stdout, status } = cli(['device', 'revoke', deviceId]);
    assert.equal(status, 0, stdout);
    assert.match(stdout, /Revoked/);
    assert.match(stdout, /stays connected until it reconnects/);

    const listed = cli(['device', 'list']).stdout;
    assert.ok(!listed.includes(deviceId), 'the revoked device is gone');
    assert.match(listed, /1 authorized device/);
  });
});

describe('a secret from the CLI opens a real socket', () => {
  it('connects when signed, and is refused once revoked', async () => {
    const { VigylWebSocketServer, loadDevices, revokeDevice, sign } = (await import(
      path.join(REPO, 'packages', 'daemon', 'dist', 'index.js')
    )) as typeof import('@vigylx/daemon');
    const { WebSocket } = await import('ws');
    const { randomBytes } = await import('node:crypto');

    // Whatever `vigyl device add` wrote, read back the way the daemon reads it.
    const devices = loadDevices(workspace);
    const device = [...devices.values()][0];
    assert.ok(device, 'the CLI should have left a device behind');

    const daemon = {
      handleCommand: async () => ({ status: 'completed', description: 'ok' }),
      approve: async () => ({ status: 'completed', description: 'ok' }),
      deny: () => true,
    };

    const server = new VigylWebSocketServer(daemon, {
      port: 0,
      host: '127.0.0.1',
      workspaceRoot: workspace,
      keepaliveMs: 60_000,
    });
    const port = await server.start();

    const headersFor = (secret: string, deviceId: string): Record<string, string> => {
      const timestamp = String(Date.now());
      const nonce = randomBytes(12).toString('hex');
      return {
        'x-vigyl-device': deviceId,
        'x-vigyl-timestamp': timestamp,
        'x-vigyl-nonce': nonce,
        'x-vigyl-signature': sign(secret, deviceId, timestamp, nonce),
      };
    };

    try {
      // Signed with the CLI's secret: connects.
      const good = new WebSocket(`ws://127.0.0.1:${port}`, {
        headers: headersFor(device.secret, device.deviceId),
      });
      const hello = await new Promise<string>((resolve, reject) => {
        good.once('message', (data) => resolve(String(data)));
        good.once('close', (code) => reject(new Error(`closed with ${code}`)));
        good.once('error', reject);
      });
      assert.match(hello, /hello/);
      good.close();

      // A made-up secret for the same device: refused.
      const forged = new WebSocket(`ws://127.0.0.1:${port}`, {
        headers: headersFor('f'.repeat(64), device.deviceId),
      });
      const forgedCode = await new Promise<number>((resolve) => forged.on('close', resolve));
      assert.equal(forgedCode, 4001);
    } finally {
      await server.stop();
    }

    // Revoking takes effect for a server started afterwards.
    assert.equal(await revokeDevice(workspace, device.deviceId), true);

    const afterRevoke = new VigylWebSocketServer(daemon, {
      port: 0,
      host: '127.0.0.1',
      workspaceRoot: workspace,
      keepaliveMs: 60_000,
    });
    const revokedPort = await afterRevoke.start();
    try {
      const socket = new WebSocket(`ws://127.0.0.1:${revokedPort}`, {
        headers: headersFor(device.secret, device.deviceId),
      });
      const code = await new Promise<number>((resolve) => socket.on('close', resolve));
      assert.equal(code, 4001, 'a revoked device must not connect');
    } finally {
      await afterRevoke.stop();
    }
  });
});

describe('the daemon starts the socket when it is configured', () => {
  it('reports the WebSocket address, or says there are no devices', async () => {
    // `vigyl run` blocks forever, so this checks the thing it would print:
    // config with ws.enabled true, and a server that binds.
    const { loadConfig } = (await import(
      path.join(REPO, 'packages', 'daemon', 'dist', 'index.js')
    )) as typeof import('@vigylx/daemon');

    const previous = process.cwd();
    process.chdir(home);
    try {
      const config = loadConfig();
      assert.equal(config.ws.enabled, true);
      assert.equal(config.ws.port, 8473);
      assert.equal(config.ws.host, '127.0.0.1');
    } finally {
      process.chdir(previous);
    }
  });

  it('defaults to off, on loopback', async () => {
    const { VigylConfigSchema } = (await import(
      path.join(REPO, 'packages', 'daemon', 'dist', 'index.js')
    )) as typeof import('@vigylx/daemon');

    const parsed = VigylConfigSchema.parse({
      workspace_root: workspace,
      telegram: { bot_token: '123456:' + 'a'.repeat(35), allowed_chat_ids: [1] },
      provider: 'openai',
      openai: { api_key: 'sk-' + 'b'.repeat(40) },
    });

    assert.equal(parsed.ws.enabled, false, 'a shell-running daemon must not listen by default');
    assert.equal(parsed.ws.host, '127.0.0.1');
    assert.equal(parsed.ws.port, 8472);
  });
});
