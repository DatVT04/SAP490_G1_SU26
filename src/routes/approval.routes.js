/**
 * Luong PR: gui duyet, danh sach cho duyet, lich su, duyet/tu choi.
 *
 * Tach ra tu server.js (ban goc 4520 dong) ngay 15/08/2026.
 * Noi dung ham giu nguyen 100%, chi them phan require/exports o dau va cuoi file.
 */


const express = require("express");
const { findActiveEmployeeByEmail } = require("../services/employee.service");
const { extractSapErrorMessage, odataEscape } = require("../lib/sap-client");
const { boolToSapX } = require("../lib/sap-format");
const { buildApprovalFlagsByCostCenter } = require("../services/approval.service");
const { notifyPurchasing, notifyRequester } = require("../services/notify.service");
const { attachPoNumbers, createPRInSAP, createPrDraft, enrichWithRfqAward, fetchPrDraftById, fetchPrDraftList, mapClientItemToSapDeep, updatePrDraft } = require("../services/pr.service");

const router = express.Router();


router.post("/api/approval/submit", async (req, res) => {
	const { requesterEmail, currency, totalPRValue, items, resubmitOf } = req.body || {};

	if (!requesterEmail) {
		return res.status(400).json({ success: false, message: "Thieu thong tin nguoi de nghi." });
	}
	if (!Array.isArray(items) || items.length === 0) {
		return res.status(400).json({ success: false, message: "PR phai co it nhat 1 vat tu." });
	}
	for (var i = 0; i < items.length; i++) {
		var it = items[i];
		if (!it.description) {
			return res.status(400).json({ success: false, message: "Dong " + (i + 1) + ": Thieu mo ta vat tu." });
		}
		if (!it.quantity || Number(it.quantity) <= 0) {
			return res.status(400).json({ success: false, message: "Dong " + (i + 1) + ": So luong khong hop le." });
		}
		// Account assignment chi con 2 loai: ZAST -> bat buoc AssetNo (Cat 'A');
		// con lai bat buoc Cost Center (Cat 'K'). Internal Order khong phai input
		// cua nguoi dung nua nen khong validate.
		if (it.materialType === "ZAST") {
			if (!String(it.assetNo || "").trim()) {
				return res.status(400).json({ success: false, message: "Dong " + (i + 1) + ": Vat tu Tai san (ZAST) bat buoc nhap Asset No." });
			}
		} else if (!String(it.costCenter || "").trim()) {
			return res.status(400).json({ success: false, message: "Dong " + (i + 1) + ": Bat buoc chon bo phan (Cost Center)." });
		}
	}

	if (!process.env.SAP_HOST) {
		return res.status(503).json({ success: false, message: "He thong SAP chua duoc cau hinh (thieu SAP_HOST)." });
	}

	// ── CHOT CHAN: chi duoc lap de nghi cho CHINH bo phan cua minh ──────────
	// Khoa o giao dien (PR01) chi la tien nghi — ai mo DevTools hoac goi thang
	// API nay van gui duoc cost center bat ky. Doi chieu lai voi EmployeeSet
	// tren SAP theo email nguoi gui, khong tin gia tri nao do client gui len.
	let employeeCC = "";
	try {
		const employee = await findActiveEmployeeByEmail(String(requesterEmail).trim());
		if (!employee) {
			return res.status(403).json({
				success: false,
				message: "Không tìm thấy nhân viên " + requesterEmail + " trên hệ thống."
			});
		}
		employeeCC = String(employee.CostCenter || "").trim().toUpperCase();
	} catch (error) {
		console.error("[POST /api/approval/submit] Doc EmployeeSet that bai:", extractSapErrorMessage(error));
		return res.status(502).json({ success: false, message: "Không kiểm tra được bộ phận của người đề nghị. Vui lòng thử lại." });
	}

	if (!employeeCC) {
		return res.status(403).json({
			success: false,
			message: "Tài khoản của bạn chưa được gán Bộ phận (Cost Center) trên SAP nên chưa lập được đề nghị mua sắm."
		});
	}

	for (var c = 0; c < items.length; c++) {
		const lineCC = String(items[c].costCenter || "").trim().toUpperCase();
		if (lineCC && lineCC !== employeeCC) {
			return res.status(403).json({
				success: false,
				message: "Dòng " + (c + 1) + ": bạn chỉ được lập đề nghị cho bộ phận " + employeeCC
					+ ", không được lập cho " + lineCC + "."
			});
		}
		// Dong khong gui cost center -> gan bang bo phan cua nguoi de nghi, khong
		// de rong roi cho SAP tu quyet.
		items[c].costCenter = employeeCC;
	}

	// Chi con 2 loai account assignment: 'A' (vat tu Tai san) va 'K' (Cost Center).
	// Cau hinh cua nhom: moi phong ban = 1 Cost Center, va moi Cost Center gan dung
	// 1 Internal Order ngan sach -> IO khong phai mot "loai" rieng, no la ngan sach
	// cua chinh phong do. Nen KHONG con Cat 'F': PR len SAP luon mang CostCenter.
	const mappedItems = items.map(function (item, idx) {
		var sMaterialType = item.materialType || "ZSRV";
		var sCat = sMaterialType === "ZAST" ? "A" : "K";
		return {
			LineNo: String(idx + 1).padStart(5, "0"),
			MaterialNo: item.materialNo || "",
			MaterialType: sMaterialType,
			Description: item.description || "",
			Quantity: Number(item.quantity),
			UoM: item.uom || "PC",
			EstimatedValue: Number(item.estimatedValue) || 0,
			AcctAssignCat: sCat,
			CostCenter: sCat === "K" ? (item.costCenter || "") : "",
			// Luon rong: khong con Cat 'F'. Xem itemsForFlags ben duoi de biet nguong
			// ngan sach van duoc tinh — suy tu CostCenter chu khong tu field nay.
			InternalOrder: "",
			AssetNo: sCat === "A" ? (item.assetNo || "") : "",
			isFreeText: item.isFreeText || false
		};
	});

	const flags = await buildApprovalFlagsByCostCenter(totalPRValue || 0, mappedItems);

	// Deep-entity POST: header + toan bo dong item long trong PrDraftToItems.
	// InternalId (PRId) do ABAP CREATE_DEEP_ENTITY sinh qua SNRO ZPRDRAFT,
	// KHONG con tu sinh "PR-<nam>-<seq>" o Node nhu truoc.
	const payload = {
		RequesterEmail: requesterEmail,
		TotalValue: String(totalPRValue || 0),
		Currency: currency || "VND",
		Comment: "",
		NeedsProcurementHeadReview: boolToSapX(flags.needsProcurementHeadReview),
		NeedsLegalReview: boolToSapX(flags.needsLegalReview),
		IoThreshold: flags.ioThreshold != null ? String(flags.ioThreshold) : "0",
		EscalationIO: flags.escalationIO || "",
		EstimatedTotalValue: String(totalPRValue || 0),
		PrDraftToItems: mappedItems.map(mapClientItemToSapDeep)
	};

	// Neu day la ban GUI LAI cua 1 PR bi tra (RETURNED): kiem tra ban cu truoc khi
	// tao ban moi, de khong bao gio roi vao tinh trang co 2 ban cung song song.
	let oldRecord = null;
	if (resubmitOf) {
		try {
			oldRecord = await fetchPrDraftById(resubmitOf);
		} catch (error) {
			const message = extractSapErrorMessage(error);
			console.error("[POST /api/approval/submit] Doc ban cu (resubmitOf) THAT BAI:", message);
			return res.status(502).json({ success: false, message });
		}
		if (!oldRecord) {
			return res.status(404).json({ success: false, message: "Khong tim thay de nghi cu " + resubmitOf + " de gui lai." });
		}
		if (oldRecord.Status !== "REJECTED") {
			return res.status(400).json({
				success: false,
				message: "De nghi " + resubmitOf + " dang o trang thai " + oldRecord.Status
					+ " — chi de nghi da bi tu choi (REJECTED) moi duoc lap lai."
			});
		}
		if (String(oldRecord.RequesterEmail || "").toLowerCase() !== String(requesterEmail || "").toLowerCase()) {
			return res.status(403).json({ success: false, message: "Chi chinh nguoi de nghi ban dau moi duoc gui lai de nghi nay." });
		}
	}

	let record;
	try {
		record = await createPrDraft(payload);
		if (!record) {
			return res.status(502).json({ success: false, message: "SAP khong tra ve du lieu PR nhap vua tao." });
		}
	} catch (error) {
		const message = extractSapErrorMessage(error);
		console.error("[POST /api/approval/submit] Tao PrDraft THAT BAI:", message);
		return res.status(502).json({ success: false, message: "Khong tao duoc PR nhap tren SAP: " + message });
	}

	// 18/08/2026: KHONG con dong ban cu thanh CANCELLED nua. REJECTED da la trang
	// thai ket thuc (khong nam trong danh sach cho nao), va khoi cu con ghi de
	// Comment -> xoa mat chinh ly do tu choi. Ban cu giu nguyen REJECTED + ly do.

	notifyRequester(
		record,
		"Đề nghị " + record.PRId + " đã được gửi, đang chờ Bộ phận mua sắm (Purchasing) xem xét. PR trên SAP sẽ được tạo khi Purchasing duyệt."
	);
	await notifyPurchasing(
		record.PRId,
		"Có đề nghị mới " + record.PRId + " từ " + requesterEmail
		+ " — giá trị " + Number(record.TotalValue).toLocaleString("vi-VN") + " " + record.Currency
		+ ". Vui lòng xem xét trên màn PR-02."
	);

	return res.status(201).json({
		success: true,
		approval: record,
		sapIntegration: "pending_approval"
	});
});

router.get("/api/approval/pending", async (req, res) => {
	if (!process.env.SAP_HOST) {
		return res.status(503).json({ success: false, message: "He thong SAP chua duoc cau hinh (thieu SAP_HOST)." });
	}
	const role = String(req.query.role || "").toUpperCase();
	var statusFilter = "PENDING_PURCHASING";
	if (role === "CEO") {
		statusFilter = "PENDING_CEO";
	} else if (role === "CFO") {
		statusFilter = "PENDING_CFO";
	} else if (role === "PURCHASING") {
		statusFilter = "PENDING_PURCHASING";
	}
	// Cho phep override status truc tiep — RFQ-01 dung ?status=PENDING_RFQ de lay
	// danh sach PR da duoc Purchasing duyet hop le, dang cho tao RFQ.
	if (req.query.status) {
		statusFilter = String(req.query.status).toUpperCase();
	}
	try {
		// Loc lai o Node sau khi SAP tra ve: neu PRDRAFTSET_GET_ENTITYSET chua ap
		// select-options thi $filter bi bo qua va SAP tra ve CA BANG — man hinh se
		// hien ca nhung PR khong thuoc trang thai dang cho. Loc 2 lan cho chac.
		const pending = (await fetchPrDraftList(`Status eq '${odataEscape(statusFilter)}'`))
			.filter((pr) => String(pr.Status || "").toUpperCase() === statusFilter);
		await enrichWithRfqAward(pending);
		return res.json({ success: true, data: pending });
	} catch (error) {
		const message = extractSapErrorMessage(error);
		console.error("[GET /api/approval/pending] THAT BAI:", message);
		return res.status(502).json({ success: false, message });
	}
});

router.get("/api/approval/approved", async (req, res) => {
	if (!process.env.SAP_HOST) {
		return res.status(503).json({ success: false, message: "He thong SAP chua duoc cau hinh (thieu SAP_HOST)." });
	}
	try {
		// 18/08/2026: PO-01 tao don hang tu PR da CHOT NCC (Status=AWARDED) — khong
		// con trang thai APPROVED trong luong moi (CFO/CEO duyet o cap PO, sau khi
		// PO da tao). Loc lai o Node — xem ghi chu cung loai o /api/approval/pending.
		const data = (await fetchPrDraftList(`Status eq 'AWARDED'`))
			.filter((pr) => String(pr.Status || "").toUpperCase() === "AWARDED");
		// Gan them RfqGroups (moi nhom = 1 RFQ da chot = 1 NCC = 1 PO se tao). PO-01
		// dua vao day de tao dung N don hang thay vi gop het vao 1 PO 1 NCC.
		await enrichWithRfqAward(data);
		return res.json({ success: true, data });
	} catch (error) {
		const message = extractSapErrorMessage(error);
		console.error("[GET /api/approval/approved] THAT BAI:", message);
		return res.status(502).json({ success: false, message });
	}
});

router.get("/api/approval/history", async (req, res) => {
	const email = String(req.query.email || "").trim().toLowerCase();
	const role = String(req.query.role || "").toUpperCase();

	if (!email) {
		return res.status(400).json({ success: false, message: "Thieu email." });
	}
	if (!process.env.SAP_HOST) {
		return res.status(503).json({ success: false, message: "He thong SAP chua duoc cau hinh (thieu SAP_HOST)." });
	}

	function sortNewest(a, b) {
		return new Date(b.UpdatedAt || b.CreatedAt || 0) - new Date(a.UpdatedAt || a.CreatedAt || 0);
	}

	let pending = [];
	let history = [];

	try {
		const allDrafts = await fetchPrDraftList();

		if (role === "REQUESTER") {
			history = allDrafts
				.filter(function (item) {
					return String(item.RequesterEmail || "").toLowerCase() === email;
				})
				.slice()
				.sort(sortNewest);
		} else if (role === "PURCHASING") {
			pending = allDrafts
				.filter(function (item) {
					return String(item.Status || "").toUpperCase() === "PENDING_PURCHASING";
				})
				.slice()
				.sort(sortNewest);
			history = allDrafts
				.filter(function (item) {
					// PR dang trong giai doan RFQ (chua co quyet dinh Approve/Reject nao ca) van
					// phai hien o day, khong thi bien mat khoi man Purchasing tu luc tao RFQ toi
					// luc PENDING_CFO — chua co man RFQ01/RFQ02 rieng de theo doi.
					const s = String(item.Status || "").toUpperCase();
					if (s === "PENDING_RFQ" || s === "RFQ_SENT" || s === "QUOTATIONS_RECEIVED") { return true; }
					if (item.PurchasingApprovedBy || item.PurchasingAction) { return true; }
					return String(item.DecidedByRole || "").toUpperCase() === "PURCHASING";
				})
				.slice()
				.sort(sortNewest);
		} else if (role === "CFO") {
			pending = allDrafts
				.filter(function (item) {
					return String(item.Status || "").toUpperCase() === "PENDING_CFO";
				})
				.slice()
				.sort(sortNewest);
			history = allDrafts
				.filter(function (item) {
					if (item.CfoProcessedBy || item.CfoAction) { return true; }
					return String(item.DecidedByRole || "").toUpperCase() === "CFO";
				})
				.slice()
				.sort(sortNewest);
		} else if (role === "CEO") {
			pending = allDrafts
				.filter(function (item) {
					return String(item.Status || "").toUpperCase() === "PENDING_CEO";
				})
				.slice()
				.sort(sortNewest);
			history = allDrafts
				.filter(function (item) {
					if (item.CeoProcessedBy || item.CeoAction) { return true; }
					return String(item.DecidedByRole || "").toUpperCase() === "CEO";
				})
				.slice()
				.sort(sortNewest);
		} else {
			history = allDrafts
				.filter(function (item) {
					const s = String(item.Status || "").toUpperCase();
					return s === "APPROVED" || s === "REJECTED" || s === "OPENED" || s === "OPEN";
				})
				.slice()
				.sort(sortNewest);
		}

		return res.json({ success: true, role: role, pending: pending, history: history });
	} catch (error) {
		const message = extractSapErrorMessage(error);
		console.error("[GET /api/approval/history] THAT BAI:", message);
		return res.status(502).json({ success: false, message });
	}
});

router.get("/api/approval/:id", async (req, res) => {
	const { id } = req.params;
	if (!process.env.SAP_HOST) {
		return res.status(503).json({ success: false, message: "He thong SAP chua duoc cau hinh (thieu SAP_HOST)." });
	}
	try {
		const record = await fetchPrDraftById(id);
		if (!record) {
			return res.status(404).json({
				success: false,
				message: "Không tìm thấy đề nghị mua sắm " + id + "."
			});
		}
		await enrichWithRfqAward([record]);

		// So PO that cua tung dong (EBAN). Chi lam o route CHI TIET, khong lam o
		// /history hay /approved: nhung route do tra ve hang chuc PR, moi PR them
		// 1 vong goi SAP la du lam man hinh do treo.
		try {
			await attachPoNumbers(record);
		} catch (poError) {
			console.error("[GET /api/approval/:id] Khong gan duoc so PO:", poError.message);
		}

		return res.json({ success: true, data: record });
	} catch (error) {
		const message = extractSapErrorMessage(error);
		console.error("[GET /api/approval/:id] THAT BAI:", message);
		return res.status(502).json({ success: false, message });
	}
});

router.patch("/api/approval/:id", async (req, res) => {
	const { id } = req.params;
	const { status, comment, decidedByEmail, decidedByRole } = req.body || {};

	if (!process.env.SAP_HOST) {
		return res.status(503).json({ success: false, message: "He thong SAP chua duoc cau hinh (thieu SAP_HOST)." });
	}

	let record;
	try {
		record = await fetchPrDraftById(id);
	} catch (error) {
		const message = extractSapErrorMessage(error);
		console.error("[PATCH /api/approval/:id] Doc PrDraft THAT BAI:", message);
		return res.status(502).json({ success: false, message });
	}
	if (!record) {
		return res.status(404).json({ success: false, message: "Khong tim thay de nghi mua sam." });
	}

	const sRole = String(decidedByRole || "").toUpperCase();
	const nowIso = new Date().toISOString();

	// 18/08/2026 — CUA DUYET 1 chi con Purchasing. CFO/CEO khong dong vao PR nua:
	// ho duyet DON HANG sau khi co gia that (PATCH /api/po/:prId/approval).
	if (sRole !== "PURCHASING") {
		return res.status(403).json({
			success: false,
			message: "Chỉ Bộ phận mua sắm (Purchasing) duyệt đề nghị ở bước này. CFO/CEO duyệt đơn hàng trên màn PO-02."
		});
	}
	if (record.Status !== "PENDING_PURCHASING") {
		return res.status(400).json({ success: false, message: "Đề nghị này không ở trạng thái chờ Purchasing duyệt." });
	}

	if (status === "REJECTED") {
		// 18/08/2026: TU CHOI = KET THUC. Khong con RETURNED (tra lai sua) lan
		// CANCELLED — dang nao requester cung phai lam lai, nen gop ve mot trang
		// thai dong kem LY DO BAT BUOC. Requester doc ly do roi LAP DE NGHI MOI
		// (man chi tiet co nut prefill du lieu cu); ban nay giu nguyen REJECTED
		// de ly do khong bao gio bi ghi de — audit trail day du.
		if (!comment || !String(comment).trim()) {
			return res.status(400).json({
				success: false,
				message: "Bắt buộc nhập lý do từ chối để người đề nghị biết cần điều chỉnh gì."
			});
		}

		record.Status = "REJECTED";
		record.Comment = comment;
		record.DecidedByEmail = decidedByEmail;
		record.DecidedByRole = sRole;
		record.PurchasingApprovedBy = decidedByEmail;
		record.PurchasingAction = "REJECTED";
		record.PurchasingAt = nowIso;
		record.UpdatedAt = nowIso;

		try {
			await updatePrDraft(record.InternalId, {
				Status: "REJECTED",
				Comment: record.Comment,
				DecidedByEmail: decidedByEmail,
				DecidedByRole: sRole,
				PurchasingApprovedBy: decidedByEmail,
				PurchasingAction: "REJECTED"
			});
		} catch (error) {
			const message = extractSapErrorMessage(error);
			console.error("[PATCH /api/approval/:id] MERGE (REJECTED) THAT BAI:", message);
			return res.status(502).json({ success: false, message });
		}

		notifyRequester(
			record,
			"Đề nghị " + record.PRId + " bị Bộ phận mua sắm TỪ CHỐI. Lý do: " + comment
			+ " — Bạn có thể lập đề nghị mới (màn chi tiết có nút điền sẵn dữ liệu cũ)."
		);
		return res.json({ success: true, approval: record });
	}

	if (status === "APPROVED") {
		// ── CUA DUYET 1 (18/08/2026): Purchasing duyet nhu cau = NHAP PR THAT vao
		// SAP (tuong duong ME51N). Truoc day PR that chi sinh SAU khi CFO/CEO duyet
		// cuoi -> suot giai doan RFQ, EBAN rong, RFQ khong tham chieu duoc so PR
		// nao (bi hoi dong bat o review lan 2 ngay 17/08). Nay: duyet la co so PR,
		// moi RFQ tao sau do deu tham chieu so that.
		//
		// CFO/CEO KHONG con duyet o day — ho duyet DON HANG (PO) tren gia bao that
		// tai PATCH /api/po/:prId/approval, sau khi PO da duoc tao (tuong duong
		// ME29N). "PR duyet nhu cau, PO duyet tien."
		const sapResult = await createPRInSAP(record);

		if (sapResult.sapIntegration !== "created" || !sapResult.sapPrNumber) {
			// KHONG doi Status: de nghi van nam o PENDING_PURCHASING, sua loi
			// (mang/SAP/master data) xong bam duyet lai la duoc — khong can rollback.
			return res.status(502).json({
				success: false,
				message: "Không tạo được PR trên SAP: " + (sapResult.sapErrorMessage || "không có PRNumber")
					+ " — đề nghị vẫn ở trạng thái chờ, có thể bấm duyệt lại sau khi xử lý lỗi.",
				sapErrorMessage: sapResult.sapErrorMessage
			});
		}

		const oldId = record.PRId;
		record.SapPRId = sapResult.sapPrNumber;
		record.PRId = sapResult.sapPrNumber;
		record.Status = "PENDING_RFQ";
		record.Comment = comment || record.Comment;
		record.PurchasingApprovedBy = decidedByEmail;
		record.PurchasingAction = "APPROVED";
		record.PurchasingAt = nowIso;
		record.UpdatedAt = nowIso;

		try {
			await updatePrDraft(record.InternalId, {
				// Gui SapPRId -> ABAP PRDRAFTSET_UPDATE_ENTITY tu dong gan lai ca
				// SAPPRID lan PRID trong bang ZPR_DRAFT (xem code method).
				SapPRId: sapResult.sapPrNumber,
				Status: "PENDING_RFQ",
				Comment: record.Comment,
				PurchasingApprovedBy: decidedByEmail,
				PurchasingAction: "APPROVED"
			});
		} catch (error) {
			const message = extractSapErrorMessage(error);
			// PR that DA ton tai tren EBAN — chi buoc ghi nguoc trang thai fail.
			// Tra ca so PR de nguoi dung biet chung tu da co, xu ly tay neu can.
			console.error("[PATCH /api/approval/:id] MERGE (Purchasing APPROVED) THAT BAI (PR SAP "
				+ sapResult.sapPrNumber + " da ton tai):", message);
			return res.status(502).json({ success: false, message, sapPrNumber: sapResult.sapPrNumber });
		}

		notifyRequester(
			record,
			"Đề nghị " + oldId + " đã được Bộ phận mua sắm duyệt. Số PR trên SAP: "
			+ record.SapPRId + " (tra cứu ME53N). Tiếp theo: hỏi giá nhà cung cấp (RFQ)."
		);
		await notifyPurchasing(
			record.PRId,
			"PR " + record.PRId + " đã tạo trên SAP — tiếp tục tạo RFQ trên màn RFQ-01 để hỏi giá nhà cung cấp."
		);

		return res.json({
			success: true,
			approval: record,
			forwarded: "RFQ",
			sapIntegration: "created",
			sapPrNumber: sapResult.sapPrNumber
		});
	}

	return res.status(400).json({ success: false, message: "Status không hợp lệ (chỉ nhận APPROVED/REJECTED)." });
});
module.exports = router;
