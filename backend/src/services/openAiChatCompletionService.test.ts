import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeChatCreateArgsForModel } from './openAiChatCompletionService';

test('normalizeChatCreateArgsForModel migrates max_tokens for gpt-5 models', () => {
  const input = {
    messages: [{ role: 'user', content: 'ping' }],
    max_tokens: 42,
    temperature: 0,
  };
  const normalized = normalizeChatCreateArgsForModel(input, 'gpt-5-mini');

  assert.equal(normalized.max_tokens, undefined);
  assert.equal(normalized.max_completion_tokens, 42);
  assert.equal(normalized.temperature, undefined);
});

test('normalizeChatCreateArgsForModel keeps max_tokens for non gpt-5 models', () => {
  const input = {
    messages: [{ role: 'user', content: 'ping' }],
    max_tokens: 42,
  };
  const normalized = normalizeChatCreateArgsForModel(input, 'gpt-4.1-mini');

  assert.equal(normalized.max_tokens, 42);
  assert.equal(normalized.max_completion_tokens, undefined);
});
