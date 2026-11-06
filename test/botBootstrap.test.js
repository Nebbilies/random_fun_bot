import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../index.js', import.meta.url), 'utf8');

test('bot bootstrap logs the client in', () => {
  // Regression guard: a truncated index.js once dropped the login block, so the
  // service started, exited with status 0 and never connected to Discord.
  assert.match(source, /yoshiko\.client\.login\(config\.token\)/,
    'index.js must call yoshiko.client.login(config.token)');
});

test('search preparation follows recovery and precedes game readiness', () => {
  const ready = source.indexOf('yoshiko.client.once(Events.ClientReady');
  const recovered = source.indexOf('cleanupExpiredItems(yoshiko.catalogDb);', ready);
  const prepared = source.indexOf('catalogCache.get();', recovered);
  const enabled = source.indexOf('gameRuntimeReady = true;', ready);
  assert.ok(ready >= 0 && recovered > ready && prepared > recovered && enabled > prepared);
});

function handlerBlocks(registration) {
  return [...source.matchAll(new RegExp(`${registration}[\\s\\S]*?\\n\\}\\);`, 'g'))].map((match) => match[0]);
}

test('bot bootstrap registers utility commands on ready and on guild create', () => {
  const readyBlocks = handlerBlocks('yoshiko\\.client\\.once\\(Events\\.ClientReady');
  assert.ok(readyBlocks.some((block) => block.includes('registerUtilityCommands')),
    'an Events.ClientReady handler must register utility commands');

  const guildBlocks = handlerBlocks('yoshiko\\.client\\.on\\(Events\\.GuildCreate');
  assert.ok(guildBlocks.some((block) => block.includes('registerUtilityCommands')),
    'an Events.GuildCreate handler must register utility commands');
});
