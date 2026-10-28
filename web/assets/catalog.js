import { feedback } from './portal.js';

const $ = id => document.getElementById(id);
let current = null;
let pending = null;
let franchises = [];
let franchiseSelection = [];
let generation = 0;
let characterGeneration = 0;
let searchOffset = 0;
let searchQuery = '';
let searchGeneration = 0;
let auditOffset = 0;
let auditCharacter = '';
let auditGeneration = 0;
const pageSize = 50;
async function api(path, body) {
  const response = await fetch(`/api/catalog${path}`, body === undefined ? undefined : {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  const data = await response.json();
  if (!response.ok) {
    const error = new Error(data.error || `HTTP ${response.status}`);
    error.stale = data.refreshPreview;
    throw error;
  }
  return data;
}
function fail(error) { feedback($('message'), error.message, 'error'); }
const lines = id => $(id).value.split('\n').map(value => value.trim()).filter(Boolean);
const selectedFranchises = () => [...franchiseSelection];
let franchiseOpen = false;
let franchiseActive = -1;
let franchiseMatches = [];
function closeFranchisePicker() {
  franchiseOpen = false;
  $('franchiseOptions').hidden = true;
  $('franchiseSearch').setAttribute('aria-expanded', 'false');
  $('franchiseSearch').removeAttribute('aria-activedescendant');
}
function renderFranchiseOptions() {
  const query = $('franchiseSearch').value.trim().toLocaleLowerCase();
  franchiseMatches = franchises.filter(row => !franchiseSelection.includes(row.id)
    && [row.display_name, ...(row.aliases || [])].some(name => name.toLocaleLowerCase().includes(query)));
  if (franchiseActive >= franchiseMatches.length) franchiseActive = franchiseMatches.length - 1;
  const list = $('franchiseOptions');
  list.replaceChildren();
  franchiseMatches.forEach((row, index) => {
    const option = document.createElement('li');
    option.id = `franchise-option-${row.id}`;
    option.className = `picker-option${index === franchiseActive ? ' active' : ''}`;
    option.setAttribute('role', 'option');
    option.setAttribute('aria-selected', 'false');
    option.textContent = row.display_name;
    // Keep focus on the combobox so pointer and keyboard selection behave alike.
    option.addEventListener('mousedown', event => event.preventDefault());
    option.addEventListener('click', () => {
      setFranchiseSelection([...franchiseSelection, row.id], true);
      $('franchiseSearch').focus();
    });
    list.append(option);
  });
  if (!franchiseMatches.length) {
    const empty = document.createElement('li'); empty.className = 'picker-empty';
    empty.textContent = 'No matching unselected franchises.'; list.append(empty);
  }
  list.hidden = !franchiseOpen;
  $('franchiseSearch').setAttribute('aria-expanded', String(franchiseOpen));
  const active = franchiseOpen && franchiseMatches[franchiseActive];
  if (active) {
    $('franchiseSearch').setAttribute('aria-activedescendant', `franchise-option-${active.id}`);
    list.children[franchiseActive]?.scrollIntoView?.({ block: 'nearest' });
  } else $('franchiseSearch').removeAttribute('aria-activedescendant');
  $('franchiseSearchStatus').textContent = `${franchiseSelection.length} selected. ${franchiseMatches.length} available matches.`;
}
function renderFranchiseSelection() {
  const select = $('franchiseIds'); select.replaceChildren();
  for (const row of franchises) {
    const option = new Option(row.display_name, row.id);
    option.selected = franchiseSelection.includes(row.id); select.append(option);
  }
  $('franchiseChips').replaceChildren();
  for (const id of franchiseSelection) {
    const name = franchises.find(row => row.id === id)?.display_name || `Franchise #${id}`;
    // Retain authoritative memberships even if the list has not loaded yet.
    if (!franchises.some(row => row.id === id)) {
      const option = new Option(name, id); option.selected = true; select.append(option);
    }
    const chip = document.createElement('span'); chip.className = 'franchise-chip';
    const label = document.createElement('span'); label.textContent = name;
    const remove = document.createElement('button'); remove.type = 'button';
    remove.className = 'secondary'; remove.textContent = '×';
    remove.setAttribute('aria-label', `Remove ${name}`);
    remove.addEventListener('click', () => {
      setFranchiseSelection(franchiseSelection.filter(value => value !== id), true);
      $('franchiseSearch').focus();
    });
    chip.append(label, remove); $('franchiseChips').append(chip);
  }
  const required = !current || current.creationMethod === 'manual';
  $('franchiseSearch').setAttribute('aria-required', String(required));
  // A required hidden select cannot receive focus; validate the visible search instead.
  $('franchiseSearch').setCustomValidity(required && !franchiseSelection.length ? 'Select at least one direct franchise.' : '');
  renderFranchiseOptions();
}
function setFranchiseSelection(ids, edited = false) {
  const next = [...new Set(ids)];
  const changed = next.length !== franchiseSelection.length || next.some(id => !franchiseSelection.includes(id));
  franchiseSelection = next;
  if (edited && changed) {
    invalidate(); $('franchiseSearch').value = ''; franchiseActive = -1;
  }
  renderFranchiseSelection();
}
function invalidate() {
  generation++;
  pending = null; $('previewPanel').hidden = true;
  $('confirm').disabled = false;
}
function image(url, alt) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password) return null;
    const img = document.createElement('img'); img.src = parsed.href; img.alt = alt;
    img.width = 100; img.referrerPolicy = 'no-referrer'; return img;
  } catch { return null; }
}
async function showPreview(operation, body) {
  invalidate();
  const token = generation;
  let data;
  try { data = await api(`/${operation}/preview`, body); }
  catch (error) {
    if (token !== generation) return;
    if (operation === 'create' && body.input?.tagName && /tag/i.test(error.message)) {
      $('createTag').setCustomValidity(error.message);
      $('createTag').reportValidity();
    }
    throw error;
  }
  if (token !== generation) return;
  // A key belongs to this exact preview; failed confirmation retries never rotate it.
  pending = { operation, previewId: data.previewId, payloadHash: data.payloadHash, idempotencyKey: crypto.randomUUID() };
  $('previewDetails').open = false;
  $('previewData').textContent = JSON.stringify(data, null, 2);
  $('previewSummary').textContent = `Operation: ${operation}. ${data.rank != null ? `Final rank #${data.rank}. ` : ''}${data.favourites != null ? `${data.favourites} likes${data.likesSource === 'anilist' ? '' : ' [generated]'}. ` : ''}${operation === 'create' ? (data.tagName ? `Danbooru tag: ${data.tagName} (verified). ` : 'No Danbooru tag selected. ') : ''}Review neighbors and all changes below.`;
  $('duplicates').replaceChildren();
  for (const warning of data.duplicateWarnings || []) {
    const row = document.createElement('article');
    const heading = document.createElement('p'); heading.textContent = `Possible duplicate: ${warning.name} (${warning.id})`;
    const portrait = image(warning.portraitUrl, warning.name);
    const sources = document.createElement('p'); sources.textContent = `Sources: ${JSON.stringify(warning.sources || [])}`;
    const memberships = document.createElement('p');
    memberships.textContent = `Franchises: ${(warning.franchiseIds || []).map(id => franchises.find(row => row.id === id)?.display_name || `#${id}`).join(', ') || 'None'}`;
    const reuse = document.createElement('button'); reuse.type = 'button'; reuse.textContent = 'Reuse / edit this identity';
    reuse.addEventListener('click', () => loadCharacter(warning.id).catch(fail));
    row.append(heading); if (portrait) row.append(portrait); row.append(sources, memberships, reuse); $('duplicates').append(row);
  }
  $('sourceComparison').replaceChildren();
  if (operation === 'source') {
    const local = document.createElement('p'); local.textContent = `Local: ${current?.name_full} (${current?.id})`;
    const portrait = image(current?.image_url, 'Local portrait');
    $('sourceComparison').append(local); if (portrait) $('sourceComparison').append(portrait);
    // The verified remote identity and exact impact are shown unmodified in full preview.
    const remote = data.source || data.verifiedSource || data.verified;
    if (remote) {
      const text = document.createElement('p'); text.textContent = `Verified AniList identity: ${JSON.stringify(remote)}`;
      $('sourceComparison').append(text);
      const img = image(remote.portraitUrl || remote.imageUrl || remote.image?.large, 'Verified source portrait');
      if (img) $('sourceComparison').append(img);
    }
  }
  $('confirm').disabled = false;
  feedback($('message'), data.duplicateWarnings?.length
    ? 'Preview ready. Possible duplicates are shown below; you can still confirm to create or update this distinct identity. Nothing has been published.'
    : 'Preview ready. Nothing has been published.');
  $('previewPanel').hidden = false; $('previewPanel').focus();
}
async function loadFranchises(isActive = () => true) {
  const rows = await api('/franchises');
  if (!isActive()) return;
  const editing = $('franchiseEditId').value;
  franchises = rows;
  renderFranchiseSelection();
  $('franchiseEditId').replaceChildren(new Option('New franchise', ''));
  for (const row of franchises) $('franchiseEditId').append(new Option(row.display_name, row.id));
  if (franchises.some(row => String(row.id) === editing)) $('franchiseEditId').value = editing;
  else if (editing) {
    $('franchiseForm').reset();
    $('franchiseEditId').value = '';
    for (const id of ['franchiseName', 'franchiseAliases', 'coverUrl', 'franchiseReference']) $(id).value = '';
    invalidate();
  }
}
async function search(offset = 0, isActive = () => true) {
  const token = ++searchGeneration;
  const query = offset === 0 ? $('query').value.trim() : searchQuery;
  const data = await api(`/search?query=${encodeURIComponent(query)}&limit=${pageSize}&offset=${offset}`);
  if (token !== searchGeneration || !isActive()) return;
  searchOffset = offset; searchQuery = query;
  $('searchPrevious').disabled = offset === 0;
  $('searchNext').disabled = data.characters.length < pageSize;
  $('searchPage').textContent = `Page ${offset / pageSize + 1}`;
  $('results').replaceChildren();
  if (!data.characters.length) $('results').textContent = data.count ? 'No matches.' : 'The catalog is empty. Create a franchise and your first manual character below.';
  for (const row of data.characters) {
    const button = document.createElement('button'); button.type = 'button'; button.className = 'secondary';
    button.textContent = `#${row.rank} · ${row.name_full} · ${row.favourites} likes${row.likes_source === 'generated' ? ' [generated]' : ''}`;
    button.addEventListener('click', () => loadCharacter(row.id).catch(fail)); $('results').append(button);
  }
}
function editor(row = null) {
  characterGeneration++;
  invalidate(); current = row;
  franchiseSelection = [...(row?.franchiseIds || [])];
  $('editorTitle').textContent = row ? 'Edit character metadata' : 'New manual character';
  $('identity').textContent = row ? `${row.id} · ${row.creationMethod} · rank #${row.rank} · ${row.favourites} likes${row.likes_source === 'generated' ? ' [generated]' : ''}` : 'Identity and likes are generated server-side.';
  $('characterForm').reset(); $('createTag').setCustomValidity(''); $('portrait').hidden = true;
  const imported = row && row.creationMethod !== 'manual';
  for (const id of ['name', 'gender', 'portraitUrl', 'description']) $(id).disabled = Boolean(imported);
  $('franchiseSearch').value = ''; franchiseActive = -1;
  closeFranchisePicker(); renderFranchiseSelection();
  $('createRank').hidden = Boolean(row); $('rank').required = !row;
  $('createTagField').hidden = Boolean(row);
  $('existingActions').hidden = !row;
  $('sourceForm').reset(); $('tagForm').reset(); $('repositionForm').reset();
  if (!row) return;
  $('name').value = row.name_full || ''; $('aliases').value = row.aliases.join('\n');
  $('gender').value = ({ Female: 'female', Male: 'male', 'Non-binary': 'nonbinary' })[row.gender] || 'unknown';
  $('portraitUrl').value = row.image_url || ''; $('description').value = row.description || '';
  $('referenceUrl').value = row.referenceUrl || ''; $('targetRank').value = row.rank;
  $('externalId').value = row.sources.find(source => source.source === 'anilist')?.external_id || '';
  $('tag').value = row.tag?.tag_name || '';
  $('tagStatus').value = row.tag?.status || 'approve';
}
async function loadCharacter(id, isActive = () => true) {
  if (!isActive()) return;
  invalidate();
  const token = ++characterGeneration;
  const formToken = generation;
  const row = await api(`/detail?id=${encodeURIComponent(id)}`);
  if (token === characterGeneration && formToken === generation && isActive()) editor(row);
}
function onForm(id, action) {
  $(id).addEventListener('submit', async event => {
    event.preventDefault();
    const button = event.submitter; if (button) button.disabled = true;
    try { await action(); } catch (error) { fail(error); } finally { if (button) button.disabled = false; }
  });
}
onForm('searchForm', () => search());
$('searchPrevious').addEventListener('click', () => search(Math.max(0, searchOffset - pageSize)).catch(fail));
$('searchNext').addEventListener('click', () => search(searchOffset + pageSize).catch(fail));
$('newCharacter').addEventListener('click', () => editor());
$('previewPortrait').addEventListener('click', () => {
  const img = image($('portraitUrl').value, 'Portrait preview');
  if (!img) return fail(new Error('Use an HTTPS portrait URL without credentials.'));
  $('portrait').src = img.src; $('portrait').hidden = false;
});
for (const form of document.querySelectorAll('form:not(#searchForm)')) {
  const onEdit = event => { if (event.target !== $('franchiseSearch')) invalidate(); };
  form.addEventListener('input', onEdit);
  form.addEventListener('change', onEdit);
}
for (const event of ['input', 'change']) {
  $('franchiseIds').addEventListener(event, () => {
    setFranchiseSelection([...$('franchiseIds').selectedOptions].map(option => Number(option.value)), true);
  });
}
for (const event of ['focus', 'click']) {
  $('franchiseSearch').addEventListener(event, () => { franchiseOpen = true; renderFranchiseOptions(); });
}
$('franchiseSearch').addEventListener('input', () => {
  franchiseOpen = true; franchiseActive = -1; renderFranchiseOptions();
});
$('franchiseSearch').addEventListener('keydown', event => {
  if (event.isComposing) return;
  if (event.key === 'Escape') { event.preventDefault(); closeFranchisePicker(); }
  else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault(); franchiseOpen = true;
    const count = franchiseMatches.length;
    franchiseActive = count ? (franchiseActive < 0 ? (event.key === 'ArrowDown' ? 0 : count - 1)
      : (franchiseActive + (event.key === 'ArrowDown' ? 1 : -1) + count) % count) : -1;
    renderFranchiseOptions();
  } else if (event.key === 'Enter') {
    event.preventDefault(); // Never implicitly submit the character form from the picker.
    if (franchiseOpen && franchiseMatches[franchiseActive]) {
      setFranchiseSelection([...franchiseSelection, franchiseMatches[franchiseActive].id], true);
    }
  }
});
$('franchisePicker').addEventListener('focusout', event => {
  if (!$('franchisePicker').contains(event.relatedTarget)) closeFranchisePicker();
});
$('createTag').addEventListener('input', () => $('createTag').setCustomValidity(''));
renderFranchiseSelection();
onForm('characterForm', () => {
  const input = { aliases: lines('aliases'), franchiseIds: selectedFranchises(), referenceUrl: $('referenceUrl').value || null };
  if (!current || current.creationMethod === 'manual') Object.assign(input, {
    name: $('name').value, gender: $('gender').value, portraitUrl: $('portraitUrl').value,
    description: $('description').value || null, referenceUrl: $('referenceUrl').value || null,
  });
  if (current) input.characterId = current.id;
  else if ($('createTag').value.trim()) input.tagName = $('createTag').value.trim();
  return showPreview(current ? 'edit' : 'create', current ? { input } : { input, rank: Number($('rank').value) });
});
onForm('repositionForm', () => showPreview('reposition', { input: { characterId: current.id,
  rank: Number($('targetRank').value), switchToGenerated: $('switchGenerated').value === 'true' } }));
onForm('sourceForm', () => {
  const action = $('sourceOperation').value;
  const linked = current.sources.some(source => source.source === 'anilist');
  return showPreview('source', { operation: action === 'unlink' ? 'source-unlink' : action === 'switch_likes' ? 'imported-likes-adopt' : linked ? 'source-correct' : 'source-link',
    input: { characterId: current.id, source: 'anilist', ...(action === 'link' ? { externalId: $('externalId').value } : {}) } });
});
onForm('tagForm', () => showPreview('tag', { input: { characterId: current.id, status: $('tagStatus').value,
  ...($('tagStatus').value === 'approve' ? { tagName: $('tag').value } : {}) } }));
onForm('franchiseForm', () => showPreview('franchise', { operation: $('franchiseEditId').value ? 'franchise_edit' : 'franchise_create', input: {
  ...($('franchiseEditId').value ? { franchiseId: Number($('franchiseEditId').value) } : {}),
  displayName: $('franchiseName').value, aliases: lines('franchiseAliases'), coverUrl: $('coverUrl').value || null,
  referenceUrl: $('franchiseReference').value || null,
} }));
$('franchiseEditId').addEventListener('change', () => {
  const row = franchises.find(item => item.id === Number($('franchiseEditId').value));
  $('franchiseName').value = row?.display_name || ''; $('franchiseAliases').value = row?.aliases.join('\n') || '';
  $('coverUrl').value = row?.curated_cover_url || ''; $('franchiseReference').value = row?.reference_url || '';
});
$('confirm').addEventListener('click', async () => {
  if (!pending) return fail(new Error('Request a preview before confirming publication.'));
  $('confirm').disabled = true;
  const preview = pending;
  const { operation, ...body } = preview;
  let token = generation;
  let ownedPending = preview;
  const isActive = () => token === generation && pending === ownedPending;
  try {
    const result = await api(`/${operation}/confirm`, body);
    // Publication may finish server-side, but it no longer owns a newer session.
    if (!isActive()) return;
    invalidate(); token = generation; ownedPending = null;
    feedback($('message'), `Published successfully. ${JSON.stringify(result)}`, 'success');
    await loadFranchises(isActive);
    if (!isActive()) return;
    await search(0, isActive);
    if (!isActive()) return;
    if (result.characterId) {
      // loadCharacter invalidates on entry; transfer ownership to that generation.
      const loading = loadCharacter(result.characterId, isActive);
      token = generation;
      await loading;
    }
  } catch (error) {
    if (!isActive()) return;
    if (error.stale) { invalidate(); error.message += ' Your form is preserved. Request a new preview.'; }
    // Network/unknown errors retain pending and its exact idempotency key.
    fail(error);
  } finally { if (isActive()) $('confirm').disabled = false; }
});
async function audit(offset = 0) {
  const token = ++auditGeneration;
  const characterId = offset === 0 ? $('auditCharacter').value.trim() : auditCharacter;
  const rows = await api(`/audit?limit=${pageSize}&offset=${offset}&characterId=${encodeURIComponent(characterId)}`);
  if (token !== auditGeneration) return;
  auditOffset = offset; auditCharacter = characterId;
  $('auditData').textContent = JSON.stringify(rows, null, 2);
  $('auditPrevious').disabled = offset === 0;
  $('auditNext').disabled = rows.length < pageSize;
  $('auditPage').textContent = `Page ${offset / pageSize + 1}`;
}
$('audit').addEventListener('click', () => audit().catch(fail));
$('auditPrevious').addEventListener('click', () => audit(Math.max(0, auditOffset - pageSize)).catch(fail));
$('auditNext').addEventListener('click', () => audit(auditOffset + pageSize).catch(fail));
// The standalone franchise entrypoint has no character-review queue.
fetch('/api/status').then(response => {
  $('tagQueueLink').hidden = !response.ok;
  if (response.status === 404) {
    document.querySelector('nav a[href="/"]')?.setAttribute('hidden', '');
  }
}).catch(fail);
Promise.all([loadFranchises(), search()]).catch(fail);
