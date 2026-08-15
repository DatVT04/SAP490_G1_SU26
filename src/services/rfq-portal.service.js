/**
 * Portal bao gia cho NCC: sinh/kiem token, dung link cong khai.
 *
 * Tach ra tu server.js (ban goc 4520 dong) ngay 15/08/2026.
 * Noi dung ham giu nguyen 100%, chi them phan require/exports o dau va cuoi file.
 */


const crypto = require("crypto");


// ============================================================================
// PORTAL BAO GIA CHO NHA CUNG CAP (webapp/quote.html)
//
// Bai toan: truoc day gui mail xong thi Purchasing chi con cach ngoi cho NCC
// tra loi mail, roi go tay tung con so vao RFQ-02. Khong ai biet NCC da doc
// mail chua, mail co roi vao Spam khong, con bao nhieu NCC chua nop.
//
// Cach lam: moi NCC nhan 1 link rieng co token -> mo trang quote.html (khong
// can tai khoan) -> nhap dung cac truong RFQ-02 can -> ghi thang vao
// ZG1_QUOTATION voi QuoteStatus = RECEIVED. He thong biet NGAY luc NCC bam
// gui, khong phu thuoc vao viec ai do doc mail.
//
// Token KHONG luu o dau ca (SAP khong co field de luu, va them field thi phai
// sua SE11 + SEGW): token = HMAC-SHA256(RfqId|VendorNo, secret) cat 32 ky tu.
// Muon kiem tra thi tinh lai roi so — khong the doan, khong the sua RfqId hay
// VendorNo trong URL de nhay sang RFQ cua nguoi khac. Doi RFQ_PORTAL_SECRET la
// vo hieu toan bo link cu (chap nhan duoc: RFQ song rat ngan).
// ============================================================================

const RFQ_QUOTE_PATH = "/quote.html";
let _warnedPortalSecret = false;

function rfqPortalSecret() {
	const configured = String(process.env.RFQ_PORTAL_SECRET || "").trim();
	if (configured.length >= 16) { return configured; }
	if (!_warnedPortalSecret) {
		_warnedPortalSecret = true;
		console.warn("⚠️ RFQ_PORTAL_SECRET chua dat (hoac ngan hon 16 ky tu) — dang dung secret mac dinh. "
			+ "PHAI dat bien moi truong nay truoc khi deploy, neu khong ai doc duoc source cung tao duoc link bao gia.");
	}
	return "qdavy-rfq-portal-dev-secret-doi-truoc-khi-deploy";
}

/** Token cua 1 cap (RFQ, NCC) — tinh lai duoc, khong can luu tru. */
function rfqPortalToken(rfqId, vendorNo) {
	return crypto
		.createHmac("sha256", rfqPortalSecret())
		.update(String(rfqId) + "|" + String(vendorNo))
		.digest("hex")
		.slice(0, 32);
}

/** So sanh token theo kieu chong timing attack (do dai luon bang nhau nen an toan de dung timingSafeEqual). */
function verifyRfqPortalToken(rfqId, vendorNo, token) {
	const expected = rfqPortalToken(rfqId, vendorNo);
	const given = String(token || "");
	if (given.length !== expected.length) { return false; }
	return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(given));
}

/**
 * URL goc cua ung dung de ghep vao link gui cho NCC.
 * Uu tien APP_BASE_URL (bat buoc dat tren Vercel) vi mail gui di co the duoc mo
 * o bat ky dau — suy tu req.headers chi dung khi chay local/dev.
 */
function appBaseUrl(req) {
	const configured = String(process.env.APP_BASE_URL || "").trim().replace(/\/+$/, "");
	if (configured) { return configured; }
	const proto = String(req.headers["x-forwarded-proto"] || req.protocol || "http").split(",")[0].trim();
	const host = String(req.headers["x-forwarded-host"] || req.headers.host || ("localhost:" + PORT)).split(",")[0].trim();
	return proto + "://" + host;
}

function rfqQuoteLink(baseUrl, rfqId, vendorNo) {
	return baseUrl + RFQ_QUOTE_PATH
		+ "?rfq=" + encodeURIComponent(rfqId)
		+ "&v=" + encodeURIComponent(vendorNo)
		+ "&t=" + rfqPortalToken(rfqId, vendorNo);
}
module.exports = {
	appBaseUrl,
	rfqQuoteLink,
	verifyRfqPortalToken,
};
