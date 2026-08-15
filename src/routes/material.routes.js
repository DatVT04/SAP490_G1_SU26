/**
 * Man MM01: value help + tao material master.
 *
 * Tach ra tu server.js (ban goc 4520 dong) ngay 15/08/2026.
 * Noi dung ham giu nguyen 100%, chi them phan require/exports o dau va cuoi file.
 */


const express = require("express");
const axios = require("axios");
const { MATERIAL_MASTER_CONFIG } = require("../config/master-data");
const { ODATA_SERVICE_PATH } = require("../config/org");
const { extractSapErrorMessage, sapAuth } = require("../lib/sap-client");
const { buildMaterialCreatePayload, fetchMaterialValueHelpFromSAP, mockMaterialValueHelp } = require("../services/masterdata.service");

const router = express.Router();


router.get("/api/material-master/value-help", async function (req, res) {
	const type = String(req.query.type || "ZAST").toUpperCase();
	if (!MATERIAL_MASTER_CONFIG[type]) {
		return res.status(400).json({
			success: false,
			message: "Material Type chỉ nhận ZAST hoặc ZSRV."
		});
	}
	if (!process.env.SAP_HOST) {
		return res.json({
			success: true,
			sapIntegration: "mock",
			data: mockMaterialValueHelp(type)
		});
	}
	try {
		return res.json({
			success: true,
			sapIntegration: "fetched",
			data: await fetchMaterialValueHelpFromSAP(type)
		});
	} catch (error) {
		console.error("[material-master/value-help] SAP error:", error.response?.status || error.message);
		return res.json({
			success: true,
			sapIntegration: "fallback",
			sapError: true,
			data: mockMaterialValueHelp(type)
		});
	}
});

router.post("/api/material-master/create", async function (req, res) {
	const body = req.body || {};
	const type = String(body.materialType || "").toUpperCase();
	const fixed = MATERIAL_MASTER_CONFIG[type];
	if (!fixed) {
		return res.status(400).json({ success: false, message: "Material Type không hợp lệ." });
	}
	if (!String(body.materialNo || "").trim()) {
		return res.status(400).json({
			success: false,
			message: "Thiếu mã Material."
		});
	}
	if (!String(body.description || "").trim()) {
		return res.status(400).json({ success: false, message: "Thiếu tên vật tư/dịch vụ." });
	}
	if (!String(body.baseUnit || "").trim()) {
		return res.status(400).json({ success: false, message: "Thiếu đơn vị tính cơ bản." });
	}
	if (!String(body.materialGroup || "").trim()) {
		return res.status(400).json({ success: false, message: "Thiếu nhóm vật tư/dịch vụ." });
	}
	if (type === "ZSRV" && !String(body.purchaseOrderText || "").trim()) {
		return res.status(400).json({
			success: false,
			message: "Dịch vụ cần có mô tả chi tiết/phạm vi dịch vụ."
		});
	}
	const sapPayload = buildMaterialCreatePayload(body, fixed);
	if (!process.env.SAP_HOST) {
		const mockMaterialNumber = String(Date.now()).slice(-8);
		return res.status(201).json({
			success: true,
			sapIntegration: "mock",
			materialNumber: mockMaterialNumber,
			data: {
				materialNumber: mockMaterialNumber,
				payload: sapPayload
			}
		});
	}
	const entitySet = process.env.SAP_MATERIAL_CREATE_ENTITY_SET || "MaterialSet";
	try {
		const tokenResponse = await axios.get(
			`${process.env.SAP_HOST}${ODATA_SERVICE_PATH}`,
			{
				auth: sapAuth(),
				headers: {
					"X-CSRF-Token": "Fetch",
					"sap-language": sapPayload.Language || "EN"
				},
				timeout: 20000
			}
		);
		const csrfToken = tokenResponse.headers["x-csrf-token"];
		const cookies = tokenResponse.headers["set-cookie"];
		const sapResponse = await axios.post(
			`${process.env.SAP_HOST}${ODATA_SERVICE_PATH}/${entitySet}`,
			sapPayload,
			{
				auth: sapAuth(),
				headers: {
					"Content-Type": "application/json",
					"Accept": "application/json",
					"X-CSRF-Token": csrfToken,
					"Cookie": cookies ? cookies.join("; ") : "",
					"sap-language": sapPayload.Language || "EN"
				},
				timeout: 30000
			}
		);
		const created = (sapResponse.data && sapResponse.data.d) || sapResponse.data || {};
		const materialNumber = created.MaterialNo
			|| created.MaterialNumber
			|| created.Matnr
			|| created.MATNR
			|| "";
		return res.status(201).json({
			success: true,
			sapIntegration: "created",
			materialNumber: String(materialNumber || ""),
			data: created
		});
	} catch (error) {
		// Nhanh An dung getSapBusinessError() nhung khong dinh nghia o dau ca (bug co san
		// tren nhanh An, se ReferenceError neu that su roi vao day) - doi sang ham tuong
		// duong da co san tren main.
		const message = extractSapErrorMessage(error);
		console.error("[material-master/create] THAT BAI:", message);
		return res.status(502).json({
			success: false,
			message: "Không tạo được danh mục trên SAP: " + message,
			sapError: true
		});
	}
});
module.exports = router;
