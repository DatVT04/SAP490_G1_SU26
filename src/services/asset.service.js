/**
 * GAN THE TAI SAN cho vat tu da mua ve (buoc sau khi nhan hang).
 *
 * Vi sao co buoc nay: truoc 21/08/2026 he thong khai san ma tai san cho tung vat
 * tu trong data/asset-map.json roi PR-01 tu dien vao — tuc la GIA DINH moi vat tu
 * duoc phep mua deu da la tai san cua cong ty. Thuc te nguoc lai: mua ve roi moi
 * sinh the tai san. Nen PR-01 da bo han o nhap tai san, va viec gan the chuyen
 * sang day, do BO PHAN MUA SAM lam sau khi don hang da tao — ho la nguoi nhan
 * hang va da theo de nghi tu dau nen biet mon hang thuc te ve la cai gi.
 *
 * SAP khong co lien ket san giua Material (MM) va Asset (FI-AA) — 2 module khac
 * nhau, khong bang nao noi. Nen the tai san phai duoc TAO ra (AS01 /
 * BAPI_FIXEDASSET_CREATE1) roi ung dung tu luu lai quan he "dong PR nay -> the
 * tai san nao".
 *
 * Moi DON VI SO LUONG = 1 the tai san rieng (mua 3 man hinh = 3 the), dung nhu
 * cach FI-AA quan ly tai san vat ly.
 *
 * Luu quan he o dau: uu tien ghi nguoc AssetNo vao dong cua PrDraftItemSet tren
 * SAP (field da co san, dang bo trong tu 21/08). Neu SAP chua co method
 * UPDATE_ENTITY cho item thi lui ve file registry o DATA_DIR — luu y tren Vercel
 * DATA_DIR nam trong /tmp nen mat khi cold start, do la ly do duong SAP moi la
 * duong chinh.
 */


const fs = require("fs");
const path = require("path");
const { ORG_DEFAULTS } = require("../config/org");
const { extractSapErrorMessage, odataEscape, sapWrite } = require("../lib/sap-client");
const { DATA_DIR } = require("../lib/store");
const { attachPoNumbers, fetchPrDraftById, fetchPrDraftList } = require("./pr.service");

const REGISTRY_FILE = path.join(DATA_DIR, "asset-registry.json");

/** Loai vat tu duoc coi la tai san — con lai (ZSRV) la dich vu, khong len the. */
const ASSET_MATERIAL_TYPE = "ZAST";

/** Nhom tai san mac dinh khi tao the. Z100 = IT Equipment (da xac minh 14/08). */
const DEFAULT_ASSET_CLASS = process.env.SAP_ASSET_CLASS || "Z100";


// ── REGISTRY DU PHONG ───────────────────────────────────────────────────────

function loadRegistry() {
	try {
		if (fs.existsSync(REGISTRY_FILE)) {
			return JSON.parse(fs.readFileSync(REGISTRY_FILE, "utf8")) || {};
		}
	} catch (e) {
		console.error("[asset] Doc " + REGISTRY_FILE + " that bai:", e.message);
	}
	return {};
}

function saveRegistry(store) {
	try {
		fs.mkdirSync(path.dirname(REGISTRY_FILE), { recursive: true });
		fs.writeFileSync(REGISTRY_FILE, JSON.stringify(store, null, 2), "utf8");
	} catch (e) {
		console.error("[asset] Ghi " + REGISTRY_FILE + " that bai:", e.message);
	}
}

function registryKey(internalId, lineNo) {
	return String(internalId || "").trim() + "|" + normalizeLine(lineNo);
}

/**
 * SAP tra ve so tai san co dem 0 dau theo kieu ALPHA: "000000100008" (da kiem
 * chung tren Gateway Client 21/08). Nguoi dung go vao AS03 la "100008", nen bo
 * 0 cho khop voi cai ho nhin thay trong SAP GUI — dung nhu cach normalizeLine()
 * xu ly so dong.
 */
function displayAssetNo(value) {
	const s = String(value == null ? "" : value).trim();
	if (!s) { return ""; }
	return /^\d+$/.test(s) ? String(Number(s)) : s;
}

function normalizeLine(lineNo) {
	const s = String(lineNo == null ? "" : lineNo).trim();
	if (!s) { return ""; }
	return /^\d+$/.test(s) ? String(Number(s)) : s;
}

/** Cac ma tai san da gan cho 1 dong — gop ca nguon SAP lan registry, bo trung. */
function assetsOfLine(item, internalId) {
	const fromSap = String((item && item.AssetNo) || "")
		.split(",")
		.map(displayAssetNo)
		.filter(Boolean);
	const fromLocal = (loadRegistry()[registryKey(internalId, item && item.LineNo)] || [])
		.map(function (r) { return displayAssetNo(r.assetNo); })
		.filter(Boolean);
	const all = [];
	fromSap.concat(fromLocal).forEach(function (a) {
		if (all.indexOf(a) === -1) { all.push(a); }
	});
	return all;
}

function recordAssets(internalId, lineNo, rows) {
	const store = loadRegistry();
	const key = registryKey(internalId, lineNo);
	store[key] = (store[key] || []).concat(rows);
	saveRegistry(store);
}


// ── DANH SACH DONG CHO GAN TAI SAN ──────────────────────────────────────────

/**
 * Cac dong vat tu tai san cua nhung de nghi DA TAO DON HANG (PO_CREATED) — tuc
 * la hang da dat, sap ve hoac da ve. Dong nao da du the tai san theo so luong
 * thi coi nhu xong va khong tra ve nua.
 */
async function fetchPendingAssetLines() {
	const prs = (await fetchPrDraftList(`Status eq 'PO_CREATED'`))
		.filter(function (pr) { return String(pr.Status || "").toUpperCase() === "PO_CREATED"; });

	const rows = [];
	for (const pr of prs) {
		// So PO that doc tu EBAN — de ke toan doi chieu chung tu khi tao the.
		try { await attachPoNumbers(pr); } catch (e) {
			console.error("[asset] attachPoNumbers " + pr.PRId + ":", e.message);
		}

		(pr.items || []).forEach(function (it) {
			if (String(it.MaterialType || "").toUpperCase() !== ASSET_MATERIAL_TYPE) { return; }
			const assigned = assetsOfLine(it, pr.InternalId);
			const qty = Math.max(1, Math.floor(Number(it.Quantity) || 0));
			rows.push({
				InternalId: pr.InternalId,
				PRId: pr.PRId,
				SapPRId: pr.SapPRId || "",
				DisplayId: pr.DisplayId || pr.PRId,
				PoNumber: String(it.PoNumber || pr.PoNumberText || "").trim(),
				LineNo: normalizeLine(it.LineNo),
				// Ban NGUYEN VAN SAP tra ve — dung lam key khi MERGE nguoc lai
				// PrDraftItemSet. Tu pad ve 5 ky tu la doan mo: bang co the luu '1'
				// chu khong phai '00001', doan sai thi MERGE khong trung dong nao.
				RawLineNo: String(it.LineNo == null ? "" : it.LineNo),
				MaterialNo: it.MaterialNo || "",
				Description: it.Description || "",
				Quantity: qty,
				UoM: it.UoM || "",
				CostCenter: it.CostCenter || "",
				Currency: pr.Currency || ORG_DEFAULTS.currency,
				RequesterEmail: pr.RequesterEmail || "",
				UpdatedAt: pr.UpdatedAt || pr.CreatedAt || "",
				AssignedAssets: assigned,
				Remaining: Math.max(0, qty - assigned.length)
			});
		});
	}

	// Dong chua gan du len truoc — day moi la viec phai lam.
	rows.sort(function (a, b) {
		if ((b.Remaining > 0) !== (a.Remaining > 0)) { return b.Remaining - a.Remaining; }
		return new Date(b.UpdatedAt || 0) - new Date(a.UpdatedAt || 0);
	});
	return rows;
}


// ── TAO THE TAI SAN TREN SAP ────────────────────────────────────────────────

/**
 * Tao 1 the tai san. Entity AssetSet ben SAP goi BAPI_FIXEDASSET_CREATE1 rồi
 * BAPI_TRANSACTION_COMMIT, tra ve so tai san do SAP tu danh (internal numbering
 * theo asset class) — xem HUONG_DAN_SAP_ASSETSET.md.
 */
async function createOneAsset(payload, session) {
	const body = {
		AssetNo: "",
		SubNo: "0000",
		CompanyCode: payload.companyCode || ORG_DEFAULTS.companyCode,
		AssetClass: payload.assetClass || DEFAULT_ASSET_CLASS,
		Description: String(payload.description || "").substring(0, 50),
		InventoryNo: String(payload.inventoryNo || "").substring(0, 25),
		CostCenter: String(payload.costCenter || "").substring(0, 10),
		CapitalizedOn: payload.capitalizedOn || new Date().toISOString().split("T")[0],
		MaterialNo: String(payload.materialNo || "").substring(0, 18)
	};
	const resp = await sapWrite("POST", "AssetSet", body, session);
	const created = resp.data && resp.data.d;
	const assetNo = displayAssetNo(created && created.AssetNo);
	if (!assetNo) {
		throw new Error("SAP khong tra ve so tai san sau khi tao the.");
	}
	return { assetNo: assetNo, subNo: String((created && created.SubNo) || "0000"), raw: created };
}

/**
 * Ghi nguoc cac so tai san vao dong cua de nghi tren SAP.
 * KHONG nem loi: the tai san da duoc tao that roi, khong duoc phep vi buoc ghi
 * nguoc that bai ma bao ca thao tac hong. Tra ve true/false de route bao lai FE.
 */
async function writeAssetNoToSap(internalId, rawLineNo, assetNos, session) {
	try {
		await sapWrite(
			"MERGE",
			`PrDraftItemSet(InternalId='${odataEscape(String(internalId))}',LineNo='${odataEscape(String(rawLineNo))}')`,
			// Cot ASSETNO tren ZPR_DRAFT_ITEM da noi len CHAR 200 (22/08) — mot dong
			// so luong 5 can 34 ky tu, ban cu gioi han 40 la vua du cho 5-6 ma roi
			// cat cut am tham. Cat o 200 cho khop dung do dai cot.
			{ AssetNo: assetNos.join(",").substring(0, 200) },
			session
		);
		return true;
	} catch (error) {
		console.error("[asset] Ghi AssetNo vao PrDraftItemSet that bai (dung registry du phong):",
			extractSapErrorMessage(error));
		return false;
	}
}

/**
 * Tao N the tai san cho 1 dong de nghi. Tao tung the mot: the nao xong la chac
 * chan xong, hong o the thu k thi k-1 the truoc do van con — tra ve danh sach da
 * tao kem loi de ke toan biet phai lam tiep bao nhieu the.
 */
async function createAssetsForLine(options) {
	const line = await findLine(options.prId, options.lineNo);
	if (!line) {
		const e = new Error("Khong tim thay dong " + options.lineNo + " trong de nghi " + options.prId + ".");
		e.statusCode = 404;
		throw e;
	}
	if (line.Remaining <= 0) {
		const e = new Error("Dong nay da gan du " + line.Quantity + " the tai san.");
		e.statusCode = 400;
		throw e;
	}

	const want = Math.min(
		Math.max(1, Math.floor(Number(options.count) || 1)),
		line.Remaining
	);

	const created = [];
	let failure = null;
	for (let i = 0; i < want; i++) {
		try {
			const one = await createOneAsset({
				description: options.description || line.Description,
				costCenter: options.costCenter || line.CostCenter,
				capitalizedOn: options.capitalizedOn,
				assetClass: options.assetClass,
				materialNo: line.MaterialNo,
				// Truy vet nguoc ve chung tu mua: so PO (hoac so PR khi chua doc duoc PO).
				inventoryNo: line.PoNumber || line.SapPRId || line.PRId
			});
			created.push({
				assetNo: one.assetNo,
				subNo: one.subNo,
				createdAt: new Date().toISOString(),
				createdBy: options.createdByEmail || "",
				description: options.description || line.Description
			});
		} catch (error) {
			failure = extractSapErrorMessage(error);
			break;
		}
	}

	if (created.length > 0) {
		recordAssets(line.InternalId, line.LineNo, created);
	}

	let savedToSap = false;
	if (created.length > 0) {
		const all = line.AssignedAssets.concat(created.map(function (c) { return c.assetNo; }));
		savedToSap = await writeAssetNoToSap(line.InternalId, line.RawLineNo || line.LineNo, all);
	}

	return {
		created: created,
		savedToSap: savedToSap,
		remaining: Math.max(0, line.Remaining - created.length),
		error: failure
	};
}

/** Doc lai 1 dong tu SAP (khong tin so lieu FE gui len). */
async function findLine(prId, lineNo) {
	const pr = await fetchPrDraftById(prId);
	if (!pr) { return null; }
	try { await attachPoNumbers(pr); } catch (e) {
		console.error("[asset] attachPoNumbers " + prId + ":", e.message);
	}
	const want = normalizeLine(lineNo);
	const it = (pr.items || []).find(function (row) { return normalizeLine(row.LineNo) === want; });
	if (!it) { return null; }
	if (String(it.MaterialType || "").toUpperCase() !== ASSET_MATERIAL_TYPE) {
		const e = new Error("Dong " + lineNo + " khong phai vat tu tai san (ZAST) nen khong tao the tai san.");
		e.statusCode = 400;
		throw e;
	}
	const assigned = assetsOfLine(it, pr.InternalId);
	const qty = Math.max(1, Math.floor(Number(it.Quantity) || 0));
	return {
		InternalId: pr.InternalId,
		PRId: pr.PRId,
		SapPRId: pr.SapPRId || "",
		PoNumber: String(it.PoNumber || pr.PoNumberText || "").trim(),
		LineNo: normalizeLine(it.LineNo),
		RawLineNo: String(it.LineNo == null ? "" : it.LineNo),
		MaterialNo: it.MaterialNo || "",
		Description: it.Description || "",
		CostCenter: it.CostCenter || "",
		Quantity: qty,
		AssignedAssets: assigned,
		Remaining: Math.max(0, qty - assigned.length)
	};
}
module.exports = {
	ASSET_MATERIAL_TYPE,
	displayAssetNo,
	DEFAULT_ASSET_CLASS,
	createAssetsForLine,
	fetchPendingAssetLines,
	findLine,
};
