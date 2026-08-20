/**
 * Hang so to chuc + duong dan OData dung chung toan he thong.
 *
 * Tach ra tu server.js (ban goc 4520 dong) ngay 15/08/2026.
 * Noi dung ham giu nguyen 100%, chi them phan require/exports o dau va cuoi file.
 */




// Cong chay server. De o day (khong de rieng trong server.js) vi service dung link
// cho NCC cung can lam gia tri du phong khi request khong co header host.
const PORT = process.env.PORT || 3001;

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

// ============================================================================
// LOAI HACH TOAN CHO DONG CHI PHI (khong phai tai san)
//
// 'F' = Internal Order. Chi phi ghi vao IO ngan sach cua phong -> SAP tu ghi
//       commitment va Availability Control tu CHAN khi vuot ngan sach (KO22 +
//       tolerance limit). Day la cach chuan de "tru dan tien theo tung don".
// 'K' = Cost Center. Cach cu: chi phi ve thang cost center, ngan sach IO KHONG
//       bao gio bi tru -> chi con ngan sach o tang ung dung (thresholds.json).
//
// De 'K' de quay lui ngay neu AVC ben SAP chua kip cau hinh xong. Doi 1 dong
// nay la ca luong PR/PO doi theo, khong phai sua cho nao khac.
//
// Vat tu Tai san (ZAST) LUON la Cat 'A', khong chiu anh huong cua bien nay —
// tai san co ngan sach dau tu rieng, khong thuoc IO chi phi.
// ============================================================================
const BUDGET_ACCT_CAT = "F";

// ============================================================================
// MUI GIO (TIMEZONE) — vi sao can offset:
// Cac field *At tren ZPR_DRAFT (CreatedAt/UpdatedAt/PurchasingAt/CfoAt/CeoAt)
// do ABAP dong dau bang sy-datum/sy-uzeit — tuc GIO HE THONG SAP (server TUM
// o Duc, CEST = UTC+2), KHONG phai UTC. Truoc day sapTsToIso() gan thang "Z"
// vao nen FE (VN, UTC+7) hien lech +2h: PR tao luc 15:25 VN -> SAP ghi 10:25
// -> FE hien 17:25 (feedback QDAVY 13/08: "Gio giac dang sai").
// SAP_TZ_OFFSET_MIN = so phut SAP server di truoc UTC (CEST = 120; mua dong
// CET = 60 — chinh bang env khi doi mua).
// Cac field RFQ/Quotation (CreatedAt/SentAt/AwardedAt/EnteredAt) thi do Node
// tu dong dau — sapTimestamp() nay ghi UTC (getUTC*) nen khi doc ra dung
// offset 0. Hai loai field, hai offset — dung tron lan.
// ============================================================================
const SAP_TZ_OFFSET_MIN = Number(process.env.SAP_TZ_OFFSET_MIN || 120);
module.exports = {
	PORT,
	BUDGET_ACCT_CAT,
	LEGAL_ESCALATION_THRESHOLD,
	ODATA_SERVICE_PATH,
	ORG_DEFAULTS,
	SAP_TZ_OFFSET_MIN,
};
