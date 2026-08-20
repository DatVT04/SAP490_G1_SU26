/**
 * State luu tren dia: thong bao + nguong duyet theo Internal Order.
 *
 * Tach ra tu server.js (ban goc 4520 dong) ngay 15/08/2026.
 * Noi dung ham giu nguyen 100%, chi them phan require/exports o dau va cuoi file.
 */


const fs = require("fs");
const path = require("path");
const os = require("os");

// Duong dan goc cua project. Truoc day code nay nam o server.js (thu muc goc) nen
// dung thang __dirname; sau khi tach xuong src/lib thi __dirname da lech,
// phai lui lai dung so cap thu muc de tro ve dung cho cu.
const APP_ROOT = path.join(__dirname, "..", "..");


// ============================================================================
// PERSIST — lưu file JSON, không mất khi restart server
// Trên Vercel, /var/task chỉ đọc (read-only) — chỉ /tmp mới ghi được (nhưng /tmp
// không bền, có thể mất khi cold start / đổi instance). Local dev vẫn dùng ./data
// như cũ để dữ liệu bền thật sự giữa các lần chạy.
// ============================================================================
const IS_SERVERLESS = !!(process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME);
const DATA_DIR = IS_SERVERLESS
	? path.join(os.tmpdir(), "qdavy-data")
	: path.join(APP_ROOT, "data");
const NOTIF_FILE = path.join(DATA_DIR, "notifications.json");
const THRESHOLD_FILE = path.join(DATA_DIR, "thresholds.json");
const MAT_CONFIG_FILE = path.join(DATA_DIR, "material-config.json");

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
		// Tren Vercel, DATA_DIR nam trong /tmp va bi xoa sach moi lan cold start ->
		// thresholdStore rong -> getThresholdForIO() luon tra null -> KHONG PR NAO
		// leo CEO theo ngan sach IO. Da kiem chung: /api/thresholds tren production
		// tra {"byIO":{}} trong khi data/thresholds.json trong repo co du lieu.
		// Doc file trong repo lam gia tri khoi tao; sua qua man Cau hinh nguong van
		// ghi vao /tmp va van mat khi restart (muon ben that su phai luu len SAP
		// hoac 1 store ngoai — chua lam).
		const seedFile = path.join(APP_ROOT, "data", "thresholds.json");
		if (seedFile !== THRESHOLD_FILE && fs.existsSync(seedFile)) {
			try {
				const seed = JSON.parse(fs.readFileSync(seedFile, "utf8"));
				const byIO = seed.byIO && typeof seed.byIO === "object" ? seed.byIO : {};
				console.log("[DATA] Nap nguong IO tu repo (seed):", Object.keys(byIO).length);
				return { byIO: byIO };
			} catch (e) {
				console.error("⚠️ Doc seed thresholds THAT BAI:", e.message);
			}
		}
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

// ============================================================================
// DANH MUC CAU HINH VAT TU NOI BO: GIA KE HOACH + MA TAI SAN
// Ban ghi that nam tren SAP (bang Z ZG1_MAT_CONFIG) — phan duoi day chi la ban
// du phong trong ung dung, dung khi SAP chua san sang / loi. Xem
// src/services/material-config.service.js.
//
// Shape: { "MON-001": { assetClass, assets: [{ no, used, usedByPr }] } }
// GIA KHONG nam o day — gia cua vat tu lay tu material master (MM02, bang MBEW)
// qua MaterialSet.
// Moi lan mua 1 the tai san rieng nen `assets` la KHO MA: dung den dau danh dau
// den do. Chi tiet xem src/services/material-config.service.js.
// ============================================================================

function loadMaterialConfig() {
	ensureDataDir();
	if (!fs.existsSync(MAT_CONFIG_FILE)) {
		// Cung ly do voi thresholds: tren Vercel DATA_DIR nam trong /tmp va mat
		// khi cold start -> phai co ban seed commit trong repo, neu khong PR-01
		// se khong tu dien duoc ma nao tren production.
		const seedFile = path.join(APP_ROOT, "data", "material-config.json");
		if (seedFile !== MAT_CONFIG_FILE && fs.existsSync(seedFile)) {
			try {
				const seed = JSON.parse(fs.readFileSync(seedFile, "utf8"));
				const byMaterial = seed.byMaterial && typeof seed.byMaterial === "object" ? seed.byMaterial : {};
				console.log("[DATA] Nap cau hinh vat tu tu repo (seed):", Object.keys(byMaterial).length);
				return { byMaterial: byMaterial };
			} catch (e) {
				console.error("⚠️ Doc seed material-config THAT BAI:", e.message);
			}
		}
		return { byMaterial: {} };
	}
	try {
		const raw = JSON.parse(fs.readFileSync(MAT_CONFIG_FILE, "utf8"));
		return { byMaterial: raw.byMaterial && typeof raw.byMaterial === "object" ? raw.byMaterial : {} };
	} catch (e) {
		console.error("⚠️ Load material-config THAT BAI:", e.message);
		return { byMaterial: {} };
	}
}

function saveMaterialConfig() {
	ensureDataDir();
	fs.writeFileSync(MAT_CONFIG_FILE, JSON.stringify(materialConfigStore, null, 2), "utf8");
}

/**
 * Khoa tra cuu vat tu. SAP tra ma vat tu khi thi co so 0 dem dau khi thi khong
 * (da dinh 1 lan o isMaterialSelectable) — chuan hoa ve chu HOA, bo 0 dem dau
 * cho ma toan so, de "0000000MON-001" va "MON-001" van la 1.
 */
function normalizeMaterialKey(materialNo) {
	const s = String(materialNo || "").trim().toUpperCase();
	if (!s) { return ""; }
	return /^\d+$/.test(s) ? (s.replace(/^0+/, "") || "0") : s;
}

/** Cau hinh cua 1 vat tu: { assetClass, assets: [{no,used,usedByPr}] }. */
function configForMaterial(materialNo) {
	const key = normalizeMaterialKey(materialNo);
	const empty = { assetClass: "", assets: [] };
	if (!key) { return empty; }
	const raw = materialConfigStore.byMaterial[key];
	if (!raw) { return empty; }
	const assets = (Array.isArray(raw.assets) ? raw.assets : [])
		.map(function (a) {
			if (a && typeof a === "object") {
				return { no: String(a.no || "").trim(), used: !!a.used, usedByPr: String(a.usedByPr || "") };
			}
			return { no: String(a || "").trim(), used: false, usedByPr: "" };
		})
		.filter(function (a) { return a.no; });
	return {
		assetClass: String(raw.assetClass || "").trim().toUpperCase(),
		assets: assets
	};
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

const _loadedNotifs = loadNotifications();
const notificationStore = _loadedNotifs.items;
let nextNotificationId = _loadedNotifs.nextId;

const thresholdStore = loadThresholds();
const materialConfigStore = loadMaterialConfig();

console.log("[DATA] Loaded notif:", notificationStore.length);
console.log("[DATA] IO thresholds:", Object.keys(thresholdStore.byIO).length);
console.log("[DATA] Vat tu da cau hinh:", Object.keys(materialConfigStore.byMaterial).length);

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
module.exports = {
	DATA_DIR,
	configForMaterial,
	getThresholdForIO,
	normalizeMaterialKey,
	normalizeOrderNo,
	notificationStore,
	materialConfigStore,
	pushNotification,
	saveMaterialConfig,
	saveNotifications,
	saveThresholds,
	thresholdStore,
};
