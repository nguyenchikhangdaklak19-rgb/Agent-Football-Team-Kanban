# Acceptance Checklist — Team Board on Vercel (cloud migration)

Maps every Acceptance Criterion in `spec/vercel-migration.md` to its evidence.

- Spec: `spec/vercel-migration.md`
- Product under test: `testgent/api/*.js` (serverless handlers), `testgent/lib/{kv-store,auth,workflow,remote}.js`, `testgent/public/*`, `testgent/board.js` (remote mode)
- Automated suite: `npm test` → **tests 317 · suites 12 · pass 317 · fail 0** (offline; KV mocked, no network).
- Date: 2026-06-21

Legend:
- **AUTO-PASS** — proven offline by a named automated test (`api.test.js` drives the real handler with a mock KV client).
- **LIVE-PENDING** — code path proven offline, but the "when X then Y" wording can only be *finally* signed off by the PO against the deployed Vercel URL (requires Step 2: deploy + KV + env). Not a failure — a deploy-gated checkbox.

---

## A. Acceptance Criteria

### A1. Chưa đăng nhập → màn hình yêu cầu mật khẩu, không thấy dữ liệu board — **AUTO-PASS** / LIVE-PENDING
- `api.test.js`: `board: no cookie => 401 and body contains no projects/workflow data`;
  `move: no cookie => 401 body has zero board data (no projects/workflow leak)`.
- UI: `public/index.html` serves the login screen; `board-client.js` only fetches `/api/board` after login.
- LIVE: PO opens the Vercel URL logged out → login screen, no data. Sign off post-deploy.

### A2. Đúng mật khẩu → vào được, thấy dự án + epic (tiến độ) + kanban 5 cột — **AUTO-PASS** / LIVE-PENDING
- `api.test.js`: `login: correct password => 200 + Set-Cookie ... HttpOnly`; `board: valid token => 200 with board data (projects and workflow)`;
  `e2e auth chain: login -> cookie -> board returns data`.
- UI rendering of tabs/epics/5 columns is unchanged from v1 (see `acceptance-checklist.md` A1–A2, same `board-client.js` renderers).
- LIVE: confirm the rendered board on the deployed URL.

### A3. Sai mật khẩu → bị từ chối rõ ràng, vẫn không thấy dữ liệu — **AUTO-PASS**
- `api.test.js`: `login: wrong password => 401, no Set-Cookie`;
  `login: wrong-password error text is generic (no length/closeness oracle)`;
  `e2e auth chain: wrong password login -> 401, cookie rejected by board`.

### A4. Gọi thẳng `/api/board`, `/api/move` không token hợp lệ → 401, không trả dữ liệu, không move — **AUTO-PASS**
- `api.test.js`: `board: no cookie => 401`; `board: tampered token => 401`; `board: expired token => 401`; `board: wrong secret => 401`;
  `move: no token => 401 and no state change`; `move: invalid (tampered) token => 401 and no state change`;
  `move: expired token is rejected before any KV access`; empty-secret bypass attempts rejected for both endpoints.

### A5. Agent (Mac) chạy move chế độ remote → PO refresh ở mạng khác thấy trạng thái mới — **AUTO-PASS** / LIVE-PENDING
- `remote.test.js`: board.js remote mode POSTs `/api/login` then `/api/move` with the signed cookie (cookie parsed via `auth.COOKIE_NAME`, fixed in `fix(remote)`).
- `api.test.js`: `move: valid token + legal move (uat->done by po) => 200 and persisted`; persistence read back via KV.
- LIVE: this criterion is fundamentally cross-network — only fully verifiable agent-on-Mac → PO-on-other-network against the live URL.

### A6. PO bấm Duyệt UAT → task sang Xong, reload vẫn thấy (bền) — **AUTO-PASS** / LIVE-PENDING
- `api.test.js`: `move: valid token + legal move (uat->done by po) => 200 and persisted`; `e2e auth chain: login -> cookie -> move succeeds`.
- Persistence is to KV (single source of truth), so reload re-reads the stored value.
- LIVE: confirm reload-after-Duyệt on the deployed URL (this is the same path as A9 redeploy durability).

### A7. PO bấm Trả lại UAT → về Chờ làm + nhãn Reject, reload vẫn thấy — **AUTO-PASS** / LIVE-PENDING
- `api.test.js`: `move: uat->backlog (reject) by po => 200 with reject flag`.
- UI reject tag rendering unchanged from v1.

### A8. Bước sai luồng / sai vai → bị chặn, thông báo lỗi rõ ràng (đúng state machine) — **AUTO-PASS**
- `api.test.js`: `move: illegal move (engineer pushing uat->done) => 409 with error, no change`;
  `move: invalid transition (backlog->done directly) => 409`;
  `move: test->uat without testsPass => 409`; `move: truthy-but-not-true testsPass` blocked;
  unknown task → 404; missing `id`/`to`/`by` → 400.
- `lib/workflow.js` is unmodified (spec hard constraint) — `workflow.test.js` (all role/transition rules) green.

### A9. Sau redeploy Vercel → toàn bộ dữ liệu board vẫn còn (không reset về mẫu) — **LIVE-PENDING**
- Offline support: data lives in KV, not the filesystem; handlers never write a local file; `seed-kv.js` is the *only* writer of the seed, run once.
- This is inherently a **deploy-time** guarantee: redeploy the Vercel project and confirm KV data survives. Cannot be exercised offline.
- ⚠️ Seed-once discipline: re-running `npm run seed` OVERWRITES KV — do not run it again after go-live.

---

## B. Concurrency (spec "Notes": no lost update)

### B1. Hai move gần như đồng thời không nuốt mất nhau — **AUTO-PASS**
- `api.test.js`: `concurrency: two concurrent valid move requests both persist (no lost update)`;
  `concurrency: forced CAS contention through move handler => both persist, no lost update`.
- Implementation: atomic Lua `EVAL` CAS in `lib/kv-store.js` (`fix(kv-store)` / `fix/kv-cas-atomic`), verified in `kv-store.test.js`.

---

## C. Robustness (supporting)
- KV failure handling: `board: KV load failure => 500, no board data leaked, no hang`; `move: KV update failure => 500, ... no hang`.
- Malformed input: null/garbage cookie, malformed JSON body, non-allowed methods (405) all handled — see `api.test.js`.
- Security headers + `Cache-Control: no-store` via `vercel.json`; HttpOnly/Secure/SameSite cookie via `lib/auth.js`.

---

## Verdict

**Offline acceptance: PASS** — every criterion that can be exercised without a live
cloud is proven by the green automated suite (317/317). The remaining checkboxes
(A1/A2/A5/A6/A7 final sign-off and **A9 redeploy durability**) are **LIVE-PENDING**:
they unblock once Step 2 (Vercel deploy + KV provision + env vars + one-time seed)
is done by the PO, then verified against the deployed URL.

### Live sign-off checklist (PO, post-deploy)
- [ ] A1 logged-out URL shows login, no data
- [ ] A2 correct password → full board renders
- [ ] A5 agent move on Mac → visible to PO on another network
- [ ] A6 Duyệt → Xong, survives reload
- [ ] A7 Trả lại → backlog+Reject, survives reload
- [ ] A9 redeploy → board data still present (no reset to seed)
