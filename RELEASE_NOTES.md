# Vigyl v0.1.0 — private beta

**Control your server from Telegram, in plain English.** Send your bot "run the
tests" and it runs them. If the build breaks, Vigyl reads the error, patches the
file and runs it again — and it asks you first before anything destructive.

```
you  ▸ run the build
bot  ▸ 🧠 Working out what to run...
     ▸ ▶ Running (attempt 1/4): npm run build
     ▸ ✗ Failed (exit 1) — build_error: src/app.ts(12,5): error TS2304
     ▸ 🔧 Asking the model for a fix...
     ▸ ✍ Patched src/app.ts: added the missing import
     ▸ ▶ Running (attempt 2/4): npm run build
     ▸ ✅ Done — succeeded on attempt 2 after self-healing.
```

## Install

```bash
npm install -g @vigylx/cli
cd ~/my-project
vigyl init     # validates your credentials before writing anything
vigyl start
```

Node 20 or newer. Linux, macOS and Windows. You need a Telegram bot token from
[@BotFather](https://t.me/BotFather) and an
[OpenAI API key](https://platform.openai.com/api-keys) — `gpt-4o-mini` by
default, well under a cent per command.

## What works

- **Plain-English commands.** Your message becomes exactly one shell command,
  returned as schema-validated structured output, then run in a real PTY with
  live output streamed back to Telegram.
- **Self-healing.** On failure the output is classified, the model is shown the
  failing file *plus the local files it imports* (up to 3 hops), and it proposes
  a patch. Up to 3 retries. Every overwrite is backed up first.
- **Approval gate.** Anything destructive — production, deletes, migrations,
  pushes, `.env` reads — comes back with Approve / Deny buttons. The keyword
  rules are yours and apply regardless of what the model thinks.
- **Path sandbox.** Every path is canonicalised (symlinks resolved) and checked
  for containment in your workspace. A patch aimed outside it is rejected and
  logged.
- **Two providers.** OpenAI by default, Anthropic supported; one interface, the
  same normalised errors either way.
- **Operations.** `vigyl doctor` checks environment, config and live
  credentials in one pass. Sessions, durable command history, `/history`,
  `/repeat`, full log retrieval, and health alerts for CPU, memory and disk.
- **Secrets stay out of logs.** Every log record is redacted: credential-shaped
  fields, plus OpenAI, Anthropic and bot-token patterns in free text.

402 tests (385 daemon, 17 CLI), including tests that run real commands and
patch real files on disk.

## Verified live, not just in tests

Driven from a real Telegram bot against `gpt-4o-mini`:

| Scenario | Result |
|---|---|
| Failing unit test (`sum()` subtracted instead of adding) | healed in one attempt |
| TypeScript `TS2322` type error | healed in one attempt |
| Bug two imports deep (`test → cart → tax`) | healed after the import-follower learned to go deeper |
| Real OSS project — a `TS2551` typo injected into [`sindresorhus/ts-extras`](https://github.com/sindresorhus/ts-extras) | healed in one attempt, ~9 s |
| Missing npm package | correctly refused to patch — no model call |
| "deploy to production" | held for approval, ran only after Approve |

The first live run **failed**, and that is the interesting part: the model was
only ever shown the file at the top of the stack trace, so it "fixed" the test
instead of the bug. Four self-heal guards came out of these runs — follow
imports, send whole files, patch only a file the model saw in full, and reject a
patch that changes nothing.

## Known limitations

- **Live testing is one developer's sandbox**, on Windows, on `gpt-4o-mini`. A
  handful of scenarios, not real-world mileage.
- **Anthropic has never run against a live key.** Same interface, unit-tested
  only.
- **One file per patch attempt**, files under 60 KB only. Bugs needing
  coordinated edits across files will stop rather than be fixed.
- **Patches are not always minimal** — the model sometimes adds a comment it
  was not asked for.
- **The model never sees your `package.json` scripts**, so name the script you
  mean ("run npm run typecheck", not "check the types").
- One workspace per daemon. Telegram only. Memory is the last few turns.
- pwsh and POSIX shell paths are written but lightly exercised.

## Security

Vigyl runs real commands on your server. The boundary is the path sandbox plus
the approval gate plus running as a non-root user — **not** the command
blocklist, which is a speed bump for accidents. Build output is treated as
untrusted input to the model (any dependency's postinstall script can print
whatever it likes), fenced in delimiters, and nothing the model returns is
trusted: every path is re-validated before a write.

Threat model and what Vigyl does *not* protect against:
[docs/SECURITY.md](docs/SECURITY.md).

## Feedback

This is a private beta and the install path has been walked by one person. If
`vigyl doctor` says something confusing, or self-heal does something daft,
[open an issue](https://github.com/ankithm-113/vigyl/issues) — that is exactly
what v0.2.0 gets built from.

Packages: [`@vigylx/cli`](https://www.npmjs.com/package/@vigylx/cli) ·
[`@vigylx/daemon`](https://www.npmjs.com/package/@vigylx/daemon)
