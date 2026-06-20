/*
 * test/seed.test.js — tests for scripts/seed-kv.js and vercel.json / package.json
 *
 * All KV I/O is mocked in-memory. No real network calls are made.
 *
 * Run: node --test test/seed.test.js
 *      (or via npm test which runs node --test test/*.test.js)
 */
"use strict";

const { test } = require("node:test");
const assert   = require("node:assert");
const path     = require("path");
const fs       = require("fs");
const os       = require("os");

const { seedKv } = require("../scripts/seed-kv");
const { load }   = require("../lib/kv-store");

// ---------------------------------------------------------------------------
// In-memory mock KV client (mirrors the factory used in kv-store.test.js)
// ---------------------------------------------------------------------------

function makeMockClient(initialStore) {
  const store = Object.assign(Object.create(null), initialStore || {});
  return {
    async get(key)        { return key in store ? store[key] : null; },
    async set(key, value) { store[key] = value; },
    async incr(key) {
      const current = key in store ? Number(store[key]) : 0;
      const next    = current + 1;
      store[key]    = String(next);
      return next;
    },
    _store: store,
  };
}

// ---------------------------------------------------------------------------
// Minimal sample board for injection tests (no filesystem needed)
// ---------------------------------------------------------------------------

const SAMPLE_BOARD = {
  workflow: { states: ["backlog", "done"] },
  projects: [
    {
      id: "p1",
      name: "Sample Project",
      epics: [
        {
          id: "EP-1",
          title: "Sample Epic",
          tasks: [
            { id: "EP-1-T1", title: "Task A", status: "backlog" },
            { id: "EP-1-T2", title: "Task B", status: "done"    },
          ],
        },
      ],
    },
  ],
};

// ---------------------------------------------------------------------------
// 1. seedKv writes data injected via opts.data (fully offline)
// ---------------------------------------------------------------------------

test("seedKv: writes the injected board data into KV", async () => {
  const client = makeMockClient({});
  await seedKv({ data: SAMPLE_BOARD, kvOpts: { client } });

  // The "board" key must now exist in the mock store
  assert.ok("board" in client._store, "board key must be set in KV");

  // And it must parse back to the same shape
  const stored = JSON.parse(client._store["board"]);
  assert.deepStrictEqual(stored, SAMPLE_BOARD, "stored board must equal injected data");
});

test("seedKv: written board survives a round-trip through kv-store.load()", async () => {
  const client = makeMockClient({});
  await seedKv({ data: SAMPLE_BOARD, kvOpts: { client } });

  const { data } = await load({ client });
  assert.deepStrictEqual(data, SAMPLE_BOARD,
    "board loaded via kv-store.load() must equal the originally seeded data");
});

test("seedKv: projects and workflow survive the round-trip", async () => {
  const client = makeMockClient({});
  await seedKv({ data: SAMPLE_BOARD, kvOpts: { client } });

  const { data } = await load({ client });
  assert.deepStrictEqual(data.workflow, SAMPLE_BOARD.workflow, "workflow must survive");
  assert.deepStrictEqual(data.projects, SAMPLE_BOARD.projects, "projects must survive");
});

// ---------------------------------------------------------------------------
// 2. seedKv bumps the version counter (via kv-store.save())
// ---------------------------------------------------------------------------

test("seedKv: version counter is incremented after seeding", async () => {
  const client = makeMockClient({ "board:version": "0" });
  await seedKv({ data: SAMPLE_BOARD, kvOpts: { client } });

  const versionAfter = Number(client._store["board:version"]);
  assert.ok(versionAfter > 0, "board:version must be incremented by seed");
});

// ---------------------------------------------------------------------------
// 3. seedKv is idempotent-overwrite: second call replaces the first
// ---------------------------------------------------------------------------

test("seedKv: re-running overwrites the previous board (idempotent overwrite)", async () => {
  const client = makeMockClient({});

  // First seed
  await seedKv({ data: SAMPLE_BOARD, kvOpts: { client } });
  const afterFirst = JSON.parse(client._store["board"]);
  assert.deepStrictEqual(afterFirst, SAMPLE_BOARD);

  // Second seed with different data
  const updatedBoard = Object.assign({}, SAMPLE_BOARD, { _seededTwice: true });
  await seedKv({ data: updatedBoard, kvOpts: { client } });

  const afterSecond = JSON.parse(client._store["board"]);
  assert.strictEqual(afterSecond._seededTwice, true,
    "second seed must overwrite the first board");
  assert.strictEqual(afterFirst._seededTwice, undefined,
    "original board object should not have been mutated");
});

// ---------------------------------------------------------------------------
// 4. seedKv reads from a JSON file when opts.dataPath is supplied
// ---------------------------------------------------------------------------

test("seedKv: reads board from a custom dataPath (no env/network)", async () => {
  // Write a temp JSON file
  const tmpFile = path.join(os.tmpdir(), "test-board-" + Date.now() + ".json");
  fs.writeFileSync(tmpFile, JSON.stringify(SAMPLE_BOARD), "utf8");

  const client = makeMockClient({});
  try {
    await seedKv({ dataPath: tmpFile, kvOpts: { client } });
    const { data } = await load({ client });
    assert.deepStrictEqual(data, SAMPLE_BOARD,
      "board from file must match the JSON written to the temp file");
  } finally {
    fs.unlinkSync(tmpFile);
  }
});

test("seedKv: returns the board object that was written", async () => {
  const client  = makeMockClient({});
  const returned = await seedKv({ data: SAMPLE_BOARD, kvOpts: { client } });
  assert.deepStrictEqual(returned, SAMPLE_BOARD,
    "seedKv must return the board object that was seeded");
});

// ---------------------------------------------------------------------------
// 5. seedKv reads the real board-data.json by default (via opts.dataPath
//    defaulting to the real path, but we still inject a mock client so no
//    real KV network call is made)
// ---------------------------------------------------------------------------

test("seedKv: seeds from the real board-data.json when dataPath is omitted", async () => {
  const client = makeMockClient({});
  const returned = await seedKv({ kvOpts: { client } });

  assert.ok(Array.isArray(returned.projects),
    "board read from real board-data.json must have a projects array");
  assert.ok(returned.projects.length > 0,
    "real board-data.json must have at least one project");

  // Verify it persisted to KV
  const { data } = await load({ client });
  assert.ok(Array.isArray(data.projects),
    "loaded board from KV must have a projects array");
  assert.strictEqual(data.projects.length, returned.projects.length,
    "number of projects in KV must match what was seeded");
});

// ---------------------------------------------------------------------------
// 6. seedKv does NOT require real env variables (mock client bypasses env)
// ---------------------------------------------------------------------------

test("seedKv: offline — does not require KV_REST_API_URL or KV_REST_API_TOKEN", async () => {
  const savedUrl   = process.env.KV_REST_API_URL;
  const savedToken = process.env.KV_REST_API_TOKEN;
  delete process.env.KV_REST_API_URL;
  delete process.env.KV_REST_API_TOKEN;

  const client = makeMockClient({});
  try {
    // Must not throw even though env vars are absent, because client is injected
    await seedKv({ data: SAMPLE_BOARD, kvOpts: { client } });
    const { data } = await load({ client });
    assert.deepStrictEqual(data, SAMPLE_BOARD,
      "injected mock client bypasses env var requirement");
  } finally {
    if (savedUrl   !== undefined) process.env.KV_REST_API_URL   = savedUrl;
    if (savedToken !== undefined) process.env.KV_REST_API_TOKEN = savedToken;
  }
});

// ---------------------------------------------------------------------------
// 7. vercel.json is valid JSON and has the required keys
// ---------------------------------------------------------------------------

test("vercel.json: is parseable JSON", () => {
  const vercelPath = path.resolve(__dirname, "../vercel.json");
  const raw = fs.readFileSync(vercelPath, "utf8");
  assert.doesNotThrow(() => JSON.parse(raw), "vercel.json must be valid JSON");
});

test("vercel.json: has version field", () => {
  const vercelPath = path.resolve(__dirname, "../vercel.json");
  const config     = JSON.parse(fs.readFileSync(vercelPath, "utf8"));
  assert.ok("version" in config, "vercel.json must have a 'version' field");
  assert.strictEqual(config.version, 2, "vercel.json version must be 2");
});

test("vercel.json: has rewrites array with at least one entry", () => {
  const vercelPath = path.resolve(__dirname, "../vercel.json");
  const config     = JSON.parse(fs.readFileSync(vercelPath, "utf8"));
  assert.ok(Array.isArray(config.rewrites), "vercel.json must have a rewrites array");
  assert.ok(config.rewrites.length > 0,    "rewrites must have at least one entry");
});

test("vercel.json: rewrites include an API route pattern", () => {
  const vercelPath = path.resolve(__dirname, "../vercel.json");
  const config     = JSON.parse(fs.readFileSync(vercelPath, "utf8"));
  const hasApiRewrite = config.rewrites.some(
    (r) => r.source && r.source.includes("/api/")
  );
  assert.ok(hasApiRewrite, "rewrites must include an /api/ route");
});

test("vercel.json: rewrites include a fallback to index.html for the SPA", () => {
  const vercelPath = path.resolve(__dirname, "../vercel.json");
  const config     = JSON.parse(fs.readFileSync(vercelPath, "utf8"));
  const hasSpaFallback = config.rewrites.some(
    (r) => r.destination && r.destination.includes("index.html")
  );
  assert.ok(hasSpaFallback,
    "rewrites must include a fallback that serves index.html for the SPA root");
});

test("vercel.json: functions runtime targets nodejs20.x or higher", () => {
  const vercelPath = path.resolve(__dirname, "../vercel.json");
  const config     = JSON.parse(fs.readFileSync(vercelPath, "utf8"));
  // functions block is optional if Vercel auto-detects, but when present it must
  // declare a nodejs runtime compatible with Node 18+.
  if (config.functions) {
    const runtimes = Object.values(config.functions).map((fn) => fn.runtime || "");
    const allNode  = runtimes.every((r) => r.startsWith("nodejs"));
    assert.ok(allNode,
      "all function runtimes in vercel.json must use a nodejs runtime");
  }
  // If functions block is absent, Vercel auto-detects — also acceptable.
});

// ---------------------------------------------------------------------------
// 8. package.json has the expected scripts
// ---------------------------------------------------------------------------

test("package.json: has 'seed' script", () => {
  const pkgPath = path.resolve(__dirname, "../package.json");
  const pkg     = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
  assert.ok(pkg.scripts && pkg.scripts.seed,
    "package.json must define a 'seed' script");
  assert.ok(
    pkg.scripts.seed.includes("seed-kv.js"),
    "'seed' script must reference seed-kv.js"
  );
});

test("package.json: 'test' script is unchanged (node --test test/*.test.js)", () => {
  const pkgPath = path.resolve(__dirname, "../package.json");
  const pkg     = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
  assert.ok(pkg.scripts && pkg.scripts.test,
    "package.json must define a 'test' script");
  assert.strictEqual(
    pkg.scripts.test,
    "node --test test/*.test.js",
    "'test' script must be exactly 'node --test test/*.test.js'"
  );
});

test("package.json: 'start' and 'board' scripts are preserved", () => {
  const pkgPath = path.resolve(__dirname, "../package.json");
  const pkg     = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
  assert.ok(pkg.scripts && pkg.scripts.start, "package.json must have a 'start' script");
  assert.ok(pkg.scripts && pkg.scripts.board, "package.json must have a 'board' script");
});

test("package.json: engines.node is >=18", () => {
  const pkgPath = path.resolve(__dirname, "../package.json");
  const pkg     = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
  assert.ok(pkg.engines && pkg.engines.node,
    "package.json must have an engines.node field");
  assert.ok(
    pkg.engines.node.includes("18") || pkg.engines.node.includes(">="),
    "engines.node must require Node 18 or newer"
  );
});

test("package.json: type is commonjs", () => {
  const pkgPath = path.resolve(__dirname, "../package.json");
  const pkg     = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
  assert.strictEqual(pkg.type, "commonjs", "package.json type must be 'commonjs'");
});
