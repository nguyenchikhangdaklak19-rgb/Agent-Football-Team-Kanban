# Acceptance Checklist — Team Board (E2 Final Acceptance)

Reviewer/QA final acceptance, performed by driving the **running product**
(HTTP API + served UI assets), not by reading code alone.

- Branch: `qa/E2-acceptance`
- Product under test: `testgent/server.js`, `testgent/public/*`, `testgent/lib/*`, `testgent/board-data.json`
- How run: `cp board-data.json /tmp/e2.json && BOARD_FILE=/tmp/e2.json PORT=3811 node server.js`
  then driven with Node's `http` client against a throwaway data copy.
- Automated suite: `npm test` → **tests 83 · pass 83 · fail 0** (workflow + server + cli + e2e).
- Date: 2026-06-18

Legend: PASS = verified against the running product. The "Evidence" column gives
the actual request + observed response, or the served asset / code location that
implements the criterion (combined with the matching live API behaviour).

---

## A. Acceptance Criteria (PO nghiệm thu)

### A1. Mở bảng → thấy danh sách dự án (tabs) — **PASS**
- API: `GET /api/board` → 200, `projects` = `todo-app:Ứng dụng To-do | landing:Landing page`.
- UI: served `index.html` has `<nav class="tabs" id="tabs">`; `board-client.js` `renderTabs()`
  builds one `<button class="tab">` per project from the live `/api/board` payload and wires
  `onclick` to switch projects. Evidence combination = data present + renderer present.

### A2. Chọn dự án → thấy Epic kèm thanh tiến độ + số task xong, và bảng kanban 5 cột — **PASS**
- API: `todo-app` returns epics `EP-1(4 tasks), EP-2(3 tasks)`.
- UI epics+progress: `renderEpics()` renders an `epic-chip` per epic with a progress bar
  `<span class="mini"><i style="width:<pct>%"></i></span>` and a `<d>/<tot>` "xong" count via `prog()`.
- UI 5 columns: `COLUMNS = [backlog "Chờ làm", progress "Đang làm", test "Đang test", uat "UAT", done "Xong"]`,
  rendered by `renderBoard()` as five `<section class="col">`. Column titles/order match the spec exactly.

### A3. Bấm vào một Epic → bảng chỉ còn task của Epic đó; có lựa chọn "Tất cả" — **PASS**
- UI: `renderEpics()` prepends `epicChip("all", "Tất cả tính năng", ...)`; each chip's `onclick`
  sets `state.epic` and `renderBoard()` filters rows with
  `state.epic === "all" || r.ep.id === state.epic`. "Tất cả" shows the aggregate, an epic id filters to it.

### A4. Mỗi thẻ hiển thị: tên việc, người phụ trách, tính năng, phụ thuộc — **PASS**
- Data sample `EP-1-T2` = `{title:"API + mô hình dữ liệu công việc", agent:"engineer", deps:["EP-1-T1"]}`.
- UI `renderCard()` renders: title (`.title`), assignee via `AGENTS[t.agent]` →
  Tech Lead/Engineer/Reviewer (`.assignee`), epic title (`.tag epic`), and each dep as a
  `.tag` (`✓ <dep>` when `depMet`, else `Chờ <dep>`). All four fields present.

### A5. Task ở cột UAT → thẻ có nút Duyệt và Trả lại — **PASS**
- UI: `renderCard()` only when `t.status === "uat"` appends `.btn-approve "Duyệt"` and
  `.btn-reject "Trả lại"`. Live UAT cards exist (e.g. `EP-1-T2`, `LP-1-T2` start in `uat`).

#### A5a. Bấm Duyệt → task chuyển sang Xong — **PASS**
- Button calls `poAction(id,"done",btn)` → `POST /api/move {by:"po",to:"done"}`.
- Live: `POST /api/move {id:"LP-1-T2",to:"done",by:"po"}` → **200 `{ok:true, task.status:"done"}`**.

#### A5b. Bấm Trả lại → task về Chờ làm + nhãn Reject — **PASS**
- Button calls `poAction(id,"backlog",btn)` → `POST /api/move {by:"po",to:"backlog"}`.
- Live: `POST /api/move {id:"EP-1-T2",to:"backlog",by:"po"}` → **200**, resulting
  `status="backlog", reject=true, last history entry flag="reject"`.
- UI renders the Reject tag: card gets `is-rejected` + `<span class="tag reject">↺ Reject</span>` when `status==="backlog" && reject`.

### A6. Đội cập nhật trạng thái → bảng phản ánh gần thời gian thực (không reload tay) — **PASS**
- `GET /api/stream` → 200, `content-type: text/event-stream` (SSE).
- Live test: connect SSE, then `POST /api/move {id:"LP-2-T1",to:"test",by:"engineer"}`;
  within ~1s the stream delivered **1 `event: update` frame** (`data:{"at":"...Z"}`).
- Server: `lib/sse.js` watches `BOARD_FILE` (re-watches after atomic rename), debounces, broadcasts `update`.
- Client: `connectStream()` subscribes `EventSource("/api/stream")` and on `update` calls `load()`
  → re-fetch `/api/board` + re-render, preserving selected project/epic. No manual reload needed.

### A7. Góc trên hiển thị số "việc đang chờ bạn duyệt" của dự án đang chọn — **PASS**
- UI: `index.html` has `<span class="chip-attn" id="pending">` in the top bar; `renderHeader()`
  computes `wait = allTasks().filter(status==="uat").length` for the **selected** project and
  renders `👀 <b>N</b> việc chờ bạn duyệt` (hidden when 0). Per-project count confirmed from live data.

---

## B. Quy tắc trạng thái (state machine)

### B1. Luồng hợp lệ backlog→progress→test→uat→done; reject→backlog — **PASS**
- Live full flow on `EP-2-T2` (started `backlog`):
  - `engineer backlog→progress` → 200 ok
  - `engineer progress→test` → 200 ok
  - `qa test→uat (testsPass:true)` → 200 ok
  - `po uat→done` → 200 ok
- Reject path: `po uat→backlog` on `EP-1-T2` → 200, `reject=true` (see A5b).
- `workflow.transitions` defines exactly these 6 edges; matches spec.

### B2. Quyền theo vai (engineer / qa / po; chỉ PO mới uat→done hoặc uat→backlog) — **PASS**
- `engineer uat→done` → **409** "Sai vai ... chỉ cho phép vai (po), không phải engineer".
- `qa uat→done` → **409** same (po only).
- `qa backlog→progress` → **409** "chỉ cho phép vai (engineer), không phải qa".
- `po uat→done` → 200 ok. Reviewer (qa) owns `test→uat` and `test→backlog` reject; engineer owns
  `backlog→progress` and `progress→test`. Role gating enforced server-side in `applyMove`.

### B3. test→uat chỉ khi test pass — **PASS**
- `qa test→uat` WITHOUT `testsPass` → **409** "yêu cầu test pass (tests_pass)".
- `qa test→uat` with `testsPass:true` → **200 ok**.
- Note: gate is strict `=== true` (truthy-but-not-true blocked), confirmed by automated suite.

### B4. Bước sai luồng/quyền bị chặn với thông báo lỗi rõ ràng — **PASS**
- Skip step `backlog→test` (engineer) → **409** "Bước KHÔNG hợp lệ: backlog → test không có trong transitions".
- Wrong role (see B2) → 409 with explicit Vietnamese role message.
- Terminal `done→*` blocked (automated suite). Missing fields → 400 "id, to and by are required";
  unknown task → 404 "Task ... not found". All errors are clear, structured `{ok:false,error}`.

### B5. Mỗi task lưu lịch sử đầy đủ (ai, sang trạng thái nào, lúc nào) — **PASS**
- After the live full flow, `GET /api/board` shows `EP-2-T2` history =
  `["progress/engineer","test/engineer","uat/qa","done/po"]` (each entry `{to, by, at}`, reject entries add `flag:"reject"`).
- `applyMove` appends (never overwrites) a `{to, by, at}` entry on every accepted move; reject moves
  add `flag:"reject"`. History lets the PO trace whether a task went through all steps.

---

## C. Platform / robustness (supporting evidence)
- Node, zero runtime deps; serves UI from `public/` with MIME types and path-traversal protection
  (`GET /../board-data.json` → **404**, contained under `public/`).
- Atomic save (`store.save` temp+rename) so concurrent CLI + server writes don't corrupt data.
- `npm test` → **83/83 pass** covering workflow rules, server routes, CLI, and e2e.

---

## Overall Verdict: **ACCEPT** ✅

Every acceptance criterion in the spec (A1–A7) and every state rule (B1–B5) is
satisfied by the running product, with concrete request/response evidence. The
automated suite is fully green (83/83).

### Caveats (non-blocking)
- v1 has **no authentication**: the `by` role comes from the client request body (as the spec's
  "Ngoài phạm vi" explicitly allows — no multi-user login in the first version). Role *rules* are
  enforced, but anyone can claim any role. Acceptable per scope; flag for any future hardening.
- SSE is a "something changed" signal (re-fetch on `update`); the file watcher debounces ~100ms,
  so updates are near-real-time (sub-second observed), not instantaneous — matches the spec wording.
- Drag-and-drop is intentionally out of scope; only Duyệt/Trả lại buttons, as specified.
