/**
 * Durable command history, persisted to .vigyl/history.json.
 *
 * Distinct from session.ts, which holds short-lived in-memory context for the
 * Supervisor. This survives a restart and is what /history and /repeat read.
 *
 * DURABILITY. Writes go to a temp file and are then renamed over the target.
 * rename is atomic, so a crash mid-write leaves either the old file or the new
 * one — never a half-written JSON document that makes the daemon fail to start
 * next time. Writing in place is the thing that corrupts history, and history
 * is exactly what you want after an unexplained restart.
 *
 * A file that is already corrupt is moved aside rather than deleted, and the
 * daemon starts with empty history instead of refusing to run. Losing history
 * is annoying; a daemon that will not boot because of it is worse.
 *
 * ISOLATION. Entries are stored per chat id and there is no API that returns
 * another chat's commands.
 */
import * as fs from 'fs';
import * as path from 'path';
import { logger } from './logger';
import type { CommandStatus } from './daemon';

/** Bumped if the on-disk shape ever changes incompatibly. */
const FORMAT_VERSION = 1;

const DEFAULT_MAX_PER_CHAT = 20;
const DEFAULT_MAX_CHATS = 100;
const MAX_TEXT = 400;

export type ChatKey = string | number;

export interface HistoryEntry {
  at: number;
  /** What the user typed — this is what /repeat re-runs. */
  userMessage: string;
  /** The shell command it became, if it got that far. */
  command?: string;
  status: CommandStatus;
  exitCode?: number;
  /** Links to the stored full output, when there is one. */
  commandId?: string;
}

interface HistoryFile {
  version: number;
  chats: Record<string, HistoryEntry[]>;
}

export interface HistoryOptions {
  maxPerChat?: number;
  maxChats?: number;
}

function clip(text: string, limit = MAX_TEXT): string {
  const trimmed = text.trim();
  return trimmed.length <= limit ? trimmed : `${trimmed.slice(0, limit - 1)}…`;
}

function isEntry(value: unknown): value is HistoryEntry {
  if (typeof value !== 'object' || value === null) return false;
  const entry = value as Partial<HistoryEntry>;
  return typeof entry.at === 'number' && typeof entry.userMessage === 'string';
}

export class HistoryStore {
  private readonly filePath: string;
  private readonly maxPerChat: number;
  private readonly maxChats: number;
  private data: HistoryFile = { version: FORMAT_VERSION, chats: {} };

  constructor(filePath: string, options: HistoryOptions = {}) {
    this.filePath = path.resolve(filePath);
    this.maxPerChat = Math.max(1, options.maxPerChat ?? DEFAULT_MAX_PER_CHAT);
    this.maxChats = Math.max(1, options.maxChats ?? DEFAULT_MAX_CHATS);
    this.load();
  }

  get path(): string {
    return this.filePath;
  }

  /** Chats with any recorded history. */
  get chatCount(): number {
    return Object.keys(this.data.chats).length;
  }

  /**
   * Read the file, tolerating everything.
   *
   * Any failure — missing, unreadable, malformed, wrong shape — results in
   * empty history rather than a throw. This runs during daemon construction.
   */
  private load(): void {
    if (!fs.existsSync(this.filePath)) return;

    let raw: string;
    try {
      raw = fs.readFileSync(this.filePath, 'utf-8');
    } catch (err) {
      logger.warn('Could not read history file; starting empty', {
        path: this.filePath,
        reason: err instanceof Error ? err.message : String(err),
      });
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      this.quarantine('not valid JSON');
      return;
    }

    if (typeof parsed !== 'object' || parsed === null || !('chats' in parsed)) {
      this.quarantine('unexpected shape');
      return;
    }

    const chats = (parsed as HistoryFile).chats;
    if (typeof chats !== 'object' || chats === null) {
      this.quarantine('chats is not an object');
      return;
    }

    // Rebuild defensively: keep well-formed entries, drop anything else,
    // rather than trusting a file that has already surprised us once.
    const cleaned: Record<string, HistoryEntry[]> = {};
    for (const [chatId, entries] of Object.entries(chats)) {
      if (!Array.isArray(entries)) continue;
      const valid = entries.filter(isEntry).slice(-this.maxPerChat);
      if (valid.length > 0) cleaned[chatId] = valid;
    }
    this.data = { version: FORMAT_VERSION, chats: cleaned };
  }

  /** Move a bad file aside so it can be inspected, and carry on. */
  private quarantine(reason: string): void {
    const backup = `${this.filePath}.corrupt`;
    try {
      fs.renameSync(this.filePath, backup);
      logger.error('History file was corrupt; moved aside and starting empty', {
        reason,
        path: this.filePath,
        backup,
      });
    } catch (err) {
      logger.error('History file was corrupt and could not be moved aside', {
        reason,
        moveError: err instanceof Error ? err.message : String(err),
      });
    }
    this.data = { version: FORMAT_VERSION, chats: {} };
  }

  /**
   * Write atomically: temp file, then rename over the target.
   *
   * fs.rename replaces the destination on both POSIX and Windows, so a reader
   * sees either the whole old file or the whole new one.
   */
  private persist(): void {
    const tempPath = `${this.filePath}.${process.pid}.tmp`;
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      fs.writeFileSync(tempPath, `${JSON.stringify(this.data, null, 2)}\n`, 'utf-8');
      fs.renameSync(tempPath, this.filePath);
    } catch (err) {
      logger.warn('Could not persist history', {
        path: this.filePath,
        reason: err instanceof Error ? err.message : String(err),
      });
      try {
        fs.rmSync(tempPath, { force: true });
      } catch {
        // best effort
      }
    }
  }

  private key(chatId: ChatKey): string {
    return String(chatId);
  }

  /** Append an entry for this chat and flush to disk. */
  record(chatId: ChatKey, entry: Omit<HistoryEntry, 'at'> & { at?: number }): void {
    const key = this.key(chatId);
    const existing = this.data.chats[key] ?? [];

    existing.push({
      at: entry.at ?? Date.now(),
      userMessage: clip(entry.userMessage),
      status: entry.status,
      ...(entry.command === undefined ? {} : { command: clip(entry.command) }),
      ...(entry.exitCode === undefined ? {} : { exitCode: entry.exitCode }),
      ...(entry.commandId === undefined ? {} : { commandId: entry.commandId }),
    });

    while (existing.length > this.maxPerChat) existing.shift();
    this.data.chats[key] = existing;

    this.evictOverflowChats();
    this.persist();
  }

  /** This chat's entries, newest first. Never another chat's. */
  list(chatId: ChatKey, limit = DEFAULT_MAX_PER_CHAT): readonly HistoryEntry[] {
    const entries = this.data.chats[this.key(chatId)] ?? [];
    return [...entries].reverse().slice(0, Math.max(1, limit));
  }

  /**
   * The most recent entry worth repeating.
   *
   * Skips turns that never produced a command — repeating a message that
   * failed to parse would just fail to parse again.
   */
  lastRepeatable(chatId: ChatKey): HistoryEntry | undefined {
    const entries = this.data.chats[this.key(chatId)] ?? [];
    for (let i = entries.length - 1; i >= 0; i--) {
      const entry = entries[i];
      if (entry !== undefined && entry.command !== undefined) return entry;
    }
    return undefined;
  }

  /** Forget one chat. */
  clear(chatId: ChatKey): boolean {
    const key = this.key(chatId);
    if (this.data.chats[key] === undefined) return false;
    delete this.data.chats[key];
    this.persist();
    return true;
  }

  /** Forget everything, on disk too. */
  clearAll(): number {
    const count = this.chatCount;
    this.data = { version: FORMAT_VERSION, chats: {} };
    this.persist();
    return count;
  }

  /** Drop the chats with the oldest most-recent activity. */
  private evictOverflowChats(): void {
    const keys = Object.keys(this.data.chats);
    if (keys.length <= this.maxChats) return;

    const byRecency = keys
      .map((key) => ({ key, at: this.data.chats[key]?.at(-1)?.at ?? 0 }))
      .sort((a, b) => b.at - a.at);

    for (const { key } of byRecency.slice(this.maxChats)) {
      delete this.data.chats[key];
    }
  }
}
