/**
 * CAN CU DUYET — du lieu de nguoi duyet dua vao ma quyet dinh, thay vi chi nhin
 * noi dung de nghi roi bam theo cam tinh.
 *
 * Hai cua duyet tra loi hai cau khac nhau nen can hai bo can cu khac nhau:
 *
 *   Purchasing duyet PR = duyet NHU CAU ("co dang mua khong?")
 *     - Ngan sach phong con bao nhieu, duyet cai nay xong con bao nhieu
 *     - Vat tu nay co dang duoc de nghi o don khac khong (mua trung)
 *     - Ly do de nghi mua (nguoi de nghi tu khai o PR-01)
 *
 *   CFO/CEO duyet PO = duyet TIEN ("co dang chi khong?")
 *     - Moi bao nhieu NCC, nhan duoc may bao gia (co canh tranh that khong)
 *     - Gia thap nhat / cao nhat / gia da chon; neu KHONG chon gia thap nhat
 *       thi phai co ly do — day la cho de bi chat van nhat
 *     - NCC thang co du ho so phap ly khong, dieu khoan thanh toan the nao
 *
 * Tat ca deu tinh tu du lieu DA CO (ZPR_DRAFT, ZG1_RFQ, ZG1_QUOTATION) — khong
 * can them bang hay entity nao tren SAP.
 */


const { extractSapErrorMessage, odataEscape, sapRead } = require("../lib/sap-client");
const { describePaymentTerms } = require("../config/payment-terms");
const { getThresholdForIO, normalizeOrderNo } = require("../lib/store");
const { fetchInternalOrderMaster } = require("./masterdata.service");
const { fetchPrDraftList } = require("./pr.service");

/**
 * Cac trang thai coi la DANG CHIEM ngan sach: de nghi da gui va chua ket thuc.
 * REJECTED / PO_REJECTED da chet nen tra lai ngan sach. PO_RELEASED van tinh vi
 * do la tien da thuc su cam ket voi NCC.
 */
const COMMITTED_STATUSES = [
	"PENDING_PURCHASING", "PENDING_RFQ", "RFQ_SENT", "QUOTATIONS_RECEIVED",
	"AWARDED", "PENDING_CFO", "PENDING_CEO", "PO_RELEASED"
];

/** Trang thai coi la "de nghi con song" — dung cho canh bao mua trung. */
const OPEN_STATUSES = COMMITTED_STATUSES;

/** Gia tri 1 dong = so luong x don gia (dung cach PR-01 tinh tong khi gui len). */
function lineAmount(item) {
	return (Number(item && item.Quantity) || 0) * (Number(item && item.EstimatedValue) || 0);
}

/** Tong tien cua 1 PR gom theo tung cost center. */
function amountByCostCenter(pr) {
	const byCC = {};
	let sum = 0;
	((pr && pr.items) || []).forEach(function (it) {
		const cc = String(it.CostCenter || "").trim();
		const amount = lineAmount(it);
		sum += amount;
		if (!cc) { return; }
		byCC[cc] = (byCC[cc] || 0) + amount;
	});

	// Du lieu cu (hoac dong khong co cost center) co the ra 0 trong khi header van
	// co TotalValue — khi do dung TotalValue va gan het cho cost center dau tien
	// doc duoc, con hon la bao ngan sach da dung = 0.
	if (sum <= 0 && Number(pr && pr.TotalValue) > 0) {
		const firstCC = ((pr.items || []).find(function (it) { return it.CostCenter; }) || {}).CostCenter;
		if (firstCC) { byCC[String(firstCC).trim()] = Number(pr.TotalValue); }
	}
	return byCC;
}

function prKey(pr) {
	return String((pr && (pr.InternalId || pr.PRId)) || "");
}

/**
 * Gan `BudgetContext` + `DuplicateWarnings` vao tung PR dang cho Purchasing duyet.
 *
 * Doc CA BANG ZPR_DRAFT dung 1 lan (bang nay nho — vai chuc dong) roi tinh tai
 * Node, thay vi ban N request theo tung PR.
 */
async function attachPurchasingContext(pendingList) {
	if (!Array.isArray(pendingList) || pendingList.length === 0) { return; }

	let allPrs = [];
	let ccToIOs = {};
	try {
		allPrs = await fetchPrDraftList();
		const master = await fetchInternalOrderMaster();
		ccToIOs = master.costCenterToIOs || {};
	} catch (error) {
		console.error("[decision-context] Doc du lieu de tinh can cu duyet that bai:",
			extractSapErrorMessage(error));
		return;
	}

	// ── Ngan sach da cam ket theo cost center ──
	const committedByCC = {};
	allPrs.forEach(function (pr) {
		if (COMMITTED_STATUSES.indexOf(String(pr.Status || "").toUpperCase()) === -1) { return; }
		const byCC = amountByCostCenter(pr);
		Object.keys(byCC).forEach(function (cc) {
			if (!committedByCC[cc]) { committedByCC[cc] = { total: 0, byPr: {} }; }
			committedByCC[cc].total += byCC[cc];
			committedByCC[cc].byPr[prKey(pr)] = byCC[cc];
		});
	});

	// ── Cac de nghi con song, gom theo ma vat tu (de bat mua trung) ──
	const openByMaterial = {};
	allPrs.forEach(function (pr) {
		if (OPEN_STATUSES.indexOf(String(pr.Status || "").toUpperCase()) === -1) { return; }
		((pr.items || []).forEach(function (it) {
			const mat = String(it.MaterialNo || "").trim().toUpperCase();
			if (!mat) { return; }
			if (!openByMaterial[mat]) { openByMaterial[mat] = []; }
			openByMaterial[mat].push({
				key: prKey(pr),
				DisplayId: pr.DisplayId || pr.PRId || "",
				Status: pr.Status || "",
				CostCenter: String(it.CostCenter || "").trim(),
				RequesterEmail: pr.RequesterEmail || "",
				Quantity: Number(it.Quantity) || 0,
				UoM: it.UoM || "",
				CreatedAt: pr.CreatedAt || ""
			});
		}));
	});

	pendingList.forEach(function (pr) {
		const selfKey = prKey(pr);
		const byCC = amountByCostCenter(pr);

		// ── 1. Ngan sach tung phong ma de nghi nay dung toi ──
		pr.BudgetContext = Object.keys(byCC).map(function (cc) {
			const ios = ccToIOs[cc] || [];
			// Phong co nhieu IO thi lay IO co nguong THAP NHAT — cung quy tac voi
			// buildApprovalFlags (leo CEO theo nguong thap nhat bi vuot).
			let io = "";
			let threshold = null;
			ios.forEach(function (candidate) {
				const t = getThresholdForIO(candidate);
				if (t == null) { return; }
				if (threshold == null || t < threshold) {
					threshold = t;
					io = normalizeOrderNo(candidate);
				}
			});

			const bucket = committedByCC[cc] || { total: 0, byPr: {} };
			// Tru phan cua CHINH de nghi nay ra khoi "da cam ket", neu khong se bi
			// dem 2 lan khi tinh "duyet xong con lai bao nhieu".
			const committedOthers = bucket.total - (bucket.byPr[selfKey] || 0);
			const thisAmount = byCC[cc];

			return {
				CostCenter: cc,
				InternalOrder: io,
				Threshold: threshold,
				Committed: committedOthers,
				Remaining: threshold != null ? (threshold - committedOthers) : null,
				ThisRequest: thisAmount,
				RemainingAfter: threshold != null ? (threshold - committedOthers - thisAmount) : null
			};
		});

		// ── 2. Vat tu nay dang duoc de nghi o don khac ──
		const seen = {};
		const dups = [];
		((pr.items || []).forEach(function (it) {
			const mat = String(it.MaterialNo || "").trim().toUpperCase();
			if (!mat) { return; }
			(openByMaterial[mat] || []).forEach(function (other) {
				if (other.key === selfKey) { return; }
				const dedupKey = mat + "|" + other.key;
				if (seen[dedupKey]) { return; }
				seen[dedupKey] = true;
				dups.push(Object.assign({
					MaterialNo: it.MaterialNo || "",
					Description: it.Description || ""
				}, other));
			});
		}));
		pr.DuplicateWarnings = dups;
	});
}

/**
 * Bang chung canh tranh gia cho 1 nhom (1 RFQ = 1 PO). Doc thang ZG1_QUOTATION
 * qua navigation cua RFQ.
 *
 * Tra ve null neu nhom khong di qua RFQ (khong co gi de chung minh) — FE hien
 * dong nhac rieng cho truong hop do thay vi bang so 0.
 */
async function buildQuotationEvidence(group) {
	const rfqId = String((group && group.RfqId) || "").trim();
	if (!rfqId) { return null; }

	let rows = [];
	try {
		const resp = await sapRead(`RfqSet('${odataEscape(rfqId)}')/RfqToQuotations`);
		rows = (resp.data && resp.data.d && resp.data.d.results) || [];
	} catch (error) {
		console.error("[decision-context] Doc bao gia cua " + rfqId + " that bai:",
			extractSapErrorMessage(error));
		return null;
	}
	if (!rows.length) { return null; }

	const received = rows.filter(function (q) {
		return q.QuoteStatus === "RECEIVED" || q.QuoteStatus === "AWARDED";
	});
	const prices = received
		.map(function (q) { return Number(q.QuotedPrice) || 0; })
		.filter(function (p) { return p > 0; });

	const awardedVendor = String((group && group.AwardedVendor) || "").trim();
	const chosen = received.find(function (q) {
		return String(q.VendorNo) === awardedVendor;
	}) || null;

	const lowest = prices.length ? Math.min.apply(null, prices) : 0;
	const highest = prices.length ? Math.max.apply(null, prices) : 0;
	const chosenPrice = chosen ? (Number(chosen.QuotedPrice) || 0) : 0;

	return {
		RfqId: rfqId,
		Invited: rows.length,
		Received: received.length,
		LowestPrice: lowest,
		HighestPrice: highest,
		ChosenPrice: chosenPrice,
		ChosenVendorNo: awardedVendor,
		ChosenVendorName: (chosen && chosen.VendorName) || (group && group.AwardedVendorName) || "",
		// Chon gia cao hon gia thap nhat = phai giai trinh. Day la cau hoi so 1 cua
		// bat ky ai duyet chi tieu.
		ChosenIsLowest: !!(chosenPrice > 0 && lowest > 0 && chosenPrice <= lowest),
		ExtraVsLowest: (chosenPrice > 0 && lowest > 0) ? (chosenPrice - lowest) : 0,
		SavedVsHighest: (chosenPrice > 0 && highest > 0) ? (highest - chosenPrice) : 0,
		// Chi 1 bao gia = chi dinh thau, khong co canh tranh — canh bao rieng.
		SingleQuote: received.length <= 1,
		LegalDocsOk: !!(chosen && String(chosen.LegalDocsOk || "").trim().toUpperCase() === "X"),
		PaymentTerms: describePaymentTerms(chosen && chosen.PaymentTerms),
		LeadTimeDays: chosen ? (Number(chosen.LeadTimeDays) || 0) : 0,
		WarrantyMonths: chosen ? (Number(chosen.WarrantyMonths) || 0) : 0,
		AwardReason: (group && group.AwardReason) || ""
	};
}

/** Gan Evidence vao tung PoGroups cua 1 PR. Loi doc KHONG lam hong man duyet. */
async function attachQuotationEvidence(pr) {
	const groups = (pr && pr.PoGroups) || [];
	for (const group of groups) {
		try {
			group.Evidence = await buildQuotationEvidence(group);
		} catch (error) {
			console.error("[decision-context] Dung bang chung bao gia that bai:", error.message);
			group.Evidence = null;
		}
	}
}
module.exports = {
	attachPurchasingContext,
	attachQuotationEvidence,
	buildQuotationEvidence,
};
