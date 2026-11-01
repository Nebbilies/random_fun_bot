import './portal.js';
const el = id => document.getElementById(id);
let offset = 0;
async function api(path, input) {
  const response = await fetch(`/api/gender/${path}`, input ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) } : {});
  const value = await response.json();
  if (!response.ok) throw new Error(value.error);
  return value;
}
function button(label, action) {
  const node = document.createElement('button'); node.textContent = label;
  node.addEventListener('click', async () => {
    node.disabled = true;
    try { await action(); } catch (error) { el('feedback').textContent = error.message; }
    finally { node.disabled = false; }
  }); return node;
}
async function resolve(row, action, gender) {
  await api('resolve', { characterId: row.id, caseId: row.caseId, revision: row.revision, action, ...(gender ? { gender } : {}) });
  el('feedback').textContent = 'Review saved.';
  await load();
}
function card(row, overrideOnly = false) {
  const section = document.createElement('section');
  const title = document.createElement('h3'); title.textContent = row.name; section.append(title);
  if (!overrideOnly && row.imageUrl) {
    try {
      const url = new URL(row.imageUrl);
      if (url.protocol === 'https:') {
        const image = document.createElement('img'); image.src = url.href; image.alt = row.name;
        image.loading = 'lazy'; image.referrerPolicy = 'no-referrer'; image.width = 180;
        section.append(image);
      }
    } catch { /* Missing or invalid portraits do not block review. */ }
  }
  const info = document.createElement('p'); info.textContent = `Current: ${row.gender} · ${row.reportCount} open reports${row.hasOverride ? ` · Source: ${row.sourceGender}` : ''}`; section.append(info);
  if (!overrideOnly) {
    const select = document.createElement('select'); select.setAttribute('aria-label', 'Correct gender');
    for (const gender of ['Female', 'Male', 'Non-binary', 'Unknown']) {
      const option = document.createElement('option'); option.textContent = gender; option.selected = gender === row.gender; select.append(option);
    }
    section.append(select, button('Correct gender', () => resolve(row, 'correct', select.value)), button('Dismiss reports', () => resolve(row, 'dismiss')));
  }
  if (row.hasOverride) section.append(button('Use source gender', () => resolve(row, 'source')));
  return section;
}
async function history(reset = false) {
  if (reset) { offset = 0; el('history').replaceChildren(); }
  const rows = await api(`history?offset=${offset}`); offset += rows.length;
  for (const row of rows) {
    const text = document.createElement('p');
    text.textContent = `${row.name} · ${row.outcome} · ${row.before_gender ?? 'Unknown'} → ${row.after_gender ?? 'Unknown'} · ${row.account} (${row.role}) · ${row.reportCount} reports · ${new Date(row.resolved_at).toLocaleString()}`;
    el('history').append(text);
  }
  el('more').hidden = rows.length < 50;
}
async function load() {
  const [row, overrides] = await Promise.all([api('next'), api('overrides')]);
  el('case').replaceChildren(row ? card(row) : document.createTextNode('No open gender reports.'));
  el('overrides').replaceChildren(...overrides.map(row => card(row, true)));
  await history(true);
}
el('more').addEventListener('click', () => history().catch(error => { el('feedback').textContent = error.message; }));
load().catch(error => { el('feedback').textContent = error.message; });
