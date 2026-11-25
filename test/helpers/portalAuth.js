import { hashPortalPassword } from "../../web/portalAuth.js";

export const password = "test-only-portal-password";
export const authConfig = {
  accounts: ["admin", "moderator"].map((role) => ({
    role,
    username: `test-${role}`,
    passwordHash: hashPortalPassword(password),
  })),
};

export async function login(origin, role = "admin") {
  const response = await globalThis.fetch(`${origin}/api/auth/login`, {
    method: "POST",
    headers: { origin, "content-type": "application/json" },
    body: JSON.stringify({ username: `test-${role}`, password }),
  });
  if (response.status !== 200)
    throw new Error(`Test login failed: ${response.status}`);
  return {
    cookie: response.headers.get("set-cookie").split(";")[0],
    ...(await response.json()),
  };
}

// Explicit test-only client, never installed as a production/global fetch override.
const clients = new Map();
export async function authenticatedFetch(input, init = {}) {
  const origin = new URL(input).origin;
  if (!clients.has(origin)) clients.set(origin, login(origin));
  const client = await clients.get(origin);
  const headers = new Headers({
    origin,
    cookie: client.cookie,
    "x-csrf-token": client.csrfToken,
  });
  new Headers(init.headers).forEach((value, key) => headers.set(key, value));
  return globalThis.fetch(input, { ...init, headers });
}
