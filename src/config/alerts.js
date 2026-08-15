/**
 * Nguong canh bao tren chuong thong bao (PR de lau, RFQ sap den han).
 *
 * Tach ra tu server.js (ban goc 4520 dong) ngay 15/08/2026.
 * Noi dung ham giu nguyen 100%, chi them phan require/exports o dau va cuoi file.
 */




// So ngay PR duoc phep "nam" o 1 buoc truoc khi canh bao nguoi duyet (feedback QDAVY
// 13/08: "PR de tren he thong bao lau? Lam thong bao cho Purchasing/CEO/CFO biet don
// nay da cho bao lau roi"). PR KHONG tu xoa — thay vao do sinh canh bao aging.
const AGING_ALERT_DAYS = Number(process.env.AGING_ALERT_DAYS || 2);

// Trang thai nao la "dang cho" cua role nao + nhan buoc de ghi vao message.
const AGING_STATUS_BY_ROLE = {
	PURCHASING: {
		PENDING_PURCHASING: "chờ Purchasing duyệt",
		PENDING_RFQ: "đã duyệt nhưng chưa tạo RFQ",
		RFQ_SENT: "đã gửi RFQ, chờ nhập báo giá",
		QUOTATIONS_RECEIVED: "đã có báo giá, chờ chốt NCC"
	},
	CFO: { PENDING_CFO: "chờ CFO duyệt" },
	CEO: { PENDING_CEO: "chờ CEO duyệt" }
};

// So ngay truoc han nop bao gia thi bat dau canh bao "sap het han".
const RFQ_DUE_SOON_DAYS = Number(process.env.RFQ_DUE_SOON_DAYS || 2);

// 2c) Nhac TU DONG — goi 1 lan/ngay bang Vercel Cron (xem vercel.json) hoac
// bat ky bo lich nao khac. Khong luu "da nhac lan may" o dau: chi nhac dung
// vao cac moc con 3 ngay / con 1 ngay / qua han 1 ngay, nen chay lai nhieu lan
// trong cung 1 ngay cung khong sinh them thu (tru khi cron chay 2 lan/ngay).
const RFQ_REMIND_ON_DAYS_LEFT = [3, 1, -1];
module.exports = {
	AGING_ALERT_DAYS,
	AGING_STATUS_BY_ROLE,
	RFQ_DUE_SOON_DAYS,
	RFQ_REMIND_ON_DAYS_LEFT,
};
