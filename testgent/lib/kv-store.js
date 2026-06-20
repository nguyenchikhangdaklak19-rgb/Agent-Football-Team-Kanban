/*
 * kv-store — async storage adapter for Vercel KV (Upstash Redis REST API).
 *
 * API shape mirrors lib/store.js (load/save/findTask) but is async.
 * The board JSON is stored under a single KV key ("board").
 * A separate version key ("board:version") is used for optimistic concurrency.
 *
 * Optimistic Concurrency / CAS strategy (Lua EVAL — single atomic round-trip):
 *   update(mutatorFn, opts) is the safe read-modify-write helper:
 *     1. load() reads the current board payload and version counter.
 *     2. mutatorFn is applied to a deep clone of the board data.
 *     3. client.eval(CAS_SCRIPT, [BOARD_KEY, VERSION_KEY], [expectedVersion, newBoard])
 *        is called.  This executes a Lua script server-side in ONE atomic step:
 *          - Reads the stored version; if it doesn't match expectedVersion → conflict.
 *          - Only if it matches: writes newBoard and increments the version.
 *        Because the script runs atomically inside Redis (no other command can
 *        interleave while the Lua VM is executing), there is NO window between
 *        the "read version" and the "write board" where a concurrent writer's
 *        retry GET can land and observe stale data.  This eliminates the TOCTOU
 *        race that the two-round-trip INCR-then-SET approach had.
 *     4. On conflict the caller retries from step 1 with fresh data.
 *     5. After MAX_RETRIES failures, throw.
 *
 *   Why INCR-then-SET is broken:
 *     INCR and SET are TWO separate REST calls (two round-trips).  Between the
 *     winner's INCR completing and the winner's SET landing, a losing writer's
 *     retry GET(board) can execute against Redis and receive the PRE-winner
 *     board value.  The loser then sees a version that lets it pass the
 *     INCR check on its next attempt and clobbers the winner's write — a
 *     silent lost update (~9 % of real concurrent runs).
 *
 * Injectable client:
 *   Pass opts.client = { get(key), set(key,value), incr(key),
 *                        eval(script, keys, args) }
 *   to inject a mock in tests. If not provided, a real fetch-based client is
 *   built from opts.url / opts.token or from env KV_REST_API_URL /
 *   KV_REST_API_TOKEN.
 *
 * This is a library: no console output, no process.exit. Callers handle errors.
 */
"use strict";

const BOARD_KEY = "board";
const VERSION_KEY = "board:version";
const MAX_RETRIES = 20;

/*
 * Lua CAS script (Upstash/Redis EVAL).
 *
 * KEYS[1] = board key
 * KEYS[2] = version key
 * ARGV[1] = expected version (integer, as string)
 * ARGV[2] = new board JSON value
 *
 * Returns a two-element array:
 *   [0, currentVersion]   — conflict (stored version != expected)
 *   [1, newVersion]       — success (wrote board + bumped version)
 *
 * The entire body executes atomically server-side; no other Redis command
 * can interleave between the GET(version) and the SET(board)+INCR(version).
 */
const CAS_SCRIPT = [
  "local cv = redis.call('GET', KEYS[2])",
  "local stored = cv and tonumber(cv) or 0",
  "local expected = tonumber(ARGV[1])",
  "if stored ~= expected then",
  "  return {0, stored}",
  "end",
  "redis.call('SET', KEYS[1], ARGV[2])",
  "local newv = redis.call('INCR', KEYS[2])",
  "return {1, newv}",
].join("\n");

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Build a fetch-based Upstash REST client.
 * Upstash Redis REST API:
 *   POST <baseUrl> with body ["GET",  key]                      -> { result }
 *   POST <baseUrl> with body ["SET",  key, value]               -> { result }
 *   POST <baseUrl> with body ["INCR", key]                      -> { result }
 *   POST <baseUrl> with body ["EVAL", script, numKeys, ...keys, ...args] -> { result }
 * All requests use Authorization: Bearer <token>.
 */
function buildFetchClient(url, token, fetchFn) {
  const base = url.replace(/\/$/, "");
  const headers = { Authorization: "Bearer " + token };
  const f = fetchFn || globalThis.fetch;

  async function request(command, ...args) {
    const res = await f(base, {
      method: "POST",
      headers: Object.assign({ "Content-Type": "application/json" }, headers),
      body: JSON.stringify([command, ...args]),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error("kv-store: KV request failed (" + res.status + "): " + text);
    }
    const json = await res.json();
    if (json.error) throw new Error("kv-store: KV error: " + json.error);
    return json.result;
  }

  return {
    async get(key) {
      return await request("GET", key);
    },
    async set(key, value) {
      await request("SET", key, value);
    },
    async incr(key) {
      return await request("INCR", key);
    },
    /**
     * eval(script, keys, args) — execute a Lua script atomically via EVAL.
     * Upstash REST: ["EVAL", script, numKeys, key1, ..., arg1, ...]
     * Returns the raw result array from Redis.
     */
    async eval(script, keys, args) {
      return await request("EVAL", script, keys.length, ...keys, ...args);
    },
  };
}

/**
 * Resolve the client from opts, falling back to env vars + global fetch.
 */
function resolveClient(opts) {
  opts = opts || {};
  if (opts.client) return opts.client;

  const url = opts.url || process.env.KV_REST_API_URL;
  const token = opts.token || process.env.KV_REST_API_TOKEN;
  if (!url) throw new Error("kv-store: KV_REST_API_URL is not set");
  if (!token) throw new Error("kv-store: KV_REST_API_TOKEN is not set");

  return buildFetchClient(url, token, opts.fetch);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * load(opts) -> { data, version }
 *
 * Returns the board object and current version counter.
 * update() uses these for its optimistic CAS loop.
 *
 * opts:
 *   client  — injectable mock client { get, set, incr, eval }
 *   url     — KV REST API URL (overrides env)
 *   token   — KV REST API token (overrides env)
 *   fetch   — injectable fetch function (for tests without a mock client)
 */
async function load(opts) {
  const client = resolveClient(opts);
  const [raw, versionRaw] = await Promise.all([
    client.get(BOARD_KEY),
    client.get(VERSION_KEY),
  ]);

  if (raw === null || raw === undefined) {
    throw new Error("kv-store: board key not found in KV (have you run the seed script?)");
  }

  let data;
  try {
    data = typeof raw === "object" ? raw : JSON.parse(raw);
  } catch (err) {
    throw new Error("kv-store: invalid JSON stored in KV: " + err.message);
  }

  const version = versionRaw === null || versionRaw === undefined ? 0 : Number(versionRaw);
  return { data, version };
}

/**
 * save(data, opts) -> void
 *
 * Unconditional write — does NOT perform optimistic concurrency checks.
 * Use update() for safe read-modify-write. save() is an escape hatch
 * (e.g. seed script). It increments the version so concurrent update()
 * callers detect the write and retry.
 */
async function save(data, opts) {
  const client = resolveClient(opts);
  const serialized = JSON.stringify(data);
  await client.set(BOARD_KEY, serialized);
  await client.incr(VERSION_KEY);
}

/**
 * findTask(data, id) -> { project, epic, task } | null
 *
 * Synchronous lookup — same shape as store.js. Callers pass the loaded board.
 */
function findTask(data, id) {
  for (const p of data.projects)
    for (const e of p.epics)
      for (const t of e.tasks)
        if (t.id === id) return { project: p, epic: e, task: t };
  return null;
}

/**
 * update(mutatorFn, opts) -> void
 *
 * Safe read-modify-write using a single atomic Lua EVAL CAS:
 *
 *   1. load() the current board and version V.
 *   2. Call mutatorFn(clone) — may mutate in-place or return a new value.
 *      (Runs on a deep clone, so a failed attempt leaves the original intact.)
 *   3. Call client.eval(CAS_SCRIPT, [BOARD_KEY, VERSION_KEY], [V, newBoard]).
 *      The Lua script executes atomically server-side:
 *        - Reads the stored version.
 *        - If it matches V → writes newBoard + increments version → success.
 *        - If it doesn't match → conflict, returns current version.
 *      Because this is ONE server-side operation, no concurrent writer's
 *      GET or SET can interleave between the "check version" and the
 *      "write board" steps.  This is the canonical atomic CAS for Redis.
 *   4. On conflict: reload fresh data, re-apply mutator, re-try EVAL.
 *   5. After MAX_RETRIES failures, throw an error.
 *
 * mutatorFn may be async or sync.
 * opts: same as load/save (client, url, token, fetch).
 */
async function update(mutatorFn, opts) {
  const client = resolveClient(opts);
  const optsWithClient = Object.assign({}, opts, { client });

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    // Step 1: read current state
    const { data, version } = await load(optsWithClient);

    // Step 2: apply mutation on a deep clone
    const clone = JSON.parse(JSON.stringify(data));
    const result = await Promise.resolve(mutatorFn(clone));
    const newData = result !== undefined ? result : clone;
    const newBoard = JSON.stringify(newData);

    // Step 3: atomic CAS via Lua EVAL — single round-trip, no TOCTOU window.
    // result[0]: 1 = success, 0 = conflict
    // result[1]: new version (success) or current stored version (conflict)
    const casResult = await client.eval(CAS_SCRIPT, [BOARD_KEY, VERSION_KEY], [String(version), newBoard]);

    // Upstash returns integer arrays as arrays of numbers
    const ok = Array.isArray(casResult) ? casResult[0] : casResult;
    if (ok === 1 || ok === "1") {
      return; // committed
    }

    // Conflict: another writer changed the version between our load and our EVAL.
    // Loop back to step 1 to reload fresh data.
  }

  throw new Error(
    "kv-store: update() failed after " + MAX_RETRIES + " retries due to concurrent writes"
  );
}

module.exports = { load, save, findTask, update };
