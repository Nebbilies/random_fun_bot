import { AFFECTION_CAP, getPerks, relatedAffectionBase } from './affectionRules.js';

const text = value => typeof value==='string' && value.trim().length>0;
const characterId = value => typeof value==='string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
const shape = (value, keys) => value!==null && typeof value==='object' && !Array.isArray(value)
  && Object.keys(value).length===keys.length && keys.every(key=>Object.hasOwn(value,key));
const genreList = value => Array.isArray(value) && value.every(text) && new Set(value).size===value.length;
const invalid = () => { throw new Error('Invalid affection context snapshot; inspect before startup or replay'); };

/** Validate only immutable saved facts, never current ownership, metadata or perks.
 * The context row supplies authority for actor/target; candidate fields cannot redirect it.
 * @param {any} context
 * @returns {any}
 */
export function validateSavedAffectionContext(context) {
  if (![context.source_key,context.guild_id,context.user_id,context.channel_id].every(text)
    || !characterId(context.character_id) || context.capture_version!==1
    || !['captured','completed','canceled'].includes(context.state)) invalid();
  let snapshot;
  try { snapshot=JSON.parse(context.snapshot_json); } catch { invalid(); }
  if (!shape(snapshot,['version','owned','soulmate','matching','awards']) || snapshot.version!==1
    || typeof snapshot.owned!=='boolean' || !Array.isArray(snapshot.awards) || snapshot.awards.length>2) invalid();
  const {soulmate,matching}=snapshot;
  const expected=new Map();
  if (snapshot.owned) expected.set(context.character_id,100);
  if (soulmate!==null) {
    if (!shape(soulmate,['characterId','total']) || !characterId(soulmate.characterId)
      || !Number.isSafeInteger(soulmate.total) || soulmate.total<0 || soulmate.total>AFFECTION_CAP
      || (soulmate.characterId===context.character_id && !snapshot.owned)
      || !shape(matching,['sharedFranchises','soulmateGenres','rolledGenres'])
      || !genreList(matching.soulmateGenres) || !genreList(matching.rolledGenres)
      || !Array.isArray(matching.sharedFranchises)
      || matching.sharedFranchises.some(f=>!shape(f,['franchise_id','size'])
        || !Number.isSafeInteger(f.franchise_id) || f.franchise_id<1 || !Number.isSafeInteger(f.size)
        || f.size<(soulmate.characterId===context.character_id?1:2))
      || new Set(matching.sharedFranchises.map(f=>f.franchise_id)).size!==matching.sharedFranchises.length) invalid();
    if (soulmate.characterId===context.character_id
      && (matching.soulmateGenres.length!==matching.rolledGenres.length
        || matching.soulmateGenres.some(g=>!matching.rolledGenres.includes(g)))) invalid();
    const base=relatedAffectionBase({sharedFranchiseSizes:matching.sharedFranchises.map(f=>f.size),
      soulmateGenres:matching.soulmateGenres,rolledGenres:matching.rolledGenres});
    if (base) expected.set(soulmate.characterId,Math.max(base,expected.get(soulmate.characterId)??0));
  } else if (matching!==null) invalid();
  const chance=getPerks(soulmate?.total??0).unbroken_bond;
  if (snapshot.awards.length!==expected.size) invalid();
  const seen=new Set();
  for (const candidate of snapshot.awards) {
    if (!shape(candidate,['userId','characterId','base','bondChance','bond'])
      || candidate.userId!==context.user_id || !characterId(candidate.characterId)
      || seen.has(candidate.characterId) || !expected.has(candidate.characterId)
      || candidate.base!==expected.get(candidate.characterId)
      || candidate.bondChance!==chance || typeof candidate.bond!=='boolean'
      || (candidate.bond && chance===0)) invalid();
    seen.add(candidate.characterId);
  }
  return snapshot;
}
