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
     ▸ 🔧 Asking Claude for a fix...
     ▸ ✍ Patched src/app.ts: added the missing import
     ▸ ▶ Running (attempt 2/4): npm run build
     ▸ ✅ Done — succeeded on attempt 2 after self-healing.
```

---

## Status

**v0.1.0 — private beta.** Built and tested, but young. Read
[What is not proven yet](#what-is-not-proven-yet) before pointing it at
anything you care about.

---

## Install

```bash
npm install -g @vigyl/cli
```

Or the one-liner:

```bash
curl -fsSL https://raw.githubusercontent.com/nulldesk/vigyl/main/scripts/install.sh | bash
```

Windows (PowerShell):

```powershell
irm https://raw.githubusercontent.com/nulldesk/vigyl/main/scripts/install.ps1 | iex
```

Requires **Node 20 or newer**. Works on Linux, macOS and Windows.

## Set up (about five minutes)

**1. Make a Telegram bot.** Message [@BotFather](https://t.me/BotFather), send
`/newbot`, follow the prompts, copy the token it gives you.

**2. Get an Anthropic API key** from
[console.anthropic.com](https://console.anthropic.com).

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
export ANTHROPIC_API_KEY=sk-ant-...
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

`vigyl doctor` is the fastest way to find out why something is not working:

```
Vigyl doctor

  ✓ Node version               Node 24.13.1
  ✓ Shell                      Commands will run through bash
  ✓ PTY support                node-pty is loadable
  ✓ Config file                Loaded and valid
  ✓ Workspace writable         /home/you/my-project
  ✓ Authorized chats           1 chat(s) authorized
  ✓ Anthropic key              Key valid; Claude Haiku 4.5 is available.
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
Telegram ──▶ bot.ts ──▶ daemon.ts ──▶ supervisor.ts ──▶ Claude Haiku
                          │                              (what should run?)
                          ├──▶ hitl.ts       approval gate
                          ├──▶ security.ts   path sandbox + command policy
                          └──▶ self-heal.ts ──▶ executor.ts ──▶ your shell
                                     │              │
                                     │              └──▶ monitor.ts (classify failure)
                                     └──▶ supervisor.ts (propose a patch)
```

1. Your message goes to Claude Haiku, which turns it into one shell command.
2. The command is checked against the security policy and the approval rules.
3. Anything destructive comes back to you with Approve / Deny buttons.
4. Otherwise it runs in a real PTY, confined to your workspace.
5. On failure, the output is classified and — when it is the kind of failure a
   file edit can fix — Claude proposes a patch, which is validated against the
   sandbox before it is written. Then the command runs again, up to 3 retries.

## Safety

Vigyl runs real commands on your server, so it is worth knowing exactly what
holds it in. The short version:

- **Path sandbox.** Every path is canonicalised (symlinks resolved) and checked
  for containment inside your workspace. This is a real boundary.
- **Approval gate.** Destructive actions need a button press. The rules are
  yours, and they run independently of Claude's own judgement.
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
  "anthropic": { "api_key": "…", "model": "claude-haiku-4-5" },
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

## What is not proven yet

Being straight with you, because this is v0.1.0 and it runs commands on your
server:

- **No end-to-end session has been run against a live Anthropic key.** Every
  layer is unit- and integration-tested (360 tests, including tests that run
  real commands and patch real files on disk), and the credential checks have
  been verified against the live APIs. But the full
  message → Claude → command → self-heal loop has not yet been driven by a real
  key. Run `vigyl doctor` first; it exercises the same code path.
- **The self-healing patch loop has never seen a real model's patch.** The loop
  is tested against a stubbed Supervisor.
- **pwsh and POSIX shell paths are written but lightly exercised.** Development
  was on Windows with cmd.exe.

Known limitations: one workspace per daemon, Telegram only, and no persistent
conversation memory beyond the last few turns.

## Troubleshooting

Start with `vigyl doctor`. Common problems and fixes:
**[docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md)**.

## Development

```bash
git clone https://github.com/nulldesk/vigyl && cd vigyl
npm install
npm run build
npm test
```

Monorepo: `packages/daemon` is the library, `packages/cli` owns the `vigyl`
binary. Current build status and design decisions live in
[PROGRESS.md](PROGRESS.md).

## Licence

MIT
