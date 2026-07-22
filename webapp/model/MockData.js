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
	// ZAST - Tai san co dinh CNTT (Account Assignment A, bat buoc co AssetNo tu AS01)
	{ MaterialNo: "LAPTOP-001",  MaterialType: "ZAST", MaterialGroup: "LAPTOP", Description: "Laptop Dell Latitude 5540 i5", BaseUoM: "ST" },
	{ MaterialNo: "LAPTOP-002",  MaterialType: "ZAST", MaterialGroup: "LAPTOP", Description: "Laptop MacBook Pro 14 M3", BaseUoM: "ST" },
	{ MaterialNo: "MON-001",     MaterialType: "ZAST", MaterialGroup: "83102",  Description: "Man hinh Dell 24 inch FHD", BaseUoM: "ST" },
	{ MaterialNo: "MON-002",     MaterialType: "ZAST", MaterialGroup: "83102",  Description: "Man hinh LG 27 inch 4K", BaseUoM: "ST" },
	{ MaterialNo: "MON-003",     MaterialType: "ZAST", MaterialGroup: "83102",  Description: "Man hinh HP 24 inch FHD", BaseUoM: "ST" },
	{ MaterialNo: "SERVER-001",  MaterialType: "ZAST", MaterialGroup: "83102",  Description: "May chu Dell PowerEdge T40", BaseUoM: "ST" },
	{ MaterialNo: "PHONE-001",   MaterialType: "ZAST", MaterialGroup: "LAPTOP", Description: "Dien thoai iPhone 15 Pro", BaseUoM: "ST" },
	{ MaterialNo: "TABLET-001",  MaterialType: "ZAST", MaterialGroup: "LAPTOP", Description: "May tinh bang iPad Pro 12.9", BaseUoM: "ST" },
	{ MaterialNo: "PRINTER-001", MaterialType: "ZAST", MaterialGroup: "83102",  Description: "May in laser HP LaserJet", BaseUoM: "ST" },
	{ MaterialNo: "NAS-001",     MaterialType: "ZAST", MaterialGroup: "83102",  Description: "Thiet bi luu tru NAS Synology", BaseUoM: "ST" },
	{ MaterialNo: "SWITCH-001",  MaterialType: "ZAST", MaterialGroup: "83102",  Description: "Bo chuyen mach Cisco 24 cong", BaseUoM: "ST" },
	// ZSRV - Dich vu / Vat tu tieu hao (Account Assignment K, bat buoc co CostCenter)
	{ MaterialNo: "SW-LIC-001",  MaterialType: "ZSRV", MaterialGroup: "004", Description: "Ban quyen Microsoft Office 365", BaseUoM: "EA" },
	{ MaterialNo: "SW-LIC-002",  MaterialType: "ZSRV", MaterialGroup: "004", Description: "Ban quyen Adobe Creative Suite", BaseUoM: "EA" },
	{ MaterialNo: "CLOUD-001",   MaterialType: "ZSRV", MaterialGroup: "004", Description: "Dich vu Cloud AWS Azure", BaseUoM: "EA" },
	{ MaterialNo: "CLOUD-002",   MaterialType: "ZSRV", MaterialGroup: "004", Description: "Google Workspace for Business", BaseUoM: "EA" },
	{ MaterialNo: "SUPPLY-001",  MaterialType: "ZSRV", MaterialGroup: "003", Description: "Van phong pham tong hop", BaseUoM: "BOX" },
	{ MaterialNo: "SUPPLY-002",  MaterialType: "ZSRV", MaterialGroup: "003", Description: "Muc in toner HP", BaseUoM: "ST" },
	{ MaterialNo: "MAINT-001",   MaterialType: "ZSRV", MaterialGroup: "004", Description: "Bao tri thiet bi IT dinh ky", BaseUoM: "EA" },
	{ MaterialNo: "MAINT-002",   MaterialType: "ZSRV", MaterialGroup: "004", Description: "Ve sinh may tinh van phong", BaseUoM: "EA" },
	{ MaterialNo: "TRAIN-001",   MaterialType: "ZSRV", MaterialGroup: "004", Description: "Dao tao nhan vien ky nang IT", BaseUoM: "EA" },
	{ MaterialNo: "CONSULT-001", MaterialType: "ZSRV", MaterialGroup: "004", Description: "Tu van giai phap he thong IT", BaseUoM: "EA" }
];

const vendors = [
	{ VendorNo: "0050000007", VendorName: "Cong ty TNHH Dell Viet Nam",   AccountGroup: "KRED", Email: "sales@dell.vn",       Rating: 4.5, AvgLeadTimeDays: 7,  PriceIndex: 1.0 },
	{ VendorNo: "0050000008", VendorName: "Cong ty CP Microsoft Viet Nam", AccountGroup: "KRED", Email: "contact@microsoft.vn", Rating: 4.0, AvgLeadTimeDays: 5,  PriceIndex: 1.1 },
	{ VendorNo: "0050000009", VendorName: "Cong ty TNHH HP Viet Nam",      AccountGroup: "KRED", Email: "info@hp.vn",           Rating: 3.8, AvgLeadTimeDays: 10, PriceIndex: 0.9 }
];

// Seed record cho GET /api/approval/pending — cau truc moi ho tro nhieu Line Item (Section 3.4).
const pendingPRs = [
	{
		PRId: "PR-2026-0001",
		RequesterEmail: "nhanvien@qdavy.com",
		TotalValue: 55000000,
		Currency: "VND",
		Status: "PENDING_APPROVAL",
		CreatedAt: "2026-07-01T09:00:00Z",
		needsProcurementHeadReview: false,
		needsLegalReview: false,
		items: [
			{
				LineNo: "00001",
				MaterialNo: "LAPTOP-001",
				MaterialType: "ZAST",
				Description: "Laptop Dell Latitude 5540 i5",
				Quantity: 2,
				UoM: "ST",
				EstimatedValue: 25000000,
				CostCenter: "",
				InternalOrder: "",
				AssetNo: "AST-2026-001",
				isFreeText: false
			},
			{
				LineNo: "00002",
				MaterialNo: "MON-001",
				MaterialType: "ZAST",
				Description: "Man hinh Dell 24 inch FHD",
				Quantity: 2,
				UoM: "ST",
				EstimatedValue: 2500000,
				CostCenter: "",
				InternalOrder: "",
				AssetNo: "AST-2026-002",
				isFreeText: false
			}
		]
	}
];

module.exports = { employees, materials, vendors, pendingPRs };
