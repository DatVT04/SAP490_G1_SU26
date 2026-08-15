/**
 * Bang dieu khoan thanh toan + anh xa ZTERM cua SAP.
 *
 * Tach ra tu server.js (ban goc 4520 dong) ngay 15/08/2026.
 * Noi dung ham giu nguyen 100%, chi them phan require/exports o dau va cuoi file.
 */




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
	{ code: "NET7", label: "Trả trong 7 ngày (NET7)", days: 7 },
	{ code: "NET15", label: "Trả trong 15 ngày (NET15)", days: 15 },
	{ code: "NET30", label: "Trả trong 30 ngày (NET30)", days: 30 },
	{ code: "NET45", label: "Trả trong 45 ngày (NET45)", days: 45 },
	{ code: "NET60", label: "Trả trong 60 ngày (NET60)", days: 60 },
	{ code: "AFTER_ACCEPT", label: "Trả sau khi nghiệm thu", days: 30 }
];

// Ma dieu khoan thanh toan cua SAP (bang T052, vd LFM1-ZTERM cua Vendor master) -> ma
// noi bo cua app o tren. VendorSet HIEN CHUA tra ve PaymentTerms (xem
// PHU_LUC_KY_THUAT_VendorSet.md) nen bang nay chua co du lieu de chay qua — chuan bi san
// de khi SEGW/ABAP xong thi describePaymentTerms() tu dong hieu duoc ma that cua SAP,
// khong phai sua gi them o day. Doi chieu F4 tren he thong 14/08/2026 — nhom chi dung dai NT.
const SAP_ZTERM_TO_APP = {
	"NT00": "IMMEDIATE",
	"NT07": "NET7",
	"NT30": "NET30",
	"NT45": "NET45",
	"NT60": "NET60"
};

/**
 * Doi ma dieu khoan thanh toan sang chuoi nguoi/AI doc hieu.
 * Thu map ma SAP (NT..) sang ma noi bo truoc, khong khop thi coi nhu da la ma noi bo
 * (giu nguyen hanh vi cu cho route POST quotation cua RFQ-02 — noi Purchasing nhap thang ma noi bo
 * NET30... chu khong phai ma SAP). Bao gia cu nhap tay ("net5", "net10") khong khop
 * danh muc nao thi tra ve nguyen van de khong lam mat du lieu lich su.
 */
function describePaymentTerms(code) {
	const raw = String(code || "").trim();
	if (!raw) { return "Không nêu"; }
	const mapped = SAP_ZTERM_TO_APP[raw.toUpperCase()] || raw;
	const found = PAYMENT_TERMS.find((t) => t.code.toUpperCase() === mapped.toUpperCase());
	return found ? found.label : mapped;
}
module.exports = {
	PAYMENT_TERMS,
	describePaymentTerms,
};
