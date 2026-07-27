/**
 * Full command output, kept on disk so a truncated Telegram message can still
 * be retrieved in full.
 *
 * SECURITY. The command id reaches this module from user input — someone types
 * `/logs abc12345`, or presses a button whose callback_data they could forge.
 * It is therefore never concatenated into a path on trust. Two independent
 * checks, in this order:
 *
 *   1. The id must match a strict token pattern. Nothing with a separator, a
 *      dot, or a NUL can even be considered.
 *   2. The resolved path must still be inside the log directory, checked with
 *      the same containment logic as the workspace sandbox.
 *
 * Either check alone would probably do. Both are cheap, and this is a path
 * built from attacker-controlled text.
 *
 * BOUNDS. A daemon runs for weeks and every command writes a file, so the
 * directory is pruned on each write by count and by total size. Without that,
 * "keep the full log" quietly becomes "fill the disk".
 */
import * as fs from 'fs';
import * as path from 'path';
import { randomBytes } from 'crypto';
import { logger } from './logger';
import { isContained } from './security';

/** 8 hex characters: short enough to type, long enough not to collide. */
const ID_PATTERN = /^[0-9a-f]{8}$/;
const ID_BYTES = 4;

const DEFAULT_MAX_FILES = 50;
const DEFAULT_MAX_TOTAL_BYTES = 20 * 1024 * 1024;
/** Refuse to store more than this from a single command. */
const DEFAULT_MAX_FILE_BYTES = 5 * 1024 * 1024;

export interface LogStoreOptions {
  maxFiles?: number;
  maxTotalBytes?: number;
  maxFileBytes?: number;
}

export interface StoredLog {
  commandId: string;
  path: string;
  text: string;
  bytes: number;
}

export interface LogMetadata {
  command: string;
  exitCode: number;
  attempts: number;
  at: number;
}

/** True only for an id this module could have generated. */
export function isValidCommandId(value: unknown): value is string {
  return typeof value === 'string' && ID_PATTERN.test(value);
}

export class CommandLogStore {
  private readonly dir: string;
  private readonly maxFiles: number;
  private readonly maxTotalBytes: number;
  private readonly maxFileBytes: number;

  constructor(dir: string, options: LogStoreOptions = {}) {
    this.dir = path.resolve(dir);
    this.maxFiles = Math.max(1, options.maxFiles ?? DEFAULT_MAX_FILES);
    this.maxTotalBytes = Math.max(1, options.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES);
    this.maxFileBytes = Math.max(1, options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES);
  }

  get directory(): string {
    return this.dir;
  }

  /**
   * Turn an id into a path, or undefined if it is not one of ours.
   *
   * Exported behaviour, not a private detail: every read goes through here,
   * and it is the only place an id becomes a filename.
   */
  resolve(commandId: string): string | undefined {
    if (!isValidCommandId(commandId)) {
      logger.warn('Rejected a malformed command log id', { commandId: String(commandId).slice(0, 64) });
      return undefined;
    }

    const candidate = path.resolve(this.dir, `${commandId}.log`);
    if (!isContained(this.dir, candidate)) {
      // Unreachable given the pattern above, which is exactly why it is here:
      // if the pattern is ever loosened, this still holds the line.
      logger.warn('Command log path escaped the log directory', { commandId, candidate });
      return undefined;
    }
    return candidate;
  }

  /** Persist output and return the id used to retrieve it. */
  write(output: string, meta: LogMetadata): string | undefined {
    if (output.trim() === '') return undefined;

    try {
      fs.mkdirSync(this.dir, { recursive: true });

      const commandId = this.freshId();
      const target = this.resolve(commandId);
      if (target === undefined) return undefined;

      const header = [
        `# command: ${meta.command}`,
        `# exit code: ${meta.exitCode}`,
        `# attempts: ${meta.attempts}`,
        `# recorded: ${new Date(meta.at).toISOString()}`,
        '',
      ].join('\n');

      const body =
        output.length > this.maxFileBytes
          ? `${output.slice(0, this.maxFileBytes)}\n… [truncated at ${this.maxFileBytes} bytes]`
          : output;

      fs.writeFileSync(target, `${header}${body}\n`, 'utf-8');
      this.prune();
      return commandId;
    } catch (err) {
      // A daemon that cannot save a log should still report the command result.
      logger.warn('Could not store command log', {
        reason: err instanceof Error ? err.message : String(err),
      });
      return undefined;
    }
  }

  /** Read a stored log, or undefined if the id is unknown or invalid. */
  read(commandId: string): StoredLog | undefined {
    const target = this.resolve(commandId);
    if (target === undefined) return undefined;

    try {
      const text = fs.readFileSync(target, 'utf-8');
      return { commandId, path: target, text, bytes: Buffer.byteLength(text, 'utf-8') };
    } catch {
      return undefined;
    }
  }

  has(commandId: string): boolean {
    const target = this.resolve(commandId);
    return target !== undefined && fs.existsSync(target);
  }

  /** Delete the oldest logs until the count and size caps are satisfied. */
  prune(): number {
    let removed = 0;
    try {
      if (!fs.existsSync(this.dir)) return 0;

      const entries = fs
        .readdirSync(this.dir)
        .filter((name) => name.endsWith('.log'))
        .map((name) => {
          const full = path.join(this.dir, name);
          const stat = fs.statSync(full);
          return { full, mtimeMs: stat.mtimeMs, size: stat.size };
        })
        // Newest first, so the tail of the list is what gets dropped.
        .sort((a, b) => b.mtimeMs - a.mtimeMs);

      let runningBytes = 0;
      for (const [index, entry] of entries.entries()) {
        runningBytes += entry.size;
        const overCount = index >= this.maxFiles;
        const overSize = runningBytes > this.maxTotalBytes && index > 0;
        if (overCount || overSize) {
          fs.rmSync(entry.full, { force: true });
          removed++;
        }
      }
    } catch (err) {
      logger.debug('Log pruning failed', {
        reason: err instanceof Error ? err.message : String(err),
      });
    }
    return removed;
  }

  /** Remove every stored log. Returns how many went. */
  clear(): number {
    try {
      if (!fs.existsSync(this.dir)) return 0;
      const names = fs.readdirSync(this.dir).filter((name) => name.endsWith('.log'));
      for (const name of names) fs.rmSync(path.join(this.dir, name), { force: true });
      return names.length;
    } catch {
      return 0;
    }
  }

  private freshId(): string {
    for (let attempt = 0; attempt < 8; attempt++) {
      const id = randomBytes(ID_BYTES).toString('hex');
      if (!this.has(id)) return id;
    }
    // Vanishingly unlikely; a collision only costs one overwritten log.
    return randomBytes(ID_BYTES).toString('hex');
  }
}
