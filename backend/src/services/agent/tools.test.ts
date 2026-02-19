import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeText, resolveLocation } from './tools';

test('normalizeText removes emojis and accents', () => {
  assert.equal(normalizeText('✅ PUENTE ALTO'), 'puente alto');
  assert.equal(normalizeText('Santiago/Ñuñoa'), 'santiago/nunoa');
});

test('resolveLocation detects RM comuna/ciudad/region from messy input', () => {
  const out = resolveLocation('✅ PUENTE ALTO / REGION METROPOLITANA');
  assert.deepEqual(
    { comuna: out.comuna, ciudad: out.ciudad, region: out.region, country: out.country },
    { comuna: 'Puente Alto', ciudad: 'Santiago', region: 'Región Metropolitana', country: 'CL' },
  );
  assert.equal(out.confidence >= 0.8, true);
});

test('resolveLocation handles separators like "/" and keeps accents in canonical labels', () => {
  const out = resolveLocation('Santiago/Ñuñoa');
  assert.deepEqual(
    { comuna: out.comuna, ciudad: out.ciudad, region: out.region, country: out.country },
    { comuna: 'Ñuñoa', ciudad: 'Santiago', region: 'Región Metropolitana', country: 'CL' },
  );
  assert.equal(out.confidence, 0.9);
});

test('resolveLocation returns low confidence when no match', () => {
  const out = resolveLocation('Concón Valparaíso');
  assert.equal(out.confidence, 0);
  assert.equal(out.comuna, null);
});
