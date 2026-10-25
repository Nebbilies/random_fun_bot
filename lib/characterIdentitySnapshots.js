// Offline historical codecs. Dispatch by producer, never by a recursive number/id rewrite.
export const IDENTITY_JSON_COLUMNS = Object.freeze({
  item_actions: ['selections_json', 'result_json', 'crown_json'],
  mystery_sessions: ['state_json'], active_user_buffs: ['data_json'],
  item_action_costs: ['snapshot_json'],
});
const ACTIONS = new Set(['alchemist', 'chaos_exchange', 'counterfeit_crown', 'heart_for_a_heart',
  'hostage_note', 'severed_fate', 'grand_masquerade', 'kaimetsu']);
const BUFFS = {
  four_leaf_clover: 'rolls minFavourites maxRank', rolling_fever: 'rolls favouritesThreshold refundRolls',
  adrenaline_rush: 'durationMs allowanceMultiplier', pinata: 'rolls minFavourites maxRank claimTokens',
  pinata_claim_token: 'rolls minFavourites maxRank claimTokens', engagement_ring: 'claims cooldownMultiplier',
  double_date: 'durationMs', franchise_passport: 'rolls franchiseId name', crown_of_the_sovereign: 'claimTokens',
};
const EVENTS = {
  doors: 'status rollerId winningDoor deadlineAt',
  treasure_hunt: 'status puzzleId startedAt deadlineAt clueIndex',
  clue_reveal: 'animeId title aliases clues stage startedAt guessedAtStage',
  greed_chamber: 'phase round startedAt players choices', deadlock: 'phase round startedAt players choices',
};
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

/** Returns typed legacy references and rewritten text. Unchanged JSON stays byte-for-byte.
 * mapping omitted means inventory/validation only. Diagnostics include table, row and JSON path.
 */
export function adaptCharacterSnapshot(table, column, row, mapping) {
  const label = `${table}[${row.id ?? row.action_id ?? row.buff_id ?? '?'}].${column}`;
  const fail = (path, reason) => { throw new Error(`${label}${path}: ${reason}`); };
  const raw = row[column];
  if (raw == null) return { json: raw, references: [] };
  let value;
  try { value = JSON.parse(raw); } catch { fail('', 'Invalid JSON'); }
  const references = [];
  const keys = (v, allowed, path) => {
    if (!object(v)) fail(path, 'expected object');
    for (const key of Object.keys(v)) if (!allowed.split(' ').includes(key)) fail(`${path}.${key}`, 'unknown shape-specific field');
  };
  const array = (v, path, visit) => {
    if (!Array.isArray(v)) fail(path, 'expected array');
    v.forEach((item, i) => visit(item, `${path}[${i}]`));
  };
  // Configuration/item-definition subtrees have dynamic keys, but cannot hide character references.
  const noCharacters = (v, path) => {
    if (!v || typeof v !== 'object') return;
    for (const [key, child] of Object.entries(v)) {
      if (/character/i.test(key)) fail(`${path}.${key}`, 'unreviewed character-bearing shape');
      noCharacters(child, `${path}.${key}`);
    }
  };
  const reference = (v, key, path) => {
    const id = v[key];
    if (!Number.isSafeInteger(id) || id <= 0) fail(`${path}.${key}`, 'invalid legacy character reference');
    references.push({ id, path: `${label}${path}.${key}` });
    if (mapping) {
      if (!mapping.has(id)) fail(`${path}.${key}`, `Unresolved reference ${id}`);
      v[key] = mapping.get(id);
    }
  };
  const choice = (v, path) => {
    keys(v, 'characterId marriageId ownerId rank name', path);
    reference(v, 'characterId', path);
    if (!Number.isSafeInteger(v.marriageId) || v.marriageId <= 0 || typeof v.ownerId !== 'string') fail(path, 'invalid ownership choice');
  };
  if (table === 'item_actions') {
    if (!ACTIONS.has(row.kind)) fail('', `unknown action kind ${row.kind}`);
    if (column === 'selections_json') {
      keys(value, 'own targets originals inventoryIds users _ui _rules _rewardPools', '');
      if ('own' in value && value.own !== null) choice(value.own, '.own');
      for (const key of ['targets', 'originals']) if (key in value) array(value[key], `.${key}`, choice);
      if ('inventoryIds' in value) array(value.inventoryIds, '.inventoryIds', (v, p) => {
        if (!Number.isSafeInteger(v) || v <= 0) fail(p, 'invalid inventory ID');
      });
      if ('users' in value) array(value.users, '.users', (v, p) => { if (typeof v !== 'string') fail(p, 'invalid user ID'); });
      if ('_ui' in value) { keys(value._ui, 'users slot page messageId privateDelivered privateMessageId', '._ui'); noCharacters(value._ui, '._ui'); }
      if ('_ui' in value) for (const [key, v] of Object.entries(value._ui)) {
        if (key === 'users') array(v, '._ui.users', (user, p) => { if (typeof user !== 'string') fail(p, 'invalid user ID'); });
        else if (v !== null && typeof v === 'object') fail(`._ui.${key}`, 'expected scalar UI value');
      }
      for (const key of ['_rules', '_rewardPools']) if (key in value) noCharacters(value[key], `.${key}`);
    } else if (column === 'crown_json') {
      array(value, '', (v, p) => {
        keys(v, 'guild_id user_id character_id marriage_id generation_id', p);
        reference(v, 'character_id', p);
        if (!Number.isSafeInteger(v.marriage_id) || typeof v.user_id !== 'string'
          || typeof v.guild_id !== 'string' || typeof v.generation_id !== 'string') fail(p, 'invalid crown row');
      });
    } else if (column === 'result_json') {
      const extra = { alchemist: 'rewardId', counterfeit_crown: 'privateCharacter', chaos_exchange: 'character',
        heart_for_a_heart: 'originals targets blocked', severed_fate: 'originals targets blocked',
        grand_masquerade: 'originals targets assignment', hostage_note: 'choice loser characters blocked',
        kaimetsu: 'kind actorId totalDivorced affectedOwners noCost' }[row.kind];
      const maintenance = value.canceledBy === 'uuid_maintenance';
      keys(value, `status message ${extra}${maintenance ? ' canceledBy canceledAt releasedEscrow' : ''}`, '');
      if (maintenance) {
        if (row.state !== 'canceled' || value.status !== 'canceled' || !Number.isSafeInteger(value.canceledAt)) fail('', 'invalid maintenance cancellation');
        array(value.releasedEscrow, '.releasedEscrow', (escrow, path) => {
          keys(escrow, 'inventoryId snapshotJson', path);
          if (!Number.isSafeInteger(escrow.inventoryId) || typeof escrow.snapshotJson !== 'string') fail(path, 'invalid released escrow');
          adaptCharacterSnapshot('item_action_costs', 'snapshot_json', { action_id: row.id, snapshot_json: escrow.snapshotJson });
        });
      }
      if ('privateCharacter' in value) choice(value.privateCharacter, '.privateCharacter');
      if ('character' in value) {
        keys(value.character, 'id name rank', '.character'); reference(value.character, 'id', '.character');
      }
      for (const key of ['originals', 'targets', 'characters']) if (key in value) array(value[key], `.${key}`, choice);
      if ('loser' in value && value.loser !== null) choice(value.loser, '.loser');
      if ('assignment' in value) array(value.assignment, '.assignment', (v, p) => { if (!Number.isSafeInteger(v)) fail(p, 'invalid assignment'); });
      for (const [key, v] of Object.entries(value)) {
        if (!['privateCharacter', 'character', 'originals', 'targets', 'characters', 'loser', 'assignment', ...(maintenance ? ['releasedEscrow'] : [])].includes(key)
          && v !== null && typeof v === 'object') fail(`.${key}`, 'expected scalar result value');
      }
    } else fail('', 'unreviewed column');
  } else if (table === 'active_user_buffs') {
    // NULL and empty legacy snapshots have no reference, including custom/retired buffs.
    if (value !== null && (!object(value) || Object.keys(value).length)) {
      if (!BUFFS[row.buff_id]) fail('', `unknown buff ${row.buff_id}`);
      keys(value, `${BUFFS[row.buff_id]} startingCharges rewardEligible`, '');
      noCharacters(value, '');
      for (const [key, v] of Object.entries(value)) if (v !== null && typeof v === 'object') fail(`.${key}`, 'expected scalar buff value');
    }
  } else if (table === 'mystery_sessions') {
    keys(value, `${EVENTS[row.event_id] ?? ''} rules gameConfig`, '');
    if (Object.keys(value).length && !EVENTS[row.event_id]) fail('', `unknown mystery event ${row.event_id}`);
    noCharacters(value, '');
    for (const key of ['players', 'choices', 'guessedAtStage']) if (key in value && !object(value[key])) fail(`.${key}`, 'expected user-keyed object');
    if (value.players) for (const [id, player] of Object.entries(value.players)) keys(player,
      row.event_id === 'greed_chamber' ? 'score banked status' : 'score', `.players.${id}`);
    for (const key of ['aliases', 'clues']) if (key in value) array(value[key], `.${key}`, (v, p) => { if (typeof v !== 'string') fail(p, 'expected text'); });
    for (const key of ['choices', 'guessedAtStage']) if (value[key]) {
      for (const [id, v] of Object.entries(value[key])) if (v !== null && typeof v === 'object') fail(`.${key}.${id}`, 'expected scalar user value');
    }
    for (const [key, v] of Object.entries(value)) {
      if (!['rules', 'gameConfig', 'players', 'choices', 'guessedAtStage', 'aliases', 'clues'].includes(key)
        && v !== null && typeof v === 'object') fail(`.${key}`, 'expected scalar event value');
    }
  } else if (table === 'item_action_costs') {
    // The inventory escrow producer has no character shape: id is an inventory ID.
    keys(value, 'id guild_id user_id item_id charges acquired_at', '');
    if (!Number.isSafeInteger(value.id) || typeof value.item_id !== 'string') fail('', 'invalid inventory snapshot');
  } else fail('', 'unreviewed table');
  return { json: mapping && references.length ? JSON.stringify(value) : raw, references };
}
