/**
 * The sandbox.
 *
 * TRUST MODEL — read this before changing anything here.
 *
 * There are two very different mechanisms in this file, and conflating them is
 * how sandboxes get broken:
 *
 *   1. validatePath() is a REAL boundary. Every filesystem path the daemon or
 *      the LLM produces goes through it, and it is enforced by canonicalizing
 *      the path (symlinks resolved, casing normalized) and checking containment
 *      with path.relative — never a string prefix.
 *
 *   2. validateCommand() is NOT a boundary. It is a speed bump. We hand command
 *      strings to a real shell, so any blocklist can be defeated by quoting,
 *      base64, variable indirection, or a script file. It exists to catch
 *      accidents and naive LLM output, and it must never be described as the
 *      thing that keeps a hostile command from running.
 *
 * What actually contains a hostile command is: the process cwd is pinned inside
 * workspace_root, the daemon should run as a non-root user with no sudo rights,
 * and anything destructive goes through the human-in-the-loop gate (Day 8).
 */
import * as fs from 'fs';
import * as path from 'path';
import { logger } from './logger';

export class SecurityError extends Error {
  public readonly attempted: string;

  constructor(message: string, attempted: string) {
    super(message);
    this.name = 'SecurityError';
    this.attempted = attempted;
  }
}

/**
 * Command patterns that are almost always a mistake. See the trust-model note
 * above: this is a typo-and-hallucination filter, not a security control.
 */
const BLOCKED_COMMAND_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [/(?:^|[;&|(`\s])sudo\s/i, 'runs sudo'],
  [/(?:^|[;&|(`\s])doas\s/i, 'runs doas'],
  [/(?:^|[;&|(`\s])su\s+(?:-|\w)/i, 'switches user with su'],
  [/rm\s+(?:-[a-z]*\s+)*-?[a-z]*[rf][a-z]*\s+\/(?:\s|$)/i, 'deletes from the filesystem root'],
  [/rm\s+(?:-{1,2}[\w-]+\s+)*(?:~|\$HOME)(?:\/\s*)?(?:\s|$)/i, 'deletes the home directory'],
  [/>\s*\/(?:etc|usr|bin|sbin|boot|sys|proc)\//i, 'writes into a system directory'],
  [/\b(?:curl|wget)\b[^|;]*\|\s*(?:sudo\s+)?(?:ba|z|k|fi)?sh\b/i, 'pipes a download into a shell'],
  [/\bdd\b[^;|]*\bof=\/dev\/(?:sd|nvme|hd|disk)/i, 'writes directly to a block device'],
  [/\bmkfs(?:\.\w+)?\b/i, 'formats a filesystem'],
  [/\b(?:shutdown|reboot|halt|poweroff)\b/i, 'shuts the machine down'],
  [/:\s*\(\s*\)\s*\{.*\|.*&.*\}\s*;?\s*:/, 'is a fork bomb'],
  [/\bchmod\s+(?:-[a-zA-Z]+\s+)*[0-7]{0,3}7\s/i, 'makes files world-writable'],
  // Windows equivalents
  [/\bformat\s+[a-z]:/i, 'formats a drive'],
  [/\b(?:del|erase)\b[^;]*\/[sq]\b[^;]*[a-z]:\\?(?:\s|$)/i, 'recursively deletes a drive'],
  [/\brd\s+\/s\b[^;]*[a-z]:\\?(?:\s|$)/i, 'recursively removes a drive'],
  [/Remove-Item[^;]*-Recurse[^;]*(?:-Force[^;]*)?[a-z]:\\(?:\s|$)/i, 'recursively deletes a drive'],
  [/\b(?:vssadmin|wbadmin)\b[^;]*\bdelete\b/i, 'deletes system backups'],
  // The guide lists eval() as a blocked pattern; a model proposing eval( in a
  // shell command is a hallucination worth stopping, not a shortcut. Built via
  // new RegExp: literal escapes do not survive saving in this repo.
  [new RegExp('(?:^|[^A-Za-z0-9_$])eval[ ]*[(]', 'i'), 'calls eval()'],
];

/**
 * Basenames that open a device rather than a file on Windows. The superscript
 * digits are not a typo — Win32 treats COM¹/COM²/COM³ as reserved too.
 */
const WINDOWS_RESERVED_NAMES = /^(?:CON|PRN|AUX|NUL|(?:COM|LPT)[1-9²³¹])(?:\..*)?$/i;

export interface ValidatePathOptions {
  /** Reject the path if it does not already exist. Default false (creates are allowed). */
  mustExist?: boolean;
  /** Label used in the error message, e.g. "patch target". */
  label?: string;
}

/**
 * Canonicalize a path, tolerating components that do not exist yet.
 *
 * fs.realpathSync throws ENOENT on a path whose leaf is missing, but the daemon
 * legitimately needs to validate destinations before creating them. So: resolve
 * the deepest ancestor that does exist (which is where any symlink trickery must
 * live) and re-attach the non-existent tail. Because path.resolve has already
 * collapsed "." and "..", the tail cannot contain traversal segments.
 */
function canonicalize(input: string): string {
  const absolute = path.resolve(input);
  const tail: string[] = [];
  let cursor = absolute;

  for (;;) {
    try {
      const real = fs.realpathSync.native(cursor);
      return tail.length === 0 ? real : path.join(real, ...tail);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') throw err;

      const parent = path.dirname(cursor);
      if (parent === cursor) return absolute; // reached the filesystem root
      tail.unshift(path.basename(cursor));
      cursor = parent;
    }
  }
}

/**
 * True when `candidate` is `root` itself or lives beneath it.
 *
 * This is the check the build guide got wrong. `startsWith` treats
 * /home/u/proj-evil as inside /home/u/proj because the string matches;
 * path.relative returns "../proj-evil", which fails on the ".." test.
 * Both paths must already be canonical for this to mean anything.
 */
export function isContained(root: string, candidate: string): boolean {
  if (candidate === root) return true;
  const rel = path.relative(root, candidate);
  if (rel === '') return true;
  if (path.isAbsolute(rel)) return false; // different drive on Windows
  return !rel.split(path.sep).includes('..');
}

export class SecurityLayer {
  /** Canonical, symlink-resolved workspace root. */
  public readonly workspaceRoot: string;

  constructor(workspaceRoot: string) {
    // config.ts already canonicalizes this, but SecurityLayer is constructible
    // on its own (and in tests), so never assume that.
    this.workspaceRoot = canonicalize(workspaceRoot);
  }

  /**
   * Resolve `targetPath` (absolute, or relative to the workspace root) and
   * guarantee the result is inside the workspace. Returns the canonical path.
   */
  validatePath(targetPath: string, options: ValidatePathOptions = {}): string {
    const label = options.label ?? 'path';

    if (typeof targetPath !== 'string' || targetPath.length === 0) {
      throw new SecurityError(`Access denied: ${label} is empty.`, String(targetPath));
    }
    if (targetPath.includes('\0')) {
      // A NUL byte truncates the path in the underlying syscall — classic bypass.
      throw new SecurityError(`Access denied: ${label} contains a NUL byte.`, targetPath);
    }

    const resolved = path.resolve(this.workspaceRoot, targetPath);
    const canonical = canonicalize(resolved);

    if (!isContained(this.workspaceRoot, canonical)) {
      logger.warn('PATH TRAVERSAL BLOCKED', {
        attempted: targetPath,
        resolved: canonical,
        workspace: this.workspaceRoot,
      });
      throw new SecurityError(
        `Access denied: ${label} "${targetPath}" resolves outside the workspace.\n` +
          `  resolved to: ${canonical}\n` +
          `  workspace:   ${this.workspaceRoot}`,
        targetPath,
      );
    }

    if (process.platform === 'win32') {
      for (const segment of path.relative(this.workspaceRoot, canonical).split(path.sep)) {
        if (segment !== '' && WINDOWS_RESERVED_NAMES.test(segment)) {
          throw new SecurityError(
            `Access denied: "${segment}" is a reserved Windows device name.`,
            targetPath,
          );
        }
      }
    }

    if (options.mustExist === true && !fs.existsSync(canonical)) {
      throw new SecurityError(`Access denied: ${label} does not exist: ${canonical}`, targetPath);
    }

    return canonical;
  }

  /** Non-throwing form of validatePath, for callers that want to branch. */
  isInsideWorkspace(targetPath: string): boolean {
    try {
      this.validatePath(targetPath);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Reject obviously destructive commands. A speed bump, not a boundary —
   * see the trust-model note at the top of this file.
   */
  validateCommand(command: string): void {
    if (typeof command !== 'string' || command.trim() === '') {
      throw new SecurityError('Command blocked: empty command.', String(command));
    }
    if (command.includes('\0')) {
      throw new SecurityError('Command blocked: contains a NUL byte.', command);
    }

    for (const [pattern, description] of BLOCKED_COMMAND_PATTERNS) {
      if (pattern.test(command)) {
        logger.warn('DESTRUCTIVE COMMAND BLOCKED', { command, reason: description });
        throw new SecurityError(
          `Command blocked by security policy: it ${description}.\n` +
            `  ${command}\n` +
            `If this is genuinely what you want, run it yourself on the server.`,
          command,
        );
      }
    }
  }

  /** Same checks, as a predicate. */
  isCommandAllowed(command: string): boolean {
    try {
      this.validateCommand(command);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Does this command or action need human approval? Consulted by the HITL gate
   * (Day 8) alongside the Supervisor's own judgement — the LLM can be talked out
   * of setting requiresApproval, so this keyword check runs independently.
   */
  requiresApproval(subject: string, triggers: readonly string[]): boolean {
    const haystack = subject.toLowerCase();
    return triggers.some((trigger) => {
      const needle = trigger.toLowerCase().trim();
      return needle !== '' && haystack.includes(needle);
    });
  }
}
