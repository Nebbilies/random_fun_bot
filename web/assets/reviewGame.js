import { feedback } from './portal.js';

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
    feedback(target, success, 'success');
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
