/**
 * Background service management.
 *
 * `vigyl start` re-executes this CLI as a detached child running `vigyl run`,
 * so there is one code path for foreground and background operation and no
 * second binary to keep in sync.
 *
 * The PID file stores more than a number. A bare pid is not enough to decide
 * whether a daemon is running: pids are recycled, so a stale file can point at
 * an unrelated process that `vigyl stop` would then kill. Recording the start
 * time and workspace lets us notice when the pid no longer refers to us.
 */
import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';

export interface PidRecord {
  pid: number;
  /** Epoch ms, used to spot a recycled pid. */
  startedAt: number;
  workspaceRoot: string;
  version: string;
}

export function vigylDir(cwd: string = process.cwd()): string {
  return path.join(cwd, '.vigyl');
}

export function pidFilePath(cwd: string = process.cwd()): string {
  return path.join(vigylDir(cwd), 'daemon.pid');
}

export function logFilePath(cwd: string = process.cwd()): string {
  return path.join(vigylDir(cwd), 'logs', 'daemon.log');
}

export function stdioLogPath(cwd: string = process.cwd()): string {
  return path.join(vigylDir(cwd), 'logs', 'daemon.out');
}

export function readPidRecord(cwd: string = process.cwd()): PidRecord | undefined {
  const file = pidFilePath(cwd);
  if (!fs.existsSync(file)) return undefined;
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf-8'));
    if (typeof parsed !== 'object' || parsed === null) return undefined;
    const record = parsed as Partial<PidRecord>;
    if (typeof record.pid !== 'number') return undefined;
    return {
      pid: record.pid,
      startedAt: typeof record.startedAt === 'number' ? record.startedAt : 0,
      workspaceRoot: typeof record.workspaceRoot === 'string' ? record.workspaceRoot : '',
      version: typeof record.version === 'string' ? record.version : 'unknown',
    };
  } catch {
    return undefined;
  }
}

export function writePidRecord(record: PidRecord, cwd: string = process.cwd()): void {
  fs.mkdirSync(vigylDir(cwd), { recursive: true });
  fs.writeFileSync(pidFilePath(cwd), `${JSON.stringify(record, null, 2)}\n`, 'utf-8');
}

export function removePidFile(cwd: string = process.cwd()): void {
  try {
    fs.rmSync(pidFilePath(cwd), { force: true });
  } catch {
    // nothing useful to do
  }
}

/** Signal 0 tests for existence without delivering anything. */
export function isAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means it exists but belongs to another user — still "alive".
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export type ServiceState =
  | { state: 'running'; record: PidRecord }
  | { state: 'stopped' }
  | { state: 'stale'; record: PidRecord };

export function serviceState(cwd: string = process.cwd()): ServiceState {
  const record = readPidRecord(cwd);
  if (record === undefined) return { state: 'stopped' };
  if (!isAlive(record.pid)) return { state: 'stale', record };
  return { state: 'running', record };
}

/** Absolute path to this CLI's entry point, for re-exec. */
export function cliEntryPoint(): string {
  return path.resolve(__dirname, 'index.js');
}

export interface SpawnResult {
  pid: number;
  logPath: string;
}

/**
 * Launch the daemon in the background.
 *
 * stdio is redirected to a file rather than ignored: if the daemon dies during
 * startup, that file is the only record of why, and "it just didn't start" is
 * the least debuggable failure a user can report.
 */
export function spawnDetached(cwd: string = process.cwd()): SpawnResult {
  const outPath = stdioLogPath(cwd);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  const out = fs.openSync(outPath, 'a');

  const child = spawn(process.execPath, [cliEntryPoint(), 'run'], {
    cwd,
    detached: true,
    stdio: ['ignore', out, out],
    env: process.env,
  });
  child.unref();

  if (child.pid === undefined) {
    throw new Error('Failed to spawn the daemon process.');
  }
  return { pid: child.pid, logPath: outPath };
}

/**
 * Ask a process to stop, escalating if it will not.
 *
 * Windows has no real signals: process.kill terminates immediately whatever
 * signal is named, so the graceful window only applies on POSIX.
 */
export async function terminate(pid: number, graceMs = 5_000): Promise<boolean> {
  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    return false;
  }

  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }

  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    // already gone between the check and here
  }
  return !isAlive(pid);
}

/** Split on LF; CR is trimmed by the blank-line filter. */
const NEWLINE = String.fromCharCode(10);

/** Byte length of the log file, or 0 when it does not exist yet. */
export function logFileSize(cwd: string = process.cwd()): number {
  try {
    return fs.statSync(logFilePath(cwd)).size;
  } catch {
    return 0;
  }
}

/**
 * Read whatever was appended past `offset`.
 *
 * Returns the new offset so the caller can poll. Handles the two things that
 * break a naive implementation: the file being rotated or truncated (size goes
 * backwards, so start over), and a read landing mid-line (hold the partial
 * line back until its newline arrives).
 */
export function readLogSince(
  offset: number,
  cwd: string = process.cwd(),
): { lines: string[]; offset: number } {
  const file = logFilePath(cwd);
  let size: number;
  try {
    size = fs.statSync(file).size;
  } catch {
    return { lines: [], offset: 0 };
  }

  if (size < offset) return { lines: [], offset: 0 };
  if (size === offset) return { lines: [], offset };

  const handle = fs.openSync(file, 'r');
  try {
    const length = size - offset;
    const buffer = Buffer.alloc(length);
    const read = fs.readSync(handle, buffer, 0, length, offset);
    const chunk = buffer.subarray(0, read).toString('utf-8');

    const lastBreak = chunk.lastIndexOf(String.fromCharCode(10));
    if (lastBreak === -1) return { lines: [], offset };

    const complete = chunk.slice(0, lastBreak);
    const lines = complete.split(NEWLINE).filter((line) => line.trim() !== '');
    return { lines, offset: offset + Buffer.byteLength(complete, 'utf-8') + 1 };
  } finally {
    fs.closeSync(handle);
  }
}

/**
 * Print appended log lines until the process is interrupted.
 *
 * Polling rather than fs.watch: watch semantics differ across platforms and
 * miss appends on some network shares, and once a second is plenty for a log a
 * human is reading.
 */
export function followLog(
  write: (line: string) => void,
  cwd: string = process.cwd(),
  intervalMs = 1_000,
): () => void {
  let offset = logFileSize(cwd);
  const tick = (): void => {
    const next = readLogSince(offset, cwd);
    offset = next.offset;
    for (const line of next.lines) write(line);
  };
  const timer = setInterval(tick, Math.max(100, intervalMs));
  return () => clearInterval(timer);
}

/** Read the tail of the daemon log without shelling out to `tail`. */
export function readLogTail(lines: number, cwd: string = process.cwd()): string[] {
  const file = logFilePath(cwd);
  if (!fs.existsSync(file)) return [];
  const contents = fs.readFileSync(file, 'utf-8');
  return contents.split(/\r?\n/).filter((line) => line.trim() !== '').slice(-Math.max(1, lines));
}
