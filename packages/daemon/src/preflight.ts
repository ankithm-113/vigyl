/**
 * Live credential checks.
 *
 * Run by `vigyl init` before it writes a config file, and by `vigyl start`
 * before it goes to the background. The point is that every failure mode a
 * user can hit — wrong key, revoked token, no network, a model their account
 * cannot reach — surfaces in the terminal with a readable message, rather than
 * two minutes later inside a detached process whose only symptom is that
 * Telegram never replies.
 *
 * Nothing here throws. Each check returns a result the caller can render.
 */
import Anthropic from '@anthropic-ai/sdk';
import { logger } from './logger';
import { Supervisor } from './supervisor';

export interface CheckResult {
  ok: boolean;
  /** One line, safe to print. Never contains the credential. */
  detail: string;
  /** Present on success where there is something useful to show. */
  info?: Record<string, string | number>;
}

const CHECK_TIMEOUT_MS = 20_000;

/**
 * Verify the Anthropic key and that the account can reach the model.
 *
 * Uses models.retrieve rather than a messages call: it is free, it is fast,
 * and it distinguishes "bad key" from "key is fine but this model id is wrong
 * for your account", which a 400 from messages would not.
 */
export async function checkAnthropicKey(apiKey: string, model: string): Promise<CheckResult> {
  if (apiKey.trim() === '') return { ok: false, detail: 'No API key provided.' };

  const client = new Anthropic({ apiKey, maxRetries: 1, timeout: CHECK_TIMEOUT_MS });

  try {
    const found = await client.models.retrieve(model);
    return {
      ok: true,
      detail: `Key valid; ${found.display_name} is available.`,
      info: { model: found.id, displayName: found.display_name },
    };
  } catch (err) {
    if (err instanceof Anthropic.AuthenticationError) {
      return { ok: false, detail: 'Anthropic rejected this key. Check it at console.anthropic.com.' };
    }
    if (err instanceof Anthropic.NotFoundError) {
      return {
        ok: false,
        detail: `The key works, but model "${model}" is not available to this account.`,
      };
    }
    if (err instanceof Anthropic.PermissionDeniedError) {
      return { ok: false, detail: 'This key does not have permission to use the Models API.' };
    }
    if (err instanceof Anthropic.APIConnectionError) {
      return { ok: false, detail: 'Could not reach api.anthropic.com. Check your network.' };
    }
    return { ok: false, detail: describe(err) };
  }
}

/**
 * Exercise the real request shape the daemon will use.
 *
 * A valid key does not prove structured outputs work: the schema still has to
 * compile server-side and the model still has to fill it. This is the only
 * check that covers that path, and it is the one that would have caught a
 * broken output_config before a user hit it from their phone. Costs a few
 * hundred Haiku tokens.
 */
export async function checkCommandParsing(
  apiKey: string,
  model: string,
  workspaceRoot: string,
): Promise<CheckResult> {
  const supervisor = new Supervisor({ anthropic: { api_key: apiKey, model } });

  try {
    const parsed = await supervisor.parseCommand('show me the last 20 lines of the app log', {
      workspaceRoot,
    });
    return {
      ok: true,
      detail: `Parsed a test request into: ${parsed.command}`,
      info: { action: parsed.action, command: parsed.command },
    };
  } catch (err) {
    return { ok: false, detail: describe(err) };
  }
}

interface TelegramResponse<T> {
  ok: boolean;
  result?: T;
  description?: string;
}

async function telegram<T>(token: string, method: string, query = ''): Promise<TelegramResponse<T>> {
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}${query}`, {
    signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
  });
  return (await response.json()) as TelegramResponse<T>;
}

/** Verify the bot token with getMe, and report the bot's @username. */
export async function checkTelegramToken(token: string): Promise<CheckResult> {
  if (token.trim() === '') return { ok: false, detail: 'No bot token provided.' };

  try {
    const body = await telegram<{ username: string; first_name: string }>(token, 'getMe');
    if (!body.ok || body.result === undefined) {
      return {
        ok: false,
        detail: `Telegram rejected this token: ${body.description ?? 'unknown reason'}`,
      };
    }
    return {
      ok: true,
      detail: `Connected to @${body.result.username}.`,
      info: { username: body.result.username, name: body.result.first_name },
    };
  } catch (err) {
    if (err instanceof Error && err.name === 'TimeoutError') {
      return { ok: false, detail: 'Timed out reaching api.telegram.org.' };
    }
    return { ok: false, detail: describe(err) };
  }
}

export interface ChatIdResult {
  ok: boolean;
  chatId?: number;
  detail: string;
}

/**
 * Wait for someone to message the bot, and report which chat they used.
 *
 * The build guide's version advances the getUpdates offset ONLY when it fails
 * to find a chat id, so any non-message update at the head of the queue is
 * re-read forever and the wizard hangs until it times out. This acknowledges
 * every update it has seen regardless, and scans the whole batch rather than
 * just the first entry.
 */
export async function captureChatId(token: string, timeoutMs = 120_000): Promise<ChatIdResult> {
  const deadline = Date.now() + timeoutMs;
  let offset = 0;

  while (Date.now() < deadline) {
    let body: TelegramResponse<Array<Record<string, unknown>>>;
    try {
      body = await telegram(token, 'getUpdates', `?offset=${offset}&timeout=10`);
    } catch (err) {
      if (err instanceof Error && err.name === 'TimeoutError') continue; // long-poll expiry
      return { ok: false, detail: describe(err) };
    }

    if (!body.ok) {
      return { ok: false, detail: `Telegram error: ${body.description ?? 'unknown'}` };
    }

    for (const update of body.result ?? []) {
      // Acknowledge every update, whether or not it is the one we want.
      const updateId = update['update_id'];
      if (typeof updateId === 'number') offset = Math.max(offset, updateId + 1);

      const chatId = extractChatId(update);
      if (chatId !== undefined) {
        logger.debug('Captured Telegram chat id', { chatId });
        return { ok: true, chatId, detail: `Captured chat ID ${chatId}.` };
      }
    }
  }

  return {
    ok: false,
    detail: 'Timed out waiting for a message. Open Telegram, find your bot, and send it anything.',
  };
}

/** Pull chat.id out of whichever update shape arrived. */
function extractChatId(update: Record<string, unknown>): number | undefined {
  for (const key of ['message', 'edited_message', 'channel_post', 'my_chat_member']) {
    const payload = update[key];
    if (typeof payload !== 'object' || payload === null) continue;
    const chat = (payload as Record<string, unknown>)['chat'];
    if (typeof chat !== 'object' || chat === null) continue;
    const id = (chat as Record<string, unknown>)['id'];
    if (typeof id === 'number') return id;
  }
  return undefined;
}

function describe(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
