/*
 * api/move.js — Vercel serverless function: POST /api/move
 *
 * Auth-protected endpoint that applies a task state transition via the
 * state machine (workflow.js) and persists it atomically via kv.update().
 *
 * Expected body: { id, to, by, testsPass? }
 *
 * Response codes:
 *   200 { ok: true,  task }           — success
 *   400 { ok: false, error }          — missing required fields or bad body
 *   401 { ok: false, error }          — missing/invalid/expired token
 *   404 { ok: false, error }          — task id not found
 *   405 { ok: false, error }          — non-POST
 *   409 { ok: false, error }          — illegal workflow transition
 *   500 { ok: false, error }          — KV failure
 *
 * Dependencies (injectable via createHandler for offline unit tests):
 *   deps.secret    — HMAC verification secret  (env BOARD_SECRET)
 *   deps.kvOpts    — options forwarded to kv.update() e.g. { client: mockClient }
 *   deps.now       — clock fn () => unix-seconds (for token expiry) or ISO string fn
 *                    for move timestamp (same fn serves both: token uses seconds,
 *                    move uses new Date(now()*1000).toISOString())
 *   deps.nowIso    — optional: () => ISO-8601 string for the move history timestamp
 *
 * Export shape:
 *   createHandler(deps)   — factory returning the handler (for tests)
 *   module.exports        — default wired to process.env
 */
"use strict";

const auth = require("../lib/auth");
const kv = require("../lib/kv-store");
const { DEFAULT_WORKFLOW, applyMove } = require("../lib/workflow");

/**
 * Parse the request body. Vercel may pre-parse it; if not, read the stream.
 */
function parseBody(req) {
  if (req.body !== undefined && req.body !== null && typeof req.body === "object") {
    return Promise.resolve(req.body);
  }
  if (typeof req.body === "string") {
    try {
      return Promise.resolve(JSON.parse(req.body));
    } catch (e) {
      return Promise.reject(new SyntaxError("invalid JSON: " + e.message));
    }
  }
  return new Promise((resolve, reject) => {
    const MAX = 1e6;
    let raw = "";
    let aborted = false;
    req.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > MAX) {
        aborted = true;
        req.destroy();
        reject(new Error("request body too large"));
      }
    });
    req.on("error", (err) => {
      if (!aborted) reject(err);
    });
    req.on("end", () => {
      if (aborted) return;
      if (!raw || raw.trim() === "") {
        return reject(new Error("empty body"));
      }
      try {
        resolve(JSON.parse(raw));
      } catch (e) {
        reject(new SyntaxError("invalid JSON: " + e.message));
      }
    });
  });
}

/**
 * createHandler(deps) — factory for the move handler.
 *
 * deps:
 *   { secret, kvOpts?, now?, nowIso? }
 *
 * @param {object} deps
 * @returns {function(req, res): Promise<void>}
 */
function createHandler(deps) {
  const { secret, kvOpts, now, nowIso } = deps;

  // Determine token clock fn
  const tokenNowFn = now || null;
  // Determine move-timestamp fn (ISO string)
  const moveNowFn = nowIso || (now
    ? () => new Date(now() * 1000).toISOString()
    : () => new Date().toISOString());

  return async function handler(req, res) {
    // Method check
    if (req.method !== "POST") {
      res.status(405).json({ ok: false, error: "Method Not Allowed" });
      return;
    }

    // AUTH GATE: parse cookie and verify token
    const cookies = auth.parseCookies(req.headers && req.headers.cookie);
    const token = cookies[auth.COOKIE_NAME];

    const verifyOpts = tokenNowFn ? { now: tokenNowFn } : {};
    const authResult = auth.verifyToken(token, secret, verifyOpts);

    if (!authResult.valid) {
      res.status(401).json({ ok: false, error: "Unauthorized" });
      return;
    }

    // Parse body
    let body;
    try {
      body = await parseBody(req);
    } catch (err) {
      res.status(400).json({ ok: false, error: "Malformed request body: " + err.message });
      return;
    }

    if (!body || typeof body !== "object") {
      res.status(400).json({ ok: false, error: "Request body must be a JSON object" });
      return;
    }

    const { id, to, by, testsPass } = body;

    // Validate required fields
    if (!id || !to || !by) {
      res.status(400).json({ ok: false, error: "id, to, and by are required" });
      return;
    }

    // Apply the move atomically via kv.update()
    let movedTask = null;
    let moveError = null;
    let notFound = false;

    try {
      await kv.update((data) => {
        const found = kv.findTask(data, id);
        if (!found) {
          notFound = true;
          return; // don't mutate; we'll 404 below
        }

        const workflow = data.workflow || DEFAULT_WORKFLOW;
        const result = applyMove(workflow, found.task, to, by, {
          testsPass: testsPass === true,
          now: moveNowFn(),
        });

        if (!result.ok) {
          moveError = result.error;
          return; // don't mutate; we'll 409 below
        }

        // task is already mutated in-place by applyMove; capture it
        movedTask = found.task;
        // Data is mutated in-place via found.task reference — kv.update clones it
      }, kvOpts || {});
    } catch (err) {
      res.status(500).json({ ok: false, error: "KV update failed: " + err.message });
      return;
    }

    // Map result to HTTP response
    if (notFound) {
      res.status(404).json({ ok: false, error: 'Task "' + id + '" not found' });
      return;
    }

    if (moveError) {
      res.status(409).json({ ok: false, error: moveError });
      return;
    }

    res.status(200).json({ ok: true, task: movedTask });
  };
}

// Default export: wired to real environment
module.exports = createHandler({
  secret: process.env.BOARD_SECRET || "",
  kvOpts: {},
});

// Also export the factory for test injection
module.exports.createHandler = createHandler;
