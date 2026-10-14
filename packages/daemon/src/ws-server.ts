/**
 * WebSocket interface: a persistent connection for the Month 3 mobile app.
 *
 * Telegram stays. This exists because an app needs a real event stream rather
 * than a bot API, and because the approval gate is far better served by a
 * connection that can push than by polling.
 *
 * ## Why the authentication here is not the guide's
 *
 * The build guide's `verifySignature(signature, deviceId)` does this:
 *
 *     if (!signature || !deviceId) return false;
 *     return this.authorizedKeys.has(deviceId);
 *
 * It takes a signature and never looks at it. A device id is not a secret — it
 * travels in every request, it ends up in logs, and the guide's own file format
 * stores a list of them in plain text. So anyone who learns one gets a shell on
 * the server, which is the whole of Vigyl's threat model in one line.
 *
 * What is here instead:
 *
 *   - **A shared secret per device.** The id names the device; the secret
 *     proves it.
 *   - **HMAC-SHA256 over device id, timestamp and nonce**, compared with
 *     `timingSafeEqual` so the comparison cannot be timed.
 *   - **A freshness window.** A signature older than two minutes is refused,
 *     so a captured one is not useful tomorrow.
 *   - **A nonce, remembered for the window.** A signature captured and replayed
 *     inside the window is refused too.
 *   - **Loopback by default.** The server binds 127.0.0.1 unless told
 *     otherwise, because a daemon that runs shell commands should not be
 *     listening on every interface by default.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type Server as HttpServer, type IncomingMessage } from 'node:http';
import { promises as fsp, readFileSync } from 'node:fs';
import * as path from 'node:path';

import { logger } from './logger';

const NL = String.fromCharCode(10);

export const DEFAULT_WS_PORT = 8472;
export const KEEPALIVE_INTERVAL_MS = 30_000;

/** How far a signature's timestamp may be from ours, either way. */
export const SIGNATURE_WINDOW_MS = 120_000;

/** A single message larger than this is refused unread. */
export const MAX_MESSAGE_BYTES = 64 * 1024;

export const HEADER_DEVICE = 'x-vigyl-device';
export const HEADER_SIGNATURE = 'x-vigyl-signature';
export const HEADER_TIMESTAMP = 'x-vigyl-timestamp';
export const HEADER_NONCE = 'x-vigyl-nonce';

// ---------------------------------------------------------------------------
// Protocol
// ---------------------------------------------------------------------------

export type ClientMessageType = 'command' | 'approve' | 'deny' | 'pong';

export interface ClientMessage {
  id: string;
  type: ClientMessageType;
  payload: {
    text?: string;
    approvalId?: string;
  };
}

export type ServerEventType =
  | 'progress'
  | 'hitl_request'
  | 'success'
  | 'error'
  | 'ping'
  | 'hello';

export interface ServerEvent {
  id: string;
  type: ServerEventType;
  payload: {
    message?: string;
    approvalId?: string;
    reasons?: string[];
    expiresAt?: number;
    description?: string;
    data?: unknown;
  };
}

/**
 * Parse a client frame.
 *
 * Returns a reason instead of throwing: a malformed frame is an ordinary event
 * on a public-ish socket, not an exceptional one.
 */
export function parseClientMessage(raw: string): { message?: ClientMessage; reason?: string } {
  if (raw.length > MAX_MESSAGE_BYTES) return { reason: 'message too large' };

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { reason: 'not valid JSON' };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { reason: 'not an object' };
  }

  const candidate = parsed as Partial<ClientMessage>;
  const id = typeof candidate.id === 'string' && candidate.id !== '' ? candidate.id : undefined;
  if (!id) return { reason: 'missing id' };
  if (id.length > 128) return { reason: 'id too long' };

  const type = candidate.type;
  if (type !== 'command' && type !== 'approve' && type !== 'deny' && type !== 'pong') {
    return { reason: `unknown type: ${String(type)}` };
  }

  const payload = (candidate.payload ?? {}) as ClientMessage['payload'];
  if (typeof payload !== 'object' || payload === null) return { reason: 'payload is not an object' };

  if (type === 'command') {
    const text = typeof payload.text === 'string' ? payload.text.trim() : '';
    if (text === '') return { reason: 'command has no text' };
    return { message: { id, type, payload: { text } } };
  }

  if (type === 'approve' || type === 'deny') {
    const approvalId = typeof payload.approvalId === 'string' ? payload.approvalId.trim() : '';
    if (approvalId === '') return { reason: `${type} has no approvalId` };
    return { message: { id, type, payload: { approvalId } } };
  }

  return { message: { id, type, payload: {} } };
}

// ---------------------------------------------------------------------------
// Devices and signatures
// ---------------------------------------------------------------------------

export interface AuthorizedDevice {
  deviceId: string;
  /** Hex or base64; compared as bytes. */
  secret: string;
  label?: string;
}

/**
 * The string that gets signed.
 *
 * Includes the timestamp and nonce so a signature is bound to one moment and
 * one attempt. Newline-separated with no escaping needed because none of the
 * three fields may contain a newline — `isValidDeviceId` and the hex checks
 * below enforce that.
 */
export function canonicalString(deviceId: string, timestamp: string, nonce: string): string {
  return [deviceId, timestamp, nonce].join(NL);
}

export function sign(secret: string, deviceId: string, timestamp: string, nonce: string): string {
  return createHmac('sha256', secret)
    .update(canonicalString(deviceId, timestamp, nonce))
    .digest('hex');
}

export function isValidDeviceId(id: string): boolean {
  return /^[A-Za-z0-9_-]{4,64}$/.test(id);
}

/** Constant-time compare of two hex signatures. */
export function signaturesMatch(expected: string, provided: string): boolean {
  if (typeof provided !== 'string') return false;
  if (!/^[0-9a-f]{64}$/i.test(provided)) return false;

  const a = Buffer.from(expected, 'hex');
  const b = Buffer.from(provided.toLowerCase(), 'hex');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export type AuthFailure =
  | 'missing_headers'
  | 'bad_device_id'
  | 'unknown_device'
  | 'stale_timestamp'
  | 'replayed_nonce'
  | 'bad_signature';

export type AuthResult =
  | { ok: true; device: AuthorizedDevice }
  | { ok: false; failure: AuthFailure };

/**
 * Remembers nonces for as long as a signature could still be fresh.
 *
 * Without this, a captured signature can be replayed as many times as you like
 * for two minutes — which is plenty to run a command.
 */
export class NonceCache {
  private readonly seen = new Map<string, number>();

  constructor(private readonly windowMs: number = SIGNATURE_WINDOW_MS) {}

  /** True if this nonce is new; false if it has been used. */
  claim(key: string, now: number = Date.now()): boolean {
    this.sweep(now);
    if (this.seen.has(key)) return false;
    this.seen.set(key, now);
    return true;
  }

  get size(): number {
    return this.seen.size;
  }

  private sweep(now: number): void {
    for (const [key, at] of this.seen) {
      if (now - at > this.windowMs * 2) this.seen.delete(key);
    }
  }
}

export interface AuthHeaders {
  [key: string]: string | string[] | undefined;
}

/**
 * Decide whether a connection may proceed.
 *
 * Every rejection returns the same way, and the caller tells the client only
 * "unauthorized" — an attacker should not learn whether the device id exists,
 * whether the clock is off, or which header was wrong.
 */
export function authenticate(
  headers: AuthHeaders,
  devices: ReadonlyMap<string, AuthorizedDevice>,
  nonces: NonceCache,
  now: number = Date.now(),
): AuthResult {
  const header = (name: string): string => {
    const value = headers[name];
    return typeof value === 'string' ? value.trim() : '';
  };

  const deviceId = header(HEADER_DEVICE);
  const signature = header(HEADER_SIGNATURE);
  const timestamp = header(HEADER_TIMESTAMP);
  const nonce = header(HEADER_NONCE);

  if (deviceId === '' || signature === '' || timestamp === '' || nonce === '') {
    return { ok: false, failure: 'missing_headers' };
  }
  if (!isValidDeviceId(deviceId)) return { ok: false, failure: 'bad_device_id' };
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(nonce)) return { ok: false, failure: 'missing_headers' };

  const sentAt = Number(timestamp);
  if (!Number.isFinite(sentAt)) return { ok: false, failure: 'stale_timestamp' };
  if (Math.abs(now - sentAt) > SIGNATURE_WINDOW_MS) {
    return { ok: false, failure: 'stale_timestamp' };
  }

  const device = devices.get(deviceId);
  if (!device) {
    // Still do the work, so an unknown device does not answer faster than a
    // known one with a wrong signature.
    signaturesMatch(sign('placeholder', deviceId, timestamp, nonce), signature);
    return { ok: false, failure: 'unknown_device' };
  }

  if (!signaturesMatch(sign(device.secret, deviceId, timestamp, nonce), signature)) {
    return { ok: false, failure: 'bad_signature' };
  }

  // Claimed only after the signature is proven, so an attacker cannot burn
  // nonces for a device they cannot sign for.
  if (!nonces.claim(`${deviceId}:${nonce}`, now)) {
    return { ok: false, failure: 'replayed_nonce' };
  }

  return { ok: true, device };
}

/** Where the device list lives: `<workspace>/.vigyl/authorized_devices.json`. */
export function devicesPath(workspaceRoot: string): string {
  // The guide used process.cwd(), which is wherever the daemon happened to be
  // started from.
  return path.join(workspaceRoot, '.vigyl', 'authorized_devices.json');
}

export function parseDevices(contents: string): Map<string, AuthorizedDevice> {
  const devices = new Map<string, AuthorizedDevice>();

  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch {
    logger.warn('authorized_devices.json is not valid JSON; no devices loaded');
    return devices;
  }
  if (!Array.isArray(parsed)) {
    logger.warn('authorized_devices.json should be an array; no devices loaded');
    return devices;
  }

  for (const entry of parsed) {
    const device = entry as Partial<AuthorizedDevice>;
    if (typeof device.deviceId !== 'string' || !isValidDeviceId(device.deviceId)) {
      logger.warn('Ignoring device with an invalid id');
      continue;
    }
    if (typeof device.secret !== 'string' || device.secret.length < 32) {
      // A short secret is worse than none: it looks like security.
      logger.warn('Ignoring device with a missing or too-short secret', {
        deviceId: device.deviceId,
      });
      continue;
    }
    devices.set(device.deviceId, {
      deviceId: device.deviceId,
      secret: device.secret,
      ...(device.label === undefined ? {} : { label: device.label }),
    });
  }

  return devices;
}

export function loadDevices(workspaceRoot: string): Map<string, AuthorizedDevice> {
  try {
    return parseDevices(readFileSync(devicesPath(workspaceRoot), 'utf8'));
  } catch {
    return new Map();
  }
}

/** Mint a device the app can use. The secret is shown once, by the caller. */
export async function addDevice(
  workspaceRoot: string,
  label?: string,
): Promise<AuthorizedDevice> {
  const file = devicesPath(workspaceRoot);
  const existing = loadDevices(workspaceRoot);

  const device: AuthorizedDevice = {
    deviceId: randomBytes(12).toString('hex'),
    secret: randomBytes(32).toString('hex'),
    ...(label === undefined ? {} : { label }),
  };
  existing.set(device.deviceId, device);

  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, JSON.stringify([...existing.values()], null, 2), {
    encoding: 'utf8',
    // Owner-only: this file is equivalent to a password for the daemon.
    mode: 0o600,
  });

  return device;
}

// ---------------------------------------------------------------------------
// The server
// ---------------------------------------------------------------------------

/** What the server needs from the daemon. Narrow, so tests can fake it. */
export interface WsDaemonLike {
  handleCommand(
    text: string,
    onProgress: (message: string) => void,
    options?: { owner?: string },
  ): Promise<unknown>;
  approve(
    approvalId: string,
    onProgress: (message: string) => void,
    options?: { owner?: string },
  ): Promise<unknown>;
  deny(approvalId: string, options?: { owner?: string }): boolean;
}

export interface WsServerOptions {
  port?: number;
  /** Defaults to loopback: this daemon runs shell commands. */
  host?: string;
  workspaceRoot: string;
  keepaliveMs?: number;
  /** Test seam: supply devices instead of reading the file. */
  devices?: Map<string, AuthorizedDevice>;
}

interface Connected {
  socket: import('ws').WebSocket;
  deviceId: string;
  connectedAt: number;
  alive: boolean;
}

export class VigylWebSocketServer {
  private readonly devices: Map<string, AuthorizedDevice>;
  private readonly nonces = new NonceCache();
  private readonly clients = new Map<string, Connected>();
  private readonly keepaliveMs: number;
  private http?: HttpServer;
  private wss?: import('ws').WebSocketServer;
  private keepalive?: NodeJS.Timeout;

  constructor(
    private readonly daemon: WsDaemonLike,
    private readonly options: WsServerOptions,
  ) {
    this.devices = options.devices ?? loadDevices(options.workspaceRoot);
    this.keepaliveMs = options.keepaliveMs ?? KEEPALIVE_INTERVAL_MS;
  }

  get connectionCount(): number {
    return this.clients.size;
  }

  get deviceCount(): number {
    return this.devices.size;
  }

  async start(): Promise<number> {
    const { WebSocketServer } = await import('ws');

    this.http = createServer((_request, response) => {
      // Nothing is served over plain HTTP; this is a WebSocket endpoint.
      response.writeHead(426, { 'content-type': 'text/plain' });
      response.end('Upgrade required');
    });

    this.wss = new WebSocketServer({ server: this.http, maxPayload: MAX_MESSAGE_BYTES });
    this.wss.on('connection', (socket, request) => this.onConnection(socket, request));

    const host = this.options.host ?? '127.0.0.1';
    const port = this.options.port ?? DEFAULT_WS_PORT;

    await new Promise<void>((resolve, reject) => {
      this.http?.once('error', reject);
      this.http?.listen(port, host, () => resolve());
    });

    this.keepalive = setInterval(() => this.sweep(), this.keepaliveMs);
    this.keepalive.unref?.();

    const actual = (this.http?.address() as { port: number } | null)?.port ?? port;
    logger.info('WebSocket server started', {
      host,
      port: actual,
      devices: this.devices.size,
    });
    if (this.devices.size === 0) {
      logger.warn('No authorized devices; every connection will be refused');
    }
    return actual;
  }

  async stop(): Promise<void> {
    if (this.keepalive) clearInterval(this.keepalive);
    for (const client of this.clients.values()) client.socket.close(1001, 'Server stopping');
    this.clients.clear();

    await new Promise<void>((resolve) => {
      if (!this.wss) return resolve();
      this.wss.close(() => resolve());
    });
    await new Promise<void>((resolve) => {
      if (!this.http) return resolve();
      this.http.close(() => resolve());
    });
  }

  private onConnection(socket: import('ws').WebSocket, request: IncomingMessage): void {
    const auth = authenticate(request.headers as AuthHeaders, this.devices, this.nonces);

    if (!auth.ok) {
      // The client is told nothing beyond "no". The reason is logged for the
      // operator, not returned to whoever is knocking.
      logger.warn('WebSocket connection refused', {
        failure: auth.failure,
        remote: request.socket.remoteAddress,
      });
      socket.close(4001, 'Unauthorized');
      return;
    }

    const key = `${auth.device.deviceId}:${Date.now()}:${randomBytes(4).toString('hex')}`;
    const client: Connected = {
      socket,
      deviceId: auth.device.deviceId,
      connectedAt: Date.now(),
      alive: true,
    };
    this.clients.set(key, client);

    logger.info('Device connected', { deviceId: auth.device.deviceId, label: auth.device.label });
    this.send(socket, {
      id: 'system',
      type: 'hello',
      payload: { message: 'Connected to the Vigyl daemon' },
    });

    socket.on('pong', () => {
      client.alive = true;
    });
    socket.on('message', (data) => void this.onMessage(client, String(data)));
    socket.on('close', () => {
      this.clients.delete(key);
      logger.info('Device disconnected', { deviceId: auth.device.deviceId });
    });
    socket.on('error', (error: Error) => {
      logger.warn('WebSocket error', { deviceId: auth.device.deviceId, error: error.message });
    });
  }

  private async onMessage(client: Connected, raw: string): Promise<void> {
    const { message, reason } = parseClientMessage(raw);
    if (!message) {
      this.send(client.socket, {
        id: 'unknown',
        type: 'error',
        payload: { message: `Could not read that message: ${reason}` },
      });
      return;
    }

    if (message.type === 'pong') {
      client.alive = true;
      return;
    }

    const onProgress = (text: string): void => {
      this.send(client.socket, { id: message.id, type: 'progress', payload: { message: text } });
    };

    // The device id is the approval owner, so one device cannot approve
    // another device's request — the same rule Telegram chats get.
    const owner = { owner: client.deviceId };

    try {
      if (message.type === 'command') {
        const result = await this.daemon.handleCommand(message.payload.text ?? '', onProgress, owner);
        this.send(client.socket, toEvent(message.id, result));
        return;
      }

      if (message.type === 'approve') {
        const result = await this.daemon.approve(message.payload.approvalId ?? '', onProgress, owner);
        this.send(client.socket, toEvent(message.id, result));
        return;
      }

      const denied = this.daemon.deny(message.payload.approvalId ?? '', owner);
      this.send(client.socket, {
        id: message.id,
        type: denied ? 'success' : 'error',
        payload: { message: denied ? 'Denied.' : 'That approval is not waiting any more.' },
      });
    } catch (error) {
      logger.warn('WebSocket command failed', {
        deviceId: client.deviceId,
        error: (error as Error).message,
      });
      this.send(client.socket, {
        id: message.id,
        type: 'error',
        payload: { message: (error as Error).message },
      });
    }
  }

  /** Ping everyone; drop anyone who did not answer the last one. */
  private sweep(): void {
    for (const [key, client] of this.clients) {
      if (!client.alive) {
        logger.info('Dropping an unresponsive device', { deviceId: client.deviceId });
        client.socket.terminate();
        this.clients.delete(key);
        continue;
      }
      client.alive = false;
      try {
        client.socket.ping();
        this.send(client.socket, { id: 'ping', type: 'ping', payload: {} });
      } catch {
        this.clients.delete(key);
      }
    }
  }

  private send(socket: import('ws').WebSocket, event: ServerEvent): void {
    // 1 === OPEN. Checked numerically so this file does not need the ws import
    // at module load.
    if (socket.readyState !== 1) return;
    socket.send(JSON.stringify(event));
  }
}

/**
 * Turn a daemon result into an event.
 *
 * An approval becomes `hitl_request` with everything the app needs to draw the
 * two buttons, which is the reason this interface exists at all.
 */
export function toEvent(id: string, result: unknown): ServerEvent {
  const value = (result ?? {}) as Record<string, unknown>;

  switch (value.status) {
    case 'approval_required':
      return {
        id,
        type: 'hitl_request',
        payload: {
          message: String(value.description ?? 'This needs your approval.'),
          approvalId: String(value.approvalId ?? ''),
          reasons: Array.isArray(value.reasons) ? (value.reasons as string[]) : [],
          ...(typeof value.expiresAt === 'number' ? { expiresAt: value.expiresAt } : {}),
          ...(typeof value.description === 'string' ? { description: value.description } : {}),
        },
      };

    case 'completed':
      return {
        id,
        type: 'success',
        payload: { message: String(value.description ?? 'Done.'), data: value },
      };

    case 'tool_result':
      return {
        id,
        type: value.isError === true ? 'error' : 'success',
        payload: { message: String(value.text ?? ''), data: value },
      };

    case 'failed':
    case 'rejected':
    case 'busy':
    case 'error':
      return {
        id,
        type: 'error',
        payload: {
          message: String(value.reason ?? value.description ?? 'That did not work.'),
          data: value,
        },
      };

    default:
      return { id, type: 'success', payload: { message: 'Done.', data: value } };
  }
}
