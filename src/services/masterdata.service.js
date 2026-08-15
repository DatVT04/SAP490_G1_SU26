/**
 * Doc master data tu SAP: internal order, GL, value help material.
 *
 * Tach ra tu server.js (ban goc 4520 dong) ngay 15/08/2026.
 * Noi dung ham giu nguyen 100%, chi them phan require/exports o dau va cuoi file.
 */


const axios = require("axios");
const { costCenterLabelVi } = require("../config/master-data");
const { ODATA_SERVICE_PATH } = require("../config/org");
const { sapAuth } = require("../lib/sap-client");
const { normalizeOrderNo } = require("../lib/store");


async function fetchInternalOrderMaster() {
	const EMPTY = {
		internalOrders: [],
		costCenters: [],
		ioToCostCenter: {},
		costCenterToIOs: {}
	};

	if (!process.env.SAP_HOST) {
		console.error("⚠️ SAP_HOST chua cau hinh — khong co master CC/IO");
		return EMPTY;
	}

	const ioMap = {};
	const ccMap = {};
	const ioToCostCenter = {};
	const costCenterToIOs = {};

	function addIO(orderNo, orderName, cc, ccName) {
		orderNo = normalizeOrderNo(orderNo);
		cc = String(cc || "").trim();
		if (!orderNo) { return; }

		if (!ioMap[orderNo]) {
			ioMap[orderNo] = {
				InternalOrder: orderNo,
				Description: String(orderName || orderNo).trim(),
				CostCenter: cc,
				CostCenterName: String(ccName || cc).trim(),
				CompanyCode: "",
				OrderType: ""
			};
		} else {
			var sName = String(orderName || "").trim();
			if (sName && sName !== orderNo && ioMap[orderNo].Description === orderNo) {
				ioMap[orderNo].Description = sName;
			}
			if (cc && !ioMap[orderNo].CostCenter) {
				ioMap[orderNo].CostCenter = cc;
				ioMap[orderNo].CostCenterName = String(ccName || cc).trim();
			}
		}

		if (cc) {
			ccMap[cc] = String(ccName || ccMap[cc] || cc).trim();
			ioToCostCenter[orderNo] = cc;
			if (!costCenterToIOs[cc]) { costCenterToIOs[cc] = []; }
			if (costCenterToIOs[cc].indexOf(orderNo) === -1) {
				costCenterToIOs[cc].push(orderNo);
			}
		}
	}

	function addCC(cc, ccName) {
		cc = String(cc || "").trim();
		if (!cc) { return; }
		if (!ccMap[cc] || ccMap[cc] === cc) {
			ccMap[cc] = String(ccName || cc).trim();
		}
	}

	try {
		const response = await axios.get(
			`${process.env.SAP_HOST}${ODATA_SERVICE_PATH}/InternalOrderSet`,
			{ params: { "$format": "json" }, auth: sapAuth(), timeout: 20000 }
		);
		const results = (response.data && response.data.d && response.data.d.results) || [];
		console.log("[SAP] InternalOrderSet:", results.length, "dong");

		results.forEach(function (row) {
			const orderNo = row.OrderNo || row.InternalOrder || row.Aufnr || "";
			const orderName = row.OrderName || row.Description || row.Ktext || orderNo;
			const cc = row.CostCenter || row.Kostl || "";
			const ccName = row.CostCenterName || row.KtextCc || cc;
			addIO(orderNo, orderName, cc, ccName);
			const key = normalizeOrderNo(orderNo);
			if (key && ioMap[key]) {
				if (row.CompanyCode) { ioMap[key].CompanyCode = row.CompanyCode; }
				if (row.OrderType) { ioMap[key].OrderType = row.OrderType; }
			}
		});
	} catch (error) {
		console.error("⚠️ InternalOrderSet THAT BAI:", error.response?.status || error.message);
	}

	try {
		const response = await axios.get(
			`${process.env.SAP_HOST}${ODATA_SERVICE_PATH}/PurchaseRequisitionHisSet`,
			{
				params: {
					"$format": "json",
					"$select": "CostCenter,InternalOrder,GLAccount"
				},
				auth: sapAuth(),
				timeout: 20000
			}
		);
		const results = (response.data && response.data.d && response.data.d.results) || [];
		console.log("[SAP] PR history (CC/IO):", results.length, "dong");

		results.forEach(function (row) {
			const cc = row.CostCenter || "";
			const io = row.InternalOrder || "";
			addCC(cc, cc);
			if (io) { addIO(io, io, cc, cc); }
		});
	} catch (error) {
		console.error("⚠️ PR history CC/IO THAT BAI:", error.response?.status || error.message);
	}

	const internalOrders = Object.keys(ioMap).sort().map(function (k) {
		const io = ioMap[k];
		io.CostCenterName = costCenterLabelVi(io.CostCenter, io.CostCenterName);
		return io;
	});
	const costCenters = Object.keys(ccMap).sort().map(function (code) {
		return { CostCenter: code, Description: costCenterLabelVi(code, ccMap[code]) };
	});

	console.log("[SAP] Master ket qua: IO=", internalOrders.length, "CC=", costCenters.length);
	return { internalOrders, costCenters, ioToCostCenter, costCenterToIOs };
}

async function fetchGLAccountsFromHistory() {
	if (!process.env.SAP_HOST) { return []; }
	try {
		const response = await axios.get(
			`${process.env.SAP_HOST}${ODATA_SERVICE_PATH}/PurchaseRequisitionHisSet`,
			{
				params: { "$format": "json", "$select": "GLAccount" },
				auth: sapAuth(),
				timeout: 20000
			}
		);
		const results = (response.data && response.data.d && response.data.d.results) || [];
		const map = {};
		results.forEach(function (row) {
			const gl = String(row.GLAccount || "").trim();
			if (gl) { map[gl] = true; }
		});
		return Object.keys(map).sort().map(function (code) {
			return { GLAccount: code, Description: code };
		});
	} catch (error) {
		console.error("⚠️ GL history:", error.message);
		return [];
	}
}

function mockMaterialValueHelp(type) {
	return {
		uoms: [
			{ code: "PC", description: "Piece" },
			{ code: "EA", description: "Each" },
			{ code: "MON", description: "Month" },
			{ code: "YR", description: "Year" },
			{ code: "H", description: "Hour" },
			{ code: "DAY", description: "Day" }
		],
		materialGroups: type === "ZSRV"
			? [{ code: "Z20V", description: "QDAVY Service Group" }]
			: [{ code: "Z10V", description: "QDAVY Asset/Material Group" }],
		purchasingGroups: []
	};
}

/** Loc trung theo "code", bo cac dong khong co code. Dung cho uoms/materialGroups/purchasingGroups. */
function uniqueCodeDescription(rows) {
	const map = {};
	(rows || []).forEach(function (r) {
		const code = String((r && r.code) || "").trim();
		if (!code) { return; }
		if (!map[code]) {
			map[code] = { code: code, description: String((r && r.description) || code).trim() };
		}
	});
	return Object.keys(map).map(function (k) { return map[k]; });
}

async function fetchMaterialValueHelpFromSAP(type) {
	const response = await axios.get(
		`${process.env.SAP_HOST}${ODATA_SERVICE_PATH}/MaterialSet`,
		{
			params: { "$format": "json" },
			auth: sapAuth(),
			timeout: 20000
		}
	);
	const results = (response.data && response.data.d && response.data.d.results) || [];
	const filtered = results.filter(function (row) {
		const rowType = String(
			row.MaterialType || row.MatType || row.Mtart || row.MTART || ""
		).trim();
		return !rowType || rowType === type;
	});
	const source = filtered.length ? filtered : results;
	const uoms = uniqueCodeDescription(source.map(function (row) {
		return {
			code: row.BaseUnit || row.UoM || row.Uom || row.Meins || row.MEINS,
			description: row.BaseUnitText || row.UoMText || row.UomText || row.UnitDescription
		};
	}));
	const materialGroups = uniqueCodeDescription(source.map(function (row) {
		return {
			code: row.MaterialGroup || row.MatGroup || row.Matkl || row.MATKL,
			description: row.MaterialGroupText || row.MatGroupText || row.MaterialGroupDescription
		};
	}));
	const purchasingGroups = uniqueCodeDescription(source.map(function (row) {
		return {
			code: row.PurchasingGroup || row.PurchGroup || row.Ekgrp || row.EKGRP,
			description: row.PurchasingGroupText || row.PurchGroupText || row.PurchasingGroupDescription
		};
	}));
	const fallback = mockMaterialValueHelp(type);
	return {
		uoms: uoms.length ? uoms : fallback.uoms,
		materialGroups: materialGroups.length ? materialGroups : fallback.materialGroups,
		purchasingGroups: purchasingGroups
	};
}

function buildMaterialCreatePayload(body, fixed) {
	// TODO: Đối chiếu tên property với $metadata của ZG1_PROC_SRV_SRV.
	// Đây là mapping nghiệp vụ đã chốt từ MM01/MM03.
	return {
		MaterialNo: String(body.materialNo || "").trim(),
		MaterialType: fixed.materialType,
		IndustrySector: fixed.industrySector,
		Description: String(body.description || "").trim().substring(0, 40),
		BaseUnit: String(body.baseUnit || "").trim(),
		MaterialGroup: String(body.materialGroup || "").trim(),
		PurchasingGroup: String(body.purchasingGroup || "").trim(),
		Plant: fixed.plant,
		StorageLocation: fixed.storageLocation,
		PurchaseOrderText: String(body.purchaseOrderText || "").trim(),
		Language: String(body.language || "EN").trim().toUpperCase()
	};
}
module.exports = {
	buildMaterialCreatePayload,
	fetchGLAccountsFromHistory,
	fetchInternalOrderMaster,
	fetchMaterialValueHelpFromSAP,
	mockMaterialValueHelp,
};
