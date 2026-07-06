/**
 * Mock data used by server.js when SAP_HOST is not configured.
 * Shapes mirror the real ZG1_PROC_SRV OData EmployeeSet (from HCM infotype 0001/0105),
 * so switching to the real backend later needs no controller/server changes.
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

const materials = [
	{ MaterialId: "MAT-001", MaterialName: "Thep tam CT3", MaterialGroup: "RAW-STEEL", Unit: "KG" },
	{ MaterialId: "MAT-002", MaterialName: "Bulong M10", MaterialGroup: "HARDWARE", Unit: "PC" },
	{ MaterialId: "MAT-003", MaterialName: "Son cong nghiep", MaterialGroup: "CHEMICAL", Unit: "LIT" }
];

const vendors = [
	{ VendorId: "V-001", VendorName: "Cong ty TNHH Thep Viet", Rating: 4.5, AvgLeadTimeDays: 7, PriceIndex: 1.0 },
	{ VendorId: "V-002", VendorName: "Cong ty CP Vat Tu Cong Nghiep", Rating: 4.0, AvgLeadTimeDays: 5, PriceIndex: 1.1 },
	{ VendorId: "V-003", VendorName: "Cong ty TNHH Xuat Nhap Khau Kim Khi", Rating: 3.8, AvgLeadTimeDays: 10, PriceIndex: 0.9 }
];

const pendingPRs = [
	{
		PRId: "PR-2026-0001",
		RequesterEmail: "nhanvien@qdavy.com",
		MaterialName: "Thep tam CT3",
		Quantity: 500,
		TotalValue: 150000000,
		CostCenter: "CC-0300",
		Status: "PENDING_APPROVAL",
		CreatedAt: "2026-07-01T09:00:00Z"
	}
];

module.exports = { employees, materials, vendors, pendingPRs };
