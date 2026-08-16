# SAP490_G1_SU26

## Thành viên nhóm (SAP490_G1_SU26)

| Fullname | Email | Student ID |
|---|---|---|
| Dương Thị Quỳnh | quynhdthe180574@fpt.edu.vn | HE180574 |
| Phạm Thu An | anpthe186638@fpt.edu.vn | HE186638 |
| Vũ Tiến Đạt | datvthe186351@fpt.edu.vn | HE186351 |
| Vương Hải Vũ | vuvhhe182232@fpt.edu.vn | HE182232 |
| Phạm Hải Yến | yenphhs170751@fpt.edu.vn | HS170751 |

## Cấu trúc dự án

> Tái cấu trúc ngày **15/08/2026**: `server.js` (4.520 dòng) tách thành 31 module trong `src/`,
> `webapp/css/style.css` (1.854 dòng) chẻ thành 13 file, view/controller gom theo nhóm màn hình.
> **Không có URL, API hay tính năng nào thay đổi** — chỉ đổi chỗ ngồi của code.

### Tôi cần sửa cái này thì vào file nào?

| Tôi muốn sửa… | Mở file |
|---|---|
| Giao diện một màn hình | `webapp/view/<nhóm>/<Tên>.view.xml` |
| Xử lý sự kiện, gọi API của một màn | `webapp/controller/<nhóm>/<Tên>.controller.js` |
| Màu sắc, khoảng cách, bố cục | `webapp/css/` — tên file có tên màn |
| Một endpoint `/api/...` | `src/routes/` — xem bảng "Bản đồ API" bên dưới |
| Nghiệp vụ (tính ngưỡng duyệt, xử lý báo giá…) | `src/services/` |
| Cách gọi SAP OData (auth, đọc, ghi) | `src/lib/sap-client.js` |
| Nội dung email gửi NCC | `src/services/rfq-mail.service.js`, `po-mail.service.js` |
| Mã công ty, kho, ngưỡng, điều khoản thanh toán | `src/config/` |

### Cây thư mục

```
server.js                    Khởi tạo Express + gắn 11 router. ~50 dòng — KHÔNG thêm logic vào đây.
api/index.js                 Cửa vào cho Vercel, chỉ re-export server.js.

src/                         ── BACKEND (Node.js) ──
  routes/                    Nhận HTTP request, kiểm tra đầu vào, trả response.
  services/                  Nghiệp vụ: PR, RFQ, PO, nhà cung cấp, master data, email.
  lib/                       Hạ tầng dùng chung: gọi SAP, đổi định dạng, gửi mail, gọi AI, lưu file.
  config/                    Hằng số cấu hình: mã tổ chức, điều khoản thanh toán, ngưỡng cảnh báo.

webapp/                      ── FRONTEND (SAPUI5) ──
  view/<nhóm>/               Giao diện XML.        nhóm = common | pr | po | rfq | admin
  controller/<nhóm>/         Xử lý cho view cùng tên.
  css/01..13-*.css           Số đầu tên = THỨ TỰ NẠP (khai báo trong manifest.json).
  model/Config.js            Xác định URL backend. Mọi controller phải dùng, đừng hardcode localhost.
  manifest.json              Khai báo route (#/create-pr…), view, danh sách CSS.
  quote.html                 Trang báo giá cho NCC — nằm ngoài UI5, không cần đăng nhập.

data/                        Dữ liệu chạy runtime (thông báo, ngưỡng duyệt theo Internal Order).
mail-assets.js               Logo + màu thương hiệu QDAVY dùng trong email.
```

Luồng một request đi qua hệ thống:

```
Trình duyệt  →  controller  →  fetch /api/...  →  routes/  →  services/  →  lib/sap-client  →  SAP S/4HANA
```

### Bản đồ màn hình

Mỗi màn có 4 phần cùng tên nằm ở 4 chỗ. Biết tên màn là suy ra được cả 4.

| Màn | URL | View + Controller | API màn đó gọi |
|---|---|---|---|
| Đăng nhập | `#/` | `common/Login` | `/api/config`, `/api/login/google` |
| Trang chủ | `#/dashboard` | `common/Dashboard` | `/api/approval/pending·approved·history`, `/api/notifications` |
| Lịch sử đề nghị | `#/history` | `common/History` | `/api/approval/history` |
| PR-01 Tạo đề nghị | `#/create-pr` | `pr/PR01` | `/api/approval/submit`, `/api/materials`, `/api/cost-centers`, `/api/internal-orders`, `/api/thresholds` |
| PR-02 Phê duyệt | `#/approve-pr` | `pr/PR02` | `/api/approval/pending`, `/api/approval/:id`, `/api/rfq/:id/compare` |
| Chi tiết PR | `#/pr-detail/{prId}` | `pr/PRDetail` | `/api/approval/:id` |
| RFQ-01 Mời báo giá | `#/create-rfq` | `rfq/RFQ01` | `/api/rfq/create`, `/api/rfq/:id/send`, `/api/vendors`, `/api/ai/recommend-vendor` |
| RFQ-02 So sánh & trao thầu | `#/manage-quotations` | `rfq/RFQ02` | `/api/rfq`, `/api/rfq/:id/compare·award`, `/api/ai/compare-quotations` |
| PO-01 Tạo đơn mua | `#/create-po` | `po/PO01` | `/api/po/create`, `/api/approval/approved`, `/api/vendors` |
| Tạo vật tư (MM01) | `#/material-create` | `admin/MaterialCreate` | `/api/material-master/value-help·create` |
| Cấu hình ngưỡng duyệt | `#/threshold-config` | `admin/ThresholdConfig` | `/api/thresholds`, `/api/internal-orders` |

*Ví dụ: sửa màn PR-01 thì mở `webapp/view/pr/PR01.view.xml` (giao diện), `webapp/controller/pr/PR01.controller.js` (xử lý), và backend nằm ở `src/routes/approval.routes.js`.*

### Bản đồ API — 34 endpoint

| File trong `src/routes/` | Phụ trách | Endpoint |
|---|---|---|
| `auth.routes.js` | Đăng nhập | `GET /api/config` · `POST /api/login` · `POST /api/login/google` |
| `masterdata.routes.js` | Danh mục cho dropdown | `GET /api/materials · /api/vendors · /api/cost-centers · /api/internal-orders · /api/gl-accounts` |
| `approval.routes.js` | Toàn bộ vòng đời PR | `POST /api/approval/submit` · `GET /api/approval/pending · approved · history · :id` · `PATCH /api/approval/:id` |
| `rfq.routes.js` | RFQ nội bộ | `GET /api/rfq` · `POST /api/rfq/create · :id/send · :id/remind · :id/quotation · :id/award` · `GET /api/rfq/:id/compare` |
| `rfq-public.routes.js` | Portal NCC (**không cần đăng nhập**) | `GET · POST /api/public/rfq/quote` |
| `po.routes.js` | Đơn mua hàng | `POST /api/po/create` |
| `material.routes.js` | Tạo vật tư | `GET /api/material-master/value-help` · `POST /api/material-master/create` |
| `threshold.routes.js` | Ngưỡng duyệt | `GET · PUT /api/thresholds` |
| `notification.routes.js` | Chuông thông báo | `GET /api/notifications` · `PATCH /api/notifications/:id/read` |
| `ai.routes.js` | Tính năng AI | `POST /api/ai/recommend-vendor · compare-quotations · ask` |
| `cron.routes.js` | Job Vercel chạy hằng ngày | `GET /api/cron/rfq-reminders` |

Riêng `GET /api/health` (kiểm tra server sống) nằm thẳng trong `server.js`.

### Vai trò từng file backend

**`src/config/` — hằng số, không có logic**

| File | Chứa gì |
|---|---|
| `org.js` | Mã công ty, kho, đường dẫn OData, ngưỡng pháp chế, múi giờ SAP |
| `payment-terms.js` | Điều khoản & phương thức thanh toán, ánh xạ mã ZTERM của SAP |
| `master-data.js` | Cấu hình vật tư, tên cost center tiếng Việt, GL mặc định, làm tròn tiền tệ |
| `alerts.js` | Số ngày cảnh báo PR để lâu / RFQ sắp hết hạn |

**`src/lib/` — hạ tầng, không dính nghiệp vụ**

| File | Chứa gì |
|---|---|
| `sap-client.js` | Xác thực SAP, lấy CSRF token, đọc/ghi OData, bóc tách message lỗi |
| `sap-format.js` | Đổi kiểu qua lại giữa SAP và JS (ngày DATS, timestamp, cờ `"X"`) |
| `store.js` | Lưu thông báo + ngưỡng duyệt xuống đĩa (trên Vercel thì ghi vào `/tmp`) |
| `mailer.js` | Khởi tạo kết nối gửi mail |
| `html.js` | Escape HTML, định dạng ngày, đếm ngày còn lại — dùng khi dựng email |
| `claude.js` | Gọi API AI của Anthropic (có retry) |

**`src/services/` — nghiệp vụ**

| File | Chứa gì |
|---|---|
| `pr.service.js` | Tạo PR thật trên SAP, đọc/ghi PrDraftSet, chuyển đổi dữ liệu PR |
| `rfq.service.js` | Sinh mã RFQ, nạp ngữ cảnh, xử lý báo giá nhận về, cảnh báo hạn nộp |
| `rfq-portal.service.js` | Sinh và kiểm tra link báo giá riêng cho từng NCC (ký bằng HMAC) |
| `rfq-mail.service.js` | Dựng và gửi email mời/nhắc báo giá |
| `po-mail.service.js` | Dựng và gửi email đơn mua hàng cho NCC |
| `approval.service.js` | Quyết định PR cần cấp nào duyệt, cảnh báo PR để lâu |
| `vendor.service.js` | Đọc danh sách NCC, ẩn danh trước khi đưa cho AI, tính điểm hiệu suất |
| `masterdata.service.js` | Đọc master data từ SAP: internal order, GL, danh mục vật tư |
| `employee.service.js` | Tra cứu nhân viên và email theo vai trò |
| `notify.service.js` | Đẩy thông báo trong ứng dụng cho từng vai trò |

### Quy tắc khi thêm code mới

1. **Thêm endpoint** → viết trong `src/routes/`, và **luôn ghi đường dẫn đầy đủ**:
   `router.post("/api/rfq/:id/send", ...)`. Router được gắn không có tiền tố, nên thứ tự gắn
   trong `server.js` không làm đổi URL.
2. **Route chỉ nên mỏng** — nhận request, gọi service, trả response. Logic dài đưa xuống `src/services/`.
3. **Cần đường dẫn tính từ thư mục gốc** trong `src/**` thì dùng `APP_ROOT`
   (xem `src/lib/store.js`), **đừng dùng `__dirname`** — file nằm sâu 2 cấp nên sẽ trỏ sai chỗ.
4. **Thêm màn hình mới** → tạo đủ cặp `view/<nhóm>/Tên.view.xml` + `controller/<nhóm>/Tên.controller.js`,
   rồi khai báo route và target trong `manifest.json`.
5. **Thêm file CSS** → đánh số lớn hơn 13 và thêm vào cuối danh sách trong `manifest.json`.
   Đảo thứ tự sẽ đổi độ ưu tiên cascade và làm vỡ giao diện.
6. **Đặt tên file khớp hoa/thường tuyệt đối** — Windows không phân biệt nhưng Vercel chạy Linux thì có.

### Kiểm tra trước khi commit

```bash
node --check server.js                        # kiểm cú pháp 1 file
npx eslint server.js mail-assets.js src       # tìm biến/hàm chưa khai báo giữa các module
npm start                                     # chạy thật, xem log khởi động
```

Log khởi động phải đủ 6 dòng, trong đó `[DATA] IO thresholds: 6` và `[DATA] Folder: <thư mục gốc>\data`
chứng tỏ đọc được file cấu hình.
