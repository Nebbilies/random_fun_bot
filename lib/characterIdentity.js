import { randomUUID } from 'node:crypto';

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Internal character identity only; source, roll, marriage and Discord IDs differ. */
export function isCharacterId(value) {
  return typeof value === 'string' && UUID_V4.test(value);
}

export function createCharacterId() {
  return randomUUID();
}

export function requireCharacterId(value) {
  if (!isCharacterId(value)) throw new Error('Invalid character UUID');
  return value.toLowerCase();
}

/** Canonical source key at an AniList adapter boundary, never a game identity. */
export function normalizeAniListCharacterId(value) {
  const text = typeof value === 'number' ? String(value) : value;
  if (typeof text !== 'string' || !/^[1-9]\d*$/.test(text)) throw new Error('Invalid AniList character ID');
  if (!Number.isSafeInteger(Number(text))) throw new Error('Invalid AniList character ID');
  return text;
}
