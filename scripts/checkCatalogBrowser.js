// Real-browser acceptance against a disposable final catalog and loopback servers.
// Usage: node scripts/checkCatalogBrowser.js --browser /path/to/chrome
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { parseArgs } from 'node:util';
import assert from 'node:assert/strict';
import { createFinalCatalog } from '../lib/catalogDb.js';
import { createReviewServer } from '../web/reviewCharacterTags.js';
import { createFranchiseReviewServer } from '../web/reviewFranchises.js';
import { authConfig, password } from '../test/helpers/portalAuth.js';
import { previewCatalogMutation, confirmCatalogMutation } from '../lib/catalogMutations.js';
const { values } = parseArgs({ options: { browser: { type: 'string' } } });
if (!values.browser) throw new Error('Explicit Chrome/Edge executable required via --browser');
const root = mkdtempSync(join(tmpdir(), 'catalog-browser-'));
let browser, socket, db, server;
try {
  browser = spawn(values.browser, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=0', `--user-data-dir=${join(root, 'profile')}`, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  const browserUrl = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Browser startup timeout: ${stderr}`)), 20000);
    browser.once('error', error => { clearTimeout(timeout); reject(error); });
    browser.stderr.on('data', chunk => {
      stderr += chunk;
      const match = stderr.match(/DevTools listening on (ws:\/\/\S+)/);
      if (match) { clearTimeout(timeout); resolve(match[1]); }
    });
  });
  const debugOrigin = new URL(browserUrl); debugOrigin.protocol = 'http:';
  const targets = await (await fetch(`${debugOrigin.origin}/json`)).json();
  socket = new WebSocket(targets.find(target => target.type === 'page').webSocketDebuggerUrl);
  await once(socket, 'open');
  let sequence = 0;
  const browserErrors = [];
  const awaiting = new Map();
  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    if (message.method === 'Runtime.exceptionThrown') browserErrors.push(message.params.exceptionDetails);
    if (message.id && awaiting.has(message.id)) {
      const { resolve, reject, timer } = awaiting.get(message.id); awaiting.delete(message.id); clearTimeout(timer);
      message.error ? reject(new Error(JSON.stringify(message.error))) : resolve(message.result);
    }
  });
  const call = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { awaiting.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 20000);
    awaiting.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method, params }));
  });
  await call('Runtime.enable');
  await call('Network.enable');
  await call('Network.setBlockedURLs', { urls: ['*://*.invalid/*', '*://anilist.co/*'] });
  const evaluate = async expression => {
    const result = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  const wait = async expression => {
    for (let i = 0; i < 150; i++) {
      try { if (await evaluate(`Boolean(${expression})`)) return; }
      catch (error) { if (!/navigated|Execution context|Cannot find context/i.test(error.message)) throw error; }
      await new Promise(resolve => setTimeout(resolve, 30));
    }
    throw new Error(`Condition timed out: ${expression}`);
  };
  const fill = (id, value) => evaluate(`(()=>{const e=document.getElementById(${JSON.stringify(id)});e.value=${JSON.stringify(value)};e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  const click = id => evaluate(`document.getElementById(${JSON.stringify(id)}).click()`);
  const submit = id => evaluate(`document.getElementById(${JSON.stringify(id)}).requestSubmit()`);
  const confirm = async () => {
    await wait("!document.getElementById('previewPanel').hidden");
    await evaluate("document.getElementById('confirmExplicit').checked=true");
    await click('confirm');
    await wait("document.getElementById('previewPanel').hidden && !document.getElementById('confirm').disabled");
  };
  for (const [name, factory] of [['combined', createReviewServer], ['standalone', createFranchiseReviewServer]]) {
    db = createFinalCatalog(join(root, `${name}.sqlite`));
    server = factory({ db, port: 0, authConfig, sourcePermissionConfirmed: true,
      verifySource: async (_url, options) => {
        const id = JSON.parse(options.body).variables.id;
        return id === 999999 ? new Response('', { status: 503 }) : new Response(JSON.stringify({
          data: { Character: { id, favourites: 23, name: { full: `Verified source ${id}` },
            image: { large: 'https://example.invalid/source.png' }, siteUrl: `https://anilist.co/character/${id}` } },
        }));
      },
    }); await once(server, 'listening');
    const origin = `http://127.0.0.1:${server.address().port}`;
    for (const role of ['admin', 'moderator']) {
      await call('Network.clearBrowserCookies');
      await call('Page.navigate', { url: `${origin}/login` }); await wait("document.readyState==='complete' && location.pathname==='/login'");
      await evaluate(`(()=>{const f=document.getElementById('loginForm');f.elements.username.value=${JSON.stringify(`test-${role}`)};f.elements.password.value=${JSON.stringify(password)};f.requestSubmit();})()`);
      await wait("location.pathname!=='/login' && document.readyState==='complete'");
      await call('Page.navigate', { url: `${origin}/catalog` });
      await wait("document.getElementById('franchiseForm') && document.readyState==='complete'");
      await call('Emulation.setDeviceMetricsOverride', { width: role === 'admin' ? 1280 : 390, height: 850, deviceScaleFactor: 1, mobile: role !== 'admin' });
      const label = `${name}-${role}`;
      await fill('franchiseName', `Franchise ${label}`); await submit('franchiseForm'); await confirm();
      await wait("document.getElementById('franchiseIds').options.length>0");
      await fill('name', `Character ${label}`); await fill('gender', 'unknown'); await fill('portraitUrl', 'https://example.invalid/portrait.png');
      await evaluate("(()=>{const f=document.getElementById('franchiseIds'); f.options[f.options.length-1].selected=true;f.dispatchEvent(new Event('change',{bubbles:true}));})()");
      await submit('characterForm'); await confirm();
      assert.equal(db.prepare('SELECT count(*) AS n FROM characters WHERE name_full=?').get(`Character ${label}`).n, 1);
      const originalId = db.prepare('SELECT id FROM characters WHERE name_full=?').get(`Character ${label}`).id;
      await fill('query', `Character ${label}`); await submit('searchForm');
      await wait(`Array.from(document.getElementById('results').querySelectorAll('button')).some(b=>b.textContent.includes(${JSON.stringify(`Character ${label}`)}))`);
      await evaluate(`Array.from(document.getElementById('results').querySelectorAll('button')).find(b=>b.textContent.includes(${JSON.stringify(`Character ${label}`)})).click()`);
      await wait(`!document.getElementById('existingActions').hidden && document.getElementById('name').value===${JSON.stringify(`Character ${label}`)}`);
      // Wait for the selected detail fetch to complete rather than matching the
      // same character still visible from the preceding successful publication.
      await evaluate("new Promise(r=>setTimeout(r,150))");
      await fill('aliases', `Browser Alias ${label}`); await submit('characterForm'); await confirm();
      assert.equal(db.prepare('SELECT count(*) AS n FROM character_curated_aliases WHERE alias=?').get(`Browser Alias ${label}`).n, 1, JSON.stringify({ message: await evaluate("document.getElementById('message').textContent"), aliases: db.prepare('SELECT * FROM character_curated_aliases').all(), editor: await evaluate("document.getElementById('name').value+'|'+document.getElementById('aliases').value") }));
      assert.ok(await evaluate("document.getElementById('identity').textContent.includes('[generated]')"));

      // A competing editor publishes after preview. The browser must retain
      // unsaved input and require a new preview, then permit an exact retry.
      const retainedAlias = `Retained after conflict ${label}`;
      await fill('aliases', retainedAlias); await submit('characterForm');
      await wait("!document.getElementById('previewPanel').hidden");
      const elsewhere = previewCatalogMutation(db, { account: `test-${role}`, role,
        operation: 'franchise_create', input: { displayName: `Concurrent ${label}` } });
      confirmCatalogMutation(db, { account: `test-${role}`, role, ...Object.fromEntries(
        ['previewId', 'payloadHash'].map(key => [key, elsewhere[key]])), idempotencyKey: elsewhere.previewId });
      await evaluate("document.getElementById('confirmExplicit').checked=true"); await click('confirm');
      await wait("document.getElementById('message').textContent.includes('Your form is preserved')");
      assert.equal(await evaluate("document.getElementById('aliases').value"), retainedAlias);
      await submit('characterForm');
      await wait("!document.getElementById('previewPanel').hidden");
      await evaluate("(()=>{const send=window.fetch;window.fetch=async(input,init)=>{if(String(input).endsWith('/edit/confirm'))window.lastConfirmation={input,init};return send(input,init);};})()");
      const auditsBefore = db.prepare('SELECT count(*) n FROM catalog_mutations').get().n;
      await evaluate("document.getElementById('confirmExplicit').checked=true;document.getElementById('confirm').click();document.getElementById('confirm').click()");
      await wait("document.getElementById('message').textContent.startsWith('Published successfully.') && document.getElementById('previewPanel').hidden");
      const retry = await evaluate("fetch(window.lastConfirmation.input,window.lastConfirmation.init).then(async r=>({status:r.status,value:await r.json()}))");
      assert.equal(retry.status, 200); assert.equal(retry.value.characterId, originalId);
      assert.equal(db.prepare('SELECT count(*) n FROM catalog_mutations').get().n, auditsBefore + 1);
      await wait("!document.getElementById('existingActions').hidden && document.getElementById('aliases').value.includes('Retained after conflict')");

      // Reposition and source verification/adoption use the same rendered
      // confirmation flow. Transports are deterministic and never call AniList.
      await fill('targetRank', '1'); await submit('repositionForm'); await confirm();
      await wait("!document.getElementById('existingActions').hidden");
      const externalId = role === 'admin' ? '7001' : '7002';
      await fill('sourceOperation', 'link'); await fill('externalId', externalId);
      await evaluate("document.getElementById('sourceExplicit').checked=true"); await submit('sourceForm');
      await wait("!document.getElementById('previewPanel').hidden");
      assert.ok(await evaluate("document.getElementById('sourceComparison').textContent.includes('Verified source')"));
      await confirm();
      await wait(`document.getElementById('externalId').value===${JSON.stringify(externalId)}`);
      assert.equal(db.prepare('SELECT likes_source FROM characters WHERE id=?').get(originalId).likes_source, 'generated');
      await fill('externalId', '999999');
      await evaluate("document.getElementById('sourceExplicit').checked=true"); await submit('sourceForm');
      await wait("document.getElementById('message').textContent.includes('HTTP failure')");
      assert.equal(await evaluate("document.getElementById('externalId').value"), '999999');
      assert.equal(db.prepare('SELECT external_id FROM character_sources WHERE character_id=?').get(originalId).external_id, externalId);
      await fill('sourceOperation', 'switch_likes');
      await evaluate("document.getElementById('sourceExplicit').checked=true"); await submit('sourceForm'); await confirm();
      await wait("document.getElementById('identity').textContent.includes('23 likes') && !document.getElementById('identity').textContent.includes('[generated]')");
      assert.equal(db.prepare('SELECT favourites FROM characters WHERE id=?').get(originalId).favourites, 23);
      assert.ok(!await evaluate("document.getElementById('identity').textContent.includes('[generated]')"));

      // Duplicate warnings block confirmation until the editor explicitly
      // distinguishes the new identity. Reusing an occupied source stays refused.
      await click('newCharacter'); await fill('name', `Character ${label}`); await fill('gender', 'unknown');
      await fill('portraitUrl', 'https://example.invalid/portrait.png');
      await evaluate("(()=>{const f=document.getElementById('franchiseIds');f.options[0].selected=true;f.dispatchEvent(new Event('change',{bubbles:true}));})()");
      await submit('characterForm'); await wait("!document.getElementById('previewPanel').hidden");
      assert.ok(await evaluate("document.getElementById('duplicates').textContent.includes('Possible duplicate')"));
      assert.equal(await evaluate("document.getElementById('confirm').disabled"), true);
      await fill('duplicateReason', 'Browser acceptance: distinct test identity sharing a name');
      await evaluate("const c=document.getElementById('duplicateOverride');c.checked=true;c.dispatchEvent(new Event('change',{bubbles:true}));");
      await submit('characterForm'); await confirm();
      await wait("!document.getElementById('existingActions').hidden");
      assert.equal(db.prepare('SELECT count(*) n FROM characters WHERE name_full=?').get(`Character ${label}`).n, 2);
      await fill('externalId', externalId);
      await evaluate("document.getElementById('sourceExplicit').checked=true"); await submit('sourceForm');
      await wait("document.getElementById('message').textContent.includes('already belongs')");
      const forbidden = await evaluate("fetch('/api/config').then(r=>r.status)");
      if (role === 'moderator') assert.equal(forbidden, 403);
      await evaluate("Array.from(document.querySelectorAll('button')).find(b=>b.textContent.startsWith('Sign out (')).click()");
      await wait("location.pathname==='/login' && document.readyState==='complete'");
      assert.equal(await evaluate("fetch('/api/catalog/search').then(r=>r.status)"), 401);
      console.log(JSON.stringify({ entrypoint: name, role, viewport: role === 'admin' ? 'desktop' : 'mobile',
        create: true, search: true, edit: true, generatedLabel: true, staleInputRetained: true, exactRetry: true,
        reposition: true, sourceVerify: true, sourceFailure: true, likesAdoption: true, duplicates: true, sourceConflict: true, logout: true }));
    }
    assert.deepEqual(browserErrors, [], 'No uncaught browser module errors');
    await new Promise(resolve => server.close(resolve)); server = null; db.close(); db = null;
  }
} finally {
  socket?.close();
  if (browser && browser.exitCode === null) { browser.kill(); await once(browser, 'exit').catch(() => {}); }
  if (server) await new Promise(resolve => server.close(resolve));
  db?.close();
  // Browser child cleanup may release its profile files shortly after exit.
  rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
