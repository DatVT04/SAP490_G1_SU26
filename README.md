# SAP490_G1_SU26

## Thành viên nhóm (SAP490_G1_SU26)

| Fullname | Email | Student ID |
|---|---|---|
| Dương Thị Quỳnh | quynhdthe180574@fpt.edu.vn | HE180574 |
| Phạm Thu An | anpthe186638@fpt.edu.vn | HE186638 |
| Vũ Tiến Đạt | datvthe186351@fpt.edu.vn | HE186351 |
| Vương Hải Vũ | vuvhhe182232@fpt.edu.vn | HE182232 |
| Phạm Hải Yến | yenphhs170751@fpt.edu.vn | HS170751 |
## Cấu trúc thư mục

Tái cấu trúc 15/08/2026: `server.js` (4520 dòng) và `webapp/css/style.css` (1854 dòng) được chẻ nhỏ.
Không có URL hay tính năng nào thay đổi.

```
server.js                     tạo app + gắn router (~65 dòng, đừng thêm logic vào đây)
src/
  routes/    *.routes.js      1 express.Router()/file, GIỮ NGUYÊN đường dẫn đầy đủ
  services/  *.service.js     nghiệp vụ: PR, RFQ, PO, vendor, master data, mail
  lib/                        hạ tầng: sap-client, sap-format, store, mailer, html, claude
  config/                     hằng số: org, payment terms, master data, ngưỡng cảnh báo
webapp/
  controller/{common,pr,po,rfq,admin}/    controller theo nhóm màn hình
  view/{common,pr,po,rfq,admin}/          view XML tương ứng, cùng tên
  css/01..13-*.css                        số = THỨ TỰ NẠP, khai báo trong manifest.json
  model/Config.js                         resolve BACKEND URL — mọi controller phải dùng
  quote.html                              portal báo giá cho NCC (ngoài UI5, không cần đăng nhập)
api/index.js                  entry cho Vercel, chỉ re-export server.js
data/                         state chạy runtime (notifications, thresholds)
```

Tìm code nhanh:

| Cần sửa | Vào đâu |
|---|---|
| Một endpoint `/api/...` | `src/routes/` — tra theo tên nhóm (pr → `approval.routes.js`) |
| Cách gọi SAP OData | `src/lib/sap-client.js` |
| Nội dung email | `src/services/rfq-mail.service.js`, `po-mail.service.js`, `mail-assets.js` |
| Giao diện 1 màn | `webapp/view/<nhóm>/` + `webapp/controller/<nhóm>/` cùng tên |
| CSS của 1 màn | `webapp/css/` — tên file có tên màn |
