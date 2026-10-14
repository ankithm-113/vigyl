/**
 * Deciding whether a statement is a read, before it reaches the database.
 *
 * This is a typo filter, not the security boundary. The boundary is a
 * `BEGIN TRANSACTION READ ONLY` wrapper, which Postgres itself enforces. Both
 * exist because the string check gives a clear error for an obvious mistake,
 * and the transaction stops everything the string check cannot see.
 *
 * The build guide used only the string check — `sql.startsWith('select') ||
 * sql.startsWith('with')` — and that is genuinely unsafe. Measured against a
 * real Neon database on 2026-10-14:
 *
 *   WITH gone AS (DELETE FROM users WHERE id=1 RETURNING *) SELECT * FROM gone
 *     -> allowed by the check, deleted the row
 *   SELECT 1; DROP TABLE users
 *     -> allowed by the check, dropped the table
 *
 * Postgres allows data-modifying CTEs, and node-postgres sends a query with no
 * parameters over the simple protocol, which permits multiple statements.
 */

const NL = String.fromCharCode(10);

/** Rows returned to the model. Beyond this nobody reads it and the prompt suffers. */
export const MAX_ROWS = 200;
export const DEFAULT_ROWS = 50;

/** A query that runs longer than this is a mistake or an attack. */
export const STATEMENT_TIMEOUT_MS = 10_000;

export interface SqlVerdict {
  readonly ok: boolean;
  readonly reason?: string;
}

/**
 * Remove comments and string literals.
 *
 * Both can hide a semicolon or a keyword: `SELECT 1 /* ; DROP TABLE x *​/` and
 * `SELECT ';DROP TABLE x'` are each harmless, while `SELECT 1; DROP TABLE x`
 * is not, and they are indistinguishable without this.
 */
export function stripLiterals(sql: string): string {
  let out = '';
  let index = 0;

  while (index < sql.length) {
    const two = sql.slice(index, index + 2);

    if (two === '--') {
      const end = sql.indexOf(NL, index);
      index = end === -1 ? sql.length : end;
      continue;
    }
    if (two === '/*') {
      const end = sql.indexOf('*/', index + 2);
      index = end === -1 ? sql.length : end + 2;
      out += ' ';
      continue;
    }

    const char = sql[index];
    if (char === "'" || char === '"') {
      const quote = char;
      index += 1;
      while (index < sql.length) {
        if (sql[index] === quote) {
          // A doubled quote is an escaped quote, not the end.
          if (sql[index + 1] === quote) index += 2;
          else break;
        } else {
          index += 1;
        }
      }
      index += 1;
      out += quote + quote;
      continue;
    }

    // $tag$ ... $tag$ dollar quoting.
    if (char === '$') {
      const match = /^\$[A-Za-z_]*\$/.exec(sql.slice(index));
      if (match) {
        const tag = match[0];
        const end = sql.indexOf(tag, index + tag.length);
        index = end === -1 ? sql.length : end + tag.length;
        out += ' ';
        continue;
      }
    }

    out += char;
    index += 1;
  }

  return out;
}

/** Keywords that write, wherever they appear — including inside a CTE. */
const WRITING = [
  'insert',
  'update',
  'delete',
  'truncate',
  'drop',
  'create',
  'alter',
  'grant',
  'revoke',
  'comment',
  'merge',
  'copy',
  'vacuum',
  'reindex',
  'cluster',
  'refresh',
  'call',
  'do',
  'set',
  'reset',
  'lock',
  'listen',
  'notify',
  'prepare',
  'execute',
  'begin',
  'commit',
  'rollback',
  'savepoint',
  'security',
] as const;

/**
 * Is this one read-only statement?
 *
 * Deliberately strict: a rejected legitimate query is an inconvenience, a
 * permitted write is data loss.
 */
export function checkReadOnly(sql: string): SqlVerdict {
  const raw = sql.trim();
  if (raw === '') return { ok: false, reason: 'The query is empty.' };
  if (raw.length > 20_000) return { ok: false, reason: 'That query is too long.' };

  const bare = stripLiterals(raw).trim();
  const lower = bare.toLowerCase();

  // One statement only. node-postgres sends a parameterless query over the
  // simple protocol, which happily runs "SELECT 1; DROP TABLE users".
  const withoutTrailing = bare.replace(/;\s*$/, '');
  if (withoutTrailing.includes(';')) {
    return {
      ok: false,
      reason: 'Only one statement at a time. Remove the semicolon and anything after it.',
    };
  }

  if (!/^(select|with|table|values|explain|show)\b/.test(lower)) {
    return {
      ok: false,
      reason: 'Only read queries are allowed: SELECT, WITH, TABLE, VALUES, SHOW or EXPLAIN.',
    };
  }

  // A WITH clause may contain INSERT, UPDATE or DELETE, and Postgres runs it.
  // This is the case the guide's check misses entirely.
  for (const keyword of WRITING) {
    const pattern = new RegExp('(?:^|[^A-Za-z0-9_])' + keyword + '(?:[^A-Za-z0-9_]|$)', 'i');
    if (pattern.test(lower)) {
      return {
        ok: false,
        reason:
          `That query contains "${keyword.toUpperCase()}", which can modify data. ` +
          'Only plain reads are allowed.',
      };
    }
  }

  // SELECT ... INTO creates a table.
  if (/\binto\b/.test(lower) && !/\binsert\b/.test(lower)) {
    return { ok: false, reason: 'SELECT ... INTO creates a table, which is a write.' };
  }

  // EXPLAIN ANALYZE executes the statement it is explaining. Postgres accepts
  // both spellings, so both are refused.
  if (/^explain\b/.test(lower) && /\banaly[sz]e\b/.test(lower)) {
    return { ok: false, reason: 'EXPLAIN ANALYZE runs the query it explains. Use plain EXPLAIN.' };
  }

  return { ok: true };
}

export function clampRows(requested: number | undefined): number {
  if (requested === undefined || !Number.isFinite(requested)) return DEFAULT_ROWS;
  return Math.min(MAX_ROWS, Math.max(1, Math.floor(requested)));
}

/**
 * A table name for `db_schema`.
 *
 * Passed as a parameter to information_schema, so injection is not the risk;
 * this keeps the error useful instead of returning an empty column list for
 * something that was never a table name.
 */
export function isValidIdentifier(name: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_$]{0,62}$/.test(name);
}

/** Hide the password before a connection string reaches a log or a model. */
export function redactConnectionString(url: string): string {
  return url.replace(/:\/\/([^:@/]+):[^@]*@/, '://$1:***@');
}
