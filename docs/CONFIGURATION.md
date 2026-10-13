# Configuration

`vigyl init` writes `vigyl.config.json` in the directory you run it from. Every
field except the credentials and `workspace_root` has a default.

## Precedence

Highest wins:

1. Environment variables
2. `vigyl.config.json`
3. Schema defaults

A `.env` file in the working directory is loaded at startup. Real environment
variables always beat `.env`.

## Full reference

```jsonc
{
  // Absolute path. Vigyl cannot read or write outside this directory.
  // Canonicalised at load time, so symlinks are resolved once, up front.
  "workspace_root": "/home/you/my-project",

  "telegram": {
    "bot_token": "123456789:AA...",   // from @BotFather
    "allowed_chat_ids": [12345678]    // everyone else is refused
  },

  // Which model vendor to use: "openai" (default) or "anthropic". Only the
  // matching block below is required.
  "provider": "openai",

  "openai": {
    "api_key": "sk-...",
    "model": "gpt-4o-mini"            // chosen for latency and cost
  },

  // Optional unless provider is "anthropic".
  "anthropic": {
    "api_key": "sk-ant-...",
    "model": "claude-haiku-4-5"
  },

  "hitl": {
    // Approval is required if a command contains any of these, regardless of
    // what the model thinks. Case-insensitive substring match.
    "require_for": ["production", "env", "delete", "migrate", "push"],
    "timeout_seconds": 300            // how long an approval stays valid
  },

  "self_heal": {
    "enabled": true,
    "max_retries": 3,                 // HARD CAP is 3; larger values are clamped
    "context_lines": 80               // output lines sent to the model on failure
  },

  "monitor": {
    "enabled": true,
    "interval_seconds": 300,          // how often to check
    "cooldown_seconds": 3600,         // minimum gap between repeats of one alert
    "cpu_percent": 90,
    "memory_percent": 90,
    "disk_percent": 85
  },

  "daemon": {
    "log_level": "info",              // debug | info | warn | error
    "log_retention_days": 7
  }
}
```

Unknown keys are an **error**, not silently ignored. A typo like
`telegram_bot_token` at the top level tells you so, rather than starting a
daemon with no token.

## Service liveness alerts

`monitor.services` is empty by default. Each entry needs a `name` and either a
`url` or a `port`; unknown keys are rejected.

```jsonc
"monitor": {
  "enabled": true,
  "interval_seconds": 300,
  "services": [
    { "name": "api",    "url": "http://localhost:3000/health" },
    { "name": "redis",  "port": 6379 },
    { "name": "db",     "host": "10.0.0.5", "port": 5432 }
  ]
}
```

Checked on the same tick as CPU, memory and disk. A `url` counts as up on any
response under 500 — the question is "is it alive", not "is this route right" —
and 5xx alerts, because up-but-broken is worth knowing. A `port` counts as up if
a TCP connection completes; `host` defaults to `127.0.0.1`. Each probe gives up
after 5 seconds.

Alerts are per service, so one dead service does not mute another, and a service
that recovers clears its cooldown — the next failure reports immediately instead
of waiting out `cooldown_seconds`.

## Environment variables

| Variable | Overrides |
|---|---|
| `OPENAI_API_KEY` | `openai.api_key` |
| `ANTHROPIC_API_KEY` | `anthropic.api_key` |
| `VIGYL_PROVIDER` | `provider` (`openai` or `anthropic`) |
| `TELEGRAM_BOT_TOKEN` | `telegram.bot_token` |
| `VIGYL_ALLOWED_CHAT_IDS` | `telegram.allowed_chat_ids` (comma-separated) |
| `VIGYL_WORKSPACE` | `workspace_root` |
| `VIGYL_MODEL` | the active provider's `model` |
| `VIGYL_LOG_LEVEL` | `daemon.log_level` |
| `VIGYL_HITL_TIMEOUT_SECONDS` | `hitl.timeout_seconds` |
| `VIGYL_CONFIG` | path to the config file itself |
| `VIGYL_SHELL` | shell used to run commands |

Vigyl can run from environment variables alone, with no config file at all.

## Notes on specific fields

**`self_heal.max_retries`** is capped at 3 in code. Config can lower it, never
raise it — a runaway loop means repeated model spend and repeated overwrites of
a real file.

**`monitor.cooldown_seconds`** governs how often the *same* alert repeats. A
metric that drops back below its threshold resets immediately, so a recovery
followed by a fresh breach is reported at once rather than being swallowed.

**`hitl.require_for`** is matched against the command, the action and the target
together. Keep it broad; a false approval prompt costs a button press, a missed
one costs a production deploy.

## Runtime state

Everything Vigyl writes lives under `.vigyl/` beside your config:

```
.vigyl/
├── daemon.pid              pid, start time, workspace
├── history.json            durable per-chat command history
└── logs/
    ├── daemon.log          structured JSON, credentials redacted
    ├── daemon.out          stdout/stderr of the background process
    └── commands/           full output per command, for /logs
```

Files overwritten by a self-healing patch are backed up under `.vigyl/backups/`
inside the workspace.

`.vigyl/` and `vigyl.config.json` are both added to `.gitignore` by
`vigyl init`.

## Choosing a provider

If `provider` is not set, Vigyl picks one in this order:

1. `VIGYL_PROVIDER`, if set
2. `provider` in `vigyl.config.json`, if set
3. `openai`, if an OpenAI key is present (env or file)
4. `anthropic`, if only an Anthropic key is present
5. otherwise `openai`, and startup fails asking for `OPENAI_API_KEY`

Default models: `gpt-4o-mini` for OpenAI, `claude-haiku-4-5` for Anthropic.
Both providers use schema-enforced structured output, so the model's reply
always parses. `vigyl doctor` checks the key for whichever provider is active.
