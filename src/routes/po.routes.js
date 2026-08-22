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
const { extractSapErrorMessage, odataEscape, sapAuth, sapRead, sapWrite } = require("../lib/sap-client");
const { notifyCeos, notifyPurchasing, notifyRequester } = require("../services/notify.service");
const { attachQuotationEvidence } = require("../services/decision-context.service");
const { sendPOEmailToVendor } = require("../services/po-mail.service");
const { enrichWithRfqAward, fetchPRItemsFromSAP, fetchPrDraftById, fetchPrDraftList, pickRealItemNo, updatePrDraft } = require("../services/pr.service");
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

	// 21/08/2026 — SO DO TO-BE: PO chi duoc tao SAU khi CFO/CEO da duyet de nghi
	// (buoc 10-11 dung truoc buoc 12). Chan o backend chu khong chi an nut tren
	// FE: goi thang API bang Postman van phai di qua cua duyet.
	try {
		const prCheck = await fetchPrDraftById(prNumber);
		if (!prCheck) {
			return res.status(404).json({ success: false, message: "Không tìm thấy đề nghị mua sắm " + prNumber + "." });
		}
		const prStatus = String(prCheck.Status || "").toUpperCase();
		if (prStatus !== "APPROVED") {
			return res.status(400).json({
				success: false,
				message: "Đề nghị " + prNumber + " chưa được phê duyệt (trạng thái hiện tại: " + prStatus
					+ "). Đơn hàng chỉ được tạo sau khi CFO/CEO duyệt."
			});
		}
	} catch (error) {
		const message = extractSapErrorMessage(error);
		console.error("[POST /api/po/create] Doc PrDraft de kiem tra trang thai THAT BAI:", message);
		return res.status(502).json({ success: false, message });
	}

	// ── NCC TREN PO PHAI DUNG BANG NCC DA THANG THAU O RFQ ──────────────────────
	// Chot NCC o buoc bao gia roi ma don hang lai dat cho NCC khac thi don hang do
	// khong co goc: gia dang dung la gia cua NCC thang thau chao, con ca vong so
	// sanh bao gia thi mat y nghia. Trong SAP standard, PO tao tham chieu quotation
	// cung khoa cung NCC nhu vay.
	//
	// FE (PO-01) da khoa o dropdown, nhung khong tin FE — goi thang API bang Postman
	// van tao duoc PO. Bo qua khi khong co rfqId: PR cu / PR khong di qua RFQ giu
	// nguyen hanh vi cu.
	if (rfqId) {
		try {
			const rfqResp = await sapRead(`RfqSet('${odataEscape(String(rfqId))}')`);
			const rfqHead = (rfqResp.data && rfqResp.data.d) || null;
			const awardedRaw = rfqHead ? String(rfqHead.AwardedVendor || "").trim() : "";
			const awarded = /^\d+$/.test(awardedRaw) ? awardedRaw.padStart(10, "0") : awardedRaw;
			const sentRaw = String(vendorNo || "").trim();
			const sent = /^\d+$/.test(sentRaw) ? sentRaw.padStart(10, "0") : sentRaw;
			if (awarded && awarded !== sent) {
				return res.status(400).json({
					success: false,
					message: "Nhà cung cấp trên đơn hàng (" + sent + ") khác nhà cung cấp đã trúng thầu ở "
						+ rfqId + " (" + awarded + "). Muốn đổi nhà cung cấp thì phải quay lại bước báo giá để chốt lại."
				});
			}
		} catch (error) {
			const message = extractSapErrorMessage(error);
			console.error("[POST /api/po/create] Doc RfqSet de kiem tra NCC trung thau THAT BAI:", message);
			return res.status(502).json({ success: false, message });
		}
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

		// ── SO DO TO-BE (21/08/2026): PO tao xong la GUI NGAY cho NCC ──────────
		// Cua duyet nam TRUOC buoc nay (CFO/CEO duyet de nghi o buoc 10-11), nen
		// toi day moi thu da duoc chap thuan — khong con gi de duyet lai. Da bo
		// han co che "cho release" cua luong 2 cua: khong luu payload mail ra file
		// nua (tren Vercel file nam /tmp, mat khi cold start), khong con trang
		// thai PO_RELEASED.
		//
		// Trang thai: danh dau nhom nay PO_CREATED tren RfqSet; khi MOI nhom cua
		// PR deu da co PO thi ha PR xuong PO_CREATED — trang thai ket thuc cua
		// ung dung, tiep theo la MIGO/MIRO lam trong SAP GUI.
		let poGroupsDone = 0;
		let poGroupsTotal = 0;
		try {
			const approval = await fetchPrDraftById(prNumber);
			if (!approval) {
				console.error("[POST /api/po/create] Khong tim thay PrDraft ung voi prNumber", prNumber, "de cap nhat trang thai.");
			} else {
				if (rfqId) {
					await sapWrite("MERGE", `RfqSet('${odataEscape(String(rfqId))}')`, { Status: "PO_CREATED" });
				}

				// Doc lai sau khi da MERGE de dem dung so nhom con lai.
				let groups = [];
				try {
					groups = await fetchRfqsByPr(approval);
				} catch (readError) {
					console.error("[POST /api/po/create] Doc cac RFQ cua PR that bai:", extractSapErrorMessage(readError));
				}
				poGroupsTotal = groups.length;
				poGroupsDone = groups.filter(function (g) {
					return String(g.Status || "").toUpperCase() === "PO_CREATED";
				}).length;

				// PR khong di qua RFQ (groups rong): tao PO xong la het.
				const allDone = poGroupsTotal === 0 || poGroupsDone >= poGroupsTotal;
				if (allDone) {
					await updatePrDraft(approval.InternalId, { Status: "PO_CREATED" });
					notifyRequester(
						approval,
						"Đơn hàng cho đề nghị " + approval.PRId + " đã được tạo trên SAP (PO " + realPoNum
						+ ") và gửi tới nhà cung cấp."
					);
				} else {
					console.log(`[POST /api/po/create] PR ${prNumber}: da tao PO cho ${poGroupsDone}/${poGroupsTotal} nhom `
						+ `— giu PR o trang thai APPROVED de tao not cac nhom con lai.`);
				}
			}
		} catch (mergeError) {
			console.error("[POST /api/po/create] Cap nhat trang thai sau khi tao PO THAT BAI:", extractSapErrorMessage(mergeError));
		}

		// Gui mail don hang cho NCC. Loi gui mail KHONG lam hong ket qua tao PO:
		// chung tu da nam tren SAP roi, gui lai duoc bang tay — tra co emailSent
		// de man hinh noi ro cho nguoi mua biet thay vi im lang.
		let isMailSent = false;
		try {
			isMailSent = await sendPOEmailToVendor(vendorEmail, realPoNum, {
				items,
				currency,
				docDate,
				companyCode,
				buyerName,
				buyerPhone,
				deliveryAddress,
				receiverName,
				receiverPhone,
				deliveryDate,
				paymentMethod,
				paymentTerms
			});
		} catch (mailError) {
			console.error("[POST /api/po/create] Gui mail PO " + realPoNum + " that bai:", mailError.message);
		}

		return res.status(201).json({
			success: true,
			sapIntegration: "created",
			poNumber: realPoNum,
			emailSent: isMailSent,
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
// SO DO TO-BE (21/08/2026) — CFO/CEO DUYET DE NGHI, TRUOC KHI TAO PO
// Buoc 9-11 cua so do: chot NCC xong Purchasing "Submit to CFO"; CFO doi chieu
// gia chot voi du toan roi quyet; vuot nguong Internal Order thi len CEO. Duyet
// xong PR sang APPROVED va Purchasing moi vao PO-01 tao don hang (buoc 12).
//
// Vi sao duyet DE NGHI chu khong duyet PO: PR da co so that tren EBAN tu buoc 4
// nen day dung la PR Release (ME54N) — dung chung tu, dung thoi diem. Duyet sau
// khi PO da ton tai la PO Release (ME29N), can classification CT04/CL02 ma he
// thong nay khong cau hinh. Quan trong hon: tu choi o day KHONG de lai PO mo
// coi — chua co PO nao ca, Purchasing chon lai NCC binh thuong, khong dinh loi
// "PR already converted" phai vao ME22N xoa tay.
// ════════════════════════════════════════════════════════════════════════════

// Danh sach DE NGHI cho duyet theo role (CFO: PENDING_CFO, CEO: PENDING_CEO).
router.get("/api/pr-approval/pending", async (req, res) => {
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
		// RfqGroups (ten NCC, ly do chot, gia tung nhom) de man duyet du ngu canh.
		await enrichWithRfqAward(data);

		for (const pr of data) {
			const aGroups = (pr.RfqGroups || []).filter(function (g) {
				const st = String(g.Status || "").toUpperCase();
				return st === "AWARDED" || st === "PO_CREATED";
			});
			if (aGroups.length > 0) {
				pr.AwardGroups = aGroups;
			} else {
				// PR khong di qua RFQ: dung 1 "nhom" gia lap tu chinh PR de man hinh
				// van hien duoc gia chot va NCC.
				pr.AwardGroups = [{
					RfqId: "",
					Status: "AWARDED",
					AwardedVendor: pr.RfqAwardedVendor || "",
					AwardedVendorName: "",
					AwardReason: "",
					ItemLines: "",
					FinalValue: pr.RfqFinalValue || pr.TotalValue,
					Currency: pr.Currency
				}];
			}

			// Bang chung canh tranh gia cho tung nhom: moi may NCC, nhan may bao gia,
			// gia thap nhat/cao nhat, co chon gia thap nhat khong. Day la thu CFO
			// dua vao de duyet chi tien — xem decision-context.service.js.
			try {
				await attachQuotationEvidence(pr);
			} catch (e) {
				console.error("[GET /api/pr-approval/pending] attachQuotationEvidence:", e.message);
			}
		}

		return res.json({ success: true, data });
	} catch (error) {
		const message = extractSapErrorMessage(error);
		console.error("[GET /api/pr-approval/pending] THAT BAI:", message);
		return res.status(502).json({ success: false, message });
	}
});

// CFO/CEO quyet dinh: APPROVED -> cho PO-01 tao don hang; CFO + vuot nguong IO
// -> chuyen CEO; REJECTED (bat buoc ly do) -> ket thuc.
router.patch("/api/pr-approval/:prId", async (req, res) => {
	const { prId } = req.params;
	const { action, comment, decidedByEmail, decidedByRole } = req.body || {};

	if (!process.env.SAP_HOST) {
		return res.status(503).json({ success: false, message: "He thong SAP chua duoc cau hinh (thieu SAP_HOST)." });
	}
	const sRole = String(decidedByRole || "").toUpperCase();
	const sAction = String(action || "").toUpperCase();
	if (sRole !== "CFO" && sRole !== "CEO") {
		return res.status(403).json({ success: false, message: "Chỉ CFO hoặc CEO được duyệt đề nghị ở bước này." });
	}
	if (sAction !== "APPROVED" && sAction !== "REJECTED") {
		return res.status(400).json({ success: false, message: "action chỉ nhận APPROVED/REJECTED." });
	}

	let record;
	try {
		record = await fetchPrDraftById(prId);
	} catch (error) {
		const message = extractSapErrorMessage(error);
		console.error("[PATCH /api/pr-approval/:prId] Doc PrDraft THAT BAI:", message);
		return res.status(502).json({ success: false, message });
	}
	if (!record) {
		return res.status(404).json({ success: false, message: "Không tìm thấy đề nghị " + prId + "." });
	}
	if (sRole === "CFO" && record.Status !== "PENDING_CFO") {
		return res.status(400).json({ success: false, message: "Đề nghị " + prId + " không ở trạng thái chờ CFO duyệt." });
	}
	if (sRole === "CEO" && record.Status !== "PENDING_CEO") {
		return res.status(400).json({ success: false, message: "Đề nghị " + prId + " không ở trạng thái chờ CEO duyệt." });
	}

	const nowIso = new Date().toISOString();

	// ── TU CHOI ──────────────────────────────────────────────────────────────
	// Chua co PO nao duoc tao nen khong phai don dep gi ben EKKO — chi dong de
	// nghi lai. RFQ giu nguyen AWARDED de con doc duoc lich su bao gia.
	if (sAction === "REJECTED") {
		if (!comment || !String(comment).trim()) {
			return res.status(400).json({ success: false, message: "Bắt buộc nhập lý do từ chối." });
		}
		const sapFields = {
			Status: "REJECTED",
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
		try {
			Object.assign(record, sapFields, { UpdatedAt: nowIso });
			await updatePrDraft(record.InternalId, sapFields);
		} catch (error) {
			const message = extractSapErrorMessage(error);
			console.error("[PATCH /api/pr-approval/:prId] MERGE (REJECTED) THAT BAI:", message);
			return res.status(502).json({ success: false, message });
		}

		notifyRequester(record, "Đề nghị " + record.PRId + " bị " + sRole + " từ chối. Lý do: " + comment);
		await notifyPurchasing(
			record.PRId,
			"Đề nghị " + record.PRId + " bị " + sRole + " từ chối: " + comment
			+ " — chưa có đơn hàng nào được tạo nên không cần xử lý gì thêm trên SAP."
		);
		return res.json({ success: true, approval: record });
	}

	// ── DUYET ────────────────────────────────────────────────────────────────
	// CFO + vuot nguong IO (tinh lai tren GIA THAT luc award — xem
	// buildApprovalFlagsByCostCenter o /api/rfq/:id/award): chuyen CEO.
	if (sRole === "CFO" && record.needsProcurementHeadReview) {
		const t = record.ioThreshold;
		const io = record.escalationIO || "";
		const escFields = {
			Status: "PENDING_CEO",
			EscalationReason: "Vượt ngưỡng Internal Order " + io + " ("
				+ Number(t).toLocaleString("vi-VN") + " VND) — cần CEO phê duyệt.",
			Comment: comment || record.Comment,
			CfoProcessedBy: decidedByEmail || "",
			CfoAction: "ESCALATED"
		};
		try {
			await updatePrDraft(record.InternalId, escFields);
		} catch (error) {
			const message = extractSapErrorMessage(error);
			console.error("[PATCH /api/pr-approval/:prId] MERGE (escalate CEO) THAT BAI:", message);
			return res.status(502).json({ success: false, message });
		}
		Object.assign(record, escFields, { CfoAt: nowIso, UpdatedAt: nowIso });

		notifyRequester(record, "Đề nghị " + record.PRId + " đã được CFO chuyển lên CEO (vượt ngưỡng IO).");
		await notifyCeos(
			record.PRId,
			"Đề nghị " + record.PRId + " leo thang lên CEO. " + record.EscalationReason
			+ " Giá trị: " + Number(record.TotalValue).toLocaleString("vi-VN") + " " + record.Currency + "."
		);
		return res.json({ success: true, approval: record, escalated: true, reason: record.EscalationReason });
	}

	// Duyet cuoi: PR sang APPROVED. Purchasing vao PO-01 tao don hang, va CHINH
	// buoc do gui mail cho NCC — khong con buoc release rieng nao nua.
	const okFields = {
		Status: "APPROVED",
		Comment: comment || record.Comment,
		DecidedByEmail: decidedByEmail || "",
		DecidedByRole: sRole
	};
	if (sRole === "CFO") {
		okFields.CfoProcessedBy = decidedByEmail || "";
		okFields.CfoAction = "APPROVED";
		record.CfoAt = nowIso;
	} else {
		okFields.CeoProcessedBy = decidedByEmail || "";
		okFields.CeoAction = "APPROVED";
		record.CeoAt = nowIso;
	}
	try {
		Object.assign(record, okFields, { UpdatedAt: nowIso });
		await updatePrDraft(record.InternalId, okFields);
	} catch (error) {
		const message = extractSapErrorMessage(error);
		console.error("[PATCH /api/pr-approval/:prId] MERGE (APPROVED) THAT BAI:", message);
		return res.status(502).json({ success: false, message });
	}

	notifyRequester(
		record,
		"Đề nghị " + record.PRId + " đã được " + sRole
		+ " phê duyệt. Bộ phận Mua sắm sẽ tạo đơn hàng và gửi nhà cung cấp."
	);
	await notifyPurchasing(
		record.PRId,
		"Đề nghị " + record.PRId + " đã được " + sRole + " duyệt — vào màn hình PO-01 tạo đơn hàng cho nhà cung cấp đã chốt."
	);

	return res.json({ success: true, approval: record });
});

module.exports = router;
