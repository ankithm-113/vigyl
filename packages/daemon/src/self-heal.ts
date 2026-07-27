/**
 * The self-healing loop: run -> classify -> patch -> retry.
 *
 * SECURITY. This is the only file in the daemon that writes to disk on the
 * strength of something a language model said, so it is the highest-risk code
 * in the project. Two invariants:
 *
 *   1. Every write goes through applyPatch(), and applyPatch() begins with
 *      SecurityLayer.validatePath(). There is no other fs write in this file.
 *      The build guide instead did
 *          fs.writeFileSync(path.join(workspace_root, patch.filePath), ...)
 *      with no check at all, so a filePath of "../../.ssh/authorized_keys"
 *      wrote successfully. The model does not have to be malicious for that to
 *      happen — it only has to be wrong, and build output (which any
 *      dependency's postinstall script can write to) is part of its prompt.
 *
 *   2. Retries are capped by HARD_MAX_RETRIES regardless of config. A runaway
 *      loop here means repeated LLM spend and repeated overwrites of a real
 *      file, so config can lower the cap but never raise it.
 *
 * Overwritten files are backed up first, so a bad patch is recoverable.
 */
import * as fs from 'fs';
import * as path from 'path';
import { logger } from './logger';
import { Monitor, type ErrorContext, type ErrorType } from './monitor';
import { SecurityError, SecurityLayer } from './security';
import type { Executor } from './executor';
import { SupervisorError } from './supervisor';
import type { Supervisor, UnvalidatedPatch } from './supervisor';
import type { VigylConfig } from './config';

/** Absolute ceiling on retries. Config may lower this; nothing may raise it. */
export const HARD_MAX_RETRIES = 3;

/** Never read more than this into an LLM prompt as "the relevant source". */
const MAX_CODE_CONTEXT_BYTES = 200_000;
/** Lines either side of the reported error line. */
const CODE_CONTEXT_RADIUS = 40;

/**
 * Failure kinds a single-file edit cannot fix.
 *
 * A missing dependency needs an install, a permission error needs the operator,
 * and a network error needs the network. Asking for a patch anyway wastes a
 * call and invites the model to invent an edit to an unrelated file — and a
 * wrong patch overwrites something real.
 */
const NOT_PATCHABLE: ReadonlySet<ErrorType> = new Set<ErrorType>([
  'dependency_missing',
  'permission_error',
  'network_error',
]);

export type StopReason =
  | 'success'
  | 'disabled'
  | 'not_auto_fixable'
  | 'no_patch_offered'
  | 'rate_limited'
  | 'patch_rejected'
  | 'patch_write_failed'
  | 'repeated_failure'
  | 'retries_exhausted';

export interface AppliedPatch {
  /** Path exactly as the model proposed it. */
  proposedPath: string;
  /** Canonical path actually written, after validation. */
  resolvedPath: string;
  explanation: string;
  backupPath: string;
  attempt: number;
}

export interface HealResult {
  success: boolean;
  /** How many times the command was run, including the first. */
  attempts: number;
  finalExitCode: number;
  stoppedBecause: StopReason;
  errorType?: ErrorType;
  /** The last error line, for showing a human. */
  message?: string;
  /** Cleaned output of the final run, for showing a human. */
  output: string;
  patches: AppliedPatch[];
}

export type ProgressReporter = (message: string) => void;

/**
 * Stable identity for a failure, used to notice a patch that changed nothing.
 *
 * Volatile fragments are normalised out first. npm ends every failure with the
 * path to a fresh debug log:
 *
 *   npm error A complete log of this run can be found in:
 *   .../_logs/2026-07-26T20_09_07_255Z-debug-0.log
 *
 * The timestamp differs on every run, so a raw string comparison never matches
 * and the loop happily burns all three retries — and three LLM calls — on an
 * error that has not changed at all. Long digit runs go too (pids, epoch ms),
 * while short ones survive so a TS error code and a line number still
 * distinguish two genuinely different failures.
 */
export function errorSignature(context: ErrorContext): string {
  const normalized = context.message
    .replace(/[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9TZ_:.-]+/g, '<timestamp>')
    .replace(/[0-9]{5,}/g, '<number>');
  return `${context.type}::${normalized}`;
}

export class SelfHealingLoop {
  private readonly executor: Executor;
  private readonly supervisor: Supervisor;
  private readonly security: SecurityLayer;
  private readonly config: VigylConfig;
  private readonly maxRetries: number;

  constructor(executor: Executor, supervisor: Supervisor, config: VigylConfig) {
    this.executor = executor;
    this.supervisor = supervisor;
    this.config = config;
    this.security = new SecurityLayer(config.workspace_root);

    const configured = config.self_heal.max_retries;
    this.maxRetries = Math.max(0, Math.min(configured, HARD_MAX_RETRIES));
    if (configured > HARD_MAX_RETRIES) {
      logger.warn('self_heal.max_retries clamped to the hard limit', {
        configured,
        applied: this.maxRetries,
        hardLimit: HARD_MAX_RETRIES,
      });
    }
  }

  /**
   * Run `command`, and on failure try to fix it and run again.
   *
   * Always resolves. A failure the loop could not fix is a HealResult with
   * success:false and a stoppedBecause explaining why, not an exception —
   * callers (Telegram, the CLI) need to report the reason either way.
   */
  async runWithHealing(command: string, onProgress: ProgressReporter): Promise<HealResult> {
    const patches: AppliedPatch[] = [];
    const seenFailures = new Set<string>();
    const totalRuns = this.maxRetries + 1;

    let attempt = 0;
    let lastExitCode = 1;
    let lastOutput = '';
    let lastContext: ErrorContext | undefined;

    while (attempt < totalRuns) {
      attempt++;
      onProgress(`▶ Running (attempt ${attempt}/${totalRuns}): ${command}`);

      const monitor = new Monitor();
      const onData = (chunk: string): void => monitor.feed(chunk);
      this.executor.on('data', onData);

      let result;
      try {
        result = await this.executor.execute(command);
      } finally {
        this.executor.off('data', onData);
      }

      lastExitCode = result.exitCode;
      lastOutput = result.cleanOutput;

      if (result.exitCode === 0) {
        monitor.onExit(0);
        onProgress('✓ Success — exit code 0');
        return {
          success: true,
          attempts: attempt,
          finalExitCode: 0,
          stoppedBecause: 'success',
          output: result.cleanOutput,
          patches,
        };
      }

      const context = monitor.classify(result.exitCode, this.config.self_heal.context_lines);
      lastContext = context;
      onProgress(
        `✗ Failed (exit ${result.exitCode}) — ${context.type}: ${truncate(context.message, 160)}`,
      );

      if (!this.config.self_heal.enabled) {
        onProgress('⚠ Self-healing is disabled in config.');
        return this.failure(attempt, lastExitCode, 'disabled', context, patches, lastOutput);
      }

      if (attempt >= totalRuns) break;

      if (NOT_PATCHABLE.has(context.type)) {
        onProgress(`⚠ ${context.type} cannot be fixed by editing a file. Stopping.`);
        return this.failure(attempt, lastExitCode, 'not_auto_fixable', context, patches, lastOutput);
      }

      const signature = errorSignature(context);
      if (seenFailures.has(signature)) {
        // The previous patch was applied but changed nothing observable.
        onProgress('⚠ The same failure came back unchanged after a patch. Stopping.');
        return this.failure(attempt, lastExitCode, 'repeated_failure', context, patches, lastOutput);
      }
      seenFailures.add(signature);

      onProgress('🔧 Asking Claude for a fix...');

      const proposal = await this.requestPatch(context);
      if (proposal === 'rate_limited') {
        onProgress('⚠ Anthropic rate limit reached. Stopping so you can retry shortly.');
        return this.failure(attempt, lastExitCode, 'rate_limited', context, patches, lastOutput);
      }
      if (proposal === undefined) {
        onProgress('⚠ No confident fix available. Stopping.');
        return this.failure(attempt, lastExitCode, 'no_patch_offered', context, patches, lastOutput);
      }

      const applied = this.applyPatch(proposal, attempt);
      if (applied === 'rejected') {
        onProgress('⛔ Patch rejected: it targeted a file outside the workspace.');
        return this.failure(attempt, lastExitCode, 'patch_rejected', context, patches, lastOutput);
      }
      if (applied === 'failed') {
        onProgress('✗ Could not write the patch. Stopping.');
        return this.failure(attempt, lastExitCode, 'patch_write_failed', context, patches, lastOutput);
      }

      patches.push(applied);
      onProgress(`✍ Patched ${applied.proposedPath}: ${applied.explanation}`);
    }

    onProgress(`⚠ Still failing after ${attempt} attempt(s). Manual intervention needed.`);
    return this.failure(attempt, lastExitCode, 'retries_exhausted', lastContext, patches, lastOutput);
  }

  private failure(
    attempts: number,
    finalExitCode: number,
    stoppedBecause: StopReason,
    context: ErrorContext | undefined,
    patches: AppliedPatch[],
    output: string,
  ): HealResult {
    return {
      success: false,
      attempts,
      finalExitCode,
      stoppedBecause,
      ...(context === undefined ? {} : { errorType: context.type, message: context.message }),
      output,
      patches,
    };
  }

  /** Ask the Supervisor for a patch, with the relevant source attached. */
  private async requestPatch(
    context: ErrorContext,
  ): Promise<UnvalidatedPatch | undefined | 'rate_limited'> {
    const errorText = context.rawLines.slice(-this.config.self_heal.context_lines).join('\n');
    const codeContext = this.gatherCodeContext(context);

    try {
      return await this.supervisor.generatePatch(errorText, codeContext, this.config.workspace_root);
    } catch (err) {
      logger.warn('Patch generation failed', {
        reason: err instanceof Error ? err.message : String(err),
        kind: err instanceof SupervisorError ? err.kind : 'unknown',
      });
      // Distinguished because "we were rate limited" and "Claude had no fix"
      // call for completely different responses from the user.
      if (err instanceof SupervisorError && err.kind === 'rate_limit') return 'rate_limited';
      return undefined;
    }
  }

  /**
   * Read the source the error points at.
   *
   * Goes through validatePath like everything else: the file path here comes
   * from parsing command output, which is not trustworthy input either. The
   * build guide compared with `filePath.startsWith(workspaceRoot)`, the same
   * prefix bug as its sandbox, so a path could be read from outside the
   * workspace and then handed to the model.
   */
  private gatherCodeContext(context: ErrorContext): string {
    if (context.file === undefined) return 'No file context available.';

    let resolved: string;
    try {
      resolved = this.security.validatePath(context.file, {
        mustExist: true,
        label: 'error location',
      });
    } catch (err) {
      logger.warn('Refusing to read error location outside the workspace', {
        file: context.file,
        reason: err instanceof Error ? err.message : String(err),
      });
      return 'No file context available (the reported path is outside the workspace).';
    }

    let contents: string;
    try {
      const stat = fs.statSync(resolved);
      if (!stat.isFile()) return 'No file context available (not a regular file).';
      if (stat.size > MAX_CODE_CONTEXT_BYTES) {
        return `File ${context.file} is too large to include (${stat.size} bytes).`;
      }
      contents = fs.readFileSync(resolved, 'utf-8');
    } catch (err) {
      logger.debug('Could not read error location', {
        resolved,
        reason: err instanceof Error ? err.message : String(err),
      });
      return 'No file context available (unreadable).';
    }

    const lines = contents.split('\n');
    if (context.line === undefined) {
      return `File: ${context.file}\n${contents}`;
    }

    const start = Math.max(0, context.line - 1 - CODE_CONTEXT_RADIUS);
    const end = Math.min(lines.length, context.line + CODE_CONTEXT_RADIUS);
    const excerpt = lines.slice(start, end).join('\n');
    return (
      `File: ${context.file} (showing lines ${start + 1}-${end} of ${lines.length}; ` +
      `the error is on line ${context.line})\n${excerpt}`
    );
  }

  /**
   * The ONLY filesystem write in this file.
   *
   * Order matters and is not negotiable: validate the path, back the file up,
   * then write. Returns 'rejected' when the path fails validation — that case
   * is logged at warn level with the attempted path, because it is either a
   * confused model or an injection attempt and both are worth seeing.
   */
  private applyPatch(patch: UnvalidatedPatch, attempt: number): AppliedPatch | 'rejected' | 'failed' {
    let resolved: string;
    try {
      // mustExist: a self-healing edit repairs a file that is already there.
      // Letting the model create new files is a strictly larger capability
      // than letting it edit known ones, and nothing about fixing a build
      // error requires it.
      resolved = this.security.validatePath(patch.filePath, {
        mustExist: true,
        label: 'patch target',
      });
    } catch (err) {
      if (err instanceof SecurityError) {
        logger.warn('PATCH REJECTED — target outside the workspace', {
          proposedPath: patch.filePath,
          workspace: this.config.workspace_root,
          explanation: patch.explanation,
          attempt,
          reason: err.message,
        });
      } else {
        logger.warn('PATCH REJECTED — target could not be validated', {
          proposedPath: patch.filePath,
          attempt,
          reason: err instanceof Error ? err.message : String(err),
        });
      }
      return 'rejected';
    }

    try {
      if (!fs.statSync(resolved).isFile()) {
        logger.warn('PATCH REJECTED — target is not a regular file', { resolved });
        return 'rejected';
      }

      const backupPath = this.backUp(resolved);

      // Write to a sibling temp file and rename, so a crash mid-write cannot
      // leave the real file truncated.
      const tempPath = `${resolved}.vigyl-tmp`;
      fs.writeFileSync(tempPath, patch.contents, 'utf-8');
      fs.renameSync(tempPath, resolved);

      logger.info('Patch applied', {
        resolved,
        backupPath,
        attempt,
        explanation: patch.explanation,
        bytes: patch.contents.length,
      });

      return {
        proposedPath: patch.filePath,
        resolvedPath: resolved,
        explanation: patch.explanation,
        backupPath,
        attempt,
      };
    } catch (err) {
      logger.error('Failed to write patch', {
        resolved,
        reason: err instanceof Error ? err.message : String(err),
      });
      return 'failed';
    }
  }

  /** Copy the file into .vigyl/backups before it is overwritten. */
  private backUp(resolved: string): string {
    const backupDir = path.join(this.security.workspaceRoot, '.vigyl', 'backups');
    fs.mkdirSync(backupDir, { recursive: true });

    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupPath = path.join(backupDir, `${path.basename(resolved)}.${stamp}.bak`);
    fs.copyFileSync(resolved, backupPath);
    return backupPath;
  }
}

function truncate(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;
}
