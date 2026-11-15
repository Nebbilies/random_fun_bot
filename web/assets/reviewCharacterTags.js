import { feedback } from './portal.js';

const byId = (id) => document.getElementById(id);
let current = null;
let after = Math.max(0, Number(localStorage.getItem('character-review-rank')) || 0);
let selected = '';
let mode = 'undecided';
let historyOffset = 0;
let previewRequest = 0;
let navigationRequest = 0;
let efficiencyRanking = false;
let pendingDecision = null;
let decisionVersion = 0;
let confirmingDecision = false;
function invalidateDecision() {
  decisionVersion++;
  pendingDecision = null;
  byId('decisionPreview').hidden = true;
  byId('confirmDecision').disabled = true;
  return decisionVersion;
}
function advance(rank) { after = rank; localStorage.setItem('character-review-rank', String(rank)); }
const safeUrl = (value) => { try { const url = new URL(value); return url.protocol === 'https:' ? url.href : ''; } catch { return ''; } };
async function read(url, options) {
  const response = await fetch(url, options);
  const value = await response.json();
  if (!response.ok) throw new Error(value.error || `HTTP ${response.status}`);
  return value;
}
async function status() {
  const data = await read('/api/status');
  efficiencyRanking = data.efficiencyRanking === true;
  byId('status').replaceChildren();
  const cards = [
    ['Undecided characters', data.queue, 'Ready for your review', '#9c76df'],
    ['Reported characters', data.reports, 'Community feedback', '#df9b78'],
    ['Manual decisions', data.manual, 'Reviewed by a person', '#6ba89b'],
    ['Automatic matches', data.automatic, `${data.matched.toLocaleString()}/${data.total.toLocaleString()} characters searched`, '#86a0d1'],
  ];
  for (const [label, value, note, color] of cards) {
    const card = document.createElement('div');
    card.className = 'stat-card';
    card.style.setProperty('--stat-color', color);
    for (const [className, text] of [['stat-label', label], ['stat-value', value.toLocaleString()], ['stat-note', note]]) {
      const element = document.createElement('span');
      element.className = className;
      element.textContent = text;
      card.append(element);
    }
    byId('status').append(card);
  }
}
function tagOption(tag, container) {
  const label = document.createElement('label');
  label.className = 'candidate';
  const radio = document.createElement('input');
  radio.type = 'radio';
  radio.name = 'tag';
  radio.value = tag.name;
  radio.checked = tag.name === selected;
  radio.addEventListener('change', () => { invalidateDecision(); selected = tag.name; byId('custom').value = ''; preview(); });
  const copy = document.createElement('span');
  copy.className = 'candidate-copy';
  const name = document.createElement('span');
  name.className = 'candidate-name';
  name.textContent = tag.name;
  const meta = document.createElement('span');
  meta.className = 'candidate-meta';
  meta.textContent = `${(tag.postCount ?? tag.post_count ?? 0).toLocaleString()} posts${tag.reason ? ` · ${tag.reason}` : ''}`;
  copy.append(name, meta);
  label.append(radio, copy);
  container.append(label);
}
async function navigate(direction = 'resume') {
  invalidateDecision();
  previewRequest++;
  const request = ++navigationRequest;
  feedback(byId('message'), '');
  const rank = direction === 'jump' ? Number(byId('jumpRank').value) : current?.rank ?? after;
  const url = mode === 'reported' ? '/api/reports/next' : direction === 'first' ? '/api/next?after=0'
    : direction === 'last' ? '/api/next?last=1'
    : direction === 'back' ? `/api/next?before=${current ? rank : rank + 1}`
    : `/api/next?after=${direction === 'resume' ? after : rank}`;
  const row = await read(url);
  if (request !== navigationRequest) return;
  if (!row && mode === 'undecided' && direction === 'back') {
    byId('message').textContent = 'Beginning of queue.';
    return;
  }
  if (!row && mode === 'undecided' && (direction === 'forward' || direction === 'jump')) advance(rank);
  current = row;
  byId('tagWorkspace').hidden = !row;
  byId('candidates').replaceChildren();
  byId('previews').replaceChildren();
  byId('soloPreviews').replaceChildren();
  byId('previewQuery').textContent = '';
  byId('soloQuery').textContent = '';
  byId('searchResults').replaceChildren();
  byId('custom').value = '';
  selected = row?.decision?.tag_name || row?.candidates?.[0]?.name || '';
  byId('reportDetails').textContent = row ? `${row.reportCount} report${row.reportCount === 1 ? '' : 's'} · oldest ${new Date(row.firstReportedAt).toLocaleString()}` : 'No open reports.';
  byId('currentTag').textContent = row?.decision?.tag_name || 'No tag';
  if (!row) {
    byId('name').textContent = mode === 'reported' || direction === 'first' || direction === 'last' ? 'All caught up' : 'End of queue';
    byId('position').textContent = '';
    byId('details').textContent = mode === 'reported' ? 'No reported characters need review.' : 'Use Back or First to revisit characters.';
    byId('portrait').hidden = true;
    byId('anilist').hidden = true;
    byId('googleSearch').hidden = true;
    return;
  }
  if (mode === 'undecided') advance(row.rank - 1);
  byId('name').textContent = row.name;
  byId('position').textContent = `Rank ${row.rank.toLocaleString('en-US')}`;
  byId('details').textContent = `${row.nativeName || ''}\n${row.animeTitles.join(' · ')}${row.adultAnime ? ' · adult anime' : ''}${row.decision?.source === 'automatic' ? ' · automatic match audit' : ''}`;
  byId('details').style.whiteSpace = 'pre-line';
  byId('portrait').alt = `Portrait of ${row.name}`;
  byId('portrait').src = safeUrl(row.imageUrl);
  byId('portrait').hidden = !safeUrl(row.imageUrl);
  byId('anilist').href = safeUrl(row.siteUrl);
  byId('anilist').hidden = !safeUrl(row.siteUrl);
  byId('googleSearch').hidden = false;
  row.candidates.forEach((tag) => tagOption(tag, byId('candidates')));
  if (!row.candidates.length) byId('candidates').textContent = 'No candidates found. Search or mark no match.';
  if (selected) await preview();
}
async function preview() {
  const tag = byId('custom').value.trim() || selected;
  const request = ++previewRequest;
  const show = async (solo, container, queryLabel) => {
    queryLabel.textContent = tag ? `${tag} order:score${solo ? ' · filtered to solo posts' : ''}` : '';
    container.textContent = tag ? 'Loading previews…' : 'Select a tag to preview.';
    if (!tag) return;
    try {
      const urls = await read(`/api/preview?tag=${encodeURIComponent(tag)}${solo ? '&solo=1' : ''}`);
      if (request !== previewRequest) return;
      container.replaceChildren();
      if (!urls.length) container.textContent = solo ? 'No solo preview found among the top scored posts checked.' : 'No preview found.';
      urls.forEach((url) => { const img = document.createElement('img'); img.src = safeUrl(url); img.alt = `${tag}${solo ? ' solo' : ''} preview`; container.append(img); });
    } catch (error) { if (request === previewRequest) container.textContent = error.message; }
  };
  await Promise.all([
    show(false, byId('previews'), byId('previewQuery')),
    show(true, byId('soloPreviews'), byId('soloQuery')),
  ]);
}
async function decide(decision) {
  if (!current) return;
  const version = invalidateDecision();
  const tag = byId('custom').value.trim() || selected;
  if ((decision === 'approve' || decision === 'corrected') && !tag) { byId('message').textContent = 'Select or enter a tag.'; return; }
  try {
    if (efficiencyRanking && decision !== 'dismissed') {
      const endpoint = mode === 'reported' ? '/api/reports/resolve' : '/api/decision';
      const body = mode === 'reported' ? { characterId: current.id, outcome: decision, tag } : { characterId: current.id, status: decision, tag };
      const preview = await read(endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...body, preview: true }) });
      if (version !== decisionVersion) return;
      pendingDecision = { endpoint, body: { ...body, previewId: preview.previewId, payloadHash: preview.payloadHash, idempotencyKey: crypto.randomUUID() } };
      byId('decisionPreviewText').textContent = `${preview.warning || ''} Verified count: ${preview.danbooru_post_count ?? 'NULL'}. Efficiency: ${preview.efficiency}. Proposed rank: #${preview.rank}.`;
      byId('decisionPreview').hidden = false;
      byId('confirmDecision').disabled = confirmingDecision;
      return;
    }
    await read(mode === 'reported' ? '/api/reports/resolve' : '/api/decision', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(mode === 'reported'
        ? { characterId: current.id, outcome: decision, tag }
        : { characterId: current.id, status: decision, tag }),
    });
    await status();
    await navigate('forward');
    if (mode === 'reported') await loadHistory(true);
  } catch (error) { if (version === decisionVersion) feedback(byId('message'), error.message, 'error'); }
}
byId('confirmDecision').addEventListener('click', async () => {
  if (!pendingDecision || confirmingDecision) return;
  const decision = pendingDecision, version = decisionVersion;
  confirmingDecision = true;
  byId('confirmDecision').disabled = true;
  try {
    await read(decision.endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(decision.body) });
    if (version !== decisionVersion) return;
    invalidateDecision();
    await status(); await navigate('forward');
    if (mode === 'reported') await loadHistory(true);
  } catch (error) { if (version === decisionVersion) feedback(byId('message'), error.message, 'error'); }
  finally { confirmingDecision = false; byId('confirmDecision').disabled = !pendingDecision; }
});
byId('custom').addEventListener('input', invalidateDecision);
async function loadHistory(reset = false) {
  if (reset) { historyOffset = 0; byId('reportHistory').replaceChildren(); }
  const rows = await read(`/api/reports/history?offset=${historyOffset}`);
  for (const row of rows) {
    const entry = document.createElement('p');
    entry.textContent = `${row.name} · ${row.reportCount} report${row.reportCount === 1 ? '' : 's'} · ${row.outcome} · ${new Date(row.resolvedAt).toLocaleString()}`;
    byId('reportHistory').append(entry);
  }
  historyOffset += rows.length;
  byId('moreHistory').hidden = rows.length < 50;
  if (!historyOffset) byId('reportHistory').textContent = 'No resolved reports yet.';
}
async function showMode(nextMode) {
  mode = nextMode;
  current = null;
  byId('reportedSection').hidden = mode !== 'reported';
  byId('undecidedNavigation').hidden = mode === 'reported';
  byId('undecidedActions').hidden = mode === 'reported';
  byId('reportedActions').hidden = mode !== 'reported';
  byId('showUndecided').className = mode === 'undecided' ? '' : 'secondary';
  byId('showReported').className = mode === 'reported' ? '' : 'secondary';
  byId('showUndecided').setAttribute('aria-pressed', String(mode === 'undecided'));
  byId('showReported').setAttribute('aria-pressed', String(mode === 'reported'));
  await navigate();
  if (mode === 'reported') await loadHistory(true);
}
byId('search').addEventListener('click', async () => {
  try {
    const tags = await read(`/api/search?query=${encodeURIComponent(byId('custom').value.trim())}`);
    byId('searchResults').replaceChildren();
    tags.forEach((tag) => tagOption(tag, byId('searchResults')));
    if (!tags.length) byId('searchResults').textContent = 'No matching character tags.';
  } catch (error) { byId('message').textContent = error.message; }
});
byId('preview').addEventListener('click', preview);
byId('googleSearch').addEventListener('click', () => {
  if (!current) return;
  const query = [current.name, current.animeTitles[0], 'danbooru'].filter(Boolean).join(' ');
  const url = new URL('https://www.google.com/search');
  url.searchParams.set('q', query);
  window.open(url.href, '_blank', 'noopener,noreferrer');
});
byId('approve').addEventListener('click', () => decide('approve'));
byId('noMatch').addEventListener('click', () => decide('no_match'));
byId('correct').addEventListener('click', () => decide('corrected'));
byId('dismiss').addEventListener('click', () => decide('dismissed'));
byId('showUndecided').addEventListener('click', () => showMode('undecided').catch((error) => { byId('message').textContent = error.message; }));
byId('showReported').addEventListener('click', () => showMode('reported').catch((error) => { byId('message').textContent = error.message; }));
byId('moreHistory').addEventListener('click', () => loadHistory().catch((error) => { byId('message').textContent = error.message; }));
for (const direction of ['first', 'back', 'forward', 'last']) {
  byId(direction).addEventListener('click', () => navigate(direction).catch((error) => { byId('message').textContent = error.message; }));
}
const jump = () => {
  if (!byId('jumpRank').reportValidity()) return;
  navigate('jump').catch((error) => { byId('message').textContent = error.message; });
};
byId('jump').addEventListener('click', jump);
byId('jumpRank').addEventListener('keydown', (event) => {
  if (event.key === 'Enter') { event.preventDefault(); jump(); }
});
status().then(() => navigate()).catch((error) => { byId('message').textContent = error.message; });
