import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync, existsSync } from 'node:fs';

const source = readFileSync(new URL('../index.js', import.meta.url), 'utf8');

test('bot bootstrap logs the client in', () => {
  // Regression guard: a truncated index.js once dropped the login block, so the
  // service started, exited with status 0 and never connected to Discord.
  assert.match(source, /yoshiko\.client\.login\(config\.token\)/,
    'index.js must call yoshiko.client.login(config.token)');
});

test('retired reward inbox is not routable and old controls only receive a removal notice', async () => {
  assert.equal(existsSync(new URL('../commands/rewards.js', import.meta.url)), false);
  assert.doesNotMatch(source, /'rewards'/);
  const { run } = await import('../commands/help.js');
  let help;
  await run({ prefix: '?', message: { reply: async payload => { help = payload; } } });
  assert.doesNotMatch(JSON.stringify(help), /\*\*rewards\*\*/);
  // Exercise the retired-control branch without booting a Discord client or catalog.
  const start = source.indexOf("    // Retired inbox controls");
  const end = source.indexOf('    // Collector-only dialogs', start);
  assert.ok(start >= 0 && end > start);
  const retired = new Function('interaction', `return (async () => {${source.slice(start, end)}})();`);
  for (const customId of ['rewards:next', 'rewards:accept:reward', 'rewards:decline:reward', 'rewardreplace:choose']) {
    const replies = [];
    await retired({ customId, reply: async payload => replies.push(payload) });
    assert.equal(replies.length, 1);
    assert.equal(replies[0].ephemeral, true);
    assert.match(replies[0].content, /inbox has been removed/);
    assert.match(replies[0].content, /original reward card/);
    assert.doesNotMatch(replies[0].content, /Run the command again|[!?]rewards/);
  }
  await retired({ customId: 'vault:reward:replace', reply: async () => assert.fail('canonical controls must remain routable') });
});

test('search preparation follows awaited recovery and precedes game readiness', () => {
  const ready = source.indexOf('yoshiko.client.once(Events.ClientReady');
  const recovered = source.indexOf("await startup.run('post-client-ready'", ready);
  const prepared = source.indexOf("startup.runSync('search-cache'", recovered);
  const enabled = source.indexOf('gameRuntimeReady = true;', ready);
  const marker = source.indexOf("console.log('Character game ready.');", enabled);
  assert.ok(ready >= 0 && recovered > ready && prepared > recovered && enabled > prepared && marker > enabled);
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
