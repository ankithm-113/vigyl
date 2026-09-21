import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import OpenAI from 'openai';
import { LengthFinishReasonError } from 'openai/error';

import { OpenAIProvider, createProvider, AnthropicProvider } from './llm';
import { ParsedCommandSchema, Supervisor, SupervisorError } from './supervisor';

const VALID_COMMAND = {
  action: 'logs' as const,
  target: 'app',
  command: 'tail -n 20 logs/app.log',
  isDestructive: false,
  description: 'Show the last 20 log lines.',
  requiresApproval: false,
};

interface Captured {
  body?: Record<string, unknown>;
  options?: Record<string, unknown>;
}

/** Minimal stand-in for the parts of the OpenAI SDK the provider touches. */
function stubOpenAI(handler: () => unknown, captured: Captured = {}): OpenAI {
  return {
    chat: {
      completions: {
        parse: async (body: Record<string, unknown>, options: Record<string, unknown>) => {
          captured.body = body;
          captured.options = options;
          return handler();
        },
      },
    },
  } as unknown as OpenAI;
}

function completion(message: Record<string, unknown>, finish = 'stop'): unknown {
  return {
    choices: [{ message, finish_reason: finish }],
    usage: { prompt_tokens: 100, completion_tokens: 40, total_tokens: 140 },
  };
}

const REQUEST = {
  schemaName: 'parsed_command',
  schema: ParsedCommandSchema,
  system: 'system prompt',
  user: 'user message',
  maxTokens: 256,
  timeoutMs: 1_000,
  what: 'parse the command',
};

describe('OpenAIProvider', () => {
  it('sends a strict json_schema request with system and user messages', async () => {
    const captured: Captured = {};
    const provider = new OpenAIProvider(
      'sk-test',
      'gpt-4o-mini',
      stubOpenAI(() => completion({ parsed: VALID_COMMAND, refusal: null }), captured),
    );

    await provider.structured(REQUEST);

    const body = captured.body ?? {};
    assert.equal(body['model'], 'gpt-4o-mini');
    assert.equal(body['max_completion_tokens'], 256);
    assert.deepEqual(body['messages'], [
      { role: 'system', content: 'system prompt' },
      { role: 'user', content: 'user message' },
    ]);
    const format = body['response_format'] as { type: string; json_schema: { name: string; strict: boolean } };
    assert.equal(format.type, 'json_schema');
    assert.equal(format.json_schema.name, 'parsed_command');
    assert.equal(format.json_schema.strict, true);
    assert.equal(captured.options?.['timeout'], 1_000);
  });

  it('normalises the parsed object, stop reason and token usage', async () => {
    const provider = new OpenAIProvider(
      'sk-test',
      'gpt-4o-mini',
      stubOpenAI(() => completion({ parsed: VALID_COMMAND, refusal: null })),
    );

    const result = await provider.structured(REQUEST);

    assert.deepEqual(result.parsed, VALID_COMMAND);
    assert.equal(result.stopReason, 'stop');
    assert.equal(result.totalTokens, 140);
  });

  it('treats a refusal as no result', async () => {
    const provider = new OpenAIProvider(
      'sk-test',
      'gpt-4o-mini',
      stubOpenAI(() => completion({ parsed: null, refusal: 'I cannot help with that.' })),
    );

    const result = await provider.structured(REQUEST);

    assert.equal(result.parsed, undefined);
    assert.equal(result.stopReason, 'refusal');
  });

  it('treats truncation as no result rather than throwing', async () => {
    const provider = new OpenAIProvider(
      'sk-test',
      'gpt-4o-mini',
      stubOpenAI(() => {
        throw new LengthFinishReasonError();
      }),
    );

    const result = await provider.structured(REQUEST);

    assert.equal(result.parsed, undefined);
    assert.equal(result.stopReason, 'length');
  });

  const errors: Array<[string, () => Error, string, RegExp]> = [
    ['auth', () => new OpenAI.AuthenticationError(401, undefined, 'bad key', new Headers()), 'auth', /OPENAI_API_KEY/],
    ['rate limit', () => new OpenAI.RateLimitError(429, undefined, 'slow', new Headers()), 'rate_limit', /rate limit/i],
    ['timeout', () => new OpenAI.APIConnectionTimeoutError(), 'timeout', /Timed out/],
    ['connection', () => new OpenAI.APIConnectionError({ message: 'down' }), 'connection', /Could not reach the OpenAI API/],
    ['server error', () => new OpenAI.InternalServerError(500, undefined, 'boom', new Headers()), 'api', /OpenAI API error/],
    ['anything else', () => new Error('weird'), 'unknown', /Unexpected failure.*weird/],
  ];

  for (const [label, make, kind, message] of errors) {
    it('maps ' + label + ' to SupervisorError kind "' + kind + '"', async () => {
      const provider = new OpenAIProvider(
        'sk-test',
        'gpt-4o-mini',
        stubOpenAI(() => {
          throw make();
        }),
      );

      await assert.rejects(
        () => provider.structured(REQUEST),
        (err: unknown) => {
          assert.ok(err instanceof SupervisorError);
          assert.equal(err.kind, kind);
          assert.match(err.message, message);
          return true;
        },
      );
    });
  }
});

describe('createProvider', () => {
  it('picks the implementation matching the configured provider', () => {
    const openai = createProvider({ provider: 'openai', api_key: 'sk-x', model: 'gpt-4o-mini' });
    const anthropic = createProvider({ provider: 'anthropic', api_key: 'sk-ant-x', model: 'claude-haiku-4-5' });

    assert.ok(openai instanceof OpenAIProvider);
    assert.equal(openai.model, 'gpt-4o-mini');
    assert.ok(anthropic instanceof AnthropicProvider);
  });
});

describe('Supervisor on OpenAI', () => {
  const settings = { provider: 'openai' as const, api_key: 'sk-test', model: 'gpt-4o-mini' };

  it('parses a command end to end through the OpenAI provider', async () => {
    const provider = new OpenAIProvider(
      'sk-test',
      'gpt-4o-mini',
      stubOpenAI(() => completion({ parsed: VALID_COMMAND, refusal: null })),
    );
    const supervisor = new Supervisor(settings, { provider });

    const parsed = await supervisor.parseCommand('show the logs', { workspaceRoot: '/ws' });

    assert.equal(parsed.command, 'tail -n 20 logs/app.log');
  });

  it('returns no patch when OpenAI truncates the file', async () => {
    const provider = new OpenAIProvider(
      'sk-test',
      'gpt-4o-mini',
      stubOpenAI(() => {
        throw new LengthFinishReasonError();
      }),
    );
    const supervisor = new Supervisor(settings, { provider });

    assert.equal(await supervisor.generatePatch('error', 'code', '/ws'), undefined);
  });

  it('surfaces an OpenAI rate limit as a rate_limit SupervisorError', async () => {
    const provider = new OpenAIProvider(
      'sk-test',
      'gpt-4o-mini',
      stubOpenAI(() => {
        throw new OpenAI.RateLimitError(429, undefined, 'slow', new Headers());
      }),
    );
    const supervisor = new Supervisor(settings, { provider });

    await assert.rejects(
      () => supervisor.generatePatch('error', 'code', '/ws'),
      (err: unknown) => err instanceof SupervisorError && err.kind === 'rate_limit',
    );
  });
});
