import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveModelChain } from './modelResolutionService';

test('resolveModelChain preserves modelOverride exact string', () => {
  const resolved = resolveModelChain({
    modelOverride: 'gpt-5-mini-2025-08-07',
    modelAlias: 'gpt-4.1-mini',
    legacyModel: null,
    defaultModel: 'gpt-4.1-mini',
  });
  assert.equal(resolved.modelOverride, 'gpt-5-mini-2025-08-07');
  assert.equal(resolved.modelRequested, 'gpt-5-mini-2025-08-07');
  assert.equal(resolved.modelChain[0], 'gpt-5-mini-2025-08-07');
});

test('resolveModelChain normalizes modelAlias for runtime without mutating stored alias', () => {
  const resolved = resolveModelChain({
    modelOverride: null,
    modelAlias: 'gpt-5-mini',
    legacyModel: null,
    defaultModel: 'gpt-4.1-mini',
  });
  assert.equal(resolved.modelAliasStored, 'gpt-5-mini');
  assert.equal(resolved.modelAliasResolved, 'gpt-5-chat-latest');
  assert.equal(resolved.modelRequested, 'gpt-5-chat-latest');
});

test('resolveModelChain falls back to legacy model if alias is empty', () => {
  const resolved = resolveModelChain({
    modelOverride: null,
    modelAlias: '',
    legacyModel: 'gpt-4.1-mini',
    defaultModel: 'gpt-4.1-mini',
  });
  assert.equal(resolved.modelAliasStored, 'gpt-4.1-mini');
  assert.equal(resolved.modelRequested, 'gpt-4.1-mini');
});

