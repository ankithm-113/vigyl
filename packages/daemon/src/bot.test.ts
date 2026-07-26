import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  CALLBACK_APPROVE,
  CALLBACK_DENY,
  TELEGRAM_MAX_MESSAGE,
  clampMessage,
  escapeHtml,
  explainStopReason,
  isAuthorized,
  parseCallbackData,
  renderResult,
  truncateOutput,
} from './bot';
import type { CommandResult } from './daemon';

const NL = String.fromCharCode(10);

describe('chat authorization', () => {
  const allowed = [12345, -1009876543210];

  it('admits an allowlisted chat', () => {
    assert.equal(isAuthorized(12345, allowed), true);
    assert.equal(isAuthorized(-1009876543210, allowed), true);
  });

  it('rejects an unknown chat', () => {
    assert.equal(isAuthorized(999, allowed), false);
  });

  it('rejects an update with no chat id rather than defaulting open', () => {
    assert.equal(isAuthorized(undefined, allowed), false);
  });

  it('rejects everything when the allowlist is empty', () => {
    // The bootstrap state. It must fail closed: an empty list means nobody has
    // been authorized yet, not that everybody is.
    assert.equal(isAuthorized(12345, []), false);
    assert.equal(isAuthorized(undefined, []), false);
  });

  it('does not match a chat id by string coercion', () => {
    // Telegram ids arrive as numbers; a string that looks like one must not
    // slip through a loose comparison.
    assert.equal(isAuthorized(Number('12345'), allowed), true);
    assert.equal(isAuthorized(1234, allowed), false, 'prefix must not match');
  });
});

describe('escapeHtml', () => {
  it('escapes exactly the three characters Telegram HTML cares about', () => {
    assert.equal(escapeHtml('a & b'), 'a &amp; b');
    assert.equal(escapeHtml('<script>'), '&lt;script&gt;');
  });

  it('escapes ampersands before angle brackets, not after', () => {
    // Order matters: escaping < first would turn the & of &lt; into &amp;lt;.
    assert.equal(escapeHtml('<'), '&lt;');
    assert.equal(escapeHtml('&lt;'), '&amp;lt;');
  });

  it('leaves the markdown characters that broke the guide alone', () => {
    // An unbalanced backtick or underscore is fatal under parse_mode Markdown
    // and completely inert under HTML.
    const nasty = 'npm run build -- --flag `unclosed _underscore *star';
    assert.equal(escapeHtml(nasty), nasty);
  });
});

describe('truncateOutput', () => {
  it('keeps short output untouched', () => {
    assert.equal(truncateOutput('  hello  '), 'hello');
  });

  it('keeps the END of long output, because errors come last', () => {
    const output = 'START' + 'x'.repeat(5_000) + 'THE-ACTUAL-ERROR';

    const result = truncateOutput(output, 1_000);

    assert.ok(result.includes('THE-ACTUAL-ERROR'));
    assert.ok(!result.includes('START'));
    assert.match(result, /earlier characters omitted/);
  });
});

describe('clampMessage', () => {
  it('never returns more than Telegram accepts', () => {
    const huge = 'y'.repeat(TELEGRAM_MAX_MESSAGE * 3);
    assert.ok(clampMessage(huge).length <= TELEGRAM_MAX_MESSAGE);
  });

  it('leaves a normal message alone', () => {
    assert.equal(clampMessage('short'), 'short');
  });
});

describe('parseCallbackData', () => {
  it('reads an approve payload', () => {
    assert.deepEqual(parseCallbackData(`${CALLBACK_APPROVE}:abc-123`), {
      action: 'approve',
      approvalId: 'abc-123',
    });
  });

  it('reads a deny payload', () => {
    assert.deepEqual(parseCallbackData(`${CALLBACK_DENY}:abc-123`), {
      action: 'deny',
      approvalId: 'abc-123',
    });
  });

  it('keeps a UUID intact, colons and all', () => {
    const uuid = '53af9e3c-7aec-449e-b4bf-a3609bcc2d27';
    assert.equal(parseCallbackData(`approve:${uuid}`)?.approvalId, uuid);
  });

  it('rejects anything it did not produce', () => {
    assert.equal(parseCallbackData(undefined), undefined);
    assert.equal(parseCallbackData(''), undefined);
    assert.equal(parseCallbackData('approve'), undefined);
    assert.equal(parseCallbackData('approve:'), undefined);
    assert.equal(parseCallbackData('delete:abc'), undefined);
  });

  it('fits inside Telegram callback_data limit of 64 bytes', () => {
    const payload = `${CALLBACK_APPROVE}:53af9e3c-7aec-449e-b4bf-a3609bcc2d27`;
    assert.ok(Buffer.byteLength(payload, 'utf-8') <= 64, `payload was ${payload.length} chars`);
  });
});

describe('renderResult', () => {
  const patches = [
    {
      proposedPath: 'src/app.ts',
      resolvedPath: '/ws/src/app.ts',
      explanation: 'Removed the stray token.',
      backupPath: '/ws/.vigyl/backups/app.ts.bak',
      attempt: 1,
    },
  ];

  it('renders a completed command with no keyboard', () => {
    const result: CommandResult = {
      status: 'completed',
      command: 'npm run build',
      description: 'Build the API.',
      attempts: 1,
      exitCode: 0,
      output: 'Build succeeded',
      patches: [],
    };

    const rendered = renderResult(result);

    assert.match(rendered.text, /Done/);
    assert.match(rendered.text, /Build succeeded/);
    assert.equal(rendered.keyboard, undefined);
  });

  it('mentions self-healing when the command needed more than one attempt', () => {
    const rendered = renderResult({
      status: 'completed',
      command: 'node app.js',
      description: 'Run the app.',
      attempts: 2,
      exitCode: 0,
      output: 'repaired',
      patches,
    });

    assert.match(rendered.text, /attempt 2/);
    assert.match(rendered.text, /src\/app\.ts/);
    assert.match(rendered.text, /Removed the stray token/);
  });

  it('offers approve and deny buttons carrying the approval id', () => {
    const rendered = renderResult({
      status: 'approval_required',
      approvalId: 'abc-123',
      command: 'npm run deploy:production',
      description: 'Deploy to production.',
      isDestructive: true,
      expiresAt: Date.now() + 300_000,
      reasons: ['it matches the "production" approval rule'],
    });

    assert.ok(rendered.keyboard !== undefined);
    const payloads = JSON.stringify(rendered.keyboard);
    assert.match(payloads, /approve:abc-123/);
    assert.match(payloads, /deny:abc-123/);
    assert.match(rendered.text, /needs your approval/);
    assert.match(rendered.text, /production. approval rule/);
  });

  it('explains why a failure stopped, in plain English', () => {
    const rendered = renderResult({
      status: 'failed',
      command: 'npm start',
      description: 'Start the app.',
      attempts: 1,
      exitCode: 1,
      reason: 'not_auto_fixable',
      errorType: 'dependency_missing',
      message: "Error: Cannot find module 'express'",
      output: 'npm ERR!',
      patches: [],
    });

    assert.match(rendered.text, /Failed/);
    assert.match(rendered.text, /cannot be fixed by editing a file/);
    assert.match(rendered.text, /Cannot find module/);
    assert.equal(rendered.keyboard, undefined);
  });

  it('renders each status without throwing and within the length limit', () => {
    const results: CommandResult[] = [
      { status: 'busy', reason: 'A command is already running.' },
      { status: 'error', reason: 'Anthropic rejected the API key.' },
      { status: 'rejected', command: 'sudo rm -rf /', reason: 'it runs sudo' },
    ];

    for (const result of results) {
      const rendered = renderResult(result);
      assert.ok(rendered.text.length > 0, result.status);
      assert.ok(rendered.text.length <= TELEGRAM_MAX_MESSAGE, result.status);
    }
  });

  it('survives command output full of HTML and markdown metacharacters', () => {
    // A build log really can contain these. Under the guide's parse_mode
    // Markdown this message would be rejected outright by Telegram.
    const hostile = ['<script>alert(1)</script>', 'a & b', '`unclosed', '_italic', '**bold'].join(NL);

    const rendered = renderResult({
      status: 'completed',
      command: 'npm run build',
      description: 'Build.',
      attempts: 1,
      exitCode: 0,
      output: hostile,
      patches: [],
    });

    assert.ok(!rendered.text.includes('<script>'), 'raw tag must not survive');
    assert.match(rendered.text, /&lt;script&gt;/);
    assert.match(rendered.text, /a &amp; b/);
  });

  it('clamps a gigantic build log to something Telegram will accept', () => {
    const rendered = renderResult({
      status: 'completed',
      command: 'npm run build',
      description: 'Build.',
      attempts: 1,
      exitCode: 0,
      output: 'noise'.repeat(50_000),
      patches: [],
    });

    assert.ok(rendered.text.length <= TELEGRAM_MAX_MESSAGE);
  });
});

describe('explainStopReason', () => {
  it('has a distinct explanation for every stop reason', () => {
    const reasons = [
      'not_auto_fixable',
      'no_patch_offered',
      'patch_rejected',
      'patch_write_failed',
      'repeated_failure',
      'retries_exhausted',
      'disabled',
    ] as const;

    const seen = new Set<string>();
    for (const reason of reasons) {
      const text = explainStopReason(reason);
      assert.ok(text.length > 0, reason);
      assert.ok(!text.includes('_'), `${reason} leaked the raw enum value`);
      seen.add(text);
    }
    assert.equal(seen.size, reasons.length, 'each reason should read differently');
  });
});
