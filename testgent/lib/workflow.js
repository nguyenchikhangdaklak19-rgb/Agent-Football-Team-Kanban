/*
 * workflow — single source of truth cho state machine của board.
 * Pure logic: không đọc/ghi file, không process.exit, không console.
 * Được dùng lại bởi board.js và các task khác.
 */

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

function allowedFrom(workflow, from) {
  return workflow.transitions.filter((x) => x.from === from);
}

/*
 * validateMove — kiểm tra một bước (from, to, by) có hợp lệ không.
 * opts: { testsPass?: boolean }
 * Trả về { ok: true, transition } nếu hợp lệ.
 * Ngược lại { ok: false, error, allowed } với allowed là các transition cho phép từ 'from'.
 */
function validateMove(workflow, from, to, by, opts) {
  opts = opts || {};
  const allowed = allowedFrom(workflow, from);

  // Bước có đúng (from, to) không?
  const stepMatches = workflow.transitions.filter((x) => x.from === from && x.to === to);
  if (stepMatches.length === 0) {
    return {
      ok: false,
      error: 'Bước KHÔNG hợp lệ: "' + from + '" → "' + to + '" không có trong transitions.',
      allowed: allowed
    };
  }

  // Bước đúng nhưng sai vai?
  const tr = stepMatches.find((x) => x.by === by);
  if (!tr) {
    const roles = stepMatches.map((x) => x.by).join(", ");
    return {
      ok: false,
      error: 'Sai vai: bước "' + from + '" → "' + to + '" chỉ cho phép vai (' + roles + '), không phải "' + by + '".',
      allowed: allowed
    };
  }

  // Bước yêu cầu test pass?
  if (tr.requires === "tests_pass" && opts.testsPass !== true) {
    return {
      ok: false,
      error: 'Bước "' + from + '" → "' + to + '" yêu cầu test pass (tests_pass). Cung cấp opts.testsPass === true sau khi test xanh.',
      allowed: allowed
    };
  }

  return { ok: true, transition: tr };
}

/*
 * applyMove — áp dụng một bước lên task (mutate task).
 * opts: { testsPass?: boolean, now: string (ISO) }
 * Nếu không hợp lệ trả { ok: false, error }.
 * Nếu hợp lệ: set task.status, đẩy history entry, set task.reject, trả { ok: true, task, entry }.
 */
function applyMove(workflow, task, to, by, opts) {
  opts = opts || {};
  const from = task.status;
  const res = validateMove(workflow, from, to, by, opts);
  if (!res.ok) return { ok: false, error: res.error };

  const tr = res.transition;
  task.status = to;
  if (tr.flag === "reject") task.reject = true;
  else if (to !== "backlog") task.reject = false;

  task.history = task.history || [];
  const entry = { to: to, by: by, at: opts.now };
  if (tr.flag === "reject") entry.flag = "reject";
  task.history.push(entry);

  return { ok: true, task: task, entry: entry };
}

module.exports = {
  DEFAULT_WORKFLOW,
  validateMove,
  applyMove
};
