/*
 * e2e.test.js — end-to-end UAT acceptance gate for the Team Board.
 *
 * Walks the scenarios a Product Owner (who does NOT read code) would perform by
 * hand, exercising the REAL product end-to-end: every test spawns the actual
 * server.js child process against its OWN fresh temp copy of board-data.json on
 * its OWN random high port, then drives it over Node's built-in http client +
 * an SSE connection.
 *
 * Isolation: because each PO scenario is destructive (it moves tasks off uat),
 * every test gets a dedicated server + temp BOARD_FILE under os.tmpdir(). This
 * keeps the tests independent under node:test's default concurrency and means
 * the real board-data.json is NEVER mutated. Each child is always killed in the
 * test's `finally`.
 *
 * Maps to spec-team-board.md Acceptance Criteria:
 *   - Duyệt → Xong            : uat -> done by po (200, leaves uat, lands in done)
 *   - Trả lại → Chờ làm/Reject: uat -> backlog by po (200, status backlog,
 *                               reject:true, history flag:"reject")
 *   - Chỉ PO mới được duyệt    : uat -> done by engineer/qa -> 409
 *   - Số việc chờ duyệt        : #pending = count of uat tasks; -1 after a Duyệt
 *   - Cập nhật gần thời gian thực: /api/stream emits `update` after a move
 *   - Giao diện sống            : GET / serves HTML linking board.css +
 *                               board-client.js; GET /board-client.js -> 200
 *
 * Run:  cd testgent && node --test test/e2e.test.js
 */
"use strict";

const { test } = require("node:test");
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

// --- helpers ----------------------------------------------------------------

// Fresh temp copy of board-data.json so the real file is never touched.
function freshData() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "board-e2e-test-"));
  const tmp = path.join(dir, "board-data.json");
  fs.copyFileSync(DATA_FILE, tmp);
  return tmp;
}

// Pick a random high port. Each test gets its own to avoid collisions even when
// node:test runs the tests concurrently.
function randomPort() {
  return 20000 + Math.floor(Math.random() * 20000);
}

// Minimal promise-based HTTP request over the built-in client, against `base`.
function request(base, opts) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      base + opts.path,
      { method: opts.method || "GET", headers: opts.headers || {} },
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

function getJSON(base, p) {
  return request(base, { path: p }).then((r) => ({
    status: r.status,
    headers: r.headers,
    json: JSON.parse(r.body),
  }));
}

function postMove(base, obj) {
  return request(base, {
    method: "POST",
    path: "/api/move",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(obj),
  }).then((r) => {
    let json = null;
    try {
      json = JSON.parse(r.body);
    } catch (_) {
      /* error paths may not be JSON */
    }
    return { status: r.status, headers: r.headers, body: r.body, json };
  });
}

function findTask(data, id) {
  for (const p of data.projects)
    for (const e of p.epics)
      for (const t of e.tasks) if (t.id === id) return t;
  return null;
}

// Locate the project that owns task `id` (for the pending-count assertion).
function projectOf(data, id) {
  for (const p of data.projects)
    for (const e of p.epics)
      for (const t of e.tasks) if (t.id === id) return p;
  return null;
}

// Count uat tasks across a whole project — this is exactly what the UI's
// #pending corner computes (board-client.js: allTasks().filter status === uat).
function pendingCount(project) {
  let n = 0;
  for (const e of project.epics)
    for (const t of e.tasks) if (t.status === "uat") n++;
  return n;
}

// Find a task currently in `uat` (via the live API). Returns the task id.
async function pickUatTask(base) {
  const { json } = await getJSON(base, "/api/board");
  for (const p of json.projects)
    for (const e of p.epics)
      for (const t of e.tasks) if (t.status === "uat") return t.id;
  return null;
}

// Spawn the REAL server on its own port + temp data file, wait until it answers
// GET /api/board, run `fn(ctx)`, then ALWAYS kill the child. `ctx` exposes the
// base URL and the temp file path (for on-disk persistence assertions).
async function withServer(fn) {
  const tmpFile = freshData();
  const port = randomPort();
  const base = "http://127.0.0.1:" + port;
  const child = spawn("node", [SERVER_JS], {
    cwd: TESTGENT_DIR,
    env: { ...process.env, PORT: String(port), BOARD_FILE: tmpFile },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stderr.on("data", (d) => {
    process.stderr.write("[server stderr] " + d);
  });

  const readData = () => JSON.parse(fs.readFileSync(tmpFile, "utf8"));
  const ctx = { base, tmpFile, readData };

  try {
    // Poll until the real server is ready.
    const deadline = Date.now() + 8000;
    for (;;) {
      try {
        const r = await request(base, { path: "/api/board" });
        if (r.status === 200) break;
      } catch (_) {
        /* not up yet */
      }
      if (Date.now() > deadline) throw new Error("server not ready in 8000ms");
      await new Promise((res) => setTimeout(res, 50));
    }
    return await fn(ctx);
  } finally {
    if (child && !child.killed) {
      try {
        child.kill("SIGKILL");
      } catch (_) {
        /* already gone */
      }
    }
  }
}

// === PO acceptance scenarios ================================================

// AC: "Khi bấm Duyệt → task chuyển sang Xong." (uat -> done by po)
test("Duyệt → Xong: PO approves a UAT task; it lands in done and leaves uat", () =>
  withServer(async ({ base }) => {
    const id = await pickUatTask(base);
    assert.ok(id, "precondition: at least one task in uat");

    const r = await postMove(base, { id, to: "done", by: "po" });
    assert.equal(r.status, 200, "PO uat->done must be accepted");
    assert.equal(r.json && r.json.ok, true);
    assert.equal(r.json.task.status, "done");

    // The board the PO would see now shows it in `done`, no longer in `uat`.
    const board = (await getJSON(base, "/api/board")).json;
    const t = findTask(board, id);
    assert.equal(t.status, "done", "task is in the Xong column");
    assert.notEqual(t.status, "uat", "task has left the UAT column");
  }));

// AC: "Khi bấm Trả lại → task về Chờ làm, gắn nhãn Reject."
test("Trả lại → Chờ làm + Reject: PO rejects a UAT task back to backlog with reject tag + history", () =>
  withServer(async ({ base }) => {
    const id = await pickUatTask(base);
    assert.ok(id, "precondition: at least one task in uat");

    const r = await postMove(base, { id, to: "backlog", by: "po" });
    assert.equal(r.status, 200, "PO uat->backlog (reject) must be accepted");
    assert.equal(r.json && r.json.ok, true);

    const board = (await getJSON(base, "/api/board")).json;
    const t = findTask(board, id);
    assert.equal(t.status, "backlog", "task returned to Chờ làm");
    assert.equal(t.reject, true, "card would show the Reject tag");

    const last = t.history[t.history.length - 1];
    assert.equal(last.flag, "reject", "history records a reject flag");
    assert.equal(last.to, "backlog");
    assert.equal(last.by, "po");
  }));

// AC: "Chỉ PO mới được uat→done." Only the PO sees Duyệt; the server enforces it.
test("Chỉ PO duyệt: engineer/qa attempting uat→done are rejected (409)", () =>
  withServer(async ({ base }) => {
    const id = await pickUatTask(base);
    assert.ok(id, "precondition: at least one task in uat");

    for (const role of ["engineer", "qa"]) {
      const r = await postMove(base, { id, to: "done", by: role });
      assert.equal(r.status, 409, role + " must NOT be allowed to approve (409)");
      assert.equal(r.json && r.json.ok, false);
    }

    // Wrong-role attempts must not have moved the task off uat.
    const board = (await getJSON(base, "/api/board")).json;
    assert.equal(findTask(board, id).status, "uat", "task still in UAT after blocked attempts");
  }));

// AC: "Góc trên hiển thị số việc đang chờ bạn duyệt của dự án đang chọn."
test("Số việc chờ duyệt: #pending equals project uat-count and drops by one after a Duyệt", () =>
  withServer(async ({ base, readData }) => {
    const id = await pickUatTask(base);
    assert.ok(id, "precondition: at least one task in uat");

    const before = readData();
    const project = projectOf(before, id);
    const beforeCount = pendingCount(project);
    assert.ok(beforeCount >= 1, "selected project has at least one pending task");

    const r = await postMove(base, { id, to: "done", by: "po" });
    assert.equal(r.status, 200);

    const after = readData();
    const afterCount = pendingCount(projectOf(after, id));
    assert.equal(afterCount, beforeCount - 1, "pending count decreases by exactly one after a Duyệt");
  }));

// AC: "Bảng phản ánh đúng (cập nhật gần thời gian thực, không phải reload tay)."
test("Cập nhật gần thời gian thực: /api/stream emits an `update` event after a move", () =>
  withServer(async ({ base }) => {
    const id = await pickUatTask(base);
    assert.ok(id, "precondition: at least one task in uat");

    // Connect to the SSE stream first, then trigger a move and await `update`.
    const update = new Promise((resolve, reject) => {
      const req = http.request(
        base + "/api/stream",
        { method: "GET", headers: { Accept: "text/event-stream" } },
        (res) => {
          assert.equal(res.statusCode, 200, "SSE handshake returns 200");
          let buf = "";
          let done = false;
          const timer = setTimeout(() => {
            if (!done) {
              done = true;
              try { req.destroy(); } catch (_) { /* ignore */ }
              reject(new Error("no `update` event within 5000ms"));
            }
          }, 5000);
          res.setEncoding("utf8");
          res.on("data", (chunk) => {
            buf += chunk;
            if (/event:\s*update/.test(buf) && !done) {
              done = true;
              clearTimeout(timer);
              try { req.destroy(); } catch (_) { /* ignore */ }
              resolve();
            }
          });
        }
      );
      req.on("error", reject);
      req.end();
    });

    // Give the stream a moment to register before triggering the change.
    await new Promise((res) => setTimeout(res, 200));
    const r = await postMove(base, { id, to: "done", by: "po" });
    assert.equal(r.status, 200, "the move that should trigger the update succeeded");

    // The watcher debounces ~100ms; the promise above tolerates that.
    await update;
  }));

// AC: "Khi mở bảng → giao diện sống" (the live UI actually loads).
test("Giao diện sống: / serves HTML linking board.css + board-client.js, and the script loads", () =>
  withServer(async ({ base }) => {
    const root = await request(base, { path: "/" });
    assert.equal(root.status, 200);
    assert.match(String(root.headers["content-type"]), /text\/html/);
    assert.match(root.body, /board\.css/, "index links board.css");
    assert.match(root.body, /board-client\.js/, "index links board-client.js");

    const script = await request(base, { path: "/board-client.js" });
    assert.equal(script.status, 200, "board-client.js is served");
    assert.match(String(script.headers["content-type"]), /javascript/);
  }));
