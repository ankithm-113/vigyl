/**
 * The decisions a Firestore query makes before it touches the network.
 *
 * Separated from the server so they can be tested without credentials: what
 * counts as a legal collection name, how big a page may be, and where "today"
 * starts.
 */

/** A page bigger than this is rarely read and always expensive. */
export const MAX_LIMIT = 100;
export const DEFAULT_LIMIT = 10;

/**
 * Pages of 1,000 Auth users to walk before giving up.
 *
 * `listUsers` is the only way to count, and on a large project it never ends.
 * The count is reported as "at least" when the cap is hit, rather than pretending
 * to be exact or hanging the command.
 */
export const MAX_AUTH_PAGES = 20;

export function clampLimit(requested: number | undefined): number {
  if (requested === undefined || !Number.isFinite(requested)) return DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, Math.max(1, Math.floor(requested)));
}

/**
 * Is this a collection the server will read?
 *
 * Firestore accepts a slash-separated path, so `users/u1/sessions` is a valid
 * collection reference — and so is anything else with an odd number of
 * segments. Allowing a free-form path would let a prompt walk the whole
 * database a level at a time, so only plain names and explicit subcollection
 * paths of known shape are accepted, and nothing with traversal in it.
 */
export function isAllowedCollection(name: string): boolean {
  if (name === '' || name.length > 200) return false;
  if (name.startsWith('/') || name.endsWith('/')) return false;
  if (name.includes('//')) return false;

  const segments = name.split('/');
  if (segments.length % 2 === 0) return false; // even = a document, not a collection
  if (segments.length > 5) return false;

  return segments.every((segment) => /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(segment) && segment !== '..');
}

export type WhereOperator = '==' | '!=' | '<' | '<=' | '>' | '>=';

export const WHERE_OPERATORS: readonly WhereOperator[] = ['==', '!=', '<', '<=', '>', '>='];

/**
 * The start of today, in a named IANA zone.
 *
 * "How many users signed up today?" is asked by a person in a place. The server
 * runs wherever it runs, and on a UTC box the answer is wrong for most of the
 * day in Asia — by 05:30 for the operator of this project.
 */
export function startOfToday(timeZone: string, now: Date = new Date()): Date {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(now);

  const get = (type: string): number => Number(parts.find((part) => part.type === type)?.value ?? 0);

  // Midnight local, expressed as the instant it happened.
  const elapsedMs =
    (get('hour') % 24) * 3_600_000 + get('minute') * 60_000 + get('second') * 1_000;
  return new Date(now.getTime() - elapsedMs - now.getMilliseconds());
}

/** Reject a time zone the platform does not know, rather than silently using UTC. */
export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return true;
  } catch {
    return false;
  }
}
