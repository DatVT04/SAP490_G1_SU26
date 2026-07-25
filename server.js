require("dotenv").config();

const express = require("express");
const cors = require("cors");
const axios = require("axios");

const { employees, materials, vendors, pendingPRs } = require("./webapp/model/MockData");

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

// In-memory stand-in cho ZG1_APPROVAL de UI co the hien thi/duyet ngay, vi OData chua co
// entity doc/ghi truc tiep bang ZG1_APPROVAL. Khi tao PR, neu SAP_HOST duoc cau hinh thi
// server se GOI THEM OData PurchaseRequisitionHisSet de tao PR that ben SAP (BAPI_PR_CREATE se
// tu ghi 1 dong vao ZG1_APPROVAL that) - ca 2 con duong chay song song, khong xung dot vi
// approvalStore chi phuc vu UI, cho den khi ABAP bo sung entity doc ZG1_APPROVAL.
const approvalStore = [...pendingPRs].map((pr) => ({ ...pr }));
let nextApprovalId = approvalStore.length + 1;

function buildApprovalFlags(totalValue) {
	return {
		needsProcurementHeadReview: totalValue > PAMS_ESCALATION_THRESHOLD,
		needsLegalReview: totalValue > LEGAL_ESCALATION_THRESHOLD
	};
}

// GL Account mac dinh theo Material Type — GIA DINH TAM THOI vi FE chua co o nhap
// GLAccount rieng va Blueprint khong neu ro bang mapping nay cho buoc tao PR (Blueprint
// chi neu GL 156100/335000/331xxx/112xxx cho buoc GR/Payment, khong phai luc tao PR).
// CAN nguoi phu trach FI (theo Blueprint: Duong Thi Quynh) xac nhan lai ma tai khoan
// dung, hoac bo sung o nhap GLAccount ngay tren form PR01 de nguoi dung tu chon.
function defaultGLAccount(materialType) {
	var GL_MAP = {
		ZAST: "211100", // Tai san co dinh (tam thoi - can FI xac nhan)
		ZSRV: "641000", // Chi phi dich vu (tam thoi - can FI xac nhan)
		ZROH: "641000"  // Vat tu/hang hoa thong thuong (tam thoi - can FI xac nhan)
	};
	return GL_MAP[materialType] || "641000";
}

function sapAuth() {
	return {
		username: process.env.SAP_USER,
		password: process.env.SAP_PASS
	};
}

// --- POST /api/login ---------------------------------------------------
// Xac thuc qua SAP HCM: email (PA0105 subtype 0010, cau hinh bang PA20/PA30)
// -> EmployeeSet tra ve Role/FullName/Pernr. SAP la nguon danh tinh duy nhat.
// Email khong co trong SAP -> fallback MockData (tai khoan demo/dev).
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

		// Neu SAP khong co email nay, fallback ve MockData (demo / dev accounts)
		if (!employee) {
			const mockEmp = employees.find(
				(emp) => emp.Email.toLowerCase() === String(email).toLowerCase()
			);
			if (!mockEmp || !mockEmp.IsActive) {
				return res.status(401).json({
					success: false,
					message: "Email khong ton tai hoac tai khoan da bi khoa."
				});
			}
			return res.json({ success: true, employee: mockEmp });
		}

		if (!employee.IsActive) {
			return res.status(401).json({
				success: false,
				message: "Email khong ton tai hoac tai khoan da bi khoa."
			});
		}

		return res.json({ success: true, employee });
	} catch (error) {
		// SAP khong ket noi duoc → fallback ve MockData
		const mockEmp = employees.find(
			(emp) => emp.Email.toLowerCase() === String(email).toLowerCase()
		);
		if (mockEmp && mockEmp.IsActive) {
			return res.json({ success: true, employee: mockEmp });
		}
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

// app.get("/api/vendors", async (req, res) => {
// 	if (!process.env.SAP_HOST) {
// 		return res.json({ success: true, data: vendors });
// 	}

// 	try {
// 		const response = await axios.get(
// 			`${process.env.SAP_HOST}${ODATA_SERVICE_PATH}/VendorSet`,
// 			{ params: { "$format": "json" }, auth: sapAuth() }
// 		);
// 		const results = (response.data && response.data.d && response.data.d.results) || [];

// 		// 🎯 LỌC CỐ ĐỊNH THEO COMPANY CODE QD01 CỦA NHÓM
// 		const myGroupVendors = results.filter((v) => {
// 			// SAP OData có thể trả về tên trường CompanyCode, CoCode, hoặc Bukrs
// 			const companyCode = String(v.CompanyCode || v.CoCode || v.Bukrs || "").toUpperCase();

// 			// Chỉ lấy những Vendor thuộc Company Code QD01
// 			return companyCode === "QD01";
// 		}).map((v) => ({
// 			...v,
// 			VendorNo: v.VendorNo || v.Lifnr || v.Vendor || "",
// 			VendorName: v.VendorName || v.Name1 || v.Name || `Nhà cung cấp ${v.VendorNo || v.Lifnr}`
// 		}));

// 		if (myGroupVendors.length > 0) {
// 			return res.json({ success: true, data: myGroupVendors });
// 		} else {
// 			const fallbackByCoCode = results.filter((v) => {
// 				const vendorNo = String(v.VendorNo || v.Lifnr || "");
// 				return vendorNo.includes("800000"); // Mã Vendor thuộc dải QD01
// 			}).map((v) => ({
// 				...v,
// 				VendorNo: v.VendorNo || v.Lifnr || "",
// 				VendorName: v.VendorName || v.Name1 || `Nhà cung cấp ${v.VendorNo || v.Lifnr}`
// 			}));

// 			return res.json({ success: true, data: fallbackByCoCode });
// 		}

// 	} catch (error) {
// 		console.error("❌ Lỗi gọi VendorSet từ SAP:", error.message);
// 		return res.json({ success: true, data: vendors, sapError: true });
// 	}
// });

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

		// 🚀 BỎ LỌC: Map trực tiếp toàn bộ Vendor nhận từ SAP
		const allVendors = results.map((v) => ({
			...v,
			VendorNo: v.VendorNo || v.Lifnr || v.Vendor || "",
			VendorName: v.VendorName || v.Name1 || v.Name || `Nhà cung cấp ${v.VendorNo || v.Lifnr}`
		}));

		return res.json({ success: true, data: allVendors });

	} catch (error) {
		console.error("❌ Lỗi gọi VendorSet từ SAP:", error.message);
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
// db.js (Postgres/in-memory) la nguon du lieu cho man PR02 (vi OData chua co entity doc ZG1_APPROVAL).
// Khi co SAP_HOST, PR cung duoc tao that ben SAP qua OData PurchaseRequisitionHisSet (BAPI_PR_CREATE),
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
	let sapIntegration = "mock";
	let sapErrorMessage = null;

	if (process.env.SAP_HOST) {
		// Tao PR trong SAP voi item dau tien (OData PurchaseRequisitionHisSet hien ho tro 1 item/call)
		const firstItem = items[0];
		try {
			// Thu ep sap-language=EN — BAPI dang sinh loi "ME/083 Bitte Kurztext eingeben"
			// bat ke Description gui len la gi, nghi ngo BAPI tu dong tra Kurztext tu
			// bang MAKT (Material Short Text) theo ngon ngu he thong (mac dinh DE) thay vi
			// dung field Description minh gui. Thu doi ngon ngu request sang EN xem SAP co
			// fallback dung Kurztext da maintain hay khong. KHONG CHAC se khac phuc duoc vi
			// day co the la loi mapping trong lop ABAP (DPC_EXT) — neu van loi, can nguoi
			// phu trach ABAP (theo Blueprint: Vu Tien Dat) kiem tra lai CREATE_ENTITY /
			// CREATE_DEEP_ENTITY cua PurchaseRequisitionHisSet co map dung field Description
			// sang tham so short text cua BAPI hay khong.
			const tokenResponse = await axios.get(
				`${process.env.SAP_HOST}${ODATA_SERVICE_PATH}`,
				{
					auth: sapAuth(),
					headers: {
						"X-CSRF-Token": "Fetch",
						"sap-language": "EN"
					}
				}
			);

			const csrfToken = tokenResponse.headers["x-csrf-token"];
			const cookies = tokenResponse.headers["set-cookie"];

			console.log("CSRF:", csrfToken);
			console.log("COOKIE:", cookies);

			// SUA: field dung dung TEN + CASE that ma SAP chap nhan (xac nhan qua SAP
			// Gateway Client test truc tiep - xem anh chup Postman/Gateway Client):
			//   - "Uom" (khong phai "UoM"), OData phan biet hoa/thuong.
			//   - "GLAccount" la field BAT BUOC ma truoc do code chua he gui.
			//   - Entity nay KHONG co field CompanyCode/AssetNo/MaterialType — bo hoan
			//     toan, gui thua co the bi SAP tu choi hoac bo qua tuy cau hinh.
			const sapResponse = await axios.post(
				`${process.env.SAP_HOST}${ODATA_SERVICE_PATH}/PurchaseRequisitionHisSet`,
				{
					MaterialNo: firstItem.materialNo || "",
					Description: firstItem.description || "",
					Quantity: String(firstItem.quantity),
					Uom: firstItem.uom || "PC",
					EstimatedValue: String(firstItem.estimatedValue || 0),
					Currency: currency || "VND",
					CostCenter: firstItem.costCenter || "",
					InternalOrder: firstItem.internalOrder || "",
					GLAccount: firstItem.glAccount || defaultGLAccount(firstItem.materialType)
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

			// SAP tra ve so PR that o field "PRNumber" (xac nhan qua Gateway Client,
			// VD: "0010003924") — KHONG phai "Banfn" nhu gia dinh truoc do.
			sapPrNumber = sapResponse.data && sapResponse.data.d && sapResponse.data.d.PRNumber;
		} catch (error) {
			console.log("STATUS:", error.response?.status);
			console.log("HEADERS:", error.response?.headers);
			console.log("DATA:", JSON.stringify(error.response?.data, null, 2));
			sapIntegration = "failed";

			// Loc rieng cac loi severity="error" trong errordetails (neu co) de tra ve
			// thong bao cu the cho FE hien thi, thay vi chi 1 cau tieng Duc chung chung
			// "Es ist eine Ausnahme aufgetreten" khong ai hieu duoc dang loi gi.
			const errorDetails = error.response?.data?.error?.innererror?.errordetails;
			if (Array.isArray(errorDetails)) {
				const realErrors = errorDetails
					.filter((d) => d.severity === "error" && d.code !== "/IWBEP/CX_MGW_BUSI_EXCEPTION")
					.map((d) => d.message);
				if (realErrors.length) {
					sapErrorMessage = realErrors.join("; ");
				}
			}
			if (!sapErrorMessage) {
				sapErrorMessage =
					error.response?.data?.error?.message?.value ||
					(error.response ? `SAP tra ve HTTP ${error.response.status}` : error.message);
			}

			console.error("[approval/submit] Tao PR that ben SAP THAT BAI:", sapErrorMessage);
		}
	}

	let newPRId = sapPrNumber;
	if (!newPRId) {
		const BASE_PR_NUMBER = 1000000000;
		newPRId = String(BASE_PR_NUMBER + nextApprovalId);
	}

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
				isFreeText: item.isFreeText || false
			};
		}),
		...buildApprovalFlags(totalPRValue || 0)
	};

	nextApprovalId += 1;
	approvalStore.push(record);

	return res.status(201).json({ success: true, approval: record, sapIntegration, sapErrorMessage });
});

app.get("/api/approval/pending", (req, res) => {
	const pending = approvalStore.filter((item) => item.Status === "PENDING_APPROVAL");
	return res.json({ success: true, data: pending });
});

// --- GET /api/approval/approved -------------------------------------------
// Tra ve cac PR da duoc duyet (Status = APPROVED) de PO01 co the chon va link.
// app.get("/api/approval/approved", (req, res) => {
// 	const approved = approvalStore.filter((item) => item.Status === "APPROVED");
// 	return res.json({ success: true, data: approved });
// });
// --- GET /api/approval/approved -------------------------------------------
// Trả về danh sách PR đã duyệt để màn PO01 chọn và lập PO
app.get("/api/approval/approved", async (req, res) => {
	const getLocalApproved = () => approvalStore.filter((item) => {
		const s = String(item.Status || "").toUpperCase();
		return s === "APPROVED" || s === "OPENED" || s === "OPEN";
	});

	if (!process.env.SAP_HOST) {
		return res.json({ success: true, data: getLocalApproved() });
	}

	try {
		// Gọi ĐÚNG EntitySet: PurchaseRequisitionHisSet
		const response = await axios.get(
			`${process.env.SAP_HOST}${ODATA_SERVICE_PATH}/PurchaseRequisitionHisSet`,
			{
				params: { "$format": "json" },
				auth: sapAuth()
			}
		);

		const results = (response.data && response.data.d && response.data.d.results) || [];

		// Lọc PR có Status là "OPEN" (theo ảnh từ SAP) hoặc "OPENED" / "APPROVED"
		// Map thêm trường PRId để FE (PO01.controller.js) đọc được mã PR
		const approvedPRs = results
			.filter((item) => {
				const s = String(item.Status || "").toUpperCase();
				return s === "OPEN" || s === "OPENED" || s === "APPROVED";
			})
			.map((item) => ({
				...item,
				PRId: item.PRNumber || item.PRId // Map PRNumber từ SAP thành PRId cho FE
			}));

		return res.json({ success: true, data: approvedPRs });
	} catch (error) {
		console.error("❌ Lỗi bốc PR từ SAP OData:", error.message);
		return res.json({ success: true, data: getLocalApproved(), sapError: true });
	}
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
// app.post("/api/po/create", async (req, res) => {
// 	const { vendorNo, items } = req.body || {};

// 	if (!vendorNo || !Array.isArray(items) || items.length === 0) {
// 		return res.status(400).json({ success: false, message: "Thieu nha cung cap hoac danh sach vat tu." });
// 	}

// 	for (const item of items) {
// 		if (item.materialType === "ZAST" && !item.assetNo) {
// 			return res.status(400).json({ success: false, message: `Vat tu ${item.materialNo} la tai san (ZAST), bat buoc phai co Asset No.` });
// 		}
// 		if (item.materialType !== "ZAST" && !item.costCenter) {
// 			return res.status(400).json({ success: false, message: `Vat tu ${item.materialNo} bat buoc phai co Cost Center.` });
// 		}
// 	}

// 	const totalValue = items.reduce((sum, item) => sum + (Number(item.netPrice) || 0) * (Number(item.quantity) || 0), 0);

// 	if (!process.env.SAP_HOST) {
// 		return res.status(201).json({
// 			success: true,
// 			sapIntegration: "mock",
// 			po: {
// 				PoNumber: `PO-${new Date().getFullYear()}-${String(Math.floor(Math.random() * 9000) + 1000)}`,
// 				VendorNo: vendorNo,
// 				TotalValue: totalValue,
// 				Currency: "VND",
// 				Status: "CREATED",
// 				Items: items
// 			}
// 		});
// 	}

// 	try {
// 		const sapResponse = await axios.post(
// 			`${process.env.SAP_HOST}${ODATA_SERVICE_PATH}/PurchaseOrderHeaderSet`,
// 			{
// 				CompanyCode: "QD01",
// 				DocType: "ZPO",
// 				VendorNo: vendorNo,
// 				PurchOrg: "QDPO",
// 				PurchGroup: "QDG",
// 				Currency: "VND",
// 				POToItems: {
// 					results: items.map((item, idx) => ({
// 						ItemNo: String(idx + 1).padStart(5, "0"),
// 						MaterialNo: item.materialNo,
// 						Description: item.description || "",
// 						Quantity: String(item.quantity),
// 						UoM: item.uom || "PC",
// 						NetPrice: String(item.netPrice),
// 						CostCenter: item.costCenter || "",
// 						AssetNo: item.assetNo || "",
// 						Plant: "QDPL",
// 						PreqNo: item.preqNo || ""   // BANFN - lien ket toi PR nguon (EKPO-BANFN)
// 					}))
// 				}
// 			},
// 			{
// 				auth: sapAuth(),
// 				headers: { "Content-Type": "application/json" }
// 			}
// 		);

// 		return res.status(201).json({
// 			success: true,
// 			sapIntegration: "created",
// 			po: sapResponse.data && sapResponse.data.d
// 		});
// 	} catch (error) {
// 		return res.status(502).json({
// 			success: false,
// 			message: "Khong the tao PO qua SAP. Kiem tra ket noi/du lieu roi thu lai."
// 		});
// 	}
// });
// --- POST /api/po/create --------------------------------------------------
// --- POST /api/po/create (FIX TRIỆT ĐỂ CSRF TOKEN & COOKIE DÀNH CHO BE) ------------------
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
		// 🔑 BƯỚC 1: Fetch CSRF Token & Session Cookies từ SAP Gateway
		const tokenResponse = await axios.get(
			`${process.env.SAP_HOST}${ODATA_SERVICE_PATH}/PurchaseOrderHeaderSet`,
			{
				auth: sapAuth(),
				headers: {
					"X-CSRF-Token": "Fetch",
					"sap-language": "EN"
				}
			}
		);

		const csrfToken = tokenResponse.headers["x-csrf-token"];
		const cookies = tokenResponse.headers["set-cookie"];

		// 📦 BƯỚC 2: Chuẩn hóa Payload - BỎ TRƯỜNG PreqNo ĐỂ KHÔNG BỊ LỖI INVALID PROPERTY
		const sapPayload = {
			CompanyCode: "QD01",
			DocType: "ZPO",
			VendorNo: vendorNo,
			PurchOrg: "QDPO",
			PurchGroup: "QDG",
			Currency: "VND",
			POToItems: {
				results: items.map((item, idx) => ({
					ItemNo: String(idx + 1).padStart(5, "0"),
					MaterialNo: item.materialNo || "",
					Description: item.description || "",
					Quantity: String(item.quantity || 1),
					UoM: item.uom || "PC",
					NetPrice: String(item.netPrice || 0),
					CostCenter: item.costCenter || "CCADM",
					AssetNo: item.assetNo || "",
					Plant: "QDPL"
				}))
			}
		};

		// 🚀 BƯỚC 3: Gửi POST Request tạo PO
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

		return res.status(201).json({
			success: true,
			sapIntegration: "created",
			po: sapResponse.data && sapResponse.data.d
		});
	} catch (error) {
		console.error("❌ [SAP BAPI CREATION ERROR]:");
		if (error.response) {
			console.error("HTTP Status:", error.response.status);
			console.error("Chi tiết từ SAP:", JSON.stringify(error.response.data || error.response.statusText, null, 2));
		} else {
			console.error("System Error:", error.message);
		}

		const sapMsg = error.response && error.response.data && error.response.data.error && error.response.data.error.message && error.response.data.error.message.value;

		return res.status(502).json({
			success: false,
			message: sapMsg || "Khong the tao PO qua SAP. Kiem tra ket noi/du lieu roi thu lai."
		});
	}
});
// --- GET /api/po/report (Báo cáo lịch sử Đơn hàng từ SAP) ------------------
app.get("/api/po/report", async (req, res) => {
	if (!process.env.SAP_HOST) {
		// Mock data de xem giao dien + thanh tien do hoat dong khi chua co SAP_HOST.
		// StepActive duoc POReport.controller.js tinh lai dua tren Status khi chon dong,
		// nhung PrDate/LeadDate/CfoDate/CeoDate/DeliveryDate can co san de hien thi mocked.
		return res.json({
			success: true,
			sapIntegration: "mock",
			// data: [
			// 	{
			// 		PoNumber: "PO-2026-1001", VendorName: "Cong ty TNHH Dell Viet Nam",
			// 		CompanyCode: "QD01", DocDate: "01.07.2026",
			// 		TotalValue: 55000000, Currency: "VND", Status: "CREATED",
			// 		PrDate: "28.06.2026", LeadDate: "29.06.2026", CfoDate: "30.06.2026",
			// 		CeoDate: "", DeliveryDate: ""
			// 	},
			// 	{
			// 		PoNumber: "PO-2026-1002", VendorName: "Cong ty CP Microsoft Viet Nam",
			// 		CompanyCode: "QD01", DocDate: "05.07.2026",
			// 		TotalValue: 320000000, Currency: "VND", Status: "DELIVERED",
			// 		PrDate: "01.07.2026", LeadDate: "02.07.2026", CfoDate: "03.07.2026",
			// 		CeoDate: "04.07.2026", DeliveryDate: "10.07.2026"
			// 	},
			// 	{
			// 		PoNumber: "PO-2026-1003", VendorName: "Cong ty TNHH HP Viet Nam",
			// 		CompanyCode: "QD01", DocDate: "15.07.2026",
			// 		TotalValue: 18000000, Currency: "VND", Status: "CREATED",
			// 		PrDate: "12.07.2026", LeadDate: "13.07.2026", CfoDate: "14.07.2026",
			// 		CeoDate: "", DeliveryDate: ""
			// 	}
			// ]
		});
	}

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