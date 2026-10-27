import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { getVaultSession, drawVaultSessionOutcome } from './vaultSessions.js';

export function inspectFortuneRuntime(db) {
  const blockers = [], recoverable = [];
  if (!hasFortune(db)) return { blockers: [{ code: 'fortune_schema_missing', table: 'fortune_schema', detail: 'Explicit offline Fortune upgrade required.' }], recoverable };
  const versions = db.prepare('SELECT version FROM fortune_schema').all();
  if (versions.length !== 1 || versions[0].version !== 1) blockers.push({ code: 'fortune_schema_invalid', table: 'fortune_schema', detail: 'Unsupported Fortune schema version' });
  const issue = (table, id, detail) => blockers.push({ code: 'invalid_fortune_state', table, id, detail });
  const outcomeValid = outcome => outcome && typeof outcome.item?.id === 'string' && typeof outcome.item.name === 'string'
    && outcome.item.tier === outcome.tier && outcome._fortuneVersion === 1 && outcome._rules?.doubleDecisionMs > 0
    && outcome._rewardPools && ['common','rare','epic','legendary','???'].every(tier => Array.isArray(outcome._rewardPools[tier]));
  const matchingHold = (inventoryId, kind, guildId, userId, referenceId = null) => db.prepare(`SELECT 1 FROM fortune_holds
    WHERE inventory_id=? AND kind=? AND guild_id=? AND user_id=? AND (? IS NULL OR reference_id=?)`)
    .get(inventoryId, kind, guildId, userId, referenceId, referenceId);
  for (const hold of db.prepare('SELECT * FROM fortune_holds').all()) {
    const source = db.prepare('SELECT * FROM user_inventory WHERE id=?').get(hold.inventory_id);
    let lens = null;
    try { lens = hold.kind === 'lens' ? getLens(db, hold.reference_id) : null; }
    catch { issue('fortune_holds', hold.inventory_id, 'Corrupt held Lens candidates'); }
    const armed = hold.kind === 'recast' ? getArmedRecast(db, hold.guild_id, hold.user_id) : null;
    if (!source || source.guild_id !== hold.guild_id || source.user_id !== hold.user_id
      || source.item_id !== (hold.kind === 'lens' ? 'fortunes_lens' : 'fortunes_recast')
      || !Number.isSafeInteger(source.charges) || source.charges < (hold.kind === 'lens' ? 0 : 1)
      || (hold.kind === 'lens' ? lens?.state !== 'pending' || lens.inventory_id !== hold.inventory_id : armed?.inventory_id !== hold.inventory_id)
      || db.prepare('SELECT 1 FROM item_action_costs WHERE inventory_id=?').get(hold.inventory_id)) issue('fortune_holds', hold.inventory_id, 'Held source/provenance conflict');
  }
  for (const armed of db.prepare('SELECT * FROM fortune_armed').all()) {
    if (!Number.isSafeInteger(armed.armed_at) || armed.armed_at < 0
      || !matchingHold(armed.inventory_id, 'recast', armed.guild_id, armed.user_id)) issue('fortune_armed', armed.inventory_id, 'Armed effect missing held charge');
    else recoverable.push({ kind: 'armed_recast', id: armed.inventory_id });
  }
  for (const row of db.prepare('SELECT vault_id FROM fortune_lens').all()) {
    try {
      const lens = getLens(db, row.vault_id), session = getVaultSession(db, row.vault_id);
      if (!session || session.captured.fortuneVersion !== 1 || !Array.isArray(lens.candidates) || lens.candidates.length !== 3 || !lens.candidates.every(outcomeValid)
        || !Number.isSafeInteger(lens.created_at) || lens.created_at < session.createdAt || lens.created_at >= session.deadline
        || (lens.state === 'pending' && !matchingHold(lens.inventory_id, 'lens', session.guildId, session.rollerId, row.vault_id))
        || (lens.state === 'presented' && !Number.isSafeInteger(lens.presented_at))) throw new Error('Invalid Lens captured state/source');
      if (lens.state === 'pending') recoverable.push({ kind: 'fortune_lens', id: row.vault_id });
    } catch (error) { issue('fortune_lens', row.vault_id, error.message); }
  }
  for (const row of db.prepare('SELECT vault_id FROM fortune_recasts').all()) {
    try {
      const decision = getRecast(db, row.vault_id);
      const reward = db.prepare('SELECT * FROM vault_rewards WHERE vault_id=?').get(row.vault_id);
      const ids = decision.alternatives.map(item => item.id);
      const armed = getArmedRecast(db, decision.guild_id, decision.user_id);
      const selected = decision.state === 'chosen' && decision.choice !== -1
        ? { ...decision.original, item: decision.alternatives[decision.choice] } : decision.original;
      if (!Number.isSafeInteger(decision.created_at) || decision.created_at < reward?.created_at
        || !Number.isSafeInteger(decision.duration_ms) || decision.duration_ms < 1 || decision.duration_ms > 2147483647
        || (decision.state !== 'pending' && (!Number.isSafeInteger(decision.presented_at) || decision.presented_at < decision.created_at
          || !Number.isSafeInteger(decision.deadline) || decision.deadline !== decision.presented_at + decision.duration_ms))
        || !reward || reward.guild_id !== decision.guild_id || reward.user_id !== decision.user_id || !outcomeValid(decision.original)
        || decision.duration_ms !== decision.original._rules.doubleDecisionMs || new Set(ids).size !== ids.length
        || decision.alternatives.some(item => item.id === decision.original.item.id || item.tier !== decision.original.tier
          || !decision.original._rewardPools[item.tier].some(candidate => JSON.stringify(candidate) === JSON.stringify(item)))
        || (decision.state !== 'chosen' && reward.state !== 'recast')
        || (decision.state === 'chosen' && (!['delivered', 'overflow', 'declined'].includes(reward.state)
          || !Number.isInteger(decision.choice) || decision.choice < -1 || decision.choice >= ids.length))
        || !isDeepStrictEqual(JSON.parse(reward.reward_json), selected)
        || (decision.state === 'pending' && (!matchingHold(decision.inventory_id, 'recast', decision.guild_id, decision.user_id)
          || armed?.inventory_id !== decision.inventory_id))) throw new Error('Invalid Recast terms/delivery/source linkage');
      if (decision.state !== 'chosen') recoverable.push({ kind: 'fortune_recast', id: row.vault_id });
    } catch (error) { issue('fortune_recasts', row.vault_id, error.message); }
  }
  for (const row of db.prepare("SELECT vault_id FROM vault_rewards WHERE state='recast'").all()) {
    if (!db.prepare('SELECT 1 FROM fortune_recasts WHERE vault_id=?').get(row.vault_id)) issue('vault_rewards', row.vault_id, 'Missing persisted Recast decision');
  }
  return { blockers, recoverable };
}

export function hasFortune(db) {
  return !!db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='fortune_schema'").get();
}
export function fortuneTransaction(db, operation) {
  if (db.isTransaction) return operation();
  db.exec('BEGIN IMMEDIATE');
  try { const result = operation(); db.exec('COMMIT'); return result; }
  catch (error) { db.exec('ROLLBACK'); throw error; }
}
export function getArmedRecast(db, guildId, userId) {
  return hasFortune(db) ? db.prepare('SELECT * FROM fortune_armed WHERE guild_id=? AND user_id=?').get(guildId, userId) ?? null : null;
}
export function isFortuneHeld(db, inventoryId) {
  return hasFortune(db) && !!db.prepare('SELECT 1 FROM fortune_holds WHERE inventory_id=?').get(inventoryId);
}
function available(db, guildId, userId, inventoryId, itemId) {
  return db.prepare(`SELECT i.* FROM user_inventory i WHERE i.guild_id=? AND i.user_id=?
    AND i.item_id=? AND i.charges>0 AND (? IS NULL OR i.id=?)
    AND NOT EXISTS(SELECT 1 FROM item_action_costs c WHERE c.inventory_id=i.id)
    AND NOT EXISTS(SELECT 1 FROM fortune_holds h WHERE h.inventory_id=i.id)
    ORDER BY i.id LIMIT 1`).get(guildId, userId, itemId, inventoryId ?? null, inventoryId ?? null);
}
export function getLens(db, vaultId) {
  if (!hasFortune(db)) return null;
  const row = db.prepare('SELECT * FROM fortune_lens WHERE vault_id=?').get(vaultId);
  return row ? { ...row, candidates: JSON.parse(row.candidates_json) } : null;
}
export function activateLens(db, { vaultId, guildId, userId, channelId, messageId, now = Date.now(), random = Math.random }) {
  if (!hasFortune(db)) return { status: 'unsupported' };
  return fortuneTransaction(db, () => {
    const session = getVaultSession(db, vaultId);
    if (!session || session.guildId !== guildId || session.rollerId !== userId || session.channelId !== channelId || !messageId || session.messageId !== messageId) return { status: 'forbidden' };
    if (session.state !== 'unopened' || now >= session.deadline || session.captured.fortuneVersion !== 1) return { status: 'stale' };
    const existing = getLens(db, vaultId);
    if (existing) return { status: 'existing', lens: existing };
    const source = available(db, guildId, userId, null, 'fortunes_lens');
    if (!source) return { status: 'missing_item' };
    const candidates = Array.from({ length: 3 }, () => drawVaultSessionOutcome(session, random));
    db.prepare("INSERT INTO fortune_holds VALUES(?,?,?,'lens',?)").run(source.id, guildId, userId, vaultId);
    db.prepare('UPDATE user_inventory SET charges=charges-1 WHERE id=?').run(source.id);
    db.prepare("INSERT INTO fortune_lens VALUES(?,?,?,'pending',?,NULL)").run(vaultId, source.id, JSON.stringify(candidates), now);
    return { status: 'revealed', lens: getLens(db, vaultId) };
  });
}
function releaseSource(db, inventoryId) {
  db.prepare('DELETE FROM fortune_holds WHERE inventory_id=?').run(inventoryId);
  db.prepare('DELETE FROM user_inventory WHERE id=? AND charges=0').run(inventoryId);
}
export function acknowledgeLens(db, vaultId, now = Date.now()) {
  return fortuneTransaction(db, () => {
    const lens = getLens(db, vaultId);
    if (!lens || lens.state !== 'pending') return false;
    db.prepare("UPDATE fortune_lens SET state='presented',presented_at=? WHERE vault_id=?").run(now, vaultId);
    releaseSource(db, lens.inventory_id);
    return true;
  });
}
/** absent must come from a definitive canonical message inspection, never a transport error. */
export function refundUnpresentedLens(db, vaultId, { absent = false, now = Date.now() } = {}) {
  return fortuneTransaction(db, () => {
    const lens = getLens(db, vaultId), session = getVaultSession(db, vaultId);
    if (!absent || !lens || lens.state !== 'pending' || !session || session.state === 'revealed' || now < session.deadline) return false;
    db.prepare('UPDATE user_inventory SET charges=charges+1 WHERE id=?').run(lens.inventory_id);
    releaseSource(db, lens.inventory_id);
    db.prepare("UPDATE fortune_lens SET state='refunded' WHERE vault_id=?").run(vaultId);
    return true;
  });
}
export function getRecast(db, vaultId) {
  if (!hasFortune(db)) return null;
  const row = db.prepare('SELECT * FROM fortune_recasts WHERE vault_id=?').get(vaultId);
  return row ? { ...row, original: JSON.parse(row.original_json), alternatives: JSON.parse(row.alternatives_json) } : null;
}
/** Called inside the authoritative reward delivery transaction. */
export function prepareRecast(db, reward, outcome, now, random = Math.random) {
  if (outcome._fortuneVersion !== 1 || !hasFortune(db)) return null;
  const existing = getRecast(db, reward.vaultId);
  if (existing) return existing;
  const armed = getArmedRecast(db, reward.guildId, reward.userId);
  if (!armed || db.prepare("SELECT 1 FROM fortune_recasts WHERE guild_id=? AND user_id=? AND state IN ('pending','presented')").get(reward.guildId, reward.userId)) return null;
  const pool = [...new Map((outcome._rewardPools?.[outcome.tier] ?? [])
    .filter(item => item.id !== outcome.item.id && item.tier === outcome.tier && item.rewardEligible !== false).map(item => [item.id, item])).values()];
  if (!pool.length) return null;
  const alternatives = [];
  while (pool.length && alternatives.length < 3) {
    const value = random();
    if (!Number.isFinite(value) || value < 0 || value >= 1) throw new Error('Invalid random value');
    alternatives.push(pool.splice(Math.floor(value * pool.length), 1)[0]);
  }
  db.prepare("INSERT INTO fortune_recasts VALUES(?,?,?,?,?,?,?,'pending',?,NULL,NULL,NULL)")
    .run(reward.vaultId, reward.guildId, reward.userId, armed.inventory_id, JSON.stringify(outcome), JSON.stringify(alternatives), outcome._rules.doubleDecisionMs, now);
  return getRecast(db, reward.vaultId);
}
function recastScope(db, request) {
  const row = db.prepare('SELECT * FROM vault_rewards WHERE vault_id=?').get(request.vaultId);
  return row && row.state === 'recast' && row.guild_id === request.guildId && row.user_id === request.userId
    && row.channel_id === request.channelId && !!request.messageId && row.message_id === request.messageId;
}
export function presentRecast(db, request) {
  return fortuneTransaction(db, () => {
    const decision = getRecast(db, request.vaultId);
    if (!decision || !recastScope(db, request)) return { status: 'forbidden' };
    if (decision.state !== 'pending') return { status: decision.state, decision };
    const now = request.now ?? Date.now();
    const source = db.prepare('SELECT charges FROM user_inventory WHERE id=?').get(decision.inventory_id);
    if (!source || source.charges < 1 || !isFortuneHeld(db, decision.inventory_id)) throw new Error('Missing reserved Recast source');
    db.prepare('DELETE FROM fortune_armed WHERE inventory_id=?').run(decision.inventory_id);
    db.prepare('UPDATE user_inventory SET charges=charges-1 WHERE id=?').run(decision.inventory_id);
    releaseSource(db, decision.inventory_id);
    db.prepare("UPDATE fortune_recasts SET state='presented',presented_at=?,deadline=? WHERE vault_id=?").run(now, now + decision.duration_ms, request.vaultId);
    return { status: 'presented', decision: getRecast(db, request.vaultId) };
  });
}
/** Only returns the persisted choice; the reward service owns inventory delivery. */
export function chooseRecast(db, request) {
  return fortuneTransaction(db, () => {
    if (!recastScope(db, request)) return { status: 'forbidden' };
    let decision = getRecast(db, request.vaultId);
    if (!decision || decision.state === 'chosen') return { status: 'stale' };
    const choice = request.choice;
    if (!Number.isInteger(choice) || choice < -1 || choice >= decision.alternatives.length) return { status: 'invalid' };
    if (decision.state === 'pending') decision = presentRecast(db, request).decision;
    const selected = (request.now ?? Date.now()) >= decision.deadline ? -1 : choice;
    db.prepare("UPDATE fortune_recasts SET state='chosen',choice=? WHERE vault_id=?").run(selected, request.vaultId);
    return { status: 'chosen', outcome: selected === -1 ? decision.original : { ...decision.original, item: decision.alternatives[selected] } };
  });
}
export function armRecast(db, { guildId, userId, inventoryId, now = Date.now() }) {
  if (!hasFortune(db)) return { status: 'unsupported' };
  return fortuneTransaction(db, () => {
    if (getArmedRecast(db, guildId, userId)) return { status: 'already_armed' };
    if (db.prepare("SELECT 1 FROM fortune_recasts WHERE guild_id=? AND user_id=? AND state IN ('pending','presented')").get(guildId, userId)) return { status: 'choice_pending' };
    const entry = available(db, guildId, userId, inventoryId, 'fortunes_recast');
    if (!entry) return { status: 'missing_item' };
    db.prepare("INSERT INTO fortune_holds VALUES(?,?,?,'recast',?)").run(entry.id, guildId, userId, randomUUID());
    db.prepare('INSERT INTO fortune_armed VALUES(?,?,?,?)').run(guildId, userId, entry.id, now);
    return { status: 'armed' };
  });
}
