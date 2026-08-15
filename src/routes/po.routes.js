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
const { extractSapErrorMessage, sapAuth } = require("../lib/sap-client");
const { sendPOEmailToVendor } = require("../services/po-mail.service");
const { fetchPRItemsFromSAP, fetchPrDraftById, fetchPrDraftList, pickRealItemNo, updatePrDraft } = require("../services/pr.service");

const router = express.Router();


// ── API TẠO PURCHASE ORDER TRÊN SAP GATEWAY ODATA ──
router.post("/api/po/create", async (req, res) => {
	const {
		vendorNo,
		vendorEmail, // 👈 Email do người dùng tự nhập trên View
		prNumber,
		companyCode,
		purchOrg,
		purchGroup,
		docType,
		docDate,
		currency,
		items
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
		function realPreqItemAt(idx) {
			const row = realPrItems[idx];
			if (!row) { return null; }
			const n = pickRealItemNo(row);
			return n ? String(n).padStart(5, "0") : null;
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
					var formattedPreqItem = realPreqItemAt(idx)
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
		try {
			const approval = await fetchPrDraftById(prNumber);
			if (approval) {
				await updatePrDraft(approval.InternalId, { Status: "PO_CREATED" });
			} else {
				console.error("[POST /api/po/create] Khong tim thay PrDraft ung voi prNumber", prNumber, "de cap nhat Status=PO_CREATED.");
			}
		} catch (mergeError) {
			console.error("[POST /api/po/create] Cap nhat Status=PO_CREATED THAT BAI:", extractSapErrorMessage(mergeError));
		}
		console.log("=== BEFORE SEND EMAIL ===");

		const isMailSent = await sendPOEmailToVendor(
			vendorEmail,
			realPoNum,
			{
				items,
				currency,
				docDate,
				companyCode
			}
		);
		console.log("=== EMAIL SENT ===");

	
		return res.status(201).json({
			success: true,
			sapIntegration: "created",
			poNumber: realPoNum,
			emailSent: isMailSent,
			po: createdPo
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
// ============================================================================
// API BÁO CÁO TIẾN ĐỘ PO (REPORT) — MERGE TIMELINE & PHÂN QUYỀN VAI TRÒ (ROLE)
// ============================================================================
router.get("/api/po/report", async (req, res) => {
	const userEmail = String(req.query.email || "").trim().toLowerCase();

	// Chế độ Mock Data khi chưa cấu hình kết nối SAP
	if (!process.env.SAP_HOST) {
		return res.json({ success: true, sapIntegration: "mock", data: [] });
	}

	try {
		// 1. Gọi OData lấy danh sách lịch sử Purchase Order từ SAP S/4HANA
		const response = await axios.get(
			`${process.env.SAP_HOST}${ODATA_SERVICE_PATH}/PurchaseOrderHistorySet`,
			{ params: { "$format": "json" }, auth: sapAuth() }
		);
		let results = (response.data && response.data.d && response.data.d.results) || [];
		console.log("===== PO HISTORY =====");
		console.log(results.length);
		console.dir(results, { depth: null });

		// 2. Merge (trộn) dữ liệu mốc thời gian duyệt PR (giờ lấy từ PrDraftSet trên SAP,
		// không còn approvalStore local) vào PO từ SAP. Sửa luôn 1 lỗi cũ: code trước đọc
		// matchedPR.PurchasingApprovedAt/CfoProcessedAt/CeoProcessedAt — 3 field này CHƯA BAO
		// GIỜ tồn tại (bản ghi PR luôn dùng tên PurchasingAt/CfoAt/CeoAt), nên LeadDate/CfoDate/
		// CeoDate trước đây luôn ra null. Nay dùng đúng tên field.
		const allDrafts = await fetchPrDraftList();
		results = results.map((po) => {
			const matchedPR = allDrafts.find(
				(pr) => pr.SapPRId === po.PoNumber || pr.PRId === po.PreqNo || pr.InternalId === po.PreqNo
			);

			return {
				...po,
				// Gán thông tin người tạo PR
				RequesterEmail: matchedPR ? matchedPR.RequesterEmail : (po.RequesterEmail || "requester@qdavy.com"),

				// Gán các mốc thời gian (Dates) cho Timeline 6 bước
				PrDate: matchedPR ? matchedPR.CreatedAt?.split("T")[0] : po.DocDate,
				LeadDate: matchedPR?.PurchasingAt ? matchedPR.PurchasingAt.split("T")[0] : null,
				CfoDate: matchedPR?.CfoAt ? matchedPR.CfoAt.split("T")[0] : null,
				CeoDate: matchedPR?.CeoAt ? matchedPR.CeoAt.split("T")[0] : null,
				DocDate: po.DocDate || new Date().toISOString().split("T")[0],
				DeliveryDate: po.Status === "DELIVERED" ? po.DeliveryDate : null
			};
		});

		// 3. Phân quyền xem dữ liệu báo cáo theo Email người dùng
		if (userEmail === "requester@qdavy.com") {
			// Requester chỉ lọc và thấy danh sách PO do chính mình đề nghị
			results = results.filter((po) =>
				String(po.RequesterEmail || "").toLowerCase() === "requester@qdavy.com"
			);
		}
		// Các email cấp quản lý: purchasing@qdavy.com, cfo@qdavy.com, ceo@qdavy.com
		// sẽ nhận được toàn bộ danh sách PO trên hệ thống.

		return res.json({ success: true, sapIntegration: "fetched", data: results });
	} catch (error) {
		console.error("❌ Lỗi lấy báo cáo PO:", error.message);
		return res.status(502).json({
			success: false,
			sapError: true,
			message: "Node.js không thể kết nối tới SAP Gateway!"
		});
	}
});
module.exports = router;
