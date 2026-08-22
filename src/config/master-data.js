/**
 * Cau hinh master data: cost center, material master, GL mac dinh, tien te.
 *
 * Tach ra tu server.js (ban goc 4520 dong) ngay 15/08/2026.
 * Noi dung ham giu nguyen 100%, chi them phan require/exports o dau va cuoi file.
 */




// ============================================================================
// TEN BO PHAN TIENG VIET
//
// SAP tra ve ten Cost Center bang tieng Anh ("Technology Div") vi master data
// tao bang tieng Anh. Requester la nhan vien nghiep vu, khong phai ai cung doc
// duoc "OPS" hay "ADM" la bo phan nao cua minh.
//
// Map o day chu KHONG doi ten tren SAP (KS02): doi ben SAP thi anh huong ca
// bao cao CO, tat ca tài liệu da nop hoi dong deu dang ghi ten tieng Anh.
// Ma nao khong co trong map thi giu nguyen ten SAP - them Cost Center moi ma
// quen khai bao o day thi chi mat phan dich, khong vo dropdown.
// ============================================================================
const COST_CENTER_LABEL_VI = Object.freeze({
	CCADM: "Phòng Hành chính",
	CCBUS: "Phòng Kinh doanh",
	CCFIN: "Phòng Tài chính",
	CCOPS: "Phòng Vận hành",
	CCPUR: "Phòng Mua sắm",
	CCTEC: "Phòng Công nghệ"
});

function costCenterLabelVi(code, sapName) {
	const key = String(code || "").trim().toUpperCase();
	return COST_CENTER_LABEL_VI[key] || String(sapName || code || "").trim();
}

// ============================================================================
// MATERIAL MASTER (MM01) — man "Tao vat tu/dich vu" cua nhanh An (PR #11), bi
// git merge lam mat toan bo khi merge vao main 13/08 (merge bao "khong loi"
// nhung thuc te xoa sach code cua nhanh An o nhieu file — loi mount, khong
// phai loi cua An). Khoi phuc thu cong tu origin/An, giu nguyen logic goc.
// ============================================================================
const MATERIAL_MASTER_CONFIG = Object.freeze({
	// industrySector PHAI la 'M', khong duoc de 'S'. Kiem chung 15/08: vat tu tao
	// voi sector 'S' khong co view Accounting -> khong co valuation class -> tao PO
	// bao ME 047. MON-003 (sector 'M') tao PO binh thuong. Sector khong sua duoc sau
	// khi tao, nen de sai o day la moi vat tu man nay tao ra deu hong.
	ZAST: {
		materialType: "ZAST",
		industrySector: "M",
		plant: "QDPL",
		storageLocation: "QDSL"
	},
	ZSRV: {
		materialType: "ZSRV",
		industrySector: "M",
		plant: "QDPL",
		storageLocation: ""
	}
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

// ============================================================================
// LOC VAT TU KHONG TAO DUOC PO
//
// Vat tu thieu doan valuation (bang MBEW) se bi SAP chan o buoc tao PO bang loi
// ME 047 "Material not maintained by accounting department" — nguoi demo di het
// ca luong PR -> duyet -> RFQ -> PO roi moi chet o buoc cuoi.
//
// 15/08: da bo sung valuation cho toan bo 30 ma bang BAPI_MATERIAL_SAVEDATA
// (nho bat HEADDATA-ACCOUNT_VIEW = 'X', thieu co nay thi BAPI van tra 'S' nhung
// khong ghi gi ca). Kiem chung: SE16N -> MBEW -> BWKEY = QDPL -> du 30 dong.
// Nen danh sach nay hien de RONG.
//
// Neu sau nay them vat tu moi ma tao PO bao ME 047, cho ma do vao day cho toi
// khi bo sung xong valuation. Kiem bang SE16N -> MBEW -> BWKEY = QDPL.
// ============================================================================
const HIDDEN_MATERIALS = new Set([]);

function isMaterialSelectable(row) {
	const code = String((row && row.MaterialNo) || "").trim();
	if (!code) { return false; }
	// So ca ban nguyen goc lan ban da bo so 0 dem dau — SAP tra ve khong nhat quan.
	return !HIDDEN_MATERIALS.has(code) && !HIDDEN_MATERIALS.has(code.replace(/^0+/, ""));
}
// ============================================================================
// TIEN TE KHONG CO SO THAP PHAN — CHI AP DUNG CHO DUONG TAO PO
//
// Kiem chung 15/08 bang chung tu that:
//   PR  gui "500000"     -> ME53N hien 500.000      (dung)
//   PO  gui "600000.00"  -> PO 4500006282 hien 60.000.000  (sai, x100)
//
// VND khai 0 chu so thap phan trong TCURX. Field NetPrice cua entity PO ben SEGW
// nhieu kha nang khai kieu tien te CO tham chieu currency nen Gateway dich thap
// phan, con EstimatedValue cua PR thi khong -> chi PO bi. Do do CHIA 100 truoc
// khi gui, va CHI o duong PO.
//
// TUYET DOI KHONG ap dung ham nay cho createPRInSAP/mapClientItemToSapDeep:
// PR dang ghi dung gia, sua vao la hong ca du lieu dang chay (14-15/08 da co
// nguoi them BAPI_CURRENCY_CONV_TO_INTERNAL vao ca 2 duong va lam chet PR).
//
// Sua tan goc thi phai vao SEGW bo tham chieu currency o NetPrice — chua lam.
// ============================================================================
const ZERO_DECIMAL_CURRENCIES = new Set(["VND", "JPY"]);

function sapPoAmount(value, currency) {
	const n = Number(value) || 0;
	if (!ZERO_DECIMAL_CURRENCIES.has(String(currency || "").trim().toUpperCase())) {
		return n.toFixed(2);
	}
	return (n / 100).toFixed(2);
}
module.exports = {
	MATERIAL_MASTER_CONFIG,
	costCenterLabelVi,
	defaultGLAccount,
	isMaterialSelectable,
	sapPoAmount,
};
