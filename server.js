require("dotenv").config();

const express = require("express");
const cors = require("cors");
const axios = require("axios");

const { employees, materials, vendors, pendingPRs } = require("./webapp/model/MockData");

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

app.get("/api/health", (req, res) => res.json({ ok: true }));

const path = require("path");
app.use(express.static(path.join(__dirname, "webapp")));

const ODATA_SERVICE_PATH = "/sap/opu/odata/sap/ZG1_PROC_SRV_SRV";

const PAMS_ESCALATION_THRESHOLD = 300000000;
const LEGAL_ESCALATION_THRESHOLD = 100000000;

const approvalStore = [...pendingPRs].map((pr) => ({ ...pr }));
let nextApprovalSeq = approvalStore.length + 1;

const notificationStore = [];
let nextNotificationId = 1;

function pushNotification(toEmail, prId, message) {
	if (!toEmail) { return; }
	notificationStore.push({
		id: nextNotificationId++,
		toEmail,
		prId,
		message,
		createdAt: new Date().toISOString(),
		read: false
	});
}

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

function findCeoEmails() {
	return employees
		.filter(function (e) {
			return e.IsActive && String(e.Role || "").toUpperCase() === "CEO";
		})
		.map(function (e) { return e.Email; })
		.filter(Boolean);
}

function notifyRequester(record, message) {
	pushNotification(record.RequesterEmail, record.PRId, message);
}

function notifyCeos(prId, message) {
	findCeoEmails().forEach(function (email) {
		pushNotification(email, prId, message);
	});
}

// ============================================================================
// MASTER: InternalOrderSet (SAP) + GL từ PurchaseRequisitionHisSet
// ============================================================================

async function fetchInternalOrderMaster() {
	const EMPTY = {
		internalOrders: [],
		costCenters: [],
		ioToCostCenter: {},
		costCenterToIOs: {}
	};
	if (!process.env.SAP_HOST) { return EMPTY; }

	try {
		const response = await axios.get(
			`${process.env.SAP_HOST}${ODATA_SERVICE_PATH}/InternalOrderSet`,
			{ params: { "$format": "json" }, auth: sapAuth() }
		);
		const results = (response.data && response.data.d && response.data.d.results) || [];

		const ioToCostCenter = {};
		const costCenterToIOs = {};
		const ccMap = {};

		const internalOrders = results.map(function (row) {
			const orderNo = String(row.OrderNo || row.InternalOrder || "").trim();
			const cc = String(row.CostCenter || "").trim();
			const orderName = String(row.OrderName || row.Description || orderNo).trim();
			const ccName = String(row.CostCenterName || cc).trim();

			if (orderNo && cc) {
				ioToCostCenter[orderNo] = cc;
				if (!costCenterToIOs[cc]) { costCenterToIOs[cc] = []; }
				if (costCenterToIOs[cc].indexOf(orderNo) === -1) {
					costCenterToIOs[cc].push(orderNo);
				}
			}
			if (cc) { ccMap[cc] = ccName || cc; }

			return {
				InternalOrder: orderNo,
				Description: orderName,
				CostCenter: cc,
				CostCenterName: ccName,
				CompanyCode: row.CompanyCode || "",
				OrderType: row.OrderType || ""
			};
		}).filter(function (x) { return !!x.InternalOrder; });

		const costCenters = Object.keys(ccMap).sort().map(function (code) {
			return { CostCenter: code, Description: ccMap[code] };
		});

		return { internalOrders, costCenters, ioToCostCenter, costCenterToIOs };
	} catch (error) {
		console.error("⚠️ InternalOrderSet:", error.message);
		return EMPTY;
	}
}

async function fetchGLAccountsFromHistory() {
	if (!process.env.SAP_HOST) { return []; }
	try {
		const response = await axios.get(
			`${process.env.SAP_HOST}${ODATA_SERVICE_PATH}/PurchaseRequisitionHisSet`,
			{
				params: { "$format": "json", "$select": "GLAccount" },
				auth: sapAuth()
			}
		);
		const results = (response.data && response.data.d && response.data.d.results) || [];
		const map = {};
		results.forEach(function (row) {
			const gl = String(row.GLAccount || "").trim();
			if (gl) { map[gl] = true; }
		});
		return Object.keys(map).sort().map(function (code) {
			return { GLAccount: code, Description: code };
		});
	} catch (error) {
		console.error("⚠️ GL history:", error.message);
		return [];
	}
}

app.get("/api/gl-accounts", async (req, res) => {
	return res.json({ success: true, data: await fetchGLAccountsFromHistory() });
});

app.get("/api/cost-centers", async (req, res) => {
	const master = await fetchInternalOrderMaster();
	return res.json({ success: true, data: master.costCenters });
});

app.get("/api/internal-orders", async (req, res) => {
	const master = await fetchInternalOrderMaster();
	return res.json({
		success: true,
		data: master.internalOrders,
		ioToCostCenter: master.ioToCostCenter,
		costCenterToIOs: master.costCenterToIOs
	});
});

function defaultGLAccount(materialType) {
	var GL_MAP = { ZAST: "211100", ZSRV: "641000", ZROH: "641000" };
	return GL_MAP[materialType] || "641000";
}

/** Chỉ gọi khi duyệt cuối — trả PRNumber thật từ SAP */
async function createPRInSAP(record) {
	if (!process.env.SAP_HOST) {
		return { sapIntegration: "mock", sapPrNumber: null, sapErrorMessage: "SAP_HOST chua cau hinh" };
	}

	const firstItem = record.items[0] || {};
	try {
		const tokenResponse = await axios.get(
			`${process.env.SAP_HOST}${ODATA_SERVICE_PATH}`,
			{ auth: sapAuth(), headers: { "X-CSRF-Token": "Fetch", "sap-language": "EN" } }
		);
		const csrfToken = tokenResponse.headers["x-csrf-token"];
		const cookies = tokenResponse.headers["set-cookie"];

		const sapResponse = await axios.post(
			`${process.env.SAP_HOST}${ODATA_SERVICE_PATH}/PurchaseRequisitionHisSet`,
			{
				MaterialNo: firstItem.MaterialNo || "",
				Description: firstItem.Description || "",
				Quantity: String(firstItem.Quantity || 1),
				Uom: firstItem.UoM || "PC",
				EstimatedValue: String(firstItem.EstimatedValue || 0),
				Currency: record.Currency || "VND",
				CostCenter: firstItem.CostCenter || "",
				InternalOrder: firstItem.InternalOrder || "",
				GLAccount: firstItem.GLAccount || defaultGLAccount(firstItem.MaterialType)
			},
			{
				auth: sapAuth(),
				headers: {
					"Content-Type": "application/json",
					"X-CSRF-Token": csrfToken,
					"Cookie": cookies ? cookies.join("; ") : "",
					"sap-language": "EN"
				}
			}
		);

		const sapPrNumber = sapResponse.data && sapResponse.data.d
			&& (sapResponse.data.d.PRNumber || sapResponse.data.d.PrNumber || sapResponse.data.d.PRId);

		if (!sapPrNumber) {
			return {
				sapIntegration: "failed",
				sapPrNumber: null,
				sapErrorMessage: "SAP khong tra ve PRNumber trong response"
			};
		}
		return { sapIntegration: "created", sapPrNumber: String(sapPrNumber), sapErrorMessage: null };
	} catch (error) {
		let sapErrorMessage = null;
		const errorDetails = error.response?.data?.error?.innererror?.errordetails;
		if (Array.isArray(errorDetails)) {
			const realErrors = errorDetails
				.filter((d) => d.severity === "error" && d.code !== "/IWBEP/CX_MGW_BUSI_EXCEPTION")
				.map((d) => d.message);
			if (realErrors.length) { sapErrorMessage = realErrors.join("; "); }
		}
		if (!sapErrorMessage) {
			sapErrorMessage = error.response?.data?.error?.message?.value
				|| (error.response ? `SAP tra ve HTTP ${error.response.status}` : error.message);
		}
		console.error("[createPRInSAP] THAT BAI:", sapErrorMessage);
		return { sapIntegration: "failed", sapPrNumber: null, sapErrorMessage };
	}
}

// --- Login ---
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
			return res.status(401).json({ success: false, message: "Email khong ton tai hoac tai khoan da bi khoa." });
		}
		return res.json({ success: true, employee });
	}

	try {
		const response = await axios.get(
			`${process.env.SAP_HOST}${ODATA_SERVICE_PATH}/EmployeeSet`,
			{ params: { "$filter": `Email eq '${email}'`, "$format": "json" }, auth: sapAuth() }
		);
		const results = (response.data && response.data.d && response.data.d.results) || [];
		const employee = results.find(
			(emp) => emp.Email && emp.Email.toLowerCase() === String(email).toLowerCase()
		);

		if (!employee) {
			const mockEmp = employees.find((emp) => emp.Email.toLowerCase() === String(email).toLowerCase());
			if (!mockEmp || !mockEmp.IsActive) {
				return res.status(401).json({ success: false, message: "Email khong ton tai hoac tai khoan da bi khoa." });
			}
			return res.json({ success: true, employee: mockEmp });
		}
		if (!employee.IsActive) {
			return res.status(401).json({ success: false, message: "Email khong ton tai hoac tai khoan da bi khoa." });
		}
		return res.json({ success: true, employee });
	} catch (error) {
		const mockEmp = employees.find((emp) => emp.Email.toLowerCase() === String(email).toLowerCase());
		if (mockEmp && mockEmp.IsActive) {
			return res.json({ success: true, employee: mockEmp });
		}
		return res.status(502).json({ success: false, message: "Khong the ket noi toi he thong SAP." });
	}
});

app.get("/api/materials", async (req, res) => {
	if (!process.env.SAP_HOST) {
		return res.json({ success: true, data: materials });
	}
	try {
		const response = await axios.get(
			`${process.env.SAP_HOST}${ODATA_SERVICE_PATH}/MaterialSet`,
			{ params: { "$format": "json" }, auth: sapAuth() }
		);
		return res.json({ success: true, data: (response.data && response.data.d && response.data.d.results) || [] });
	} catch (error) {
		return res.json({ success: true, data: materials, sapError: true });
	}
});

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
		const allVendors = results.map((v) => ({
			...v,
			VendorNo: v.VendorNo || v.Lifnr || v.Vendor || "",
			VendorName: v.VendorName || v.Name1 || v.Name || `Nhà cung cấp ${v.VendorNo || v.Lifnr}`
		}));
		return res.json({ success: true, data: allVendors });
	} catch (error) {
		console.error("❌ VendorSet:", error.message);
		return res.json({ success: true, data: vendors, sapError: true });
	}
});

app.post("/api/ai/recommend-vendor", async (req, res) => {
	const { materialName, materialGroup, quantity, budget, vendors: candidateVendors } = req.body || {};
	if (!process.env.GROQ_API_KEY) {
		return res.status(500).json({ success: false, message: "Thieu GROQ_API_KEY." });
	}
	const vendorList = candidateVendors && candidateVendors.length ? candidateVendors : vendors;
	const prompt = `Ban la chuyen gia mua hang. De xuat NCC cho:
- Vat tu: ${materialName || "N/A"} (nhom: ${materialGroup || "N/A"})
- So luong: ${quantity || "N/A"}
- Ngan sach: ${budget || "N/A"} VND
Danh sach: ${JSON.stringify(vendorList)}
Tra loi ngan gon tieng Viet: ten NCC va ly do.`;

	try {
		const response = await axios.post(
			"https://api.groq.com/openai/v1/chat/completions",
			{ model: "llama-3.3-70b-versatile", messages: [{ role: "user", content: prompt }], temperature: 0.3 },
			{ headers: { Authorization: `Bearer ${process.env.GROQ_API_KEY}`, "Content-Type": "application/json" } }
		);
		return res.json({ success: true, recommendation: response.data.choices[0].message.content });
	} catch (error) {
		return res.status(502).json({ success: false, message: "Khong the goi AI." });
	}
});

// ============================================================================
// APPROVAL
// Submit  → ID tạm PR-YYYY-NNNN, CHƯA ghi SAP, PENDING_CFO
// CFO từ chối → thông báo requester
// CFO duyệt + >300tr → PENDING_CEO, thông báo requester + CEO
// CFO/CEO duyệt cuối → createPRInSAP → mã SAP thật, thông báo requester
// ============================================================================

app.post("/api/approval/submit", async (req, res) => {
	const { requesterEmail, currency, totalPRValue, items } = req.body || {};

	if (!requesterEmail) {
		return res.status(400).json({ success: false, message: "Thieu thong tin nguoi de nghi." });
	}
	if (!Array.isArray(items) || items.length === 0) {
		return res.status(400).json({ success: false, message: "PR phai co it nhat 1 vat tu." });
	}
	for (var i = 0; i < items.length; i++) {
		var it = items[i];
		if (!it.description) {
			return res.status(400).json({ success: false, message: "Dong " + (i + 1) + ": Thieu mo ta vat tu." });
		}
		if (!it.quantity || Number(it.quantity) <= 0) {
			return res.status(400).json({ success: false, message: "Dong " + (i + 1) + ": So luong khong hop le." });
		}
	}

	const tempPRId = "PR-" + new Date().getFullYear() + "-" + String(nextApprovalSeq).padStart(4, "0");
	nextApprovalSeq += 1;

	const record = {
		PRId: tempPRId,
		InternalId: tempPRId,
		SapPRId: null,
		RequesterEmail: requesterEmail,
		TotalValue: totalPRValue || 0,
		Currency: currency || "VND",
		Status: "PENDING_CFO",
		CreatedAt: new Date().toISOString(),
		items: items.map(function (item, idx) {
			return {
				LineNo: String(idx + 1).padStart(5, "0"),
				MaterialNo: item.materialNo || (item.isFreeText ? "FREE_TEXT" : ""),
				MaterialType: item.materialType || "ZSRV",
				Description: item.description || "",
				Quantity: Number(item.quantity),
				UoM: item.uom || "PC",
				EstimatedValue: Number(item.estimatedValue) || 0,
				CostCenter: item.costCenter || "",
				InternalOrder: item.internalOrder || "",
				AssetNo: item.assetNo || "",
				GLAccount: item.glAccount || "",
				isFreeText: item.isFreeText || false
			};
		}),
		...buildApprovalFlags(totalPRValue || 0)
	};

	approvalStore.push(record);

	notifyRequester(
		record,
		"Đề nghị " + record.PRId + " đã được gửi, đang chờ CFO xem xét. Số PR SAP sẽ có sau khi phê duyệt."
	);

	return res.status(201).json({
		success: true,
		approval: record,
		sapIntegration: "pending_approval"
	});
});

app.get("/api/approval/pending", (req, res) => {
	const role = String(req.query.role || "").toUpperCase();
	const statusFilter = role === "CEO" ? "PENDING_CEO" : "PENDING_CFO";
	const pending = approvalStore.filter((item) => item.Status === statusFilter);
	return res.json({ success: true, data: pending });
});

app.get("/api/approval/approved", (req, res) => {
	const data = approvalStore.filter((item) => {
		const s = String(item.Status || "").toUpperCase();
		return s === "APPROVED" || s === "OPENED" || s === "OPEN";
	});
	return res.json({ success: true, data });
});

app.get("/api/approval/:id", (req, res) => {
	const { id } = req.params;
	const record = approvalStore.find(
		(item) => item.PRId === id || item.InternalId === id || item.SapPRId === id
	);
	if (!record) {
		return res.status(404).json({
			success: false,
			message: "Không tìm thấy đề nghị mua sắm " + id + "."
		});
	}
	return res.json({ success: true, data: record });
});

app.get("/api/notifications", (req, res) => {
	const { email } = req.query;
	if (!email) {
		return res.status(400).json({ success: false, message: "Thieu email." });
	}
	const list = notificationStore
		.filter((n) => n.toEmail.toLowerCase() === String(email).toLowerCase())
		.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
	return res.json({ success: true, data: list });
});

app.patch("/api/notifications/:id/read", (req, res) => {
	const id = Number(req.params.id);
	const n = notificationStore.find((x) => x.id === id);
	if (!n) {
		return res.status(404).json({ success: false, message: "Khong tim thay thong bao." });
	}
	n.read = true;
	return res.json({ success: true });
});

app.patch("/api/approval/:id", async (req, res) => {
	const { id } = req.params;
	const { status, comment, decidedByEmail, decidedByRole } = req.body || {};

	const record = approvalStore.find(
		(item) => item.PRId === id || item.InternalId === id
	);
	if (!record) {
		return res.status(404).json({ success: false, message: "Khong tim thay de nghi mua sam." });
	}

	const sRole = String(decidedByRole || "").toUpperCase();

	if (sRole === "CFO" && record.Status !== "PENDING_CFO") {
		return res.status(400).json({ success: false, message: "Đề nghị này không ở trạng thái chờ CFO duyệt." });
	}
	if (sRole === "CEO" && record.Status !== "PENDING_CEO") {
		return res.status(400).json({ success: false, message: "Đề nghị này không ở trạng thái chờ CEO duyệt." });
	}

	// ── TỪ CHỐI ──────────────────────────────────────────────────────────
	if (status === "REJECTED") {
		record.Status = "REJECTED";
		record.Comment = comment || record.Comment;
		record.DecidedByEmail = decidedByEmail;
		record.DecidedByRole = sRole;
		record.UpdatedAt = new Date().toISOString();

		notifyRequester(
			record,
			"Đề nghị " + record.PRId + " đã bị TỪ CHỐI bởi " + sRole + "."
				+ (comment ? " Lý do: " + comment : "")
		);

		return res.json({ success: true, approval: record });
	}

	// ── PHÊ DUYỆT ────────────────────────────────────────────────────────
	if (status === "APPROVED") {
		// CFO + vượt 300tr → leo thang CEO (CHƯA ghi SAP)
		if (sRole === "CFO" && record.needsProcurementHeadReview) {
			record.Status = "PENDING_CEO";
			record.EscalationReason = "Giá trị vượt 300 triệu VND — cần CEO phê duyệt thêm.";
			record.Comment = comment || record.Comment;
			record.UpdatedAt = new Date().toISOString();

			notifyRequester(
				record,
				"Đề nghị " + record.PRId + " đã được CFO chuyển lên CEO. Bạn sẽ nhận thông báo khi CEO quyết định."
			);

			notifyCeos(
				record.PRId,
				"PR " + record.PRId + " từ " + record.RequesterEmail
					+ " leo thang lên CEO. " + record.EscalationReason
					+ " Giá trị: " + Number(record.TotalValue).toLocaleString("vi-VN") + " " + record.Currency
			);

			return res.json({
				success: true,
				approval: record,
				escalated: true,
				reason: record.EscalationReason
			});
		}

		// Duyệt cuối (CFO thường hoặc CEO) → GHI SAP → mã PR thật
		const sapResult = await createPRInSAP(record);

		if (sapResult.sapIntegration === "failed" || !sapResult.sapPrNumber) {
			return res.status(502).json({
				success: false,
				message: "Không ghi được PR lên SAP: " + (sapResult.sapErrorMessage || "không có PRNumber"),
				sapErrorMessage: sapResult.sapErrorMessage
			});
		}

		const oldId = record.PRId;
		record.InternalId = record.InternalId || oldId;
		record.SapPRId = sapResult.sapPrNumber;
		record.PRId = sapResult.sapPrNumber;
		record.Status = "APPROVED";
		record.Comment = comment || record.Comment;
		record.DecidedByEmail = decidedByEmail;
		record.DecidedByRole = sRole;
		record.UpdatedAt = new Date().toISOString();

		notifyRequester(
			record,
			"Đề nghị " + oldId + " đã được PHÊ DUYỆT bởi " + sRole
				+ ". Số PR trên SAP: " + record.SapPRId + " (ME53N)."
		);

		return res.json({
			success: true,
			approval: record,
			sapIntegration: "created",
			sapPrNumber: sapResult.sapPrNumber
		});
	}

	return res.status(400).json({ success: false, message: "Status không hợp lệ (chỉ nhận APPROVED/REJECTED)." });
});

// --- PO ---
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

	const totalValue = items.reduce(
		(sum, item) => sum + (Number(item.netPrice) || 0) * (Number(item.quantity) || 0),
		0
	);

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
		const tokenResponse = await axios.get(
			`${process.env.SAP_HOST}${ODATA_SERVICE_PATH}/PurchaseOrderHeaderSet`,
			{ auth: sapAuth(), headers: { "X-CSRF-Token": "Fetch", "sap-language": "EN" } }
		);
		const csrfToken = tokenResponse.headers["x-csrf-token"];
		const cookies = tokenResponse.headers["set-cookie"];

		// 🔑 BƯỚC 2: Chuẩn hóa Vendor & Item đúng SEGW & Purchasing Group = QD1
		var rawVendor = String(vendorNo || "").trim();
		var formattedVendor = /^\d+$/.test(rawVendor) ? rawVendor.padStart(10, "0") : rawVendor;

		// Tạo timestamp OData V2 cho ngày hiện tại (/Date(ms)/)
		const now = new Date();
		const sapODataDate = now.toISOString().split('T')[0];

		const sapPayload = {
			CompanyCode: "QD01",
			DocType: "ZPO",
			VendorNo: formattedVendor,
			PurchOrg: "QDPO",
			PurchGroup: "QD1",
			Currency: "VND",
			DocDate: sapODataDate,
			TotalValue: totalValue.toFixed(2),
			// server.js (Đoạn build POToItems)
			POToItems: {
				results: items.map((item, idx) => {
					var rawMat = String(item.materialNo || "").trim();
					var formattedMat = (/^\d+$/.test(rawMat)) ? rawMat.padStart(18, "0") : rawMat;

					var rawAsset = String(item.assetNo || "").trim();
					var formattedAsset = "000000100000";
					if (rawAsset) {
						formattedAsset = /^\d+$/.test(rawAsset) ? rawAsset.padStart(12, "0") : rawAsset.substring(0, 12);
					}

					// 🎯 Lấy mã PR và padding thành 10 chữ số (chuẩn BANFN của SAP)
					var rawPreqNo = String(item.preqNo || req.body.prNumber || "").trim();
					var formattedPreqNo = /^\d+$/.test(rawPreqNo) ? rawPreqNo.padStart(10, "0") : rawPreqNo;

					// 🎯 Lấy dòng PR (mặc định là 00010 nếu không có)
					var rawPreqItem = String(item.preqItem || item.lineNo || "10").trim();
					var formattedPreqItem = String(rawPreqItem).padStart(5, "0");

					return {
						PoNumber: "",
						ItemNo: String((idx + 1) * 10).padStart(5, "0"),

						// 👈 TÊN TRƯỜNG CHÍNH XÁC THEO SEGW
						PreqNo: formattedPreqNo,      // Chuỗi 10 ký tự, ví dụ: "0010003924"
						PreqItem: formattedPreqItem,  // Chuỗi 5 ký tự, ví dụ: "00010"

						MaterialNo: formattedMat.substring(0, 40),
						Description: String(item.description || "").substring(0, 40),
						Quantity: Number(item.quantity || 1).toFixed(3),
						UoM: String(item.uom || "PC").substring(0, 3),
						NetPrice: Number(item.netPrice || 0).toFixed(2),
						CostCenter: String(item.costCenter || "CCADM").substring(0, 10),
						AssetNo: formattedAsset,
						Plant: "QDPL"
					};
				})
			}
		};

		const sapResponse = await axios.post(
			`${process.env.SAP_HOST}${ODATA_SERVICE_PATH}/PurchaseOrderHeaderSet`,
			sapPayload,
			{
				auth: sapAuth(),
				headers: {
					"Content-Type": "application/json",
					"X-CSRF-Token": csrfToken,
					"Cookie": cookies ? cookies.join("; ") : "",
					"sap-language": "EN"
				}
			}
		);

		// 🎯 XỬ LÝ KẾT QUẢ VÀ CẬP NHẬT TRẠNG THÁI PR
		const createdPo = sapResponse.data && sapResponse.data.d;

		const prIdToUpdate = req.body.prNumber || (items && items[0] && items[0].preqNo);
		if (prIdToUpdate) {
			// 1. Xóa khỏi store local
			const prIndex = approvalStore.findIndex(item => item.PRId === prIdToUpdate);
			if (prIndex !== -1) {
				approvalStore.splice(prIndex, 1);
			}
			// 2. 🎯 BỔ SUNG: Đánh dấu PR này ĐÃ TẠO PO để lọc bỏ khỏi kết quả SAP trả về
			completedPRs.add(String(prIdToUpdate));
		}

		return res.status(201).json({
			success: true,
			sapIntegration: "created",
			poNumber: createdPo ? createdPo.PoNumber : null,
			po: createdPo
		});
	} catch (error) {
		console.error("❌ [SAP BAPI CREATION ERROR]:");
		let detailedMsg = "Khong the tao PO qua SAP.";

		if (error.response) {
			console.error("HTTP Status:", error.response.status);
			console.error("Chi tiết từ SAP:", JSON.stringify(error.response.data || error.response.statusText, null, 2));

			if (error.response.data && error.response.data.error) {
				const errObj = error.response.data.error;
				detailedMsg = errObj.message ? errObj.message.value : detailedMsg;

				if (errObj.innererror && Array.isArray(errObj.innererror.errordetails)) {
					const messages = errObj.innererror.errordetails
						.filter(d => d.severity === "error" && d.code !== "/IWBEP/CX_MGW_BUSI_EXCEPTION")
						.map(d => d.message);
					if (messages.length > 0) {
						detailedMsg = messages.join(" | ");
					}
				}
			}
		} else {
			console.error("System Error:", error.message);
		}

		console.error("❌ [SAP PO ERROR]:", error.message);
		const sapMsg = error.response && error.response.data && error.response.data.error
			&& error.response.data.error.message && error.response.data.error.message.value;
		return res.status(502).json({
			success: false,
			message: detailedMsg,
			message: sapMsg || "Khong the tao PO qua SAP."
		});
	}
});

app.get("/api/po/report", async (req, res) => {
	if (!process.env.SAP_HOST) {
		return res.json({ success: true, sapIntegration: "mock", data: [] });
	}
	try {
		const response = await axios.get(
			`${process.env.SAP_HOST}${ODATA_SERVICE_PATH}/PurchaseOrderHistorySet`,
			{ params: { "$format": "json" }, auth: sapAuth() }
		);
		const results = (response.data && response.data.d && response.data.d.results) || [];
		return res.json({ success: true, sapIntegration: "fetched", data: results });
	} catch (error) {
		console.error("❌ PO report:", error.message);
		return res.status(502).json({
			success: false,
			sapError: true,
			message: "Node.js không thể kết nối tới SAP Gateway!"
		});
	}
});

if (require.main === module) {
	app.listen(PORT, () => {
		console.log(`QDAVY Procurement API: http://localhost:${PORT}`);
		console.log(process.env.SAP_HOST
			? `OData: ${process.env.SAP_HOST}${ODATA_SERVICE_PATH}`
			: "Che do: mock (SAP_HOST chua cau hinh)");
	});
}

module.exports = app;