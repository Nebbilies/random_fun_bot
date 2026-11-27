import { feedback } from './portal.js';

const weeklyGuild = document.querySelector('#weeklyGuildId');
const weeklySettings = document.querySelector('#weeklySettingsForm');
const weeklyEnabled = document.querySelector('#weeklyEnabled');
const weeklyChannel = document.querySelector('#weeklyChannel');
const weeklyTheme = document.querySelector('#weeklyTheme');
const weeklyStatus = document.querySelector('#weeklyStatus');
const weeklyUrl = '/api/game/weekly-events';

function showWeekly({ guildId, controls, contest, themes, errors, schedule }) {
  if (guildId !== weeklyGuild.value.trim()) return;
  weeklySettings.hidden = false;
  weeklyEnabled.checked = Boolean(controls?.enabled);
  weeklyChannel.value = controls?.channel_id ?? '';
  weeklyTheme.replaceChildren(new Option('Random', ''), ...Object.entries(themes).map(([id, [label]]) => new Option(label, id)));
  weeklyTheme.value = controls?.next_theme ?? '';
  const day = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][schedule.day];
  const time = [Math.floor(schedule.minute / 60), schedule.minute % 60].map(value => String(value).padStart(2, '0')).join(':');
  const state = contest ? `${themes[contest.theme][0]} ends ${new Date(contest.ends_at).toLocaleString()}.` : 'No active contest.';
  const problems = errors?.map(error => ` ${error.kind}: ${error.last_error}`).join('') ?? '';
  document.querySelector('#weeklyDetails').textContent = `${state} Configured start: ${day} ${time} game time.${problems}`;
}

weeklyGuild.addEventListener('input', () => { weeklySettings.hidden = true; });
document.querySelector('#weeklyLoadForm').addEventListener('submit', async event => {
  event.preventDefault();
  try {
    const response = await fetch(`${weeklyUrl}?guildId=${encodeURIComponent(weeklyGuild.value.trim())}`);
    const result = await response.json();
    if (!response.ok) throw new Error(result.error);
    showWeekly(result);
    feedback(weeklyStatus, 'Weekly Events loaded.', 'success');
  } catch (error) { feedback(weeklyStatus, error.message, 'error'); }
});
weeklySettings.addEventListener('submit', async event => {
  event.preventDefault();
  try {
    showWeekly(await apply(weeklyUrl, { guildId: weeklyGuild.value.trim(), enabled: weeklyEnabled.checked,
      channelId: weeklyChannel.value.trim(), nextTheme: weeklyTheme.value || null }, 'Weekly Event settings saved.', weeklyStatus));
  } catch { /* apply displays the failure. */ }
});

const status = document.querySelector('#status');

async function apply(path, body, success, target = status) {
  const buttons = document.querySelectorAll('button');
  const disabledStates = [...buttons].map((button) => button.disabled);
  buttons.forEach((button) => { button.disabled = true; });
  feedback(target, 'Applying changes…');
  target.setAttribute('aria-busy', 'true');
  try {
    const response = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Action failed.');
    const skipped = result.skippedGuilds?.length ? ` Skipped servers at rollover: ${result.skippedGuilds.join(', ')}.` : '';
    feedback(target, success + skipped, 'success');
    return result;
  } catch (error) {
    feedback(target, error.message, 'error');
    throw error;
  } finally {
    buttons.forEach((button, index) => { button.disabled = disabledStates[index]; });
    target.removeAttribute('aria-busy');
  }
}

const itemSelect = document.querySelector('#itemSelect');
const itemDescription = document.querySelector('#itemDescription');
const giveItemButton = document.querySelector('#giveItemButton');
const giveItemStatus = document.querySelector('#giveItemStatus');
let items = [];
let itemLoadVersion = 0;

async function loadItems() {
  const version = ++itemLoadVersion;
  const guildId = document.querySelector('#itemGuildId').value.trim();
  itemSelect.disabled = true;
  giveItemButton.disabled = true;
  try {
    if (guildId && !/^[1-9]\d{0,19}$/.test(guildId)) throw new Error('Enter a valid server ID to load its item rules.');
    const response = await fetch(`/api/game/items${guildId ? `?guildId=${encodeURIComponent(guildId)}` : ''}`);
    if (!response.ok) throw new Error('Could not load items. Reload the page to retry.');
    const result = await response.json();
    if (version !== itemLoadVersion) return;
    items = result;
    if (!items.length) throw new Error('No items are available.');
    itemSelect.replaceChildren(new Option('Select an item…', ''));
    for (const item of items) {
      itemSelect.add(new Option(`${item.name} · ${item.tier} · ${item.charges} charge${item.charges === 1 ? '' : 's'}`, item.id));
    }
    itemSelect.disabled = false;
    giveItemButton.disabled = false;
    itemDescription.textContent = 'Choose an item to see its description.';
  } catch (error) {
    if (version !== itemLoadVersion) return;
    items = [];
    itemSelect.replaceChildren(new Option('Items unavailable', ''));
    itemDescription.textContent = error.message;
    feedback(giveItemStatus, error.message, 'error');
  }
}

itemSelect.addEventListener('change', () => {
  const item = items.find((entry) => entry.id === itemSelect.value);
  itemDescription.textContent = item?.description || 'Choose an item to see its description.';
});

document.querySelector('#giveItemForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const guildId = document.querySelector('#itemGuildId').value.trim();
  const userId = document.querySelector('#itemUserId').value.trim();
  const item = items.find((entry) => entry.id === itemSelect.value);
  if (!/^[1-9]\d{0,19}$/.test(guildId) || !/^[1-9]\d{0,19}$/.test(userId) || !item) {
    feedback(giveItemStatus, 'Enter valid server and user IDs, then select an item.', 'error');
    return;
  }
  try {
    await apply('/api/game/give-item', { guildId, userId, itemId: item.id },
      `Gave ${item.name} to user ${userId} in server ${guildId}.`, giveItemStatus);
  } catch { /* apply displays the error beside the form. */ }
});

document.querySelector('#itemGuildId').addEventListener('input', loadItems);
loadItems();

document.querySelector('#rollForm').addEventListener('submit', (event) => {
  event.preventDefault();
  const amount = Number(document.querySelector('#amount').value);
  if (!Number.isSafeInteger(amount) || amount < 1) {
    status.textContent = 'Enter a positive whole number of rolls.';
    return;
  }
  apply('/api/game/add-rolls', { amount }, `Added up to ${amount} rolls per user across all servers, capped at each server's maximum.`);
});

document.querySelector('#resetClaims').addEventListener('click', () => {
  apply('/api/game/reset-claims', {}, 'Claims reset. Every user can claim again across all servers.');
});

const seasonGuild = document.querySelector('#seasonGuildId');
const seasonChannel = document.querySelector('#seasonChannelId');
const seasonDays = document.querySelector('#seasonDays');
const seasonDetails = document.querySelector('#seasonDetails');
const seasonStatus = document.querySelector('#seasonStatus');
const seasonSettings = document.querySelector('#seasonSettingsForm');
const seasonPreview = document.querySelector('#seasonPreview');
const seasonCancel = document.querySelector('#seasonCancel');
const date = time => new Date(time).toLocaleString();
let loadedSeason;
let seasonRefresh;

async function getSeason(action, guildId) {
  const response = await fetch(`/api/game/seasons${action}?guildId=${encodeURIComponent(guildId)}`);
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'Could not load season.');
  return result;
}

function refreshPendingSeason(result) {
  const {rollover} = result;
  if (!rollover || !['queued','posting'].includes(rollover.phase)) return;
  seasonRefresh = setTimeout(async () => {
    try {
      const fresh = await getSeason('',result.guildId);
      if (loadedSeason === result) showSeason(fresh, false);
    } catch {
      if (loadedSeason === result) refreshPendingSeason(result);
    }
  }, 2000);
}

function showSeason(result, updateSettings = true) {
  if (seasonGuild.value.trim() !== result.guildId) return;
  clearTimeout(seasonRefresh);
  loadedSeason = result;
  const {current,settings,rollover,lastRollover,targetAt,deliveries,canCancel,canAbandonReminder} = result;
  seasonSettings.hidden = false;
  if (updateSettings) {
    seasonChannel.value = settings.channel_id ?? '';
    seasonDays.value = settings.target_days;
  }
  const details = [`Season ${current.season}`];
  if (targetAt) details.push(`Target date ${date(targetAt)}`);
  if (settings.channel_id && settings.channel_checked_at == null) details.push('Waiting for the bot to verify the channel.');
  if (settings.channel_error) details.push(settings.channel_error);
  if (rollover && rollover.phase !== 'canceled') details.push(
    `Reminder ${rollover.announced_at == null ? 'pending' : `posted ${date(rollover.announced_at)}`}. Cutoff ${date(rollover.cutoff_at)}. Status: ${rollover.phase}.`);
  if (rollover?.last_error) details.push(rollover.last_error);
  if (lastRollover) details.push(`Last rollover ${date(lastRollover.completed_at)}`);
  for (const {kind,state,count,error} of deliveries) details.push(`${count} ${kind} ${state}${error ? `: ${error}` : ''}`);
  seasonDetails.textContent = details.join(' · ');
  seasonCancel.hidden = !canCancel && !canAbandonReminder;
  seasonCancel.textContent = canAbandonReminder ? 'Abandon unconfirmed reminder' : 'Cancel rollover';
  seasonPreview.disabled = !settings.channel_checked_at || Boolean(settings.channel_error)
    || Boolean(rollover && ['queued','posting','announced'].includes(rollover.phase));
  refreshPendingSeason(result);
}

seasonGuild.addEventListener('input', () => { clearTimeout(seasonRefresh); loadedSeason = undefined; seasonSettings.hidden = true; });
document.querySelector('#seasonLoadForm').addEventListener('submit', async event => {
  event.preventDefault();
  try {
    showSeason(await getSeason('',seasonGuild.value.trim()));
    feedback(seasonStatus,'Season loaded.','success');
  } catch (error) { feedback(seasonStatus,error.message,'error'); }
});
seasonSettings.addEventListener('submit', async event => {
  event.preventDefault();
  if (!loadedSeason) return;
  try {
    showSeason(await apply('/api/game/seasons/settings',{guildId:loadedSeason.guildId,
      channelId:seasonChannel.value.trim(),targetDays:Number(seasonDays.value),revision:loadedSeason.settings.revision},
      'Season settings saved. Reload season to check channel verification.',seasonStatus));
  } catch { /* apply displays the error. */ }
});
seasonPreview.addEventListener('click', async () => {
  const guildId = loadedSeason?.guildId;
  if (!guildId) return;
  try {
    const preview = await getSeason('/preview',guildId);
    const description = `Schedule Season ${preview.season} → ${preview.season+1} for server ${guildId}?\nChannel ${preview.channelId}\nReminder on confirmation\nCutoff at the next claim reset, ${date(preview.cutoffAt)}`;
    if (!window.confirm(description)) return;
    showSeason(await apply('/api/game/seasons/confirm',{guildId,preview},'Season reminder queued.',seasonStatus));
  } catch (error) { feedback(seasonStatus,error.message,'error'); }
});
seasonCancel.addEventListener('click', async () => {
  if (!loadedSeason?.rollover) return;
  const abandonUnconfirmed = loadedSeason.canAbandonReminder;
  if (abandonUnconfirmed && !window.confirm('Discord may have posted this reminder. Abandon the rollover and resume the current season?')) return;
  try {
    showSeason(await apply('/api/game/seasons/cancel',{guildId:loadedSeason.guildId,revision:loadedSeason.rollover.revision,abandonUnconfirmed},
      abandonUnconfirmed ? 'Unconfirmed reminder abandoned. The current season has resumed.' : 'Rollover canceled. The current season continues.',seasonStatus));
  } catch { /* apply displays the error. */ }
});
