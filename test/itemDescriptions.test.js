import test from 'node:test';
import assert from 'node:assert/strict';
import { openCatalog } from '../lib/catalogDb.js';
import { getItemDefinition, getResolvedItemDefinition } from '../lib/itemRoster.js';
import { getConfigView, saveConfigSection } from '../lib/gameConfig.js';
import { getItemHelpBullet } from '../commands/inv.js';

function fixture(t) {
  const db = openCatalog(':memory:');
  t.after(() => db.close());
  return db;
}

function save(db, section, values) {
  saveConfigSection(db, { guildId: '1', section, values,
    expectedRevision: getConfigView(db, '1').revision });
}

test('Piñata describes the shared qualifying rolls and separate personal cooldown bypass', (t) => {
  const db = fixture(t);
  for (const item of [getItemDefinition('pinata'), getResolvedItemDefinition(db, '1', 'pinata')]) {
    assert.match(item.description, /next 10 qualifying rolls.*server/i);
    assert.match(item.description, /high-favorite/i);
    assert.match(item.description, /you.*1 personal extra claim token.*bypasses.*cooldown/i);
    assert.doesNotMatch(item.description, /2x|double|reset/i);
  }
  for (const item of [getItemDefinition('pinata'), getResolvedItemDefinition(db, '1', 'pinata')]) {
    assert.match(getItemHelpBullet(item), /1 personal extra claim token/);
    assert.doesNotMatch(getItemHelpBullet(item), /reset your claim cooldown/);
  }
});

test('resolved Piñata description follows effective server settings', (t) => {
  const db = fixture(t);
  save(db, 'itemEffects', { 'itemEffects.pinata.rolls': 4, 'itemEffects.pinata.claimTokens': 2,
    'itemEffects.pinata.minFavourites': 2000, 'itemEffects.pinata.maxRank': 500 });
  const text = getResolvedItemDefinition(db, '1', 'pinata').description;
  assert.match(text, /next 4 qualifying rolls/);
  assert.match(text, /2 personal extra claim tokens/);
  assert.match(text, /2000 favorites or.*500/);
  assert.match(getResolvedItemDefinition(db, '2', 'pinata').description, /next 10 qualifying rolls/);
});

test('Double Date describes two timed free claims and cooldown bypass', (t) => {
  const db = fixture(t);
  for (const item of [getItemDefinition('double_date'), getResolvedItemDefinition(db, '1', 'double_date')]) {
    assert.match(item.description, /10 minutes after activation/);
    assert.match(item.description, /2 free claims/);
    assert.match(item.description, /even during your normal claim cooldown/);
    assert.match(item.description, /do not spend or reset/);
    assert.doesNotMatch(item.description, /2nd claim|when you marry/i);
  }
});

test('franchise summons describe availability and do not promise a Blood Pact rank upgrade', (t) => {
  const db = fixture(t);
  for (const resolve of [id => getItemDefinition(id), id => getResolvedItemDefinition(db, '1', id)]) {
    assert.match(resolve('wish_upon_a_star').description, /top 3/);
    assert.match(resolve('wish_upon_a_star').description, /otherwise.*most-favorited available/);
    assert.match(resolve('blood_pact').description, /best-ranked available unowned/);
    assert.doesNotMatch(resolve('blood_pact').description, /higher.rank|better than/i);
  }
});

test('action descriptions explain the stakes without internal terminology', () => {
  assert.match(getItemDefinition('double_or_nothing').description, /lose.*reward/);
  assert.match(getItemDefinition('hostage_note').description, /their nominated character has a 50% chance of divorce/);
  assert.match(getItemDefinition('hostage_note').description, /Your character is never at risk/);
  assert.match(getItemDefinition('counterfeit_crown').description, /redirect.*attack.*decoy/);
  assert.match(getItemDefinition('grand_masquerade').description, /nobody gets their own character back/);
  assert.doesNotMatch(getItemDefinition('chaos_exchange').description, /rank interval/);
  assert.match(getItemDefinition('heart_for_a_heart').description, /larger rank number/);
});

test('resolved timed and counted effects use effective values rather than historical defaults', (t) => {
  const db = fixture(t);
  save(db, 'itemEffects', { 'itemEffects.adrenaline_rush.durationMs': 120000,
    'itemEffects.adrenaline_rush.allowanceMultiplier': 3,
    'itemEffects.rolling_fever.rolls': 4, 'itemEffects.rolling_fever.refundRolls': 3,
    'itemEffects.rolling_fever.favouritesThreshold': 2500 });
  assert.match(getResolvedItemDefinition(db, '1', 'adrenaline_rush').description, /3x.*2 minutes/);
  assert.match(getResolvedItemDefinition(db, '1', 'rolling_fever').description, /4 character rolls.*over 2500 favorites.*3 rolls/);
});

test('Aegis description shows its current effective duration', t => {
  const db = fixture(t);
  assert.match(getResolvedItemDefinition(db, '1', 'aegis_of_fidelity').description, /for 7 days/);
  save(db, 'itemEffects', { 'itemEffects.aegis_of_fidelity.protectionMs': 5_400_000 });
  assert.match(getResolvedItemDefinition(db, '1', 'aegis_of_fidelity').description, /for 1 hour 30 minutes/);
  assert.match(getResolvedItemDefinition(db, '2', 'aegis_of_fidelity').description, /for 7 days/);
  assert.match(getItemHelpBullet(getResolvedItemDefinition(db, '1', 'aegis_of_fidelity')), /for 1 hour 30 minutes/);
});

test('resolved action descriptions follow configured costs and rank bounds', (t) => {
  const db = fixture(t);
  save(db, 'itemActions', { 'itemActions.alchemistCost': 4,
    'itemActions.chaosMinRankMultiplier': 0.75, 'itemActions.chaosMaxRankMultiplier': 1.5 });
  assert.match(getResolvedItemDefinition(db, '1', 'alchemist').description, /4 Common inventory items/);
  assert.match(getResolvedItemDefinition(db, '1', 'chaos_exchange').description, /0.75x and 1.5x/);
});

test('legacy help no longer promises unlimited rolls or guaranteed rank upgrades', () => {
  assert.doesNotMatch(getItemHelpBullet(getItemDefinition('golden_hour')), /unlimited|Happy Hour/);
  assert.match(getItemHelpBullet(getItemDefinition('golden_hour')), /everyone's hourly rolls in this server/);
  assert.match(getItemHelpBullet(getItemDefinition('blood_pact')), /rank upgrade is not guaranteed/);
  assert.match(getItemHelpBullet(getItemDefinition('double_date')), /2 free claims/);
  assert.match(getItemHelpBullet(getItemDefinition('wish_upon_a_star')), /otherwise/);
});

test('approved Kaimetsu normal description remains exact in both definitions', (t) => {
  const db = fixture(t);
  assert.equal(getItemDefinition('kaimetsu').description, 'Divorce half the harem of EVERY user.');
  assert.equal(getResolvedItemDefinition(db, '1', 'kaimetsu').description, 'Divorce half the harem of EVERY user.');
});
