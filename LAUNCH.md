# Launch — what to post, where, in what order

Everything below is final copy. Copy the block, paste it, post it. No editing
needed except where a line says `← CHOOSE`.

**One decision first.** Every post needs a link. The repo is private, so:

- **Option 1 (recommended): link the npm page only.** `https://www.npmjs.com/package/@vigylx/cli`
  Works today. No stars possible — stars need a public repo.
- **Option 2: create a public docs-only repo** (README + docs + install scripts,
  no `packages/`), link that, and get stars + an issues page without exposing
  the source.

All copy below uses the npm link. If you go with Option 2, add the repo link
under it.

**Before posting:**

- [ ] publish `0.1.1` to npm (the `0.1.0` README points at a private repo —
      every `curl`/`git clone` line in it 404s for users)
- [ ] demo GIF recorded (see `docs/DEMO.md`)
- [ ] `npm i -g @vigylx/cli` run once on a machine that has never seen Vigyl
- [ ] npm 2FA back on, publish tokens deleted

**Rule for every channel:** say it is a private beta tested by one person. The
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
v0.1.0, private beta, MIT. 424 tests.

Live testing so far is one laptop, one model (gpt-4o-mini), a handful of
scenarios. The README lists exactly what is unproven.

npmjs.com/package/@vigylx/cli
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
https://www.npmjs.com/package/@vigylx/cli
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

**"Why is the repo not public?"**
```
It is a private beta and I am not ready to maintain a public repo yet. The
package is MIT and installable today; the source ships readable in the npm
tarball.
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

Honest status: v0.1.0 private beta, live-tested by exactly one person (me) on
Windows against gpt-4o-mini. The README has a "what is not proven yet" section.

Would like feedback on whether the default approval keywords
(production/env/delete/migrate/push) match what you would actually gate.
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

npm i -g @vigylx/cli — v0.1.0, MIT, private beta, 424 tests, live-tested on one
machine so far.

The design question I keep going back and forth on: should an agent be allowed
to edit more than one file per attempt? Right now it cannot, and the cases it
fails on are exactly the ones needing coordinated edits.
```

---

## 4. IndieHackers — https://www.indiehackers.com/new-post

```
Just shipped Vigyl v0.1.0 — 30 days from idea to a published npm package.

It lets you run your server from Telegram in plain English, and when a build
breaks it patches the file and retries. MIT, free.

npm i -g @vigylx/cli

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

Answer every comment, issue and DM. This is where v0.2.0 comes from. Keep a
running note in PROGRESS.md:

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
