/**
 * Purchase Order: tao PO tren SAP + bao cao PO.
 *
 * Tach ra tu server.js (ban goc 4520 dong) ngay 15/08/2026.
 * Noi dung ham giu nguyen 100%, chi them phan require/exports o dau va cuoi file.
 */


const express = require("express");
const axios = require("axios");
const { sapPoAmount } = require("../config/master-data");
const { ODATA_SERVICE_PATH, ORG_DEFAULTS } = require("../config/org");
const { extractSapErrorMessage, odataEscape, sapAuth, sapFetchCsrfToken, sapWrite } = require("../lib/sap-client");
const { notifyCeos, notifyCfo, notifyPurchasing, notifyRequester } = require("../services/notify.service");
const { getPendingRelease, poNumberForGroup, releaseGroup, releaseKey, savePendingRelease } = require("../services/po-approval.service");
const { attachPoNumbers, enrichWithRfqAward, fetchPRItemsFromSAP, fetchPrDraftById, fetchPrDraftList, pickRealItemNo, updatePrDraft } = require("../services/pr.service");
const { fetchRfqsByPr } = require("../services/rfq.service");

const router = express.Router();


// ── API TẠO PURCHASE ORDER TRÊN SAP GATEWAY ODATA ──
// ── API TẠO PURCHASE ORDER TRÊN SAP GATEWAY ODATA ──
router.post("/api/po/create", async (req, res) => {
	const {
		vendorNo,
		vendorEmail, // 👈 Email do người dùng tự nhập trên View
		prNumber,
		// Ma RFQ (nhom) ma don hang nay thuoc ve. 1 PR tach nhieu nhom -> nhieu PO;
		// can biet PO vua tao thuoc nhom nao de danh dau dung nhom do da xong.
		// Bo trong = PR khong di qua RFQ hoac chi co 1 nhom (hanh vi cu).
		rfqId,
		companyCode,
		purchOrg,
		purchGroup,
		docType,
		docDate,
		currency,
		items,
		// Cac field nay CHI dung de dien vao mail thong bao NCC (sendPOEmailToVendor),
		// khong gui len SAP — deep entity PurchaseOrderHeaderSet khong co field tuong ung.
		buyerName,
		buyerPhone,
		deliveryAddress,
		receiverName,
		receiverPhone,
		deliveryDate,
		paymentMethod,
		paymentTerms
	} = req.body || {};

	if (!vendorNo || !Array.isArray(items) || items.length === 0) {
		return res.status(400).json({ success: false, message: "Thiếu thông tin Nhà cung cấp hoặc danh sách vật tư." });
	}

	const totalValue = items.reduce(
		(sum, item) => sum + (Number(item.netPrice) || 0) * (Number(item.quantity) || 0),
		0
	);

	// Khong con nhanh MOCK: truoc day thieu SAP_HOST van tra ve so PO gia
	// (PO-<nam>-xxxxx) kem success:true, nen FE bao "tao PO thanh cong" trong khi
	// SAP khong he co chung tu nao — rat de nham khi demo. PR da bo mock tu truoc,
	// nay PO lam giong: thieu cau hinh thi bao loi that.
	if (!process.env.SAP_HOST) {
		return res.status(503).json({
			success: false,
			message: "He thong SAP chua duoc cau hinh (thieu SAP_HOST) — khong the tao Purchase Order."
		});
	}

	// Trường hợp kết nối SAP OData thật
	try {
		const tokenResponse = await axios.get(
			`${process.env.SAP_HOST}${ODATA_SERVICE_PATH}/PurchaseOrderHeaderSet`,
			{ auth: sapAuth(), headers: { "X-CSRF-Token": "Fetch", "sap-language": "EN" } }
		);
		const csrfToken = tokenResponse.headers["x-csrf-token"];
		const cookies = tokenResponse.headers["set-cookie"];

		var rawVendor = String(vendorNo || "").trim();
		var formattedVendor = /^\d+$/.test(rawVendor) ? rawVendor.padStart(10, "0") : rawVendor;

		// Lay dong PR THAT tu SAP (EBAN qua PurchaseRequisitionHisSet) de PO tham chieu
		// dung so dong (BNFPO). Khong tin so dong FE gui len: draft luu 00001/00002...
		// nhung so dong that tren PR SAP do BAPI danh, co the khac. Neu vi ly do nao do
		// khong doc duoc PR that thi moi fallback ve so dong FE gui (giu hanh vi cu).
		const realPrItems = await fetchPRItemsFromSAP(prNumber);

		// TRA DONG EBAN THEO SO DONG, KHONG THEO VI TRI TRONG MANG.
		//
		// Ban cu la realPrItems[idx] — dung khi PO om TRON VEN ca PR (dong thu i cua
		// payload = dong thu i cua PR). Tu khi 1 PR tach thanh nhieu RFQ/nhieu PO thi
		// sai hoan toan: PO chi chua dong 3,4,5 cua PR, idx=0 lai tra ve dong 1 -> PO
		// tham chieu nham dong PR, va con "an" mat dong 1 khien PO sau bao "PR item da
		// duoc chuyen thanh PO roi". Nay uu tien khop theo so dong FE gui len (preqItem,
		// chinh la LineNo cua PrDraftItem = BNFPO do create_pr_deep danh so).
		function normalizeItemNo(value) {
			const s = String(value == null ? "" : value).trim();
			if (!s) { return ""; }
			return /^\d+$/.test(s) ? s.padStart(5, "0") : s;
		}
		function realPreqItemFor(requestedItem, idx) {
			const wanted = normalizeItemNo(requestedItem);
			if (wanted) {
				const hit = realPrItems.find(function (row) {
					return normalizeItemNo(pickRealItemNo(row)) === wanted;
				});
				if (hit) { return normalizeItemNo(pickRealItemNo(hit)); }
			}
			// Du phong theo vi tri: chi con dung khi FE khong gui preqItem (request cu).
			const row = realPrItems[idx];
			if (!row) { return null; }
			const n = pickRealItemNo(row);
			return n ? normalizeItemNo(n) : null;
		}

		const sapPayload = {
			CompanyCode: companyCode || ORG_DEFAULTS.companyCode,
			DocType: docType || "NB",
			VendorNo: formattedVendor,
			PurchOrg: purchOrg || ORG_DEFAULTS.purchOrg,
			PurchGroup: purchGroup || ORG_DEFAULTS.purchGroup,
			Currency: currency || ORG_DEFAULTS.currency,
			DocDate: docDate || new Date().toISOString().split('T')[0],
			TotalValue: sapPoAmount(totalValue, currency || ORG_DEFAULTS.currency),
			POToItems: {
				results: items.map((item, idx) => {
					var rawMat = String(item.materialNo || "").trim();
					var formattedMat = (/^\d+$/.test(rawMat)) ? rawMat.padStart(18, "0") : rawMat;

					var rawPreqNo = String(item.preqNo || prNumber || "").trim();
					var formattedPreqNo = /^\d+$/.test(rawPreqNo) ? rawPreqNo.padStart(10, "0") : rawPreqNo;
					// Fallback PHAI la (idx + 1) chu khong phai "00010".
					// PR cua app do chinh CREATE_DEEP_ENTITY tao ra, no danh so dong bang
					// lv_pr_serial chay tu 1 -> EBAN-BNFPO la 00001, 00002... Con "00010"
					// la kieu danh so cua SAP standard (buoc 10), khong dung o day, nen
					// nhanh PO tra EBAN khong thay dong nao va bao "PR ... item 00010 not found".
					var formattedPreqItem = realPreqItemFor(item.preqItem, idx)
						|| String(item.preqItem || (idx + 1)).padStart(5, "0");

					return {
						PoNumber: "",
						ItemNo: String((idx + 1) * 10).padStart(5, "0"),
						PreqNo: formattedPreqNo,
						PreqItem: formattedPreqItem,
						MaterialNo: formattedMat.substring(0, 40),
						Description: String(item.description || "").substring(0, 40),
						Quantity: Number(item.quantity || 1).toFixed(3),
						UoM: String(item.uom || "PC").substring(0, 3),
						NetPrice: sapPoAmount(item.netPrice, currency || ORG_DEFAULTS.currency),
						CostCenter: String(item.costCenter || "").substring(0, 10),
						Plant: item.plant || ORG_DEFAULTS.plant
					};
				})
			}
		};

		const sapResponse = await axios.post(
			`${process.env.SAP_HOST}${ODATA_SERVICE_PATH}/PurchaseOrderHeaderSet`,
			sapPayload,

			{
				auth: sapAuth(),
				headers: {
					"Content-Type": "application/json",
					"X-CSRF-Token": csrfToken,
					"Cookie": cookies ? cookies.join("; ") : "",
					"sap-language": "EN"
				}
			}
		);
		console.log("=== SAP CREATE PO SUCCESS ===");
		console.dir(sapResponse.data, { depth: null });

		const createdPo = sapResponse.data && sapResponse.data.d;
		const realPoNum = createdPo ? createdPo.PoNumber : "PO_SUCCESS";

		// ── CUA DUYET 2 (18/08/2026): PO tao xong CHUA gui cho NCC ──────────────
		// Mail chi duoc gui o PATCH /api/po/:prId/approval sau khi CFO/CEO duyet
		// (mo phong PO Release ME29N). Payload mail nguoi mua vua nhap (dia chi
		// giao hang, nguoi nhan...) luu lai theo nhom de buoc duyet dung lai —
		// xem po-approval.service.js (co fallback tu SAP neu store mat).
		//
		// Trang thai: danh dau nhom nay PO_CREATED tren RfqSet; khi MOI nhom cua
		// PR deu da co PO thi chuyen PR sang PENDING_CFO (cho duyet don hang).
		let poGroupsDone = 0;
		let poGroupsTotal = 0;
		let prPromoted = false;
		try {
			const approval = await fetchPrDraftById(prNumber);
			if (!approval) {
				console.error("[POST /api/po/create] Khong tim thay PrDraft ung voi prNumber", prNumber, "de cap nhat trang thai.");
			} else {
				if (rfqId) {
					await sapWrite("MERGE", `RfqSet('${odataEscape(String(rfqId))}')`, { Status: "PO_CREATED" });
				}

				savePendingRelease(releaseKey(rfqId, prNumber), {
					prNumber: String(prNumber || ""),
					internalId: approval.InternalId || "",
					rfqId: rfqId || "",
					poNumber: String(realPoNum || ""),
					vendorNo: String(vendorNo || ""),
					vendorEmail: String(vendorEmail || "").trim(),
					totalValue: totalValue,
					currency: currency || ORG_DEFAULTS.currency,
					mail: {
						items: items,
						currency: currency || ORG_DEFAULTS.currency,
						docDate: docDate || "",
						companyCode: companyCode || ORG_DEFAULTS.companyCode,
						buyerName: buyerName || "",
						buyerPhone: buyerPhone || "",
						deliveryAddress: deliveryAddress || "",
						receiverName: receiverName || "",
						receiverPhone: receiverPhone || "",
						deliveryDate: deliveryDate || "",
						paymentMethod: paymentMethod || "",
						paymentTerms: paymentTerms || ""
					}
				});

				// Doc lai sau khi da MERGE de dem dung so nhom con lai.
				let groups = [];
				try {
					groups = await fetchRfqsByPr(approval);
				} catch (readError) {
					console.error("[POST /api/po/create] Doc cac RFQ cua PR that bai:", extractSapErrorMessage(readError));
				}
				poGroupsTotal = groups.length;
				poGroupsDone = groups.filter(function (g) {
					const st = String(g.Status || "").toUpperCase();
					return st === "PO_CREATED" || st === "PO_RELEASED" || st === "PO_REJECTED";
				}).length;

				// PR khong di qua RFQ (groups rong): tao PO xong cung chuyen thang cho CFO.
				const allDone = poGroupsTotal === 0 || poGroupsDone >= poGroupsTotal;
				if (allDone) {
					await updatePrDraft(approval.InternalId, { Status: "PENDING_CFO" });
					prPromoted = true;
					notifyRequester(
						approval,
						"Đơn hàng cho đề nghị " + approval.PRId + " đã được tạo (PO " + realPoNum
						+ "), đang chờ CFO duyệt trước khi gửi nhà cung cấp."
					);
					await notifyCfo(
						approval.PRId,
						"PO " + realPoNum + " (PR " + approval.PRId + ") đang chờ duyệt trên màn PO-02."
						+ (approval.needsProcurementHeadReview ? " Lưu ý: vượt ngưỡng IO — sau CFO sẽ cần CEO duyệt." : "")
					);
				} else {
					console.log(`[POST /api/po/create] PR ${prNumber}: da tao PO cho ${poGroupsDone}/${poGroupsTotal} nhom `
						+ `— giu PR o trang thai AWARDED de tao not cac nhom con lai.`);
				}
			}
		} catch (mergeError) {
			console.error("[POST /api/po/create] Cap nhat trang thai sau khi tao PO THAT BAI:", extractSapErrorMessage(mergeError));
		}


		return res.status(201).json({
			success: true,
			sapIntegration: "created",
			poNumber: realPoNum,
			// 18/08/2026: KHONG gui mail o day nua — PO cho CFO/CEO duyet (PO-02).
			pendingRelease: true,
			prPromoted: prPromoted,
			po: createdPo,
			// FE dua vao 2 so nay de biet con nhom nao phai tao PO nua khong.
			groupsDone: poGroupsDone,
			groupsTotal: poGroupsTotal
		});
	} catch (error) {
		console.error("========== SAP ERROR ==========");

		if (error.response) {
			console.error("HTTP Status:", error.response.status);
			console.dir(error.response.data, { depth: null });

			const details =
				error.response.data?.error?.innererror?.errordetails;

			if (Array.isArray(details)) {
				console.log("===== ERROR DETAILS =====");
				details.forEach((d) => {
					console.log(
						`[${d.severity}] ${d.code} - ${d.message}`
					);
				});
			}
		} else {
			console.error(error);
		}

		// TRUOC DAY: chi lay error.message.value — voi ABAP raise exception thi truong
		// do luon la cau chung chung "An exception was raised", con LY DO THAT nam trong
		// innererror.errordetails va chi duoc console.log ra log server (tren Vercel thi
		// coi nhu khong ai doc duoc). Ket qua: nguoi dung nhin man hinh khong tài nào
		// biet PO hong vi cai gi. extractSapErrorMessage() da boc san phan do — duong
		// tao PR dung no tu lau, rieng duong tao PO bi bo quen.
		const sapMessage = extractSapErrorMessage(error);
		const sapDetails = (error.response?.data?.error?.innererror?.errordetails || [])
			.filter((d) => d && d.message)
			.map((d) => ({ severity: d.severity, code: d.code, message: d.message }));

		return res.status(502).json({
			success: false,
			message: sapMessage,
			// Tra ca danh sach chi tiet ve FE: co message phu (warning, thong tin dong nao
			// hong) ma cau gop o tren khong the hien het — mo tab Network la doc duoc ngay.
			sapErrorDetails: sapDetails,
			sapHttpStatus: error.response?.status || null
		});
	}
});
// LICH SU: truoc day o day co GET /api/po/report (bao cao tien do PO) — da XOA 15/08/2026
// cung voi man POReport (man do chua bao gio chay dung: view va controller lech phien ban).
// Trong route cu co logic merge moc thoi gian duyet PR (PrDraftSet) vao PO — neu can tai
// dung thi xem git: git show ce9d5ae~1:src/routes/po.routes.js


// ════════════════════════════════════════════════════════════════════════════
// CUA DUYET 2 — CFO/CEO DUYET DON HANG (18/08/2026, mo phong ME29N)
// "PR duyet nhu cau, PO duyet tien": PO da tao that tren SAP nhung chua gui
// NCC; CFO xem gia chot so voi du toan roi moi release. Vuot nguong IO thi
// CFO chuyen tiep len CEO (giu nguyen co che leo thang cu, chi doi doi tuong
// tu PR sang PO). Tu choi -> PO_REJECTED: PO van nam trong EKKO (chua co
// method ABAP huy PO — han che da biet, noi thang khi bao ve), he thong khong
// gui mail va Purchasing chon lai NCC / tao PO moi.
// ════════════════════════════════════════════════════════════════════════════

// Danh sach PO cho duyet theo role (CFO: PENDING_CFO, CEO: PENDING_CEO).
router.get("/api/po/pending-approval", async (req, res) => {
	if (!process.env.SAP_HOST) {
		return res.status(503).json({ success: false, message: "He thong SAP chua duoc cau hinh (thieu SAP_HOST)." });
	}
	const role = String(req.query.role || "CFO").toUpperCase();
	if (role !== "CFO" && role !== "CEO") {
		return res.status(400).json({ success: false, message: "role chi nhan CFO hoac CEO." });
	}
	const statusFilter = role === "CEO" ? "PENDING_CEO" : "PENDING_CFO";

	try {
		// Loc lai o Node — PRDRAFTSET_GET_ENTITYSET co the bo qua $filter (xem
		// ghi chu o /api/approval/pending).
		const data = (await fetchPrDraftList(`Status eq '${odataEscape(statusFilter)}'`))
			.filter((pr) => String(pr.Status || "").toUpperCase() === statusFilter);
		// RfqGroups (ten NCC, ly do chot, gia tung nhom) de man PO-02 hien du ngu canh.
		await enrichWithRfqAward(data);

		for (const pr of data) {
			// So PO that tung dong tu EBAN — nguon su that, khong phu thuoc store file.
			try { await attachPoNumbers(pr); } catch (e) {
				console.error("[GET /api/po/pending-approval] attachPoNumbers:", e.message);
			}
			const aGroups = (pr.RfqGroups || []).filter(function (g) {
				const st = String(g.Status || "").toUpperCase();
				return st === "PO_CREATED" || st === "PO_RELEASED" || st === "PO_REJECTED";
			});
			if (aGroups.length > 0) {
				pr.PoGroups = aGroups.map(function (g) {
					const pending = getPendingRelease(releaseKey(g.RfqId, pr.PRId));
					return Object.assign({}, g, {
						PoNumber: (pending && pending.poNumber) || poNumberForGroup(pr, g.ItemLines) || ""
					});
				});
			} else {
				// PR khong di qua RFQ: dung 1 "nhom" gia lap tu store/EBAN.
				const pending = getPendingRelease(releaseKey("", pr.PRId));
				pr.PoGroups = [{
					RfqId: "",
					Status: "PO_CREATED",
					AwardedVendor: (pending && pending.vendorNo) || "",
					AwardedVendorName: "",
					AwardReason: "",
					ItemLines: "",
					FinalValue: (pending && pending.totalValue) || pr.TotalValue,
					Currency: pr.Currency,
					PoNumber: (pending && pending.poNumber) || pr.PoNumberText || ""
				}];
			}
		}

		return res.json({ success: true, data });
	} catch (error) {
		const message = extractSapErrorMessage(error);
		console.error("[GET /api/po/pending-approval] THAT BAI:", message);
		return res.status(502).json({ success: false, message });
	}
});

// CFO/CEO quyet dinh: APPROVED -> release moi nhom (PO_RELEASED + gui mail NCC);
// CFO + vuot nguong IO -> chuyen CEO; REJECTED (bat buoc ly do) -> PO_REJECTED.
router.patch("/api/po/:prId/approval", async (req, res) => {
	const { prId } = req.params;
	const { action, comment, decidedByEmail, decidedByRole } = req.body || {};

	if (!process.env.SAP_HOST) {
		return res.status(503).json({ success: false, message: "He thong SAP chua duoc cau hinh (thieu SAP_HOST)." });
	}
	const sRole = String(decidedByRole || "").toUpperCase();
	const sAction = String(action || "").toUpperCase();
	if (sRole !== "CFO" && sRole !== "CEO") {
		return res.status(403).json({ success: false, message: "Chỉ CFO hoặc CEO được duyệt đơn hàng." });
	}
	if (sAction !== "APPROVED" && sAction !== "REJECTED") {
		return res.status(400).json({ success: false, message: "action chỉ nhận APPROVED/REJECTED." });
	}

	let record;
	try {
		record = await fetchPrDraftById(prId);
	} catch (error) {
		const message = extractSapErrorMessage(error);
		console.error("[PATCH /api/po/:prId/approval] Doc PrDraft THAT BAI:", message);
		return res.status(502).json({ success: false, message });
	}
	if (!record) {
		return res.status(404).json({ success: false, message: "Không tìm thấy đề nghị/PR " + prId + "." });
	}
	if (sRole === "CFO" && record.Status !== "PENDING_CFO") {
		return res.status(400).json({ success: false, message: "PR " + prId + " không ở trạng thái chờ CFO duyệt đơn hàng." });
	}
	if (sRole === "CEO" && record.Status !== "PENDING_CEO") {
		return res.status(400).json({ success: false, message: "PR " + prId + " không ở trạng thái chờ CEO duyệt đơn hàng." });
	}

	const nowIso = new Date().toISOString();
	let groups = [];
	try {
		groups = await fetchRfqsByPr(record);
	} catch (error) {
		console.error("[PATCH /api/po/:prId/approval] Doc RFQ cua PR that bai:", extractSapErrorMessage(error));
		groups = [];
	}
	const createdGroups = groups.filter(function (g) {
		return String(g.Status || "").toUpperCase() === "PO_CREATED";
	});

	// ── TU CHOI ──────────────────────────────────────────────────────────────
	if (sAction === "REJECTED") {
		if (!comment || !String(comment).trim()) {
			return res.status(400).json({ success: false, message: "Bắt buộc nhập lý do từ chối đơn hàng." });
		}
		try {
			const session = await sapFetchCsrfToken();
			for (const g of createdGroups) {
				await sapWrite("MERGE", `RfqSet('${odataEscape(String(g.RfqId))}')`, { Status: "PO_REJECTED" }, session);
			}
			const sapFields = {
				Status: "PO_REJECTED",
				Comment: comment,
				DecidedByEmail: decidedByEmail || "",
				DecidedByRole: sRole
			};
			if (sRole === "CFO") {
				sapFields.CfoProcessedBy = decidedByEmail || "";
				sapFields.CfoAction = "REJECTED";
				record.CfoAt = nowIso;
			} else {
				sapFields.CeoProcessedBy = decidedByEmail || "";
				sapFields.CeoAction = "REJECTED";
				record.CeoAt = nowIso;
			}
			Object.assign(record, sapFields, { UpdatedAt: nowIso });
			await updatePrDraft(record.InternalId, sapFields);
		} catch (error) {
			const message = extractSapErrorMessage(error);
			console.error("[PATCH /api/po/:prId/approval] MERGE (PO_REJECTED) THAT BAI:", message);
			return res.status(502).json({ success: false, message });
		}

		notifyRequester(record, "Đơn hàng của đề nghị " + record.PRId + " bị " + sRole + " TỪ CHỐI. Lý do: " + comment);
		await notifyPurchasing(
			record.PRId,
			"PO của PR " + record.PRId + " bị " + sRole + " từ chối: " + comment
			+ " — chọn lại NCC hoặc điều chỉnh rồi tạo PO mới. (PO cũ chưa gửi NCC.)"
		);
		return res.json({ success: true, approval: record });
	}

	// ── DUYET ────────────────────────────────────────────────────────────────
	// CFO + vuot nguong IO (tinh lai tren GIA THAT luc award — xem
	// buildApprovalFlagsByCostCenter o /api/rfq/:id/award): chuyen CEO, PO van
	// o PO_CREATED, CHUA release gi ca.
	if (sRole === "CFO" && record.needsProcurementHeadReview) {
		const t = record.ioThreshold;
		const io = record.escalationIO || "";
		const sapFields = {
			Status: "PENDING_CEO",
			EscalationReason: "Vượt ngưỡng Internal Order " + io + " ("
				+ Number(t).toLocaleString("vi-VN") + " VND) — cần CEO duyệt đơn hàng.",
			Comment: comment || record.Comment,
			CfoProcessedBy: decidedByEmail || "",
			CfoAction: "ESCALATED"
		};
		try {
			await updatePrDraft(record.InternalId, sapFields);
		} catch (error) {
			const message = extractSapErrorMessage(error);
			console.error("[PATCH /api/po/:prId/approval] MERGE (escalate CEO) THAT BAI:", message);
			return res.status(502).json({ success: false, message });
		}
		Object.assign(record, sapFields, { CfoAt: nowIso, UpdatedAt: nowIso });

		notifyRequester(record, "Đơn hàng của đề nghị " + record.PRId + " đã được CFO chuyển lên CEO (vượt ngưỡng IO).");
		await notifyCeos(
			record.PRId,
			"PO của PR " + record.PRId + " leo thang lên CEO. " + record.EscalationReason
			+ " Giá trị: " + Number(record.TotalValue).toLocaleString("vi-VN") + " " + record.Currency
			+ ". Duyệt trên màn PO-02."
		);
		return res.json({ success: true, approval: record, escalated: true, reason: record.EscalationReason });
	}

	// Release: moi nhom PO_CREATED -> PO_RELEASED + gui mail cho NCC cua nhom do.
	const released = [];
	try {
		const session = await sapFetchCsrfToken();
		if (createdGroups.length > 0) {
			for (const g of createdGroups) {
				released.push(await releaseGroup(record, g, session));
			}
		} else {
			released.push(await releaseGroup(record, null, session));
		}

		const sapFields = {
			Status: "PO_RELEASED",
			Comment: comment || record.Comment,
			DecidedByEmail: decidedByEmail || "",
			DecidedByRole: sRole
		};
		if (sRole === "CFO") {
			sapFields.CfoProcessedBy = decidedByEmail || "";
			sapFields.CfoAction = "APPROVED";
			record.CfoAt = nowIso;
		} else {
			sapFields.CeoProcessedBy = decidedByEmail || "";
			sapFields.CeoAction = "APPROVED";
			record.CeoAt = nowIso;
		}
		Object.assign(record, sapFields, { UpdatedAt: nowIso });
		await updatePrDraft(record.InternalId, sapFields);
	} catch (error) {
		const message = extractSapErrorMessage(error);
		console.error("[PATCH /api/po/:prId/approval] Release THAT BAI:", message);
		return res.status(502).json({ success: false, message, released });
	}

	const aPoNums = released.map(function (r) { return r.poNumber; }).filter(Boolean);
	notifyRequester(
		record,
		"Đơn hàng của đề nghị " + record.PRId + " đã được " + sRole + " DUYỆT"
		+ (aPoNums.length ? " (PO " + aPoNums.join(", ") + ")" : "")
		+ " và gửi tới nhà cung cấp."
	);
	await notifyPurchasing(
		record.PRId,
		"PO của PR " + record.PRId + " đã được " + sRole + " duyệt — hệ thống đã gửi đơn hàng cho NCC."
	);

	return res.json({
		success: true,
		approval: record,
		released: released,
		emailsSent: released.filter(function (r) { return r.emailSent; }).length
	});
});

module.exports = router;
