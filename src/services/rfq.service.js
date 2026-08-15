/**
 * Nghiep vu RFQ: sinh ma, nap ngu canh, xu ly bao gia, canh bao han nop.
 *
 * Tach ra tu server.js (ban goc 4520 dong) ngay 15/08/2026.
 * Noi dung ham giu nguyen 100%, chi them phan require/exports o dau va cuoi file.
 */


const { RFQ_DUE_SOON_DAYS } = require("../config/alerts");
const { daysUntilDeadline } = require("../lib/html");
const { extractSapErrorMessage, odataEscape, sapFetchCsrfToken, sapRead, sapWrite } = require("../lib/sap-client");
const { sapTsToIso } = require("../lib/sap-format");
const { fetchPrDraftByRfq, updatePrDraft } = require("./pr.service");
const { fetchAllVendorsFromSAP } = require("./vendor.service");


/**
 * Canh bao ve RFQ cho role PURCHASING — tinh lai tu SAP moi lan goi, giong
 * buildAgingAlerts (khong luu vao notificationStore nen khong bao gio mo coi,
 * va khong mat khi Vercel doi instance).
 *
 * Tra loi cho cau hoi "lam sao biet NCC da gui bao gia lai?": khong phai ngoi
 * canh hop thu nua — 3 loai canh bao duoi day tu hien tren chuong thong bao:
 *   1. co bao gia moi vao trong 24h qua
 *   2. RFQ sap het han ma con NCC chua nop
 *   3. RFQ da qua han — can nhac lai, gia han, hoac chot voi so bao gia dang co
 *
 * Chi 2 request SAP (RfqSet + QuotationSet toan bang) chu khong phai N+1: doc
 * QuotationSet khong kem key tra ve toan bo bang, gom theo RfqId o Node.
 */
async function buildRfqAlerts(role, email) {
	if (role !== "PURCHASING" || !process.env.SAP_HOST) { return []; }

	const alerts = [];
	try {
		const [rfqResp, quoteResp] = await Promise.all([sapRead("RfqSet"), sapRead("QuotationSet")]);
		const rfqs = (rfqResp.data && rfqResp.data.d && rfqResp.data.d.results) || [];
		const quotes = (quoteResp.data && quoteResp.data.d && quoteResp.data.d.results) || [];

		const byRfq = {};
		quotes.forEach(function (q) {
			const key = String(q.RfqId || "");
			(byRfq[key] = byRfq[key] || []).push(q);
		});

		const now = Date.now();
		rfqs.forEach(function (rfq) {
			const status = String(rfq.Status || "").toUpperCase();
			if (status !== "SENT" && status !== "QUOTATIONS_RECEIVED") { return; }

			const rfqId = String(rfq.RfqId || "");
			const list = byRfq[rfqId] || [];
			const received = list.filter((q) => q.QuoteStatus === "RECEIVED" || q.QuoteStatus === "AWARDED");
			const pendingCount = list.length - received.length;
			const daysLeft = daysUntilDeadline(rfq.Deadline);

			// 1) Bao gia moi trong 24h — mot dong cho moi NCC vua gui.
			received.forEach(function (q) {
				const enteredIso = sapTsToIso(q.EnteredAt, 0);
				const enteredMs = enteredIso ? new Date(enteredIso).getTime() : 0;
				if (!enteredMs || now - enteredMs > 86400000) { return; }
				alerts.push({
					id: "rfq-new-" + rfqId + "-" + q.VendorNo,
					toEmail: email,
					prId: rfq.SapPrNumber || rfq.PrId || rfqId,
					message: "Báo giá mới: " + (q.VendorName || q.VendorNo) + " đã gửi "
						+ Number(q.QuotedPrice || 0).toLocaleString("vi-VN") + " " + (q.Currency || "VND")
						+ " cho RFQ " + rfqId + " (" + received.length + "/" + list.length + " NCC đã nộp).",
					createdAt: enteredIso || new Date().toISOString(),
					read: false,
					aging: true
				});
			});

			// 2) Sap het han ma con NCC chua nop.
			if (daysLeft != null && daysLeft >= 0 && daysLeft <= RFQ_DUE_SOON_DAYS && pendingCount > 0) {
				alerts.push({
					id: "rfq-due-" + rfqId,
					toEmail: email,
					prId: rfq.SapPrNumber || rfq.PrId || rfqId,
					message: "RFQ " + rfqId + " còn " + daysLeft + " ngày tới hạn nộp báo giá, "
						+ pendingCount + "/" + list.length + " NCC chưa phản hồi — nên gửi nhắc hoặc gọi điện xác nhận.",
					createdAt: new Date().toISOString(),
					read: false,
					aging: true
				});
			}

			// 3) Da qua han.
			if (daysLeft != null && daysLeft < 0) {
				alerts.push({
					id: "rfq-overdue-" + rfqId,
					toEmail: email,
					prId: rfq.SapPrNumber || rfq.PrId || rfqId,
					message: "RFQ " + rfqId + " đã quá hạn nộp báo giá " + Math.abs(daysLeft) + " ngày — "
						+ (received.length === 0
							? "chưa có NCC nào báo giá. Cần nhắc lại, gia hạn hoặc mời thêm NCC."
							: "đã có " + received.length + "/" + list.length + " báo giá. Cần chốt NCC hoặc gia hạn."),
					createdAt: new Date().toISOString(),
					read: false,
					aging: true
				});
			}
		});
	} catch (error) {
		// Giong buildAgingAlerts: loi doc SAP khong duoc lam mat thong bao thuong.
		console.error("[buildRfqAlerts] Bo qua canh bao RFQ:", extractSapErrorMessage(error));
	}
	return alerts;
}
// ============================================================================
// API RFQ (Request for Quotation) — Z-table ZG1_RFQ / ZG1_QUOTATION qua OData
// RfqSet + QuotationSet, KHONG phai ME41 chuan cua SAP (quyet dinh da chot,
// xem KE_HOACH_RFQ_2_TUAN.md muc B3). Sinh RfqId dang RFQ-<nam>-<4 chu so>.
// ============================================================================

/** Sinh RfqId ke tiep bang cach dem so RFQ da co trong nam hien tai tren SAP. */
async function generateNextRfqId() {
	const year = new Date().getFullYear();
	const prefix = `RFQ-${year}-`;
	let maxSeq = 0;
	try {
		const response = await sapRead("RfqSet");
		const results = (response.data && response.data.d && response.data.d.results) || [];
		results.forEach(function (row) {
			const rid = String(row.RfqId || "");
			if (rid.indexOf(prefix) === 0) {
				const seq = parseInt(rid.slice(prefix.length), 10);
				if (!isNaN(seq) && seq > maxSeq) { maxSeq = seq; }
			}
		});
	} catch (error) {
		console.error("[generateNextRfqId] Khong doc duoc RfqSet, dung seq du phong:", error.message);
	}
	return prefix + String(maxSeq + 1).padStart(4, "0");
}

/** Doc RFQ + danh sach quotation + PR goc (kem items) — 3 route send/remind/portal dung chung. */
async function loadRfqContext(rfqId) {
	const rfqResp = await sapRead(`RfqSet('${odataEscape(rfqId)}')`);
	const rfq = rfqResp.data && rfqResp.data.d;
	if (!rfq) { return null; }

	const quotationsResp = await sapRead(`RfqSet('${odataEscape(rfqId)}')/RfqToQuotations`);
	const quotations = (quotationsResp.data && quotationsResp.data.d && quotationsResp.data.d.results) || [];

	// PR goc chi dung de lay danh sach vat tu cho vao mail/portal — doc loi thi
	// van gui duoc mail (bang vat tu se hien dong "se gui trong thu tra loi").
	let pr = null;
	try {
		pr = await fetchPrDraftByRfq(rfq);
	} catch (error) {
		console.error("[loadRfqContext] Doc PR goc that bai:", extractSapErrorMessage(error));
	}
	return { rfq: rfq, quotations: quotations, pr: pr };
}

/** Nhan mo ta PR de hien cho NCC: uu tien so PR that tren SAP. */
function prLabelOf(rfq, pr) {
	return String((pr && (pr.SapPRId || pr.PRId)) || rfq.SapPrNumber || rfq.PrId || "").trim();
}

/**
 * Email de gui cho tung NCC trong 1 RFQ.
 *
 * `ZG1_QUOTATION-VENDOR_EMAIL` la ANH CHUP tai thoi diem tao RFQ ("Email da gui
 * RFQ toi" — dung nghia field, phuc vu audit: sau nay master doi email thi van
 * biet luc do da gui di dau). Nhung neu luc tao RFQ master chua co email thi o
 * do rong VINH VIEN, va NCC do khong bao gio nhan duoc gi — ke ca sau khi da bo
 * sung email vao master.
 *
 * Nen: rong thi lay live tu VendorSet va danh dau `EmailFromMaster` de man hinh
 * noi ro "email nay lay tu master, chua tung gui RFQ toi day". Doc master loi
 * thi coi nhu khong co email, KHONG lam hong ca luong gui.
 */
async function resolveQuotationEmails(quotations) {
	const list = quotations || [];
	if (!list.some((q) => !q.VendorEmail)) {
		return list.map((q) => Object.assign({}, q, { EmailFromMaster: false }));
	}

	const masterEmail = {};
	try {
		(await fetchAllVendorsFromSAP()).forEach(function (v) {
			masterEmail[String(v.VendorNo)] = v.Email || v.VendorEmail || "";
		});
	} catch (error) {
		console.error("[resolveQuotationEmails] Khong doc duoc VendorSet:", extractSapErrorMessage(error));
	}

	return list.map(function (q) {
		if (q.VendorEmail) { return Object.assign({}, q, { EmailFromMaster: false }); }
		const email = masterEmail[String(q.VendorNo)] || "";
		return Object.assign({}, q, { VendorEmail: email, EmailFromMaster: !!email });
	});
}

/**
 * Ghi nguoc email vua lay tu master vao dong quotation, SAU KHI da gui thanh
 * cong — de lan sau khoi tra master nua va de audit trail ghi dung "da gui toi
 * dia chi nao". Loi ghi khong duoc lam hong ket qua gui mail.
 */
async function backfillQuotationEmails(rfqId, resolvedQuotations) {
	const toFix = (resolvedQuotations || []).filter((q) => q.EmailFromMaster && q.VendorEmail);
	if (toFix.length === 0) { return; }
	try {
		const session = await sapFetchCsrfToken();
		for (const q of toFix) {
			await sapWrite(
				"MERGE",
				`QuotationSet(RfqId='${odataEscape(rfqId)}',VendorNo='${odataEscape(q.VendorNo)}')`,
				{ VendorEmail: q.VendorEmail },
				session
			);
		}
	} catch (error) {
		console.error("[backfillQuotationEmails] Bo qua ghi nguoc email:", extractSapErrorMessage(error));
	}
}

/**
 * Sau khi 1 bao gia duoc ghi nhan (Purchasing nhap tay HOAC NCC tu gui qua
 * portal): nang RFQ DRAFT/SENT -> QUOTATIONS_RECEIVED va phan anh len PR goc.
 * Khong bao gio ha cap RFQ da AWARDED.
 */
async function promoteRfqAfterQuotation(rfqId, session) {
	const rfqResp = await sapRead(`RfqSet('${odataEscape(rfqId)}')`);
	const rfq = rfqResp.data && rfqResp.data.d;
	if (!rfq || (rfq.Status !== "DRAFT" && rfq.Status !== "SENT")) { return; }

	await sapWrite("MERGE", `RfqSet('${odataEscape(rfqId)}')`, { Status: "QUOTATIONS_RECEIVED" }, session);

	const prRecord = await fetchPrDraftByRfq(rfq);
	if (prRecord && (prRecord.Status === "PENDING_RFQ" || prRecord.Status === "RFQ_SENT")) {
		await updatePrDraft(prRecord.InternalId, { Status: "QUOTATIONS_RECEIVED" });
	}
}
module.exports = {
	backfillQuotationEmails,
	buildRfqAlerts,
	generateNextRfqId,
	loadRfqContext,
	prLabelOf,
	promoteRfqAfterQuotation,
	resolveQuotationEmails,
};
