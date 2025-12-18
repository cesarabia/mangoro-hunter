import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { looksLikeSecretOrToken, normalizeChilePhoneE164 } from './phone';

describe('phone utils', () => {
  it('looksLikeSecretOrToken detects EAAB tokens', () => {
    assert.equal(looksLikeSecretOrToken('EAAB12345abcdef'), true);
  });

  it('looksLikeSecretOrToken detects alphabetic strings', () => {
    assert.equal(looksLikeSecretOrToken('my-token_123'), true);
  });

  it('normalizeChilePhoneE164 normalizes spaced input', () => {
    assert.equal(normalizeChilePhoneE164('+56 9 9483 0202'), '+56994830202');
  });

  it('normalizeChilePhoneE164 adds + when missing', () => {
    assert.equal(normalizeChilePhoneE164('56982345846'), '+56982345846');
  });

  it('normalizeChilePhoneE164 throws for token-ish input', () => {
    assert.throws(() => normalizeChilePhoneE164('EAAB-something-long'), /token\/credencial/i);
  });
});

