import { ActionRowBuilder, ButtonBuilder, ButtonStyle, ContainerBuilder, MessageFlags, ModalBuilder, LabelBuilder, TextInputBuilder, TextInputStyle,
  StringSelectMenuBuilder, TextDisplayBuilder, UserSelectMenuBuilder, escapeMarkdown } from 'discord.js';
import { getChronicleTargets, getShacklesTargets, createItemAction, updateItemSelection, activateItemAction, cancelItemAction,
  confirmHostageDelivery, cancelUndeliveredHostage, resolveHostage, recoverItemActions, expireItemActions } from './itemActions.js';
import { getItemAction } from './itemActionStorage.js';
import { getUsableInventory } from './itemStorage.js';
import { getItemDefinition } from './itemRoster.js';
import { HOSTAGE_RANK_RULE } from './items/hostageNote.js';
import { publishMasqueradeReveal } from './masqueradeReveal.js';
import { publishThreadbreakerReveal } from './threadbreakerReveal.js';
import { characterRevealPlan, publishItemCharacterReveal } from './itemCharacterReveal.js';
import { immediateActionCards, itemCharacterResult } from './itemCharacterPresentation.js';
import { itemUseFeedback } from './affectionPresentation.js';
import { findFranchises } from './franchiseLookup.js';
import { getCatalogCache } from './catalogCache.js';

const PAGE_SIZE = 25;
const SWEEP_MS = 15_000;
const BATCH_SIZE = 100;
const FRANCHISE_QUERY_LIMIT = 100;
const runtimes = new WeakMap();
const noMentions = { parse: [], repliedUser: false };
const terminal = new Set(['resolved', 'canceled', 'expired']);
const row = (...controls) => new ActionRowBuilder().addComponents(...controls);
const button = (id, label, style = ButtonStyle.Secondary, disabled = false) =>
  new ButtonBuilder().setCustomId(id).setLabel(label).setStyle(style).setDisabled(disabled);
const cid = (action, verb) => `item:${action.id}:${verb}`;
const name = (character) => escapeMarkdown(character?.name ?? character?.name_full ?? `Character ${character?.characterId ?? ''}`);
const label = (value) => String(value).slice(0, 100);
function payload(text, rows = [], ephemeral = false) {
  const container = new ContainerBuilder().addTextDisplayComponents(new TextDisplayBuilder().setContent(text));
  for (const controls of rows) container.addActionRowComponents(controls);
  return { flags: MessageFlags.IsComponentsV2 | (ephemeral ? MessageFlags.Ephemeral : 0), components: [container], allowedMentions: noMentions };
}
function ui(action) { return action.selections._ui ?? {}; }
function persistUI(db, action, patch) {
  const selections = { ...action.selections, _ui: { ...ui(action), ...patch } };
  db.prepare('UPDATE item_actions SET selections_json=? WHERE id=?').run(JSON.stringify(selections), action.id);
  return getItemAction(db, action.id);
}
function ownRequired(action) { return !['alchemist', 'severed_fate', 'kaimetsu', 'chronicle_of_return'].includes(action.kind); }
function targetCount(action) { return action.kind === 'grand_masquerade' ? 3 : ['heart_for_a_heart', 'severed_fate', 'hostage_note'].includes(action.kind) ? 1 : 0; }
function ownedRows(db, action, owner) {
  return db.prepare(`SELECT m.id AS marriageId,m.character_id AS characterId,m.owner_id AS ownerId,c.rank,c.name_full AS name
    FROM marriages m JOIN characters c ON c.id=m.character_id WHERE m.guild_id=? AND m.owner_id=? ORDER BY c.rank,c.id`).all(action.guild_id, owner);
}
function commonCosts(db, action) {
  return getUsableInventory(db, action.guild_id, action.actor_id).filter((entry) => entry.id !== action.inventory_id && getItemDefinition(entry.item_id)?.tier === 'common');
}
function alchemistCost(action) { return action.selections._rules?.alchemistCost ?? 3; }
function ready(action) {
  const s = action.selections;
  if (action.kind === 'threadbreaker') return Boolean(s.franchise?.id);
  return action.kind === 'shackles_of_liberation' ? Boolean(s.unbindTarget?.marriageId) : action.kind === 'chronicle_of_return' ? Boolean(s.returnTarget?.characterId) : action.kind === 'blood_pact' ? s.sacrifices?.length === s._rules.bloodPactSacrificeCount :
    action.kind === 'alchemist' ? s.inventoryIds?.length === alchemistCost(action) :
    (!ownRequired(action) || Boolean(s.own)) && (s.targets?.filter(Boolean).length ?? 0) === targetCount(action);
}
function picker(db, action, privateView = false) {
  if (terminal.has(action.state)) return payload(`**${escapeMarkdown(getItemDefinition(action.kind)?.name ?? action.kind)}**\n${action.result?.message ?? 'This action has ended.'}`);
  if (action.kind === 'shackles_of_liberation') {
    const targets = getShacklesTargets(db, action);
    const pages = Math.max(1, Math.ceil(targets.length / PAGE_SIZE));
    const page = Math.min(Math.max(0, Number(ui(action).page) || 0), pages - 1);
    const entries = targets.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
    const selected = action.selections.unbindTarget;
    const rows = [];
    if (entries.length) rows.push(row(new StringSelectMenuBuilder().setCustomId(cid(action, 'unbind-character'))
      .setPlaceholder(`Choose a soulbound character · page ${page + 1}/${pages}`)
      .addOptions(entries.map(entry => ({ label: label(`#${entry.rank} · ${entry.name}`),
        description: label(`Owner: ${entry.ownerId} · Character ${entry.characterId}`), value: `${entry.characterId}.${entry.marriageId}`,
        default: entry.characterId === selected?.characterId && entry.marriageId === selected?.marriageId && entry.ownerId === selected?.ownerId })))));
    rows.push(row(button(cid(action, 'prev'), 'Previous', ButtonStyle.Secondary, page === 0), button(cid(action, 'next'), 'Next', ButtonStyle.Secondary, page + 1 >= pages)));
    rows.push(row(button(cid(action, 'confirm'), 'Confirm unbinding', ButtonStyle.Danger, !ready(action)), button(cid(action, 'cancel'), 'Cancel')));
    return payload(`**Shackles of Liberation**\nOnly <@${action.actor_id}> may select or confirm.\n${selected ? `Remove the soulbind from **${name(selected)}** (#${selected.rank}), owned by <@${selected.ownerId}>.` : 'Choose an owned, soulbound character in this server, including your own.'}\nOwnership stays unchanged. Bypasses Mirror Shield, Counterfeit Crown and temporary theft protection without spending defenses. No claim priority or cooldown is added; the owner may soulbind again immediately with another Aegis of Fidelity.\nOne reserved charge is spent only on success. Ownership, soulbind and busy status are checked again on confirmation.\nExpires <t:${Math.floor(action.expires_at / 1000)}:R>.`, rows);
  }
  if (action.kind === 'chronicle_of_return') {
    const targets = getChronicleTargets(db, action);
    const pages = Math.max(1, Math.ceil(targets.length / PAGE_SIZE));
    const page = Math.min(Math.max(0, Number(ui(action).page) || 0), pages - 1);
    const entries = targets.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
    const rows = [];
    if (entries.length) rows.push(row(new StringSelectMenuBuilder().setCustomId(cid(action, 'return-character'))
      .setPlaceholder(`Choose a former companion · page ${page + 1}/${pages}`)
      .addOptions(entries.map(entry => ({ label: label(`#${entry.rank} · ${entry.name}`), value: String(entry.characterId),
        default: entry.characterId === action.selections.returnTarget?.characterId })))));
    rows.push(row(button(cid(action, 'prev'), 'Previous', ButtonStyle.Secondary, page === 0), button(cid(action, 'next'), 'Next', ButtonStyle.Secondary, page + 1 >= pages)));
    rows.push(row(button(cid(action, 'confirm'), 'Confirm return', ButtonStyle.Primary, !ready(action)), button(cid(action, 'cancel'), 'Cancel')));
    const selected = action.selections.returnTarget;
    return payload(`**Chronicle of Return**\nOnly <@${action.actor_id}> may select or confirm.\n${selected ? `Return **${name(selected)}** (#${selected.rank}) with fresh ownership.` : 'Choose an available formerly owned character.'}\nCaptured history window: ${action.selections.historyWindowMs / 86400000} days. Availability and the latest loss are checked again on confirmation. One reserved use is spent only on success; normal claims, cooldowns and buffs are unchanged.\nExpires <t:${Math.floor(action.expires_at / 1000)}:R>.`, rows);
  }
  if (action.kind === 'kaimetsu') {
    return payload(`**Kaimetsu — guild-wide divorce**\nOnly <@${action.actor_id}> may confirm. This affects **every stored harem in this guild, including your own**.\nRandomly divorces half of each owner's non-soulbound characters, rounded down. Only soulbound characters are immune. Live escapes, trades/gifts, and Hostage challenges involving divorced characters will be cancelled.\nOne charge is consumed on success; cancellation, expiry, or zero total divorces costs nothing. Characters are selected when you confirm.\nExpires <t:${Math.floor(action.expires_at / 1000)}:R>.`, [row(button(cid(action, 'confirm'), 'Confirm guild-wide divorce', ButtonStyle.Danger), button(cid(action, 'cancel'), 'Cancel'))], privateView);
  }
  if (action.kind === 'threadbreaker') {
    const index = getCatalogCache(db).get().franchiseIndex;
    const matches = action.selections.franchiseQuery ? findFranchises(index, action.selections.franchiseQuery)
      : index;
    const pages = Math.max(1, Math.ceil(matches.length / PAGE_SIZE));
    const page = Math.min(Math.max(0, Number(ui(action).page) || 0), pages - 1);
    const rows = [];
    if (!action.selections.franchise && matches.length) rows.push(row(new StringSelectMenuBuilder().setCustomId(cid(action, 'franchise'))
      .setPlaceholder('Choose a franchise').addOptions(matches.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE).map(franchise => ({
        label: label(franchise.name ?? franchise.aliases[0] ?? `Franchise ${franchise.id}`), value: String(franchise.id),
      })))));
    if (!action.selections.franchise && pages > 1) rows.push(row(button(cid(action, 'prev'), 'Previous', ButtonStyle.Secondary, page === 0), button(cid(action, 'next'), 'Next', ButtonStyle.Secondary, page + 1 >= pages)));
    const selected = action.selections.franchise;
    const text = selected ? `Use **Threadbreaker** on **${escapeMarkdown(selected.name)}**? Your characters can be affected too.`
      : matches.length ? 'Choose a franchise. Your characters can be affected too.'
        : 'No franchises match. Search again or clear the search.';
    rows.push(row(button(cid(action, 'search'), 'Search franchises'),
      button(cid(action, 'clear-search'), 'Clear search', ButtonStyle.Secondary, !action.selections.franchiseQuery)));
    rows.push(selected ? row(button(cid(action, 'confirm'), 'Confirm', ButtonStyle.Danger), button(cid(action, 'cancel'), 'Cancel'))
      : row(button(cid(action, 'cancel'), 'Cancel')));
    const query = action.selections.franchiseQuery;
    return payload(`${text}${query ? `\nSearch: **${escapeMarkdown(query.slice(0, FRANCHISE_QUERY_LIMIT))}**` : ''}\nOnly <@${action.actor_id}> may select or confirm.`, rows, privateView);
  }
  if (action.kind === 'counterfeit_crown' && !privateView) {
    return payload('**Counterfeit Crown**\nOnly its owner may open the private decoy selector. No decoy will be named here.', [row(button(cid(action, 'private'), 'Choose decoy privately', ButtonStyle.Primary), button(cid(action, 'cancel'), 'Cancel'))]);
  }
  const s = action.selections;
  const state = ui(action);
  const rows = [];
  const preview = [];
  if (action.kind === 'hostage_note') preview.push(HOSTAGE_RANK_RULE);
  if (action.kind === 'grand_masquerade') {
    const rules = action.selections._rules;
    preview.push(`**Rank constraint:** Each target's rank number must be at least ${rules.masqueradeMinRankMultiplier}× your character's rank (rounded up), with no upper limit. If your character is in the top ${rules.masqueradeTopRank}, any top-${rules.masqueradeTopRank} target is also allowed.`);
  }
  const page = Math.max(0, Number(state.page) || 0);
  const slot = state.slot ?? (ownRequired(action) ? 'own' : 'target0');
  if (action.kind === 'blood_pact') {
    const count = s._rules.bloodPactSacrificeCount;
    const characters = ownedRows(db, action, action.actor_id);
    const pages = Math.max(1, Math.ceil(characters.length / PAGE_SIZE));
    const current = Math.min(page, pages - 1);
    const entries = characters.slice(current * PAGE_SIZE, (current + 1) * PAGE_SIZE);
    const selected = s.sacrifices ?? [];
    if (entries.length) rows.push(row(new StringSelectMenuBuilder().setCustomId(cid(action, 'sacrifices'))
      .setPlaceholder(label(`Choose ${count} sacrifices total · page ${current + 1}/${pages}`))
      .setMinValues(0).setMaxValues(Math.min(count, entries.length))
      .addOptions(entries.map((entry) => ({ label: label(`#${entry.rank} · ${entry.name}`), value: `${entry.characterId}.${entry.marriageId}`,
        default: selected.some((choice) => choice.characterId === entry.characterId && choice.marriageId === entry.marriageId) })))));
    preview.push(`Sacrifice **${count} distinct characters** you own from the **same franchise** to summon its best-ranked available unowned character. A rank upgrade is not guaranteed. Soulbound characters and characters committed to another action cannot be sacrificed.`,
      `Selected sacrifices (${selected.length}/${count}): ${selected.length ? selected.map((choice) => `**${name(choice)}** (#${choice.rank})`).join(', ') : 'none'}.`);
    rows.push(row(button(cid(action, 'prev'), 'Previous', ButtonStyle.Secondary, current === 0), button(cid(action, 'next'), 'Next', ButtonStyle.Secondary, current + 1 >= pages)));
  } else if (action.kind === 'alchemist') {
    const costs = commonCosts(db, action);
    const pages = Math.max(1, Math.ceil(costs.length / PAGE_SIZE));
    const current = Math.min(page, pages - 1);
    const entries = costs.slice(current * PAGE_SIZE, (current + 1) * PAGE_SIZE);
    const selected = s.inventoryIds ?? [];
    if (entries.length) rows.push(row(new StringSelectMenuBuilder().setCustomId(cid(action, 'costs')).setPlaceholder(`Select ${alchemistCost(action)} Common entries (across pages)`).setMinValues(0).setMaxValues(Math.min(alchemistCost(action), entries.length)).addOptions(entries.map((entry) => ({ label: label(`${getItemDefinition(entry.item_id).name} · entry ${entry.id}`), value: String(entry.id), default: selected.includes(entry.id) })))));
    preview.push(`Selected Common entries: ${selected.length ? selected.map((id) => `#${id} ${getItemDefinition(costs.find((e) => e.id === id)?.item_id)?.name ?? '(unavailable)'}`).join(', ') : 'none'}.`);
    rows.push(row(button(cid(action, 'prev'), 'Previous', ButtonStyle.Secondary, current === 0), button(cid(action, 'next'), 'Next', ButtonStyle.Secondary, current + 1 >= pages)));
  } else {
    const count = targetCount(action);
    if (count) {
      rows.push(row(new UserSelectMenuBuilder().setCustomId(cid(action, 'users')).setPlaceholder(`Choose ${count} distinct other owner${count === 1 ? '' : 's'}`).setMinValues(count).setMaxValues(count)));
      const slots = [];
      if (ownRequired(action)) slots.push(button(cid(action, 'slot-own'), 'Your character', ButtonStyle.Secondary, slot === 'own'));
      for (let i = 0; i < count; i++) slots.push(button(cid(action, `slot-target${i}`), `Target ${i + 1}`, ButtonStyle.Secondary, slot === `target${i}`));
      rows.push(row(...slots));
    }
    const index = /^target([0-2])$/.exec(slot)?.[1];
    const owner = slot === 'own' ? action.actor_id : state.users?.[Number(index)];
    if (owner) {
      const characters = ownedRows(db, action, owner);
      const pages = Math.max(1, Math.ceil(characters.length / PAGE_SIZE));
      const current = Math.min(page, pages - 1);
      const entries = characters.slice(current * PAGE_SIZE, (current + 1) * PAGE_SIZE);
      if (entries.length) rows.push(row(new StringSelectMenuBuilder().setCustomId(cid(action, 'character')).setPlaceholder(label(`Choose ${slot === 'own' ? 'your' : `target ${Number(index) + 1}'s`} character · page ${current + 1}/${pages}`)).addOptions(entries.map((entry) => ({ label: label(`#${entry.rank} · ${entry.name}`), value: `${entry.characterId}.${entry.marriageId}` })))));
      rows.push(row(button(cid(action, 'prev'), 'Previous', ButtonStyle.Secondary, current === 0), button(cid(action, 'next'), 'Next', ButtonStyle.Secondary, current + 1 >= pages)));
    }
    if (s.own) preview.push(`Your character: **${name(s.own)}** (#${s.own.rank}).`);
    (s.targets ?? []).forEach((target, i) => { if (target) preview.push(`Target ${i + 1}: **${name(target)}** (#${target.rank}), owned by <@${target.ownerId}>.`); });
  }
  rows.push(row(button(cid(action, 'confirm'), 'Confirm activation', ButtonStyle.Danger, !ready(action)), button(cid(action, 'cancel'), 'Cancel')));
  return payload(`**${escapeMarkdown(getItemDefinition(action.kind)?.name ?? action.kind)}**\nOnly <@${action.actor_id}> may select or confirm. Uses one item charge unless Item Conservation activates.\n${preview.join('\n')}\nChoose all costs and targets, then confirm. Expires <t:${Math.floor(action.expires_at / 1000)}:R>.`, rows, privateView);
}
function hostagePrompt(action) {
  const { own, targets } = action.selections;
  const deadline = action.deadline_at ? `<t:${Math.floor(action.deadline_at / 1000)}:R>` : 'after delivery (the decision window starts when this prompt is confirmed)';
  const original = action.selections.originals?.[0];
  const redirect = original && original.characterId !== targets[0].characterId ? `Crown substituted **${name(targets[0])}** for **${name(original)}**.\n` : '';
  return payload(itemUseFeedback(`${redirect}**Hostage Note** · ${action.id}\nOnly <@${targets[0].ownerId}> may decide.\nAttacker's stake: **${name(own)}** (<@${own.ownerId}>).\nYour stake: **${name(targets[0])}**.\n**Exchange** swaps ownership. **Decline / Gamble** gives your nominated character a 50% chance of divorce and a 50% chance of staying with you. The item user's character is never at risk in the gamble. Timeout chooses Gamble. Deadline: ${deadline}.`, action.selections._affectionPayment), [row(button(cid(action, 'exchange'), 'Exchange', ButtonStyle.Primary), button(cid(action, 'gamble'), 'Decline / Gamble', ButtonStyle.Danger))]);
}
async function reject(interaction, text = 'These controls are expired, stale, or not yours.') {
  const data = { content: text, flags: MessageFlags.Ephemeral, allowedMentions: noMentions };
  if (interaction.deferred || interaction.replied) await interaction.followUp(data);
  else await interaction.reply(data);
  return true;
}
async function channelFor(client, action) {
  const channel = await client.channels.fetch(action.channel_id);
  if (!channel?.send || (channel.guildId && channel.guildId !== action.guild_id)) throw Error('Item action channel unavailable');
  return channel;
}
async function boundMessage(channel, messageId) {
  if (!messageId) return null;
  try { return await channel.messages.fetch(messageId); }
  catch (error) {
    if (error.code === 10008) return null;
    throw error; // Network/permission failures do not prove that a prompt was deleted.
  }
}
async function repairLivePrompt(db, action, client) {
  const channel = await channelFor(client, action);
  const message = await boundMessage(channel, action.message_id);
  const data = action.state === 'active' ? hostagePrompt(action) : picker(db, action);
  if (message) await message.edit(data);
  else {
    const replacement = await channel.send(data);
    db.prepare('UPDATE item_actions SET message_id=? WHERE id=?').run(replacement.id, action.id);
  }
}
async function publish(db, action, client, interaction = null, wait) {
  if (!action.delivery_pending || !terminal.has(action.state)) return;
  if (action.kind === 'threadbreaker' && action.state === 'resolved' && !action.result.noCost) {
    const channel = await channelFor(client, action);
    const message = await boundMessage(channel, action.message_id);
    if (message && !ui(action).threadbreakerReveal) await message.edit(payload('Threadbreaker activated.'));
    await publishThreadbreakerReveal({ db, action, channel, wait,
      saveProgress: progress => { action = persistUI(db, action, { threadbreakerReveal: progress }); } });
    db.prepare('UPDATE item_actions SET delivery_pending=0 WHERE id=?').run(action.id);
    return;
  }
  if (characterRevealPlan(action)) {
    const channel = await channelFor(client, action);
    const message = await boundMessage(channel, action.message_id);
    await publishItemCharacterReveal({ db, action, channel, message, wait,
      saveProgress: (step, messageId) => {
        action = persistUI(db, action, { itemRevealStep: step });
        db.prepare('UPDATE item_actions SET message_id=? WHERE id=?').run(messageId, action.id);
      } });
    db.prepare('UPDATE item_actions SET delivery_pending=0 WHERE id=?').run(action.id);
    return;
  }
  if (action.kind === 'grand_masquerade' && action.state === 'resolved') {
    const channel = await channelFor(client, action);
    const message = await boundMessage(channel, action.message_id);
    if (!ui(action).masqueradeRevealStep && message) await message.edit(payload('Grand Masquerade activated. The reveal follows…'));
    await publishMasqueradeReveal({ db, action, channel, message,
      saveProgress: (step, messageId) => {
        action = persistUI(db, action, { masqueradeRevealStep: step });
        db.prepare('UPDATE item_actions SET message_id=? WHERE id=?').run(messageId, action.id);
      } });
    db.prepare('UPDATE item_actions SET delivery_pending=0 WHERE id=?').run(action.id);
    return;
  }
  const secret = action.result?.privateCharacter;
  let privatePending = Boolean(secret && !ui(action).privateDelivered);
  if (privatePending) {
    try {
      const data = itemCharacterResult(db, { title: 'Counterfeit Crown activated',
        message: 'Your decoy remains private.', cards: immediateActionCards(action), ephemeral: Boolean(interaction) });
      if (interaction) await interaction.followUp(data);
      else await (await client.users.fetch(action.actor_id)).send(data);
      action = persistUI(db, action, { privateDelivered: true });
      privatePending = false;
    } catch { /* retry privately, but do not block the safe public announcement */ }
  }
  // Never serialize the outcome: it can contain a private Crown character.
  const cards = secret ? [] : immediateActionCards(action);
  const title = escapeMarkdown(getItemDefinition(action.kind)?.name ?? action.kind);
  const resultMessage = itemUseFeedback(secret ? 'Counterfeit Crown is active. Its decoy is secret.' : action.result?.message ?? 'This action has ended.',action.result);
  const data = cards.length ? itemCharacterResult(db, { title, message: resultMessage, cards })
    : payload(`**${title}**\n${resultMessage}`);
  const channel = await channelFor(client, action);
  let message = await boundMessage(channel, action.message_id);
  if (message) await message.edit(data);
  else {
    message = await channel.send(data);
    db.prepare('UPDATE item_actions SET message_id=? WHERE id=?').run(message.id, action.id);
  }
  db.prepare('UPDATE item_actions SET delivery_pending=? WHERE id=?').run(privatePending ? 1 : 0, action.id);
}
async function deliverHostage(db, action, client) {
  let message;
  try {
    const channel = await channelFor(client, action);
    message = await channel.send(hostagePrompt(action));
    if (!confirmHostageDelivery(db, action.id, message.id)) {
      await message.edit(payload('This Hostage challenge is no longer active.'));
      return;
    }
  } catch (error) {
    cancelUndeliveredHostage(db, action.id);
    throw error;
  }
  // Once delivery is confirmed, editing failure must never refund the Note.
  await message.edit(hostagePrompt(getItemAction(db, action.id)));
}
function runtime(db, client) {
  let state = runtimes.get(db);
  if (!state) {
    state = { client, busy: new Set(), sweeping: false, liveCursor: 0 };
    runtimes.set(db, state);
    state.timer = setInterval(() => { void reconcile(db, state).catch(() => {}); }, SWEEP_MS);
    state.timer.unref?.();
  } else if (client) state.client = client;
  return state;
}
async function reconcile(db, state) {
  if (state.sweeping) return;
  state.sweeping = true;
  try {
    const now = Date.now();
    // Unlike startup recovery, a normal sweep must not cancel in-flight sends.
    const due = db.prepare("SELECT id,guild_id FROM item_actions WHERE state='active' AND deadline_at<=? ORDER BY deadline_at LIMIT ?").all(now, BATCH_SIZE);
    for (const action of due) {
      try { resolveHostage(db, { actionId: action.id, guildId: action.guild_id, choice: 'gamble', timeout: true, now }); } catch { /* isolate a damaged action */ }
    }
    expireItemActions(db, now, BATCH_SIZE);
    const pending = db.prepare('SELECT id FROM item_actions WHERE delivery_pending=1 ORDER BY created_at LIMIT ?').all(BATCH_SIZE);
    for (const { id } of pending) {
      if (state.busy.has(id)) continue;
      state.busy.add(id);
      if (getItemAction(db, id)?.kind === 'threadbreaker') {
        void publish(db, getItemAction(db, id), state.client).catch(() => {}).finally(() => state.busy.delete(id));
        continue;
      }
      try { await publish(db, getItemAction(db, id), state.client); } catch { /* persisted delivery flag retries later */ }
      finally { state.busy.delete(id); }
    }
    // Keyset rotation bounds each sweep without letting inaccessible or busy older
    // prompts starve the rest. Failed/skipped entries get another turn next lap.
    const selectLive = db.prepare("SELECT rowid AS cursor,id FROM item_actions WHERE state IN ('confirming','active') AND rowid>? ORDER BY rowid LIMIT ?");
    let live = selectLive.all(state.liveCursor, BATCH_SIZE);
    if (!live.length) {
      state.liveCursor = 0;
      live = selectLive.all(state.liveCursor, BATCH_SIZE);
    }
    for (const { cursor, id } of live) {
      state.liveCursor = cursor;
      if (state.busy.has(id)) continue;
      state.busy.add(id);
      try { await repairLivePrompt(db, getItemAction(db, id), state.client); }
      catch { /* leave binding/deadline intact and retry on the next lap */ }
      finally { state.busy.delete(id); }
    }
  } finally { state.sweeping = false; }
}

/** Launch the shared prefix-command/inventory confirmation flow. */
export async function startItemAction({ db, message, inventoryId, options = {} }) {
  const guildId = message.guildId ?? message.guild?.id;
  const actorId = message.author.id;
  const channelId = message.channelId ?? message.channel.id;
  const now = options.now ?? Date.now();
  let action = options.actionId ? getItemAction(db, options.actionId)
    : createItemAction(db, { guildId, actorId, channelId, inventoryId, invocationId: options.invocationId, now });
  if (!action || (action.id && (action.guild_id !== guildId || action.actor_id !== actorId || action.channel_id !== channelId)))
    throw new Error('Item action scope mismatch or missing original action');
  if (!action.id) { await message.reply({ content: action.message, allowedMentions: noMentions }); return action; }
  const state = runtime(db, message.client ?? { channels: { fetch: async () => message.channel } });
  if (state.busy.has(action.id)) return action;
  state.busy.add(action.id);
  try {
    if (action.state === 'confirming' && now >= action.expires_at) {
      activateItemAction(db, { actionId: action.id, guildId, actorId, now });
      action = getItemAction(db, action.id);
    }
    if (terminal.has(action.state)) {
      // Resume delivery/status only. Never re-open a terminal confirmation.
      await publish(db, action, state.client, null, options.wait);
      await message.reply(picker(db, action));
    } else if (action.state === 'awaiting_delivery') {
      // The original send may still be in flight; do not duplicate or settle it.
      await message.reply(payload('This item action is awaiting its original delivery. Its reserved source and action are unchanged.'));
    } else if (action.message_id || action.state === 'active') {
      await repairLivePrompt(db, action, state.client);
    } else {
      try {
        const prompt = await message.reply(picker(db, action));
        db.prepare('UPDATE item_actions SET message_id=? WHERE id=?').run(prompt.id, action.id);
      } catch (error) { cancelItemAction(db, action.id, action.guild_id, action.actor_id); throw error; }
    }
  } finally { state.busy.delete(action.id); }
  return getItemAction(db, action.id);
}

/** Deliver a committed legacy outcome through the same durable retry path as item actions. */
export async function deliverItemResult({ db, message, actionId, options = {} }) {
  const state = runtime(db, message.client ?? { channels: { fetch: async () => message.channel } });
  if (state.busy.has(actionId)) return;
  state.busy.add(actionId);
  try { await publish(db, getItemAction(db, actionId), state.client, null, options.wait); }
  finally { state.busy.delete(actionId); }
}

/** Global item: control router. Returns false for other component namespaces. */
export async function onItemActionInteraction(db, interaction) {
  if (!interaction.customId?.startsWith('item:')) return false;
  const match = /^item:([^:]+):([a-z0-9-]+)$/.exec(interaction.customId);
  if (!match) return reject(interaction);
  const [, id, control] = match;
  const searchSubmission = control.startsWith('search-submit-') && interaction.isModalSubmit?.();
  const verb = searchSubmission ? 'search-submit' : control;
  if (verb === 'search-submit' && !searchSubmission) return reject(interaction);
  let action = getItemAction(db, id);
  if (!action || action.guild_id !== interaction.guildId || action.channel_id !== (interaction.channelId ?? interaction.message?.channelId)) return reject(interaction);
  const secret = action.kind === 'counterfeit_crown';
  const decision = ['exchange', 'gamble'].includes(verb);
  const privateControl = secret && !['private', 'cancel'].includes(verb);
  const expectedMessage = privateControl ? ui(action).privateMessageId : action.message_id;
  // Cancellation may also come from the private decoy prompt.
  const bound = searchSubmission
    ? action.kind === 'threadbreaker' && ui(action).franchiseSearchId === control.slice('search-submit-'.length)
      && ui(action).franchiseSearchMessageId === expectedMessage
      && (!interaction.message || interaction.message.id === expectedMessage)
    : interaction.message?.id === expectedMessage || (secret && verb === 'cancel' && interaction.message?.id === ui(action).privateMessageId);
  if (!expectedMessage || !bound || interaction.user.id !== (decision ? action.selections.targets?.[0]?.ownerId : action.actor_id)) return reject(interaction);
  if (decision ? action.state !== 'active' || Date.now() >= action.deadline_at : action.state !== 'confirming' || Date.now() >= action.expires_at) return reject(interaction);
  // Accept only controls this producer can render. A namespace-wide allowlist
  // lets forged verbs persist impossible selection snapshots for other kinds.
  const allowed = new Set(['confirm', 'cancel']);
  if (action.kind === 'threadbreaker') {
    for (const control of ['prev', 'next', 'franchise', 'search', 'search-submit', 'clear-search']) allowed.add(control);
  } else if (action.kind === 'shackles_of_liberation') {
    for (const control of ['prev', 'next', 'unbind-character']) allowed.add(control);
  } else if (action.kind === 'chronicle_of_return') {
    for (const control of ['prev', 'next', 'return-character']) allowed.add(control);
  } else if (action.kind !== 'kaimetsu') {
    for (const control of ['prev', 'next']) allowed.add(control);
    if (secret) allowed.add('private');
    if (action.kind === 'blood_pact') allowed.add('sacrifices');
    else if (action.kind === 'alchemist') allowed.add('costs');
    else {
      allowed.add('character');
      if (targetCount(action)) {
        allowed.add('users');
        if (ownRequired(action)) allowed.add('slot-own');
        for (let slot = 0; slot < targetCount(action); slot++) allowed.add(`slot-target${slot}`);
      }
    }
    if (action.kind === 'hostage_note') for (const control of ['exchange', 'gamble']) allowed.add(control);
  }
  if (!allowed.has(verb)) return reject(interaction);
  const state = runtime(db, interaction.client);
  if (state.busy.has(id)) return reject(interaction, 'This action is already being processed.');
  state.busy.add(id);
  try {
    if (verb === 'search') {
      const modal = new ModalBuilder().setCustomId(cid(action, `search-submit-${interaction.id}`)).setTitle('Search franchises')
        .addLabelComponents(new LabelBuilder().setLabel('Franchise name or alias').setTextInputComponent(
          new TextInputBuilder().setCustomId('franchise-query').setStyle(TextInputStyle.Short)
            .setMinLength(2).setMaxLength(FRANCHISE_QUERY_LIMIT).setRequired(true)
            .setValue((action.selections.franchiseQuery ?? '').slice(0, FRANCHISE_QUERY_LIMIT))));
      persistUI(db, action, { franchiseSearchId: interaction.id, franchiseSearchMessageId: expectedMessage });
      await interaction.showModal(modal);
      return true;
    }
    if (verb === 'private') {
      if (!secret) return reject(interaction);
      await interaction.reply(picker(db, action, true));
      const response = await interaction.fetchReply();
      persistUI(db, action, { privateMessageId: response.id });
      return true;
    }
    await interaction.deferUpdate();
    if (decision) {
      const result = resolveHostage(db, { actionId: id, guildId: interaction.guildId, userId: interaction.user.id, choice: verb });
      if (result.status === 'invalid') return reject(interaction, result.message);
      await publish(db, getItemAction(db, id), state.client);
      return true;
    }
    if (verb === 'cancel') {
      cancelItemAction(db, id, interaction.guildId, interaction.user.id);
      if (secret && interaction.message.id === ui(action).privateMessageId) await interaction.editReply(payload('Canceled. No cost.', [], true));
      await publish(db, getItemAction(db, id), state.client);
      return true;
    }
    if (verb === 'confirm') {
      if (!ready(action)) return reject(interaction, 'Select all costs and targets first.');
      const result = activateItemAction(db, { actionId: id, guildId: interaction.guildId, actorId: interaction.user.id });
      if (result.status === 'invalid') return reject(interaction, result.message);
      if (result.status === 'awaiting_delivery') {
        try { await deliverHostage(db, getItemAction(db, id), state.client); }
        catch { await reject(interaction, 'Prompt delivery failed. Check the public challenge status; unstarted Notes are restored.'); }
        const current = getItemAction(db, id);
        if (current.delivery_pending) await publish(db, current, state.client);
      } else {
        if (secret) await interaction.editReply(payload('Counterfeit Crown activated. Your private confirmation follows.', [], true));
        await publish(db, getItemAction(db, id), state.client, secret ? interaction : null);
      }
      return true;
    }
    let selections = { ...action.selections, _ui: { ...ui(action) } };
    if (verb === 'search-submit' || verb === 'clear-search') {
      const query = verb === 'search-submit' ? interaction.fields.getTextInputValue('franchise-query').trim() : '';
      if (verb === 'search-submit' && (query.length < 2 || query.length > FRANCHISE_QUERY_LIMIT))
        return reject(interaction, `Enter 2–${FRANCHISE_QUERY_LIMIT} characters, or use Clear search.`);
      selections.franchiseQuery = query;
      delete selections.franchise;
      selections._ui = { ...selections._ui, page: 0, franchiseSearchId: null, franchiseSearchMessageId: null };
    } else if (verb === 'franchise') {
      if (action.kind !== 'threadbreaker') return reject(interaction);
      const selected = getCatalogCache(db).get().franchiseIndex.find(franchise => String(franchise.id) === interaction.values?.[0]);
      if (!selected) return reject(interaction, 'Choose a current franchise.');
      selections.franchise = { id: selected.id, name: selected.name ?? selected.aliases[0] };
    } else if (verb === 'users') {
      const users = interaction.values ?? [];
      if (users.length !== targetCount(action) || users.includes(action.actor_id) || new Set(users).size !== users.length) return reject(interaction, 'Choose distinct other owners.');
      selections.targets = [];
      selections._ui = { ...selections._ui, users, slot: 'target0', page: 0 };
    } else if (verb.startsWith('slot-')) {
      const slot = verb.slice(5);
      if ((slot === 'own' && !ownRequired(action)) || (slot !== 'own' && Number(slot.slice(6)) >= targetCount(action))) return reject(interaction);
      selections._ui = { ...selections._ui, slot, page: 0 };
    } else if (verb === 'prev' || verb === 'next') {
      selections._ui.page = Math.max(0, (Number(selections._ui.page) || 0) + (verb === 'next' ? 1 : -1));
    } else if (verb === 'sacrifices') {
      if (action.kind !== 'blood_pact') return reject(interaction);
      const characters = ownedRows(db, action, action.actor_id);
      const page = Math.min(Number(ui(action).page) || 0, Math.max(0, Math.ceil(characters.length / PAGE_SIZE) - 1));
      const visible = characters.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
      const values = interaction.values ?? [];
      const chosen = values.map((value) => visible.find((entry) => `${entry.characterId}.${entry.marriageId}` === value));
      if (chosen.some((entry) => !entry) || new Set(values).size !== values.length) return reject(interaction, 'Ownership changed. Choose current characters on this page.');
      selections.sacrifices = [...(selections.sacrifices ?? []).filter((choice) => !visible.some((entry) => entry.characterId === choice.characterId)), ...chosen];
      if (selections.sacrifices.length > selections._rules.bloodPactSacrificeCount) return reject(interaction, `Choose exactly ${selections._rules.bloodPactSacrificeCount} sacrifices total.`);
    } else if (verb === 'costs') {
      if (action.kind !== 'alchemist') return reject(interaction);
      const costs = commonCosts(db, action);
      const page = Math.min(Number(ui(action).page) || 0, Math.max(0, Math.ceil(costs.length / PAGE_SIZE) - 1));
      const visible = costs.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE).map((entry) => entry.id);
      const chosen = (interaction.values ?? []).map(Number);
      if (chosen.some((value) => !visible.includes(value)) || new Set(chosen).size !== chosen.length) return reject(interaction);
      selections.inventoryIds = [...(selections.inventoryIds ?? []).filter((value) => !visible.includes(value)), ...chosen];
      if (selections.inventoryIds.length > alchemistCost(action)) return reject(interaction, `Choose exactly ${alchemistCost(action)} Common entries total.`);
    } else if (verb === 'unbind-character') {
      const values = interaction.values ?? [];
      const targets = getShacklesTargets(db, action);
      const page = Math.min(Math.max(0, Number(ui(action).page) || 0), Math.max(0, Math.ceil(targets.length / PAGE_SIZE) - 1));
      const choice = values.length === 1 && targets.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE)
        .find(entry => `${entry.characterId}.${entry.marriageId}` === values[0]);
      if (!choice) return reject(interaction, 'Choose an available soulbound character on this page.');
      selections.unbindTarget = choice;
    } else if (verb === 'return-character') {
      const values = interaction.values ?? [];
      const choice = values.length === 1 && getChronicleTargets(db, action).find(entry => String(entry.characterId) === values[0]);
      if (!choice) return reject(interaction, 'This former companion is unavailable. Choose an available character.');
      selections.returnTarget = choice;
    } else if (verb === 'character') {
      if (['alchemist', 'blood_pact'].includes(action.kind)) return reject(interaction);
      const slot = ui(action).slot ?? (ownRequired(action) ? 'own' : 'target0');
      const index = Number(slot.slice(6));
      const owner = slot === 'own' ? action.actor_id : ui(action).users?.[index];
      const value = interaction.values?.[0];
      const choice = owner && ownedRows(db, action, owner).find((entry) => `${entry.characterId}.${entry.marriageId}` === value);
      if (!choice) return reject(interaction, 'Ownership changed. Choose a current character.');
      if (slot === 'own') selections.own = choice;
      else { selections.targets = [...(selections.targets ?? [])]; selections.targets[index] = choice; }
    }
    if (!updateItemSelection(db, id, interaction.guildId, interaction.user.id, selections)) return reject(interaction);
    action = getItemAction(db, id);
    if (searchSubmission) await repairLivePrompt(db, action, state.client);
    else await interaction.editReply(picker(db, action, secret));
    return true;
  } catch {
    // Effects have already committed; persisted delivery state, never activation, is retried.
    return reject(interaction, 'Unable to update this prompt. Committed effects are preserved and delivery will be retried.');
  } finally { state.busy.delete(id); }
}

/** Call once after ClientReady. Startup-only recovery refunds unconfirmed Hostage sends. */
export async function recoverItemActionRuntime(db, client) {
  recoverItemActions(db);
  const state = runtime(db, client);
  await reconcile(db, state);
  // Remaining live prompts are visited by subsequent bounded reconciliation laps.
  return { reconcile: () => reconcile(db, state), stop: () => { clearInterval(state.timer); runtimes.delete(db); } };
}
