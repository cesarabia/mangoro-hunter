import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeEscapedWhitespace } from './text';

test('normalizeEscapedWhitespace converts literal escapes', () => {
  const input = 'L1\\nL2\\tTabbed';
  const out = normalizeEscapedWhitespace(input);
  assert.equal(out, 'L1\nL2\tTabbed');
  assert.equal(out.includes('\\n'), false);
  assert.equal(out.includes('\\t'), false);
});

test('normalizeEscapedWhitespace preserves real newlines', () => {
  const input = 'A\nB';
  const out = normalizeEscapedWhitespace(input);
  assert.equal(out, 'A\nB');
});
