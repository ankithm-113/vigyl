import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { fastClassify } from '../classifier';
import { CORPUS, MODEL_CASES, RULE_CASES } from './corpus';

/**
 * The benchmark is only honest if its two halves are what they claim.
 *
 * If a 'model' case is actually answered by the rules, the benchmark measures
 * the rules and reports it as model accuracy — a flattering number that says
 * nothing about the thing being chosen.
 */
describe('benchmark corpus', () => {
  it('splits into cases the rules answer and cases they do not', () => {
    assert.equal(RULE_CASES.length + MODEL_CASES.length, CORPUS.length);
    assert.ok(RULE_CASES.length >= 5);
    assert.ok(MODEL_CASES.length >= 10, 'the model half is the one that matters');
  });

  it('every "rules" case really is answered by the rules, correctly', () => {
    for (const testCase of RULE_CASES) {
      const result = fastClassify(testCase.log);
      assert.ok(result, `rules did not answer: ${testCase.name}`);
      assert.equal(result.errorType, testCase.expect, `wrong label for: ${testCase.name}`);
    }
  });

  it('every "model" case really is one the rules cannot name', () => {
    for (const testCase of MODEL_CASES) {
      const result = fastClassify(testCase.log);
      assert.equal(
        result,
        null,
        `${testCase.name} is answered by the rules, so it does not belong in the model half`,
      );
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
