# CLAUDE.md — QDAVY Integrated Procurement System (SAP490_G1)

Đọc file này trước khi làm bất kỳ việc gì trong repo. Đây là capstone SAP490, đồ án nhóm G1,
sắp bảo vệ trong ~2 tuần. Kế hoạch chi tiết đầy đủ nằm ở
`../KE_HOACH_RFQ_2_TUAN.md` (ngoài repo, cùng cấp thư mục `SAP490_G1_SU26`) — **đọc file đó
trước khi bắt đầu bất kỳ task nào trong "Việc cần làm" bên dưới**, nó có bối cảnh đầy đủ hơn
phần tóm tắt ở đây.

## Kiến trúc

3 tầng, không dùng CAP/CDS/BTP:

```
SAPUI5 freestyle (webapp/)  →  Node.js/Express (server.js, port 3001)  →  SAP OData ZG1_PROC_SRV_SRV
                                        ↓                                        ↓
                                  Groq/Claude API                       SAP S/4HANA thật
                                (gợi ý vendor)                    (s40lp1.ucc.cit.tum.de:8100)
```

- **Không có mock mode.** `server.js` bắt buộc `SAP_HOST` phải có, thiếu là `process.exit(1)`.
  Mọi test phải chạy với SAP thật đằng sau (hoặc ai đó đang sửa lại việc này — kiểm tra trước
  khi giả định).
- **Không có database local.** Toàn bộ dữ liệu bền vững nằm trong SAP. Ngoại lệ: `ZG1_APPROVAL`
  (Z-table, lưu trạng thái PAMS/duyệt) — nhưng hiện Node.js **chưa** đọc/ghi bảng này, đang
  dùng in-memory array `approvalStore` trong `server.js` (mất khi restart). Đây là lỗ hổng đã
  biết, không phải bug mới.
- **Không có auth/session thật.** Login chỉ tra email trong `EmployeeSet` (HCM), không token,
  không password. Role tin tưởng hoàn toàn từ 1 lần lookup, lưu ở JSONModel phía browser.
  `PATCH /api/approval/:id` hiện KHÔNG kiểm tra người gọi có đúng quyền duyệt không.

## File quan trọng

- `server.js` — chỉ còn ~65 dòng: tạo app, middleware, gắn 11 router. **Không đặt logic ở đây.**
- `src/routes/*.routes.js` — mỗi file là 1 `express.Router()` và **giữ nguyên đường dẫn đầy đủ**
  (ví dụ trong `rfq.routes.js` vẫn viết `router.post("/api/rfq/:id/send", ...)`). Nhờ vậy thứ tự
  gắn router không làm đổi URL. Muốn tìm 1 endpoint: tra tên trong `src/routes/`.
- `src/services/*.service.js` — nghiệp vụ, gọi SAP, dựng/gửi mail. Route chỉ nên nhận request,
  gọi service, trả response.
- `src/lib/*.js` — hạ tầng dùng chung: `sap-client` (auth/CSRF/đọc/ghi OData), `sap-format`
  (đổi kiểu DATS/TIMESTAMP/"X"), `store` (state trên đĩa), `mailer`, `html`, `claude`.
- `src/config/*.js` — hằng số: org, điều khoản thanh toán, master data, ngưỡng cảnh báo.
- `webapp/controller/<nhóm>/*.js` + `webapp/view/<nhóm>/*.xml` — nhóm = `common`, `pr`, `po`,
  `rfq`, `admin`. 13 màn hình SAPUI5, 1 route/màn qua `sap.m.routing.Router` (`manifest.json`).
  Route pattern trên URL giữ nguyên như trước khi gom thư mục.
- `webapp/css/01..13-*.css` — style.css cũ chẻ nhỏ. **Số thứ tự chính là thứ tự nạp** khai báo
  trong `manifest.json > sap.ui5 > resources > css`; đảo thứ tự sẽ đổi độ ưu tiên cascade.
- `webapp/model/Config.js` — resolve `BACKEND` URL theo hostname. **Mọi controller phải dùng
  cái này**, không hardcode `localhost:3001` (xem lỗi đã biết bên dưới).
- `.env` (không commit) — `SAP_HOST`, `SAP_USER`, `SAP_PASS`, `GROQ_API_KEY`, `EMAIL_USER/PASS`,
  `GOOGLE_CLIENT_ID`.

## Lỗi đã biết — ĐỪNG coi là đã fix trừ khi tự verify

1. **PR nhiều dòng chỉ ghi 1 dòng vào SAP.** `createPRInSAP()` trong `server.js` chỉ lấy
   `record.items[0]`, POST vào `PurchaseRequisitionHisSet` (flat, 1 item). Cần sửa thành
   deep-insert `PurchaseReqHeaderSet` + `PRToItems` cho toàn bộ item — **nhưng phần ABAP/SEGW
   phía SAP phải làm xong trước** (xem `HUONG_DAN_PR_DEEP_ENTITY.md`, `HUONG_DAN_SAP_GUI_PR_STEPBYSTEP.md`
   ở thư mục gốc `D:\SAPCapstoneSu26`). Hỏi người dùng đã xong SAP-side chưa trước khi sửa code này.
2. ~~2 nhánh AI gợi ý vendor song song trong `PO01.controller.js`~~ — **không còn tồn tại** (11/08).
   Đã grep cả controller lẫn view: không có `_getAIVendorRecommendations` hay bất kỳ code AI nào
   trong PO01. Mục này đã lỗi thời, giữ lại để khỏi ai đi tìm lại lần nữa.
3. ✅ **`/api/ai/recommend-vendor` đã ẩn danh hoá** (11/08) — chỉ gửi `V1/V2/...` + country/city/
   payment terms, map ngược bằng word-boundary ở server, có log mỗi lần gọi. Đồng thời đổi từ Groq
   sang Claude (`callClaude`) cho khớp `/api/ai/compare-quotations`. **Groq đã bị loại hoàn toàn
   khỏi codebase** — không còn `GROQ_API_KEY` ở đâu nữa.
4. **Màn PO Report đã bị XOÁ HẲN 15/08/2026.** Lý do: view và controller là 2 phiên bản lệch
   nhau nên màn chưa bao giờ chạy đúng — 6 ô KPI là số cứng viết thẳng trong XML
   (125/18/36/14/89/5), 3 biểu đồ và bảng bind vào model mặc định trong khi controller ghi vào
   model tên `reportModel`, và 8 handler view gọi (`onRefresh`, `onSearch`, `onApplyFilter`,
   `onViewDetail`, `onEditPO`, `onMoreAction`, `formatDaysState`, `formatStatusState`) không
   tồn tại trong controller. Route `po-report` cũng đã gỡ khỏi `manifest.json` — trước đó chỉ
   tile bị ẩn còn route vẫn sống, gõ thẳng URL là vào được và thấy số liệu bịa.
   Endpoint `GET /api/po/report` cũng đã xoá nốt (không ai gọi). Phần merge mốc thời gian
   duyệt PR vào PO trong route cũ nếu cần tái dùng: `git show ce9d5ae~1:src/routes/po.routes.js`.
5. ✅ **`ThresholdConfig` đã nối backend thật** (11/08). Route `PUT /api/thresholds` (kèm
   `saveThresholds()`) thực ra ĐÃ có sẵn từ trước — vấn đề chỉ là frontend chưa bao giờ gọi fetch.
   Nhưng màn hình cũ dựng quanh 1 ngưỡng phẳng 300tr trong khi backend đã chuyển sang **ngưỡng
   theo từng Internal Order**, nên đã dựng lại màn theo đúng mô hình đó (bảng IO × ngưỡng, đọc
   `/api/internal-orders` + `/api/thresholds`, lưu bằng `PUT`). Bỏ luôn bảng "lịch sử thay đổi"
   vì toàn bộ là dữ liệu bịa.
6. ✅ **Đã xoá nhánh mock PO trong `/api/po/create`** (11/08) — thiếu `SAP_HOST` giờ trả 503 thay
   vì số PO giả kèm `success:true`.
7. ✅ **Đã dọn `console.log`/`console.table` trong `PO01.controller.js`** (11/08). Chỉ giữ lại 1
   `console.error` trong `catch` của `onPRSelect`.
8. **Org code sai trong `/api/po/create`** — đã sửa (11/08). Trước đây fallback `1000/1000/001`.
   Lưu ý sự khác biệt quan trọng giữa PR và PO (đã đối chiếu `create_deep_entity_v2.abap`):
   PR thì ABAP tự hardcode `plant='QDPL'`, `pur_group='QD1'` và header **không có** comp_code nên
   giá trị Node gửi bị bỏ qua; PO thì ABAP đọc thẳng `comp_code/purch_org/pur_group` **từ deep
   entity** → sai org là sai thật. Nay gom vào `ORG_DEFAULTS` trong `server.js`
   (`QD01/QDPO/QD1/QDPL`) và expose qua `/api/config` để PO-01 tự điền.
   ✅ **Đã chốt Purchasing Group = `QD1`** (mô tả "QDAVY PG") — xác minh trực tiếp trên OME4 ngày
   11/08. Tức là ABAP hardcode `'QD1'` mới ĐÚNG, còn `QDG` trong tài liệu là SAI. Đã sửa
   `MASTER_DATA_SAP490_G1.md` và sheet Assumptions của cả 4 file Technical Specification.
   **Vẫn còn `QDG` ở các file sau, chưa sửa vì là báo cáo lịch sử / guide cần bạn quyết:**
   `sap_step_by_step_config_guide.md` (2 chỗ — guide này nếu ai làm theo sẽ tạo nhầm group),
   `HUONG_DAN_SAP490_G1_FULL.md` (3), `KE_HOACH_RFQ_2_TUAN.md`, `Report2_Completed_Content.md`,
   `Gap_Analysis_Report.md`, `RA_SOAT_TIEN_DO_2026-08-02.md`, `HUONG_DAN_PR_DEEP_ENTITY.md`.
9. **`createPRInSAP()` vẫn gửi `CompanyCode: "1000"`** vì không chỗ nào set `record.CompanyCode`.
   Vô hại về mặt chức năng (ABAP PR bỏ qua field này) nên chưa sửa, nhưng nên dọn cho sạch.
10. ✅ **Lệch hoa/thường tên file view — đã sửa** (11/08). `manifest.json` khai
   `"viewName": "ThresholdConfig"` nhưng git track `thresholdConfig.view.xml` (t thường) → Windows
   bỏ qua nhưng Linux/Vercel sẽ 404. Đã `git mv` qua tên tạm để git nhận đúng `ThresholdConfig.view.xml`.
   **Bài học:** trên Windows, đổi tên file chỉ khác hoa/thường sẽ KHÔNG được git nhận nếu `mv` thẳng.
11. ⚠️ **`.git/index.lock`** — cái sót từ 10/08 đã được xoá, nhưng lệnh `git mv` ở mục 10 lại tạo
   ra một cái mới và không tự dọn được (môi trường chạy lệnh không có quyền unlink file trong
   `.git/`). **Phải xoá tay `SAP490_G1_SU26\.git\index.lock` từ Windows trước khi commit**, nếu
   không mọi lệnh git ghi sẽ bị chặn. Bản thân thao tác đổi tên đã vào index thành công rồi
   (`git diff --cached` hiện `R100 thresholdConfig.view.xml -> ThresholdConfig.view.xml`).

## Việc cần làm (Phần B trong kế hoạch — xem `KE_HOACH_RFQ_2_TUAN.md` để biết chi tiết đầy đủ + lý do)

Đang bổ sung luồng RFQ (Request for Quotation) còn thiếu so với quy trình MM chuẩn:
`PR → Purchasing xem xét → [MỚI] RFQ (AI gợi ý vendor + gửi mail) → [MỚI] nhập báo giá + so
sánh → CFO/CEO duyệt → PO`. RFQ làm **ngoài SAP** (Z-table `ZG1_RFQ`/`ZG1_QUOTATION`, không
phải ME41 chuẩn) — quyết định đã chốt, đừng đề xuất đổi sang ME41.

Thứ tự ưu tiên (🔴 trước, 🟠 sau):

- 🔴 **B1** — sửa `createPRInSAP` gửi đủ mọi dòng item (phụ thuộc: SAP-side deep entity phải
  xong trước — hỏi trước khi làm)
- 🔴 **B2** — ẩn danh dữ liệu vendor trước khi gọi AI + đổi từ Groq sang Claude API
  (`ANTHROPIC_API_KEY`), ghi log mỗi lần gọi (thời điểm, người gọi, PR nào, số vendor)
- 🟠 **B3** — route mới: `POST /api/rfq/create`, `POST /api/rfq/:id/send`,
  `POST /api/rfq/:id/quotation`, `GET /api/rfq/:id/compare`, `POST /api/rfq/:id/award`,
  `POST /api/ai/compare-quotations` (phụ thuộc: SAP-side SEGW expose `RfqSet`/`QuotationSet`
  xong trước — hỏi tên chính xác Entity Set/property trước khi viết)
- ✅ **B4** (backend xong, 10/08) — `PENDING_RFQ → RFQ_SENT → QUOTATIONS_RECEIVED` đã được set
  trong `approvalStore` tại `/api/rfq/create` (guard: chỉ tạo được RFQ khi PR đang
  `PENDING_PURCHASING`), `/api/rfq/:id/send`, `/api/rfq/:id/quotation`. `/api/rfq/:id/award` đã
  gọi lại `buildApprovalFlags` trên `FinalValue` thật (giá ước tính cũ được giữ lại ở
  `EstimatedTotalValue` để audit). `/api/approval/history` (role PURCHASING) đã thêm 3 trạng
  thái này vào "history" để không biến mất khỏi màn Purchasing khi chưa có RFQ01/RFQ02. Label
  tiếng Việt cho 3 trạng thái đã thêm vào `History.controller.js` và `PRDetail.controller.js`.
  **Chưa làm:** chặn cứng UI nếu <2 báo giá (hiện đang cho phép sole-source kèm bắt buộc lý do,
  coi đây là quyết định thiết kế tốt hơn bản gốc — cân nhắc trước khi đổi).
  ✅ Bước "RFQ" trong timeline `PRDetail` đã làm xong (11/08): chèn giữa Purchasing và CFO, chỉ
  hiện với PR thực sự đi qua RFQ (nhận biết bằng `RfqId` / 3 trạng thái RFQ / `RfqAwardedVendor`),
  và không hiện khi Purchasing đã từ chối. Đã test 4 ca trên trình duyệt bằng cách stub `fetch`
  để chạy thật qua `buildTimeline()`. Lưu ý: các route RFQ chưa ghi mốc thời gian riêng cho từng
  bước nên bước này dùng tạm `UpdatedAt` — muốn chính xác hơn thì cần thêm field `RfqAt`/`RfqSentAt`.
- 🟠 **B5** — 2 màn hình mới `RFQ01` (chọn PR → AI gợi ý vendor → gửi mail) và `RFQ02` (nhập
  báo giá tay + bảng so sánh + chốt vendor có lý do), thêm route vào `manifest.json` + tile
  Dashboard (chỉ hiện role `PURCHASING`)
- ✅ **B6** (xong 11/08) — `PO01.controller.js` giờ tự điền NCC + giá từ báo giá thắng. Không cần
  route backend mới: `/api/rfq/:id/award` vốn đã ghi sẵn `RfqId` / `RfqAwardedVendor` /
  `RfqFinalValue` lên chính bản ghi approval, nên chỉ cần `_loadApprovedPRs()` mang các field đó
  qua và `_applyRfqAward()` đọc ra. Đơn giá = `RfqFinalValue / số lượng` (vì `FinalValue` là tổng
  giá trị PR theo báo giá thắng, giống cách `buildApprovalFlags` dùng nó), PR nào không qua RFQ
  thì vẫn rơi về giá ước tính như cũ. Có `MessageStrip` nói rõ giá đến từ RFQ nào, kèm cả giá ước
  tính ban đầu để đối chiếu. Đã dọn `console.log`/`console.table`; nhánh AI giả thì vốn không tồn tại.
  **Tiện thể sửa 1 race condition có sẵn:** `_loadApprovedPRs()` gọi `setModel(new JSONModel(...))`
  ghi đè cả model, nên nếu `/api/vendors` trả về trước thì danh sách NCC bị xoá sạch — ComboBox
  rỗng ngẫu nhiên tuỳ tốc độ mạng. Nay model tạo 1 lần trong `onInit`, 2 request chỉ `setProperty`.
  **Bài học khi sửa view:** đừng đặt `MessageStrip` vào trong `f:SimpleForm` — UI5 ném
  "not a valid Form content" và chặn render cả thẻ đó (đã dính 1 lần, phát hiện nhờ đọc console
  chứ `node --check` / parse XML đều báo OK).

**Mỗi bản ghi báo giá bắt buộc có** `enteredBy`/`enteredAt`/`sourceNote` (ai nhập tay, lúc nào,
căn cứ email nào) — đây là yêu cầu audit trail, không phải nice-to-have, vì cả đề tài định vị
là giải quyết vấn đề thiếu audit trail.

## Portal báo giá cho NCC (thêm 14/08) — đọc trước khi sửa luồng RFQ

Trước đây gửi mail xong thì chỉ còn cách ngồi chờ NCC trả lời email rồi gõ tay vào RFQ-02.
Nay có thêm đường thứ hai, **không thay thế** đường nhập tay:

- `webapp/quote.html` — trang HTML thuần (KHÔNG phải UI5, cố ý: NCC là người ngoài, mở trên
  điện thoại, không nên bắt tải cả framework). Đường dẫn `/quote.html?rfq=…&v=…&t=…`.
- Token `t` = `HMAC-SHA256(RfqId|VendorNo, RFQ_PORTAL_SECRET)` cắt 32 ký tự — **không lưu ở
  đâu cả**, tính lại để kiểm tra. Chọn cách này để khỏi phải thêm field vào `ZG1_QUOTATION`
  (SE11 + SEGW + generate lại). Đổi `RFQ_PORTAL_SECRET` = vô hiệu mọi link đã gửi.
- Route công khai (không đăng nhập): `GET/POST /api/public/rfq/quote`. **Không bao giờ trả
  `EstimatedValue`/`TotalValue` của PR ra 2 route này** — đó là ngân sách nội bộ, lộ ra thì
  báo giá nào cũng sẽ bám sát con số đó. Cũng không trả danh sách/báo giá của NCC khác.
- NCC nộp qua portal → `QuotationSet` `QuoteStatus = RECEIVED`, `EnteredBy` = liên hệ NCC,
  `SourceNote` tự sinh ("NCC tự gửi qua Portal …"). Cùng đường trạng thái với nhập tay
  (`promoteRfqAfterQuotation`), nên RFQ-02/PO-01 không cần biết báo giá đến từ đâu.
- Email mời báo giá dựng trong `buildRfqEmail()` (server.js) + logo ở `mail-assets.js`
  (base64, KHÔNG đọc file từ `webapp/images/` — thư mục đó không được đóng gói vào serverless
  function trên Vercel).
- Biết NCC đã phản hồi chưa: `buildRfqAlerts()` tính lại từ SAP mỗi lần gọi
  `/api/notifications` (báo giá mới trong 24h / sắp hết hạn / quá hạn), cộng thêm email báo
  cho role PURCHASING ngay khi có báo giá vào. Nhắc NCC: `POST /api/rfq/:id/remind` (thủ công
  từ RFQ-02) và `GET /api/cron/rfq-reminders` (Vercel Cron, cần `CRON_SECRET`).

Biến môi trường mới — xem `.env.example`: `RFQ_PORTAL_SECRET`, `APP_BASE_URL`, `CRON_SECRET`,
`RFQ_DUE_SOON_DAYS`. Thiếu `APP_BASE_URL` thì link trong mail sẽ là `localhost:3001`.

## Quy ước code hiện có (giữ nguyên style khi sửa)

- Node: CommonJS. Route nằm trong `src/routes/*.routes.js`, mỗi file 1 `express.Router()`
  **viết đường dẫn đầy đủ** (không dùng prefix khi `app.use`) — thêm route mới thì theo đúng kiểu này.
- Cẩn thận với `__dirname`: code trong `src/**` nằm sâu 2 cấp so với gốc project. Cần đường dẫn
  tính từ gốc thì dùng `APP_ROOT` như trong `src/lib/store.js`, đừng dùng thẳng `__dirname`.
- SAPUI5: `Controller.extend(...)`, JSONModel cục bộ theo view, gọi backend bằng `fetch()`
  (PR01/PR02/PO01) — **không** dùng jQuery `$.ajax`.
- Comment tiếng Việt không dấu trong `server.js` (`// Trang thai duyet`, không phải convention
  đẹp nhưng đang nhất quán trong toàn file — giữ nguyên khi sửa cùng vùng code).
