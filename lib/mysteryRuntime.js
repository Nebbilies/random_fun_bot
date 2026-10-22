import { fileURLToPath } from 'node:url';
import {
  ActionRowBuilder, AttachmentBuilder, ButtonBuilder, ButtonStyle, ContainerBuilder, EmbedBuilder, escapeMarkdown,
  MediaGalleryBuilder, MediaGalleryItemBuilder, MessageFlags, TextDisplayBuilder,
} from 'discord.js';
import {
  cancelActiveMysteries, endMysterySession, getMysterySession, openMysteryClaim,
  publishMysteryIntro,
} from './characterRolls.js';
import { activeMysteryInGuild, advanceMysteryEvent, beginMysteryEvent } from './mysteryCoordinator.js';
import { decrementItemCharge } from './itemStorage.js';
import { formatNumber } from './formatNumber.js';

const MYSTERY_IMAGE = fileURLToPath(new URL('../assets/mystery_roll.png', import.meta.url));
const JOHN_PORK_IMAGE = fileURLToPath(new URL('../assets/john_pork.gif', import.meta.url));
const HEART = '❤️';
const HEADER = '# ❓ A mystery character appears!';
const NO_MENTIONS = { parse: [], repliedUser: false };
const active = new WeakMap();

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
    embeds: [new EmbedBuilder().setTitle('??????').setImage('attachment://mystery_roll.png')
      .addFields(
        { name: 'Rank', value: '???', inline: true },
        { name: 'Likes', value: '????', inline: true },
        { name: 'Anime', value: '-' },
      ).setFooter({ text: `${remaining} roll${remaining === 1 ? '' : 's'} left` })],
    files: [new AttachmentBuilder(MYSTERY_IMAGE, { name: 'mystery_roll.png' })],
    allowedMentions: NO_MENTIONS,
  };
}

function firstAnime(titles) {
  try {
    const names = JSON.parse(titles || '[]');
    return Array.isArray(names) ? names.find((name) => typeof name === 'string' && name.trim()) || '-'
      : '-';
  } catch {
    return '-';
  }
}

async function prizeCard(runtime, status) {
  const { character, imagePicker, reservation } = runtime;
  let imageUrl = character.image_url;
  if (imagePicker) {
    try {
      imageUrl = (await imagePicker.pick(runtime.guildId, character.id, character.tag_name,
        character.image_url))?.url || imageUrl;
    } catch (error) {
      console.error('Mystery prize image lookup failed:', error);
    }
  }
  const embed = new EmbedBuilder().setTitle(character.name_full)
    .setDescription(firstAnime(character.anime_titles))
    .addFields(
      { name: 'Rank', value: `#${formatNumber(character.rank)}`, inline: true },
      { name: 'Likes', value: formatNumber(character.favourites), inline: true },
    ).setFooter({ text: `${reservation.remaining} roll${reservation.remaining === 1 ? '' : 's'} left · ${status}` });
  if (imageUrl) embed.setImage(imageUrl);
  const components = status === 'Winner only · 60 seconds' ? [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`mystery:${runtime.sessionId}:decline`)
      .setLabel('i dont wanna').setStyle(ButtonStyle.Secondary),
  )] : [];
  return runtime.channel.send({ embeds: [embed], components, allowedMentions: NO_MENTIONS });
}

function controls(sessionId, view) {
  if (!view?.buttons?.length) return [];
  const row = /** @type {ActionRowBuilder<import('discord.js').MessageActionRowComponentBuilder>} */ (new ActionRowBuilder());
  for (const button of view.buttons) {
    row.addComponents(new ButtonBuilder().setCustomId(`mystery:${sessionId}:door:${button.value}`)
      .setLabel(button.label).setStyle(ButtonStyle.Primary));
  }
  return [row];
}

export async function updateMysteryPrizeStatus(card, status) {
  if (card.embeds?.[0]) {
    const embed = new EmbedBuilder(card.embeds[0].toJSON()).setFooter({ text: status });
    if (status === 'Claimed') embed.setColor(0x8b4513);
    return card.edit({ embeds: [embed],
      components: [], allowedMentions: NO_MENTIONS });
  }
  const data = card.components[0].toJSON();
  if (status === 'Claimed') data.accent_color = 0x8b4513;
  data.components = data.components.filter((component) => component.type !== 1);
  const footer = data.components.filter((component) => component.type === 10).at(-1);
  footer.content = `-# ${status}`;
  return card.edit({ components: [new ContainerBuilder(data)], allowedMentions: NO_MENTIONS });
}

/** @param {any} runtime @param {{hidden?: boolean, selected?: number | null, winningDoor?: number | null}} options */
async function doorsCard(runtime, { hidden = false, selected = null, winningDoor = null } = {}) {
  const won = selected !== null && selected === winningDoor;
  let image = runtime.character.image_url;
  if (!hidden && runtime.imagePicker) {
    try {
      image = (await runtime.imagePicker.pick(runtime.guildId, runtime.character.id,
        runtime.character.tag_name, image))?.url || image;
    } catch (error) { console.error('Doors image lookup failed:', error); }
  }
  const title = hidden ? 'Choose Left or Right' : selected === null ? 'No choice made'
    : won ? runtime.character.name_full : 'John Pork';
  const anime = !hidden && won ? firstAnime(runtime.character.anime_titles) : '-';
  const rank = !hidden && won ? `#${formatNumber(runtime.character.rank)}` : '?';
  const likes = !hidden && won ? formatNumber(runtime.character.favourites) : '?';
  const container = new ContainerBuilder().setAccentColor(0xe91e63)
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(`# ${escapeMarkdown(title)}`),
      new TextDisplayBuilder().setContent(escapeMarkdown(anime)),
      new TextDisplayBuilder().setContent(`**Rank:** ${rank}\n**Likes:** ${likes}`));
  const urls = hidden ? ['attachment://mystery_roll.png', 'attachment://mystery_roll.png']
    : [1, 2].map((slot) => slot === winningDoor ? image || 'attachment://mystery_roll.png' : 'attachment://john_pork.gif');
  container.addMediaGalleryComponents(new MediaGalleryBuilder().addItems(...urls.map((url, index) =>
    new MediaGalleryItemBuilder().setURL(url).setDescription(`${index === 0 ? 'Left' : 'Right'} character`))));
  container.addTextDisplayComponents(new TextDisplayBuilder().setContent(
    `-# ${runtime.reservation.remaining} rolls left · ${hidden ? 'Only the roller may choose' : won ? 'Winner only · 60 seconds' : 'Unclaimable'}`));
  if (hidden) container.addActionRowComponents(...controls(runtime.sessionId,
    { buttons: [{ value: '1', label: 'Left' }, { value: '2', label: 'Right' }] }));
  else if (won) container.addActionRowComponents((row) => row.addComponents(
    new ButtonBuilder().setCustomId(`mystery:${runtime.sessionId}:decline`).setLabel('i dont wanna').setStyle(ButtonStyle.Secondary)));
  const files = hidden || !image ? [new AttachmentBuilder(MYSTERY_IMAGE, { name: 'mystery_roll.png' })] : [];
  if (!hidden) files.push(new AttachmentBuilder(JOHN_PORK_IMAGE, { name: 'john_pork.gif' }));
  return runtime.channel.send({ flags: MessageFlags.IsComponentsV2, components: [container], files,
    allowedMentions: NO_MENTIONS });
}

function arm(runtime, at, action) {
  if (runtime.timer) runtime.clearTimer(runtime.timer);
  const version = ++runtime.timerVersion;
  const delay = Math.max(0, at - runtime.now());
  runtime.timer = runtime.setTimer(() => {
    runtime.timer = null;
    // A fired timer can still be queued behind a Discord edit when a new phase replaces it.
    return queue(runtime, () => version === runtime.timerVersion ? action() : undefined)
      .catch((error) => failRuntime(runtime, error));
  }, delay);
  runtime.timer?.unref?.();
}

function queue(runtime, action) {
  const next = runtime.queue.then(() => runtime.disposed ? undefined : action());
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
  console.error('Mystery event delivery failed:', error);
  endMysterySession(runtime.db, { sessionId: runtime.sessionId, outcome: 'failed', now: runtime.now() });
  dispose(runtime);
}

async function showView(runtime, view) {
  if (getMysterySession(runtime.db, runtime.sessionId)?.eventId === 'doors') {
    runtime.eventMessage = await doorsCard(runtime, { hidden: true });
    return;
  }
  runtime.eventMessage = await runtime.channel.send({ content: view.text,
    components: controls(runtime.sessionId, view), allowedMentions: NO_MENTIONS });
}

async function revealUnclaimable(runtime, reason, answer = null) {
  const session = getMysterySession(runtime.db, runtime.sessionId);
  if (!session || !['completed', 'failed'].includes(session.state)) return;
  const answerLine = answer ? `\nAnime answer: **${answer}**` : '';
  await runtime.channel.send({ content: `${reason}${answerLine}\nThe character is revealed below.`,
    components: [], allowedMentions: NO_MENTIONS });
  await prizeCard(runtime, 'Unclaimable');
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
  if (!session) return;
  const content = `🔭 **Binoculars** reveals the answer: **${reveal.answer}**`;
  const user = await runtime.client?.users?.fetch(session.rollerId).catch(() => null);
  const sent = user?.send
    ? await user.send({ content, allowedMentions: NO_MENTIONS }).catch(() => null)
    : null;
  if (sent) {
    decrementItemCharge(runtime.db, reveal.inventoryId);
    return;
  }
  await runtime.channel.send({ content: `<@${session.rollerId}> 🔭 **Binoculars** could not reach you in DMs. `
    + 'The answer stays hidden and the charge was not spent.',
  allowedMentions: { users: [session.rollerId], roles: [], repliedUser: false } }).catch(() => {});
}

async function begin(runtime) {
  const result = beginMysteryEvent(runtime.db, runtime.sessionId, runtime.now(), runtime.random);
  if (result.status === 'early') {
    arm(runtime, result.nextAt, () => begin(runtime));
  } else if (result.status === 'started') {
    await showView(runtime, result.view);
    if (result.reveal) await revealAnswer(runtime, result.reveal);
    arm(runtime, result.session.nextAt, () => advance(runtime, { type: 'timer' }));
  } else if (result.status === 'no_winner' || result.status === 'unavailable') {
    await revealUnclaimable(runtime, 'The event ended without a winner.');
  } else if (result.status === 'stale') {
    dispose(runtime);
  }
}

async function countdown(runtime) {
  const session = getMysterySession(runtime.db, runtime.sessionId);
  if (session?.state !== 'countdown') { dispose(runtime); return; }
  const remaining = Math.ceil((session.nextAt - runtime.now()) / 1000);
  if (remaining <= 0) { await revealWinner(runtime); return; }
  const first = !runtime.countdownAnnounced;
  runtime.countdownAnnounced = true;
  await runtime.channel.send({ content: first
    ? `<@${session.winnerId}> won! Revealing in **${remaining}...**` : `**${remaining}...**`,
    components: [], allowedMentions: first
      ? { users: [session.winnerId], roles: [], repliedUser: false } : NO_MENTIONS });
  arm(runtime, session.nextAt - (remaining - 1) * 1000, () => countdown(runtime));
}

async function revealWinner(runtime) {
  const session = getMysterySession(runtime.db, runtime.sessionId);
  if (session?.state !== 'countdown') { dispose(runtime); return; }
  if (runtime.now() < session.nextAt) { arm(runtime, session.nextAt, () => revealWinner(runtime)); return; }
  await runtime.channel.send({ content: 'The character is revealed below.',
    components: [], allowedMentions: NO_MENTIONS });
  const card = await prizeCard(runtime, 'Winner only · 60 seconds');
  runtime.prize = card;
  await openWinnerClaim(runtime, card);
}

async function openWinnerClaim(runtime, card) {
  const session = getMysterySession(runtime.db, runtime.sessionId);
  if (session?.state !== 'countdown') { dispose(runtime); return; }
  const opened = openMysteryClaim(runtime.db, { sessionId: runtime.sessionId,
    messageId: card.id, now: runtime.now() });
  if (opened.status === 'early') {
    arm(runtime, session.nextAt, () => openWinnerClaim(runtime, card));
    return;
  }
  if (opened.status !== 'open') {
    await updateMysteryPrizeStatus(card, `${runtime.reservation.remaining} rolls left · Unclaimable`)
      .catch((error) => console.error('Mystery card update failed:', error));
    dispose(runtime);
    return;
  }
  try {
    await card.react(HEART);
  } catch (error) {
    endMysterySession(runtime.db, { sessionId: runtime.sessionId, outcome: 'failed', now: runtime.now() });
    dispose(runtime);
    throw error;
  }
  arm(runtime, opened.expiresAt, () => closeClaim(runtime));
}

async function closeClaim(runtime) {
  const session = getMysterySession(runtime.db, runtime.sessionId);
  if (session?.state !== 'claim_open') { dispose(runtime); return; }
  if (runtime.now() < session.nextAt) { arm(runtime, session.nextAt, () => closeClaim(runtime)); return; }
  if (!endMysterySession(runtime.db, { sessionId: runtime.sessionId, outcome: 'expired', now: runtime.now() })) {
    dispose(runtime);
    return;
  }
  if (runtime.prize) {
    await updateMysteryPrizeStatus(runtime.prize, `${runtime.reservation.remaining} rolls left · Unclaimable`)
      .catch((error) => console.error('Mystery claim close edit failed:', error));
  }
  dispose(runtime);
}

async function advance(runtime, input) {
  // Answers queued before a win must not dispose the newer countdown or claim phase.
  const current = getMysterySession(runtime.db, runtime.sessionId);
  if (current && ['countdown', 'claim_open'].includes(current.state)) return { status: 'stale' };
  const result = advanceMysteryEvent(runtime.db, { sessionId: runtime.sessionId,
    guildId: runtime.guildId, channelId: runtime.channel.id, input, now: runtime.now() });
  if (current?.eventId === 'doors' && ['winner', 'doors_lost'].includes(result.status)) {
    await runtime.channel.send({ content: `<@${current.rollerId}> has chosen **${input.value === '1' ? 'Left' : 'Right'}**, and the character is... :question:`,
      allowedMentions: { users: [current.rollerId], roles: [], repliedUser: false } });
    arm(runtime, runtime.now() + 3_000, async () => {
      if (getMysterySession(runtime.db, runtime.sessionId)?.state !== 'countdown') { dispose(runtime); return; }
      if (result.status === 'winner') {
        const card = await prizeCard(runtime, 'Winner only · 60 seconds');
        runtime.prize = card;
        await openWinnerClaim(runtime, card);
      } else {
        await runtime.channel.send({ embeds: [new EmbedBuilder().setTitle('John Pork').setDescription('-')
          .addFields({ name: 'Rank', value: '?', inline: true }, { name: 'Likes', value: '?', inline: true })
          .setImage('attachment://john_pork.gif').setFooter({ text: 'Unclaimable' })],
          files: [new AttachmentBuilder(JOHN_PORK_IMAGE, { name: 'john_pork.gif' })], allowedMentions: NO_MENTIONS });
        arm(runtime, runtime.now() + 2_000, async () => {
          endMysterySession(runtime.db, { sessionId: runtime.sessionId, outcome: 'no_winner', now: runtime.now() });
          await prizeCard(runtime, 'Unclaimable');
          dispose(runtime);
        });
      }
    });
    return result;
  }
  if (current?.eventId === 'doors' && result.status === 'no_winner') {
    const state = JSON.parse(current.stateJson);
    await doorsCard(runtime, { winningDoor: state.winningDoor,
      selected: input.type === 'button' ? Number(input.value) : null });
    dispose(runtime);
    return result;
  }
  if (result.status === 'ongoing') {
    if (result.view) await showView(runtime, result.view);
    arm(runtime, result.session.nextAt, () => advance(runtime, { type: 'timer' }));
  } else if (result.status === 'winner') {
    await countdown(runtime);
  } else if (result.status === 'no_winner') {
    await revealUnclaimable(runtime, 'The event ended without a winner.', result.answer);
  } else if (result.status === 'stale') {
    dispose(runtime);
  }
  return result;
}

export async function startMysteryRoll({ db, client, message, reservation, imagePicker,
  now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout, random = Math.random }) {
  const session = getMysterySession(db, reservation.sessionId);
  if (!session || session.state !== 'reserved') throw new Error('Mystery reservation is unavailable');
  const channel = session.eventChannelId === message.channelId ? message.channel
    : await client.channels.fetch(session.eventChannelId);
  if (!channel?.send) throw new Error('Mystery event channel is unavailable');
  const intro = await channel.send(introCard(reservation.remaining));
  if (!publishMysteryIntro(db, reservation.sessionId, intro.id, now())) {
    throw new Error('Mystery introduction could not be published');
  }
  const runtime = { db, client, channel, intro, imagePicker, reservation,
    character: reservation.character, guildId: session.guildId, sessionId: session.id,
    now, setTimer, clearTimer, random, eventMessage: null, countdownAnnounced: false, timer: null, timerVersion: 0,
    queue: Promise.resolve(), disposed: false, prize: null };
  sessions(db).set(session.id, runtime);
  arm(runtime, getMysterySession(db, session.id).nextAt, () => begin(runtime));
  return intro;
}

export async function onMysteryButton(db, interaction) {
  if (!interaction.isButton() || !interaction.customId.startsWith('mystery:')) return false;
  const decline = /^mystery:(\d+):decline$/.exec(interaction.customId);
  if (decline) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const runtime = sessions(db).get(Number(decline[1]));
    if (!runtime || runtime.prize?.id !== interaction.message.id
      || runtime.guildId !== interaction.guildId || runtime.channel.id !== interaction.channelId) {
      await interaction.editReply('This prize is no longer available.');
      return true;
    }
    const answer = await queue(runtime, async () => {
      const session = getMysterySession(db, runtime.sessionId);
      if (session?.state !== 'claim_open' || runtime.now() >= session.nextAt)
        return 'This prize is no longer available.';
      if (session.winnerId !== interaction.user.id) return 'Only the winner can decline this character.';
      endMysterySession(db, { sessionId: runtime.sessionId, outcome: 'declined', now: runtime.now() });
      dispose(runtime);
      await updateMysteryPrizeStatus(runtime.prize, `${runtime.reservation.remaining} rolls left · Declined`);
      return 'Character declined. Rolls are available again.';
    }).catch((error) => { failRuntime(runtime, error); return 'The mystery could not continue.'; });
    await interaction.editReply(answer ?? 'This prize is no longer available.');
    return true;
  }
  const match = /^mystery:(\d+):door:([12])$/.exec(interaction.customId);
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const runtime = match && sessions(db).get(Number(match[1]));
  if (!runtime || runtime.eventMessage?.id !== interaction.message.id
    || runtime.guildId !== interaction.guildId || runtime.channel.id !== interaction.channelId) {
    await interaction.editReply('This mystery choice has expired.');
    return true;
  }
  const answer = await queue(runtime, async () => {
    const current = getMysterySession(db, runtime.sessionId);
    if (current?.state !== 'running' || current.eventId !== 'doors') return 'This mystery choice has expired.';
    if (current.rollerId !== interaction.user.id) return 'Only the roller can choose a door.';
    const result = await advance(runtime, { type: 'button', userId: interaction.user.id, value: match[2] });
    return ['winner', 'doors_lost'].includes(result.status) ? 'Choice locked in. The character will be revealed shortly.'
        : 'This mystery choice has expired.';
  }).catch((error) => { failRuntime(runtime, error); return 'The mystery could not continue.'; });
  await interaction.editReply(answer);
  return true;
}

export async function onMysteryAnswer(db, message) {
  if (!message.guildId || !message.channelId || message.author?.bot || !message.content?.trim()) return false;
  const sessionId = activeMysteryInGuild(db, message.guildId);
  const runtime = sessionId && sessions(db).get(sessionId);
  if (!runtime || runtime.channel.id !== message.channelId) return false;
  const session = getMysterySession(db, sessionId);
  if (session?.state !== 'running' || !['treasure_hunt', 'clue_reveal'].includes(session.eventId)) return false;
  await queue(runtime, () => advance(runtime, { type: 'answer', userId: message.author.id,
    value: message.content.trim() })).catch((error) => failRuntime(runtime, error));
  return true;
}

export function cancelMysteryRuntime(db) {
  for (const runtime of sessions(db).values()) dispose(runtime);
  return cancelActiveMysteries(db);
}
