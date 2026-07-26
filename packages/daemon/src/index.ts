/**
 * @vigyl/daemon — public surface.
 *
 * This package is a library. The user-facing `vigyl` binary lives in
 * @vigyl/cli, which depends on this package. Nothing here should call
 * process.exit() or write to stdout directly — that is the CLI's job.
 *
 * Build order (Month 1, Week 1):
 *   Day 2  config.ts    — Zod-validated config loader          [done]
 *   Day 2  logger.ts    — winston structured logger            [done]
 *   Day 3  security.ts  — path sandbox + command policy      [done]
 *   Day 3  executor.ts  — PTY command execution              [done]
 *   Day 4  monitor.ts   — output buffer + error classification
 *   Day 5  supervisor.ts— Claude intent parsing + patch generation
 *   Day 6  self-heal.ts — run/classify/patch/retry loop
 *   Day 7  daemon.ts    — orchestrator
 *   Day 8  bot.ts       — Telegram interface (grammY)
 *   Day 8  hitl.ts      — approval gate with expiry
 */

export const VERSION = '0.1.0';

export {
  CONFIG_FILENAME,
  ConfigError,
  DEFAULT_MODEL,
  VigylConfigSchema,
  getConfig,
  getDefaultConfig,
  isConfigLoaded,
  loadConfig,
  resetConfig,
  resolveConfigPath,
  type VigylConfig,
} from './config';

export {
  SecurityError,
  SecurityLayer,
  isContained,
  type ValidatePathOptions,
} from './security';

export {
  EXIT_TIMEOUT,
  Executor,
  ExecutorBusyError,
  ShellUnavailableError,
  cleanOutput,
  findExecutable,
  resolveShell,
  type ExecuteOptions,
  type ExecutionResult,
  type ShellSpec,
} from './executor';

export {
  LOG_DIR,
  LOG_FILE,
  LOG_LEVELS,
  getLogLevel,
  isLogLevel,
  logger,
  redactSecrets,
  setLogLevel,
  type LogLevel,
} from './logger';
