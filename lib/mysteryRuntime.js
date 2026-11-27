import { currentSeasonRows } from "./seasonSchema.js";
import { inspectMysteryConsolation } from "./mysteryConsolation.js";
import { recoverVaultRewards } from "./vaultRuntime.js";
import {
  characterMainFranchises,
  withCharacterMainFranchises,
} from "./characterSeries.js";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  ContainerBuilder,
  EmbedBuilder,
  escapeMarkdown,
  MediaGalleryBuilder,
  MediaGalleryItemBuilder,
  MessageFlags,
  SeparatorBuilder,
  TextDisplayBuilder,
} from "discord.js";
import {
  cancelActiveMysteries,
  endMysterySession,
  getMysterySession,
  openMysteryClaim,
  publishMysteryIntro,
} from "./characterRolls.js";
import {
  activeMysteryInGuild,
  advanceMysteryEvent,
  beginMysteryEvent,
  getMysterySessionConfig,
  selectedMysteryCharacter,
  revealWithBinoculars,
} from "./mysteryCoordinator.js";
import { reserveBinocularsUse, settleBinocularsUse } from "./binocularsUse.js";
import { formatNumber } from "./formatNumber.js";
import { transaction } from "./catalogDb.js";
import {
  hasAffection,
  completeAppearanceInTransaction,
} from "./characterAffection.js";
import { getResolvedItemDefinitions } from "./itemRoster.js";
import { flushAffectionRewardsInTransaction } from "./affectionRewards.js";
import { loadValidatedRollAffection } from "./affectionRollCapture.js";
import {
  affectionFeedback,
  appendCardNotice,
  WINDFALL_NOTICE,
  CONSERVATION_NOTICE,
} from "./affectionPresentation.js";
import { wasWindfallRoll } from "./affectionPerks.js";

const MYSTERY_IMAGE = fileURLToPath(
  new URL("../assets/mystery_roll.png", import.meta.url),
);
const JOHN_PORK_IMAGE = fileURLToPath(
  new URL("../assets/john_pork.gif", import.meta.url),
);
const HEART = "❤️";
const HEADER = "# ❓ A mystery character appears!";
const NO_MENTIONS = { parse: [], repliedUser: false };
const BUTTON_STYLES = {
  primary: ButtonStyle.Primary,
  secondary: ButtonStyle.Secondary,
  success: ButtonStyle.Success,
  danger: ButtonStyle.Danger,
};
// Components V2 caps a message's text at 4000 characters. Standings only ride
// inside the round card while there is room to spare.
const CARD_TEXT_LIMIT = 3_500;
const active = new WeakMap();
const starting = new WeakMap();

function sessions(db) {
  let found = active.get(db);
  if (!found) {
    found = new Map();
    active.set(db, found);
  }
  return found;
}

function introCard(remaining) {
  return {
    content: HEADER,
    embeds: [
      new EmbedBuilder()
        .setTitle("??????")
        .setImage("attachment://mystery_roll.png")
        .addFields(
          { name: "Rank", value: "???", inline: true },
          { name: "Anime", value: "-" },
        )
        .setFooter({
          text: `${remaining} roll${remaining === 1 ? "" : "s"} left`,
        }),
    ],
    files: [new AttachmentBuilder(MYSTERY_IMAGE, { name: "mystery_roll.png" })],
    allowedMentions: NO_MENTIONS,
  };
}

function winnerStatus(runtime) {
  return `Winner only · ${runtime.gameConfig.windows.claimMs / 1000} seconds`;
}

async function prizeCard(runtime, status) {
  const { character, imagePicker, reservation } = runtime;
  let imageUrl = character.image_url;
  if (imagePicker) {
    try {
      imageUrl =
        (
          await imagePicker.pick(
            runtime.guildId,
            character.id,
            character.tag_name,
            character.image_url,
          )
        )?.url || imageUrl;
    } catch (error) {
      console.error("Mystery prize image lookup failed:", error);
    }
  }
  const embed = new EmbedBuilder()
    .setTitle(character.name_full)
    .addFields({
      name: "Rank",
      value: `#${formatNumber(character.rank)}`,
      inline: true,
    })
    .setFooter({
      text: `${reservation.remaining} roll${reservation.remaining === 1 ? "" : "s"} left · ${status}`,
    });
  const franchises = characterMainFranchises(
    withCharacterMainFranchises(runtime.db, character),
    180,
    escapeMarkdown,
  );
  if (franchises) embed.setDescription(franchises.text);
  if (imageUrl) embed.setImage(imageUrl);
  const components = status.startsWith("Winner only · ")
    ? [
        new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId(`mystery:${runtime.sessionId}:decline`)
            .setLabel("i dont wanna")
            .setStyle(ButtonStyle.Secondary),
        ),
      ]
    : [];
  const session = getMysterySession(runtime.db, runtime.sessionId);
  const validated = loadValidatedRollAffection(
    runtime.db,
    session.originRollId,
  );
  const saved = JSON.parse(session.stateJson).runtime;
  const compensated = saved?.consolation?.status === "activated";
  const captured = Boolean(validated);
  const nonce =
    compensated || captured
      ? createHash("sha256")
          .update(
            `character-reveal:${runtime.sessionId}:${saved.prizeMessageId ?? ""}`,
          )
          .digest("hex")
          .slice(0, 24)
      : null;
  if (captured) persistRuntime(runtime, { affectionRevealPending: true });
  const message = await runtime.channel.send({
    embeds: [embed],
    components,
    allowedMentions: NO_MENTIONS,
    ...(nonce ? { nonce, enforceNonce: true } : {}),
  });
  if (captured) {
    const earned = acknowledgeAffectionReveal(runtime, message.id);
    const feedback = affectionFeedback(earned?.awards ?? [], character.id);
    if (feedback) {
      embed.addFields({ name: "Affection", value: feedback });
      await message.edit?.({ embeds: [embed] }).catch(() => {});
    }
  }
  return message;
}

function acknowledgeAffectionReveal(runtime, messageId) {
  const session = getMysterySession(runtime.db, runtime.sessionId);
  const validated = loadValidatedRollAffection(
    runtime.db,
    session.originRollId,
  );
  if (!validated) return { awards: [] };
  return transaction(runtime.db, () => {
    // Recheck the complete cross-record binding at the earning seam too.
    loadValidatedRollAffection(runtime.db, session.originRollId);
    const result = completeAppearanceInTransaction(runtime.db, {
      sourceKey: validated.sourceKey,
      now: runtime.now(),
      rewardRoster: getResolvedItemDefinitions(runtime.db, runtime.guildId),
    });
    flushAffectionRewardsInTransaction(runtime.db, {
      guildId: runtime.guildId,
      userId: session.rollerId,
      now: runtime.now(),
    });
    persistRuntime(runtime, {
      affectionRevealPending: false,
      affectionRevealAcknowledged: true,
      prizeMessageId: messageId,
    });
    return result;
  });
}

function controls(sessionId, view) {
  if (!view?.buttons?.length) return [];
  const row =
    /** @type {ActionRowBuilder<import('discord.js').MessageActionRowComponentBuilder>} */ (
      new ActionRowBuilder()
    );
  for (const button of view.buttons) {
    const customId =
      view.round == null
        ? `mystery:${sessionId}:door:${button.value}`
        : `mystery:${sessionId}:choice:${view.round}:${button.value}`;
    const component = new ButtonBuilder()
      .setCustomId(customId)
      .setLabel(button.label)
      .setStyle(BUTTON_STYLES[button.style] ?? ButtonStyle.Primary);
    if (button.emoji) component.setEmoji(button.emoji);
    row.addComponents(component);
  }
  return [row];
}

function cardStatus(card) {
  const parts = [...(card.stats ?? [])];
  if (card.deadline)
    parts.push(`Closes <t:${Math.ceil(card.deadline / 1000)}:R>`);
  return parts.length ? `-# ${parts.join(" · ")}` : null;
}

/** Instructions, participants, and standings belong to the opening card only. */
function isOpeningRound(view) {
  return view.round === 1 || view.publicChoices === true;
}

function roundCardText(view, inline) {
  const heading = `## ${view.card.title} · ${view.card.heading}`;
  if (!isOpeningRound(view)) return heading;
  return [
    heading,
    ...(view.card.rules ?? []),
    cardStatus(view.card),
    ...(inline ? (view.lines ?? []) : []),
  ]
    .filter(Boolean)
    .join("\n");
}

/** @param {string} sessionId @param {any} view */
function roundCard(sessionId, view, { inline = false, closed = false } = {}) {
  const card = view.card;
  const container = new ContainerBuilder()
    .setAccentColor(card.accent ?? 0x5865f2)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`## ${card.title} · ${card.heading}`),
    );
  if (isOpeningRound(view)) {
    if (card.rules?.length) {
      container.addTextDisplayComponents(
        new TextDisplayBuilder().setContent(card.rules.join("\n")),
      );
    }
    const status = cardStatus(card);
    if (status)
      container.addTextDisplayComponents(
        new TextDisplayBuilder().setContent(status),
      );
    if (inline && view.lines?.length) {
      container
        .addSeparatorComponents(new SeparatorBuilder())
        .addTextDisplayComponents(
          new TextDisplayBuilder().setContent(view.lines.join("\n")),
        );
    }
  }
  if (closed) {
    container
      .addSeparatorComponents(new SeparatorBuilder())
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
          "-# Round closed · choices are locked",
        ),
      );
  } else if (view.buttons?.length) {
    container.addActionRowComponents(...controls(sessionId, view));
  }
  return {
    flags: MessageFlags.IsComponentsV2,
    components: [container],
    allowedMentions: NO_MENTIONS,
  };
}

export async function updateMysteryPrizeStatus(card, status) {
  if (card.embeds?.[0]) {
    const embed = new EmbedBuilder(card.embeds[0].toJSON()).setFooter({
      text: status,
    });
    if (status === "Claimed") embed.setColor(0x8b4513);
    return card.edit({
      embeds: [embed],
      components: [],
      allowedMentions: NO_MENTIONS,
    });
  }
  const data = card.components[0].toJSON();
  if (status === "Claimed") data.accent_color = 0x8b4513;
  data.components = data.components.filter((component) => component.type !== 1);
  const footer = data.components
    .filter((component) => component.type === 10)
    .at(-1);
  footer.content = `-# ${status}`;
  return card.edit({
    components: [new ContainerBuilder(data)],
    allowedMentions: NO_MENTIONS,
  });
}

/** @param {any} runtime @param {{hidden?: boolean, selected?: number | null, winningDoor?: number | null}} options */
async function doorsCard(
  runtime,
  { hidden = false, selected = null, winningDoor = null } = {},
) {
  if (!hidden) {
    const session = getMysterySession(runtime.db, runtime.sessionId);
    loadValidatedRollAffection(runtime.db, session.originRollId);
  }
  const won = selected !== null && selected === winningDoor;
  let image = runtime.character.image_url;
  if (!hidden && runtime.imagePicker) {
    try {
      image =
        (
          await runtime.imagePicker.pick(
            runtime.guildId,
            runtime.character.id,
            runtime.character.tag_name,
            image,
          )
        )?.url || image;
    } catch (error) {
      console.error("Doors image lookup failed:", error);
    }
  }
  const title = hidden
    ? "Choose Left or Right"
    : selected === null
      ? "No choice made"
      : won
        ? runtime.character.name_full
        : "John Pork";
  const franchises =
    !hidden && won
      ? characterMainFranchises(
          withCharacterMainFranchises(runtime.db, runtime.character),
          180,
          escapeMarkdown,
        )
      : null;
  const rank =
    !hidden && won ? `#${formatNumber(runtime.character.rank)}` : "?";
  const container = new ContainerBuilder()
    .setAccentColor(0xe91e63)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`# ${escapeMarkdown(title)}`),
      ...(franchises
        ? [new TextDisplayBuilder().setContent(franchises.text)]
        : []),
      new TextDisplayBuilder().setContent(`**Rank:** ${rank}`),
    );
  const urls = hidden
    ? ["attachment://mystery_roll.png", "attachment://mystery_roll.png"]
    : [1, 2].map((slot) =>
        slot === winningDoor
          ? image || "attachment://mystery_roll.png"
          : "attachment://john_pork.gif",
      );
  container.addMediaGalleryComponents(
    new MediaGalleryBuilder().addItems(
      ...urls.map((url, index) =>
        new MediaGalleryItemBuilder()
          .setURL(url)
          .setDescription(`${index === 0 ? "Left" : "Right"} character`),
      ),
    ),
  );
  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(
      `-# ${runtime.reservation.remaining} rolls left · ${hidden ? "Only the roller may choose" : won ? winnerStatus(runtime) : "Unclaimable"}`,
    ),
  );
  if (hidden)
    container.addActionRowComponents(
      ...controls(runtime.sessionId, {
        buttons: [
          { value: "1", label: "Left" },
          { value: "2", label: "Right" },
        ],
      }),
    );
  else if (won)
    container.addActionRowComponents((row) =>
      row.addComponents(
        new ButtonBuilder()
          .setCustomId(`mystery:${runtime.sessionId}:decline`)
          .setLabel("i dont wanna")
          .setStyle(ButtonStyle.Secondary),
      ),
    );
  const files =
    hidden || !image
      ? [new AttachmentBuilder(MYSTERY_IMAGE, { name: "mystery_roll.png" })]
      : [];
  if (!hidden)
    files.push(
      new AttachmentBuilder(JOHN_PORK_IMAGE, { name: "john_pork.gif" }),
    );
  const message = await runtime.channel.send({
    flags: MessageFlags.IsComponentsV2,
    components: [container],
    files,
    allowedMentions: NO_MENTIONS,
  });
  if (!hidden) acknowledgeAffectionReveal(runtime, message.id);
  return message;
}

function arm(runtime, at, action) {
  if (runtime.timer) runtime.clearTimer(runtime.timer);
  const version = ++runtime.timerVersion;
  const delay = Math.max(0, at - runtime.now());
  runtime.timer = runtime.setTimer(() => {
    runtime.timer = null;
    // A fired timer can still be queued behind a Discord edit when a new phase replaces it.
    return queue(runtime, () =>
      version === runtime.timerVersion ? action() : undefined,
    ).catch((error) => failRuntime(runtime, error));
  }, delay);
  runtime.timer?.unref?.();
}

function queue(runtime, action) {
  const next = runtime.queue.then(() =>
    runtime.disposed ? undefined : action(),
  );
  runtime.queue = next.catch(() => {});
  return next;
}

function dispose(runtime) {
  if (runtime.disposed) return;
  runtime.disposed = true;
  if (runtime.timer) runtime.clearTimer(runtime.timer);
  sessions(runtime.db).delete(runtime.sessionId);
}

function failRuntime(runtime, error) {
  console.error("Mystery event delivery failed:", error);
  // Delivery failures must not resolve a paid session. Recovery can retry it.
  dispose(runtime);
}

function persistRuntime(runtime, patch) {
  const session = getMysterySession(runtime.db, runtime.sessionId);
  if (!session) return;
  const state = JSON.parse(session.stateJson);
  state.runtime = { ...state.runtime, version: 1, ...patch };
  runtime.db
    .prepare(
      "UPDATE mystery_sessions SET state_json = ? WHERE id = ? AND state_json IS ?",
    )
    .run(JSON.stringify(state), session.id, session.stateJson);
}

async function postLines(runtime, lines) {
  let content = "";
  for (const raw of lines.flatMap((line) => line.split("\n"))) {
    const line = raw.length > 2000 ? raw.slice(0, 2000) : raw;
    if (content && content.length + line.length + 1 > 2000) {
      await runtime.channel.send({ content, allowedMentions: NO_MENTIONS });
      content = "";
    }
    content += `${content ? "\n" : ""}${line}`;
  }
  if (content)
    await runtime.channel.send({ content, allowedMentions: NO_MENTIONS });
}

// Cosmetic edits never hold the authoritative work queue. Keep only the latest
// waiting snapshot, ordered after the in-flight edit, so results/closed cards
// supersede participant updates and cannot be overwritten by an older snapshot.
const roundEdits = new WeakMap();
/** @param {any} message @param {any} payload @param {(() => Promise<void>) | null} [after] */
function editRoundCard(message, payload, after = null) {
  let edits = roundEdits.get(message);
  if (!edits) {
    edits = { running: false, pending: null };
    roundEdits.set(message, edits);
  }
  edits.pending = { payload, after, attempts: 0 };
  if (edits.running) return;
  edits.running = true;
  void (async () => {
    try {
      while (edits.pending) {
        const next = edits.pending;
        edits.pending = null;
        try {
          await message.edit(next.payload);
          if (next.after && !edits.pending) await next.after();
        } catch (error) {
          console.error("Mystery round card edit failed:", error);
          // Retry transient failures without holding up entries/timers. A newer
          // snapshot always wins over a failed participant list or result.
          if (!edits.pending && next.attempts++ < 3) {
            edits.pending = next;
            await new Promise((resolve) => {
              const timer = setTimeout(resolve, 250 * 2 ** (next.attempts - 1));
              timer.unref?.();
            });
          }
        }
      }
    } finally {
      edits.running = false;
    }
  })();
}

async function closeRoundCard(runtime) {
  if (!runtime.eventMessage || !runtime.eventView) return;
  const view = runtime.eventView;
  if (view.phase !== "choice") {
    runtime.eventMessage = null;
    runtime.eventView = null;
    runtime.eventInline = false;
    return;
  }
  editRoundCard(
    runtime.eventMessage,
    roundCard(runtime.sessionId, view, {
      inline: runtime.eventInline,
      closed: true,
    }),
  );
  runtime.eventMessage = null;
  runtime.eventView = null;
  runtime.eventInline = false;
}

async function showRoundCard(runtime, view) {
  // Standings ride inside the opening card until a lobby is too large for one message.
  const inline =
    isOpeningRound(view) && roundCardText(view, true).length <= CARD_TEXT_LIMIT;
  if (runtime.eventRound === view.round && runtime.eventMessage) {
    const overflow =
      view.publicChoices && !inline
        ? () => postLines(runtime, view.lines ?? [])
        : null;
    const payload = roundCard(runtime.sessionId, view, { inline });
    const previous =
      runtime.eventView &&
      roundCard(runtime.sessionId, runtime.eventView, {
        inline: runtime.eventInline,
      });
    if (
      JSON.stringify(payload) !== JSON.stringify(previous) ||
      (overflow &&
        JSON.stringify(view.lines) !== JSON.stringify(runtime.eventView?.lines))
    ) {
      editRoundCard(runtime.eventMessage, payload, overflow);
    }
    runtime.eventView = view;
    runtime.eventInline = inline;
    return;
  }
  await closeRoundCard(runtime);
  if (isOpeningRound(view) && !inline)
    await postLines(runtime, view.lines ?? []);
  runtime.eventRound = view.round;
  runtime.eventView = view;
  runtime.eventInline = inline;
  runtime.eventMessage = await runtime.channel.send(
    roundCard(runtime.sessionId, view, { inline }),
  );
}

async function showView(runtime, view) {
  await deliverView(runtime, view);
  persistRuntime(runtime, {
    view,
    eventMessageId: runtime.eventMessage?.id ?? null,
    eventRound: runtime.eventRound ?? null,
    eventInline: runtime.eventInline,
  });
}

async function deliverView(runtime, view) {
  if (
    getMysterySession(runtime.db, runtime.sessionId)?.eventId ===
      "glass_bridge" &&
    view.phase !== "choice"
  ) {
    const text = [view.text, ...(view.lines ?? [])].join("\n");
    const inline = text.length <= CARD_TEXT_LIMIT;
    const container = new ContainerBuilder()
      .setAccentColor(0x3498db)
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent(inline ? text : view.text),
      );
    const payload = {
      flags: MessageFlags.IsComponentsV2,
      components: [container],
      allowedMentions: NO_MENTIONS,
    };
    if (runtime.eventMessage && view.phase === "result") {
      editRoundCard(
        runtime.eventMessage,
        payload,
        inline ? null : () => postLines(runtime, view.lines ?? []),
      );
    } else {
      runtime.eventMessage = await runtime.channel.send(payload);
      if (!inline) await postLines(runtime, view.lines ?? []);
    }
    runtime.eventView = view;
    runtime.eventRound = view.round;
    return;
  }
  if (getMysterySession(runtime.db, runtime.sessionId)?.eventId === "doors") {
    runtime.eventMessage = await doorsCard(runtime, { hidden: true });
    return;
  }
  if (view.round == null) {
    runtime.eventMessage = await runtime.channel.send({
      content: view.text,
      components: controls(runtime.sessionId, view),
      allowedMentions: NO_MENTIONS,
    });
    return;
  }
  if (view.phase === "choice" && view.card) {
    await showRoundCard(runtime, view);
    return;
  }
  // Results and oversized standings stay plain messages so a large lobby can be
  // chunked under Discord's content limit instead of being truncated.
  await closeRoundCard(runtime);
  await postLines(
    runtime,
    view.phase === "choice"
      ? (view.lines ?? [])
      : [view.text, ...(view.lines ?? [])],
  );
  runtime.eventRound = view.round;
  if (view.phase === "choice") {
    runtime.eventMessage = await runtime.channel.send({
      content: view.text,
      components: controls(runtime.sessionId, view),
      allowedMentions: NO_MENTIONS,
    });
  }
}

async function revealUnclaimable(runtime, reason, answer = null) {
  const session = getMysterySession(runtime.db, runtime.sessionId);
  if (!session || !["completed", "failed"].includes(session.state)) return;
  if (loadValidatedRollAffection(runtime.db, session.originRollId))
    persistRuntime(runtime, { affectionRevealPending: true });
  const answerLine = answer ? `\nAnime answer: **${answer}**` : "";
  await runtime.channel.send({
    content: `${reason}${answerLine}\nThe character is revealed below.`,
    components: [],
    allowedMentions: NO_MENTIONS,
  });
  await prizeCard(runtime, "Unclaimable");
  dispose(runtime);
}

/**
 * Delivers the Binoculars answer to the roller in DMs. The answer must never
 * reach the channel: for clue_reveal every member of the channel can answer
 * with it and take the character from the roller. The charge is only spent
 * once the answer is delivered privately.
 */
async function revealAnswer(runtime, reveal) {
  const session = getMysterySession(runtime.db, runtime.sessionId);
  if (!session) return false;
  const reservation = reserveBinocularsUse(runtime.db, {
    guildId: session.guildId,
    userId: session.rollerId,
    channelId: runtime.channel.id,
    inventoryId: reveal.inventoryId,
    sessionId: session.id,
    now: runtime.now(),
    random: runtime.random,
  });
  if (!reservation) return false;
  const content = `🔭 **Binoculars** reveals the answer: **${reveal.answer}**`;
  const user = await runtime.client?.users
    ?.fetch(session.rollerId)
    .catch(() => null);
  const sent = user?.send
    ? await user
        .send({ content, allowedMentions: NO_MENTIONS })
        .catch(() => null)
    : null;
  settleBinocularsUse(runtime.db, reservation, Boolean(sent));
  if (sent) {
    const payment = JSON.parse(
      runtime.db
        .prepare(
          `SELECT result_json FROM ${currentSeasonRows(runtime.db, "item_actions")} WHERE id=?`,
        )
        .get(reservation).result_json,
    );
    return { conserved: Boolean(payment.conserved) };
  }
  await runtime.channel
    .send({
      content:
        `<@${session.rollerId}> 🔭 **Binoculars** could not reach you in DMs. ` +
        "The answer stays hidden and the charge was not spent.",
      allowedMentions: {
        users: [session.rollerId],
        roles: [],
        repliedUser: false,
      },
    })
    .catch(() => {});
  return false;
}

async function offerBinoculars(runtime, rollerId) {
  // Save consent state before sending so interrupted publication can be retried.
  runtime.binocularsUsed = false;
  persistRuntime(runtime, { binocularsUsed: false, binocularsMessageId: null });
  runtime.binocularsMessage = await runtime.channel.send({
    content: `<@${rollerId}> — optionally use one Binoculars charge to receive the answer in DMs. Ignore this button to keep your item.`,
    components: [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`mystery:${runtime.sessionId}:binoculars`)
          .setLabel("Use Binoculars")
          .setEmoji("🔭")
          .setStyle(ButtonStyle.Secondary),
      ),
    ],
    allowedMentions: NO_MENTIONS,
  });
  persistRuntime(runtime, {
    binocularsMessageId: runtime.binocularsMessage.id,
  });
}

async function begin(runtime) {
  const result = beginMysteryEvent(
    runtime.db,
    runtime.sessionId,
    runtime.now(),
    runtime.random,
  );
  if (result.status === "early") {
    arm(runtime, result.nextAt, () => begin(runtime));
  } else if (result.status === "started") {
    await showView(runtime, result.view);
    if (revealWithBinoculars(runtime.db, result.session, runtime.now())) {
      await offerBinoculars(runtime, result.session.rollerId);
    }
    arm(runtime, result.session.nextAt, () =>
      advance(runtime, { type: "timer" }),
    );
  } else if (result.status === "no_winner" || result.status === "unavailable") {
    await revealUnclaimable(runtime, "The event ended without a winner.");
  } else if (result.status === "stale") {
    dispose(runtime);
  }
}

async function countdown(runtime) {
  const session = getMysterySession(runtime.db, runtime.sessionId);
  if (session?.state !== "countdown") {
    dispose(runtime);
    return;
  }
  const remaining = Math.ceil((session.nextAt - runtime.now()) / 1000);
  if (remaining <= 0) {
    await revealWinner(runtime);
    return;
  }
  const first = !runtime.countdownAnnounced;
  const compensated =
    inspectMysteryConsolation(runtime.db, session)?.status === "activated";
  runtime.countdownAnnounced = true;
  await runtime.channel.send({
    content: first
      ? `<@${session.winnerId}> won! Revealing in **${remaining}...**`
      : `**${remaining}...**`,
    components: [],
    allowedMentions:
      first && !compensated
        ? { users: [session.winnerId], roles: [], repliedUser: false }
        : NO_MENTIONS,
  });
  arm(runtime, session.nextAt - (remaining - 1) * 1000, () =>
    countdown(runtime),
  );
}

async function revealWinner(runtime, { recoverRewards = true } = {}) {
  const session = getMysterySession(runtime.db, runtime.sessionId);
  if (!session) {
    dispose(runtime);
    return;
  }
  const decision = inspectMysteryConsolation(runtime.db, session);
  if (session.state !== "countdown" && decision?.status !== "activated") {
    dispose(runtime);
    return;
  }
  if (session.state === "countdown" && runtime.now() < session.nextAt) {
    arm(runtime, session.nextAt, () => revealWinner(runtime));
    return;
  }
  await runtime.channel.send({
    content: "The character is revealed below.",
    components: [],
    allowedMentions: NO_MENTIONS,
  });
  const compensated =
    inspectMysteryConsolation(runtime.db, session)?.status === "activated";
  const card =
    runtime.prize ??
    (await prizeCard(
      runtime,
      compensated ? "Unclaimable" : winnerStatus(runtime),
    ));
  runtime.prize = card;
  persistRuntime(runtime, {
    prizeMessageId: card.id,
    ...(compensated ? { consolationRevealAcknowledged: true } : {}),
  });
  if (session.state !== "countdown") {
    if (recoverRewards)
      await recoverVaultRewards(runtime.db, runtime.client, {
        now: runtime.now,
      });
    dispose(runtime);
  } else await openWinnerClaim(runtime, card);
}

async function openWinnerClaim(runtime, card) {
  const session = getMysterySession(runtime.db, runtime.sessionId);
  if (session?.state !== "countdown") {
    dispose(runtime);
    return;
  }
  const opened = openMysteryClaim(runtime.db, {
    sessionId: runtime.sessionId,
    messageId: card.id,
    now: runtime.now(),
  });
  if (opened.status === "early") {
    arm(runtime, session.nextAt, () => openWinnerClaim(runtime, card));
    return;
  }
  if (opened.status !== "open") {
    if (opened.reason === "consolation") {
      await recoverVaultRewards(runtime.db, runtime.client, {
        now: runtime.now,
      });
    }
    await updateMysteryPrizeStatus(
      card,
      `${runtime.reservation.remaining} rolls left · Unclaimable`,
    ).catch((error) => console.error("Mystery card update failed:", error));
    dispose(runtime);
    return;
  }
  persistRuntime(runtime, {
    phase: "claim_open",
    prizeMessageId: card.id,
    claimExpiresAt: opened.expiresAt,
  });
  try {
    await card.react(HEART);
  } catch (error) {
    dispose(runtime);
    throw error;
  }
  arm(runtime, opened.expiresAt, () => closeClaim(runtime));
}

async function closeClaim(runtime) {
  const session = getMysterySession(runtime.db, runtime.sessionId);
  if (session?.state !== "claim_open") {
    dispose(runtime);
    return;
  }
  if (runtime.now() < session.nextAt) {
    arm(runtime, session.nextAt, () => closeClaim(runtime));
    return;
  }
  if (
    !endMysterySession(runtime.db, {
      sessionId: runtime.sessionId,
      outcome: "expired",
      now: runtime.now(),
    })
  ) {
    dispose(runtime);
    return;
  }
  if (runtime.prize) {
    await updateMysteryPrizeStatus(
      runtime.prize,
      `${runtime.reservation.remaining} rolls left · Unclaimable`,
    ).catch((error) =>
      console.error("Mystery claim close edit failed:", error),
    );
  }
  dispose(runtime);
}

/** @param {any} runtime @param {any} input @param {((result: any) => void) | null} [onDecision] */
async function advance(runtime, input, onDecision = null) {
  // Answers queued before a win must not dispose the newer countdown or claim phase.
  const current = getMysterySession(runtime.db, runtime.sessionId);
  if (current && ["countdown", "claim_open"].includes(current.state))
    return { status: "stale" };
  const result = advanceMysteryEvent(runtime.db, {
    sessionId: runtime.sessionId,
    guildId: runtime.guildId,
    channelId: runtime.channel.id,
    input,
    now: runtime.now(),
    random: runtime.random,
  });
  // The coordinator has committed the decision. Private feedback must not wait
  // for public presentation; the caller owns and handles the reply promise.
  onDecision?.(result);
  if (
    current?.eventId === "doors" &&
    ["winner", "doors_lost"].includes(result.status)
  ) {
    const compensated =
      inspectMysteryConsolation(runtime.db, result.session)?.status ===
      "activated";
    await runtime.channel.send({
      content: `<@${current.rollerId}> has chosen **${input.value === "1" ? "Left" : "Right"}**, and the character is... :question:`,
      allowedMentions: compensated
        ? NO_MENTIONS
        : { users: [current.rollerId], roles: [], repliedUser: false },
    });
    arm(runtime, result.session.nextAt, () => resumeCountdown(runtime));
    return result;
  }
  if (current?.eventId === "doors" && result.status === "no_winner") {
    const state = JSON.parse(current.stateJson);
    await doorsCard(runtime, {
      winningDoor: state.winningDoor,
      selected: input.type === "button" ? Number(input.value) : null,
    });
    dispose(runtime);
    return result;
  }
  for (const view of result.views ?? []) await showView(runtime, view);
  if (result.status === "ongoing") {
    if (result.view) await showView(runtime, result.view);
    arm(runtime, result.session.nextAt, () =>
      advance(runtime, { type: "timer" }),
    );
  } else if (result.status === "winner") {
    if (result.view) await showView(runtime, result.view);
    await countdown(runtime);
  } else if (result.status === "no_winner") {
    if (result.view) await showView(runtime, result.view);
    await revealUnclaimable(
      runtime,
      "The event ended without a winner.",
      result.answer,
    );
  } else if (result.status === "stale") {
    dispose(runtime);
  }
  return result;
}

export async function startMysteryRoll(options) {
  const { db, reservation } = options;
  let pending = starting.get(db);
  if (!pending) {
    pending = new Map();
    starting.set(db, pending);
  }
  if (pending.has(reservation.sessionId))
    return pending.get(reservation.sessionId);
  const work = startReservedMystery(options);
  pending.set(reservation.sessionId, work);
  try {
    return await work;
  } finally {
    pending.delete(reservation.sessionId);
  }
}

async function startReservedMystery({
  db,
  client,
  message,
  reservation,
  imagePicker,
  now = Date.now,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  random = Math.random,
}) {
  const session = getMysterySession(db, reservation.sessionId);
  if (!session || session.state !== "reserved")
    throw new Error("Mystery reservation is unavailable");
  const channel =
    session.eventChannelId === message.channelId
      ? message.channel
      : await client.channels.fetch(session.eventChannelId);
  if (!channel?.send) throw new Error("Mystery event channel is unavailable");
  // Final-v12 terms were committed with payment. Preserve the legacy runtime
  // capture path without changing the legacy snapshot/conversion contract.
  if (db.prepare("PRAGMA user_version").get().user_version !== 12) {
    const state = JSON.parse(session.stateJson);
    db.prepare(
      "UPDATE mystery_sessions SET state_json = ? WHERE id = ? AND state_json IS ?",
    ).run(
      JSON.stringify({
        ...state,
        runtime: {
          version: 1,
          phase: "reserved",
          remaining: reservation.remaining,
        },
      }),
      session.id,
      session.stateJson,
    );
  }
  const introPayload = introCard(reservation.remaining);
  const origin = db
    .prepare(
      `SELECT command_message_id FROM ${currentSeasonRows(db, "character_rolls")} WHERE id=?`,
    )
    .get(session.originRollId);
  if (
    origin &&
    wasWindfallRoll(
      db,
      session.guildId,
      session.rollerId,
      origin.command_message_id,
    )
  )
    appendCardNotice(introPayload, WINDFALL_NOTICE);
  const intro = await channel.send({
    ...introPayload,
    nonce: createHash("sha256")
      .update(`mystery-intro:${session.guildId}:${session.id}`)
      .digest("hex")
      .slice(0, 24),
    enforceNonce: true,
  });
  if (!publishMysteryIntro(db, reservation.sessionId, intro.id, now())) {
    throw new Error("Mystery introduction could not be published");
  }
  const runtime = {
    db,
    client,
    channel,
    intro,
    imagePicker,
    reservation,
    gameConfig: getMysterySessionConfig(session),
    character: reservation.character,
    guildId: session.guildId,
    sessionId: session.id,
    now,
    setTimer,
    clearTimer,
    random,
    eventMessage: null,
    eventView: null,
    eventInline: false,
    countdownAnnounced: false,
    timer: null,
    timerVersion: 0,
    queue: Promise.resolve(),
    disposed: false,
    prize: null,
  };
  sessions(db).set(session.id, runtime);
  const published = getMysterySession(db, session.id);
  // Publication already committed the canonical intro and deadlines. Avoid a
  // second write that could leave a registered runtime without an armed timer.
  arm(runtime, published.nextAt, () => begin(runtime));
  return intro;
}

export async function onMysteryButton(db, interaction) {
  if (!interaction.isButton() || !interaction.customId.startsWith("mystery:"))
    return false;
  let response;
  const respond = (answer) => {
    response ??= interaction.editReply(answer);
    // Presentation may still be pending when an interaction reply fails.
    // Observe it immediately, then propagate it to the caller below.
    response.catch(() => {});
  };
  const binoculars = /^mystery:(\d+):binoculars$/.exec(interaction.customId);
  if (binoculars) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const runtime = sessions(db).get(Number(binoculars[1]));
    if (!runtime) {
      await interaction.editReply(
        "This mystery has expired. No charge was spent.",
      );
      return true;
    }
    const answer = await queue(runtime, async () => {
      const session = getMysterySession(db, runtime.sessionId);
      if (
        runtime.binocularsMessage?.id !== interaction.message.id ||
        runtime.guildId !== interaction.guildId ||
        runtime.channel.id !== interaction.channelId ||
        session?.state !== "running" ||
        runtime.now() >= session.nextAt ||
        runtime.now() >= session.deadlineAt ||
        runtime.binocularsUsed
      ) {
        return "Binoculars is no longer available for this mystery. No charge was spent.";
      }
      if (session.rollerId !== interaction.user.id)
        return "Only the roller can use Binoculars for this mystery.";
      const reveal = revealWithBinoculars(db, session, runtime.now());
      if (!reveal)
        return "You have no Binoculars available. No charge was spent.";
      const payment = await revealAnswer(runtime, reveal);
      if (!payment)
        return "Could not DM you. Enable DMs and try again; no charge was spent.";
      runtime.binocularsUsed = true;
      persistRuntime(runtime, { binocularsUsed: true });
      await runtime.binocularsMessage
        .edit({
          content:
            "🔭 Binoculars used. The answer was sent privately to the roller.",
          components: [],
          allowedMentions: NO_MENTIONS,
        })
        .catch(() => {});
      return `🔭 The answer was sent to your DMs. ${payment.conserved ? CONSERVATION_NOTICE : "One charge was spent."}`;
    }).catch((error) => {
      failRuntime(runtime, error);
      return "The mystery could not continue.";
    });
    await interaction.editReply(
      answer ?? "This mystery has expired. No charge was spent.",
    );
    return true;
  }
  const decline = /^mystery:(\d+):decline$/.exec(interaction.customId);
  if (decline) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const runtime = sessions(db).get(Number(decline[1]));
    if (
      !runtime ||
      runtime.prize?.id !== interaction.message.id ||
      runtime.guildId !== interaction.guildId ||
      runtime.channel.id !== interaction.channelId
    ) {
      await interaction.editReply("This prize is no longer available.");
      return true;
    }
    const answer = await queue(runtime, async () => {
      const session = getMysterySession(db, runtime.sessionId);
      if (session?.state !== "claim_open" || runtime.now() >= session.nextAt)
        return "This prize is no longer available.";
      if (session.winnerId !== interaction.user.id)
        return "Only the winner can decline this character.";
      endMysterySession(db, {
        sessionId: runtime.sessionId,
        outcome: "declined",
        now: runtime.now(),
      });
      dispose(runtime);
      await updateMysteryPrizeStatus(
        runtime.prize,
        `${runtime.reservation.remaining} rolls left · Declined`,
      );
      return "Character declined. Rolls are available again.";
    }).catch((error) => {
      failRuntime(runtime, error);
      return "The mystery could not continue.";
    });
    await interaction.editReply(answer ?? "This prize is no longer available.");
    return true;
  }
  const choice =
    /^mystery:(\d+):choice:([1-9]\d*):(stay|escape|left|right|[1-5])$/.exec(
      interaction.customId,
    );
  if (choice) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const runtime = sessions(db).get(Number(choice[1]));
    if (!runtime) {
      await interaction.editReply("This mystery choice has expired.");
      return true;
    }
    const answer = await queue(runtime, async () => {
      const current = getMysterySession(db, runtime.sessionId);
      if (
        runtime.eventMessage?.id !== interaction.message.id ||
        runtime.guildId !== interaction.guildId ||
        runtime.channel.id !== interaction.channelId ||
        current?.state !== "running" ||
        !["greed_chamber", "deadlock", "glass_bridge"].includes(current.eventId)
      )
        return "This mystery choice has expired.";
      await advance(
        runtime,
        {
          type: "button",
          round: Number(choice[2]),
          userId: interaction.user.id,
          value: choice[3],
        },
        (result) => {
          const feedback = result.feedback;
          if (feedback?.type !== "choice_saved") {
            respond(feedback?.message ?? "This mystery choice has expired.");
            return;
          }
          const seconds = Math.max(
            0,
            Math.ceil((feedback.deadlineAt - runtime.now()) / 1000),
          );
          respond(
            `✅ Round ${feedback.round} · Saved: ${feedback.choice} — you have ${seconds} more seconds to change it.`,
          );
        },
      );
    }).catch((error) => {
      failRuntime(runtime, error);
      return "The mystery could not continue.";
    });
    await (response ??
      interaction.editReply(answer ?? "This mystery choice has expired."));
    return true;
  }
  const match = /^mystery:(\d+):door:([12])$/.exec(interaction.customId);
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const runtime = match && sessions(db).get(Number(match[1]));
  if (
    !runtime ||
    runtime.eventMessage?.id !== interaction.message.id ||
    runtime.guildId !== interaction.guildId ||
    runtime.channel.id !== interaction.channelId
  ) {
    await interaction.editReply("This mystery choice has expired.");
    return true;
  }
  const answer = await queue(runtime, async () => {
    const current = getMysterySession(db, runtime.sessionId);
    if (current?.state !== "running" || current.eventId !== "doors")
      return "This mystery choice has expired.";
    if (current.rollerId !== interaction.user.id)
      return "Only the roller can choose a door.";
    await advance(
      runtime,
      { type: "button", userId: interaction.user.id, value: match[2] },
      (result) => {
        respond(
          ["winner", "doors_lost"].includes(result.status)
            ? "Choice locked in. The character will be revealed shortly."
            : "This mystery choice has expired.",
        );
      },
    );
  }).catch((error) => {
    failRuntime(runtime, error);
    return "The mystery could not continue.";
  });
  await (response ??
    interaction.editReply(answer ?? "This mystery choice has expired."));
  return true;
}

export async function onMysteryAnswer(db, message) {
  if (
    !message.guildId ||
    !message.channelId ||
    message.author?.bot ||
    !message.content?.trim()
  )
    return false;
  const sessionId = activeMysteryInGuild(db, message.guildId);
  const runtime = sessionId && sessions(db).get(sessionId);
  if (!runtime || runtime.channel.id !== message.channelId) return false;
  const session = getMysterySession(db, sessionId);
  if (
    session?.state !== "running" ||
    !["treasure_hunt", "clue_reveal"].includes(session.eventId)
  )
    return false;
  await queue(runtime, () =>
    advance(runtime, {
      type: "answer",
      userId: message.author.id,
      value: message.content.trim(),
    }),
  ).catch((error) => failRuntime(runtime, error));
  return true;
}

async function resumeCountdown(runtime) {
  const session = getMysterySession(runtime.db, runtime.sessionId);
  if (session?.state !== "countdown") return dispose(runtime);
  const saved = JSON.parse(session.stateJson).runtime;
  if (runtime.now() < session.nextAt)
    return arm(runtime, session.nextAt, () => resumeCountdown(runtime));
  if (saved?.resolved?.type !== "no_winner") {
    if (
      session.eventId !== "doors" ||
      saved.consolation?.status === "activated"
    )
      return revealWinner(runtime);
    if (saved?.resolved?.type !== "winner") return dispose(runtime);
    const card =
      runtime.prize ?? (await prizeCard(runtime, winnerStatus(runtime)));
    runtime.prize = card;
    persistRuntime(runtime, { prizeMessageId: card.id });
    return openWinnerClaim(runtime, card);
  }
  const revealAt =
    saved.lossRevealAt ??
    session.nextAt + (runtime.gameConfig.mystery.wrongChoiceDelayMs ?? 2000);
  if (saved.phase !== "loss_reveal") {
    persistRuntime(runtime, { phase: "loss_reveal", lossRevealAt: revealAt });
    await runtime.channel.send({
      embeds: [
        new EmbedBuilder()
          .setTitle("John Pork")
          .addFields({ name: "Rank", value: "?", inline: true })
          .setImage("attachment://john_pork.gif")
          .setFooter({ text: "Unclaimable" }),
      ],
      files: [
        new AttachmentBuilder(JOHN_PORK_IMAGE, { name: "john_pork.gif" }),
      ],
      allowedMentions: NO_MENTIONS,
    });
  }
  if (runtime.now() < revealAt)
    return arm(runtime, revealAt, () => resumeCountdown(runtime));
  await prizeCard(runtime, "Unclaimable");
  endMysterySession(runtime.db, {
    sessionId: runtime.sessionId,
    outcome: "no_winner",
    now: runtime.now(),
  });
  dispose(runtime);
}

/** Read-only input for the whole-bot guard. No ambiguous paid row is resolved. */
export function inspectMysteryRuntime(db) {
  const recoverable = [],
    blockers = [];
  for (const { id } of db
    .prepare(
      `SELECT id FROM ${currentSeasonRows(db, "mystery_sessions")}
    WHERE state IN ('reserved','running','countdown','claim_open') OR state_json LIKE '%"consolation"%'
      OR state_json LIKE '%"affectionRevealPending":true%'`,
    )
    .all()) {
    const session = getMysterySession(db, id);
    try {
      const state = JSON.parse(session.stateJson);
      const consolation = inspectMysteryConsolation(db, session);
      const active = [
        "reserved",
        "running",
        "countdown",
        "claim_open",
      ].includes(session.state);
      const pendingAffectionReveal =
        state?.runtime?.affectionRevealPending === true;
      if (
        !active &&
        !pendingAffectionReveal &&
        (consolation?.status !== "activated" ||
          state.runtime.consolationRevealAcknowledged === true)
      )
        continue;
      if (!state?.gameConfig) throw new Error("missing captured gameConfig");
      if (!selectedMysteryCharacter(db, session))
        throw new Error("missing character");
      if (state.runtime?.version !== 1)
        throw new Error(
          "missing versioned runtime terms/bindings; legacy Doors outcome is ambiguous",
        );
      if (
        !Number.isSafeInteger(state.runtime.remaining) ||
        state.runtime.remaining < 0
      )
        throw new Error("missing captured remaining rolls");
      // A committed reservation can precede channel fetch, send, or acknowledgement.
      // Only this exact pre-publication shape is retryable; partial bindings stay blocked.
      const unboundIntro =
        session.state === "reserved" &&
        session.nextAt === null &&
        session.eventMessageId === null &&
        state.runtime.phase === "reserved" &&
        session.winnerId === null &&
        session.resolvedAt === null &&
        session.outcome === null &&
        Number.isSafeInteger(session.startedAt) &&
        session.startedAt >= 0 &&
        Number.isSafeInteger(session.deadlineAt) &&
        session.deadlineAt > session.startedAt;
      if (active && session.nextAt == null && !unboundIntro)
        throw new Error("missing phase deadline");
      if (
        session.state === "reserved" &&
        !session.eventMessageId &&
        !unboundIntro
      )
        throw new Error("unbound intro publication");
      if (session.state === "running" && !state.runtime.view)
        throw new Error("missing event view");
      if (
        session.state === "countdown" &&
        !["winner", "no_winner"].includes(state.runtime.resolved?.type)
      )
        throw new Error("ambiguous countdown outcome");
      if (session.state === "claim_open") {
        const roll = db
          .prepare(
            `SELECT message_id, expires_at FROM ${currentSeasonRows(db, "character_rolls")} WHERE id=?`,
          )
          .get(session.originRollId);
        if (!roll?.message_id || roll.expires_at !== session.nextAt)
          throw new Error("invalid canonical claim binding");
      }
      recoverable.push(session);
    } catch (error) {
      blockers.push({ sessionId: id, reason: error.message });
    }
  }
  return { recoverable, blockers, safe: blockers.length === 0 };
}

export async function recoverMysteryRuntime({
  db,
  client,
  imagePicker,
  now = Date.now,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  random = Math.random,
  recoverRewards = true,
}) {
  const inspection = inspectMysteryRuntime(db),
    recovered = [],
    deferred = [];
  for (const session of inspection.recoverable) {
    if (sessions(db).has(session.id)) {
      recovered.push(session.id);
      continue;
    }
    let runtime;
    try {
      const state = JSON.parse(session.stateJson),
        saved = state.runtime;
      if (session.state === "reserved" && session.eventMessageId === null) {
        await startMysteryRoll({
          db,
          client,
          imagePicker,
          now,
          setTimer,
          clearTimer,
          random,
          message: { channelId: null },
          reservation: {
            sessionId: session.id,
            rollId: session.originRollId,
            remaining: saved.remaining,
            character: selectedMysteryCharacter(db, session),
          },
        });
        recovered.push(session.id);
        continue;
      }
      const channel = await client.channels.fetch(session.eventChannelId);
      if (!channel?.send) throw new Error("event channel unavailable");
      const fetchMessage = async (id) => {
        if (!id) return null;
        try {
          return await channel.messages.fetch(id);
        } catch (error) {
          if (Number(error.code) === 10008) return null;
          throw error;
        }
      };
      const eventMessage = await fetchMessage(saved.eventMessageId);
      // Missing legacy consent metadata is ambiguous: never recreate a possibly
      // spent offer. Only an explicitly unused, still-open offer is retryable.
      const unusedBinoculars =
        session.state === "running" &&
        saved.binocularsUsed === false &&
        now() < session.nextAt &&
        now() < session.deadlineAt;
      const binocularsMessage = unusedBinoculars
        ? await fetchMessage(saved.binocularsMessageId)
        : null;
      const roll = db
        .prepare(
          `SELECT message_id FROM ${currentSeasonRows(db, "character_rolls")} WHERE id=?`,
        )
        .get(session.originRollId);
      const prize = await fetchMessage(
        session.state === "claim_open"
          ? roll?.message_id
          : saved.prizeMessageId,
      );
      if (session.state === "claim_open" && !prize)
        throw new Error("canonical claim message deleted (10008)");
      runtime = {
        db,
        client,
        channel,
        imagePicker,
        guildId: session.guildId,
        sessionId: session.id,
        character: selectedMysteryCharacter(db, session),
        gameConfig: state.gameConfig,
        reservation: {
          remaining: saved.remaining,
          rollId: session.originRollId,
          sessionId: session.id,
        },
        now,
        setTimer,
        clearTimer,
        random,
        eventMessage,
        eventView: saved.view,
        eventRound: saved.eventRound,
        eventInline: saved.eventInline,
        prize,
        binocularsMessage,
        binocularsUsed: saved.binocularsUsed === true,
        countdownAnnounced: true,
        timer: null,
        timerVersion: 0,
        queue: Promise.resolve(),
        disposed: false,
      };
      sessions(db).set(session.id, runtime);
      await queue(runtime, async () => {
        if (session.state === "reserved")
          arm(runtime, session.nextAt, () => begin(runtime));
        else if (session.state === "running") {
          if (!eventMessage && now() < session.nextAt)
            await showView(runtime, saved.view);
          if (
            unusedBinoculars &&
            !binocularsMessage &&
            revealWithBinoculars(db, session, runtime.now())
          ) {
            await offerBinoculars(runtime, session.rollerId);
          }
          arm(runtime, session.nextAt, () =>
            advance(runtime, { type: "timer" }),
          );
        } else if (session.state === "countdown")
          arm(runtime, saved.lossRevealAt ?? session.nextAt, () =>
            resumeCountdown(runtime),
          );
        else if (
          saved.affectionRevealPending === true &&
          !["claim_open", "running", "reserved"].includes(session.state)
        ) {
          await prizeCard(runtime, "Unclaimable");
          dispose(runtime);
        } else if (saved.consolation?.status === "activated")
          await revealWinner(runtime, { recoverRewards });
        else if (now() >= session.nextAt) await closeClaim(runtime);
        else {
          await prize.react(HEART);
          arm(runtime, session.nextAt, () => closeClaim(runtime));
        }
      });
      recovered.push(session.id);
    } catch (error) {
      if (runtime) dispose(runtime);
      deferred.push({
        sessionId: session.id,
        code: error.code ?? null,
        reason: error.message,
      });
    }
  }
  return {
    ...inspection,
    recovered,
    deferred,
    safe: inspection.safe && deferred.length === 0,
  };
}

// Final-runtime shutdown only detaches timers; legacy startup keeps its
// cancellation contract. Administrative callers can explicitly override either.
/** @param {any} db @param {{cancelPaidSessions?: boolean}} [options] */
export function cancelMysteryRuntime(db, { cancelPaidSessions } = {}) {
  for (const runtime of sessions(db).values()) dispose(runtime);
  const legacy =
    Number(db.prepare("PRAGMA user_version").get().user_version) <= 10;
  return (cancelPaidSessions ?? legacy) ? cancelActiveMysteries(db) : 0;
}
