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
/** A single file larger than this is not shown, and so cannot be patched. */
const MAX_FILE_BYTES = 60_000;
/** How many locally imported files to show alongside the error location. */
const MAX_RELATED_FILES = 5;
/**
 * How many import hops to follow from the error location. A failing test
 * usually sits two hops from the bug (test -> module -> helper); the live
 * cart scenario had the bug at exactly that depth.
 */
const MAX_IMPORT_DEPTH = 3;

// Built from char codes: backslash escapes do not survive saving in this repo.
const NL = String.fromCharCode(10);
const CR = String.fromCharCode(13);
const BS = String.fromCharCode(92);

/**
 * Relative module specifiers in require(), import ... from, and import().
 * Only ./ and ../ paths: packages live in node_modules and are never patched.
 */
const LOCAL_IMPORT = new RegExp(
  '(?:require' + BS + '(' + BS + 's*|from' + BS + 's+|import' + BS + 's*' + BS + '(' + BS +
    's*|import' + BS + 's+)([' + "'" + '"])([.]{1,2}/[^' + "'" + '"]+)' + BS + '1',
  'g',
);
const RESOLVE_SUFFIXES = ['', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '/index.ts', '/index.js'];

/**
 * The source handed to the model, plus the exact set of files it was shown.
 *
 * Patches replace a file wholesale, so the model may only patch a file it saw
 * in full. Handing it a 40-line excerpt and accepting "the complete file" back
 * would silently delete every line it never saw.
 */
export interface CodeContext {
  text: string;
  /** Canonical paths of every file included in full. */
  shown: ReadonlySet<string>;
}

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
 * Built from the headline message AND the tail of the output. The message
 * alone was not enough: an assertion keeps its message ("total should be
 * 110") while its actual value moves (1100 -> 110.00000000000001), so a patch
 * that made real progress looked like no progress and the loop quit. The
 * detail lines that carry "actual"/"expected" values now count too.
 *
 * Volatile fragments are normalised out first, or every run would look new
 * and the loop would burn all its retries on one unchanged error. npm ends
 * every failure with a path to a fresh, timestamped debug log; test runners
 * print durations; stacks carry pids and epoch millis. Short numbers survive,
 * so a TS error code, a line number or an assertion value still count.
 */
export function errorSignature(context: ErrorContext): string {
  const normalise = (text: string): string =>
    text
      .replace(/[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9TZ_:.-]+/g, '<timestamp>')
      .replace(/[0-9]+(?:[.][0-9]+)? ?(?:ms|s)[)]?$/g, '<duration>')
      .replace(/[0-9]{5,}/g, '<number>')
      .trim();
  const detail = context.rawLines
    .slice(-SIGNATURE_TAIL_LINES)
    .map(normalise)
    .filter((line) => line !== '' && !line.includes('<timestamp>'))
    .join('|');
  return `${context.type}::${normalise(context.message)}::${detail}`;
}

/** Output lines, from the end, that contribute to a failure's identity. */
const SIGNATURE_TAIL_LINES = 30;

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

      onProgress('🔧 Asking the model for a fix...');

      const code = this.gatherCodeContext(context);
      const proposal = await this.requestPatch(context, code);
      if (proposal === 'rate_limited') {
        onProgress('⚠ LLM rate limit reached. Stopping so you can retry shortly.');
        return this.failure(attempt, lastExitCode, 'rate_limited', context, patches, lastOutput);
      }
      if (proposal === undefined) {
        onProgress('⚠ No confident fix available. Stopping.');
        return this.failure(attempt, lastExitCode, 'no_patch_offered', context, patches, lastOutput);
      }

      const applied = this.applyPatch(proposal, attempt, code.shown);
      if (applied === 'rejected') {
        onProgress('⛔ Patch rejected: it targeted a file outside the workspace.');
        return this.failure(attempt, lastExitCode, 'patch_rejected', context, patches, lastOutput);
      }
      if (applied === 'unseen') {
        onProgress('⛔ Patch rejected: it targeted a file the model was not shown in full.');
        return this.failure(attempt, lastExitCode, 'patch_rejected', context, patches, lastOutput);
      }
      if (applied === 'unchanged') {
        onProgress('⚠ The proposed fix did not change the file. Stopping.');
        return this.failure(attempt, lastExitCode, 'no_patch_offered', context, patches, lastOutput);
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
    code: CodeContext,
  ): Promise<UnvalidatedPatch | undefined | 'rate_limited'> {
    const errorText = context.rawLines.slice(-this.config.self_heal.context_lines).join('\n');

    try {
      return await this.supervisor.generatePatch(errorText, code.text, this.config.workspace_root);
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
   * Read the source the error points at, plus the local files it imports.
   *
   * The error location is where a failure was DETECTED, which is often not
   * where the bug is: a failing assertion throws in the test file, while the
   * bug lives in the module under test. Showing only the throwing file left
   * the model nothing to fix but the test itself (seen in the first live run).
   *
   * Every path goes through validatePath like everything else: the file path
   * comes from parsing command output, and an import specifier is file
   * content, so neither is a trustworthy path.
   */
  private gatherCodeContext(context: ErrorContext): CodeContext {
    const shown = new Set<string>();
    if (context.file === undefined) return { text: 'No file context available.', shown };

    const primary = this.readForContext(context.file, 'error location');
    if (typeof primary === 'string') return { text: primary, shown };

    shown.add(primary.resolved);
    let budget = MAX_CODE_CONTEXT_BYTES - primary.contents.length;
    const where = context.line === undefined ? '' : `, error reported on line ${context.line}`;
    const sections = [
      `File: ${this.display(primary.resolved)} (where the error was detected${where})` + NL + primary.contents,
    ];

    // Breadth-first, so nearer imports win the file and byte budgets.
    const queue: Array<{ resolved: string; contents: string; depth: number }> = [
      { resolved: primary.resolved, contents: primary.contents, depth: 0 },
    ];
    for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
      if (next.depth >= MAX_IMPORT_DEPTH) continue;
      for (const related of this.localImports(next.resolved, next.contents)) {
        if (shown.size > MAX_RELATED_FILES) break;
        if (shown.has(related)) continue;
        const file = this.readForContext(related, 'imported file');
        if (typeof file === 'string' || file.contents.length > budget) continue;
        budget -= file.contents.length;
        shown.add(file.resolved);
        sections.push(
          `File: ${this.display(file.resolved)} (imported by ${this.display(next.resolved)})` + NL + file.contents,
        );
        queue.push({ ...file, depth: next.depth + 1 });
      }
    }

    return { text: sections.join(NL + NL), shown };
  }

  /** Validate and read one whole file, or explain why not. */
  private readForContext(
    filePath: string,
    label: string,
  ): { resolved: string; contents: string } | string {
    let resolved: string;
    try {
      resolved = this.security.validatePath(filePath, { mustExist: true, label });
    } catch (err) {
      logger.warn('Refusing to read a file outside the workspace', {
        file: filePath,
        label,
        reason: err instanceof Error ? err.message : String(err),
      });
      return 'No file context available (the reported path is outside the workspace).';
    }

    try {
      const stat = fs.statSync(resolved);
      if (!stat.isFile()) return 'No file context available (not a regular file).';
      if (stat.size > MAX_FILE_BYTES) {
        // Too big to show in full, so too big to patch safely.
        return `File ${filePath} is too large to include (${stat.size} bytes).`;
      }
      return { resolved, contents: fs.readFileSync(resolved, 'utf-8') };
    } catch (err) {
      logger.debug('Could not read file for context', {
        resolved,
        reason: err instanceof Error ? err.message : String(err),
      });
      return 'No file context available (unreadable).';
    }
  }

  /** Absolute paths of local modules imported by `contents`, in source order. */
  private localImports(fromFile: string, contents: string): string[] {
    const found: string[] = [];
    for (const match of contents.matchAll(LOCAL_IMPORT)) {
      const specifier = match[2];
      if (specifier === undefined) continue;
      const base = path.resolve(path.dirname(fromFile), specifier);
      const hit = RESOLVE_SUFFIXES.map((suffix) => base + suffix).find((candidate) => {
        try {
          return fs.statSync(candidate).isFile();
        } catch {
          return false;
        }
      });
      if (hit !== undefined && !found.includes(hit)) found.push(hit);
    }
    return found;
  }

  /** Workspace-relative with forward slashes: what the model echoes back as filePath. */
  private display(resolved: string): string {
    return path.relative(this.security.workspaceRoot, resolved).split(path.sep).join('/');
  }

  /**
   * The ONLY filesystem write in this file.
   *
   * Order matters and is not negotiable: validate the path, back the file up,
   * then write. Returns 'rejected' when the path fails validation — that case
   * is logged at warn level with the attempted path, because it is either a
   * confused model or an injection attempt and both are worth seeing.
   */
  private applyPatch(
    patch: UnvalidatedPatch,
    attempt: number,
    shown: ReadonlySet<string>,
  ): AppliedPatch | 'rejected' | 'unseen' | 'unchanged' | 'failed' {
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

      // A wholesale replacement of a file the model saw only in part, or not
      // at all, would delete whatever it did not see.
      if (!shown.has(resolved)) {
        logger.warn('PATCH REJECTED — target was not shown to the model in full', {
          proposedPath: patch.filePath,
          attempt,
        });
        return 'unseen';
      }

      const normalise = (text: string): string => text.split(CR).join('').trimEnd();
      if (normalise(fs.readFileSync(resolved, 'utf-8')) === normalise(patch.contents)) {
        logger.warn('Patch changes nothing; not writing it', { proposedPath: patch.filePath, attempt });
        return 'unchanged';
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
