/*
 * auth — HMAC-signed session tokens, cookie parsing, and password checking.
 *
 * Pure library: no console output, no process.exit. Uses only the Node built-in
 * `crypto` module — zero additional dependencies. Secret material always comes
 * from the caller; nothing is hardcoded here.
 *
 * Token format:
 *   <base64url(JSON payload)>.<base64url(HMAC-SHA256 signature)>
 *
 * Payload JSON contains at minimum:
 *   { iat: <unix seconds issued>, exp: <unix seconds expiry>, ...rest }
 *
 * Both parts are base64url-encoded (RFC 4648 §5, no padding).
 */
"use strict";

const crypto = require("crypto");

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Cookie name shared by the API layer and tests. */
const COOKIE_NAME = "board_token";

/** Default token lifetime in seconds (8 hours). */
const DEFAULT_TTL = 8 * 60 * 60;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Encode a Buffer or string to base64url (no padding).
 * @param {Buffer|string} data
 * @returns {string}
 */
function toBase64url(data) {
  return Buffer.from(data)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/**
 * Decode a base64url string to a Buffer.
 * Returns null if decoding produces garbage that cannot be interpreted
 * (doesn't throw — callers handle null).
 * @param {string} str
 * @returns {Buffer|null}
 */
function fromBase64url(str) {
  try {
    // Re-pad as standard base64
    const padded = str.replace(/-/g, "+").replace(/_/g, "/");
    const pad = (4 - (padded.length % 4)) % 4;
    return Buffer.from(padded + "=".repeat(pad), "base64");
  } catch {
    return null;
  }
}

/**
 * Compute the HMAC-SHA256 of `data` using `secret`.
 * @param {string} data
 * @param {string} secret
 * @returns {Buffer}
 */
function hmac(data, secret) {
  return crypto.createHmac("sha256", secret).update(data).digest();
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Timing-safe password comparison.
 *
 * Returns true only when `input` exactly equals `expected`.
 * Handles length mismatches without crashing (returns false).
 *
 * @param {string} input    - Password supplied by the user.
 * @param {string} expected - The stored/env password.
 * @returns {boolean}
 */
function checkPassword(input, expected) {
  if (typeof input !== "string" || typeof expected !== "string") return false;
  const a = Buffer.from(input);
  const b = Buffer.from(expected);
  if (a.length === 0 && b.length === 0) {
    // Both empty: treat as matching to stay consistent, but via safe path.
    // We cannot call timingSafeEqual with length 0 safely in all Node versions,
    // so compare explicitly.
    return true;
  }
  if (a.length !== b.length) {
    // Avoid length oracle: still run a dummy comparison to preserve timing
    // characteristics, then return false.
    const dummy = Buffer.alloc(b.length, 0);
    crypto.timingSafeEqual(dummy, b);
    return false;
  }
  return crypto.timingSafeEqual(a, b);
}

/**
 * Sign a token carrying `payload` (an arbitrary object).
 *
 * The library stamps `iat` (issued-at) and `exp` (expiry) onto the payload
 * before encoding. Any keys already present in `payload` are preserved; `iat`
 * and `exp` are always overwritten by this function so callers cannot forge them.
 *
 * @param {object} payload  - Data to embed in the token (must be JSON-serializable).
 * @param {string} secret   - HMAC secret (comes from env BOARD_SECRET upstream).
 * @param {object} [opts]
 * @param {number} [opts.ttl=DEFAULT_TTL]  - Token lifetime in seconds.
 * @param {function} [opts.now]            - Injected clock: () => unix-seconds. For tests.
 * @returns {string}  - Signed token string.
 */
function signToken(payload, secret, opts) {
  const options = opts || {};
  const ttl = typeof options.ttl === "number" ? options.ttl : DEFAULT_TTL;
  const nowSec =
    typeof options.now === "function"
      ? options.now()
      : Math.floor(Date.now() / 1000);

  const body = Object.assign({}, payload, {
    iat: nowSec,
    exp: nowSec + ttl,
  });

  const headerPart = toBase64url(JSON.stringify(body));
  const sig = toBase64url(hmac(headerPart, secret));
  return headerPart + "." + sig;
}

/**
 * Verify a token and return its payload if valid.
 *
 * Checks:
 *  1. Token has exactly two dot-separated parts.
 *  2. Payload part is valid base64url-encoded JSON containing `exp`.
 *  3. Signature matches (timing-safe).
 *  4. Token has not expired (`exp` > now).
 *
 * @param {string} token   - Token string produced by signToken.
 * @param {string} secret  - HMAC secret.
 * @param {object} [opts]
 * @param {function} [opts.now]  - Injected clock: () => unix-seconds. For tests.
 * @returns {{ valid: true, payload: object } | { valid: false, reason: string }}
 */
function verifyToken(token, secret, opts) {
  // Structural check
  if (typeof token !== "string" || !token) {
    return { valid: false, reason: "malformed: not a string" };
  }

  const parts = token.split(".");
  if (parts.length !== 2) {
    return { valid: false, reason: "malformed: expected 2 parts" };
  }

  const [headerPart, sigPart] = parts;

  // Decode payload
  const payloadBuf = fromBase64url(headerPart);
  if (!payloadBuf) {
    return { valid: false, reason: "malformed: cannot decode payload" };
  }

  let payload;
  try {
    payload = JSON.parse(payloadBuf.toString("utf8"));
  } catch {
    return { valid: false, reason: "malformed: payload is not valid JSON" };
  }

  if (typeof payload !== "object" || payload === null) {
    return { valid: false, reason: "malformed: payload is not an object" };
  }

  // Signature check (timing-safe)
  const expectedSig = toBase64url(hmac(headerPart, secret));
  const expectedSigBuf = Buffer.from(expectedSig);
  const actualSigBuf = Buffer.from(sigPart || "");

  let sigOk = false;
  if (actualSigBuf.length === expectedSigBuf.length) {
    sigOk = crypto.timingSafeEqual(actualSigBuf, expectedSigBuf);
  } else {
    // Lengths differ — run dummy comparison for timing uniformity, then fail.
    const dummy = Buffer.alloc(expectedSigBuf.length, 0);
    crypto.timingSafeEqual(dummy, expectedSigBuf);
    sigOk = false;
  }

  if (!sigOk) {
    return { valid: false, reason: "bad signature" };
  }

  // Expiry check
  if (typeof payload.exp !== "number") {
    return { valid: false, reason: "malformed: missing exp" };
  }

  const options = opts || {};
  const nowSec =
    typeof options.now === "function"
      ? options.now()
      : Math.floor(Date.now() / 1000);

  if (nowSec >= payload.exp) {
    return { valid: false, reason: "expired" };
  }

  return { valid: true, payload };
}

/**
 * Parse a Cookie header string into a name→value map.
 *
 * Handles:
 *  - undefined / empty header (returns {})
 *  - single cookie
 *  - multiple cookies separated by "; "
 *  - leading/trailing spaces around names and values
 *  - values that contain '=' characters (only the first '=' is the separator)
 *
 * @param {string|undefined} cookieHeader  - Value of the Cookie HTTP header.
 * @returns {Record<string, string>}
 */
function parseCookies(cookieHeader) {
  const result = {};
  if (!cookieHeader) return result;

  for (const part of cookieHeader.split(";")) {
    const eqIdx = part.indexOf("=");
    if (eqIdx === -1) continue; // malformed pair, skip
    const name = part.slice(0, eqIdx).trim();
    const value = part.slice(eqIdx + 1).trim();
    if (name) result[name] = value;
  }

  return result;
}

/**
 * Serialize a cookie into a Set-Cookie header value.
 *
 * Supported options:
 *   httpOnly  {boolean}  — adds HttpOnly directive
 *   secure    {boolean}  — adds Secure directive
 *   sameSite  {string}   — adds SameSite=<value> directive (e.g. "Strict", "Lax")
 *   path      {string}   — adds Path=<value> directive
 *   maxAge    {number}   — adds Max-Age=<seconds> directive
 *
 * @param {string} name    - Cookie name.
 * @param {string} value   - Cookie value.
 * @param {object} [opts]  - Cookie attributes.
 * @returns {string}  - Complete Set-Cookie header value.
 */
function serializeCookie(name, value, opts) {
  const options = opts || {};
  let str = name + "=" + value;

  if (typeof options.path === "string") {
    str += "; Path=" + options.path;
  }
  if (typeof options.maxAge === "number") {
    str += "; Max-Age=" + Math.floor(options.maxAge);
  }
  if (options.httpOnly) {
    str += "; HttpOnly";
  }
  if (options.secure) {
    str += "; Secure";
  }
  if (typeof options.sameSite === "string") {
    str += "; SameSite=" + options.sameSite;
  }

  return str;
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  COOKIE_NAME,
  checkPassword,
  signToken,
  verifyToken,
  parseCookies,
  serializeCookie,
};
