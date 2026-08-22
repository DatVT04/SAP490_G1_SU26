/**
 * Man GAN THE TAI SAN (role PURCHASING) — buoc sau khi don hang da tao.
 * Xem src/services/asset.service.js de biet vi sao co buoc nay.
 */


const express = require("express");
const { extractSapErrorMessage } = require("../lib/sap-client");
const { notifyRequester } = require("../services/notify.service");
const { fetchPrDraftById } = require("../services/pr.service");
const { createAssetsForLine, fetchPendingAssetLines } = require("../services/asset.service");

const router = express.Router();


// Danh sach dong vat tu tai san cho gan the.
router.get("/api/asset-assignment/pending", async (req, res) => {
	if (!process.env.SAP_HOST) {
		return res.status(503).json({ success: false, message: "He thong SAP chua duoc cau hinh (thieu SAP_HOST)." });
	}
	try {
		const data = await fetchPendingAssetLines();
		return res.json({
			success: true,
			data: data,
			// De man hinh hien duoc "con X dong chua gan" ma khong phai tu dem lai.
			openCount: data.filter(function (r) { return r.Remaining > 0; }).length
		});
	} catch (error) {
		const message = extractSapErrorMessage(error);
		console.error("[GET /api/asset-assignment/pending] THAT BAI:", message);
		return res.status(502).json({ success: false, message });
	}
});

// Tao the tai san cho 1 dong. Chi Phong Mua sam duoc goi.
router.post("/api/asset-assignment/create", async (req, res) => {
	const { prId, lineNo, count, description, costCenter, capitalizedOn, assetClass, role, createdByEmail } = req.body || {};

	if (!process.env.SAP_HOST) {
		return res.status(503).json({ success: false, message: "He thong SAP chua duoc cau hinh (thieu SAP_HOST)." });
	}
	// Chan o backend chu khong chi an tile: tao the tai san la buoc sinh chung tu
	// tren SAP, goi thang bang Postman van phai dung vai tro.
	if (String(role || "").toUpperCase() !== "PURCHASING") {
		return res.status(403).json({ success: false, message: "Chỉ Phòng Mua sắm được gán mã tài sản." });
	}
	if (!prId || lineNo == null || lineNo === "") {
		return res.status(400).json({ success: false, message: "Thieu prId hoac lineNo." });
	}

	try {
		const result = await createAssetsForLine({
			prId: prId,
			lineNo: lineNo,
			count: count,
			description: description,
			costCenter: costCenter,
			capitalizedOn: capitalizedOn,
			assetClass: assetClass,
			createdByEmail: createdByEmail
		});

		// Bao cho nguoi de nghi biet do da thanh tai san cua cong ty — day la cai
		// ket that su cua de nghi mua sam, truoc gio khong ai bao ho.
		if (result.created.length > 0) {
			try {
				const pr = await fetchPrDraftById(prId);
				if (pr) {
					notifyRequester(
						pr,
						"Vật tư trong đề nghị " + pr.PRId + " đã được ghi nhận thành tài sản của công ty. "
						+ "Mã tài sản: " + result.created.map(function (c) { return c.assetNo; }).join(", ") + "."
					);
				}
			} catch (e) {
				console.error("[POST /api/asset-assignment/create] Thong bao nguoi de nghi that bai:", e.message);
			}
		}

		// Tao duoc 1 phan roi hong: van la 201 vi cac the da tao la CO THAT tren
		// SAP — bao kem loi de ke toan biet con thieu may the.
		return res.status(result.created.length > 0 ? 201 : 502).json({
			success: result.created.length > 0,
			created: result.created,
			remaining: result.remaining,
			savedToSap: result.savedToSap,
			message: result.error || ""
		});
	} catch (error) {
		const code = error.statusCode || 502;
		const message = error.statusCode ? error.message : extractSapErrorMessage(error);
		console.error("[POST /api/asset-assignment/create] THAT BAI:", message);
		return res.status(code).json({ success: false, message });
	}
});
module.exports = router;
