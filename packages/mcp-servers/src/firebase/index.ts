#!/usr/bin/env node
/**
 * Firebase MCP server.
 *
 * Answers questions about a Firebase project over stdio, so Vigyl can turn
 * "how many users signed up today?" into a real number.
 *
 * Read-only by design: nothing here writes, deletes or changes configuration.
 * A tool that could delete a collection would be one prompt injection away from
 * doing it, and the approval gate lives in the daemon, not here.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import { dataResult, errorResult } from '../shared/untrusted';
import { loadServiceAccount } from './credentials';
import {
  DEFAULT_LIMIT,
  MAX_AUTH_PAGES,
  MAX_LIMIT,
  WHERE_OPERATORS,
  clampLimit,
  isAllowedCollection,
  isValidTimeZone,
  startOfToday,
} from './query';

/** firebase-admin v13 dropped the `import * as admin` namespace the guide uses. */
type Firestore = import('firebase-admin/firestore').Firestore;
type Auth = import('firebase-admin/auth').Auth;

const SERVER_NAME = 'vigyl-firebase';
const VERSION = '0.2.0';

/** Where the operator is, for anything that means "today". */
const DEFAULT_TIME_ZONE = process.env.VIGYL_TIMEZONE?.trim() || 'UTC';

interface FirebaseHandles {
  db: Firestore;
  auth: Auth;
  projectId: string;
}

async function connect(): Promise<FirebaseHandles> {
  const account = loadServiceAccount();

  const { initializeApp, cert } = await import('firebase-admin/app');
  const { getFirestore } = await import('firebase-admin/firestore');
  const { getAuth } = await import('firebase-admin/auth');

  const app = initializeApp({
    credential: cert({
      projectId: account.project_id,
      clientEmail: account.client_email,
      privateKey: account.private_key,
    }),
  });
  return { db: getFirestore(app), auth: getAuth(app), projectId: account.project_id };
}

/**
 * Walk Auth users, with a ceiling.
 *
 * Returns `exact: false` when the ceiling was hit, so the caller can say "at
 * least" instead of stating a wrong number confidently.
 */
async function countUsers(
  auth: Auth,
  since?: Date,
): Promise<{ count: number; exact: boolean; scanned: number }> {
  let count = 0;
  let scanned = 0;
  let pageToken: string | undefined;
  let pages = 0;

  do {
    const page = await auth.listUsers(1000, pageToken);
    scanned += page.users.length;
    count += since
      ? page.users.filter((user) => {
          const created = user.metadata.creationTime;
          return created !== undefined && new Date(created) >= since;
        }).length
      : page.users.length;
    pageToken = page.pageToken;
    pages += 1;
  } while (pageToken && pages < MAX_AUTH_PAGES);

  return { count, exact: pageToken === undefined, scanned };
}

/**
 * Declared outside the call because zod's inference on the nested object
 * exceeds TypeScript's instantiation depth when inlined into registerTool.
 */
const FIRESTORE_QUERY_SHAPE = {
  collection: z
    .string()
    .describe('Collection name, e.g. "users". A subcollection path like "users/u1/sessions" also works.'),
  limit: z
    .number()
    .int()
    .optional()
    .describe(`How many documents to return (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT}).`),
  orderBy: z.string().optional().describe('Field to order by.'),
  direction: z.enum(['asc', 'desc']).optional().describe('Order direction, default asc.'),
  where: z
    .object({
      field: z.string(),
      operator: z.enum(['==', '!=', '<', '<=', '>', '>=']),
      value: z.union([z.string(), z.number(), z.boolean()]),
    })
    .optional()
    .describe('Optional filter.'),
};

interface FirestoreQueryArgs {
  collection: string;
  limit?: number;
  orderBy?: string;
  direction?: 'asc' | 'desc';
  where?: { field: string; operator: string; value: string | number | boolean };
}

/** What a tool hands back to the model. */
type ToolResult = { content: Array<{ type: 'text'; text: string }>; isError?: boolean };

/**
 * `registerTool` is generic over the zod shape, and inferring through those
 * generics makes the compiler walk the whole schema type: with the nested
 * `where` object it exceeds the instantiation depth limit, and annotating the
 * shape as ZodRawShape instead makes tsc run out of memory outright.
 *
 * The schemas are still real zod objects and the SDK still validates with them
 * at runtime. Only the compile-time inference is given up, and each handler
 * declares its own argument type in exchange.
 */
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

export function registerFirebaseTools(server: McpServer, handles: FirebaseHandles): void {
  const { db, auth, projectId } = handles;
  const registerTool = server.registerTool.bind(server) as unknown as RegisterTool;

  registerTool(
    'firestore_query',
    {
      title: 'Query Firestore',
      description:
        'Read documents from a Firestore collection, newest first if an orderBy ' +
        'is given. Read-only. Returns at most ' + MAX_LIMIT + ' documents.',
      inputSchema: FIRESTORE_QUERY_SHAPE,
      annotations: { readOnlyHint: true },
    },
    async (raw: never): Promise<ToolResult> => {
      const args = raw as FirestoreQueryArgs;
      const { collection, limit, orderBy, direction, where } = args;
      if (!isAllowedCollection(collection)) {
        return errorResult(
          `"${collection}" is not a collection name this server will read. Use a ` +
            'plain name such as "users", or a subcollection path such as "users/u1/sessions".',
        );
      }
      const operator = WHERE_OPERATORS.find((candidate) => candidate === where?.operator);
      if (where && !operator) {
        return errorResult(`Unsupported operator: ${where.operator}`);
      }

      const capped = clampLimit(limit);

      try {
        let query = db.collection(collection) as FirebaseFirestore.Query;
        if (where && operator) query = query.where(where.field, operator, where.value);
        if (orderBy) query = query.orderBy(orderBy, direction ?? 'asc');
        query = query.limit(capped);

        const snapshot = await query.get();
        const documents = snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));

        return dataResult(`firestore ${projectId}/${collection}`, {
          collection,
          returned: documents.length,
          limit: capped,
          truncated: documents.length === capped,
          documents,
        });
      } catch (error) {
        return errorResult(describeFirestoreError(error, collection, orderBy));
      }
    },
  );

  registerTool(
    'auth_user_count',
    {
      title: 'Count Firebase Auth users',
      description: 'Total number of users in Firebase Authentication.',
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async (): Promise<ToolResult> => {
      try {
        const { count, exact, scanned } = await countUsers(auth);
        return dataResult(`firebase auth ${projectId}`, {
          totalUsers: count,
          exact,
          note: exact
            ? undefined
            : `Stopped after scanning ${scanned} users; the real total is higher.`,
        });
      } catch (error) {
        return errorResult(describeAuthError(error));
      }
    },
  );

  registerTool(
    'auth_users_today',
    {
      title: 'Count sign-ups today',
      description:
        'How many Firebase Auth users were created since midnight in the ' +
        'configured time zone. Note: Firebase reports the real creation time, ' +
        'which cannot be backdated, so seeded test users all appear as today.',
      inputSchema: {
        timeZone: z
          .string()
          .optional()
          .describe(`IANA time zone deciding when "today" starts (default ${DEFAULT_TIME_ZONE}).`),
      },
      annotations: { readOnlyHint: true },
    },
    async (raw: never): Promise<ToolResult> => {
      const { timeZone } = raw as { timeZone?: string };
      const zone = timeZone?.trim() || DEFAULT_TIME_ZONE;
      if (!isValidTimeZone(zone)) {
        return errorResult(`"${zone}" is not a time zone this system knows. Use an IANA name like Asia/Kolkata.`);
      }

      try {
        const since = startOfToday(zone);
        const { count, exact, scanned } = await countUsers(auth, since);
        return dataResult(`firebase auth ${projectId}`, {
          signupsToday: count,
          since: since.toISOString(),
          timeZone: zone,
          exact,
          note: exact ? undefined : `Stopped after scanning ${scanned} users; there may be more.`,
        });
      } catch (error) {
        return errorResult(describeAuthError(error));
      }
    },
  );
}

/**
 * Turn a Firestore failure into something the operator can act on.
 *
 * The raw error is not relayed: it can carry the project id, internal hostnames
 * and occasionally a token fragment. The missing-index case gets its own
 * message because it is the one every new query hits and the fix is specific.
 */
function describeFirestoreError(error: unknown, collection: string, orderBy?: string): string {
  const code = (error as { code?: string | number }).code;
  const message = String((error as Error)?.message ?? error);

  if (/requires an index/i.test(message)) {
    return (
      `Firestore needs a composite index for this query on "${collection}"` +
      (orderBy ? ` (filtering and ordering by "${orderBy}")` : '') +
      '. Create it in the Firebase console, then ask again.'
    );
  }
  if (code === 7 || /permission|PERMISSION_DENIED/i.test(message)) {
    return `The service account is not allowed to read "${collection}".`;
  }
  if (code === 5 || /NOT_FOUND/i.test(message)) {
    return `No collection named "${collection}" in this project.`;
  }
  if (/UNAVAILABLE|ECONNREFUSED|ENOTFOUND|deadline/i.test(message)) {
    return 'Could not reach Firestore. Check the network and try again.';
  }
  return `Firestore query on "${collection}" failed.`;
}

function describeAuthError(error: unknown): string {
  const message = String((error as Error)?.message ?? error);
  if (/insufficient permission|PERMISSION_DENIED/i.test(message)) {
    return 'The service account is not allowed to list Authentication users.';
  }
  if (/UNAVAILABLE|ECONNREFUSED|ENOTFOUND|deadline/i.test(message)) {
    return 'Could not reach Firebase Authentication. Check the network and try again.';
  }
  return 'Reading Firebase Authentication failed.';
}

/**
 * Top-level await does not compile under `module: commonjs`, which is what the
 * build guide's version used. This is the same server, started properly.
 */
async function main(): Promise<void> {
  const handles = await connect();
  const server = new McpServer({ name: SERVER_NAME, version: VERSION });
  registerFirebaseTools(server, handles);

  // stdout is the protocol channel: anything written to it that is not a
  // message corrupts the stream, so diagnostics go to stderr.
  await server.connect(new StdioServerTransport());
  process.stderr.write(`${SERVER_NAME} ready for project ${handles.projectId}\n`);
}

if (require.main === module) {
  main().catch((error: unknown) => {
    process.stderr.write(`${SERVER_NAME} failed to start: ${(error as Error).message}\n`);
    process.exit(1);
  });
}
