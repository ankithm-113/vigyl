import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { parseChatIds } from './config-wizard';

describe('parseChatIds (VIGYL_ALLOWED_CHAT_IDS for headless init)', () => {
  it('parses a comma-separated list, keeping negative group ids', () => {
    assert.deepEqual(parseChatIds('5303349334, -1001234567890 ,7'), [5303349334, -1001234567890, 7]);
  });

  it('treats an empty value as none preset', () => {
    assert.deepEqual(parseChatIds(''), []);
    assert.deepEqual(parseChatIds(' , '), []);
  });

  it('rejects anything that is not a whole number', () => {
    assert.equal(parseChatIds('123,abc'), undefined);
    assert.equal(parseChatIds('1.5'), undefined);
  });
});
