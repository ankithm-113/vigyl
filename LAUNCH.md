# Launch — what to post, where, in what order

Everything below is final copy. Copy the block, paste it, post it. No editing
needed except where a line says `← CHOOSE`.

**The links to use everywhere:**

- repo: `https://github.com/ankithm-113/vigyl`
- npm: `https://www.npmjs.com/package/@vigylx/cli`
- release: `https://github.com/ankithm-113/vigyl/releases/tag/v0.1.0`

**Before posting:**

- [x] repo public, description + topics set, v0.1.0 released
- [x] npm 2FA back on, publish tokens deleted
- [x] demo GIF recorded and committed as `docs/demo.gif` (3.2 MB, 14s) — an `.mp4` of the same cut is better for X and Reddit
- [ ] `npm i -g @vigylx/cli` run once on a machine that has never seen Vigyl
- [x] GIF in the release body, release published as “Vigyl v0.1.0 — early beta”
- [x] X thread posted 2026-10-13 — next: HN a day later, Reddit a day after that

**Rule for every channel:** say it is an early beta tested by one person. The
honesty is the pitch. People can tell the difference between "I shipped a thing"
and "I shipped a thing and here is exactly where it breaks", and only one of
those gets a second look.

**Timing.** Post the X thread and Hacker News on a weekday morning US Eastern
(roughly 6:30–9:00pm IST). Be at your keyboard for the two hours after the HN
post — early comments decide whether it goes anywhere. Space Reddit a day later
so the threads do not compete.

---

## 1. X / Twitter — thread of 5

Post 1, attach the GIF:

```
I built a tool that lets me control my server from Telegram in plain English.

"run the tests" → runs them
"deploy to staging" → deploys
build fails? → it reads the error, patches the file, runs it again

No app. npm install + a Telegram bot.

npm i -g @vigylx/cli
```

Post 2:

```
The part I didn't expect: the first real run failed.

It was only shown the file at the top of the stack trace — the test file — so it
"fixed" the test instead of the bug. Confidently. With a pointless edit.
```

Post 3:

```
Four guards came out of that:

- follow imports from the failing file (3 hops)
- always send whole files, never an excerpt
- a patch may only touch a file the model saw in full
- reject a patch that changes nothing

Then it fixed a real typo in sindresorhus/ts-extras in 9 seconds.
```

Post 4:

```
Anything destructive stops and asks.

"deploy to production" → Approve / Deny buttons, every time.
Keyword rules are yours and apply regardless of what the model decided.
Patches are sandboxed to your workspace and backed up before any overwrite.
```

Post 5:

```
v0.1.0, early beta, AGPL-3.0. 424 tests.

Live testing so far is one laptop, one model (gpt-4o-mini), a handful of
scenarios. The README lists exactly what is unproven.

github.com/ankithm-113/vigyl
```

---

## 2. Hacker News — Show HN

Go to https://news.ycombinator.com/submit

**Title** (exactly this — "Show HN:" prefix matters):

```
Show HN: Vigyl – control your server from Telegram in plain English
```

**URL:**

```
https://github.com/ankithm-113/vigyl
```

**Then post this as the first comment on your own submission:**

```
Vigyl is a Node daemon that turns a Telegram message into one shell command,
runs it in a real PTY inside a sandboxed workspace, and streams the output back.
If the command fails it classifies the failure, shows the model the failing file
plus the local files it imports, and tries a patch — up to 3 retries, with a
backup before every overwrite. Anything destructive waits for an Approve/Deny
button press.

I built it over a month and the honest state is: 424 tests, and live testing on
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
AGPL-3.0, 424 tests.

Happy to be told where the design is wrong — particularly about handing an LLM
write access to a real repo at all.
```

### Answers to have ready (HN will ask these)

**"Why not just SSH?"**
```
Because this is for the phone. SSH on a phone is miserable, and the parts that
matter here — classify the failure, patch it, retry, ask before anything
destructive — are not things a shell does for you.
```

**"Isn't letting an LLM write files reckless?"**
```
Yes, which is why nothing the model returns is trusted. Paths are re-validated
at the executor against a canonicalised workspace root, files are backed up
before any overwrite, a patch may only target a file the model was shown in
full, and the loop is capped at 3 retries. I'll also say plainly: the command
blocklist is not a security boundary, it is a typo filter. What contains a
hostile command is the workspace confinement, running as non-root, and the
approval gate.
```

**"Why AGPL and not MIT?"**
```
Because I would rather someone's improvements come back than be absorbed into a
closed product. Use it, self-host it, modify it freely — the only obligation
kicks in if you run a modified version as a service for others. v0.1.0 went out
under MIT and stays MIT; AGPL starts at v0.1.1.
```

**"Why Telegram?"**
```
It is the interface I already have on my phone, with push notifications and
inline buttons for the approval gate, and nothing to install. A proper daemon
protocol and MCP are next.
```

---

## 3. Reddit

Two subreddits, same idea, different emphasis. Post a day apart.

### r/selfhosted — https://www.reddit.com/r/selfhosted/submit

**Title:**
```
I built a tool to run my server from Telegram in plain English — it also auto-fixes failed builds
```

**Body:**
```
No cloud service, no account, nothing phones home. It runs on your box with your
own API key.

npm i -g @vigylx/cli

- plain-English message → one shell command, run in a PTY, output streamed back
- build fails → it classifies the error, patches the file, retries (max 3)
- anything destructive → Approve/Deny buttons first
- confined to one workspace directory, every overwrite backed up
- health alerts for CPU, memory, disk and any HTTP/TCP service you list

Honest status: v0.1.0 early beta, live-tested by exactly one person (me) on
Windows against gpt-4o-mini. The README has a "what is not proven yet" section.

Would like feedback on whether the default approval keywords
(production/env/delete/migrate/push) match what you would actually gate.

https://github.com/ankithm-113/vigyl
```

### r/devops — https://www.reddit.com/r/devops/submit

**Title:**
```
Built a self-healing command runner you drive from Telegram — would like holes poked in the design
```

**Body:**
```
The loop: message → one shell command (schema-validated, not free text) → PTY
execution inside a sandboxed workspace → on failure, classify the error
(dependency missing / permission / network / build / test / syntax / config),
then show the model the failing file plus the files it imports and ask for a
patch. Max 3 retries, backup before every write, and a patch may only target a
file the model was shown in full.

Destructive commands hit a human-in-the-loop gate: inline Approve/Deny in
Telegram, with keyword rules owned by the operator rather than by the model.

npm i -g @vigylx/cli — v0.1.0, AGPL-3.0, early beta, 424 tests, live-tested
on one machine so far. Source: https://github.com/ankithm-113/vigyl

The design question I keep going back and forth on: should an agent be allowed
to edit more than one file per attempt? Right now it cannot, and the cases it
fails on are exactly the ones needing coordinated edits.
```

---

## 4. IndieHackers — https://www.indiehackers.com/new-post

```
Just shipped Vigyl v0.1.0 — 30 days from idea to a published npm package.

It lets you run your server from Telegram in plain English, and when a build
breaks it patches the file and retries. AGPL-3.0, free.

npm i -g @vigylx/cli
github.com/ankithm-113/vigyl

Three things I learned shipping it:

1. The first real run of the self-healing loop failed. Not crashed — it
   confidently "fixed" the wrong file, because it had only been shown the file
   at the top of the stack trace. Every guard in that loop now exists because a
   run went wrong, not because I designed it up front.

2. Testing inside the monorepo hid two bugs that a clean global install exposed
   in 30 seconds. Packaging is its own test surface.

3. Writing "what is not proven yet" in the README was uncomfortable, and is the
   part I would keep.
```

---

## 5. After posting (Days 27–28)

Answer every comment, issue and DM — GitHub issues is the channel the README
and these posts point at, so watch
<https://github.com/ankithm-113/vigyl/issues>. This is where v0.2.0 comes from.
Keep a running note in PROGRESS.md:

1. The 3 most common feature requests
2. The 3 most common setup problems
3. The one thing people say they love
4. What to cut for v0.2.0

Two answers to have ready:

- **"Does it work with Claude?"** Yes — set `ANTHROPIC_API_KEY` and leave
  `OPENAI_API_KEY` unset. Say plainly that the Anthropic path has not been run
  against a live key.
- **"Can I use it without Telegram?"** Not in v0.1.0. An MCP server so other
  agents can drive it is next — see `docs/MCP-ARCHITECTURE.md`.
- **"Can I contribute?"** Yes, issues and PRs. Be honest that it is one
  person's beta and the architecture may still move under them.

---
---

# v0.2.0 launch copy

Everything above is the v0.1.0 launch, some of which is still pending. This
section is for v0.2.0 and should only go out **after** it is published to npm.

**The one rule, unchanged:** it is an early beta tested by one person, and the
most interesting thing to say about this release is the feature that was
measured and then **not** shipped.

**Links:**

- repo: `https://github.com/ankithm-113/vigyl`
- release: `https://github.com/ankithm-113/vigyl/releases/tag/v0.2.0`
- benchmark: `https://github.com/ankithm-113/vigyl/blob/main/docs/SLM-BENCHMARK.md`

---

## 1. X / Twitter — thread of 5

Post 1 — attach a short clip of a service question being answered:

```
Vigyl v0.2.0 is out.

It already ran commands on your server from Telegram and fixed failed builds.
Now it answers questions about the services that server depends on.

"how many users signed up today?" — Firebase
"did CI pass on main?" — GitHub
"how many rows in users?" — Postgres

npm i -g @vigylx/cli
```

Post 2:

```
The part I cut is more interesting than the part I shipped.

The plan was a local Phi-3 classifying build failures on-device. 90% fewer API
calls, the roadmap said.

I built it, benchmarked it on real failures, and it was 36% accurate at 11
seconds a go.
```

Post 3:

```
Worse: every wrong answer came back at 0.8-0.9 confidence.

The design accepts a local answer above 0.7 and falls back to the cloud below
it. That gate would have accepted every single mistake.

A confidence score you cannot trust is not a safety mechanism.
```

Post 4:

```
So I deleted the premise and widened the regex rules instead.

They now answer the whole benchmark corpus correctly in 67 microseconds. No
model, no 2GB download, no GPU.

Sometimes the feature is the one you do not ship.
```

Post 5:

```
Also in v0.2.0: anything that writes goes through Approve/Deny first, and the
gate never asks the model whether its own request is safe — it reads the tool's
declared annotations and fails closed.

694 tests. AGPL-3.0. Still one person, one machine.

github.com/ankithm-113/vigyl
```

---

## 2. Hacker News — a follow-up, not another Show HN

A second Show HN for the same project within weeks reads badly. Post this as a
normal submission **only if the v0.1.0 Show HN got traction**; otherwise skip
HN for this release.

**Title:**

```
I benchmarked small local LLMs for build-error classification and shipped regex instead
```

**URL:**

```
https://github.com/ankithm-113/vigyl/blob/main/docs/SLM-BENCHMARK.md
```

**First comment:**

```
Context: Vigyl turns a Telegram message into a shell command and tries to fix
the build when it fails. Month 2 of the plan was to move failure classification
onto a local small model to cut API cost. This is what the measurements said.

The corpus splits into failures a regex rule set already names and failures it
cannot, and only the second half is benchmarked — measuring accuracy over
obvious "Cannot find module" errors would report a flattering number that means
nothing, since in production those never reach the model. A test enforces the
split and caught four mislabelled cases when I wrote it.

Llama 3.2 1B and Qwen2.5 1.5B both scored 36% on the 11 cases that mattered, at
11-16 seconds per answer on CPU. Phi-3 mini could not run at all on an 8 GB
machine: it refused a 4096 context, loaded at 2048, then spent 13 minutes
without finishing one classification while free memory fell to 0.2 GB.

The result that changed my mind was not the accuracy. Every one of the 14 wrong
answers came back at 0.8-0.9 confidence. The design gates on confidence >= 0.7
and falls back to the cloud below it, which only works if the model knows when
it is unsure. It does not, so the gate would have accepted every mistake.

Both models also defaulted to "build_error" while writing summaries that showed
they had understood the error correctly — one labelled a missing Postgres
database build_error and summarised it as "Database app_production does not
exist, causing an OperationalError". So I rewrote the prompt with explicit
label definitions. 36% before, 36% after, and slower.

I widened the rules instead. They answer the whole corpus correctly in 67
microseconds. Happy to be told what I measured wrong, particularly by anyone
who has made small models work for this on a GPU.
```

---

## 3. Reddit — r/LocalLLaMA

This release has a natural home that v0.1.0 did not. The benchmark is the post;
the tool is the footnote.

**Subreddit:** <https://www.reddit.com/r/LocalLLaMA/submit>

**Title:**

```
Benchmarked Llama 3.2 1B and Qwen2.5 1.5B on build-error classification: 36% accurate, and the confidence scores are unusable
```

**Body:**

```
I wanted local inference to replace a cloud API call for classifying build
failures in a devops tool I maintain. Here is what I measured on CPU, 8 GB RAM,
no GPU.

Corpus: 20 real build failures with known labels, split into the 9 a regex rule
set already names and the 11 it cannot. Only the second half is benchmarked —
in production the model never sees the first.

  regex rules      100% (9/9)     67 microseconds
  Llama 3.2 1B     36% (4/11)     11.6s median, 36.6s p90
  Qwen2.5 1.5B     36% (4/11)     16.0s median, 54.3s p90
  Phi-3 mini 4k    could not run

Phi-3 refused a 4096 context on this machine, loaded at 2048, then ran 13
minutes without finishing a single classification while free memory dropped to
0.2 GB.

The thing I did not expect: all 14 wrong answers across both models came back at
0.8-0.9 confidence. I was going to gate on confidence >= 0.7 and fall back to
the cloud below it. That gate would have accepted every mistake.

Both models defaulted to "build_error" for almost everything while writing
summaries that showed they understood the error. Adding explicit definitions of
each label to the prompt moved accuracy not at all: 36% before, 36% after.

Output was grammar-constrained the whole time (node-llama-cpp JSON schema
grammar), so this is not a parsing problem.

Full numbers and the corpus:
https://github.com/ankithm-113/vigyl/blob/main/docs/SLM-BENCHMARK.md

Genuine question for this sub: is 1-3B simply the wrong size for taxonomy
classification, or did I pick the wrong models? I would rerun this on a GPU if
someone thinks the result would change.
```

---

## 4. r/selfhosted and r/devops

**Still held for r/selfhosted** — their rules ask for production-ready, and this
is still an early beta tested by one person. That has not changed.

**r/devops** takes a short update comment in the weekly thread rather than a new
post:

```
Vigyl v0.2.0: it can now answer questions about Firebase, GitHub and Postgres
from the same Telegram chat, with anything that writes going through an
Approve/Deny gate first. The gate reads the tool's own declared annotations
rather than asking the model whether its request is safe, and fails closed.

Also shipped a benchmark explaining why the local-model feature was cut:
https://github.com/ankithm-113/vigyl/blob/main/docs/SLM-BENCHMARK.md

npm i -g @vigylx/cli — AGPL-3.0, still an early beta.
```

---

## 5. Answers to have ready

**"Why did you ship the benchmark for a feature you cut?"**
```
Because the measurement is more useful than the feature would have been. Plenty
of people are about to try the same thing, and the number that stopped me —
wrong answers at 0.9 confidence — is not in anybody's README.
```

**"Isn't an LLM choosing which tool to call just as risky as one writing files?"**
```
It would be if the model decided what is safe. It does not. The gate reads the
tool's own declared annotations and the operator's keyword rules, and fails
closed: a tool that does not declare itself read-only is gated, which caught a
real omission of mine the first time I ran it. A request that describes itself
as safe is exactly what an injected one would say, so nothing the model says
about its own request is consulted.
```

**"How is db_query read-only?"**
```
Not by reading the SQL. Every statement runs inside BEGIN TRANSACTION READ
ONLY, which Postgres enforces. There is a string check too, but it is
explicitly a typo filter — the guide I was following had only that, and against
a real database its version let a data-modifying CTE delete a row and
"SELECT 1; DROP TABLE users" drop a table.
```

**"Does it work without Telegram now?"**
```
Partly. There is a WebSocket interface on 8472 for the mobile app that is
coming, authenticated with HMAC over device id, timestamp and nonce. Telegram
is still the interface that exists today.
```

