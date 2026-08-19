/**
 * Danh muc anh xa vat tu (ZAST) -> ma tai san.
 *
 * NGUON CHINH: bang Z tren SAP `ZG1_MAT_ASSET`, doc/ghi qua entity `MatAssetSet`
 * cua ZG1_PROC_SRV_SRV (xem HUONG_DAN_SAP_ZG1_MAT_ASSET.md). Chon luu tren SAP
 * thay vi file trong app de du lieu cau hinh nam cung cho voi master data khac
 * va khong mat khi Vercel cold start.
 *
 * DUONG LUI: neu chua lam xong phan SAP (entity chua co / ABAP chua implement)
 * hoac SAP loi, module tu quay ve file JSON trong app (`data/asset-map.json` +
 * DATA_DIR) — man Cau hinh va PR-01 van chay, chi kem ben. Moi ham deu tra kem
 * `storage: "sap" | "app"` de FE noi ro cho nguoi dung dang ghi vao dau.
 *
 * Vi sao GHI bang MERGE chu khong POST: simple <EntitySet>_CREATE_ENTITY bi
 * Gateway tu choi khi goi qua Basic Auth (da xac nhan 14/08, xem memory RFQ deep
 * entity). Method UPDATE_ENTITY ben ABAP dung `MODIFY` nen MERGE vua tao moi vua
 * cap nhat duoc — khong can CREATE.
 */


const { assetMapStore, normalizeMaterialKey, saveAssetMap } = require("../lib/store");
const { extractSapErrorMessage, odataEscape, sapFetchCsrfToken, sapRead, sapWrite } = require("../lib/sap-client");

const ENTITY_SET = "MatAssetSet";

/** So thu tu ma tai san trong 1 vat tu: 1 -> "001" (khop kieu NUMC3 ben SAP). */
function seqOf(index) {
	return String(index + 1).padStart(3, "0");
}

function keyPath(materialNo, seqNo) {
	return `${ENTITY_SET}(MaterialNo='${odataEscape(materialNo)}',SeqNo='${odataEscape(seqNo)}')`;
}

/** Cac dong tren SAP -> { byMaterial: { "MON-001": ["100000", "100001"] } } */
function rowsToByMaterial(rows) {
	const byMaterial = {};
	(rows || [])
		.slice()
		// Sap theo SeqNo de thu tu ma tai san giong luc khai — PR-01 dien lan luot
		// cho tung don vi so luong nen thu tu co y nghia.
		.sort(function (a, b) {
			return String(a.SeqNo || "").localeCompare(String(b.SeqNo || ""));
		})
		.forEach(function (row) {
			const key = normalizeMaterialKey(row.MaterialNo);
			const asset = String(row.AssetNo || "").trim();
			if (!key || !asset) { return; }
			if (!byMaterial[key]) { byMaterial[key] = []; }
			byMaterial[key].push(asset);
		});
	return byMaterial;
}

/** Doc danh muc. Uu tien SAP, loi thi quay ve file trong app. */
async function loadAssetMap() {
	if (!process.env.SAP_HOST) {
		return { storage: "app", byMaterial: assetMapStore.byMaterial };
	}
	try {
		const resp = await sapRead(ENTITY_SET);
		const rows = (resp.data && resp.data.d && resp.data.d.results) || [];
		const byMaterial = rowsToByMaterial(rows);
		// Ghi lai vao file lam ban cache: neu lat sau SAP loi thi PR-01 van co du
		// lieu tuong doi moi de tu dien, thay vi tro ve bang rong.
		assetMapStore.byMaterial = byMaterial;
		try { saveAssetMap(); } catch (e) { /* cache loi khong lam hong luong chinh */ }
		return { storage: "sap", byMaterial: byMaterial };
	} catch (error) {
		console.error("[asset-map] Doc MatAssetSet that bai, dung ban trong app:", extractSapErrorMessage(error));
		return {
			storage: "app",
			byMaterial: assetMapStore.byMaterial,
			warning: "Chua doc duoc bang ZG1_MAT_ASSET tren SAP — dang hien ban luu trong ung dung."
		};
	}
}

/**
 * Ghi ca bang. `byMaterial` = { materialNo: [assetNo, ...] }; mang rong = xoa het
 * ma tai san cua vat tu do.
 */
async function saveAssetMapTo(byMaterial, changedBy) {
	const normalized = {};
	Object.keys(byMaterial || {}).forEach(function (mat) {
		const key = normalizeMaterialKey(mat);
		if (!key) { return; }
		const raw = byMaterial[mat];
		const list = (Array.isArray(raw) ? raw : String(raw == null ? "" : raw).split(","))
			.map(function (x) { return String(x || "").trim(); })
			.filter(Boolean);
		normalized[key] = list;
	});

	// Cap nhat ban trong app truoc: du SAP loi thi man hinh van giu duoc thay doi.
	Object.keys(normalized).forEach(function (key) {
		if (normalized[key].length === 0) {
			delete assetMapStore.byMaterial[key];
		} else {
			assetMapStore.byMaterial[key] = normalized[key];
		}
	});
	saveAssetMap();

	if (!process.env.SAP_HOST) {
		return { storage: "app", byMaterial: assetMapStore.byMaterial };
	}

	try {
		// Doc truoc de biet dong nao dang co: giam tu 3 ma xuong 1 thi 2 dong thua
		// PHAI xoa, khong thi PR-01 van dien 3 ma nhu cu.
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
		const stamp = new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14);

		for (const key of Object.keys(normalized)) {
			const list = normalized[key];

			for (let i = 0; i < list.length; i++) {
				// MERGE = MODIFY ben ABAP: chua co thi them, co roi thi sua.
				await sapWrite("MERGE", keyPath(key, seqOf(i)), {
					MaterialNo: key,
					SeqNo: seqOf(i),
					AssetNo: list[i],
					ChangedBy: String(changedBy || "").slice(0, 100),
					ChangedAt: stamp
				}, session);
			}

			// Xoa cac dong vuot qua so ma con lai.
			const olds = existingSeqs[key] || [];
			for (const seq of olds) {
				if (Number(seq) > list.length) {
					await sapWrite("DELETE", keyPath(key, seq), undefined, session);
				}
			}
		}

		const after = await loadAssetMap();
		return { storage: "sap", byMaterial: after.byMaterial };
	} catch (error) {
		const message = extractSapErrorMessage(error);
		console.error("[asset-map] Ghi MatAssetSet that bai, chi luu trong app:", message);
		return {
			storage: "app",
			byMaterial: assetMapStore.byMaterial,
			warning: "Chua ghi duoc len bang ZG1_MAT_ASSET tren SAP (" + message
				+ "). Thay doi dang chi luu trong ung dung."
		};
	}
}
module.exports = {
	loadAssetMap,
	saveAssetMapTo,
};
