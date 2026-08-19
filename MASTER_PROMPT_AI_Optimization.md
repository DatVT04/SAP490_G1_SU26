# MASTER PROMPT — Phản biện & tối ưu module AI trong hệ thống Procurement (SAP490_G1)

> Cách dùng: copy TOÀN BỘ nội dung dưới đây (từ dòng `===== BẮT ĐẦU PROMPT =====` trở xuống) dán vào ChatGPT / Gemini / Claude. Prompt đã tự chứa đầy đủ bối cảnh, không cần đính kèm code.

---

===== BẮT ĐẦU PROMPT =====

Bạn là một chuyên gia có ĐỒNG THỜI 3 mảng: (1) nghiệp vụ mua sắm SAP MM (P2P: PR → RFQ → PO → GR → IR), (2) kiến trúc hệ thống ứng dụng LLM trong doanh nghiệp, (3) phản biện học thuật cho đồ án tốt nghiệp. Hãy giữ giọng thẳng thắn, không nịnh, sẵn sàng nói "chỗ này các bạn sai" nếu đúng là sai.

## A. BỐI CẢNH

Nhóm tôi làm đồ án tốt nghiệp: một web app (SAPUI5 + Node/Express) chạy ĐÈ LÊN hệ thống SAP ECC/S4 của trường qua OData service tự viết (`ZG1_PROC_SRV_SRV`). App số hoá luồng mua sắm nội bộ: nhân viên tạo Đề nghị mua hàng (PR) → Purchasing duyệt → gửi Yêu cầu báo giá (RFQ) cho nhà cung cấp qua email → nhận báo giá qua portal công khai → chọn NCC → tạo PO → CFO/CEO duyệt PO → gửi PO cho NCC.

Trong luồng đó nhóm nhúng 4 tính năng AI. **Hội đồng phản biện đã chất vấn và nhóm chưa trả lời được.** Tôi cần bạn vừa giúp tôi trả lời sòng phẳng, vừa đề xuất cách nâng cấp.

## B. HIỆN TRẠNG KỸ THUẬT (mô tả chính xác từ source code, không phóng đại)

### B.1. Công nghệ
- Không có ML/mô hình tự huấn luyện, không embedding, không vector DB, không RAG, không fine-tune, không agent/tool-calling, không memory.
- Toàn bộ AI = **gọi HTTP thẳng tới Anthropic Messages API** (`POST https://api.anthropic.com/v1/messages`), model `claude-sonnet-5`, bằng `axios` (không dùng SDK).
- Mỗi lần gọi là **một prompt one-shot, stateless** — không gửi lại lịch sử hội thoại, không có system prompt riêng (toàn bộ chỉ thị nhồi vào 1 message `role: "user"`).
- `max_tokens` mặc định 1500; có cơ chế retry 1 lần với budget x2 nếu bị cắt ở `stop_reason=max_tokens`.
- Đầu ra là **văn bản thuần hoặc JSON**, backend parse bằng string/regex rồi trả về frontend.
- Có ẩn danh hoá (anonymization): tên/email/mã số thuế NCC **không bao giờ** rời hệ thống — backend đổi thành mã tạm `V1, V2, V3...` trước khi gọi AI, rồi dịch ngược lại bằng regex word-boundary sau khi có kết quả.

### B.2. Bốn endpoint AI

| Endpoint | Thời điểm dùng | Việc AI làm |
|---|---|---|
| `POST /api/ai/recommend-vendor` | TRƯỚC khi gửi RFQ | Gợi ý nên mời NCC nào báo giá. Trả về văn xuôi: dòng đầu `NCC ĐỀ XUẤT ƯU TIÊN: V2`, sau đó 3–5 gạch đầu dòng lý do. |
| `POST /api/ai/suggest-rfq-groups` | TRƯỚC khi gửi RFQ, khi PR có nhiều dòng khác ngành hàng | Chia các dòng PR thành nhiều nhóm, mỗi nhóm gợi ý một tập NCC → tách thành nhiều RFQ. Trả JSON `{groups:[{name, lines[], vendorCodes[], reason}]}`, dùng để **tick sẵn checkbox** trên UI (người mua vẫn sửa tay được). |
| `POST /api/ai/compare-quotations` | SAU khi đã nhận báo giá thật | So sánh các báo giá theo 5 tiêu chí và kết luận chọn NCC nào. |
| `POST /api/ai/ask` | Bất kỳ lúc nào | Khung chat hỏi thêm 1 câu trên đúng bộ dữ liệu đang xem (context = `recommend-vendor` hoặc `compare-quotations`). Mỗi câu là 1 lượt độc lập, không nhớ câu trước. |

### B.3. AI được ăn ĐÚNG những dữ liệu gì (đây là phần quan trọng nhất)

**Nguồn 1 — Master data NCC, đọc từ SAP OData `VendorSet` (KHÔNG lọc, lấy toàn bộ danh sách).**
Code đọc và gửi cho AI các trường sau (đã ẩn danh):
```
vendorCode, country, city, category (map từ LFA1-SORTL),
paymentTerms, currency, incoterms, leadTimeDays (map từ EINE/LFM1-PLIFZ)
```
⚠️ **Nhưng thực tế**: OData `VendorSet` hiện chỉ trả về `CompanyCode, VendorNo, VendorName, AccountGroup, Email, Rating`. Nghĩa là `category`, `incoterms`, `country`, `city`, `leadTimeDays` **đang rỗng hoặc bằng 0** — code viết sẵn để đón dữ liệu nhưng phía SAP (SEGW + ABAP + nhập liệu ~34 NCC) chưa mở rộng.

**Nguồn 2 — Lịch sử hành vi trong chính app, tính runtime từ bảng Z tự tạo (`ZG1_RFQ` / `ZG1_QUOTATION`, đọc qua `RfqSet` → `RfqToQuotations`).** Hàm `computeVendorPerformanceStats()` duyệt mọi RFQ có `Status ∈ {QUOTATIONS_RECEIVED, AWARDED}`, gom theo `VendorNo`:
```
pastQuoteCount       // số lần từng được mời và có báo giá
pastAwardedCount     // số lần trúng thầu
pastAvgLeadTimeDays  // lead time trung bình theo báo giá
pastLegalDocsOkRate  // % lần nộp đủ hồ sơ pháp lý
```
Cố ý **bỏ qua giá trung bình** vì giá phụ thuộc loại vật tư (mua thép ≠ mua laptop), trung bình chung sẽ sai lệch.
⚠️ Đây là dữ liệu do **chính app sinh ra**, KHÔNG phải lịch sử mua hàng thật của SAP (EKKO/EKPO/EKBE). Vì đồ án mới chạy nên số lượng bản ghi rất nhỏ.

**Nguồn 3 — Thông tin nhu cầu mua, do frontend gửi lên.**
- Với `recommend-vendor`: `materialName` = mô tả dòng đầu tiên của PR, `materialGroup`, `quantity`, `budget` = tổng giá trị PR.
- ⚠️ **LỖI ĐÁNG CHÚ Ý**: frontend truyền `materialGroup: firstItem.MaterialType` — tức là truyền **Material Type** (`ZAST` = tài sản / `ZSRV` = dịch vụ) chứ **KHÔNG PHẢI Material Group (MATKL)**. Nghĩa là AI chỉ biết "đây là tài sản hay dịch vụ", hoàn toàn không biết ngành hàng.
- Với `suggest-rfq-groups`: mỗi dòng chỉ gửi `lineNo, description, materialNo, quantity, uom` — **không có MATKL, không có material group text**.

**Nguồn 4 — Báo giá thật (cho `compare-quotations`)**, đọc từ `ZG1_QUOTATION`:
```
quotedPrice, currency, leadTimeDays, paymentTerms (đã dịch mã T052 sang chữ),
warrantyMonths, legalDocsOk
```

### B.4. Hệ quả logic của B.3 (tôi tự nhận ra, cần bạn xác nhận hoặc bác bỏ)
Vì `category` của NCC đang rỗng và material group không được truyền lên, nên khi AI "biết" NCC nào bán được vật tư nào, nó **đang suy đoán bằng cách đọc chuỗi mô tả tiếng Việt** (`description`) và **tên NCC đã bị ẩn danh** — tức là gần như không có căn cứ dữ liệu. Riêng phần so sánh báo giá thì có dữ liệu thật đầy đủ.

### B.5. Các ràng buộc kỹ thuật khác đã biết
- `computeVendorPerformanceStats()` gọi SAP theo kiểu **N+1**: 1 request lấy `RfqSet`, rồi mỗi RFQ 1 request lấy quotations → càng nhiều RFQ càng chậm, không cache.
- Không giới hạn số NCC nhồi vào prompt (hiện ~34 NCC nên chưa vỡ).
- Không có bộ đo lường (eval / benchmark / A-B test) nào chứng minh gợi ý AI tốt hơn quy tắc thủ công.
- Không lưu lại việc người mua CÓ theo gợi ý AI hay không (chỉ có `console.log`), nên không có vòng phản hồi.
- Đầu ra bị ép định dạng bằng chỉ thị trong prompt và parse bằng regex → giòn (đã có sẵn nhánh fallback khi AI trả sai JSON).

## C. BA CÂU CHẤT VẤN CỦA HỘI ĐỒNG (nguyên văn, cần trả lời sòng phẳng)

1. *"Trong DB SAP đã có phân nhóm, đã có lịch sử → AI có tác dụng gì?"*
2. *"Một NCC bán rất nhiều mặt hàng → AI dựa vào đâu để biết NCC nào bán được thứ đang cần mua?"*
3. *"Nếu có thể viết query lọc ra và làm được hết những việc AI đang làm, thì tại sao lại dùng AI?"*

## D. VIỆC TÔI CẦN BẠN LÀM

Trả lời theo đúng 6 phần dưới đây. Ở mọi phần, nếu hiện trạng của nhóm là sai/yếu thì nói thẳng, đừng bênh.

**PHẦN 1 — Phán quyết trung thực.**
Với từng câu trong mục C, cho biết hội đồng ĐÚNG tới đâu và SAI tới đâu, dựa trên đúng dữ liệu ở mục B. Nói rõ: trong 4 tính năng AI hiện tại, tính năng nào **thật sự không cần AI** (một câu SQL / một đoạn `if-else` là đủ và còn tốt hơn), tính năng nào **có lý do chính đáng để dùng LLM**. Đừng cố cứu cả 4.

**PHẦN 2 — Ranh giới "khi nào query thắng, khi nào LLM thắng".**
Đưa ra một tiêu chí phân định rõ ràng, có thể phát biểu thành 1–2 câu trước hội đồng, kiểu: LLM chỉ chính đáng khi đầu vào là *dữ liệu phi cấu trúc / thiếu chuẩn hoá / đa tiêu chí đánh đổi không có công thức cố định / cần giải thích bằng ngôn ngữ tự nhiên*, còn khi bài toán quy được về `WHERE ... ORDER BY ...` xác định thì query luôn thắng về độ chính xác, chi phí, độ trễ và khả năng kiểm toán. Hãy phát biểu tiêu chí của riêng bạn, chính xác hơn, rồi **áp tiêu chí đó lên từng tính năng trong bảng B.2**.

**PHẦN 3 — Kiến trúc lai (deterministic + LLM) đề xuất.**
Thiết kế lại module AI theo hướng: **luật/query làm phần cứng, LLM chỉ làm phần mềm**. Cụ thể tôi muốn thấy:
- Bước nào nên chuyển thành query/rule thuần (ví dụ: lọc NCC theo material group, chấm điểm có trọng số cho báo giá).
- LLM còn giữ vai trò gì (ví dụ: chuẩn hoá mô tả tự do → material group, giải thích quyết định, xử lý trường hợp dữ liệu thiếu).
- Sơ đồ luồng dữ liệu mới (dạng text/ASCII cũng được).
- Nói rõ mỗi thay đổi trả lời trực tiếp cho câu chất vấn số mấy ở mục C.

**PHẦN 4 — Nguồn dữ liệu SAP nhóm đang bỏ phí.**
Liệt kê cụ thể các bảng/đối tượng SAP chuẩn mà một hệ thống mua sắm nghiêm túc phải dùng nhưng nhóm chưa đụng tới, và **mỗi cái giải quyết được câu chất vấn nào**. Ít nhất hãy đánh giá: Purchasing Info Record (EINA/EINE), Source List (EORD) / Quota Arrangement (EQUK-EQUP), Material Group (MATKL) & Material–Vendor assignment, lịch sử PO thật (EKKO/EKPO/EKBE), đánh giá NCC chuẩn của SAP (Vendor Evaluation — ELBK/ELBP hoặc Supplier Evaluation trong S/4), điều kiện giá (A017/KONP), Partner functions (WYT3), khoá NCC (LFA1-SPERM/LFM1). Với mỗi bảng: dữ liệu gì, dùng làm gì trong hệ thống của nhóm, và **chi phí thực hiện** (cần mở SEGW/ABAP mới hay không).

**PHẦN 5 — Kế hoạch nâng cấp có ưu tiên.**
Chia làm 3 mức, mỗi mục ghi rõ: *việc phải làm — file/endpoint nào đụng tới — nỗ lực ước tính — câu chất vấn nào được gỡ*:
- **P0 (bắt buộc sửa trước khi bảo vệ lại, ≤ 1 ngày công)** — ví dụ sửa lỗi `materialGroup` đang truyền nhầm `MaterialType`.
- **P1 (nâng cấp thật, vài ngày)**.
- **P2 (định hướng, chỉ nói trong phần "hướng phát triển")**.
Nói rõ mục nào chỉ cần sửa Node/UI5, mục nào bắt buộc phải làm thêm phía SAP (SEGW/ABAP/nhập master data).

**PHẦN 6 — Cách chứng minh AI có giá trị (phần nhóm đang thiếu hoàn toàn).**
Đề xuất một bộ đo lường KHẢ THI với đồ án sinh viên trong 1–2 tuần: baseline nào để so (rule-based? người mua thật?), chỉ số nào (top-1/top-3 accuracy khi gợi ý NCC, tỉ lệ người mua chấp nhận gợi ý, độ chính xác chia nhóm dòng, độ trễ, chi phí token/lượt), cỡ mẫu tối thiểu, cách thu thập dữ liệu ngay trong app (log nào cần thêm). Kèm gợi ý cách trình bày kết quả này trước hội đồng.

## E. QUY TẮC TRẢ LỜI
- Tiếng Việt có dấu đầy đủ.
- Đi thẳng vào nội dung, không mở bài xã giao, không tóm tắt lại đề bài của tôi.
- Dùng bảng khi so sánh; dùng gạch đầu dòng khi liệt kê; hạn chế văn xuôi dài.
- **Không bịa tên bảng SAP, tên transaction, tên BAPI.** Nếu không chắc chắn một đối tượng có tồn tại/dùng được trong ECC hay chỉ có ở S/4, nói rõ là chưa chắc chắn và bảo tôi kiểm chứng.
- Nếu bạn thấy tôi mô tả có chỗ mâu thuẫn hoặc thiếu thông tin quyết định, hãy nêu ra ở cuối bằng mục "CÂU HỎI NGƯỢC LẠI CHO BẠN" (tối đa 5 câu) — nhưng vẫn trả lời đầy đủ 6 phần trước bằng giả định hợp lý nhất, ghi rõ giả định đó là gì.

===== KẾT THÚC PROMPT =====

---

## Phụ lục (không dán vào AI, chỉ để bạn tự đối chiếu)

| Nội dung | Vị trí trong repo |
|---|---|
| Gọi Anthropic API | `src/lib/claude.js` |
| 4 endpoint AI + toàn bộ prompt | `src/routes/ai.routes.js` |
| Ẩn danh hoá + tính lịch sử NCC | `src/services/vendor.service.js` |
| Lấy NCC từ SAP (không lọc) | `src/routes/masterdata.routes.js` → `/api/vendors` |
| FE gọi AI (RFQ-01: gợi ý NCC, chia nhóm) | `webapp/controller/rfq/RFQ01.controller.js` (~dòng 583, 644, 840) |
| FE gọi AI (RFQ-02: so sánh báo giá) | `webapp/controller/rfq/RFQ02.controller.js` (~dòng 511, 583) |
| **Lỗi P0 đã xác định** | `RFQ01.controller.js` ~dòng 592: `materialGroup: firstItem.MaterialType` |

---

# PHỤ LỤC C — Trả lời 3 câu hỏi ngược của AI (dán tiếp vào cùng cuộc hội thoại)

===== BẮT ĐẦU PHẦN TRẢ LỜI =====

Dưới đây là câu trả lời cho 3 câu hỏi của bạn. Tôi ghi rõ đâu là điều đã kiểm chứng trong source code, đâu là suy luận. Sau khi đọc, hãy **cập nhật lại Phần 1 → Phần 6** nếu có kết luận nào phải đổi.

## 1. Hệ thống là S/4HANA (mức tin cậy cao, chưa xem System → Status)

- Endpoint thật trong `.env`: `SAP_HOST=https://s40lp1.ucc.cit.tum.de:8100` — hệ thống của **SAP University Competence Center TUM (Munich)**, định danh máy chủ bắt đầu bằng `s4`.
- Tài liệu nội bộ, README và cả màn hình đăng nhập của app đều ghi "SAP S/4HANA".
- Server đặt ở Đức, múi giờ CEST (UTC+2) — khớp với cấu hình `SAP_TZ_OFFSET_MIN=120`.
- Tôi **chưa** xác minh release cụ thể (1909 / 2020 / 2021 / 2022).

⇒ Khi đề xuất bảng/CDS View, hãy giả định **S/4HANA on-premise**, và với mỗi đối tượng bạn nêu, ghi rõ nó là: (a) vẫn dùng được nguyên như ECC, (b) đã bị thay thế/deprecate trong S/4, hay (c) chỉ có ở S/4. Đặc biệt lưu ý giúp tôi: trong S/4 nhà cung cấp bắt buộc quản lý qua **Business Partner**, `LFA1/LFM1` vẫn còn nhưng chỉ là bảng nền — điều này ảnh hưởng thế nào tới đề xuất của bạn?

## 2. MATKL có tồn tại nhưng **quá thô để dùng được** — đây là điểm bạn cần chú ý nhất

Bằng chứng trong code:
- OData `MaterialSet` là entity mỏng: frontend chỉ đọc được `MaterialNo`, `MaterialType`, `Description`, `BaseUoM`. **Không expose `MaterialGroup` ra ngoài.**
- Hàm lấy danh mục nhóm vật tư (`fetchMaterialValueHelpFromSAP`) có thử đọc `MaterialGroup / MatGroup / Matkl / MATKL`, nhưng **có sẵn nhánh fallback** — nghĩa là người viết đã lường trước việc trường này rỗng.
- Nội dung fallback đó chỉ có **đúng 2 nhóm**: `Z10V` (QDAVY Asset/Material Group) và `Z20V` (QDAVY Service Group).
- Màn hình tạo vật tư (MM01) trong app có gửi `MaterialGroup` lên SAP, nên ~30 mã vật tư nhóm tự tạo nhiều khả năng đều mang `MATKL` = `Z10V` hoặc `Z20V`.

⇒ Suy luận: `MATKL` **không rác, nhưng chỉ có 2 giá trị và trùng ý nghĩa với MaterialType (tài sản / dịch vụ)**.

**Hệ quả rất quan trọng, xin bạn đưa hẳn vào kết luận:** việc sửa lỗi P0 (truyền `MATKL` thay vì `MaterialType`) **tự nó KHÔNG giải quyết được câu chất vấn số 2 của hội đồng**, vì `Z10V/Z20V` vẫn không cho biết "văn phòng phẩm" hay "thiết bị mạng". Vậy hãy trả lời thêm:
- Có nên thiết kế lại bộ **Material Group** (ví dụ 8–12 nhóm ngành hàng thật) không? Chi phí là gì (cấu hình + gán lại 30 mã)?
- Hay nên bỏ qua MATKL và dùng thẳng cơ chế **NCC ↔ vật tư** ở cấp bản ghi (Info Record / Source List)? So sánh 2 hướng theo tiêu chí: công sức, tính thuyết phục trước hội đồng, tính "đúng chuẩn SAP".
- Về phía nhà cung cấp: `VendorSet` hiện **không** expose trường ngành hàng nào; nhóm mới chỉ *dự định* chạy một report ABAP để bổ sung dữ liệu cho 34 NCC, **chưa chạy**. Vậy nguồn "NCC bán được gì" nên lấy từ đâu cho đúng chuẩn?

## 3. PR **bắt buộc chọn mã vật tư có sẵn**, không cho nhập tự do

Bằng chứng: màn PR-01 dùng ComboBox gắn vào danh mục `MaterialSet`, và controller chặn cứng khi để trống ("Vui lòng chọn vật tư / dịch vụ"). Không có text item / PR không mã vật tư. Trường "Mô tả" được **tự động điền từ material master**, người dùng chỉ sửa lại chữ.

⇒ Đây có vẻ là điểm chí mạng cho lập luận hiện tại của nhóm, xin bạn xác nhận hoặc bác bỏ thẳng: vì **mọi dòng PR luôn có `MaterialNo` chuẩn**, hệ thống hoàn toàn có thể đi `MARA → MATKL → Info Record/Source List → NCC` bằng một câu query xác định. Nghĩa là ở đúng luồng hiện tại, việc để LLM **suy đoán ngành hàng từ chuỗi mô tả tiếng Việt** là thừa và kém chính xác hơn query — tức hội đồng đúng.

Nếu bạn đồng ý, hãy chỉ ra: **chỗ nào trong hệ thống này LLM MỚI thực sự chính đáng?** Tôi tự thấy vài khả năng, xin bạn đánh giá và bổ sung:
- Màn tạo vật tư mới (MM01 trong app): người dùng gõ mô tả tự do → LLM gợi ý `MATKL` + đơn vị tính + purchase order text. Đây mới đúng là dữ liệu phi cấu trúc.
- Trường hợp mua ngoài danh mục (nếu sau này mở text item).
- Diễn giải quyết định chọn NCC thành văn bản để đính kèm hồ sơ mua sắm (audit trail) — sau khi việc **chấm điểm** đã do công thức/query làm.
- Đọc file báo giá NCC gửi về dạng PDF/email tự do → trích số liệu vào form.

Hãy xếp hạng các hướng trên theo (giá trị nghiệp vụ × tính khả thi trong 1–2 tuần), và nói thẳng nếu có hướng nào bạn cho là vô nghĩa.

===== KẾT THÚC PHẦN TRẢ LỜI =====
