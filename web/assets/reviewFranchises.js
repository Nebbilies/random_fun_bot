import { feedback } from './portal.js';
import { createFranchisePicker } from './franchisePicker.js';

const byId = (id) => document.getElementById(id);
const apiBase = location.pathname.startsWith('/franchise') ? '/franchise' : '';
let franchises = [];
let currentId = null;
async function read(url, options) {
  const response = await fetch(url, options);
  const value = await response.json();
  if (!response.ok) throw new Error(value.error || `HTTP ${response.status}`);
  return value;
}
function loadFranchiseOptions(query, { excludeId } = {}) {
  const params = new URLSearchParams({ query: query ?? '', exclude: String(excludeId ?? 0) });
  return read(`${apiBase}/api/franchise-options?${params}`);
}
async function correct(body) {
  await read(`${apiBase}/api/correction`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  feedback(byId('message'), 'Changes saved.', 'success');
  await loadList();
  if (currentId && franchises.some((item) => item.id === currentId)) await loadDetails(currentId);
}
async function loadList() {
  franchises = await read(`${apiBase}/api/franchises?query=${encodeURIComponent(byId('search').value.trim())}`);
  byId('list').replaceChildren();
  if (!franchises.length) byId('list').textContent = 'No matching franchises.';
  for (const item of franchises) {
    const button = document.createElement('button');
    button.className = `franchise${item.id === currentId ? ' selected' : ''}`;
    button.setAttribute('aria-pressed', String(item.id === currentId));
    const name = document.createElement('span');
    name.className = 'franchise-name';
    name.textContent = item.name;
    const meta = document.createElement('span');
    meta.className = 'franchise-meta';
    meta.textContent = `${item.animeCount} anime · ${item.characterCount} characters · ${item.manualMembers} manual`;
    button.append(name, meta);
    button.addEventListener('click', () => loadDetails(item.id).catch(showError));
    byId('list').append(button);
  }
  byId('status').textContent = `${franchises.length} groups shown`;
  updateMergeTargets();
}
function updateMergeTargets() {
  mergePicker.reset();
}
async function loadDetails(id) {
  currentId = id;
  const data = await read(`${apiBase}/api/franchise?id=${id}`);
  byId('empty').hidden = true;
  byId('details').hidden = false;
  byId('name').textContent = data.name;
  byId('summary').textContent = `${data.characterCount} current catalog characters · ${data.members.length} anime (${data.automaticMembers} automatic, ${data.manualMembers} manual) · group name ${data.nameSource}`;
  byId('rename').value = data.name;
  byId('manual').textContent = `${data.manual.decisions} saved name, alias, or membership correction(s) for this group. Anime rows label automatic and manual memberships; manually excluded anime appear below.`;
  byId('aliases').replaceChildren();
  for (const alias of data.aliases) {
    const row = document.createElement('div');
    row.className = 'row';
    const label = document.createElement('span');
    label.textContent = `${alias.alias} · ${alias.source}`;
    row.append(label);
    if (alias.source === 'manual') {
      const remove = document.createElement('button');
      remove.className = 'secondary';
      remove.textContent = 'Remove alias';
      remove.addEventListener('click', () => correct({ action: 'remove_alias', franchiseId: id, alias: alias.alias }).catch(showError));
      row.append(remove);
    }
    byId('aliases').append(row);
  }
  byId('directCharacters').replaceChildren();
  const directCharacters = data.directCharacters ?? [];
  if (!directCharacters.length) byId('directCharacters').textContent = 'No directly assigned characters.';
  for (const character of directCharacters) {
    const row = document.createElement('p');
    row.className = 'row';
    row.textContent = `#${character.rank} · ${character.name}`;
    byId('directCharacters').append(row);
  }
  byId('members').replaceChildren();
  if (!data.members.length) byId('members').textContent = 'No anime members. Characters can belong directly to this franchise without an anime.';
  for (const member of data.members) {
    const section = document.createElement('article');
    section.className = 'member';
    const heading = document.createElement('h3');
    heading.textContent = member.title;
    const info = document.createElement('p');
    const year = member.seasonYear || member.startDate?.year || 'year unknown';
    info.textContent = `AniList #${member.id} · ${member.format || 'format unknown'} · ${year} · ${member.characterCount} catalog characters · ${member.membershipSource} membership`;
    const links = document.createElement('p');
    links.className = 'muted';
    links.textContent = `Relations: ${member.relations.length ? member.relations.join(', ') : 'none within this group'}`;
    const controls = document.createElement('div');
    controls.className = 'row';
    const moveButton = document.createElement('button'); moveButton.className = 'secondary'; moveButton.textContent = 'Move';
    moveButton.disabled = true;
    const move = createFranchisePicker({
      loadOptions: loadFranchiseOptions,
      excludeId: id,
      placeholder: 'Search franchises…',
      ariaLabel: `Move ${member.title} to another franchise`,
      onSelect: () => { moveButton.disabled = !move.selection; },
    });
    moveButton.addEventListener('click', () => {
      const target = move.selection;
      if (!target) return;
      correct({ action: 'move_anime', animeId: member.id, franchiseId: target.id }).catch(showError);
    });
    const splitName = document.createElement('input'); splitName.type = 'text'; splitName.placeholder = 'New group name'; splitName.setAttribute('aria-label', `New group name for ${member.title}`);
    const splitButton = document.createElement('button'); splitButton.className = 'secondary'; splitButton.textContent = 'Split into new group';
    splitButton.addEventListener('click', async () => {
      try {
        const result = await read(`${apiBase}/api/correction`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'create', name: splitName.value }) });
        currentId = result.franchiseId;
        byId('search').value = '';
        await correct({ action: 'move_anime', animeId: member.id, franchiseId: result.franchiseId });
      } catch (error) { showError(error); }
    });
    const removeButton = document.createElement('button'); removeButton.className = 'danger'; removeButton.textContent = 'Remove from all groups';
    removeButton.addEventListener('click', () => correct({ action: 'remove_anime', animeId: member.id }).catch(showError));
    controls.append(move.element, moveButton, splitName, splitButton, removeButton);
    section.append(heading, info, links, controls);
    byId('members').append(section);
  }
  await loadExcluded();
  updateMergeTargets();
  await loadList();
}
async function loadExcluded() {
  const items = await read(`${apiBase}/api/unassigned`);
  byId('excluded').replaceChildren();
  if (!items.length) { byId('excluded').textContent = 'No manually excluded anime.'; return; }
  for (const item of items) {
    const row = document.createElement('div'); row.className = 'row';
    const title = document.createElement('span');
    title.textContent = `${item.title} · AniList #${item.id} · ${item.characterCount} current characters`;
    const restore = document.createElement('button'); restore.className = 'secondary'; restore.textContent = 'Restore to franchise';
    restore.disabled = true;
    const select = createFranchisePicker({
      loadOptions: loadFranchiseOptions,
      placeholder: 'Search franchises…',
      ariaLabel: `Restore ${item.title} to a franchise`,
      onSelect: () => { restore.disabled = !select.selection; },
    });
    restore.addEventListener('click', () => {
      const target = select.selection;
      if (!target) return;
      correct({ action: 'move_anime', animeId: item.id, franchiseId: target.id }).catch(showError);
    });
    row.append(title, select.element, restore); byId('excluded').append(row);
  }
}
function showError(error) { feedback(byId('message'), error.message, 'error'); }
byId('search').addEventListener('input', () => loadList().catch(showError));
byId('create').addEventListener('click', async () => {
  const name = window.prompt('Name for the new franchise:');
  if (!name) return;
  try {
    const result = await read(`${apiBase}/api/correction`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'create', name }) });
    await loadList(); await loadDetails(result.franchiseId);
  } catch (error) { showError(error); }
});
byId('renameButton').addEventListener('click', () => correct({ action: 'rename', franchiseId: currentId, name: byId('rename').value }).catch(showError));
byId('addAlias').addEventListener('click', () => correct({ action: 'add_alias', franchiseId: currentId, alias: byId('alias').value }).catch(showError));
const mergePicker = createFranchisePicker({
  loadOptions: loadFranchiseOptions,
  excludeId: () => currentId,
  placeholder: 'Search franchises…',
  ariaLabel: 'Merge this group into',
  onSelect: () => { byId('merge').disabled = !mergePicker.selection; },
});
byId('mergeTarget').append(mergePicker.element);
byId('merge').disabled = true;
byId('merge').addEventListener('click', () => {
  const target = mergePicker.selection;
  if (!currentId || !target) return;
  if (window.confirm(`Merge ${byId('name').textContent} into ${target.name}?`))
    correct({ action: 'merge', sourceId: currentId, targetId: target.id }).then(() => { currentId = null; byId('details').hidden = true; byId('empty').hidden = false; }).catch(showError);
});
loadList().catch(showError);
