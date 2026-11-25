import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

// Run the actual browser module with controllable fetch completion and a small DOM.
function browser(module = "catalog") {
  class Element {
    constructor(value = "") {
      this.value = String(value);
      this.children = [];
      this.listeners = {};
      this.hidden = false;
      this.open = false;
      this.disabled = false;
      this.dataset = {};
      this.attributes = {};
      this.style = { setProperty() {} };
    }
    addEventListener(name, fn) {
      (this.listeners[name] ??= []).push(fn);
    }
    async fire(name, extra = {}) {
      const event = {
        target: this,
        defaultPrevented: false,
        preventDefault() {
          this.defaultPrevented = true;
        },
        ...extra,
      };
      for (let node = this; node; node = node.parentElement) {
        for (const fn of node.listeners[name] || []) await fn(event);
        if (!["input", "change", "keydown", "click", "focusout"].includes(name))
          break;
      }
      return event;
    }
    setAttribute(name, value) {
      this.attributes[name] = String(value);
    }
    removeAttribute(name) {
      delete this.attributes[name];
    }
    contains(node) {
      return (
        node === this || this.children.some((child) => child.contains?.(node))
      );
    }
    append(...nodes) {
      for (const node of nodes) node.parentElement = this;
      this.children.push(...nodes);
    }
    replaceChildren(...nodes) {
      this.children = nodes;
      if (nodes.length && this === elements.franchiseEditId)
        this.value = nodes[0].value;
    }
    get options() {
      return this.children;
    }
    get selectedOptions() {
      return this.children.filter((node) => node.selected);
    }
    reset() {}
    setCustomValidity(message) {
      this.validationMessage = message;
    }
    reportValidity() {
      return !this.validationMessage;
    }
    focus() {
      this.focused = true;
    }
  }
  const html = readFileSync(
    new URL(
      `../web/${module === "catalog" ? "reviewCatalog" : "reviewCharacterTags"}.html`,
      import.meta.url,
    ),
    "utf8",
  );
  const elements = Object.fromEntries(
    [...html.matchAll(/id="([^"]+)"/g)].map(([, id]) => [id, new Element()]),
  );
  if (module === "catalog") {
    elements.franchisePicker.append(
      elements.franchiseChips,
      elements.franchiseSearch,
      elements.franchiseOptions,
    );
    elements.characterForm.append(
      elements.franchisePicker,
      elements.franchiseIds,
    );
  }
  const requests = [];
  let key = 0;
  const context = vm.createContext({
    document: {
      getElementById: (id) => elements[id],
      createElement: () => new Element(),
      querySelector: () => null,
      querySelectorAll: () =>
        ["characterForm", "sourceForm", "rankingForm", "franchiseForm"].map(
          (id) => elements[id],
        ),
    },
    Option: function (text, value) {
      return Object.assign(new Element(value), { textContent: text });
    },
    URL,
    crypto: { randomUUID: () => `request-key-${++key}` },
    localStorage: { getItem: () => null, setItem() {} },
    feedback: (el, message) => {
      el.textContent = message;
    },
    fetch: (path, init) =>
      new Promise((resolve) =>
        requests.push({
          path,
          body: init?.body && JSON.parse(init.body),
          resolve: (data, status = 200) =>
            resolve({
              ok: status >= 200 && status < 300,
              status,
              json: async () => data,
            }),
        }),
      ),
  });
  vm.runInContext(
    readFileSync(
      new URL(`../web/assets/${module}.js`, import.meta.url),
      "utf8",
    ).replace("import { feedback } from './portal.js';", ""),
    context,
  );
  return { elements, requests, run: (code) => vm.runInContext(code, context) };
}
const flush = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

test("navigation discards decisions started while another character was still displayed", async () => {
  for (const previewFirst of [true, false]) {
    const b = browser("reviewCharacterTags");
    b.requests[0].resolve({
      efficiencyRanking: true,
      queue: 2,
      reports: 0,
      manual: 0,
      automatic: 0,
      matched: 0,
      total: 2,
    });
    await flush();
    const row = (id, rank) => ({
      id,
      rank,
      name: id,
      animeTitles: [],
      candidates: [],
      reportCount: 0,
      firstReportedAt: "2026-01-01",
    });
    b.requests.at(-1).resolve(row("A", 1));
    await flush();
    const navigating = b.elements.forward.fire("click");
    const navigation = b.requests.at(-1);
    b.elements.custom.value = "series";
    await b.elements.custom.fire("input");
    const deciding = b.elements.approve.fire("click");
    const preview = b.requests.at(-1);
    const result = {
      previewId: "A-preview",
      payloadHash: "A-hash",
      rank: 1,
      efficiency: 0,
      danbooru_post_count: 0,
    };
    if (previewFirst) {
      preview.resolve(result);
      await deciding;
    }
    navigation.resolve(row("B", 2));
    await navigating;
    if (!previewFirst) {
      preview.resolve(result);
      await deciding;
    }
    assert.equal(b.elements.name.textContent, "B");
    assert.equal(b.elements.decisionPreview.hidden, true);
    assert.equal(b.elements.confirmDecision.disabled, true);
    const count = b.requests.length;
    await b.elements.confirmDecision.fire("click");
    assert.equal(
      b.requests.length,
      count,
      "no confirmation for A can be sent while B is displayed",
    );
  }
});

const franchiseRows = [
  { id: 1, display_name: "One", aliases: ["FIRST SERIES"] },
  {
    id: 2,
    display_name: "<img src=x onerror=alert(1)> Two",
    aliases: ["Second"],
  },
  { id: 3, display_name: "Three", aliases: [] },
];
async function pickerReady() {
  const b = browser();
  b.requests
    .find((r) => r.path === "/api/catalog/franchises")
    .resolve(franchiseRows);
  await flush();
  return b;
}

test("franchise picker searches names and aliases without changing a preview, selects with keys and prevents submit", async () => {
  const b = await pickerReady();
  await preview(b, "stable");
  const input = b.elements.franchiseSearch;
  await input.fire("focus");
  assert.equal(input.attributes["aria-expanded"], "true");
  input.value = "fIrSt";
  await input.fire("input");
  assert.equal(b.elements.franchiseOptions.children.length, 1);
  assert.equal(b.elements.franchiseOptions.children[0].textContent, "One");
  await input.fire("change");
  assert.equal(
    b.run("pending.previewId"),
    "stable",
    "search is not a membership edit",
  );
  const down = await input.fire("keydown", { key: "ArrowDown" });
  assert.equal(down.defaultPrevented, true);
  assert.equal(input.attributes["aria-activedescendant"], "franchise-option-1");
  const enter = await input.fire("keydown", { key: "Enter" });
  assert.equal(enter.defaultPrevented, true);
  assert.equal(b.run("pending"), null);
  assert.deepEqual(Array.from(b.run("selectedFranchises()")), [1]);
  assert.equal(input.validationMessage, "");
  assert.equal(b.elements.franchiseChips.children.length, 1);
  assert.equal(
    b.elements.franchiseChips.children[0].children[1].attributes["aria-label"],
    "Remove One",
  );
  assert.equal(input.value, "");
  assert.ok(
    !b.elements.franchiseOptions.children.some(
      (option) => option.textContent === "One",
    ),
  );
  await preview(b, "unchanged");
  b.run("setFranchiseSelection([1, 1], true)");
  assert.equal(
    b.run("pending.previewId"),
    "unchanged",
    "duplicate selection is not an edit",
  );
  await input.fire("keydown", { key: "ArrowUp" });
  assert.equal(input.attributes["aria-activedescendant"], "franchise-option-3");
  await input.fire("keydown", { key: "Escape" });
  assert.equal(input.attributes["aria-expanded"], "false");
  assert.equal(input.attributes["aria-activedescendant"], undefined);
  const count = b.requests.length;
  assert.equal(
    (await input.fire("keydown", { key: "Enter" })).defaultPrevented,
    true,
  );
  assert.equal(b.requests.length, count);
  await input.fire("click");
  input.value = "tWo";
  await input.fire("input");
  const option = b.elements.franchiseOptions.children[0];
  assert.equal(option.textContent, franchiseRows[1].display_name);
  assert.equal(
    option.children.length,
    0,
    "untrusted names are text, not markup",
  );
  assert.equal((await option.fire("mousedown")).defaultPrevented, true);
  await option.fire("click");
  assert.deepEqual(Array.from(b.run("selectedFranchises()")), [1, 2]);
  await b.elements.franchisePicker.fire("focusout", {
    relatedTarget: b.elements.name,
  });
  assert.equal(b.elements.franchiseOptions.hidden, true);
});

test("chip removal invalidates selection previews and visible validation follows manual/imported editor state", async () => {
  const b = await pickerReady();
  assert.match(b.elements.franchiseSearch.validationMessage, /at least one/);
  b.run(
    `editor(${JSON.stringify({ ...character("manual", [1]), creationMethod: "manual" })})`,
  );
  assert.equal(b.elements.franchiseSearch.attributes["aria-required"], "true");
  await preview(b, "remove");
  const remove = b.elements.franchiseChips.children[0].children[1];
  assert.equal(remove.type, "button");
  await remove.fire("click");
  assert.equal(b.run("pending"), null);
  assert.equal(b.elements.franchiseSearch.focused, true);
  assert.match(b.elements.franchiseSearch.validationMessage, /at least one/);
  b.run(`editor(${JSON.stringify(character("imported"))})`);
  assert.equal(b.elements.franchiseSearch.validationMessage, "");
  assert.equal(b.elements.franchiseSearch.attributes["aria-required"], "false");
  b.run("editor()");
  assert.match(b.elements.franchiseSearch.validationMessage, /at least one/);
  assert.equal(b.elements.franchiseChips.children.length, 0);
  const html = readFileSync(
    new URL("../web/reviewCatalog.html", import.meta.url),
    "utf8",
  );
  const select = html.match(/<select\b[^>]*\bid="franchiseIds"[^>]*>/)[0];
  assert.match(select, /\bhidden\b/);
  assert.doesNotMatch(select, /\brequired\b/);
  assert.match(html, /for="franchiseSearch"/);
  assert.match(
    html,
    /id="franchiseOptions"[^>]*role="listbox"[^>]*aria-labelledby="franchiseLabel"/,
  );
});

test("late lists, editor switches, refresh and franchise publication preserve chip IDs and payloads", async () => {
  const b = browser();
  b.run(`editor(${JSON.stringify(character("A", [1]))})`);
  assert.equal(
    b.elements.franchiseChips.children[0].children[0].textContent,
    "Franchise #1",
  );
  b.run(`editor(${JSON.stringify(character("B", [2]))})`);
  b.requests
    .find((r) => r.path === "/api/catalog/franchises")
    .resolve(franchiseRows);
  await flush();
  assert.equal(
    b.elements.franchiseChips.children[0].children[0].textContent,
    franchiseRows[1].display_name,
  );
  const refreshing = b.run("loadFranchises()");
  b.run("setFranchiseSelection([1, 3], true)");
  b.requests.at(-1).resolve(franchiseRows);
  await refreshing;
  assert.deepEqual(Array.from(b.run("selectedFranchises()")), [1, 3]);
  const publishing = b.run("showPreview('franchise', {input: {}})");
  b.requests.at(-1).resolve({ previewId: "franchise", payloadHash: "hash" });
  await publishing;
  const confirming = b.elements.confirm.fire("click");
  b.requests.at(-1).resolve({ franchiseId: 4 });
  await flush();
  b.requests
    .at(-1)
    .resolve([
      ...franchiseRows,
      { id: 4, display_name: "New franchise", aliases: ["Published"] },
    ]);
  await flush();
  b.requests.at(-1).resolve({ characters: [], count: 0 });
  await confirming;
  assert.deepEqual(Array.from(b.run("selectedFranchises()")), [1, 3]);
  b.elements.franchiseSearch.value = "published";
  await b.elements.franchiseSearch.fire("input");
  await b.elements.franchiseOptions.children[0].fire("click");
  const editing = b.elements.characterForm.fire("submit");
  assert.deepEqual(b.requests.at(-1).body.input.franchiseIds, [1, 3, 4]);
  b.requests.at(-1).resolve({ previewId: "edit", payloadHash: "hash" });
  await editing;
});

test("catalog controls use no checkboxes and preview JSON is collapsed by default", () => {
  const html = readFileSync(
    new URL("../web/reviewCatalog.html", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(html, /type\s*=\s*["']?checkbox/i);
  for (const id of [
    "duplicateReason",
    "duplicateOverride",
    "confirmExplicit",
    "sourceExplicit",
  ]) {
    assert.doesNotMatch(html, new RegExp(`id=["']${id}["']`));
  }
  const details = html.match(/<details\b[^>]*\bid="previewDetails"[^>]*>/)?.[0];
  assert.ok(details, "full JSON preview has a stable details id");
  assert.doesNotMatch(details, /\bopen(?:\s|=|>)/);
  assert.doesNotMatch(
    html,
    /id="(?:switchGenerated|targetRank|repositionForm)"/,
  );
  assert.match(html, /<input\b[^>]*\bid="createTag"[^>]*>/);
  assert.doesNotMatch(
    html.match(/<input\b[^>]*\bid="createTag"[^>]*>/)[0],
    /\brequired\b/,
  );
});

test("optional creation tag is trimmed and NULL when blank, and never sent on edit", async () => {
  for (const value of ["", "   \n  ", "  approved_character  "]) {
    const b = browser();
    b.elements.createTag.value = value;
    const loading = b.elements.characterForm.fire("submit");
    const request = b.requests.at(-1);
    assert.equal(request.path, "/api/catalog/create/preview");
    if (value.trim())
      assert.equal(request.body.input.tagName, "approved_character");
    else assert.equal(request.body.input.tagName, null);
    assert.equal(Object.hasOwn(request.body, "duplicateOverrideReason"), false);
    assert.equal(
      Object.hasOwn(request.body.input, "duplicateOverrideReason"),
      false,
    );
    request.resolve({ previewId: "create", payloadHash: "hash" });
    await loading;
    b.run(
      "editor({id: 'manual', creationMethod: 'manual', aliases: [], sources: [], franchiseIds: []})",
    );
    b.elements.createTag.value = "not_an_edit_tag";
    const editing = b.elements.characterForm.fire("submit");
    const edit = b.requests.at(-1);
    assert.equal(edit.path, "/api/catalog/edit/preview");
    assert.equal(Object.hasOwn(edit.body.input, "tagName"), false);
    assert.equal(
      Object.hasOwn(edit.body.input, "duplicateOverrideReason"),
      false,
    );
    edit.resolve({ previewId: "edit", payloadHash: "hash" });
    await editing;
  }
});

test("duplicate warnings are advisory for create and edit; Confirm publishes immediately", async () => {
  for (const operation of ["create", "edit"]) {
    const b = browser();
    const loading = b.run(`showPreview('${operation}', {input: {}})`);
    b.requests.at(-1).resolve({
      previewId: operation,
      payloadHash: "hash",
      duplicateWarnings: [{ id: "match", name: "Same name", sources: [] }],
    });
    await loading;
    assert.equal(b.elements.duplicates.children.length, 1);
    assert.equal(
      b.elements.duplicates.children[0].children[0].textContent,
      "Possible duplicate: Same name (match)",
    );
    assert.equal(b.elements.confirm.disabled, false);
    const confirmation = b.elements.confirm.fire("click");
    const request = b.requests.at(-1);
    assert.equal(request.path, `/api/catalog/${operation}/confirm`);
    assert.deepEqual(request.body, {
      previewId: operation,
      payloadHash: "hash",
      idempotencyKey: "request-key-1",
    });
    request.resolve({ error: "Unknown outcome" }, 500);
    await confirmation;
  }
});

test("every new preview collapses previously opened JSON details", async () => {
  const b = browser();
  for (const id of ["first", "second"]) {
    b.elements.previewDetails.open = true;
    const loading = b.run("showPreview('edit', {input: {}})");
    b.requests.at(-1).resolve({ previewId: id, payloadHash: "hash" });
    await loading;
    assert.equal(b.elements.previewDetails.open, false);
    assert.equal(JSON.parse(b.elements.previewData.textContent).previewId, id);
  }
});

test("creation tag errors attach to the field and verified canonical tag is readable without JSON", async () => {
  const b = browser();
  b.elements.createTag.value = "bad_tag";
  const invalid = b.elements.characterForm.fire("submit");
  b.requests
    .at(-1)
    .resolve({ error: "Tag must be an active Danbooru character tag" }, 400);
  await invalid;
  assert.match(b.elements.createTag.validationMessage, /active Danbooru/);
  await b.elements.createTag.fire("input");
  assert.equal(b.elements.createTag.validationMessage, "");
  b.elements.createTag.value = "valid_tag";
  const valid = b.elements.characterForm.fire("submit");
  b.requests.at(-1).resolve({
    previewId: "tagged",
    payloadHash: "hash",
    tagName: "canonical_tag",
  });
  await valid;
  assert.match(
    b.elements.previewSummary.textContent,
    /Danbooru tag: canonical_tag \(verified\)/,
  );
  assert.equal(b.elements.previewDetails.open, false);
});

test("ranking form sends nullable inputs instead of a manual rank", async () => {
  const b = browser();
  b.run(
    "editor({id: 'imported', creationMethod: 'imported', aliases: [], sources: [], franchiseIds: []})",
  );
  b.elements.rankingTag.value = "";
  b.elements.rankingClaimRank.value = "123";
  const loading = b.elements.rankingForm.fire("submit");
  const request = b.requests.at(-1);
  assert.equal(request.path, "/api/catalog/ranking/preview");
  assert.deepEqual(request.body.input, {
    characterId: "imported",
    tagName: null,
    mudaeClaimRank: 123,
  });
  request.resolve({ previewId: "ranked", payloadHash: "hash" });
  await loading;
});

test("newest preview wins even when the previous response arrives last", async () => {
  const b = browser();
  b.run("showPreview('edit', {input: {}})");
  b.run("showPreview('tag', {input: {status: 'no_match'}})");
  b.requests
    .find((r) => r.path === "/api/catalog/tag/preview")
    .resolve({ previewId: "new", payloadHash: "new-hash" });
  await flush();
  b.requests
    .find((r) => r.path === "/api/catalog/edit/preview")
    .resolve({ previewId: "old", payloadHash: "old-hash" });
  await flush();
  assert.equal(b.run("pending.previewId"), "new");
  assert.equal(b.elements.previewPanel.hidden, false);
});

test("imported reference curation, no-match payload, search/history navigation and standalone queue visibility", async () => {
  const b = browser();
  b.run(
    "editor({id: 'imported', creationMethod: 'imported', aliases: [], sources: [], franchiseIds: [], name_full: 'Imported', tag: null})",
  );
  assert.equal(b.elements.referenceUrl.disabled, false);
  assert.equal(b.elements.name.disabled, true);
  b.elements.referenceUrl.value = "https://example.test/curated";
  const editing = b.elements.characterForm.fire("submit");
  const edit = b.requests.find((r) => r.path === "/api/catalog/edit/preview");
  assert.equal(edit.body.input.referenceUrl, "https://example.test/curated");
  assert.equal("name" in edit.body.input, false);
  edit.resolve({ previewId: "edit", payloadHash: "hash" });
  await editing;
  b.elements.rankingTag.value = "";
  b.elements.rankingClaimRank.value = "";
  const tagging = b.elements.rankingForm.fire("submit");
  const tag = b.requests.find((r) => r.path === "/api/catalog/ranking/preview");
  assert.equal(tag.body.input.tagName, null);
  assert.equal(tag.body.input.mudaeClaimRank, null);
  tag.resolve({ previewId: "tag", payloadHash: "hash" });
  await tagging;
  const searching = b.elements.searchNext.fire("click");
  const search = b.requests.find((r) => r.path.includes("offset=50"));
  assert.ok(search.path.includes("/search?"));
  search.resolve({ characters: [], count: 0 });
  await searching;
  b.elements.auditCharacter.value = "imported";
  const auditing = b.elements.audit.fire("click");
  const audit = b.requests.find((r) => r.path.includes("/audit?"));
  assert.ok(audit.path.includes("characterId=imported"));
  audit.resolve(Array.from({ length: 50 }, () => ({})));
  await auditing;
  const nextAudit = b.elements.auditNext.fire("click");
  const next = b.requests.find(
    (r) => r.path.includes("/audit?") && r.path.includes("offset=50"),
  );
  assert.ok(next.path.includes("characterId=imported"));
  next.resolve([]);
  await nextAudit;
  b.requests.find((r) => r.path === "/api/status").resolve({});
  await flush();
  assert.equal(b.elements.tagQueueLink.hidden, false);
  const standalone = browser();
  standalone.requests.find((r) => r.path === "/api/status").resolve({}, 404);
  await flush();
  assert.equal(standalone.elements.tagQueueLink.hidden, true);
});

test("late previews cannot restore publication after input, character selection, or a newer preview", async () => {
  for (const invalidation of [
    "document.getElementById('characterForm').fire('input')",
    "editor()",
    "loadCharacter('other')",
    "showPreview('tag', {input: {status: 'no_match'}})",
  ]) {
    const b = browser();
    b.run("showPreview('edit', {input: {}})");
    const old = b.requests.find((r) => r.path === "/api/catalog/edit/preview");
    b.run(invalidation);
    old.resolve({ previewId: "old", payloadHash: "old-hash" });
    await flush();
    assert.equal(b.run("pending"), null, invalidation);
    assert.equal(b.elements.previewPanel.hidden, true, invalidation);
  }
});

test("franchise refresh retains the edit identity and populated fields", async () => {
  const b = browser();
  b.elements.franchiseEditId.value = "7";
  b.elements.franchiseName.value = "Unsaved name";
  b.requests
    .find((r) => r.path === "/api/catalog/franchises")
    .resolve([{ id: 7, display_name: "Original", aliases: [] }]);
  await flush();
  assert.equal(b.elements.franchiseEditId.value, "7");
  assert.equal(b.elements.franchiseName.value, "Unsaved name");
});

const character = (id, franchiseIds = []) => ({
  id,
  creationMethod: "imported",
  name_full: id,
  aliases: [],
  sources: [],
  franchiseIds,
});
async function ready() {
  const b = browser();
  b.requests
    .find((r) => r.path === "/api/catalog/franchises")
    .resolve([{ id: 1, display_name: "One", aliases: [] }]);
  b.requests
    .find((r) => r.path.includes("/search?"))
    .resolve({ characters: [], count: 0 });
  await flush();
  return b;
}
async function preview(b, id) {
  const loading = b.run("showPreview('edit', {input: {}})");
  b.requests.at(-1).resolve({ previewId: id, payloadHash: `${id}-hash` });
  await loading;
}
async function confirming(b) {
  await preview(b, "A");
  const done = b.elements.confirm.fire("click");
  return { done, request: b.requests.at(-1) };
}
function assertDraft(b) {
  assert.equal(b.run("current.id"), "B");
  assert.equal(b.elements.aliases.value, "Unsaved B");
  assert.equal(b.run("pending.previewId"), "B");
  assert.equal(b.elements.previewPanel.hidden, false);
  assert.equal(b.elements.confirm.disabled, false);
}
async function newerDraft(b) {
  b.run(`editor(${JSON.stringify(character("B"))})`);
  b.elements.aliases.value = "Unsaved B";
  await b.elements.characterForm.fire("input");
  await preview(b, "B");
}

test("late confirmation success, stale and unknown errors leave a newer preview untouched", async () => {
  for (const status of [200, 409, 500]) {
    const b = await ready();
    const { done, request } = await confirming(b);
    await newerDraft(b);
    const message = b.elements.message.textContent;
    const count = b.requests.length;
    request.resolve(
      status === 200
        ? { characterId: "A" }
        : { error: "A failed", refreshPreview: status === 409 },
      status,
    );
    await done;
    assertDraft(b);
    assert.equal(b.elements.message.textContent, message);
    assert.equal(
      b.requests.length,
      count,
      "obsolete confirmation must not launch refreshes",
    );
  }
});

test("confirmation followups discard late franchise, search and detail responses", async () => {
  for (const stage of ["franchises", "search", "detail"]) {
    const b = await ready();
    const { done, request } = await confirming(b);
    request.resolve({ characterId: "A" });
    await flush();
    if (stage !== "franchises") {
      b.requests.at(-1).resolve([{ id: 1, display_name: "One", aliases: [] }]);
      await flush();
    }
    if (stage === "detail") {
      b.requests.at(-1).resolve({ characters: [], count: 0 });
      await flush();
    }
    const followup = b.requests.at(-1);
    assert.ok(
      followup.path.includes(
        `/${stage === "detail" ? "detail?" : stage === "search" ? "search?" : "franchises"}`,
      ),
    );
    await newerDraft(b);
    const count = b.requests.length;
    const options = b.elements.franchiseIds.children;
    const results = b.elements.results.children;
    followup.resolve(
      stage === "detail"
        ? character("A")
        : stage === "search"
          ? { characters: [character("A")], count: 1 }
          : [],
    );
    await done;
    assertDraft(b);
    assert.equal(b.requests.length, count);
    assert.equal(b.elements.franchiseIds.children, options);
    assert.equal(b.elements.results.children, results);
  }
});

test("input alone revokes confirmation ownership at every asynchronous boundary", async () => {
  for (const stage of ["success", "stale", "franchises", "search", "detail"]) {
    const b = await ready();
    b.run(`editor(${JSON.stringify(character("A"))})`);
    const { done, request } = await confirming(b);
    if (!["success", "stale"].includes(stage)) {
      request.resolve({ characterId: "A" });
      await flush();
      if (stage !== "franchises") {
        b.requests
          .at(-1)
          .resolve([{ id: 1, display_name: "One", aliases: [] }]);
        await flush();
      }
      if (stage === "detail") {
        b.requests.at(-1).resolve({ characters: [], count: 0 });
        await flush();
      }
    }
    const response = b.requests.at(-1);
    b.elements.aliases.value = "New unsaved input";
    await b.elements.characterForm.fire("input");
    const count = b.requests.length;
    const message = b.elements.message.textContent;
    response.resolve(
      stage === "stale"
        ? { error: "Stale", refreshPreview: true }
        : stage === "success"
          ? { characterId: "A" }
          : stage === "franchises"
            ? []
            : stage === "search"
              ? { characters: [], count: 0 }
              : character("A"),
      stage === "stale" ? 409 : 200,
    );
    await done;
    assert.equal(b.elements.aliases.value, "New unsaved input", stage);
    assert.equal(b.run("pending"), null, stage);
    assert.equal(b.elements.previewPanel.hidden, true, stage);
    assert.equal(b.elements.message.textContent, message, stage);
    assert.equal(b.requests.length, count, stage);
  }
});

test("owned confirmation completes refresh and loads the committed character", async () => {
  const b = await ready();
  const { done, request } = await confirming(b);
  request.resolve({ characterId: "A" });
  await flush();
  b.requests.at(-1).resolve([{ id: 1, display_name: "One", aliases: [] }]);
  await flush();
  b.requests.at(-1).resolve({ characters: [], count: 0 });
  await flush();
  assert.ok(b.requests.at(-1).path.includes("/detail?id=A"));
  b.requests.at(-1).resolve(character("A", [1]));
  await done;
  assert.equal(b.run("current.id"), "A");
  assert.equal(b.run("pending"), null);
  assert.equal(b.elements.confirm.disabled, false);
  assert.deepEqual(
    Array.from(b.elements.franchiseIds.selectedOptions, (option) =>
      Number(option.value),
    ),
    [1],
  );
});

test("confirmation retries retain their key, while owned stale responses require a new preview", async () => {
  const b = await ready();
  const { done, request } = await confirming(b);
  request.resolve({ error: "Unknown outcome" }, 500);
  await done;
  assert.equal(b.run("pending.previewId"), "A");
  const retry = b.elements.confirm.fire("click");
  const second = b.requests.at(-1);
  assert.deepEqual(second.body, request.body);
  second.resolve({ error: "Stale", refreshPreview: true }, 409);
  await retry;
  assert.equal(b.run("pending"), null);
  assert.equal(b.elements.previewPanel.hidden, true);
  assert.match(b.elements.message.textContent, /form is preserved/);
});

test("a pending detail cannot replace input in any editor form", async () => {
  for (const form of [
    "characterForm",
    "sourceForm",
    "rankingForm",
    "franchiseForm",
  ]) {
    for (const event of ["input", "change"]) {
      const b = await ready();
      b.run(`editor(${JSON.stringify(character("A"))})`);
      const loading = b.run("loadCharacter('B')");
      const detail = b.requests.at(-1);
      b.elements.aliases.value = "Unsaved A";
      await b.elements[form].fire(event);
      detail.resolve(character("B"));
      await loading;
      assert.equal(b.run("current.id"), "A", `${form} ${event}`);
      assert.equal(b.elements.aliases.value, "Unsaved A");
    }
  }
});

test("initial franchise options retain authoritative detail memberships and subsequent user changes", async () => {
  for (const selection of ["untouched", "clear", "select"]) {
    const b = browser();
    const loading = b.run("loadCharacter('A')");
    b.requests.at(-1).resolve(character("A", [1]));
    await loading;
    if (selection !== "untouched") {
      for (const option of b.elements.franchiseIds.options)
        option.selected = false;
      if (selection === "select")
        b.elements.franchiseIds.append({ value: "2", selected: true });
      await b.elements.franchiseIds.fire("change");
    }
    const rows = [
      { id: 1, display_name: "One", aliases: [] },
      { id: 2, display_name: "Two", aliases: [] },
    ];
    b.requests.find((r) => r.path === "/api/catalog/franchises").resolve(rows);
    await flush();
    const expected =
      selection === "untouched" ? [1] : selection === "clear" ? [] : [2];
    assert.deepEqual(
      Array.from(b.elements.franchiseIds.selectedOptions, (option) =>
        Number(option.value),
      ),
      expected,
    );
    const refreshing = b.run("loadFranchises()");
    for (const option of b.elements.franchiseIds.options)
      option.selected = Number(option.value) === 2;
    await b.elements.franchiseIds.fire("input");
    b.requests.at(-1).resolve(rows);
    await refreshing;
    assert.deepEqual(
      Array.from(b.elements.franchiseIds.selectedOptions, (option) =>
        Number(option.value),
      ),
      [2],
    );
    const editing = b.elements.characterForm.fire("submit");
    assert.deepEqual(b.requests.at(-1).body.input.franchiseIds, [2]);
    b.requests
      .at(-1)
      .resolve({ previewId: "memberships", payloadHash: "hash" });
    await editing;
  }
});
