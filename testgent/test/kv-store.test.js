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
 *
 * The eval() method executes a hard-coded CAS matching the CAS_SCRIPT in
 * kv-store.js — this is the correct mock for single-client (non-concurrent)
 * tests.  For concurrency tests see makeConcurrentBackend / makeToctouBackend.
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
    /**
     * eval() — atomic CAS matching kv-store's CAS_SCRIPT semantics.
     * keys[0]=boardKey, keys[1]=versionKey
     * args[0]=expectedVersion, args[1]=newBoardJSON
     * Returns [1, newVersion] on success, [0, storedVersion] on conflict.
     */
    async eval(script, keys, args) {
      const versionKey = keys[1];
      const boardKey = keys[0];
      const stored = versionKey in store ? (Number(store[versionKey]) || 0) : 0;
      const expected = Number(args[0]);
      if (stored !== expected) {
        return [0, stored];
      }
      store[boardKey] = args[1];
      const newv = stored + 1;
      store[versionKey] = String(newv);
      return [1, newv];
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
  // A client whose eval() always returns a conflict (stored version never matches).
  let versionCounter = 0;
  const store = { board: JSON.stringify(SAMPLE_BOARD) };

  const conflictClient = {
    async get(key) {
      if (key === "board") return store.board;
      return String(versionCounter++);
    },
    async set(key, value) {
      if (key === "board") store.board = value;
    },
    async incr(key) {
      versionCounter++;
      return versionCounter;
    },
    async eval(script, keys, args) {
      // Always conflict: bump the stored version so it never matches expected
      versionCounter++;
      return [0, versionCounter];
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
   * Scenario using atomic-CAS EVAL:
   *   - Agent A reads version 0, mutates, calls eval(expected=0) → success (version→1), writes.
   *   - Agent B reads version 0, mutates, calls eval(expected=0) → conflict (stored=1≠0).
   *   - Agent B retries: reads version 1, board has A's data, mutates, eval(expected=1) → success.
   *   - Final board: both _byA and _byB present.
   *
   * We simulate this with shared KV state and a scripted eval() that injects A's
   * write on the first call (simulating A committing before B's eval runs).
   */

  let kvBoard = JSON.stringify(SAMPLE_BOARD);
  let kvVersion = 0;

  // Agent A: straightforward update with no conflict
  const clientA = {
    async get(key) {
      if (key === "board") return kvBoard;
      if (key === "board:version") return String(kvVersion);
      return null;
    },
    async set(key, value) { if (key === "board") kvBoard = value; },
    async incr(key) {
      if (key === "board:version") { kvVersion++; return kvVersion; }
      return 1;
    },
    async eval(script, keys, args) {
      const expected = Number(args[0]);
      if (kvVersion !== expected) return [0, kvVersion];
      kvBoard = args[1];
      kvVersion++;
      return [1, kvVersion];
    },
  };

  await update((data) => { data._byA = true; }, { client: clientA });

  assert.strictEqual(kvVersion, 1, "version should be 1 after Agent A's write");
  assert.strictEqual(JSON.parse(kvBoard)._byA, true, "_byA should be set after Agent A");

  // Reset for Agent B's scenario
  kvBoard = JSON.stringify(SAMPLE_BOARD);
  kvVersion = 0;

  // Agent B's client: first eval() returns conflict (simulating A committed first),
  // then injects A's board write, retry succeeds.
  let agentBEvalCalls = 0;
  const clientB = {
    async get(key) {
      if (key === "board") return kvBoard;
      if (key === "board:version") return String(kvVersion);
      return null;
    },
    async set(key, value) { if (key === "board") kvBoard = value; },
    async incr(key) { if (key === "board:version") { kvVersion++; return kvVersion; } return 1; },
    async eval(script, keys, args) {
      agentBEvalCalls++;
      if (agentBEvalCalls === 1) {
        // Simulate Agent A committing atomically (board + version) before B's eval lands
        const dataWithA = JSON.parse(kvBoard);
        dataWithA._byA = true;
        kvBoard = JSON.stringify(dataWithA);
        kvVersion = 1; // A's eval bumped version to 1
        return [0, kvVersion]; // conflict: expected=0, stored=1
      }
      // Retry: normal CAS
      const expected = Number(args[0]);
      if (kvVersion !== expected) return [0, kvVersion];
      kvBoard = args[1];
      kvVersion++;
      return [1, kvVersion];
    },
  };

  await update((data) => { data._byB = true; }, { client: clientB });

  const finalBoard = JSON.parse(kvBoard);
  assert.strictEqual(finalBoard._byA, true, "Agent A's mutation must survive");
  assert.strictEqual(finalBoard._byB, true, "Agent B's mutation must survive");
  assert.strictEqual(kvVersion, 2, "version should be 2 after both writes");
});

test("concurrency: explicit retry path is exercised", async () => {
  /*
   * Verify the retry counter is exercised: cause exactly 2 conflicts (eval()
   * returns [0, ...]) before letting the write through (eval returns [1, ...]).
   */
  let kvBoard = JSON.stringify(SAMPLE_BOARD);
  let kvVersion = 0;
  let conflictsSimulated = 0;
  const NUM_CONFLICTS = 2;

  const client = {
    async get(key) {
      if (key === "board") return kvBoard;
      if (key === "board:version") return String(kvVersion);
      return null;
    },
    async set(key, value) {
      if (key === "board") kvBoard = value;
    },
    async incr(key) {
      if (key === "board:version") { kvVersion++; return kvVersion; }
      return 1;
    },
    async eval(script, keys, args) {
      if (conflictsSimulated < NUM_CONFLICTS) {
        conflictsSimulated++;
        kvVersion += 2; // external writer bumped ahead
        return [0, kvVersion]; // conflict
      }
      // Normal CAS
      const expected = Number(args[0]);
      if (kvVersion !== expected) return [0, kvVersion];
      kvBoard = args[1];
      kvVersion++;
      return [1, kvVersion];
    },
  };

  let mutationCount = 0;
  await update((data) => {
    mutationCount++;
    data._attempt = mutationCount;
  }, { client });

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
// (each await yields a microtask turn).  The key invariant:
//
//   • get/set/incr each yield ONE tick — modelling individual round-trips.
//   • eval() yields ONE tick for the network round-trip, then executes the
//     entire CAS body synchronously WITHOUT any additional yield — exactly
//     like real Redis, where a Lua script runs atomically to completion
//     inside the single-threaded server, invisible to any concurrent client.
//
// This is the faithful serialized-Redis model:
//   - With the old INCR-then-SET design (two round-trips) a concurrent GET
//     can land between the INCR and the SET and observe stale data →
//     the loser's retry can clobber the winner's write.
//   - With the new single-EVAL design, no command can interleave during the
//     CAS body, so the TOCTOU window is closed.
// ---------------------------------------------------------------------------

/**
 * makeConcurrentBackend(initialBoard, initialVersion)
 *
 * Returns { state, client }.  client() produces a new client handle sharing
 * the same state.  Pass a different client() call to each concurrent update().
 *
 * get / set / incr — each yield one microtask tick (models individual I/O).
 * eval             — yields one tick (network RTT), then runs CAS atomically
 *                    with NO further yield (models Redis Lua atomicity).
 */
function makeConcurrentBackend(initialBoard, initialVersion) {
  const state = {
    board: JSON.stringify(initialBoard),
    version: initialVersion == null ? 0 : initialVersion,
  };

  function client() {
    return {
      async get(key) {
        await Promise.resolve(); // one tick — lets other coroutines advance
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
      /**
       * eval — ONE tick for the network round-trip, then CAS runs synchronously.
       *
       * The synchronous body models Redis Lua atomicity: after the single yield
       * (representing the network RTT), the compare-and-swap executes without
       * any further await, so no other coroutine can observe an intermediate
       * state between the version-check and the board-write.
       */
      async eval(script, keys, args) {
        await Promise.resolve(); // network RTT — other coroutines may advance here
        // CAS body runs synchronously (atomic w.r.t. the event loop):
        const expected = Number(args[0]);
        if (state.version !== expected) {
          return [0, state.version]; // conflict
        }
        state.board = args[1];
        state.version += 1;
        return [1, state.version]; // success
      },
    };
  }

  return { state, client };
}

// CRITICAL: two genuinely-interleaved update()s must not lose either mutation.
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

// Higher contention: N concurrent updates each appending a distinct id.
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

// Retry must re-read FRESH data, not reuse the stale snapshot.
test("REVIEWER concurrency: retry re-reads fresh data before mutating", async () => {
  let kvBoard = JSON.stringify({ projects: [], counter: 0 });
  let kvVersion = 0;
  let evalCalls = 0;
  const sawCounterOnEachAttempt = [];

  const client = {
    async get(key) {
      if (key === "board") return kvBoard;
      if (key === "board:version") return String(kvVersion);
      return null;
    },
    async set(key, value) { if (key === "board") kvBoard = value; },
    async incr(key) {
      if (key === "board:version") { kvVersion++; return kvVersion; }
      return 1;
    },
    async eval(script, keys, args) {
      evalCalls++;
      if (evalCalls === 1) {
        // First CAS attempt: simulate an external writer that committed counter=99
        // atomically (board + version bump) while our eval was in-flight.
        kvBoard = JSON.stringify({ projects: [], counter: 99 });
        kvVersion = 2; // external writer consumed slot 1, we expected 0
        return [0, kvVersion]; // conflict
      }
      // Retry: normal CAS
      const expected = Number(args[0]);
      if (kvVersion !== expected) return [0, kvVersion];
      kvBoard = args[1];
      kvVersion++;
      return [1, kvVersion];
    },
  };

  await update((data) => {
    sawCounterOnEachAttempt.push(data.counter);
    data.counter = data.counter + 1;
  }, { client });

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

// load() against an empty KV must surface the missing-board error.
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

// ---------------------------------------------------------------------------
// RE-REVIEW edge cases for the Lua EVAL atomic-CAS design
// ---------------------------------------------------------------------------

// With atomic EVAL, if the eval itself throws (e.g. network error during the
// single round-trip), neither the board nor the version is modified — no
// dangling version is left behind.  Future writers can still proceed normally.
test("RE-REVIEW update: eval() failing propagates AND does not brick future writes", async () => {
  let kvBoard = JSON.stringify(SAMPLE_BOARD);
  let kvVersion = 0;
  let failNextEval = true;

  const client = {
    async get(key) {
      if (key === "board") return kvBoard;
      if (key === "board:version") return String(kvVersion);
      return null;
    },
    async set(key, value) { if (key === "board") kvBoard = value; },
    async incr(key) {
      if (key === "board:version") { kvVersion++; return kvVersion; }
      return 1;
    },
    async eval(script, keys, args) {
      if (failNextEval) {
        failNextEval = false;
        throw new Error("network blip on EVAL");
      }
      // Normal CAS
      const expected = Number(args[0]);
      if (kvVersion !== expected) return [0, kvVersion];
      kvBoard = args[1];
      kvVersion++;
      return [1, kvVersion];
    },
  };

  // First update: mutator succeeds, eval() throws — nothing is written.
  await assert.rejects(
    () => update((data) => { data._first = true; }, { client }),
    /network blip on EVAL/,
    "a failed eval must propagate, not be silently swallowed"
  );

  // Version unchanged (eval was atomic — it either commits both or nothing).
  assert.strictEqual(kvVersion, 0, "version must be unchanged after eval failure");
  assert.strictEqual(JSON.parse(kvBoard)._first, undefined,
    "board must be unchanged after eval failure");

  // Subsequent update must still succeed: loads version 0, eval(expected=0) → success.
  await update((data) => { data._second = true; }, { client });
  const finalBoard = JSON.parse(kvBoard);
  assert.strictEqual(finalBoard._second, true,
    "a later update must commit normally after an earlier eval failure");
  assert.strictEqual(kvVersion, 1, "version lines up for the recovering writer");
});

// A mutator that throws on a LATER call must not corrupt state.
// With EVAL, the mutator runs BEFORE eval() is called, so a throwing mutator
// never reaches eval() and reserves nothing — no dangling state possible.
test("RE-REVIEW update: throwing mutator after a prior success leaves state writable", async () => {
  const client = freshClient();

  // 1) successful update
  await update((data) => { data._ok = true; }, { client });
  const versionAfterOk = client._store["board:version"];
  const boardAfterOk = client._store["board"];

  // 2) update whose mutator throws — must NOT reserve a slot or write
  await assert.rejects(
    () => update(() => { throw new Error("late-boom"); }, { client }),
    /late-boom/
  );
  assert.strictEqual(client._store["board:version"], versionAfterOk,
    "throwing mutator must not bump the version (eval never reached)");
  assert.strictEqual(client._store["board"], boardAfterOk,
    "throwing mutator must not alter the board");

  // 3) a further update must succeed normally
  await update((data) => { data._after = true; }, { client });
  const { data } = await load({ client });
  assert.strictEqual(data._ok, true, "earlier successful mutation survived");
  assert.strictEqual(data._after, true, "later update committed cleanly");
});

// MAX_RETRIES exhaustion must throw a CLEAR error.
test("RE-REVIEW update: retry exhaustion throws clear error and never silently drops", async () => {
  let kvBoard = JSON.stringify(SAMPLE_BOARD);
  let kvVersion = 0;
  let mutatorCalls = 0;

  const alwaysConflict = {
    async get(key) {
      if (key === "board") return kvBoard;
      if (key === "board:version") return String(kvVersion);
      return null;
    },
    async set(key, value) { if (key === "board") kvBoard = value; },
    async incr(key) {
      if (key === "board:version") { kvVersion += 2; return kvVersion; }
      return 1;
    },
    async eval(script, keys, args) {
      // Always conflict: advance version so it never matches expected
      kvVersion += 2;
      return [0, kvVersion];
    },
  };

  await assert.rejects(
    () => update((data) => { mutatorCalls++; data._never = true; }, { client: alwaysConflict }),
    /failed after 20 retries/,
    "exhaustion must surface a clear, bounded-retry error"
  );

  assert.strictEqual(JSON.parse(kvBoard)._never, undefined,
    "no board write may leak through on permanent conflict");
  assert.strictEqual(mutatorCalls, 20,
    "mutator invoked exactly MAX_RETRIES times (bounded retry loop)");
});

// Direct save() interleaved with update(): save() is an unconditional write.
// A save() that bumps the version mid-update causes the eval() to conflict,
// forcing a retry — the update() survives on top of the fresh (saved) data.
test("RE-REVIEW save() bumping version mid-update forces a retry, update still survives", async () => {
  let kvBoard = JSON.stringify({ projects: [], log: [] });
  let kvVersion = 0;
  let firstEval = true;

  const client = {
    async get(key) {
      if (key === "board") return kvBoard;
      if (key === "board:version") return String(kvVersion);
      return null;
    },
    async set(key, value) { if (key === "board") kvBoard = value; },
    async incr(key) {
      if (key === "board:version") { kvVersion++; return kvVersion; }
      return 1;
    },
    async eval(script, keys, args) {
      if (firstEval) {
        firstEval = false;
        // Simulate a concurrent direct save() landing before our eval executes:
        // save() wrote the board and bumped version to 1.
        const b = JSON.parse(kvBoard);
        b.log.push("from-save");
        kvBoard = JSON.stringify(b);
        kvVersion = 1; // save() consumed slot 0→1
        return [0, kvVersion]; // conflict: our expected=0, stored=1
      }
      // Retry CAS
      const expected = Number(args[0]);
      if (kvVersion !== expected) return [0, kvVersion];
      kvBoard = args[1];
      kvVersion++;
      return [1, kvVersion];
    },
  };

  await update((data) => { data.log.push("from-update"); }, { client });

  const finalBoard = JSON.parse(kvBoard);
  assert.ok(finalBoard.log.includes("from-save"),
    "the concurrent direct save()'s write must survive");
  assert.ok(finalBoard.log.includes("from-update"),
    "the update()'s mutation must survive (retried on top of fresh data)");
});

// ===========================================================================
// DECISIVE TOCTOU TEST — proves the old INCR-then-SET design has the bug
// and the new single-EVAL design does not.
//
// This test uses a backend that faithfully models a SERIALIZED REDIS server:
//   • Each command is served one at a time (single-channel serialization).
//   • Between any two commands, other clients' commands can be interleaved.
//   • EVAL runs atomically: once a client's eval starts, it completes before
//     any other client's command is served.
//
// The TOCTOU scenario that breaks INCR-then-SET:
//   1. A and B both call load() → both read version=0, board=state0.
//   2. A calls incr(version) → gets 1 (wins slot).
//   3. B calls incr(version) → gets 2 (conflict, schedules retry).
//   4. B's RETRY load() GET(board) executes NOW — BEFORE A's SET(board).
//      B reads stale board (state0).
//   5. A calls set(board) → commits state_A, version=1.
//   6. B's load() reads version=1 (from GET(version)).
//      But B already read state0 from step 4, so B has (data=state0, version=1).
//   7. B calls incr(version) → gets 2 (=1+1), wins slot.
//   8. B calls set(board) → commits state0+B mutation, CLOBBERING A's write!
//
// With the EVAL design, step 4 cannot interleave inside A's eval (which does
// read-version + write-board + incr-version in one atomic server-side step).
// ===========================================================================

/**
 * makeToctouBackend()
 *
 * Returns a backend that precisely models the TOCTOU interleave:
 *   - Commands from different clients are interleaved at await boundaries.
 *   - incr() and set() are each TWO separate round-trips (like the old design).
 *   - eval() is a SINGLE atomic round-trip (like the new design).
 *
 * The backend exposes hooks to force the exact "B's GET(board) executes after
 * A's INCR but before A's SET" interleave.
 *
 * It is also used to prove that the old design (simulated via manual
 * incr+set calls) WOULD fail in the same scenario.
 */
function makeToctouBackend(initialBoard) {
  const state = {
    board: JSON.stringify(initialBoard),
    version: 0,
  };

  // Hooks for forcing the bad interleave in the old-design simulation
  const hooks = {
    afterIncr: null, // called after incr() modifies state — inject B's stale GET here
  };

  function client() {
    return {
      async get(key) {
        await Promise.resolve();
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
          const result = state.version;
          if (hooks.afterIncr) await hooks.afterIncr(state);
          return result;
        }
        return 1;
      },
      // eval: ONE tick for network, then CAS runs synchronously (atomic)
      async eval(script, keys, args) {
        await Promise.resolve(); // network RTT
        // Synchronous CAS body — no yield, no interleave possible:
        const expected = Number(args[0]);
        if (state.version !== expected) {
          return [0, state.version];
        }
        state.board = args[1];
        state.version += 1;
        return [1, state.version];
      },
    };
  }

  return { state, hooks, client };
}

/*
 * PROOF OF DEFECT: simulate the old INCR-then-SET design using the
 * makeToctouBackend and verify the lost-update bug is reproducible.
 *
 * We use an explicit state machine to force the exact TOCTOU interleave:
 *   A: load(version=0, board=s0)
 *   B: load(version=0, board=s0)
 *   A: incr() → 1
 *       [B's retry GET(board) runs HERE: reads s0 before A's SET]
 *   A: set(board=s_A, version=1)
 *   B's retry: load returns (version=1, board=s0) — STALE board!
 *   B: incr() → 2 (= 1+1, wins slot)
 *   B: set(board=s0+B) — CLOBBERS A!
 *
 * This test asserts the lost-update DOES happen with the old pattern,
 * confirming the bug was real.
 */
test("TOCTOU PROOF: old INCR-then-SET design loses an update in the TOCTOU window", async () => {
  const backend = makeToctouBackend(SAMPLE_BOARD);

  // Simulate the old two-round-trip update() loop manually:
  // Reads version from load(), then INCR-reserves, then SET.
  async function oldUpdate(mutatorFn, onConflict) {
    // Step 1: read
    const boardRaw = await backend.client().get("board");
    const versionRaw = await backend.client().get("board:version");
    const data = JSON.parse(boardRaw);
    const version = Number(versionRaw) || 0;

    // Step 2: mutate
    const clone = JSON.parse(JSON.stringify(data));
    mutatorFn(clone);
    const newData = JSON.stringify(clone);

    // Step 3: INCR-reserve
    const c = backend.client();
    const next = await c.incr("board:version");
    if (next !== version + 1) {
      // Conflict — retry (simplified: one retry with fresh read)
      if (onConflict) await onConflict();
      const boardRaw2 = await backend.client().get("board");
      const versionRaw2 = await backend.client().get("board:version");
      const data2 = JSON.parse(boardRaw2);
      const version2 = Number(versionRaw2) || 0;
      const clone2 = JSON.parse(JSON.stringify(data2));
      mutatorFn(clone2);
      const newData2 = JSON.stringify(clone2);
      const next2 = await backend.client().incr("board:version");
      if (next2 === version2 + 1) {
        await backend.client().set("board", newData2);
      }
      return;
    }

    // Step 4: SET (but gap exists here — another client can read board before this)
    await backend.client().set("board", newData);
  }

  // Force the TOCTOU: after A's INCR (wins slot 1), B's retry GET(board)
  // reads the board synchronously (still state0) before A's SET executes.
  let bStaleBoard = null;
  let bStaleVersion = null;

  // We'll capture B's stale read in a hook triggered after A's INCR
  backend.hooks.afterIncr = async (state) => {
    // This runs synchronously INSIDE A's incr(), after version is bumped to 1
    // but BEFORE A's subsequent set() call.
    // Capture what B's retry load() would see right now:
    bStaleBoard = state.board;    // still s0 — A hasn't set() yet
    bStaleVersion = state.version; // 1 (A's INCR landed)
    backend.hooks.afterIncr = null; // only intercept once
  };

  // Run A: load → mutate → incr(gets 1, hook fires) → set
  await oldUpdate((data) => { data._byA = true; });

  // A's write has landed. Now simulate B's stale-read retry:
  // B read (board=stale_s0, version=1) from inside the hook.
  // B's retry now uses that stale board + current version.
  if (bStaleBoard !== null) {
    const staleData = JSON.parse(bStaleBoard);
    staleData._byB = true;  // B's mutation on stale board
    const newBoard = JSON.stringify(staleData);

    // B does incr() → gets 2 (= bStaleVersion 1 + 1 → B "wins" the slot)
    const next = await backend.client().incr("board:version");
    assert.strictEqual(next, bStaleVersion + 1,
      "B's retry incr must equal staleVersion+1 (confirming it wins the slot)");

    // B does set() — clobbers A's write with stale+B data
    await backend.client().set("board", newBoard);
  }

  // With the old design, A's write is LOST: final board has _byB but NOT _byA
  const finalBoard = JSON.parse(backend.state.board);
  assert.strictEqual(finalBoard._byB, true, "B's mutation is present (B wrote last)");
  assert.strictEqual(finalBoard._byA, undefined,
    "TOCTOU BUG CONFIRMED: A's mutation was clobbered by B's stale-board write");
});

/*
 * DECISIVE TEST: The new single-EVAL design must pass 200 iterations of
 * fully-interleaved concurrent updates with zero lost updates.
 *
 * Uses makeConcurrentBackend whose eval() is atomic (no additional yield
 * inside the CAS body).  Two concurrent update() calls via Promise.all
 * interleave at every await boundary except inside eval's CAS body.
 *
 * With the old INCR-then-SET design + the concurrent backend's ticks,
 * lost updates can occur (the TOCTOU proof above demonstrates why).
 * With the new EVAL design, no interleave is possible inside the CAS body,
 * so both mutations always survive.
 *
 * 200 iterations ensures this isn't passing by microtask-scheduling luck.
 */
test("DECISIVE: atomic-EVAL CAS passes 200 iterations of forced-concurrent updates with zero lost updates", async () => {
  let lostUpdates = 0;

  for (let iter = 0; iter < 200; iter++) {
    const backend = makeConcurrentBackend(SAMPLE_BOARD, 0);

    const updateA = update((data) => { data._byA = true; }, { client: backend.client() });
    const updateB = update((data) => { data._byB = true; }, { client: backend.client() });

    await Promise.all([updateA, updateB]);

    const final = JSON.parse(backend.state.board);
    if (!final._byA || !final._byB) lostUpdates++;
  }

  assert.strictEqual(lostUpdates, 0,
    "Expected 0 lost updates across 200 iterations; atomic EVAL CAS must hold every time");
});

/*
 * DECISIVE N-CONCURRENT: 200 iterations of N=6 concurrent update()s each
 * appending a distinct id to an array.  All N ids must appear in every run.
 */
test("DECISIVE: atomic-EVAL CAS survives 200 iterations of N=6 concurrent appends with zero lost updates", async () => {
  const N = 6;
  let failures = 0;

  for (let iter = 0; iter < 200; iter++) {
    const seed = { projects: [], log: [] };
    const backend = makeConcurrentBackend(seed, 0);

    const ops = [];
    for (let i = 0; i < N; i++) {
      ops.push(update((data) => { data.log.push(i); }, { client: backend.client() }));
    }
    await Promise.all(ops);

    const final = JSON.parse(backend.state.board);
    const got = final.log.slice().sort((a, b) => a - b);
    const want = Array.from({ length: N }, (_, i) => i);
    const ok = got.length === want.length && got.every((v, i) => v === want[i]);
    if (!ok) failures++;
  }

  assert.strictEqual(failures, 0,
    "Expected 0 failures across 200 iterations; all " + N + " mutations must survive every run");
});
