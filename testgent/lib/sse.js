/*
 * sse — zero-dependency Server-Sent Events hub + file watcher.
 *
 * Powers near-real-time updates for the Team Board: when the agent CLI mutates
 * board-data.json, the watcher fires and we push an `update` event to every
 * connected browser. The client reacts by re-fetching /api/board — we keep the
 * payload tiny on purpose (just a timestamp) so the SSE channel stays a pure
 * "something changed" signal and the data flows over the normal HTTP endpoint.
 *
 * Library style: no console output, no process.exit. Built entirely on Node
 * built-ins (fs). The `handler` is a standard (req, res) http listener.
 *
 * Usage:
 *   const createSSE = require("./lib/sse");
 *   const sse = createSSE({ file: "./board-data.json" });
 *   sse.watch();                  // start watching for changes
 *   // in your http server, route GET /events -> sse.handler
 *   // on shutdown: sse.close();
 */
const fs = require("fs");

module.exports = function createSSE({ file }) {
  if (!file) throw new Error("createSSE: { file } is required");

  // Set of connected client responses. Using a Set keeps add/remove O(1) and
  // tolerant of duplicates / double-removal on disconnect.
  const clients = new Set();

  let watcher = null;
  let debounceTimer = null;
  let closed = false;

  /**
   * Attach an SSE client. Sets the event-stream headers, registers the
   * response, sends an initial comment line (acts as a ping / flushes headers),
   * and de-registers the client when the connection closes.
   */
  function handler(req, res) {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      // Disable proxy buffering (e.g. nginx) so events arrive promptly.
      "X-Accel-Buffering": "no",
    });

    // A comment line ( ":" prefix ) is ignored by EventSource but flushes the
    // response headers and confirms the stream is live.
    safeWrite(res, ": connected\n\n");

    clients.add(res);

    // Drop the client on disconnect. `req` close covers most cases; guard `res`
    // too in case the underlying socket aborts.
    const drop = () => clients.delete(res);
    if (req && typeof req.on === "function") req.on("close", drop);
    if (typeof res.on === "function") res.on("close", drop);
  }

  /**
   * Broadcast an event to every connected client. `data` is JSON-encoded.
   * Returns the number of clients written to.
   */
  function broadcast(event, data) {
    const payload =
      "event: " + String(event) + "\n" +
      "data: " + JSON.stringify(data === undefined ? null : data) + "\n\n";

    let delivered = 0;
    for (const res of clients) {
      if (safeWrite(res, payload)) delivered++;
      else clients.delete(res); // dead socket — reap it
    }
    return delivered;
  }

  /**
   * Start watching `file`. On change we debounce (~100ms) because fs.watch
   * commonly fires twice per save, then broadcast a small `update` event.
   *
   * store.js saves atomically (write temp + rename over target). On many
   * platforms the rename causes the original inode's watch to stop receiving
   * events ('rename' eventType), so after each fire we re-establish the watch
   * to keep tracking the new file. Returns this api for chaining.
   */
  function watch() {
    if (closed) return api;
    startWatcher();
    return api;
  }

  function startWatcher() {
    closeWatcher();
    try {
      watcher = fs.watch(file, (eventType) => {
        // A 'rename' usually means the watched path was replaced (atomic save)
        // or the file moved — the existing watch is now stale, so rebuild it.
        const needsRewatch = eventType === "rename";

        if (debounceTimer) clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
          debounceTimer = null;
          if (closed) return;
          if (needsRewatch) startWatcher();
          broadcast("update", { at: new Date().toISOString() });
        }, 100);
      });
      // Don't let the watcher keep the event loop alive on its own.
      if (watcher && typeof watcher.on === "function") {
        watcher.on("error", () => {
          // Swallow watcher errors (e.g. transient ENOENT during rename) and
          // try to re-establish on the next tick rather than crashing.
          if (!closed) setTimeout(() => { if (!closed) startWatcher(); }, 100);
        });
      }
    } catch (err) {
      // If the file doesn't exist yet, retry shortly rather than throwing.
      if (!closed) setTimeout(() => { if (!closed) startWatcher(); }, 100);
    }
  }

  function closeWatcher() {
    if (watcher) {
      try { watcher.close(); } catch (_) { /* ignore */ }
      watcher = null;
    }
  }

  /**
   * Stop the watcher and end every client response. Idempotent.
   */
  function close() {
    closed = true;
    if (debounceTimer) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
    closeWatcher();
    for (const res of clients) {
      try {
        if (typeof res.end === "function") res.end();
      } catch (_) { /* client already gone */ }
    }
    clients.clear();
  }

  /** Number of currently connected clients. */
  function clientCount() {
    return clients.size;
  }

  // Write to a client response, swallowing errors from a disconnected socket.
  // Returns true on success, false if the write failed (caller may reap it).
  function safeWrite(res, chunk) {
    try {
      res.write(chunk);
      return true;
    } catch (_) {
      return false;
    }
  }

  const api = { handler, broadcast, watch, close, clientCount };
  return api;
};
