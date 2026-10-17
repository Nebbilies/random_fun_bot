import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openCatalog } from '../lib/catalogDb.js';
import { claimRoll, getClaimStatus, getMysterySession } from '../lib/characterRolls.js';
import { MYSTERY_ROSTER, reserveMysteryAwareRoll, setMysteryEventChannel } from '../lib/mysteryCoordinator.js';
import { onRollReaction } from '../lib/characterRollRuntime.js';
import { cancelMysteryRuntime, onMysteryAnswer, onMysteryButton,
  startMysteryRoll } from '../lib/mysteryRuntime.js';

function clock(start = 1100) {
  let current = start;
  let nextId = 1;
  const timers = new Map();
  return {
    now: () => current,
    setTimer(callback, delay) {
      const id = nextId++;
      timers.set(id, { at: current + delay, callback });
      return id;
    },
    clearTimer(id) { timers.delete(id); },
    async advanceTo(target) {
      while (true) {
        const due = [...timers].filter(([, timer]) => timer.at <= target)
          .sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]);
        current = due[1].at;
        await due[1].callback();
      }
      current = target;
    },
    pending: () => timers.size,
  };
}

function channel(id) {
  const sent = [];
  return {
    id, sent,
    async send(payload) {
      const messageId = String(500 + sent.length + Number(id) * 10);
      const item = { id: messageId, url: `https://discord.com/channels/1/${id}/${messageId}`,
        channelId: id, payload, edits: [], reactions: [], embeds: payload.embeds || [],
        async edit(change) {
          this.edits.push(change);
          if (change.embeds) this.embeds = change.embeds;
          return this;
        },
        async react(emoji) { this.reactions.push(emoji); },
      };
      sent.push(item);
      return item;
    },
  };
}

function fixture(t, eventDraw = 0) {
  const dir = mkdtempSync(join(tmpdir(), 'mystery-runtime-'));
  const db = openCatalog(join(dir, 'catalog.sqlite'));
  t.after(() => { cancelMysteryRuntime(db); db.close(); rmSync(dir, { recursive: true, force: true }); });
  db.exec(`INSERT INTO characters (id, rank, favourites, name_full, gender, anime_titles)
    VALUES (1, 1, 1000, 'Hidden Prize', 'Female', '["Example Anime"]')`);
  db.exec(`INSERT INTO anime (id, title_english, genres, tags, season_year, format, is_adult, fetched_at)
    VALUES (10, 'Example Anime', '["Adventure"]', '[{"name":"Space","rank":90}]', 2020, 'TV', 0, 'now');
    INSERT INTO character_anime (character_id, anime_id) VALUES (1, 10)`);
  const origin = channel('10');
  const event = channel('20');
  setMysteryEventChannel(db, '1', '20');
  const draws = [0, 0, eventDraw][Symbol.iterator]();
  const reservation = reserveMysteryAwareRoll(db, { guildId: '1', channelId: '10',
    commandMessageId: '100', userId: '101', pool: 'w', now: 1000,
    random: () => draws.next().value, mysteryEnabled: true });
  assert.equal(reservation.status, 'mystery');
  const message = { id: '100', guildId: '1', channelId: '10', channel: origin, author: { id: '101' } };
  const client = { channels: { async fetch(id) { assert.equal(id, '20'); return event; } } };
  const time = clock();
  const start = () => startMysteryRoll({ db, client, message, reservation, ...time, random: () => 0 });
  return { db, origin, event, reservation, time, start };
}

function doorInteraction(intro, value, userId = '101') {
  const acknowledgements = [];
  return { customId: `mystery:1:door:${value}`, message: intro, guildId: '1', channelId: '20',
    user: { id: userId }, acknowledgements, isButton: () => true,
    async deferReply(payload) { acknowledgements.push(payload); },
    async editReply(content) { acknowledgements.push(content); },
  };
}

test('configured channel receives a hidden portrait card, then Doors starts after five seconds', async (t) => {
  const { db, origin, event, reservation, time, start } = fixture(t);
  const intro = await start();
  assert.equal(origin.sent.length, 0);
  assert.equal(event.sent.length, 1);
  assert.equal(intro.payload.content, '# ❓ A mystery character appears!');
  assert.deepEqual(intro.payload.embeds[0].data.fields.map(({ name, value }) => [name, value]),
    [['Rank', '???'], ['Likes', '????'], ['Anime', '-']]);
  assert.equal(intro.payload.embeds[0].data.title, '??????');
  assert.equal(intro.payload.embeds[0].data.image.url, 'attachment://mystery_roll.png');
  assert.equal(intro.payload.files[0].name, 'mystery_roll.png');
  assert.equal(getMysterySession(db, reservation.sessionId).state, 'reserved');
  await time.advanceTo(6099);
  assert.equal(intro.edits.length, 0);
  await time.advanceTo(6100);
  assert.equal(getMysterySession(db, reservation.sessionId).state, 'running');
  assert.equal(intro.edits.length, 0);
  assert.match(event.sent[1].payload.content, /Three doors/);
  assert.equal(event.sent[1].payload.components[0].components.length, 3);
});

test('clue updates send new messages and preserve earlier clues', async (t) => {
  const { event, time, start } = fixture(t, 0.9);
  const intro = await start();
  await time.advanceTo(6100);
  const first = event.sent[1];
  assert.match(first.payload.content, /Clue 1/);
  assert.doesNotMatch(first.payload.content, /Clue 2/);
  await time.advanceTo(24100);
  assert.equal(event.sent.length, 3);
  assert.match(event.sent[2].payload.content, /Clue 2/);
  assert.equal(first.edits.length, 0);
  assert.equal(intro.edits.length, 0);
});

test('Door winner gets three new countdown messages and a 60-second exclusive claim', async (t) => {
  const { db, event, reservation, time, start } = fixture(t);
  const intro = await start();
  await time.advanceTo(6100);
  const choice = doorInteraction(event.sent[1], '1');
  assert.equal(await onMysteryButton(db, choice), true);
  assert.equal(getMysterySession(db, reservation.sessionId).state, 'countdown');
  assert.equal(event.sent.at(-1).payload.content, '<@101> won! Revealing in **3...**');
  assert.deepEqual(event.sent.at(-1).payload.allowedMentions.users, ['101']);
  await time.advanceTo(8100);
  for (const number of [3, 2, 1]) {
    assert(event.sent.some((item) => item.payload.content?.includes(`**${number}...**`)));
  }
  assert.equal(event.sent[3].payload.content, '**2...**');
  assert.equal(event.sent[4].payload.content, '**1...**');
  assert.equal(event.sent.filter((item) => item.payload.content?.includes('mystery character appears')).length, 1);
  assert.equal(event.sent.filter((item) => item.payload.content?.includes('<@101>')).length, 1);
  assert.equal(event.sent.length, 5);
  await time.advanceTo(9100);
  assert.equal(event.sent.length, 7);
  assert.equal(intro.edits.length, 0);
  const prize = event.sent[6];
  assert.equal(prize.embeds[0].data.title, 'Hidden Prize');
  assert.deepEqual(prize.reactions, ['❤️']);
  assert.equal(getMysterySession(db, reservation.sessionId).state, 'claim_open');
  assert.equal(claimRoll(db, { guildId: '1', channelId: '20', messageId: prize.id,
    userId: '102', now: 11101 }).status, 'protected');
  prize.guildId = '1';
  prize.channel = event;
  const originalNow = Date.now;
  Date.now = () => 11102;
  try {
    await onRollReaction({ catalogDb: db }, { emoji: { name: '❤️' }, message: prize },
      { id: '101', bot: false });
  } finally {
    Date.now = originalNow;
  }
  assert.equal(getMysterySession(db, reservation.sessionId).outcome, 'claimed');
  assert.equal(prize.embeds[0].data.footer.text, 'Claimed');
  await time.advanceTo(71100);
  assert.equal(event.sent.length, 8);
  assert.equal(getMysterySession(db, reservation.sessionId).outcome, 'claimed');
});

test('Door timeout reveals once, unclaimable, and a late choice is stale', async (t) => {
  const { db, event, reservation, time, start } = fixture(t);
  const intro = await start();
  await time.advanceTo(36100);
  assert.equal(getMysterySession(db, reservation.sessionId).outcome, 'no_winner');
  assert.equal(event.sent.length, 4);
  assert.match(event.sent[3].embeds[0].data.footer.text, /Unclaimable/);
  assert.equal(event.sent[3].reactions.length, 0);
  const late = doorInteraction(intro, '1');
  await onMysteryButton(db, late);
  assert.match(late.acknowledgements.at(-1), /expired/);
  await time.advanceTo(100000);
  assert.equal(event.sent.length, 4);
});

test('only the winner can decline a revealed prize, releasing rolls without spending a claim', async (t) => {
  assert.equal(MYSTERY_ROSTER.some((entry) => entry.id === 'treasure_hunt'), false);
  const { db, event, reservation, time, start } = fixture(t);
  await start();
  await time.advanceTo(6100);
  await onMysteryButton(db, doorInteraction(event.sent[1], '1'));
  await time.advanceTo(9100);
  const prize = event.sent[6];
  assert.equal(prize.payload.components[0].components[0].data.label, 'i dont wanna');
  const decline = (userId) => ({ ...doorInteraction(prize, '1', userId),
    customId: `mystery:${reservation.sessionId}:decline` });
  const denied = decline('102');
  await onMysteryButton(db, denied);
  assert.match(denied.acknowledgements.at(-1), /Only the winner/);
  assert.equal(getMysterySession(db, reservation.sessionId).state, 'claim_open');
  const accepted = decline('101');
  await onMysteryButton(db, accepted);
  assert.equal(getMysterySession(db, reservation.sessionId).outcome, 'declined');
  assert.equal(time.pending(), 0);
  assert.deepEqual(prize.edits.at(-1).components, []);
  assert.match(prize.embeds[0].data.footer.text, /Declined/);
  assert.equal(getClaimStatus(db, '1', '101', time.now()).canClaim, true);
  assert.notEqual(claimRoll(db, { guildId: '1', channelId: '20', messageId: prize.id,
    userId: '101', now: time.now() }).status, 'married');
  const late = decline('101');
  await onMysteryButton(db, late);
  assert.match(late.acknowledgements.at(-1), /no longer available/);
  const next = reserveMysteryAwareRoll(db, { guildId: '1', channelId: '10',
    commandMessageId: '101', userId: '101', pool: 'w', now: time.now(),
    mysteryEnabled: false, random: () => 0.5 });
  assert.equal(next.status, 'reserved');
});

test('queued clue timers and simultaneous guesses cannot cancel the winner countdown', async (t) => {
  const { db, event, reservation, time, start } = fixture(t, 0.9);
  assert.equal(reservation.eventId, 'clue_reveal');
  const intro = await start();
  await time.advanceTo(23900);
  let releaseEdit = () => {};
  let editStarted = () => {};
  const editing = new Promise((resolve) => { editStarted = () => resolve(undefined); });
  const blocked = new Promise((resolve) => { releaseEdit = () => resolve(undefined); });
  const send = event.send.bind(event);
  event.send = async (change) => {
    if (change.content?.includes('**3...**')) {
      editStarted();
      await blocked;
    }
    return send(change);
  };
  const answer = onMysteryAnswer(db, { guildId: '1', channelId: '20',
    author: { id: '102' }, content: 'Example Anime' });
  const secondAnswer = onMysteryAnswer(db, { guildId: '1', channelId: '20',
    author: { id: '103' }, content: 'Example Anime' });
  await editing;
  // The old clue timer fires while Discord is still processing the winner edit.
  const oldTimer = time.advanceTo(24100);
  releaseEdit();
  await Promise.all([answer, secondAnswer, oldTimer]);
  await time.advanceTo(26900);
  assert.equal(getMysterySession(db, reservation.sessionId).state, 'claim_open');
  assert.equal(event.sent.length, 7);
  assert.deepEqual(event.sent[6].reactions, ['❤️']);
  assert.equal(intro.edits.length, 0);
  await time.advanceTo(86900);
  assert.equal(getMysterySession(db, reservation.sessionId).outcome, 'expired');
  assert.equal(time.pending(), 0);
  const next = reserveMysteryAwareRoll(db, { guildId: '1', channelId: '10',
    commandMessageId: '101', userId: '101', pool: 'w', now: time.now(),
    mysteryEnabled: false, random: () => 0.5 });
  assert.equal(next.status, 'reserved');
});

test('Clue Reveal accepts an event-channel answer and a restart leaves old message untouched', async (t) => {
  const { db, event, reservation, time, start } = fixture(t, 0.5);
  assert.equal(reservation.eventId, 'clue_reveal');
  const intro = await start();
  await time.advanceTo(6100);
  const session = getMysterySession(db, reservation.sessionId);
  const answer = JSON.parse(session.stateJson).title;
  assert.equal(await onMysteryAnswer(db, { guildId: '1', channelId: '10',
    author: { id: '102' }, content: answer }), false);
  assert.equal(await onMysteryAnswer(db, { guildId: '1', channelId: '20',
    author: { id: '102' }, content: answer }), true);
  assert.equal(getMysterySession(db, reservation.sessionId).winnerId, '102');
  const editsBeforeRestart = intro.edits.length;
  assert.equal(cancelMysteryRuntime(db), 1);
  await time.advanceTo(100000);
  assert.equal(intro.edits.length, editsBeforeRestart);
  assert.equal(event.sent.length, 3);
  assert.equal(getMysterySession(db, reservation.sessionId).outcome, 'canceled');
});
