/**
 * Cua duyet 2 (18/08/2026): CFO/CEO duyet Purchase Order TRUOC khi gui NCC.
 *
 * PO duoc tao that tren SAP ngay o PO-01 nhung o trang thai "cho release"
 * (RfqSet.Status = PO_CREATED) — mail cho NCC CHI duoc gui khi CFO/CEO duyet
 * (PO_RELEASED). Day la mo phong PO Release (ME29N) o tang ung dung; chua cau
 * hinh release strategy chuan (can classification CT04/CL02) — noi thang khi
 * bao ve, dung nhan la da co.
 *
 * Store file JSON (cung pattern notifications/thresholds trong lib/store.js):
 * luu payload mail nguoi mua da nhap o PO-01 (dia chi giao hang, nguoi nhan...)
 * de buoc release dung lai. Tren Vercel file nam /tmp co the mat khi cold
 * start -> moi ham deu co duong FALLBACK dung du lieu SAP that (so PO tu EBAN
 * qua attachPoNumbers, email NCC tu VendorSet, gia phan bo tu FinalValue).
 */


const fs = require("fs");
const path = require("path");
const { ORG_DEFAULTS } = require("../config/org");
const { odataEscape, sapWrite } = require("../lib/sap-client");
const { DATA_DIR } = require("../lib/store");
const { sendPOEmailToVendor } = require("./po-mail.service");
const { itemsOfRfq, normalizeLineNo, parseItemLines } = require("./rfq.service");
const { fetchAllVendorsFromSAP } = require("./vendor.service");

const RELEASE_FILE = path.join(DATA_DIR, "po-pending-release.json");


function loadReleaseStore() {
	try {
		if (fs.existsSync(RELEASE_FILE)) {
			return JSON.parse(fs.readFileSync(RELEASE_FILE, "utf8")) || {};
		}
	} catch (e) {
		console.error("[po-approval] Doc " + RELEASE_FILE + " that bai:", e.message);
	}
	return {};
}

function saveReleaseStore(store) {
	try {
		fs.mkdirSync(path.dirname(RELEASE_FILE), { recursive: true });
		fs.writeFileSync(RELEASE_FILE, JSON.stringify(store, null, 2), "utf8");
	} catch (e) {
		console.error("[po-approval] Ghi " + RELEASE_FILE + " that bai:", e.message);
	}
}

/**
 * Key cua 1 "don cho release": theo RfqId (moi nhom NCC 1 PO). PR khong di qua
 * RFQ (hiem, luong cu) thi key theo so PR.
 */
function releaseKey(rfqId, prNumber) {
	const r = String(rfqId || "").trim();
	return r ? r : "pr-" + String(prNumber || "").trim();
}

function savePendingRelease(key, payload) {
	const store = loadReleaseStore();
	store[key] = Object.assign({ savedAt: new Date().toISOString() }, payload);
	saveReleaseStore(store);
}

function getPendingRelease(key) {
	const store = loadReleaseStore();
	return store[key] || null;
}

/**
 * So PO cua 1 nhom, suy tu EBAN: attachPoNumbers() phai chay truoc de gan
 * it.PoNumber vao tung dong cua PR; o day chi loc theo ItemLines cua nhom.
 */
function poNumberForGroup(pr, itemLines) {
	const lines = parseItemLines(itemLines);
	const items = (pr && pr.items) || [];
	const distinct = [];
	items.forEach(function (it) {
		if (lines.length > 0 && lines.indexOf(normalizeLineNo(it.LineNo)) === -1) { return; }
		const po = String(it.PoNumber || "").trim();
		if (po && distinct.indexOf(po) === -1) { distinct.push(po); }
	});
	return distinct.join(", ");
}

/** Email NCC tu VendorSet (fallback khi store mat). */
async function vendorEmailOf(vendorNo) {
	if (!vendorNo) { return ""; }
	try {
		const all = await fetchAllVendorsFromSAP();
		const v = (all || []).find(function (x) { return String(x.VendorNo) === String(vendorNo); });
		return v ? String(v.Email || v.VendorEmail || "").trim() : "";
	} catch (e) {
		console.error("[po-approval] Doc VendorSet that bai:", e.message);
		return "";
	}
}

/**
 * Payload mail toi thieu khi store mat: dong hang tu PR (loc theo nhom), don
 * gia phan bo tu FinalValue theo ty le gia uoc tinh (cung cach PO-01 lam tren
 * FE). Cac truong logistics (dia chi giao, nguoi nhan...) de trong — chap nhan
 * duoc cho mail fallback, con duong chinh la payload da luu luc tao PO.
 */
function buildFallbackMail(pr, group) {
	const groupItems = group ? itemsOfRfq(group, (pr && pr.items) || []) : ((pr && pr.items) || []);
	const est = groupItems.reduce(function (sum, it) { return sum + (Number(it.EstimatedValue) || 0); }, 0);
	const finalValue = Number(group && group.FinalValue)
		|| Number(pr && pr.RfqFinalValue)
		|| est;

	const items = groupItems.map(function (it) {
		const share = est > 0 ? finalValue * (Number(it.EstimatedValue) || 0) / est : 0;
		const qty = Number(it.Quantity) || 1;
		return {
			materialNo: it.MaterialNo || "",
			description: it.Description || "",
			quantity: it.Quantity,
			uom: it.UoM || "",
			netPrice: qty > 0 ? Math.round(share / qty) : Math.round(share)
		};
	});

	return {
		items: items,
		currency: (group && group.Currency) || (pr && pr.Currency) || ORG_DEFAULTS.currency,
		docDate: new Date().toISOString().split("T")[0],
		companyCode: ORG_DEFAULTS.companyCode,
		buyerName: "",
		buyerPhone: "",
		deliveryAddress: "",
		receiverName: "",
		receiverPhone: "",
		deliveryDate: "",
		paymentMethod: "",
		paymentTerms: ""
	};
}

/**
 * Release 1 nhom: RfqSet -> PO_RELEASED + gui mail PO cho NCC.
 * group = null khi PR khong di qua RFQ. Loi gui mail KHONG lam fail release —
 * trang thai da doi, mail bao lai duoc bang tay; tra co emailSent de FE canh bao.
 */
async function releaseGroup(pr, group, session) {
	const key = releaseKey(group && group.RfqId, pr.PRId);
	const pending = getPendingRelease(key);

	const poNumber = (pending && pending.poNumber)
		|| poNumberForGroup(pr, group && group.ItemLines)
		|| "";
	const vendorNo = (pending && pending.vendorNo)
		|| (group && group.AwardedVendor)
		|| "";
	let vendorEmail = (pending && pending.vendorEmail) || "";
	if (!vendorEmail) { vendorEmail = await vendorEmailOf(vendorNo); }
	const mailData = (pending && pending.mail) || buildFallbackMail(pr, group);

	if (group && group.RfqId) {
		await sapWrite("MERGE", `RfqSet('${odataEscape(String(group.RfqId))}')`, { Status: "PO_RELEASED" }, session);
	}

	let emailSent = false;
	try {
		emailSent = await sendPOEmailToVendor(vendorEmail, poNumber || ("PR " + pr.PRId), mailData);
	} catch (e) {
		console.error("[po-approval] Gui mail PO " + poNumber + " that bai:", e.message);
	}

	return {
		rfqId: (group && group.RfqId) || "",
		poNumber: poNumber,
		vendorNo: String(vendorNo || ""),
		vendorEmail: vendorEmail || "",
		emailSent: emailSent
	};
}
module.exports = {
	buildFallbackMail,
	getPendingRelease,
	poNumberForGroup,
	releaseGroup,
	releaseKey,
	savePendingRelease,
};
