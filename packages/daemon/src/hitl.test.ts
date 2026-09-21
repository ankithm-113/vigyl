import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { ApprovalStore, approvalReasons } from './hitl';
import { SecurityLayer } from './security';
import type { ParsedCommand } from './supervisor';

let workspace: string;
let security: SecurityLayer;

function command(overrides: Partial<ParsedCommand> = {}): ParsedCommand {
  return {
    action: 'build',
    target: 'api',
    command: 'npm run build',
    isDestructive: false,
    description: 'Build the API.',
    requiresApproval: false,
    ...overrides,
  };
}

beforeEach(() => {
  workspace = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'vigyl-hitl-')));
  security = new SecurityLayer(workspace);
});

afterEach(() => {
  fs.rmSync(workspace, { recursive: true, force: true });
});

describe('approvalReasons', () => {
  const triggers = ['production', 'delete', 'migrate', 'push'];

  it('says nothing for a routine command', () => {
    assert.deepEqual(approvalReasons(command(), triggers, security), []);
  });

  it('reports the model flag', () => {
    const reasons = approvalReasons(command({ requiresApproval: true }), triggers, security);
    assert.ok(reasons.some((r) => r.includes('model flagged')));
  });

  it('reports a destructive action separately from the approval flag', () => {
    const reasons = approvalReasons(
      command({ isDestructive: true, requiresApproval: false }),
      triggers,
      security,
    );
    assert.ok(reasons.some((r) => r.includes('destructive')));
  });

  it('catches a trigger even when the model says approval is not needed', () => {
    // The model is being steered by the message it is parsing, so the
    // operator's own rules get an independent vote.
    const reasons = approvalReasons(
      command({ command: 'git push origin main', requiresApproval: false, isDestructive: false }),
      triggers,
      security,
    );

    assert.equal(reasons.length, 1);
    assert.ok(reasons[0]?.includes('push'));
  });

  it('matches a trigger against the target as well as the command', () => {
    const reasons = approvalReasons(
      command({ command: 'npm run deploy', target: 'production' }),
      triggers,
      security,
    );
    assert.ok(reasons.some((r) => r.includes('production')));
  });

  it('collects every reason, not just the first', () => {
    const reasons = approvalReasons(
      command({
        command: 'npm run migrate && git push',
        requiresApproval: true,
        isDestructive: true,
      }),
      triggers,
      security,
    );

    assert.ok(reasons.length >= 4, `expected several reasons, got ${reasons.length}`);
  });
});

describe('ApprovalStore', () => {
  it('issues a unique id per approval', () => {
    const store = new ApprovalStore(300);
    const a = store.create(command(), ['because']);
    const b = store.create(command(), ['because']);

    assert.notEqual(a.id, b.id);
    assert.equal(store.size, 2);
  });

  it('returns the stored command verbatim on claim', () => {
    const store = new ApprovalStore(300);
    const parsed = command({ command: 'npm run deploy:production' });
    const approval = store.create(parsed, ['production rule']);

    const claim = store.claim(approval.id);

    assert.equal(claim.ok, true);
    if (!claim.ok) throw new Error('narrowing');
    assert.equal(claim.approval.parsed.command, 'npm run deploy:production');
  });

  it('is single use, so an approval cannot be replayed', () => {
    const store = new ApprovalStore(300);
    const approval = store.create(command(), []);

    assert.equal(store.claim(approval.id).ok, true);
    const second = store.claim(approval.id);

    assert.equal(second.ok, false);
    if (second.ok) throw new Error('narrowing');
    assert.equal(second.failure, 'unknown');
  });

  it('reports expiry distinctly from an unknown id', () => {
    const store = new ApprovalStore(0);
    const approval = store.create(command(), []);

    const claim = store.claim(approval.id);

    assert.equal(claim.ok, false);
    if (claim.ok) throw new Error('narrowing');
    // Distinct so the user can be told to send the command again, rather
    // than being left wondering whether it already ran.
    assert.equal(claim.failure, 'expired');
  });

  it('refuses a claim from a different owner without consuming it', () => {
    const store = new ApprovalStore(300);
    const approval = store.create(command(), [], 111);

    const stolen = store.claim(approval.id, 222);
    assert.equal(stolen.ok, false);
    if (stolen.ok) throw new Error('narrowing');
    assert.equal(stolen.failure, 'wrong_owner');

    // Still there for the rightful owner.
    assert.equal(store.claim(approval.id, 111).ok, true);
  });

  it('refuses a deny from a different owner', () => {
    const store = new ApprovalStore(300);
    const approval = store.create(command(), [], 111);

    assert.equal(store.deny(approval.id, 222), false);
    assert.equal(store.deny(approval.id, 111), true);
    assert.equal(store.deny(approval.id, 111), false);
  });

  it('peeks without consuming', () => {
    const store = new ApprovalStore(300);
    const approval = store.create(command(), []);

    assert.equal(store.peek(approval.id)?.parsed.command, 'npm run build');
    assert.equal(store.size, 1);
    assert.equal(store.claim(approval.id).ok, true);
  });

  it('drops everything on clear and reports how many were lost', () => {
    const store = new ApprovalStore(300);
    store.create(command(), []);
    store.create(command(), []);

    assert.equal(store.clear(), 2);
    assert.equal(store.size, 0);
  });

  it('does not count expired approvals as pending', () => {
    const store = new ApprovalStore(0);
    store.create(command(), []);

    assert.equal(store.size, 0);
  });
});
