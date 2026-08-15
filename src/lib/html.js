/**
 * Helper dung khi dung chuoi HTML cho email.
 *
 * Tach ra tu server.js (ban goc 4520 dong) ngay 15/08/2026.
 * Noi dung ham giu nguyen 100%, chi them phan require/exports o dau va cuoi file.
 */


const { normalizeSapDeadline, sapDateOnly } = require("./sap-format");


// ============================================================================
// EMAIL MOI BAO GIA — template dung chung cho lan gui dau va lan nhac
// ============================================================================

/** Chan noi dung tu SAP/nguoi dung truoc khi nhet vao HTML email. */
function htmlEscape(v) {
	return String(v == null ? "" : v)
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}

/** "20260820" (DATS cua SAP) -> "20/08/2026". Chuoi khac dinh dang thi tra ve nguyen van. */
function formatDeadlineVi(dats) {
	const s = String(dats || "").replace(/-/g, "").trim();
	if (!/^\d{8}$/.test(s)) { return String(dats || ""); }
	return s.slice(6, 8) + "/" + s.slice(4, 6) + "/" + s.slice(0, 4);
}

/** So ngay con lai tinh tu hom nay toi han nop (am = da qua han). null neu khong co han. */
function daysUntilDeadline(dats) {
	const s = normalizeSapDeadline(dats);
	if (!s) { return null; }
	const due = Date.UTC(Number(s.slice(0, 4)), Number(s.slice(4, 6)) - 1, Number(s.slice(6, 8)));
	const today = normalizeSapDeadline(sapDateOnly());
	const now = Date.UTC(Number(today.slice(0, 4)), Number(today.slice(4, 6)) - 1, Number(today.slice(6, 8)));
	return Math.round((due - now) / 86400000);
}
module.exports = {
	daysUntilDeadline,
	formatDeadlineVi,
	htmlEscape,
};
