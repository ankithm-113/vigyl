/**
 * MCP: the daemon's connection to the cloud services it can be asked about.
 *
 * Three jobs, deliberately separated:
 *
 *   `McpHub`     spawns the configured servers, discovers their tools, calls one.
 *   `toolGate`   decides whether a call needs a human first.
 *   `McpRouter`  turns "how many users signed up today?" into a tool and arguments.
 *
 * The gate is the part worth reading twice. An MCP tool can dispatch a
 * production deploy or open an issue in a public repository, and the thing
 * choosing which tool to call is a language model reading text written by
 * other people — a Firestore document, a pull request title, a database row.
 * So the decision to require approval is made from the tool's own declared
 * annotations and the operator's rules, never from what the model says about
 * its own request.
 */
import { logger } from './logger';

/** A server the daemon should spawn and talk to. */
export interface McpServerConfig {
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
  /** Fail the whole connection attempt after this long. */
  startupTimeoutMs?: number;
}

/** A tool, as discovered. */
export interface McpTool {
  name: string;
  description: string;
  serverId: string;
  inputSchema: Record<string, unknown>;
  /**
   * True only when the server said so explicitly.
   *
   * A tool that declares nothing is treated as a writer. Defaulting the other
   * way would mean a server that forgets its annotations silently loses the
   * approval gate, which is exactly the failure nobody notices until it
   * matters.
   */
  readOnly: boolean;
  destructive: boolean;
}

export interface McpToolCall {
  tool: string;
  serverId: string;
  args: Record<string, unknown>;
  /** One sentence for the person being asked to approve it. */
  description: string;
}

export interface McpCallResult {
  content: Array<{ type: string; text?: string }>;
  isError?: boolean;
}

/** How long a single tool call may take before the daemon gives up. */
export const TOOL_TIMEOUT_MS = 10_000;

/** How long a server has to start and answer a tool listing. */
export const STARTUP_TIMEOUT_MS = 20_000;

// ---------------------------------------------------------------------------
// The approval gate
// ---------------------------------------------------------------------------

export interface ToolGateVerdict {
  needsApproval: boolean;
  reasons: string[];
}

/**
 * Does this call need a human?
 *
 * Fails closed in three ways: an unknown tool needs approval, a tool that did
 * not declare itself read-only needs approval, and the operator's keyword rules
 * are checked against the arguments as well as the name — because
 * `create_issue` is harmless and `create_issue` with a body naming production
 * may not be.
 */
export function toolGate(
  tool: McpTool | undefined,
  call: McpToolCall,
  triggers: readonly string[] = [],
): ToolGateVerdict {
  const reasons: string[] = [];

  if (!tool) {
    return {
      needsApproval: true,
      reasons: [`"${call.tool}" is not a tool this daemon knows about`],
    };
  }

  if (tool.destructive) reasons.push('the tool declares itself destructive');
  else if (!tool.readOnly) reasons.push('the tool is not read-only');

  const haystack = `${call.tool} ${JSON.stringify(call.args)}`.toLowerCase();
  for (const trigger of triggers) {
    const needle = trigger.trim().toLowerCase();
    if (needle !== '' && haystack.includes(needle)) {
      reasons.push(`it mentions "${trigger}", which you asked to be warned about`);
    }
  }

  return { needsApproval: reasons.length > 0, reasons };
}

// ---------------------------------------------------------------------------
// The hub
// ---------------------------------------------------------------------------

/** The MCP client surface used here, so tests can supply a fake. */
export interface McpClientLike {
  listTools(): Promise<{
    tools: Array<{
      name: string;
      description?: string;
      inputSchema?: unknown;
      annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean };
    }>;
  }>;
  callTool(request: { name: string; arguments: Record<string, unknown> }): Promise<unknown>;
  close(): Promise<void>;
}

export type McpClientFactory = (config: McpServerConfig) => Promise<McpClientLike>;

export class McpHub {
  private readonly clients = new Map<string, McpClientLike>();
  private tools: McpTool[] = [];
  private readonly factory: McpClientFactory;
  private readonly timeoutMs: number;

  constructor(
    private readonly servers: readonly McpServerConfig[],
    options: { factory?: McpClientFactory; timeoutMs?: number } = {},
  ) {
    this.factory = options.factory ?? defaultClientFactory;
    this.timeoutMs = options.timeoutMs ?? TOOL_TIMEOUT_MS;
  }

  get connectedServers(): string[] {
    return [...this.clients.keys()];
  }

  /**
   * Connect to every configured server.
   *
   * One server failing does not stop the others: a missing Firebase key should
   * not cost the operator their GitHub tools. Failures are logged and the tool
   * simply is not offered.
   */
  async init(): Promise<void> {
    for (const config of this.servers) {
      try {
        await this.connect(config);
      } catch (error) {
        logger.warn('MCP server failed to connect', {
          server: config.name,
          error: (error as Error).message,
        });
      }
    }
    logger.info('MCP ready', { servers: this.clients.size, tools: this.tools.length });
  }

  private async connect(config: McpServerConfig): Promise<void> {
    const client = await withTimeout(
      this.factory(config),
      config.startupTimeoutMs ?? STARTUP_TIMEOUT_MS,
      `${config.name} did not start`,
    );

    const listed = await withTimeout(
      client.listTools(),
      config.startupTimeoutMs ?? STARTUP_TIMEOUT_MS,
      `${config.name} did not list its tools`,
    );

    for (const tool of listed.tools) {
      const annotations = tool.annotations ?? {};
      this.tools.push({
        name: tool.name,
        description: tool.description ?? '',
        serverId: config.name,
        inputSchema: (tool.inputSchema as Record<string, unknown>) ?? {},
        readOnly: annotations.readOnlyHint === true,
        destructive: annotations.destructiveHint === true,
      });
    }

    this.clients.set(config.name, client);
    logger.info('MCP server connected', { server: config.name, tools: listed.tools.length });
  }

  getToolManifest(): readonly McpTool[] {
    return this.tools;
  }

  findTool(name: string): McpTool | undefined {
    return this.tools.find((tool) => tool.name === name);
  }

  /**
   * Call a tool.
   *
   * Does not consult the gate: approval is the caller's decision, made before
   * this is reached. Keeping the two apart means a future caller cannot
   * accidentally inherit a "already approved" flag from somewhere.
   */
  async callTool(name: string, args: Record<string, unknown>): Promise<McpCallResult> {
    const tool = this.findTool(name);
    if (!tool) throw new Error(`No such tool: ${name}`);

    const client = this.clients.get(tool.serverId);
    if (!client) throw new Error(`MCP server not connected: ${tool.serverId}`);

    const started = Date.now();
    const result = (await withTimeout(
      client.callTool({ name, arguments: args }),
      this.timeoutMs,
      `${name} did not answer within ${this.timeoutMs}ms`,
    )) as McpCallResult;

    logger.info('MCP tool called', {
      tool: name,
      server: tool.serverId,
      durationMs: Date.now() - started,
      isError: result?.isError === true,
    });

    return result;
  }

  async close(): Promise<void> {
    for (const [name, client] of this.clients) {
      try {
        await client.close();
      } catch (error) {
        logger.warn('MCP server did not close cleanly', { server: name });
      }
    }
    this.clients.clear();
    this.tools = [];
  }
}

/** Flatten an MCP result into text for a Telegram message. */
export function resultToText(result: McpCallResult): string {
  return result.content
    .map((part) => part.text ?? '')
    .filter((text) => text !== '')
    .join(String.fromCharCode(10));
}

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

/**
 * Should this message go to a tool at all?
 *
 * Cheap pre-filter so an ordinary "run the tests" never costs an extra model
 * call. It only has to be roughly right: the router returns "none" for anything
 * that does not fit, and a missed tool call falls through to the normal shell
 * path, which is the safe direction to be wrong in.
 */
export function mightNeedTool(message: string, tools: readonly McpTool[]): boolean {
  if (tools.length === 0) return false;

  const text = message.toLowerCase();
  const hints = [
    'user',
    'sign up',
    'signup',
    'signed up',
    'firestore',
    'firebase',
    'collection',
    'database',
    'db ',
    'sql',
    'query',
    'table',
    'row',
    'schema',
    'pull request',
    ' pr',
    'pr ',
    'ci ',
    ' ci',
    'checks',
    'workflow',
    'commit',
    'issue',
    'github',
    'how many',
    'did the',
    'is the',
  ];
  return hints.some((hint) => text.includes(hint));
}

export interface RouteDecision {
  call?: McpToolCall;
  /** Why no tool was chosen, when none was. */
  reason?: string;
}

/**
 * The structured answer the model gives when choosing a tool.
 *
 * `args` is a JSON string rather than an object because every tool has a
 * different shape and a single schema cannot describe all of them. It is parsed
 * defensively here, and the server validates it properly afterwards.
 */
export interface ToolChoice {
  toolName: string;
  argsJson: string;
  description: string;
}

export function parseToolChoice(
  choice: ToolChoice,
  tools: readonly McpTool[],
): RouteDecision {
  const name = choice.toolName?.trim() ?? '';
  if (name === '' || name.toLowerCase() === 'none') {
    return { reason: 'no tool fits this request' };
  }

  const tool = tools.find((candidate) => candidate.name === name);
  if (!tool) {
    // A model inventing a tool name must not reach the hub, where an unknown
    // name would otherwise be an exception in the middle of a chat.
    return { reason: `the model asked for "${name}", which does not exist` };
  }

  let args: unknown;
  try {
    args = JSON.parse(choice.argsJson?.trim() || '{}');
  } catch {
    return { reason: `the model's arguments for ${name} were not valid JSON` };
  }
  if (typeof args !== 'object' || args === null || Array.isArray(args)) {
    return { reason: `the model's arguments for ${name} were not an object` };
  }

  const description = choice.description?.trim();
  return {
    call: {
      tool: tool.name,
      serverId: tool.serverId,
      args: args as Record<string, unknown>,
      description: description && description !== '' ? description : `run ${tool.name}`,
    },
  };
}

/** The tool list as the model sees it, smallest thing that is still useful. */
export function describeTools(tools: readonly McpTool[]): string {
  const NL = String.fromCharCode(10);
  return tools
    .map((tool) => {
      const properties = (tool.inputSchema?.properties ?? {}) as Record<string, unknown>;
      const names = Object.keys(properties);
      const shape = names.length > 0 ? ` (${names.join(', ')})` : '';
      const mark = tool.readOnly ? '' : ' [needs approval]';
      return `- ${tool.name}${shape}: ${tool.description}${mark}`;
    })
    .join(NL);
}

async function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), ms);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Spawn a server over stdio.
 *
 * The MCP SDK is ESM with a CommonJS `require` condition, so a plain require
 * works here — unlike node-llama-cpp and Octokit, which need dynamic import.
 */
async function defaultClientFactory(config: McpServerConfig): Promise<McpClientLike> {
  // Required lazily: a daemon with no MCP servers configured should not pay to
  // load the SDK, and the package is an optional dependency.
  /* eslint-disable @typescript-eslint/no-var-requires */
  const { Client } = require('@modelcontextprotocol/sdk/client/index.js') as {
    Client: new (info: { name: string; version: string }, options: { capabilities: object }) => McpClientLike & {
      connect(transport: unknown): Promise<void>;
    };
  };
  const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js') as {
    StdioClientTransport: new (options: {
      command: string;
      args: string[];
      env: Record<string, string>;
      stderr: string;
    }) => unknown;
  };
  /* eslint-enable @typescript-eslint/no-var-requires */

  // Only split the command when no args were given. The build guide always
  // splits on spaces, which breaks every Windows path: "C:\Program
  // Files\nodejs\node.exe" becomes "C:\Program" with "Files\nodejs\node.exe"
  // as its first argument, and the server dies before saying anything useful.
  const explicitArgs = config.args ?? [];
  const [splitCommand, ...splitArgs] =
    explicitArgs.length > 0 ? [config.command] : config.command.split(' ');

  const transport = new StdioClientTransport({
    command: splitCommand ?? config.command,
    args: [...splitArgs, ...explicitArgs],
    // The server's own environment, plus whatever the config adds. Credentials
    // reach the child this way and never through the command line, where they
    // would show up in a process listing.
    env: { ...(process.env as Record<string, string>), ...(config.env ?? {}) },
    stderr: 'pipe',
  });

  const client = new Client({ name: 'vigyl-daemon', version: '0.2.0' }, { capabilities: {} });
  await client.connect(transport);
  return client;
}
