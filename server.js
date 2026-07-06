require("dotenv").config();

const express = require("express");
const cors = require("cors");
const axios = require("axios");

const { employees, materials, vendors, pendingPRs } = require("./webapp/model/MockData");

const app = express();
const PORT = 3001;

app.use(cors());
app.use(express.json());

const PAMS_ESCALATION_THRESHOLD = 300000000; // > 300 trieu VND -> Truong bo phan mua sam
const LEGAL_ESCALATION_THRESHOLD = 100000000; // > 100 trieu VND -> Phap che

// In-memory stand-in for ZG1_APPROVAL until the real SAP table/BAPI is available.
const approvalStore = [...pendingPRs].map((pr) => ({ ...pr }));
let nextApprovalId = approvalStore.length + 1;

function buildApprovalFlags(totalValue) {
	return {
		needsProcurementHeadReview: totalValue > PAMS_ESCALATION_THRESHOLD,
		needsLegalReview: totalValue > LEGAL_ESCALATION_THRESHOLD
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
			`${process.env.SAP_HOST}/sap/opu/odata/sap/ZG1_PROC_SRV/EmployeeSet`,
			{
				params: {
					"$filter": `Email eq '${email}'`,
					"$format": "json"
				},
				auth: {
					username: process.env.SAP_USER,
					password: process.env.SAP_PASS
				}
			}
		);

		const results = (response.data && response.data.d && response.data.d.results) || [];
		const employee = results[0];

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

// --- Approval workflow (in-memory stand-in for ZG1_APPROVAL) -----------
app.post("/api/approval/submit", (req, res) => {
	const { requesterEmail, materialName, quantity, totalValue, costCenter } = req.body || {};

	if (!requesterEmail || !totalValue) {
		return res.status(400).json({ success: false, message: "Thieu thong tin de nghi mua sam." });
	}

	const record = {
		PRId: `PR-${new Date().getFullYear()}-${String(nextApprovalId).padStart(4, "0")}`,
		RequesterEmail: requesterEmail,
		MaterialName: materialName,
		Quantity: quantity,
		TotalValue: totalValue,
		CostCenter: costCenter,
		Status: "PENDING_APPROVAL",
		CreatedAt: new Date().toISOString(),
		...buildApprovalFlags(totalValue)
	};

	nextApprovalId += 1;
	approvalStore.push(record);

	return res.status(201).json({ success: true, approval: record });
});

app.get("/api/approval/pending", (req, res) => {
	const pending = approvalStore.filter((item) => item.Status === "PENDING_APPROVAL");
	return res.json({ success: true, data: pending });
});

app.patch("/api/approval/:id", (req, res) => {
	const { id } = req.params;
	const { status, comment } = req.body || {};

	const record = approvalStore.find((item) => item.PRId === id);

	if (!record) {
		return res.status(404).json({ success: false, message: "Khong tim thay de nghi mua sam." });
	}

	record.Status = status || record.Status;
	record.Comment = comment || record.Comment;
	record.UpdatedAt = new Date().toISOString();

	return res.json({ success: true, approval: record });
});

app.listen(PORT, () => {
	console.log(`QDAVY Procurement API server dang chay tai http://localhost:${PORT}`);
	console.log(process.env.SAP_HOST
		? `Che do: goi OData that toi ${process.env.SAP_HOST}`
		: "Che do: mock data (SAP_HOST chua duoc cau hinh)");
});
