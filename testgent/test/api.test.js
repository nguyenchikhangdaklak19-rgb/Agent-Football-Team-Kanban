/*
 * api.test.js — Offline unit tests for api/login.js, api/board.js, api/move.js
 *
 * All tests use:
 *   - createHandler(deps) factory to inject mocks (no real network, no env vars)
 *   - In-memory mock KV client (same pattern as kv-store.test.js)
 *   - Fake req/res objects capturing status / json / headers
 *   - Known test literals for BOARD_PASSWORD and BOARD_SECRET
 *
 * Run: node --test test/api.test.js
 *   or: npm test
 */
"use strict";

const { test } = require("node:test");
const assert = require("node:assert");

// Import factories from the three API modules
const { createHandler: createLogin } = require("../api/login");
const { createHandler: createBoard } = require("../api/board");
const { createHandler: createMove } = require("../api/move");

// Import auth helpers for token generation in tests
const auth = require("../lib/auth");

// ---------------------------------------------------------------------------
// Test constants (never committed secrets — test literals only)
// ---------------------------------------------------------------------------
const TEST_PASSWORD = "test-board-password-t5";
const TEST_SECRET = "test-hmac-secret-t5-do-not-use-in-production";
const FIXED_NOW = 1_700_000_000; // fixed unix timestamp for deterministic tests
const nowFn = () => FIXED_NOW;

// ---------------------------------------------------------------------------
// In-memory mock KV client (mirrors kv-store.test.js for consistency)
// ---------------------------------------------------------------------------

function makeMockClient(initialStore) {
  const store = Object.assign(Object.create(null), initialStore || {});
  return {
    async get(key) {
      return key in store ? store[key] : null;
    },
    async set(key, value) {
      store[key] = value;
    },
    async incr(key) {
      const current = key in store ? Number(store[key]) : 0;
      const next = current + 1;
      store[key] = String(next);
      return next;
    },
    _store: store,
  };
}

// ---------------------------------------------------------------------------
// Sample board data (includes a task that can be moved uat->done by po)
// ---------------------------------------------------------------------------

const SAMPLE_BOARD = {
  workflow: {
    states: ["backlog", "progress", "test", "uat", "done"],
    labels: {
      backlog: "Chờ làm",
      progress: "Đang làm",
      test: "Đang test",
      uat: "UAT",
      done: "Xong",
    },
    transitions: [
      { from: "backlog", to: "progress", by: "engineer" },
      { from: "progress", to: "test", by: "engineer" },
      { from: "test", to: "uat", by: "qa", requires: "tests_pass" },
      { from: "test", to: "backlog", by: "qa", flag: "reject" },
      { from: "uat", to: "done", by: "po" },
      { from: "uat", to: "backlog", by: "po", flag: "reject" },
    ],
    rules: [],
  },
  projects: [
    {
      id: "p1",
      name: "Project One",
      epics: [
        {
          id: "EP-1",
          title: "Epic One",
          tasks: [
            { id: "EP-1-T1", title: "Task in UAT", status: "uat", history: [] },
            { id: "EP-1-T2", title: "Task in test", status: "test", history: [] },
            { id: "EP-1-T3", title: "Task in backlog", status: "backlog", history: [] },
          ],
        },
      ],
    },
  ],
};

function freshKvOpts() {
  const client = makeMockClient({
    board: JSON.stringify(SAMPLE_BOARD),
    "board:version": "0",
  });
  return { kvOpts: { client }, client };
}

// ---------------------------------------------------------------------------
// Fake req / res factory
// ---------------------------------------------------------------------------

function makeReq(overrides) {
  return Object.assign(
    {
      method: "GET",
      headers: {},
      body: undefined,
    },
    overrides
  );
}

function makeRes() {
  const res = {
    _status: null,
    _body: null,
    _headers: {},
    status(code) {
      res._status = code;
      return res; // allow chaining: res.status(200).json(...)
    },
    json(obj) {
      res._body = obj;
      return res;
    },
    setHeader(name, value) {
      res._headers[name.toLowerCase()] = value;
    },
  };
  return res;
}

// ---------------------------------------------------------------------------
// Helper: generate a valid signed token (for auth'd requests)
// ---------------------------------------------------------------------------

function makeValidToken(opts) {
  return auth.signToken({ board: true }, TEST_SECRET, {
    ttl: 3600,
    now: nowFn,
    ...opts,
  });
}

function cookieHeader(token) {
  return auth.COOKIE_NAME + "=" + token;
}

// ---------------------------------------------------------------------------
// Helper: make a valid authenticated request with a cookie
// ---------------------------------------------------------------------------

function authedGetReq(extraHeaders) {
  const token = makeValidToken();
  return makeReq({
    method: "GET",
    headers: Object.assign(
      { cookie: cookieHeader(token) },
      extraHeaders || {}
    ),
  });
}

function authedPostReq(body, extraHeaders) {
  const token = makeValidToken();
  return makeReq({
    method: "POST",
    headers: Object.assign(
      { cookie: cookieHeader(token) },
      extraHeaders || {}
    ),
    body,
  });
}

// ============================================================================
// SECTION 1: api/login.js
// ============================================================================

test("login: correct password => 200 + Set-Cookie present with COOKIE_NAME and HttpOnly", async () => {
  const handler = createLogin({
    password: TEST_PASSWORD,
    secret: TEST_SECRET,
    now: nowFn,
  });
  const req = makeReq({ method: "POST", body: { password: TEST_PASSWORD } });
  const res = makeRes();

  await handler(req, res);

  assert.strictEqual(res._status, 200, "status must be 200");
  assert.strictEqual(res._body.ok, true, "body.ok must be true");
  assert.ok(res._headers["set-cookie"], "Set-Cookie header must be present");
  assert.ok(
    res._headers["set-cookie"].includes(auth.COOKIE_NAME + "="),
    "Set-Cookie must contain the COOKIE_NAME"
  );
  assert.ok(
    res._headers["set-cookie"].includes("HttpOnly"),
    "Set-Cookie must contain HttpOnly"
  );
});

test("login: wrong password => 401, no Set-Cookie", async () => {
  const handler = createLogin({
    password: TEST_PASSWORD,
    secret: TEST_SECRET,
    now: nowFn,
  });
  const req = makeReq({ method: "POST", body: { password: "WRONG_PASSWORD" } });
  const res = makeRes();

  await handler(req, res);

  assert.strictEqual(res._status, 401, "status must be 401");
  assert.strictEqual(res._body.ok, false, "body.ok must be false");
  assert.ok(!res._headers["set-cookie"], "Set-Cookie must NOT be present on failure");
});

test("login: missing password field => 400, no Set-Cookie", async () => {
  const handler = createLogin({
    password: TEST_PASSWORD,
    secret: TEST_SECRET,
    now: nowFn,
  });
  const req = makeReq({ method: "POST", body: {} });
  const res = makeRes();

  await handler(req, res);

  assert.strictEqual(res._status, 400, "missing password must be 400");
  assert.strictEqual(res._body.ok, false);
  assert.ok(!res._headers["set-cookie"], "no cookie on 400");
});

test("login: non-POST (GET) => 405", async () => {
  const handler = createLogin({
    password: TEST_PASSWORD,
    secret: TEST_SECRET,
    now: nowFn,
  });
  const req = makeReq({ method: "GET" });
  const res = makeRes();

  await handler(req, res);

  assert.strictEqual(res._status, 405, "must be 405 for non-POST");
  assert.strictEqual(res._body.ok, false);
});

test("login: non-POST (DELETE) => 405", async () => {
  const handler = createLogin({
    password: TEST_PASSWORD,
    secret: TEST_SECRET,
    now: nowFn,
  });
  const req = makeReq({ method: "DELETE" });
  const res = makeRes();

  await handler(req, res);

  assert.strictEqual(res._status, 405);
});

test("login: null body => 400", async () => {
  const handler = createLogin({
    password: TEST_PASSWORD,
    secret: TEST_SECRET,
    now: nowFn,
  });
  // null body: parseBody will try to parse and fail
  const req = makeReq({ method: "POST", body: null });
  const res = makeRes();

  await handler(req, res);

  // null body doesn't contain password field, expect 400 (non-object body -> 400)
  // OR it's treated as empty object by the handler (typeof null === "object")
  // Our handler checks: if body is null, we treat req.body=null as "not pre-parsed"
  // null is not an instance check of typeof object === "object"? Yes: typeof null === "object"
  // Our parseBody: req.body is null -> falls through to raw stream read
  // but in our fake req, there's no stream listener -> end never fires
  // Let's check what happens when body is provided as null explicitly
  // In our fake req, body: null will be seen in parseBody as null -> falls to stream reader
  // but our fake req doesn't have .on() etc. Let's handle this by testing with body: undefined too
  assert.ok(res._status >= 400, "null/missing body must result in 4xx");
});

test("login: non-string password value (number) => 400", async () => {
  const handler = createLogin({
    password: TEST_PASSWORD,
    secret: TEST_SECRET,
    now: nowFn,
  });
  const req = makeReq({ method: "POST", body: { password: 12345 } });
  const res = makeRes();

  await handler(req, res);

  assert.strictEqual(res._status, 400, "non-string password must be 400");
});

test("login: cookie contains the COOKIE_NAME token that is verifiable", async () => {
  const handler = createLogin({
    password: TEST_PASSWORD,
    secret: TEST_SECRET,
    now: nowFn,
    ttl: 3600,
  });
  const req = makeReq({ method: "POST", body: { password: TEST_PASSWORD } });
  const res = makeRes();

  await handler(req, res);

  assert.strictEqual(res._status, 200);
  const setCookieVal = res._headers["set-cookie"];
  // Extract token from Set-Cookie header
  const cookieMap = auth.parseCookies(setCookieVal.split(";")[0]);
  const token = cookieMap[auth.COOKIE_NAME];
  assert.ok(token, "token must be extractable from Set-Cookie");

  const verified = auth.verifyToken(token, TEST_SECRET, { now: nowFn });
  assert.strictEqual(verified.valid, true, "token issued by login must be verifiable");
});

// ============================================================================
// SECTION 2: api/board.js
// ============================================================================

test("board: no cookie => 401 and body contains no projects/workflow data", async () => {
  const { kvOpts } = freshKvOpts();
  const handler = createBoard({ secret: TEST_SECRET, kvOpts, now: nowFn });

  const req = makeReq({ method: "GET", headers: {} });
  const res = makeRes();

  await handler(req, res);

  assert.strictEqual(res._status, 401, "must be 401 without cookie");
  assert.strictEqual(res._body.ok, false);
  assert.ok(!res._body.projects, "body must not contain projects on 401");
  assert.ok(!res._body.workflow, "body must not contain workflow on 401");
});

test("board: tampered token => 401", async () => {
  const { kvOpts } = freshKvOpts();
  const handler = createBoard({ secret: TEST_SECRET, kvOpts, now: nowFn });

  const token = makeValidToken();
  const [headerPart, sigPart] = token.split(".");
  // Tamper payload
  const tampered =
    headerPart.slice(0, -1) +
    (headerPart.slice(-1) === "A" ? "B" : "A") +
    "." + sigPart;

  const req = makeReq({
    method: "GET",
    headers: { cookie: cookieHeader(tampered) },
  });
  const res = makeRes();

  await handler(req, res);

  assert.strictEqual(res._status, 401, "tampered token must be 401");
  assert.ok(!res._body.projects, "no board data on 401");
});

test("board: expired token => 401", async () => {
  const { kvOpts } = freshKvOpts();
  const handler = createBoard({ secret: TEST_SECRET, kvOpts, now: nowFn });

  // Sign a token that is already expired
  const token = auth.signToken({ board: true }, TEST_SECRET, {
    ttl: 60,
    now: () => FIXED_NOW - 120, // issued 2 mins ago, ttl=60 => already expired
  });

  const req = makeReq({
    method: "GET",
    headers: { cookie: cookieHeader(token) },
  });
  const res = makeRes();

  await handler(req, res);

  assert.strictEqual(res._status, 401, "expired token must be 401");
  assert.ok(!res._body.projects, "no board data on expired token");
});

test("board: valid token => 200 with board data (projects and workflow)", async () => {
  const { kvOpts } = freshKvOpts();
  const handler = createBoard({ secret: TEST_SECRET, kvOpts, now: nowFn });

  const req = authedGetReq();
  const res = makeRes();

  await handler(req, res);

  assert.strictEqual(res._status, 200, "valid token must be 200");
  assert.ok(res._body.projects, "body must contain projects");
  assert.ok(res._body.workflow, "body must contain workflow");
  assert.ok(Array.isArray(res._body.projects), "projects must be an array");
});

test("board: non-GET (POST) => 405", async () => {
  const { kvOpts } = freshKvOpts();
  const handler = createBoard({ secret: TEST_SECRET, kvOpts, now: nowFn });

  const req = makeReq({ method: "POST", headers: {} });
  const res = makeRes();

  await handler(req, res);

  assert.strictEqual(res._status, 405, "must be 405 for non-GET");
});

test("board: wrong secret => 401", async () => {
  const { kvOpts } = freshKvOpts();
  // handler uses a different secret from the token
  const handler = createBoard({ secret: "different-secret", kvOpts, now: nowFn });

  const token = makeValidToken(); // signed with TEST_SECRET
  const req = makeReq({
    method: "GET",
    headers: { cookie: cookieHeader(token) },
  });
  const res = makeRes();

  await handler(req, res);

  assert.strictEqual(res._status, 401, "token signed with wrong secret must be 401");
});

// ============================================================================
// SECTION 3: api/move.js
// ============================================================================

test("move: no token => 401 and no state change", async () => {
  const { kvOpts, client } = freshKvOpts();
  const handler = createMove({ secret: TEST_SECRET, kvOpts, now: nowFn });

  const boardBefore = client._store["board"];
  const req = makeReq({
    method: "POST",
    headers: {},
    body: { id: "EP-1-T1", to: "done", by: "po" },
  });
  const res = makeRes();

  await handler(req, res);

  assert.strictEqual(res._status, 401, "no token must be 401");
  assert.strictEqual(res._body.ok, false);
  // Board must NOT have changed
  assert.strictEqual(client._store["board"], boardBefore, "no state change on 401");
});

test("move: invalid (tampered) token => 401 and no state change", async () => {
  const { kvOpts, client } = freshKvOpts();
  const handler = createMove({ secret: TEST_SECRET, kvOpts, now: nowFn });

  const boardBefore = client._store["board"];
  const token = makeValidToken();
  const [h, s] = token.split(".");
  const tampered = h.slice(0, -1) + (h.slice(-1) === "A" ? "B" : "A") + "." + s;

  const req = makeReq({
    method: "POST",
    headers: { cookie: cookieHeader(tampered) },
    body: { id: "EP-1-T1", to: "done", by: "po" },
  });
  const res = makeRes();

  await handler(req, res);

  assert.strictEqual(res._status, 401, "tampered token must be 401");
  assert.strictEqual(client._store["board"], boardBefore, "no state change on tampered token");
});

test("move: valid token + legal move (uat->done by po) => 200 and persisted", async () => {
  const { kvOpts, client } = freshKvOpts();
  const handler = createMove({ secret: TEST_SECRET, kvOpts, now: nowFn });

  const req = authedPostReq({ id: "EP-1-T1", to: "done", by: "po" });
  const res = makeRes();

  await handler(req, res);

  assert.strictEqual(res._status, 200, "legal move must be 200");
  assert.strictEqual(res._body.ok, true, "body.ok must be true");
  assert.ok(res._body.task, "body must include the updated task");
  assert.strictEqual(res._body.task.status, "done", "task status must be 'done'");

  // Verify durability: re-load the board from KV and check
  const kv = require("../lib/kv-store");
  const { data } = await kv.load({ client });
  const movedTask = data.projects[0].epics[0].tasks[0];
  assert.strictEqual(movedTask.status, "done", "persisted status must be 'done'");
  assert.ok(
    movedTask.history && movedTask.history.length > 0,
    "history must be populated"
  );
});

test("move: valid token + illegal move (engineer pushing uat->done) => 409 with error, no change", async () => {
  const { kvOpts, client } = freshKvOpts();
  const handler = createMove({ secret: TEST_SECRET, kvOpts, now: nowFn });

  const boardBefore = client._store["board"];
  const req = authedPostReq({ id: "EP-1-T1", to: "done", by: "engineer" });
  const res = makeRes();

  await handler(req, res);

  assert.strictEqual(res._status, 409, "illegal move must be 409");
  assert.strictEqual(res._body.ok, false, "body.ok must be false");
  assert.ok(res._body.error && res._body.error.length > 0, "error message must be present");
  // Board must not have changed
  assert.strictEqual(client._store["board"], boardBefore, "no state change on 409");
});

test("move: valid token + test->uat without testsPass => 409", async () => {
  const { kvOpts, client } = freshKvOpts();
  const handler = createMove({ secret: TEST_SECRET, kvOpts, now: nowFn });

  const boardBefore = client._store["board"];
  // EP-1-T2 is in 'test' status
  const req = authedPostReq({ id: "EP-1-T2", to: "uat", by: "qa", testsPass: false });
  const res = makeRes();

  await handler(req, res);

  assert.strictEqual(res._status, 409, "missing tests_pass must be 409");
  assert.strictEqual(res._body.ok, false);
  assert.ok(res._body.error.toLowerCase().includes("test") || res._body.error.length > 0,
    "error must describe the issue");
  assert.strictEqual(client._store["board"], boardBefore, "no change without tests_pass");
});

test("move: valid token + test->uat with testsPass:true => 200", async () => {
  const { kvOpts, client } = freshKvOpts();
  const handler = createMove({ secret: TEST_SECRET, kvOpts, now: nowFn });

  const req = authedPostReq({ id: "EP-1-T2", to: "uat", by: "qa", testsPass: true });
  const res = makeRes();

  await handler(req, res);

  assert.strictEqual(res._status, 200, "test->uat with testsPass:true must be 200");
  assert.strictEqual(res._body.task.status, "uat");
});

test("move: unknown task id => 404", async () => {
  const { kvOpts } = freshKvOpts();
  const handler = createMove({ secret: TEST_SECRET, kvOpts, now: nowFn });

  const req = authedPostReq({ id: "NOPE-T999", to: "done", by: "po" });
  const res = makeRes();

  await handler(req, res);

  assert.strictEqual(res._status, 404, "unknown task must be 404");
  assert.strictEqual(res._body.ok, false);
  assert.ok(res._body.error.includes("NOPE-T999"), "error must mention the missing id");
});

test("move: missing id field => 400", async () => {
  const { kvOpts } = freshKvOpts();
  const handler = createMove({ secret: TEST_SECRET, kvOpts, now: nowFn });

  const req = authedPostReq({ to: "done", by: "po" }); // missing id
  const res = makeRes();

  await handler(req, res);

  assert.strictEqual(res._status, 400, "missing id must be 400");
  assert.strictEqual(res._body.ok, false);
});

test("move: missing to field => 400", async () => {
  const { kvOpts } = freshKvOpts();
  const handler = createMove({ secret: TEST_SECRET, kvOpts, now: nowFn });

  const req = authedPostReq({ id: "EP-1-T1", by: "po" }); // missing to
  const res = makeRes();

  await handler(req, res);

  assert.strictEqual(res._status, 400);
});

test("move: missing by field => 400", async () => {
  const { kvOpts } = freshKvOpts();
  const handler = createMove({ secret: TEST_SECRET, kvOpts, now: nowFn });

  const req = authedPostReq({ id: "EP-1-T1", to: "done" }); // missing by
  const res = makeRes();

  await handler(req, res);

  assert.strictEqual(res._status, 400);
});

test("move: non-POST => 405", async () => {
  const { kvOpts } = freshKvOpts();
  const handler = createMove({ secret: TEST_SECRET, kvOpts, now: nowFn });

  const token = makeValidToken();
  const req = makeReq({
    method: "GET",
    headers: { cookie: cookieHeader(token) },
  });
  const res = makeRes();

  await handler(req, res);

  assert.strictEqual(res._status, 405);
});

// ============================================================================
// SECTION 4: Concurrency — two concurrent moves both persist
// ============================================================================

test("concurrency: two concurrent valid move requests both persist (no lost update)", async () => {
  /*
   * Uses the same shared in-memory backend pattern as kv-store.test.js.
   * Two move handlers operate on the same backend concurrently via Promise.all.
   * EP-1-T3 (backlog) and EP-1-T1 (uat) are moved simultaneously.
   * Both must succeed and be visible when the board is re-loaded.
   */

  // Shared backend with real async yields (mimics genuine concurrency)
  const state = {
    board: JSON.stringify(SAMPLE_BOARD),
    version: 0,
  };

  function makeSharedClient() {
    return {
      async get(key) {
        await Promise.resolve(); // yield
        if (key === "board") return state.board;
        if (key === "board:version") return String(state.version);
        return null;
      },
      async set(key, value) {
        await Promise.resolve();
        if (key === "board") state.board = value;
      },
      async incr(key) {
        await Promise.resolve();
        if (key === "board:version") {
          state.version += 1;
          return state.version;
        }
        return 1;
      },
    };
  }

  const deps = (client) => ({
    secret: TEST_SECRET,
    kvOpts: { client },
    now: nowFn,
  });

  const handlerA = createMove(deps(makeSharedClient()));
  const handlerB = createMove(deps(makeSharedClient()));

  // Move A: EP-1-T3 backlog -> progress by engineer
  const reqA = authedPostReq({ id: "EP-1-T3", to: "progress", by: "engineer" });
  const resA = makeRes();

  // Move B: EP-1-T1 uat -> done by po
  const reqB = authedPostReq({ id: "EP-1-T1", to: "done", by: "po" });
  const resB = makeRes();

  // Fire both concurrently
  await Promise.all([
    handlerA(reqA, resA),
    handlerB(reqB, resB),
  ]);

  assert.strictEqual(resA._status, 200, "Move A must succeed (200)");
  assert.strictEqual(resB._status, 200, "Move B must succeed (200)");

  // Verify both are persisted
  const kv = require("../lib/kv-store");
  const { data } = await kv.load({ client: makeSharedClient() });

  const taskT3 = data.projects[0].epics[0].tasks.find((t) => t.id === "EP-1-T3");
  const taskT1 = data.projects[0].epics[0].tasks.find((t) => t.id === "EP-1-T1");

  assert.strictEqual(taskT3.status, "progress", "EP-1-T3 must be in 'progress' (Move A persisted)");
  assert.strictEqual(taskT1.status, "done", "EP-1-T1 must be in 'done' (Move B persisted)");
});

// ============================================================================
// SECTION 5: End-to-end auth chain
// ============================================================================

test("e2e auth chain: login -> cookie -> board returns data", async () => {
  /*
   * Full chain: POST /api/login, get cookie, feed cookie into GET /api/board.
   * Proves the token issued by login is accepted by the board gate.
   */
  const { kvOpts } = freshKvOpts();

  const loginHandler = createLogin({
    password: TEST_PASSWORD,
    secret: TEST_SECRET,
    ttl: 3600,
    now: nowFn,
  });
  const boardHandler = createBoard({ secret: TEST_SECRET, kvOpts, now: nowFn });

  // Step 1: Login
  const loginReq = makeReq({ method: "POST", body: { password: TEST_PASSWORD } });
  const loginRes = makeRes();
  await loginHandler(loginReq, loginRes);

  assert.strictEqual(loginRes._status, 200, "login must succeed");
  const setCookie = loginRes._headers["set-cookie"];
  assert.ok(setCookie, "Set-Cookie must be present");

  // Step 2: Extract cookie value (the part before the first ';')
  // Set-Cookie: board_token=<token>; Path=/; Max-Age=...
  const cookieValue = setCookie.split(";")[0]; // "board_token=<token>"

  // Step 3: Feed cookie into board GET
  const boardReq = makeReq({
    method: "GET",
    headers: { cookie: cookieValue },
  });
  const boardRes = makeRes();
  await boardHandler(boardReq, boardRes);

  assert.strictEqual(boardRes._status, 200, "board must accept cookie from login");
  assert.ok(boardRes._body.projects, "board response must contain projects");
});

test("e2e auth chain: login -> cookie -> move succeeds", async () => {
  /*
   * Full chain: POST /api/login, get cookie, POST /api/move.
   * Proves the token issued by login is accepted by the move auth gate.
   */
  const { kvOpts } = freshKvOpts();

  const loginHandler = createLogin({
    password: TEST_PASSWORD,
    secret: TEST_SECRET,
    ttl: 3600,
    now: nowFn,
  });
  const moveHandler = createMove({ secret: TEST_SECRET, kvOpts, now: nowFn });

  // Step 1: Login
  const loginReq = makeReq({ method: "POST", body: { password: TEST_PASSWORD } });
  const loginRes = makeRes();
  await loginHandler(loginReq, loginRes);

  assert.strictEqual(loginRes._status, 200, "login must succeed");
  const setCookie = loginRes._headers["set-cookie"];

  // Extract just the name=value part for the Cookie header
  const cookieValue = setCookie.split(";")[0];

  // Step 2: Move EP-1-T1 (uat -> done by po)
  const moveReq = makeReq({
    method: "POST",
    headers: { cookie: cookieValue },
    body: { id: "EP-1-T1", to: "done", by: "po" },
  });
  const moveRes = makeRes();
  await moveHandler(moveReq, moveRes);

  assert.strictEqual(moveRes._status, 200, "move must accept cookie from login");
  assert.strictEqual(moveRes._body.ok, true);
  assert.strictEqual(moveRes._body.task.status, "done");
});

test("e2e auth chain: wrong password login -> 401, cookie rejected by board", async () => {
  const { kvOpts } = freshKvOpts();

  const loginHandler = createLogin({
    password: TEST_PASSWORD,
    secret: TEST_SECRET,
    now: nowFn,
  });
  const boardHandler = createBoard({ secret: TEST_SECRET, kvOpts, now: nowFn });

  // Step 1: Wrong password login
  const loginReq = makeReq({ method: "POST", body: { password: "wrong-password" } });
  const loginRes = makeRes();
  await loginHandler(loginReq, loginRes);

  assert.strictEqual(loginRes._status, 401, "login must fail");
  assert.ok(!loginRes._headers["set-cookie"], "no Set-Cookie on failed login");

  // Step 2: Try board without cookie (no cookie was set)
  const boardReq = makeReq({ method: "GET", headers: {} });
  const boardRes = makeRes();
  await boardHandler(boardReq, boardRes);

  assert.strictEqual(boardRes._status, 401, "board must reject request without valid cookie");
  assert.ok(!boardRes._body.projects, "no board data must leak");
});

// ============================================================================
// SECTION 6: Additional edge cases
// ============================================================================

test("move: expired token is rejected before any KV access", async () => {
  const { kvOpts, client } = freshKvOpts();
  const handler = createMove({ secret: TEST_SECRET, kvOpts, now: nowFn });

  const boardBefore = client._store["board"];
  // Create an already-expired token
  const expiredToken = auth.signToken({ board: true }, TEST_SECRET, {
    ttl: 60,
    now: () => FIXED_NOW - 120, // expired 1 min ago
  });

  const req = makeReq({
    method: "POST",
    headers: { cookie: cookieHeader(expiredToken) },
    body: { id: "EP-1-T1", to: "done", by: "po" },
  });
  const res = makeRes();

  await handler(req, res);

  assert.strictEqual(res._status, 401, "expired token must be 401 on move");
  assert.strictEqual(client._store["board"], boardBefore, "no state change on expired token");
});

test("move: invalid transition (backlog->done directly) => 409 with error", async () => {
  const { kvOpts } = freshKvOpts();
  const handler = createMove({ secret: TEST_SECRET, kvOpts, now: nowFn });

  // EP-1-T3 is in 'backlog'; skipping to 'done' is not a valid transition
  const req = authedPostReq({ id: "EP-1-T3", to: "done", by: "po" });
  const res = makeRes();

  await handler(req, res);

  assert.strictEqual(res._status, 409, "invalid transition must be 409");
  assert.strictEqual(res._body.ok, false);
  assert.ok(res._body.error && res._body.error.length > 0, "must have error message");
});

test("board: valid token returns the correct projects shape", async () => {
  const { kvOpts } = freshKvOpts();
  const handler = createBoard({ secret: TEST_SECRET, kvOpts, now: nowFn });

  const req = authedGetReq();
  const res = makeRes();

  await handler(req, res);

  assert.strictEqual(res._status, 200);
  const body = res._body;
  // Verify the response shape matches what the client expects
  assert.ok(Array.isArray(body.projects), "projects must be an array");
  assert.ok(body.projects.length > 0, "must have at least one project");
  const project = body.projects[0];
  assert.ok(project.id, "project must have id");
  assert.ok(project.name, "project must have name");
  assert.ok(Array.isArray(project.epics), "project must have epics array");
});

test("move: uat->backlog (reject) by po => 200 with reject flag", async () => {
  const { kvOpts, client } = freshKvOpts();
  const handler = createMove({ secret: TEST_SECRET, kvOpts, now: nowFn });

  const req = authedPostReq({ id: "EP-1-T1", to: "backlog", by: "po" });
  const res = makeRes();

  await handler(req, res);

  assert.strictEqual(res._status, 200, "uat->backlog by po must be 200");
  assert.strictEqual(res._body.task.status, "backlog", "task must be in backlog");
  assert.strictEqual(res._body.task.reject, true, "reject flag must be set");

  // Verify persisted
  const kv = require("../lib/kv-store");
  const { data } = await kv.load({ client });
  const t = data.projects[0].epics[0].tasks[0];
  assert.strictEqual(t.status, "backlog", "persisted status must be 'backlog'");
  assert.strictEqual(t.reject, true, "persisted reject flag must be true");
});

// ============================================================================
// SECTION 7: Reviewer edge-case tests (added by QA/reviewer)
// ============================================================================

// ---- 7a. Auth gate: malformed / garbage cookies on BOTH endpoints ----------

const GARBAGE_COOKIES = [
  ["empty token value", auth.COOKIE_NAME + "="],
  ["garbage non-base64 token", auth.COOKIE_NAME + "=$$$not-a-token$$$"],
  ["only one part (no dot)", auth.COOKIE_NAME + "=justonepart"],
  ["three parts", auth.COOKIE_NAME + "=a.b.c"],
  ["right name wrong value", auth.COOKIE_NAME + "=deadbeef.deadbeef"],
  ["wrong cookie name entirely", "some_other_cookie=" + "x.y"],
  ["malformed pair, no equals", "garbagewithoutequals"],
];

for (const [label, cookie] of GARBAGE_COOKIES) {
  test("board: garbage cookie (" + label + ") => 401, no data leak", async () => {
    const { kvOpts } = freshKvOpts();
    const handler = createBoard({ secret: TEST_SECRET, kvOpts, now: nowFn });
    const req = makeReq({ method: "GET", headers: { cookie } });
    const res = makeRes();
    await handler(req, res);
    assert.strictEqual(res._status, 401, "garbage cookie must be 401");
    assert.ok(!res._body.projects, "no projects leaked on 401");
    assert.ok(!res._body.workflow, "no workflow leaked on 401");
  });

  test("move: garbage cookie (" + label + ") => 401, KV untouched", async () => {
    const { kvOpts, client } = freshKvOpts();
    const handler = createMove({ secret: TEST_SECRET, kvOpts, now: nowFn });
    const boardBefore = client._store["board"];
    const versionBefore = client._store["board:version"];
    const req = makeReq({
      method: "POST",
      headers: { cookie },
      body: { id: "EP-1-T1", to: "done", by: "po" },
    });
    const res = makeRes();
    await handler(req, res);
    assert.strictEqual(res._status, 401, "garbage cookie must be 401 on move");
    assert.ok(!res._body.projects, "no projects leaked in move 401 body");
    assert.ok(!res._body.workflow, "no workflow leaked in move 401 body");
    assert.strictEqual(client._store["board"], boardBefore, "board untouched on rejected auth");
    assert.strictEqual(
      client._store["board:version"],
      versionBefore,
      "version counter untouched on rejected auth (no INCR before gate)"
    );
  });
}

// ---- 7b. move 401 body must carry zero board data --------------------------

test("move: no cookie => 401 body has zero board data (no projects/workflow leak)", async () => {
  const { kvOpts } = freshKvOpts();
  const handler = createMove({ secret: TEST_SECRET, kvOpts, now: nowFn });
  const req = makeReq({
    method: "POST",
    headers: {},
    body: { id: "EP-1-T1", to: "done", by: "po" },
  });
  const res = makeRes();
  await handler(req, res);
  assert.strictEqual(res._status, 401);
  assert.ok(!res._body.projects, "no projects in move 401 body");
  assert.ok(!res._body.workflow, "no workflow in move 401 body");
  assert.ok(!res._body.task, "no task in move 401 body");
});

// ---- 7c. Empty / missing BOARD_SECRET must NOT bypass the gate -------------

test("board: empty secret rejects a token signed with the real secret (no bypass)", async () => {
  const { kvOpts } = freshKvOpts();
  // Handler configured with empty secret (simulates BOARD_SECRET unset on Vercel)
  const handler = createBoard({ secret: "", kvOpts, now: nowFn });
  // Attacker presents a token signed with the REAL secret
  const token = makeValidToken();
  const req = makeReq({
    method: "GET",
    headers: { cookie: cookieHeader(token) },
  });
  const res = makeRes();
  await handler(req, res);
  assert.strictEqual(res._status, 401, "mismatched (empty) secret must reject => 401");
  assert.ok(!res._body.projects, "no data leak when secret mismatches");
});

test("move: empty secret rejects real-secret token and leaves KV untouched", async () => {
  const { kvOpts, client } = freshKvOpts();
  const handler = createMove({ secret: "", kvOpts, now: nowFn });
  const boardBefore = client._store["board"];
  const token = makeValidToken();
  const req = makeReq({
    method: "POST",
    headers: { cookie: cookieHeader(token) },
    body: { id: "EP-1-T1", to: "done", by: "po" },
  });
  const res = makeRes();
  await handler(req, res);
  assert.strictEqual(res._status, 401, "empty-secret handler must reject => 401");
  assert.strictEqual(client._store["board"], boardBefore, "KV untouched");
});

// ---- 7d. Crash-safety: KV failure surfaces as 500, never a data leak/hang --

test("board: KV load failure => 500, no board data leaked, no hang", async () => {
  const exploding = {
    async get() { throw new Error("boom: KV down"); },
    async set() { throw new Error("boom"); },
    async incr() { throw new Error("boom"); },
  };
  const handler = createBoard({ secret: TEST_SECRET, kvOpts: { client: exploding }, now: nowFn });
  const req = authedGetReq();
  const res = makeRes();
  await handler(req, res);
  assert.strictEqual(res._status, 500, "KV failure must surface as 500");
  assert.ok(!res._body.projects, "no projects leaked in 500 body");
  assert.ok(!res._body.workflow, "no workflow leaked in 500 body");
  assert.strictEqual(res._body.ok, false, "500 body must report failure");
});

test("move: KV update failure => 500, no data leaked, no hang", async () => {
  const exploding = {
    async get() { throw new Error("boom: KV down"); },
    async set() { throw new Error("boom"); },
    async incr() { throw new Error("boom"); },
  };
  const handler = createMove({ secret: TEST_SECRET, kvOpts: { client: exploding }, now: nowFn });
  const req = authedPostReq({ id: "EP-1-T1", to: "done", by: "po" });
  const res = makeRes();
  await handler(req, res);
  assert.strictEqual(res._status, 500, "KV failure must surface as 500");
  assert.ok(!res._body.projects, "no projects leaked in move 500 body");
  assert.strictEqual(res._body.ok, false);
});

// ---- 7e. testsPass must be strict === true at the handler boundary ----------

test("move: test->uat with truthy-but-not-true testsPass ('yes') => 409 (strict ===)", async () => {
  const { kvOpts, client } = freshKvOpts();
  const handler = createMove({ secret: TEST_SECRET, kvOpts, now: nowFn });
  const boardBefore = client._store["board"];
  const req = authedPostReq({ id: "EP-1-T2", to: "uat", by: "qa", testsPass: "yes" });
  const res = makeRes();
  await handler(req, res);
  assert.strictEqual(res._status, 409, "non-strict-true testsPass must be blocked");
  assert.strictEqual(client._store["board"], boardBefore, "no change when testsPass is not === true");
});

// ---- 7f. Concurrency THROUGH the handler with forced CAS contention --------

test("concurrency: forced CAS contention through move handler => both persist, no lost update", async () => {
  /*
   * REVIEWER FINDING (currently RED): this exposes a lost-update defect in the
   * shared lib/kv-store.js CAS that /api/move relies on for the spec's
   * concurrency acceptance criterion ("hai move gần như đồng thời không nuốt
   * mất nhau").
   *
   * Drives genuine contention: both load() calls observe version 0 before
   * either INCR runs. The backend serializes INCR (Redis semantics) so exactly
   * one writer reserves version 1 and writes; the other gets version 2, detects
   * the conflict, reloads, and retries.
   *
   * The bug: kv-store.update() reserves a version slot via INCR, but the board
   * SET is a SEPARATE, LATER command. The losing writer's retry GET(board) can
   * land in the window AFTER the winner's INCR but BEFORE the winner's SET,
   * reading STALE board state, then SET its own mutation over the winner's =>
   * the winner's move is silently lost. INCR-as-reservation does not fence the
   * board read against an in-flight, uncommitted board write.
   *
   * Owned by T5? No — the fix belongs in lib/kv-store.js (T1). This test stays
   * red until that CAS is made safe (e.g. single atomic Lua check-and-set, or a
   * version embedded in the board value compared inside one atomic op).
   *
   * Both moves must end up persisted (no lost update).
   */
  const state = { board: JSON.stringify(SAMPLE_BOARD), version: 0 };

  // Gate that releases both load()s only after BOTH have read version 0.
  let loadCount = 0;
  let releaseBoth;
  const bothLoaded = new Promise((r) => { releaseBoth = r; });

  function makeContendingClient() {
    return {
      async get(key) {
        if (key === "board") {
          const snapshot = state.board;
          loadCount += 1;
          if (loadCount === 2) releaseBoth();
          // Hold until both readers have captured the current snapshot.
          await bothLoaded;
          return snapshot;
        }
        if (key === "board:version") return String(state.version);
        return null;
      },
      async set(key, value) {
        await Promise.resolve();
        if (key === "board") state.board = value;
      },
      async incr(key) {
        // Serialized atomic increment (Redis INCR semantics).
        await Promise.resolve();
        if (key === "board:version") {
          state.version += 1;
          return state.version;
        }
        return 1;
      },
    };
  }

  const deps = (client) => ({ secret: TEST_SECRET, kvOpts: { client }, now: nowFn });
  const handlerA = createMove(deps(makeContendingClient()));
  const handlerB = createMove(deps(makeContendingClient()));

  const reqA = authedPostReq({ id: "EP-1-T3", to: "progress", by: "engineer" });
  const resA = makeRes();
  const reqB = authedPostReq({ id: "EP-1-T1", to: "done", by: "po" });
  const resB = makeRes();

  await Promise.all([handlerA(reqA, resA), handlerB(reqB, resB)]);

  assert.strictEqual(resA._status, 200, "Move A must succeed after CAS resolution");
  assert.strictEqual(resB._status, 200, "Move B must succeed after CAS resolution");

  const kv = require("../lib/kv-store");
  const final = JSON.parse(state.board);
  const t3 = final.projects[0].epics[0].tasks.find((t) => t.id === "EP-1-T3");
  const t1 = final.projects[0].epics[0].tasks.find((t) => t.id === "EP-1-T1");
  assert.strictEqual(t3.status, "progress", "Move A persisted (not lost)");
  assert.strictEqual(t1.status, "done", "Move B persisted (not lost)");
  // version advanced by exactly 2 successful writes (each owns one slot)
  assert.ok(state.version >= 2, "both writers reserved a version slot");
  // touch kv to keep import meaningful
  assert.ok(typeof kv.update === "function");
});

// ---- 7g. login: error text must not leak password-closeness ----------------

test("login: wrong-password error text is generic (no length/closeness oracle)", async () => {
  const handler = createLogin({ password: TEST_PASSWORD, secret: TEST_SECRET, now: nowFn });

  async function loginWith(pw) {
    const req = makeReq({ method: "POST", body: { password: pw } });
    const res = makeRes();
    await handler(req, res);
    return res;
  }

  // A near-match (same length, one char off) and a wildly-different one
  const near = await loginWith(TEST_PASSWORD.slice(0, -1) + "X");
  const far = await loginWith("x");

  assert.strictEqual(near._status, 401);
  assert.strictEqual(far._status, 401);
  // Identical generic error regardless of how close the guess was.
  assert.deepStrictEqual(
    near._body.error,
    far._body.error,
    "error message must be identical for near and far wrong guesses"
  );
  assert.ok(!near._headers["set-cookie"], "no cookie on near miss");
  assert.ok(!far._headers["set-cookie"], "no cookie on far miss");
});

// ---- 7h. login: malformed JSON string body => 400, no cookie ---------------

test("login: malformed JSON string body => 400, no cookie", async () => {
  const handler = createLogin({ password: TEST_PASSWORD, secret: TEST_SECRET, now: nowFn });
  const req = makeReq({ method: "POST", body: "{not valid json" });
  const res = makeRes();
  await handler(req, res);
  assert.strictEqual(res._status, 400, "malformed JSON must be 400");
  assert.ok(!res._headers["set-cookie"], "no cookie on malformed body");
});

// ---- 7i. move: malformed JSON string body (post-auth) => 400, KV untouched -

test("move: authed but malformed JSON body => 400, KV untouched", async () => {
  const { kvOpts, client } = freshKvOpts();
  const handler = createMove({ secret: TEST_SECRET, kvOpts, now: nowFn });
  const boardBefore = client._store["board"];
  const req = authedPostReq("{bad json");
  const res = makeRes();
  await handler(req, res);
  assert.strictEqual(res._status, 400, "malformed body must be 400");
  assert.strictEqual(client._store["board"], boardBefore, "no KV change on 400");
});
