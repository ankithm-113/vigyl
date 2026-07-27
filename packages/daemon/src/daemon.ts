/**
 * The orchestrator. One entry point — handleCommand() — wired to config,
 * executor, supervisor and the self-healing loop.
 *
 * STRUCTURED RESULTS. Every path returns a CommandResult, a discriminated
 * union on `status`. Callers switch on it. This is deliberate and it is the
 * fix for a real defect in the build guide, whose handleCommand returned a
 * human-readable string and whose Telegram bot then did
 *
 *     if (result.includes('requires your approval')) { ...ask for approval... }
 *
 * That is control flow driven by prose. It breaks when the wording changes,
 * when the message is translated, and — worse — when a command's own output
 * happens to contain the phrase, at which point a completed command is
 * presented to the user as a pending approval.
 *
 * APPROVALS. A command needing approval is stored, not re-parsed. The guide
 * re-sent `originalMessage + ' --approved'` through the LLM on approval, which
 * asks the model to parse a string no human wrote and trusts it to notice a
 * magic suffix. Here the parsed command is held in a short-lived store and
 * executed verbatim when approved, so what the user approved is exactly what
 * runs.
 */
import * as fs from 'fs';
import * as path from 'path';
import { ApprovalStore, approvalReasons, type ApprovalOwner } from './hitl';
import { Executor } from './executor';

import { SecurityError, SecurityLayer } from './security';
import { HealthMonitor, type HealthAlert, type HealthMetrics } from './health';
import { HistoryStore, type HistoryEntry } from './history';
import { CommandLogStore, type StoredLog } from './log-store';
import { LOG_DIR, logger } from './logger';
import { SessionStore, type ChatKey, type SessionTurn } from './session';
import { SelfHealingLoop, type AppliedPatch, type ProgressReporter, type StopReason } from './self-heal';
import { Supervisor, SupervisorError, type ParsedCommand } from './supervisor';
import type { ErrorType } from './monitor';
import type { VigylConfig } from './config';

export const DAEMON_VERSION = '0.1.0';

export type CommandStatus =
  | 'completed'
  | 'failed'
  | 'approval_required'
  | 'rejected'
  | 'busy'
  | 'error';

export interface CompletedResult {
  status: 'completed';
  /** Handle for retrieving the untruncated output, when one was stored. */
  commandId?: string;
  command: string;
  description: string;
  attempts: number;
  exitCode: number;
  output: string;
  patches: AppliedPatch[];
}

export interface FailedResult {
  status: 'failed';
  /** Handle for retrieving the untruncated output, when one was stored. */
  commandId?: string;
  command: string;
  description: string;
  attempts: number;
  exitCode: number;
  /** Why the self-healing loop gave up. */
  reason: StopReason;
  errorType?: ErrorType;
  message?: string;
  output: string;
  patches: AppliedPatch[];
}

export interface ApprovalRequiredResult {
  status: 'approval_required';
  /** Opaque handle to pass back to approve() or deny(). */
  approvalId: string;
  command: string;
  description: string;
  isDestructive: boolean;
  /** Epoch ms after which the approval is no longer valid. */
  expiresAt: number;
  /** Why approval is needed — shown to the user, and useful in logs. */
  reasons: string[];
}

/** A refusal. The command was never run. */
export interface RejectedResult {
  status: 'rejected';
  command?: string;
  reason: string;
}

export interface BusyResult {
  status: 'busy';
  reason: string;
}

/** Something broke on our side — API failure, bad config, internal error. */
export interface ErrorResult {
  status: 'error';
  reason: string;
}

export type CommandResult =
  | CompletedResult
  | FailedResult
  | ApprovalRequiredResult
  | RejectedResult
  | BusyResult
  | ErrorResult;

export interface DaemonStatus {
  running: boolean;
  busy: boolean;
  version: string;
  workspaceRoot: string;
  model: string;
  pendingApprovals: number;
  startedAt?: number;
}

export interface HandleOptions {
  /** Scopes the approval so one chat cannot approve another chat's command. */
  owner?: ApprovalOwner;
}

export class DaemonNotStartedError extends Error {
  constructor() {
    super('Daemon has not been started. Call start() first.');
    this.name = 'DaemonNotStartedError';
  }
}

function explainClaimFailure(failure: 'unknown' | 'expired' | 'wrong_owner'): string {
  switch (failure) {
    case 'expired':
      return 'That approval expired. Send the command again if you still want it.';
    case 'wrong_owner':
      return 'That approval belongs to someone else.';
    default:
      return 'That approval is no longer valid — it expired or was already handled.';
  }
}

export class VigylDaemon {
  private readonly config: VigylConfig;
  private readonly security: SecurityLayer;
  private readonly executor: Executor;
  private readonly supervisor: Supervisor;
  private readonly selfHeal: SelfHealingLoop;
  private readonly approvals: ApprovalStore;
  private readonly sessions = new SessionStore();
  private readonly logs: CommandLogStore;
  private readonly commands: HistoryStore;
  private readonly monitor: HealthMonitor;
  private onHealthAlert: ((chatIds: readonly number[], alerts: readonly HealthAlert[]) => void) | undefined;

  private running = false;
  private startedAt: number | undefined;

  /**
   * @param parts.stateDir where runtime state lives. Defaults to .vigyl beside
   *   the daemon log, which is what production wants — one daemon per project
   *   directory. Injectable because it is process-wide otherwise, so two
   *   daemons in one process (only tests do this) would share history.
   */
  constructor(
    config: VigylConfig,
    parts: { supervisor?: Supervisor; executor?: Executor; stateDir?: string } = {},
  ) {
    const stateDir = parts.stateDir ?? path.dirname(LOG_DIR);
    this.config = config;
    this.security = new SecurityLayer(config.workspace_root);
    this.executor = parts.executor ?? new Executor(config);
    this.supervisor = parts.supervisor ?? new Supervisor(config);
    this.selfHeal = new SelfHealingLoop(this.executor, this.supervisor, config);
    this.approvals = new ApprovalStore(config.hitl.timeout_seconds);
    // Under .vigyl/logs, alongside daemon.log, so one directory holds all output.
    this.logs = new CommandLogStore(path.join(stateDir, 'logs', 'commands'));
    // Sibling of logs/, so all runtime state lives under one directory.
    this.commands = new HistoryStore(path.join(stateDir, 'history.json'));
    this.monitor = new HealthMonitor({
      workspaceRoot: this.security.workspaceRoot,
      intervalSeconds: config.monitor.interval_seconds,
      cooldownSeconds: config.monitor.cooldown_seconds,
      thresholds: {
        cpuPercent: config.monitor.cpu_percent,
        memoryPercent: config.monitor.memory_percent,
        diskPercent: config.monitor.disk_percent,
      },
      // Indirection so the bot can register a sender after construction.
      notify: (chatIds, alerts) => this.onHealthAlert?.(chatIds, alerts),
    });
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  async start(): Promise<void> {
    if (this.running) return;

    // Config validated the workspace at load time; it may have moved since.
    if (!fs.existsSync(this.security.workspaceRoot)) {
      throw new Error(`Workspace no longer exists: ${this.security.workspaceRoot}`);
    }

    this.running = true;
    this.startedAt = Date.now();
    if (this.config.monitor.enabled) this.monitor.start();
    logger.info('Vigyl daemon started', {
      version: DAEMON_VERSION,
      workspace: this.security.workspaceRoot,
      model: this.config.anthropic.model,
      selfHeal: this.config.self_heal.enabled,
    });
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.executor.kill();
    // Before anything else: an interval that outlives stop() keeps the libuv
    // loop alive and the process never exits.
    this.monitor.stop();
    const dropped = this.approvals.clear();
    this.sessions.clearAll();
    this.running = false;
    this.startedAt = undefined;
    logger.info('Vigyl daemon stopped', { droppedApprovals: dropped });
  }

  get status(): DaemonStatus {
    return {
      running: this.running,
      busy: this.executor.isRunning,
      version: DAEMON_VERSION,
      workspaceRoot: this.security.workspaceRoot,
      model: this.config.anthropic.model,
      pendingApprovals: this.approvals.size,
      ...(this.startedAt === undefined ? {} : { startedAt: this.startedAt }),
    };
  }

  // -------------------------------------------------------------------------
  // Command pipeline
  // -------------------------------------------------------------------------

  /**
   * parse -> policy check -> (approval gate) -> execute with self-healing.
   *
   * Never throws for an expected condition. Everything a caller needs to react
   * to is encoded in the returned status.
   */
  async handleCommand(
    userMessage: string,
    onProgress: ProgressReporter,
    options: HandleOptions = {},
  ): Promise<CommandResult> {
    if (!this.running) throw new DaemonNotStartedError();

    if (this.executor.isRunning) {
      return { status: 'busy', reason: 'A command is already running. Wait for it to finish.' };
    }

    let parsed: ParsedCommand;
    try {
      onProgress('🧠 Working out what to run...');
      // Context is fetched per chat and never merged across chats: one user's
      // output must not steer the model while parsing another user's message.
      const recentOutput =
        options.owner === undefined ? undefined : this.sessions.recentOutput(options.owner);

      parsed = await this.supervisor.parseCommand(userMessage, {
        workspaceRoot: this.security.workspaceRoot,
        ...(recentOutput === undefined ? {} : { recentOutput }),
      });
    } catch (err) {
      const reason = err instanceof SupervisorError ? err.message : String(err);
      logger.warn('Could not parse command', { reason });
      const failure: CommandResult = { status: 'error', reason };
      this.remember(options.owner, userMessage, failure);
      return failure;
    }

    onProgress(`📋 ${parsed.description}`);

    // Refuse outright before any approval question is asked — there is no
    // point offering to approve something the executor will refuse anyway.
    try {
      this.security.validateCommand(parsed.command);
    } catch (err) {
      const reason = err instanceof SecurityError ? err.message : String(err);
      logger.warn('Command refused by policy', { command: parsed.command, reason });
      const refusal: CommandResult = { status: 'rejected', command: parsed.command, reason };
      this.remember(options.owner, userMessage, refusal);
      return refusal;
    }

    const reasons = approvalReasons(parsed, this.config.hitl.require_for, this.security);
    if (reasons.length > 0) {
      return this.requestApproval(parsed, reasons, options.owner);
    }

    const result = await this.execute(parsed, onProgress);
    this.remember(options.owner, userMessage, result);
    return result;
  }

  private requestApproval(
    parsed: ParsedCommand,
    reasons: string[],
    owner: ApprovalOwner | undefined,
  ): ApprovalRequiredResult {
    const approval = this.approvals.create(parsed, reasons, owner);
    return {
      status: 'approval_required',
      approvalId: approval.id,
      command: parsed.command,
      description: parsed.description,
      isDestructive: parsed.isDestructive,
      expiresAt: approval.expiresAt,
      reasons,
    };
  }

  /**
   * Run a previously approved command.
   *
   * Executes the stored ParsedCommand verbatim — no second trip through the
   * model — so what runs is exactly what the user was shown and agreed to.
   */
  async approve(
    approvalId: string,
    onProgress: ProgressReporter,
    options: HandleOptions = {},
  ): Promise<CommandResult> {
    if (!this.running) throw new DaemonNotStartedError();

    if (this.executor.isRunning) {
      return { status: 'busy', reason: 'A command is already running. Wait for it to finish.' };
    }

    const claim = this.approvals.claim(approvalId, options.owner);
    if (!claim.ok) {
      return { status: 'rejected', reason: explainClaimFailure(claim.failure) };
    }

    const result = await this.execute(claim.approval.parsed, onProgress);
    this.remember(options.owner, claim.approval.parsed.description, result);
    return result;
  }

  /** Discard a pending approval. Returns false if it was already gone. */
  deny(approvalId: string, options: HandleOptions = {}): boolean {
    return this.approvals.deny(approvalId, options.owner);
  }

  /** Inspect a pending approval without consuming it. */
  peekApproval(approvalId: string): ParsedCommand | undefined {
    return this.approvals.peek(approvalId)?.parsed;
  }

  /** This chat's in-memory context turns. Never another chat's. */
  sessionTurns(owner: ChatKey): readonly SessionTurn[] {
    return this.sessions.history(owner);
  }

  /** This chat's durable command history, newest first. Never another chat's. */
  commandHistory(owner: ChatKey, limit = 10): readonly HistoryEntry[] {
    return this.commands.list(owner, limit);
  }

  /** The message /repeat would re-run, or undefined if there is nothing to repeat. */
  repeatable(owner: ChatKey): HistoryEntry | undefined {
    return this.commands.lastRepeatable(owner);
  }

  /**
   * Re-run the last command in this chat.
   *
   * Deliberately re-enters handleCommand with the ORIGINAL user message rather
   * than replaying the stored shell command. That keeps one pipeline: the
   * Supervisor parses it again and the approval gate re-applies, so repeating
   * a production deploy still asks. Replaying the shell string directly would
   * quietly route around both.
   */
  async repeat(
    owner: ChatKey,
    onProgress: ProgressReporter,
    options: HandleOptions = {},
  ): Promise<CommandResult> {
    const entry = this.commands.lastRepeatable(owner);
    if (entry === undefined) {
      return { status: 'rejected', reason: 'Nothing to repeat in this chat yet.' };
    }
    return this.handleCommand(entry.userMessage, onProgress, { ...options, owner });
  }

  /** The last command this chat ran, for "run that again". */
  lastCommand(owner: ChatKey): string | undefined {
    return this.sessions.lastCommand(owner);
  }

  /** Forget one chat's history. */
  forget(owner: ChatKey): boolean {
    const hadHistory = this.commands.clear(owner);
    const hadSession = this.sessions.clear(owner);
    return hadHistory || hadSession;
  }

  /** Register where health alerts should be delivered. */
  onHealthAlerts(
    handler: (chatIds: readonly number[], alerts: readonly HealthAlert[]) => void,
  ): void {
    this.onHealthAlert = handler;
  }

  /** Opt a chat into health alerts. */
  enableMonitoring(chatId: number): boolean {
    return this.monitor.subscribe(chatId);
  }

  /** Opt a chat out of health alerts. */
  disableMonitoring(chatId: number): boolean {
    return this.monitor.unsubscribe(chatId);
  }

  isMonitoring(chatId: number): boolean {
    return this.monitor.isSubscribed(chatId);
  }

  get monitorRunning(): boolean {
    return this.monitor.isRunning;
  }

  /** Current readings, for /monitor status. */
  async healthSnapshot(): Promise<{ metrics: HealthMetrics; alerts: HealthAlert[] }> {
    return this.monitor.snapshot();
  }

  /** Run one health check immediately. Returns the alerts that were sent. */
  async runHealthCheck(): Promise<HealthAlert[]> {
    return this.monitor.runCheck();
  }

  /**
   * Fetch a stored log by id.
   *
   * The id is user input; CommandLogStore validates it before it becomes a
   * path. Returning undefined for both "unknown" and "malformed" is
   * deliberate — an attacker probing ids learns nothing from the difference.
   */
  readLog(commandId: string): StoredLog | undefined {
    return this.logs.read(commandId);
  }

  /** The id of the most recent command in this chat that produced output. */
  lastCommandId(owner: ChatKey): string | undefined {
    const turns = this.sessions.history(owner);
    for (let i = turns.length - 1; i >= 0; i--) {
      const id = turns[i]?.commandId;
      if (id !== undefined) return id;
    }
    return undefined;
  }

  /** Store the outcome so the next message in this chat has context. */
  private remember(owner: ChatKey | undefined, userMessage: string, result: CommandResult): void {
    // No owner means no session. A shared bucket for anonymous callers would
    // be a cross-chat leak waiting to happen.
    if (owner === undefined) return;

    const command = 'command' in result ? result.command : undefined;
    const description = 'description' in result ? result.description : undefined;
    const exitCode = 'exitCode' in result ? result.exitCode : undefined;
    const output = 'output' in result ? result.output : undefined;

    const commandId = 'commandId' in result ? result.commandId : undefined;

    this.commands.record(owner, {
      userMessage,
      status: result.status,
      ...(command === undefined ? {} : { command }),
      ...(exitCode === undefined ? {} : { exitCode }),
      ...(commandId === undefined ? {} : { commandId }),
    });

    this.sessions.record(owner, {
      userMessage,
      status: result.status,
      ...(commandId === undefined ? {} : { commandId }),
      ...(command === undefined ? {} : { command }),
      ...(description === undefined ? {} : { description }),
      ...(exitCode === undefined ? {} : { exitCode }),
      ...(output === undefined ? {} : { outputTail: output }),
    });
  }

  private async execute(parsed: ParsedCommand, onProgress: ProgressReporter): Promise<CommandResult> {
    try {
      const heal = await this.selfHeal.runWithHealing(parsed.command, onProgress);

      const commandId = this.logs.write(heal.output, {
        command: parsed.command,
        exitCode: heal.finalExitCode,
        attempts: heal.attempts,
        at: Date.now(),
      });

      if (heal.success) {
        return {
          status: 'completed',
          ...(commandId === undefined ? {} : { commandId }),
          command: parsed.command,
          description: parsed.description,
          attempts: heal.attempts,
          exitCode: heal.finalExitCode,
          output: heal.output,
          patches: heal.patches,
        };
      }

      return {
        status: 'failed',
        ...(commandId === undefined ? {} : { commandId }),
        command: parsed.command,
        description: parsed.description,
        attempts: heal.attempts,
        exitCode: heal.finalExitCode,
        reason: heal.stoppedBecause,
        ...(heal.errorType === undefined ? {} : { errorType: heal.errorType }),
        ...(heal.message === undefined ? {} : { message: heal.message }),
        output: heal.output,
        patches: heal.patches,
      };
    } catch (err) {
      // A refusal from the executor's own policy check, or a shell that could
      // not be spawned. Neither is a command failure.
      if (err instanceof SecurityError) {
        return { status: 'rejected', command: parsed.command, reason: err.message };
      }
      const reason = err instanceof Error ? err.message : String(err);
      logger.error('Command execution failed unexpectedly', { command: parsed.command, reason });
      return { status: 'error', reason };
    }
  }

}
