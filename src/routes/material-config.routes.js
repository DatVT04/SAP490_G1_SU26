/**
 * Danh muc tai san cua vat tu: nhom tai san + kho ma tai san.
 *
 * Man Cau hinh he thong (CEO) khai; PR-01 doc de tu dien Ma tai san khi nguoi de
 * nghi chon vat tu tai san. Noi luu: bang Z `ZG1_MAT_CONFIG` tren SAP — chi tiet
 * va duong lui xem src/services/material-config.service.js.
 *
 * GIA khong di qua route nay: gia cua vat tu lay tu material master (MM02),
 * MaterialSet tra ve cung danh sach vat tu.
 */


const express = require("express");
const { normalizeMaterialKey } = require("../lib/store");
const { loadMaterialConfig, saveMaterialConfigTo } = require("../services/material-config.service");

const router = express.Router();


router.get("/api/material-config", async (req, res) => {
	const result = await loadMaterialConfig();
	return res.json({
		success: true,
		byMaterial: result.byMaterial,
		storage: result.storage,
		warning: result.warning || ""
	});
});

router.put("/api/material-config", async (req, res) => {
	const body = req.body || {};

	// Nhan 2 dang: sua 1 vat tu {materialNo, assets, assetClass} hoac ghi ca bang
	// {byMaterial}.
	let byMaterial = {};
	if (body.materialNo != null) {
		if (!normalizeMaterialKey(body.materialNo)) {
			return res.status(400).json({ success: false, message: "Ma vat tu khong hop le." });
		}
		byMaterial[body.materialNo] = {
			assets: body.assets,
			assetClass: body.assetClass
		};
	}
	if (body.byMaterial && typeof body.byMaterial === "object") {
		byMaterial = Object.assign(byMaterial, body.byMaterial);
	}
	if (Object.keys(byMaterial).length === 0) {
		return res.status(400).json({ success: false, message: "Khong co du lieu de luu." });
	}

	const result = await saveMaterialConfigTo(byMaterial, body.changedBy);
	return res.json({
		success: true,
		byMaterial: result.byMaterial,
		storage: result.storage,
		warning: result.warning || ""
	});
});
module.exports = router;
