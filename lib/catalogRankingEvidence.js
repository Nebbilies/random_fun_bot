import { nullableRankingInteger } from './catalogRanking.js';
const trusted = new WeakSet();
export const COPYRIGHT_TAG_WARNING = 'This copyright tag uses the franchise-wide post count and general-rated image pool. Images may depict other characters from the franchise.';

/** Trusted HTTP adapter boundary only; HTTP bodies cannot supply this object. */
export function captureRankingTagEvidence(name, result, { allowCopyright = true, now = Date.now() } = {}) {
  if (!result || result.name !== name || !/^(?!.*[*,A-Z])[\x21-\x7E]{2,120}$/.test(name)
    || ![4, ...(allowCopyright ? [3] : [])].includes(result.category) || result.is_deprecated !== false) throw new Error('Tag must be an active Danbooru character or copyright tag');
  const count = nullableRankingInteger(result.post_count, 'Danbooru count');
  if (count === null) throw new Error('Missing Danbooru count');
  const evidence = Object.freeze({ name, category: result.category, post_count: count, observedAt: now });
  trusted.add(evidence);
  return evidence;
}

export function requireRankingTagEvidence(tag, evidence) {
  if (tag === null && evidence == null) return null;
  if (!evidence || !trusted.has(evidence) || evidence.name !== tag) throw new Error('Fresh trusted ranking tag evidence required');
  return evidence;
}
