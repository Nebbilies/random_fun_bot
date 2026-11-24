import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ContainerComponent } from 'discord.js';
import { createFinalCatalog, openFinalCatalog } from '../lib/catalogDb.js';
import { addItemToInventory, getInventory, getInventoryCapacity, decrementItemCharge } from '../lib/itemStorage.js';
import { getItemDefinition, ITEM_TIERS } from '../lib/itemRoster.js';
import { revealVaultReward, getVaultReward, reconcileVaultRewards, bindVaultRewardMessage } from '../lib/vaultRewards.js';
import { recoverVaultRewards, recoverVaultSessions, onVaultInteraction, publishVaultRewards, startVaultRoll } from '../lib/vaultRuntime.js';
import { reservePaidVaultSession } from '../lib/vaultSessions.js';
import { resolveMysteryConsolation } from '../lib/mysteryConsolation.js';
import { applySeasonRollover } from '../features/seasons/seasonRollover.js';

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'vault-efficiency-')), path = join(dir, 'test.sqlite');
  let db = createFinalCatalog(path);
  t.mock.method(globalThis, 'setTimeout', () => ({}));
  t.mock.method(globalThis, 'clearTimeout', () => {});
  t.after(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
  return { get db() { return db; }, reopen() { db.close(); db = openFinalCatalog(path); } };
}

// REST-shaped data, not builder identity. Discord adds component IDs and default fields.
function apiData(value) {
  const data = JSON.parse(JSON.stringify(value));
  let id = 1;
  function defaults(node) {
    if (!node || typeof node !== 'object') return;
    if (typeof node.type === 'number') node.id = id++;
    if (node.type === 2 || node.type === 3) node.disabled ??= false;
    if (node.type === 3) { node.min_values ??= 1; node.max_values ??= 1; }
    if (node.type === 17) node.spoiler ??= false;
    if (Array.isArray(node.options)) for (const option of node.options) option.default ??= false;
    for (const child of Object.values(node)) {
      if (Array.isArray(child)) child.forEach(defaults);
      else if (child && typeof child === 'object') defaults(child);
    }
  }
  defaults(data);
  return data;
}
function discord() {
  const messages = new Map(), requests = [];
  const counts = { channels: 0, fetches: 0, sends: 0, edits: 0 };
  const channel = { id: 'channel', messages: { fetch: async request => {
    counts.fetches++; requests.push(request);
    const id = typeof request === 'string' ? request : request.message;
    if (!messages.has(id)) throw Object.assign(new Error('deleted'), { code: 10008 });
    await new Promise(resolve => setImmediate(resolve)); // controlled transport turn
    return messages.get(id);
  } }, send: async payload => {
    counts.sends++;
    if (payload.enforceNonce) {
      const existing = [...messages.values()].find(message => message.nonce === payload.nonce);
      if (existing) return existing;
    }
    const message = { id: String(counts.sends), channelId: 'channel', channel, nonce: payload.nonce,
      content: '', embeds: [], components: apiData(payload.components), flags: { bitfield: payload.flags },
      edit: async payload => {
        counts.edits++;
        if ('content' in payload) message.content = payload.content ?? '';
        if ('embeds' in payload) message.embeds = apiData(payload.embeds);
        if ('components' in payload) message.components = apiData(payload.components);
        if ('flags' in payload) message.flags = { bitfield: payload.flags };
        return message;
      } };
    messages.set(message.id, message);
    return message;
  } };
  return { channel, messages, requests, counts,
    client: { channels: { fetch: async () => { counts.channels++; return channel; } } } };
}
const outcome = (id = 'hourglass_of_haste') => ({ tier: getItemDefinition(id).tier,
  tierData: ITEM_TIERS[getItemDefinition(id).tier], item: getItemDefinition(id) });
function overflow(f, count) {
  while (getInventory(f.db, 'guild', 'owner').length < getInventoryCapacity(f.db, 'guild', 'owner')) {
    addItemToInventory(f.db, 'guild', 'owner', 'hourglass_of_haste');
  }
  for (let i = 0; i < count; i++) assert.equal(revealVaultReward(f.db, { vaultId: `reward-${i}`,
    guildId: 'guild', userId: 'owner', channelId: 'channel', outcome: outcome(), now: 100 }).state, 'overflow');
}

for (const count of [0, 1, 10, 100]) test(`${count} pending rewards: publication and reopened second scan verify without redundant writes`, async t => {
  const f = fixture(t), d = discord();
  overflow(f, count);
  const first = {};
  await recoverVaultRewards(f.db, d.client, { now: () => 200, stats: first });
  assert.equal(d.counts.sends, count);
  assert.equal(d.counts.edits, 0, 'confirmed send response already presents the desired card');
  assert.equal(first.candidates ?? 0, count);
  assert.equal(first.rewardSends ?? 0, count);
  assert.equal(first.rewardEdits ?? 0, 0);
  const acknowledged = count ? getVaultReward(f.db, 'reward-0').deliveredAt : null;
  f.reopen();
  const second = {};
  await recoverVaultRewards(f.db, d.client, { now: () => 300, stats: second });
  assert.equal(d.counts.sends, count);
  assert.equal(d.counts.edits, 0);
  assert.equal(second.candidates ?? 0, count);
  assert.equal(second.channelFetches ?? 0, count);
  assert.equal(second.rewardFetches ?? 0, count);
  assert.equal(second.rewardUnchanged ?? 0, count);
  assert.equal(second.rewardSends ?? 0, 0);
  assert.equal(second.rewardEdits ?? 0, 0);
  assert.ok(d.requests.every(request => typeof request === 'object' && request.force === true));
  if (count) assert.equal(getVaultReward(f.db, 'reward-0').deliveredAt, acknowledged);
  t.diagnostic(JSON.stringify({ pending: count, first, second, transport: d.counts }));
});

test('session recovery may opt out of its trailing reward sweep without changing default callers or return value', async t => {
  const f = fixture(t), d = discord();
  overflow(f, 1);
  const skipped = {};
  assert.deepEqual(await recoverVaultSessions(f.db, d.client, { now: () => 200, recoverRewards: false, stats: skipped }), []);
  assert.equal(d.counts.sends, 0);
  assert.deepEqual(await recoverVaultSessions(f.db, d.client, { now: () => 300 }), []);
  assert.equal(d.counts.sends, 1);
});

function select(message, vaultId = 'reward-0', value = 'page_0') {
  return { customId: `vault:${vaultId}:replace`, guildId: 'guild', channelId: 'channel',
    channel: message.channel, user: { id: 'owner' }, message, values: [value],
    isButton: () => false, isStringSelectMenu: () => true,
    update: payload => message.edit(payload), reply: async () => {} };
}

test('authoritative verification repairs meaningful controls, content and embeds, not stale cached equality', async t => {
  const f = fixture(t), d = discord(); overflow(f, 1);
  await recoverVaultRewards(f.db, d.client, { now: () => 200 });
  const message = d.messages.get('1');
  const cached = { ...message, components: apiData(message.components) };
  message.components[0].components.at(-1).components[0].options[0].value = 'forged';
  message.content = 'unexpected'; message.embeds = [{ title: 'unexpected' }];
  const fetch = d.channel.messages.fetch;
  d.channel.messages.fetch = request => typeof request === 'object' && request.force ? fetch(request) : cached;
  const stats = {};
  await recoverVaultRewards(f.db, d.client, { now: () => 300, stats });
  assert.equal(stats.rewardEdits, 1);
  assert.equal(message.content, '');
  assert.deepEqual(message.embeds, []);
  assert.notEqual(message.components[0].components.at(-1).components[0].options[0].value, 'forged');
});

test('inventory charge changes invalidate replacement labels without a reward or discovery change', async t => {
  const f = fixture(t), d = discord(); overflow(f, 1);
  const entry = getInventory(f.db, 'guild', 'owner')[0];
  f.db.prepare('UPDATE user_inventory SET charges=3 WHERE id=?').run(entry.id);
  await recoverVaultRewards(f.db, d.client, { now: () => 200 });
  const reward = getVaultReward(f.db, 'reward-0');
  const message = d.messages.get('1');
  const options = () => message.components[0].components.at(-1).components[0].options;
  const previous = options().find(option => option.value === String(entry.id));
  decrementItemCharge(f.db, entry.id);
  const stats = {};
  await recoverVaultRewards(f.db, d.client, { now: () => 300, stats });
  assert.equal(stats.rewardEdits, 1);
  const latest = options().find(option => option.value === String(entry.id));
  assert.equal(latest.value, previous.value);
  assert.notEqual(latest.label, previous.label);
  assert.deepEqual(getVaultReward(f.db, 'reward-0'), reward);
});

test('guild discovery changes presentation even when the reward and inventory do not change', async t => {
  const f = fixture(t), d = discord(); overflow(f, 0);
  revealVaultReward(f.db, { vaultId: 'reward-0', guildId: 'guild', userId: 'owner',
    channelId: 'channel', outcome: outcome('kaimetsu'), now: 100 });
  await recoverVaultRewards(f.db, d.client, { now: () => 200 });
  const before = getVaultReward(f.db, 'reward-0');
  const message = d.messages.get('1'), old = JSON.stringify(message.components);
  addItemToInventory(f.db, 'guild', 'other-owner', 'kaimetsu');
  const stats = {};
  await recoverVaultRewards(f.db, d.client, { now: () => 300, stats });
  assert.equal(stats.rewardEdits, 1);
  assert.notEqual(JSON.stringify(message.components), old);
  assert.match(JSON.stringify(message.components), /Kaimetsu/);
  assert.deepEqual(getVaultReward(f.db, 'reward-0'), before);
});

test('a verified unchanged card still acknowledges publication and a live identical interaction', async t => {
  const f = fixture(t), d = discord(); overflow(f, 1);
  await recoverVaultRewards(f.db, d.client, { now: () => 200 });
  f.db.prepare('UPDATE vault_rewards SET delivered_at=NULL WHERE vault_id=?').run('reward-0');
  const stats = {};
  await recoverVaultRewards(f.db, d.client, { now: () => 300, stats });
  assert.equal(stats.rewardUnchanged, 1);
  assert.equal(getVaultReward(f.db, 'reward-0').deliveredAt, 300);
  let acknowledged = 0;
  const interaction = select(d.messages.get('1'));
  interaction.update = async payload => { acknowledged++; return interaction.message.edit(payload); };
  await onVaultInteraction(f.db, interaction, { now: () => 400 });
  assert.equal(acknowledged, 1);
  assert.equal(d.counts.edits, 1, 'only the mandatory interaction update writes');
});

test('definite reward deletion rebinds once, invalidates old controls, and settles once', async t => {
  const f = fixture(t), d = discord(); overflow(f, 1);
  await recoverVaultRewards(f.db, d.client, { now: () => 200 });
  const old = d.messages.get('1'); d.messages.delete('1');
  const stats = {};
  await recoverVaultRewards(f.db, d.client, { now: () => 300, stats });
  assert.equal(stats.missing, 1); assert.equal(stats.rebindings, 1); assert.equal(stats.rewardSends, 1);
  assert.equal(getVaultReward(f.db, 'reward-0').messageId, '2');
  let rejected;
  await onVaultInteraction(f.db, { ...select(old, 'reward-0', '-1'), reply: async payload => { rejected = payload; } });
  assert.match(rejected.content, /stale/);
  assert.equal(getVaultReward(f.db, 'reward-0').state, 'overflow');
  await onVaultInteraction(f.db, select(d.messages.get('2'), 'reward-0', '-1'), { now: () => 400 });
  assert.equal(getVaultReward(f.db, 'reward-0').state, 'declined');
  await recoverVaultRewards(f.db, d.client, { now: () => 500 });
  assert.equal(d.counts.sends, 2);
});

test('transient verification and edit failures defer without replacement or acknowledgement', async t => {
  const f = fixture(t), d = discord(); overflow(f, 1);
  await recoverVaultRewards(f.db, d.client, { now: () => 200 });
  f.db.prepare('UPDATE vault_rewards SET delivered_at=NULL WHERE vault_id=?').run('reward-0');
  const fetch = d.channel.messages.fetch;
  d.channel.messages.fetch = async () => { throw Object.assign(new Error('transient'), { code: 50001 }); };
  const failed = {};
  await recoverVaultRewards(f.db, d.client, { now: () => 300, stats: failed });
  assert.equal(failed.rewardFetches, 1); assert.equal(failed.deferred, 1);
  assert.equal(failed.missing, undefined); assert.equal(d.counts.sends, 1);
  assert.equal(getVaultReward(f.db, 'reward-0').deliveredAt, null);
  d.channel.messages.fetch = fetch;
  const message = d.messages.get('1'), edit = message.edit;
  message.components = [];
  message.edit = async () => { throw new Error('transient edit'); };
  const editFailed = {};
  await recoverVaultRewards(f.db, d.client, { now: () => 400, stats: editFailed });
  assert.equal(editFailed.rewardEdits, 1); assert.equal(editFailed.deferred, 1);
  assert.equal(getVaultReward(f.db, 'reward-0').deliveredAt, null);
  message.edit = edit;
  await recoverVaultRewards(f.db, d.client, { now: () => 500 });
  assert.equal(getVaultReward(f.db, 'reward-0').deliveredAt, 500);
});

function rollOverRewardGuild(db) {
  const { season } = db.prepare("SELECT season FROM guild_seasons WHERE guild_id='guild'").get();
  db.prepare(`INSERT INTO season_rollovers(guild_id,season,revision,phase,channel_id,reminder_at,cutoff_at,requester)
    VALUES ('guild',?,1,'announced','channel',1,2,'admin')`).run(season);
  assert.equal(applySeasonRollover(db, { guildId: 'guild', season, members: new Set(['owner']), now: 2 }).status, 'applied');
}

for (const operation of ['fetch', 'send', 'edit']) test(`reward recovery stops when a rollover completes during ${operation}`, async t => {
  const f = fixture(t), d = discord(); overflow(f, 1);
  if (operation !== 'send') await recoverVaultRewards(f.db, d.client, { now: () => 200 });
  f.db.prepare("UPDATE vault_rewards SET delivered_at=NULL WHERE vault_id='reward-0'").run();
  const binding = f.db.prepare("SELECT message_id,delivered_at FROM vault_rewards WHERE vault_id='reward-0'");
  const before = binding.get();
  if (operation === 'fetch') {
    d.channel.messages.fetch = async () => {
      rollOverRewardGuild(f.db);
      throw Object.assign(new Error('deleted'), { code: 10008 });
    };
  } else if (operation === 'send') {
    const send = d.channel.send;
    d.channel.send = async payload => {
      const message = await send(payload);
      rollOverRewardGuild(f.db);
      return message;
    };
  } else {
    const message = d.messages.get('1'), edit = message.edit;
    message.components = [];
    message.edit = async payload => {
      const updated = await edit(payload);
      rollOverRewardGuild(f.db);
      return updated;
    };
  }
  const stats = {};
  await recoverVaultRewards(f.db, d.client, { now: () => 300, stats });
  assert.equal(stats.deferred, undefined);
  assert.equal(d.counts.sends, 1);
  assert.equal(getVaultReward(f.db, 'reward-0'), null);
  assert.deepEqual(binding.get(), before);
});

test('a reward interaction remains handled when its edit completes after rollover', async t => {
  const f = fixture(t), d = discord(); overflow(f, 1);
  await recoverVaultRewards(f.db, d.client, { now: () => 200 });
  const message = d.messages.get('1');
  const interaction = select(message, 'reward-0', '-1');
  interaction.update = async payload => {
    const edited = await message.edit(payload);
    rollOverRewardGuild(f.db);
    return edited;
  };
  assert.equal(await onVaultInteraction(f.db, interaction, { now: () => 300 }), true);
  assert.equal(d.counts.edits, 1);
  assert.equal(getVaultReward(f.db, 'reward-0'), null);
});

test('reconciliation during authoritative fetch publishes the latest overdue Keep state', async t => {
  const f = fixture(t), d = discord();
  addItemToInventory(f.db, 'guild', 'owner', 'double_or_nothing');
  const reward = revealVaultReward(f.db, { vaultId: 'decision', guildId: 'guild', userId: 'owner',
    channelId: 'channel', outcome: outcome(), now: 100 });
  assert.equal(reward.state, 'decision');
  await recoverVaultRewards(f.db, d.client, { now: () => 200 });
  const fetch = d.channel.messages.fetch;
  d.channel.messages.fetch = async request => {
    const result = await fetch(request);
    reconcileVaultRewards(f.db, { now: reward.deadline });
    return result;
  };
  const stats = {};
  await recoverVaultRewards(f.db, d.client, { now: () => 300, stats });
  assert.equal(stats.rewardEdits, 1);
  assert.equal(getVaultReward(f.db, 'decision').state, 'delivered');
  assert.match(JSON.stringify(d.messages.get('1').components), /received/);
  assert.equal(getInventory(f.db, 'guild', 'owner', reward.deadline).length, 2);
});

test('recovery queued behind settlement cannot overwrite the settled card with its scan snapshot', async t => {
  const f = fixture(t), d = discord(); overflow(f, 1);
  await recoverVaultRewards(f.db, d.client, { now: () => 200 });
  const pending = [getVaultReward(f.db, 'reward-0')];
  const message = d.messages.get('1');
  let entered, release;
  const started = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const interaction = select(message, 'reward-0', '-1');
  interaction.update = async payload => { entered(); await gate; return message.edit(payload); };
  const settlement = onVaultInteraction(f.db, interaction, { now: () => 300 });
  await started;
  const stats = {};
  const recovery = publishVaultRewards(f.db, d.client, pending, { now: () => 400, stats });
  release(); await Promise.all([settlement, recovery]);
  assert.match(JSON.stringify(message.components), /declined/);
  assert.equal(stats.rewardEdits ?? 0, 0);
  assert.equal(getVaultReward(f.db, 'reward-0').deliveredAt, 300);
});


test('a canonical rebind during fetch must not acknowledge an obsolete message', async t => {
  const f = fixture(t), d = discord(); overflow(f, 1);
  await recoverVaultRewards(f.db, d.client, { now: () => 200 });
  f.db.prepare('UPDATE vault_rewards SET delivered_at=NULL WHERE vault_id=?').run('reward-0');
  const old = d.messages.get('1');
  const replacement = await d.channel.send({ flags: 32768, components: old.components });
  const fetch = d.channel.messages.fetch;
  d.channel.messages.fetch = async request => {
    const message = await fetch(request);
    bindVaultRewardMessage(f.db, 'reward-0', 'channel', replacement.id, old.id);
    return message;
  };
  const stats = {};
  await recoverVaultRewards(f.db, d.client, { now: () => 300, stats });
  assert.equal(getVaultReward(f.db, 'reward-0').deliveredAt, null);
  assert.equal(stats.deferred, 1);
  d.channel.messages.fetch = fetch;
  await recoverVaultRewards(f.db, d.client, { now: () => 400 });
  assert.equal(getVaultReward(f.db, 'reward-0').deliveredAt, 400);
});


test('deletion evidence for an old binding cannot replace a newer live canonical card', async t => {
  const f = fixture(t), d = discord(); overflow(f, 1);
  await recoverVaultRewards(f.db, d.client, { now: () => 200 });
  const old = d.messages.get('1');
  const replacement = await d.channel.send({ flags: 32768, components: old.components });
  const fetch = d.channel.messages.fetch;
  d.channel.messages.fetch = async request => {
    bindVaultRewardMessage(f.db, 'reward-0', 'channel', replacement.id, old.id);
    throw Object.assign(new Error('old canonical card deleted'), { code: 10008 });
  };
  const stats = {};
  await recoverVaultRewards(f.db, d.client, { now: () => 300, stats });
  assert.equal(getVaultReward(f.db, 'reward-0').messageId, replacement.id);
  assert.equal(stats.deferred, 1);
  assert.equal(stats.rewardSends ?? 0, 0);
  assert.equal(d.messages.size, 2);
  d.channel.messages.fetch = fetch;
  await recoverVaultRewards(f.db, d.client, { now: () => 400 });
  assert.equal(d.messages.size, 2);
});

test('response-loss retry uses the same nonce without duplicate reward acquisition', async t => {
  const f = fixture(t), d = discord(); overflow(f, 1);
  const send = d.channel.send;
  let lost = true;
  d.channel.send = async payload => {
    const message = await send(payload);
    if (lost) { lost = false; throw new Error('response lost after send'); }
    return message;
  };
  const failed = {};
  await recoverVaultRewards(f.db, d.client, { now: () => 200, stats: failed });
  assert.equal(failed.rewardSends, 1); assert.equal(failed.deferred, 1);
  assert.equal(getVaultReward(f.db, 'reward-0').messageId, null);
  const retry = {};
  await recoverVaultRewards(f.db, d.client, { now: () => 300, stats: retry });
  assert.equal(retry.rewardSends, 1);
  assert.equal(d.messages.size, 1);
  assert.equal(getVaultReward(f.db, 'reward-0').messageId, '1');
  assert.equal(d.counts.edits, 0);
  assert.equal(getInventory(f.db, 'guild', 'owner').length, getInventoryCapacity(f.db, 'guild', 'owner'));
});


test('recovery disables every source control while keeping reward operations separate', async t => {
  const f = fixture(t), d = discord(); overflow(f, 0);
  const session = reservePaidVaultSession(f.db, { guildId: 'guild', rollerId: 'owner', channelId: 'channel',
    commandMessageId: 'command', capturedOutcome: outcome(), now: 100, timeoutMs: 60000 });
  const started = await startVaultRoll({ db: f.db, channel: d.channel, guildId: 'guild', rollerId: 'owner',
    commandMessageId: 'command', remaining: 0, now: () => 100 });
  const source = started.message;
  revealVaultReward(f.db, { vaultId: session.vaultId, guildId: 'guild', userId: 'owner', channelId: 'channel',
    sourceMessageId: source.id, outcome: outcome(), now: 200 });
  // One disabled control is not evidence that all A/B/C controls are disabled.
  const sourceData = apiData(source.components);
  sourceData[0].components.at(-1).components[0].disabled = true;
  sourceData[0].components.find(component => component.type === 12).items[0].media = {
    url: 'https://cdn.discordapp.com/attachments/1/2/mystery_vault.png',
    proxy_url: 'https://media.discordapp.net/attachments/1/2/mystery_vault.png',
    width: 500, height: 500,
  };
  source.components = sourceData.map(data => new ContainerComponent(data));
  const first = {};
  await recoverVaultRewards(f.db, d.client, { now: () => 300, stats: first });
  assert.equal(first.sourceFetches, 1); assert.equal(first.sourceEdits, 1);
  assert.equal(first.rewardSends, 1); assert.equal(first.rewardEdits ?? 0, 0);
  assert.ok(source.components[0].components.at(-1).components.every(button => button.disabled));
  const second = {};
  await recoverVaultRewards(f.db, d.client, { now: () => 400, stats: second });
  assert.equal(second.sourceFetches, 1); assert.equal(second.sourceEdits ?? 0, 0);
  assert.equal(second.rewardFetches, 1); assert.equal(second.rewardUnchanged, 1);
});

test('historical source and reward same-message binding remains canonical and interactive', async t => {
  const f = fixture(t), d = discord(); overflow(f, 0);
  const session = reservePaidVaultSession(f.db, { guildId: 'guild', rollerId: 'owner', channelId: 'channel',
    commandMessageId: 'command', capturedOutcome: outcome(), now: 100 });
  const { message } = await startVaultRoll({ db: f.db, channel: d.channel, guildId: 'guild', rollerId: 'owner',
    commandMessageId: 'command', remaining: 0, now: () => 100 });
  revealVaultReward(f.db, { vaultId: session.vaultId, guildId: 'guild', userId: 'owner', channelId: 'channel',
    sourceMessageId: message.id, messageId: message.id, outcome: outcome(), now: 200 });
  const stats = {};
  await recoverVaultRewards(f.db, d.client, { now: () => 300, stats });
  assert.equal(stats.sourceFetches ?? 0, 0); assert.equal(stats.rewardFetches, 1);
  assert.equal(stats.rewardEdits, 1); assert.equal(d.counts.sends, 1);
  await onVaultInteraction(f.db, select(message, session.vaultId, '-1'), { now: () => 400 });
  assert.equal(getVaultReward(f.db, session.vaultId).state, 'declined');
  assert.equal(getVaultReward(f.db, session.vaultId).messageId, message.id);
});


test('gated consolation is counted but never fetched, sent or acknowledged before revelation', async t => {
  const f = fixture(t), d = discord();
  addItemToInventory(f.db, 'guild', 'owner', 'consolation_chit');
  const session = { id: 1, guildId: 'guild', eventChannelId: 'channel' };
  const now = Date.now();
  f.db.exec('BEGIN IMMEDIATE');
  const decision = resolveMysteryConsolation(f.db, { session, winnerId: 'owner', canClaim: false, now, random: () => 0 });
  f.db.exec('COMMIT');
  const runtime = { resolved: { type: 'winner', winnerId: 'owner' }, consolation: decision };
  f.db.prepare("INSERT INTO character_identities(id,name_full,creation_method) VALUES('00000000-0000-4000-8000-000000000002','Test','manual')").run();
  f.db.prepare(`INSERT INTO mystery_sessions(id,guild_id,origin_roll_id,event_id,character_id,rank_snapshot,roller_id,event_channel_id,
    state,state_json,started_at,deadline_at,winner_id) VALUES(1,'guild',1,'doors','00000000-0000-4000-8000-000000000002',1,'owner','channel','resolved',?,?,?,'owner')`)
    .run(JSON.stringify({ runtime }), now, now + 1000);
  const gated = {};
  await recoverVaultRewards(f.db, d.client, { now: () => now + 1, stats: gated });
  assert.equal(gated.gated, 1); assert.equal(gated.candidates, 1);
  assert.equal(d.counts.fetches, 0); assert.equal(d.counts.sends, 0);
  assert.equal(getVaultReward(f.db, decision.rewardId).deliveredAt, null);
  runtime.prizeMessageId = '99'; runtime.consolationRevealAcknowledged = true;
  f.db.prepare('UPDATE mystery_sessions SET state_json=? WHERE id=1').run(JSON.stringify({ runtime }));
  await recoverVaultRewards(f.db, d.client, { now: () => now + 2 });
  assert.equal(d.counts.sends, 1);
  assert.equal(getVaultReward(f.db, decision.rewardId).deliveredAt, now + 2);
});
