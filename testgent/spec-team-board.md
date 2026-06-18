# Spec: Bảng theo dõi công việc của đội (Team Board)

## Mục tiêu
Một công cụ nội bộ giúp **Product Owner (không đọc code)** theo dõi trạng thái mọi đầu việc của đội agent trên **nhiều dự án** và **nhiều tính năng**, và **tự duyệt (UAT)** việc nào được tính là "Xong". Chạy 24/7 trên máy chủ nội bộ.

## Người dùng & ngữ cảnh
- **Product Owner (bạn):** mở bảng để theo dõi tiến độ và duyệt/từ chối ở bước UAT.
- **Đội agent (Tech Lead, Engineer, Reviewer):** cập nhật trạng thái task khi làm việc, qua công cụ dòng lệnh.
- Chạy trên Mac Mini (Node), bật liên tục.

## Acceptance Criteria (PO nghiệm thu bằng cách dùng thử)
- [ ] Khi mở bảng → thấy danh sách **dự án** để chọn (tabs).
- [ ] Khi chọn một dự án → thấy các **tính năng (Epic)** kèm thanh tiến độ + số task xong, và một **bảng kanban 5 cột**: Chờ làm · Đang làm · Đang test · UAT · Xong.
- [ ] Khi bấm vào một Epic → bảng chỉ còn hiển thị task của tính năng đó; có lựa chọn "Tất cả".
- [ ] Mỗi thẻ task hiển thị: tên việc, **người phụ trách** (Tech Lead / Engineer / Reviewer), **tính năng** thuộc về, và **phụ thuộc** (nếu có).
- [ ] Khi một task ở cột **UAT** → thẻ có nút **Duyệt** và **Trả lại**.
  - [ ] Khi bấm **Duyệt** → task chuyển sang **Xong**.
  - [ ] Khi bấm **Trả lại** → task về **Chờ làm**, gắn nhãn **Reject**.
- [ ] Khi đội agent cập nhật trạng thái một task → bảng phản ánh đúng (cập nhật gần thời gian thực, không phải reload tay).
- [ ] Góc trên hiển thị số "việc đang chờ bạn duyệt" của dự án đang chọn.

### Quy tắc trạng thái (bắt buộc đúng, không nhảy cóc)
- [ ] Luồng hợp lệ: `backlog → progress → test → uat → done`; với `reject → backlog`.
- [ ] **Quyền theo vai:** Engineer (backlog→progress→test) · Reviewer (test→uat khi **test xanh**, hoặc test→backlog reject) · **chỉ PO** mới được uat→done hoặc uat→backlog.
- [ ] Bước `test → uat` chỉ được phép khi toàn bộ test đã pass.
- [ ] Mọi bước chuyển bị chặn nếu không đúng luồng/quyền (thông báo lỗi rõ ràng).
- [ ] Mỗi task lưu **lịch sử** đầy đủ (ai chuyển, sang trạng thái nào, lúc nào) để truy vết — nhìn lịch sử biết được task có đi đủ các bước hay không.

## Ngoài phạm vi (bản đầu tiên)
- Đăng nhập nhiều người dùng / phân quyền phức tạp.
- Thông báo qua email / Slack.
- Báo cáo nâng cao (burndown, velocity...).
- Kéo-thả thẻ trên giao diện (lần đầu chỉ cần nút Duyệt/Trả lại).

## Ghi chú / ràng buộc
- **Thiết kế:** theo MoMo Design System — theme sáng, hồng `#eb2f96` làm accent (không phải nền), card `rounded-2xl`, dùng đúng token chức năng (txt/bg/bd).
- **Dữ liệu:** đọc/ghi từ `board-data.json` (theo schema đính kèm); state machine định nghĩa trong khối `workflow` của file đó.
- **Nền tảng:** chạy trên Node ở Mac Mini.

## Tài liệu tham chiếu đính kèm (build theo cho khớp)
- `team-board.html` — bản mẫu giao diện đã duyệt.
- `board-data.json` — schema dữ liệu chuẩn (workflow + projects → epics → tasks → history).
- `board.js` — đặc tả state machine + quyền theo vai (tham chiếu cho phần logic chuyển trạng thái).

> Các file này là **chuẩn để build theo**, không phải bản cuối cần tối ưu. Đội có thể dựng lại sạch sẽ miễn là khớp giao diện, schema và quy tắc trạng thái ở trên.
