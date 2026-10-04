# Launch copy — v0.1.0

Post order matters: Twitter/X and the GitHub release first, then Hacker News
(its front page depends on early comment quality, so be at your keyboard for the
first two hours), then Reddit, then IndieHackers.

**Before posting anything:**

- [ ] GitHub release v0.1.0 published
- [ ] `npm i -g @vigylx/cli` tried once from a machine that has never seen Vigyl
- [ ] Demo GIF recorded (Telegram thread healing a real build — the guide's
      Day 20 item, still outstanding; it is the single highest-leverage asset)
- [ ] Repo description and topics set: `telegram`, `devops`, `chatops`,
      `self-healing`, `openai`, `nodejs`, `cli`
- [ ] 2FA back on, publish tokens deleted

**Rule for every channel:** say it is a private beta tested by one person. The
honesty *is* the pitch — anyone can tell the difference between "I shipped a
thing" and "I shipped a thing and here is exactly where it breaks", and only one
of those earns a second look.

---

## 1. Twitter/X (thread)

**1/**
```
I built a tool that lets me control my server from Telegram in plain English.

"run the tests" → runs them
"deploy to staging" → deploys
build fails? → it reads the error, patches the file, runs it again

No app. npm install + a Telegram bot.

npm i -g @vigylx/cli
```
*(attach demo GIF)*

**2/**
```
The part I didn't expect: the first real run failed.

It was only shown the file at the top of the stack trace — the test file — so it
"fixed" the test instead of the bug. Confidently. With a pointless edit.
```

**3/**
```
Four guards came out of that:

- follow imports from the failing file (3 hops)
- always send whole files, never an excerpt
- a patch may only touch a file the model saw in full
- reject a patch that changes nothing

Then it fixed a real typo in sindresorhus/ts-extras in 9 seconds.
```

**4/**
```
Anything destructive stops and asks.

"deploy to production" → Approve / Deny buttons, every time.
Keyword rules are yours and apply regardless of what the model decided.
Patches are sandboxed to your workspace and backed up before any overwrite.
```

**5/**
```
v0.1.0, private beta, MIT. 402 tests.

Live testing so far is one laptop, one model (gpt-4o-mini), a handful of
scenarios. The README lists exactly what is unproven.

github.com/ankithm-113/vigyl
```

---

## 2. Hacker News — Show HN

**Title:** `Show HN: Vigyl – control your server from Telegram in plain English`

**Body:**
```
Vigyl is a Node daemon that turns a Telegram message into one shell command,
runs it in a real PTY in a sandboxed workspace, and streams the output back. If
the command fails, it classifies the failure, shows the model the failing file
plus the local files it imports, and tries a patch — up to 3 retries, with a
backup before every overwrite. Anything destructive waits for an Approve/Deny
button press.

I built it over a month and the honest state is: 402 tests, and live testing on
one laptop against gpt-4o-mini. The first live self-heal run failed in a way I
found instructive — the model only ever saw the file at the top of the stack
trace, which for a failing assertion is the test file, so it edited the test
instead of the bug and reported success. Fixing that properly meant following
imports from the error location, always sending whole files rather than an
excerpt, and refusing any patch aimed at a file the model had not been shown in
full (otherwise "here is the complete corrected file" silently deletes whatever
it never saw).

The security boundary is deliberately not the LLM: path containment is enforced
at the executor with canonicalised paths, the approval keywords are the
operator's and apply regardless of what the model decided, and build output is
treated as untrusted input because any dependency's postinstall script can print
whatever it likes into the prompt.

npm i -g @vigylx/cli
github.com/ankithm-113/vigyl

Happy to be told where the design is wrong — particularly about handing an LLM
write access to a real repo at all.
```

**If asked "why not just SSH?"** — because this is for the phone. SSH on a phone
is miserable, and the parts that matter here (classify the failure, patch, retry,
ask before anything destructive) are not things a shell does.

**If asked "isn't letting an LLM write files reckless?"** — yes, which is why the
model's output is never trusted: paths are re-validated at the executor, files
are backed up, patches are confined to files the model was shown in full, and the
loop is capped at 3 retries. Also say plainly: the blocklist is not a boundary.

---

## 3. Reddit — r/devops, r/selfhosted

**Title:** `I built a tool to control my server from Telegram in plain English — it also auto-fixes failed builds`

**Body:**
```
Open source (MIT), 5 minute setup: npm i -g @vigylx/cli

- plain-English message → one shell command, run in a PTY, output streamed back
- build fails → classifies the error, patches the file, retries (max 3)
- anything destructive → Approve/Deny buttons first
- everything confined to one workspace directory, every overwrite backed up

Honest status: v0.1.0 private beta, tested live by exactly one person (me) on
Windows against gpt-4o-mini. The README has a "what is not proven yet" section.

What I'd most like feedback on: whether the approval keywords
(production/env/delete/migrate/push) match what you'd actually gate.

github.com/ankithm-113/vigyl
```

*r/selfhosted leans self-hosting: lead with "no cloud service, no account, runs
on your box, your API key". r/devops leans practitioner: lead with the failure
classification and the approval gate.*

---

## 4. IndieHackers

```
Just shipped Vigyl v0.1.0 — 30 days from idea to a published npm package.

It lets you run your server from Telegram in plain English, and when a build
breaks it patches the file and retries. MIT, free.

Three things I learned shipping it:

1. The first real run of the self-healing loop failed. Not crashed — it
   confidently "fixed" the wrong file, because it had only been shown the file
   at the top of the stack trace. Every guard in the loop now exists because of
   a run that went wrong, not because I designed it that way up front.

2. Testing in the monorepo hid two bugs that a clean global install exposed in
   30 seconds. Packaging is its own test surface.

3. Writing down "what is not proven yet" in the README was uncomfortable and is
   the part I would keep.

npm i -g @vigylx/cli
github.com/ankithm-113/vigyl
```

---

## Replies (Days 27–28)

Answer every issue, DM and comment. The guide is right that this is where v0.2.0
comes from. Track in PROGRESS.md as they arrive:

1. The 3 most common feature requests
2. The 3 most common setup problems
3. The one thing people say they love
4. What to cut for v0.2.0

Two answers worth preparing now, because they will come up:

- **"Does it work with Claude?"** Yes — set `ANTHROPIC_API_KEY` and leave
  `OPENAI_API_KEY` unset. Say plainly that the Anthropic path has not been run
  against a live key yet.
- **"Can I use it without Telegram?"** Not in v0.1.0. A proper daemon protocol
  and MCP are Month 2 — see `docs/MCP-ARCHITECTURE.md`.
