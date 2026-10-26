import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// Run the actual browser module with controllable fetch completion and a small DOM.
function browser() {
  class Element {
    constructor(value = '') { this.value = String(value); this.children = []; this.listeners = {}; this.hidden = false; this.checked = false; this.disabled = false; this.dataset = {}; }
    addEventListener(name, fn) { (this.listeners[name] ??= []).push(fn); }
    async fire(name, extra = {}) { for (const fn of this.listeners[name] || []) await fn({ preventDefault() {}, ...extra }); }
    append(...nodes) { this.children.push(...nodes); }
    replaceChildren(...nodes) { this.children = nodes; if (nodes.length && this === elements.franchiseEditId) this.value = nodes[0].value; }
    get options() { return this.children; }
    get selectedOptions() { return this.children.filter(node => node.selected); }
    reset() {}
    focus() {}
  }
  const html = readFileSync(new URL('../web/reviewCatalog.html', import.meta.url), 'utf8');
  const elements = Object.fromEntries([...html.matchAll(/id="([^"]+)"/g)].map(([, id]) => [id, new Element()]));
  const requests = [];
  let key = 0;
  const context = vm.createContext({
    document: { getElementById: id => elements[id], createElement: () => new Element(), querySelector: () => null, querySelectorAll: () => ['characterForm', 'sourceForm', 'tagForm', 'repositionForm', 'franchiseForm'].map(id => elements[id]) },
    Option: function(text, value) { return Object.assign(new Element(value), { textContent: text }); },
    URL, crypto: { randomUUID: () => `request-key-${++key}` },
    feedback: (el, message) => { el.textContent = message; },
    fetch: (path, init) => new Promise(resolve => requests.push({ path, body: init?.body && JSON.parse(init.body), resolve: (data, status = 200) => resolve({ ok: status >= 200 && status < 300, status, json: async () => data }) })),
  });
  vm.runInContext(readFileSync(new URL('../web/assets/catalog.js', import.meta.url), 'utf8').replace("import { feedback } from './portal.js';", ''), context);
  return { elements, requests, run: code => vm.runInContext(code, context) };
}
const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };

test('newest preview wins even when the previous response arrives last', async () => {
  const b = browser();
  b.run("showPreview('edit', {input: {}})");
  b.run("showPreview('tag', {input: {status: 'no_match'}})");
  b.requests.find(r => r.path === '/api/catalog/tag/preview').resolve({ previewId: 'new', payloadHash: 'new-hash' });
  await flush();
  b.requests.find(r => r.path === '/api/catalog/edit/preview').resolve({ previewId: 'old', payloadHash: 'old-hash' });
  await flush();
  assert.equal(b.run('pending.previewId'), 'new');
  assert.equal(b.elements.previewPanel.hidden, false);
});

test('imported reference curation, no-match payload, search/history navigation and standalone queue visibility', async () => {
  const b = browser();
  b.run("editor({id: 'imported', creationMethod: 'imported', aliases: [], sources: [], franchiseIds: [], name_full: 'Imported', tag: null})");
  assert.equal(b.elements.referenceUrl.disabled, false);
  assert.equal(b.elements.name.disabled, true);
  b.elements.referenceUrl.value = 'https://example.test/curated';
  const editing = b.elements.characterForm.fire('submit');
  const edit = b.requests.find(r => r.path === '/api/catalog/edit/preview');
  assert.equal(edit.body.input.referenceUrl, 'https://example.test/curated');
  assert.equal('name' in edit.body.input, false);
  edit.resolve({ previewId: 'edit', payloadHash: 'hash' }); await editing;
  b.elements.tagStatus.value = 'no_match';
  const tagging = b.elements.tagForm.fire('submit');
  const tag = b.requests.find(r => r.path === '/api/catalog/tag/preview');
  assert.equal(tag.body.input.status, 'no_match'); assert.equal('tagName' in tag.body.input, false);
  tag.resolve({ previewId: 'tag', payloadHash: 'hash' }); await tagging;
  const searching = b.elements.searchNext.fire('click');
  const search = b.requests.find(r => r.path.includes('offset=50'));
  assert.ok(search.path.includes('/search?'));
  search.resolve({ characters: [], count: 0 }); await searching;
  b.elements.auditCharacter.value = 'imported';
  const auditing = b.elements.audit.fire('click');
  const audit = b.requests.find(r => r.path.includes('/audit?'));
  assert.ok(audit.path.includes('characterId=imported'));
  audit.resolve(Array.from({ length: 50 }, () => ({}))); await auditing;
  const nextAudit = b.elements.auditNext.fire('click');
  const next = b.requests.find(r => r.path.includes('/audit?') && r.path.includes('offset=50'));
  assert.ok(next.path.includes('characterId=imported'));
  next.resolve([]); await nextAudit;
  b.requests.find(r => r.path === '/api/status').resolve({}); await flush();
  assert.equal(b.elements.tagQueueLink.hidden, false);
  const standalone = browser();
  standalone.requests.find(r => r.path === '/api/status').resolve({}, 404); await flush();
  assert.equal(standalone.elements.tagQueueLink.hidden, true);
});

test('late previews cannot restore publication after input, character selection, or a newer preview', async () => {
  for (const invalidation of ["document.getElementById('characterForm').fire('input')", "editor()", "loadCharacter('other')", "showPreview('tag', {input: {status: 'no_match'}})"]) {
    const b = browser();
    b.run("showPreview('edit', {input: {}})");
    const old = b.requests.find(r => r.path === '/api/catalog/edit/preview');
    b.run(invalidation);
    old.resolve({ previewId: 'old', payloadHash: 'old-hash' }); await flush();
    assert.equal(b.run('pending'), null, invalidation);
    assert.equal(b.elements.previewPanel.hidden, true, invalidation);
  }
});

test('franchise refresh retains the edit identity and populated fields', async () => {
  const b = browser();
  b.elements.franchiseEditId.value = '7'; b.elements.franchiseName.value = 'Unsaved name';
  b.requests.find(r => r.path === '/api/catalog/franchises').resolve([{ id: 7, display_name: 'Original', aliases: [] }]);
  await flush();
  assert.equal(b.elements.franchiseEditId.value, '7');
  assert.equal(b.elements.franchiseName.value, 'Unsaved name');
});

const character = (id, franchiseIds = []) => ({
  id, creationMethod: 'imported', name_full: id, aliases: [], sources: [], franchiseIds,
});
async function ready() {
  const b = browser();
  b.requests.find(r => r.path === '/api/catalog/franchises').resolve([{ id: 1, display_name: 'One', aliases: [] }]);
  b.requests.find(r => r.path.includes('/search?')).resolve({ characters: [], count: 0 });
  await flush();
  return b;
}
async function preview(b, id) {
  const loading = b.run("showPreview('edit', {input: {}})");
  b.requests.at(-1).resolve({ previewId: id, payloadHash: `${id}-hash` });
  await loading;
}
async function confirming(b) {
  await preview(b, 'A');
  b.elements.confirmExplicit.checked = true;
  const done = b.elements.confirm.fire('click');
  return { done, request: b.requests.at(-1) };
}
function assertDraft(b) {
  assert.equal(b.run('current.id'), 'B');
  assert.equal(b.elements.aliases.value, 'Unsaved B');
  assert.equal(b.run('pending.previewId'), 'B');
  assert.equal(b.elements.previewPanel.hidden, false);
  assert.equal(b.elements.confirmExplicit.checked, true);
  assert.equal(b.elements.confirm.disabled, false);
}
async function newerDraft(b) {
  b.run(`editor(${JSON.stringify(character('B'))})`);
  b.elements.aliases.value = 'Unsaved B';
  await b.elements.characterForm.fire('input');
  await preview(b, 'B');
  b.elements.confirmExplicit.checked = true;
}

test('late confirmation success, stale and unknown errors leave a newer preview untouched', async () => {
  for (const status of [200, 409, 500]) {
    const b = await ready();
    const { done, request } = await confirming(b);
    await newerDraft(b);
    const message = b.elements.message.textContent;
    const count = b.requests.length;
    request.resolve(status === 200 ? { characterId: 'A' } : { error: 'A failed', refreshPreview: status === 409 }, status);
    await done;
    assertDraft(b);
    assert.equal(b.elements.message.textContent, message);
    assert.equal(b.requests.length, count, 'obsolete confirmation must not launch refreshes');
  }
});

test('confirmation followups discard late franchise, search and detail responses', async () => {
  for (const stage of ['franchises', 'search', 'detail']) {
    const b = await ready();
    const { done, request } = await confirming(b);
    request.resolve({ characterId: 'A' }); await flush();
    if (stage !== 'franchises') {
      b.requests.at(-1).resolve([{ id: 1, display_name: 'One', aliases: [] }]); await flush();
    }
    if (stage === 'detail') {
      b.requests.at(-1).resolve({ characters: [], count: 0 }); await flush();
    }
    const followup = b.requests.at(-1);
    assert.ok(followup.path.includes(`/${stage === 'detail' ? 'detail?' : stage === 'search' ? 'search?' : 'franchises'}`));
    await newerDraft(b);
    const count = b.requests.length;
    const options = b.elements.franchiseIds.children;
    const results = b.elements.results.children;
    followup.resolve(stage === 'detail' ? character('A') : stage === 'search' ? { characters: [character('A')], count: 1 } : []);
    await done;
    assertDraft(b);
    assert.equal(b.requests.length, count);
    assert.equal(b.elements.franchiseIds.children, options);
    assert.equal(b.elements.results.children, results);
  }
});

test('input alone revokes confirmation ownership at every asynchronous boundary', async () => {
  for (const stage of ['success', 'stale', 'franchises', 'search', 'detail']) {
    const b = await ready();
    b.run(`editor(${JSON.stringify(character('A'))})`);
    const { done, request } = await confirming(b);
    if (!['success', 'stale'].includes(stage)) {
      request.resolve({ characterId: 'A' }); await flush();
      if (stage !== 'franchises') {
        b.requests.at(-1).resolve([{ id: 1, display_name: 'One', aliases: [] }]); await flush();
      }
      if (stage === 'detail') {
        b.requests.at(-1).resolve({ characters: [], count: 0 }); await flush();
      }
    }
    const response = b.requests.at(-1);
    b.elements.aliases.value = 'New unsaved input';
    await b.elements.characterForm.fire('input');
    const count = b.requests.length;
    const message = b.elements.message.textContent;
    response.resolve(stage === 'stale' ? { error: 'Stale', refreshPreview: true }
      : stage === 'success' ? { characterId: 'A' }
      : stage === 'franchises' ? []
      : stage === 'search' ? { characters: [], count: 0 } : character('A'), stage === 'stale' ? 409 : 200);
    await done;
    assert.equal(b.elements.aliases.value, 'New unsaved input', stage);
    assert.equal(b.run('pending'), null, stage);
    assert.equal(b.elements.previewPanel.hidden, true, stage);
    assert.equal(b.elements.message.textContent, message, stage);
    assert.equal(b.requests.length, count, stage);
  }
});

test('owned confirmation completes refresh and loads the committed character', async () => {
  const b = await ready();
  const { done, request } = await confirming(b);
  request.resolve({ characterId: 'A' }); await flush();
  b.requests.at(-1).resolve([{ id: 1, display_name: 'One', aliases: [] }]); await flush();
  b.requests.at(-1).resolve({ characters: [], count: 0 }); await flush();
  assert.ok(b.requests.at(-1).path.includes('/detail?id=A'));
  b.requests.at(-1).resolve(character('A', [1])); await done;
  assert.equal(b.run('current.id'), 'A');
  assert.equal(b.run('pending'), null);
  assert.equal(b.elements.confirm.disabled, false);
  assert.deepEqual(Array.from(b.elements.franchiseIds.selectedOptions, option => Number(option.value)), [1]);
});

test('confirmation retries retain their key, while owned stale responses require a new preview', async () => {
  const b = await ready();
  const { done, request } = await confirming(b);
  request.resolve({ error: 'Unknown outcome' }, 500); await done;
  assert.equal(b.run('pending.previewId'), 'A');
  const retry = b.elements.confirm.fire('click');
  const second = b.requests.at(-1);
  assert.deepEqual(second.body, request.body);
  second.resolve({ error: 'Stale', refreshPreview: true }, 409); await retry;
  assert.equal(b.run('pending'), null);
  assert.equal(b.elements.previewPanel.hidden, true);
  assert.match(b.elements.message.textContent, /form is preserved/);
});

test('a pending detail cannot replace input in any editor form', async () => {
  for (const form of ['characterForm', 'sourceForm', 'tagForm', 'repositionForm', 'franchiseForm']) {
    for (const event of ['input', 'change']) {
      const b = await ready();
      b.run(`editor(${JSON.stringify(character('A'))})`);
      const loading = b.run("loadCharacter('B')");
      const detail = b.requests.at(-1);
      b.elements.aliases.value = 'Unsaved A';
      await b.elements[form].fire(event);
      detail.resolve(character('B')); await loading;
      assert.equal(b.run('current.id'), 'A', `${form} ${event}`);
      assert.equal(b.elements.aliases.value, 'Unsaved A');
    }
  }
});

test('initial franchise options retain authoritative detail memberships and subsequent user changes', async () => {
  for (const selection of ['untouched', 'clear', 'select']) {
    const b = browser();
    const loading = b.run("loadCharacter('A')");
    b.requests.at(-1).resolve(character('A', [1])); await loading;
    if (selection !== 'untouched') {
      if (selection === 'select') b.elements.franchiseIds.append({ value: '2', selected: true });
      await b.elements.franchiseIds.fire('change');
    }
    const rows = [{ id: 1, display_name: 'One', aliases: [] }, { id: 2, display_name: 'Two', aliases: [] }];
    b.requests.find(r => r.path === '/api/catalog/franchises').resolve(rows); await flush();
    const expected = selection === 'untouched' ? [1] : selection === 'clear' ? [] : [2];
    assert.deepEqual(Array.from(b.elements.franchiseIds.selectedOptions, option => Number(option.value)), expected);
    const refreshing = b.run('loadFranchises()');
    for (const option of b.elements.franchiseIds.options) option.selected = Number(option.value) === 2;
    await b.elements.franchiseIds.fire('input');
    b.requests.at(-1).resolve(rows); await refreshing;
    assert.deepEqual(Array.from(b.elements.franchiseIds.selectedOptions, option => Number(option.value)), [2]);
    const editing = b.elements.characterForm.fire('submit');
    assert.deepEqual(b.requests.at(-1).body.input.franchiseIds, [2]);
    b.requests.at(-1).resolve({ previewId: 'memberships', payloadHash: 'hash' }); await editing;
  }
});
