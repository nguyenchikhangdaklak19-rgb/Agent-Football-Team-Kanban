# Spec: Triển khai Team Board lên Vercel (cloud, truy cập mọi nơi, có mật khẩu)

> Copy of `spec/TEMPLATE.md`, filled in. The `tech-lead` decomposes this into
> tasks; the `reviewer` verifies against the Acceptance Criteria below.

## Goal

Đưa Team Board từ chỗ chỉ chạy nội bộ trên Mac (file + LAN) lên **Vercel** để PO
xem được board **từ bất kỳ đâu** (laptop ở công ty, mạng khác). Nguồn dữ liệu
chuyển thành **một database trên cloud** — cả đội agent ở nhà (ghi) lẫn PO ở công
ty (đọc) đều là client của cloud. Board phải **riêng tư**: phải nhập mật khẩu mới
xem hoặc sửa được.

## Users & context

- **Mac Mini ở nhà** chạy đội agent 24/7. Agent cập nhật trạng thái task bằng
  công cụ `board.js`. Hôm nay `board.js` ghi thẳng vào file local
  `board-data.json`; sau migration nó phải **đẩy cập nhật lên cloud** (qua HTTP
  API của Vercel), vì file local không còn là nguồn dữ liệu.
- **PO dùng laptop ở công ty** (mạng khác hẳn Mac) chỉ **xem** board và thỉnh
  thoảng bấm **Duyệt / Trả lại** task ở cột UAT.
- Vì board ra internet công khai, **bất kỳ ai có link không được phép xem hay
  sửa** nếu không có mật khẩu.

Kiến trúc đích:

```
Đội agent (Mac nhà)  ──HTTPS (board.js remote)──►  Vercel API ──►  KV (cloud, nguồn dữ liệu duy nhất)
PO (laptop công ty)  ──HTTPS (trình duyệt)─────►  Vercel UI  ──►  đọc/ghi KV
```

Ràng buộc:
- Chạy trên Vercel serverless (không có process sống lâu, filesystem read-only).
- Dữ liệu phải **bền** qua mỗi request/redeploy (không dùng file ghi tạm).
- Logic state machine (`lib/workflow.js`) là tài sản lõi — **không được sửa**, chỉ
  dùng lại. Mọi luật vai/transition giữ nguyên hành vi.
- Test phải chạy được bằng một lệnh (`npm test`) và xanh trước khi merge.

## Acceptance Criteria

> "when X then Y" — PO kiểm chứng bằng cách dùng sản phẩm thật trên URL Vercel.

- [ ] Khi mở URL Vercel mà **chưa đăng nhập**, thì hiện màn hình yêu cầu mật khẩu
      và **không thấy** dữ liệu board nào.
- [ ] Khi nhập **đúng mật khẩu**, thì vào được và thấy danh sách dự án, epic kèm
      tiến độ, và bảng kanban 5 cột (như bản hiện tại).
- [ ] Khi nhập **sai mật khẩu**, thì bị từ chối với thông báo rõ ràng và vẫn
      không thấy dữ liệu.
- [ ] Khi gọi thẳng API dữ liệu (`/api/board`, `/api/move`) mà **không có
      token/mật khẩu hợp lệ**, thì bị từ chối (HTTP 401), không trả dữ liệu, không
      cho move.
- [ ] Khi một agent trên Mac chạy lệnh move (chế độ remote), thì sau khi PO mở/refresh
      board trên laptop **ở mạng khác**, trạng thái mới hiện đúng.
- [ ] Khi PO bấm **Duyệt** một task UAT trên cloud, thì task chuyển sang **Xong**,
      và **tải lại trang vẫn thấy** trạng thái mới (đã lưu bền, không mất).
- [ ] Khi PO bấm **Trả lại** một task UAT, thì task về **Chờ làm** kèm nhãn Reject,
      và tải lại trang vẫn thấy.
- [ ] Khi thực hiện một **bước sai luồng/sai vai** (vd engineer đẩy uat→done), thì
      bị chặn với thông báo lỗi rõ ràng — đúng như luật state machine hiện tại.
- [ ] Khi sau một lần **redeploy** Vercel, thì toàn bộ dữ liệu board **vẫn còn**
      (không reset về mẫu).

## Out of scope

- **Realtime tức thời (SSE).** PO chỉ thỉnh thoảng xem; bỏ SSE/file-watch. Trang
  lấy dữ liệu mới mỗi lần mở (và có nút/poll nhẹ để refresh) là đủ. Không cần đẩy
  cập nhật tức thời.
- **Tài khoản đa người dùng / đăng nhập theo vai.** Chỉ **một mật khẩu dùng chung**
  bảo vệ board. Vai (`by`: engineer/qa/po) vẫn đến từ phía gọi như v1 — luật vai
  được enforce, nhưng không có hệ thống login riêng từng người.
- **Kéo–thả (drag & drop).** Giữ nguyên: chỉ nút Duyệt/Trả lại.
- **Deploy launchd/Mac Mini cho hướng này.** Vercel tự deploy qua tích hợp Git;
  workflow `deploy.yml` (Mac Mini) không thuộc phạm vi spec này.
- **Đổi logic state machine.** `lib/workflow.js` không được sửa.

## Notes

Quyết định đã chốt với PO:
- **Lưu trữ:** dùng **Vercel KV (Upstash Redis)** — lưu cả board JSON dưới một key.
  Tạo lớp `lib/kv-store.js` (load/save **async**) cùng hình dạng API với
  `lib/store.js` (`load`, `save`, `findTask`) để tái dùng tối đa. `lib/store.js`
  (file) vẫn giữ cho CLI/test local.
- **Phía ghi của agent:** `board.js` thêm **chế độ remote** — khi có cấu hình
  remote (vd `--remote <url> --password <pw>` hoặc biến môi trường
  `BOARD_REMOTE`/`BOARD_PASSWORD`), thay vì ghi file thì **POST `/api/move`** lên
  Vercel. Không có cấu hình remote thì giữ nguyên hành vi file local (cho test/dev).
- **Mật khẩu (cả xem lẫn sửa):** một biến môi trường `BOARD_PASSWORD` trên Vercel.
  Màn hình login POST mật khẩu tới `/api/login`; nếu đúng, server cấp một **cookie
  token có ký HMAC** (secret = env `BOARD_SECRET`) thời hạn hữu hạn. Mọi endpoint
  (`/api/board`, `/api/move`) và việc phục vụ board yêu cầu cookie hợp lệ; thiếu →
  401. Dùng `crypto` built-in để ký, không thêm dependency cho phần auth.
- **Concurrency:** nhiều agent có thể move cùng lúc. Khi đọc-sửa-ghi cả board JSON
  trong KV, phải tránh **mất cập nhật** — dùng cơ chế optimistic (trường version /
  CAS của KV) hoặc retry, thay cho atomic-rename của bản file. Reviewer kiểm tra
  hai move gần như đồng thời không nuốt mất nhau.
- **Seed dữ liệu:** nạp `board-data.json` hiện có vào KV **một lần** (script seed
  chạy thủ công với credential KV). Sau đó KV là nguồn dữ liệu.
- **Biến môi trường cần đặt** (Vercel project settings + trên Mac cho `board.js`):
  `KV_REST_API_URL`, `KV_REST_API_TOKEN`, `BOARD_PASSWORD`, `BOARD_SECRET`. Không
  commit secret nào vào repo (đúng CLAUDE.md).
- **Cấu trúc cho Vercel:** thư mục `api/` chứa các serverless function
  (`board.js` GET, `move.js` POST, `login.js` POST); `public/` phục vụ tĩnh; thêm
  `vercel.json` (rewrites/headers) nếu cần; cập nhật `package.json` (thêm dep KV
  client, script `seed`).
- **Test:** phải mock KV (không gọi mạng thật trong test). `workflow.test.js` và
  `cli.test.js` (chế độ file) giữ xanh; viết lại phần test server/e2e quanh các
  handler serverless + auth; bỏ test SSE.

### Gợi ý phân chia file (disjoint — tech-lead chốt lại)

- **Lõi không động vào:** `testgent/lib/workflow.js`.
- **Storage adapter:** `testgent/lib/kv-store.js` (+ test) — KV load/save/findTask async + CAS.
- **Auth:** `testgent/lib/auth.js` (+ test) — ký/kiểm token HMAC, parse cookie.
- **API functions:** `testgent/api/board.js`, `testgent/api/move.js`, `testgent/api/login.js`.
- **Client + login UI:** `testgent/public/index.html`, `testgent/public/board-client.js`, `testgent/public/board.css`.
- **CLI remote mode:** `testgent/board.js`, `testgent/lib/remote.js` (+ test).
- **Cấu hình & seed:** `testgent/vercel.json`, `testgent/package.json`, `testgent/scripts/seed-kv.js`.
- **Tài liệu vận hành:** `testgent/README.md` (biến môi trường, cách deploy, cách trỏ agent lên cloud).
