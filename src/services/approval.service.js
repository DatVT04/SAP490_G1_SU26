/**
 * Luat duyet: xac dinh cap duyet can thiet + canh bao PR de lau.
 *
 * Tach ra tu server.js (ban goc 4520 dong) ngay 15/08/2026.
 * Noi dung ham giu nguyen 100%, chi them phan require/exports o dau va cuoi file.
 */


const { AGING_ALERT_DAYS, AGING_STATUS_BY_ROLE } = require("../config/alerts");
const { LEGAL_ESCALATION_THRESHOLD } = require("../config/org");
const { extractSapErrorMessage } = require("../lib/sap-client");
const { getThresholdForIO, normalizeOrderNo } = require("../lib/store");
const { fetchInternalOrderMaster } = require("./masterdata.service");
const { fetchPrDraftList } = require("./pr.service");


/**
 * Leo CEO khi total > ngưỡng của ít nhất 1 IO đã cấu hình.
 * Không còn số 300tr cố định.
 */
function buildApprovalFlags(totalValue, items) {
	const total = Number(totalValue) || 0;
	let needCeo = false;
	let hitThreshold = null;
	let hitIO = null;

	(items || []).forEach(function (it) {
		const io = it.internalOrder || it.InternalOrder || "";
		const t = getThresholdForIO(io);
		if (t != null && total > t) {
			needCeo = true;
			if (hitThreshold == null || t < hitThreshold) {
				hitThreshold = t;
				hitIO = normalizeOrderNo(io);
			}
		}
	});

	return {
		needsProcurementHeadReview: needCeo,
		needsLegalReview: total > LEGAL_ESCALATION_THRESHOLD,
		ioThreshold: hitThreshold,
		escalationIO: hitIO
	};
}

/**
 * IO NGAN SACH cua 1 cost center — dung khi hach toan Cat 'F'.
 *
 * Thiet ke cua nhom: moi phong = 1 cost center = 1 IO ngan sach. Nhung du lieu
 * that co the co nhieu IO tren 1 cost center, nen uu tien IO DA DAT NGUONG
 * (do la IO ngan sach thuc su cua phong); khong co cai nao dat nguong thi lay
 * cai dau tien. Tra ve "" khi cost center chua gan IO nao — luc do phai quay ve
 * Cat 'K', vi khong the hach toan Cat 'F' ma khong co so order.
 */
async function budgetOrderOfCostCenter(costCenter) {
	const cc = String(costCenter || "").trim();
	if (!cc) { return ""; }
	try {
		const master = await fetchInternalOrderMaster();
		const list = (master.costCenterToIOs || {})[cc] || [];
		if (!list.length) { return ""; }
		const withThreshold = list.find(function (io) { return getThresholdForIO(io) != null; });
		return normalizeOrderNo(withThreshold || list[0]);
	} catch (error) {
		console.error("[budgetOrderOfCostCenter] Doc danh muc IO that bai:", extractSapErrorMessage(error));
		return "";
	}
}

/**
 * Bao boc buildApprovalFlags cho thiet ke "chi con Cat K va A".
 *
 * Item khong con mang InternalOrder (Cat 'K' chi gui CostCenter len SAP), trong khi
 * buildApprovalFlags lai tra nguong theo IO. Nen o day suy nguoc IO ngan sach tu
 * CostCenter roi moi tinh. Mang expanded chi ton tai trong ham nay, KHONG ghi vao
 * PR nao ca.
 *
 * Phai dung o CA HAI cho: luc submit PR (gia uoc tinh) va luc recalc sau khi award
 * RFQ (gia thuc te tu bao gia — day moi la con so quyet dinh co leo CEO hay khong).
 * Quen cho thu hai thi PR dat hon nguong van truot thang qua CFO.
 */
async function buildApprovalFlagsByCostCenter(totalValue, items) {
	const master = await fetchInternalOrderMaster();
	const ccToIOs = master.costCenterToIOs || {};
	const expanded = [];

	(items || []).forEach(function (it) {
		const cc = String(it.CostCenter || it.costCenter || "").trim();
		const aIO = ccToIOs[cc] || [];
		if (!aIO.length) { expanded.push(it); return; }
		// Phong co nhieu IO thi xet het — buildApprovalFlags tu lay nguong thap nhat.
		aIO.forEach(function (io) {
			expanded.push(Object.assign({}, it, { InternalOrder: io }));
		});
	});

	return buildApprovalFlags(totalValue, expanded);
}

/**
 * Sinh danh sach canh bao "PR treo lau" cho 1 role — KHONG luu vao notificationStore
 * (tinh lai moi lan goi tu trang thai that tren SAP nen khong bao gio lech/mo coi;
 * PR duoc xu ly xong la canh bao tu bien mat). id dang "aging-<PRId>" de FE biet
 * day khong phai thong bao thuong (khong goi PATCH read cho no).
 */
async function buildAgingAlerts(role, email) {
	const statusMap = AGING_STATUS_BY_ROLE[role];
	if (!statusMap || !process.env.SAP_HOST) { return []; }

	const alerts = [];
	try {
		const allDrafts = await fetchPrDraftList();
		const now = Date.now();
		allDrafts.forEach(function (pr) {
			const stepLabel = statusMap[String(pr.Status || "").toUpperCase()];
			if (!stepLabel) { return; }
			// UpdatedAt = luc PR buoc vao trang thai hien tai (moi lan doi trang thai
			// ABAP deu dong dau lai) — do chinh la "da cho bao lau o buoc nay".
			const refTime = new Date(pr.UpdatedAt || pr.CreatedAt || 0).getTime();
			if (!refTime) { return; }
			const waitedDays = Math.floor((now - refTime) / 86400000);
			if (waitedDays < AGING_ALERT_DAYS) { return; }

			const totalDays = Math.floor((now - new Date(pr.CreatedAt || 0).getTime()) / 86400000);
			alerts.push({
				id: "aging-" + pr.PRId,
				toEmail: email,
				prId: pr.PRId,
				message: "PR " + pr.PRId + " của " + (pr.RequesterEmail || "?")
					+ " đã " + waitedDays + " ngày ở bước " + stepLabel
					+ (totalDays > waitedDays ? " (tổng " + totalDays + " ngày trên hệ thống)" : "")
					+ ". Giá trị: " + Number(pr.TotalValue || 0).toLocaleString("vi-VN")
					+ " " + (pr.Currency || "VND") + " — cần xử lý.",
				createdAt: new Date().toISOString(),
				read: false,
				aging: true
			});
		});
	} catch (error) {
		// Loi doc SAP khong duoc lam mat thong bao thuong — chi bo qua phan aging.
		console.error("[buildAgingAlerts] Bo qua canh bao aging:", extractSapErrorMessage(error));
	}
	return alerts;
}
module.exports = {
	buildAgingAlerts,
	budgetOrderOfCostCenter,
	buildApprovalFlagsByCostCenter,
};
