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
const { extractSapErrorMessage, odataEscape, sapAuth, sapWrite } = require("../lib/sap-client");
const { sendPOEmailToVendor } = require("../services/po-mail.service");
const { fetchPRItemsFromSAP, fetchPrDraftById, pickRealItemNo, updatePrDraft } = require("../services/pr.service");
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

		// ZPR_DRAFT khong co field PoNumber/PoCreatedAt rieng (khac approvalStore
		// truoc day) — chi can Status="PO_CREATED" la du de /api/approval/approved
		// loai PR nay khoi danh sach "cho tao PO". So PO that (realPoNum) da tra ve
		// thang trong response API nay (PO01.controller.js doc res.poNumber), khong
		// can luu lai tren ban ghi PR.
		//
		// TU 16/08/2026: 1 PR co the tach nhieu nhom (nhieu RFQ) -> nhieu PO. Dat PR
		// sang PO_CREATED ngay sau PO DAU TIEN se lam PR bien mat khoi man PO-01 trong
		// khi cac nhom con lai chua he co don hang. Nay: danh dau nhom vua tao xong
		// (RfqSet.Status='PO_CREATED') truoc, chi khi MOI nhom deu xong moi ha PR.
		// Khong can them field moi ben SAP — dung lai chinh field Status san co.
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

				// PR khong di qua RFQ (groups rong) van giu hanh vi cu: tao PO xong la het.
				const allDone = poGroupsTotal === 0 || poGroupsDone >= poGroupsTotal;
				if (allDone) {
					await updatePrDraft(approval.InternalId, { Status: "PO_CREATED" });
				} else {
					console.log(`[POST /api/po/create] PR ${prNumber}: da tao PO cho ${poGroupsDone}/${poGroupsTotal} nhom `
						+ `— giu PR o trang thai APPROVED de tao not cac nhom con lai.`);
				}
			}
		} catch (mergeError) {
			console.error("[POST /api/po/create] Cap nhat trang thai sau khi tao PO THAT BAI:", extractSapErrorMessage(mergeError));
		}
		console.log("=== BEFORE SEND EMAIL ===");

		const isMailSent = await sendPOEmailToVendor(
			vendorEmail,
			realPoNum,
			{
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
			}
		);
		console.log("=== EMAIL SENT ===");


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

module.exports = router;
