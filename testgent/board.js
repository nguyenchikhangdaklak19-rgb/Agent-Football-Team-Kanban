#!/usr/bin/env node
/*
 * board — công cụ quản lý trạng thái task cho đội agent.
 * Enforce state machine trong board-data.json: chỉ cho bước hợp lệ, đúng vai,
 * và tự ghi history. KHÔNG sửa board-data.json bằng tay.
 *
 * Dùng: node board.js <lệnh> ...   (xem "node board.js help")
 */
const fs = require("fs");
const path = require("path");

const argv = process.argv.slice(2);
const cmd = argv[0];

function getFlag(name, def) {
  const i = argv.indexOf("--" + name);
  if (i === -1) return def;
  const v = argv[i + 1];
  return (v && !v.startsWith("--")) ? v : true;
}
function hasFlag(name) { return argv.indexOf("--" + name) !== -1; }

const FILE = path.resolve(typeof getFlag("file") === "string" ? getFlag("file") : "board-data.json");

const fail = (m) => { console.error("✗ " + m); process.exit(1); };
const ok = (m) => { console.log("✓ " + m); };
const now = () => new Date().toISOString();

function load() {
  if (!fs.existsSync(FILE)) fail("Không tìm thấy " + FILE + '. Chạy "node board.js init" trước.');
  return JSON.parse(fs.readFileSync(FILE, "utf8"));
}
function save(d) { fs.writeFileSync(FILE, JSON.stringify(d, null, 2) + "\n"); }

function findTask(d, id) {
  for (const p of d.projects)
    for (const e of p.epics)
      for (const t of e.tasks)
        if (t.id === id) return { project: p, epic: e, task: t };
  return null;
}

const DEFAULT_WORKFLOW = {
  states: ["backlog", "progress", "test", "uat", "done"],
  labels: { backlog: "Chờ làm", progress: "Đang làm", test: "Đang test", uat: "UAT", done: "Xong" },
  transitions: [
    { from: "backlog", to: "progress", by: "engineer" },
    { from: "progress", to: "test", by: "engineer" },
    { from: "test", to: "uat", by: "qa", requires: "tests_pass" },
    { from: "test", to: "backlog", by: "qa", flag: "reject" },
    { from: "uat", to: "done", by: "po" },
    { from: "uat", to: "backlog", by: "po", flag: "reject" }
  ],
  rules: [
    "Mọi thay đổi trạng thái phải đi qua công cụ board (không sửa file trực tiếp).",
    "Chỉ chấp nhận bước có trong 'transitions'. Bước không hợp lệ bị từ chối.",
    "Quyền chuyển theo 'by': engineer / qa / po. Chỉ 'po' được đẩy sang 'done'.",
    "Bước test -> uat yêu cầu test pass (requires: tests_pass)."
  ]
};

// ---------- move ----------
if (cmd === "move") {
  const id = argv[1], to = argv[2], by = getFlag("by");
  if (!id || !to || by === undefined) fail("Cú pháp: node board.js move <task-id> <status> --by <engineer|qa|po> [--tests-pass]");
  if (by === true) fail("Thiếu giá trị cho --by (engineer | qa | po).");
  const d = load();
  const f = findTask(d, id);
  if (!f) fail("Task không tồn tại: " + id);
  const from = f.task.status;
  const tr = d.workflow.transitions.find((x) => x.from === from && x.to === to && x.by === by);
  if (!tr) {
    const allowed = d.workflow.transitions
      .filter((x) => x.from === from)
      .map((x) => "  " + from + " → " + x.to + "  (--by " + x.by + (x.requires ? ", cần " + x.requires : "") + (x.flag ? ", " + x.flag : "") + ")");
    fail("Bước KHÔNG hợp lệ: " + from + " → " + to + " --by " + by + "\nTừ \"" + from + "\" chỉ cho phép:\n" + (allowed.length ? allowed.join("\n") : "  (không có — đây là trạng thái cuối)"));
  }
  if (tr.requires === "tests_pass" && !hasFlag("tests-pass"))
    fail("Bước " + from + " → " + to + " yêu cầu test pass. Thêm cờ --tests-pass sau khi toàn bộ test xanh.");
  f.task.status = to;
  if (tr.flag === "reject") f.task.reject = true;
  else if (to !== "backlog") f.task.reject = false;
  f.task.history = f.task.history || [];
  const entry = { to, by, at: now() };
  if (tr.flag) entry.flag = tr.flag;
  f.task.history.push(entry);
  save(d);
  ok(id + ": " + from + " → " + to + (tr.flag ? " [" + tr.flag + "]" : "") + " (by " + by + ")");
  process.exit(0);
}

// ---------- list ----------
if (cmd === "list") {
  const d = load();
  const fp = getFlag("project"), fe = getFlag("epic"), fst = getFlag("status");
  const L = d.workflow.labels;
  d.projects.forEach((p) => {
    if (fp && fp !== p.id) return;
    console.log("\n■ " + p.name + "  (" + p.id + ")");
    p.epics.forEach((e) => {
      if (fe && fe !== e.id) return;
      console.log("  ▸ " + e.id + " — " + e.title);
      e.tasks.forEach((t) => {
        if (fst && fst !== t.status) return;
        console.log("     " + t.id.padEnd(10) + " [" + (L[t.status] || t.status).padEnd(9) + "] " +
          (t.agent || "").padEnd(9) + t.title + (t.reject ? "  ↺REJECT" : ""));
      });
    });
  });
  process.exit(0);
}

// ---------- show ----------
if (cmd === "show") {
  const id = argv[1];
  if (!id) fail("Cú pháp: node board.js show <task-id>");
  const d = load();
  const f = findTask(d, id);
  if (!f) fail("Task không tồn tại: " + id);
  const t = f.task, L = d.workflow.labels;
  console.log(t.id + " — " + t.title);
  console.log("  Project: " + f.project.name + "  |  Epic: " + f.epic.id + " " + f.epic.title);
  console.log("  Agent: " + t.agent + "  |  Status: " + (L[t.status] || t.status) + (t.reject ? "  (reject)" : ""));
  if (t.deps) console.log("  Deps: " + t.deps.join(", "));
  console.log("  History:");
  (t.history || []).forEach((h) => console.log("    " + h.at + "  → " + (L[h.to] || h.to) + "  by " + h.by + (h.flag ? "  [" + h.flag + "]" : "")));
  process.exit(0);
}

// ---------- add-task ----------
if (cmd === "add-task") {
  const d = load();
  const pj = getFlag("project"), ep = getFlag("epic"), title = getFlag("title"),
    agent = typeof getFlag("agent") === "string" ? getFlag("agent") : "engineer", deps = getFlag("deps");
  if (!pj || !ep || !title || title === true) fail('Cú pháp: node board.js add-task --project <id> --epic <id> --title "..." [--agent ..] [--deps "a,b"]');
  const P = d.projects.find((p) => p.id === pj); if (!P) fail("Project không tồn tại: " + pj);
  const E = P.epics.find((e) => e.id === ep); if (!E) fail("Epic không tồn tại: " + ep);
  const id = ep + "-T" + (E.tasks.length + 1);
  const t = { id, title, agent, status: "backlog", history: [{ to: "backlog", by: "tech-lead", at: now() }] };
  if (typeof deps === "string") t.deps = deps.split(",").map((s) => s.trim());
  E.tasks.push(t);
  save(d);
  ok("Tạo task " + id + " (backlog) trong " + ep);
  process.exit(0);
}

// ---------- create-epic ----------
if (cmd === "create-epic") {
  const d = load();
  const pj = getFlag("project"), id = getFlag("id"), title = getFlag("title"), spec = getFlag("spec");
  if (!pj || !id || !title || title === true) fail('Cú pháp: node board.js create-epic --project <id> --id <EP-x> --title "..." [--spec path]');
  const P = d.projects.find((p) => p.id === pj); if (!P) fail("Project không tồn tại: " + pj);
  if (P.epics.find((e) => e.id === id)) fail("Epic đã tồn tại: " + id);
  const e = { id, title, tasks: [] };
  if (typeof spec === "string") e.spec = spec;
  P.epics.push(e);
  save(d);
  ok("Tạo epic " + id + " trong " + pj);
  process.exit(0);
}

// ---------- init ----------
if (cmd === "init") {
  if (fs.existsSync(FILE)) fail(FILE + " đã tồn tại.");
  save({ workflow: DEFAULT_WORKFLOW, projects: [] });
  ok("Tạo " + FILE);
  process.exit(0);
}

// ---------- help ----------
console.log(`board — quản lý trạng thái task, enforce state machine.

Lệnh:
  node board.js move <task-id> <status> --by <engineer|qa|po> [--tests-pass]
  node board.js list  [--project <id>] [--epic <id>] [--status <s>]
  node board.js show  <task-id>
  node board.js add-task    --project <id> --epic <id> --title "..." [--agent ..] [--deps "a,b"]
  node board.js create-epic --project <id> --id <EP-x> --title "..." [--spec path]
  node board.js init
  (thêm --file <path> để trỏ tới board-data.json khác; mặc định ./board-data.json)

Luồng:  backlog → progress → test → uat → done   (reject → backlog)
Quyền:  engineer (backlog→progress→test) · qa (test→uat/reject) · po (uat→done/reject)`);
process.exit(0);
