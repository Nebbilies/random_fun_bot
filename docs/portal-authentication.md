# Management portal authentication

Both `node web/reviewCharacterTags.js` (integrated portal) and `node web/reviewFranchises.js` (standalone franchise workspace) require **both** accounts before listening. There is no registration, account editor, plaintext-password environment setting, or unauthenticated development/test mode. This setup does not migrate or access a database when generating hashes.

## Credentials and explicit environment loading

Use Node with `process.loadEnvFile` support (Node 22+ is recommended). Run this locally in a private interactive terminal, once per account:

```sh
node scripts/hashPortalPassword.js
```

The script reads a hidden password and confirmation in terminal raw mode. It rejects arguments and redirected input, prints only a salted scrypt hash, and does not echo the password. Minimum password length is 12 characters; use a long, unique password for each account. Do not put plaintext in shell arguments, environment variables, logs, or source control. Protect the hash output as credential material too.

Configure these four required variables:

```dotenv
PORTAL_ADMIN_USERNAME=portal-admin
PORTAL_ADMIN_PASSWORD_HASH="scrypt$16384$8$1$<32 lowercase hex salt>$<128 lowercase hex derived key>"
PORTAL_MODERATOR_USERNAME=portal-moderator
PORTAL_MODERATOR_PASSWORD_HASH="scrypt$16384$8$1$<different salt>$<derived key>"
```

Replace the entire hash placeholders with generated output. Usernames must be distinct, 1–80 ASCII letters/digits or `_.@-`. Only the fixed scrypt format produced by the script is accepted; malformed/missing configuration stops startup. Scrypt uses a fresh 16-byte salt and a 64-byte derived key with N=16384, r=8, p=1, using built-in Node crypto. Do not hand-edit algorithm parameters.

The CLI entry points explicitly load `.env` from the working directory, then validate credentials **before opening the catalog**. An absent default `.env` is allowed only if the required process environment is already present. To select a different file, set `PORTAL_ENV_FILE` in the process environment; a missing explicit file is fatal. Node's environment-file loader preserves existing process environment values. Keep credential files out of source control and restrict filesystem permissions. Programmatic server constructors validate the process environment unless passed an explicit `authConfig`; they do not implicitly read files. Tests inject explicit test-only configurations and log in normally.

## Network and TLS

Loopback binding and existing `--host`, `--port`, and `--public-host` Host validation remain in place. Do not expose this HTTP listener directly to an untrusted network. For remote access terminate HTTPS at a trusted reverse proxy or use a private SSH tunnel.

Set `PORTAL_PUBLIC_ORIGIN=https://portal.example` when the browser uses HTTPS (an exact origin, no path or trailing slash). This enables Secure cookies and sets the exact required Origin for login and every mutation. Non-loopback configured HTTP origins are rejected. Without an explicit public origin, the existing validated HTTP Host/port determines the origin; this is intended for local HTTP use. Never use HTTP for credentials over an untrusted network.

No `Forwarded`, `X-Forwarded-Host`, `X-Forwarded-Proto`, or `X-Forwarded-For` headers are trusted. A TLS proxy must send the **backend** Host hostname and listening port matching `--public-host` and `--port`; it must preserve the browser's Origin header. `PORTAL_PUBLIC_ORIGIN` defines the browser-facing origin independently, not a replacement for Host validation. Restrict backend reachability to the proxy. This preserves DNS-rebinding/Host defense without trusting arbitrary proxy headers. Login throttling uses socket addresses, so all clients behind one proxy share its login limit. The standalone server needs its own correct public origin when deployed separately; set per-process environments if origins differ.

## Sessions and browser behavior

Open any workspace to reach `/login`. Only the login page, `/assets/login.js`, and the JSON login endpoint are intentionally anonymous. All other pages, assets, and APIs require authentication. Pages redirect to login; APIs return 401. Workspace modules load session details, attach CSRF headers to same-origin mutations, hide admin navigation for moderators, and provide a sign-out button. Direct API calls remain subject to the same server-side permission checks.

Sessions are opaque random 256-bit tokens stored only in server memory, with a fixed eight-hour lifetime. Cookies are HttpOnly, SameSite=Strict, Path=/, host-only, and Secure for configured HTTPS. Login replaces the current session; logout invalidates it server-side and clears the cookie. Restarting the process invalidates all sessions. There is no cross-process session sharing: route one portal origin to one server process (or use affinity), rather than round-robin between independent processes. Rotate credentials by updating configuration and restarting; existing sessions do not survive that restart.

Mutations (including logout) require both the exact Origin and the session's independent CSRF token in `X-CSRF-Token`. Login has no prior session and requires JSON and the exact Origin, preventing login CSRF. `/api/auth/session` returns only username, role, and CSRF token, never hashes/passwords/session tokens. Route handlers receive `request.portalAccount = { username, role }` for future mutation attribution; this phase does not invent attribution for old catalog history or implement the later mutation log.

Login attempts, successful or unsuccessful, are limited to five per socket address per 15 minutes, with 429 and Retry-After thereafter. Unknown accounts still perform scrypt derivation. Sessions and throttle entries have bounded in-memory capacities and expired entries are pruned. A restart clears rate-limit state; enforce additional perimeter limits for public deployments. Do not log request bodies or Cookie/Set-Cookie headers at the proxy.

## Permission matrix

| Workspace / API | Admin | Moderator |
| --- | --- | --- |
| Character/tag review and report resolution | Yes | Yes |
| Franchise pages, searches, corrections (integrated and standalone) | Yes | Yes |
| Catalog character/source/likes management | Yes, through attributed preview/confirmation services | Yes, through the same services |
| Configuration page and all `/api/config` routes | Yes | No, including reads |
| Game administration page and all `/api/game` routes | Yes | No, including item roster/rates reads |
| Item grants, added rolls, claim resets | Yes | No |
| Session info / logout | Own session | Own session |

Checks run before assets or route dispatch on both server entry points, including unknown methods on admin namespaces. Exported internal route handlers are not standalone HTTP entry points; new entry points must install the shared auth gate before invoking them. New admin APIs outside `/api/config` or `/api/game` must explicitly extend the authorization policy. Do not rely on sidebar visibility.

## Verification and integration notes

Focused tests: `node --test test/portalAuth.test.js test/configPortal.test.js test/franchiseReview.test.js test/gameReview.test.js test/characterCatalog.test.js`.

Tests use isolated temporary catalogs and explicit accounts. They cover both entry points, anonymous/admin/moderator boundaries, credentials, cookie flags, expiry, logout, Origin/Host/CSRF rejection, rate limiting, and existing authorized operations. Browser configuration coverage runs when a supported browser executable is available. No production database is used.

The integrated server still requires the existing completed import marker before exposing tag review. Removing that bootstrap restriction for an empty/manual-only catalog belongs to the later catalog/manual-workflow phase. This phase does not implement catalog edits, mutation history, or migration.
