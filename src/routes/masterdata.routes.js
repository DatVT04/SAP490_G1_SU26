/**
 * Danh muc cho dropdown: GL, cost center, internal order, material, NCC.
 *
 * Tach ra tu server.js (ban goc 4520 dong) ngay 15/08/2026.
 * Noi dung ham giu nguyen 100%, chi them phan require/exports o dau va cuoi file.
 */


const express = require("express");
const axios = require("axios");
const { isMaterialSelectable } = require("../config/master-data");
const { ODATA_SERVICE_PATH } = require("../config/org");
const { sapAuth } = require("../lib/sap-client");
const { fetchGLAccountsFromHistory, fetchInternalOrderMaster } = require("../services/masterdata.service");
const { fetchAllVendorsFromSAP } = require("../services/vendor.service");

const router = express.Router();


router.get("/api/gl-accounts", async (req, res) => {
	return res.json({ success: true, data: await fetchGLAccountsFromHistory() });
});

router.get("/api/cost-centers", async (req, res) => {
	const master = await fetchInternalOrderMaster();
	return res.json({ success: true, data: master.costCenters });
});

router.get("/api/internal-orders", async (req, res) => {
	const master = await fetchInternalOrderMaster();
	return res.json({
		success: true,
		data: master.internalOrders,
		ioToCostCenter: master.ioToCostCenter,
		costCenterToIOs: master.costCenterToIOs
	});
});

router.get("/api/materials", async (req, res) => {
	if (!process.env.SAP_HOST) {
		return res.status(503).json({ success: false, message: "He thong SAP chua duoc cau hinh (thieu SAP_HOST)." });
	}
	try {
		const response = await axios.get(
			`${process.env.SAP_HOST}${ODATA_SERVICE_PATH}/MaterialSet`,
			{ params: { "$format": "json" }, auth: sapAuth() }
		);
		const all = (response.data && response.data.d && response.data.d.results) || [];
		const data = all.filter(isMaterialSelectable);
		if (all.length !== data.length) {
			console.log("[MaterialSet] An", all.length - data.length, "vat tu khong tao duoc PO;", data.length, "ma con lai");
		}
		return res.json({ success: true, data: data });
	} catch (error) {
		console.error("❌ MaterialSet:", error.message);
		return res.status(502).json({ success: false, message: "Khong the lay du lieu vat tu tu SAP.", sapError: true });
	}
});

router.get("/api/vendors", async (req, res) => {
	if (!process.env.SAP_HOST) {
		return res.status(503).json({ success: false, message: "He thong SAP chua duoc cau hinh (thieu SAP_HOST)." });
	}
	try {
		const allVendors = await fetchAllVendorsFromSAP();
		return res.json({ success: true, data: allVendors });
	} catch (error) {
		console.error("❌ VendorSet:", error.message);
		return res.status(502).json({ success: false, message: "Khong the lay du lieu nha cung cap tu SAP.", sapError: true });
	}
});
module.exports = router;
