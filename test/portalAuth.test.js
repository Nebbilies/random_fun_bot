import assert from "node:assert/strict";
import test from "node:test";
import { once } from "node:events";
import { createServer, request as httpRequest } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createPortalAuth,
  portalAuthConfig,
  hashPortalPassword,
} from "../web/portalAuth.js";
import { createReviewServer } from "../web/reviewCharacterTags.js";
import { createFranchiseReviewServer } from "../web/reviewFranchises.js";
import { openCatalog, setMeta } from "../lib/catalogDb.js";
import { authConfig, password, login } from "./helpers/portalAuth.js";

const jsonHeaders = (origin) => ({
  origin,
  "content-type": "application/json",
});
async function stop(server) {
  await new Promise((resolve) => {
    server.close(resolve);
    server.closeAllConnections();
  });
}

test("credentials fail closed and hash format is salted and strictly bounded", () => {
  assert.throws(() => portalAuthConfig({}), /username/);
  assert.throws(() => createPortalAuth({}), /both/);
  for (const passwordHash of ["", "plaintext", "scrypt$99999999$8$1$aa$bb"]) {
    assert.throws(
      () =>
        createPortalAuth({
          accounts: authConfig.accounts.map((a) => ({ ...a, passwordHash })),
        }),
      /hash/,
    );
  }
  assert.notEqual(hashPortalPassword(password), hashPortalPassword(password));
  assert.throws(() => hashPortalPassword("short"), /12/);
  assert.throws(
    () =>
      createPortalAuth({
        ...authConfig,
        accounts: authConfig.accounts.map((a) => ({ ...a, username: "same" })),
      }),
    /distinct/,
  );
  assert.throws(
    () =>
      createPortalAuth({
        ...authConfig,
        publicOrigin: "http://portal.example",
      }),
    /HTTPS/,
  );
});

for (const standalone of [false, true]) {
  test(`${standalone ? "standalone" : "integrated"} server enforces role, session, origin, host and CSRF boundaries`, async (t) => {
    const directory = mkdtempSync(join(tmpdir(), "portal-auth-"));
    const db = openCatalog(join(directory, "catalog.sqlite"));
    setMeta(db, "import_phase", "complete");
    const makeServer = standalone
      ? createFranchiseReviewServer
      : createReviewServer;
    assert.throws(() => makeServer({ db, port: 0, authConfig: {} }), /both/);
    const server = makeServer({
      db,
      port: 0,
      authConfig,
      api: { searchTagsLiteral: async () => [], exactTag: async () => null },
      fetchImpl: async () => ({ ok: true, json: async () => [] }),
    });
    t.after(async () => {
      await stop(server);
      db.close();
      rmSync(directory, { recursive: true, force: true });
    });
    await once(server, "listening");
    const origin = `http://127.0.0.1:${server.address().port}`;
    const franchise = standalone ? "" : "/franchise";
    const allowed = [
      franchise || "/",
      `${franchise}/api/franchises`,
      `${franchise}/api/franchise-options`,
      `${franchise}/api/unassigned`,
      `${franchise}/api/franchise?id=1`,
      "/assets/portal.js",
    ];
    if (!standalone)
      allowed.push(
        "/",
        "/api/status",
        "/api/next",
        "/api/reports/next",
        "/api/reports/history",
        "/api/search?query=xx",
        "/api/preview?tag=xx",
      );
    const denied = [
      "/config",
      "/game",
      "/api/config",
      "/api/config/section",
      "/api/config/activate-schedule",
      "/api/game/items",
      "/api/game/rates",
      "/api/game/give-item",
      "/api/game/add-rolls",
      "/api/game/reset-claims",
    ];
    for (const path of [...allowed, ...denied]) {
      const response = await fetch(origin + path, { redirect: "manual" });
      assert.ok(
        [303, 401].includes(response.status),
        `anonymous ${path}: ${response.status}`,
      );
    }
    assert.equal((await fetch(`${origin}/login`)).status, 200);
    assert.equal((await fetch(`${origin}/assets/login.js`)).status, 200);
    assert.equal(
      (
        await fetch(`${origin}/api/auth/login`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
        })
      ).status,
      403,
    );
    const admin = await login(origin);
    const moderator = await login(origin, "moderator");
    assert.match(admin.cookie, /^portal_session=[a-f0-9]{64}$/);
    for (const [role, client] of [
      ["admin", admin],
      ["moderator", moderator],
    ]) {
      const headers = {
        ...jsonHeaders(origin),
        cookie: client.cookie,
        "x-csrf-token": client.csrfToken,
      };
      for (const path of denied) {
        for (const method of ["GET", "POST"]) {
          const response = await fetch(origin + path, {
            method,
            headers,
            ...(method === "POST" ? { body: "{}" } : {}),
          });
          if (role === "moderator")
            assert.equal(response.status, 403, `${role} ${method} ${path}`);
          else
            assert.ok(
              ![401, 403].includes(response.status),
              `${role} ${method} ${path}`,
            );
        }
      }
      // Valid local catalog requests reach the handlers for both roles.
      for (const path of allowed) {
        const response = await fetch(origin + path, { headers });
        assert.ok(![401, 403].includes(response.status), `${role} ${path}`);
      }
      const mutations = [`${franchise}/api/correction`];
      if (!standalone) mutations.push("/api/decision", "/api/reports/resolve");
      for (const path of mutations) {
        assert.equal(
          (
            await fetch(origin + path, {
              method: "POST",
              headers: { ...headers, "x-csrf-token": "" },
              body: "{}",
            })
          ).status,
          403,
        );
        assert.equal(
          (
            await fetch(origin + path, {
              method: "POST",
              headers: { ...headers, origin: "https://evil.example" },
              body: "{}",
            })
          ).status,
          403,
        );
        const response = await fetch(origin + path, {
          method: "POST",
          headers,
          body: "{}",
        });
        assert.ok(![401, 403].includes(response.status), `${role} ${path}`);
      }
    }
    const headers = {
      ...jsonHeaders(origin),
      cookie: moderator.cookie,
      "x-csrf-token": moderator.csrfToken,
    };
    const created = await fetch(`${origin}${franchise}/api/correction`, {
      method: "POST",
      headers,
      body: JSON.stringify({ action: "create", name: "Auth Test Franchise" }),
    });
    assert.equal(created.status, 200);
    assert.equal(
      (
        await fetch(`${origin}/api/auth/session`, {
          headers: { cookie: admin.cookie, origin: "https://evil.example" },
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await fetch(`${origin}/api/auth/logout`, {
          method: "POST",
          headers: { ...headers, "x-csrf-token": admin.csrfToken },
        })
      ).status,
      403,
    );
    const logout = await fetch(`${origin}/api/auth/logout`, {
      method: "POST",
      headers,
    });
    assert.equal(logout.status, 200);
    assert.match(logout.headers.get("set-cookie"), /Max-Age=0/);
    assert.equal(
      (
        await fetch(`${origin}/api/auth/session`, {
          headers: { cookie: moderator.cookie },
        })
      ).status,
      401,
    );
    const foreignHost = await new Promise((resolve, reject) => {
      const req = httpRequest(
        `${origin}/login`,
        {
          headers: {
            host: "evil.example",
            "x-forwarded-host": new URL(origin).host,
          },
        },
        (res) => {
          res.resume();
          res.on("end", () => resolve(res.statusCode));
        },
      );
      req.on("error", reject);
      req.end();
    });
    assert.equal(foreignHost, 403);
  });
}

test("expiry, cookie flags, logout, attribution and bounded login throttling", async (t) => {
  let time = Date.now();
  const auth = createPortalAuth(
    { ...authConfig, publicOrigin: "https://portal.example" },
    { now: () => time },
  );
  const server = createServer(async (request, response) => {
    const origin = auth.origin("http://ignored");
    if (
      !(await auth.handle(
        request,
        response,
        new URL(request.url, origin),
        origin,
      ))
    ) {
      response.end(JSON.stringify(request.portalAccount));
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => stop(server));
  const base = `http://127.0.0.1:${server.address().port}`;
  const headers = jsonHeaders("https://portal.example");
  const signIn = (username = "test-admin", pass = password) =>
    fetch(`${base}/api/auth/login`, {
      method: "POST",
      headers,
      body: JSON.stringify({ username, password: pass }),
    });
  const first = await signIn();
  assert.equal(first.status, 200);
  const setCookie = first.headers.get("set-cookie");
  for (const flag of [
    "HttpOnly",
    "SameSite=Strict",
    "Secure",
    "Path=/",
    "Max-Age=28800",
  ])
    assert.ok(setCookie.includes(flag));
  assert.doesNotMatch(setCookie, /Domain=/);
  const cookie = setCookie.split(";")[0];
  const body = await first.json();
  assert.deepEqual(
    await (await fetch(base + "/", { headers: { cookie } })).json(),
    { username: "test-admin", role: "admin" },
  );
  assert.doesNotMatch(
    JSON.stringify(body),
    /password|scrypt|salt|expires|portal_session/,
  );
  time += 8 * 60 * 60 * 1000;
  assert.equal(
    (await fetch(base + "/api/auth/session", { headers: { cookie } })).status,
    401,
  );
  for (let i = 0; i < 5; i++)
    assert.equal(
      (await signIn(i % 2 ? "unknown" : "test-admin", "wrong")).status,
      401,
    );
  const limited = await signIn();
  assert.equal(limited.status, 429);
  assert.ok(limited.headers.get("retry-after"));
  time += 15 * 60 * 1000;
  assert.equal((await signIn()).status, 200);
});
