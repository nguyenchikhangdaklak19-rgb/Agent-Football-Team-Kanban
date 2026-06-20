"use strict";

/*
 * auth.test.js — unit tests for testgent/lib/auth.js
 *
 * Covers: checkPassword, signToken, verifyToken, parseCookies,
 *         serializeCookie, and the exported COOKIE_NAME constant.
 *
 * Run:  node --test test/auth.test.js
 *   or: npm test  (runs all *.test.js files)
 */

const test = require("node:test");
const assert = require("node:assert");

const {
  COOKIE_NAME,
  checkPassword,
  signToken,
  verifyToken,
  parseCookies,
  serializeCookie,
} = require("../lib/auth");

const SECRET = "test-secret-do-not-use-in-production";
// A fixed "now" for deterministic token tests (unix seconds).
const FIXED_NOW = 1_700_000_000;
const nowFn = () => FIXED_NOW;

// ---------------------------------------------------------------------------
// COOKIE_NAME constant
// ---------------------------------------------------------------------------

test("COOKIE_NAME is a non-empty string", () => {
  assert.strictEqual(typeof COOKIE_NAME, "string");
  assert.ok(COOKIE_NAME.length > 0);
});

test("COOKIE_NAME equals 'board_token'", () => {
  assert.strictEqual(COOKIE_NAME, "board_token");
});

// ---------------------------------------------------------------------------
// checkPassword
// ---------------------------------------------------------------------------

test("checkPassword: correct password returns true", () => {
  assert.strictEqual(checkPassword("hunter2", "hunter2"), true);
});

test("checkPassword: wrong password returns false", () => {
  assert.strictEqual(checkPassword("wrong", "hunter2"), false);
});

test("checkPassword: length mismatch returns false (short input)", () => {
  assert.strictEqual(checkPassword("hi", "hunter2"), false);
});

test("checkPassword: length mismatch returns false (long input)", () => {
  assert.strictEqual(checkPassword("averylongpassword", "short"), false);
});

test("checkPassword: empty input against non-empty expected returns false", () => {
  assert.strictEqual(checkPassword("", "hunter2"), false);
});

test("checkPassword: non-empty input against empty expected returns false", () => {
  assert.strictEqual(checkPassword("hunter2", ""), false);
});

test("checkPassword: both empty returns true", () => {
  assert.strictEqual(checkPassword("", ""), true);
});

test("checkPassword: does not throw on empty strings", () => {
  assert.doesNotThrow(() => checkPassword("", ""));
  assert.doesNotThrow(() => checkPassword("", "abc"));
  assert.doesNotThrow(() => checkPassword("abc", ""));
});

test("checkPassword: non-string arguments return false without throwing", () => {
  assert.strictEqual(checkPassword(null, "hunter2"), false);
  assert.strictEqual(checkPassword("hunter2", null), false);
  assert.strictEqual(checkPassword(undefined, "x"), false);
  assert.strictEqual(checkPassword(123, "123"), false);
});

// ---------------------------------------------------------------------------
// signToken / verifyToken — round-trip
// ---------------------------------------------------------------------------

test("signToken returns a string with exactly one dot separator", () => {
  const token = signToken({ role: "po" }, SECRET, { now: nowFn });
  assert.strictEqual(typeof token, "string");
  const parts = token.split(".");
  assert.strictEqual(parts.length, 2);
  assert.ok(parts[0].length > 0);
  assert.ok(parts[1].length > 0);
});

test("signToken/verifyToken round-trip: valid result with correct payload", () => {
  const token = signToken({ role: "po" }, SECRET, { now: nowFn, ttl: 3600 });
  const result = verifyToken(token, SECRET, { now: nowFn });
  assert.strictEqual(result.valid, true);
  assert.strictEqual(result.payload.role, "po");
});

test("verifyToken payload carries iat and exp", () => {
  const token = signToken({}, SECRET, { now: nowFn, ttl: 3600 });
  const result = verifyToken(token, SECRET, { now: nowFn });
  assert.strictEqual(result.valid, true);
  assert.strictEqual(result.payload.iat, FIXED_NOW);
  assert.strictEqual(result.payload.exp, FIXED_NOW + 3600);
});

test("verifyToken: extra payload fields are preserved", () => {
  const token = signToken({ userId: "abc", role: "engineer" }, SECRET, { now: nowFn });
  const result = verifyToken(token, SECRET, { now: nowFn });
  assert.strictEqual(result.valid, true);
  assert.strictEqual(result.payload.userId, "abc");
  assert.strictEqual(result.payload.role, "engineer");
});

// ---------------------------------------------------------------------------
// signToken / verifyToken — tampered payload
// ---------------------------------------------------------------------------

test("verifyToken: tampered payload (changed base64) -> invalid, reason: bad signature", () => {
  const token = signToken({ role: "po" }, SECRET, { now: nowFn });
  const [headerPart, sigPart] = token.split(".");
  // Flip the last character of the payload portion to simulate tampering.
  const tampered =
    headerPart.slice(0, -1) +
    (headerPart.slice(-1) === "A" ? "B" : "A") +
    "." +
    sigPart;
  const result = verifyToken(tampered, SECRET, { now: nowFn });
  assert.strictEqual(result.valid, false);
  assert.ok(
    result.reason === "bad signature" ||
      result.reason.startsWith("malformed"),
    "reason should indicate signature or malformed, got: " + result.reason
  );
});

test("verifyToken: signature replaced with all zeros -> invalid", () => {
  const token = signToken({ role: "po" }, SECRET, { now: nowFn });
  const [headerPart] = token.split(".");
  const fakeSig = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
  const result = verifyToken(headerPart + "." + fakeSig, SECRET, { now: nowFn });
  assert.strictEqual(result.valid, false);
  assert.strictEqual(result.reason, "bad signature");
});

// ---------------------------------------------------------------------------
// signToken / verifyToken — expired token
// ---------------------------------------------------------------------------

test("verifyToken: expired token (exp in the past) -> invalid, reason: expired", () => {
  const ttl = 60; // 60 seconds
  const token = signToken({}, SECRET, { now: nowFn, ttl });
  // Advance clock past expiry.
  const futureNow = () => FIXED_NOW + ttl + 1;
  const result = verifyToken(token, SECRET, { now: futureNow });
  assert.strictEqual(result.valid, false);
  assert.strictEqual(result.reason, "expired");
});

test("verifyToken: token at exact exp boundary is expired", () => {
  const ttl = 60;
  const token = signToken({}, SECRET, { now: nowFn, ttl });
  const atExpiry = () => FIXED_NOW + ttl; // exp === now → expired
  const result = verifyToken(token, SECRET, { now: atExpiry });
  assert.strictEqual(result.valid, false);
  assert.strictEqual(result.reason, "expired");
});

test("verifyToken: token 1 second before expiry is still valid", () => {
  const ttl = 60;
  const token = signToken({}, SECRET, { now: nowFn, ttl });
  const almostExpired = () => FIXED_NOW + ttl - 1;
  const result = verifyToken(token, SECRET, { now: almostExpired });
  assert.strictEqual(result.valid, true);
});

// ---------------------------------------------------------------------------
// signToken / verifyToken — wrong secret
// ---------------------------------------------------------------------------

test("verifyToken: wrong secret -> invalid, reason: bad signature", () => {
  const token = signToken({ role: "po" }, SECRET, { now: nowFn });
  const result = verifyToken(token, "completely-different-secret", { now: nowFn });
  assert.strictEqual(result.valid, false);
  assert.strictEqual(result.reason, "bad signature");
});

// ---------------------------------------------------------------------------
// verifyToken — malformed / garbage input
// ---------------------------------------------------------------------------

test("verifyToken: empty string -> invalid, no throw", () => {
  assert.doesNotThrow(() => {
    const r = verifyToken("", SECRET);
    assert.strictEqual(r.valid, false);
  });
});

test("verifyToken: null -> invalid, no throw", () => {
  assert.doesNotThrow(() => {
    const r = verifyToken(null, SECRET);
    assert.strictEqual(r.valid, false);
  });
});

test("verifyToken: random garbage -> invalid, no throw", () => {
  assert.doesNotThrow(() => {
    const r = verifyToken("totally.garbage.token.parts", SECRET);
    assert.strictEqual(r.valid, false);
  });
});

test("verifyToken: single part (no dot) -> invalid", () => {
  const r = verifyToken("justonepart", SECRET);
  assert.strictEqual(r.valid, false);
  assert.match(r.reason, /malformed/);
});

test("verifyToken: three parts -> invalid", () => {
  const r = verifyToken("a.b.c", SECRET);
  assert.strictEqual(r.valid, false);
  assert.match(r.reason, /malformed/);
});

test("verifyToken: valid base64url but non-JSON payload -> invalid", () => {
  // Encode a plain string (not JSON) as the payload part.
  const fakeHeader = Buffer.from("not-json-at-all")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  const r = verifyToken(fakeHeader + ".fakesig", SECRET, { now: nowFn });
  assert.strictEqual(r.valid, false);
  assert.ok(r.reason.startsWith("malformed") || r.reason === "bad signature");
});

// ---------------------------------------------------------------------------
// parseCookies
// ---------------------------------------------------------------------------

test("parseCookies: single cookie", () => {
  const result = parseCookies("board_token=abc123");
  assert.deepStrictEqual(result, { board_token: "abc123" });
});

test("parseCookies: multiple cookies", () => {
  const result = parseCookies("a=1; b=2; c=3");
  assert.deepStrictEqual(result, { a: "1", b: "2", c: "3" });
});

test("parseCookies: spaces around name and value", () => {
  const result = parseCookies("  foo = bar ");
  assert.strictEqual(result["foo"], "bar");
});

test("parseCookies: undefined header returns empty object", () => {
  const result = parseCookies(undefined);
  assert.deepStrictEqual(result, {});
});

test("parseCookies: empty string header returns empty object", () => {
  const result = parseCookies("");
  assert.deepStrictEqual(result, {});
});

test("parseCookies: null header returns empty object", () => {
  const result = parseCookies(null);
  assert.deepStrictEqual(result, {});
});

test("parseCookies: value containing '=' (e.g. base64)", () => {
  // Only the first '=' is the separator; the rest is part of the value.
  const result = parseCookies("board_token=abc=def==");
  assert.strictEqual(result["board_token"], "abc=def==");
});

test("parseCookies: mixed — COOKIE_NAME present among others", () => {
  const header = `session_id=xyz; ${COOKIE_NAME}=mytoken; pref=dark`;
  const result = parseCookies(header);
  assert.strictEqual(result[COOKIE_NAME], "mytoken");
  assert.strictEqual(result["session_id"], "xyz");
  assert.strictEqual(result["pref"], "dark");
});

test("parseCookies: pair without '=' is skipped gracefully", () => {
  const result = parseCookies("badpair; good=value");
  assert.strictEqual(result["good"], "value");
  assert.strictEqual(Object.keys(result).length, 1);
});

// ---------------------------------------------------------------------------
// serializeCookie
// ---------------------------------------------------------------------------

test("serializeCookie: basic name=value", () => {
  const str = serializeCookie("foo", "bar");
  assert.ok(str.startsWith("foo=bar"), "must start with name=value");
});

test("serializeCookie: includes HttpOnly when requested", () => {
  const str = serializeCookie("foo", "bar", { httpOnly: true });
  assert.ok(str.includes("HttpOnly"), "must include HttpOnly");
});

test("serializeCookie: includes Secure when requested", () => {
  const str = serializeCookie("foo", "bar", { secure: true });
  assert.ok(str.includes("Secure"), "must include Secure");
});

test("serializeCookie: includes SameSite", () => {
  const str = serializeCookie("foo", "bar", { sameSite: "Strict" });
  assert.ok(str.includes("SameSite=Strict"), "must include SameSite=Strict");
});

test("serializeCookie: includes Path", () => {
  const str = serializeCookie("foo", "bar", { path: "/" });
  assert.ok(str.includes("Path=/"), "must include Path=/");
});

test("serializeCookie: includes Max-Age", () => {
  const str = serializeCookie("foo", "bar", { maxAge: 3600 });
  assert.ok(str.includes("Max-Age=3600"), "must include Max-Age=3600");
});

test("serializeCookie: full session cookie options", () => {
  const str = serializeCookie(COOKIE_NAME, "mytoken", {
    httpOnly: true,
    secure: true,
    sameSite: "Strict",
    path: "/",
    maxAge: 28800,
  });
  assert.ok(str.startsWith(COOKIE_NAME + "=mytoken"), "name=value prefix");
  assert.ok(str.includes("HttpOnly"), "HttpOnly present");
  assert.ok(str.includes("Secure"), "Secure present");
  assert.ok(str.includes("SameSite=Strict"), "SameSite present");
  assert.ok(str.includes("Path=/"), "Path present");
  assert.ok(str.includes("Max-Age=28800"), "Max-Age present");
});

test("serializeCookie: omits directives not requested", () => {
  const str = serializeCookie("foo", "bar");
  assert.ok(!str.includes("HttpOnly"), "HttpOnly must be absent");
  assert.ok(!str.includes("Secure"), "Secure must be absent");
  assert.ok(!str.includes("SameSite"), "SameSite must be absent");
  assert.ok(!str.includes("Max-Age"), "Max-Age must be absent");
});

test("serializeCookie: COOKIE_NAME constant works as the cookie name", () => {
  const str = serializeCookie(COOKIE_NAME, "tok123", { httpOnly: true, path: "/" });
  assert.ok(str.startsWith(COOKIE_NAME + "=tok123"));
});

// ===========================================================================
// REVIEWER edge-case tests (test(auth): add reviewer edge-case tests)
// ===========================================================================

// --- checkPassword: timingSafeEqual length-mismatch must never throw --------

test("[reviewer] checkPassword: length mismatch never throws (timingSafeEqual guard)", () => {
  // crypto.timingSafeEqual throws on unequal buffer lengths; the impl must guard.
  assert.doesNotThrow(() => checkPassword("a", "abcdefghijklmnop"));
  assert.doesNotThrow(() => checkPassword("abcdefghijklmnop", "a"));
  assert.strictEqual(checkPassword("a", "abcdefghijklmnop"), false);
  assert.strictEqual(checkPassword("abcdefghijklmnop", "a"), false);
});

test("[reviewer] checkPassword: many non-string types return false without throwing", () => {
  for (const bad of [undefined, null, 0, 1, {}, [], true, false, NaN, () => {}]) {
    assert.doesNotThrow(() => checkPassword(bad, "x"));
    assert.doesNotThrow(() => checkPassword("x", bad));
    assert.strictEqual(checkPassword(bad, "x"), false);
    assert.strictEqual(checkPassword("x", bad), false);
  }
});

test("[reviewer] checkPassword: unicode of differing byte-length returns false safely", () => {
  // 'é' is 2 bytes in UTF-8, 'e' is 1 — Buffer lengths differ.
  assert.doesNotThrow(() => checkPassword("é", "e"));
  assert.strictEqual(checkPassword("é", "e"), false);
});

// --- verifyToken: malformed input must return {valid:false}, never throw ----

test("[reviewer] verifyToken: garbage/malformed tokens never throw", () => {
  const SAMPLES = [
    "",
    ".",
    "..",
    "a.b.c",
    "justonepart",
    ".onlysig",
    "onlyheader.",
    "@@@@.@@@@",        // chars outside base64url alphabet
    "   .   ",
    "%%%.###",
    "a".repeat(10000) + "." + "b".repeat(10000), // large junk
  ];
  for (const tok of SAMPLES) {
    assert.doesNotThrow(() => verifyToken(tok, SECRET, { now: nowFn }), `threw on: ${tok.slice(0, 20)}`);
    const r = verifyToken(tok, SECRET, { now: nowFn });
    assert.strictEqual(r.valid, false, `should be invalid: ${tok.slice(0, 20)}`);
  }
});

test("[reviewer] verifyToken: non-string token types never throw, return invalid", () => {
  for (const bad of [null, undefined, 0, 123, {}, [], true]) {
    assert.doesNotThrow(() => verifyToken(bad, SECRET, { now: nowFn }));
    assert.strictEqual(verifyToken(bad, SECRET, { now: nowFn }).valid, false);
  }
});

test("[reviewer] verifyToken: base64url payload that is valid JSON but not an object", () => {
  // JSON number, string, array, null all decode to non-{} — must be rejected.
  const enc = (s) =>
    Buffer.from(s).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const crypto = require("node:crypto");
  for (const raw of ["123", '"hello"', "[1,2,3]", "null", "true"]) {
    const h = enc(raw);
    const sig = crypto
      .createHmac("sha256", SECRET)
      .update(h)
      .digest()
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    assert.doesNotThrow(() => verifyToken(h + "." + sig, SECRET, { now: nowFn }));
    const r = verifyToken(h + "." + sig, SECRET, { now: nowFn });
    assert.strictEqual(r.valid, false, `non-object JSON payload accepted: ${raw}`);
  }
});

test("[reviewer] verifyToken: correctly-signed payload missing exp is rejected", () => {
  const enc = (s) =>
    Buffer.from(s).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const crypto = require("node:crypto");
  const h = enc(JSON.stringify({ role: "po" })); // no exp
  const sig = crypto
    .createHmac("sha256", SECRET)
    .update(h)
    .digest()
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  const r = verifyToken(h + "." + sig, SECRET, { now: nowFn });
  assert.strictEqual(r.valid, false);
  assert.match(r.reason, /exp/);
});

test("[reviewer] verifyToken: exp present but non-numeric (string) is rejected", () => {
  const enc = (s) =>
    Buffer.from(s).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const crypto = require("node:crypto");
  const h = enc(JSON.stringify({ exp: "9999999999" })); // string, not number
  const sig = crypto
    .createHmac("sha256", SECRET)
    .update(h)
    .digest()
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  const r = verifyToken(h + "." + sig, SECRET, { now: nowFn });
  assert.strictEqual(r.valid, false);
});

// --- verifyToken: signature must cover the payload (no swap / forgery) ------

test("[reviewer] verifyToken: cannot extend expiry by editing payload + reusing old signature", () => {
  const ttl = 60;
  const token = signToken({ role: "po" }, SECRET, { now: nowFn, ttl });
  const [h, s] = token.split(".");
  // Decode payload, push exp far into the future, re-encode, keep ORIGINAL signature.
  const decoded = JSON.parse(
    Buffer.from(h.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8")
  );
  decoded.exp = 9_999_999_999;
  const forgedH = Buffer.from(JSON.stringify(decoded))
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  const r = verifyToken(forgedH + "." + s, SECRET, { now: nowFn });
  assert.strictEqual(r.valid, false, "forged extended-expiry token must be rejected");
  assert.strictEqual(r.reason, "bad signature");
});

test("[reviewer] verifyToken: cannot swap payload of token A onto signature of token B", () => {
  const tokenA = signToken({ role: "engineer" }, SECRET, { now: nowFn });
  const tokenB = signToken({ role: "po" }, SECRET, { now: nowFn });
  const headerA = tokenA.split(".")[0];
  const sigB = tokenB.split(".")[1];
  const r = verifyToken(headerA + "." + sigB, SECRET, { now: nowFn });
  assert.strictEqual(r.valid, false);
  assert.strictEqual(r.reason, "bad signature");
});

test("[reviewer] verifyToken: appending base64url char to header invalidates signature", () => {
  const token = signToken({ role: "po" }, SECRET, { now: nowFn });
  const [h, s] = token.split(".");
  const r = verifyToken(h + "A." + s, SECRET, { now: nowFn });
  assert.strictEqual(r.valid, false);
});

test("[reviewer] verifyToken: empty signature part is rejected without throwing", () => {
  const token = signToken({ role: "po" }, SECRET, { now: nowFn });
  const h = token.split(".")[0];
  assert.doesNotThrow(() => verifyToken(h + ".", SECRET, { now: nowFn }));
  assert.strictEqual(verifyToken(h + ".", SECRET, { now: nowFn }).valid, false);
});

// --- signToken: caller cannot pre-seed iat/exp to forge a longer life ------

test("[reviewer] signToken: caller-supplied exp/iat are overwritten by the signer", () => {
  const token = signToken(
    { role: "po", exp: 9_999_999_999, iat: 0 },
    SECRET,
    { now: nowFn, ttl: 100 }
  );
  const r = verifyToken(token, SECRET, { now: nowFn });
  assert.strictEqual(r.valid, true);
  assert.strictEqual(r.payload.iat, FIXED_NOW);
  assert.strictEqual(r.payload.exp, FIXED_NOW + 100);
});

// --- parseCookies: more robustness -----------------------------------------

test("[reviewer] parseCookies: trailing/leading/empty segments are skipped", () => {
  const r = parseCookies("a=1;; ;b=2;");
  assert.deepStrictEqual(r, { a: "1", b: "2" });
});

test("[reviewer] parseCookies: duplicate cookie names — last value wins", () => {
  const r = parseCookies("a=1; a=2; a=3");
  assert.strictEqual(r["a"], "3");
});

test("[reviewer] parseCookies: empty value is preserved", () => {
  const r = parseCookies("a=; b=2");
  assert.strictEqual(r["a"], "");
  assert.strictEqual(r["b"], "2");
});

test("[reviewer] parseCookies: realistic header with HMAC token containing dots and '='", () => {
  const token = signToken({ role: "po" }, SECRET, { now: nowFn });
  const header = `${COOKIE_NAME}=${token}; other=1`;
  const r = parseCookies(header);
  assert.strictEqual(r[COOKIE_NAME], token, "full token must round-trip through cookie parse");
  assert.strictEqual(verifyToken(r[COOKIE_NAME], SECRET, { now: nowFn }).valid, true);
});

// --- serializeCookie -> parseCookies round-trip & hardened session cookie ---

test("[reviewer] serializeCookie produces a hardened session cookie (HttpOnly + SameSite + Secure)", () => {
  const token = signToken({ role: "po" }, SECRET, { now: nowFn });
  const setCookie = serializeCookie(COOKIE_NAME, token, {
    httpOnly: true,
    secure: true,
    sameSite: "Strict",
    path: "/",
    maxAge: 28800,
  });
  assert.ok(/(^|; )HttpOnly(;|$)/.test(setCookie), "HttpOnly directive present");
  assert.ok(/SameSite=Strict/.test(setCookie), "SameSite=Strict present");
  assert.ok(/(^|; )Secure(;|$)/.test(setCookie), "Secure present");
  // The name=value portion (before the first '; ') must parse back to the token.
  const nameValue = setCookie.split("; ")[0];
  const parsed = parseCookies(nameValue);
  assert.strictEqual(parsed[COOKIE_NAME], token);
});

test("[reviewer] serializeCookie: Max-Age=0 (expire/clear cookie) is emitted", () => {
  const str = serializeCookie(COOKIE_NAME, "", { maxAge: 0, path: "/" });
  assert.ok(str.includes("Max-Age=0"), "Max-Age=0 must be emitted to clear a cookie");
});

test("[reviewer] serializeCookie: fractional Max-Age is floored to an integer", () => {
  const str = serializeCookie("x", "y", { maxAge: 3600.9 });
  assert.ok(str.includes("Max-Age=3600"), "Max-Age must be an integer");
});

// --- no hardcoded secret: token signed under one secret fails under another -

test("[reviewer] secret is caller-supplied: same payload under two secrets yields different, non-cross-valid tokens", () => {
  const t1 = signToken({ role: "po" }, "secret-one", { now: nowFn });
  const t2 = signToken({ role: "po" }, "secret-two", { now: nowFn });
  assert.notStrictEqual(t1, t2, "different secrets must produce different signatures");
  assert.strictEqual(verifyToken(t1, "secret-two", { now: nowFn }).valid, false);
  assert.strictEqual(verifyToken(t2, "secret-one", { now: nowFn }).valid, false);
});
