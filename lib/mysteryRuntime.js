import { fileURLToPath } from 'node:url';
import {
  ActionRowBuilder, AttachmentBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, MessageFlags,
} from 'discord.js';
import {
  cancelActiveMysteries, endMysterySession, getMysterySession, openMysteryClaim,
  publishMysteryIntro,
} from './characterRolls.js';
import { activeMysteryInGuild, advanceMysteryEvent, beginMysteryEvent } from './mysteryCoordinator.js';
import { formatNumber } from './formatNumber.js';

const MYSTERY_IMAGE = fileURLToPath(new URL('../assets/mystery_roll.png', import.meta.url));
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
  return runtime.channel.send({ embeds: [embed], allowedMentions: NO_MENTIONS });
}

function controls(sessionId, view) {
  if (!view?.buttons?.length) return [];
  const row = new ActionRowBuilder();
  for (const button of view.buttons) {
    row.addComponents(new ButtonBuilder().setCustomId(`mystery:${sessionId}:door:${button.value}`)
      .setLabel(button.label).setStyle(ButtonStyle.Primary));
  }
  return [row];
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
  await runtime.intro.edit({ content: `${HEADER}\n\n${view.text}`,
    components: controls(runtime.sessionId, view), allowedMentions: NO_MENTIONS });
}

async function revealUnclaimable(runtime, reason, answer = null) {
  const session = getMysterySession(runtime.db, runtime.sessionId);
  if (!session || !['completed', 'failed'].includes(session.state)) return;
  const answerLine = answer ? `\nAnime answer: **${answer}**` : '';
  await runtime.intro.edit({ content: `${HEADER}\n\n${reason}${answerLine}\nThe character is revealed below.`,
    components: [], allowedMentions: NO_MENTIONS });
  await prizeCard(runtime, 'Unclaimable');
  dispose(runtime);
}

async function begin(runtime) {
  const result = beginMysteryEvent(runtime.db, runtime.sessionId, runtime.now(), runtime.random);
  if (result.status === 'early') {
    arm(runtime, result.nextAt, () => begin(runtime));
  } else if (result.status === 'started') {
    await showView(runtime, result.view);
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
  await runtime.intro.edit({ content: `${HEADER}\n\n<@${session.winnerId}> won! Revealing in **${remaining}**…`,
    components: [], allowedMentions: NO_MENTIONS });
  arm(runtime, session.nextAt - (remaining - 1) * 1000, () => countdown(runtime));
}

async function revealWinner(runtime) {
  const session = getMysterySession(runtime.db, runtime.sessionId);
  if (session?.state !== 'countdown') { dispose(runtime); return; }
  if (runtime.now() < session.nextAt) { arm(runtime, session.nextAt, () => revealWinner(runtime)); return; }
  await runtime.intro.edit({ content: `${HEADER}\n\n<@${session.winnerId}> won! The character is revealed below.`,
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
    await card.edit({ embeds: [new EmbedBuilder(card.embeds[0].toJSON())
      .setFooter({ text: `${runtime.reservation.remaining} rolls left · Unclaimable` })],
      allowedMentions: NO_MENTIONS }).catch((error) => console.error('Mystery card update failed:', error));
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
    await runtime.prize.edit({ embeds: [new EmbedBuilder(runtime.prize.embeds[0].toJSON())
      .setFooter({ text: `${runtime.reservation.remaining} rolls left · Unclaimable` })],
      allowedMentions: NO_MENTIONS }).catch((error) => console.error('Mystery claim close edit failed:', error));
  }
  dispose(runtime);
}

async function advance(runtime, input) {
  // Answers queued before a win must not dispose the newer countdown or claim phase.
  const current = getMysterySession(runtime.db, runtime.sessionId);
  if (current && ['countdown', 'claim_open'].includes(current.state)) return { status: 'stale' };
  const result = advanceMysteryEvent(runtime.db, { sessionId: runtime.sessionId,
    guildId: runtime.guildId, channelId: runtime.channel.id, input, now: runtime.now() });
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
    now, setTimer, clearTimer, random, timer: null, timerVersion: 0,
    queue: Promise.resolve(), disposed: false, prize: null };
  sessions(db).set(session.id, runtime);
  arm(runtime, getMysterySession(db, session.id).nextAt, () => begin(runtime));
  return intro;
}

export async function onMysteryButton(db, interaction) {
  if (!interaction.isButton() || !interaction.customId.startsWith('mystery:')) return false;
  const match = /^mystery:(\d+):door:([123])$/.exec(interaction.customId);
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const runtime = match && sessions(db).get(Number(match[1]));
  if (!runtime || runtime.intro.id !== interaction.message.id
    || runtime.guildId !== interaction.guildId || runtime.channel.id !== interaction.channelId) {
    await interaction.editReply('This mystery choice has expired.');
    return true;
  }
  const answer = await queue(runtime, async () => {
    const current = getMysterySession(db, runtime.sessionId);
    if (current?.state !== 'running' || current.eventId !== 'doors') return 'This mystery choice has expired.';
    if (current.rollerId !== interaction.user.id) return 'Only the roller can choose a door.';
    const result = await advance(runtime, { type: 'button', userId: interaction.user.id, value: match[2] });
    return result.status === 'winner' ? 'Correct door! The prize will be revealed shortly.'
      : result.status === 'no_winner' ? 'Wrong door. The prize is unclaimable.'
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
