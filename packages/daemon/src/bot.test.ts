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
  DEFAULT_RETRY_POLICY,
  createFloodControl,
  retryDecision,
  stripHtml,
  CALLBACK_LOG,
  renderHistory,
  renderHealthAlert,
  renderHealthSnapshot,
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


describe('retryDecision (Telegram flood control)', () => {
  it('does not retry a successful call', () => {
    assert.deepEqual(retryDecision({ ok: true }, 1), { retry: false, waitMs: 0 });
  });

  it('honours retry_after on a 429 rather than guessing', () => {
    // Guessing short gets the bot rate-limited harder, so the number Telegram
    // supplies is the only sensible wait.
    const decision = retryDecision(
      { ok: false, error_code: 429, parameters: { retry_after: 7 } },
      1,
    );
    assert.deepEqual(decision, { retry: true, waitMs: 7_000 });
  });

  it('defaults to one second when a 429 carries no retry_after', () => {
    assert.deepEqual(retryDecision({ ok: false, error_code: 429 }, 1), {
      retry: true,
      waitMs: 1_000,
    });
  });

  it('gives up rather than sleeping longer than the policy allows', () => {
    const decision = retryDecision(
      { ok: false, error_code: 429, parameters: { retry_after: 600 } },
      1,
      { maxAttempts: 4, maxWaitMs: 30_000 },
    );
    // A ten-minute sleep inside a command handler is not a retry.
    assert.equal(decision.retry, false);
  });

  it('backs off exponentially on 5xx', () => {
    const waits = [1, 2, 3].map(
      (attempt) => retryDecision({ ok: false, error_code: 500 }, attempt).waitMs,
    );
    assert.deepEqual(waits, [500, 1_000, 2_000]);
  });

  it('never retries a client error', () => {
    // 400 is our bug, 401 is a bad token, 403 is the user blocking the bot.
    // Retrying any of them wastes time and hides the real problem.
    for (const code of [400, 401, 403, 404]) {
      assert.equal(retryDecision({ ok: false, error_code: code }, 1).retry, false, String(code));
    }
  });

  it('stops once the attempt budget is spent', () => {
    const { maxAttempts } = DEFAULT_RETRY_POLICY;
    assert.equal(retryDecision({ ok: false, error_code: 429 }, maxAttempts).retry, false);
  });
});

describe('createFloodControl', () => {
  it('retries a 429 and returns the eventual success', async () => {
    let calls = 0;
    const transformer = createFloodControl({ maxAttempts: 4, maxWaitMs: 30_000 });
    const prev = async (): Promise<unknown> => {
      calls++;
      return calls < 3
        ? { ok: false, error_code: 429, parameters: { retry_after: 0 } }
        : { ok: true, result: 42 };
    };

    const result = (await transformer(prev, 'sendMessage', {})) as { ok: boolean };

    assert.equal(result.ok, true);
    assert.equal(calls, 3);
  });

  it('returns the failure once retries are exhausted, rather than looping', async () => {
    let calls = 0;
    const transformer = createFloodControl({ maxAttempts: 2, maxWaitMs: 30_000 });
    const prev = async (): Promise<unknown> => {
      calls++;
      return { ok: false, error_code: 429, parameters: { retry_after: 0 } };
    };

    const result = (await transformer(prev, 'sendMessage', {})) as { ok: boolean };

    assert.equal(result.ok, false);
    assert.equal(calls, 2);
  });

  it('passes a client error straight through without retrying', async () => {
    let calls = 0;
    const transformer = createFloodControl();
    const prev = async (): Promise<unknown> => {
      calls++;
      return { ok: false, error_code: 400, description: 'Bad Request' };
    };

    await transformer(prev, 'sendMessage', {});

    assert.equal(calls, 1);
  });
});

describe('stripHtml', () => {
  it('produces a readable plain-text fallback', () => {
    // Used when Telegram rejects our HTML: the result still has to arrive.
    const nl = String.fromCharCode(10);
    const html = '✅ <b>Done</b>' + nl + '<pre>a &lt; b &amp; c</pre>';
    assert.equal(stripHtml(html), '✅ Done' + nl + 'a < b & c');
  });
});
describe('full log retrieval', () => {
  it('offers a view-full-log button when output was truncated', () => {
    const rendered = renderResult({
      status: 'completed',
      command: 'npm run build',
      description: 'Build.',
      attempts: 1,
      exitCode: 0,
      output: 'noise'.repeat(5_000),
      commandId: 'a1b2c3d4',
      patches: [],
    });

    assert.ok(rendered.keyboard !== undefined);
    assert.match(JSON.stringify(rendered.keyboard), /log:a1b2c3d4/);
  });

  it('does not offer the button when nothing was withheld', () => {
    // Pressing it would return the same text; a dead end for the user.
    const rendered = renderResult({
      status: 'completed',
      command: 'npm run build',
      description: 'Build.',
      attempts: 1,
      exitCode: 0,
      output: 'short output',
      commandId: 'a1b2c3d4',
      patches: [],
    });

    assert.equal(rendered.keyboard, undefined);
  });

  it('does not offer the button when no log was stored', () => {
    const rendered = renderResult({
      status: 'completed',
      command: 'npm run build',
      description: 'Build.',
      attempts: 1,
      exitCode: 0,
      output: 'noise'.repeat(5_000),
      patches: [],
    });

    assert.equal(rendered.keyboard, undefined);
  });

  it('offers it on a failure too, where the log matters most', () => {
    const rendered = renderResult({
      status: 'failed',
      command: 'npm run build',
      description: 'Build.',
      attempts: 4,
      exitCode: 1,
      reason: 'retries_exhausted',
      output: 'error '.repeat(2_000),
      commandId: 'deadbeef',
      patches: [],
    });

    assert.match(JSON.stringify(rendered.keyboard), /log:deadbeef/);
  });

  it('parses a log callback payload', () => {
    assert.deepEqual(parseCallbackData(CALLBACK_LOG + ':a1b2c3d4'), {
      action: 'log',
      approvalId: 'a1b2c3d4',
    });
  });

  it('keeps the log payload inside the callback_data budget', () => {
    const payload = CALLBACK_LOG + ':a1b2c3d4';
    assert.ok(Buffer.byteLength(payload, 'utf-8') <= 64);
  });
});

describe('renderHistory', () => {
  it('says so plainly when there is nothing yet', () => {
    assert.match(renderHistory([]), /No commands yet/);
  });

  it('lists commands with status, text and log id', () => {
    const text = renderHistory([
      {
        at: Date.UTC(2026, 6, 27, 12, 0),
        userMessage: 'deploy to staging',
        command: 'npm run deploy:staging',
        status: 'completed',
        exitCode: 0,
        commandId: 'a1b2c3d4',
      },
    ]);

    assert.match(text, /deploy to staging/);
    assert.match(text, /npm run deploy:staging/);
    assert.match(text, /a1b2c3d4/);
    assert.match(text, /✅/);
  });

  it('escapes history text so a command cannot inject markup', () => {
    const text = renderHistory([
      { at: 0, userMessage: '<script>alert(1)</script>', status: 'failed' },
    ]);

    assert.ok(!text.includes('<script>'));
    assert.match(text, /&lt;script&gt;/);
  });

  it('stays within the Telegram message limit', () => {
    const many = Array.from({ length: 100 }, (_unused, i) => ({
      at: Date.now(),
      userMessage: 'command number ' + i + ' with a fairly long description attached',
      command: 'npm run something-with-a-long-name-' + i,
      status: 'completed' as const,
      commandId: 'a1b2c3d4',
    }));

    assert.ok(renderHistory(many).length <= TELEGRAM_MAX_MESSAGE);
  });
});

describe('health rendering', () => {
  it('lists every breached metric in an alert', () => {
    const text = renderHealthAlert([
      { metric: 'cpu', value: 95, threshold: 90, message: 'CPU at 95% (threshold 90%)' },
      { metric: 'disk', value: 91, threshold: 85, message: 'Disk at 91% (threshold 85%)' },
    ]);

    assert.match(text, /CPU at 95%/);
    assert.match(text, /Disk at 91%/);
    assert.match(text, /monitor off/);
  });

  it('shows readings and opt-in state in a snapshot', () => {
    const text = renderHealthSnapshot(
      { cpuPercent: 12, memoryPercent: 34, diskPercent: 56, at: Date.now() },
      [],
      true,
    );

    assert.match(text, /12%/);
    assert.match(text, /34%/);
    assert.match(text, /56%/);
    assert.match(text, /within thresholds/);
    assert.match(text, /ON for this chat/);
  });

  it('says so when disk could not be read', () => {
    const text = renderHealthSnapshot(
      { cpuPercent: 5, memoryPercent: 5, at: Date.now() },
      [],
      false,
    );

    assert.match(text, /unavailable/);
    assert.match(text, /OFF for this chat/);
  });

  it('stays within the Telegram message limit', () => {
    const many = Array.from({ length: 200 }, () => ({
      metric: 'cpu' as const,
      value: 99,
      threshold: 90,
      message: 'a fairly long alert message that repeats many times over',
    }));
    assert.ok(renderHealthAlert(many).length <= TELEGRAM_MAX_MESSAGE);
  });
});
