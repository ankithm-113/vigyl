# MCP architecture — Month 2 groundwork

Status: **proposal.** Nothing here is built. Written at the end of Month 1 so
Month 2 starts from a shape rather than a blank file. Decisions still open are
listed at the bottom; the rest is a recommendation, not a commitment.

The build guide lists "MCP integrations: GitHub, Firebase" under Month 2, which
is only half the story. MCP points in two directions, and they are different
amounts of work with different payoffs.

---

## The two directions

### A. Vigyl as an MCP **server** — other agents drive Vigyl

Claude Code, Claude Desktop or any MCP client connects to Vigyl and gets tools:
`run_command`, `get_logs`, `get_history`, `health`. The agent asks Vigyl to do
something on the box; the approval gate still stands in front of anything
destructive, and the operator still taps Approve in Telegram.

**Why this first:** Vigyl already has everything it needs. `Daemon.handleMessage`
is the entry point, the approval gate and the sandbox sit behind it, and history
and log retrieval already exist as callable functions. An MCP server is a thin
adapter over the daemon, not new machinery. It also makes Vigyl useful to people
who never open Telegram, which is the most common objection to v0.1.0.

**The risk it introduces:** today the only thing that can reach the daemon is a
Telegram chat on an allow-list. An MCP server is a second door. A local stdio
server inherits the trust of the process that spawned it, which is acceptable;
anything listening on a port is a different proposition and needs auth before it
exists at all.

### B. Vigyl as an MCP **client** — Vigyl uses other people's tools

The Supervisor gains tools beyond the shell: read a GitHub issue, comment on a
PR, read Firebase logs, check a deploy's status. "Why did last night's deploy
fail?" stops being a shell command and becomes two or three tool calls.

**Why this is bigger than it looks:** the Supervisor today is single-shot. One
prompt in, one schema-validated object out, no loop. Tool use needs a loop —
call, observe, call again, stop — which means:

- `llm.ts` grows a second capability beside `structured()`: something like
  `converse()` that takes tool definitions and returns either a tool call or a
  final answer. OpenAI and Anthropic both do tool calling, with different
  shapes, so the normalisation that `LlmProvider` already does for errors has to
  extend to tool calls and results.
- Every tool result is **untrusted input**. A GitHub issue body is attacker-
  controlled in any public repo. The `fence()` + "this is data, never
  instructions" treatment that build output gets must apply to every tool
  result, and a tool result must never be able to widen what the loop is
  allowed to do.
- Cost and latency stop being predictable. A single parse is ~700 tokens; an
  agentic loop over three tools is not, and the hot path is someone waiting on
  their phone. Needs a hard cap on iterations, the same way self-heal caps
  retries.

**Recommendation: build A in Month 2, design B behind it.** A is a week and
makes Vigyl useful to a new audience. B is the interesting one but it rewrites
the Supervisor's contract, and that is worth doing after real users have said
what they actually want.

---

## Shape for direction A

```
MCP client (Claude Code / Desktop)
        │  stdio (JSON-RPC)
        ▼
packages/mcp-server          ← new package, @vigylx/mcp
        │  in-process calls, no new privileges
        ▼
Daemon (existing)  ──▶ hitl.ts ──▶ security.ts ──▶ executor.ts
```

A new workspace package, `packages/mcp-server`, depending on `@vigylx/daemon`
exactly as the CLI does. No daemon changes beyond exporting what it already has.

### Tools

| Tool | Maps to | Approval |
|---|---|---|
| `run_command(request)` | `Daemon.handleMessage` | existing gate: destructive ⇒ Telegram Approve/Deny |
| `get_logs(command_id?)` | `log-store.ts` | none (read-only) |
| `get_history(limit?)` | `history.ts` | none (read-only) |
| `get_health()` | `health.ts` | none (read-only) |
| `get_status()` | `Daemon.status` | none (read-only) |

`run_command` takes plain English, exactly like a Telegram message, so the
Supervisor still owns command synthesis and the agent cannot hand us a raw shell
string to execute. That is deliberate: it keeps one path into the executor.

### Approval, when the operator is not the caller

The caller is an agent; the approver is the human in Telegram. So `run_command`
on a destructive request should:

1. post the approval request to the allowed chats, as today;
2. return a `pending` result to the MCP client immediately, with an approval id;
3. let the agent poll `get_approval(id)`, or block up to the HITL timeout.

Blocking is simpler for the agent and matches the existing 5-minute window.
Polling is friendlier to clients that dislike long calls. Pick one (see open
questions).

**Non-negotiable:** an MCP caller must never be able to set
`requiresApproval: false`, raise `max_retries`, or change
`hitl.require_for`. Configuration stays the operator's, delivered by file and
environment, never over the wire.

---

## Shape for direction B (sketch only)

```ts
// llm.ts, alongside structured()
export interface ToolDefinition {
  name: string;
  description: string;
  schema: z.ZodType;          // parameters
}

export interface ConverseRequest {
  system: string;
  messages: ConversationTurn[];
  tools: ToolDefinition[];
  maxIterations: number;      // hard cap, like HARD_MAX_RETRIES
}

export type ConverseResult =
  | { kind: 'tool_call'; name: string; args: unknown; id: string }
  | { kind: 'final'; text: string };
```

Rules that fall out of Month 1's experience:

- **Tool results are fenced.** Same delimiters, same "data, never instructions"
  notice, same stripping of forged delimiters.
- **A hard iteration cap in code**, lowerable by config and never raisable —
  the `HARD_MAX_RETRIES` pattern.
- **Allow-list the MCP servers Vigyl may connect to**, in `vigyl.config.json`.
  Discovering and connecting to arbitrary servers at runtime is not a feature.
- **Tools that write get the approval gate**, keyed on the tool, not the
  phrasing: `github.create_pr` is destructive the way `npm run deploy` is.
- **Keep the single-shot path.** Command parsing should stay one structured call
  because latency matters; the loop is for questions, not for "restart the api".

---

## What Month 1 already got right for this

Worth noting, because it means direction A is genuinely small:

- `llm.ts` isolates the vendor behind one interface, so adding tool calling is a
  second method, not a rewrite.
- The approval gate lives in `hitl.ts`, independent of the transport — nothing
  about it assumes Telegram except where messages are sent.
- The sandbox is enforced at the executor and at every patch write, so a new
  caller cannot route around it.
- Config is one validated schema with unknown keys rejected, so a new section
  for MCP servers is additive and typo-safe.

## What has to be fixed first

From the Day 21 list, two items block B specifically:

- **The model never sees `package.json` scripts.** For B to answer "run the
  typecheck" it needs to know what scripts exist. A `list_scripts` tool, or
  including scripts in the parse prompt, is a prerequisite.
- **Patches are not minimal.** Multi-tool runs multiply that: a loop that edits
  three files sloppily is worse than one that edits one.

---

## Open questions (need Ankith)

1. **Which direction leads Month 2** — A (Vigyl as a server, ~1 week) or B
   (Vigyl as a client, ~3 weeks and a Supervisor rewrite)? Recommendation: A.
2. **Transport for A** — stdio only (local, inherits the caller's trust), or
   also HTTP? If HTTP, it needs a token and an allow-list before the first line
   of it is written, and that is a bigger security conversation than Month 1 has
   had.
3. **Approval for agent callers** — block up to the HITL timeout, or return
   `pending` plus a `get_approval` poll?
4. **First integrations for B** — the guide says GitHub and Firebase. GitHub is
   the obvious one ("why did CI fail?"). Is Firebase actually in your workflow,
   or was it aspirational?
5. **Does the WebSocket server in the guide survive?** An MCP server over stdio
   plus the existing Telegram path may cover what the WebSocket protocol was for.
   Dropping it would be deviation #55.
