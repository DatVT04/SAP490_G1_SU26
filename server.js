const nodemailer = require("nodemailer");
require("dotenv").config();
const transporter = nodemailer.createTransport({
	service: "gmail",
	auth: {
		user: process.env.EMAIL_USER,
		pass: process.env.EMAIL_PASS
	}
});
const express = require("express");
const cors = require("cors");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const os = require("os");

const { employees, materials, vendors, pendingPRs } = require("./webapp/model/MockData");

const app = express();
const PORT = process.env.PORT || 3001;
app.use(cors());
app.use(express.json());

app.get("/api/health", (req, res) => res.json({ ok: true }));

app.use(express.static(path.join(__dirname, "webapp")));

const ODATA_SERVICE_PATH = "/sap/opu/odata/sap/ZG1_PROC_SRV_SRV";

const PAMS_ESCALATION_THRESHOLD = 300000000;
const LEGAL_ESCALATION_THRESHOLD = 100000000;

// ============================================================================
// PERSIST — lưu file JSON, không mất khi restart server
// Trên Vercel, /var/task chỉ đọc (read-only) — chỉ /tmp mới ghi được (nhưng /tmp
// không bền, có thể mất khi cold start / đổi instance). Local dev vẫn dùng ./data
// như cũ để dữ liệu bền thật sự giữa các lần chạy.
// ============================================================================
const IS_SERVERLESS = !!(process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME);
const DATA_DIR = IS_SERVERLESS
	? path.join(os.tmpdir(), "qdavy-data")
	: path.join(__dirname, "data");
const APPROVAL_FILE = path.join(DATA_DIR, "approvals.json");
const NOTIF_FILE = path.join(DATA_DIR, "notifications.json");

// material create
const MATERIAL_MASTER_CONFIG = Object.freeze({
	ZAST: {
		materialType: "ZAST",
		industrySector: "S",
		plant: "QDPL",
		storageLocation: "QDSL"
	},
	ZSRV: {
		materialType: "ZSRV",
		industrySector: "S",
		plant: "QDPL",
		storageLocation: ""
	}
});

function ensureDataDir() {
	try {
		if (!fs.existsSync(DATA_DIR)) {
			fs.mkdirSync(DATA_DIR, { recursive: true });
		}
		return true;
	} catch (e) {
		console.error("⚠️ Khong tao duoc thu muc data (" + DATA_DIR + "):", e.message);
		return false;
	}
}

function loadApprovals() {
	const seed = [...pendingPRs].map(function (pr) { return { ...pr }; });
	if (!ensureDataDir() || !fs.existsSync(APPROVAL_FILE)) {
		return { items: seed, nextSeq: seed.length + 1 };
	}
	try {
		const raw = JSON.parse(fs.readFileSync(APPROVAL_FILE, "utf8"));
		const items = Array.isArray(raw.items) ? raw.items : [];
		const nextSeq = Number(raw.nextSeq) || (items.length + 1);
		return { items: items, nextSeq: nextSeq };
	} catch (e) {
		console.error("⚠️ Load approvals THAT BAI:", e.message);
		return { items: seed, nextSeq: seed.length + 1 };
	}
}

function saveApprovals() {
	if (!ensureDataDir()) { return; }
	try {
		fs.writeFileSync(
			APPROVAL_FILE,
			JSON.stringify({ items: approvalStore, nextSeq: nextApprovalSeq }, null, 2),
			"utf8"
		);
	} catch (e) {
		console.error("⚠️ Save approvals THAT BAI:", e.message);
	}
}

function loadNotifications() {
	if (!ensureDataDir() || !fs.existsSync(NOTIF_FILE)) {
		return { items: [], nextId: 1 };
	}
	try {
		const raw = JSON.parse(fs.readFileSync(NOTIF_FILE, "utf8"));
		return {
			items: Array.isArray(raw.items) ? raw.items : [],
			nextId: Number(raw.nextId) || 1
		};
	} catch (e) {
		console.error("⚠️ Load notifications THAT BAI:", e.message);
		return { items: [], nextId: 1 };
	}
}

function saveNotifications() {
	if (!ensureDataDir()) { return; }
	try {
		fs.writeFileSync(
			NOTIF_FILE,
			JSON.stringify({ items: notificationStore, nextId: nextNotificationId }, null, 2),
			"utf8"
		);
	} catch (e) {
		console.error("⚠️ Save notifications THAT BAI:", e.message);
	}
}

const _loadedApprovals = loadApprovals();
const approvalStore = _loadedApprovals.items;
let nextApprovalSeq = _loadedApprovals.nextSeq;

const _loadedNotifs = loadNotifications();
const notificationStore = _loadedNotifs.items;
let nextNotificationId = _loadedNotifs.nextId;

console.log("[DATA] Loaded PR:", approvalStore.length, "| nextSeq:", nextApprovalSeq);
console.log("[DATA] Loaded notif:", notificationStore.length);




function pushNotification(toEmail, prId, message) {
	if (!toEmail) { return; }
	notificationStore.push({
		id: nextNotificationId++,
		toEmail,
		prId,
		message,
		createdAt: new Date().toISOString(),
		read: false
	});
	saveNotifications();
}

function buildApprovalFlags(totalValue) {
	return {
		needsProcurementHeadReview: totalValue > PAMS_ESCALATION_THRESHOLD,
		needsLegalReview: totalValue > LEGAL_ESCALATION_THRESHOLD
	};
}

function sapAuth() {
	return {
		username: process.env.SAP_USER,
		password: process.env.SAP_PASS
	};
}

function findCeoEmails() {
	return employees
		.filter(function (e) {
			return e.IsActive && String(e.Role || "").toUpperCase() === "CEO";
		})
		.map(function (e) { return e.Email; })
		.filter(Boolean);
}

function notifyRequester(record, message) {
	pushNotification(record.RequesterEmail, record.PRId, message);
}

function notifyCeos(prId, message) {
	findCeoEmails().forEach(function (email) {
		pushNotification(email, prId, message);
	});
}

// material create
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
		orderNo = String(orderNo || "").trim();
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
			if (orderName && ioMap[orderNo].Description === orderNo) {
				ioMap[orderNo].Description = String(orderName).trim();
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
			if (row.CompanyCode) {
				const key = String(orderNo).trim();
				if (ioMap[key]) { ioMap[key].CompanyCode = row.CompanyCode; }
			}
			if (row.OrderType) {
				const key = String(orderNo).trim();
				if (ioMap[key]) { ioMap[key].OrderType = row.OrderType; }
			}
		});
	} catch (error) {
		console.error("⚠️ InternalOrderSet THAT BAI:", error.response?.status || error.message);
		if (error.response?.data) {
			console.error(JSON.stringify(error.response.data).slice(0, 500));
		}
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
			if (io) {
				addIO(io, io, cc, cc);
			}
		});
	} catch (error) {
		console.error("⚠️ PR history CC/IO THAT BAI:", error.response?.status || error.message);
	}

	const internalOrders = Object.keys(ioMap).sort().map(function (k) {
		return ioMap[k];
	});
	const costCenters = Object.keys(ccMap).sort().map(function (code) {
		return { CostCenter: code, Description: ccMap[code] };
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

// material create
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

app.get("/api/gl-accounts", async (req, res) => {
	return res.json({ success: true, data: await fetchGLAccountsFromHistory() });
});

app.get("/api/cost-centers", async (req, res) => {
	const master = await fetchInternalOrderMaster();
	return res.json({ success: true, data: master.costCenters });
});

app.get("/api/internal-orders", async (req, res) => {
	const master = await fetchInternalOrderMaster();
	return res.json({
		success: true,
		data: master.internalOrders,
		ioToCostCenter: master.ioToCostCenter,
		costCenterToIOs: master.costCenterToIOs
	});
});
//material create
app.get("/api/material-master/value-help", async function (req, res) {
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

function defaultGLAccount(materialType) {
	var GL_MAP = { ZAST: "211100", ZSRV: "641000", ZROH: "641000" };
	return GL_MAP[materialType] || "641000";
}

async function createPRInSAP(record) {

	if (!process.env.SAP_HOST) {
		return { sapIntegration: "mock", sapPrNumber: null, sapErrorMessage: "SAP_HOST chua cau hinh" };
	}

	const firstItem = record.items[0] || {};
	try {
		const tokenResponse = await axios.get(
			`${process.env.SAP_HOST}${ODATA_SERVICE_PATH}`,
			{ auth: sapAuth(), headers: { "X-CSRF-Token": "Fetch", "sap-language": "EN" } }
		);
		const csrfToken = tokenResponse.headers["x-csrf-token"];
		const cookies = tokenResponse.headers["set-cookie"];

		const sapResponse = await axios.post(
			`${process.env.SAP_HOST}${ODATA_SERVICE_PATH}/PurchaseRequisitionHisSet`,
			{
				MaterialNo: firstItem.MaterialNo || "",
				Description: firstItem.Description || "",
				Quantity: String(firstItem.Quantity || 1),
				Uom: firstItem.UoM || "PC",
				EstimatedValue: String(firstItem.EstimatedValue || 0),
				Currency: record.Currency || "VND",
				CostCenter: firstItem.CostCenter || "",
				InternalOrder: firstItem.InternalOrder || "",
				GLAccount: firstItem.GLAccount || defaultGLAccount(firstItem.MaterialType)
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
// Material create
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

// --- Login ---
app.post("/api/login", async (req, res) => {
	const { email } = req.body || {};
	if (!email) {
		return res.status(400).json({ success: false, message: "Thieu email." });
	}

	if (!process.env.SAP_HOST) {
		const employee = employees.find(
			(emp) => emp.Email.toLowerCase() === String(email).toLowerCase()
		);
		if (!employee || !employee.IsActive) {
			return res.status(401).json({ success: false, message: "Email khong ton tai hoac tai khoan da bi khoa." });
		}
		return res.json({ success: true, employee });
	}

	try {
		const response = await axios.get(
			`${process.env.SAP_HOST}${ODATA_SERVICE_PATH}/EmployeeSet`,
			{ params: { "$filter": `Email eq '${email}'`, "$format": "json" }, auth: sapAuth() }
		);
		const results = (response.data && response.data.d && response.data.d.results) || [];
		const employee = results.find(
			(emp) => emp.Email && emp.Email.toLowerCase() === String(email).toLowerCase()
		);

		if (!employee) {
			const mockEmp = employees.find((emp) => emp.Email.toLowerCase() === String(email).toLowerCase());
			if (!mockEmp || !mockEmp.IsActive) {
				return res.status(401).json({ success: false, message: "Email khong ton tai hoac tai khoan da bi khoa." });
			}
			return res.json({ success: true, employee: mockEmp });
		}
		if (!employee.IsActive) {
			return res.status(401).json({ success: false, message: "Email khong ton tai hoac tai khoan da bi khoa." });
		}
		return res.json({ success: true, employee });
	} catch (error) {
		const mockEmp = employees.find((emp) => emp.Email.toLowerCase() === String(email).toLowerCase());
		if (mockEmp && mockEmp.IsActive) {
			return res.json({ success: true, employee: mockEmp });
		}
		return res.status(502).json({ success: false, message: "Khong the ket noi toi he thong SAP." });
	}
});

app.get("/api/materials", async (req, res) => {
	if (!process.env.SAP_HOST) {
		return res.json({ success: true, data: materials });
	}
	try {
		const response = await axios.get(
			`${process.env.SAP_HOST}${ODATA_SERVICE_PATH}/MaterialSet`,
			{ params: { "$format": "json" }, auth: sapAuth() }
		);
		return res.json({ success: true, data: (response.data && response.data.d && response.data.d.results) || [] });
	} catch (error) {
		return res.json({ success: true, data: materials, sapError: true });
	}
});

app.get("/api/vendors", async (req, res) => {
	if (!process.env.SAP_HOST) {
		return res.json({ success: true, data: vendors });
	}
	try {
		const response = await axios.get(
			`${process.env.SAP_HOST}${ODATA_SERVICE_PATH}/VendorSet`,
			{ params: { "$format": "json" }, auth: sapAuth() }
		);
		const results = (response.data && response.data.d && response.data.d.results) || [];
		const allVendors = results.map((v) => ({
			...v,
			VendorNo: v.VendorNo || v.Lifnr || v.Vendor || "",
			VendorName: v.VendorName || v.Name1 || v.Name || `Nhà cung cấp ${v.VendorNo || v.Lifnr}`
		}));
		return res.json({ success: true, data: allVendors });
	} catch (error) {
		console.error("❌ VendorSet:", error.message);
		return res.json({ success: true, data: vendors, sapError: true });
	}
});

app.post("/api/ai/recommend-vendor", async (req, res) => {
	const { materialName, materialGroup, quantity, budget, vendors: candidateVendors } = req.body || {};
	if (!process.env.GROQ_API_KEY) {
		return res.status(500).json({ success: false, message: "Thieu GROQ_API_KEY." });
	}
	const vendorList = candidateVendors && candidateVendors.length ? candidateVendors : vendors;
	const prompt = `Ban la chuyen gia mua hang. De xuat NCC cho:
- Vat tu: ${materialName || "N/A"} (nhom: ${materialGroup || "N/A"})
- So luong: ${quantity || "N/A"}
- Ngan sach: ${budget || "N/A"} VND
Danh sach: ${JSON.stringify(vendorList)}
Tra loi ngan gon tieng Viet: ten NCC va ly do.`;

	try {
		const response = await axios.post(
			"https://api.groq.com/openai/v1/chat/completions",
			{ model: "llama-3.3-70b-versatile", messages: [{ role: "user", content: prompt }], temperature: 0.3 },
			{ headers: { Authorization: `Bearer ${process.env.GROQ_API_KEY}`, "Content-Type": "application/json" } }
		);
		return res.json({ success: true, recommendation: response.data.choices[0].message.content });
	} catch (error) {
		return res.status(502).json({ success: false, message: "Khong the goi AI." });
	}
});

function findPurchasingEmails() {
	return employees
		.filter(function (e) {
			return e.IsActive && String(e.Role || "").toUpperCase() === "PURCHASING";
		})
		.map(function (e) { return e.Email; })
		.filter(Boolean);
}

function notifyPurchasing(prId, message) {
	findPurchasingEmails().forEach(function (email) {
		pushNotification(email, prId, message);
	});
}

function notifyCfo(prId, message) {
	employees
		.filter(function (e) {
			return e.IsActive && String(e.Role || "").toUpperCase() === "CFO";
		})
		.forEach(function (e) {
			if (e.Email) { pushNotification(e.Email, prId, message); }
		});
}

app.post("/api/approval/submit", async (req, res) => {
	const { requesterEmail, currency, totalPRValue, items } = req.body || {};

	if (!requesterEmail) {
		return res.status(400).json({ success: false, message: "Thieu thong tin nguoi de nghi." });
	}
	if (!Array.isArray(items) || items.length === 0) {
		return res.status(400).json({ success: false, message: "PR phai co it nhat 1 vat tu." });
	}
	for (var i = 0; i < items.length; i++) {
		var it = items[i];
		if (!it.description) {
			return res.status(400).json({ success: false, message: "Dong " + (i + 1) + ": Thieu mo ta vat tu." });
		}
		if (!it.quantity || Number(it.quantity) <= 0) {
			return res.status(400).json({ success: false, message: "Dong " + (i + 1) + ": So luong khong hop le." });
		}
	}

	const tempPRId = "PR-" + new Date().getFullYear() + "-" + String(nextApprovalSeq).padStart(4, "0");
	nextApprovalSeq += 1;

	const record = {
		PRId: tempPRId,
		InternalId: tempPRId,
		SapPRId: null,
		RequesterEmail: requesterEmail,
		TotalValue: totalPRValue || 0,
		Currency: currency || "VND",
		Status: "PENDING_PURCHASING",
		CreatedAt: new Date().toISOString(),
		items: items.map(function (item, idx) {
			return {
				LineNo: String((idx + 1) * 10).padStart(5, "0"),
				MaterialNo: item.materialNo || (item.isFreeText ? "FREE_TEXT" : ""),
				MaterialType: item.materialType || "ZSRV",
				Description: item.description || "",
				Quantity: Number(item.quantity),
				UoM: item.uom || "PC",
				EstimatedValue: Number(item.estimatedValue) || 0,
				CostCenter: item.costCenter || "",
				InternalOrder: item.internalOrder || "",
				AssetNo: item.assetNo || "",
				GLAccount: item.glAccount || "",
				isFreeText: item.isFreeText || false
			};
		}),
		...buildApprovalFlags(totalPRValue || 0)
	};

	approvalStore.push(record);
	saveApprovals();

	notifyRequester(
		record,
		"Đề nghị " + record.PRId + " đã được gửi, đang chờ Bộ phận mua sắm (Purchasing) xem xét. Số PR SAP sẽ có sau khi phê duyệt cuối."
	);
	notifyPurchasing(
		record.PRId,
		"Có đề nghị mới " + record.PRId + " từ " + requesterEmail
		+ " — giá trị " + Number(record.TotalValue).toLocaleString("vi-VN") + " " + record.Currency
		+ ". Vui lòng xem xét trên màn PR-02."
	);

	return res.status(201).json({
		success: true,
		approval: record,
		sapIntegration: "pending_approval"
	});
});

app.get("/api/approval/pending", (req, res) => {
	const role = String(req.query.role || "").toUpperCase();
	var statusFilter = "PENDING_PURCHASING";
	if (role === "CEO") {
		statusFilter = "PENDING_CEO";
	} else if (role === "CFO") {
		statusFilter = "PENDING_CFO";
	} else if (role === "PURCHASING") {
		statusFilter = "PENDING_PURCHASING";
	}
	const pending = approvalStore.filter((item) => item.Status === statusFilter);
	return res.json({ success: true, data: pending });
});

app.get("/api/approval/approved", (req, res) => {
	const data = approvalStore.filter((item) => {
		const s = String(item.Status || "").toUpperCase();
		return s === "APPROVED" && !item.PoNumber;
	});
	return res.json({ success: true, data });
});

// ============================================================================
// HISTORY theo role — PHẢI đặt TRƯỚC /api/approval/:id
// ============================================================================
app.get("/api/approval/history", (req, res) => {
	const email = String(req.query.email || "").trim().toLowerCase();
	const role = String(req.query.role || "").toUpperCase();

	if (!email) {
		return res.status(400).json({ success: false, message: "Thieu email." });
	}

	function sortNewest(a, b) {
		return new Date(b.UpdatedAt || b.CreatedAt || 0) - new Date(a.UpdatedAt || a.CreatedAt || 0);
	}

	let pending = [];
	let history = [];

	if (role === "REQUESTER") {
		history = approvalStore
			.filter(function (item) {
				return String(item.RequesterEmail || "").toLowerCase() === email;
			})
			.slice()
			.sort(sortNewest);
	} else if (role === "PURCHASING") {
		pending = approvalStore
			.filter(function (item) {
				return String(item.Status || "").toUpperCase() === "PENDING_PURCHASING";
			})
			.slice()
			.sort(sortNewest);

		history = approvalStore
			.filter(function (item) {
				if (item.PurchasingApprovedBy || item.PurchasingAction) { return true; }
				return String(item.DecidedByRole || "").toUpperCase() === "PURCHASING";
			})
			.slice()
			.sort(sortNewest);
	} else if (role === "CFO") {
		pending = approvalStore
			.filter(function (item) {
				return String(item.Status || "").toUpperCase() === "PENDING_CFO";
			})
			.slice()
			.sort(sortNewest);

		history = approvalStore
			.filter(function (item) {
				if (item.CfoProcessedBy || item.CfoAction) { return true; }
				return String(item.DecidedByRole || "").toUpperCase() === "CFO";
			})
			.slice()
			.sort(sortNewest);
	} else if (role === "CEO") {
		pending = approvalStore
			.filter(function (item) {
				return String(item.Status || "").toUpperCase() === "PENDING_CEO";
			})
			.slice()
			.sort(sortNewest);

		history = approvalStore
			.filter(function (item) {
				if (item.CeoProcessedBy || item.CeoAction) { return true; }
				return String(item.DecidedByRole || "").toUpperCase() === "CEO";
			})
			.slice()
			.sort(sortNewest);
	} else {
		history = approvalStore
			.filter(function (item) {
				const s = String(item.Status || "").toUpperCase();
				return s === "APPROVED" || s === "REJECTED" || s === "OPENED" || s === "OPEN";
			})
			.slice()
			.sort(sortNewest);
	}

	return res.json({
		success: true,
		role: role,
		pending: pending,
		history: history
	});
});

app.get("/api/approval/:id", (req, res) => {
	const { id } = req.params;
	const record = approvalStore.find(
		(item) => item.PRId === id || item.InternalId === id || item.SapPRId === id
	);
	if (!record) {
		return res.status(404).json({
			success: false,
			message: "Không tìm thấy đề nghị mua sắm " + id + "."
		});
	}
	return res.json({ success: true, data: record });
});

app.get("/api/notifications", (req, res) => {
	const { email } = req.query;
	if (!email) {
		return res.status(400).json({ success: false, message: "Thieu email." });
	}
	const list = notificationStore
		.filter((n) => n.toEmail.toLowerCase() === String(email).toLowerCase())
		.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
	return res.json({ success: true, data: list });
});

app.patch("/api/notifications/:id/read", (req, res) => {
	const id = Number(req.params.id);
	const n = notificationStore.find((x) => x.id === id);
	if (!n) {
		return res.status(404).json({ success: false, message: "Khong tim thay thong bao." });
	}
	n.read = true;
	saveNotifications();
	return res.json({ success: true });
});

app.patch("/api/approval/:id", async (req, res) => {
	const { id } = req.params;
	const { status, comment, decidedByEmail, decidedByRole } = req.body || {};

	const record = approvalStore.find(
		(item) => item.PRId === id || item.InternalId === id
	);
	if (!record) {
		return res.status(404).json({ success: false, message: "Khong tim thay de nghi mua sam." });
	}

	const sRole = String(decidedByRole || "").toUpperCase();

	if (sRole === "PURCHASING" && record.Status !== "PENDING_PURCHASING") {
		return res.status(400).json({ success: false, message: "Đề nghị này không ở trạng thái chờ Purchasing duyệt." });
	}
	if (sRole === "CFO" && record.Status !== "PENDING_CFO") {
		return res.status(400).json({ success: false, message: "Đề nghị này không ở trạng thái chờ CFO duyệt." });
	}
	if (sRole === "CEO" && record.Status !== "PENDING_CEO") {
		return res.status(400).json({ success: false, message: "Đề nghị này không ở trạng thái chờ CEO duyệt." });
	}
	if (sRole !== "PURCHASING" && sRole !== "CFO" && sRole !== "CEO") {
		return res.status(403).json({ success: false, message: "Role không được phê duyệt." });
	}

	// ── TỪ CHỐI ──────────────────────────────────────────────────────────
	if (status === "REJECTED") {
		record.Status = "REJECTED";
		record.Comment = comment || record.Comment;
		record.DecidedByEmail = decidedByEmail;
		record.DecidedByRole = sRole;
		record.UpdatedAt = new Date().toISOString();

		if (sRole === "PURCHASING") {
			record.PurchasingApprovedBy = decidedByEmail;
			record.PurchasingAction = "REJECTED";
		} else if (sRole === "CFO") {
			record.CfoProcessedBy = decidedByEmail;
			record.CfoAction = "REJECTED";
		} else if (sRole === "CEO") {
			record.CeoProcessedBy = decidedByEmail;
			record.CeoAction = "REJECTED";
		}

		saveApprovals();

		notifyRequester(
			record,
			"Đề nghị " + record.PRId + " đã bị TỪ CHỐI bởi " + sRole + "."
			+ (comment ? " Lý do: " + comment : "")
		);

		return res.json({ success: true, approval: record });
	}

	// ── PHÊ DUYỆT ────────────────────────────────────────────────────────
	if (status === "APPROVED") {
		// 1) Purchasing → CFO
		if (sRole === "PURCHASING") {
			record.Status = "PENDING_CFO";
			record.Comment = comment || record.Comment;
			record.PurchasingApprovedBy = decidedByEmail;
			record.PurchasingAction = "APPROVED";
			record.UpdatedAt = new Date().toISOString();

			saveApprovals();

			notifyRequester(
				record,
				"Đề nghị " + record.PRId + " đã được Bộ phận mua sắm duyệt, đang chờ CFO xem xét."
			);
			notifyCfo(
				record.PRId,
				"PR " + record.PRId + " từ " + record.RequesterEmail
				+ " đã qua Purchasing — chờ CFO duyệt. Giá trị: "
				+ Number(record.TotalValue).toLocaleString("vi-VN") + " " + record.Currency
			);

			return res.json({
				success: true,
				approval: record,
				forwarded: "CFO"
			});
		}

		// 2) CFO + >300tr → CEO
		if (sRole === "CFO" && record.needsProcurementHeadReview) {
			record.Status = "PENDING_CEO";
			record.EscalationReason = "Giá trị vượt 300 triệu VND — cần CEO phê duyệt thêm.";
			record.Comment = comment || record.Comment;
			record.CfoProcessedBy = decidedByEmail;
			record.CfoAction = "ESCALATED";
			record.UpdatedAt = new Date().toISOString();

			saveApprovals();

			notifyRequester(
				record,
				"Đề nghị " + record.PRId + " đã được CFO chuyển lên CEO. Bạn sẽ nhận thông báo khi CEO quyết định."
			);
			notifyCeos(
				record.PRId,
				"PR " + record.PRId + " từ " + record.RequesterEmail
				+ " leo thang lên CEO. " + record.EscalationReason
				+ " Giá trị: " + Number(record.TotalValue).toLocaleString("vi-VN") + " " + record.Currency
			);

			return res.json({
				success: true,
				approval: record,
				escalated: true,
				reason: record.EscalationReason
			});
		}

		// 3) Duyệt cuối: CFO ≤300tr hoặc CEO → SAP
		const sapResult = await createPRInSAP(record);

		if (sapResult.sapIntegration === "failed" || !sapResult.sapPrNumber) {
			return res.status(502).json({
				success: false,
				message: "Không ghi được PR lên SAP: " + (sapResult.sapErrorMessage || "không có PRNumber"),
				sapErrorMessage: sapResult.sapErrorMessage
			});
		}

		const oldId = record.PRId;
		record.InternalId = record.InternalId || oldId;
		record.SapPRId = sapResult.sapPrNumber;
		record.PRId = sapResult.sapPrNumber;
		record.Status = "APPROVED";
		record.Comment = comment || record.Comment;
		record.DecidedByEmail = decidedByEmail;
		record.DecidedByRole = sRole;
		record.UpdatedAt = new Date().toISOString();

		if (sRole === "CFO") {
			record.CfoProcessedBy = decidedByEmail;
			record.CfoAction = "APPROVED";
		} else if (sRole === "CEO") {
			record.CeoProcessedBy = decidedByEmail;
			record.CeoAction = "APPROVED";
		}

		saveApprovals();

		notifyRequester(
			record,
			"Đề nghị " + oldId + " đã được PHÊ DUYỆT bởi " + sRole
			+ ". Số PR trên SAP: " + record.SapPRId + " (ME53N)."
		);

		return res.json({
			success: true,
			approval: record,
			sapIntegration: "created",
			sapPrNumber: sapResult.sapPrNumber
		});
	}

	return res.status(400).json({ success: false, message: "Status không hợp lệ (chỉ nhận APPROVED/REJECTED)." });
});
// 🎯 Lấy SỐ DÒNG (ItemNo) THẬT của PR trực tiếp từ SAP OData — không đoán, không hardcode.

async function fetchPRItemsFromSAP(prNumber) {
	if (!process.env.SAP_HOST || !prNumber) { return []; }

	const candidateFilterFields = ["PRNumber", "PrNumber", "PRId", "ReqNo"];

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
			const results = (response.data && response.data.d && response.data.d.results) || [];
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

// gửi mail Vendor
async function sendPOEmailToVendor(vendorEmail, poNumber, data) {

	if (!vendorEmail) {
		return false;
	}

	const rows = (data.items || []).map(function (item) {
		return `
        <tr>
            <td>${item.materialNo || ""}</td>
            <td>${item.description || ""}</td>
            <td>${item.quantity || ""}</td>
            <td>${item.uom || ""}</td>
            <td>${Number(item.netPrice || 0).toLocaleString("vi-VN")}</td>
        </tr>`;
	}).join("");

	const html = `
        <h2>Purchase Order Notification</h2>

        <p>Dear Vendor,</p>

        <p>
            A new Purchase Order has been created.
        </p>

        <table border="1" cellpadding="6" cellspacing="0">
            <tr>
                <td><b>PO Number</b></td>
                <td>${poNumber}</td>
            </tr>

            <tr>
                <td><b>Company Code</b></td>
                <td>${data.companyCode}</td>
            </tr>

            <tr>
                <td><b>Document Date</b></td>
                <td>${data.docDate}</td>
            </tr>

            <tr>
                <td><b>Currency</b></td>
                <td>${data.currency}</td>
            </tr>
        </table>

        <br>

        <table border="1" cellpadding="6" cellspacing="0">
            <tr>
                <th>Material</th>
                <th>Description</th>
                <th>Quantity</th>
                <th>UoM</th>
                <th>Net Price</th>
            </tr>

            ${rows}

        </table>

        <br>

        <p>
            Please review the Purchase Order and prepare the requested goods.
        </p>

        <br>

        <p>Regards,</p>

        <p>Purchasing Department</p>
    `;

	await transporter.sendMail({

		from: process.env.EMAIL_USER,

		to: vendorEmail,

		subject: `Purchase Order ${poNumber}`,

		html

	});

	return true;
}
// ── API TẠO PURCHASE ORDER TRÊN SAP GATEWAY ODATA ──
app.post("/api/po/create", async (req, res) => {
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

	// Trường hợp chạy MOCK
	if (!process.env.SAP_HOST) {
		const mockPoNum = `PO-${new Date().getFullYear()}-${Math.floor(Math.random() * 90000) + 10000}`;

		const isMailSent = false;
		return res.status(201).json({
			success: true,
			sapIntegration: "mock",
			poNumber: mockPoNum,
			emailSent: isMailSent,
			po: {
				PoNumber: mockPoNum,
				VendorNo: vendorNo,
				TotalValue: totalValue,
				Currency: currency || "VND",
				Status: "CREATED",
				Items: items
			}
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

		const sapPayload = {
			CompanyCode: companyCode || "1000",
			DocType: docType || "NB",
			VendorNo: formattedVendor,
			PurchOrg: purchOrg || "1000",
			PurchGroup: purchGroup || "001",
			Currency: currency || "VND",
			DocDate: docDate || new Date().toISOString().split('T')[0],
			TotalValue: totalValue.toFixed(2),
			POToItems: {
				results: items.map((item, idx) => {
					var rawMat = String(item.materialNo || "").trim();
					var formattedMat = (/^\d+$/.test(rawMat)) ? rawMat.padStart(18, "0") : rawMat;

					var rawPreqNo = String(item.preqNo || prNumber || "").trim();
					var formattedPreqNo = /^\d+$/.test(rawPreqNo) ? rawPreqNo.padStart(10, "0") : rawPreqNo;
					var formattedPreqItem = String(item.preqItem || "00010").padStart(5, "0");

					return {
						PoNumber: "",
						ItemNo: String((idx + 1) * 10).padStart(5, "0"),
						PreqNo: formattedPreqNo,
						PreqItem: formattedPreqItem,
						MaterialNo: formattedMat.substring(0, 40),
						Description: String(item.description || "").substring(0, 40),
						Quantity: Number(item.quantity || 1).toFixed(3),
						UoM: String(item.uom || "PC").substring(0, 3),
						NetPrice: Number(item.netPrice || 0).toFixed(2),
						CostCenter: String(item.costCenter || "CCADM").substring(0, 10),
						Plant: item.plant || "1000"
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

		const approval = approvalStore.find(
			x => x.SapPRId === prNumber || x.PRId === prNumber
		);

		if (approval) {
			approval.Status = "PO_CREATED";
			approval.PoNumber = realPoNum;
			approval.PoCreatedAt = new Date().toISOString();

			saveApprovals();
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

		return res.status(502).json({
			success: false,
			message:
				error.response?.data?.error?.message?.value ||
				error.message
		});
	}
});
// ============================================================================
// API BÁO CÁO TIẾN ĐỘ PO (REPORT) — MERGE TIMELINE & PHÂN QUYỀN VAI TRÒ (ROLE)
// ============================================================================
app.get("/api/po/report", async (req, res) => {
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
		// 2. Merge (trộn) dữ liệu mốc thời gian duyệt PR từ approvalStore ở Node.js vào PO từ SAP
		results = results.map((po) => {
			// Tra cứu PR tương ứng trong approvalStore dựa trên SapPRId hoặc PreqNo
			const matchedPR = approvalStore.find(
				(pr) => pr.SapPRId === po.PoNumber || pr.PRId === po.PreqNo || pr.InternalId === po.PreqNo
			);

			return {
				...po,
				// Gán thông tin người tạo PR
				RequesterEmail: matchedPR ? matchedPR.RequesterEmail : (po.RequesterEmail || "requester@qdavy.com"),

				// Gán các mốc thời gian (Dates) cho Timeline 6 bước
				PrDate: matchedPR ? matchedPR.CreatedAt?.split("T")[0] : po.DocDate,
				LeadDate: matchedPR?.PurchasingApprovedAt ? matchedPR.PurchasingApprovedAt.split("T")[0] : null,
				CfoDate: matchedPR?.CfoProcessedAt ? matchedPR.CfoProcessedAt.split("T")[0] : null,
				CeoDate: matchedPR?.CeoProcessedAt ? matchedPR.CeoProcessedAt.split("T")[0] : null,
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

// ============================================================================
// API BÁO CÁO TIẾN ĐỘ PO (REPORT) — MERGE TIMELINE & PHÂN QUYỀN VAI TRÒ (ROLE)
// ============================================================================
app.get("/api/po/report", async (req, res) => {
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

		// 2. Merge (trộn) dữ liệu mốc thời gian duyệt PR từ approvalStore ở Node.js vào PO từ SAP
		results = results.map((po) => {
			// Tra cứu PR tương ứng trong approvalStore dựa trên SapPRId hoặc PreqNo
			const matchedPR = approvalStore.find(
				(pr) => pr.SapPRId === po.PoNumber || pr.PRId === po.PreqNo || pr.InternalId === po.PreqNo
			);

			return {
				...po,
				// Gán thông tin người tạo PR
				RequesterEmail: matchedPR ? matchedPR.RequesterEmail : (po.RequesterEmail || "requester@qdavy.com"),

				// Gán các mốc thời gian (Dates) cho Timeline 6 bước
				PrDate: matchedPR ? matchedPR.CreatedAt?.split("T")[0] : po.DocDate,
				LeadDate: matchedPR?.PurchasingApprovedAt ? matchedPR.PurchasingApprovedAt.split("T")[0] : null,
				CfoDate: matchedPR?.CfoProcessedAt ? matchedPR.CfoProcessedAt.split("T")[0] : null,
				CeoDate: matchedPR?.CeoProcessedAt ? matchedPR.CeoProcessedAt.split("T")[0] : null,
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

//Material create
app.post("/api/material-master/create", async function (req, res) {
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
		const message = getSapBusinessError(error);
		console.error("[material-master/create] THAT BAI:", message);
		return res.status(502).json({
			success: false,
			message: "Không tạo được danh mục trên SAP: " + message,
			sapError: true
		});
	}
});
if (require.main === module) {
	app.listen(PORT, () => {
		console.log(`QDAVY Procurement API: http://localhost:${PORT}`);
		console.log(process.env.SAP_HOST
			? `OData: ${process.env.SAP_HOST}${ODATA_SERVICE_PATH}`
			: "Che do: mock (SAP_HOST chua cau hinh)");
		console.log("[DATA] Folder:", DATA_DIR);
	});
}

module.exports = app;