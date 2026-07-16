/**
 * Mock data used by server.js when SAP_HOST is not configured.
 * Shapes mirror the real ZG1_PROC_SRV_SRV OData entities (Employee/Material/Vendor/
 * PurchaseRequisition), so switching to the real backend later needs no controller changes.
 *
 * Employee fields <-> EmployeeSet (PA0001/PA0105): Email, Pernr, FullName, Position, Role,
 *   CostCenter, IsActive.
 * Material fields <-> MaterialSet (MARA/MAKT): MaterialNo, MaterialType (ZAST=tai san CNTT,
 *   ZSRV=vat tu/dich vu), MaterialGroup, Description, BaseUoM.
 * Vendor fields <-> VendorSet (LFA1): VendorNo, VendorName, AccountGroup, Email, Rating.
 *   (AvgLeadTimeDays/PriceIndex la field rieng cua app, dung cho tinh nang goi y AI, khong
 *   thuoc OData VendorSet chuan.)
 */

const employees = [
	{
		Email: "ceo@qdavy.com",
		Pernr: "00000001",
		FullName: "Nguyen Van An",
		Position: "Tong Giam Doc",
		Role: "CEO",
		CostCenter: "CC-0001",
		IsActive: true
	},
	{
		Email: "cfo@qdavy.com",
		Pernr: "00000002",
		FullName: "Tran Thi Bich",
		Position: "Giam Doc Tai Chinh",
		Role: "CFO",
		CostCenter: "CC-0002",
		IsActive: true
	},
	{
		Email: "truongphongmuahang@qdavy.com",
		Pernr: "00000003",
		FullName: "Le Van Cuong",
		Position: "Truong Bo Phan Mua Sam",
		Role: "TRUONG_BO_PHAN_MUA_SAM",
		CostCenter: "CC-0100",
		IsActive: true
	},
	{
		Email: "phapche@qdavy.com",
		Pernr: "00000004",
		FullName: "Pham Thi Dung",
		Position: "Truong Phong Phap Che",
		Role: "LEGAL",
		CostCenter: "CC-0200",
		IsActive: true
	},
	{
		Email: "muahang@qdavy.com",
		Pernr: "00000005",
		FullName: "Hoang Van Em",
		Position: "Nhan Vien Mua Hang",
		Role: "PURCHASING",
		CostCenter: "CC-0100",
		IsActive: true
	},
	{
		Email: "nhanvien@qdavy.com",
		Pernr: "00000006",
		FullName: "Vo Thi Giang",
		Position: "Nhan Vien San Xuat",
		Role: "REQUESTER",
		CostCenter: "CC-0300",
		IsActive: true
	},
	{
		Email: "nghiviec@qdavy.com",
		Pernr: "00000007",
		FullName: "Dang Van Hai",
		Position: "Cuu Nhan Vien",
		Role: "REQUESTER",
		CostCenter: "CC-0300",
		IsActive: false
	}
];

// MaterialType: 'ZSRV' = vat tu/dich vu thuong (Account Assignment K - Cost Center),
// 'ZAST' = tai san CNTT (Account Assignment A - Asset, phai co AssetNo tham chieu AS01).
const materials = [
	{ MaterialNo: "MAT-001", MaterialType: "ZSRV", MaterialGroup: "RAW-STEEL", Description: "Thep tam CT3", BaseUoM: "KG" },
	{ MaterialNo: "MAT-002", MaterialType: "ZSRV", MaterialGroup: "HARDWARE", Description: "Bulong M10", BaseUoM: "PC" },
	{ MaterialNo: "MAT-003", MaterialType: "ZSRV", MaterialGroup: "CHEMICAL", Description: "Son cong nghiep", BaseUoM: "LIT" },
	{ MaterialNo: "MAT-100", MaterialType: "ZAST", MaterialGroup: "IT-EQUIP", Description: "Laptop Dell Latitude 5540", BaseUoM: "PC" },
	{ MaterialNo: "MAT-101", MaterialType: "ZAST", MaterialGroup: "IT-EQUIP", Description: "Man hinh Dell 24 inch", BaseUoM: "PC" },
	{ MaterialNo: "MAT-102", MaterialType: "ZAST", MaterialGroup: "IT-EQUIP", Description: "May chu Server Dell PowerEdge", BaseUoM: "PC" }
];

const vendors = [
	{ VendorNo: "8000001", VendorName: "Cong ty TNHH Thep Viet", AccountGroup: "ZDO1", Email: "sales@thepviet.vn", Rating: 4.5, AvgLeadTimeDays: 7, PriceIndex: 1.0 },
	{ VendorNo: "8000002", VendorName: "Cong ty CP Vat Tu Cong Nghiep", AccountGroup: "ZDO1", Email: "contact@vtcn.vn", Rating: 4.0, AvgLeadTimeDays: 5, PriceIndex: 1.1 },
	{ VendorNo: "8000003", VendorName: "Cong ty TNHH Xuat Nhap Khau Kim Khi", AccountGroup: "ZDO1", Email: "info@xnkkimkhi.vn", Rating: 3.8, AvgLeadTimeDays: 10, PriceIndex: 0.9 }
];

// Seed record cho GET /api/approval/pending khi chua co PR nao duoc tao qua UI.
const pendingPRs = [
	{
		PRId: "PR-2026-0001",
		RequesterEmail: "nhanvien@qdavy.com",
		MaterialNo: "MAT-001",
		MaterialType: "ZSRV",
		Description: "Thep tam CT3",
		Quantity: 500,
		UoM: "KG",
		TotalValue: 150000000,
		Currency: "VND",
		CostCenter: "CC-0300",
		AssetNo: "",
		Status: "PENDING_APPROVAL",
		CreatedAt: "2026-07-01T09:00:00Z",
		needsProcurementHeadReview: false,
		needsLegalReview: true
	}
];

module.exports = { employees, materials, vendors, pendingPRs };
