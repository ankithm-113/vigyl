/**
 * Structured logger.
 *
 * Two sinks:
 *   - stdout: colorized, human-readable, one line per event (+ pretty meta)
 *   - file:   newline-delimited JSON at .vigyl/logs/daemon.log, rotated at 10MB
 *
 * The logger deliberately does NOT depend on config.ts — config.ts logs its own
 * failures, so the dependency has to run one way. It boots at the level given by
 * VIGYL_LOG_LEVEL (default "info"); loadConfig() calls setLogLevel() afterwards
 * to apply daemon.log_level from the config file.
 *
 * Everything written through this logger passes through a redaction pass first.
 * We log config objects, command strings, and LLM payloads — all of which can
 * carry an Anthropic key or a bot token — and daemon.log is exactly the file a
 * user will paste into a GitHub issue.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as winston from 'winston';

export const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

export function isLogLevel(value: unknown): value is LogLevel {
  return typeof value === 'string' && (LOG_LEVELS as readonly string[]).includes(value);
}

/** Keys whose value is replaced wholesale, regardless of content. */
const SECRET_KEY_PATTERN = /(api[_-]?key|token|secret|password|passwd|authorization|credential)/i;

/**
 * Patterns scrubbed from any string, even when the key looks innocent.
 *
 * No \b anchors on the bot-token pattern: the highest-value leak is a URL like
 * api.telegram.org/bot<token>/getMe, where the digits are preceded by "bot" —
 * a word character, so \b never matches there.
 */
const SECRET_VALUE_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [/sk-ant-[A-Za-z0-9_-]{8,}/g, 'sk-ant-[REDACTED]'],
  // OpenAI: sk-proj-, sk-svcacct-, sk-admin-, or legacy bare sk-. After the
  // Anthropic rule, whose replacement is too short to match this one.
  [/sk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,}/g, 'sk-[REDACTED]'],
  [/\d{6,12}:[A-Za-z0-9_-]{30,}/g, '[REDACTED-BOT-TOKEN]'],
];

const REDACTED = '[REDACTED]';
const MAX_REDACT_DEPTH = 8;

function scrubString(value: string): string {
  let out = value;
  for (const [pattern, replacement] of SECRET_VALUE_PATTERNS) {
    out = out.replace(pattern, replacement);
  }
  return out;
}

function redactValue(
  value: unknown,
  keyName: string | undefined,
  seen: WeakSet<object>,
  depth: number,
): unknown {
  if (keyName !== undefined && SECRET_KEY_PATTERN.test(keyName)) {
    // Preserve shape for objects (e.g. a nested `anthropic` block), redact leaves.
    if (typeof value === 'string' || typeof value === 'number') return REDACTED;
  }

  if (typeof value === 'string') return scrubString(value);
  if (value === null || typeof value !== 'object') return value;
  if (depth >= MAX_REDACT_DEPTH) return '[TRUNCATED]';

  const asObject = value as object;
  if (seen.has(asObject)) return '[CIRCULAR]';
  seen.add(asObject);

  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item, keyName, seen, depth + 1));
  }

  if (value instanceof Error) {
    return {
      name: value.name,
      message: scrubString(value.message),
      stack: value.stack === undefined ? undefined : scrubString(value.stack),
    };
  }

  const out: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    out[key] = redactValue(nested, key, seen, depth + 1);
  }
  return out;
}

/** Deep-copy `value`, replacing anything that looks like a credential. Pure. */
export function redactSecrets(value: unknown): unknown {
  return redactValue(value, undefined, new WeakSet(), 0);
}

const redactFormat = winston.format((info) => {
  for (const key of Object.keys(info)) {
    if (key === 'level') continue;
    const record = info as unknown as Record<string, unknown>;
    record[key] = redactValue(record[key], key === 'message' ? undefined : key, new WeakSet(), 0);
  }
  return info;
});

/** Directory holding daemon.log. Override with VIGYL_LOG_DIR (used by tests). */
export function resolveLogDir(): string {
  const override = process.env['VIGYL_LOG_DIR'];
  if (override !== undefined && override.trim() !== '') return path.resolve(override);
  return path.join(process.cwd(), '.vigyl', 'logs');
}

export const LOG_DIR = resolveLogDir();
export const LOG_FILE = path.join(LOG_DIR, 'daemon.log');

const initialLevel: LogLevel = isLogLevel(process.env['VIGYL_LOG_LEVEL'])
  ? process.env['VIGYL_LOG_LEVEL']
  : 'info';

const consoleTransport = new winston.transports.Console({
  format: winston.format.combine(
    winston.format.colorize(),
    winston.format.printf((info) => {
      const { level, message, timestamp, stack, ...rest } = info as unknown as Record<
        string,
        unknown
      >;
      const time = typeof timestamp === 'string' ? timestamp : new Date().toISOString();
      const text = typeof message === 'string' ? message : JSON.stringify(message);
      const meta = Object.keys(rest).length > 0 ? `\n${JSON.stringify(rest, null, 2)}` : '';
      const trace = typeof stack === 'string' ? `\n${stack}` : '';
      return `${time} [${level}] ${text}${meta}${trace}`;
    }),
  ),
});

export const logger = winston.createLogger({
  level: initialLevel,
  format: winston.format.combine(
    redactFormat(),
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.json(),
  ),
  transports: [consoleTransport],
});

/**
 * Attach the JSON file sink. Called once at module load unless VIGYL_NO_FILE_LOG
 * is set. Failure to create the log directory is non-fatal — a daemon that can't
 * write logs should still be able to run and report that fact on stdout.
 */
export function attachFileTransport(dir: string = LOG_DIR): boolean {
  try {
    fs.mkdirSync(dir, { recursive: true });
    logger.add(
      new winston.transports.File({
        filename: path.join(dir, 'daemon.log'),
        maxsize: 10 * 1024 * 1024,
        maxFiles: 5,
        tailable: true,
      }),
    );
    return true;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    logger.warn('File logging disabled — could not create log directory', { dir, reason });
    return false;
  }
}

if (process.env['VIGYL_NO_FILE_LOG'] !== '1') {
  attachFileTransport();
}

/** Change the level at runtime. Applies to every sink. */
export function setLogLevel(level: LogLevel): void {
  logger.level = level;
  for (const transport of logger.transports) {
    transport.level = level;
  }
}

export function getLogLevel(): LogLevel {
  return isLogLevel(logger.level) ? logger.level : 'info';
}
