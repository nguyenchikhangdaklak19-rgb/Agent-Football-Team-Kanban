/*
 * server.test.js — adversarial integration tests for the Team Board HTTP server.
 *
 * Spawns the real server (server.js) as a child process against a fresh temp
 * copy of board-data.json on a random high port, then drives it over Node's
 * built-in http client. The real data file is never mutated: every run gets its
 * own BOARD_FILE in os.tmpdir(). The child is always killed in `after`.
 *
 * Run:  cd testgent && node --test test/server.test.js
 */
"use strict";

const { test, before, after } = require("node:test");
const assert = require("node:assert");
const { spawn } = require("node:child_process");
const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

// Resolve paths relative to THIS file so the suite runs from any CWD.
const TESTGENT_DIR = path.resolve(__dirname, "..");
const SERVER_JS = path.join(TESTGENT_DIR, "server.js");
const DATA_FILE = path.join(TESTGENT_DIR, "board-data.json");

// Pick a random high port to dodge collisions with other suites/processes.
const PORT = 20000 + Math.floor(Math.random() * 20000);
const BASE = "http://127.0.0.1:" + PORT;

let child = null;
let tmpFile = null;

// --- helpers ----------------------------------------------------------------

// Make a fresh temp copy of board-data.json. Returns the temp path.
function freshData() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "board-server-test-"));
  const tmp = path.join(dir, "board-data.json");
  fs.copyFileSync(DATA_FILE, tmp);
  return tmp;
}

function readData() {
  return JSON.parse(fs.readFileSync(tmpFile, "utf8"));
}

function findTask(data, id) {
  for (const p of data.projects)
    for (const e of p.epics)
      for (const t of e.tasks) if (t.id === id) return t;
  return null;
}

// Minimal promise-based HTTP request over the built-in client.
// opts: { method, path, headers, body (string) }. Returns { status, headers, body }.
function request(opts) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      BASE + opts.path,
      {
        method: opts.method || "GET",
        headers: opts.headers || {},
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (body += c));
        res.on("end", () =>
          resolve({ status: res.statusCode, headers: res.headers, body })
        );
      }
    );
    req.on("error", reject);
    if (opts.body != null) req.write(opts.body);
    req.end();
  });
}

function getJSON(p) {
  return request({ path: p }).then((r) => ({
    status: r.status,
    headers: r.headers,
    json: JSON.parse(r.body),
  }));
}

function postMove(obj, raw) {
  const body = raw != null ? raw : JSON.stringify(obj);
  return request({
    method: "POST",
    path: "/api/move",
    headers: { "Content-Type": "application/json" },
    body,
  }).then((r) => {
    let json = null;
    try {
      json = JSON.parse(r.body);
    } catch (_) {
      /* some error paths may not be JSON; leave null */
    }
    return { status: r.status, headers: r.headers, body: r.body, json };
  });
}

// Poll until the server answers GET /api/board (or time out).
async function waitForServer(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await request({ path: "/api/board" });
      if (r.status === 200) return;
    } catch (_) {
      /* not up yet */
    }
    await new Promise((res) => setTimeout(res, 50));
  }
  throw new Error("server did not become ready within " + timeoutMs + "ms");
}

// --- lifecycle --------------------------------------------------------------

before(async () => {
  tmpFile = freshData();
  child = spawn("node", [SERVER_JS], {
    cwd: TESTGENT_DIR,
    env: { ...process.env, PORT: String(PORT), BOARD_FILE: tmpFile },
    stdio: ["ignore", "pipe", "pipe"],
  });
  // Surface child crashes for debugging without failing the harness directly.
  child.stderr.on("data", (d) => {
    process.stderr.write("[server stderr] " + d);
  });
  await waitForServer(8000);
});

after(() => {
  if (child && !child.killed) {
    try {
      child.kill("SIGKILL");
    } catch (_) {
      /* already gone */
    }
  }
});

// --- GET /api/board ---------------------------------------------------------

test("GET /api/board -> 200 JSON with projects[] and workflow", async () => {
  const r = await getJSON("/api/board");
  assert.equal(r.status, 200);
  assert.match(String(r.headers["content-type"]), /application\/json/);
  assert.ok(Array.isArray(r.json.projects), "projects must be an array");
  assert.ok(r.json.workflow && typeof r.json.workflow === "object", "workflow object present");
  assert.ok(Array.isArray(r.json.workflow.states), "workflow.states present");
});

// --- POST /api/move : valid PO move + persistence ---------------------------

test("POST /api/move valid PO uat->done -> 200 {ok:true}, persisted", async () => {
  const before = findTask(readData(), "EP-1-T2");
  assert.equal(before.status, "uat", "precondition: EP-1-T2 starts in uat");

  const r = await postMove({ id: "EP-1-T2", to: "done", by: "po" });
  assert.equal(r.status, 200);
  assert.equal(r.json.ok, true);
  assert.ok(r.json.task, "response includes task");
  assert.equal(r.json.task.status, "done");

  // Persisted on disk.
  const onDisk = findTask(readData(), "EP-1-T2");
  assert.equal(onDisk.status, "done", "status persisted to BOARD_FILE");

  // Persisted as seen through the API too.
  const board = await getJSON("/api/board");
  assert.equal(findTask(board.json, "EP-1-T2").status, "done");
});

// --- POST /api/move : illegal move (wrong role) -----------------------------

test("POST illegal move (wrong role engineer uat->done) -> 409, data UNCHANGED", async () => {
  // LP-1-T2 is in uat; only `po` may push to done. engineer must be rejected.
  const before = findTask(readData(), "LP-1-T2");
  assert.equal(before.status, "uat", "precondition: LP-1-T2 in uat");
  const historyBefore = JSON.stringify(before.history || null);

  const r = await postMove({ id: "LP-1-T2", to: "done", by: "engineer" });
  assert.equal(r.status, 409);
  assert.equal(r.json.ok, false);
  assert.ok(r.json.error, "error message present");

  // Data must be untouched.
  const after = findTask(readData(), "LP-1-T2");
  assert.equal(after.status, "uat", "status unchanged after rejected move");
  assert.equal(
    JSON.stringify(after.history || null),
    historyBefore,
    "history unchanged after rejected move"
  );
});

test("POST illegal move (non-existent transition done->backlog) -> 409", async () => {
  // EP-1-T1 is done; there is no done->* transition for any role.
  const before = findTask(readData(), "EP-1-T1");
  assert.equal(before.status, "done");
  const r = await postMove({ id: "EP-1-T1", to: "backlog", by: "po" });
  assert.equal(r.status, 409);
  assert.equal(r.json.ok, false);
  assert.equal(findTask(readData(), "EP-1-T1").status, "done", "unchanged");
});

// --- POST /api/move : bad input ---------------------------------------------

test("POST unknown id -> 404 {ok:false}", async () => {
  const r = await postMove({ id: "NOPE-999", to: "done", by: "po" });
  assert.equal(r.status, 404);
  assert.equal(r.json.ok, false);
  assert.ok(r.json.error);
});

test("POST malformed JSON body -> 400 {ok:false}", async () => {
  const r = await postMove(null, "{ this is : not json ");
  assert.equal(r.status, 400);
  assert.ok(r.json && r.json.ok === false, "400 returns {ok:false}");
});

test("POST empty body -> 400", async () => {
  const r = await postMove(null, "");
  assert.equal(r.status, 400);
});

test("POST missing fields (no `by`) -> 400", async () => {
  const r = await postMove({ id: "EP-1-T3", to: "uat" });
  assert.equal(r.status, 400);
  assert.equal(r.json.ok, false);
});

test("POST missing fields (no `to`) -> 400", async () => {
  const r = await postMove({ id: "EP-1-T3", by: "qa" });
  assert.equal(r.status, 400);
  assert.equal(r.json.ok, false);
});

test("POST missing fields (no `id`) -> 400", async () => {
  const r = await postMove({ to: "uat", by: "qa" });
  assert.equal(r.status, 400);
  assert.equal(r.json.ok, false);
});

// --- POST /api/move : test->uat requires testsPass --------------------------

test("test->uat WITHOUT testsPass -> 409, unchanged", async () => {
  // LP-1-T3 is in test, role qa. Missing testsPass must be rejected.
  const before = findTask(readData(), "LP-1-T3");
  assert.equal(before.status, "test");
  const r = await postMove({ id: "LP-1-T3", to: "uat", by: "qa" });
  assert.equal(r.status, 409);
  assert.equal(r.json.ok, false);
  assert.equal(findTask(readData(), "LP-1-T3").status, "test", "unchanged");
});

test("test->uat WITH testsPass:true -> 200, persisted", async () => {
  // EP-1-T3 is in test, role qa, with testsPass true.
  const before = findTask(readData(), "EP-1-T3");
  assert.equal(before.status, "test");
  const r = await postMove({ id: "EP-1-T3", to: "uat", by: "qa", testsPass: true });
  assert.equal(r.status, 200);
  assert.equal(r.json.ok, true);
  assert.equal(r.json.task.status, "uat");
  assert.equal(findTask(readData(), "EP-1-T3").status, "uat", "persisted");
});

// --- Static files -----------------------------------------------------------

test("GET / -> 200 text/html", async () => {
  const r = await request({ path: "/" });
  assert.equal(r.status, 200);
  assert.match(String(r.headers["content-type"]), /text\/html/);
  assert.ok(r.body.length > 0);
});

test("GET /board.css -> 200 text/css", async () => {
  const r = await request({ path: "/board.css" });
  assert.equal(r.status, 200);
  assert.match(String(r.headers["content-type"]), /text\/css/);
});

test("GET unknown path -> 404", async () => {
  const r = await request({ path: "/no-such-file.xyz" });
  assert.equal(r.status, 404);
});

test("path traversal /../server.js does NOT return server.js", async () => {
  const r = await request({ path: "/../server.js" });
  assert.notEqual(r.status, 200, "traversal must not succeed");
  assert.ok(!/zero-dependency Node http server/.test(r.body), "must not leak server.js source");
});

test("path traversal /..%2fserver.js does NOT return server.js", async () => {
  const r = await request({ path: "/..%2fserver.js" });
  assert.notEqual(r.status, 200, "encoded traversal must not succeed");
  assert.ok(!/zero-dependency Node http server/.test(r.body), "must not leak server.js source");
});

test("path traversal /..%2f..%2fboard-data.json does NOT escape public/", async () => {
  const r = await request({ path: "/..%2f..%2fboard-data.json" });
  assert.notEqual(r.status, 200, "must not serve files outside public/");
});

// --- Method handling --------------------------------------------------------

test("DELETE /api/move -> not 200 (unsupported method)", async () => {
  const r = await request({ method: "DELETE", path: "/api/move" });
  assert.notEqual(r.status, 200);
});

// --- SSE --------------------------------------------------------------------

test("GET /api/stream -> text/event-stream", async () => {
  await new Promise((resolve, reject) => {
    const req = http.request(BASE + "/api/stream", { method: "GET" }, (res) => {
      try {
        assert.equal(res.statusCode, 200);
        assert.match(String(res.headers["content-type"]), /text\/event-stream/);
      } catch (e) {
        req.destroy();
        return reject(e);
      }
      req.destroy(); // close the long-lived stream
      resolve();
    });
    req.on("error", (e) => {
      // destroy() triggers an error we can ignore once resolved.
      if (!/socket hang up|aborted|ECONNRESET/i.test(String(e.message))) reject(e);
    });
    req.end();
  });
});

test("SSE emits `update` event after a move (within timeout)", async () => {
  // Open a stream, register a data collector, then trigger a real move and
  // assert an `event: update` frame arrives before the deadline.
  const got = await new Promise((resolve, reject) => {
    let buf = "";
    let settled = false;
    const finish = (val) => {
      if (settled) return;
      settled = true;
      try { req.destroy(); } catch (_) { /* ignore */ }
      clearTimeout(timer);
      resolve(val);
    };

    const req = http.request(BASE + "/api/stream", { method: "GET" }, (res) => {
      res.setEncoding("utf8");
      res.on("data", (c) => {
        buf += c;
        if (/event:\s*update/.test(buf)) finish(true);
      });
    });
    req.on("error", (e) => {
      if (!settled && !/socket hang up|aborted|ECONNRESET/i.test(String(e.message))) {
        reject(e);
      }
    });
    req.end();

    const timer = setTimeout(() => finish(false), 4000);

    // Give the SSE handshake a moment, then trigger a state change that the
    // file watcher should pick up. EP-2-T1 is in backlog; engineer moves it
    // to progress (a valid transition) which saves BOARD_FILE.
    setTimeout(() => {
      postMove({ id: "EP-2-T1", to: "progress", by: "engineer" }).catch(() => {});
    }, 300);
  });

  assert.equal(got, true, "expected an SSE `update` event after a board mutation");
});
