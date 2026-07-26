/**
 * Telegram interface (grammY).
 *
 * This file is deliberately thin. All state — pending approvals, expiry,
 * ownership — lives in daemon.ts; the bot renders CommandResults and turns
 * button presses back into daemon calls. It switches on `result.status` and
 * never inspects message text to decide what happened, which is what the build
 * guide did (`result.includes('requires your approval')`).
 *
 * Three things the guide gets wrong and this file fixes:
 *
 *   1. parse_mode "Markdown" on arbitrary command output. Telegram rejects the
 *      whole message on an unbalanced backtick or underscore, so a build log
 *      containing one would silently fail to send. We use HTML, where exactly
 *      three characters need escaping and we control all of them.
 *   2. No length handling. Telegram caps a message at 4096 characters; a build
 *      log blows past that and the send fails.
 *   3. An edit per progress line. Telegram rate-limits edits to roughly one per
 *      second per chat, and the guide edits on every callback — which earns a
 *      429 partway through a noisy build and loses the rest of the updates.
 */
import { Bot, GrammyError, HttpError, InlineKeyboard } from 'grammy';
import type { Context } from 'grammy';
import { logger } from './logger';
import type { CommandResult } from './daemon';
import type { VigylDaemon } from './daemon';
import type { StopReason } from './self-heal';
import type { VigylConfig } from './config';

/** Telegram's hard limit on a message body. */
export const TELEGRAM_MAX_MESSAGE = 4096;
/** Leaves room for our own framing around truncated output. */
const OUTPUT_BUDGET = 3_000;
/** Telegram tolerates about one edit per second per chat. */
const EDIT_INTERVAL_MS = 1_200;
/** Progress lines kept on screen at once. */
const PROGRESS_WINDOW = 8;

export const CALLBACK_APPROVE = 'approve';
export const CALLBACK_DENY = 'deny';

// ---------------------------------------------------------------------------
// Pure helpers (exported for testing)
// ---------------------------------------------------------------------------

/** Escape for Telegram's HTML parse mode. Exactly these three, nothing else. */
export function escapeHtml(text: string): string {
  return text.split('&').join('&amp;').split('<').join('&lt;').split('>').join('&gt;');
}

/**
 * Trim output to fit, keeping the END.
 *
 * Errors are reported last. Truncating the tail would throw away the only part
 * of a build log anyone wants to read.
 */
export function truncateOutput(output: string, budget: number = OUTPUT_BUDGET): string {
  const trimmed = output.trim();
  if (trimmed.length <= budget) return trimmed;
  const kept = trimmed.slice(-budget);
  const dropped = trimmed.length - kept.length;
  return `… [${dropped} earlier characters omitted] …\n${kept}`;
}

/** Final guard so a message can never exceed Telegram's limit. */
export function clampMessage(text: string): string {
  if (text.length <= TELEGRAM_MAX_MESSAGE) return text;
  return `${text.slice(0, TELEGRAM_MAX_MESSAGE - 20)}\n… [truncated]`;
}

function codeBlock(text: string): string {
  return `<pre>${escapeHtml(text)}</pre>`;
}

export function isAuthorized(chatId: number | undefined, allowed: readonly number[]): boolean {
  if (chatId === undefined) return false;
  return allowed.includes(chatId);
}

export interface RenderedMessage {
  text: string;
  keyboard?: InlineKeyboard;
}

/** Turn a CommandResult into what the user sees. Pure; no Telegram calls. */
export function renderResult(result: CommandResult): RenderedMessage {
  switch (result.status) {
    case 'completed': {
      const lines = [`✅ <b>Done</b> — ${escapeHtml(result.description)}`];
      if (result.attempts > 1) {
        lines.push(`<i>Succeeded on attempt ${result.attempts} after self-healing.</i>`);
      }
      for (const patch of result.patches) {
        lines.push(`✍ Patched <code>${escapeHtml(patch.proposedPath)}</code> — ${escapeHtml(patch.explanation)}`);
      }
      const output = truncateOutput(result.output);
      if (output !== '') lines.push(codeBlock(output));
      return { text: clampMessage(lines.join('\n')) };
    }

    case 'failed': {
      const lines = [`❌ <b>Failed</b> — ${escapeHtml(result.description)}`];
      lines.push(`Exit code ${result.exitCode} after ${result.attempts} attempt(s).`);
      lines.push(`<i>${escapeHtml(explainStopReason(result.reason))}</i>`);
      if (result.message !== undefined) lines.push(codeBlock(truncateOutput(result.message, 400)));
      for (const patch of result.patches) {
        lines.push(
          `✍ Patched <code>${escapeHtml(patch.proposedPath)}</code> (backup kept) — ${escapeHtml(patch.explanation)}`,
        );
      }
      const output = truncateOutput(result.output, 1_500);
      if (output !== '') lines.push(codeBlock(output));
      return { text: clampMessage(lines.join('\n')) };
    }

    case 'approval_required': {
      const secondsLeft = Math.max(0, Math.round((result.expiresAt - Date.now()) / 1000));
      const lines = [
        '⚠️ <b>This needs your approval</b>',
        '',
        escapeHtml(result.description),
        `<code>${escapeHtml(result.command)}</code>`,
        '',
        'Why:',
        ...result.reasons.map((reason) => `• ${escapeHtml(reason)}`),
        '',
        `<i>Expires in ${secondsLeft}s.</i>`,
      ];
      const keyboard = new InlineKeyboard()
        .text('✅ Approve', `${CALLBACK_APPROVE}:${result.approvalId}`)
        .text('❌ Deny', `${CALLBACK_DENY}:${result.approvalId}`);
      return { text: clampMessage(lines.join('\n')), keyboard };
    }

    case 'rejected':
      return {
        text: clampMessage(
          `⛔ <b>Refused</b>\n${codeBlock(result.reason)}` +
            (result.command === undefined ? '' : `\nCommand: <code>${escapeHtml(result.command)}</code>`),
        ),
      };

    case 'busy':
      return { text: `⏳ <b>Busy</b>\n${escapeHtml(result.reason)}` };

    case 'error':
      return { text: clampMessage(`⚠️ <b>Something went wrong</b>\n${codeBlock(result.reason)}`) };
  }
}

/** Plain-English gloss for a StopReason, so the user knows what to do next. */
export function explainStopReason(reason: StopReason): string {
  switch (reason) {
    case 'not_auto_fixable':
      return 'This kind of failure cannot be fixed by editing a file — it needs you.';
    case 'no_patch_offered':
      return 'Claude was not confident enough to propose a fix.';
    case 'patch_rejected':
      return 'A proposed fix targeted a file outside the workspace and was blocked.';
    case 'patch_write_failed':
      return 'The fix could not be written to disk.';
    case 'repeated_failure':
      return 'The same error came back unchanged after a patch, so I stopped.';
    case 'retries_exhausted':
      return 'I tried every retry available and it still failed.';
    case 'disabled':
      return 'Self-healing is turned off in your config.';
    default:
      return String(reason);
  }
}

/** Split a callback_data payload. Returns undefined when it is not ours. */
export function parseCallbackData(
  data: string | undefined,
): { action: 'approve' | 'deny'; approvalId: string } | undefined {
  if (data === undefined) return undefined;
  const separator = data.indexOf(':');
  if (separator < 0) return undefined;
  const action = data.slice(0, separator);
  const approvalId = data.slice(separator + 1);
  if (approvalId === '') return undefined;
  if (action === CALLBACK_APPROVE) return { action: 'approve', approvalId };
  if (action === CALLBACK_DENY) return { action: 'deny', approvalId };
  return undefined;
}

// ---------------------------------------------------------------------------
// Live progress
// ---------------------------------------------------------------------------

/**
 * Streams progress into a single message, edited in place and throttled.
 *
 * Telegram rate-limits edits per chat. Rather than edit on every line (and get
 * a 429 partway through a noisy build), lines are buffered and flushed on a
 * timer; the newest state always wins, so a dropped intermediate frame costs
 * nothing.
 */
class ProgressPresenter {
  private readonly ctx: Context;
  private readonly lines: string[] = [];
  private messageId: number | undefined;
  private lastEditAt = 0;
  private timer: NodeJS.Timeout | undefined;
  private sending = false;

  constructor(ctx: Context) {
    this.ctx = ctx;
  }

  /** Safe to call from a synchronous progress callback; never throws. */
  push(line: string): void {
    this.lines.push(line);
    const since = Date.now() - this.lastEditAt;
    if (since >= EDIT_INTERVAL_MS) {
      void this.flush();
      return;
    }
    if (this.timer === undefined) {
      this.timer = setTimeout(() => {
        this.timer = undefined;
        void this.flush();
      }, EDIT_INTERVAL_MS - since);
    }
  }

  private currentText(): string {
    return clampMessage(codeBlock(this.lines.slice(-PROGRESS_WINDOW).join('\n')));
  }

  private async flush(): Promise<void> {
    if (this.sending || this.lines.length === 0) return;
    this.sending = true;
    this.lastEditAt = Date.now();

    try {
      const text = this.currentText();
      if (this.messageId === undefined) {
        const sent = await this.ctx.reply(text, { parse_mode: 'HTML' });
        this.messageId = sent.message_id;
      } else {
        await this.ctx.api.editMessageText(this.ctx.chat!.id, this.messageId, text, {
          parse_mode: 'HTML',
        });
      }
    } catch (err) {
      // "message is not modified" and rate limits are both non-fatal; the
      // final result message is sent separately regardless.
      logger.debug('Progress update skipped', {
        reason: err instanceof Error ? err.message : String(err),
      });
    } finally {
      this.sending = false;
    }
  }

  /** Stop the timer. The result message is sent by the caller. */
  dispose(): void {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }
}

// ---------------------------------------------------------------------------
// Bot
// ---------------------------------------------------------------------------

export class TelegramInterface {
  private readonly bot: Bot;
  private readonly daemon: VigylDaemon;
  private readonly allowedChatIds: readonly number[];

  /**
   * @param onPollingStopped invoked when long polling ends unexpectedly. In
   *   Month 1 Telegram is the ONLY interface, so a daemon that has lost it is
   *   doing nothing at all — the caller is expected to exit rather than linger.
   */
  constructor(
    config: VigylConfig,
    daemon: VigylDaemon,
    private readonly onPollingStopped?: (reason: string) => void,
  ) {
    this.bot = new Bot(config.telegram.bot_token);
    this.daemon = daemon;
    this.allowedChatIds = config.telegram.allowed_chat_ids;

    this.warnAboutGroupChats();
    this.installAuth();
    this.installCommands();
    this.installApprovalButtons();
    this.installNaturalLanguage();
    this.installErrorHandler();
  }

  /**
   * A negative chat id is a group or channel. Allowing one grants every member
   * of that group the ability to run commands on the server — which is a very
   * different decision from allowing one person, and is easy to make by
   * accident when copying an id out of a group chat.
   */
  private warnAboutGroupChats(): void {
    const groups = this.allowedChatIds.filter((id) => id < 0);
    if (groups.length > 0) {
      logger.warn(
        'Group chats are authorized — EVERY member can control this server',
        { groupChatIds: groups },
      );
    }
  }

  /**
   * Authorization. Registered before every other handler, so nothing runs for
   * an unknown chat. Applies to button presses as well as messages: a callback
   * query is an update like any other, and an inline keyboard's callback_data
   * is trivially replayable by anyone who learns the approval id.
   */
  private installAuth(): void {
    this.bot.use(async (ctx, next) => {
      const chatId = ctx.chat?.id;

      if (!isAuthorized(chatId, this.allowedChatIds)) {
        logger.warn('Unauthorized Telegram update rejected', {
          chatId,
          from: ctx.from?.id,
          username: ctx.from?.username,
          updateType: ctx.callbackQuery !== undefined ? 'callback_query' : 'message',
        });
        if (chatId !== undefined) {
          await ctx
            .reply(
              `⛔ Not authorized.\n\nThis chat's ID is <code>${chatId}</code>.\n` +
                `Add it to <code>telegram.allowed_chat_ids</code> in vigyl.config.json and restart.`,
              { parse_mode: 'HTML' },
            )
            .catch(() => undefined);
        }
        return; // do not call next()
      }

      await next();
    });
  }

  private installCommands(): void {
    this.bot.command('start', async (ctx) => {
      await ctx.reply(WELCOME, { parse_mode: 'HTML' });
    });

    this.bot.command('help', async (ctx) => {
      await ctx.reply(HELP, { parse_mode: 'HTML' });
    });

    this.bot.command('status', async (ctx) => {
      const status = this.daemon.status;
      const lines = [
        status.running ? '✅ <b>Vigyl is running</b>' : '⛔ <b>Vigyl is stopped</b>',
        `Workspace: <code>${escapeHtml(status.workspaceRoot)}</code>`,
        `Model: <code>${escapeHtml(status.model)}</code>`,
        `Version: ${escapeHtml(status.version)}`,
        status.busy ? 'Currently running a command.' : 'Idle.',
      ];
      if (status.pendingApprovals > 0) {
        lines.push(`${status.pendingApprovals} approval(s) waiting.`);
      }
      await ctx.reply(lines.join('\n'), { parse_mode: 'HTML' });
    });
  }

  private installApprovalButtons(): void {
    this.bot.on('callback_query:data', async (ctx) => {
      const parsed = parseCallbackData(ctx.callbackQuery.data);
      if (parsed === undefined) {
        await ctx.answerCallbackQuery({ text: 'Unrecognized button.' });
        return;
      }

      const owner = ctx.chat?.id;

      if (parsed.action === 'deny') {
        const existed = this.daemon.deny(parsed.approvalId, { owner });
        await ctx.answerCallbackQuery({ text: existed ? 'Cancelled.' : 'Already handled.' });
        await this.clearKeyboard(ctx);
        await ctx.reply(existed ? '❌ Cancelled — nothing was run.' : '❌ That approval is no longer pending.');
        return;
      }

      // Acknowledge immediately: Telegram shows a spinner until we answer, and
      // the command may take minutes.
      await ctx.answerCallbackQuery({ text: 'Approved — running now.' });
      await this.clearKeyboard(ctx);

      const presenter = new ProgressPresenter(ctx);
      try {
        const result = await this.daemon.approve(
          parsed.approvalId,
          (line) => presenter.push(line),
          { owner },
        );
        await this.send(ctx, result);
      } catch (err) {
        await this.reportUnexpected(ctx, err);
      } finally {
        presenter.dispose();
      }
    });
  }

  private installNaturalLanguage(): void {
    this.bot.on('message:text', async (ctx) => {
      const text = ctx.message.text.trim();
      if (text === '' || text.startsWith('/')) return; // commands handled above

      await ctx.replyWithChatAction('typing').catch(() => undefined);

      const presenter = new ProgressPresenter(ctx);
      try {
        const result = await this.daemon.handleCommand(text, (line) => presenter.push(line), {
          owner: ctx.chat.id,
        });
        await this.send(ctx, result);
      } catch (err) {
        await this.reportUnexpected(ctx, err);
      } finally {
        presenter.dispose();
      }
    });
  }

  private installErrorHandler(): void {
    this.bot.catch((err) => {
      const inner = err.error;
      if (inner instanceof GrammyError) {
        logger.error('Telegram API rejected a request', {
          description: inner.description,
          method: inner.method,
        });
      } else if (inner instanceof HttpError) {
        logger.error('Could not reach Telegram', { reason: String(inner) });
      } else {
        logger.error('Unhandled bot error', {
          reason: inner instanceof Error ? inner.message : String(inner),
        });
      }
    });
  }

  private async send(ctx: Context, result: CommandResult): Promise<void> {
    const rendered = renderResult(result);
    await ctx.reply(rendered.text, {
      parse_mode: 'HTML',
      ...(rendered.keyboard === undefined ? {} : { reply_markup: rendered.keyboard }),
    });
  }

  /** Remove the buttons so an approval cannot be pressed twice. */
  private async clearKeyboard(ctx: Context): Promise<void> {
    await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => undefined);
  }

  private async reportUnexpected(ctx: Context, err: unknown): Promise<void> {
    const reason = err instanceof Error ? err.message : String(err);
    logger.error('Command handling threw', { reason });
    await ctx
      .reply(`⚠️ <b>Something went wrong</b>\n${codeBlock(reason)}`, { parse_mode: 'HTML' })
      .catch(() => undefined);
  }

  /** Begin long polling. Resolves once polling has started. */
  async start(): Promise<void> {
    logger.info('Telegram bot starting', { authorizedChats: this.allowedChatIds.length });
    // start() only resolves when the bot STOPS, so it must not be awaited.
    // It must still be caught: an invalid token rejects here, and an
    // unhandled rejection would take the whole daemon down with a stack
    // trace instead of a diagnosis.
    this.bot
      .start({
        onStart: (me) => {
          logger.info('Telegram bot ready', { username: me.username });
        },
      })
      .catch((err: unknown) => {
        const reason = err instanceof Error ? err.message : String(err);
        // Do NOT claim the daemon carries on here. Nothing else holds the
        // event loop open, so the process would exit seconds later anyway —
        // silently, leaving a pid file pointing at nothing and 'vigyl start'
        // cheerfully launching a second copy on top of it.
        logger.error('Telegram polling stopped — the bot is unreachable', {
          reason,
          hint: reason.includes('401')
            ? 'The bot token is wrong or has been revoked. Run vigyl init.'
            : 'Check network access to api.telegram.org.',
        });
        this.onPollingStopped?.(reason);
      });
  }

  async stop(): Promise<void> {
    await this.bot.stop();
    logger.info('Telegram bot stopped');
  }
}

const WELCOME = `🌑 <b>Vigyl is ready</b>

Your infrastructure, in your pocket.

Send a command in plain English:
• "check if the server is healthy"
• "show me the last 50 lines of the app log"
• "run the test suite"
• "deploy to staging"

/status — daemon status
/help — command reference`;

const HELP = `<b>Vigyl command reference</b>

<b>Health</b>
• Is the server healthy?
• Check disk usage

<b>Logs</b>
• Show the last 100 lines of the app log
• Any errors in the last 10 minutes?

<b>Build &amp; deploy</b>
• Run the test suite
• Deploy to staging
• Deploy to production <i>(needs approval)</i>

<b>Services</b>
• Restart the API service
• Is Redis running?

Anything destructive shows Approve / Deny buttons.
If a build fails, I will try to fix it and run it again.`;
