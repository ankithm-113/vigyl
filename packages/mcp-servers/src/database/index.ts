#!/usr/bin/env node
/**
 * Database MCP server.
 *
 * Three tools: run a read query, check the connection, describe a table.
 *
 * Read-only is enforced twice, and the second one is the real boundary:
 *
 *   1. `checkReadOnly` rejects anything that is not plainly a read. This is a
 *      typo filter — it gives a clear message for an obvious mistake.
 *   2. Every query runs inside `BEGIN TRANSACTION READ ONLY`, which Postgres
 *      enforces itself and which the string check cannot be talked out of.
 *
 * The build guide had only the string check. Against a real database that
 * allowed a data-modifying CTE to delete a row and `SELECT 1; DROP TABLE x` to
 * drop a table, both of which its check called read-only.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import { dataResult, errorResult } from '../shared/untrusted';
import {
  DEFAULT_ROWS,
  MAX_ROWS,
  STATEMENT_TIMEOUT_MS,
  checkReadOnly,
  clampRows,
  isValidIdentifier,
  redactConnectionString,
} from './sql';

const SERVER_NAME = 'vigyl-database';
const VERSION = '0.2.0';

type ToolResult = { content: Array<{ type: 'text'; text: string }>; isError?: boolean };

type RegisterTool = (
  name: string,
  config: {
    title: string;
    description: string;
    inputSchema: Record<string, unknown>;
    annotations?: Record<string, unknown>;
  },
  handler: (args: never) => Promise<ToolResult>,
) => void;

/** The slice of `pg` used here, so tests can supply a fake. */
export interface QueryResult {
  rows: Array<Record<string, unknown>>;
  rowCount: number | null;
  fields?: Array<{ name: string; dataTypeID?: number }>;
}

export interface PoolClient {
  query(sql: string, values?: unknown[]): Promise<QueryResult>;
  release(): void;
}

export interface DatabasePool {
  connect(): Promise<PoolClient>;
  query(sql: string, values?: unknown[]): Promise<QueryResult>;
  end(): Promise<void>;
  readonly totalCount?: number;
  readonly idleCount?: number;
  readonly waitingCount?: number;
}

/**
 * Run one statement inside a read-only transaction.
 *
 * The transaction is always rolled back: nothing a read does needs committing,
 * and a rollback cannot leave anything behind.
 */
export async function runReadOnly(
  pool: DatabasePool,
  sql: string,
  values: unknown[],
  timeoutMs = STATEMENT_TIMEOUT_MS,
): Promise<QueryResult> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN TRANSACTION READ ONLY');
    // LOCAL: scoped to this transaction, so it cannot leak into a pooled
    // connection the next caller gets.
    await client.query(`SET LOCAL statement_timeout = ${Math.floor(timeoutMs)}`);
    return await client.query(sql, values);
  } finally {
    try {
      await client.query('ROLLBACK');
    } catch {
      // A connection that died mid-query cannot be rolled back; releasing it is
      // what matters.
    }
    client.release();
  }
}

export function registerDatabaseTools(server: McpServer, pool: DatabasePool): void {
  const registerTool = server.registerTool.bind(server) as unknown as RegisterTool;

  registerTool(
    'db_query',
    {
      title: 'Run a read-only SQL query',
      description:
        'Run one SELECT (or WITH / TABLE / VALUES / SHOW / EXPLAIN) and return ' +
        `the rows. Read-only: the query runs in a read-only transaction. Up to ${MAX_ROWS} rows.`,
      inputSchema: {
        sql: z.string().describe('One read-only SQL statement. No semicolons, no writes.'),
        params: z
          .array(z.union([z.string(), z.number(), z.boolean()]))
          .optional()
          .describe('Values for $1, $2 … placeholders. Prefer these over string interpolation.'),
        limit: z
          .number()
          .int()
          .optional()
          .describe(`Maximum rows to return (default ${DEFAULT_ROWS}, max ${MAX_ROWS}).`),
      },
      annotations: { readOnlyHint: true },
    },
    async (raw: never): Promise<ToolResult> => {
      const args = raw as { sql: string; params?: unknown[]; limit?: number };
      const sql = args.sql ?? '';

      const verdict = checkReadOnly(sql);
      if (!verdict.ok) return errorResult(verdict.reason ?? 'That query was refused.');

      const maxRows = clampRows(args.limit);

      try {
        const result = await runReadOnly(pool, sql.trim(), args.params ?? []);
        const rows = result.rows.slice(0, maxRows);

        return dataResult('sql result', {
          rowCount: result.rowCount ?? rows.length,
          returned: rows.length,
          truncated: result.rows.length > rows.length,
          columns: result.fields?.map((field) => field.name),
          rows,
        });
      } catch (error) {
        return errorResult(describeDatabaseError(error));
      }
    },
  );

  registerTool(
    'db_health',
    {
      title: 'Check the database connection',
      description: 'Round-trip latency and connection pool state.',
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async (): Promise<ToolResult> => {
      const started = Date.now();
      try {
        const result = await pool.query('SELECT 1 AS ok');
        const latencyMs = Date.now() - started;

        return dataResult('database health', {
          status: result.rows.length === 1 ? 'connected' : 'unexpected response',
          latencyMs,
          pool: {
            total: pool.totalCount ?? null,
            idle: pool.idleCount ?? null,
            waiting: pool.waitingCount ?? null,
          },
        });
      } catch (error) {
        // Health is the tool someone runs when things are broken, so the
        // failure itself is the answer rather than an exception.
        return dataResult('database health', {
          status: 'unreachable',
          latencyMs: Date.now() - started,
          detail: describeDatabaseError(error),
        });
      }
    },
  );

  registerTool(
    'db_schema',
    {
      title: 'Describe a table',
      description: 'Columns, types, nullability and defaults for one table.',
      inputSchema: {
        table: z.string().describe('Table name, without the schema.'),
        schema: z.string().optional().describe('Schema name, default public.'),
      },
      annotations: { readOnlyHint: true },
    },
    async (raw: never): Promise<ToolResult> => {
      const args = raw as { table: string; schema?: string };
      const table = args.table?.trim() ?? '';
      const schema = args.schema?.trim() || 'public';

      if (!isValidIdentifier(table)) return errorResult(`"${table}" is not a table name.`);
      if (!isValidIdentifier(schema)) return errorResult(`"${schema}" is not a schema name.`);

      try {
        const result = await runReadOnly(
          pool,
          `SELECT column_name, data_type, is_nullable, column_default
             FROM information_schema.columns
            WHERE table_schema = $1 AND table_name = $2
            ORDER BY ordinal_position`,
          [schema, table],
        );

        if (result.rows.length === 0) {
          return errorResult(
            `No table "${table}" in schema "${schema}" — or the user cannot see it.`,
          );
        }

        return dataResult(`schema of ${schema}.${table}`, {
          table: `${schema}.${table}`,
          columns: result.rows.map((row) => ({
            name: row.column_name,
            type: row.data_type,
            nullable: row.is_nullable === 'YES',
            default: row.column_default ?? null,
          })),
        });
      } catch (error) {
        return errorResult(describeDatabaseError(error));
      }
    },
  );
}

/**
 * Describe a failure without relaying the driver's message.
 *
 * A `pg` error can carry the connection string, the host and the full query
 * text, and this goes into a prompt.
 */
export function describeDatabaseError(error: unknown): string {
  const code = (error as { code?: string }).code;
  const message = String((error as Error)?.message ?? error);

  switch (code) {
    case '42P01':
      return 'That table does not exist.';
    case '42703':
      return 'That column does not exist.';
    case '42601':
      return 'The SQL could not be parsed. Check the syntax.';
    case '42501':
      return 'The database user is not allowed to read that.';
    case '28P01':
      return 'The database rejected the credentials.';
    case '3D000':
      return 'That database does not exist.';
    case '57014':
      return `The query was cancelled for taking longer than ${STATEMENT_TIMEOUT_MS / 1000} seconds.`;
    case '53300':
      return 'The database has too many connections open.';
    case '25006':
      return 'That statement tried to write inside a read-only transaction.';
    case 'ECONNREFUSED':
    case 'ENOTFOUND':
    case 'ETIMEDOUT':
      return 'Could not reach the database. Check it is running and reachable.';
    default:
      break;
  }

  if (/timeout|timed out/i.test(message)) return 'The database did not answer in time.';
  if (/self.signed|certificate/i.test(message)) return 'The database TLS certificate was rejected.';
  return 'The database query failed.';
}

/**
 * Build the pool.
 *
 * `pg` is CommonJS, so no dynamic-import dance is needed here.
 */
export async function createPool(
  env: Record<string, string | undefined> = process.env,
): Promise<DatabasePool> {
  const url = env.DATABASE_URL?.trim();
  if (!url) {
    throw new Error('DATABASE_URL is not set. It should be a postgresql:// connection string.');
  }
  if (!/^postgres(ql)?:\/\//.test(url)) {
    throw new Error('DATABASE_URL must be a postgresql:// connection string.');
  }

  const type = env.VIGYL_DB_TYPE?.trim().toLowerCase() || 'postgres';
  if (type !== 'postgres' && type !== 'postgresql') {
    throw new Error(
      `VIGYL_DB_TYPE=${type} is not supported yet. This server speaks Postgres; ` +
        'MySQL is not implemented.',
    );
  }

  const { Pool } = await import('pg');
  return new Pool({
    connectionString: url,
    // Small: this serves one operator's questions, not an application.
    max: 3,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    application_name: 'vigyl-mcp',
  }) as unknown as DatabasePool;
}

async function main(): Promise<void> {
  const pool = await createPool();
  const server = new McpServer({ name: SERVER_NAME, version: VERSION });
  registerDatabaseTools(server, pool);

  await server.connect(new StdioServerTransport());

  const where = redactConnectionString(process.env.DATABASE_URL ?? '');
  process.stderr.write(`${SERVER_NAME} ready, read-only, ${where}\n`);
}

if (require.main === module) {
  main().catch((error: unknown) => {
    process.stderr.write(`${SERVER_NAME} failed to start: ${(error as Error).message}\n`);
    process.exit(1);
  });
}
