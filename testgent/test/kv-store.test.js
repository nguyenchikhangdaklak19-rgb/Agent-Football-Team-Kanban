/*
 * kv-store.test.js — tests for lib/kv-store.js
 *
 * All KV I/O is mocked in-memory. No real network calls are made.
 *
 * Run: node --test test/kv-store.test.js
 */
"use strict";

const { test } = require("node:test");
const assert = require("node:assert");
const { load, save, findTask, update } = require("../lib/kv-store");

// ---------------------------------------------------------------------------
// In-memory mock KV client factory
// ---------------------------------------------------------------------------

/**
 * Creates a fresh in-memory KV client. Optionally pre-seeded with data.
 * store is a plain object { [key]: value } where values are strings or null.
 */
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
    // Expose the raw store for test assertions
    _store: store,
  };
}

// ---------------------------------------------------------------------------
// Sample board data (minimal — exercises the data shape)
// ---------------------------------------------------------------------------

const SAMPLE_BOARD = {
  workflow: { states: ["backlog", "done"] },
  projects: [
    {
      id: "p1",
      name: "Project One",
      epics: [
        {
          id: "EP-1",
          title: "Epic One",
          tasks: [
            { id: "EP-1-T1", title: "Task 1", status: "backlog" },
            { id: "EP-1-T2", title: "Task 2", status: "done" },
          ],
        },
      ],
    },
    {
      id: "p2",
      name: "Project Two",
      epics: [
        {
          id: "EP-2",
          title: "Epic Two",
          tasks: [{ id: "EP-2-T1", title: "Task 3", status: "backlog" }],
        },
      ],
    },
  ],
};

function freshClient() {
  return makeMockClient({
    board: JSON.stringify(SAMPLE_BOARD),
    "board:version": "0",
  });
}

// ---------------------------------------------------------------------------
// 1. load()
// ---------------------------------------------------------------------------

test("load: returns stored board object", async () => {
  const client = freshClient();
  const { data } = await load({ client });
  assert.deepStrictEqual(data, SAMPLE_BOARD);
});

test("load: returns version number from KV", async () => {
  const client = makeMockClient({
    board: JSON.stringify(SAMPLE_BOARD),
    "board:version": "7",
  });
  const { version } = await load({ client });
  assert.strictEqual(version, 7);
});

test("load: version defaults to 0 when version key is missing", async () => {
  const client = makeMockClient({ board: JSON.stringify(SAMPLE_BOARD) });
  const { version } = await load({ client });
  assert.strictEqual(version, 0);
});

test("load: throws when board key is missing", async () => {
  const client = makeMockClient({});
  await assert.rejects(
    () => load({ client }),
    /board key not found/
  );
});

test("load: throws on invalid JSON in KV", async () => {
  const client = makeMockClient({ board: "this is not json" });
  await assert.rejects(
    () => load({ client }),
    /invalid JSON/
  );
});

// ---------------------------------------------------------------------------
// 2. save()
// ---------------------------------------------------------------------------

test("save: persists board object", async () => {
  const client = makeMockClient({
    board: JSON.stringify(SAMPLE_BOARD),
    "board:version": "0",
  });
  const newBoard = Object.assign({}, SAMPLE_BOARD, { _marker: "saved" });
  await save(newBoard, { client });

  const stored = JSON.parse(client._store["board"]);
  assert.strictEqual(stored._marker, "saved");
});

test("save: increments version key", async () => {
  const client = makeMockClient({
    board: JSON.stringify(SAMPLE_BOARD),
    "board:version": "3",
  });
  await save(SAMPLE_BOARD, { client });
  assert.strictEqual(client._store["board:version"], "4");
});

test("save then load: round-trips board data", async () => {
  const client = makeMockClient({ board: JSON.stringify(SAMPLE_BOARD) });
  const modified = JSON.parse(JSON.stringify(SAMPLE_BOARD));
  modified.projects[0].name = "Modified Name";

  await save(modified, { client });
  const { data } = await load({ client });

  assert.strictEqual(data.projects[0].name, "Modified Name");
  assert.deepStrictEqual(data, modified);
});

// ---------------------------------------------------------------------------
// 3. findTask()
// ---------------------------------------------------------------------------

test("findTask: finds an existing task by id", () => {
  const result = findTask(SAMPLE_BOARD, "EP-1-T1");
  assert.ok(result, "should return a result object");
  assert.strictEqual(result.project.id, "p1");
  assert.strictEqual(result.epic.id, "EP-1");
  assert.strictEqual(result.task.id, "EP-1-T1");
  assert.strictEqual(result.task.status, "backlog");
});

test("findTask: finds a task in a different project/epic", () => {
  const result = findTask(SAMPLE_BOARD, "EP-2-T1");
  assert.ok(result);
  assert.strictEqual(result.project.id, "p2");
  assert.strictEqual(result.epic.id, "EP-2");
  assert.strictEqual(result.task.title, "Task 3");
});

test("findTask: returns null for unknown task id", () => {
  const result = findTask(SAMPLE_BOARD, "NOPE-T99");
  assert.strictEqual(result, null);
});

test("findTask: returns null for empty projects array", () => {
  const emptyBoard = { projects: [] };
  const result = findTask(emptyBoard, "EP-1-T1");
  assert.strictEqual(result, null);
});

// ---------------------------------------------------------------------------
// 4. update()
// ---------------------------------------------------------------------------

test("update: applies a mutation and persists it", async () => {
  const client = freshClient();

  await update((data) => {
    data.projects[0].name = "Mutated";
  }, { client });

  const { data } = await load({ client });
  assert.strictEqual(data.projects[0].name, "Mutated");
});

test("update: increments version after successful write", async () => {
  const client = makeMockClient({
    board: JSON.stringify(SAMPLE_BOARD),
    "board:version": "5",
  });

  await update((data) => {
    data._updated = true;
  }, { client });

  assert.strictEqual(Number(client._store["board:version"]), 6);
});

test("update: mutator can return a new object (replaces board)", async () => {
  const client = freshClient();
  const replacement = { projects: [], _replaced: true };

  await update(() => replacement, { client });

  const { data } = await load({ client });
  assert.strictEqual(data._replaced, true);
  assert.deepStrictEqual(data.projects, []);
});

test("update: async mutator is supported", async () => {
  const client = freshClient();

  await update(async (data) => {
    await Promise.resolve(); // simulate async work
    data.projects[0].name = "Async Mutated";
  }, { client });

  const { data } = await load({ client });
  assert.strictEqual(data.projects[0].name, "Async Mutated");
});

test("update: throws after max retries on permanent conflict", async () => {
  // A client whose get() always returns an ever-incrementing version
  // to simulate infinite concurrent writes.
  let versionCounter = 0;
  const store = { board: JSON.stringify(SAMPLE_BOARD) };

  const conflictClient = {
    async get(key) {
      if (key === "board") return store.board;
      // board:version: always returns a different value than what we read
      // by incrementing on every call without a real set
      return String(versionCounter++);
    },
    async set(key, value) {
      if (key === "board") store.board = value;
    },
    async incr(key) {
      versionCounter++;
      return versionCounter;
    },
  };

  await assert.rejects(
    () => update((data) => { data._touched = true; }, { client: conflictClient }),
    /failed after \d+ retries/
  );
});

// ---------------------------------------------------------------------------
// 5. CRITICAL concurrency test: two concurrent update() calls must not lose
//    each other's mutation (no lost update).
// ---------------------------------------------------------------------------

test("concurrency: two concurrent updates both survive (no lost update)", async () => {
  /*
   * Scenario:
   *   - Both Agent A and Agent B load the board at version 0.
   *   - Agent A's save lands first: board gains {_byA: true}, version becomes 1.
   *   - Agent B then tries to save with stale version 0 → detects conflict
   *     (version is now 1, not 0) → retries.
   *   - On retry, Agent B reads the updated board (with _byA: true) and applies
   *     its own mutation, producing {_byA: true, _byB: true}, version becomes 2.
   *   - Final board: both mutations present.
   */

  // Shared in-memory KV store (simulates the real backend)
  let kvBoard = JSON.stringify(SAMPLE_BOARD);
  let kvVersion = 0;

  // Track whether Agent B has done its first (conflicting) attempt
  let agentBFirstAttempt = true;

  // We'll intercept the version check inside update() by using a specialized
  // client that lets Agent A "win" the first write slot.

  // Simple shared client (both agents share this store)
  function makeSharedClient() {
    return {
      async get(key) {
        if (key === "board") return kvBoard;
        if (key === "board:version") return String(kvVersion);
        return null;
      },
      async set(key, value) {
        if (key === "board") kvBoard = value;
      },
      async incr(key) {
        if (key === "board:version") {
          kvVersion += 1;
          return kvVersion;
        }
        return 1;
      },
    };
  }

  // Agent A: read version (0), mutate, check version (still 0), write -> version=1
  const clientA = makeSharedClient();

  // Agent B's client: on the FIRST version check (during update's conflict detection),
  // pretend version is 1 (Agent A already wrote), triggering a retry.
  // On retry, version check sees current value.
  let agentBVersionChecks = 0;
  const clientB = {
    async get(key) {
      if (key === "board") return kvBoard;
      if (key === "board:version") {
        agentBVersionChecks++;
        // First read = load() call returns 0 (same as Agent A loaded)
        // Second read = conflict check returns 1 (Agent A has written)
        // Third read = load() in retry sees 1
        // Fourth read = conflict check sees 1 still -> safe to write
        if (agentBVersionChecks === 2) {
          // Simulate Agent A having written between B's load and B's conflict check
          // Agent A's save:
          const dataWithA = JSON.parse(kvBoard);
          dataWithA._byA = true;
          kvBoard = JSON.stringify(dataWithA);
          kvVersion = 1;
          return "1"; // conflict: B loaded version 0, but now version is 1
        }
        return String(kvVersion);
      }
      return null;
    },
    async set(key, value) {
      if (key === "board") kvBoard = value;
    },
    async incr(key) {
      if (key === "board:version") {
        kvVersion += 1;
        return kvVersion;
      }
      return 1;
    },
  };

  // Run Agent A's update (straightforward: no conflict)
  await update((data) => {
    data._byA = true;
  }, { client: clientA });

  // Verify Agent A wrote
  assert.strictEqual(kvVersion, 1, "version should be 1 after Agent A's write");
  assert.strictEqual(JSON.parse(kvBoard)._byA, true, "_byA should be set");

  // Reset shared state to simulate both loading before A's write
  // (re-run from scratch to test the retry scenario using clientB's intercept)
  kvBoard = JSON.stringify(SAMPLE_BOARD);
  kvVersion = 0;
  agentBVersionChecks = 0;

  // Run Agent B's update — it will conflict on first attempt (clientB intercepts
  // the version check and simulates Agent A writing mid-flight), then retry
  await update((data) => {
    data._byB = true;
  }, { client: clientB });

  // After retry: board should have _byA (from the simulated A write) AND _byB
  const finalBoard = JSON.parse(kvBoard);
  assert.strictEqual(finalBoard._byA, true, "Agent A's mutation must survive");
  assert.strictEqual(finalBoard._byB, true, "Agent B's mutation must survive");
  assert.strictEqual(kvVersion, 2, "version should be 2 after both writes");
});

test("concurrency: explicit retry path is exercised", async () => {
  /*
   * Verify the retry counter is exercised: we cause exactly 2 conflicts
   * before letting the write through.
   */
  let kvBoard = JSON.stringify(SAMPLE_BOARD);
  let kvVersion = 0;
  let versionGetCalls = 0;
  let conflictsSimulated = 0;
  const NUM_CONFLICTS = 2;

  const client = {
    async get(key) {
      if (key === "board") return kvBoard;
      if (key === "board:version") {
        versionGetCalls++;
        // Every other call to get version (the conflict-check call inside update)
        // simulates a conflict by returning a bumped version.
        // load() calls get() for version once; then update() calls it again for CAS.
        // load() = odd calls, CAS check = even calls.
        const isConflictCheck = versionGetCalls % 2 === 0;
        if (isConflictCheck && conflictsSimulated < NUM_CONFLICTS) {
          conflictsSimulated++;
          kvVersion++; // simulate external write
          return String(kvVersion);
        }
        return String(kvVersion);
      }
      return null;
    },
    async set(key, value) {
      if (key === "board") kvBoard = value;
    },
    async incr() {
      kvVersion++;
      return kvVersion;
    },
  };

  let mutationCount = 0;
  await update((data) => {
    mutationCount++;
    data._attempt = mutationCount;
  }, { client });

  // mutator must have been called NUM_CONFLICTS + 1 times (once per attempt)
  assert.strictEqual(mutationCount, NUM_CONFLICTS + 1,
    "mutator must be called once per attempt (conflicts + final success)");

  const finalBoard = JSON.parse(kvBoard);
  assert.strictEqual(finalBoard._attempt, NUM_CONFLICTS + 1,
    "final board must reflect the last successful mutation attempt");
});

// ---------------------------------------------------------------------------
// 6. Missing credentials error
// ---------------------------------------------------------------------------

test("resolveClient: throws when no client, url, or env vars provided", async () => {
  // Temporarily clear env vars
  const savedUrl = process.env.KV_REST_API_URL;
  const savedToken = process.env.KV_REST_API_TOKEN;
  delete process.env.KV_REST_API_URL;
  delete process.env.KV_REST_API_TOKEN;

  try {
    await assert.rejects(
      () => load({}),
      /KV_REST_API_URL/
    );
  } finally {
    if (savedUrl !== undefined) process.env.KV_REST_API_URL = savedUrl;
    if (savedToken !== undefined) process.env.KV_REST_API_TOKEN = savedToken;
  }
});

// ===========================================================================
// REVIEWER edge-case tests
// ===========================================================================
//
// A realistic, in-memory KV backend whose operations are genuinely async
// (each await yields a microtask turn) and whose INCR is atomic with respect
// to that single-threaded event loop. This is the faithful model the CAS
// claim must hold under: two update() calls driven concurrently via
// Promise.all that interleave at the await boundaries.
//
// No real network: this is a pure in-memory object. No console / process.exit.
// ---------------------------------------------------------------------------

/**
 * A shared backend object shared by clients handed to concurrent update() calls.
 * Every op is async and yields control, so two in-flight update() calls
 * interleave the way they would against a real remote KV.
 */
function makeConcurrentBackend(initialBoard, initialVersion) {
  const state = {
    board: JSON.stringify(initialBoard),
    version: initialVersion == null ? 0 : initialVersion,
  };
  function client() {
    return {
      async get(key) {
        await Promise.resolve(); // yield: let the other update() advance
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
          state.version += 1; // atomic w.r.t. the single-threaded loop
          return state.version;
        }
        return 1;
      },
    };
  }
  return { state, client };
}

// CRITICAL: this is the lost-update probe the spec demands. Two agents update
// the SAME board concurrently. Each sets a distinct top-level marker. For the
// CAS guarantee to hold, BOTH markers must survive in the final persisted board.
//
// This test interleaves them via Promise.all so both can read version V before
// either commits — exactly the window where a naive GET-check-then-SET loses an
// update. If the adapter's concurrency control is real, both survive; if it is
// only a non-atomic check-then-act, one mutation is clobbered and this fails.
test("REVIEWER concurrency: two genuinely-interleaved updates must not lose an update", async () => {
  const backend = makeConcurrentBackend(SAMPLE_BOARD, 0);

  const updateA = update((data) => {
    data._byA = true;
  }, { client: backend.client() });

  const updateB = update((data) => {
    data._byB = true;
  }, { client: backend.client() });

  await Promise.all([updateA, updateB]);

  const finalBoard = JSON.parse(backend.state.board);
  assert.strictEqual(finalBoard._byA, true, "Agent A's mutation must survive");
  assert.strictEqual(finalBoard._byB, true, "Agent B's mutation must survive");
});

// Same probe at higher contention: many concurrent updates each appending a
// distinct id to an array. A correct adapter ends with every id present.
test("REVIEWER concurrency: N interleaved updates all survive (array append)", async () => {
  const seed = { projects: [], log: [] };
  const backend = makeConcurrentBackend(seed, 0);

  const N = 8;
  const ops = [];
  for (let i = 0; i < N; i++) {
    ops.push(update((data) => {
      data.log.push(i);
    }, { client: backend.client() }));
  }
  await Promise.all(ops);

  const finalBoard = JSON.parse(backend.state.board);
  const got = finalBoard.log.slice().sort((a, b) => a - b);
  const want = Array.from({ length: N }, (_, i) => i);
  assert.deepStrictEqual(got, want,
    "every concurrent update's append must survive (no lost update)");
});

// Retry must re-read FRESH data, not reuse the stale snapshot from the first
// attempt. We force one conflict, then assert the mutator on the retry sees
// the value written by the conflicting writer.
test("REVIEWER concurrency: retry re-reads fresh data before mutating", async () => {
  let kvBoard = JSON.stringify({ projects: [], counter: 0 });
  let kvVersion = 0;
  let versionGets = 0;
  const sawCounterOnEachAttempt = [];

  const client = {
    async get(key) {
      if (key === "board") return kvBoard;
      if (key === "board:version") {
        versionGets++;
        // call #2 is the first attempt's CAS check: simulate an external
        // writer that has bumped counter -> 99 and version -> 1.
        if (versionGets === 2) {
          kvBoard = JSON.stringify({ projects: [], counter: 99 });
          kvVersion = 1;
          return "1";
        }
        return String(kvVersion);
      }
      return null;
    },
    async set(key, value) { if (key === "board") kvBoard = value; },
    async incr(key) { if (key === "board:version") { kvVersion++; return kvVersion; } return 1; },
  };

  await update((data) => {
    sawCounterOnEachAttempt.push(data.counter);
    data.counter = data.counter + 1;
  }, { client });

  // First attempt saw 0 then conflicted; retry must have seen the fresh 99.
  assert.deepStrictEqual(sawCounterOnEachAttempt, [0, 99],
    "retry mutator must operate on freshly re-read data");
  assert.strictEqual(JSON.parse(kvBoard).counter, 100,
    "final value must build on the fresh data (99 -> 100), not the stale 0");
});

// A mutator that throws must propagate and must NOT persist a partial write.
test("REVIEWER update: throwing mutator propagates and does not write", async () => {
  const client = freshClient();
  const versionBefore = client._store["board:version"];
  const boardBefore = client._store["board"];

  await assert.rejects(
    () => update(() => { throw new Error("boom"); }, { client }),
    /boom/
  );

  assert.strictEqual(client._store["board:version"], versionBefore,
    "version must be unchanged when mutator throws");
  assert.strictEqual(client._store["board"], boardBefore,
    "board must be unchanged when mutator throws");
});

// An async mutator that rejects must also propagate without persisting.
test("REVIEWER update: rejecting async mutator propagates and does not write", async () => {
  const client = freshClient();
  const boardBefore = client._store["board"];

  await assert.rejects(
    () => update(async () => { throw new Error("async-boom"); }, { client }),
    /async-boom/
  );
  assert.strictEqual(client._store["board"], boardBefore,
    "board must be unchanged when async mutator rejects");
});

// load() against a totally empty KV (no board, no version) must surface the
// missing-board error, not silently succeed.
test("REVIEWER load: empty/missing KV rejects with not-found", async () => {
  const client = makeMockClient({});
  await assert.rejects(() => load({ client }), /not found/);
});

// findTask must tolerate empty epics / empty tasks without throwing.
test("REVIEWER findTask: tolerates empty epics and empty tasks", () => {
  const board = {
    projects: [
      { id: "p", epics: [] },
      { id: "q", epics: [{ id: "e", tasks: [] }] },
    ],
  };
  assert.strictEqual(findTask(board, "anything"), null);
});
