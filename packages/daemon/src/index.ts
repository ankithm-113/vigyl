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
 *   Day 4  monitor.ts   — output buffer + error classification [done]
 *   Day 5  supervisor.ts— Claude intent parsing + patch generation [done]
 *   Day 6  self-heal.ts — run/classify/patch/retry loop        [done]
 *   Day 7  daemon.ts    — orchestrator                        [done]
 *   Day 8  bot.ts       — Telegram interface (grammY)          [done]
 *   Day 8  hitl.ts      — approval gate with expiry             [done]
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
  loadDotenv,
  resetConfig,
  resolveConfigPath,
  type VigylConfig,
} from './config';

export {
  CommandLogStore,
  isValidCommandId,
  type LogMetadata,
  type LogStoreOptions,
  type StoredLog,
} from './log-store';

export {
  DEFAULT_CONTEXT_TURNS,
  SessionStore,
  sanitize,
  type ChatKey,
  type SessionOptions,
  type SessionTurn,
} from './session';

export {
  captureChatId,
  checkAnthropicKey,
  checkCommandParsing,
  checkTelegramToken,
  type ChatIdResult,
  type CheckResult,
} from './preflight';

export {
  CALLBACK_APPROVE,
  CALLBACK_DENY,
  CALLBACK_LOG,
  LOG_AS_FILE_THRESHOLD,
  TELEGRAM_MAX_MESSAGE,
  TelegramInterface,
  clampMessage,
  escapeHtml,
  explainStopReason,
  isAuthorized,
  parseCallbackData,
  renderResult,
  truncateOutput,
  type RenderedMessage,
} from './bot';

export {
  ApprovalStore,
  approvalReasons,
  type ApprovalOwner,
  type ClaimFailure,
  type ClaimResult,
  type PendingApproval,
} from './hitl';

export {
  DAEMON_VERSION,
  DaemonNotStartedError,
  VigylDaemon,
  type ApprovalRequiredResult,
  type BusyResult,
  type CommandResult,
  type CommandStatus,
  type CompletedResult,
  type DaemonStatus,
  type ErrorResult,
  type FailedResult,
  type HandleOptions,
  type RejectedResult,
} from './daemon';

export {
  HARD_MAX_RETRIES,
  SelfHealingLoop,
  type AppliedPatch,
  type HealResult,
  type ProgressReporter,
  type StopReason,
} from './self-heal';

export {
  ACTIONS,
  ParsedCommandSchema,
  PatchProposalSchema,
  Supervisor,
  SupervisorError,
  toUnvalidatedPatch,
  type Action,
  type ParsedCommand,
  type PatchProposal,
  type SupervisorContext,
  type UnvalidatedPatch,
} from './supervisor';

export {
  ERROR_TYPES,
  Monitor,
  classifyError,
  extractLocation,
  type ErrorContext,
  type ErrorType,
  type ExtractedLocation,
} from './monitor';

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
