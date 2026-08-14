require("dotenv").config();

// nodemailer chỉ dùng cho tính năng phụ (gửi PO cho vendor qua email).
// Lazy-load + try/catch để nếu module thiếu/lỗi trên môi trường deploy
// (VD Vercel không bundle đúng nodemailer) thì CHỈ tính năng gửi mail bị
// tắt, không kéo sập toàn bộ server (login, PR, PO... vẫn chạy bình thường).
let _mailTransporter;
let _mailInitTried = false;
function getMailTransporter() {
	if (_mailInitTried) { return _mailTransporter; }
	_mailInitTried = true;
	try {
		const nodemailer = require("nodemailer");
		_mailTransporter = nodemailer.createTransport({
			service: "gmail",
			auth: {
				user: process.env.EMAIL_USER,
				pass: process.env.EMAIL_PASS
			}
		});
	} catch (e) {
		console.error("⚠️ Khong khoi tao duoc nodemailer (tinh nang gui email se bi tat):", e.message);
		_mailTransporter = null;
	}
	return _mailTransporter;
}
const express = require("express");
const cors = require("cors");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const os = require("os");

const app = express();
const PORT = process.env.PORT || 3001;
app.use(cors());
app.use(express.json());

app.get("/api/health", (req, res) => res.json({ ok: true }));
app.use(express.static(path.join(__dirname, "webapp")));

const ODATA_SERVICE_PATH = "/sap/opu/odata/sap/ZG1_PROC_SRV_SRV";

// ============================================================================
// ORG DATA THAT — cau hinh SPRO cua he thong (xem MASTER_DATA_SAP490_G1.md).
// Truoc day cac gia tri nay bi de fallback "1000"/"001" rai rac trong
// /api/po/create. Voi PR thi vo hai (ABAP create_pr_deep tu hardcode QDPL/QD1
// va header PR khong co comp_code), NHUNG voi PO thi ABAP doc thang
// comp_code/purch_org/pur_group tu deep entity gui len -> sai org that su.
// Gom ve 1 cho de FE va BE dung chung, khong lap so ma nua.
// ============================================================================
// purchGroup = "QD1" (mo ta "QDAVY PG") — da xac minh truc tiep tren OME4 ngay 11/08.
// MASTER_DATA_SAP490_G1.md ghi "QDG" la SAI; ABAP hardcode 'QD1' moi dung. Dung sua nguoc lai.
const ORG_DEFAULTS = {
	companyCode: "QD01",
	purchOrg: "QDPO",
	purchGroup: "QD1",
	plant: "QDPL",
	storageLocation: "QDSL",
	currency: "VND"
};

// Chỉ cảnh báo “giá trị lớn” — KHÔNG dùng để leo CEO
const LEGAL_ESCALATION_THRESHOLD = 100000000;

/**
 * Danh muc dieu khoan thanh toan dung chung cho RFQ-02.
 * Truoc day o nhap tu do nen moi nguoi go moi kieu ("net5", "NET30", "50/50"...),
 * nguoi doc bang so sanh khong hieu va AI cung kho danh gia. Nay chot 1 danh muc:
 * `code` luu vao ZG1_QUOTATION.PAYMENT_TERMS, `label` hien tren giao dien,
 * `days` de AI biet so ngay duoc no thuc te (cang lon cang loi cho dong tien).
 *
 * LUU Y: day KHONG phai key cua bang T052 cua SAP. Gia tri nay chi song trong bang Z
 * cua nhom, khong duoc ghi vao EKKO-ZTERM cua PO that. Muon dong bo voi SAP thi phai
 * map sang key T052 hop le truoc — xem ghi chu trong /api/po/create.
 */
const PAYMENT_TERMS = [
	{ code: "IMMEDIATE", label: "Trả ngay khi nhận hàng", days: 0 },
	{ code: "ADVANCE50", label: "Trả trước 50%, còn lại khi giao", days: 0 },
	{ code: "NET15", label: "Trả trong 15 ngày (NET15)", days: 15 },
	{ code: "NET30", label: "Trả trong 30 ngày (NET30)", days: 30 },
	{ code: "NET45", label: "Trả trong 45 ngày (NET45)", days: 45 },
	{ code: "NET60", label: "Trả trong 60 ngày (NET60)", days: 60 },
	{ code: "AFTER_ACCEPT", label: "Trả sau khi nghiệm thu", days: 30 }
];

/**
 * Doi ma dieu khoan thanh toan sang chuoi nguoi/AI doc hieu.
 * Bao gia cu nhap tay ("net5", "net10") khong khop danh muc thi tra ve nguyen van
 * de khong lam mat du lieu lich su.
 */
function describePaymentTerms(code) {
	const raw = String(code || "").trim();
	if (!raw) { return "Không nêu"; }
	const found = PAYMENT_TERMS.find((t) => t.code.toUpperCase() === raw.toUpperCase());
	return found ? found.label : raw;
}

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
const NOTIF_FILE = path.join(DATA_DIR, "notifications.json");
const THRESHOLD_FILE = path.join(DATA_DIR, "thresholds.json");

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

function loadThresholds() {
	ensureDataDir();
	if (!fs.existsSync(THRESHOLD_FILE)) {
		return { byIO: {} };
	}
	try {
		const raw = JSON.parse(fs.readFileSync(THRESHOLD_FILE, "utf8"));
		return { byIO: raw.byIO && typeof raw.byIO === "object" ? raw.byIO : {} };
	} catch (e) {
		console.error("⚠️ Load thresholds THAT BAI:", e.message);
		return { byIO: {} };
	}
}

function saveThresholds() {
	ensureDataDir();
	fs.writeFileSync(THRESHOLD_FILE, JSON.stringify(thresholdStore, null, 2), "utf8");
}

function normalizeOrderNo(orderNo) {
	orderNo = String(orderNo || "").trim();
	if (!orderNo) { return ""; }
	var s = orderNo.replace(/^0+/, "");
	return s || "0";
}

/** null = IO chưa cấu hình ngưỡng → không leo CEO */
function getThresholdForIO(internalOrder) {
	const key = normalizeOrderNo(internalOrder);
	if (!key) { return null; }
	if (thresholdStore.byIO[key] == null || thresholdStore.byIO[key] === "") {
		return null;
	}
	return Number(thresholdStore.byIO[key]);
}

/**
 * Leo CEO khi total > ngưỡng của ít nhất 1 IO đã cấu hình.
 * Không còn số 300tr cố định.
 */
function buildApprovalFlags(totalValue, items) {
	const total = Number(totalValue) || 0;
	let needCeo = false;
	let hitThreshold = null;
	let hitIO = null;

	(items || []).forEach(function (it) {
		const io = it.internalOrder || it.InternalOrder || "";
		const t = getThresholdForIO(io);
		if (t != null && total > t) {
			needCeo = true;
			if (hitThreshold == null || t < hitThreshold) {
				hitThreshold = t;
				hitIO = normalizeOrderNo(io);
			}
		}
	});

	return {
		needsProcurementHeadReview: needCeo,
		needsLegalReview: total > LEGAL_ESCALATION_THRESHOLD,
		ioThreshold: hitThreshold,
		escalationIO: hitIO
	};
}

const _loadedNotifs = loadNotifications();
const notificationStore = _loadedNotifs.items;
let nextNotificationId = _loadedNotifs.nextId;

const thresholdStore = loadThresholds();

console.log("[DATA] Loaded notif:", notificationStore.length);
console.log("[DATA] IO thresholds:", Object.keys(thresholdStore.byIO).length);

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

function sapAuth() {
	return {
		username: process.env.SAP_USER,
		password: process.env.SAP_PASS
	};
}

async function fetchAllEmployeesFromSAP() {
	if (!process.env.SAP_HOST) { return []; }
	try {
		const response = await axios.get(
			`${process.env.SAP_HOST}${ODATA_SERVICE_PATH}/EmployeeSet`,
			{ params: { "$format": "json" }, auth: sapAuth() }
		);
		return (response.data && response.data.d && response.data.d.results) || [];
	} catch (error) {
		console.error("[fetchAllEmployeesFromSAP] Khong lay duoc danh sach nhan vien tu SAP:", error.message);
		return [];
	}
}

async function findEmailsByRole(role) {
	const list = await fetchAllEmployeesFromSAP();
	return list
		.filter(function (e) {
			return e.IsActive && String(e.Role || "").toUpperCase() === String(role).toUpperCase();
		})
		.map(function (e) { return e.Email; })
		.filter(Boolean);
}

function notifyRequester(record, message) {
	pushNotification(record.RequesterEmail, record.PRId, message);
}

async function notifyCeos(prId, message) {
	const emails = await findEmailsByRole("CEO");
	emails.forEach(function (email) {
		pushNotification(email, prId, message);
	});
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

	const internalOrders = Object.keys(ioMap).sort().map(function (k) { return ioMap[k]; });
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

// ============================================================================
// MATERIAL MASTER (MM01) — man "Tao vat tu/dich vu" cua nhanh An (PR #11), bi
// git merge lam mat toan bo khi merge vao main 13/08 (merge bao "khong loi"
// nhung thuc te xoa sach code cua nhanh An o nhieu file — loi mount, khong
// phai loi cua An). Khoi phuc thu cong tu origin/An, giu nguyen logic goc.
// ============================================================================
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

// --- Ngưỡng theo Internal Order ---
app.get("/api/thresholds", (req, res) => {
	return res.json({ success: true, byIO: thresholdStore.byIO });
});

app.put("/api/thresholds", (req, res) => {
	const body = req.body || {};

	if (body.internalOrder != null) {
		const key = normalizeOrderNo(body.internalOrder);
		if (!key) {
			return res.status(400).json({ success: false, message: "Internal Order khong hop le." });
		}
		if (body.threshold == null || body.threshold === "") {
			delete thresholdStore.byIO[key];
		} else {
			thresholdStore.byIO[key] = Number(body.threshold);
		}
	}

	if (body.byIO && typeof body.byIO === "object") {
		Object.keys(body.byIO).forEach(function (io) {
			const key = normalizeOrderNo(io);
			if (!key) { return; }
			if (body.byIO[io] == null || body.byIO[io] === "") {
				delete thresholdStore.byIO[key];
			} else {
				thresholdStore.byIO[key] = Number(body.byIO[io]);
			}
		});
	}

	saveThresholds();
	return res.json({ success: true, byIO: thresholdStore.byIO });
});

/**
 * Tai khoan so cai mac dinh cho account assignment K (Cost Center) va F (Internal Order).
 *
 * Gia tri cu ("211100" cho ZAST, "641000" cho con lai) la so bia theo chart of accounts
 * kieu IDES, KHONG ton tai trong chart of accounts that cua nhom la QCOA -> BAPI_PR_CREATE
 * bao "Account 641000 does not exist in chart of accounts QCOA" va PR khong ghi duoc len SAP.
 *
 * QCOA (kiem tra SE16N bang SKA1, KTOPL='QCOA') chi co dung 7 tai khoan:
 *   610001, 610002, 610003, 611111, 650001, 650003  -> deu la tai khoan bang can doi (XBILK='X')
 *   650002                                          -> tai khoan P&L DUY NHAT
 * Cat.K/F bat buoc hach toan vao tai khoan chi phi P&L nen 650002 la lua chon duy nhat.
 *
 * Cat.A (tai san) KHONG di qua day: xem mapClientItemToSapDeep/createPRInSAP, ca hai deu
 * gui GLAccount rong cho Cat.A de SAP tu suy tu Asset Master. Do la ly do 2 PR tai san dau
 * tien ghi len SAP thanh cong trong khi PR Cat.K that bai.
 */
function defaultGLAccount(materialType) {
	var GL_MAP = { ZAST: "", ZSRV: "650002", ZROH: "650002" };
	return GL_MAP[materialType] != null ? GL_MAP[materialType] : "650002";
}

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

// ============================================================================
// HELPER SAP OData DUNG CHUNG CHO CAC ROUTE RFQ (RfqSet / QuotationSet)
// Tai su dung dung pattern CSRF token da dung trong createPRInSAP() o tren.
// ============================================================================

/** Escape dau nhay don trong gia tri key OData (vd RfqSet('...')) de tranh loi cu phap. */
function odataEscape(v) {
	return String(v == null ? "" : v).replace(/'/g, "''");
}

/**
 * 5 field ngay gio cua RFQ/Quotation (CreatedAt, SentAt, Deadline, AwardedAt, EnteredAt)
 * la Edm.String 14 ky tu YYYYMMDDHHMMSS, KHONG phai Edm.DateTime — xem CLAUDE.md.
 */
function sapTimestamp(date) {
	const d = date || new Date();
	const p = (n) => String(n).padStart(2, "0");
	return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** Field Deadline la DATS 8 ky tu YYYYMMDD (khac 14 ky tu cua 4 field TIMESTAMP con lai). */
function sapDateOnly(date) {
	const d = date || new Date();
	const p = (n) => String(n).padStart(2, "0");
	return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
}

/** Chuan hoa deadline FE gui len (vd "2026-08-20" hoac da la "20260820") ve 8 ky tu, hoac "" neu khong hop le. */
function normalizeSapDeadline(input) {
	if (!input) { return ""; }
	const digits = String(input).replace(/-/g, "").slice(0, 8);
	return /^\d{8}$/.test(digits) ? digits : "";
}

async function sapFetchCsrfToken() {
	const tokenResponse = await axios.get(
		`${process.env.SAP_HOST}${ODATA_SERVICE_PATH}`,
		{ auth: sapAuth(), headers: { "X-CSRF-Token": "Fetch", "sap-language": "EN" } }
	);
	return {
		csrfToken: tokenResponse.headers["x-csrf-token"],
		cookies: tokenResponse.headers["set-cookie"]
	};
}

/** POST/MERGE vao 1 entity path (vd "RfqSet" hoac "RfqSet('RFQ-2026-0001')"). Truyen session de tai su dung 1 CSRF token cho nhieu lan ghi lien tiep. */
async function sapWrite(method, entityPath, data, session) {
	const s = session || await sapFetchCsrfToken();
	return axios({
		method,
		url: `${process.env.SAP_HOST}${ODATA_SERVICE_PATH}/${entityPath}`,
		data,
		auth: sapAuth(),
		headers: {
			"Content-Type": "application/json",
			"X-CSRF-Token": s.csrfToken,
			"Cookie": s.cookies ? s.cookies.join("; ") : "",
			"sap-language": "EN"
		}
	});
}

/** GET 1 entity path (vd "RfqSet('RFQ-2026-0001')/RfqToQuotations"). */
async function sapRead(entityPath) {
	return axios.get(
		`${process.env.SAP_HOST}${ODATA_SERVICE_PATH}/${entityPath}`,
		{ params: { "$format": "json" }, auth: sapAuth(), timeout: 20000 }
	);
}

// ============================================================================
// PrDraftSet / PrDraftItemSet — thay the hoan toan approvalStore/approvals.json.
// PR "nhap" (draft, chua sang SAP that) gio luu qua OData service ZG1_PROC_SRV_SRV
// (bang ZPR_DRAFT / ZPR_DRAFT_ITEM). Xem CLAUDE.md muc SEGW PrDraftSet.
//
// Field cua SAP entity PrDraft trung ten voi field cu tren approvalStore o HAU HET
// truong hop (PRId, InternalId, SapPRId, RequesterEmail, TotalValue, Currency,
// Status, Comment, DecidedByEmail/Role, PurchasingApprovedBy/Action/At,
// CfoProcessedBy/Action/At, CeoProcessedBy/Action/At, EscalationReason, RfqId,
// RfqAwardedVendor, RfqFinalValue, EstimatedTotalValue). Chi 4 cho khac phai
// chuyen doi 2 chieu khi doc/ghi:
//   1) CreatedAt/UpdatedAt: SAP tra ve chuoi 14 ky tu YYYYMMDDHHMMSS (Edm.String),
//      khong phai ISO — cac formatter tren FE (formatViTime, formatDate...) dung
//      `new Date(sIso)` nen bat buoc doi sang ISO khi tra ve FE.
//   2) NeedsProcurementHeadReview / NeedsLegalReview / IsFreeText: SAP la co "X"/"",
//      FE/Node dung boolean true/false (needsProcurementHeadReview, isFreeText).
//   3) IoThreshold: SAP Edm.Decimal mac dinh "0.00" (khong null) khi khong co
//      escalation — FE chi hien thi field nay khi needsProcurementHeadReview=true
//      nen khong can ep ve null rieng.
//   4) PRId: truoc day Node tu sinh "PR-<nam>-<seq>"; gio la InternalId SNRO
//      10 chu so do ABAP CREATE_DEEP_ENTITY sinh ra — FE chi dung PRId nhu chuoi
//      opaque (khong parse dinh dang) nen an toan.
// ============================================================================

/** SAP tra ve "X"/"" cho field boolean-like — chuyen ve true/false cho Node/FE. */
function sapXToBool(x) {
	return x === "X" || x === true;
}

/** Nguoc lai: boolean Node/FE -> "X"/"" cho SAP. */
function boolToSapX(b) {
	return b ? "X" : "";
}

/** Chuoi 14 ky tu YYYYMMDDHHMMSS cua SAP -> ISO 8601 (de FE dung duoc new Date()). */
function sapTsToIso(ts) {
	const s = String(ts || "").trim();
	if (!/^\d{14}$/.test(s)) { return s || null; }
	const iso = `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}T${s.slice(8, 10)}:${s.slice(10, 12)}:${s.slice(12, 14)}.000Z`;
	const d = new Date(iso);
	return isNaN(d.getTime()) ? null : iso;
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
	const sCat = sMaterialType === "ZAST" ? "A" : (item.AcctAssignCat === "F" ? "F" : "K");
	return {
		MaterialNo: item.isFreeText ? "" : (item.MaterialNo || ""),
		MaterialType: sMaterialType,
		Description: item.Description || "",
		Quantity: String(item.Quantity || 0),
		UoM: item.UoM || "PC",
		EstimatedValue: String(item.EstimatedValue || 0),
		AcctAssignCat: sCat,
		CostCenter: sCat === "K" ? (item.CostCenter || "") : "",
		InternalOrder: sCat === "F" ? (item.InternalOrder || "") : "",
		AssetNo: sCat === "A" ? (item.AssetNo || "") : "",
		GLAccount: sCat === "A" ? "" : defaultGLAccount(sMaterialType),
		IsFreeText: boolToSapX(item.isFreeText)
	};
}

/** 1 entity PrDraft (SAP, da $expand=PrDraftToItems) -> shape cu approvalStore ma FE dang doc. */
function mapSapPrToClient(sap) {
	const items = ((sap.PrDraftToItems && sap.PrDraftToItems.results) || []).map(mapSapItemToClient);
	return {
		PRId: sap.PRId || sap.InternalId,
		InternalId: sap.InternalId,
		SapPRId: sap.SapPRId || null,
		RequesterEmail: sap.RequesterEmail || "",
		TotalValue: Number(sap.TotalValue) || 0,
		Currency: sap.Currency || "VND",
		Status: sap.Status || "",
		CreatedAt: sapTsToIso(sap.CreatedAt),
		UpdatedAt: sapTsToIso(sap.UpdatedAt),
		items: items,
		Comment: sap.Comment || "",
		DecidedByEmail: sap.DecidedByEmail || "",
		DecidedByRole: sap.DecidedByRole || "",
		PurchasingApprovedBy: sap.PurchasingApprovedBy || "",
		PurchasingAction: sap.PurchasingAction || "",
		PurchasingAt: sapTsToIso(sap.PurchasingAt),
		CfoProcessedBy: sap.CfoProcessedBy || "",
		CfoAction: sap.CfoAction || "",
		CfoAt: sapTsToIso(sap.CfoAt),
		CeoProcessedBy: sap.CeoProcessedBy || "",
		CeoAction: sap.CeoAction || "",
		CeoAt: sapTsToIso(sap.CeoAt),
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

/** Rut gon message loi tu SAP OData (hoac API ngoai nhu Anthropic) de tra ve FE, khong nuot loi. */
function extractSapErrorMessage(error) {
	const errorDetails = error.response?.data?.error?.innererror?.errordetails;
	if (Array.isArray(errorDetails)) {
		const realErrors = errorDetails
			.filter((d) => d.severity === "error" && d.code !== "/IWBEP/CX_MGW_BUSI_EXCEPTION")
			.map((d) => d.message);
		if (realErrors.length) { return realErrors.join("; "); }
	}
	const odataMsg = error.response?.data?.error?.message?.value;
	if (odataMsg) { return odataMsg; }
	const rawMsg = error.response?.data?.error?.message;
	if (typeof rawMsg === "string" && rawMsg) { return rawMsg; }
	if (error.response) {
		return `HTTP ${error.response.status}: ${JSON.stringify(error.response.data).slice(0, 300)}`;
	}
	return error.message;
}

/** Lay toan bo NCC tu SAP VendorSet (dung chung cho /api/vendors va cac route RFQ). */
async function fetchAllVendorsFromSAP() {
	if (!process.env.SAP_HOST) { return []; }
	// timeout bat buoc: ham nay gio nam tren duong di cua /api/approval/pending
	// (qua enrichWithRfqAward), SAP treo ma khong co timeout la treo ca man phe duyet.
	const response = await axios.get(
		`${process.env.SAP_HOST}${ODATA_SERVICE_PATH}/VendorSet`,
		{ params: { "$format": "json" }, auth: sapAuth(), timeout: 20000 }
	);
	const results = (response.data && response.data.d && response.data.d.results) || [];
	return results.map((v) => ({
		...v,
		VendorNo: v.VendorNo || v.Lifnr || v.Vendor || "",
		VendorName: v.VendorName || v.Name1 || v.Name || `Nhà cung cấp ${v.VendorNo || v.Lifnr}`
	}));
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
	const needEnrich = prList.filter((pr) => pr.RfqId);
	if (needEnrich.length === 0) { return prList; }

	let vendorMap = {};
	try {
		const vendors = await fetchAllVendorsFromSAP();
		vendors.forEach(function (v) { vendorMap[String(v.VendorNo)] = v.VendorName; });
	} catch (error) {
		console.error("[enrichWithRfqAward] Doc VendorSet that bai:", extractSapErrorMessage(error));
	}

	await Promise.all(needEnrich.map(async function (pr) {
		pr.RfqAwardedVendorName = vendorMap[String(pr.RfqAwardedVendor)] || "";
		try {
			const resp = await sapRead(`RfqSet('${odataEscape(pr.RfqId)}')`);
			const rfq = resp.data && resp.data.d;
			if (rfq) {
				pr.RfqAwardReason = rfq.AwardReason || "";
				pr.RfqAwardedBy = rfq.AwardedBy || "";
				pr.RfqAwardedAt = rfq.AwardedAt || "";
				pr.RfqStatus = rfq.Status || "";
			}
		} catch (error) {
			console.error(`[enrichWithRfqAward] Doc RFQ ${pr.RfqId} that bai:`, extractSapErrorMessage(error));
		}
	}));

	return prList;
}

/**
 * Tra cuu 1 nhan vien active theo email trong SAP EmployeeSet.
 * Dung chung cho ca 2 duong dang nhap (email-only cu va Google moi) de
 * khong lap code va de sau nay chi sua 1 cho neu doi cach query SAP.
 */
async function findActiveEmployeeByEmail(email) {
	const response = await axios.get(
		`${process.env.SAP_HOST}${ODATA_SERVICE_PATH}/EmployeeSet`,
		{
			params: { "$filter": `Email eq '${email}'`, "$format": "json" },
			auth: sapAuth(),
			timeout: 8000
		}
	);
	const results = (response.data && response.data.d && response.data.d.results) || [];
	return results.find(
		(emp) => emp.Email && emp.Email.toLowerCase() === String(email).toLowerCase()
	);
}

// Cho frontend biet co the hien nut "Dang nhap voi Google" hay khong,
// va lay dung Client ID (khong bi coi la bi mat, an toan de tra ve public).
app.get("/api/config", (req, res) => {
	// orgDefaults: de PO-01 tu dien san Company Code / Purch Org / Purch Group
	// thay vi bat nguoi dung go tay moi lan (ban ghi PR khong he luu cac field nay).
	// paymentTerms: de RFQ-02 dung chung 1 danh muc voi backend/AI, khong hardcode
	// lai o view (tranh lech ma giua noi luu va noi hien thi).
	res.json({
		googleClientId: process.env.GOOGLE_CLIENT_ID || null,
		orgDefaults: ORG_DEFAULTS,
		paymentTerms: PAYMENT_TERMS
	});
});

/**
 * ⚠️ DANG NHAP CHI BANG EMAIL — KHONG CO YEU TO XAC THUC NAO.
 * Ai go dung 1 email dang active trong SAP la vao duoc, du khong phai chu
 * email do. Giu lai de test/dev khi chua cau hinh Google OAuth, nhung VE
 * BAN CHAT KHONG AN TOAN. Khi da co GOOGLE_CLIENT_ID, nen uu tien dung
 * /api/login/google va can nhac tat han duong nay o production.
 */
app.post("/api/login", async (req, res) => {
	const { email } = req.body || {};
	if (!email) {
		return res.status(400).json({ success: false, message: "Thieu email." });
	}

	if (!process.env.SAP_HOST) {
		return res.status(503).json({ success: false, message: "He thong SAP chua duoc cau hinh (thieu SAP_HOST)." });
	}

	try {
		const employee = await findActiveEmployeeByEmail(email);
		if (!employee || !employee.IsActive) {
			return res.status(401).json({ success: false, message: "Email khong ton tai hoac tai khoan da bi khoa." });
		}
		return res.json({ success: true, employee });
	} catch (error) {
		console.error("❌ [login] Loi ket noi SAP:", error.message);
		return res.status(502).json({ success: false, message: "Khong the ket noi toi he thong SAP." });
	}
});

/**
 * Dang nhap qua Google (khuyen nghi dung thay /api/login).
 * Google da xac minh danh tinh nguoi dung (mat khau + 2FA phia Google) va
 * ky so ID token — server chi can xac minh chu ky/audience qua endpoint
 * chinh thuc cua Google (khong them thu vien moi, tranh lap loi bundling
 * nhu tung gap voi nodemailer tren Vercel), sau do doi chieu email voi SAP.
 */
app.post("/api/login/google", async (req, res) => {
	const { credential } = req.body || {};
	if (!credential) {
		return res.status(400).json({ success: false, message: "Thieu Google ID token." });
	}
	if (!process.env.GOOGLE_CLIENT_ID) {
		return res.status(503).json({ success: false, message: "Dang nhap Google chua duoc cau hinh (thieu GOOGLE_CLIENT_ID)." });
	}

	let payload;
	try {
		const verifyResp = await axios.get(
			"https://oauth2.googleapis.com/tokeninfo",
			{ params: { id_token: credential }, timeout: 8000 }
		);
		payload = verifyResp.data;
	} catch (error) {
		console.error("❌ [login/google] Token khong hop le/het han:", error.message);
		return res.status(401).json({ success: false, message: "Phien dang nhap Google khong hop le hoac da het han, vui long thu lai." });
	}

	if (payload.aud !== process.env.GOOGLE_CLIENT_ID) {
		console.error("❌ [login/google] Sai audience — token khong phai cap cho app nay.");
		return res.status(401).json({ success: false, message: "Token khong hop le." });
	}
	if (payload.email_verified !== "true" && payload.email_verified !== true) {
		return res.status(401).json({ success: false, message: "Email Google chua duoc xac minh." });
	}

	const email = payload.email;
	if (!process.env.SAP_HOST) {
		return res.status(503).json({ success: false, message: "He thong SAP chua duoc cau hinh (thieu SAP_HOST)." });
	}

	try {
		const employee = await findActiveEmployeeByEmail(email);
		if (!employee || !employee.IsActive) {
			return res.status(401).json({
				success: false,
				message: `Email ${email} chua duoc cap quyen truy cap he thong (khong co trong SAP hoac da bi khoa).`
			});
		}
		return res.json({ success: true, employee, googlePicture: payload.picture || null });
	} catch (error) {
		console.error("❌ [login/google] Loi ket noi SAP:", error.message);
		return res.status(502).json({ success: false, message: "Khong the ket noi toi he thong SAP." });
	}
});

app.get("/api/materials", async (req, res) => {
	if (!process.env.SAP_HOST) {
		return res.status(503).json({ success: false, message: "He thong SAP chua duoc cau hinh (thieu SAP_HOST)." });
	}
	try {
		const response = await axios.get(
			`${process.env.SAP_HOST}${ODATA_SERVICE_PATH}/MaterialSet`,
			{ params: { "$format": "json" }, auth: sapAuth() }
		);
		return res.json({ success: true, data: (response.data && response.data.d && response.data.d.results) || [] });
	} catch (error) {
		console.error("❌ MaterialSet:", error.message);
		return res.status(502).json({ success: false, message: "Khong the lay du lieu vat tu tu SAP.", sapError: true });
	}
});

app.get("/api/vendors", async (req, res) => {
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

// Goi y NCC TRUOC khi gui RFQ (khac /api/ai/compare-quotations la sau khi da co gia that).
// Truoc day route nay gui thang ten/email/ma so thue NCC that len Groq — cung mot lo hong
// ma B2 da vá cho compare-quotations nhung bo sot o day. Nay dung chung 1 co che: an danh
// V1/V2/... truoc khi goi, dich nguoc sau khi co ket qua, va ghi log moi lan goi.
app.post("/api/ai/recommend-vendor", async (req, res) => {
	const { materialName, materialGroup, quantity, budget, vendors: candidateVendors } = req.body || {};

	if (!process.env.ANTHROPIC_API_KEY) {
		return res.status(500).json({ success: false, message: "Thieu ANTHROPIC_API_KEY." });
	}
	if (!Array.isArray(candidateVendors) || candidateVendors.length === 0) {
		return res.status(400).json({ success: false, message: "Thieu danh sach nha cung cap (goi /api/vendors truoc)." });
	}

	// An danh hoa: chi gui cho AI nhung thuoc tinh phuc vu viec chon NCC, tuyet doi khong
	// gui VendorName / Email / TaxCode / dia chi ra ngoai he thong.
	const anonMap = {};
	const anonymized = candidateVendors.map(function (v, idx) {
		const code = "V" + (idx + 1);
		// Dich nguoc ve "Ten NCC (ma)" — ten khong duoc gui cho AI, chi ghep lai sau.
		const vendorNo = String(v.VendorNo || v.Lifnr || "");
		const vendorName = String(v.VendorName || v.Name1 || "").trim();
		anonMap[code] = vendorName ? `${vendorName} (${vendorNo})` : vendorNo;
		return {
			vendorCode: code,
			country: v.Country || v.Land1 || "",
			city: v.City || v.Ort01 || "",
			paymentTerms: describePaymentTerms(v.PaymentTerms || v.Zterm),
			currency: v.Currency || v.Waers || ""
		};
	});

	// Prompt viet tieng Viet CO DAU — xem ghi chu o /api/ai/compare-quotations.
	const prompt = `Bạn là chuyên gia mua hàng. Dưới đây là danh sách nhà cung cấp đã ẩn danh hóa `
		+ `(không có tên/email thật) cho nhu cầu mua sắm:\n`
		+ `- Vật tư: ${materialName || "Không rõ"} (nhóm: ${materialGroup || "Không rõ"})\n`
		+ `- Số lượng: ${quantity || "Không rõ"}\n`
		+ `- Ngân sách dự kiến: ${budget || "Không rõ"} VND\n`
		+ `- Danh sách nhà cung cấp: ${JSON.stringify(anonymized, null, 2)}\n\n`
		+ `Hãy đề xuất các mã nhà cung cấp (vendorCode) nên mời báo giá và giải thích ngắn gọn. `
		+ `Lưu ý đây chỉ là gợi ý để mời báo giá, chưa phải quyết định chọn nhà cung cấp.\n\n`
		+ `QUAN TRỌNG VỀ HÌNH THỨC TRẢ LỜI: viết bằng TIẾNG VIỆT CÓ DẤU đầy đủ (ví dụ viết `
		+ `"đề xuất mời báo giá", tuyệt đối không viết "de xuat moi bao gia"). Chỉ viết văn xuôi `
		+ `thuần túy, KHÔNG dùng markdown (không dùng #, ##, **, gạch đầu dòng, đánh số thứ tự). `
		+ `Tối đa 4-5 câu. Kết quả sẽ được hiển thị nguyên văn trong một ô text thường trên giao diện, `
		+ `không render được markdown.`;

	try {
		const aiText = await callClaude(prompt, 500);

		// Dich nguoc ma an danh ve VendorNo that; dung word boundary de V1 khong khop nham trong V10.
		// Ham thay the thay vi chuoi — xem ghi chu o /api/ai/compare-quotations.
		let translatedText = aiText;
		Object.keys(anonMap).forEach(function (code) {
			if (anonMap[code]) {
				translatedText = translatedText.replace(
					new RegExp("\\b" + code + "\\b", "g"),
					function () { return anonMap[code]; }
				);
			}
		});

		console.log(
			"[AI recommend-vendor] " + new Date().toISOString()
			+ " vatTu=" + (materialName || "N/A") + " soNCCGuiVaoAI=" + anonymized.length
		);

		return res.json({ success: true, recommendation: translatedText, vendorCount: anonymized.length });
	} catch (error) {
		const message = extractSapErrorMessage(error);
		console.error("[POST /api/ai/recommend-vendor] THAT BAI:", message);
		return res.status(502).json({ success: false, message: "Khong the goi AI: " + message });
	}
});

async function notifyPurchasing(prId, message) {
	const emails = await findEmailsByRole("PURCHASING");
	emails.forEach(function (email) {
		pushNotification(email, prId, message);
	});
}

async function notifyCfo(prId, message) {
	const emails = await findEmailsByRole("CFO");
	emails.forEach(function (email) {
		pushNotification(email, prId, message);
	});
}

app.post("/api/approval/submit", async (req, res) => {
	const { requesterEmail, currency, totalPRValue, items, resubmitOf } = req.body || {};

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
		// Account assignment: ZAST -> bat buoc AssetNo; con lai theo acctAssignCat (K=CostCenter, F=InternalOrder).
		// Khong con bat buoc dong thoi ca CostCenter lan InternalOrder nhu truoc (chi 1 trong 2 duoc dung that tren SAP).
		if (it.materialType === "ZAST") {
			if (!String(it.assetNo || "").trim()) {
				return res.status(400).json({ success: false, message: "Dong " + (i + 1) + ": Vat tu Tai san (ZAST) bat buoc nhap Asset No." });
			}
		} else if (it.acctAssignCat === "F") {
			if (!String(it.internalOrder || "").trim()) {
				return res.status(400).json({ success: false, message: "Dong " + (i + 1) + ": Bat buoc chon Internal Order." });
			}
		} else {
			if (!String(it.costCenter || "").trim()) {
				return res.status(400).json({ success: false, message: "Dong " + (i + 1) + ": Bat buoc chon Cost Center." });
			}
		}
	}

	if (!process.env.SAP_HOST) {
		return res.status(503).json({ success: false, message: "He thong SAP chua duoc cau hinh (thieu SAP_HOST)." });
	}

	const mappedItems = items.map(function (item, idx) {
		var sMaterialType = item.materialType || "ZSRV";
		var sCat = sMaterialType === "ZAST" ? "A" : (item.acctAssignCat === "F" ? "F" : "K");
		return {
			LineNo: String(idx + 1).padStart(5, "0"),
			MaterialNo: item.materialNo || "",
			MaterialType: sMaterialType,
			Description: item.description || "",
			Quantity: Number(item.quantity),
			UoM: item.uom || "PC",
			EstimatedValue: Number(item.estimatedValue) || 0,
			AcctAssignCat: sCat,
			CostCenter: sCat === "K" ? (item.costCenter || "") : "",
			InternalOrder: sCat === "F" ? (normalizeOrderNo(item.internalOrder) || String(item.internalOrder || "").trim()) : "",
			AssetNo: sCat === "A" ? (item.assetNo || "") : "",
			isFreeText: item.isFreeText || false
		};
	});

	const flags = buildApprovalFlags(totalPRValue || 0, mappedItems);

	// Deep-entity POST: header + toan bo dong item long trong PrDraftToItems.
	// InternalId (PRId) do ABAP CREATE_DEEP_ENTITY sinh qua SNRO ZPRDRAFT,
	// KHONG con tu sinh "PR-<nam>-<seq>" o Node nhu truoc.
	const payload = {
		RequesterEmail: requesterEmail,
		TotalValue: String(totalPRValue || 0),
		Currency: currency || "VND",
		Comment: "",
		NeedsProcurementHeadReview: boolToSapX(flags.needsProcurementHeadReview),
		NeedsLegalReview: boolToSapX(flags.needsLegalReview),
		IoThreshold: flags.ioThreshold != null ? String(flags.ioThreshold) : "0",
		EscalationIO: flags.escalationIO || "",
		EstimatedTotalValue: String(totalPRValue || 0),
		PrDraftToItems: mappedItems.map(mapClientItemToSapDeep)
	};

	// Neu day la ban GUI LAI cua 1 PR bi tra (RETURNED): kiem tra ban cu truoc khi
	// tao ban moi, de khong bao gio roi vao tinh trang co 2 ban cung song song.
	let oldRecord = null;
	if (resubmitOf) {
		try {
			oldRecord = await fetchPrDraftById(resubmitOf);
		} catch (error) {
			const message = extractSapErrorMessage(error);
			console.error("[POST /api/approval/submit] Doc ban cu (resubmitOf) THAT BAI:", message);
			return res.status(502).json({ success: false, message });
		}
		if (!oldRecord) {
			return res.status(404).json({ success: false, message: "Khong tim thay de nghi cu " + resubmitOf + " de gui lai." });
		}
		if (oldRecord.Status !== "RETURNED") {
			return res.status(400).json({
				success: false,
				message: "De nghi " + resubmitOf + " dang o trang thai " + oldRecord.Status
					+ " — chi de nghi bi tra lai (RETURNED) moi duoc sua va gui lai."
			});
		}
		if (String(oldRecord.RequesterEmail || "").toLowerCase() !== String(requesterEmail || "").toLowerCase()) {
			return res.status(403).json({ success: false, message: "Chi chinh nguoi de nghi ban dau moi duoc gui lai de nghi nay." });
		}
	}

	let record;
	try {
		record = await createPrDraft(payload);
		if (!record) {
			return res.status(502).json({ success: false, message: "SAP khong tra ve du lieu PR nhap vua tao." });
		}
	} catch (error) {
		const message = extractSapErrorMessage(error);
		console.error("[POST /api/approval/submit] Tao PrDraft THAT BAI:", message);
		return res.status(502).json({ success: false, message: "Khong tao duoc PR nhap tren SAP: " + message });
	}

	// Ban moi tao xong -> dong ban cu lai (CANCELLED) de khong con xuat hien o bat ky
	// danh sach cho xu ly nao. Loi o buoc nay khong duoc lam fail ca request (ban moi
	// da ton tai hop le roi) — chi log de xu ly tay neu can.
	if (oldRecord) {
		try {
			await updatePrDraft(oldRecord.InternalId, {
				Status: "CANCELLED",
				Comment: "Da duoc gui lai bang de nghi moi " + record.PRId + "."
			});
		} catch (error) {
			console.error(
				"[POST /api/approval/submit] Huy ban cu " + oldRecord.InternalId + " THAT BAI (ban moi "
				+ record.PRId + " van hop le):", extractSapErrorMessage(error)
			);
		}
	}

	notifyRequester(
		record,
		"Đề nghị " + record.PRId + " đã được gửi, đang chờ Bộ phận mua sắm (Purchasing) xem xét. Số PR SAP sẽ có sau khi phê duyệt cuối."
	);
	await notifyPurchasing(
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

app.get("/api/approval/pending", async (req, res) => {
	if (!process.env.SAP_HOST) {
		return res.status(503).json({ success: false, message: "He thong SAP chua duoc cau hinh (thieu SAP_HOST)." });
	}
	const role = String(req.query.role || "").toUpperCase();
	var statusFilter = "PENDING_PURCHASING";
	if (role === "CEO") {
		statusFilter = "PENDING_CEO";
	} else if (role === "CFO") {
		statusFilter = "PENDING_CFO";
	} else if (role === "PURCHASING") {
		statusFilter = "PENDING_PURCHASING";
	}
	// Cho phep override status truc tiep — RFQ-01 dung ?status=PENDING_RFQ de lay
	// danh sach PR da duoc Purchasing duyet hop le, dang cho tao RFQ.
	if (req.query.status) {
		statusFilter = String(req.query.status).toUpperCase();
	}
	try {
		// Loc lai o Node sau khi SAP tra ve: neu PRDRAFTSET_GET_ENTITYSET chua ap
		// select-options thi $filter bi bo qua va SAP tra ve CA BANG — man hinh se
		// hien ca nhung PR khong thuoc trang thai dang cho. Loc 2 lan cho chac.
		const pending = (await fetchPrDraftList(`Status eq '${odataEscape(statusFilter)}'`))
			.filter((pr) => String(pr.Status || "").toUpperCase() === statusFilter);
		await enrichWithRfqAward(pending);
		return res.json({ success: true, data: pending });
	} catch (error) {
		const message = extractSapErrorMessage(error);
		console.error("[GET /api/approval/pending] THAT BAI:", message);
		return res.status(502).json({ success: false, message });
	}
});

app.get("/api/approval/approved", async (req, res) => {
	if (!process.env.SAP_HOST) {
		return res.status(503).json({ success: false, message: "He thong SAP chua duoc cau hinh (thieu SAP_HOST)." });
	}
	try {
		// Khong con check !item.PoNumber — ZPR_DRAFT khong co field PoNumber (xem
		// ghi chu tren /api/po/create). Status da tu chuyen sang PO_CREATED ngay
		// sau khi tao PO nen filter Status='APPROVED' la du de loai PR da co PO.
		// Loc lai o Node — xem ghi chu cung loai o /api/approval/pending.
		const data = (await fetchPrDraftList(`Status eq 'APPROVED'`))
			.filter((pr) => String(pr.Status || "").toUpperCase() === "APPROVED");
		return res.json({ success: true, data });
	} catch (error) {
		const message = extractSapErrorMessage(error);
		console.error("[GET /api/approval/approved] THAT BAI:", message);
		return res.status(502).json({ success: false, message });
	}
});

app.get("/api/approval/history", async (req, res) => {
	const email = String(req.query.email || "").trim().toLowerCase();
	const role = String(req.query.role || "").toUpperCase();

	if (!email) {
		return res.status(400).json({ success: false, message: "Thieu email." });
	}
	if (!process.env.SAP_HOST) {
		return res.status(503).json({ success: false, message: "He thong SAP chua duoc cau hinh (thieu SAP_HOST)." });
	}

	function sortNewest(a, b) {
		return new Date(b.UpdatedAt || b.CreatedAt || 0) - new Date(a.UpdatedAt || a.CreatedAt || 0);
	}

	let pending = [];
	let history = [];

	try {
		const allDrafts = await fetchPrDraftList();

		if (role === "REQUESTER") {
			history = allDrafts
				.filter(function (item) {
					return String(item.RequesterEmail || "").toLowerCase() === email;
				})
				.slice()
				.sort(sortNewest);
		} else if (role === "PURCHASING") {
			pending = allDrafts
				.filter(function (item) {
					return String(item.Status || "").toUpperCase() === "PENDING_PURCHASING";
				})
				.slice()
				.sort(sortNewest);
			history = allDrafts
				.filter(function (item) {
					// PR dang trong giai doan RFQ (chua co quyet dinh Approve/Reject nao ca) van
					// phai hien o day, khong thi bien mat khoi man Purchasing tu luc tao RFQ toi
					// luc PENDING_CFO — chua co man RFQ01/RFQ02 rieng de theo doi.
					const s = String(item.Status || "").toUpperCase();
					if (s === "PENDING_RFQ" || s === "RFQ_SENT" || s === "QUOTATIONS_RECEIVED") { return true; }
					if (item.PurchasingApprovedBy || item.PurchasingAction) { return true; }
					return String(item.DecidedByRole || "").toUpperCase() === "PURCHASING";
				})
				.slice()
				.sort(sortNewest);
		} else if (role === "CFO") {
			pending = allDrafts
				.filter(function (item) {
					return String(item.Status || "").toUpperCase() === "PENDING_CFO";
				})
				.slice()
				.sort(sortNewest);
			history = allDrafts
				.filter(function (item) {
					if (item.CfoProcessedBy || item.CfoAction) { return true; }
					return String(item.DecidedByRole || "").toUpperCase() === "CFO";
				})
				.slice()
				.sort(sortNewest);
		} else if (role === "CEO") {
			pending = allDrafts
				.filter(function (item) {
					return String(item.Status || "").toUpperCase() === "PENDING_CEO";
				})
				.slice()
				.sort(sortNewest);
			history = allDrafts
				.filter(function (item) {
					if (item.CeoProcessedBy || item.CeoAction) { return true; }
					return String(item.DecidedByRole || "").toUpperCase() === "CEO";
				})
				.slice()
				.sort(sortNewest);
		} else {
			history = allDrafts
				.filter(function (item) {
					const s = String(item.Status || "").toUpperCase();
					return s === "APPROVED" || s === "REJECTED" || s === "OPENED" || s === "OPEN";
				})
				.slice()
				.sort(sortNewest);
		}

		return res.json({ success: true, role: role, pending: pending, history: history });
	} catch (error) {
		const message = extractSapErrorMessage(error);
		console.error("[GET /api/approval/history] THAT BAI:", message);
		return res.status(502).json({ success: false, message });
	}
});

app.get("/api/approval/:id", async (req, res) => {
	const { id } = req.params;
	if (!process.env.SAP_HOST) {
		return res.status(503).json({ success: false, message: "He thong SAP chua duoc cau hinh (thieu SAP_HOST)." });
	}
	try {
		const record = await fetchPrDraftById(id);
		if (!record) {
			return res.status(404).json({
				success: false,
				message: "Không tìm thấy đề nghị mua sắm " + id + "."
			});
		}
		await enrichWithRfqAward([record]);
		return res.json({ success: true, data: record });
	} catch (error) {
		const message = extractSapErrorMessage(error);
		console.error("[GET /api/approval/:id] THAT BAI:", message);
		return res.status(502).json({ success: false, message });
	}
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

	if (!process.env.SAP_HOST) {
		return res.status(503).json({ success: false, message: "He thong SAP chua duoc cau hinh (thieu SAP_HOST)." });
	}

	let record;
	try {
		record = await fetchPrDraftById(id);
	} catch (error) {
		const message = extractSapErrorMessage(error);
		console.error("[PATCH /api/approval/:id] Doc PrDraft THAT BAI:", message);
		return res.status(502).json({ success: false, message });
	}
	if (!record) {
		return res.status(404).json({ success: false, message: "Khong tim thay de nghi mua sam." });
	}

	const sRole = String(decidedByRole || "").toUpperCase();
	const nowIso = new Date().toISOString();

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

	if (status === "REJECTED") {
		// Phan biet 2 loai tu choi theo dung quy trinh TO-BE:
		// - PURCHASING tu choi (buoc "Valid?" dau luong) -> RETURNED: PR bi tra lai,
		//   requester duoc sua va gui lai (PR01 se prefill tu ban nay, ban cu se bi
		//   CANCELLED khi ban moi duoc gui). Bat buoc co ly do de requester biet sua gi.
		// - CFO/CEO tu choi -> REJECTED: ket thuc han, khong co vong sua lai.
		const isReturn = sRole === "PURCHASING";
		if (isReturn && (!comment || !String(comment).trim())) {
			return res.status(400).json({
				success: false,
				message: "Bắt buộc nhập lý do khi trả lại PR để người đề nghị biết cần sửa gì."
			});
		}

		const finalStatus = isReturn ? "RETURNED" : "REJECTED";
		record.Status = finalStatus;
		record.Comment = comment || record.Comment;
		record.DecidedByEmail = decidedByEmail;
		record.DecidedByRole = sRole;
		record.UpdatedAt = nowIso;

		const sapFields = {
			Status: finalStatus,
			Comment: record.Comment,
			DecidedByEmail: decidedByEmail,
			DecidedByRole: sRole
		};
		if (sRole === "PURCHASING") {
			record.PurchasingApprovedBy = decidedByEmail;
			record.PurchasingAction = "REJECTED";
			record.PurchasingAt = nowIso;
			sapFields.PurchasingApprovedBy = decidedByEmail;
			sapFields.PurchasingAction = "REJECTED";
		} else if (sRole === "CFO") {
			record.CfoProcessedBy = decidedByEmail;
			record.CfoAction = "REJECTED";
			record.CfoAt = nowIso;
			sapFields.CfoProcessedBy = decidedByEmail;
			sapFields.CfoAction = "REJECTED";
		} else if (sRole === "CEO") {
			record.CeoProcessedBy = decidedByEmail;
			record.CeoAction = "REJECTED";
			record.CeoAt = nowIso;
			sapFields.CeoProcessedBy = decidedByEmail;
			sapFields.CeoAction = "REJECTED";
		}

		try {
			await updatePrDraft(record.InternalId, sapFields);
		} catch (error) {
			const message = extractSapErrorMessage(error);
			console.error("[PATCH /api/approval/:id] MERGE (REJECTED) THAT BAI:", message);
			return res.status(502).json({ success: false, message });
		}

		if (isReturn) {
			notifyRequester(
				record,
				"Đề nghị " + record.PRId + " bị Bộ phận mua sắm TRẢ LẠI. Lý do: " + comment
				+ " — Bạn có thể sửa lại và gửi lại đề nghị (màn Tạo đề nghị sẽ điền sẵn dữ liệu cũ)."
			);
			return res.json({ success: true, approval: record, returned: true });
		}
		notifyRequester(
			record,
			"Đề nghị " + record.PRId + " đã bị TỪ CHỐI bởi " + sRole + "."
			+ (comment ? " Lý do: " + comment : "")
		);
		return res.json({ success: true, approval: record });
	}

	if (status === "APPROVED") {
		// 1) Purchasing duyet ("Valid? = Yes" trong so do TO-BE) → PENDING_RFQ.
		// Theo quy trinh chot: Purchasing PHAI duyet truoc roi moi duoc tao RFQ,
		// va RFQ la buoc bat buoc — khong con duong duyet thang len CFO nua.
		// (Duong len CFO gio chi di qua award RFQ o /api/rfq/:id/award.)
		if (sRole === "PURCHASING") {
			record.Status = "PENDING_RFQ";
			record.Comment = comment || record.Comment;
			record.PurchasingApprovedBy = decidedByEmail;
			record.PurchasingAction = "APPROVED";
			record.PurchasingAt = nowIso;
			record.UpdatedAt = nowIso;

			try {
				await updatePrDraft(record.InternalId, {
					Status: "PENDING_RFQ",
					Comment: record.Comment,
					PurchasingApprovedBy: decidedByEmail,
					PurchasingAction: "APPROVED"
				});
			} catch (error) {
				const message = extractSapErrorMessage(error);
				console.error("[PATCH /api/approval/:id] MERGE (Purchasing->RFQ) THAT BAI:", message);
				return res.status(502).json({ success: false, message });
			}

			notifyRequester(
				record,
				"Đề nghị " + record.PRId + " đã được Bộ phận mua sắm chấp nhận, chuyển sang bước hỏi giá nhà cung cấp (RFQ)."
			);
			await notifyPurchasing(
				record.PRId,
				"PR " + record.PRId + " đã duyệt hợp lệ — tiếp tục tạo RFQ trên màn RFQ-01 để hỏi giá nhà cung cấp."
			);

			return res.json({ success: true, approval: record, forwarded: "RFQ" });
		}

		// 2) CFO + vượt ngưỡng IO → CEO
		if (sRole === "CFO" && record.needsProcurementHeadReview) {
			const t = record.ioThreshold;
			const io = record.escalationIO || "";
			record.Status = "PENDING_CEO";
			record.EscalationReason = "Vượt ngưỡng Internal Order "
				+ io + " (" + Number(t).toLocaleString("vi-VN") + " VND) — cần CEO phê duyệt.";
			record.Comment = comment || record.Comment;
			record.CfoProcessedBy = decidedByEmail;
			record.CfoAction = "ESCALATED";
			record.CfoAt = nowIso;
			record.UpdatedAt = nowIso;

			try {
				await updatePrDraft(record.InternalId, {
					Status: "PENDING_CEO",
					EscalationReason: record.EscalationReason,
					Comment: record.Comment,
					CfoProcessedBy: decidedByEmail,
					CfoAction: "ESCALATED"
				});
			} catch (error) {
				const message = extractSapErrorMessage(error);
				console.error("[PATCH /api/approval/:id] MERGE (CFO->CEO escalate) THAT BAI:", message);
				return res.status(502).json({ success: false, message });
			}

			notifyRequester(
				record,
				"Đề nghị " + record.PRId + " đã được CFO chuyển lên CEO (vượt ngưỡng IO). Bạn sẽ nhận thông báo khi CEO quyết định."
			);
			await notifyCeos(
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

		// 3) CFO (không vượt) hoặc CEO → SAP
		if (sRole === "CFO" || sRole === "CEO") {
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
			record.UpdatedAt = nowIso;

			const sapFields = {
				// Gui SapPRId -> ABAP PRDRAFTSET_UPDATE_ENTITY tu dong gan lai ca
				// SAPPRID lan PRID trong bang ZPR_DRAFT (xem code method).
				SapPRId: sapResult.sapPrNumber,
				Status: "APPROVED",
				Comment: record.Comment,
				DecidedByEmail: decidedByEmail,
				DecidedByRole: sRole
			};

			if (sRole === "CFO") {
				record.CfoProcessedBy = decidedByEmail;
				record.CfoAction = "APPROVED";
				record.CfoAt = nowIso;
				sapFields.CfoProcessedBy = decidedByEmail;
				sapFields.CfoAction = "APPROVED";
			} else {
				record.CeoProcessedBy = decidedByEmail;
				record.CeoAction = "APPROVED";
				record.CeoAt = nowIso;
				sapFields.CeoProcessedBy = decidedByEmail;
				sapFields.CeoAction = "APPROVED";
			}

			try {
				await updatePrDraft(record.InternalId, sapFields);
			} catch (error) {
				const message = extractSapErrorMessage(error);
				console.error("[PATCH /api/approval/:id] MERGE (final APPROVED) THAT BAI:", message);
				return res.status(502).json({ success: false, message });
			}

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
	}

	return res.status(400).json({ success: false, message: "Status không hợp lệ (chỉ nhận APPROVED/REJECTED)." });
});
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

// Logo cong ty gan vao mail bang inline attachment (cid), KHONG dung link anh
// public — nhieu mail client (Outlook, Gmail) mac dinh chan tai anh tu URL
// ngoai nen link se hien o dang "vo anh". attachments rong neu thieu file thi
// mail van gui binh thuong, chi la khong co logo.
const COMPANY_LOGO_PATH = path.join(__dirname, "webapp", "images", "LogoCty.png");
function getLogoAttachment() {
	if (!fs.existsSync(COMPANY_LOGO_PATH)) { return []; }
	return [{
		filename: "LogoCty.png",
		path: COMPANY_LOGO_PATH,
		cid: "companyLogo"
	}];
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
        <img src="cid:companyLogo" alt="Company Logo" style="max-width:200px;height:auto;display:block;margin-bottom:16px;">

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

	const transporter = getMailTransporter();
	if (!transporter) {
		console.error("⚠️ Bo qua gui email PO (nodemailer khong san sang):", poNumber);
		return false;
	}

	try {
		await transporter.sendMail({

			from: process.env.EMAIL_USER,

			to: vendorEmail,

			subject: `Purchase Order ${poNumber}`,

			html,

			attachments: getLogoAttachment()

		});

		return true;
	} catch (e) {
		console.error("⚠️ Gui email PO that bai:", e.message);
		return false;
	}
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
			TotalValue: totalValue.toFixed(2),
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
						NetPrice: Number(item.netPrice || 0).toFixed(2),
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
// ============================================================================
// API RFQ (Request for Quotation) — Z-table ZG1_RFQ / ZG1_QUOTATION qua OData
// RfqSet + QuotationSet, KHONG phai ME41 chuan cua SAP (quyet dinh da chot,
// xem KE_HOACH_RFQ_2_TUAN.md muc B3). Sinh RfqId dang RFQ-<nam>-<4 chu so>.
// ============================================================================

/** Sinh RfqId ke tiep bang cach dem so RFQ da co trong nam hien tai tren SAP. */
async function generateNextRfqId() {
	const year = new Date().getFullYear();
	const prefix = `RFQ-${year}-`;
	let maxSeq = 0;
	try {
		const response = await sapRead("RfqSet");
		const results = (response.data && response.data.d && response.data.d.results) || [];
		results.forEach(function (row) {
			const rid = String(row.RfqId || "");
			if (rid.indexOf(prefix) === 0) {
				const seq = parseInt(rid.slice(prefix.length), 10);
				if (!isNaN(seq) && seq > maxSeq) { maxSeq = seq; }
			}
		});
	} catch (error) {
		console.error("[generateNextRfqId] Khong doc duoc RfqSet, dung seq du phong:", error.message);
	}
	return prefix + String(maxSeq + 1).padStart(4, "0");
}

/** Goi Anthropic Messages API (khong them SDK moi, dung axios cho dong bo voi phan con lai cua file). */
async function callClaude(promptText, maxTokens) {
	const response = await axios.post(
		"https://api.anthropic.com/v1/messages",
		{
			model: "claude-sonnet-5",
			max_tokens: maxTokens || 800,
			messages: [{ role: "user", content: promptText }]
		},
		{
			headers: {
				"x-api-key": process.env.ANTHROPIC_API_KEY,
				"anthropic-version": "2023-06-01",
				"Content-Type": "application/json"
			},
			timeout: 30000
		}
	);
	const content = response.data && response.data.content;
	// Truoc day lay thang content[0].text — neu block dau tien khong phai type "text" (vi du
	// bi chen block khac truoc no) thi se ra chuoi rong ma khong bao loi gi ca, FE nhan
	// success:true nhung khong hien thi duoc gi. Doi sang tim dung block type "text".
	const textBlock = Array.isArray(content) && content.find((c) => c && c.type === "text" && c.text);
	if (!textBlock) {
		console.error(
			"[callClaude] Khong tim thay text block trong phan hoi Claude. stop_reason="
			+ (response.data && response.data.stop_reason) + " content=" + JSON.stringify(content)
		);
		throw new Error(
			"Claude khong tra ve noi dung text (stop_reason=" + (response.data && response.data.stop_reason) + ")."
		);
	}
	return textBlock.text;
}

// 0) Danh sach RFQ (cho man RFQ-02 chon RFQ dang xu ly) — doc thang tu RfqSet
app.get("/api/rfq", async (req, res) => {
	if (!process.env.SAP_HOST) {
		return res.status(503).json({ success: false, message: "He thong SAP chua duoc cau hinh (thieu SAP_HOST)." });
	}
	try {
		const response = await sapRead("RfqSet");
		let results = (response.data && response.data.d && response.data.d.results) || [];

		const statusFilter = String(req.query.status || "").toUpperCase();
		if (statusFilter) {
			results = results.filter((r) => String(r.Status || "").toUpperCase() === statusFilter);
		}

		// Moi nhat len dau — CreatedAt la chuoi YYYYMMDDHHMMSS nen so sanh chuoi la du
		results.sort((a, b) => String(b.CreatedAt || "").localeCompare(String(a.CreatedAt || "")));

		return res.json({ success: true, data: results });
	} catch (error) {
		const message = extractSapErrorMessage(error);
		console.error("[GET /api/rfq] THAT BAI:", message);
		return res.status(502).json({ success: false, message });
	}
});

// 1) Tao RFQ tu 1 PR + danh sach NCC duoc moi
app.post("/api/rfq/create", async (req, res) => {
	const { prId, sapPrNumber, vendorIds, createdBy, currency } = req.body || {};

	if (!process.env.SAP_HOST) {
		return res.status(503).json({ success: false, message: "He thong SAP chua duoc cau hinh (thieu SAP_HOST)." });
	}
	if (!prId) {
		return res.status(400).json({ success: false, message: "Thieu prId." });
	}
	if (!Array.isArray(vendorIds) || vendorIds.length < 1) {
		return res.status(400).json({ success: false, message: "Phai chon it nhat 1 nha cung cap de gui RFQ." });
	}

	// Máy trạng thái theo quy trình TO-BE đã chốt: Purchasing phải DUYỆT PR trước
	// (PENDING_PURCHASING → PENDING_RFQ qua PATCH /api/approval/:id), rồi mới được
	// tạo RFQ ở đây. Chặn tạo trùng bằng check RfqId đã gắn.
	let prRecord;
	try {
		prRecord = await fetchPrDraftById(prId);
	} catch (error) {
		const message = extractSapErrorMessage(error);
		console.error("[POST /api/rfq/create] Doc PrDraft THAT BAI:", message);
		return res.status(502).json({ success: false, message });
	}
	if (!prRecord) {
		return res.status(404).json({ success: false, message: "Khong tim thay PR " + prId + " tren SAP." });
	}
	if (prRecord.Status !== "PENDING_RFQ") {
		return res.status(400).json({
			success: false,
			message: "PR " + prId + " dang o trang thai " + prRecord.Status
				+ ". Purchasing phai duyet PR (chuyen sang PENDING_RFQ) truoc khi tao RFQ."
		});
	}
	if (prRecord.RfqId) {
		return res.status(400).json({
			success: false,
			message: "PR " + prId + " da co RFQ " + prRecord.RfqId + " — khong tao trung."
		});
	}

	try {
		const rfqId = await generateNextRfqId();
		const session = await sapFetchCsrfToken();

		const allVendors = await fetchAllVendorsFromSAP();
		const vendorMap = {};
		allVendors.forEach(function (v) { vendorMap[String(v.VendorNo)] = v; });

		// Gui 1 deep-entity POST duy nhat (RFQ header + mang RfqToQuotations long ben
		// trong) thay vi POST RfqSet roi loop POST QuotationSet rieng. Ly do: simple
		// <EntitySet>_CREATE_ENTITY tren SAP bi Gateway framework tu choi khi goi qua
		// Basic Auth (user ky thuat DEV-261) voi loi "Property 'RfqId' ... invalid
		// value" — da xac nhan qua nhieu vong test (SEGW creatable flag, generate lai
		// runtime objects, xoa cache /IWBEP/CACHE_CLEANUP deu khong het), trong khi goi
		// qua session trinh duyet/SAP GUI thi luon thanh cong. CREATE_DEEP_ENTITY (nhu
		// PrDraftSet/PurchaseRequisitionHeaderSet dang dung) khong bi loi nay. Xem
		// memory: SAP490_G1 RFQ deep entity fix.
		const rfqToQuotations = vendorIds.map(function (vendorId) {
			const vendorInfo = vendorMap[String(vendorId)] || {};
			return {
				VendorNo: String(vendorId),
				VendorName: vendorInfo.VendorName || "",
				VendorEmail: vendorInfo.Email || vendorInfo.VendorEmail || "",
				QuotedPrice: "0",
				Currency: currency || "VND",
				LeadTimeDays: 0,
				PaymentTerms: "",
				WarrantyMonths: 0,
				LegalDocsOk: "",
				QuoteStatus: "PENDING",
				EnteredBy: "",
				EnteredAt: "",
				SourceNote: ""
			};
		});

		await sapWrite("POST", "RfqSet", {
			RfqId: rfqId,
			PrId: String(prId),
			SapPrNumber: sapPrNumber ? String(sapPrNumber) : "",
			CreatedBy: createdBy || "",
			CreatedAt: sapTimestamp(),
			SentAt: "",
			Deadline: "",
			Status: "DRAFT",
			AwardedVendor: "",
			AwardReason: "",
			AwardedBy: "",
			AwardedAt: "",
			FinalValue: "0",
			Currency: currency || "VND",
			RfqToQuotations: rfqToQuotations
		}, session);

		// RFQ da tao thanh cong tren SAP -> gan RfqId vao PR (Status van PENDING_RFQ,
		// RfqId != rong la dau hieu "da co RFQ, dang o buoc gui/nhap bao gia").
		prRecord.RfqId = rfqId;
		prRecord.UpdatedAt = new Date().toISOString();
		await updatePrDraft(prRecord.InternalId, { RfqId: rfqId }, session);

		notifyRequester(
			prRecord,
			"Đề nghị " + prRecord.PRId + " đang được Purchasing gửi yêu cầu báo giá (RFQ " + rfqId + ") tới nhà cung cấp."
		);

		return res.status(201).json({ success: true, rfqId, status: "DRAFT" });
	} catch (error) {
		const message = extractSapErrorMessage(error);
		console.error("[POST /api/rfq/create] THAT BAI:", message);
		return res.status(502).json({ success: false, message });
	}
});

// 2) Gui email RFQ toi cac NCC da moi + chuyen trang thai sang SENT
app.post("/api/rfq/:id/send", async (req, res) => {
	const { id } = req.params;
	const { deadline } = req.body || {};

	if (!process.env.SAP_HOST) {
		return res.status(503).json({ success: false, message: "He thong SAP chua duoc cau hinh (thieu SAP_HOST)." });
	}

	// Khong tin FE: du DatePicker da chan minDate, request van co the bi sua tay (Postman, DevTools...).
	const normalizedDeadlineCheck = normalizeSapDeadline(deadline);
	if (normalizedDeadlineCheck && normalizedDeadlineCheck < sapDateOnly()) {
		return res.status(400).json({ success: false, message: "Han nop bao gia khong duoc o qua khu." });
	}

	try {
		const rfqResp = await sapRead(`RfqSet('${odataEscape(id)}')`);
		const rfq = rfqResp.data && rfqResp.data.d;
		if (!rfq) {
			return res.status(404).json({ success: false, message: "Khong tim thay RFQ " + id + "." });
		}

		const quotationsResp = await sapRead(`RfqSet('${odataEscape(id)}')/RfqToQuotations`);
		const quotations = (quotationsResp.data && quotationsResp.data.d && quotationsResp.data.d.results) || [];

		const transporter = getMailTransporter();
		let sentCount = 0;
		if (transporter) {
			for (const q of quotations) {
				if (!q.VendorEmail) { continue; }
				try {
					await transporter.sendMail({
						from: process.env.EMAIL_USER,
						to: q.VendorEmail,
						subject: `Yeu cau bao gia ${id}`,
						html: `
							<img src="cid:companyLogo" alt="Company Logo" style="max-width:200px;height:auto;display:block;margin-bottom:16px;">
							<p>Kinh gui ${q.VendorName || q.VendorNo},</p>
							<p>Chung toi de nghi Quy vi gui bao gia cho yeu cau mua sam lien quan:</p>
							<table border="1" cellpadding="6" cellspacing="0">
								<tr><td><b>Ma RFQ</b></td><td>${id}</td></tr>
								<tr><td><b>PR lien quan</b></td><td>${rfq.SapPrNumber || rfq.PrId || ""}</td></tr>
								<tr><td><b>Han nop bao gia</b></td><td>${deadline || "(chua xac dinh)"}</td></tr>
							</table>
							<p>Vui long phan hoi truoc han neu co the.</p>
							<p>Tran trong,<br>Purchasing Department</p>
						`,
						attachments: getLogoAttachment()
					});
					sentCount++;
				} catch (mailError) {
					console.error(`[POST /api/rfq/${id}/send] Gui mail that bai cho ${q.VendorEmail}:`, mailError.message);
				}
			}
		} else {
			console.error(`[POST /api/rfq/${id}/send] Bo qua gui email (nodemailer khong san sang).`);
		}

		const normalizedDeadline = normalizeSapDeadline(deadline);
		const mergeData = {
			Status: "SENT",
			SentAt: sapTimestamp()
		};
		if (normalizedDeadline) { mergeData.Deadline = normalizedDeadline; }

		await sapWrite("MERGE", `RfqSet('${odataEscape(id)}')`, mergeData);

		// Chuyen PR goc sang RFQ_SENT (khong ha cap neu vi ly do nao do da qua giai doan sau).
		const prRecordForSend = await fetchPrDraftByRfq(rfq);
		if (prRecordForSend && prRecordForSend.Status === "PENDING_RFQ") {
			await updatePrDraft(prRecordForSend.InternalId, { Status: "RFQ_SENT" });
		}

		return res.json({ success: true, emailsSent: sentCount, totalVendors: quotations.length });
	} catch (error) {
		const message = extractSapErrorMessage(error);
		console.error(`[POST /api/rfq/${id}/send] THAT BAI:`, message);
		return res.status(502).json({ success: false, message });
	}
});

// 3) Nhap tay 1 bao gia cho 1 NCC (bat buoc ghi ai nhap/luc nao/can cu gi — audit trail)
app.post("/api/rfq/:id/quotation", async (req, res) => {
	const { id } = req.params;
	const {
		vendorNo, quotedPrice, currency, leadTimeDays,
		paymentTerms, warrantyMonths, legalDocsOk, sourceNote, enteredBy
	} = req.body || {};

	if (!process.env.SAP_HOST) {
		return res.status(503).json({ success: false, message: "He thong SAP chua duoc cau hinh (thieu SAP_HOST)." });
	}
	if (!vendorNo) {
		return res.status(400).json({ success: false, message: "Thieu vendorNo." });
	}
	if (quotedPrice == null || quotedPrice === "" || Number(quotedPrice) <= 0) {
		return res.status(400).json({ success: false, message: "Gia bao gia (quotedPrice) khong hop le." });
	}
	if (!sourceNote || !String(sourceNote).trim()) {
		return res.status(400).json({ success: false, message: "Bat buoc nhap sourceNote (can cu nhap bao gia, vd email NCC ngay nao)." });
	}

	try {
		const session = await sapFetchCsrfToken();

		await sapWrite(
			"MERGE",
			`QuotationSet(RfqId='${odataEscape(id)}',VendorNo='${odataEscape(vendorNo)}')`,
			{
				QuotedPrice: String(quotedPrice),
				Currency: currency || "VND",
				LeadTimeDays: Number(leadTimeDays) || 0,
				PaymentTerms: paymentTerms || "",
				WarrantyMonths: Number(warrantyMonths) || 0,
				LegalDocsOk: legalDocsOk ? "X" : "",
				QuoteStatus: "RECEIVED",
				EnteredBy: enteredBy || "",
				EnteredAt: sapTimestamp(),
				SourceNote: String(sourceNote).trim()
			},
			session
		);

		// Neu RFQ dang DRAFT/SENT thi nang len QUOTATIONS_RECEIVED — khong ha cap neu da AWARDED
		const rfqResp = await sapRead(`RfqSet('${odataEscape(id)}')`);
		const rfq = rfqResp.data && rfqResp.data.d;
		if (rfq && (rfq.Status === "DRAFT" || rfq.Status === "SENT")) {
			await sapWrite("MERGE", `RfqSet('${odataEscape(id)}')`, { Status: "QUOTATIONS_RECEIVED" }, session);

			// Phan anh cung trang thai nay len PR goc tren PrDraftSet.
			const prRecordForQuote = await fetchPrDraftByRfq(rfq);
			if (prRecordForQuote && (prRecordForQuote.Status === "PENDING_RFQ" || prRecordForQuote.Status === "RFQ_SENT")) {
				await updatePrDraft(prRecordForQuote.InternalId, { Status: "QUOTATIONS_RECEIVED" });
			}
		}

		return res.json({ success: true });
	} catch (error) {
		const message = extractSapErrorMessage(error);
		console.error(`[POST /api/rfq/${id}/quotation] THAT BAI:`, message);
		return res.status(502).json({ success: false, message });
	}
});

// 4) Bang so sanh bao gia cho 1 RFQ
app.get("/api/rfq/:id/compare", async (req, res) => {
	const { id } = req.params;

	if (!process.env.SAP_HOST) {
		return res.status(503).json({ success: false, message: "He thong SAP chua duoc cau hinh (thieu SAP_HOST)." });
	}

	try {
		const rfqResp = await sapRead(`RfqSet('${odataEscape(id)}')`);
		const rfq = rfqResp.data && rfqResp.data.d;
		if (!rfq) {
			return res.status(404).json({ success: false, message: "Khong tim thay RFQ " + id + "." });
		}

		const quotationsResp = await sapRead(`RfqSet('${odataEscape(id)}')/RfqToQuotations`);
		const allQuotations = (quotationsResp.data && quotationsResp.data.d && quotationsResp.data.d.results) || [];

		const received = allQuotations.filter((q) => q.QuoteStatus === "RECEIVED" || q.QuoteStatus === "AWARDED");
		const pending = allQuotations.filter((q) => q.QuoteStatus === "PENDING");

		// Kem theo PR goc (header + tung dong item) de man RFQ-02 hien duoc "da yeu cau
		// bao gia cai gi" — truoc day chi tra ve moi ma RFQ, nguoi nhap bao gia khong
		// biet minh dang doi bao gia cho vat tu nao, so luong bao nhieu.
		// Doc PR loi thi van tra bang so sanh (pr = null), khong chan ca man hinh.
		let pr = null;
		try {
			pr = await fetchPrDraftByRfq(rfq);
		} catch (error) {
			console.error(`[GET /api/rfq/${id}/compare] Doc PR goc that bai:`, extractSapErrorMessage(error));
		}

		return res.json({
			success: true,
			rfq,
			pr,
			quotations: received,
			pendingVendors: pending.map((q) => ({ VendorNo: q.VendorNo, VendorName: q.VendorName }))
		});
	} catch (error) {
		const message = extractSapErrorMessage(error);
		console.error(`[GET /api/rfq/${id}/compare] THAT BAI:`, message);
		return res.status(502).json({ success: false, message });
	}
});

// 5) Chot NCC thang — bat buoc >=2 bao gia RECEIVED + ly do, chuyen PR goc sang PENDING_CFO
app.post("/api/rfq/:id/award", async (req, res) => {
	const { id } = req.params;
	const { vendorNo, awardReason, awardedBy, soleSourceReason } = req.body || {};

	if (!process.env.SAP_HOST) {
		return res.status(503).json({ success: false, message: "He thong SAP chua duoc cau hinh (thieu SAP_HOST)." });
	}
	if (!vendorNo) {
		return res.status(400).json({ success: false, message: "Thieu vendorNo." });
	}
	if (!awardReason || !String(awardReason).trim()) {
		return res.status(400).json({ success: false, message: "Bat buoc nhap ly do chon nha cung cap (awardReason)." });
	}

	try {
		const quotationsResp = await sapRead(`RfqSet('${odataEscape(id)}')/RfqToQuotations`);
		const quotations = (quotationsResp.data && quotationsResp.data.d && quotationsResp.data.d.results) || [];
		const receivedCount = quotations.filter((q) => q.QuoteStatus === "RECEIVED" || q.QuoteStatus === "AWARDED").length;

		if (receivedCount < 1) {
			return res.status(400).json({ success: false, message: "Chua co bao gia nao duoc nhan." });
		}
		if (receivedCount === 1 && (!soleSourceReason || !String(soleSourceReason).trim())) {
			return res.status(400).json({ success: false, message: "Chi co 1 bao gia — bat buoc nhap ly do chi dinh 1 nha cung cap (sole source)." });
		}

		const winner = quotations.find((q) => String(q.VendorNo) === String(vendorNo));
		if (!winner) {
			return res.status(404).json({ success: false, message: "Khong tim thay bao gia cua nha cung cap " + vendorNo + " trong RFQ nay." });
		}
		if (winner.QuoteStatus !== "RECEIVED" && winner.QuoteStatus !== "AWARDED") {
			return res.status(400).json({ success: false, message: "Nha cung cap " + vendorNo + " chua co bao gia RECEIVED." });
		}

		const finalValue = winner.QuotedPrice;
		const finalCurrency = winner.Currency || "VND";
		const session = await sapFetchCsrfToken();

		const finalAwardReason = receivedCount === 1
			? "[SOLE SOURCE] " + String(soleSourceReason).trim() + " | " + String(awardReason).trim()
			: String(awardReason).trim();

		await sapWrite("MERGE", `RfqSet('${odataEscape(id)}')`, {
			Status: "AWARDED",
			AwardedVendor: String(vendorNo),
			AwardReason: finalAwardReason,
			AwardedBy: awardedBy || "",
			AwardedAt: sapTimestamp(),
			FinalValue: String(finalValue),
			Currency: finalCurrency
		}, session);

		await sapWrite(
			"MERGE",
			`QuotationSet(RfqId='${odataEscape(id)}',VendorNo='${odataEscape(vendorNo)}')`,
			{ QuoteStatus: "AWARDED" },
			session
		);

		// Cap nhat trang thai PR goc sang PENDING_CFO tren PrDraftSet.
		const rfqResp = await sapRead(`RfqSet('${odataEscape(id)}')`);
		const rfq = rfqResp.data && rfqResp.data.d;
		const prRecord = rfq && await fetchPrDraftByRfq(rfq);
		if (prRecord) {
			// Tinh lai co/khong vuot nguong CEO tren GIA THAT tu bao gia thang, khong dung
			// gia uoc tinh luc tao PR nua — gia uoc tinh va gia thuong luong co the lech nhau
			// đủ để đổi kết quả escalation. Giữ lại giá ước tính ban đầu để audit trail.
			const recalculatedFlags = buildApprovalFlags(finalValue, prRecord.items);

			if (prRecord.EstimatedTotalValue == null) {
				prRecord.EstimatedTotalValue = prRecord.TotalValue;
			}
			prRecord.TotalValue = finalValue;
			prRecord.Currency = finalCurrency;
			prRecord.needsProcurementHeadReview = recalculatedFlags.needsProcurementHeadReview;
			prRecord.needsLegalReview = recalculatedFlags.needsLegalReview;
			prRecord.ioThreshold = recalculatedFlags.ioThreshold;
			prRecord.escalationIO = recalculatedFlags.escalationIO;

			prRecord.Status = "PENDING_CFO";
			prRecord.UpdatedAt = new Date().toISOString();
			prRecord.RfqId = id;
			prRecord.RfqAwardedVendor = String(vendorNo);
			prRecord.RfqFinalValue = finalValue;

			await updatePrDraft(prRecord.InternalId, {
				EstimatedTotalValue: String(prRecord.EstimatedTotalValue),
				TotalValue: String(finalValue),
				Currency: finalCurrency,
				NeedsProcurementHeadReview: boolToSapX(recalculatedFlags.needsProcurementHeadReview),
				NeedsLegalReview: boolToSapX(recalculatedFlags.needsLegalReview),
				IoThreshold: recalculatedFlags.ioThreshold != null ? String(recalculatedFlags.ioThreshold) : "0",
				EscalationIO: recalculatedFlags.escalationIO || "",
				Status: "PENDING_CFO",
				RfqId: id,
				RfqAwardedVendor: String(vendorNo),
				RfqFinalValue: String(finalValue)
			});

			notifyRequester(
				prRecord,
				"RFQ " + id + " da chon nha cung cap " + vendorNo + ". De nghi " + prRecord.PRId + " chuyen sang cho CFO xem xet."
			);
			await notifyCfo(
				prRecord.PRId,
				"RFQ " + id + " da chon NCC " + vendorNo + " — gia tri bao gia "
				+ Number(finalValue).toLocaleString("vi-VN") + " " + finalCurrency + ". Cho CFO duyet."
			);
		} else {
			console.error(`[POST /api/rfq/${id}/award] Khong tim thay PR tuong ung tren SAP de cap nhat trang thai.`);
		}

		return res.json({ success: true, finalValue, awardedVendor: String(vendorNo) });
	} catch (error) {
		const message = extractSapErrorMessage(error);
		console.error(`[POST /api/rfq/${id}/award] THAT BAI:`, message);
		return res.status(502).json({ success: false, message });
	}
});

// 6) AI ho tro so sanh bao gia SAU KHI da co gia that (tach khoi /api/ai/recommend-vendor
// dung TRUOC khi gui RFQ). An danh hoa VendorNo -> V1/V2/... truoc khi gui cho AI,
// dich nguoc lai truoc khi tra ve FE — khong gui ten/email NCC that ra ngoai.
app.post("/api/ai/compare-quotations", async (req, res) => {
	const { rfqId } = req.body || {};

	if (!rfqId) {
		return res.status(400).json({ success: false, message: "Thieu rfqId." });
	}
	if (!process.env.SAP_HOST) {
		return res.status(503).json({ success: false, message: "He thong SAP chua duoc cau hinh (thieu SAP_HOST)." });
	}
	if (!process.env.ANTHROPIC_API_KEY) {
		return res.status(500).json({ success: false, message: "Thieu ANTHROPIC_API_KEY." });
	}

	try {
		const quotationsResp = await sapRead(`RfqSet('${odataEscape(rfqId)}')/RfqToQuotations`);
		const allQuotations = (quotationsResp.data && quotationsResp.data.d && quotationsResp.data.d.results) || [];
		const received = allQuotations.filter((q) => q.QuoteStatus === "RECEIVED" || q.QuoteStatus === "AWARDED");

		if (received.length === 0) {
			return res.status(400).json({ success: false, message: "Chua co bao gia nao RECEIVED de so sanh." });
		}

		// An danh hoa: VendorNo that -> ma tam V1/V2/..., giu bang map o server de dich nguoc sau
		const anonMap = {};
		const anonymized = received.map(function (q, idx) {
			const code = "V" + (idx + 1);
			// Dich nguoc ve "Ten NCC (ma)" chu khong chi ma so: nguoi doc khong nho
			// 0080000012 la ai. Ten van KHONG duoc gui cho AI, chi ghep lai o buoc dich
			// nguoc sau khi da co cau tra loi.
			const vendorName = String(q.VendorName || "").trim();
			anonMap[code] = vendorName
				? `${vendorName} (${q.VendorNo})`
				: String(q.VendorNo);
			return {
				vendorCode: code,
				quotedPrice: Number(q.QuotedPrice) || 0,
				currency: q.Currency || "VND",
				leadTimeDays: Number(q.LeadTimeDays) || 0,
				paymentTerms: describePaymentTerms(q.PaymentTerms),
				warrantyMonths: Number(q.WarrantyMonths) || 0,
				legalDocsOk: q.LegalDocsOk === "X"
			};
		});

		// Prompt PHAI viet tieng Viet co dau: truoc day prompt viet khong dau nen Claude
		// bat chuoc van phong do va tra ve nguyen doan tieng Viet khong dau, nguoi dung
		// doc rat kho. Yeu cau co dau mot cach tuong minh o cuoi.
		const prompt = `Bạn là chuyên gia mua hàng. Dưới đây là các báo giá đã ẩn danh hóa `
			+ `(không có tên/email nhà cung cấp thật) cho RFQ ${rfqId}:\n`
			+ `${JSON.stringify(anonymized, null, 2)}\n\n`
			+ `Hãy đề xuất 1 mã nhà cung cấp (vendorCode) nên chọn. Đánh giá lần lượt theo 5 tiêu chí, `
			+ `xếp theo mức độ quan trọng giảm dần:\n`
			+ `1. Giá báo (quotedPrice) — thấp hơn thì tốt hơn, nêu rõ chênh lệch bao nhiêu tiền.\n`
			+ `2. Thời gian giao hàng (leadTimeDays) — ngắn hơn thì tốt hơn.\n`
			+ `3. Công nợ / điều khoản thanh toán (paymentTerms) — được trả càng chậm thì càng có lợi cho dòng tiền.\n`
			+ `4. Bảo hành (warrantyMonths) — dài hơn thì tốt hơn.\n`
			+ `5. Hồ sơ pháp lý (legalDocsOk) — thiếu hồ sơ là rủi ro đáng kể.\n\n`
			+ `Dòng đầu tiên chỉ ghi đúng mã vendorCode được chọn (ví dụ: "V2"), không thêm gì khác. `
			+ `Các dòng sau giải thích ngắn gọn 3-5 câu, bám vào 5 tiêu chí trên.\n\n`
			+ `QUAN TRỌNG VỀ HÌNH THỨC TRẢ LỜI: viết bằng TIẾNG VIỆT CÓ DẤU đầy đủ (ví dụ viết `
			+ `"đề xuất chọn nhà cung cấp", tuyệt đối không viết "de xuat chon nha cung cap"). `
			+ `Chỉ viết văn xuôi thuần túy, KHÔNG dùng markdown (không dùng #, ##, **, gạch đầu dòng, `
			+ `đánh số thứ tự) vì kết quả sẽ hiển thị nguyên văn trong một ô text thường không render được markdown.`;

		const aiText = await callClaude(prompt, 500);

		// Dich nguoc ma an danh (V1/V2/...) trong cau tra loi ve VendorNo that, dung word boundary
		// de tranh the V1 khop nham vao trong V10 khi co >=10 NCC.
		// Dung ham thay the (khong dung chuoi) vi gia tri thay the gio chua TEN NCC:
		// String.replace se dien giai $&, $', $1... trong chuoi thay the, ten NCC co
		// ky tu $ se ra sai. Ham callback tra ve nguyen van, khong dien giai gi.
		let translatedText = aiText;
		Object.keys(anonMap).forEach(function (code) {
			translatedText = translatedText.replace(
				new RegExp("\\b" + code + "\\b", "g"),
				function () { return anonMap[code]; }
			);
		});

		console.log(
			"[AI compare-quotations] " + new Date().toISOString()
			+ " rfqId=" + rfqId + " soNCCGuiVaoAI=" + anonymized.length
		);

		return res.json({ success: true, rfqId, recommendation: translatedText, vendorCount: anonymized.length });
	} catch (error) {
		const message = extractSapErrorMessage(error);
		console.error("[POST /api/ai/compare-quotations] THAT BAI:", message);
		return res.status(502).json({ success: false, message });
	}
});

if (require.main === module) {
	app.listen(PORT, () => {
		console.log(`QDAVY Procurement API: http://localhost:${PORT}`);
		console.log(process.env.SAP_HOST
			? `OData: ${process.env.SAP_HOST}${ODATA_SERVICE_PATH}`
			: "Che do: mock (SAP_HOST chua cau hinh)");
		console.log("[DATA] Folder:", DATA_DIR);
		console.log("[LOGIC] Leo CEO theo ngưỡng Internal Order (khong con 300tr co dinh)");
	});
}

module.exports = app;