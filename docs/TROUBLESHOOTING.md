# Troubleshooting

Run this first — it checks everything, including live credentials:

```bash
vigyl doctor
```

`--offline` skips the network checks and the one that costs tokens.

## The bot does not reply

**Check it is running:** `vigyl status`.

If it says *not running* right after `vigyl start`, the daemon started and then
exited. Read `.vigyl/logs/daemon.out` — that file exists precisely for this.

The most common cause is a bad bot token. Telegram answers `401 Unauthorized`,
and Vigyl reports it and exits rather than sitting there doing nothing:

```
✗ Telegram polling stopped: Call to 'getMe' failed! (401: Unauthorized)
  The daemon cannot be reached. Exiting.
```

**Check your chat is authorized.** Message the bot; if the chat is unknown it
replies with its own ID:

```
⛔ Not authorized.
This chat's ID is 12345678.
```

Add it to `telegram.allowed_chat_ids` and restart.

## "Config not found"

Vigyl reads `vigyl.config.json` from the **current directory**. Run commands
from the project you ran `vigyl init` in, or set `VIGYL_CONFIG`.

## Commands fail with "resolves outside the workspace"

Working as designed: Vigyl cannot touch anything outside `workspace_root`. If
the path really should be reachable, widen `workspace_root` — but prefer
pointing it at one project rather than a home directory.

## Self-healing did not try to fix my build

It deliberately does not attempt a patch for failures that a file edit cannot
fix: **missing dependencies** (needs an install), **permission errors** (needs
you), and **network errors** (needs the network). The reply says which.

Other reasons it stops early:

| Message | Meaning |
|---|---|
| *Claude was not confident enough* | The model declined. A wrong patch overwrites a real file. |
| *The same error came back unchanged* | The patch changed nothing observable, so retrying is pointless. |
| *A proposed fix targeted a file outside the workspace* | Blocked by the sandbox. Worth reading the log. |
| *rate-limited us before a fix could be generated* | Anthropic rate limit. Try again shortly. |

## A patch made things worse

Every overwritten file is backed up first, under `.vigyl/backups/` in your
workspace. Restore the copy you want.

Set `self_heal.enabled: false` to stop automatic patching entirely while keeping
everything else.

## Output is cut off

Telegram caps messages at 4096 characters. Press **View full log**, or:

```
/logs           full output of your last command
/logs a1b2c3d4  a specific command (IDs are shown by /history)
```

Anything large arrives as a file attachment rather than being split up.

## Health alerts are too noisy / too quiet

`/monitor off` stops them for your chat. To tune:

```jsonc
"monitor": {
  "interval_seconds": 300,     // how often to check
  "cooldown_seconds": 3600,    // minimum gap between repeats of one alert
  "disk_percent": 85
}
```

A metric that recovers resets its cooldown, so a fresh breach after a recovery
is reported immediately.

## Windows specifics

- Vigyl prefers **pwsh**, then **cmd.exe**. Windows PowerShell 5.1 is skipped
  deliberately: it has no `&&` operator, so ordinary commands like
  `npm ci && npm run build` would fail with a parser error.
- Override with `VIGYL_SHELL` if you need something else.
- `vigyl logs` reads the log file directly rather than shelling out to `tail`,
  so it works the same everywhere.

## Getting the detail

```bash
vigyl logs -n 200
```

Or set `daemon.log_level` to `debug` and restart. Logs are JSON, one object per
line, with credentials redacted — safe to attach to a GitHub issue.
