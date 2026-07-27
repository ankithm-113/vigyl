# Security model

Vigyl runs shell commands on your server on the strength of a Telegram message
and a language model's interpretation of it. This document says exactly what
holds that in, and — more importantly — what does not.

## What is a real boundary

### The path sandbox

Every filesystem path that the daemon or the model produces goes through
`SecurityLayer.validatePath()`. It:

1. Resolves the path to absolute, then **canonicalises it** with
   `realpathSync.native`, so symlinks are followed and Windows casing is
   normalised.
2. Checks containment with `path.relative`, not a string prefix.

That second point matters. A prefix check accepts `/home/you/project-evil` as
being inside `/home/you/project`, because the string matches. There is a
regression test asserting both halves of that: the prefix genuinely does match,
and containment correctly rejects it.

Paths that do not exist yet are handled by canonicalising the deepest existing
ancestor — so a file can be validated before it is created, without losing
symlink resolution.

### Patch validation

`self-heal.ts` is the only place in the daemon that writes to disk because a
model said so. It has one write path, and that path begins with
`validatePath()`. A proposed patch that resolves outside the workspace is
rejected and logged at warn level with the attempted path.

Additionally:

- The target must **already exist**. Letting a model create arbitrary new files
  is a strictly larger capability than letting it edit known ones, and fixing a
  build error never requires it.
- The file is **copied to a backup** before it is overwritten.
- Writes go to a temp file and are renamed, so a crash cannot truncate your
  source.

### The approval gate

A command needs a human if **either**:

- Claude sets `requiresApproval` or `isDestructive`, **or**
- the command text matches one of *your* `hitl.require_for` keywords.

Two independent votes, deliberately. The model is being steered by the very
message it is parsing, so it cannot be the only one deciding whether that
message is dangerous.

Approvals are single-use, expire on `hitl.timeout_seconds`, and are scoped to
the chat that requested them — one chat cannot approve another's command.

`/repeat` re-enters the same pipeline with the original message rather than
replaying the stored shell command, so repeating a production deploy still asks.

### Chat authorization

Middleware runs before every other handler and rejects any chat not in
`allowed_chat_ids`. It covers **button presses as well as messages** — an inline
keyboard's `callback_data` is replayable by anyone who learns an approval ID.

It fails closed: an unknown chat, a missing chat ID, and an empty allowlist are
all rejected.

## What is NOT a boundary

### The command blocklist

`validateCommand()` rejects `sudo`, `rm -rf /`, piped-download-to-shell, `mkfs`
and similar. **This is a speed bump, not a security control.**

Commands are handed to a real shell. Any blocklist can be defeated by quoting,
base64, variable indirection, or writing a script file first. It exists to catch
accidents and naive model output, and it should never be described as the thing
that stops a hostile command.

What actually contains a hostile command:

- the process working directory is pinned inside `workspace_root`
- the daemon should run as a **non-root user with no sudo rights**
- destructive actions go through the approval gate

*(An aside: Vigyl's own blocklist rejects the pipe-a-download-into-a-shell
pattern, which is also how the quickstart installer is delivered. That is not
hypocrisy — it is the point. A pattern you choose to run once, knowingly, is a
different thing from one a model generates unattended.)*

### Prompt injection

Command output goes into the model's prompt when generating a patch. In any
project with third-party dependencies, that output is attacker-influenced — a
postinstall script can print whatever it likes.

Mitigations:

- Untrusted text is wrapped in long, specific delimiters, and the system prompt
  states that content inside them is data, never instructions.
- Forged delimiters are stripped, both when building the prompt and when storing
  text in session history.

**These are mitigations, not guarantees.** Nothing the model returns is trusted:
every path is re-validated against the sandbox, and destructive commands still
need a button press. Assume injection can influence what Vigyl *tries* to do,
and rely on the sandbox and the gate for what it *can* do.

## Credentials

`vigyl.config.json` holds a live Anthropic key and a Telegram bot token. It is
written `0600` and added to `.gitignore` by `vigyl init`.

**Logs are redacted.** Every record passes through a redaction pass before it
reaches stdout or `daemon.log`: credential-shaped keys are replaced, and
`sk-ant-` and bot-token patterns are scrubbed out of free text — including from
Telegram API URLs, which embed the token in the path. `daemon.log` is the file
people paste into GitHub issues, so this matters.

## Deployment advice

- **Run as a dedicated non-root user** with no sudo rights. This is the single
  most valuable thing you can do.
- **Point `workspace_root` at one project**, not at a home directory.
- **Authorize a direct message, not a group.** A negative chat ID is a group,
  and every member of it can run commands. Vigyl warns at startup if you do
  this, but it will not stop you.
- **Treat the approval keywords as yours.** The defaults are a starting point;
  add anything specific to your setup.

## Reporting a vulnerability

Open a GitHub issue for anything non-sensitive. For something you would rather
not post publicly, say so in an issue without detail and a private channel will
be arranged.
