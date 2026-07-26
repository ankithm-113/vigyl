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

/** Read the tail of the daemon log without shelling out to `tail`. */
export function readLogTail(lines: number, cwd: string = process.cwd()): string[] {
  const file = logFilePath(cwd);
  if (!fs.existsSync(file)) return [];
  const contents = fs.readFileSync(file, 'utf-8');
  return contents.split(/\r?\n/).filter((line) => line.trim() !== '').slice(-Math.max(1, lines));
}
