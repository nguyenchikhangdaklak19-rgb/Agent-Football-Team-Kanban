/*
 * server — zero-dependency Node http server for the Team Board.
 *
 * Wires together the reusable libraries:
 *   - store.js     : fresh load / atomic save of board-data.json
 *   - workflow.js  : state-machine + role rules (validateMove/applyMove)
 *   - sse.js       : Server-Sent Events hub + file watcher (real-time refresh)
 * and serves the static frontend from public/.
 *
 * Designed to run 24/7: every request is wrapped so a single bad request can
 * never take the process down. The board's state machine (incl. "only PO may
 * push uat -> done") lives in workflow.js — this server does NOT reimplement
 * any role/auth logic; v1 has no login, so `by` comes from the client.
 *
 * Config (environment):
 *   PORT        listening port            (default 3000)
 *   BOARD_FILE  path to board-data.json    (default ./board-data.json,
 *               resolved relative to this file's directory)
 */
const http = require("http");
const fs = require("fs");
const path = require("path");

const store = require("./lib/store");
const { DEFAULT_WORKFLOW, applyMove } = require("./lib/workflow");
const createSSE = require("./lib/sse");

// --- Paths (relative to __dirname so CWD doesn't matter) --------------------
const PUBLIC_DIR = path.join(__dirname, "public");
const BOARD_FILE = path.isAbsolute(process.env.BOARD_FILE || "")
  ? process.env.BOARD_FILE
  : path.join(__dirname, process.env.BOARD_FILE || "board-data.json");
const PORT = Number(process.env.PORT) || 3000;

// --- SSE hub: pushes an `update` event whenever BOARD_FILE changes ----------
const sse = createSSE({ file: BOARD_FILE });
sse.watch();

// --- Static file helpers ----------------------------------------------------
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".ico": "image/x-icon",
  ".map": "application/json; charset=utf-8",
};

function sendJSON(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

function sendText(res, status, text) {
  res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" });
  res.end(text);
}

// Serve a file from public/. `urlPath` is the pathname portion of the request.
// Path traversal is blocked by resolving against PUBLIC_DIR and verifying the
// result stays inside it. Missing file -> 404.
function serveStatic(req, res, urlPath) {
  const rel = decodeURIComponent(urlPath === "/" ? "/index.html" : urlPath);
  const full = path.join(PUBLIC_DIR, rel);

  // Containment check: full must live under PUBLIC_DIR.
  const rootWithSep = PUBLIC_DIR.endsWith(path.sep) ? PUBLIC_DIR : PUBLIC_DIR + path.sep;
  if (full !== PUBLIC_DIR && !full.startsWith(rootWithSep)) {
    return sendText(res, 403, "Forbidden");
  }

  fs.stat(full, (err, st) => {
    if (err || !st.isFile()) return sendText(res, 404, "Not Found");
    const type = MIME[path.extname(full).toLowerCase()] || "application/octet-stream";
    res.writeHead(200, { "Content-Type": type, "Content-Length": st.size });
    const stream = fs.createReadStream(full);
    stream.on("error", () => {
      // Stream failed mid-flight; best effort, don't crash.
      if (!res.headersSent) sendText(res, 500, "Internal Server Error");
      else res.end();
    });
    stream.pipe(res);
  });
}

// Read the JSON request body (capped) then hand it to `cb(err, parsed)`.
function readJSONBody(req, cb) {
  const MAX = 1e6; // 1MB guard
  let raw = "";
  let aborted = false;
  req.on("data", (chunk) => {
    raw += chunk;
    if (raw.length > MAX) {
      aborted = true;
      req.destroy();
    }
  });
  req.on("error", () => { if (!aborted) { aborted = true; cb(new Error("request error")); } });
  req.on("end", () => {
    if (aborted) return;
    if (raw.trim() === "") return cb(new Error("empty body"));
    try {
      cb(null, JSON.parse(raw));
    } catch (e) {
      cb(e);
    }
  });
}

// --- Route handlers ---------------------------------------------------------
function handleGetBoard(req, res) {
  let data;
  try {
    data = store.load(BOARD_FILE); // fresh on every request
  } catch (e) {
    return sendJSON(res, 500, { ok: false, error: "cannot read board: " + e.message });
  }
  sendJSON(res, 200, data);
}

function handlePostMove(req, res) {
  readJSONBody(req, (err, body) => {
    if (err) return sendJSON(res, 400, { ok: false, error: "Malformed JSON body" });

    const { id, to, by, testsPass } = body || {};
    if (!id || !to || !by) {
      return sendJSON(res, 400, { ok: false, error: "id, to and by are required" });
    }

    let data;
    try {
      data = store.load(BOARD_FILE);
    } catch (e) {
      return sendJSON(res, 500, { ok: false, error: "cannot read board: " + e.message });
    }

    const found = store.findTask(data, id);
    if (!found) {
      return sendJSON(res, 404, { ok: false, error: 'Task "' + id + '" not found' });
    }

    const workflow = data.workflow || DEFAULT_WORKFLOW;
    const result = applyMove(workflow, found.task, to, by, {
      testsPass: !!testsPass,
      now: new Date().toISOString(),
    });

    if (!result.ok) {
      return sendJSON(res, 409, { ok: false, error: result.error });
    }

    try {
      store.save(BOARD_FILE, data); // atomic; watcher will broadcast `update`
    } catch (e) {
      return sendJSON(res, 500, { ok: false, error: "cannot save board: " + e.message });
    }

    sendJSON(res, 200, { ok: true, task: result.task });
  });
}

// --- Request dispatcher -----------------------------------------------------
const server = http.createServer((req, res) => {
  let pathname;
  try {
    pathname = new URL(req.url, "http://localhost").pathname;
  } catch (_) {
    return sendText(res, 400, "Bad Request");
  }

  try {
    if (pathname === "/api/board" && req.method === "GET") {
      return handleGetBoard(req, res);
    }
    if (pathname === "/api/move" && req.method === "POST") {
      return handlePostMove(req, res);
    }
    if (pathname === "/api/stream" && req.method === "GET") {
      return sse.handler(req, res);
    }
    if (req.method === "GET" || req.method === "HEAD") {
      return serveStatic(req, res, pathname);
    }
    return sendText(res, 405, "Method Not Allowed");
  } catch (e) {
    // Last-resort guard: never let a handler bug crash the process.
    if (!res.headersSent) sendJSON(res, 500, { ok: false, error: "Internal Server Error" });
    else { try { res.end(); } catch (_) { /* ignore */ } }
  }
});

// Don't crash on transient socket errors (client aborts, resets, etc.).
server.on("clientError", (err, socket) => {
  try { socket.end("HTTP/1.1 400 Bad Request\r\n\r\n"); } catch (_) { /* ignore */ }
});

// Keep the process alive 24/7 even if something throws outside a request.
process.on("uncaughtException", (err) => {
  console.error("[server] uncaughtException:", err && err.stack ? err.stack : err);
});
process.on("unhandledRejection", (err) => {
  console.error("[server] unhandledRejection:", err);
});

function shutdown() {
  try { sse.close(); } catch (_) { /* ignore */ }
  try { server.close(); } catch (_) { /* ignore */ }
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

server.listen(PORT, () => {
  console.log("[server] Team Board listening on http://localhost:" + PORT);
  console.log("[server] BOARD_FILE = " + BOARD_FILE);
});

module.exports = server;
