/*
 * api/board.js — Vercel serverless function: GET /api/board
 *
 * Auth-protected endpoint that returns the full board JSON when a valid
 * HMAC session cookie is present. Returns 401 (no board data) otherwise.
 *
 * Dependencies (injectable via createHandler for offline unit tests):
 *   deps.secret    — HMAC verification secret  (env BOARD_SECRET)
 *   deps.kvOpts    — options forwarded to kv.load() e.g. { client: mockClient }
 *   deps.now       — clock fn () => unix-seconds  (for token expiry check)
 *
 * Export shape:
 *   createHandler(deps)   — factory returning the handler (for tests)
 *   module.exports        — default wired to process.env
 */
"use strict";

const auth = require("../lib/auth");
const kv = require("../lib/kv-store");

/**
 * createHandler(deps) — factory for the board handler.
 *
 * deps:
 *   { secret, kvOpts?, now? }
 *
 * @param {object} deps
 * @returns {function(req, res): Promise<void>}
 */
function createHandler(deps) {
  const { secret, kvOpts, now } = deps;

  return async function handler(req, res) {
    // Method check
    if (req.method !== "GET") {
      res.status(405).json({ ok: false, error: "Method Not Allowed" });
      return;
    }

    // AUTH GATE: parse cookie and verify token
    const cookies = auth.parseCookies(req.headers && req.headers.cookie);
    const token = cookies[auth.COOKIE_NAME];

    const verifyOpts = now ? { now } : {};
    const result = auth.verifyToken(token, secret, verifyOpts);

    if (!result.valid) {
      // Do NOT leak any board data on auth failure
      res.status(401).json({ ok: false, error: "Unauthorized" });
      return;
    }

    // Load board from KV
    try {
      const { data } = await kv.load(kvOpts || {});
      res.status(200).json(data);
    } catch (err) {
      res.status(500).json({ ok: false, error: "Failed to load board: " + err.message });
    }
  };
}

// Default export: wired to real environment
module.exports = createHandler({
  secret: process.env.BOARD_SECRET || "",
  kvOpts: {}, // will use KV_REST_API_URL / KV_REST_API_TOKEN from env
});

// Also export the factory for test injection
module.exports.createHandler = createHandler;
