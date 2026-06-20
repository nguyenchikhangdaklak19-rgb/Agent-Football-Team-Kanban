/*
 * remote — HTTP client for board.js remote mode.
 *
 * This is a pure library: no process.exit, minimal console output.
 * Requires Node 18+ (global fetch).
 *
 * Auth approach (option a — two-step):
 *   1. POST /api/login with { password } → server issues an HMAC-signed session
 *      cookie named auth.COOKIE_NAME (currently "board_token").
 *   2. POST /api/move with that cookie (Cookie header) and the move payload.
 *
 * Configuration precedence (flags override env):
 *   - remote URL:  --remote <url>  >  env BOARD_REMOTE
 *   - password:    --password <pw> >  env BOARD_PASSWORD
 */
"use strict";

const auth = require("./auth");

/**
 * isRemoteConfigured(opts) — returns true when both a remote URL and a
 * password are available (either from CLI flags or environment variables).
 *
 * @param {object} opts
 * @param {string|undefined} opts.remote   — value of --remote flag (overrides env)
 * @param {string|undefined} opts.password — value of --password flag (overrides env)
 * @param {object} [opts.env]             — environment map (defaults to process.env)
 * @returns {boolean}
 */
function isRemoteConfigured(opts) {
  opts = opts || {};
  const env = opts.env || process.env;
  const url = (typeof opts.remote === "string" && opts.remote) || env.BOARD_REMOTE || "";
  const pw = (typeof opts.password === "string" && opts.password) || env.BOARD_PASSWORD || "";
  return Boolean(url && pw);
}

/**
 * resolveConfig(opts) — resolve URL and password with flag-over-env precedence.
 *
 * @param {object} opts
 * @param {string|undefined} opts.remote
 * @param {string|undefined} opts.password
 * @param {object} [opts.env]
 * @returns {{ url: string, password: string }}
 */
function resolveConfig(opts) {
  opts = opts || {};
  const env = opts.env || process.env;
  const url = (typeof opts.remote === "string" && opts.remote) || env.BOARD_REMOTE || "";
  const pw = (typeof opts.password === "string" && opts.password) || env.BOARD_PASSWORD || "";
  return { url, password: pw };
}

/**
 * remoteMove(opts) — authenticate then POST /api/move.
 *
 * Steps:
 *   1. POST <url>/api/login { password } — expects a Set-Cookie: board_token=...
 *   2. POST <url>/api/move  { id, to, by, testsPass } with Cookie: board_token=...
 *
 * @param {object} opts
 * @param {string}   opts.url        — base URL of the Vercel deployment (no trailing slash)
 * @param {string}   opts.password   — board password
 * @param {string}   opts.id         — task id
 * @param {string}   opts.to         — target status
 * @param {string}   opts.by         — role (engineer|qa|po)
 * @param {boolean}  [opts.testsPass] — whether --tests-pass flag was provided
 * @param {Function} [opts.fetch]    — injectable fetch (defaults to global fetch).
 *                                     Signature: (url, init) => Promise<Response>
 *
 * @returns {Promise<{ ok: boolean, status: number, body?: any, error?: string }>}
 */
async function remoteMove(opts) {
  const fetchFn = opts.fetch || fetch;
  const baseUrl = opts.url.replace(/\/$/, "");

  // Step 1: login to obtain session cookie.
  let loginRes;
  try {
    loginRes = await fetchFn(baseUrl + "/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: opts.password }),
    });
  } catch (err) {
    return { ok: false, status: 0, error: "Network error during login: " + err.message };
  }

  if (!loginRes.ok) {
    let body;
    try { body = await loginRes.json(); } catch (_) { body = null; }
    return {
      ok: false,
      status: loginRes.status,
      error: "Login failed: " + loginRes.status + (body && body.error ? " — " + body.error : ""),
    };
  }

  // Extract the session cookie from the Set-Cookie header.
  // The Set-Cookie header contains a single cookie with attributes:
  //   "board_token=<value>; Path=/; HttpOnly; ..."
  // We must parse the name=value portion (before the first ";") keyed on
  // auth.COOKIE_NAME so the cookie name can never drift from the server's
  // expectation.  A naive substring match like /token=([^;]+)/ would
  // incorrectly capture values from a cookie named "board_token" as
  // "token=<value>", which the server's auth gate would not recognise.
  const setCookie = loginRes.headers.get("set-cookie") || "";
  // parseCookies handles "name=value; Attr; Attr" correctly: it splits on ";"
  // and for each part takes the text before the first "=" as the name.
  // For Set-Cookie we only care about the first pair (the actual cookie), not
  // the attributes — extract just the "name=value" segment before the first ";".
  const cookiePair = setCookie.split(";")[0]; // e.g. "board_token=<value>"
  const parsedSetCookie = auth.parseCookies(cookiePair);
  const tokenValue = parsedSetCookie[auth.COOKIE_NAME];
  const cookie = tokenValue ? auth.COOKIE_NAME + "=" + tokenValue : "";

  // Step 2: POST /api/move with the session cookie.
  const movePayload = {
    id: opts.id,
    to: opts.to,
    by: opts.by,
    testsPass: Boolean(opts.testsPass),
  };

  let moveRes;
  try {
    moveRes = await fetchFn(baseUrl + "/api/move", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(cookie ? { Cookie: cookie } : {}),
      },
      body: JSON.stringify(movePayload),
    });
  } catch (err) {
    return { ok: false, status: 0, error: "Network error during move: " + err.message };
  }

  let moveBody;
  try { moveBody = await moveRes.json(); } catch (_) { moveBody = null; }

  if (!moveRes.ok) {
    return {
      ok: false,
      status: moveRes.status,
      body: moveBody,
      error: moveBody && moveBody.error
        ? moveBody.error
        : "Move failed: HTTP " + moveRes.status,
    };
  }

  return { ok: true, status: moveRes.status, body: moveBody };
}

module.exports = { isRemoteConfigured, resolveConfig, remoteMove };
