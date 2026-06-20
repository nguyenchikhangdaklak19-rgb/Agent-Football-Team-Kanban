/*
 * remote — HTTP client for board.js remote mode.
 *
 * This is a pure library: no process.exit, minimal console output.
 * Requires Node 18+ (global fetch).
 *
 * Auth approach (option a — two-step):
 *   1. POST /api/login with { password } → server issues an HMAC-signed session
 *      cookie named "token".
 *   2. POST /api/move with that cookie (Cookie header) and the move payload.
 *
 * Configuration precedence (flags override env):
 *   - remote URL:  --remote <url>  >  env BOARD_REMOTE
 *   - password:    --password <pw> >  env BOARD_PASSWORD
 */
"use strict";

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
 *   1. POST <url>/api/login { password } — expects a Set-Cookie: token=...
 *   2. POST <url>/api/move  { id, to, by, testsPass } with Cookie: token=...
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
  const setCookie = loginRes.headers.get("set-cookie") || "";
  // Parse out the token value (format: "token=<value>; Path=/; ...")
  const tokenMatch = setCookie.match(/token=([^;]+)/);
  const cookie = tokenMatch ? "token=" + tokenMatch[1] : "";

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
