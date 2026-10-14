# Local model benchmark — 14 October 2026

Month 2 week 1 asked a question: can a small model running on the user's own
machine classify build failures, so Vigyl stops paying a cloud provider to do
it? This is what the measurements said.

**Short answer: not on this hardware, and the confidence score cannot be used
to tell when it has gone wrong.** The regex fast path was 100% accurate at
~1.5ms. Both local models were 36% accurate at 10–50 seconds, and reported
0.8–0.9 confidence on every wrong answer.

## What was measured

Hardware: Windows 11 laptop, 8 GB RAM (~2 GB free in practice), **no GPU** —
`node-llama-cpp` reports `gpu: false`, 0 GB VRAM, CPU inference only.

| | |
|---|---|
| Corpus | 20 real build failures with known labels |
| of which answered by the regex rules | 9 |
| of which the rules cannot name | **11 — the only ones that matter** |
| Models | Llama 3.2 1B (770 MB), Qwen2.5 1.5B (940 MB), Phi-3 mini 4k (2.2 GB) |

The split is the whole design of the benchmark. In the real loop the model only
sees failures the rules could not name, so measuring accuracy over obvious
`Cannot find module` errors would produce a flattering number that means
nothing. A test enforces the split: every "model" case must return null from
`fastClassify`, and it caught four mislabelled cases when the corpus was first
written.

## Results

| Model | Size | Load | Accuracy | Median | p90 | Mean |
|---|---|---|---|---|---|---|
| **regex fast path** | — | — | **100%** (9/9) | **1.5ms** | — | — |
| Llama 3.2 1B | 0.8 GB | 18.8s | **36%** (4/11) | 11.6s | 36.6s | 20.5s |
| Qwen2.5 1.5B | 1.0 GB | 21.1s | **36%** (4/11) | 16.0s | 54.3s | 28.8s |
| Phi-3 mini 4k | 2.2 GB | — | **could not run** | — | — | — |

### Phi-3 could not run at all

With a 4096 context it refused outright: *"A context size of 4096 is too large
for the available VRAM"* — on a machine with no VRAM, that is the CPU memory
budget. It loads at context 2048, but then the benchmark ran for **13 minutes
without finishing a single classification**, using 110 seconds of CPU in that
time: the process was almost entirely waiting on swap. Free memory dropped to
**0.2 GB** and the whole machine became unresponsive.

It was killed rather than left to finish. A classifier that makes the developer's
laptop unusable has failed regardless of its accuracy.

This is why `SLMClassifier` now negotiates its context size down through
4096 → 2048 → 1024 → 512 instead of failing: an 8 GB machine is not exotic.

### The confidence score is not usable

This matters more than the accuracy figure. The guide's design has the daemon
accept a local classification when `confidence >= 0.7` and fall back to the
cloud otherwise, which only works if the model knows when it is unsure.

It does not. **Every one of the 14 wrong answers across both models came back at
0.80 or 0.90.** Not one fell below the threshold. So the gate would have
accepted all of them, and the self-healing loop would have gone looking for the
wrong kind of problem with full confidence.

### What the models got wrong, and why it is interesting

Both defaulted to `build_error` for nearly everything — which is superficially
reasonable, since all of these failures *did* occur during a build.

The striking part is that the summaries were often right:

> **Qwen on a missing Postgres database:**
> label `build_error` (wrong) — summary *"Database 'app_production' does not
> exist, causing an OperationalError."* (exactly right)

The model had understood the error. It just could not map that understanding
onto the taxonomy.

So the prompt was rewritten with an explicit definition of each label, plus
"choose by what caused the failure, not by what was running when it happened,
and do not default to build_error". **Accuracy did not move: 36% before, 36%
after.** The errors shifted around — Llama started getting `config_error` right
and began calling Rust panics `syntax_error` — but the total did not improve,
and the longer prompt made every classification slower.

That result is worth more than the first one. It says the gap is not a prompt
problem that better wording closes.

## What this means for the product

The guide's premise for week 1 was "classification happens in milliseconds, for
free, on-device" and "90% reduction in cloud API calls". On this hardware the
first half is false: a cloud `gpt-4o-mini` classification takes 1–2 seconds and
costs a fraction of a cent. **The local model is 5–25× slower and wrong about
two thirds of the time.**

What is actually true, and worth keeping:

- **The regex fast path already does the job.** 100% on the failures it
  recognises, in about a millisecond, with no model, no download and no memory.
  It covers the common cases: missing modules, permission errors, connection
  refused, syntax errors, type errors, test failures.
- **The expensive cloud call is already rare**, because the fast path answers
  first. The remaining calls are the hard ones — exactly the cases the small
  models got wrong.

So the honest conclusion is that **local inference should ship disabled, marked
experimental**, and the cost saving should come from widening the rules rather
than from a 2 GB download. The machine that benefits from a local model is one
with a GPU, and that is a different claim to test.

## Reproducing

```bash
vigyl slm download --model llama3.2-1b-q4
npm run build
node packages/slm/dist/bench/run.js llama3.2-1b-q4
```

The corpus is `packages/slm/src/bench/corpus.ts`; add cases there. Anything
added to the `model` half must be one the rules genuinely cannot name, and the
test suite will reject it otherwise.
