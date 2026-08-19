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
const ASSET_MAP_FILE = path.join(DATA_DIR, "asset-map.json");

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
// ANH XA VAT TU (ZAST) -> MA TAI SAN
// SAP khong co lien ket san giua Material va Asset (2 module khac nhau: MM va
// FI-AA), nen quan he "vat tu nay chinh la tai san nao" phai do Ke toan khai —
// dung y nghia voi Info Record khai "vat tu nay mua cua NCC nao". Danh muc nay
// la nguon de PR-01 tu dien o Asset.
//
// 1 vat tu co the ung nhieu ma tai san (mua 3 man hinh = 3 the tai san rieng),
// nen gia tri luu duoi dang MANG. Nhan ca chuoi don cho de sua tay file.
// ============================================================================

function loadAssetMap() {
	ensureDataDir();
	if (!fs.existsSync(ASSET_MAP_FILE)) {
		// Cung ly do voi thresholds: tren Vercel DATA_DIR nam trong /tmp va mat
		// khi cold start -> phai co ban seed commit trong repo, neu khong PR-01
		// se khong tu dien duoc ma nao tren production.
		const seedFile = path.join(APP_ROOT, "data", "asset-map.json");
		if (seedFile !== ASSET_MAP_FILE && fs.existsSync(seedFile)) {
			try {
				const seed = JSON.parse(fs.readFileSync(seedFile, "utf8"));
				const byMaterial = seed.byMaterial && typeof seed.byMaterial === "object" ? seed.byMaterial : {};
				console.log("[DATA] Nap anh xa vat tu-tai san tu repo (seed):", Object.keys(byMaterial).length);
				return { byMaterial: byMaterial };
			} catch (e) {
				console.error("⚠️ Doc seed asset-map THAT BAI:", e.message);
			}
		}
		return { byMaterial: {} };
	}
	try {
		const raw = JSON.parse(fs.readFileSync(ASSET_MAP_FILE, "utf8"));
		return { byMaterial: raw.byMaterial && typeof raw.byMaterial === "object" ? raw.byMaterial : {} };
	} catch (e) {
		console.error("⚠️ Load asset-map THAT BAI:", e.message);
		return { byMaterial: {} };
	}
}

function saveAssetMap() {
	ensureDataDir();
	fs.writeFileSync(ASSET_MAP_FILE, JSON.stringify(assetMapStore, null, 2), "utf8");
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

/** Mang ma tai san cua 1 vat tu ([] neu chua khai). */
function assetsForMaterial(materialNo) {
	const key = normalizeMaterialKey(materialNo);
	if (!key) { return []; }
	const raw = assetMapStore.byMaterial[key];
	if (raw == null || raw === "") { return []; }
	const list = Array.isArray(raw) ? raw : String(raw).split(",");
	return list
		.map(function (x) { return String(x || "").trim(); })
		.filter(Boolean);
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
const assetMapStore = loadAssetMap();

console.log("[DATA] Loaded notif:", notificationStore.length);
console.log("[DATA] IO thresholds:", Object.keys(thresholdStore.byIO).length);
console.log("[DATA] Vat tu co ma tai san:", Object.keys(assetMapStore.byMaterial).length);

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
	assetMapStore,
	assetsForMaterial,
	getThresholdForIO,
	normalizeMaterialKey,
	normalizeOrderNo,
	notificationStore,
	pushNotification,
	saveAssetMap,
	saveNotifications,
	saveThresholds,
	thresholdStore,
};
