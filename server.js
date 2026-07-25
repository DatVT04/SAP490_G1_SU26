require("dotenv").config();

if (!process.env.SAP_HOST) {
	console.error("Thieu SAP_HOST trong .env — server chi chay voi SAP that, khong con che do mock.");
	process.exit(1);
}

const express = require("express");
const cors = require("cors");
const axios = require("axios");

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

// Health check cho hosting/uptime monitor
app.get("/api/health", (req, res) => res.json({ ok: true }));

// Serve frontend UI5 (webapp/) ngay tu Express — khi hosting chi can 1 service,
// FE + BE cung origin. (UI5 runtime load tu CDN ui5.sap.com, khong can build.)
const path = require("path");
app.use(express.static(path.join(__dirname, "webapp")));

// Ten service OData that duoc dang ky qua /IWFND/MAINT_SERVICE. SEGW tu dong them hau to
// "_SRV" vao ten project (ZG1_PROC_SRV) nen ten service thuc te co 2 lan "_SRV" lien tiep.
const ODATA_SERVICE_PATH = "/sap/opu/odata/sap/ZG1_PROC_SRV_SRV";

const PAMS_ESCALATION_THRESHOLD = 300000000; // > 300 trieu VND -> Truong bo phan mua sam
const LEGAL_ESCALATION_THRESHOLD = 100000000; // > 100 trieu VND -> Phap che

// In-memory cache cho ZG1_APPROVAL — chi luu PR/PO THAT nguoi dung tao qua app nay,
// khong con seed du lieu gia. Ton tai vi OData chua co entity doc/ghi truc tiep
// ZG1_APPROVAL (BE-2 chua lam xong); moi PR van duoc ghi that ben SAP qua
// PurchaseRequisitionSet (BAPI_PR_CREATE), cache nay chi phuc vu UI PR-02 hien danh sach.
const approvalStore = [];
let nextApprovalId = 1;

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

// Xin X-CSRF-Token truoc khi goi POST/MERGE/PATCH/DELETE vao SAP Gateway.
// Cac route PR/PO create hien tai chua can cai nay (co the vi CSRF check dang
// tat cho nhung method do, hoac chua thuc su test qua) — nhung EmployeeSet
// UPDATE_ENTITY dang tra 403 khong co body JSON chuan, dau hieu dien hinh cua
// CSRF bi tu choi o tang framework (truoc khi vao toi ABAP method).
async function fetchSapCsrfToken() {
	const response = await axios.get(
		`${process.env.SAP_HOST}${ODATA_SERVICE_PATH}/`,
		{
			auth: sapAuth(),
			headers: { "X-CSRF-Token": "Fetch" }
		}
	);
	const token = response.headers["x-csrf-token"];
	const setCookieHeaders = response.headers["set-cookie"] || [];
	const cookie = setCookieHeaders.map((c) => c.split(";")[0]).join("; ");
	return { token, cookie };
}

// --- POST /api/login ---------------------------------------------------
// Xac thuc qua SAP HCM: email (PA0105 subtype 0010, cau hinh bang PA20/PA30)
// -> EmployeeSet tra ve Role/FullName/Pernr. SAP la nguon danh tinh duy nhat,
// khong con fallback ve du lieu gia khi SAP loi hoac khong tim thay email.
app.post("/api/login", async (req, res) => {
	const { email } = req.body || {};

	if (!email) {
		return res.status(400).json({ success: false, message: "Thieu email." });
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

// --- PATCH /api/profile -----------------------------------------------------
// Cap nhat thong tin ca nhan (Ho ten, SDT, dia chi), ghi that vao SAP HCM
// (Infotype 0002 + 0006) qua OData EmployeeSet MERGE -> method EMPLOYEESET_UPDATE_ENTITY
// ben ABAP (BE-2). KHONG cho sua Email o day — Email la key dinh danh dang nhap,
// doi email phai lam truc tiep qua PA30 (Infotype 0105), khong qua route nay.
//
// Neu SAP tra loi CSRF token error (403 Forbidden voi header x-csrf-token: Required),
// nghia la service ZG1_PROC_SRV_SRV chua tat CSRF check — can GET truoc voi header
// "X-CSRF-Token: Fetch!" de lay token roi moi goi MERGE kem token + cookie do.
app.patch("/api/profile", async (req, res) => {
	const { email, firstName, lastName, phoneNumber, street, city, postalCode } = req.body || {};

	if (!email) {
		return res.status(400).json({ success: false, message: "Thieu email." });
	}

	const payload = {};
	if (firstName !== undefined) { payload.FirstName = firstName; }
	if (lastName !== undefined) { payload.LastName = lastName; }
	if (phoneNumber !== undefined) { payload.PhoneNumber = phoneNumber; }
	if (street !== undefined) { payload.Street = street; }
	if (city !== undefined) { payload.City = city; }
	if (postalCode !== undefined) { payload.PostalCode = postalCode; }

	if (Object.keys(payload).length === 0) {
		return res.status(400).json({ success: false, message: "Khong co truong nao de cap nhat." });
	}

	try {
		const { token, cookie } = await fetchSapCsrfToken();
		console.log(`[profile] CSRF token nhan duoc: ${token ? "co (" + token.slice(0, 8) + "...)" : "KHONG CO / undefined"}, cookie: ${cookie ? "co" : "KHONG CO"}`);

		await axios({
			method: "MERGE",
			url: `${process.env.SAP_HOST}${ODATA_SERVICE_PATH}/EmployeeSet('${encodeURIComponent(email)}')`,
			data: payload,
			auth: sapAuth(),
			headers: {
				"Content-Type": "application/json",
				"X-CSRF-Token": token,
				"Cookie": cookie
			}
		});

		// MERGE thanh cong thuong tra 204 No Content (khong co body) -> doc lai
		// EmployeeSet de FE nhan duoc du lieu moi nhat, dong bo lai model "user".
		const response = await axios.get(
			`${process.env.SAP_HOST}${ODATA_SERVICE_PATH}/EmployeeSet`,
			{ params: { "$filter": `Email eq '${email}'`, "$format": "json" }, auth: sapAuth() }
		);
		const results = (response.data && response.data.d && response.data.d.results) || [];
		const employee = results.find(
			(emp) => emp.Email && emp.Email.toLowerCase() === String(email).toLowerCase()
		);

		return res.json({ success: true, employee: employee || null });
	} catch (error) {
		const sapMessage =
			(error.response && error.response.data && error.response.data.error &&
				error.response.data.error.message && error.response.data.error.message.value) ||
			(error.response && `SAP tra ve HTTP ${error.response.status}`) ||
			error.message;
		console.error(`[profile] Cap nhat ho so that bai: ${sapMessage}`);
		console.error(`[profile] DEBUG - request URL: ${error.config && error.config.url}`);
		console.error(`[profile] DEBUG - response status: ${error.response && error.response.status}`);
		console.error(`[profile] DEBUG - response headers: ${JSON.stringify(error.response && error.response.headers)}`);
		console.error(`[profile] DEBUG - response data: ${JSON.stringify(error.response && error.response.data)}`);
		return res.status(422).json({
			success: false,
			message: "Khong the cap nhat ho so: " + sapMessage
		});
	}
});

// --- GET /api/materials --------------------------------------------------
app.get("/api/materials", async (req, res) => {
	try {
		const response = await axios.get(
			`${process.env.SAP_HOST}${ODATA_SERVICE_PATH}/MaterialSet`,
			{ params: { "$format": "json" }, auth: sapAuth() }
		);
		const results = (response.data && response.data.d && response.data.d.results) || [];
		return res.json({ success: true, data: results });
	} catch (error) {
		return res.status(502).json({ success: false, message: "Khong the lay danh sach vat tu tu SAP." });
	}
});

// --- GET /api/vendors ------------------------------------------------------
app.get("/api/vendors", async (req, res) => {
	try {
		const response = await axios.get(
			`${process.env.SAP_HOST}${ODATA_SERVICE_PATH}/VendorSet`,
			{ params: { "$format": "json" }, auth: sapAuth() }
		);
		const results = (response.data && response.data.d && response.data.d.results) || [];
		return res.json({ success: true, data: results });
	} catch (error) {
		return res.status(502).json({ success: false, message: "Khong the lay danh sach nha cung cap tu SAP." });
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

	// Khong con fallback ve danh sach vendor gia — FE bat buoc phai truyen candidateVendors
	// (lay tu /api/vendors, tuc VendorSet that ben SAP) thi moi goi y duoc.
	if (!candidateVendors || !candidateVendors.length) {
		return res.status(400).json({
			success: false,
			message: "Thieu danh sach nha cung cap ung vien (goi /api/vendors truoc de lay tu SAP)."
		});
	}

	const vendorList = candidateVendors;

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
// db.js (Postgres/in-memory) la nguon du lieu cho man PR02 (vi OData chua co entity doc ZG1_APPROVAL).
// Khi co SAP_HOST, PR cung duoc tao that ben SAP qua OData PurchaseRequisitionSet (BAPI_PR_CREATE),
// nhung ket qua tao that KHONG chan luong demo neu SAP loi/khong ket noi duoc.

// POST /api/approval/submit — Tao PR moi voi nhieu Line Item (Section 3.4 meeting minutes)
app.post("/api/approval/submit", async (req, res) => {
	const { requesterEmail, currency, totalPRValue, items } = req.body || {};

	if (!requesterEmail) {
		return res.status(400).json({ success: false, message: "Thieu thong tin nguoi de nghi." });
	}
	if (!Array.isArray(items) || items.length === 0) {
		return res.status(400).json({ success: false, message: "PR phai co it nhat 1 vat tu." });
	}

	// Validate tung dong vat tu
	for (var i = 0; i < items.length; i++) {
		var it = items[i];
		if (!it.description) {
			return res.status(400).json({ success: false, message: "Dong " + (i + 1) + ": Thieu mo ta vat tu." });
		}
		if (!it.quantity || Number(it.quantity) <= 0) {
			return res.status(400).json({ success: false, message: "Dong " + (i + 1) + ": So luong khong hop le." });
		}
	}

	let sapPrNumber = null;
	let sapIntegration = "created";
	let sapErrorMessage = null;

	// Tao PR trong SAP voi TAT CA line items qua deep-insert: POST PurchaseReqHeaderSet
	// kem navigation property PRToItems -> BAPI_PR_CREATE nhan bang pritem nhieu dong,
	// tra ve 1 so PR duy nhat (giong ME51N nhap nhieu dong tren cung 1 PR). Cach nay
	// thay cho PurchaseRequisitionSet phang cu (1 item/call). Cau truc mirror PurchaseOrder
	// (PurchaseOrderHeaderSet + POToItems). Xem HUONG_DAN_PR_DEEP_ENTITY.md.
	try {
		const sapResponse = await axios.post(
			`${process.env.SAP_HOST}${ODATA_SERVICE_PATH}/PurchaseReqHeaderSet`,
			{
				CompanyCode: "QD01",
				Requester: requesterEmail,
				Currency: currency || "VND",
				TotalValue: String(totalPRValue || 0),
				PRToItems: {
					results: items.map(function (item, idx) {
						return {
							PreqItem:       String(idx + 1).padStart(5, "0"),
							MaterialNo:     item.materialNo || "",
							MaterialType:   item.materialType || "",
							Description:    item.description || "",
							Quantity:       String(item.quantity),
							UoM:            item.uom || "PC",
							EstimatedValue: String(item.estimatedValue || 0),
							CostCenter:     item.costCenter || "",
							InternalOrder:  item.internalOrder || "",
							AssetNo:        item.assetNo || ""
						};
					})
				}
			},
			{ auth: sapAuth(), headers: { "Content-Type": "application/json" } }
		);
		sapPrNumber = sapResponse.data && sapResponse.data.d && sapResponse.data.d.PrNumber;
	} catch (error) {
		sapIntegration = "failed";
		sapErrorMessage =
			(error.response && error.response.data && error.response.data.error &&
				error.response.data.error.message && error.response.data.error.message.value) ||
			(error.response && `SAP tra ve HTTP ${error.response.status}`) ||
			error.message;
		console.error(`[approval/submit] Tao PR that ben SAP THAT BAI: ${sapErrorMessage}`);
	}

	// Khong con che do mock — SAP tu choi ghi thi tra loi that cho nguoi dung, khong
	// tao PR gia trong bo nho roi bao "thanh cong". Dung 422 (khong phai 502) de FE
	// hien duoc chinh xac thong bao loi tu SAP thay vi "may chu gap su co" chung chung.
	if (sapIntegration === "failed") {
		return res.status(422).json({
			success: false,
			sapIntegration: "failed",
			sapErrorMessage: sapErrorMessage,
			message: "Khong the ghi de nghi mua sam vao SAP: " + sapErrorMessage
		});
	}

	const newPRId = sapPrNumber ||
		`PR-${new Date().getFullYear()}-${String(nextApprovalId).padStart(4, "0")}`;

	const record = {
		PRId: newPRId,
		RequesterEmail: requesterEmail,
		TotalValue: totalPRValue || 0,
		Currency: currency || "VND",
		Status: "PENDING_APPROVAL",
		CreatedAt: new Date().toISOString(),
		// Mang items — cau truc chinh theo Section 3.4 meeting minutes
		items: items.map(function (item, idx) {
			return {
				LineNo:        String(idx + 1).padStart(5, "0"),
				MaterialNo:    item.materialNo    || (item.isFreeText ? "FREE_TEXT" : ""),
				MaterialType:  item.materialType  || "ZSRV",
				Description:   item.description   || "",
				Quantity:      Number(item.quantity),
				UoM:           item.uom            || "PC",
				EstimatedValue: Number(item.estimatedValue) || 0,
				CostCenter:    item.costCenter     || "",
				InternalOrder: item.internalOrder  || "",
				AssetNo:       item.assetNo        || "",
				isFreeText:    item.isFreeText      || false
			};
		}),
		...buildApprovalFlags(totalPRValue || 0)
	};

	nextApprovalId += 1;
	approvalStore.push(record);

	return res.status(201).json({ success: true, approval: record, sapIntegration });
});

app.get("/api/approval/pending", (req, res) => {
	const pending = approvalStore.filter((item) => item.Status === "PENDING_APPROVAL");
	return res.json({ success: true, data: pending });
});

// --- GET /api/approval/approved -------------------------------------------
// Tra ve cac PR da duoc duyet (Status = APPROVED) de PO01 co the chon va link.
app.get("/api/approval/approved", (req, res) => {
	const approved = approvalStore.filter((item) => item.Status === "APPROVED");
	return res.json({ success: true, data: approved });
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
						Plant: "QDPL",
					PreqNo: item.preqNo || ""   // BANFN - lien ket toi PR nguon (EKPO-BANFN)
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

// --- GET /api/po/report (Báo cáo lịch sử Đơn hàng từ SAP) ------------------
app.get("/api/po/report", async (req, res) => {
	try {
		// Gọi chính xác tới EntitySet Lịch sử PO hoạt động trên Gateway thật của bạn
		const response = await axios.get(
			`${process.env.SAP_HOST}${ODATA_SERVICE_PATH}/PurchaseOrderHistorySet`, 
			{ 
				params: { "$format": "json" }, 
				auth: sapAuth() 
			}
		);
		const results = (response.data && response.data.d && response.data.d.results) || [];
		
		// Trả về dữ liệu thật từ SAP thành công
		return res.json({ success: true, sapIntegration: "fetched", data: results });

	} catch (error) {
		// 🛠️ IN LỖI CHI TIẾT RA TERMINAL ĐỂ KIỂM TRA
		console.error("❌ LỖI KẾT NỐI TỪ NODEJS SANG SAP GATEWAY:");
		if (error.response) {
			console.error("Mã lỗi HTTP từ SAP:", error.response.status);
			console.error("Chi tiết phản hồi lỗi:", error.response.data);
		} else {
			console.error("Lỗi hệ thống mạng (Timeout/Wrong Port):", error.message);
		}

		// Trả về lỗi rõ ràng cho Front-End thay vì lấp liếm bằng dữ liệu mock
		return res.status(502).json({ 
			success: false, 
			sapError: true, 
			message: "Node.js không thể kết nối tới SAP Gateway thật!" 
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
