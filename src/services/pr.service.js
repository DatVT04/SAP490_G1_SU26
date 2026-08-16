/**
 * Purchase Requisition: tao PR that tren SAP + CRUD PrDraftSet + mapping.
 *
 * Tach ra tu server.js (ban goc 4520 dong) ngay 15/08/2026.
 * Noi dung ham giu nguyen 100%, chi them phan require/exports o dau va cuoi file.
 */


const axios = require("axios");
const { defaultGLAccount } = require("../config/master-data");
const { ODATA_SERVICE_PATH } = require("../config/org");
const { extractSapErrorMessage, odataEscape, sapAuth, sapRead, sapWrite } = require("../lib/sap-client");
const { abapTsToIso, boolToSapX, sapTsToIso, sapXToBool } = require("../lib/sap-format");
const { fetchAllVendorsFromSAP } = require("./vendor.service");


async function createPRInSAP(record) {

	if (!process.env.SAP_HOST) {
		return { sapIntegration: "mock", sapPrNumber: null, sapErrorMessage: "SAP_HOST chua cau hinh" };
	}

	if (!Array.isArray(record.items) || record.items.length === 0) {
		return {
			sapIntegration: "failed",
			sapPrNumber: null,
			sapErrorMessage: "PR khong co dong item nao de gui len SAP"
		};
	}

	// Deep-insert: gui ca header + toan bo dong item qua nav property PRToItems.
	// Da verify thuc te qua Gateway Client (HTTP 201) — xem CLAUDE.md muc "Loi da biet" #1.
	const prToItems = record.items.map(function (item, idx) {
		const preqItem = String(idx + 1).padStart(5, "0");
		// AcctAssignCat da duoc luu tren draft luc submit (mapClientItemToSapDeep) - doc lai, khong doan lai
		// tu CostCenter nhu code cu (bug cu: CostCenter luon co gia tri nen luon roi vao Cat 'K', InternalOrder
		// khong bao gio duoc dung that du UI bat buoc nhap).
		const sCat = item.AcctAssignCat || (item.MaterialType === "ZAST" ? "A" : (item.InternalOrder ? "F" : "K"));
		return {
			PreqItem: preqItem,
			MaterialNo: item.isFreeText ? "" : (item.MaterialNo || ""),
			MaterialType: item.MaterialType || "",
			Description: item.Description || "",
			Quantity: String(item.Quantity || 0),
			UoM: item.UoM || "PC",
			EstimatedValue: String(item.EstimatedValue || 0),
			AcctAssignCat: sCat,
			CostCenter: sCat === "K" ? (item.CostCenter || "") : "",
			InternalOrder: sCat === "F" ? (item.InternalOrder || "") : "",
			AssetNo: sCat === "A" ? (item.AssetNo || "") : "",
			GLAccount: sCat === "A" ? "" : (item.GLAccount || defaultGLAccount(item.MaterialType))
		};
	});

	try {
		const tokenResponse = await axios.get(
			`${process.env.SAP_HOST}${ODATA_SERVICE_PATH}`,
			{ auth: sapAuth(), headers: { "X-CSRF-Token": "Fetch", "sap-language": "EN" } }
		);
		const csrfToken = tokenResponse.headers["x-csrf-token"];
		const cookies = tokenResponse.headers["set-cookie"];

		const sapResponse = await axios.post(
			`${process.env.SAP_HOST}${ODATA_SERVICE_PATH}/PurchaseRequisitionHeaderSet`,
			{
				CompanyCode: record.CompanyCode || "1000",
				Currency: record.Currency || "VND",
				Requester: record.RequesterEmail || "",
				TotalValue: String(record.TotalValue || 0),
				PRToItems: {
					results: prToItems
				}
			},
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

		const sapPrNumber = sapResponse.data && sapResponse.data.d
			&& (sapResponse.data.d.PRNumber || sapResponse.data.d.PrNumber || sapResponse.data.d.PRId);

		if (!sapPrNumber) {
			return {
				sapIntegration: "failed",
				sapPrNumber: null,
				sapErrorMessage: "SAP khong tra ve PRNumber trong response"
			};
		}
		return { sapIntegration: "created", sapPrNumber: String(sapPrNumber), sapErrorMessage: null };
	} catch (error) {
		let sapErrorMessage = null;
		const errorDetails = error.response?.data?.error?.innererror?.errordetails;
		if (Array.isArray(errorDetails)) {
			const realErrors = errorDetails
				.filter((d) => d.severity === "error" && d.code !== "/IWBEP/CX_MGW_BUSI_EXCEPTION")
				.map((d) => d.message);
			if (realErrors.length) { sapErrorMessage = realErrors.join("; "); }
		}
		if (!sapErrorMessage) {
			sapErrorMessage = error.response?.data?.error?.message?.value
				|| (error.response ? `SAP tra ve HTTP ${error.response.status}` : error.message);
		}
		console.error("[createPRInSAP] THAT BAI:", sapErrorMessage);
		return { sapIntegration: "failed", sapPrNumber: null, sapErrorMessage };
	}
}

/** 1 dong item tu PrDraftItemSet (SAP) -> shape cu FE dang doc (isFreeText la boolean). */
function mapSapItemToClient(sapItem) {
	return {
		LineNo: sapItem.LineNo,
		MaterialNo: sapItem.MaterialNo || "",
		MaterialType: sapItem.MaterialType || "",
		Description: sapItem.Description || "",
		Quantity: Number(sapItem.Quantity) || 0,
		UoM: sapItem.UoM || "",
		EstimatedValue: Number(sapItem.EstimatedValue) || 0,
		CostCenter: sapItem.CostCenter || "",
		InternalOrder: sapItem.InternalOrder || "",
		AssetNo: sapItem.AssetNo || "",
		GLAccount: sapItem.GLAccount || "",
		AcctAssignCat: sapItem.AcctAssignCat || "",
		isFreeText: sapXToBool(sapItem.IsFreeText)
	};
}

/**
 * 1 dong item FE gui len (submit PR moi) -> shape PrDraftToItems cho deep-entity POST.
 * AcctAssignCat + GLAccount KHONG lay tu client nua ma tu tinh o day (xem defaultGLAccount()):
 * ZAST -> Cat 'A' (Asset, khong gui GL - SAP tu lay tu Asset Master); con lai theo item.AcctAssignCat
 * FE gui len (K/F), moi Cat chi giu dung 1 truong CostCenter/InternalOrder tuong ung.
 */
function mapClientItemToSapDeep(item) {
	const sMaterialType = item.MaterialType || "ZSRV";
	// Chi con 'A' (Tai san) va 'K' (Cost Center) — xem ghi chu o cho tao mappedItems.
	const sCat = sMaterialType === "ZAST" ? "A" : "K";
	return {
		MaterialNo: item.isFreeText ? "" : (item.MaterialNo || ""),
		MaterialType: sMaterialType,
		Description: item.Description || "",
		Quantity: String(item.Quantity || 0),
		UoM: item.UoM || "PC",
		EstimatedValue: String(item.EstimatedValue || 0),
		AcctAssignCat: sCat,
		CostCenter: sCat === "K" ? (item.CostCenter || "") : "",
		// Luon rong: khong con Cat 'F'. Nguong ngan sach suy tu CostCenter luc tinh flag.
		InternalOrder: "",
		AssetNo: sCat === "A" ? (item.AssetNo || "") : "",
		GLAccount: sCat === "A" ? "" : defaultGLAccount(sMaterialType),
		IsFreeText: boolToSapX(item.isFreeText)
	};
}

/** 1 entity PrDraft (SAP, da $expand=PrDraftToItems) -> shape cu approvalStore ma FE dang doc. */
function mapSapPrToClient(sap) {
	const headerCurrency = sap.Currency || "VND";
	// Gan Currency cua header vao tung item: ZPR_DRAFT_ITEM khong co field Currency,
	// nen FE (PR-02 danh sach vat tu) truoc day binding {Currency} trong context item
	// ra undefined va formatter fallback ve "VND" — PR tinh bang USD hien dong item
	// "1.000 VND" ngay duoi tong "1.000 USD" (feedback QDAVY 13/08).
	const items = ((sap.PrDraftToItems && sap.PrDraftToItems.results) || [])
		.map(mapSapItemToClient)
		.map(function (it) { return Object.assign({}, it, { Currency: headerCurrency }); });
	return {
		PRId: sap.PRId || sap.InternalId,
		InternalId: sap.InternalId,
		SapPRId: sap.SapPRId || null,
		RequesterEmail: sap.RequesterEmail || "",
		TotalValue: Number(sap.TotalValue) || 0,
		Currency: sap.Currency || "VND",
		Status: sap.Status || "",
		CreatedAt: abapTsToIso(sap.CreatedAt),
		UpdatedAt: abapTsToIso(sap.UpdatedAt),
		items: items,
		Comment: sap.Comment || "",
		DecidedByEmail: sap.DecidedByEmail || "",
		DecidedByRole: sap.DecidedByRole || "",
		PurchasingApprovedBy: sap.PurchasingApprovedBy || "",
		PurchasingAction: sap.PurchasingAction || "",
		PurchasingAt: abapTsToIso(sap.PurchasingAt),
		CfoProcessedBy: sap.CfoProcessedBy || "",
		CfoAction: sap.CfoAction || "",
		CfoAt: abapTsToIso(sap.CfoAt),
		CeoProcessedBy: sap.CeoProcessedBy || "",
		CeoAction: sap.CeoAction || "",
		CeoAt: abapTsToIso(sap.CeoAt),
		EscalationReason: sap.EscalationReason || "",
		needsProcurementHeadReview: sapXToBool(sap.NeedsProcurementHeadReview),
		needsLegalReview: sapXToBool(sap.NeedsLegalReview),
		ioThreshold: sap.IoThreshold != null && sap.IoThreshold !== "" ? Number(sap.IoThreshold) : null,
		escalationIO: sap.EscalationIO || null,
		RfqId: sap.RfqId || null,
		RfqAwardedVendor: sap.RfqAwardedVendor || null,
		RfqFinalValue: sap.RfqFinalValue != null ? Number(sap.RfqFinalValue) : null,
		EstimatedTotalValue: sap.EstimatedTotalValue != null ? Number(sap.EstimatedTotalValue) : null
	};
}

/** GET danh sach PrDraftSet (co $filter tuy chon) + luon $expand item, tra ve da map ve shape cu. */
async function fetchPrDraftList(filterExpr) {
	const params = { "$format": "json", "$expand": "PrDraftToItems" };
	if (filterExpr) { params["$filter"] = filterExpr; }
	const response = await axios.get(
		`${process.env.SAP_HOST}${ODATA_SERVICE_PATH}/PrDraftSet`,
		{ params, auth: sapAuth(), timeout: 20000 }
	);
	const results = (response.data && response.data.d && response.data.d.results) || [];
	return results.map(mapSapPrToClient);
}

/**
 * Tim 1 PrDraft theo id — id co the la InternalId (chua duyet) HOAC PRId/SapPRId
 * (sau khi CFO/CEO duyet, PRId doi thanh so PR that tren SAP).
 *
 * KHONG gui $filter dang "A eq x or B eq x or C eq x" len SAP nua. SAP Gateway chi
 * chuyen duoc $filter thanh select-options theo tung property roi AND chung lai, nen
 * bieu thuc OR tren nhieu property khong bao gio cho ket qua dung — te hon nua, khi
 * PRDRAFTSET_GET_ENTITYSET chua ap select-options thi filter bi bo qua HOAN TOAN va
 * ham nay tra ve dong dau tien cua ca bang (mot PR hoan toan khong lien quan). Bang
 * ZPR_DRAFT nho nen doc het roi doi chieu o Node vua dung vua khong the sai.
 */
async function fetchPrDraftById(id) {
	const target = String(id || "").trim();
	if (!target) { return null; }
	const list = await fetchPrDraftList();
	return list.find((pr) =>
		String(pr.InternalId || "").trim() === target
		|| String(pr.PRId || "").trim() === target
		|| String(pr.SapPRId || "").trim() === target
	) || null;
}

/**
 * Tim PrDraft goc cua 1 RFQ — dung chung cho 3 route rfq/:id/send, /quotation, /award.
 * RfqSet luu ca PrId (InternalId luc tao RFQ) lan SapPrNumber (neu PR da co so SAP that).
 */
async function fetchPrDraftByRfq(rfq) {
	if (!rfq) { return null; }

	// Doi chieu o Node, KHONG gui $filter OR len SAP — xem giai thich o fetchPrDraftById().
	// Ngoai ra phai bo qua cac ve RONG: RFQ tao truoc khi PR co so SAP that thi
	// SapPrNumber rong, ghep vao filter se thanh "PRId eq ''" khop bua voi moi PR
	// chua co so SAP, va cac route send/quotation/award se ghi de Status len PR vo can.
	const sapNo = String(rfq.SapPrNumber || "").trim();
	const prId = String(rfq.PrId || "").trim();
	if (!sapNo && !prId) {
		console.warn(`[fetchPrDraftByRfq] RFQ ${rfq.RfqId} khong co PrId lan SapPrNumber — bo qua, khong doan bua.`);
		return null;
	}

	const list = await fetchPrDraftList();
	const matched = list.filter(function (pr) {
		const internalId = String(pr.InternalId || "").trim();
		const prIdField = String(pr.PRId || "").trim();
		const sapPrId = String(pr.SapPRId || "").trim();
		if (sapNo && (prIdField === sapNo || sapPrId === sapNo)) { return true; }
		if (prId && (internalId === prId || prIdField === prId)) { return true; }
		return false;
	});

	if (matched.length === 0) { return null; }
	if (matched.length > 1) {
		console.warn(`[fetchPrDraftByRfq] RFQ ${rfq.RfqId} khop ${matched.length} PR — lay ban dau tien: `
			+ matched.map((p) => p.InternalId).join(", "));
	}
	return matched[0];
}

/** Tao 1 PrDraft moi (deep-entity POST voi PrDraftToItems long ben trong). Tra ve record da map. */
async function createPrDraft(payload) {
	const response = await sapWrite("POST", "PrDraftSet", payload);
	const created = response.data && response.data.d;
	return created ? mapSapPrToClient(created) : null;
}

/** MERGE cap nhat 1 PrDraft theo InternalId (field object dung ten SAP PascalCase). */
async function updatePrDraft(internalId, fields, session) {
	await sapWrite("MERGE", `PrDraftSet('${odataEscape(internalId)}')`, fields, session);
}

/**
 * Bo sung thong tin RFQ da chot vao danh sach PR truoc khi tra ve FE.
 *
 * ZPR_DRAFT chi luu RfqId / RfqAwardedVendor / RfqFinalValue — KHONG luu ten NCC
 * va KHONG luu ly do chon. Man phe duyet PR-02 vi the truoc day chi hien duoc con
 * so tong tien, CFO khong biet Purchasing da chot ai va vi sao. Doc them RfqSet
 * (co AwardReason/AwardedBy/AwardedAt) + VendorSet (co ten NCC) de ghep vao.
 *
 * Chi doc 1 lan VendorSet cho ca danh sach, va bo qua PR nao chua co RfqId.
 * Loi khi doc phan bo sung nay khong duoc lam hong ca danh sach phe duyet.
 */
async function enrichWithRfqAward(prList) {
	if (!Array.isArray(prList) || prList.length === 0) { return prList; }

	let vendorMap = {};
	try {
		const vendors = await fetchAllVendorsFromSAP();
		vendors.forEach(function (v) { vendorMap[String(v.VendorNo)] = v.VendorName; });
	} catch (error) {
		console.error("[enrichWithRfqAward] Doc VendorSet that bai:", extractSapErrorMessage(error));
	}

	// Doc CA BANG RfqSet dung 1 lan cho ca danh sach.
	//
	// Truoc day o day loc `prList.filter(pr => pr.RfqId)` roi doc tung RfqSet('<id>')
	// theo khoa. Cach do gio SAI ve nghiep vu: 1 PR co the co NHIEU RFQ (moi nhom
	// dong 1 cai — xem rfq.service.js), ma ZPR_DRAFT-RFQID chi la 1 field CHAR10 nen
	// chi giu duoc RFQ DAU TIEN; cac nhom sau bi bo qua hoan toan. Nay doi chieu theo
	// PrId/SapPrNumber giong fetchRfqsByPr() — dung 1 request thay vi N request.
	let allRfqs = [];
	try {
		const resp = await sapRead("RfqSet");
		allRfqs = (resp.data && resp.data.d && resp.data.d.results) || [];
	} catch (error) {
		console.error("[enrichWithRfqAward] Doc RfqSet that bai:", extractSapErrorMessage(error));
		return prList;
	}

	prList.forEach(function (pr) {
		const internalId = String(pr.InternalId || "").trim();
		const prId = String(pr.PRId || "").trim();
		const sapPrId = String(pr.SapPRId || "").trim();

		const mine = allRfqs.filter(function (rfq) {
			const rfqPrId = String(rfq.PrId || "").trim();
			const rfqSapNo = String(rfq.SapPrNumber || "").trim();
			if (rfqPrId && (rfqPrId === internalId || rfqPrId === prId)) { return true; }
			if (rfqSapNo && (rfqSapNo === prId || rfqSapNo === sapPrId)) { return true; }
			return false;
		});

		if (mine.length === 0) { return; }

		// Moi nhom = 1 RFQ = 1 NCC thang thau = sau nay 1 PO. PR-02 (CFO duyet) va
		// PO-01 doc mang nay. ItemLines rong = nhom do gom toan bo dong cua PR.
		pr.RfqGroups = mine.map(function (rfq) {
			const vendorNo = String(rfq.AwardedVendor || "");
			return {
				RfqId: String(rfq.RfqId || ""),
				ItemLines: String(rfq.ItemLines || ""),
				Status: rfq.Status || "",
				AwardedVendor: vendorNo,
				AwardedVendorName: vendorMap[vendorNo] || "",
				AwardReason: rfq.AwardReason || "",
				AwardedBy: rfq.AwardedBy || "",
				AwardedAt: sapTsToIso(rfq.AwardedAt, 0) || "",
				FinalValue: Number(rfq.FinalValue) || 0,
				Currency: rfq.Currency || pr.Currency || "VND"
			};
		}).sort(function (a, b) { return a.RfqId.localeCompare(b.RfqId); });

		pr.RfqGroupCount = pr.RfqGroups.length;
		pr.RfqAllAwarded = pr.RfqGroups.every(function (g) {
			return String(g.Status || "").toUpperCase() === "AWARDED";
		});

		// Cac field le giu nguyen ten cu de man hinh chua doc theo RfqGroups khong vo.
		// PR 1 nhom: y het truoc day. PR nhieu nhom: RfqAwardedVendorName de RONG co y
		// (khong ton tai "1 NCC cua ca PR"), de PO-01 khong tu dien bua.
		const primary = pr.RfqGroups[0];
		pr.RfqAwardReason = pr.RfqGroups.length === 1
			? primary.AwardReason
			: pr.RfqGroups.map(function (g) { return g.RfqId + ": " + g.AwardReason; }).filter(Boolean).join(" | ");
		pr.RfqAwardedBy = primary.AwardedBy;
		pr.RfqAwardedAt = primary.AwardedAt;
		pr.RfqStatus = pr.RfqGroups.length === 1
			? primary.Status
			: (pr.RfqAllAwarded ? "AWARDED" : "IN_PROGRESS");
		pr.RfqAwardedVendorName = pr.RfqGroups.length === 1 ? primary.AwardedVendorName : "";
	});

	return prList;
}

// 🎯 Lấy SỐ DÒNG (ItemNo) THẬT của PR trực tiếp từ SAP OData — không đoán, không hardcode.

async function fetchPRItemsFromSAP(prNumber) {
	if (!process.env.SAP_HOST || !prNumber) { return []; }

	const candidateFilterFields = ["PRNumber", "PrNumber", "PRId", "ReqNo"];
	const target = String(prNumber).replace(/^0+/, "");

	for (const field of candidateFilterFields) {
		try {
			const response = await axios.get(
				`${process.env.SAP_HOST}${ODATA_SERVICE_PATH}/PurchaseRequisitionHisSet`,
				{
					params: { "$filter": `${field} eq '${prNumber}'`, "$format": "json" },
					auth: sapAuth(),
					timeout: 20000
				}
			);
			let results = (response.data && response.data.d && response.data.d.results) || [];

			// Loc lai o Node: nhieu method <EntitySet>_GET_ENTITYSET ben SAP bo qua $filter
			// (so ten property camel-case voi ten VIET HOA ma Gateway gui) va tra ve CA BANG.
			// Neu tin ket qua tho thi se lay nham dong cua PR khac. Xem memory:
			// SAP490_G1 PR ghi len SAP that 13/08.
			results = results.filter(function (row) {
				const rowPr = String(row.PRNumber || row.PrNumber || row.PRId || row.ReqNo || "")
					.replace(/^0+/, "");
				return rowPr === target;
			});

			if (results.length > 0) {
				console.log(`[fetchPRItemsFromSAP] Khop filter field "${field}" cho PR ${prNumber}, tra ve ${results.length} dong.`);
				return results;
			}
		} catch (error) {
			// Field không tồn tại trên entity hoặc không khớp -> thử field tiếp theo
			continue;
		}
	}
	console.error(`[fetchPRItemsFromSAP] Khong lay duoc dong vat tu that cho PR ${prNumber} tu SAP.`);
	return [];
}

function pickRealItemNo(row) {
	return row.ItemNo || row.PRItem || row.ReqItem || row.PrItem || row.Item || row.LineNo || null;
}
module.exports = {
	createPRInSAP,
	createPrDraft,
	enrichWithRfqAward,
	fetchPRItemsFromSAP,
	fetchPrDraftById,
	fetchPrDraftByRfq,
	fetchPrDraftList,
	mapClientItemToSapDeep,
	pickRealItemNo,
	updatePrDraft,
};
