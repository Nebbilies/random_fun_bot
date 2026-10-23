import { feedback } from './portal.js';

const status = document.querySelector('#status');
const customRatesList = document.querySelector('#customRatesList');

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

async function loadItems() {
  try {
    const response = await fetch('/api/game/items');
    if (!response.ok) throw new Error('Could not load items. Reload the page to retry.');
    items = await response.json();
    if (!items.length) throw new Error('No items are available.');
    itemSelect.replaceChildren(new Option('Select an item…', ''));
    for (const item of items) {
      itemSelect.add(new Option(`${item.name} · ${item.tier} · ${item.charges} charge${item.charges === 1 ? '' : 's'}`, item.id));
    }
    itemSelect.disabled = false;
    giveItemButton.disabled = false;
    itemDescription.textContent = 'Choose an item to see its description.';
  } catch (error) {
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

loadItems();

async function loadServerList() {
  if (!customRatesList) return;
  try {
    const res = await fetch('/api/game/rates');
    if (!res.ok) throw new Error('Failed to load server rates');
    const servers = await res.json();
    if (!servers.length) {
      customRatesList.innerHTML = '<p class="muted">No custom rates configured. All servers use default 1% vault and 1% prank rates.</p>';
      return;
    }
    const html = servers.map((s) => {
      const vPct = (s.vaultRate * 100).toFixed(1);
      const pPct = (s.prankRate * 100).toFixed(1);
      return `<div style="display: flex; justify-content: space-between; align-items: center; padding: 8px 6px; border-bottom: 1px solid var(--line);">
        <div>
          <strong>Server ${s.guildId}</strong>
          <span class="muted" style="margin-left: 8px;">Vault: ${vPct}% · Prank: ${pPct}%</span>
        </div>
        <button type="button" class="subtle" style="font-size: 11px; padding: 4px 8px;" data-guild="${s.guildId}" data-vault="${vPct}" data-prank="${pPct}">Edit</button>
      </div>`;
    }).join('');
    customRatesList.innerHTML = html;

    customRatesList.querySelectorAll('button[data-guild]').forEach((btn) => {
      btn.addEventListener('click', () => {
        document.querySelector('#guildId').value = btn.dataset.guild;
        document.querySelector('#vaultRate').value = btn.dataset.vault;
        document.querySelector('#prankRate').value = btn.dataset.prank;
        feedback(status, `Loaded rates for server ${btn.dataset.guild}`);
      });
    });
  } catch (err) {
    customRatesList.innerHTML = `<p class="muted">Could not load configured servers: ${err.message}</p>`;
  }
}

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

const rateForm = document.querySelector('#rateForm');
if (rateForm) {
  rateForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const guildId = document.querySelector('#guildId').value.trim();
    const vaultPct = Number(document.querySelector('#vaultRate').value);
    const prankPct = Number(document.querySelector('#prankRate').value);

    if (!/^\d+$/.test(guildId)) {
      status.textContent = 'Enter a valid numeric Discord Server (Guild) ID.';
      return;
    }
    if (isNaN(vaultPct) || vaultPct < 0 || vaultPct > 100) {
      status.textContent = 'Vault rate must be between 0% and 100%.';
      return;
    }
    if (isNaN(prankPct) || prankPct < 0 || prankPct > 100) {
      status.textContent = 'Prank rate must be between 0% and 100%.';
      return;
    }

    try {
      await apply('/api/game/rates', {
        guildId,
        vaultRate: vaultPct / 100,
        prankRate: prankPct / 100,
      }, `Custom rates saved for server ${guildId}: ${vaultPct}% vault, ${prankPct}% prank.`);
      loadServerList();
    } catch {}
  });

  document.querySelector('#loadRatesBtn')?.addEventListener('click', async () => {
    const guildId = document.querySelector('#guildId').value.trim();
    if (!/^\d+$/.test(guildId)) {
      feedback(status, 'Enter a valid numeric Guild ID first.', 'error');
      return;
    }
    try {
      const res = await fetch(`/api/game/rates?guildId=${guildId}`);
      if (!res.ok) throw new Error('Failed to fetch guild rates');
      const data = await res.json();
      document.querySelector('#vaultRate').value = (data.vaultRate * 100).toFixed(1);
      document.querySelector('#prankRate').value = (data.prankRate * 100).toFixed(1);
      feedback(status, `Loaded rates for server ${guildId}: ${(data.vaultRate * 100).toFixed(1)}% vault, ${(data.prankRate * 100).toFixed(1)}% prank.`);
    } catch (err) {
      feedback(status, err.message, 'error');
    }
  });

  loadServerList();
}
