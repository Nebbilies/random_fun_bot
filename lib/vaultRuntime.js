import {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  ContainerBuilder,
  MediaGalleryBuilder,
  MediaGalleryItemBuilder,
  MessageFlags,
  StringSelectMenuBuilder,
  TextDisplayBuilder,
} from "discord.js";
import { isConsolationRewardPublishable } from "./mysteryConsolation.js";
import { rewardPresentationMatches } from "./rewardPresentation.js";
import { getItemRewardSource } from "./vaultRewards.js";
import { getAffectionRewardGrant } from "./affectionRewards.js";
import { hasAffection } from "./characterAffection.js";
import { wasWindfallRoll } from "./affectionPerks.js";
import {
  appendCardNotice,
  WINDFALL_NOTICE,
  CONSERVATION_NOTICE,
} from "./affectionPresentation.js";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { getGameConfig } from "./gameConfig.js";
import {
  rollVaultOutcome,
  getResolvedItemDefinitions,
  getItemDefinition,
} from "./itemRoster.js";
import {
  getLens,
  activateLens,
  acknowledgeLens,
  refundUnpresentedLens,
  getRecast,
  presentRecast,
} from "./vaultFortune.js";
import { getUsableInventory } from "./itemStorage.js";
import { getVaultItemPresentation } from "./itemDiscovery.js";
import {
  revealVaultReward,
  decideVaultReward,
  getVaultReward,
  bindVaultRewardMessage,
  markVaultRewardDelivered,
  reconcileVaultRewards,
} from "./vaultRewards.js";

import {
  hasVaultSessions,
  reservePaidVaultSession,
  getVaultSession,
  getVaultSessionByCommand,
  drawVaultSessionOutcome,
  bindVaultSessionMessage,
  inspectVaultSessions,
} from "./vaultSessions.js";

// Transport counters count attempts; outcome counters count observed outcomes.
function countRecovery(stats, key) {
  if (stats) stats[key] = (stats[key] ?? 0) + 1;
}

const VAULT_IMAGE = fileURLToPath(
  new URL("../assets/mystery_vault.png", import.meta.url),
);
const activeVaults = new Map();
const rewardTimers = new WeakMap();

/** @param {number | null} remaining @param {string} vaultId @param {boolean} disabled @param {boolean} canUseLens @param {any} lens */
export function vaultCard(
  remaining,
  vaultId,
  disabled = false,
  canUseLens = false,
  lens = null,
) {
  const container = new ContainerBuilder()
    .setAccentColor(0x5865f2)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent("# A mystery vault appears!"),
      new TextDisplayBuilder().setContent("*Choose one item, wisely...*"),
    )
    .addMediaGalleryComponents(
      new MediaGalleryBuilder().addItems(
        new MediaGalleryItemBuilder()
          .setURL("attachment://mystery_vault.png")
          .setDescription("Mystery Vault"),
      ),
    )
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        remaining === null
          ? "-# Weekly Event prize"
          : `-# ${remaining} roll${remaining === 1 ? "" : "s"} left`,
      ),
    )
    .addActionRowComponents(
      /** @type {ActionRowBuilder<ButtonBuilder>} */ (
        new ActionRowBuilder()
      ).addComponents(
        ["A", "B", "C"].map((label) =>
          new ButtonBuilder()
            .setCustomId(`vault:${vaultId}:${label}`)
            .setLabel(label)
            .setStyle(ButtonStyle.Primary)
            .setDisabled(disabled),
        ),
      ),
    );
  if (lens && lens.state !== "refunded")
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `-# Fortune Lens v1 · ${vaultId}\n` +
          lens.candidates
            .map(
              (outcome, index) =>
                `**${["A", "B", "C"][index]}: ${outcome.item.name}** (${outcome.tierData.name}) — ${outcome.item.description}`,
            )
            .join("\n"),
      ),
    );
  if (canUseLens && !lens && !disabled)
    container.addActionRowComponents(
      /** @type {ActionRowBuilder<ButtonBuilder>} */ (
        new ActionRowBuilder()
      ).addComponents(
        new ButtonBuilder()
          .setCustomId(`vault:${vaultId}:lens`)
          .setLabel("Use Fortune’s Lens")
          .setStyle(ButtonStyle.Secondary),
      ),
    );
  const payload = {
    flags: MessageFlags.IsComponentsV2,
    components: [container],
    allowedMentions: { parse: [], repliedUser: false },
  };
  if (!disabled)
    payload.files = [
      new AttachmentBuilder(VAULT_IMAGE, { name: "mystery_vault.png" }),
    ];
  return payload;
}

/**
 * @param {ActionRowBuilder<import('discord.js').MessageActionRowComponentBuilder> | null} [actionRow]
 * @param {string | null} [noticeText]
 */
export function vaultRewardCard(outcome, actionRow = null, noticeText = null) {
  const emoji = outcome.tierData.emoji ? `${outcome.tierData.emoji} ` : "";
  const container = new ContainerBuilder().setAccentColor(
    outcome.tierData.color,
  );
  if (noticeText)
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(noticeText),
    );
  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(`# ${emoji}${outcome.tierData.name}`),
    new TextDisplayBuilder().setContent(
      `**${outcome.item.name}** — ${outcome.item.description}`,
    ),
  );
  if (actionRow) container.addActionRowComponents(actionRow);
  return container;
}
export const vaultRewardEmbed = vaultRewardCard;

/**
 * @param {{db: any, channel: any, guildId: string, rollerId: string, remaining: number,
 *   commandMessageId?: string, rollOutcome?: () => ReturnType<typeof rollVaultOutcome>, timeoutMs?: number,
 *   capturedOutcome?: ReturnType<typeof rollVaultOutcome>,
 *   now?: () => number, random?: () => number}} request
 */
export async function startVaultRoll({
  db,
  channel,
  guildId,
  rollerId,
  remaining,
  commandMessageId,
  rollOutcome,
  timeoutMs,
  capturedOutcome,
  now = Date.now,
  random = Math.random,
}) {
  const durable = hasVaultSessions(db);
  if (!durable && db.prepare("PRAGMA user_version").get().user_version > 10) {
    throw new Error("Final catalog requires authoritative vault_sessions DDL");
  }
  // Callback fixtures are supported only by the legacy (schema <=10) path.
  if (durable) {
    if (rollOutcome)
      throw new Error("Durable vaults require capturedOutcome, not a callback");
    const session =
      (commandMessageId && getVaultSessionByCommand(db, commandMessageId)) ||
      reservePaidVaultSession(db, {
        guildId,
        rollerId,
        channelId: channel.id,
        remaining,
        commandMessageId,
        capturedOutcome,
        timeoutMs,
        now: now(),
      });
    if (
      !session ||
      session.guildId !== guildId ||
      session.rollerId !== rollerId ||
      session.channelId !== channel.id
    ) {
      throw new Error("Vault reservation scope mismatch");
    }
    return publishVaultSession(db, session, channel, now);
  }
  const config = getGameConfig(db, guildId);
  // Explicit scripted vaults (Golden Hour) remain usable; enabled gates random drops.
  const roster = getResolvedItemDefinitions(db, guildId);
  const rules = config.itemActions;
  const weights = config.vault.tierWeights;
  const rewardPools = Object.fromEntries(
    ["epic", "legendary"].map((tier) => [
      tier,
      roster.filter((item) => item.tier === tier && item.rewardEligible),
    ]),
  );
  const drawOutcome =
    rollOutcome ?? (() => rollVaultOutcome(random, random, weights, roster));
  rollOutcome = () => ({
    ...drawOutcome(),
    _rules: rules,
    _rewardPools: rewardPools,
  });
  const vaultId = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const card = vaultCard(remaining, vaultId);
  const message = await channel.send(
    commandMessageId
      ? {
          ...card,
          reply: { messageReference: commandMessageId, failIfNotExists: false },
        }
      : card,
  );
  const session = {
    vaultId,
    db,
    message,
    guildId,
    rollerId,
    remaining,
    rollOutcome,
    now,
    random,
    handled: false,
    timer: setTimeout(async () => {
      if (!session.handled) {
        session.handled = true;
        try {
          await message.edit(vaultCard(remaining, vaultId, true));
        } catch {
          /* Deleted card. */
        }
      }
      activeVaults.delete(vaultId);
    }, timeoutMs ?? config.vault.openTimeoutMs),
  };
  session.timer.unref?.();
  activeVaults.set(vaultId, session);
  return { vaultId, message };
}

const sessionTimers = new WeakMap();
// Every canonical-card writer uses this queue, including interactions and timers.
// Helpers called inside a queued operation must not acquire it again.
const vaultWrites = new WeakMap();
async function withVaultWrite(db, vaultId, operation) {
  let writes = vaultWrites.get(db);
  if (!writes) {
    writes = new Map();
    vaultWrites.set(db, writes);
  }
  const previous = writes.get(vaultId) ?? Promise.resolve();
  const work = previous.catch(() => {}).then(operation);
  writes.set(vaultId, work);
  try {
    return await work;
  } finally {
    if (writes.get(vaultId) === work) writes.delete(vaultId);
  }
}
function scheduleVaultSession(db, session, message, now) {
  let timers = sessionTimers.get(db);
  if (!timers) {
    timers = new Map();
    sessionTimers.set(db, timers);
  }
  clearTimeout(timers.get(session.vaultId));
  timers.delete(session.vaultId);
  if (session.state !== "unopened") return;
  const timer = setTimeout(
    async () => {
      timers.delete(session.vaultId);
      try {
        inspectVaultSessions(db, { now: now() });
        const current = getVaultSession(db, session.vaultId);
        if (!current) return;
        if (current.state === "expired") {
          // Fetch/reconcile the canonical reveal before disabling or refunding it.
          await publishVaultSession(
            db,
            current,
            message.channel ?? { messages: { fetch: async () => message } },
            now,
          );
        } else if (current.state === "unopened")
          scheduleVaultSession(db, current, message, now);
      } catch {
        /* Periodic recovery retries without moving the original deadline. */
      }
    },
    Math.max(1, session.deadline - now()),
  );
  timer.unref?.();
  timers.set(session.vaultId, timer);
}

async function publishVaultSession(
  db,
  session,
  channel,
  now,
  stats = undefined,
) {
  return withVaultWrite(db, session.vaultId, () =>
    deliverVaultSession(db, session, channel, now, stats),
  );
}

async function deliverVaultSession(db, session, channel, now, stats) {
  inspectVaultSessions(db, { now: now() });
  session = getVaultSession(db, session.vaultId);
  if (session.state === "revealed")
    return { vaultId: session.vaultId, message: null };
  let message;
  if (session.messageId) {
    try {
      countRecovery(stats, "sourceFetches");
      message = await channel.messages.fetch({
        message: session.messageId,
        force: true,
      });
    } catch (error) {
      if (error.code !== 10008) throw error;
    }
  }
  const disabled = session.state !== "unopened";
  let lens = getLens(db, session.vaultId);
  if (lens?.state === "pending") {
    // Inspect before overwriting: an edit can have succeeded before its DB acknowledgement.
    const shown =
      message &&
      JSON.stringify(
        message.components ?? message.payload?.components ?? [],
      ).includes(`Fortune Lens v1 · ${session.vaultId}`);
    if (shown) acknowledgeLens(db, session.vaultId, now());
    else if (disabled)
      refundUnpresentedLens(db, session.vaultId, { absent: true, now: now() });
    lens = getLens(db, session.vaultId);
  }
  // Fortune-compatible terms alone do not entitle the roller to a Lens control.
  // Recheck live inventory on publication/recovery; another vault may have spent it.
  const canUseLens =
    !disabled &&
    !lens &&
    session.captured.fortuneVersion === 1 &&
    getUsableInventory(db, session.guildId, session.rollerId, now()).some(
      (item) => item.item_id === "fortunes_lens",
    );
  const cardForSession = () =>
    sessionCard(db, session, disabled, canUseLens, lens);
  if (message) {
    countRecovery(stats, "sourceEdits");
    await message.edit(cardForSession());
  } else {
    const card = cardForSession();
    // A replacement still needs the attachment referenced by the disabled card.
    if (disabled)
      card.files = [
        new AttachmentBuilder(VAULT_IMAGE, { name: "mystery_vault.png" }),
      ];
    countRecovery(stats, "sourceSends");
    message = await channel.send({
      ...card,
      nonce: session.vaultId.replaceAll("-", "").slice(0, 24),
      enforceNonce: true,
      ...(session.commandMessageId && /^\d+$/.test(session.commandMessageId)
        ? {
            reply: {
              messageReference: session.commandMessageId,
              failIfNotExists: false,
            },
          }
        : {}),
    });
  }
  if (!disabled && lens?.state === "pending")
    acknowledgeLens(db, session.vaultId, now());
  const bound = bindVaultSessionMessage(
    db,
    session.vaultId,
    message.id,
    session.messageId,
    now(),
    message.createdTimestamp ?? now(),
  );
  if (bound?.messageId === message.id)
    scheduleVaultSession(db, bound, message, now);
  return { vaultId: session.vaultId, message };
}

/** Startup/periodic guard. recoverRewards defaults to combined standalone recovery.
 * stats is an optional additive counter object; absent keys mean zero.
 * candidates includes sessions and, unless opted out, trailing reward candidates.
 */
export async function recoverVaultSessions(
  db,
  client,
  { now = Date.now, recoverRewards = true, stats = undefined } = {},
) {
  const pending = inspectVaultSessions(db, { now: now() });
  for (const session of pending) {
    countRecovery(stats, "candidates");
    try {
      countRecovery(stats, "channelFetches");
      const channel = await client.channels.fetch(session.channelId);
      await publishVaultSession(db, session, channel, now, stats);
    } catch {
      countRecovery(
        stats,
        "deferred",
      ); /* Never authorize replacement or reset time. */
    }
  }
  if (recoverRewards) await recoverVaultRewards(db, client, { now, stats });
  return pending;
}

function presentedLens(db, guildId, lens) {
  return (
    lens && {
      ...lens,
      candidates: lens.candidates.map((outcome) => ({
        ...outcome,
        item: getVaultItemPresentation(db, guildId, outcome.item),
      })),
    }
  );
}

function conservedRewardCost(db, sourceKey) {
  return (
    hasAffection(db) &&
    db
      .prepare("SELECT actual_debit FROM reward_use_costs WHERE source_key=?")
      .get(sourceKey)?.actual_debit === 0
  );
}
function sessionCard(db, session, disabled, canUseLens, lens) {
  const payload = vaultCard(
    session.captured.weeklyMysteryWin ? null : session.remaining,
    session.vaultId,
    disabled,
    canUseLens,
    presentedLens(db, session.guildId, lens),
  );
  if (
    wasWindfallRoll(db, session.guildId, session.rollerId, session.paidRollId)
  )
    appendCardNotice(payload, WINDFALL_NOTICE);
  if (
    lens &&
    lens.state !== "refunded" &&
    conservedRewardCost(db, `lens:${session.vaultId}`)
  )
    appendCardNotice(payload, CONSERVATION_NOTICE);
  return payload;
}
function payloadForReward(db, reward, page = 0) {
  const storedOutcome = reward.reward ?? reward.original;
  const outcome = {
    ...storedOutcome,
    item: getVaultItemPresentation(db, reward.guildId, storedOutcome.item),
  };
  /** @type {ActionRowBuilder<import('discord.js').MessageActionRowComponentBuilder> | null} */
  let row = null;
  let notice;
  if (reward.state === "decision") {
    notice = `<@${reward.userId}>, keep this revealed reward or spend Double or Nothing to gamble? Only you may decide. Keep is automatic <t:${Math.floor(reward.deadline / 1000)}:R>.`;
    row = /** @type {ActionRowBuilder<ButtonBuilder>} */ (
      new ActionRowBuilder()
    ).addComponents(
      new ButtonBuilder()
        .setCustomId(`vault:${reward.vaultId}:keep`)
        .setLabel("Keep")
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(`vault:${reward.vaultId}:gamble`)
        .setLabel("Gamble")
        .setStyle(ButtonStyle.Danger),
    );
  } else if (reward.state === "recast") {
    notice = `<@${reward.userId}>, a private Recast choice is waiting. Open it below; alternatives are never posted publicly.`;
    row = /** @type {ActionRowBuilder<ButtonBuilder>} */ (
      new ActionRowBuilder()
    ).addComponents(
      new ButtonBuilder()
        .setCustomId(`vault:${reward.vaultId}:recastopen`)
        .setLabel("Open Recast choice")
        .setStyle(ButtonStyle.Primary),
    );
  } else if (reward.state === "overflow") {
    const inv = getUsableInventory(db, reward.guildId, reward.userId);
    const pages = Math.max(1, Math.ceil(inv.length / 22));
    page = Math.max(0, Math.min(pages - 1, page));
    const options = inv.slice(page * 22, (page + 1) * 22).map((entry) => ({
      label:
        `${getItemDefinition(entry.item_id)?.name ?? entry.item_id} (${entry.charges} charges)`.slice(
          0,
          100,
        ),
      value: String(entry.id),
    }));
    options.push(
      { label: "Decline new item (keep current inventory)", value: "-1" },
      { label: "Take reward if space is now available", value: "accept" },
    );
    if (pages > 1)
      options.push({
        label: "Next inventory page",
        value: `page_${(page + 1) % pages}`,
      });
    row = /** @type {ActionRowBuilder<StringSelectMenuBuilder>} */ (
      new ActionRowBuilder()
    ).addComponents(
      new StringSelectMenuBuilder()
        .setCustomId(`vault:${reward.vaultId}:replace`)
        .setPlaceholder("Choose an item to discard, or decline")
        .addOptions(options),
    );
    notice = `⚠️ <@${reward.userId}>'s inventory is full! Only the recipient may replace an item or decline. This reward remains pending.`;
  } else if (reward.state === "lost") {
    notice = `<@${reward.userId}> gambled and lost the reward.${
      conservedRewardCost(db, `gamble:${reward.vaultId}`)
        ? ""
        : " One Double or Nothing charge was spent."
    }`;
  } else if (reward.state === "declined") {
    notice = `<@${reward.userId}> declined this reward.`;
  } else {
    notice = `🎉 <@${reward.userId}> received **${outcome.item.name}**! Added to your inventory.`;
  }
  const source = getItemRewardSource(db, reward.vaultId);
  const labels = [];
  if (source?.kind === "affection_milestone") labels.push("Affection reward");
  if (source?.kind === "affection_echo") labels.push("Echo bonus");
  const grant = getAffectionRewardGrant(db, reward.vaultId);
  if (
    grant?.state === "finalized" &&
    grant.pre_perk_outcome_json &&
    grant.pre_perk_outcome_json !== grant.final_outcome_json
  ) {
    const before = JSON.parse(grant.pre_perk_outcome_json);
    const final = JSON.parse(grant.final_outcome_json);
    if (before.tier !== final.tier)
      labels.push(`Fortune's Favor · ${before.tier} → ${final.tier}`);
  }
  if (
    ["gamble", "recast"].some((kind) =>
      conservedRewardCost(db, `${kind}:${reward.vaultId}`),
    )
  )
    labels.push(CONSERVATION_NOTICE);
  if (labels.length) notice = `${labels.join("\n")}\n${notice}`;
  return {
    flags: MessageFlags.IsComponentsV2,
    components: [vaultRewardCard(outcome, row, notice)],
    allowedMentions: { parse: [], repliedUser: false },
  };
}

// DB-only reconciliation can advance another vault while a transport write awaits.
// Do not acknowledge a stale publication: catch up before releasing this vault's queue.
async function writeLatestReward(db, vaultId, write, page = 0) {
  let reward = getVaultReward(db, vaultId);
  while (reward) {
    const payload = payloadForReward(db, reward, page);
    await write(payload, reward);
    reward = getVaultReward(db, vaultId);
    if (
      reward &&
      JSON.stringify(payload) ===
        JSON.stringify(payloadForReward(db, reward, page))
    )
      return reward;
  }
  return reward;
}

function updateRewardInteraction(db, vaultId, interaction, page = 0) {
  let acknowledged = false;
  return writeLatestReward(
    db,
    vaultId,
    async (payload) => {
      if (acknowledged) return interaction.message.edit(payload);
      acknowledged = true;
      return interaction.update(payload);
    },
    page,
  );
}

function scopeFrom(interaction) {
  return {
    guildId: interaction.guildId,
    userId: interaction.user.id,
    channelId:
      interaction.channelId ??
      interaction.channel?.id ??
      interaction.message?.channelId,
    messageId: interaction.message?.id,
  };
}
function authorized(reward, scope) {
  return (
    reward &&
    reward.guildId === scope.guildId &&
    reward.userId === scope.userId &&
    reward.channelId === scope.channelId &&
    reward.messageId === scope.messageId
  );
}
function scheduleReward(db, reward, message, now = Date.now) {
  let timers = rewardTimers.get(db);
  if (!timers) {
    timers = new Map();
    rewardTimers.set(db, timers);
  }
  clearTimeout(timers.get(reward.vaultId));
  timers.delete(reward.vaultId);
  const recast =
    reward.state === "recast" ? getRecast(db, reward.vaultId) : null;
  const deadline = recast?.deadline ?? reward.deadline;
  if (reward.state !== "decision" && !(recast?.state === "presented")) return;
  const timer = setTimeout(
    async () => {
      timers.delete(reward.vaultId);
      try {
        await withVaultWrite(db, reward.vaultId, async () => {
          reconcileVaultRewards(db, { now: now() });
          const updated = await writeLatestReward(
            db,
            reward.vaultId,
            (payload) => message.edit(payload),
          );
          if (!updated) return;
          markVaultRewardDelivered(db, reward.vaultId, now());
          if (["decision", "recast"].includes(updated.state))
            scheduleReward(db, updated, message, now);
        });
      } catch {
        /* Periodic recovery retries failures; game state is durable. */
      }
    },
    Math.max(1, deadline - now()),
  );
  timer.unref?.();
  timers.set(reward.vaultId, timer);
}

// Called inside the vault write queue by both selection and recovery.
async function deliverRewardMessage(
  db,
  vaultId,
  channel,
  now,
  stats = undefined,
) {
  let reward = getVaultReward(db, vaultId);
  if (!reward) return null;
  if (!isConsolationRewardPublishable(db, reward)) {
    countRecovery(stats, "gated");
    return null;
  }
  const direct = getItemRewardSource(db, reward.vaultId);
  const session = hasVaultSessions(db)
    ? getVaultSession(db, reward.vaultId)
    : null;
  // Historical rewards bound to the source remain valid same-message cards.
  if (
    session &&
    reward.sourceMessageId &&
    reward.messageId !== reward.sourceMessageId
  ) {
    let source;
    try {
      countRecovery(stats, "sourceFetches");
      source = await channel.messages.fetch({
        message: reward.sourceMessageId,
        force: true,
      });
    } catch (error) {
      if (error.code !== 10008) throw error;
    }
    if (source) {
      if (!getVaultReward(db, vaultId)) return null;
      // A delivered reward may be retried after a crash; never leave the old
      // A/B/C controls active, but avoid an unnecessary edit on every scan.
      const card = sessionCard(
        db,
        session,
        true,
        false,
        getLens(db, session.vaultId),
      );
      // Source attachments resolve to CDN URLs after sending; they are not reward
      // presentation evidence. Inspect every old source control, not just the
      // presence of one disabled button in the serialized card.
      const controls = [];
      const inspect = (node) => {
        if (!node || typeof node !== "object") return;
        if (node.custom_id?.startsWith(`vault:${session.vaultId}:`))
          controls.push(node);
        for (const child of node.components ?? []) inspect(child);
      };
      for (const component of JSON.parse(
        JSON.stringify(source.components ?? source.payload?.components ?? []),
      ))
        inspect(component);
      if (
        !controls.length ||
        controls.some((control) => control.disabled !== true)
      ) {
        countRecovery(stats, "sourceEdits");
        await source.edit({ ...card, content: null, embeds: [] });
      }
    }
  }
  let message;
  let sent = false;
  if (reward.messageId) {
    try {
      countRecovery(stats, "rewardFetches");
      message = await channel.messages.fetch({
        message: reward.messageId,
        force: true,
      });
    } catch (error) {
      if (error.code !== 10008) throw error;
      countRecovery(stats, "missing");
    }
  }
  if (!message) {
    // Stable across send-success/response-loss retries, distinct from the source
    // nonce and from replacements of definitively deleted reward messages.
    const previousBinding = reward.messageId;
    const nonce = createHash("sha256")
      .update(`reward:${reward.vaultId}:${previousBinding ?? ""}`)
      .digest("hex")
      .slice(0, 24);
    // Fetch/source awaits can include DB-only reconciliation. Render current state,
    // but do not replace a newer binding whose message we have not verified.
    reward = getVaultReward(db, vaultId);
    if (!reward) return null;
    if (reward.messageId !== previousBinding)
      throw new Error("Reward binding changed before replacement");
    countRecovery(stats, "rewardSends");
    sent = true;
    message = await channel.send({
      ...payloadForReward(db, reward),
      nonce,
      enforceNonce: true,
      ...(direct && !reward.messageId
        ? {
            allowedMentions: {
              parse: [],
              users: [reward.userId],
              repliedUser: false,
            },
          }
        : {}),
    });
    const previousMessageId = reward.messageId;
    reward = bindVaultRewardMessage(
      db,
      vaultId,
      reward.channelId,
      message.id,
      previousMessageId,
    );
    if (!reward) return null;
    if (reward.messageId !== message.id)
      throw new Error("Reward canonical bind lost during publication");
    if (previousMessageId && previousMessageId !== message.id)
      countRecovery(stats, "rebindings");
  }
  const requireCanonical = (current) => {
    if (current.messageId !== message.id) {
      throw new Error("Reward canonical binding changed during publication");
    }
  };
  let unchanged = true;
  reward = await writeLatestReward(db, vaultId, async (payload, current) => {
    requireCanonical(current);
    if (rewardPresentationMatches(message, payload)) return;
    unchanged = false;
    countRecovery(stats, "rewardEdits");
    // Message edits are patches: explicitly clear legacy content/embeds when
    // replacing a stale card with Components V2, rather than leaving them behind.
    message = await message.edit({ ...payload, content: null, embeds: [] });
  });
  if (!reward) return null;
  requireCanonical(reward);
  if (unchanged && !sent) countRecovery(stats, "rewardUnchanged");
  if (getLens(db, reward.vaultId)?.state === "pending")
    acknowledgeLens(db, reward.vaultId, now());
  if (reward.deliveredAt === null)
    markVaultRewardDelivered(db, reward.vaultId, now());
  scheduleReward(db, reward, message, now);
  return message;
}

/** Call after ready and periodically. One inaccessible channel cannot stop recovery. */
export async function recoverVaultRewards(
  db,
  client,
  { now = Date.now, stats = undefined } = {},
) {
  const pending = reconcileVaultRewards(db, { now: now() });
  await publishVaultRewards(db, client, pending, { now, stats });
}

/** Publish already-committed rewards immediately; recovery retries failed sends. */
export async function publishVaultRewards(
  db,
  client,
  pending,
  { now = Date.now, stats = undefined } = {},
) {
  for (const reward of pending) {
    countRecovery(stats, "candidates");
    try {
      await withVaultWrite(db, reward.vaultId, async () => {
        countRecovery(stats, "channelFetches");
        const channel = await client.channels.fetch(reward.channelId);
        // The scan may have queued behind an interaction. Never publish its stale snapshot.
        await deliverRewardMessage(db, reward.vaultId, channel, now, stats);
      });
    } catch {
      countRecovery(stats, "deferred"); /* Never replay a committed reward. */
    }
  }
  return pending;
}

function privateRecastPayload(decision, publicMessageId) {
  const options = [
    { label: `Keep ${decision.original.item.name}`.slice(0, 100), value: "-1" },
    ...decision.alternatives.map((item, index) => ({
      label: item.name.slice(0, 100),
      description: item.description.slice(0, 100),
      value: String(index),
    })),
  ];
  const container = new ContainerBuilder()
    .setAccentColor(decision.original.tierData.color)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `# Fortune's Recast\nKeep **${decision.original.item.name}** or select a same-tier alternative.\n${decision.deadline ? `Keep is automatic <t:${Math.floor(decision.deadline / 1000)}:R>.` : "The decision window starts when this private choice is presented."}`,
      ),
    )
    .addActionRowComponents(
      /** @type {ActionRowBuilder<StringSelectMenuBuilder>} */ (
        new ActionRowBuilder()
      ).addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(
            `vault:${decision.vault_id}:recastchoice:${publicMessageId}`,
          )
          .setPlaceholder("Keep or Recast")
          .addOptions(options),
      ),
    );
  return {
    flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
    components: [container],
    allowedMentions: { parse: [] },
  };
}
function followUpRecastAdapter(interaction, message = interaction.message) {
  const followUp = interaction.followUp.bind(interaction);
  let privateMessage;
  return {
    message,
    reply: async (payload) => {
      privateMessage = await followUp(payload);
    },
    editReply: async (payload) => {
      await interaction.webhook.editMessage(privateMessage.id, payload);
    },
  };
}

async function openPrivateRecast(db, interaction, reward, now) {
  const decision = getRecast(db, reward.vaultId);
  if (!decision || decision.state === "chosen") return;
  // Persisted candidates precede publication; charge and deadline follow confirmed send.
  await interaction.reply(privateRecastPayload(decision, reward.messageId));
  const presented = presentRecast(db, {
    vaultId: reward.vaultId,
    guildId: reward.guildId,
    userId: reward.userId,
    channelId: reward.channelId,
    messageId: reward.messageId,
    now: now(),
  });
  if (presented.decision) {
    const payload = privateRecastPayload(presented.decision, reward.messageId);
    if (conservedRewardCost(db, `recast:${reward.vaultId}`))
      appendCardNotice(payload, CONSERVATION_NOTICE);
    try {
      await interaction.editReply?.(payload);
    } catch {
      /* Same durable choice remains resumable. */
    }
  }
  scheduleReward(db, reward, interaction.message, now);
}
export async function onVaultInteraction(db, interaction, options = {}) {
  if (!interaction.isButton() && !interaction.isStringSelectMenu())
    return false;
  const [prefix, vaultId] = interaction.customId.split(":");
  if (prefix !== "vault") return false;
  return withVaultWrite(db, vaultId, () =>
    handleVaultInteraction(db, interaction, options),
  );
}

async function handleVaultInteraction(
  db,
  interaction,
  { now = Date.now, random = Math.random } = {},
) {
  if (!interaction.isButton() && !interaction.isStringSelectMenu())
    return false;
  const parts = interaction.customId.split(":");
  if (parts[0] !== "vault") return false;
  const [, vaultId, action] = parts;
  const reject = async (content) => {
    await interaction.reply({
      content,
      flags: MessageFlags.Ephemeral,
      allowedMentions: { parse: [] },
    });
    return true;
  };
  const scope = scopeFrom(interaction);
  if (action === "recastopen" && parts.length === 3 && interaction.isButton()) {
    reconcileVaultRewards(db, { now: now() });
    const reward = getVaultReward(db, vaultId);
    if (!reward || !authorized(reward, scope) || reward.state !== "recast")
      return reject(
        "This private choice is stale or belongs to another roller or message.",
      );
    await openPrivateRecast(db, interaction, reward, now);
    return true;
  }
  if (
    action === "recastchoice" &&
    parts.length === 4 &&
    interaction.isStringSelectMenu()
  ) {
    const reward = getVaultReward(db, vaultId);
    const canonicalScope = { ...scope, messageId: parts[3] };
    if (
      !reward ||
      !authorized(reward, canonicalScope) ||
      reward.state !== "recast"
    )
      return reject(
        "This private choice is stale or belongs to another roller.",
      );
    // Private messages have different IDs. Verify the live canonical public binding, not the ephemeral ID.
    let publicMessage;
    try {
      publicMessage = await interaction.channel.messages.fetch(
        reward.messageId,
      );
    } catch {
      return reject(
        "The public reward could not be verified. Reopen the choice from its current card.",
      );
    }
    const value = interaction.values?.[0];
    if (!/^-1$|^[0-2]$/.test(value ?? ""))
      return reject("Invalid Recast choice.");
    const result = decideVaultReward(db, {
      vaultId,
      ...canonicalScope,
      action: "recast",
      choice: Number(value),
      now: now(),
    });
    if (result.status !== "resolved")
      return reject("This Recast choice is no longer available.");
    await interaction.update({
      flags: MessageFlags.IsComponentsV2,
      components: [
        new ContainerBuilder().addTextDisplayComponents(
          new TextDisplayBuilder().setContent(
            "Recast choice saved. Your public reward card shows delivery status.",
          ),
        ),
      ],
    });
    try {
      const published = await writeLatestReward(db, vaultId, (payload) =>
        publicMessage.edit(payload),
      );
      if (published) markVaultRewardDelivered(db, vaultId, now());
    } catch {
      /* Delivery publication is recovered independently. */
    }
    return true;
  }
  if (["keep", "gamble", "replace"].includes(action)) {
    const reward = getVaultReward(db, vaultId);
    if (!reward || parts.length !== 3 || !authorized(reward, scope))
      return reject(
        "This reward control is stale or belongs to another roller, server, or message.",
      );
    if ((action === "replace") !== interaction.isStringSelectMenu())
      return reject("Invalid reward control.");
    const value = interaction.values?.[0];
    if (
      action === "replace" &&
      /^page_\d+$/.test(value ?? "") &&
      reward.state === "overflow"
    ) {
      await updateRewardInteraction(
        db,
        vaultId,
        interaction,
        Number(value.slice(5)),
      );
      return true;
    }
    const operation =
      action === "replace"
        ? value === "-1"
          ? "decline"
          : value === "accept"
            ? "accept"
            : "replace"
        : action;
    const result = decideVaultReward(db, {
      vaultId,
      ...scope,
      action: operation,
      inventoryId: value && /^\d+$/.test(value) ? Number(value) : undefined,
      now: now(),
      random,
    });
    if (
      [
        "stale",
        "invalid",
        "forbidden",
        "invalid_inventory",
        "missing_item",
      ].includes(result.status)
    ) {
      return reject(
        result.status === "missing_item"
          ? "Double or Nothing is no longer available. You may still Keep before the original deadline."
          : "This choice is stale or the selected inventory entry is unavailable.",
      );
    }
    const published = await updateRewardInteraction(db, vaultId, interaction);
    if (!published) return true;
    markVaultRewardDelivered(db, vaultId, now());
    scheduleReward(db, published, interaction.message, now);
    if (published.state === "recast" && interaction.followUp) {
      try {
        await openPrivateRecast(
          db,
          followUpRecastAdapter(interaction),
          published,
          now,
        );
      } catch {
        /* Public resume control retains the pending, unspent choice. */
      }
    }
    return true;
  }
  if (action === "lens" && parts.length === 3 && interaction.isButton()) {
    const result = activateLens(db, { vaultId, ...scope, now: now(), random });
    if (!["revealed", "existing"].includes(result.status))
      return reject(
        "Lens is unavailable on this vault, or this control is stale. No charge was spent.",
      );
    const session = getVaultSession(db, vaultId);
    if (!session) return reject("This vault is no longer available.");
    const payload = sessionCard(db, session, false, true, result.lens);
    await interaction.update(payload);
    acknowledgeLens(db, vaultId, now());
    return true;
  }
  if (
    !["A", "B", "C"].includes(action) ||
    parts.length !== 3 ||
    !interaction.isButton()
  )
    return reject("Invalid vault control.");
  const durable = hasVaultSessions(db) ? getVaultSession(db, vaultId) : null;
  if (durable) {
    if (
      scope.userId !== durable.rollerId ||
      scope.guildId !== durable.guildId ||
      scope.channelId !== durable.channelId ||
      scope.messageId !== durable.messageId
    ) {
      return reject(
        "This vault control belongs to another roller, server, or message.",
      );
    }
    // The insert trigger links vault_rewards in its own reveal transaction. A duplicate
    // click never draws again, even when the first Discord acknowledgement failed.
    let reward = getVaultReward(db, vaultId);
    if (!reward) {
      if (durable.state !== "unopened" || now() >= durable.deadline) {
        inspectVaultSessions(db, { now: now() });
        return reject(
          "This mystery vault has already expired or been claimed.",
        );
      }
      reward = revealVaultReward(db, {
        vaultId,
        guildId: durable.guildId,
        userId: durable.rollerId,
        channelId: durable.channelId,
        sourceMessageId: durable.messageId,
        outcome:
          getLens(db, vaultId)?.candidates[["A", "B", "C"].indexOf(action)] ??
          drawVaultSessionOutcome(durable, random),
        now: now(),
        random,
      });
    }
    if (!reward)
      return reject("This mystery vault has already expired or been claimed.");
    if (getLens(db, vaultId)) acknowledgeLens(db, vaultId, now());
    if (reward.deliveredAt !== null)
      return reject(
        "This vault has already been selected. Use its reward controls.",
      );
    await interaction.deferUpdate();
    const message = await deliverRewardMessage(
      db,
      vaultId,
      interaction.channel,
      now,
    );
    reward = getVaultReward(db, vaultId);
    if (!message || !reward) return true;
    if (reward.state === "recast" && interaction.followUp) {
      try {
        await openPrivateRecast(
          db,
          followUpRecastAdapter(interaction, message),
          reward,
          now,
        );
      } catch {
        /* Resume from the canonical reward card. */
      }
    }
    return true;
  }
  const session = hasVaultSessions(db) ? null : activeVaults.get(vaultId);
  if (!session || session.db !== db)
    return reject("This mystery vault has already expired or been claimed.");
  if (scope.userId !== session.rollerId)
    return reject("Only the roller who summoned the vault may choose an item.");
  if (
    scope.guildId !== session.guildId ||
    scope.channelId !== session.message.channelId ||
    scope.messageId !== session.message.id
  ) {
    return reject("This vault control belongs to another server or message.");
  }
  if (session.handled)
    return reject("An item from this vault has already been selected.");
  const reward = revealVaultReward(db, {
    vaultId,
    guildId: session.guildId,
    userId: session.rollerId,
    channelId: scope.channelId,
    sourceMessageId: session.message.id,
    outcome: session.rollOutcome(),
    now: session.now(),
    random,
  });
  session.handled = true;
  clearTimeout(session.timer);
  activeVaults.delete(vaultId);
  await interaction.reply(payloadForReward(db, reward));
  let prompt;
  try {
    prompt = await interaction.fetchReply?.();
  } catch {
    /* Recovery publishes an unbound reward. */
  }
  if (prompt?.id) {
    const bound = bindVaultRewardMessage(
      db,
      vaultId,
      scope.channelId,
      prompt.id,
    );
    markVaultRewardDelivered(db, vaultId, session.now());
    scheduleReward(db, bound, prompt, session.now);
  } else if (!["decision", "overflow"].includes(reward.state)) {
    markVaultRewardDelivered(db, vaultId, session.now());
  }
  try {
    await session.message.edit(vaultCard(session.remaining, vaultId, true));
  } catch {
    /* Deleted card. */
  }
  return true;
}
