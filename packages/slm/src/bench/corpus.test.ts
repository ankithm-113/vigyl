import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { fastClassify } from '../classifier';
import { CORPUS, MODEL_CASES, RULE_CASES } from './corpus';

/**
 * Day 3 split this corpus into failures the rules named and failures only a
 * model could attempt, and benchmarked the model on the second half. It scored
 * 36% in 11–16 seconds per answer.
 *
 * Day 4 widened the rules to cover that half. **They now answer all 20 cases
 * correctly, in about a millisecond, deterministically.** The `reach` field is
 * kept as a record of which layer answered when each case was added, and these
 * tests hold the line: no case may regress to unanswered, and none may be
 * answered with the wrong label.
 */
describe('benchmark corpus', () => {
  it('is answered completely by the rules, with no model at all', () => {
    const unanswered = CORPUS.filter((c) => fastClassify(c.log) === null);
    assert.deepEqual(
      unanswered.map((c) => c.name),
      [],
      'a case the rules cannot name means paying for a cloud call again',
    );
  });

  it('is answered correctly, not merely answered', () => {
    const wrong = CORPUS.filter((c) => fastClassify(c.log)?.errorType !== c.expect)
      .map((c) => `${c.name}: got ${fastClassify(c.log)?.errorType}, wanted ${c.expect}`);
    assert.deepEqual(wrong, []);
  });

  it('covers the cases a local model got wrong', () => {
    // docs/SLM-BENCHMARK.md: 11 cases, 36% from Llama 3.2 1B and Qwen2.5 1.5B.
    assert.ok(MODEL_CASES.length >= 11, 'the benchmarked half must stay in the corpus');
    assert.ok(RULE_CASES.length >= 5);
    assert.equal(RULE_CASES.length + MODEL_CASES.length, CORPUS.length);
  });

  it('answers in microseconds, against seconds for a model', () => {
    const started = process.hrtime.bigint();
    for (const testCase of CORPUS) fastClassify(testCase.log);
    const perCaseMs = Number(process.hrtime.bigint() - started) / 1e6 / CORPUS.length;
    assert.ok(perCaseMs < 20, `expected well under 20ms per case, got ${perCaseMs.toFixed(2)}ms`);
  });

  it('is deterministic', () => {
    for (const testCase of CORPUS) {
      const answers = new Set(
        Array.from({ length: 10 }, () => fastClassify(testCase.log)?.errorType),
      );
      assert.equal(answers.size, 1, `${testCase.name} classified more than one way`);
    }
  });

  it('has no duplicate case names', () => {
    const names = CORPUS.map((c) => c.name);
    assert.equal(new Set(names).size, names.length);
  });

  it('uses realistic multi-line output, not one-liners', () => {
    const newline = String.fromCharCode(10);
    for (const testCase of CORPUS) {
      assert.ok(
        testCase.log.split(newline).length >= 3,
        `${testCase.name} should include surrounding output, not just the error line`,
      );
    }
  });
});
