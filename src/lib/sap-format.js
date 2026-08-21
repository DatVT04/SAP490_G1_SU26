/**
 * Chuyen doi kieu du lieu qua lai giua SAP (DATS/TIMESTAMP/'X') va JS.
 *
 * Tach ra tu server.js (ban goc 4520 dong) ngay 15/08/2026.
 * Noi dung ham giu nguyen 100%, chi them phan require/exports o dau va cuoi file.
 */


const { SAP_TZ_OFFSET_MIN } = require("../config/org");


/**
 * 5 field ngay gio cua RFQ/Quotation (CreatedAt, SentAt, Deadline, AwardedAt, EnteredAt)
 * la Edm.String 14 ky tu YYYYMMDDHHMMSS, KHONG phai Edm.DateTime — xem CLAUDE.md.
 */
function sapTimestamp(date) {
	// Ghi UTC (getUTC*) chu khong phai gio local cua may chay Node: tren Vercel
	// local = UTC nen khong khac gi, nhung chay dev tren may Windows VN (UTC+7)
	// ma dung getHours() thi cung 1 field se khi UTC khi VN — khong doc lai duoc.
	const d = date || new Date();
	const p = (n) => String(n).padStart(2, "0");
	return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`;
}

/** Field Deadline la DATS 8 ky tu YYYYMMDD (khac 14 ky tu cua 4 field TIMESTAMP con lai). */
function sapDateOnly(date) {
	const d = date || new Date();
	const p = (n) => String(n).padStart(2, "0");
	return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}`;
}

/** Chuan hoa deadline FE gui len (vd "2026-08-20" hoac da la "20260820") ve 8 ky tu, hoac "" neu khong hop le. */
function normalizeSapDeadline(input) {
	if (!input) { return ""; }
	const digits = String(input).replace(/-/g, "").slice(0, 8);
	if (!/^\d{8}$/.test(digits)) { return ""; }
	// 21/08/2026: kiem them ngay CO THAT. Truoc day chi dem du 8 chu so nen
	// "2026-99-99" van lot qua, day thang xuong SAP roi moi vo o duoi.
	const y = Number(digits.slice(0, 4));
	const m = Number(digits.slice(4, 6));
	const d = Number(digits.slice(6, 8));
	const dt = new Date(Date.UTC(y, m - 1, d));
	const real = dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
	return real ? digits : "";
}

// ============================================================================
// PrDraftSet / PrDraftItemSet — thay the hoan toan approvalStore/approvals.json.
// PR "nhap" (draft, chua sang SAP that) gio luu qua OData service ZG1_PROC_SRV_SRV
// (bang ZPR_DRAFT / ZPR_DRAFT_ITEM). Xem CLAUDE.md muc SEGW PrDraftSet.
//
// Field cua SAP entity PrDraft trung ten voi field cu tren approvalStore o HAU HET
// truong hop (PRId, InternalId, SapPRId, RequesterEmail, TotalValue, Currency,
// Status, Comment, DecidedByEmail/Role, PurchasingApprovedBy/Action/At,
// CfoProcessedBy/Action/At, CeoProcessedBy/Action/At, EscalationReason, RfqId,
// RfqAwardedVendor, RfqFinalValue, EstimatedTotalValue). Chi 4 cho khac phai
// chuyen doi 2 chieu khi doc/ghi:
//   1) CreatedAt/UpdatedAt: SAP tra ve chuoi 14 ky tu YYYYMMDDHHMMSS (Edm.String),
//      khong phai ISO — cac formatter tren FE (formatViTime, formatDate...) dung
//      `new Date(sIso)` nen bat buoc doi sang ISO khi tra ve FE.
//   2) NeedsProcurementHeadReview / NeedsLegalReview / IsFreeText: SAP la co "X"/"",
//      FE/Node dung boolean true/false (needsProcurementHeadReview, isFreeText).
//   3) IoThreshold: SAP Edm.Decimal mac dinh "0.00" (khong null) khi khong co
//      escalation — FE chi hien thi field nay khi needsProcurementHeadReview=true
//      nen khong can ep ve null rieng.
//   4) PRId: truoc day Node tu sinh "PR-<nam>-<seq>"; gio la InternalId SNRO
//      10 chu so do ABAP CREATE_DEEP_ENTITY sinh ra — FE chi dung PRId nhu chuoi
//      opaque (khong parse dinh dang) nen an toan.
// ============================================================================

/** SAP tra ve "X"/"" cho field boolean-like — chuyen ve true/false cho Node/FE. */
function sapXToBool(x) {
	return x === "X" || x === true;
}

/** Nguoc lai: boolean Node/FE -> "X"/"" cho SAP. */
function boolToSapX(b) {
	return b ? "X" : "";
}

/**
 * Chuoi 14 ky tu YYYYMMDDHHMMSS -> ISO 8601 UTC (de FE dung duoc new Date()).
 * offsetMin = so phut ma dong ho DA GHI chuoi nay di truoc UTC:
 *   - field do ABAP dong dau (ZPR_DRAFT *At) -> SAP_TZ_OFFSET_MIN (SAP server CEST)
 *   - field do Node dong dau (RFQ/Quotation) -> 0 (sapTimestamp() ghi UTC)
 */
function sapTsToIso(ts, offsetMin) {
	const s = String(ts || "").trim();
	if (!/^\d{14}$/.test(s)) { return s || null; }
	const ms = Date.UTC(
		Number(s.slice(0, 4)), Number(s.slice(4, 6)) - 1, Number(s.slice(6, 8)),
		Number(s.slice(8, 10)), Number(s.slice(10, 12)), Number(s.slice(12, 14))
	) - (Number(offsetMin) || 0) * 60000;
	const d = new Date(ms);
	return isNaN(d.getTime()) ? null : d.toISOString();
}

/** Timestamp do ABAP dong dau (gio he thong SAP) -> ISO UTC. */
function abapTsToIso(ts) {
	return sapTsToIso(ts, SAP_TZ_OFFSET_MIN);
}

/** Doi timestamp 14 ky tu (do Node ghi, UTC) trong 1 object RFQ/Quotation ve ISO — tra ve ban sao. */
function rfqTimesToIso(obj) {
	if (!obj) { return obj; }
	const out = Object.assign({}, obj);
	["CreatedAt", "SentAt", "AwardedAt", "EnteredAt"].forEach(function (f) {
		if (/^\d{14}$/.test(String(out[f] || ""))) {
			out[f] = sapTsToIso(out[f], 0);
		}
	});
	return out;
}
module.exports = {
	abapTsToIso,
	boolToSapX,
	normalizeSapDeadline,
	rfqTimesToIso,
	sapDateOnly,
	sapTimestamp,
	sapTsToIso,
	sapXToBool,
};
