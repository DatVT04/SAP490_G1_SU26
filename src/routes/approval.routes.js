/**
 * Luong PR: gui duyet, danh sach cho duyet, lich su, duyet/tu choi.
 *
 * Tach ra tu server.js (ban goc 4520 dong) ngay 15/08/2026.
 * Noi dung ham giu nguyen 100%, chi them phan require/exports o dau va cuoi file.
 */


const express = require("express");
const { extractSapErrorMessage, odataEscape } = require("../lib/sap-client");
const { boolToSapX } = require("../lib/sap-format");
const { buildApprovalFlagsByCostCenter } = require("../services/approval.service");
const { notifyCeos, notifyPurchasing, notifyRequester } = require("../services/notify.service");
const { createPRInSAP, createPrDraft, enrichWithRfqAward, fetchPrDraftById, fetchPrDraftList, mapClientItemToSapDeep, updatePrDraft } = require("../services/pr.service");

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
		if (oldRecord.Status !== "RETURNED") {
			return res.status(400).json({
				success: false,
				message: "De nghi " + resubmitOf + " dang o trang thai " + oldRecord.Status
					+ " — chi de nghi bi tra lai (RETURNED) moi duoc sua va gui lai."
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

	// Ban moi tao xong -> dong ban cu lai (CANCELLED) de khong con xuat hien o bat ky
	// danh sach cho xu ly nao. Loi o buoc nay khong duoc lam fail ca request (ban moi
	// da ton tai hop le roi) — chi log de xu ly tay neu can.
	if (oldRecord) {
		try {
			await updatePrDraft(oldRecord.InternalId, {
				Status: "CANCELLED",
				Comment: "Da duoc gui lai bang de nghi moi " + record.PRId + "."
			});
		} catch (error) {
			console.error(
				"[POST /api/approval/submit] Huy ban cu " + oldRecord.InternalId + " THAT BAI (ban moi "
				+ record.PRId + " van hop le):", extractSapErrorMessage(error)
			);
		}
	}

	notifyRequester(
		record,
		"Đề nghị " + record.PRId + " đã được gửi, đang chờ Bộ phận mua sắm (Purchasing) xem xét. Số PR SAP sẽ có sau khi phê duyệt cuối."
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
		// Khong con check !item.PoNumber — ZPR_DRAFT khong co field PoNumber (xem
		// ghi chu tren /api/po/create). Status da tu chuyen sang PO_CREATED ngay
		// sau khi tao PO nen filter Status='APPROVED' la du de loai PR da co PO.
		// Loc lai o Node — xem ghi chu cung loai o /api/approval/pending.
		const data = (await fetchPrDraftList(`Status eq 'APPROVED'`))
			.filter((pr) => String(pr.Status || "").toUpperCase() === "APPROVED");
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

	if (sRole === "PURCHASING" && record.Status !== "PENDING_PURCHASING") {
		return res.status(400).json({ success: false, message: "Đề nghị này không ở trạng thái chờ Purchasing duyệt." });
	}
	if (sRole === "CFO" && record.Status !== "PENDING_CFO") {
		return res.status(400).json({ success: false, message: "Đề nghị này không ở trạng thái chờ CFO duyệt." });
	}
	if (sRole === "CEO" && record.Status !== "PENDING_CEO") {
		return res.status(400).json({ success: false, message: "Đề nghị này không ở trạng thái chờ CEO duyệt." });
	}
	if (sRole !== "PURCHASING" && sRole !== "CFO" && sRole !== "CEO") {
		return res.status(403).json({ success: false, message: "Role không được phê duyệt." });
	}

	if (status === "REJECTED") {
		// Phan biet 2 loai tu choi theo dung quy trinh TO-BE:
		// - PURCHASING tu choi (buoc "Valid?" dau luong) -> RETURNED: PR bi tra lai,
		//   requester duoc sua va gui lai (PR01 se prefill tu ban nay, ban cu se bi
		//   CANCELLED khi ban moi duoc gui). Bat buoc co ly do de requester biet sua gi.
		// - CFO/CEO tu choi -> REJECTED: ket thuc han, khong co vong sua lai.
		const isReturn = sRole === "PURCHASING";
		if (isReturn && (!comment || !String(comment).trim())) {
			return res.status(400).json({
				success: false,
				message: "Bắt buộc nhập lý do khi trả lại PR để người đề nghị biết cần sửa gì."
			});
		}

		const finalStatus = isReturn ? "RETURNED" : "REJECTED";
		record.Status = finalStatus;
		record.Comment = comment || record.Comment;
		record.DecidedByEmail = decidedByEmail;
		record.DecidedByRole = sRole;
		record.UpdatedAt = nowIso;

		const sapFields = {
			Status: finalStatus,
			Comment: record.Comment,
			DecidedByEmail: decidedByEmail,
			DecidedByRole: sRole
		};
		if (sRole === "PURCHASING") {
			record.PurchasingApprovedBy = decidedByEmail;
			record.PurchasingAction = "REJECTED";
			record.PurchasingAt = nowIso;
			sapFields.PurchasingApprovedBy = decidedByEmail;
			sapFields.PurchasingAction = "REJECTED";
		} else if (sRole === "CFO") {
			record.CfoProcessedBy = decidedByEmail;
			record.CfoAction = "REJECTED";
			record.CfoAt = nowIso;
			sapFields.CfoProcessedBy = decidedByEmail;
			sapFields.CfoAction = "REJECTED";
		} else if (sRole === "CEO") {
			record.CeoProcessedBy = decidedByEmail;
			record.CeoAction = "REJECTED";
			record.CeoAt = nowIso;
			sapFields.CeoProcessedBy = decidedByEmail;
			sapFields.CeoAction = "REJECTED";
		}

		try {
			await updatePrDraft(record.InternalId, sapFields);
		} catch (error) {
			const message = extractSapErrorMessage(error);
			console.error("[PATCH /api/approval/:id] MERGE (REJECTED) THAT BAI:", message);
			return res.status(502).json({ success: false, message });
		}

		if (isReturn) {
			notifyRequester(
				record,
				"Đề nghị " + record.PRId + " bị Bộ phận mua sắm TRẢ LẠI. Lý do: " + comment
				+ " — Bạn có thể sửa lại và gửi lại đề nghị (màn Tạo đề nghị sẽ điền sẵn dữ liệu cũ)."
			);
			return res.json({ success: true, approval: record, returned: true });
		}
		notifyRequester(
			record,
			"Đề nghị " + record.PRId + " đã bị TỪ CHỐI bởi " + sRole + "."
			+ (comment ? " Lý do: " + comment : "")
		);
		return res.json({ success: true, approval: record });
	}

	if (status === "APPROVED") {
		// 1) Purchasing duyet ("Valid? = Yes" trong so do TO-BE) → PENDING_RFQ.
		// Theo quy trinh chot: Purchasing PHAI duyet truoc roi moi duoc tao RFQ,
		// va RFQ la buoc bat buoc — khong con duong duyet thang len CFO nua.
		// (Duong len CFO gio chi di qua award RFQ o /api/rfq/:id/award.)
		if (sRole === "PURCHASING") {
			record.Status = "PENDING_RFQ";
			record.Comment = comment || record.Comment;
			record.PurchasingApprovedBy = decidedByEmail;
			record.PurchasingAction = "APPROVED";
			record.PurchasingAt = nowIso;
			record.UpdatedAt = nowIso;

			try {
				await updatePrDraft(record.InternalId, {
					Status: "PENDING_RFQ",
					Comment: record.Comment,
					PurchasingApprovedBy: decidedByEmail,
					PurchasingAction: "APPROVED"
				});
			} catch (error) {
				const message = extractSapErrorMessage(error);
				console.error("[PATCH /api/approval/:id] MERGE (Purchasing->RFQ) THAT BAI:", message);
				return res.status(502).json({ success: false, message });
			}

			notifyRequester(
				record,
				"Đề nghị " + record.PRId + " đã được Bộ phận mua sắm chấp nhận, chuyển sang bước hỏi giá nhà cung cấp (RFQ)."
			);
			await notifyPurchasing(
				record.PRId,
				"PR " + record.PRId + " đã duyệt hợp lệ — tiếp tục tạo RFQ trên màn RFQ-01 để hỏi giá nhà cung cấp."
			);

			return res.json({ success: true, approval: record, forwarded: "RFQ" });
		}

		// 2) CFO + vượt ngưỡng IO → CEO
		if (sRole === "CFO" && record.needsProcurementHeadReview) {
			const t = record.ioThreshold;
			const io = record.escalationIO || "";
			record.Status = "PENDING_CEO";
			record.EscalationReason = "Vượt ngưỡng Internal Order "
				+ io + " (" + Number(t).toLocaleString("vi-VN") + " VND) — cần CEO phê duyệt.";
			record.Comment = comment || record.Comment;
			record.CfoProcessedBy = decidedByEmail;
			record.CfoAction = "ESCALATED";
			record.CfoAt = nowIso;
			record.UpdatedAt = nowIso;

			try {
				await updatePrDraft(record.InternalId, {
					Status: "PENDING_CEO",
					EscalationReason: record.EscalationReason,
					Comment: record.Comment,
					CfoProcessedBy: decidedByEmail,
					CfoAction: "ESCALATED"
				});
			} catch (error) {
				const message = extractSapErrorMessage(error);
				console.error("[PATCH /api/approval/:id] MERGE (CFO->CEO escalate) THAT BAI:", message);
				return res.status(502).json({ success: false, message });
			}

			notifyRequester(
				record,
				"Đề nghị " + record.PRId + " đã được CFO chuyển lên CEO (vượt ngưỡng IO). Bạn sẽ nhận thông báo khi CEO quyết định."
			);
			await notifyCeos(
				record.PRId,
				"PR " + record.PRId + " từ " + record.RequesterEmail
				+ " leo thang lên CEO. " + record.EscalationReason
				+ " Giá trị: " + Number(record.TotalValue).toLocaleString("vi-VN") + " " + record.Currency
			);

			return res.json({
				success: true,
				approval: record,
				escalated: true,
				reason: record.EscalationReason
			});
		}

		// 3) CFO (không vượt) hoặc CEO → SAP
		if (sRole === "CFO" || sRole === "CEO") {
			const sapResult = await createPRInSAP(record);

			if (sapResult.sapIntegration === "failed" || !sapResult.sapPrNumber) {
				return res.status(502).json({
					success: false,
					message: "Không ghi được PR lên SAP: " + (sapResult.sapErrorMessage || "không có PRNumber"),
					sapErrorMessage: sapResult.sapErrorMessage
				});
			}

			const oldId = record.PRId;
			record.InternalId = record.InternalId || oldId;
			record.SapPRId = sapResult.sapPrNumber;
			record.PRId = sapResult.sapPrNumber;
			record.Status = "APPROVED";
			record.Comment = comment || record.Comment;
			record.DecidedByEmail = decidedByEmail;
			record.DecidedByRole = sRole;
			record.UpdatedAt = nowIso;

			const sapFields = {
				// Gui SapPRId -> ABAP PRDRAFTSET_UPDATE_ENTITY tu dong gan lai ca
				// SAPPRID lan PRID trong bang ZPR_DRAFT (xem code method).
				SapPRId: sapResult.sapPrNumber,
				Status: "APPROVED",
				Comment: record.Comment,
				DecidedByEmail: decidedByEmail,
				DecidedByRole: sRole
			};

			if (sRole === "CFO") {
				record.CfoProcessedBy = decidedByEmail;
				record.CfoAction = "APPROVED";
				record.CfoAt = nowIso;
				sapFields.CfoProcessedBy = decidedByEmail;
				sapFields.CfoAction = "APPROVED";
			} else {
				record.CeoProcessedBy = decidedByEmail;
				record.CeoAction = "APPROVED";
				record.CeoAt = nowIso;
				sapFields.CeoProcessedBy = decidedByEmail;
				sapFields.CeoAction = "APPROVED";
			}

			try {
				await updatePrDraft(record.InternalId, sapFields);
			} catch (error) {
				const message = extractSapErrorMessage(error);
				console.error("[PATCH /api/approval/:id] MERGE (final APPROVED) THAT BAI:", message);
				return res.status(502).json({ success: false, message });
			}

			notifyRequester(
				record,
				"Đề nghị " + oldId + " đã được PHÊ DUYỆT bởi " + sRole
				+ ". Số PR trên SAP: " + record.SapPRId + " (ME53N)."
			);

			return res.json({
				success: true,
				approval: record,
				sapIntegration: "created",
				sapPrNumber: sapResult.sapPrNumber
			});
		}
	}

	return res.status(400).json({ success: false, message: "Status không hợp lệ (chỉ nhận APPROVED/REJECTED)." });
});
module.exports = router;
