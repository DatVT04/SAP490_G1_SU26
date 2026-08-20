/**
 * Danh muc tai san cua vat tu: NHOM TAI SAN + KHO MA TAI SAN.
 *
 * GIA thi KHONG nam o day: gia lay tu MATERIAL MASTER (MM02 -> view Accounting 1
 * -> Standard price, bang MBEW), tra ve qua MaterialSet. Do la cho SAP chuan de
 * gia cua vat tu, va la cau tra loi khong ai chat van duoc; bang Z chi giu thu
 * SAP that su khong co.
 *
 * NGUON CHINH: bang Z tren SAP `ZG1_MAT_CONFIG`, doc/ghi qua entity
 * `MatConfigSet` cua ZG1_PROC_SRV_SRV (xem HUONG_DAN_SAP_ZG1_MAT_CONFIG.md).
 *
 * ── VI SAO KHO MA CHU KHONG PHAI 1 VAT TU = 1 MA TAI SAN ──────────────────
 * Moi tai san vat ly la 1 the tai san rieng trong FI-AA: mua them cai man hinh
 * thu hai thi no la tai san MOI, so moi, khau hao rieng — khong duoc dung lai
 * so cu. Nen cai CO DINH theo vat tu chi la NHOM TAI SAN (asset class, quyet
 * dinh tai khoan + thoi gian khau hao); con so tai san thi moi lan mua cap 1 so
 * moi.
 *
 * Cach lam o day: Ke toan tao san mot loat the tai san bang AS01 theo nhom,
 * khai vao bang Z lam "kho ma". PR-01 lay cac ma CHUA DUNG dien vao; khi PR
 * that duoc tao tren SAP thi danh dau da dung kem so PR — lan mua sau tu lay ma
 * ke tiep, khong bao gio trung.
 *
 * Danh dau o thoi diem TAO PR THAT (Purchasing duyet) chu khong phai luc gui de
 * nghi: de nghi bi tu choi thi khong dot ma nao. Doi lai, 2 de nghi lap gan nhau
 * co the cung nhin thay 1 ma trong khi chua ai duyet — voi quy mo hien tai chap
 * nhan duoc, va nguoi duyet van thay so tren man hinh truoc khi bam.
 *
 * DUONG LUI: SAP chua san sang / loi thi tu quay ve file JSON trong app
 * (`data/material-config.json` + DATA_DIR). Moi ham tra kem `storage`:
 * "sap" | "app" de FE noi ro dang doc-ghi vao dau.
 *
 * Ghi bang MERGE chu khong POST: simple <EntitySet>_CREATE_ENTITY bi Gateway tu
 * choi khi goi qua Basic Auth (xac nhan 14/08). Method UPDATE_ENTITY ben ABAP
 * dung `MODIFY` nen MERGE vua tao moi vua cap nhat duoc.
 */


const { materialConfigStore, normalizeMaterialKey, saveMaterialConfig } = require("../lib/store");
const { extractSapErrorMessage, odataEscape, sapFetchCsrfToken, sapRead, sapWrite } = require("../lib/sap-client");

const ENTITY_SET = "MatConfigSet";

/** So thu tu dong trong 1 vat tu: 0 -> "001" (khop kieu NUMC3 ben SAP). */
function seqOf(index) {
	return String(index + 1).padStart(3, "0");
}

function keyPath(materialNo, seqNo) {
	return `${ENTITY_SET}(MaterialNo='${odataEscape(materialNo)}',SeqNo='${odataEscape(seqNo)}')`;
}

function sapStamp() {
	return new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14);
}

function emptyEntry() {
	return { assetClass: "", assets: [] };
}

/** Chuan hoa 1 muc cau hinh ve dung shape chuan (nhan ca ban cu de tuong thich). */
function normalizeEntry(raw) {
	const src = raw || {};
	const assets = (Array.isArray(src.assets) ? src.assets : String(src.assets == null ? "" : src.assets).split(","))
		.map(function (a) {
			// Nhan ca chuoi ("100000") lan object ({no, used, usedByPr}).
			if (a && typeof a === "object") {
				return {
					no: String(a.no || "").trim(),
					used: !!a.used,
					usedByPr: String(a.usedByPr || "").trim()
				};
			}
			return { no: String(a || "").trim(), used: false, usedByPr: "" };
		})
		.filter(function (a) { return a.no; });

	return {
		assetClass: String(src.assetClass || "").trim().toUpperCase(),
		assets: assets
	};
}

/** Cac ma tai san CHUA dung cua 1 vat tu — day la thu PR-01 duoc phep dien. */
function freeAssetsOf(entry) {
	return ((entry && entry.assets) || [])
		.filter(function (a) { return !a.used; })
		.map(function (a) { return a.no; });
}

/** Cac dong tren SAP -> { "MON-001": { assetClass, price, currency, assets: [...] } } */
function rowsToByMaterial(rows) {
	const byMaterial = {};
	(rows || [])
		.slice()
		.sort(function (a, b) {
			return String(a.SeqNo || "").localeCompare(String(b.SeqNo || ""));
		})
		.forEach(function (row) {
			const key = normalizeMaterialKey(row.MaterialNo);
			if (!key) { return; }
			if (!byMaterial[key]) { byMaterial[key] = emptyEntry(); }
			const entry = byMaterial[key];

			// Nhom tai san lap lai tren moi dong cua cung vat tu — lay tu dong dau
			// tien doc duoc (xem ghi chu thiet ke trong huong dan SAP).
			if (!entry.assetClass && row.AssetClass) {
				entry.assetClass = String(row.AssetClass).trim().toUpperCase();
			}

			const assetNo = String(row.AssetNo || "").trim();
			if (assetNo) {
				entry.assets.push({
					no: assetNo,
					used: String(row.UsedFlag || "").trim().toUpperCase() === "X",
					usedByPr: String(row.UsedByPr || "").trim()
				});
			}
		});
	return byMaterial;
}

/** Doc danh muc. Uu tien SAP, loi thi quay ve ban trong app. */
async function loadMaterialConfig() {
	if (!process.env.SAP_HOST) {
		return { storage: "app", byMaterial: materialConfigStore.byMaterial };
	}
	try {
		const resp = await sapRead(ENTITY_SET);
		const rows = (resp.data && resp.data.d && resp.data.d.results) || [];
		const byMaterial = rowsToByMaterial(rows);
		// Cache lai: lat sau SAP loi thi PR-01 van co du lieu tuong doi moi.
		materialConfigStore.byMaterial = byMaterial;
		try { saveMaterialConfig(); } catch (e) { /* cache loi khong lam hong luong chinh */ }
		return { storage: "sap", byMaterial: byMaterial };
	} catch (error) {
		console.error("[material-config] Doc MatConfigSet that bai, dung ban trong app:", extractSapErrorMessage(error));
		return {
			storage: "app",
			byMaterial: materialConfigStore.byMaterial,
			warning: "Chua doc duoc bang ZG1_MAT_CONFIG tren SAP — dang hien ban luu trong ung dung."
		};
	}
}

/** Ghi toan bo cac dong cua 1 vat tu len SAP (da tinh san thu tu). */
async function writeMaterialRows(key, entry, changedBy, existingSeqs, session) {
	const stamp = sapStamp();
	// Vat tu khai nhom tai san nhung chua co ma nao van giu 1 dong.
	const rowCount = Math.max(entry.assets.length, (entry.assetClass ? 1 : 0));

	for (let i = 0; i < rowCount; i++) {
		const asset = entry.assets[i] || { no: "", used: false, usedByPr: "" };
		await sapWrite("MERGE", keyPath(key, seqOf(i)), {
			MaterialNo: key,
			SeqNo: seqOf(i),
			AssetNo: asset.no,
			AssetClass: entry.assetClass,
			UsedFlag: asset.used ? "X" : "",
			UsedByPr: asset.usedByPr || "",
			ChangedBy: String(changedBy || "").slice(0, 100),
			ChangedAt: stamp
		}, session);
	}

	for (const seq of (existingSeqs || [])) {
		if (Number(seq) > rowCount) {
			await sapWrite("DELETE", keyPath(key, seq), undefined, session);
		}
	}
}

/** Map ma tai san -> { used, usedByPr } de giu nguyen dau da dung khi ghi lai. */
function usedMapOf(entry) {
	const map = {};
	((entry && entry.assets) || []).forEach(function (a) {
		if (a.used) { map[a.no] = a.usedByPr || ""; }
	});
	return map;
}

/**
 * Ghi cau hinh. `byMaterial` = { materialNo: { assetClass, assets } }.
 * `assets` tu man Cau hinh chi la cac ma CHUA DUNG — cac ma DA DUNG duoc giu lai
 * nguyen ven o day, khong de ai lo xoa mat dau vet tai san da mua.
 */
async function saveMaterialConfigTo(byMaterial, changedBy) {
	const current = (await loadMaterialConfig()).byMaterial || {};

	const normalized = {};
	Object.keys(byMaterial || {}).forEach(function (mat) {
		const key = normalizeMaterialKey(mat);
		if (!key) { return; }

		const incoming = normalizeEntry(byMaterial[mat]);
		const existing = normalizeEntry(current[key] || {});
		const usedMap = usedMapOf(existing);

		// Cac ma da dung xep truoc (giu nguyen thu tu), roi toi cac ma con trong.
		const kept = existing.assets.filter(function (a) { return a.used; });
		const incomingFree = incoming.assets
			.filter(function (a) { return !usedMap[a.no]; })
			.map(function (a) { return { no: a.no, used: false, usedByPr: "" }; });

		normalized[key] = {
			assetClass: incoming.assetClass,
			assets: kept.concat(incomingFree)
		};
	});

	// Cap nhat ban trong app truoc: du SAP loi thi man hinh van giu thay doi.
	Object.keys(normalized).forEach(function (key) {
		const entry = normalized[key];
		if (entry.assets.length === 0 && !entry.assetClass) {
			delete materialConfigStore.byMaterial[key];
		} else {
			materialConfigStore.byMaterial[key] = entry;
		}
	});
	saveMaterialConfig();

	if (!process.env.SAP_HOST) {
		return { storage: "app", byMaterial: materialConfigStore.byMaterial };
	}

	try {
		// Doc truoc de biet dong nao dang co: bo bot ma thi cac dong thua PHAI xoa.
		const beforeResp = await sapRead(ENTITY_SET);
		const beforeRows = (beforeResp.data && beforeResp.data.d && beforeResp.data.d.results) || [];
		const existingSeqs = {};
		beforeRows.forEach(function (row) {
			const key = normalizeMaterialKey(row.MaterialNo);
			if (!key) { return; }
			if (!existingSeqs[key]) { existingSeqs[key] = []; }
			existingSeqs[key].push(String(row.SeqNo || ""));
		});

		const session = await sapFetchCsrfToken();
		for (const key of Object.keys(normalized)) {
			await writeMaterialRows(key, normalized[key], changedBy, existingSeqs[key], session);
		}

		const after = await loadMaterialConfig();
		return { storage: "sap", byMaterial: after.byMaterial };
	} catch (error) {
		const message = extractSapErrorMessage(error);
		console.error("[material-config] Ghi MatConfigSet that bai, chi luu trong app:", message);
		return {
			storage: "app",
			byMaterial: materialConfigStore.byMaterial,
			warning: "Chua ghi duoc len bang ZG1_MAT_CONFIG tren SAP (" + message
				+ "). Thay doi dang chi luu trong ung dung."
		};
	}
}

/**
 * Danh dau cac ma tai san da duoc dung boi 1 PR that. Goi SAU khi PR duoc tao
 * thanh cong tren SAP (Purchasing duyet) — de nghi bi tu choi khong dot ma nao.
 *
 * KHONG nem loi: PR da tao tren SAP roi, danh dau that bai thi chi la kho ma
 * chua cap nhat, khong duoc phep lam hong ket qua duyet. Tra ve so ma da danh
 * dau de route ghi log.
 */
async function markAssetsUsed(usageList, prNumber) {
	const wanted = {};
	(usageList || []).forEach(function (u) {
		const key = normalizeMaterialKey(u && u.materialNo);
		const no = String((u && u.assetNo) || "").trim();
		if (!key || !no) { return; }
		if (!wanted[key]) { wanted[key] = []; }
		if (wanted[key].indexOf(no) === -1) { wanted[key].push(no); }
	});
	if (Object.keys(wanted).length === 0) { return 0; }

	const current = (await loadMaterialConfig()).byMaterial || {};
	const stamp = sapStamp();
	let marked = 0;

	// Cap nhat ban trong app truoc (luon lam duoc, ke ca khi chua co bang Z).
	Object.keys(wanted).forEach(function (key) {
		const entry = normalizeEntry(current[key] || {});
		entry.assets.forEach(function (a) {
			if (!a.used && wanted[key].indexOf(a.no) !== -1) {
				a.used = true;
				a.usedByPr = String(prNumber || "");
				marked += 1;
			}
		});
		materialConfigStore.byMaterial[key] = entry;
	});
	saveMaterialConfig();

	if (!process.env.SAP_HOST || marked === 0) { return marked; }

	try {
		const resp = await sapRead(ENTITY_SET);
		const rows = (resp.data && resp.data.d && resp.data.d.results) || [];
		const session = await sapFetchCsrfToken();

		for (const row of rows) {
			const key = normalizeMaterialKey(row.MaterialNo);
			const no = String(row.AssetNo || "").trim();
			if (!key || !no) { continue; }
			if (!wanted[key] || wanted[key].indexOf(no) === -1) { continue; }
			if (String(row.UsedFlag || "").trim().toUpperCase() === "X") { continue; }

			await sapWrite("MERGE", keyPath(key, String(row.SeqNo || "")), {
				UsedFlag: "X",
				UsedByPr: String(prNumber || "").slice(0, 20),
				UsedAt: stamp
			}, session);
		}
	} catch (error) {
		console.error("[material-config] Danh dau ma tai san da dung that bai:",
			extractSapErrorMessage(error));
	}

	return marked;
}
module.exports = {
	freeAssetsOf,
	loadMaterialConfig,
	markAssetsUsed,
	saveMaterialConfigTo,
};
