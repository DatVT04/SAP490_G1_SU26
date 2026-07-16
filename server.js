require("dotenv").config();

const express = require("express");
const cors = require("cors");
const axios = require("axios");

const { employees, materials, vendors, pendingPRs } = require("./webapp/model/MockData");

const app = express();
const PORT = 3001;

app.use(cors());
app.use(express.json());

// Ten service OData that duoc dang ky qua /IWFND/MAINT_SERVICE. SEGW tu dong them hau to
// "_SRV" vao ten project (ZG1_PROC_SRV) nen ten service thuc te co 2 lan "_SRV" lien tiep.
const ODATA_SERVICE_PATH = "/sap/opu/odata/sap/ZG1_PROC_SRV_SRV";

const PAMS_ESCALATION_THRESHOLD = 300000000; // > 300 trieu VND -> Truong bo phan mua sam
const LEGAL_ESCALATION_THRESHOLD = 100000000; // > 100 trieu VND -> Phap che

// In-memory stand-in cho ZG1_APPROVAL de UI co the hien thi/duyet ngay, vi OData chua co
// entity doc/ghi truc tiep bang ZG1_APPROVAL. Khi tao PR, neu SAP_HOST duoc cau hinh thi
// server se GOI THEM OData PurchaseRequisitionSet de tao PR that ben SAP (BAPI_PR_CREATE se
// tu ghi 1 dong vao ZG1_APPROVAL that) - ca 2 con duong chay song song, khong xung dot vi
// approvalStore chi phuc vu UI demo/PR02, khong phai nguon du lieu chinh thuc cua SAP.
const approvalStore = [...pendingPRs].map((pr) => ({ ...pr }));
let nextApprovalId = approvalStore.length + 1;

function buildApprovalFlags(totalValue) {
	return {
		needsProcurementHeadReview: totalValue > PAMS_ESCALATION_THRESHOLD,
		needsLegalReview: totalValue > LEGAL_ESCALATION_THRESHOLD
	};
}

function sapAuth() {
	return {
		username: process.env.SAP_USER,
		password: process.env.SAP_PASS
	};
}

// --- POST /api/login ---------------------------------------------------
app.post("/api/login", async (req, res) => {
	const { email } = req.body || {};

	if (!email) {
		return res.status(400).json({ success: false, message: "Thieu email." });
	}

	if (!process.env.SAP_HOST) {
		const employee = employees.find(
			(emp) => emp.Email.toLowerCase() === String(email).toLowerCase()
		);

		if (!employee || !employee.IsActive) {
			return res.status(401).json({
				success: false,
				message: "Email khong ton tai hoac tai khoan da bi khoa."
			});
		}

		return res.json({ success: true, employee });
	}

	try {
		const response = await axios.get(
			`${process.env.SAP_HOST}${ODATA_SERVICE_PATH}/EmployeeSet`,
			{
				params: {
					"$filter": `Email eq '${email}'`,
					"$format": "json"
				},
				auth: sapAuth()
			}
		);

		const results = (response.data && response.data.d && response.data.d.results) || [];
		// SAP OData service hien khong ap dung $filter (tra ve toan bo EmployeeSet du co
		// truyen $filter hay khong), nen phai loc lai o client theo Email de tranh dang
		// nhap sai thanh nhan vien dau tien trong danh sach.
		const employee = results.find(
			(emp) => emp.Email && emp.Email.toLowerCase() === String(email).toLowerCase()
		);

		if (!employee || !employee.IsActive) {
			return res.status(401).json({
				success: false,
				message: "Email khong ton tai hoac tai khoan da bi khoa."
			});
		}

		return res.json({ success: true, employee });
	} catch (error) {
		return res.status(502).json({
			success: false,
			message: "Khong the ket noi toi he thong SAP."
		});
	}
});

// --- GET /api/materials --------------------------------------------------
app.get("/api/materials", async (req, res) => {
	if (!process.env.SAP_HOST) {
		return res.json({ success: true, data: materials });
	}

	try {
		const response = await axios.get(
			`${process.env.SAP_HOST}${ODATA_SERVICE_PATH}/MaterialSet`,
			{ params: { "$format": "json" }, auth: sapAuth() }
		);
		const results = (response.data && response.data.d && response.data.d.results) || [];
		return res.json({ success: true, data: results });
	} catch (error) {
		// Fallback ve mock neu SAP tam thoi khong truy cap duoc, de UI van demo duoc.
		return res.json({ success: true, data: materials, sapError: true });
	}
});

// --- GET /api/vendors ------------------------------------------------------
app.get("/api/vendors", async (req, res) => {
	if (!process.env.SAP_HOST) {
		return res.json({ success: true, data: vendors });
	}

	try {
		const response = await axios.get(
			`${process.env.SAP_HOST}${ODATA_SERVICE_PATH}/VendorSet`,
			{ params: { "$format": "json" }, auth: sapAuth() }
		);
		const results = (response.data && response.data.d && response.data.d.results) || [];
		return res.json({ success: true, data: results });
	} catch (error) {
		return res.json({ success: true, data: vendors, sapError: true });
	}
});

// --- POST /api/ai/recommend-vendor --------------------------------------
app.post("/api/ai/recommend-vendor", async (req, res) => {
	const { materialName, materialGroup, quantity, budget, vendors: candidateVendors } = req.body || {};

	if (!process.env.GROQ_API_KEY) {
		return res.status(500).json({
			success: false,
			message: "Thieu GROQ_API_KEY trong cau hinh may chu."
		});
	}

	const vendorList = candidateVendors && candidateVendors.length ? candidateVendors : vendors;

	const prompt = `Ban la chuyen gia mua hang. Hay de xuat nha cung cap phu hop nhat cho:
- Vat tu: ${materialName || "N/A"} (nhom: ${materialGroup || "N/A"})
- So luong: ${quantity || "N/A"}
- Ngan sach: ${budget || "N/A"} VND

Danh sach nha cung cap ung vien (JSON): ${JSON.stringify(vendorList)}

Hay danh gia dua tren gia, thoi gian giao hang va danh gia chat luong, roi tra loi ngan gon bang tieng Viet: ten nha cung cap de xuat va ly do.`;

	try {
		const response = await axios.post(
			"https://api.groq.com/openai/v1/chat/completions",
			{
				model: "llama-3.3-70b-versatile",
				messages: [{ role: "user", content: prompt }],
				temperature: 0.3
			},
			{
				headers: {
					Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
					"Content-Type": "application/json"
				}
			}
		);

		const recommendation = response.data.choices[0].message.content;
		return res.json({ success: true, recommendation });
	} catch (error) {
		return res.status(502).json({
			success: false,
			message: "Khong the goi dich vu AI goi y nha cung cap."
		});
	}
});

// --- Approval workflow (PR-01 tao PR / PR-02 duyet PR) ------------------
// approvalStore la nguon du lieu cho man PR02 (vi OData chua co entity doc ZG1_APPROVAL).
// Khi co SAP_HOST, PR cung duoc tao that ben SAP qua OData PurchaseRequisitionSet (BAPI_PR_CREATE),
// nhung ket qua tao that KHONG chan luong demo neu SAP loi/khong ket noi duoc.
app.post("/api/approval/submit", async (req, res) => {
	const {
		requesterEmail,
		materialNo,
		materialType,
		description,
		quantity,
		uom,
		totalValue,
		currency,
		costCenter,
		assetNo
	} = req.body || {};

	if (!requesterEmail || !materialNo || !quantity || !totalValue) {
		return res.status(400).json({ success: false, message: "Thieu thong tin de nghi mua sam." });
	}

	if (materialType === "ZAST" && !assetNo) {
		return res.status(400).json({ success: false, message: "Vat tu tai san (ZAST) bat buoc phai co Asset No (tao qua AS01)." });
	}

	if (materialType !== "ZAST" && !costCenter) {
		return res.status(400).json({ success: false, message: "Vat tu dich vu (ZSRV) bat buoc phai co Cost Center." });
	}

	let sapPrNumber = null;
	let sapIntegration = "mock";

	if (process.env.SAP_HOST) {
		try {
			const sapResponse = await axios.post(
				`${process.env.SAP_HOST}${ODATA_SERVICE_PATH}/PurchaseRequisitionSet`,
				{
					CompanyCode: "QD01",
					Requester: requesterEmail,
					MaterialNo: materialNo,
					Description: description || "",
					Quantity: String(quantity),
					UoM: uom || "PC",
					EstimatedValue: String(totalValue),
					Currency: currency || "VND",
					CostCenter: costCenter || "",
					AssetNo: assetNo || ""
				},
				{
					auth: sapAuth(),
					headers: { "Content-Type": "application/json" }
				}
			);
			sapPrNumber = sapResponse.data && sapResponse.data.d && sapResponse.data.d.PrNumber;
			sapIntegration = "created";
		} catch (error) {
			sapIntegration = "failed";
		}
	}

	const record = {
		PRId: sapPrNumber || `PR-${new Date().getFullYear()}-${String(nextApprovalId).padStart(4, "0")}`,
		RequesterEmail: requesterEmail,
		MaterialNo: materialNo,
		MaterialType: materialType || "ZSRV",
		Description: description || "",
		Quantity: quantity,
		UoM: uom || "PC",
		TotalValue: totalValue,
		Currency: currency || "VND",
		CostCenter: costCenter || "",
		AssetNo: assetNo || "",
		Status: "PENDING_APPROVAL",
		CreatedAt: new Date().toISOString(),
		...buildApprovalFlags(totalValue)
	};

	nextApprovalId += 1;
	approvalStore.push(record);

	return res.status(201).json({ success: true, approval: record, sapIntegration });
});

app.get("/api/approval/pending", (req, res) => {
	const pending = approvalStore.filter((item) => item.Status === "PENDING_APPROVAL");
	return res.json({ success: true, data: pending });
});

app.patch("/api/approval/:id", (req, res) => {
	const { id } = req.params;
	const { status, comment, decidedByEmail } = req.body || {};

	const record = approvalStore.find((item) => item.PRId === id);

	if (!record) {
		return res.status(404).json({ success: false, message: "Khong tim thay de nghi mua sam." });
	}

	record.Status = status || record.Status;
	record.Comment = comment || record.Comment;
	record.DecidedByEmail = decidedByEmail || record.DecidedByEmail;
	record.UpdatedAt = new Date().toISOString();

	return res.json({ success: true, approval: record });
});

// --- POST /api/po/create --------------------------------------------------
// Tao Purchase Order (PO-01). Khi co SAP_HOST, goi OData deep-insert
// PurchaseOrderHeaderSet (kem nav property POToItems) -> BAPI_PO_CREATE1 ben SAP.
// Khi khong co SAP_HOST (che do mock/demo), tra ve 1 PO gia lap de UI van hoan tat luong.
app.post("/api/po/create", async (req, res) => {
	const { vendorNo, items } = req.body || {};

	if (!vendorNo || !Array.isArray(items) || items.length === 0) {
		return res.status(400).json({ success: false, message: "Thieu nha cung cap hoac danh sach vat tu." });
	}

	for (const item of items) {
		if (item.materialType === "ZAST" && !item.assetNo) {
			return res.status(400).json({ success: false, message: `Vat tu ${item.materialNo} la tai san (ZAST), bat buoc phai co Asset No.` });
		}
		if (item.materialType !== "ZAST" && !item.costCenter) {
			return res.status(400).json({ success: false, message: `Vat tu ${item.materialNo} bat buoc phai co Cost Center.` });
		}
	}

	const totalValue = items.reduce((sum, item) => sum + (Number(item.netPrice) || 0) * (Number(item.quantity) || 0), 0);

	if (!process.env.SAP_HOST) {
		return res.status(201).json({
			success: true,
			sapIntegration: "mock",
			po: {
				PoNumber: `PO-${new Date().getFullYear()}-${String(Math.floor(Math.random() * 9000) + 1000)}`,
				VendorNo: vendorNo,
				TotalValue: totalValue,
				Currency: "VND",
				Status: "CREATED",
				Items: items
			}
		});
	}

	try {
		const sapResponse = await axios.post(
			`${process.env.SAP_HOST}${ODATA_SERVICE_PATH}/PurchaseOrderHeaderSet`,
			{
				CompanyCode: "QD01",
				DocType: "ZPO",
				VendorNo: vendorNo,
				PurchOrg: "QDPO",
				PurchGroup: "QDG",
				Currency: "VND",
				POToItems: {
					results: items.map((item, idx) => ({
						ItemNo: String(idx + 1).padStart(5, "0"),
						MaterialNo: item.materialNo,
						Description: item.description || "",
						Quantity: String(item.quantity),
						UoM: item.uom || "PC",
						NetPrice: String(item.netPrice),
						CostCenter: item.costCenter || "",
						AssetNo: item.assetNo || "",
						Plant: "QDPL"
					}))
				}
			},
			{
				auth: sapAuth(),
				headers: { "Content-Type": "application/json" }
			}
		);

		return res.status(201).json({
			success: true,
			sapIntegration: "created",
			po: sapResponse.data && sapResponse.data.d
		});
	} catch (error) {
		return res.status(502).json({
			success: false,
			message: "Khong the tao PO qua SAP. Kiem tra ket noi/du lieu roi thu lai."
		});
	}
});

if (require.main === module) {
	app.listen(PORT, () => {
		console.log(`QDAVY Procurement API server dang chay tai http://localhost:${PORT}`);
		console.log(process.env.SAP_HOST
			? `Che do: goi OData that toi ${process.env.SAP_HOST}${ODATA_SERVICE_PATH}`
			: "Che do: mock data (SAP_HOST chua duoc cau hinh)");
	});
}

module.exports = app;
