# Vigyl

**Control your server from Telegram, in plain English.**

Send your bot "run the test suite" and it runs. Send "deploy to staging" and it
deploys. If a build fails, Vigyl reads the error, tries to fix it, and runs it
again — and asks you first before anything destructive.

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

---

## Status

**v0.1.0 — early beta.** Built and tested, but young. Read
[What is not proven yet](#what-is-not-proven-yet) before pointing it at
anything you care about.

---

## Install

```bash
npm install -g @vigylx/cli
```

Or the one-liner:

```bash
curl -fsSL https://raw.githubusercontent.com/ankithm-113/vigyl/main/scripts/install.sh | bash
```

Windows (PowerShell):

```powershell
irm https://raw.githubusercontent.com/ankithm-113/vigyl/main/scripts/install.ps1 | iex
```

Requires **Node 20 or newer**. Works on Linux, macOS and Windows.

## Set up (about five minutes)

**1. Make a Telegram bot.** Message [@BotFather](https://t.me/BotFather), send
`/newbot`, follow the prompts, copy the token it gives you.

**2. Get an OpenAI API key** from
[platform.openai.com/api-keys](https://platform.openai.com/api-keys). Vigyl uses
`gpt-4o-mini` by default; a typical command costs well under a cent.
(Anthropic is also supported — see [Choosing a model](#choosing-a-model).)

**3. Run the wizard** in the project you want to control:

```bash
cd ~/my-project
vigyl init
```

It validates both credentials against the live services before writing
anything, then waits for you to message your bot so it can learn which chat to
trust.

**4. Start it:**

```bash
vigyl start
```

Now message your bot.

### No terminal? (CI, containers, agents)

```bash
export OPENAI_API_KEY=sk-...
export TELEGRAM_BOT_TOKEN=123456:ABC...
vigyl init --non-interactive
```

## Commands

### Terminal

| Command | What it does |
|---|---|
| `vigyl init` | Setup wizard with live credential checks |
| `vigyl doctor` | Check everything, including live credentials |
| `vigyl start` | Start the daemon in the background |
| `vigyl start -f` | Run in the foreground |
| `vigyl stop` | Stop the daemon |
| `vigyl status` | Is it running? |
| `vigyl logs -n 100` | Recent daemon log lines |
| `vigyl logs -f` | Follow the log until Ctrl+C |

`vigyl doctor` is the fastest way to find out why something is not working:

```
Vigyl doctor

  ✓ Node version               Node 24.13.1
  ✓ Shell                      Commands will run through bash
  ✓ PTY support                node-pty is loadable
  ✓ Config file                Loaded and valid
  ✓ Workspace writable         /home/you/my-project
  ✓ Authorized chats           1 chat(s) authorized
  ✓ OpenAI key                 Key valid; gpt-4o-mini is available.
  ✓ Telegram token             Connected to @your_bot.
  ✓ Command parsing            Parsed a test request into: tail -n 20 logs/app.log

  Everything checks out. Vigyl is ready.
```

### Telegram

| Command | What it does |
|---|---|
| *(plain English)* | Run a command |
| `/status` | Daemon status |
| `/history` | Recent commands |
| `/repeat` | Run the last command again |
| `/logs` | Full output of your last command |
| `/logs <id>` | Full output of a specific command |
| `/monitor on\|off\|status` | Health alerts for this chat |
| `/help` | Command reference |

## How it works

```
Telegram ──▶ bot.ts ──▶ daemon.ts ──▶ supervisor.ts ──▶ llm.ts (OpenAI / Anthropic)
                          │                              (what should run?)
                          ├──▶ hitl.ts       approval gate
                          ├──▶ security.ts   path sandbox + command policy
                          └──▶ self-heal.ts ──▶ executor.ts ──▶ your shell
                                     │              │
                                     │              └──▶ monitor.ts (classify failure)
                                     └──▶ supervisor.ts (propose a patch)
```

1. Your message goes to the model (gpt-4o-mini by default), which turns it into
   one shell command, returned as schema-validated structured output.
2. The command is checked against the security policy and the approval rules.
3. Anything destructive comes back to you with Approve / Deny buttons.
4. Otherwise it runs in a real PTY, confined to your workspace.
5. On failure, the output is classified and — when it is the kind of failure a
   file edit can fix — the model is shown the failing file plus the local files
   it imports (up to 3 hops) and proposes a patch. The patch may only target a
   file it was shown in full, and is validated against the sandbox before it is
   written. Then the command runs again, up to 3 retries.

## Safety

Vigyl runs real commands on your server, so it is worth knowing exactly what
holds it in. The short version:

- **Path sandbox.** Every path is canonicalised (symlinks resolved) and checked
  for containment inside your workspace. This is a real boundary.
- **Approval gate.** Destructive actions need a button press. The rules are
  yours, and they run independently of the model's own judgement.
- **Patches are validated before they are written.** A proposed fix that points
  outside the workspace is rejected and logged, and the original file is backed
  up before any overwrite.
- **The command blocklist is a speed bump, not a boundary.** It catches
  accidents. What actually contains a hostile command is the workspace
  confinement, running as a non-root user, and the approval gate.

Full detail, including the threat model and what Vigyl does *not* protect
against: **[docs/SECURITY.md](docs/SECURITY.md)**.

## Configuration

`vigyl init` writes `vigyl.config.json`. Everything has a sensible default;
full reference in **[docs/CONFIGURATION.md](docs/CONFIGURATION.md)**.

```jsonc
{
  "workspace_root": "/home/you/my-project",
  "telegram": { "bot_token": "…", "allowed_chat_ids": [12345678] },
  "provider": "openai",
  "openai": { "api_key": "…", "model": "gpt-4o-mini" },
  "hitl": {
    "require_for": ["production", "env", "delete", "migrate", "push"],
    "timeout_seconds": 300
  },
  "self_heal": { "enabled": true, "max_retries": 3, "context_lines": 80 },
  "monitor": { "enabled": true, "interval_seconds": 300, "disk_percent": 85 }
}
```

**This file holds two live credentials.** `vigyl init` writes it `0600` and adds
it to `.gitignore`.

### Choosing a model

OpenAI is the default. To use Anthropic instead, set `ANTHROPIC_API_KEY` and
leave `OPENAI_API_KEY` unset (Vigyl picks whichever key it finds, preferring
OpenAI), or force it with `VIGYL_PROVIDER=anthropic`. `VIGYL_MODEL` overrides the
model for whichever provider is active. Details in
[docs/CONFIGURATION.md](docs/CONFIGURATION.md#choosing-a-provider).

## What is not proven yet

Being straight with you, because this is v0.1.0 and it runs commands on your
server:

- **Live testing so far is one developer's sandbox.** The full Telegram →
  model → command → self-heal loop has been run end to end against
  `gpt-4o-mini`: it healed a TypeScript error, a failing test and a bug two
  imports deep, refused to patch a missing dependency, and held a production
  deploy for approval. That is a handful of scenarios, not real-world mileage.
- **Anthropic is supported but has never been run against a live key.** It
  shares the provider interface and has unit tests; only OpenAI has been live.
- **Self-heal edits one file per attempt**, and only files under 60 KB that it
  was shown in full. Bugs that need coordinated edits across files will stop
  after a few attempts rather than be fixed.
- **pwsh and POSIX shell paths are written but lightly exercised.** Development
  was on Windows with cmd.exe.

Known limitations: one workspace per daemon, Telegram only, and no persistent
conversation memory beyond the last few turns.

## Troubleshooting

Start with `vigyl doctor`. Common problems and fixes:
**[docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md)**.

## Development

```bash
git clone https://github.com/ankithm-113/vigyl && cd vigyl
npm install
npm run build
npm test
```

Monorepo: `packages/daemon` is the library, `packages/cli` owns the `vigyl`
binary. Current build status and design decisions live in
[PROGRESS.md](PROGRESS.md).

## Licence

**AGPL-3.0-only** from v0.1.1 onwards. Copyright (c) 2026 Ankith M.

You may use, modify and self-host it freely. If you run a modified version as a
network service, the AGPL requires you to publish your changes.

v0.1.0 on npm was published under MIT, and that release stays MIT — a licence
cannot be revoked retroactively.
