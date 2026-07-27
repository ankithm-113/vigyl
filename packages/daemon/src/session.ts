/**
 * Per-chat conversation history.
 *
 * Feeds SupervisorContext.recentOutput so a follow-up like "run that again" or
 * "why did that fail?" has something to refer to.
 *
 * THREE THINGS THIS FILE IS RESPONSIBLE FOR
 *
 * 1. Isolation. History is keyed strictly by chat id and there is no API that
 *    returns another chat's turns. Two people talking to the same bot must
 *    never see each other's commands, and — worse — must never have one
 *    person's output steer the model while parsing the other's message.
 *
 * 2. Bounds. A daemon runs for weeks. Both dimensions are capped: turns per
 *    chat, and number of chats (LRU). Capping only the former still leaks, one
 *    Map entry per chat that ever messaged the bot.
 *
 * 3. Injection hygiene. Everything stored here is untrusted — command output is
 *    attacker-influenced in any project with dependencies, and the user message
 *    is arbitrary text. Fence delimiters are stripped on the way IN as well as
 *    on the way out in supervisor.ts, so a forged delimiter cannot survive a
 *    round trip through history even if the outer fencing were changed.
 */
import { FENCE_CLOSE, FENCE_OPEN } from './supervisor';
import type { CommandStatus } from './daemon';

/** Turns retained per chat. */
const DEFAULT_MAX_TURNS = 10;
/** Turns actually shown to the model — the build guide asks for the last 3. */
export const DEFAULT_CONTEXT_TURNS = 3;
/** Output kept per turn. Enough to be useful, small enough to bound growth. */
const DEFAULT_MAX_OUTPUT_CHARS = 1_500;
/** Chats tracked before the least recently used is evicted. */
const DEFAULT_MAX_CHATS = 100;
/** Idle chats are forgotten after this long. */
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1_000;
/** A single stored user message cannot be longer than this. */
const MAX_MESSAGE_CHARS = 500;

export type ChatKey = string | number;

export interface SessionTurn {
  at: number;
  /** What the user typed. Truncated and sanitized. */
  userMessage: string;
  /** The shell command it became, if it got that far. */
  command?: string;
  description?: string;
  status: CommandStatus;
  exitCode?: number;
  /** Tail of the command output. Truncated and sanitized. */
  outputTail?: string;
}

export interface SessionOptions {
  maxTurnsPerChat?: number;
  maxChats?: number;
  maxOutputChars?: number;
  ttlMs?: number;
}

/**
 * Remove anything that could impersonate the prompt's fencing.
 *
 * supervisor.ts strips these again when it builds the prompt. Doing it here as
 * well means stored history is clean at rest, so a future caller that forgets
 * to fence is not instantly exploitable.
 */
export function sanitize(text: string, limit: number): string {
  const withoutDelimiters = text.split(FENCE_OPEN).join('').split(FENCE_CLOSE).join('');
  // Strip C0 control characters, keeping tab and newline: they carry real
  // structure in command output. Built from char codes because escapes
  // written into this source get normalised into raw bytes on save.
  const controls = new RegExp(
    '[' +
      Array.from({ length: 32 }, (_unused, code) => code)
        .filter((code) => code !== 9 && code !== 10)
        .map((code) => String.fromCharCode(code))
        .join('') +
      String.fromCharCode(127) +
      ']',
    'g',
  );
  const collapsed = withoutDelimiters.replace(controls, '');
  if (collapsed.length <= limit) return collapsed.trim();
  // Keep the END: for output, the error is last; for a message, the ask is last.
  return `…${collapsed.slice(-limit)}`.trim();
}

export class SessionStore {
  /** Insertion order doubles as LRU order: touched chats move to the back. */
  private readonly chats = new Map<string, SessionTurn[]>();
  private readonly lastSeen = new Map<string, number>();

  private readonly maxTurnsPerChat: number;
  private readonly maxChats: number;
  private readonly maxOutputChars: number;
  private readonly ttlMs: number;

  constructor(options: SessionOptions = {}) {
    this.maxTurnsPerChat = Math.max(1, options.maxTurnsPerChat ?? DEFAULT_MAX_TURNS);
    this.maxChats = Math.max(1, options.maxChats ?? DEFAULT_MAX_CHATS);
    this.maxOutputChars = Math.max(1, options.maxOutputChars ?? DEFAULT_MAX_OUTPUT_CHARS);
    this.ttlMs = Math.max(0, options.ttlMs ?? DEFAULT_TTL_MS);
  }

  /** Number of chats currently tracked. */
  get size(): number {
    this.expire();
    return this.chats.size;
  }

  private key(chatId: ChatKey): string {
    return String(chatId);
  }

  /** Append a turn, trimming the chat's history and evicting old chats. */
  record(chatId: ChatKey, turn: Omit<SessionTurn, 'at'> & { at?: number }): void {
    this.expire();

    const key = this.key(chatId);
    const existing = this.chats.get(key) ?? [];

    const stored: SessionTurn = {
      at: turn.at ?? Date.now(),
      userMessage: sanitize(turn.userMessage, MAX_MESSAGE_CHARS),
      status: turn.status,
      ...(turn.command === undefined
        ? {}
        : { command: sanitize(turn.command, MAX_MESSAGE_CHARS) }),
      ...(turn.description === undefined
        ? {}
        : { description: sanitize(turn.description, MAX_MESSAGE_CHARS) }),
      ...(turn.exitCode === undefined ? {} : { exitCode: turn.exitCode }),
      ...(turn.outputTail === undefined || turn.outputTail.trim() === ''
        ? {}
        : { outputTail: sanitize(turn.outputTail, this.maxOutputChars) }),
    };

    existing.push(stored);
    while (existing.length > this.maxTurnsPerChat) existing.shift();

    // Re-insert so this chat becomes the most recently used.
    this.chats.delete(key);
    this.chats.set(key, existing);
    this.lastSeen.set(key, stored.at);

    this.evictOverflow();
  }

  /** This chat's turns, oldest first. Never another chat's. */
  history(chatId: ChatKey): readonly SessionTurn[] {
    this.expire();
    return this.chats.get(this.key(chatId)) ?? [];
  }

  /** The most recent command this chat actually ran, for "run that again". */
  lastCommand(chatId: ChatKey): string | undefined {
    const turns = this.history(chatId);
    for (let i = turns.length - 1; i >= 0; i--) {
      const command = turns[i]?.command;
      if (command !== undefined && command !== '') return command;
    }
    return undefined;
  }

  /**
   * Render this chat's recent turns for SupervisorContext.recentOutput.
   *
   * Returns undefined when there is nothing worth sending, so the prompt does
   * not carry an empty context block.
   */
  recentOutput(chatId: ChatKey, turns: number = DEFAULT_CONTEXT_TURNS): string | undefined {
    const recent = this.history(chatId).slice(-Math.max(1, turns));
    if (recent.length === 0) return undefined;

    const blocks = recent.map((turn, index) => {
      const position = recent.length - index;
      const lines = [`[${position} command(s) ago] user said: ${turn.userMessage}`];
      if (turn.command !== undefined) lines.push(`  ran: ${turn.command}`);
      lines.push(
        `  outcome: ${turn.status}${turn.exitCode === undefined ? '' : ` (exit ${turn.exitCode})`}`,
      );
      if (turn.outputTail !== undefined) lines.push(`  output:\n${turn.outputTail}`);
      return lines.join('\n');
    });

    return blocks.join('\n\n');
  }

  /** Forget one chat. */
  clear(chatId: ChatKey): boolean {
    const key = this.key(chatId);
    this.lastSeen.delete(key);
    return this.chats.delete(key);
  }

  /** Forget everything. Returns how many chats were dropped. */
  clearAll(): number {
    const count = this.chats.size;
    this.chats.clear();
    this.lastSeen.clear();
    return count;
  }

  /** Drop the least recently used chats until we are back within the cap. */
  private evictOverflow(): void {
    while (this.chats.size > this.maxChats) {
      const oldest = this.chats.keys().next();
      if (oldest.done === true) return;
      this.chats.delete(oldest.value);
      this.lastSeen.delete(oldest.value);
    }
  }

  private expire(): void {
    if (this.ttlMs === 0) return;
    const cutoff = Date.now() - this.ttlMs;
    for (const [key, seen] of this.lastSeen) {
      if (seen <= cutoff) {
        this.chats.delete(key);
        this.lastSeen.delete(key);
      }
    }
  }
}
