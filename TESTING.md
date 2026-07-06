# Hướng dẫn chạy dự án & Tài khoản test

## 1. Yêu cầu môi trường

- Node.js (đã cài `@ui5/cli`, `express`, `axios`, `cors`, `dotenv` qua `npm install`)
- Không cần kết nối SAP thật để test — nếu để trống `SAP_HOST` trong `.env`, server sẽ tự dùng mock data tại [webapp/model/MockData.js](webapp/model/MockData.js).

## 2. Cài đặt

```bash
npm install
```

Tạo file `.env` từ mẫu `.env.example`:

```bash
cp .env.example .env
```

Nội dung `.env` (để trống `SAP_HOST` để chạy chế độ mock):

```
SAP_HOST=
SAP_USER=
SAP_PASS=
GROQ_API_KEY=   # cần key thật nếu muốn test tính năng AI gợi ý nhà cung cấp
```

## 3. Chạy source code

Cần chạy **2 tiến trình song song** (2 terminal riêng):

**Terminal 1 — Backend API (Express, cổng 3001):**
```bash
npm run start:server
```

**Terminal 2 — Frontend UI5 (UI5 CLI, mặc định cổng 8080):**
```bash
npm run start:ui5
```

Sau đó mở trình duyệt tại địa chỉ UI5 CLI in ra (thường là `http://localhost:8080/index.html` hoặc tương tự) để vào màn hình đăng nhập.

> Frontend gọi thẳng `http://localhost:3001/api/...` (xem [webapp/controller/Login.controller.js](webapp/controller/Login.controller.js)), nên backend phải chạy trước/song song với UI5.

## 4. Tài khoản test (đăng nhập chỉ cần Email, không cần mật khẩu)

Nguồn: [webapp/model/MockData.js](webapp/model/MockData.js)

| Email | Họ tên | Chức vụ | Role | Cost Center | Trạng thái |
|---|---|---|---|---|---|
| ceo@qdavy.com | Nguyen Van An | Tổng Giám Đốc | CEO | CC-0001 | Active |
| cfo@qdavy.com | Tran Thi Bich | Giám Đốc Tài Chính | CFO | CC-0002 | Active |
| truongphongmuahang@qdavy.com | Le Van Cuong | Trưởng Bộ Phận Mua Sắm | TRUONG_BO_PHAN_MUA_SAM | CC-0100 | Active |
| phapche@qdavy.com | Pham Thi Dung | Trưởng Phòng Pháp Chế | LEGAL | CC-0200 | Active |
| muahang@qdavy.com | Hoang Van Em | Nhân Viên Mua Hàng | PURCHASING | CC-0100 | Active |
| nhanvien@qdavy.com | Vo Thi Giang | Nhân Viên Sản Xuất | REQUESTER | CC-0300 | Active |
| nghiviec@qdavy.com | Dang Van Hai | Cựu Nhân Viên | REQUESTER | CC-0300 | **Inactive** (dùng để test case đăng nhập thất bại) |

Ghi chú:
- Đăng nhập chỉ kiểm tra field `email` (case-insensitive), không có mật khẩu — xem `POST /api/login` trong [server.js](server.js).
- Tài khoản `nghiviec@qdavy.com` bị khoá (`IsActive: false`) — dùng để test thông báo lỗi "Email không tồn tại hoặc đã bị khóa."
- Nhập một email bất kỳ không có trong danh sách trên cũng sẽ trả về lỗi tương tự.

## 5. Dữ liệu mock khác để test nghiệp vụ

- **Vật tư** (`materials`): MAT-001 (Thép tấm CT3), MAT-002 (Bulông M10), MAT-003 (Sơn công nghiệp)
- **Nhà cung cấp** (`vendors`): V-001, V-002, V-003
- **Đề nghị mua sắm đang chờ duyệt** (`pendingPRs`): `PR-2026-0001` (500 KG Thép tấm CT3, 150,000,000 VND, requester `nhanvien@qdavy.com`)

Ngưỡng phê duyệt (trong [server.js](server.js)):
- Tổng giá trị > 100,000,000 VND → cần Pháp chế duyệt (`needsLegalReview`)
- Tổng giá trị > 300,000,000 VND → cần Trưởng Bộ Phận Mua Sắm duyệt (`needsProcurementHeadReview`)

## 6. Test API thủ công (không qua UI)

```bash
# Đăng nhập
curl -X POST http://localhost:3001/api/login -H "Content-Type: application/json" -d "{\"email\":\"ceo@qdavy.com\"}"

# Lấy danh sách đề nghị mua sắm đang chờ duyệt
curl http://localhost:3001/api/approval/pending

# Tạo đề nghị mua sắm mới
curl -X POST http://localhost:3001/api/approval/submit -H "Content-Type: application/json" -d "{\"requesterEmail\":\"nhanvien@qdavy.com\",\"materialName\":\"Bulong M10\",\"quantity\":1000,\"totalValue\":50000000,\"costCenter\":\"CC-0300\"}"

# Duyệt/từ chối đề nghị
curl -X PATCH http://localhost:3001/api/approval/PR-2026-0001 -H "Content-Type: application/json" -d "{\"status\":\"APPROVED\",\"comment\":\"OK\"}"
```
