import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openCatalog } from '../lib/catalogDb.js';
import { claimRoll, getClaimStatus, getMysterySession } from '../lib/characterRolls.js';
import { MYSTERY_ROSTER, reserveMysteryAwareRoll, setMysteryEventChannel } from '../lib/mysteryCoordinator.js';
import { onRollReaction } from '../lib/characterRollRuntime.js';
import { addItemToInventory, getInventory } from '../lib/itemStorage.js';
import { closesAt, RESULT_DURATION_MS } from '../lib/mysteryEvents/roundContest.js';
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
        current = Math.max(current, due[1].at);
        await due[1].callback();
      }
      current = target;
    },
    pending: () => timers.size,
    jumpTo: (at) => { current = at; },
  };
}

function channel(id) {
  const sent = [];
  return {
    id, sent,
    async send(payload) {
      const messageId = String(500 + sent.length + Number(id) * 10);
      const item = { id: messageId, url: `https://discord.com/channels/1/${id}/${messageId}`,
        channelId: id, payload, edits: [], reactions: [], embeds: payload.embeds || [], components: payload.components || [],
        async edit(change) {
          this.edits.push(change);
          if (change.embeds) this.embeds = change.embeds;
          if (change.components) this.components = change.components;
          return this;
        },
        async react(emoji) { this.reactions.push(emoji); },
      };
      sent.push(item);
      return item;
    },
  };
}

function fixture(t, eventDraw = 0, slotDraw = 0, franchiseFallback = false) {
  const dir = mkdtempSync(join(tmpdir(), 'mystery-runtime-'));
  const db = openCatalog(join(dir, 'catalog.sqlite'));
  t.after(() => { cancelMysteryRuntime(db); db.close(); rmSync(dir, { recursive: true, force: true }); });
  db.exec(`INSERT INTO characters (id, rank, favourites, name_full, gender, anime_titles, image_url)
    VALUES (1, 1, 1000, 'Hidden Prize', 'Female', '["Example Anime"]', 'https://example.com/prize.png')`);
  db.exec(`INSERT INTO anime (id, title_english, genres, tags, season_year, format, is_adult, fetched_at)
    VALUES (10, 'Example Anime', '["Adventure"]', '[{"name":"Space","rank":90}]', 2020, 'TV', 0, 'now');
    INSERT INTO character_anime (character_id, anime_id) VALUES (1, 10)`);
  if (franchiseFallback) db.exec(`UPDATE characters SET anime_titles='[]';
    INSERT INTO franchises(id,display_name,created_at) VALUES(1,'Zulu','now'),(2,'Alpha','now');
    INSERT INTO franchise_anime(franchise_id,anime_id) VALUES(1,10),(2,10)`);
  const origin = channel('10');
  const event = channel('20');
  setMysteryEventChannel(db, '1', '20');
  const eventId = typeof eventDraw === 'string' ? eventDraw : eventDraw < 0.5 ? 'doors' : 'clue_reveal';
  const selection = (MYSTERY_ROSTER.findIndex((entry) => entry.id === eventId) + 0.1) / MYSTERY_ROSTER.length;
  const draws = [0, 0, selection][Symbol.iterator]();
  const reservation = reserveMysteryAwareRoll(db, { guildId: '1', channelId: '10',
    commandMessageId: '100', userId: '101', pool: 'w', now: 1000,
    random: () => draws.next().value, mysteryEnabled: true });
  assert.equal(reservation.status, 'mystery');
  const message = { id: '100', guildId: '1', channelId: '10', channel: origin, author: { id: '101' } };
  const client = { channels: { async fetch(id) { assert.equal(id, '20'); return event; } } };
  const time = clock();
  const start = () => startMysteryRoll({ db, client, message, reservation, ...time,
    random: typeof slotDraw === 'function' ? slotDraw : () => slotDraw });
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

function roundPrompt(event, name, round) {
  const needle = `${name} · Round ${round}/`;
  return event.sent.find((message) => JSON.stringify(message.payload).includes(needle));
}

function roundInteraction(prompt, round, value, userId = '101') {
  return { ...doorInteraction(prompt, value, userId), customId: `mystery:1:choice:${round}:${value}` };
}

async function beginContest({ db, time, start }) {
  await start();
  await time.advanceTo(getMysterySession(db, 1).nextAt);
  const { startedAt } = JSON.parse(getMysterySession(db, 1).stateJson);
  const close = (round) => closesAt({ startedAt, round });
  return { close, open: (round) => round === 1 ? startedAt : close(round - 1) + RESULT_DURATION_MS };
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
  const prompt = event.sent[1].payload.components[0].toJSON();
  assert.match(JSON.stringify(prompt), /Choose Left or Right/);
  assert.deepEqual(prompt.components.find((component) => component.type === 12).items
    .map((item) => item.media.url), ['attachment://mystery_roll.png', 'attachment://mystery_roll.png']);
  assert.equal(prompt.components.at(-1).components.length, 2);
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

test('Door winner reveals the prize after three seconds with a 60-second exclusive claim', async (t) => {
  const { db, event, reservation, time, start } = fixture(t);
  const intro = await start();
  await time.advanceTo(6100);
  const choice = doorInteraction(event.sent[1], '1');
  assert.equal(await onMysteryButton(db, choice), true);
  assert.equal(event.sent.filter((item) => item.payload.content?.includes('mystery character appears')).length, 1);
  assert.equal(event.sent.length, 3);
  assert.equal(intro.edits.length, 0);
  assert.equal(event.sent[2].payload.content, '<@101> has chosen **Left**, and the character is... :question:');
  await time.advanceTo(9099);
  assert.equal(event.sent.length, 3);
  await time.advanceTo(9100);
  const prize = event.sent[3];
  assert.equal(prize.embeds[0].data.title, 'Hidden Prize');
  assert.equal(prize.embeds[0].data.description, 'Example Anime');
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
  assert.equal(prize.embeds[0].data.color, 0x8b4513);
  await time.advanceTo(71100);
  assert.equal(event.sent.length, 5);
  assert.equal(getMysterySession(db, reservation.sessionId).outcome, 'claimed');
});

test('Door timeout reveals once, unclaimable, and a late choice is stale', async (t) => {
  const { db, event, reservation, time, start } = fixture(t);
  const intro = await start();
  await time.advanceTo(36100);
  assert.equal(getMysterySession(db, reservation.sessionId).outcome, 'no_winner');
  assert.equal(event.sent.length, 3);
  assert.match(JSON.stringify(event.sent[2].components[0].toJSON()), /Unclaimable/);
  assert.equal(event.sent[2].reactions.length, 0);
  const late = doorInteraction(intro, '1');
  await onMysteryButton(db, late);
  assert.match(late.acknowledgements.at(-1), /expired/);
  await time.advanceTo(100000);
  assert.equal(event.sent.length, 3);
});

test('both slot placements use timed reveals; John Pork precedes an unclaimable prize by two seconds', async (t) => {
  for (const draw of [0, 0.5]) {
    for (const selected of [1, 2]) {
      const { db, event, reservation, time, start } = fixture(t, 0, draw);
      await start();
      await time.advanceTo(6100);
      const prompt = event.sent[1];
      const spectator = doorInteraction(prompt, String(selected), '102');
      await onMysteryButton(db, spectator);
      assert.match(spectator.acknowledgements.at(-1), /Only the roller/);
      assert.equal(event.sent.length, 2);
      const winning = draw === 0 ? 1 : 2;
      await onMysteryButton(db, doorInteraction(prompt, String(selected)));
      assert.match(event.sent[2].payload.content, new RegExp(selected === 1 ? 'Left' : 'Right'));
      assert.equal(getMysterySession(db, reservation.sessionId).state, 'countdown');
      await time.advanceTo(9099);
      assert.equal(event.sent.length, 3);
      await time.advanceTo(9100);
      const card = event.sent[3];
      if (selected !== winning) {
        assert.equal(card.embeds[0].data.title, 'John Pork');
        assert.equal(card.embeds[0].data.description, '-');
        assert.deepEqual(card.embeds[0].data.fields.map((field) => field.value), ['?', '?']);
        assert.deepEqual(card.reactions, []);
        assert.equal(getMysterySession(db, reservation.sessionId).state, 'countdown');
        await time.advanceTo(11099);
        assert.equal(event.sent.length, 4);
        await time.advanceTo(11100);
        assert.equal(event.sent[4].embeds[0].data.title, 'Hidden Prize');
        assert.match(event.sent[4].embeds[0].data.footer.text, /Unclaimable/);
        assert.deepEqual(event.sent[4].reactions, []);
        assert.equal(getMysterySession(db, reservation.sessionId).outcome, 'no_winner');
        assert.notEqual(claimRoll(db, { guildId: '1', channelId: '20', messageId: card.id,
          userId: '101', now: time.now() }).status, 'married');
      } else {
        assert.equal(card.embeds[0].data.title, 'Hidden Prize');
        await time.advanceTo(69100);
        assert.match(card.embeds[0].data.footer.text, /Unclaimable/);
        assert.deepEqual(card.components, []);
        assert.equal(getMysterySession(db, reservation.sessionId).outcome, 'expired');
      }
      const late = doorInteraction(prompt, String(selected));
      await onMysteryButton(db, late);
      assert.equal(event.sent.length, selected === winning ? 4 : 5);
      assert.equal(time.pending(), 0);
    }
  }
});

test('only the winner can decline a revealed prize, releasing rolls without spending a claim', async (t) => {
  assert.equal(MYSTERY_ROSTER.some((entry) => entry.id === 'treasure_hunt'), false);
  const { db, event, reservation, time, start } = fixture(t);
  await start();
  await time.advanceTo(6100);
  await onMysteryButton(db, doorInteraction(event.sent[1], '1'));
  await time.advanceTo(9100);
  const prize = event.sent[3];
  assert.match(JSON.stringify(prize.components[0].toJSON()), /i dont wanna/);
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
  assert.deepEqual(prize.components, []);
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

for (const version of [10, 12]) {
  test(`shutdown cancellation policy preserves legacy v10 and detaches final v12: v${version}`, async (t) => {
    const { db, reservation, time, start } = fixture(t);
    await start();
    // Exercise only the schema-version policy; no final-schema operations run here.
    db.exec(`PRAGMA user_version = ${version}`);
    const before = getMysterySession(db, reservation.sessionId);
    assert.ok(time.pending() > 0);
    assert.equal(cancelMysteryRuntime(db), version <= 10 ? 1 : 0);
    assert.equal(time.pending(), 0);
    if (version <= 10) assert.equal(getMysterySession(db, reservation.sessionId).outcome, 'canceled');
    else assert.deepEqual(getMysterySession(db, reservation.sessionId), before);
    db.exec('PRAGMA user_version = 10');
  });
}

test('Clue Reveal accepts an event-channel answer and admin cancellation leaves old message untouched', async (t) => {
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
  assert.equal(cancelMysteryRuntime(db, { cancelPaidSessions: true }), 1);
  await time.advanceTo(100000);
  assert.equal(intro.edits.length, editsBeforeRestart);
  assert.equal(event.sent.length, 3);
  assert.equal(getMysterySession(db, reservation.sessionId).outcome, 'canceled');
});

test('Deadlock keeps prompts stable, rejects stale controls and shows final scores before a protected prize', async (t) => {
  const { db, event, reservation, time, start } = fixture(t, 'deadlock');
  const windows = await beginContest({ db, time, start });
  const first = roundPrompt(event, 'Deadlock', 1);
  const sentBefore = event.sent.length;
  const picked = roundInteraction(first, 1, '5');
  await onMysteryButton(db, picked);
  assert.equal(picked.acknowledgements[0].flags, 64);
  assert.match(picked.acknowledgements.at(-1), new RegExp(`Saved: 5.*${Math.ceil((windows.close(1) - time.now()) / 1000)} more seconds`));
  assert.doesNotMatch(picked.acknowledgements.at(-1), /claim|eligible|%/i);
  await onMysteryButton(db, roundInteraction(first, 1, '5', '102'));
  await onMysteryButton(db, roundInteraction(first, 1, '4'));
  assert.equal(event.sent.length, sentBefore, 'choices edit the same prompt without posting new ones');
  assert.match(JSON.stringify(first.edits.at(-1).components), /Participants: 2/);
  assert.ok(first.edits.every((edit) => !/picked|Saved:/.test(JSON.stringify(edit.components ?? []))));
  for (const [field, value] of [['guildId', '2'], ['channelId', '10']]) {
    const wrong = { ...roundInteraction(first, 1, '1'), [field]: value };
    await onMysteryButton(db, wrong);
    assert.match(wrong.acknowledgements.at(-1), /expired/);
  }
  await time.advanceTo(windows.close(1));
  assert.match(event.sent.at(-1).payload.content, /<@101>: picked 4 · \+4/);
  assert.match(JSON.stringify(first.components), /Round closed/);
  assert.doesNotMatch(JSON.stringify(first.components), /mystery:1:choice/);
  await time.advanceTo(windows.open(2));
  const second = roundPrompt(event, 'Deadlock', 2);
  const stale = roundInteraction(first, 1, '1');
  await onMysteryButton(db, stale);
  assert.match(stale.acknowledgements.at(-1), /expired/);
  const forged = roundInteraction(second, 1, '1');
  await onMysteryButton(db, forged);
  assert.match(forged.acknowledgements.at(-1), /closed/);
  await onMysteryButton(db, roundInteraction(second, 2, '5', '103'));
  await time.advanceTo(windows.open(3));
  await onMysteryButton(db, roundInteraction(roundPrompt(event, 'Deadlock', 3), 3, '3', '102'));
  await time.advanceTo(windows.close(3));
  const session = getMysterySession(db, reservation.sessionId);
  assert.equal(session.winnerId, '102');
  assert.equal(session.state, 'countdown');
  const finalIndex = event.sent.findIndex((message) => message.payload.content?.includes('**Final standings**'));
  const wonIndex = event.sent.findIndex((message) => message.payload.content?.includes('<@102> won!'));
  assert.ok(finalIndex >= 0 && finalIndex < wonIndex);
  await time.advanceTo(session.nextAt);
  const prize = event.sent.at(-1);
  assert.deepEqual(prize.reactions, ['❤️']);
  assert.equal(claimRoll(db, { guildId: '1', channelId: '20', messageId: prize.id,
    userId: '101', now: time.now() }).status, 'protected');
  assert.equal(claimRoll(db, { guildId: '1', channelId: '20', messageId: prize.id,
    userId: '102', now: time.now() }).status, 'married');
});

test('Greed catches a late timer, rejects a late revision and automatically banks the missed round', async (t) => {
  const { db, event, reservation, time, start } = fixture(t, 'greed_chamber', 1 - Number.EPSILON);
  const windows = await beginContest({ db, time, start });
  const first = roundPrompt(event, 'Greed Chamber', 1);
  await onMysteryButton(db, roundInteraction(first, 1, 'stay'));
  assert.ok(getMysterySession(db, reservation.sessionId).deadlineAt > windows.close(5));
  time.jumpTo(windows.close(5) + 1);
  const late = roundInteraction(first, 1, 'escape');
  await onMysteryButton(db, late);
  assert.match(late.acknowledgements.at(-1), /expired/);
  const session = getMysterySession(db, reservation.sessionId);
  assert.equal(session.state, 'countdown');
  assert.equal(JSON.parse(session.stateJson).players['101'].banked, 1);
  assert.match(event.sent.map((message) => message.payload.content).join('\n'), /Automatically escaped/);
  assert.doesNotMatch(event.sent.map((message) => JSON.stringify(message.payload)).join('\n'), /\d+%|collapse odds/i);
  await time.advanceTo(session.nextAt);
  assert.equal(getMysterySession(db, reservation.sessionId).state, 'claim_open');
});

test('Greed final round resolves at its cutoff and displays banked results before countdown', async (t) => {
  const { db, event, reservation, time, start } = fixture(t, 'greed_chamber', 1 - Number.EPSILON);
  const windows = await beginContest({ db, time, start });
  for (let round = 1; round <= 5; round++) {
    await time.advanceTo(windows.open(round));
    await onMysteryButton(db, roundInteraction(roundPrompt(event, 'Greed Chamber', round), round, 'stay'));
  }
  await time.advanceTo(windows.close(5));
  const session = getMysterySession(db, reservation.sessionId);
  assert.equal(session.state, 'countdown');
  assert.equal(JSON.parse(session.stateJson).players['101'].banked, 15);
  const final = event.sent.findIndex((message) => message.payload.content?.includes('Final banked standings'));
  const won = event.sent.findIndex((message) => message.payload.content?.includes('won!'));
  assert.ok(final >= 0 && final < won);
});

test('a queued round interaction cannot use controls replaced while waiting', async (t) => {
  const { db, event, time, start } = fixture(t, 'deadlock');
  const windows = await beginContest({ db, time, start });
  const first = roundPrompt(event, 'Deadlock', 1);
  let release;
  let editing;
  const blocked = new Promise((resolve) => { release = resolve; });
  const began = new Promise((resolve) => { editing = resolve; });
  const edit = first.edit.bind(first);
  first.edit = async (payload) => {
    if (!JSON.stringify(payload.components ?? []).includes('mystery:1:choice')) { editing(); await blocked; }
    return edit(payload);
  };
  const timer = time.advanceTo(windows.close(1));
  await began;
  const stale = roundInteraction(first, 1, '5');
  const pendingChoice = onMysteryButton(db, stale);
  release();
  await Promise.all([timer, pendingChoice]);
  assert.match(stale.acknowledgements.at(-1), /expired/);
  assert.deepEqual(JSON.parse(getMysterySession(db, 1).stateJson).players, {});
});

test('Deadlock resolves delayed final timers, including no-winner results, within the safety watchdog', async (t) => {
  for (const entered of [false, true]) {
    const { db, event, reservation, time, start } = fixture(t, 'deadlock');
    const windows = await beginContest({ db, time, start });
    if (entered) await onMysteryButton(db, roundInteraction(roundPrompt(event, 'Deadlock', 1), 1, '5'));
    time.jumpTo(windows.close(3) + 1);
    await time.advanceTo(time.now());
    const session = getMysterySession(db, reservation.sessionId);
    assert.equal(session.state, entered ? 'countdown' : 'completed');
    assert.equal(JSON.parse(session.stateJson).phase, 'finished');
    assert.match(event.sent.map((message) => message.payload.content).join('\n'), /Final standings/);
    if (!entered) assert.match(event.sent.at(-1).embeds[0].data.footer.text, /Unclaimable/);
  }
});

test('competitive events preserve Binoculars, admin cancellation, and winner forfeiture without a claim', async (t) => {
  for (const eventId of ['greed_chamber', 'deadlock']) {
    const { db, event, reservation, time, start } = fixture(t, eventId);
    addItemToInventory(db, '1', '101', 'binoculars', 1);
    await beginContest({ db, time, start });
    assert.equal(getInventory(db, '1', '101').find((item) => item.item_id === 'binoculars').charges, 1);
    const old = event.sent.at(-1);
    const edits = old.edits.length;
    assert.equal(cancelMysteryRuntime(db, { cancelPaidSessions: true }), 1);
    await time.advanceTo(getMysterySession(db, reservation.sessionId).deadlineAt + 1);
    assert.equal(old.edits.length, edits);
    assert.equal(getMysterySession(db, reservation.sessionId).outcome, 'canceled');
    const stale = roundInteraction(old, 1, eventId === 'deadlock' ? '5' : 'stay');
    await onMysteryButton(db, stale);
    assert.match(stale.acknowledgements.at(-1), /expired/);
  }
  const { db, event, reservation, time, start } = fixture(t, 'deadlock');
  const windows = await beginContest({ db, time, start });
  const period = Math.floor((time.now() + 7 * 3600000) / (3 * 3600000));
  db.prepare('INSERT INTO claim_allowances (guild_id, user_id, period) VALUES (?, ?, ?)').run('1', '101', period);
  assert.equal(getClaimStatus(db, '1', '101', time.now()).canClaim, false);
  await onMysteryButton(db, roundInteraction(roundPrompt(event, 'Deadlock', 1), 1, '5'));
  await time.advanceTo(windows.close(3));
  await time.advanceTo(getMysterySession(db, reservation.sessionId).nextAt);
  assert.equal(getMysterySession(db, reservation.sessionId).outcome, 'forfeited');
  assert.match(event.sent.at(-1).embeds[0].data.footer.text, /Unclaimable/);
});

test('competitive result messages retain every participant without exceeding Discord limits', async (t) => {
  const { db, event, time, start } = fixture(t, 'deadlock');
  const windows = await beginContest({ db, time, start });
  const state = JSON.parse(getMysterySession(db, 1).stateJson);
  const ids = Array.from({ length: 120 }, (_, index) => String(100000000000000000n + BigInt(index)));
  for (const id of ids) { state.players[id] = { score: 0 }; state.choices[id] = '5'; }
  db.prepare('UPDATE mystery_sessions SET state_json = ? WHERE id = 1').run(JSON.stringify(state));
  await time.advanceTo(windows.close(1));
  const messages = event.sent.filter((message) => message.payload.content);
  for (const message of messages) {
    assert.ok(message.payload.content.length <= 2000);
    assert.deepEqual(message.payload.allowedMentions.parse, []);
  }
  const text = messages.map((message) => message.payload.content).join('\n');
  for (const id of ids) assert.ok(text.includes(`<@${id}>: picked 5`));
});

test('round prompts render as Components V2 cards with styled buttons', async (t) => {
  const { db, event, time, start } = fixture(t, 'deadlock');
  const windows = await beginContest({ db, time, start });
  const opening = roundPrompt(event, 'Deadlock', 1);
  assert.equal(opening.payload.flags, 32768);
  assert.equal(opening.payload.content, undefined);
  const card = JSON.stringify(opening.payload.components);
  assert.match(card, /Deadlock · Round 1\/3/);
  assert.match(card, /Cumulative standings/);
  assert.match(card, /"style":1/);
  assert.match(card, /"name":"1️⃣"/);
  assert.match(card, /Participants: 0/);

  // Later rounds keep only the round number and the choices: the instructions,
  // participant count, and standings live on the opening card alone.
  const state = JSON.parse(getMysterySession(db, 1).stateJson);
  const ids = Array.from({ length: 200 }, (_, index) => String(100000000000000000n + BigInt(index)));
  for (const id of ids) { state.players[id] = { score: 0 }; state.choices[id] = '5'; }
  db.prepare('UPDATE mystery_sessions SET state_json = ? WHERE id = 1').run(JSON.stringify(state));
  await time.advanceTo(windows.open(2));
  const second = roundPrompt(event, 'Deadlock', 2);
  const later = JSON.stringify(second.payload.components);
  assert.doesNotMatch(later, /Cumulative standings/);
  assert.doesNotMatch(later, /Pick \*\*1–5\*\*/);
  assert.doesNotMatch(later, /Participants: /);
  assert.match(later, /Deadlock · Round 2\/3/);
  assert.deepEqual(second.payload.allowedMentions.parse, []);
  for (const message of event.sent) {
    if (message.payload.content) assert.ok(message.payload.content.length <= 2000);
  }
});

test('later rounds drop instructions and participants but keep the choices', async (t) => {
  const { db, event, time, start } = fixture(t, 'deadlock');
  const windows = await beginContest({ db, time, start });
  const opening = roundPrompt(event, 'Deadlock', 1);
  await onMysteryButton(db, roundInteraction(opening, 1, '5', '101'));
  await onMysteryButton(db, roundInteraction(opening, 1, '4', '102'));
  const edited = JSON.stringify(opening.edits.at(-1).components);
  assert.match(edited, /Participants: 2/);
  assert.match(edited, /Pick \*\*1–5\*\*/);
  await time.advanceTo(windows.open(2));
  const second = roundPrompt(event, 'Deadlock', 2);
  const later = JSON.stringify(second.payload.components);
  assert.match(later, /"name":"5️⃣"/);
  assert.match(later, /mystery:1:choice:2:5/);
  assert.doesNotMatch(later, /Participants: |Cumulative standings|Pick/);
  // The closed card still tells players why the buttons are gone.
  await time.advanceTo(windows.close(2));
  const closed = JSON.stringify(second.edits.at(-1).components);
  assert.match(closed, /Round closed · choices are locked/);
  assert.doesNotMatch(closed, /Participants: |Cumulative standings/);
  assert.doesNotMatch(closed, /"type":1,/);
});

test('Greed Chamber styles Stay and Escape as distinct actions', async (t) => {
  const { db, event, time, start } = fixture(t, 'greed_chamber', 1 - Number.EPSILON);
  const windows = await beginContest({ db, time, start });
  const card = JSON.stringify(roundPrompt(event, 'Greed Chamber', 1).payload.components);
  assert.match(card, /Greed Chamber · Round 1\/5/);
  assert.match(card, /"label":"Stay","style":3/);
  assert.match(card, /"label":"Escape","style":4/);
  assert.match(card, /Entry closes after this round/);
  assert.doesNotMatch(card, /\d+%|collapse odds/i);
  const opening = roundPrompt(event, 'Greed Chamber', 1);
  await onMysteryButton(db, roundInteraction(opening, 1, 'stay'));
  await time.advanceTo(windows.open(2));
  const later = JSON.stringify(roundPrompt(event, 'Greed Chamber', 2).payload.components);
  assert.match(later, /Greed Chamber · Round 2\/5/);
  assert.match(later, /mystery:1:choice:2:stay/);
  assert.doesNotMatch(later, /Stay to risk your unbanked points|Participants: |Entry is closed/);
});

function gate() {
  let release;
  const blocked = new Promise((resolve) => { release = resolve; });
  return { blocked, release };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

test('blocked participant edits do not delay private revisions, results or the next prompt', async (t) => {
  const { db, event, time, start } = fixture(t, 'deadlock');
  const windows = await beginContest({ db, time, start });
  const first = roundPrompt(event, 'Deadlock', 1);
  const delivery = gate();
  const edit = first.edit.bind(first);
  first.edit = async (payload) => { await delivery.blocked; return edit(payload); };
  const picked = roundInteraction(first, 1, '5');
  const revision = roundInteraction(first, 1, '4');
  const pending = onMysteryButton(db, picked);
  let revised, timer;
  try {
    await flush();
    assert.match(picked.acknowledgements.at(-1), /Saved: 5/);
    revised = onMysteryButton(db, revision);
    await flush();
    assert.match(revision.acknowledgements.at(-1), /Saved: 4/);
    timer = time.advanceTo(windows.open(2));
    await flush();
    assert.ok(roundPrompt(event, 'Deadlock', 2), 'next prompt does not wait for old-card edits');
    assert.match(event.sent.map((item) => item.payload.content).join('\n'), /picked 4/);
    const stale = roundInteraction(first, 1, '1');
    await onMysteryButton(db, stale);
    assert.match(stale.acknowledgements.at(-1), /expired/);
  } finally {
    delivery.release();
    await Promise.all([pending, revised, timer]);
    await flush();
  }
  assert.match(JSON.stringify(first.components), /Round closed/);
  assert.doesNotMatch(JSON.stringify(first.components), /mystery:1:choice/);
});

test('new later-round participants save privately without editing an identical prompt', async (t) => {
  const { db, event, time, start } = fixture(t, 'deadlock');
  const windows = await beginContest({ db, time, start });
  await time.advanceTo(windows.open(2));
  const second = roundPrompt(event, 'Deadlock', 2);
  const picked = roundInteraction(second, 2, '3', '102');
  await onMysteryButton(db, picked);
  assert.match(picked.acknowledgements.at(-1), /Saved: 3/);
  assert.equal(second.edits.length, 0);
  await time.advanceTo(windows.close(2));
  assert.match(event.sent.at(-1).payload.content, /<@102>: picked 3/);
});

test('blocked final card close cannot hold results or prize delivery', async (t) => {
  const { db, event, time, start } = fixture(t, 'deadlock');
  const windows = await beginContest({ db, time, start });
  await onMysteryButton(db, roundInteraction(roundPrompt(event, 'Deadlock', 1), 1, '5'));
  await time.advanceTo(windows.open(3));
  const final = roundPrompt(event, 'Deadlock', 3);
  const delivery = gate();
  const edit = final.edit.bind(final);
  final.edit = async (payload) => { await delivery.blocked; return edit(payload); };
  const pending = time.advanceTo(windows.close(3) + 3000);
  try {
    await flush();
    const resultIndex = event.sent.findIndex((item) => item.payload.content?.includes('**Final standings**'));
    const prizeIndex = event.sent.findIndex((item) => item.embeds[0]?.data.title === 'Hidden Prize');
    assert.ok(resultIndex >= 0 && prizeIndex > resultIndex);
    assert.equal(getMysterySession(db, 1).state, 'claim_open');
  } finally {
    delivery.release();
    await pending;
    await flush();
  }
});

test('Doors confirms a durable choice privately while the public announcement is blocked', async (t) => {
  const { db, event, time, start } = fixture(t);
  await start();
  await time.advanceTo(6100);
  const delivery = gate();
  const send = event.send.bind(event);
  event.send = async (payload) => { await delivery.blocked; return send(payload); };
  const picked = doorInteraction(event.sent[1], '1');
  const pending = onMysteryButton(db, picked);
  try {
    await flush();
    assert.equal(getMysterySession(db, 1).state, 'countdown');
    assert.match(picked.acknowledgements.at(-1), /Choice locked in/);
  } finally {
    delivery.release();
    await pending;
  }
  await time.advanceTo(9100);
  assert.equal(getMysterySession(db, 1).state, 'claim_open');
});

for (const selected of ['1', '2']) test(`mystery ${selected === '1' ? 'winning' : 'unclaimable'} prize keeps frozen franchise fallback`, async t => {
  const { db, event, time, start } = fixture(t, 0, 0, true);
  db.exec("UPDATE franchises SET display_name='Renamed'");
  await start();
  await time.advanceTo(6100);
  await onMysteryButton(db, doorInteraction(event.sent[1], selected));
  await time.advanceTo(selected === '1' ? 9100 : 11100);
  const prize = event.sent.at(-1);
  assert.equal(prize.embeds[0].data.description, 'Alpha (+1 more)');
  assert.doesNotMatch(JSON.stringify(prize.payload), /Renamed/);
});
