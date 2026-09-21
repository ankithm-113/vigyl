/** Error types shared by the Supervisor and the LLM providers. */

/**
 * What went wrong, so callers can react rather than just report.
 *
 * A rate limit is temporary and worth telling the user to retry; a bad key is
 * permanent and worth telling them to fix their config. Collapsing both into
 * one opaque error made the self-healing loop say "no fix available", which is
 * actively misleading when the truth is "we never got to ask".
 */
export type SupervisorFailure =
  | 'auth'
  | 'rate_limit'
  | 'timeout'
  | 'connection'
  | 'api'
  | 'unknown';

export class SupervisorError extends Error {
  public readonly originalError?: unknown;
  public readonly kind: SupervisorFailure;

  constructor(message: string, kind: SupervisorFailure = 'unknown', originalError?: unknown) {
    super(message);
    this.name = 'SupervisorError';
    this.kind = kind;
    this.originalError = originalError;
  }
}
