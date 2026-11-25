import assert from "node:assert/strict";
import {
  authConfig,
  authenticatedFetch as fetch,
  login,
  password,
} from "./helpers/portalAuth.js";
import test from "node:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { chromium } from "playwright-core";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { openCatalog, setMeta } from "../lib/catalogDb.js";
import { initGameConfig } from "../lib/gameConfig.js";
import { createReviewServer } from "../web/reviewCharacterTags.js";

test("configuration portal validates atomic writes, inheritance, reset, revision and activation", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "config-portal-"));
  const db = openCatalog(join(directory, "catalog.sqlite"));
  initGameConfig(db);
  setMeta(db, "import_phase", "complete");
  const server = createReviewServer({ db, port: 0, authConfig });
  t.after(async () => {
    await new Promise((resolve) => {
      server.close(resolve);
      server.closeAllConnections();
    });
    db.close();
    rmSync(directory, { recursive: true, force: true });
  });
  await once(server, "listening");
  const origin = `http://127.0.0.1:${server.address().port}`;
  const get = (guild = "") =>
    fetch(`${origin}/api/config${guild ? `?guildId=${guild}` : ""}`).then((r) =>
      r.json(),
    );
  const post = (body, path = "section", headers = {}) =>
    fetch(`${origin}/api/config/${path}`, {
      method: "POST",
      headers: { origin, "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
  let view = await get();
  assert.ok(view.registry["rolls.maxRolls"]);
  assert.deepEqual(view.effective.itemExpiryDays, {
    common: 2,
    rare: 4,
    epic: 7,
    legendary: 14,
    "???": 30,
  });
  assert.equal(view.sources["rolls.maxRolls"], "builtin");
  assert.deepEqual(view.effective, view.defaults);
  const save = {
    section: "rolls",
    values: { "rolls.maxRolls": 12 },
    expectedRevision: view.revision,
  };
  assert.equal(
    (await post(save, "section", { origin: "http://evil.example" })).status,
    403,
  );
  assert.equal(
    (await post(save, "section", { "content-type": "application/jsonp" }))
      .status,
    415,
  );
  for (const body of [
    null,
    [],
    {},
    { ...save, values: { "rolls.maxRolls": 0 } },
    { ...save, values: { "rolls.maxRolls": 12, "vault.enabled": false } },
    { ...save, values: { "config.token": "secret" } },
    { ...save, guildId: "invalid" },
  ]) {
    assert.equal((await post(body)).status, 400);
  }
  assert.equal((await get()).revision, view.revision);
  assert.equal((await post(save)).status, 200);
  assert.equal((await post(save)).status, 409);
  view = await get("123");
  assert.equal(view.effective.rolls.maxRolls, 12);
  assert.equal(view.sources["rolls.maxRolls"], "global");
  assert.equal(
    (
      await post({
        ...save,
        guildId: "123",
        values: { "rolls.maxRolls": 15 },
        expectedRevision: view.revision,
      })
    ).status,
    200,
  );
  view = await get("123");
  assert.equal(view.effective.rolls.maxRolls, 15);
  assert.equal(view.sources["rolls.maxRolls"], "guild");
  assert.equal(
    (
      await post({
        guildId: "123",
        section: "rolls",
        reset: true,
        expectedRevision: view.revision,
      })
    ).status,
    200,
  );
  view = await get("123");
  assert.equal(view.effective.rolls.maxRolls, 12);
  assert.equal(view.sources["rolls.maxRolls"], "global");
  const schedule = {
    section: "schedules",
    values: { "schedules.rollIntervalMs": 7200000 },
    expectedRevision: view.revision,
  };
  assert.equal((await post(schedule)).status, 400);
  assert.equal((await post(schedule, "activate-schedule")).status, 400);
  assert.equal(
    (await post({ ...schedule, confirmActivation: true }, "activate-schedule"))
      .status,
    200,
  );
  view = await get();
  assert.equal(
    (
      await post({
        section: "rolls",
        reset: true,
        expectedRevision: view.revision,
      })
    ).status,
    200,
  );
  assert.equal((await get()).sources["rolls.maxRolls"], "builtin");
  assert.equal((await fetch(`${origin}/api/config?guildId=`)).status, 400);
  for (const body of ["{", JSON.stringify({ padding: "x".repeat(66000) })]) {
    assert.equal(
      (
        await fetch(`${origin}/api/config/section`, {
          method: "POST",
          headers: { origin, "content-type": "application/json" },
          body,
        })
      ).status,
      400,
    );
  }
  for (const path of ["/", "/game", "/franchise", "/config", "/catalog"]) {
    const html = await fetch(origin + path).then((r) => r.text());
    assert.match(html, /href="\/config"/);
    const navigation = html.match(
      /<nav aria-label="Management portal">([\s\S]*?)<\/nav>/,
    )?.[1];
    assert.ok(navigation, `${path} has management navigation`);
    assert.match(
      navigation,
      /<a href="\/catalog"(?: aria-current="page")?\s*>[\s\S]*?Catalog[\s\S]*?<\/a\s*>/,
    );
    assert.equal((navigation.match(/href="\/catalog"/g) || []).length, 1);
  }
  const page = await fetch(`${origin}/config`).then((r) => r.text());
  assert.match(page, /id="scopeForm"/);
  assert.match(page, /id="changeReview"/);
  assert.match(page, /reviewConfig.js/);
  assert.match(page, /Reload \/ discard edits/);
  const script = await fetch(`${origin}/assets/reviewConfig.js`).then((r) =>
    r.text(),
  );
  assert.ok(script.includes("Applies to newly acquired items only."));
  for (const marker of [
    "view.registry",
    "view.sources",
    "expectedRevision",
    "/api/config/activate-schedule",
    "dialog.showModal()",
    "reportValidity()",
    "input.type = 'checkbox'",
    "JSON.parse(input.value)",
  ])
    assert.ok(script.includes(marker), marker);
  const game = await fetch(`${origin}/game`).then((r) => r.text());
  assert.doesNotMatch(game, /id="rateForm"|id="customRatesList"/);
  assert.match(game, /id="giveItemForm"/);
  assert.equal((await fetch(`${origin}/assets/../config.js`)).status, 404);
  view = await get("123");
  assert.equal(
    (
      await post({
        guildId: "123",
        section: "items",
        values: { "items.golden_whistle.startingCharges": 9 },
        expectedRevision: view.revision,
      })
    ).status,
    200,
  );
  const roster = await fetch(`${origin}/api/game/items?guildId=123`).then((r) =>
    r.json(),
  );
  assert.equal(roster.find((item) => item.id === "golden_whistle").charges, 9);
  const grant = await fetch(`${origin}/api/game/give-item`, {
    method: "POST",
    headers: { origin, "content-type": "application/json" },
    body: JSON.stringify({
      guildId: "123",
      userId: "456",
      itemId: "golden_whistle",
    }),
  });
  assert.equal(grant.status, 200);
  assert.equal((await grant.json()).item.charges, 9);
  const executablePath =
    process.env.CHROME_PATH ||
    [
      "C:/Program Files/Google/Chrome/Application/chrome.exe",
      "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
    ].find(existsSync);
  await t.test(
    "browser wires review, save, field reset, structured validation and mobile layout",
    { skip: !executablePath },
    async () => {
      const browser = await chromium.launch({ executablePath, headless: true });
      try {
        const page = await browser.newPage({
          viewport: { width: 390, height: 844 },
        });
        const errors = [];
        page.on("pageerror", (error) => errors.push(error.message));
        const session = await login(origin);
        await page.context().addCookies([
          {
            name: "portal_session",
            value: session.cookie.split("=")[1],
            url: origin,
          },
        ]);
        await page.goto(`${origin}/config`);
        const expiry = page.getByLabel("Common (days)", { exact: true });
        assert.equal(await expiry.inputValue(), "2");
        assert.equal(await expiry.getAttribute("min"), "1");
        assert.equal(await expiry.getAttribute("max"), "365");
        assert.equal(await expiry.getAttribute("step"), "1");
        await page
          .getByText("Applies to newly acquired items only.", { exact: true })
          .waitFor();
        assert.equal(
          await page.getByLabel("??? (days)", { exact: true }).inputValue(),
          "30",
        );
        const input = page.locator('[data-key="rolls.maxRolls"]');
        await input.fill("13");
        await input
          .locator("xpath=ancestor::form")
          .getByRole("button", { name: "Review changes…", exact: true })
          .click();
        await page.locator("#changeReview").waitFor({ state: "visible" });
        assert.match(await page.locator("#reviewChanges").innerText(), /13/);
        await page.locator("#confirmChanges").click();
        await page.waitForFunction(() =>
          document
            .querySelector("#configStatus")
            .textContent.startsWith("Saved."),
        );
        assert.equal((await get()).effective.rolls.maxRolls, 13);
        await input
          .locator("..")
          .getByRole("button", { name: "Reset this setting…" })
          .click();
        await page.locator("#confirmChanges").click();
        await page.waitForFunction(
          () =>
            document.querySelector('[data-key="rolls.maxRolls"]').value !==
            "13",
        );
        assert.equal((await get()).sources["rolls.maxRolls"], "builtin");
        const structured = page.locator('[data-key="mystery.oddsAnchors"]');
        await structured.fill("{bad");
        await structured
          .locator("xpath=ancestor::form")
          .getByRole("button", { name: "Review changes…", exact: true })
          .click();
        assert.equal(await structured.getAttribute("aria-invalid"), "true");
        assert.equal(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= window.innerWidth,
          ),
          true,
        );
        assert.deepEqual(errors, []);
        await page
          .getByRole("button", { name: "Sign out (test-admin)", exact: true })
          .click();
        await page.waitForURL(`${origin}/login`);
        await page.locator('[name="username"]').fill("test-moderator");
        await page.locator('[name="password"]').fill(password);
        await page
          .getByRole("button", { name: "Sign in", exact: true })
          .click();
        await page.waitForURL(`${origin}/`);
        await page
          .getByRole("button", {
            name: "Sign out (test-moderator)",
            exact: true,
          })
          .waitFor();
        assert.equal(
          await page.locator('nav a[href="/config"]').isVisible(),
          false,
        );
        assert.equal(
          await page.locator('nav a[href="/game"]').isVisible(),
          false,
        );
        await page.locator('nav a[href="/catalog"]').click();
        await page.waitForURL(`${origin}/catalog`);
        assert.equal(
          await page
            .locator('nav a[href="/catalog"][aria-current="page"]')
            .isVisible(),
          true,
        );
        assert.equal(
          await page.evaluate(() =>
            fetch("/api/config").then((response) => response.status),
          ),
          403,
        );
        await page
          .getByRole("button", {
            name: "Sign out (test-moderator)",
            exact: true,
          })
          .click();
        await page.waitForURL(`${origin}/login`);
      } finally {
        await browser.close();
      }
    },
  );
});
