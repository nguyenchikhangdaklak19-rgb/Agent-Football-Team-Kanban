/*
 * api/login.js — Vercel serverless function: POST /api/login
 *
 * Accepts a JSON body { password } and issues an HMAC-signed session cookie
 * when the password matches. All secret material comes from the environment
 * (or injected deps for tests) — nothing is hardcoded here.
 *
 * Dependencies (injectable via createHandler for offline unit tests):
 *   deps.password  — expected board password (env BOARD_PASSWORD)
 *   deps.secret    — HMAC signing secret    (env BOARD_SECRET)
 *   deps.ttl       — token TTL in seconds   (default: 8 hours)
 *   deps.now       — clock fn () => unix-seconds  (default: Date.now/1000)
 *
 * Export shape:
 *   createHandler(deps)   — factory returning the handler (for tests)
 *   module.exports        — default wired to process.env
 */
"use strict";

const auth = require("../lib/auth");

const DEFAULT_TTL = 8 * 60 * 60; // 8 hours

/**
 * Parse the request body. Vercel may pre-parse it into req.body; if not,
 * read and parse the raw stream.
 *
 * @param {object} req
 * @returns {Promise<object>}  Resolves to parsed body object, or rejects on error.
 */
function parseBody(req) {
  // Vercel often pre-parses JSON bodies into req.body
  if (req.body !== undefined && req.body !== null && typeof req.body === "object") {
    return Promise.resolve(req.body);
  }
  // Handle string body (Vercel sometimes provides pre-read string)
  if (typeof req.body === "string") {
    try {
      return Promise.resolve(JSON.parse(req.body));
    } catch (e) {
      return Promise.reject(new SyntaxError("invalid JSON: " + e.message));
    }
  }
  // Read raw stream
  return new Promise((resolve, reject) => {
    const MAX = 1e6; // 1 MB
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
 * createHandler(deps) — factory for the login handler.
 *
 * deps:
 *   { password, secret, ttl?, now? }
 *
 * @param {object} deps
 * @returns {function(req, res): Promise<void>}
 */
function createHandler(deps) {
  const { password, secret, ttl, now } = deps;
  const tokenTtl = typeof ttl === "number" ? ttl : DEFAULT_TTL;

  return async function handler(req, res) {
    // Method check
    if (req.method !== "POST") {
      res.status(405).json({ ok: false, error: "Method Not Allowed" });
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

    // Validate body shape
    if (!body || typeof body !== "object") {
      res.status(400).json({ ok: false, error: "Request body must be a JSON object" });
      return;
    }

    const { password: submitted } = body;

    // Missing / non-string password
    if (typeof submitted !== "string") {
      res.status(400).json({ ok: false, error: "Request body must include a 'password' string" });
      return;
    }

    // Timing-safe password check
    const ok = auth.checkPassword(submitted, password);

    if (!ok) {
      // 401 — no cookie, no detail about why (timing safe)
      res.status(401).json({ ok: false, error: "Invalid password" });
      return;
    }

    // Issue a signed token
    const token = auth.signToken({ board: true }, secret, {
      ttl: tokenTtl,
      ...(now ? { now } : {}),
    });

    const cookieStr = auth.serializeCookie(auth.COOKIE_NAME, token, {
      httpOnly: true,
      secure: true,
      sameSite: "Lax",
      path: "/",
      maxAge: tokenTtl,
    });

    res.setHeader("Set-Cookie", cookieStr);
    res.status(200).json({ ok: true });
  };
}

// Default export: wired to real environment
module.exports = createHandler({
  password: process.env.BOARD_PASSWORD || "",
  secret: process.env.BOARD_SECRET || "",
});

// Also export the factory for test injection
module.exports.createHandler = createHandler;
