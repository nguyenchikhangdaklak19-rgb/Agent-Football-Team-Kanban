/*
 * cli.test.js — integration tests for the board CLI.
 *
 * Drives the real CLI (board.js) via child_process, exactly as an agent would
 * from the shell. Each test copies board-data.json to a fresh temp file and
 * passes --file <tmp>, so the real data file is never mutated.
 *
 * Run:  cd testgent && node --test test/cli.test.js
 */
"use strict";

const { test } = require("node:test");
const assert = require("node:assert");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

// Resolve paths relative to THIS file so the suite runs from any CWD.
const TESTGENT_DIR = path.resolve(__dirname, "..");
const BOARD_JS = path.join(TESTGENT_DIR, "board.js");
const DATA_FILE = path.join(TESTGENT_DIR, "board-data.json");

// Make a fresh temp copy of board-data.json. Returns the temp path.
// The copy lives in os.tmpdir() so the repo data file is never touched.
function freshData() {
  const tmp = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "board-cli-test-")),
    "board-data.json"
  );
  fs.copyFileSync(DATA_FILE, tmp);
  return tmp;
}

// Run the CLI. Returns { code, stdout, stderr }. Never throws on non-zero exit.
function run(args, tmp) {
  const full = tmp ? args.concat(["--file", tmp]) : args.slice();
  try {
    const stdout = execFileSync("node", [BOARD_JS, ...full], {
      cwd: TESTGENT_DIR,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
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

function readData(tmp) {
  return JSON.parse(fs.readFileSync(tmp, "utf8"));
}

// Count history entries for a task id across the whole data file.
function historyLen(data, id) {
  for (const p of data.projects)
    for (const e of p.epics)
      for (const t of e.tasks)
        if (t.id === id) return (t.history || []).length;
  return null;
}

test("valid move succeeds, prints ✓ confirmation, appends history", () => {
  const tmp = freshData();
  // EP-1-T4 starts in "progress"; progress → test by engineer is legal.
  const before = readData(tmp);
  const beforeLen = historyLen(before, "EP-1-T4"); // no history array -> null

  const res = run(["move", "EP-1-T4", "test", "--by", "engineer"], tmp);
  assert.strictEqual(res.code, 0, "expected exit 0, stderr: " + res.stderr);
  assert.match(res.stdout, /✓/, "stdout should contain ✓ confirmation");
  assert.match(res.stdout, /progress\s*→\s*test/, "should show from → to");
  assert.match(res.stdout, /by engineer/);

  // Status actually changed in the file.
  const after = readData(tmp);
  let task;
  for (const p of after.projects)
    for (const e of p.epics)
      for (const t of e.tasks) if (t.id === "EP-1-T4") task = t;
  assert.strictEqual(task.status, "test");

  // A subsequent `show` proves a new history entry was appended.
  const show = run(["show", "EP-1-T4"], tmp);
  assert.strictEqual(show.code, 0);
  // EP-1-T4 had no history initially; after the move there must be at least one
  // entry whose target is the "test" state label.
  const afterLen = historyLen(after, "EP-1-T4");
  assert.ok(afterLen >= 1, "history must have an appended entry");
  if (beforeLen !== null) {
    assert.strictEqual(afterLen, beforeLen + 1, "exactly one entry appended");
  }
  // show output must render the new history row landing in "test" by engineer.
  assert.match(show.stdout, /Đang test/);
  assert.match(show.stdout, /by engineer/);
});

test("illegal move fails, lists allowed transitions, leaves data UNCHANGED", () => {
  const tmp = freshData();
  const original = fs.readFileSync(tmp, "utf8");

  // EP-1-T2 is in "uat". uat → done by engineer is illegal (only po may).
  const res = run(["move", "EP-1-T2", "done", "--by", "engineer"], tmp);
  assert.notStrictEqual(res.code, 0, "illegal move must exit non-zero");
  // Error goes to stderr and lists what IS allowed from the current state.
  assert.match(res.stderr, /✗/, "error marker on stderr");
  assert.match(res.stderr, /uat/, "should mention current state uat");
  // From uat, allowed steps are uat→done (po) and uat→backlog (po, reject).
  assert.match(res.stderr, /uat\s*→\s*done/, "lists the allowed uat→done step");
  assert.match(res.stderr, /uat\s*→\s*backlog/, "lists the allowed uat→backlog step");

  // Data file must be byte-for-byte unchanged: no spurious history written.
  const afterRaw = fs.readFileSync(tmp, "utf8");
  assert.strictEqual(afterRaw, original, "data file must be unchanged");
  const after = readData(tmp);
  assert.strictEqual(historyLen(after, "EP-1-T2"), 4, "history untouched");
});

test("test → uat rejected WITHOUT --tests-pass, succeeds WITH it", () => {
  const tmp = freshData();
  // EP-1-T3 is in "test".
  const without = run(["move", "EP-1-T3", "uat", "--by", "qa"], tmp);
  assert.notStrictEqual(without.code, 0, "must fail without --tests-pass");
  assert.match(without.stderr, /✗/);

  // File unchanged after the failed attempt: still in "test".
  let t3 = null;
  for (const p of readData(tmp).projects)
    for (const e of p.epics)
      for (const tk of e.tasks) if (tk.id === "EP-1-T3") t3 = tk;
  assert.strictEqual(t3.status, "test", "must not have advanced");

  // Now with the flag it succeeds.
  const withFlag = run(
    ["move", "EP-1-T3", "uat", "--by", "qa", "--tests-pass"],
    tmp
  );
  assert.strictEqual(withFlag.code, 0, "expected success, stderr: " + withFlag.stderr);
  assert.match(withFlag.stdout, /✓/);
  assert.match(withFlag.stdout, /test\s*→\s*uat/);

  let after = null;
  for (const p of readData(tmp).projects)
    for (const e of p.epics)
      for (const tk of e.tasks) if (tk.id === "EP-1-T3") after = tk;
  assert.strictEqual(after.status, "uat");
});

test("only po can push uat → done (engineer and qa rejected)", () => {
  // engineer rejected
  const tmp1 = freshData();
  const eng = run(["move", "EP-1-T2", "done", "--by", "engineer"], tmp1);
  assert.notStrictEqual(eng.code, 0, "engineer must not push uat→done");

  // qa rejected
  const tmp2 = freshData();
  const qa = run(["move", "EP-1-T2", "done", "--by", "qa"], tmp2);
  assert.notStrictEqual(qa.code, 0, "qa must not push uat→done");

  // po succeeds
  const tmp3 = freshData();
  const po = run(["move", "EP-1-T2", "done", "--by", "po"], tmp3);
  assert.strictEqual(po.code, 0, "po must push uat→done, stderr: " + po.stderr);
  assert.match(po.stdout, /✓/);
  assert.match(po.stdout, /uat\s*→\s*done/);
  assert.match(po.stdout, /by po/);

  let t2 = null;
  for (const p of readData(tmp3).projects)
    for (const e of p.epics)
      for (const tk of e.tasks) if (tk.id === "EP-1-T2") t2 = tk;
  assert.strictEqual(t2.status, "done");
});

test("list renders projects, epics and tasks", () => {
  const tmp = freshData();
  const res = run(["list"], tmp);
  assert.strictEqual(res.code, 0);
  // Project name and id.
  assert.match(res.stdout, /Ứng dụng To-do/);
  assert.match(res.stdout, /todo-app/);
  // Epic line.
  assert.match(res.stdout, /EP-1/);
  // A specific task id rendered.
  assert.match(res.stdout, /EP-1-T2/);
  // A reject marker is rendered for the rejected task EP-2-T1.
  assert.match(res.stdout, /↺REJECT/);
});

test("show renders task detail and existing history", () => {
  const tmp = freshData();
  // EP-1-T1 is done with a full 5-entry history.
  const res = run(["show", "EP-1-T1"], tmp);
  assert.strictEqual(res.code, 0);
  assert.match(res.stdout, /EP-1-T1/);
  assert.match(res.stdout, /Dựng khung dự án/); // title
  assert.match(res.stdout, /History:/);
  assert.match(res.stdout, /Xong/); // "done" label appears in history/status
  assert.match(res.stdout, /by po/); // last history entry
});

test("adversarial: unknown task id errors with non-zero exit, data untouched", () => {
  const tmp = freshData();
  const original = fs.readFileSync(tmp, "utf8");
  const res = run(["move", "NOPE-T99", "progress", "--by", "engineer"], tmp);
  assert.notStrictEqual(res.code, 0);
  assert.match(res.stderr, /không tồn tại|NOPE-T99/, "should report unknown task");
  assert.strictEqual(
    fs.readFileSync(tmp, "utf8"),
    original,
    "data file unchanged on unknown id"
  );
});

test("adversarial: missing --by errors with non-zero exit", () => {
  const tmp = freshData();
  const res = run(["move", "EP-1-T4", "test"], tmp);
  assert.notStrictEqual(res.code, 0, "missing --by must fail");
  assert.match(res.stderr, /✗/);
  assert.match(res.stderr, /--by/, "error should mention --by");
});

test("adversarial: --by with no value errors", () => {
  const tmp = freshData();
  // `--by` immediately followed by another flag -> value resolves to true.
  const res = run(["move", "EP-1-T4", "test", "--by", "--tests-pass"], tmp);
  assert.notStrictEqual(res.code, 0, "empty --by must fail");
  assert.match(res.stderr, /--by/);
});
