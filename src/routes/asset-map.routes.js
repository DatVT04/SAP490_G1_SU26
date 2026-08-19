/**
 * Danh muc anh xa vat tu (ZAST) -> ma tai san.
 *
 * Vi sao can: SAP khong co lien ket san giua Material (MM) va Asset (FI-AA), nen
 * quan he "vat tu nay chinh la tai san nao" phai duoc khai o dau do. Hoi dong
 * review 19/08 yeu cau PR-01 tu dien ma tai san khi chon vat tu tai san — day la
 * cho khai.
 *
 * Noi luu: bang Z `ZG1_MAT_ASSET` tren SAP (entity MatAssetSet). Chi tiet cach
 * doc/ghi + duong lui khi SAP chua san sang: xem src/services/asset-map.service.js.
 */


const express = require("express");
const { normalizeMaterialKey } = require("../lib/store");
const { loadAssetMap, saveAssetMapTo } = require("../services/asset-map.service");

const router = express.Router();


router.get("/api/asset-map", async (req, res) => {
	const result = await loadAssetMap();
	return res.json({
		success: true,
		byMaterial: result.byMaterial,
		storage: result.storage,
		warning: result.warning || ""
	});
});

router.put("/api/asset-map", async (req, res) => {
	const body = req.body || {};

	// Nhan 2 dang: sua 1 vat tu {materialNo, assets} hoac ghi ca bang {byMaterial}.
	let byMaterial = {};
	if (body.materialNo != null) {
		if (!normalizeMaterialKey(body.materialNo)) {
			return res.status(400).json({ success: false, message: "Ma vat tu khong hop le." });
		}
		byMaterial[body.materialNo] = body.assets;
	}
	if (body.byMaterial && typeof body.byMaterial === "object") {
		byMaterial = Object.assign(byMaterial, body.byMaterial);
	}
	if (Object.keys(byMaterial).length === 0) {
		return res.status(400).json({ success: false, message: "Khong co du lieu de luu." });
	}

	const result = await saveAssetMapTo(byMaterial, body.changedBy);
	return res.json({
		success: true,
		byMaterial: result.byMaterial,
		storage: result.storage,
		warning: result.warning || ""
	});
});
module.exports = router;
