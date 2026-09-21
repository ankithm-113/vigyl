/**
 * LLM providers: the one seam between Vigyl and a model vendor.
 *
 * The Supervisor needs exactly one capability from a model — "given a system
 * prompt, a user message and a schema, return an object that parses against
 * the schema" — so that is the whole interface. Each provider maps its SDK's
 * structured-output feature onto it and normalises its SDK's errors into
 * SupervisorError kinds, so callers (self-heal, the bot) react to a rate limit
 * or a bad key identically whichever vendor is behind it.
 *
 * Both providers enforce the schema server-side (Anthropic output_config,
 * OpenAI strict json_schema) AND re-validate client-side through the SDK's
 * zod helper, so nothing unparsed ever reaches the Supervisor.
 */
import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import OpenAI from 'openai';
import { LengthFinishReasonError } from 'openai/error';
import { zodResponseFormat } from 'openai/helpers/zod';
import type { z } from 'zod/v4';
import type { LlmSettings } from './config';
import { SupervisorError } from './errors';

export type ProviderName = 'openai' | 'anthropic';

export interface StructuredRequest<S extends z.ZodType> {
  /** Short identifier for the schema; OpenAI requires one. */
  schemaName: string;
  schema: S;
  system: string;
  user: string;
  maxTokens: number;
  timeoutMs: number;
  /** Human phrase for error messages: "parse the command". */
  what: string;
}

export interface StructuredResponse<T> {
  /** undefined when the model refused, was truncated, or returned nothing. */
  parsed: T | undefined;
  stopReason: string;
  totalTokens: number;
}

export interface LlmProvider {
  readonly name: ProviderName;
  readonly model: string;
  structured<S extends z.ZodType>(req: StructuredRequest<S>): Promise<StructuredResponse<z.infer<S>>>;
}

// ---------------------------------------------------------------------------
// OpenAI
// ---------------------------------------------------------------------------

export class OpenAIProvider implements LlmProvider {
  readonly name = 'openai' as const;
  private readonly client: OpenAI;

  /** @param client injected only by tests. */
  constructor(
    apiKey: string,
    readonly model: string,
    client?: OpenAI,
  ) {
    // The SDK retries 429 and 5xx with exponential backoff itself.
    this.client = client ?? new OpenAI({ apiKey, maxRetries: 3 });
  }

  async structured<S extends z.ZodType>(req: StructuredRequest<S>): Promise<StructuredResponse<z.infer<S>>> {
    try {
      const completion = await this.client.chat.completions.parse(
        {
          model: this.model,
          max_completion_tokens: req.maxTokens,
          messages: [
            { role: 'system', content: req.system },
            { role: 'user', content: req.user },
          ],
          response_format: zodResponseFormat(req.schema, req.schemaName),
        },
        { timeout: req.timeoutMs },
      );

      const choice = completion.choices[0];
      // A refusal fills message.refusal and leaves parsed null.
      const parsed = choice?.message.refusal ? undefined : (choice?.message.parsed ?? undefined);
      return {
        parsed: parsed as z.infer<S> | undefined,
        stopReason: choice?.message.refusal ? 'refusal' : (choice?.finish_reason ?? 'unknown'),
        totalTokens: completion.usage?.total_tokens ?? 0,
      };
    } catch (err) {
      // The SDK throws on truncation rather than returning a partial object.
      if (err instanceof LengthFinishReasonError) {
        return { parsed: undefined, stopReason: 'length', totalTokens: 0 };
      }
      throw normaliseOpenAIError(err, req.what);
    }
  }
}

function normaliseOpenAIError(err: unknown, what: string): SupervisorError {
  if (err instanceof OpenAI.AuthenticationError) {
    return new SupervisorError('OpenAI rejected the API key. Check OPENAI_API_KEY / openai.api_key.', 'auth', err);
  }
  if (err instanceof OpenAI.RateLimitError) {
    return new SupervisorError('OpenAI rate limit reached and retries were exhausted. Try again shortly.', 'rate_limit', err);
  }
  if (err instanceof OpenAI.APIConnectionTimeoutError) {
    return new SupervisorError(`Timed out waiting for the model to ${what}.`, 'timeout', err);
  }
  if (err instanceof OpenAI.APIConnectionError) {
    return new SupervisorError(`Could not reach the OpenAI API to ${what}.`, 'connection', err);
  }
  if (err instanceof OpenAI.APIError) {
    return new SupervisorError(`OpenAI API error while trying to ${what}: ${err.message}`, 'api', err);
  }
  return unexpected(err, what);
}

// ---------------------------------------------------------------------------
// Anthropic
// ---------------------------------------------------------------------------

export class AnthropicProvider implements LlmProvider {
  readonly name = 'anthropic' as const;
  private readonly client: Anthropic;

  /** @param client injected only by tests. */
  constructor(
    apiKey: string,
    readonly model: string,
    client?: Anthropic,
  ) {
    this.client = client ?? new Anthropic({ apiKey, maxRetries: 3 });
  }

  async structured<S extends z.ZodType>(req: StructuredRequest<S>): Promise<StructuredResponse<z.infer<S>>> {
    try {
      const response = await this.client.messages.parse(
        {
          model: this.model,
          max_tokens: req.maxTokens,
          system: req.system,
          messages: [{ role: 'user', content: req.user }],
          output_config: { format: zodOutputFormat(req.schema) },
        },
        { timeout: req.timeoutMs },
      );
      return {
        parsed: (response.parsed_output ?? undefined) as z.infer<S> | undefined,
        stopReason: response.stop_reason ?? 'unknown',
        totalTokens: response.usage.input_tokens + response.usage.output_tokens,
      };
    } catch (err) {
      throw normaliseAnthropicError(err, req.what);
    }
  }
}

function normaliseAnthropicError(err: unknown, what: string): SupervisorError {
  if (err instanceof Anthropic.AuthenticationError) {
    return new SupervisorError(
      'Anthropic rejected the API key. Check anthropic.api_key in vigyl.config.json.',
      'auth',
      err,
    );
  }
  if (err instanceof Anthropic.RateLimitError) {
    return new SupervisorError(
      'Anthropic rate limit reached and retries were exhausted. Try again shortly.',
      'rate_limit',
      err,
    );
  }
  if (err instanceof Anthropic.APIConnectionTimeoutError) {
    return new SupervisorError(`Timed out waiting for Claude to ${what}.`, 'timeout', err);
  }
  if (err instanceof Anthropic.APIConnectionError) {
    return new SupervisorError(`Could not reach the Anthropic API to ${what}.`, 'connection', err);
  }
  if (err instanceof Anthropic.APIError) {
    return new SupervisorError(`Anthropic API error while trying to ${what}: ${err.message}`, 'api', err);
  }
  return unexpected(err, what);
}

function unexpected(err: unknown, what: string): SupervisorError {
  if (err instanceof SupervisorError) return err;
  return new SupervisorError(
    `Unexpected failure while trying to ${what}: ${err instanceof Error ? err.message : String(err)}`,
    'unknown',
    err,
  );
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createProvider(settings: LlmSettings): LlmProvider {
  return settings.provider === 'openai'
    ? new OpenAIProvider(settings.api_key, settings.model)
    : new AnthropicProvider(settings.api_key, settings.model);
}
