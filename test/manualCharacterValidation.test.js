import test from 'node:test';
import assert from 'node:assert/strict';
import { validateManualCharacter } from '../lib/manualCharacterValidation.js';

const entry = () => ({ name: ' Chell ', aliases: ['chell', 'Test Subject', 'test subject'], gender: 'female', franchiseIds: [1, 1], portraitUrl: 'https://images.example/chell.webp' });

test('manual metadata requires explicit gender, portrait and franchise and normalizes aliases', () => {
  const result = validateManualCharacter(entry());
  assert.equal(result.name, 'Chell');
  assert.deepEqual(result.aliases, ['Test Subject']);
  assert.deepEqual(result.franchiseIds, [1]);
  assert.equal(result.description, null);
  assert.equal(result.referenceUrl, null);
  assert.equal(validateManualCharacter({ ...entry(), gender: 'unknown' }).gender, 'unknown');
});

test('system-owned identity and likes cannot be injected into validated metadata', () => {
  const result = validateManualCharacter({ ...entry(), id: 'attacker', favourites: 100000, likes_source: 'anilist' });
  assert.equal(Object.hasOwn(result, 'id'), false);
  assert.equal(Object.hasOwn(result, 'favourites'), false);
  assert.equal(Object.hasOwn(result, 'likes_source'), false);
});

test('reject invalid fields and credential-bearing or non-HTTPS URLs', () => {
  for (const overrides of [
    { name: '' }, { name: 'a'.repeat(121) }, { name: 'a\u0000b' },
    { aliases: 'alias' }, { aliases: [''] }, { aliases: Array(51).fill('x') },
    { gender: '' }, { franchiseIds: [] }, { franchiseIds: ['1'] },
    { portraitUrl: 'http://example.com/a.png' }, { portraitUrl: 'https://user:password@example.com/a.png' },
    { portraitUrl: 'javascript:alert(1)' }, { portraitUrl: '' }, { referenceUrl: 'file:///secret' },
    { description: 'a'.repeat(4001) },
  ]) assert.throws(() => validateManualCharacter({ ...entry(), ...overrides }));
});
