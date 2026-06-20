/*
 * remote.test.js — unit + integration tests for lib/remote.js and
 * board.js remote mode.
 *
 * All lib/remote.js tests use an injected fake fetch — NO real network calls.
 *
 * board.js-level tests use a tiny in-process stub HTTP server
 * (http.createServer) bound to 127.0.0.1:0 so the OS picks a free port.
 * The CLI child process is launched with the async execFile (not execFileSync)
 * so the parent's event loop stays free to serve HTTP requests while the child
 * is running. The server is closed after each test.
 *
 * Run:  node --test test/remote.test.js
 */
"use strict";

const { test, describe } = require("node:test");
const assert = require("node:assert");
const http = require("node:http");
const { execFile, execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const TESTGENT_DIR = path.resolve(__dirname, "..");
const BOARD_JS = path.join(TESTGENT_DIR, "board.js");
const DATA_FILE = path.join(TESTGENT_DIR, "board-data.json");
const { isRemoteConfigured, resolveConfig, remoteMove } = require("../lib/remote.js");

// ─── helpers ────────────────────────────────────────────────────────────────

function freshData() {
  const tmp = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "board-remote-test-")),
    "board-data.json"
  );
  fs.copyFileSync(DATA_FILE, tmp);
  return tmp;
}

/**
 * Build a fake fetch function.
 * routeMap is an array of { match(url, init), handler(url, init) } objects.
 * handler must return a fake Response with { ok, status, headers.get, json }.
 */
function makeFakeFetch(routeMap) {
  return async function fakeFetch(url, init) {
    for (const { match, handler } of routeMap) {
      if (match(url, init)) return handler(url, init);
    }
    throw new Error("fakeFetch: no route for " + url);
  };
}

/** Build a minimal fake Response compatible with remoteMove. */
function fakeResponse({ status, body, setCookie }) {
  const ok = status >= 200 && status < 300;
  const headersMap = new Map();
  if (setCookie) headersMap.set("set-cookie", setCookie);
  return {
    ok,
    status,
    headers: {
      get: (name) => headersMap.get(name.toLowerCase()) || null,
    },
    json: async () => (typeof body === "string" ? JSON.parse(body) : body),
  };
}

// ─── isRemoteConfigured ───────────────────────────────────────────────────

describe("isRemoteConfigured", () => {
  test("returns false when neither flags nor env set", () => {
    assert.strictEqual(isRemoteConfigured({ env: {} }), false);
  });

  test("returns false when URL present but password missing", () => {
    assert.strictEqual(
      isRemoteConfigured({ remote: "https://example.com", env: {} }),
      false
    );
  });

  test("returns false when password present but URL missing", () => {
    assert.strictEqual(
      isRemoteConfigured({ password: "secret", env: {} }),
      false
    );
  });

  test("returns true with both flags", () => {
    assert.strictEqual(
      isRemoteConfigured({ remote: "https://example.com", password: "pw", env: {} }),
      true
    );
  });

  test("returns true with env BOARD_REMOTE + BOARD_PASSWORD", () => {
    assert.strictEqual(
      isRemoteConfigured({ env: { BOARD_REMOTE: "https://x.com", BOARD_PASSWORD: "pw" } }),
      true
    );
  });

  test("flags override env — flag remote + env password", () => {
    assert.strictEqual(
      isRemoteConfigured({
        remote: "https://flag.example.com",
        env: { BOARD_PASSWORD: "env-pw" },
      }),
      true
    );
  });

  test("flags override env — flag password + env remote", () => {
    assert.strictEqual(
      isRemoteConfigured({
        password: "flag-pw",
        env: { BOARD_REMOTE: "https://env.example.com" },
      }),
      true
    );
  });

  test("flag empty string does NOT override env (falls through to env)", () => {
    // An empty string flag is treated as falsy and env takes over.
    assert.strictEqual(
      isRemoteConfigured({
        remote: "",
        password: "",
        env: { BOARD_REMOTE: "https://env.example.com", BOARD_PASSWORD: "pw" },
      }),
      true
    );
  });
});

// ─── resolveConfig ────────────────────────────────────────────────────────

describe("resolveConfig", () => {
  test("flags take precedence over env", () => {
    const cfg = resolveConfig({
      remote: "https://flag.example.com",
      password: "flag-pw",
      env: { BOARD_REMOTE: "https://env.example.com", BOARD_PASSWORD: "env-pw" },
    });
    assert.strictEqual(cfg.url, "https://flag.example.com");
    assert.strictEqual(cfg.password, "flag-pw");
  });

  test("falls back to env when flags absent", () => {
    const cfg = resolveConfig({
      env: { BOARD_REMOTE: "https://env.example.com", BOARD_PASSWORD: "env-pw" },
    });
    assert.strictEqual(cfg.url, "https://env.example.com");
    assert.strictEqual(cfg.password, "env-pw");
  });
});

// ─── remoteMove ──────────────────────────────────────────────────────────

describe("remoteMove — success path", () => {
  test("logs in and sends correct move body, returns ok", async () => {
    const loginCalls = [];
    const moveCalls = [];

    const fakeFetch = makeFakeFetch([
      {
        match: (url) => url.endsWith("/api/login"),
        handler: (url, init) => {
          loginCalls.push({ url, body: JSON.parse(init.body) });
          return fakeResponse({
            status: 200,
            body: { ok: true },
            setCookie: "board_token=abc123; Path=/; HttpOnly",
          });
        },
      },
      {
        match: (url) => url.endsWith("/api/move"),
        handler: (url, init) => {
          moveCalls.push({ url, headers: init.headers, body: JSON.parse(init.body) });
          return fakeResponse({ status: 200, body: { ok: true, id: "EP-1-T4", to: "test" } });
        },
      },
    ]);

    const result = await remoteMove({
      url: "https://example.vercel.app",
      password: "secret-pw",
      id: "EP-1-T4",
      to: "test",
      by: "engineer",
      testsPass: false,
      fetch: fakeFetch,
    });

    // Result is ok.
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.status, 200);

    // Login was called with the correct password.
    assert.strictEqual(loginCalls.length, 1, "login called once");
    assert.strictEqual(loginCalls[0].body.password, "secret-pw");

    // Move was called with the correct payload.
    assert.strictEqual(moveCalls.length, 1, "move called once");
    assert.strictEqual(moveCalls[0].body.id, "EP-1-T4");
    assert.strictEqual(moveCalls[0].body.to, "test");
    assert.strictEqual(moveCalls[0].body.by, "engineer");
    assert.strictEqual(moveCalls[0].body.testsPass, false);

    // Move was called with the session cookie using the correct cookie name.
    assert.ok(
      moveCalls[0].headers.Cookie && moveCalls[0].headers.Cookie.includes("board_token=abc123"),
      "Cookie header must carry board_token from login (correct cookie name)"
    );
  });

  test("testsPass: true is forwarded", async () => {
    const moveCalls = [];
    const fakeFetch = makeFakeFetch([
      {
        match: (url) => url.endsWith("/api/login"),
        handler: () =>
          fakeResponse({ status: 200, body: { ok: true }, setCookie: "board_token=t; Path=/" }),
      },
      {
        match: (url) => url.endsWith("/api/move"),
        handler: (_url, init) => {
          moveCalls.push(JSON.parse(init.body));
          return fakeResponse({ status: 200, body: { ok: true } });
        },
      },
    ]);

    await remoteMove({
      url: "https://example.vercel.app",
      password: "pw",
      id: "EP-1-T3",
      to: "uat",
      by: "qa",
      testsPass: true,
      fetch: fakeFetch,
    });

    assert.strictEqual(moveCalls[0].testsPass, true);
  });

  test("trailing slash in url is stripped", async () => {
    const calls = [];
    const fakeFetch = makeFakeFetch([
      {
        match: () => true,
        handler: (url) => {
          calls.push(url);
          if (url.includes("/api/login"))
            return fakeResponse({ status: 200, body: {}, setCookie: "board_token=t; Path=/" });
          return fakeResponse({ status: 200, body: { ok: true } });
        },
      },
    ]);

    await remoteMove({
      url: "https://example.vercel.app/",
      password: "pw",
      id: "T1",
      to: "progress",
      by: "engineer",
      fetch: fakeFetch,
    });

    assert.ok(
      calls.some((u) => u === "https://example.vercel.app/api/login"),
      "login URL must not have double slash"
    );
    assert.ok(
      calls.some((u) => u === "https://example.vercel.app/api/move"),
      "move URL must not have double slash"
    );
  });
});

describe("remoteMove — failure paths", () => {
  test("401 from login surfaces as error", async () => {
    const fakeFetch = makeFakeFetch([
      {
        match: () => true,
        handler: () => fakeResponse({ status: 401, body: { error: "Unauthorized" } }),
      },
    ]);

    const result = await remoteMove({
      url: "https://example.vercel.app",
      password: "wrong-password",
      id: "EP-1-T4",
      to: "test",
      by: "engineer",
      fetch: fakeFetch,
    });

    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.status, 401);
    assert.ok(result.error, "error field must be set");
    assert.match(result.error, /401|Unauthorized|Login failed/);
  });

  test("409 from move (invalid state transition) surfaced as error", async () => {
    const fakeFetch = makeFakeFetch([
      {
        match: (url) => url.endsWith("/api/login"),
        handler: () =>
          fakeResponse({ status: 200, body: { ok: true }, setCookie: "board_token=t; Path=/" }),
      },
      {
        match: (url) => url.endsWith("/api/move"),
        handler: () =>
          fakeResponse({
            status: 409,
            body: { error: "Invalid move: uat → done by engineer" },
          }),
      },
    ]);

    const result = await remoteMove({
      url: "https://example.vercel.app",
      password: "pw",
      id: "EP-1-T2",
      to: "done",
      by: "engineer",
      fetch: fakeFetch,
    });

    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.status, 409);
    assert.ok(result.error, "error field must be set");
    assert.match(result.error, /Invalid move|engineer/);
  });

  test("network error during login is surfaced", async () => {
    const fakeFetch = async () => {
      throw new Error("ECONNREFUSED");
    };

    const result = await remoteMove({
      url: "https://example.vercel.app",
      password: "pw",
      id: "T1",
      to: "progress",
      by: "engineer",
      fetch: fakeFetch,
    });

    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.status, 0);
    assert.match(result.error, /ECONNREFUSED|Network error/);
  });

  test("network error during move is surfaced", async () => {
    const fakeFetch = async (url) => {
      if (url.endsWith("/api/login"))
        return fakeResponse({ status: 200, body: {}, setCookie: "board_token=t; Path=/" });
      throw new Error("ETIMEDOUT");
    };

    const result = await remoteMove({
      url: "https://example.vercel.app",
      password: "pw",
      id: "T1",
      to: "progress",
      by: "engineer",
      fetch: fakeFetch,
    });

    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.status, 0);
    assert.match(result.error, /ETIMEDOUT|Network error/);
  });
});

// ─── board.js-level tests via stub server ────────────────────────────────

/**
 * Spin up a minimal HTTP stub server on 127.0.0.1:0 (OS-assigned port).
 * Returns a promise resolving to { url, loginRequests, moveRequests, close }.
 */
function startStubServer({ loginStatus, loginBody, loginCookie, moveStatus, moveBody }) {
  const loginRequests = [];
  const moveRequests = [];

  const server = http.createServer((req, res) => {
    let rawBody = "";
    req.on("data", (chunk) => { rawBody += chunk; });
    req.on("end", () => {
      let parsedBody = null;
      try { parsedBody = JSON.parse(rawBody); } catch (_) { /* ignore */ }

      if (req.url === "/api/login" && req.method === "POST") {
        loginRequests.push({ headers: req.headers, body: parsedBody });
        if (loginCookie) res.setHeader("Set-Cookie", loginCookie);
        res.writeHead(loginStatus, { "Content-Type": "application/json" });
        res.end(JSON.stringify(loginBody));
        return;
      }

      if (req.url === "/api/move" && req.method === "POST") {
        moveRequests.push({ headers: req.headers, body: parsedBody });
        res.writeHead(moveStatus, { "Content-Type": "application/json" });
        res.end(JSON.stringify(moveBody));
        return;
      }

      res.writeHead(404);
      res.end("Not found");
    });
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      const url = "http://127.0.0.1:" + port;
      resolve({
        url,
        loginRequests,
        moveRequests,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

/**
 * Run the CLI asynchronously (non-blocking) — required when there is a
 * stub HTTP server in the same process, because execFileSync would block
 * the event loop and prevent the server from handling incoming requests.
 *
 * Returns a promise resolving to { code, stdout, stderr }.
 */
function runCLIAsync(args, { env } = {}) {
  return new Promise((resolve) => {
    execFile(
      "node",
      [BOARD_JS, ...args],
      {
        cwd: TESTGENT_DIR,
        encoding: "utf8",
        env: { ...process.env, ...env },
      },
      (err, stdout, stderr) => {
        resolve({
          code: err ? (typeof err.code === "number" ? err.code : 1) : 0,
          stdout: stdout || "",
          stderr: stderr || "",
        });
      }
    );
  });
}

/**
 * Synchronous CLI runner for tests that do NOT use a stub server (no event
 * loop contention).  Reuses the same pattern as cli.test.js.
 */
function runCLI(args, { env } = {}) {
  try {
    const stdout = execFileSync("node", [BOARD_JS, ...args], {
      cwd: TESTGENT_DIR,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ...env },
    });
    return { code: 0, stdout, stderr: "" };
  } catch (err) {
    return {
      code: typeof err.status === "number" ? err.status : 1,
      stdout: err.stdout ? err.stdout.toString() : "",
      stderr: err.stderr ? err.stderr.toString() : "",
    };
  }
}

describe("board.js move — remote mode (stub server)", () => {
  test("remote env configured: move hits remote path and prints success", async () => {
    const stub = await startStubServer({
      loginStatus: 200,
      loginBody: { ok: true },
      loginCookie: "board_token=stubtoken; Path=/; HttpOnly",
      moveStatus: 200,
      moveBody: { ok: true },
    });

    try {
      const res = await runCLIAsync(
        ["move", "EP-1-T4", "test", "--by", "engineer"],
        { env: { BOARD_REMOTE: stub.url, BOARD_PASSWORD: "testpw" } }
      );

      assert.strictEqual(res.code, 0, "expected exit 0, stderr: " + res.stderr);
      assert.match(res.stdout, /✓/, "stdout must have success marker");
      assert.match(res.stdout, /remote/, "stdout must indicate remote mode");

      // The stub received a login request with the password.
      assert.strictEqual(stub.loginRequests.length, 1, "login called once");
      assert.strictEqual(stub.loginRequests[0].body.password, "testpw");

      // The stub received a move request.
      assert.strictEqual(stub.moveRequests.length, 1, "move called once");
      assert.strictEqual(stub.moveRequests[0].body.id, "EP-1-T4");
      assert.strictEqual(stub.moveRequests[0].body.to, "test");
      assert.strictEqual(stub.moveRequests[0].body.by, "engineer");

      // The session cookie was forwarded.
      const cookieHeader = stub.moveRequests[0].headers.cookie || "";
      assert.ok(cookieHeader.includes("stubtoken"), "move request must carry session token");
    } finally {
      await stub.close();
    }
  });

  test("remote flags configured (--remote / --password): move hits remote path", async () => {
    const stub = await startStubServer({
      loginStatus: 200,
      loginBody: { ok: true },
      loginCookie: "board_token=flagtoken; Path=/",
      moveStatus: 200,
      moveBody: { ok: true },
    });

    try {
      const res = await runCLIAsync([
        "move", "EP-1-T4", "test", "--by", "engineer",
        "--remote", stub.url, "--password", "flagpw",
      ]);

      assert.strictEqual(res.code, 0, "expected exit 0, stderr: " + res.stderr);
      assert.match(res.stdout, /✓/);
      assert.strictEqual(stub.loginRequests[0].body.password, "flagpw");
    } finally {
      await stub.close();
    }
  });

  test("remote 401 → CLI exits non-zero with error message", async () => {
    const stub = await startStubServer({
      loginStatus: 401,
      loginBody: { error: "Unauthorized" },
      loginCookie: null,
      moveStatus: 200,
      moveBody: { ok: true },
    });

    try {
      const res = await runCLIAsync(
        ["move", "EP-1-T4", "test", "--by", "engineer"],
        { env: { BOARD_REMOTE: stub.url, BOARD_PASSWORD: "wrongpw" } }
      );

      assert.notStrictEqual(res.code, 0, "must exit non-zero on 401");
      assert.match(res.stderr, /✗/, "error marker on stderr");
    } finally {
      await stub.close();
    }
  });

  test("remote 409 (invalid move) → CLI exits non-zero", async () => {
    const stub = await startStubServer({
      loginStatus: 200,
      loginBody: { ok: true },
      loginCookie: "board_token=t; Path=/",
      moveStatus: 409,
      moveBody: { error: "Invalid move" },
    });

    try {
      const res = await runCLIAsync(
        ["move", "EP-1-T2", "done", "--by", "engineer"],
        { env: { BOARD_REMOTE: stub.url, BOARD_PASSWORD: "pw" } }
      );

      assert.notStrictEqual(res.code, 0, "must exit non-zero on 409");
      assert.match(res.stderr, /✗/);
    } finally {
      await stub.close();
    }
  });

  test("--tests-pass flag is forwarded to remote", async () => {
    const stub = await startStubServer({
      loginStatus: 200,
      loginBody: { ok: true },
      loginCookie: "board_token=t; Path=/",
      moveStatus: 200,
      moveBody: { ok: true },
    });

    try {
      const res = await runCLIAsync(
        ["move", "EP-1-T3", "uat", "--by", "qa", "--tests-pass"],
        { env: { BOARD_REMOTE: stub.url, BOARD_PASSWORD: "pw" } }
      );

      assert.strictEqual(res.code, 0, "expected exit 0, stderr: " + res.stderr);
      assert.strictEqual(
        stub.moveRequests[0].body.testsPass,
        true,
        "testsPass must be true in remote payload"
      );
    } finally {
      await stub.close();
    }
  });
});

describe("board.js move — local mode (no remote config)", () => {
  test("without remote config, move still writes the local --file", () => {
    const tmp = freshData();
    // No BOARD_REMOTE / BOARD_PASSWORD in env, no --remote flag.
    // Explicitly unset those env vars to be safe.
    const res = runCLI(["move", "EP-1-T4", "test", "--by", "engineer", "--file", tmp], {
      env: { BOARD_REMOTE: "", BOARD_PASSWORD: "" },
    });

    assert.strictEqual(res.code, 0, "expected exit 0, stderr: " + res.stderr);
    assert.match(res.stdout, /✓/);
    assert.match(res.stdout, /progress\s*→\s*test/);

    // File was actually updated.
    const data = JSON.parse(fs.readFileSync(tmp, "utf8"));
    let task = null;
    for (const p of data.projects)
      for (const e of p.epics)
        for (const t of e.tasks) if (t.id === "EP-1-T4") task = t;
    assert.strictEqual(task.status, "test", "task status must be updated in local file");
  });

  test("local mode: illegal move still exits non-zero and leaves file unchanged", () => {
    const tmp = freshData();
    const original = fs.readFileSync(tmp, "utf8");

    const res = runCLI(
      ["move", "EP-1-T2", "done", "--by", "engineer", "--file", tmp],
      { env: { BOARD_REMOTE: "", BOARD_PASSWORD: "" } }
    );

    assert.notStrictEqual(res.code, 0);
    assert.match(res.stderr, /✗/);
    assert.strictEqual(fs.readFileSync(tmp, "utf8"), original, "file must be unchanged");
  });
});

// ─── reviewer edge-case tests ────────────────────────────────────────────
//
// Added by reviewer. These cover gaps the engineer's suite did not exercise:
// a value-less (boolean true) flag, a successful login that returns no cookie,
// login OK but move 401 (cookie expired between the two calls), generic 500
// server errors, non-JSON error bodies, proof that remote config does NOT leak
// into other CLI commands (list/show/help — guards the top-level `return`), and
// proof that a remote move leaves the local board-data.json byte-for-byte.

describe("reviewer: isRemoteConfigured / resolveConfig edge cases", () => {
  test("value-less flag (true) does not count as configured, no env", () => {
    assert.strictEqual(
      isRemoteConfigured({ remote: true, password: true, env: {} }),
      false
    );
  });

  test("value-less flag (true) falls through to env", () => {
    assert.strictEqual(
      isRemoteConfigured({
        remote: true,
        password: true,
        env: { BOARD_REMOTE: "https://env.example.com", BOARD_PASSWORD: "pw" },
      }),
      true
    );
  });

  test("resolveConfig ignores value-less flag and uses env", () => {
    const cfg = resolveConfig({
      remote: true,
      password: true,
      env: { BOARD_REMOTE: "https://env.example.com", BOARD_PASSWORD: "env-pw" },
    });
    assert.strictEqual(cfg.url, "https://env.example.com");
    assert.strictEqual(cfg.password, "env-pw");
  });

  test("whitespace-only env values are truthy (documents current behavior)", () => {
    assert.strictEqual(
      isRemoteConfigured({ env: { BOARD_REMOTE: " ", BOARD_PASSWORD: " " } }),
      true
    );
  });
});

describe("reviewer: remoteMove additional failure / edge paths", () => {
  test("login 200 but NO Set-Cookie → move still attempted, no Cookie header", async () => {
    let moveHeaders = null;
    const fakeFetch = makeFakeFetch([
      {
        match: (url) => url.endsWith("/api/login"),
        handler: () => fakeResponse({ status: 200, body: { ok: true } }),
      },
      {
        match: (url) => url.endsWith("/api/move"),
        handler: (_url, init) => {
          moveHeaders = init.headers;
          return fakeResponse({ status: 200, body: { ok: true } });
        },
      },
    ]);

    const result = await remoteMove({
      url: "https://example.vercel.app",
      password: "pw",
      id: "T1",
      to: "progress",
      by: "engineer",
      fetch: fakeFetch,
    });

    assert.strictEqual(result.ok, true);
    assert.ok(!moveHeaders.Cookie, "no Cookie header expected when login issued none");
  });

  test("login OK but move returns 401 (cookie expired) → surfaced as error", async () => {
    const fakeFetch = makeFakeFetch([
      {
        match: (url) => url.endsWith("/api/login"),
        handler: () =>
          fakeResponse({ status: 200, body: { ok: true }, setCookie: "board_token=t; Path=/" }),
      },
      {
        match: (url) => url.endsWith("/api/move"),
        handler: () => fakeResponse({ status: 401, body: { error: "Token expired" } }),
      },
    ]);

    const result = await remoteMove({
      url: "https://example.vercel.app",
      password: "pw",
      id: "T1",
      to: "progress",
      by: "engineer",
      fetch: fakeFetch,
    });

    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.status, 401);
    assert.match(result.error, /Token expired|401/);
  });

  test("move 500 server error → surfaced with non-ok and status 500", async () => {
    const fakeFetch = makeFakeFetch([
      {
        match: (url) => url.endsWith("/api/login"),
        handler: () =>
          fakeResponse({ status: 200, body: { ok: true }, setCookie: "board_token=t; Path=/" }),
      },
      {
        match: (url) => url.endsWith("/api/move"),
        handler: () => fakeResponse({ status: 500, body: { error: "KV unavailable" } }),
      },
    ]);

    const result = await remoteMove({
      url: "https://example.vercel.app",
      password: "pw",
      id: "T1",
      to: "progress",
      by: "engineer",
      fetch: fakeFetch,
    });

    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.status, 500);
    assert.match(result.error, /KV unavailable|500/);
  });

  test("login non-JSON error body does not crash; error still surfaced", async () => {
    const fakeFetch = makeFakeFetch([
      {
        match: () => true,
        handler: () => ({
          ok: false,
          status: 401,
          headers: { get: () => null },
          json: async () => { throw new Error("not json"); },
        }),
      },
    ]);

    const result = await remoteMove({
      url: "https://example.vercel.app",
      password: "pw",
      id: "T1",
      to: "progress",
      by: "engineer",
      fetch: fakeFetch,
    });

    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.status, 401);
    assert.match(result.error, /401|Login failed/);
  });
});

describe("reviewer: Set-Cookie parsing robustness (cookie name must not drift)", () => {
  // Capture the exact Cookie header remoteMove sends to /api/move for a given
  // Set-Cookie value from login. Returns the Cookie string (or undefined).
  async function cookieSentForSetCookie(setCookie) {
    let sentCookie;
    const fakeFetch = makeFakeFetch([
      {
        match: (url) => url.endsWith("/api/login"),
        handler: () => fakeResponse({ status: 200, body: { ok: true }, setCookie }),
      },
      {
        match: (url) => url.endsWith("/api/move"),
        handler: (_url, init) => {
          sentCookie = init.headers.Cookie;
          return fakeResponse({ status: 200, body: { ok: true } });
        },
      },
    ]);
    await remoteMove({
      url: "https://example.vercel.app",
      password: "pw",
      id: "T1",
      to: "progress",
      by: "engineer",
      fetch: fakeFetch,
    });
    return sentCookie;
  }

  test("reordered attributes (HttpOnly first, value last attr) still extracts value", async () => {
    const sent = await cookieSentForSetCookie(
      "board_token=val-XYZ; Max-Age=28800; Path=/; HttpOnly; Secure; SameSite=Lax"
    );
    assert.strictEqual(sent, "board_token=val-XYZ");
  });

  test("attribute substrings do not fool the parser (no 'token=' false match)", async () => {
    // A Secure/SameSite-laden cookie; the real value contains no 'token=' confusion.
    const sent = await cookieSentForSetCookie(
      "board_token=abc.def; Path=/; HttpOnly; SameSite=Strict"
    );
    // Must re-emit using the correct name and full value (value has a dot).
    assert.strictEqual(sent, "board_token=abc.def");
  });

  test("value containing '=' (base64url padding edge) is preserved intact", async () => {
    // parseCookies splits on first '=' only, so an '=' inside the value survives.
    const sent = await cookieSentForSetCookie(
      "board_token=a=b=c; Path=/; HttpOnly"
    );
    assert.strictEqual(sent, "board_token=a=b=c");
  });

  test("wrong cookie name in Set-Cookie → no Cookie header (fails safe, no crash)", async () => {
    // If login somehow set a differently-named cookie, remoteMove must not
    // fabricate a token; it sends no Cookie header and the move would 401.
    const sent = await cookieSentForSetCookie("token=legacy-wrong; Path=/; HttpOnly");
    assert.strictEqual(sent, undefined, "must NOT send a Cookie when board_token is absent");
  });

  test("empty Set-Cookie header → no Cookie header, no crash", async () => {
    const sent = await cookieSentForSetCookie("");
    assert.strictEqual(sent, undefined);
  });

  test("leading whitespace before cookie name is tolerated", async () => {
    const sent = await cookieSentForSetCookie("  board_token=spaced; Path=/");
    assert.strictEqual(sent, "board_token=spaced");
  });
});

describe("reviewer: CLI remote config must NOT leak to non-move commands", () => {
  test("list runs locally and prints projects even when remote env is set", () => {
    const tmp = freshData();
    const res = runCLI(["list", "--file", tmp], {
      env: { BOARD_REMOTE: "http://127.0.0.1:1", BOARD_PASSWORD: "x" },
    });
    assert.strictEqual(res.code, 0, "list must exit 0, stderr: " + res.stderr);
    assert.match(res.stdout, /■/, "list must render local project output");
  });

  test("show runs locally even when remote env is set", () => {
    const tmp = freshData();
    const res = runCLI(["show", "EP-1-T4", "--file", tmp], {
      env: { BOARD_REMOTE: "http://127.0.0.1:1", BOARD_PASSWORD: "x" },
    });
    assert.strictEqual(res.code, 0, "show must exit 0, stderr: " + res.stderr);
    assert.match(res.stdout, /EP-1-T4/);
  });

  test("help still prints when remote env is set (top-level return regression)", () => {
    const res = runCLI(["help"], {
      env: { BOARD_REMOTE: "http://127.0.0.1:1", BOARD_PASSWORD: "x" },
    });
    assert.strictEqual(res.code, 0);
    assert.match(res.stdout, /board/);
  });
});

describe("reviewer: remote move must NOT touch the local file", () => {
  test("successful remote move leaves local --file byte-for-byte unchanged", async () => {
    const tmp = freshData();
    const before = fs.readFileSync(tmp, "utf8");

    const stub = await startStubServer({
      loginStatus: 200,
      loginBody: { ok: true },
      loginCookie: "board_token=t; Path=/",
      moveStatus: 200,
      moveBody: { ok: true },
    });

    try {
      const res = await runCLIAsync(
        ["move", "EP-1-T4", "test", "--by", "engineer", "--file", tmp],
        { env: { BOARD_REMOTE: stub.url, BOARD_PASSWORD: "pw" } }
      );
      assert.strictEqual(res.code, 0, "expected exit 0, stderr: " + res.stderr);
      assert.match(res.stdout, /remote/);
    } finally {
      await stub.close();
    }

    assert.strictEqual(
      fs.readFileSync(tmp, "utf8"),
      before,
      "remote move must NOT write the local file"
    );
  });
});

// ─── ANTI-REGRESSION INTEGRATION TEST ───────────────────────────────────────
//
// This test does NOT mock the cookie round-trip. It stands up a REAL in-process
// HTTP server routing to the actual api/login.js and api/move.js handlers
// (factory form with injected in-memory KV), so Set-Cookie from login and Cookie
// on move flow through REAL HTTP headers. This means the cookie name MATTERS:
// if remote.js sends "token=<value>" instead of "board_token=<value>", the auth
// gate (which reads parseCookies(req.headers.cookie)[auth.COOKIE_NAME]) will NOT
// find the token and will return 401, failing the test.
//
// This test WOULD FAIL against the old buggy code (which sent "token=<value>")
// and PASSES after the fix (which sends "board_token=<value>").

// Test constants — literals only, not real credentials.
const INTEG_TEST_PASSWORD = "integration-test-pw-do-not-use";
const INTEG_TEST_SECRET = "integration-test-secret-do-not-use";

/**
 * In-memory mock KV client (same shape as api.test.js).
 */
function makeMockKvClient(initialStore) {
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
    async eval(script, keys, args) {
      const boardKey = keys[0];
      const versionKey = keys[1];
      const stored = versionKey in store ? (Number(store[versionKey]) || 0) : 0;
      const expected = Number(args[0]);
      if (stored !== expected) return [0, stored];
      store[boardKey] = args[1];
      const newv = stored + 1;
      store[versionKey] = String(newv);
      return [1, newv];
    },
    _store: store,
  };
}

/** Minimal sample board with a task that an engineer can move backlog→progress. */
const INTEG_SAMPLE_BOARD = {
  workflow: {
    states: ["backlog", "progress", "test", "uat", "done"],
    labels: { backlog: "Chờ làm", progress: "Đang làm", test: "Test", uat: "UAT", done: "Xong" },
    transitions: [
      { from: "backlog", to: "progress", by: "engineer" },
      { from: "progress", to: "test", by: "engineer" },
      { from: "test", to: "uat", by: "qa", requires: "tests_pass" },
      { from: "uat", to: "done", by: "po" },
      { from: "uat", to: "backlog", by: "po", flag: "reject" },
    ],
    rules: [],
  },
  projects: [
    {
      id: "p1",
      name: "Test Project",
      epics: [
        {
          id: "EP-INTEG-1",
          title: "Integration Epic",
          tasks: [
            { id: "INTEG-T1", title: "Task in backlog", status: "backlog", history: [] },
          ],
        },
      ],
    },
  ],
};

/**
 * Build a real in-process HTTP server routing to the actual api/login.js and
 * api/move.js handlers. Returns a promise resolving to { url, client, close }.
 */
function startRealApiServer() {
  const { createHandler: createLogin } = require("../api/login");
  const { createHandler: createMove } = require("../api/move");
  const kv = require("../lib/kv-store");

  const client = makeMockKvClient({
    board: JSON.stringify(INTEG_SAMPLE_BOARD),
    "board:version": "0",
  });

  const loginHandler = createLogin({
    password: INTEG_TEST_PASSWORD,
    secret: INTEG_TEST_SECRET,
  });

  const moveHandler = createMove({
    secret: INTEG_TEST_SECRET,
    kvOpts: { client },
  });

  const server = http.createServer(async (req, res) => {
    // Bridge Node's IncomingMessage → handler req/res adapter.
    // Collect the raw body, then dispatch.
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", async () => {
      const rawBody = Buffer.concat(chunks).toString("utf8");

      // Adapt: handlers use req.body (pre-parsed object) or raw stream.
      // Inject body as a pre-parsed object so handlers skip the stream path.
      let parsedBody = undefined;
      if (rawBody && rawBody.trim()) {
        try { parsedBody = JSON.parse(rawBody); } catch (_) { parsedBody = rawBody; }
      }

      // Build a facade that looks like what the handler expects.
      const handlerReq = {
        method: req.method,
        headers: req.headers,
        body: parsedBody,
        // Handlers may listen on "data"/"end" if body is undefined/null;
        // since we set body above they won't need these.
        on: () => {},
      };

      // Build a facade for res that routes back to the real Node response.
      let statusCode = 200;
      const handlerRes = {
        status(code) { statusCode = code; return handlerRes; },
        json(obj) {
          res.writeHead(statusCode, { "Content-Type": "application/json" });
          res.end(JSON.stringify(obj));
          return handlerRes;
        },
        setHeader(name, value) {
          res.setHeader(name, value);
        },
      };

      if (req.url === "/api/login" && req.method === "POST") {
        await loginHandler(handlerReq, handlerRes);
      } else if (req.url === "/api/move" && req.method === "POST") {
        await moveHandler(handlerReq, handlerRes);
      } else {
        res.writeHead(404);
        res.end("Not found");
      }
    });
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({
        url: "http://127.0.0.1:" + port,
        client,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

describe("ANTI-REGRESSION: remoteMove cookie name — real HTTP server with real auth gate", () => {
  test("correct password: remoteMove succeeds and move is persisted in KV", async () => {
    /*
     * This test feeds remoteMove's output through REAL HTTP headers and the
     * REAL auth gate (api/login.js issues board_token, api/move.js verifies it
     * via auth.parseCookies()[auth.COOKIE_NAME]).
     *
     * OLD CODE: remote.js sent "token=<value>" → auth gate looked for
     *   cookies["board_token"] → undefined → 401. Test would FAIL.
     * FIXED CODE: remote.js sends "board_token=<value>" → gate finds it → 200.
     */
    const srv = await startRealApiServer();
    try {
      const result = await remoteMove({
        url: srv.url,
        password: INTEG_TEST_PASSWORD,
        id: "INTEG-T1",
        to: "progress",
        by: "engineer",
      });

      assert.strictEqual(
        result.ok,
        true,
        "remoteMove must succeed when cookie name matches auth gate expectation; " +
        "if this is 401, remote.js is sending the wrong cookie name. error=" + result.error
      );
      assert.strictEqual(result.status, 200, "expected HTTP 200 from /api/move");

      // Verify the move was actually persisted in the mock KV.
      const kv = require("../lib/kv-store");
      const { data } = await kv.load({ client: srv.client });
      const task = data.projects[0].epics[0].tasks[0];
      assert.strictEqual(
        task.status,
        "progress",
        "INTEG-T1 must be persisted as 'progress' in the mock KV"
      );
    } finally {
      await srv.close();
    }
  });

  test("wrong password: remoteMove returns 401 and move is NOT persisted", async () => {
    /*
     * Negative check: wrong password → login 401 → remoteMove surfaces error,
     * move endpoint is never called, KV unchanged.
     */
    const srv = await startRealApiServer();
    try {
      const result = await remoteMove({
        url: srv.url,
        password: "DEFINITELY_WRONG_PASSWORD",
        id: "INTEG-T1",
        to: "progress",
        by: "engineer",
      });

      assert.strictEqual(result.ok, false, "wrong password must yield ok:false");
      assert.strictEqual(result.status, 401, "wrong password must yield 401");
      assert.ok(result.error, "error field must be present");

      // KV must be unchanged.
      const kv = require("../lib/kv-store");
      const { data } = await kv.load({ client: srv.client });
      const task = data.projects[0].epics[0].tasks[0];
      assert.strictEqual(
        task.status,
        "backlog",
        "task must remain in 'backlog' — move must NOT be persisted on wrong password"
      );
    } finally {
      await srv.close();
    }
  });
});
