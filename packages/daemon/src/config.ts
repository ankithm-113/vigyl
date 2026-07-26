/**
 * Config loading and validation.
 *
 * Precedence, highest first:
 *   1. environment variables (and .env, loaded here — not at import time)
 *   2. vigyl.config.json
 *   3. schema defaults
 *
 * Nothing else in the daemon is allowed to read process.env for config values;
 * this module is the single place raw input becomes a validated VigylConfig.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as dotenv from 'dotenv';
import { z } from 'zod';
import { LOG_LEVELS, logger, setLogLevel } from './logger';

export const CONFIG_FILENAME = 'vigyl.config.json';
export const DEFAULT_MODEL = 'claude-haiku-4-5';

/** Thrown for every config failure. Message is already human-readable. */
export class ConfigError extends Error {
  public readonly problems: string[];

  constructor(message: string, problems: string[] = []) {
    super(message);
    this.name = 'ConfigError';
    this.problems = problems;
  }
}

/**
 * workspace_root must be an existing directory, and we store its *canonical*
 * path — symlinks resolved, Windows casing normalized. Day 3's sandbox compares
 * resolved paths against this value, so canonicalizing once here is what makes
 * that comparison trustworthy.
 */
const WorkspaceRootSchema = z
  .string()
  .min(1, 'must not be empty')
  .transform((raw, ctx) => {
    const resolved = path.resolve(raw);
    let real: string;
    try {
      real = fs.realpathSync.native(resolved);
    } catch {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `directory does not exist: ${resolved}`,
      });
      return z.NEVER;
    }
    if (!fs.statSync(real).isDirectory()) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `not a directory: ${real}` });
      return z.NEVER;
    }
    return real;
  });

/** Telegram chat IDs arrive as numbers from the API and strings from env/JSON. */
const ChatIdSchema = z.union([z.number(), z.string()]).transform((raw, ctx) => {
  const parsed = typeof raw === 'string' ? Number(raw.trim()) : raw;
  if (!Number.isInteger(parsed)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `"${String(raw)}" is not a valid Telegram chat ID (expected an integer)`,
    });
    return z.NEVER;
  }
  return parsed;
});

export const VigylConfigSchema = z
  .object({
    workspace_root: WorkspaceRootSchema,

    telegram: z
      .object({
        bot_token: z.string().min(1, 'required — get one from @BotFather'),
        allowed_chat_ids: z.array(ChatIdSchema).default([]),
      })
      .strict(),

    anthropic: z
      .object({
        api_key: z.string().min(1, 'required — create one at console.anthropic.com'),
        model: z.string().min(1).default(DEFAULT_MODEL),
      })
      .strict(),

    hitl: z
      .object({
        require_for: z
          .array(z.string().min(1))
          .default(['production', 'env', 'delete', 'migrate', 'push']),
        timeout_seconds: z.number().int().positive('must be greater than 0').default(300),
      })
      .strict()
      .default({}),

    self_heal: z
      .object({
        enabled: z.boolean().default(true),
        max_retries: z.number().int().min(0, 'must not be negative').default(3),
        context_lines: z.number().int().positive('must be greater than 0').default(80),
      })
      .strict()
      .default({}),

    daemon: z
      .object({
        log_level: z.enum(LOG_LEVELS).default('info'),
        log_retention_days: z.number().int().positive('must be greater than 0').default(7),
      })
      .strict()
      .default({}),
  })
  .strict();

export type VigylConfig = z.infer<typeof VigylConfigSchema>;

/** Which env var sets each field — used to make validation errors actionable. */
const ENV_HINTS: Readonly<Record<string, string>> = {
  workspace_root: 'VIGYL_WORKSPACE',
  'telegram.bot_token': 'TELEGRAM_BOT_TOKEN',
  'telegram.allowed_chat_ids': 'VIGYL_ALLOWED_CHAT_IDS',
  'anthropic.api_key': 'ANTHROPIC_API_KEY',
  'anthropic.model': 'VIGYL_MODEL',
  'daemon.log_level': 'VIGYL_LOG_LEVEL',
  'hitl.timeout_seconds': 'VIGYL_HITL_TIMEOUT_SECONDS',
};

function formatIssues(error: z.ZodError, source: string): ConfigError {
  const problems = error.issues.map((issue) => {
    const field = issue.path.join('.') || '(root)';
    const hint = ENV_HINTS[field];
    const suffix = hint === undefined ? '' : ` (or set ${hint})`;
    return `${field}: ${issue.message}${suffix}`;
  });

  const header =
    problems.length === 1
      ? `Invalid Vigyl config — ${source}`
      : `Invalid Vigyl config (${problems.length} problems) — ${source}`;

  const body = problems.map((p) => `  • ${p}`).join('\n');
  return new ConfigError(
    `${header}\n\n${body}\n\nFix ${CONFIG_FILENAME}, or run \`vigyl init\` to regenerate it.`,
    problems,
  );
}

function splitChatIds(raw: string): string[] {
  return raw
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part !== '');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Read the config file. Returns {} when absent — env alone may be sufficient. */
function readConfigFile(filePath: string): Record<string, unknown> {
  if (!fs.existsSync(filePath)) return {};

  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf-8');
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new ConfigError(`Could not read ${filePath}: ${reason}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new ConfigError(
      `${filePath} is not valid JSON: ${reason}\n\n` +
        `Fix the syntax, or delete the file and run \`vigyl init\`.`,
    );
  }

  if (!isRecord(parsed)) {
    throw new ConfigError(`${filePath} must contain a JSON object, got ${typeof parsed}.`);
  }
  return parsed;
}

/**
 * Overlay env vars onto the file contents. Explicit rather than a generic deep
 * merge: the set of overridable fields is small, and enumerating them keeps
 * attacker-controlled keys from reaching the merge.
 */
function applyEnvOverrides(base: Record<string, unknown>): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...base };

  const telegram = isRecord(base['telegram']) ? { ...base['telegram'] } : {};
  const anthropic = isRecord(base['anthropic']) ? { ...base['anthropic'] } : {};
  const hitl = isRecord(base['hitl']) ? { ...base['hitl'] } : {};
  const daemonSection = isRecord(base['daemon']) ? { ...base['daemon'] } : {};

  const workspace = process.env['VIGYL_WORKSPACE'];
  if (workspace !== undefined && workspace !== '') merged['workspace_root'] = workspace;

  const botToken = process.env['TELEGRAM_BOT_TOKEN'];
  if (botToken !== undefined && botToken !== '') telegram['bot_token'] = botToken;

  const chatIds = process.env['VIGYL_ALLOWED_CHAT_IDS'];
  if (chatIds !== undefined && chatIds !== '') telegram['allowed_chat_ids'] = splitChatIds(chatIds);

  const apiKey = process.env['ANTHROPIC_API_KEY'];
  if (apiKey !== undefined && apiKey !== '') anthropic['api_key'] = apiKey;

  const model = process.env['VIGYL_MODEL'];
  if (model !== undefined && model !== '') anthropic['model'] = model;

  const logLevel = process.env['VIGYL_LOG_LEVEL'];
  if (logLevel !== undefined && logLevel !== '') daemonSection['log_level'] = logLevel;

  const hitlTimeout = process.env['VIGYL_HITL_TIMEOUT_SECONDS'];
  if (hitlTimeout !== undefined && hitlTimeout !== '') {
    hitl['timeout_seconds'] = Number(hitlTimeout);
  }

  if (Object.keys(telegram).length > 0) merged['telegram'] = telegram;
  if (Object.keys(anthropic).length > 0) merged['anthropic'] = anthropic;
  if (Object.keys(hitl).length > 0) merged['hitl'] = hitl;
  if (Object.keys(daemonSection).length > 0) merged['daemon'] = daemonSection;

  return merged;
}

/** Non-fatal shape checks. Wrong-looking credentials are worth saying out loud. */
function warnOnSuspiciousValues(config: VigylConfig): void {
  if (config.telegram.allowed_chat_ids.length === 0) {
    logger.warn(
      'No allowed_chat_ids configured — every Telegram message will be rejected. ' +
        'Message the bot and add the chat ID it reports.',
    );
  }
  if (!config.anthropic.api_key.startsWith('sk-ant-')) {
    logger.warn('anthropic.api_key does not look like an Anthropic key (expected sk-ant-…).');
  }
  if (!/^\d+:/.test(config.telegram.bot_token)) {
    logger.warn('telegram.bot_token does not look like a BotFather token (expected 123456:ABC…).');
  }
}

let current: VigylConfig | undefined;

export function resolveConfigPath(configPath?: string): string {
  if (configPath !== undefined && configPath !== '') return path.resolve(configPath);
  const fromEnv = process.env['VIGYL_CONFIG'];
  if (fromEnv !== undefined && fromEnv !== '') return path.resolve(fromEnv);
  return path.join(process.cwd(), CONFIG_FILENAME);
}

/**
 * Load, validate, and memoize the config. Also applies daemon.log_level to the
 * logger. Throws ConfigError with a readable message on any failure.
 */
export function loadConfig(configPath?: string): VigylConfig {
  dotenv.config();

  const filePath = resolveConfigPath(configPath);
  const fromFile = readConfigFile(filePath);
  const fileExists = Object.keys(fromFile).length > 0;
  const merged = applyEnvOverrides(fromFile);

  if (!fileExists && Object.keys(merged).length === 0) {
    throw new ConfigError(
      `No Vigyl config found at ${filePath}, and no config environment variables are set.\n\n` +
        `Run \`vigyl init\` to create one.`,
    );
  }

  const source = fileExists ? filePath : 'environment variables';
  const result = VigylConfigSchema.safeParse(merged);
  if (!result.success) throw formatIssues(result.error, source);

  current = result.data;
  setLogLevel(current.daemon.log_level);

  logger.debug('Config loaded', {
    source,
    workspace_root: current.workspace_root,
    model: current.anthropic.model,
    allowed_chat_ids: current.telegram.allowed_chat_ids.length,
  });
  warnOnSuspiciousValues(current);

  return current;
}

/** The config loaded earlier in this process. Throws if loadConfig() hasn't run. */
export function getConfig(): VigylConfig {
  if (current === undefined) {
    throw new ConfigError('Config has not been loaded yet — call loadConfig() first.');
  }
  return current;
}

export function isConfigLoaded(): boolean {
  return current !== undefined;
}

/** Drop the memoized config. For tests and for `vigyl init` re-reading the file. */
export function resetConfig(): void {
  current = undefined;
}

/** Skeleton written by the `vigyl init` wizard (Day 9-10). Not yet validated. */
export function getDefaultConfig(workspaceRoot: string): Record<string, unknown> {
  return {
    workspace_root: workspaceRoot,
    telegram: { bot_token: '', allowed_chat_ids: [] },
    anthropic: { api_key: '', model: DEFAULT_MODEL },
    hitl: {
      require_for: ['production', 'env', 'delete', 'migrate', 'push'],
      timeout_seconds: 300,
    },
    self_heal: { enabled: true, max_retries: 3, context_lines: 80 },
    daemon: { log_level: 'info', log_retention_days: 7 },
  };
}
