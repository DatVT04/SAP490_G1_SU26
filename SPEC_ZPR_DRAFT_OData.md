# Spec: Z-table + OData service cho "PR nháp + trạng thái workflow" (ZPR_DRAFT)

**Mục đích:** thay `approvalStore` (mảng in-memory + file `data/approvals.json`, hiện ephemeral trên Vercel serverless) bằng dữ liệu sống thật trên SAP — cùng kiểu với `RfqSet`/`PrSet` đang có. Tài liệu này liệt kê chính xác field cần có, rút thẳng từ những gì `server.js` đang đọc/ghi trên object `record` (approval record) — không suy đoán thêm.

**Đã xác minh với code thật (11/08/2026):** toàn bộ field bên dưới lấy từ các chỗ gán `record.X = ...` / `prRecord.X = ...` trong `server.js` (dòng 952-966, 1157-1273, 1886, 2159-2173) và object `mappedItems` trong `/api/approval/submit` (dòng 930-947).

---

## 1. Vấn đề quan trọng cần giải quyết CÙNG LÚC: sinh mã PRId

Hiện tại `tempPRId = "PR-" + year + "-" + String(nextApprovalSeq).padStart(4,"0")` (server.js dòng 930), với `nextApprovalSeq` là **biến đếm trong bộ nhớ Node**, nạp lại từ chính file JSON ephemeral kia (dòng 217). Đây là lý do PR-2026-0001 cứ lặp lại sau mỗi lần cold-start.

**Nếu chỉ chuyển chỗ lưu record mà vẫn để Node tự đếm ID thì bug này KHÔNG hết** — vì bộ đếm vẫn có thể reset và sinh trùng mã cho 2 draft PR khác nhau.

→ **Bắt buộc**: tạo 1 Number Range Object bên SAP (transaction `SNRO`) để sinh `InternalId`, giao cho ABAP method cấp mã mỗi khi có PR nháp mới — không để Node đếm nữa.

---

## 2. Bảng header: `ZPR_DRAFT`

| Field | Type gợi ý | Key | Ghi chú / nguồn field trong code |
|---|---|---|---|
| `Mandt` | MANDT | ✅ | Client, chuẩn mọi Z-table |
| `InternalId` | CHAR(10), sinh từ Number Range | ✅ | Mã bất biến của draft — **thay cho `nextApprovalSeq` của Node** (dòng 954, 1257) |
| `PRId` | CHAR(10) | | Ban đầu = `InternalId`; bị ghi đè thành `SapPRId` khi APPROVED (dòng 1259) — giữ lại để tương thích các chỗ code đang `find` theo `PRId` |
| `SapPRId` | CHAR(10), nullable | | Mã PR thật trên SAP, chỉ có sau khi `createPRInSAP()` chạy xong lúc APPROVED (dòng 955, 1258) |
| `RequesterEmail` | CHAR(100) | | dòng 956 |
| `TotalValue` | DEC(15,2) | | dòng 957 |
| `Currency` | CUKY(5) | | dòng 958 |
| `Status` | CHAR(20) | | Enum: `PENDING_PURCHASING`, `PENDING_RFQ`, `RFQ_SENT`, `QUOTATIONS_RECEIVED`, `PENDING_CFO`, `PENDING_CEO`, `APPROVED`, `REJECTED` (dòng 959, 1157-1273, 1885, 1973, 2039) |
| `CreatedAt` | CHAR(14), format YYYYMMDDHHMMSS | | dòng 960 — dùng chung format với `CreatedAt/SentAt` của `RfqSet` cho nhất quán (xem comment dòng 591-592 trong server.js) |
| `UpdatedAt` | CHAR(14) | | dòng 1161, 1194, 1222, 1264 |
| `Comment` | STRING/CHAR(255) | | dòng 1158, 1190, 1218, 1261 |
| `DecidedByEmail` | CHAR(100) | | dòng 1159, 1262 |
| `DecidedByRole` | CHAR(20) | | dòng 1160, 1263 |
| `PurchasingApprovedBy` | CHAR(100) | | dòng 1164, 1191 |
| `PurchasingAction` | CHAR(20) | | `APPROVED` / `REJECTED` (dòng 1165, 1192) |
| `PurchasingAt` | CHAR(14) | | dòng 1166, 1193 |
| `CfoProcessedBy` | CHAR(100) | | dòng 1168, 1219, 1267 |
| `CfoAction` | CHAR(20) | | `APPROVED` / `REJECTED` / `ESCALATED` (dòng 1169, 1220, 1268) |
| `CfoAt` | CHAR(14) | | dòng 1170, 1221, 1269 |
| `CeoProcessedBy` | CHAR(100) | | dòng 1172, 1271 |
| `CeoAction` | CHAR(20) | | `APPROVED` / `REJECTED` (dòng 1173, 1272) |
| `CeoAt` | CHAR(14) | | dòng 1174, 1273 |
| `EscalationReason` | STRING/CHAR(255) | | dòng 1216 |
| `NeedsProcurementHeadReview` | CHAR(1) X/space | | Từ `buildApprovalFlags()`, dòng 962 |
| `NeedsLegalReview` | CHAR(1) X/space | | dòng 963 |
| `IoThreshold` | DEC(15,2), nullable | | Ngưỡng áp dụng cho IO tại thời điểm submit — lưu lại để audit, dòng 964 |
| `EscalationIO` | CHAR(12), nullable | | Internal Order gây leo thang CEO, dòng 965 |
| `RfqId` | CHAR(10), nullable | | Liên kết sang `RfqSet` một khi RFQ được tạo, dòng 1886 |
| `RfqAwardedVendor` | CHAR(10), nullable | | Vendor thắng thầu, dòng 2172 |
| `RfqFinalValue` | DEC(15,2), nullable | | Giá chốt sau RFQ, dòng 2173 |
| `EstimatedTotalValue` | DEC(15,2), nullable | | Snapshot `TotalValue` trước khi có RFQ, để so sánh ước tính vs giá chốt thật (dòng 2159-2160) |

## 3. Bảng item: `ZPR_DRAFT_ITEM`

Khoá: `Mandt` + `InternalId` (FK sang header) + `LineNo`.

| Field | Type gợi ý | Nguồn (dòng 930-947) |
|---|---|---|
| `InternalId` | CHAR(10), FK | |
| `LineNo` | NUMC(5) | `String(idx+1).padStart(5,"0")` |
| `MaterialNo` | CHAR(18) | rỗng nếu `isFreeText` |
| `MaterialType` | CHAR(4) | mặc định `"ZSRV"` |
| `Description` | STRING/CHAR(100) | |
| `Quantity` | DEC(13,3) | |
| `UoM` | CHAR(3) | mặc định `"PC"` |
| `EstimatedValue` | DEC(15,2) | |
| `CostCenter` | CHAR(10) | |
| `InternalOrder` | CHAR(12) | qua `normalizeOrderNo()` |
| `AssetNo` | CHAR(12) | |
| `GLAccount` | CHAR(10) | |
| `IsFreeText` | CHAR(1) X/space | |

## 4. OData Service (SEGW hoặc RAP — theo đúng cách `RfqSet` đang được xây)

- **Entity Set**: `PrDraftSet` (header) với **navigation property** `PrDraftToItems` trỏ sang `PrDraftItemSet` — bắt chước đúng pattern `RfqSet('id')/RfqToQuotations` mà Node đang biết cách gọi (`sapRead` dùng lại được nguyên xi).
- **Create (deep entity)**: 1 lệnh tạo cả header + toàn bộ items cùng lúc, ABAP method tự cấp `InternalId` từ Number Range (mục 1) — mirror cách `create_deep_entity_v2.abap` hiện có đang tạo PR thật, có thể tái dùng cấu trúc class/method tương tự làm điểm khởi đầu.
- **Read**: hỗ trợ `$filter` theo `Status` (để lấy đúng danh sách "PR chờ Purchasing/CFO/CEO xử lý" theo role) và theo `RequesterEmail` (cho màn PR-02 "PR của tôi").
- **Update (MERGE)**: cho từng bước duyệt — set `Status` + field tương ứng (`PurchasingAction`/`CfoAction`/`CeoAction` + timestamp), và set `RfqId`/`RfqAwardedVendor`/`RfqFinalValue`/`EstimatedTotalValue` khi RFQ tiến triển.

## 5. Sau khi phần SAP xong

Báo lại tôi mã Entity Set thật (`PrDraftSet` hay tên khác bạn đặt) + tên các field nếu có đổi so với spec này. Tôi sẽ viết lại toàn bộ các chỗ `server.js` đang thao tác `approvalStore` (mảng in-memory) sang gọi `sapRead`/`sapWrite` vào service mới, bỏ hẳn `data/approvals.json` và biến đếm `nextApprovalSeq`.
