# Recording the demo GIF

## What it is and why it matters

A short, silent, looping animation of a Telegram chat where you ask Vigyl to run
a build, it fails, and Vigyl fixes it and re-runs — ending on the green success
line. Twelve to twenty seconds. No narration, no intro, no logo.

It matters because nobody reads a README to decide whether to care. The GIF is
the pitch: it either shows a build healing itself in one screen or it doesn't.
Every launch post leans on it.

Target: **under 5 MB** (X and Reddit will compress or reject bigger), **under 20
seconds**, phone-shaped (portrait), and legible at thumbnail size.

## What to record

Record **your phone's Telegram screen**, not the terminal. The whole point is
that this happens on a phone.

Script, exactly this much:

1. The chat is open and empty of clutter. Type **`run the tests`** and send.
2. Vigyl replies, the activity bar moves, the test fails.
3. "🔧 Asking the model for a fix..."
4. "✍ Patched sum.js: ..."
5. The re-run passes: "✅ Done — succeeded on attempt 2 after self-healing."
6. Stop recording one second after the green line appears.

Nothing else. No `/help`, no settings tour, no second command.

## Setup (10 minutes)

The sandbox from the Day 21 runs is exactly right, because its bug is tiny and
the fix is one line a stranger can read at a glance.

```powershell
# 1. restore the deliberate bug
cd C:\Users\ankit\vigyl-sandbox
# sum.js must read:  return a - b;
notepad sum.js

# 2. point Vigyl at the sandbox and start it
cd C:\Users\ankit\OneDrive\Desktop\Vigyl
# .env: VIGYL_WORKSPACE=C:/Users/ankit/vigyl-sandbox
node packages/cli/dist/index.js start
```

Then on the phone: open the Vigyl bot chat, **clear the history** so the
recording has no stale messages, and increase font size if your phone's default
is small (Telegram → Settings → Chat Settings → text size). Bigger text reads
better in a thumbnail.

## Recording on the phone

**Android:** swipe down twice → **Screen record** → record only the chat → stop.
**iPhone:** Settings → Control Centre → add **Screen Recording**, then swipe and
tap the circle.

Record in portrait. Keep your finger movements minimal — nobody needs to watch
you scroll.

## Trimming and converting (Windows)

The screen recording is an `.mp4`; X, HN and Reddit all prefer a GIF or a short
video, and a GIF autoplays everywhere.

**Easiest: ScreenToGif** (free, https://www.screentogif.com)

1. Copy the `.mp4` from your phone to the laptop.
2. Open ScreenToGif → **Editor** → **File → Load** → pick the mp4.
3. Delete frames before the first message and after the green line.
4. **Image → Resize** → width 480px (portrait, keeps text legible).
5. **File → Save as → Gif**, with "Looped" on.
6. Check the file is under 5 MB. If not: Resize to 400px, or in
   **Image → Reduce frame count** drop to every 2nd frame.

**If you prefer the terminal** and have ffmpeg:

```powershell
# 15 seconds starting at 00:03, 480px wide, 12fps, good palette
ffmpeg -ss 00:00:03 -t 15 -i recording.mp4 -vf "fps=12,scale=480:-1:flags=lanczos,split[s0][s1];[s0]palettegen[p];[s1][p]paletteuse" -loop 0 demo.gif
```

## Where it goes

- Attach to the first X post (`LAUNCH.md` section 1).
- Attach to both Reddit posts.
- Do **not** attach it to the Hacker News comment — HN is text only; the npm
  page link carries it.
- Put it in the GitHub release body if you make the release public.
- To show it on the npm page, the GIF needs a public URL. Easiest without a
  public repo: upload it to the GitHub release as an asset and use that link, or
  host it anywhere public, then reference it from the README and publish a patch
  version.

## Sanity check before you use it

- [ ] Under 5 MB, loops cleanly, no dead air at either end
- [ ] The failure **and** the fix are both visible
- [ ] No tokens, chat IDs, real hostnames or private paths on screen
- [ ] Readable when you shrink the window to thumbnail size
- [ ] The last frame is the green success line
