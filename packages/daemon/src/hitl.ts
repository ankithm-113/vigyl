/**
 * Human-in-the-loop gate.
 *
 * Holds commands that need a person to say yes, and decides which ones those
 * are. Kept separate from daemon.ts because the policy question ("does this
 * need approval, and why?") and the storage question ("is this token still
 * valid, and is it yours?") are both things you want to reason about on their
 * own — and both are security-relevant.
 *
 * Design notes:
 *
 *   - The stored ParsedCommand is executed verbatim on approval. The build
 *     guide re-sent `originalMessage + ' --approved'` through the model, which
 *     asks it to parse a string no human wrote and trusts it to spot a magic
 *     suffix. Storing the command means what runs is exactly what the user was
 *     shown and agreed to.
 *   - Approval is required if EITHER the model flags it OR the operator's own
 *     keyword rules match. The model is being steered by the very message it
 *     is parsing, so it cannot be the only vote.
 *   - Tokens are single-use and time-boxed, and carry an owner, so one chat
 *     cannot approve another chat's command.
 */
import { randomUUID } from 'crypto';
import { logger } from './logger';
import type { SecurityLayer } from './security';
import type { ParsedCommand } from './supervisor';

/** Who requested an approval — a Telegram chat id, in practice. */
export type ApprovalOwner = string | number;

export interface PendingApproval {
  id: string;
  parsed: ParsedCommand;
  reasons: string[];
  requestedAt: number;
  expiresAt: number;
  owner?: ApprovalOwner;
}

export type ClaimFailure = 'unknown' | 'expired' | 'wrong_owner';

export type ClaimResult =
  | { ok: true; approval: PendingApproval }
  | { ok: false; failure: ClaimFailure };

/**
 * Decide whether a command needs a human, and say why.
 *
 * The reasons are shown to the user, so they are phrased for reading rather
 * than for logs.
 */
export function approvalReasons(
  parsed: ParsedCommand,
  triggers: readonly string[],
  security: SecurityLayer,
): string[] {
  const reasons: string[] = [];

  if (parsed.requiresApproval) reasons.push('the model flagged this as needing approval');
  if (parsed.isDestructive) reasons.push('the action is destructive');

  // Independent of the model's own judgement: it can be talked out of setting
  // requiresApproval by the message it is parsing, so the operator's rules
  // get their own vote against the command text.
  const subject = `${parsed.command} ${parsed.action} ${parsed.target}`;
  for (const trigger of triggers) {
    if (security.requiresApproval(subject, [trigger])) {
      reasons.push(`it matches the "${trigger}" approval rule`);
    }
  }

  return reasons;
}

/** Time-boxed, single-use, owner-scoped store of commands awaiting a yes. */
export class ApprovalStore {
  private readonly pending = new Map<string, PendingApproval>();
  private readonly timeoutMs: number;

  constructor(timeoutSeconds: number) {
    this.timeoutMs = Math.max(0, timeoutSeconds) * 1000;
  }

  get size(): number {
    this.expire();
    return this.pending.size;
  }

  create(parsed: ParsedCommand, reasons: string[], owner?: ApprovalOwner): PendingApproval {
    this.expire();

    const now = Date.now();
    const approval: PendingApproval = {
      id: randomUUID(),
      parsed,
      reasons,
      requestedAt: now,
      expiresAt: now + this.timeoutMs,
      ...(owner === undefined ? {} : { owner }),
    };

    this.pending.set(approval.id, approval);
    logger.info('Approval requested', {
      approvalId: approval.id,
      command: parsed.command,
      reasons,
      expiresAt: new Date(approval.expiresAt).toISOString(),
    });
    return approval;
  }

  /**
   * Take the approval out of the store, if the caller may have it.
   *
   * Removal is part of claiming: an approval token that survives its use can
   * be replayed to run a destructive command a second time.
   */
  claim(id: string, owner?: ApprovalOwner): ClaimResult {
    // Look this id up BEFORE sweeping expired entries. Sweeping first would
    // delete it and report 'unknown', so the user gets "expired or already
    // handled" and cannot tell whether their deploy ran. Checking its own
    // deadline first is what makes 'expired' reachable at all.
    const approval = this.pending.get(id);
    if (approval === undefined) {
      this.expire();
      return { ok: false, failure: 'unknown' };
    }

    if (approval.expiresAt <= Date.now()) {
      this.pending.delete(id);
      this.expire();
      return { ok: false, failure: 'expired' };
    }

    this.expire();

    if (approval.owner !== undefined && owner !== undefined && approval.owner !== owner) {
      logger.warn('Approval claimed by a different owner', {
        approvalId: id,
        expected: approval.owner,
        got: owner,
      });
      return { ok: false, failure: 'wrong_owner' };
    }

    this.pending.delete(id);
    logger.info('Approval granted', { approvalId: id, command: approval.parsed.command });
    return { ok: true, approval };
  }

  /** Discard without running. Returns false if it was not the caller's to deny. */
  deny(id: string, owner?: ApprovalOwner): boolean {
    this.expire();

    const approval = this.pending.get(id);
    if (approval === undefined) return false;
    if (approval.owner !== undefined && owner !== undefined && approval.owner !== owner) {
      return false;
    }

    this.pending.delete(id);
    logger.info('Approval denied', { approvalId: id, command: approval.parsed.command });
    return true;
  }

  /** Look without consuming. */
  peek(id: string): PendingApproval | undefined {
    this.expire();
    return this.pending.get(id);
  }

  /** Drop everything — called on daemon shutdown. Returns how many were lost. */
  clear(): number {
    const count = this.pending.size;
    this.pending.clear();
    return count;
  }

  private expire(): void {
    const now = Date.now();
    for (const [id, approval] of this.pending) {
      if (approval.expiresAt <= now) {
        this.pending.delete(id);
        logger.info('Approval expired', { approvalId: id, command: approval.parsed.command });
      }
    }
  }
}
