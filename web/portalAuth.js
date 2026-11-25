import { randomBytes, scryptSync, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { readFileSync } from "node:fs";

const derive = promisify(scrypt);
const OPTIONS = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const COOKIE = "portal_session";
const loginHtml = readFileSync(new URL("./login.html", import.meta.url));

// Fixed, bounded scrypt parameters prevent configuration-driven resource exhaustion.
export function hashPortalPassword(password) {
  if (
    typeof password !== "string" ||
    password.length < 12 ||
    Buffer.byteLength(password) > 1024
  )
    throw new Error(
      "Password must have at least 12 characters and at most 1024 UTF-8 bytes",
    );
  const salt = randomBytes(16);
  return `scrypt$16384$8$1$${salt.toString("hex")}$${scryptSync(password, salt, 64, OPTIONS).toString("hex")}`;
}

function parseHash(value) {
  const match =
    typeof value === "string" &&
    /^scrypt\$16384\$8\$1\$([a-f0-9]{32})\$([a-f0-9]{128})$/.exec(value);
  if (!match)
    throw new Error(
      "Invalid portal password hash; use scripts/hashPortalPassword.js",
    );
  return {
    salt: Buffer.from(match[1], "hex"),
    key: Buffer.from(match[2], "hex"),
  };
}

export function portalAuthConfig(env = process.env) {
  const config = {
    accounts: ["admin", "moderator"].map((role) => ({
      role,
      username: env[`PORTAL_${role.toUpperCase()}_USERNAME`],
      passwordHash: env[`PORTAL_${role.toUpperCase()}_PASSWORD_HASH`],
    })),
    publicOrigin: env.PORTAL_PUBLIC_ORIGIN,
  };
  validateConfig(config);
  return config;
}

function validateConfig(config) {
  if (
    !config ||
    !Array.isArray(config.accounts) ||
    config.accounts.length !== 2
  )
    throw new Error("Configure both portal admin and moderator accounts");
  for (const role of ["admin", "moderator"]) {
    const account = config.accounts.find((entry) => entry.role === role);
    if (
      !account ||
      typeof account.username !== "string" ||
      !/^[A-Za-z0-9_.@-]{1,80}$/.test(account.username)
    )
      throw new Error(`Invalid or missing portal ${role} username`);
    parseHash(account.passwordHash);
  }
  if (config.accounts[0].username === config.accounts[1].username)
    throw new Error("Portal usernames must be distinct");
  if (config.publicOrigin) {
    const url = new URL(config.publicOrigin);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.origin !== config.publicOrigin
    )
      throw new Error(
        "PORTAL_PUBLIC_ORIGIN must be an exact HTTP(S) origin without a trailing slash",
      );
    if (
      url.protocol !== "https:" &&
      !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
    )
      throw new Error("Non-loopback public portal origins require HTTPS");
  }
}

// Entrypoints call this explicitly, before opening a catalog. No implicit dotenv dependency.
export function loadPortalEnvironment() {
  try {
    process.loadEnvFile(process.env.PORTAL_ENV_FILE || ".env");
  } catch (error) {
    if (error.code !== "ENOENT" || process.env.PORTAL_ENV_FILE) throw error;
  }
  return portalAuthConfig();
}

function json(response, status, body) {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify(body));
}
function equal(a, b) {
  return (
    typeof a === "string" &&
    typeof b === "string" &&
    Buffer.byteLength(a) === Buffer.byteLength(b) &&
    timingSafeEqual(Buffer.from(a), Buffer.from(b))
  );
}
async function readLogin(request) {
  let data = "";
  for await (const chunk of request) {
    data += chunk;
    if (Buffer.byteLength(data) > 4096) throw new Error("Invalid login");
  }
  return JSON.parse(data);
}

export function createPortalAuth(
  config = portalAuthConfig(),
  { now = Date.now } = {},
) {
  validateConfig(config);
  const accounts = config.accounts.map((account) => ({
    ...account,
    ...parseHash(account.passwordHash),
  }));
  const sessions = new Map();
  const attempts = new Map();
  const ttl = 8 * 60 * 60 * 1000;
  const windowMs = 15 * 60 * 1000;
  const token = () => randomBytes(32).toString("hex");
  function session(request) {
    const id = /(?:^|;\s*)portal_session=([a-f0-9]{64})(?:;|$)/.exec(
      request.headers.cookie || "",
    )?.[1];
    const value = sessions.get(id);
    return value && value.expires > now() ? { id, ...value } : null;
  }
  function cookie(response, id, secure, clear = false) {
    response.setHeader(
      "set-cookie",
      `${COOKIE}=${id}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${clear ? 0 : ttl / 1000}${secure ? "; Secure" : ""}`,
    );
  }
  return {
    origin(hostOrigin) {
      return config.publicOrigin || hostOrigin;
    },
    async handle(request, response, url, origin) {
      response.setHeader("cache-control", "no-store");
      response.setHeader("x-content-type-options", "nosniff");
      response.setHeader("referrer-policy", "same-origin");
      response.setHeader("x-frame-options", "DENY");
      const time = now();
      for (const [id, value] of sessions)
        if (value.expires <= time) sessions.delete(id);
      for (const [ip, value] of attempts)
        if (value.until <= time) attempts.delete(ip);
      const secure = origin.startsWith("https:");
      const mutating = !["GET", "HEAD", "OPTIONS"].includes(request.method);
      if (
        (request.headers.origin && request.headers.origin !== origin) ||
        (mutating && request.headers.origin !== origin)
      ) {
        json(response, 403, { error: "Invalid origin" });
        return true;
      }
      if (request.method === "GET" && url.pathname === "/login") {
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        response.end(loginHtml);
        return true;
      }
      if (request.method === "GET" && url.pathname === "/assets/login.js")
        return false;
      if (request.method === "POST" && url.pathname === "/api/auth/login") {
        // Remote socket identity only: never trust caller-controlled Forwarded/X-Forwarded-*.
        const ip = request.socket.remoteAddress;
        const attempt = attempts.get(ip) || {
          count: 0,
          until: time + windowMs,
        };
        if (
          attempt.count >= 5 ||
          (attempts.size >= 10000 && !attempts.has(ip))
        ) {
          response.setHeader(
            "retry-after",
            String(Math.max(1, Math.ceil((attempt.until - time) / 1000))),
          );
          json(response, 429, { error: "Too many login attempts; try later" });
          return true;
        }
        attempt.count++;
        attempts.set(ip, attempt);
        if (
          !/^application\/json(?:\s*;|$)/i.test(
            request.headers["content-type"] || "",
          )
        ) {
          json(response, 415, { error: "JSON required" });
          return true;
        }
        let body;
        try {
          body = await readLogin(request);
        } catch {
          json(response, 400, { error: "Invalid login" });
          return true;
        }
        const account = accounts.find(
          (entry) => entry.username === body?.username,
        );
        const password = body?.password;
        if (
          typeof password !== "string" ||
          Buffer.byteLength(password) > 1024
        ) {
          json(response, 401, { error: "Invalid credentials" });
          return true;
        }
        // Unknown accounts still do the same expensive derivation.
        const candidate = await derive(
          password,
          (account || accounts[0]).salt,
          64,
          OPTIONS,
        );
        if (!account || !timingSafeEqual(candidate, account.key)) {
          json(response, 401, { error: "Invalid credentials" });
          return true;
        }
        const old = session(request);
        if (old) sessions.delete(old.id);
        if (sessions.size >= 10000) {
          json(response, 503, { error: "Session capacity reached" });
          return true;
        }
        const id = token();
        const value = {
          username: account.username,
          role: account.role,
          csrfToken: token(),
          expires: time + ttl,
        };
        sessions.set(id, value);
        cookie(response, id, secure);
        json(response, 200, {
          username: value.username,
          role: value.role,
          csrfToken: value.csrfToken,
        });
        return true;
      }
      const current = session(request);
      if (!current) {
        if (
          url.pathname.includes("/api/") ||
          url.pathname.startsWith("/assets/") ||
          request.method !== "GET"
        )
          json(response, 401, { error: "Authentication required" });
        else {
          response.writeHead(303, { location: "/login" });
          response.end();
        }
        return true;
      }
      if (
        mutating &&
        !equal(request.headers["x-csrf-token"], current.csrfToken)
      ) {
        json(response, 403, { error: "Invalid CSRF token" });
        return true;
      }
      if (request.method === "POST" && url.pathname === "/api/auth/logout") {
        sessions.delete(current.id);
        cookie(response, "", secure, true);
        json(response, 200, { loggedOut: true });
        return true;
      }
      // Only safe attribution is attached; never expose session identifiers/hashes to route handlers.
      request.portalAccount = Object.freeze({
        username: current.username,
        role: current.role,
      });
      if (request.method === "GET" && url.pathname === "/api/auth/session") {
        json(response, 200, {
          ...request.portalAccount,
          csrfToken: current.csrfToken,
        });
        return true;
      }
      const adminOnly =
        url.pathname === "/config" ||
        url.pathname.startsWith("/config/") ||
        url.pathname === "/game" ||
        url.pathname.startsWith("/game/") ||
        /^\/api\/(config|game)(\/|$)/.test(url.pathname);
      if (adminOnly && current.role !== "admin") {
        json(response, 403, { error: "Admin access required" });
        return true;
      }
      return false;
    },
  };
}
