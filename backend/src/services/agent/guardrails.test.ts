import test from 'node:test';
import assert from 'node:assert/strict';
import { computeOutboundBlockReason, OutboundLogLike } from './guardrails';

function log(overrides: Partial<OutboundLogLike>): OutboundLogLike {
  return {
    dedupeKey: overrides.dedupeKey || 'k',
    textHash: overrides.textHash || 'h',
    blockedReason: typeof overrides.blockedReason === 'undefined' ? null : overrides.blockedReason,
    createdAt: overrides.createdAt || new Date(),
  };
}

test('computeOutboundBlockReason blocks same dedupeKey', () => {
  const recentLogs = [log({ dedupeKey: 'same', textHash: 'h1', blockedReason: null })];
  assert.equal(
    computeOutboundBlockReason({ recentLogs, dedupeKey: 'same', textHash: 'h2' }),
    'ANTI_LOOP_DEDUPE_KEY',
  );
});

test('computeOutboundBlockReason blocks same textHash', () => {
  const recentLogs = [log({ dedupeKey: 'k1', textHash: 'same', blockedReason: null })];
  assert.equal(
    computeOutboundBlockReason({ recentLogs, dedupeKey: 'k2', textHash: 'same' }),
    'ANTI_LOOP_SAME_TEXT',
  );
});

test('computeOutboundBlockReason allows same text when there is newer inbound', () => {
  const createdAt = new Date('2026-02-18T10:00:00.000Z');
  const recentLogs = [log({ dedupeKey: 'k1', textHash: 'same', blockedReason: null, createdAt })];
  assert.equal(
    computeOutboundBlockReason({
      recentLogs,
      dedupeKey: 'k2',
      textHash: 'same',
      lastInboundAt: new Date('2026-02-18T10:00:01.000Z'),
    }),
    null,
  );
});

test('computeOutboundBlockReason allows same text when stage changed after last outbound', () => {
  const createdAt = new Date('2026-02-18T10:00:00.000Z');
  const recentLogs = [log({ dedupeKey: 'k1', textHash: 'same', blockedReason: null, createdAt })];
  assert.equal(
    computeOutboundBlockReason({
      recentLogs,
      dedupeKey: 'k2',
      textHash: 'same',
      stageChangedAt: new Date('2026-02-18T10:00:02.000Z'),
    }),
    null,
  );
});

test('computeOutboundBlockReason ignores blocked logs', () => {
  const recentLogs = [log({ dedupeKey: 'same', textHash: 'same', blockedReason: 'NO_CONTACTAR' })];
  assert.equal(computeOutboundBlockReason({ recentLogs, dedupeKey: 'same', textHash: 'same' }), null);
});
