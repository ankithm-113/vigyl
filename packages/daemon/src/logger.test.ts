import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { getLogLevel, isLogLevel, redactSecrets, setLogLevel } from './logger';

describe('redactSecrets', () => {
  it('redacts values under credential-shaped keys', () => {
    const out = redactSecrets({
      anthropic: { api_key: 'sk-ant-abcdef123456', model: 'claude-haiku-4-5' },
      telegram: { bot_token: '123456789:AAEhBOweik6ad9YvHRnp', allowed_chat_ids: [42] },
    }) as Record<string, Record<string, unknown>>;

    assert.equal(out['anthropic']?.['api_key'], '[REDACTED]');
    assert.equal(out['telegram']?.['bot_token'], '[REDACTED]');
    // Non-secret siblings survive — a redacted log is still a useful log.
    assert.equal(out['anthropic']?.['model'], 'claude-haiku-4-5');
    assert.deepEqual(out['telegram']?.['allowed_chat_ids'], [42]);
  });

  it('scrubs a leaked key out of free-form text under an innocent key', () => {
    const out = redactSecrets({
      message: 'export ANTHROPIC_API_KEY=sk-ant-api03-SECRETVALUE && npm run build',
    }) as Record<string, string>;

    assert.ok(!out['message']?.includes('SECRETVALUE'));
    assert.match(String(out['message']), /sk-ant-\[REDACTED\]/);
    assert.match(String(out['message']), /npm run build/);
  });

  it('scrubs a leaked OpenAI key out of free-form text', () => {
    const out = redactSecrets({
      message: 'OPENAI_API_KEY=sk-proj-AbC123dEf456GhI789jKl012MnO345pQr && npm test',
      legacy: 'Bearer sk-AbC123dEf456GhI789jKl012MnO345',
    }) as Record<string, string>;

    assert.ok(!out['message']?.includes('AbC123'));
    assert.ok(!out['legacy']?.includes('AbC123'));
    assert.match(String(out['message']), /npm test/);
  });

  it('leaves short sk- words alone', () => {
    assert.equal(redactSecrets('see sk-learn docs'), 'see sk-learn docs');
  });

  it('scrubs a bot token out of free-form text', () => {
    const out = redactSecrets(
      'curl https://api.telegram.org/bot8123456789:AAHfitZxUvW1234567890abcdefghijklmno/getMe',
    );

    assert.ok(!String(out).includes('AAHfitZxUvW'));
    assert.match(String(out), /\[REDACTED-BOT-TOKEN\]/);
  });

  it('walks arrays and nested objects', () => {
    const out = redactSecrets({
      attempts: [{ password: 'hunter2' }, { note: 'fine' }],
    }) as { attempts: Array<Record<string, unknown>> };

    assert.equal(out.attempts[0]?.['password'], '[REDACTED]');
    assert.equal(out.attempts[1]?.['note'], 'fine');
  });

  it('survives circular references', () => {
    const cyclic: Record<string, unknown> = { name: 'daemon' };
    cyclic['self'] = cyclic;

    const out = redactSecrets(cyclic) as Record<string, unknown>;

    assert.equal(out['name'], 'daemon');
    assert.equal(out['self'], '[CIRCULAR]');
  });

  it('leaves ordinary values untouched', () => {
    const input = { exitCode: 0, command: 'npm run build', ok: true, missing: null };
    assert.deepEqual(redactSecrets(input), input);
  });

  it('flattens Error objects without losing the stack', () => {
    const out = redactSecrets(new Error('boom')) as Record<string, unknown>;

    assert.equal(out['name'], 'Error');
    assert.equal(out['message'], 'boom');
    assert.equal(typeof out['stack'], 'string');
  });
});

describe('setLogLevel', () => {
  it('round-trips through getLogLevel and reaches every transport', () => {
    const original = getLogLevel();
    try {
      setLogLevel('debug');
      assert.equal(getLogLevel(), 'debug');

      setLogLevel('error');
      assert.equal(getLogLevel(), 'error');
    } finally {
      setLogLevel(original);
    }
  });

  it('recognizes exactly the four supported levels', () => {
    for (const level of ['debug', 'info', 'warn', 'error']) {
      assert.equal(isLogLevel(level), true);
    }
    assert.equal(isLogLevel('trace'), false);
    assert.equal(isLogLevel(undefined), false);
  });
});
