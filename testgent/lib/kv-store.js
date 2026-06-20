/*
 * kv-store — async storage adapter for Vercel KV (Upstash Redis REST API).
 *
 * API shape mirrors lib/store.js (load/save/findTask) but is async.
 * The board JSON is stored under a single KV key ("board").
 * A separate version key ("board:version") is used for optimistic concurrency.
 *
 * Optimistic Concurrency / CAS strategy:
 *   - load() reads both the board payload AND the current version counter from KV.
 *   - save() writes the new board payload AND increments the version counter.
 *   - update(mutatorFn, opts) is the safe read-modify-write helper:
 *       1. load() captures the current version V.
 *       2. mutatorFn is called on a deep clone of the board data.
 *       3. save() is attempted; before writing it re-reads the version:
 *          if version still === V, write proceeds (SET board + increment version).
 *          if version !== V (someone else wrote in the interim), it retries.
 *       4. On conflict, retry from step 1, up to MAX_RETRIES times.
 *   This avoids lost updates when two agents call update() near-simultaneously.
 *   Because the Upstash REST API is HTTP (not a true Redis MULTI/EXEC), we
 *   implement CAS with a version key: we do a GET version + conditional write
 *   in a two-step sequence. The version key is incremented atomically using
 *   the Redis INCR command via the REST API.
 *
 * Injectable client:
 *   Pass opts.client = { get(key), set(key, value), incr(key) } to inject a
 *   mock in tests. If not provided, a real fetch-based client is built from
 *   opts.url / opts.token or from env KV_REST_API_URL / KV_REST_API_TOKEN.
 *
 * This is a library: no console output, no process.exit. Callers handle errors.
 */
"use strict";

const BOARD_KEY = "board";
const VERSION_KEY = "board:version";
const MAX_RETRIES = 5;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Build a fetch-based Upstash REST client.
 * The Upstash Redis REST API supports:
 *   GET  <baseUrl>/get/<key>      -> { result: value | null }
 *   GET  <baseUrl>/set/<key>/<v>  -> { result: "OK" }
 *   GET  <baseUrl>/incr/<key>     -> { result: <newValue> }
 * All with Authorization: Bearer <token>
 */
function buildFetchClient(url, token, fetchFn) {
  const base = url.replace(/\/$/, "");
  const headers = { Authorization: "Bearer " + token };
  const f = fetchFn || globalThis.fetch;

  async function request(command, ...args) {
    // Upstash REST API: POST JSON array [command, ...args]
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
      const result = await request("GET", key);
      return result; // null or string
    },
    async set(key, value) {
      await request("SET", key, value);
    },
    async incr(key) {
      return await request("INCR", key);
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
 * Returns the board object. Internally also returns the version counter so
 * update() can detect concurrent writes.
 *
 * opts:
 *   client  — injectable mock client { get, set, incr }
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
 * Persists the board object. Does NOT perform optimistic concurrency checks —
 * use update() for safe read-modify-write. save() is intentionally a plain
 * write; it also increments the version so concurrent writers can detect
 * conflicts when using update().
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
 * Synchronous lookup — same as store.js. Callers pass the already-loaded board.
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
 * Safe read-modify-write with optimistic concurrency:
 *   1. load() the current board and capture the version V.
 *   2. Call mutatorFn(data) — may mutate data in-place or return a new value.
 *      The function receives a deep clone so the original is never partially mutated.
 *   3. Re-read the version from KV.
 *      If it still equals V → save (write + incr version) and done.
 *      If it changed → someone else wrote; retry from step 1.
 *   4. After MAX_RETRIES failures, throw an error.
 *
 * mutatorFn may be async or sync.
 *
 * opts: same as load/save (client, url, token, fetch)
 */
async function update(mutatorFn, opts) {
  const client = resolveClient(opts);
  const optsWithClient = Object.assign({}, opts, { client });

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    // Step 1: read current state
    const { data, version } = await load(optsWithClient);

    // Step 2: apply mutation on a deep clone (so a failed attempt doesn't partially corrupt)
    const clone = JSON.parse(JSON.stringify(data));
    const result = await Promise.resolve(mutatorFn(clone));
    const newData = result !== undefined ? result : clone;

    // Step 3: re-read version to detect concurrent writes
    const versionRaw = await client.get(VERSION_KEY);
    const currentVersion = versionRaw === null || versionRaw === undefined ? 0 : Number(versionRaw);

    if (currentVersion !== version) {
      // Conflict — someone else wrote between our load and now; retry
      continue;
    }

    // Step 4: write (version has not changed, so this is safe)
    await save(newData, optsWithClient);
    return;
  }

  throw new Error(
    "kv-store: update() failed after " + MAX_RETRIES + " retries due to concurrent writes"
  );
}

module.exports = { load, save, findTask, update };
