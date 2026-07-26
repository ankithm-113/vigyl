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
import { randomUUID } from 'crypto';
import { Executor } from './executor';
import { logger } from './logger';
import { SecurityError, SecurityLayer } from './security';
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
  command: string;
  description: string;
  attempts: number;
  exitCode: number;
  output: string;
  patches: AppliedPatch[];
}

export interface FailedResult {
  status: 'failed';
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

interface PendingApproval {
  id: string;
  parsed: ParsedCommand;
  requestedAt: number;
  expiresAt: number;
  /** Optional caller-scoping, e.g. a Telegram chat id. */
  owner?: string | number;
}

export interface HandleOptions {
  /** Scopes the approval so one chat cannot approve another chat's command. */
  owner?: string | number;
}

export class DaemonNotStartedError extends Error {
  constructor() {
    super('Daemon has not been started. Call start() first.');
    this.name = 'DaemonNotStartedError';
  }
}

export class VigylDaemon {
  private readonly config: VigylConfig;
  private readonly security: SecurityLayer;
  private readonly executor: Executor;
  private readonly supervisor: Supervisor;
  private readonly selfHeal: SelfHealingLoop;
  private readonly pending = new Map<string, PendingApproval>();

  private running = false;
  private startedAt: number | undefined;

  constructor(config: VigylConfig, parts: { supervisor?: Supervisor; executor?: Executor } = {}) {
    this.config = config;
    this.security = new SecurityLayer(config.workspace_root);
    this.executor = parts.executor ?? new Executor(config);
    this.supervisor = parts.supervisor ?? new Supervisor(config);
    this.selfHeal = new SelfHealingLoop(this.executor, this.supervisor, config);
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
    const dropped = this.pending.size;
    this.pending.clear();
    this.running = false;
    this.startedAt = undefined;
    logger.info('Vigyl daemon stopped', { droppedApprovals: dropped });
  }

  get status(): DaemonStatus {
    this.expireStaleApprovals();
    return {
      running: this.running,
      busy: this.executor.isRunning,
      version: DAEMON_VERSION,
      workspaceRoot: this.security.workspaceRoot,
      model: this.config.anthropic.model,
      pendingApprovals: this.pending.size,
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
      parsed = await this.supervisor.parseCommand(userMessage, {
        workspaceRoot: this.security.workspaceRoot,
      });
    } catch (err) {
      const reason = err instanceof SupervisorError ? err.message : String(err);
      logger.warn('Could not parse command', { reason });
      return { status: 'error', reason };
    }

    onProgress(`📋 ${parsed.description}`);

    // Refuse outright before any approval question is asked — there is no
    // point offering to approve something the executor will refuse anyway.
    try {
      this.security.validateCommand(parsed.command);
    } catch (err) {
      const reason = err instanceof SecurityError ? err.message : String(err);
      logger.warn('Command refused by policy', { command: parsed.command, reason });
      return { status: 'rejected', command: parsed.command, reason };
    }

    const reasons = this.approvalReasons(parsed);
    if (reasons.length > 0) {
      return this.requestApproval(parsed, reasons, options.owner);
    }

    return this.execute(parsed, onProgress);
  }

  /**
   * Why this command needs a human.
   *
   * Two independent sources. The model sets requiresApproval, but the model is
   * also the thing being steered by a natural-language message, so a keyword
   * check runs alongside it against the operator's own configured triggers.
   * Either one is enough.
   */
  private approvalReasons(parsed: ParsedCommand): string[] {
    const reasons: string[] = [];
    if (parsed.requiresApproval) reasons.push('Claude flagged this as needing approval');
    if (parsed.isDestructive) reasons.push('the action is destructive');

    const triggers = this.config.hitl.require_for;
    const matched = triggers.filter((trigger) =>
      this.security.requiresApproval(`${parsed.command} ${parsed.action} ${parsed.target}`, [trigger]),
    );
    for (const trigger of matched) {
      reasons.push(`it matches the "${trigger}" approval rule`);
    }
    return reasons;
  }

  private requestApproval(
    parsed: ParsedCommand,
    reasons: string[],
    owner: string | number | undefined,
  ): ApprovalRequiredResult {
    this.expireStaleApprovals();

    const id = randomUUID();
    const now = Date.now();
    const expiresAt = now + this.config.hitl.timeout_seconds * 1000;

    this.pending.set(id, {
      id,
      parsed,
      requestedAt: now,
      expiresAt,
      ...(owner === undefined ? {} : { owner }),
    });

    logger.info('Approval requested', {
      approvalId: id,
      command: parsed.command,
      reasons,
      expiresAt: new Date(expiresAt).toISOString(),
    });

    return {
      status: 'approval_required',
      approvalId: id,
      command: parsed.command,
      description: parsed.description,
      isDestructive: parsed.isDestructive,
      expiresAt,
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
    this.expireStaleApprovals();

    const entry = this.pending.get(approvalId);
    if (entry === undefined) {
      return {
        status: 'rejected',
        reason: 'That approval is no longer valid — it expired or was already handled.',
      };
    }
    if (entry.owner !== undefined && options.owner !== undefined && entry.owner !== options.owner) {
      logger.warn('Approval attempted by a different owner', {
        approvalId,
        expected: entry.owner,
        got: options.owner,
      });
      return { status: 'rejected', reason: 'That approval belongs to someone else.' };
    }
    if (this.executor.isRunning) {
      return { status: 'busy', reason: 'A command is already running. Wait for it to finish.' };
    }

    this.pending.delete(approvalId);
    logger.info('Approval granted', { approvalId, command: entry.parsed.command });
    return this.execute(entry.parsed, onProgress);
  }

  /** Discard a pending approval. Returns false if it was already gone. */
  deny(approvalId: string, options: HandleOptions = {}): boolean {
    const entry = this.pending.get(approvalId);
    if (entry === undefined) return false;
    if (entry.owner !== undefined && options.owner !== undefined && entry.owner !== options.owner) {
      return false;
    }
    this.pending.delete(approvalId);
    logger.info('Approval denied', { approvalId, command: entry.parsed.command });
    return true;
  }

  /** Inspect a pending approval without consuming it. */
  peekApproval(approvalId: string): ParsedCommand | undefined {
    this.expireStaleApprovals();
    return this.pending.get(approvalId)?.parsed;
  }

  private async execute(parsed: ParsedCommand, onProgress: ProgressReporter): Promise<CommandResult> {
    try {
      const heal = await this.selfHeal.runWithHealing(parsed.command, onProgress);

      if (heal.success) {
        return {
          status: 'completed',
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

  private expireStaleApprovals(): void {
    const now = Date.now();
    for (const [id, entry] of this.pending) {
      if (entry.expiresAt <= now) {
        this.pending.delete(id);
        logger.info('Approval expired', { approvalId: id, command: entry.parsed.command });
      }
    }
  }
}
