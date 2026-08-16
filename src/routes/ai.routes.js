/**
 * Cac tinh nang AI: goi y NCC, so sanh bao gia, hoi dap.
 *
 * Tach ra tu server.js (ban goc 4520 dong) ngay 15/08/2026.
 * Noi dung ham giu nguyen 100%, chi them phan require/exports o dau va cuoi file.
 */


const express = require("express");
const { describePaymentTerms } = require("../config/payment-terms");
const { callClaude } = require("../lib/claude");
const { extractSapErrorMessage, odataEscape, sapRead } = require("../lib/sap-client");
const { VENDOR_FIELD_EXPLANATION, anonymizeVendorsForAI, computeVendorPerformanceStats } = require("../services/vendor.service");

const router = express.Router();


// Goi y NCC TRUOC khi gui RFQ (khac /api/ai/compare-quotations la sau khi da co gia that).
// Truoc day route nay gui thang ten/email/ma so thue NCC that len Groq — cung mot lo hong
// ma B2 da vá cho compare-quotations nhung bo sot o day. Nay dung chung 1 co che: an danh
// V1/V2/... truoc khi goi, dich nguoc sau khi co ket qua, va ghi log moi lan goi.
router.post("/api/ai/recommend-vendor", async (req, res) => {
	const { materialName, materialGroup, quantity, budget, vendors: candidateVendors } = req.body || {};

	if (!process.env.ANTHROPIC_API_KEY) {
		return res.status(500).json({ success: false, message: "Thieu ANTHROPIC_API_KEY." });
	}
	if (!Array.isArray(candidateVendors) || candidateVendors.length === 0) {
		return res.status(400).json({ success: false, message: "Thieu danh sach nha cung cap (goi /api/vendors truoc)." });
	}

	// An danh hoa: chi gui cho AI nhung thuoc tinh phuc vu viec chon NCC, tuyet doi khong
	// gui VendorName / Email / TaxCode / dia chi ra ngoai he thong. Kem lich su hieu suat
	// tu cac RFQ da hoan tat (xem computeVendorPerformanceStats).
	const anonMap = {};
	const performanceStats = await computeVendorPerformanceStats();
	const anonymized = anonymizeVendorsForAI(candidateVendors, anonMap, performanceStats);

	// Prompt viet tieng Viet CO DAU — xem ghi chu o /api/ai/compare-quotations. Dinh dang tra
	// loi (dong "NCC DE XUAT UU TIEN:" + gach dau dong "- ") duoc FE parse rieng de ve bong bong
	// co ket luan noi bat + danh sach tieu chi ro rang, thay vi 1 doan van xuoi dai (feedback
	// 15/08: "muon no ket luan gop y NCC nao luon", "format de nhin hon") — xem
	// _formatAiMessageHtml trong RFQ01.controller.js.
	const prompt = `Bạn là chuyên gia mua hàng. Dưới đây là danh sách nhà cung cấp đã ẩn danh hóa `
		+ `(không có tên/email thật) cho nhu cầu mua sắm:\n`
		+ `- Vật tư: ${materialName || "Không rõ"} (nhóm: ${materialGroup || "Không rõ"})\n`
		+ `- Số lượng: ${quantity || "Không rõ"}\n`
		+ `- Ngân sách dự kiến: ${budget || "Không rõ"} VND\n`
		+ `- Danh sách nhà cung cấp: ${JSON.stringify(anonymized, null, 2)}\n`
		+ VENDOR_FIELD_EXPLANATION
		+ `\nLưu ý đây chỉ là gợi ý để mời báo giá (nên mời tối thiểu 2 NCC để có cơ sở so sánh sau `
		+ `này), chưa phải quyết định chọn nhà cung cấp cuối cùng.\n\n`
		+ `QUAN TRỌNG VỀ ĐỊNH DẠNG TRẢ LỜI — bám sát đúng cấu trúc sau, không thêm ký tự trang trí `
		+ `nào khác (không #, ##, **, đánh số thứ tự):\n`
		+ `Dòng 1: viết đúng "NCC ĐỀ XUẤT ƯU TIÊN: " theo sau là đúng 1 mã vendorCode (ví dụ `
		+ `"NCC ĐỀ XUẤT ƯU TIÊN: V2") — chọn nhà cung cấp bạn đánh giá nên mời trước nhất.\n`
		+ `Dòng 2: để trống.\n`
		+ `Từ dòng 3: viết 3-5 dòng, MỖI dòng bắt đầu bằng "- " rồi tới 1 câu ngắn gọn — có thể là `
		+ `lý do chọn NCC ưu tiên, hoặc nhắc thêm mã NCC khác cũng nên mời kèm lý do. Nêu rõ đánh đổi `
		+ `(giá/thời gian giao/điều khoản thanh toán/lịch sử) giữa các lựa chọn nếu dữ liệu cho phép.\n\n`
		+ `Toàn bộ nội dung viết bằng TIẾNG VIỆT CÓ DẤU đầy đủ (ví dụ viết "đề xuất mời báo giá", `
		+ `tuyệt đối không viết "de xuat moi bao gia"). Kết quả sẽ được hiển thị trong khung chat trên `
		+ `giao diện, đã tự động tô đậm dòng "NCC ĐỀ XUẤT ƯU TIÊN" và các gạch đầu dòng — không viết `
		+ `markdown nào khác ngoài đúng 2 quy ước trên.`;

	try {
		const aiText = await callClaude(prompt, 1200);

		// Dich nguoc ma an danh ve VendorNo that; dung word boundary de V1 khong khop nham trong V10.
		// Ham thay the thay vi chuoi — xem ghi chu o /api/ai/compare-quotations.
		let translatedText = aiText;
		Object.keys(anonMap).forEach(function (code) {
			if (anonMap[code]) {
				translatedText = translatedText.replace(
					new RegExp("\\b" + code + "\\b", "g"),
					function () { return anonMap[code]; }
				);
			}
		});

		console.log(
			"[AI recommend-vendor] " + new Date().toISOString()
			+ " vatTu=" + (materialName || "N/A") + " soNCCGuiVaoAI=" + anonymized.length
		);

		return res.json({ success: true, recommendation: translatedText, vendorCount: anonymized.length });
	} catch (error) {
		const message = extractSapErrorMessage(error);
		console.error("[POST /api/ai/recommend-vendor] THAT BAI:", message);
		return res.status(502).json({ success: false, message: "Khong the goi AI: " + message });
	}
});

// ============================================================================
// 5b) AI GOI Y CHIA NHOM DONG PR THEO NHA CUNG CAP (16/08/2026)
//
// Khac /api/ai/recommend-vendor (goi y 1 NCC cho CA PR): route nay tra loi cau
// hoi "PR nay co 5 dong khac loai nhau, nen tach thanh may RFQ va moi ai?".
// NCC ban ban ghe khong bao gia duoc switch Cisco — gui ca ro hang cho tat ca
// vua lam phien NCC vua lo thong tin mua sam sang NCC khac.
//
// Van AN DANH HOA nhu 2 route AI kia: AI chi thay vendorCode V1/V2/... + cac
// thuoc tinh phuc vu viec chon (category tu LFA1-SORTL, city, lich su bao gia),
// KHONG bao gio thay ten/email/MST that. Dich nguoc o Node truoc khi tra ve FE.
//
// Tra ve JSON co cau truc (khong phai van xuoi nhu 2 route kia) vi FE phai dung
// ket qua de TICK SAN checkbox tren bang vat tu — parse van xuoi de sai. Neu AI
// tra ve khong dung JSON thi van tra raw text de nguoi dung tu doc, khong nem loi.
// ============================================================================
router.post("/api/ai/suggest-rfq-groups", async (req, res) => {
	const { items, vendors: candidateVendors } = req.body || {};

	if (!process.env.ANTHROPIC_API_KEY) {
		return res.status(500).json({ success: false, message: "Thieu ANTHROPIC_API_KEY." });
	}
	if (!Array.isArray(items) || items.length === 0) {
		return res.status(400).json({ success: false, message: "Thieu danh sach dong vat tu cua PR." });
	}
	if (!Array.isArray(candidateVendors) || candidateVendors.length === 0) {
		return res.status(400).json({ success: false, message: "Thieu danh sach nha cung cap (goi /api/vendors truoc)." });
	}

	// anonMap dung de dich nguoc trong VAN BAN (ra "Ten NCC (ma)"), con codeToVendorNo
	// de dich nguoc trong DU LIEU (ra dung VendorNo cho FE tick san checkbox NCC).
	// Hai muc dich khac nhau nen giu 2 map rieng, khong dung chung 1 cai.
	const anonMap = {};
	const codeToVendorNo = {};
	candidateVendors.forEach(function (v, idx) {
		codeToVendorNo["V" + (idx + 1)] = String(v.VendorNo || v.Lifnr || "");
	});

	const performanceStats = await computeVendorPerformanceStats();
	const anonymized = anonymizeVendorsForAI(candidateVendors, anonMap, performanceStats);

	const compactItems = items.map(function (it) {
		return {
			lineNo: String(it.LineNo || ""),
			description: String(it.Description || ""),
			materialNo: String(it.MaterialNo || ""),
			quantity: Number(it.Quantity) || 0,
			uom: String(it.UoM || "")
		};
	});

	const prompt = `Bạn là chuyên gia mua hàng. Một Đề nghị mua hàng (PR) có nhiều dòng vật tư `
		+ `khác loại nhau, cần tách thành nhiều Yêu cầu báo giá (RFQ) — mỗi RFQ gom những dòng mà `
		+ `CÙNG một nhóm nhà cung cấp có thể cung cấp được.\n\n`
		+ `Các dòng vật tư của PR:\n${JSON.stringify(compactItems, null, 2)}\n\n`
		+ `Danh sách nhà cung cấp đã ẩn danh hóa:\n${JSON.stringify(anonymized, null, 2)}\n`
		+ VENDOR_FIELD_EXPLANATION
		+ `\nNguyên tắc chia nhóm:\n`
		+ `- Gom các dòng cùng ngành hàng vào một nhóm (ví dụ văn phòng phẩm và mực in thường `
		+ `cùng một nhà cung cấp; switch mạng và bản quyền phần mềm thì không).\n`
		+ `- MỖI DÒNG CHỈ ĐƯỢC THUỘC ĐÚNG MỘT NHÓM, và mọi dòng đều phải được xếp vào một nhóm.\n`
		+ `- Mỗi nhóm nên đề xuất tối thiểu 2 nhà cung cấp để có cơ sở so sánh báo giá; chỉ đề xuất `
		+ `1 khi thực sự không có lựa chọn nào khác.\n`
		+ `- Nếu không nhà cung cấp nào trong danh sách phù hợp với một nhóm, vẫn tạo nhóm đó nhưng `
		+ `để mảng vendorCodes rỗng và nói rõ trong reason là chưa có NCC phù hợp.\n`
		+ `- Trường "category" của nhà cung cấp là ngành hàng họ kinh doanh. Nếu nó trống hoặc chỉ là `
		+ `tên viết tắt không rõ nghĩa thì ĐỪNG suy đoán bừa — nói rõ trong reason là thiếu dữ liệu.\n\n`
		+ `CHỈ TRẢ VỀ JSON THUẦN, không kèm chữ nào khác, không bọc trong dấu \`\`\`, đúng dạng:\n`
		+ `{"groups":[{"name":"Tên nhóm ngắn gọn","lines":["00001","00003"],"vendorCodes":["V2","V5"],`
		+ `"reason":"Một câu ngắn giải thích vì sao gom các dòng này và vì sao mời các NCC này"}]}\n\n`
		+ `Các giá trị "name" và "reason" viết bằng TIẾNG VIỆT CÓ DẤU đầy đủ. Giá trị trong "lines" `
		+ `phải là lineNo COPY NGUYÊN VĂN từ dữ liệu ở trên.`;

	try {
		const aiText = await callClaude(prompt, 2000);

		// AI doi khi van boc JSON trong ```json ... ``` du da yeu cau khong — cat bo
		// truoc khi parse thay vi de JSON.parse nem loi va mat toan bo ket qua.
		let jsonText = String(aiText || "").trim();
		const fenced = jsonText.match(/```(?:json)?\s*([\s\S]*?)```/);
		if (fenced) { jsonText = fenced[1].trim(); }

		let parsed = null;
		try {
			parsed = JSON.parse(jsonText);
		} catch (parseError) {
			console.error("[POST /api/ai/suggest-rfq-groups] AI khong tra ve JSON hop le:", parseError.message);
		}

		if (!parsed || !Array.isArray(parsed.groups)) {
			// Khong parse duoc: van tra 200 kem raw de FE hien cho nguoi dung tu doc va
			// tu chia tay, thay vi bao loi cut ngang (goi AI da ton tien roi).
			return res.json({
				success: true,
				groups: [],
				parsed: false,
				raw: aiText,
				message: "AI tra loi khong dung dinh dang JSON — hien nguyen van de nguoi dung tu doi chieu."
			});
		}

		// Chi giu lai lineNo CO THAT trong PR: AI co the bia them dong khong ton tai,
		// tick san mot dong ma ra thi FE se gui len backend va bi tu choi kho hieu.
		const knownLines = new Set(compactItems.map(function (it) { return it.lineNo; }));
		const groups = parsed.groups.map(function (g, idx) {
			const lines = (Array.isArray(g.lines) ? g.lines : [])
				.map(String)
				.filter(function (l) { return knownLines.has(l); });
			const vendorNos = (Array.isArray(g.vendorCodes) ? g.vendorCodes : [])
				.map(function (code) { return codeToVendorNo[String(code).trim().toUpperCase()]; })
				.filter(Boolean);
			return {
				name: String(g.name || "Nhóm " + (idx + 1)),
				lines: lines,
				vendorNos: vendorNos,
				reason: String(g.reason || "")
			};
		}).filter(function (g) { return g.lines.length > 0; });

		// Doi chieu do phu: dong nao AI bo sot thi bao ro cho nguoi dung tu xep,
		// khong am tham nuot mat (nguoi mua se tuong da chia het roi).
		const assigned = new Set();
		groups.forEach(function (g) { g.lines.forEach(function (l) { assigned.add(l); }); });
		const missingLines = compactItems
			.map(function (it) { return it.lineNo; })
			.filter(function (l) { return !assigned.has(l); });

		console.log(
			"[AI suggest-rfq-groups] " + new Date().toISOString()
			+ " soDong=" + compactItems.length + " soNhom=" + groups.length
			+ " soNCCGuiVaoAI=" + anonymized.length
			+ (missingLines.length ? " CHUA_XEP=" + missingLines.join(",") : "")
		);

		return res.json({
			success: true,
			parsed: true,
			groups: groups,
			missingLines: missingLines,
			vendorCount: anonymized.length
		});
	} catch (error) {
		const message = extractSapErrorMessage(error);
		console.error("[POST /api/ai/suggest-rfq-groups] THAT BAI:", message);
		return res.status(502).json({ success: false, message: "Khong the goi AI: " + message });
	}
});

// 6) AI ho tro so sanh bao gia SAU KHI da co gia that (tach khoi /api/ai/recommend-vendor
// dung TRUOC khi gui RFQ). An danh hoa VendorNo -> V1/V2/... truoc khi gui cho AI,
// dich nguoc lai truoc khi tra ve FE — khong gui ten/email NCC that ra ngoai.
router.post("/api/ai/compare-quotations", async (req, res) => {
	const { rfqId } = req.body || {};

	if (!rfqId) {
		return res.status(400).json({ success: false, message: "Thieu rfqId." });
	}
	if (!process.env.SAP_HOST) {
		return res.status(503).json({ success: false, message: "He thong SAP chua duoc cau hinh (thieu SAP_HOST)." });
	}
	if (!process.env.ANTHROPIC_API_KEY) {
		return res.status(500).json({ success: false, message: "Thieu ANTHROPIC_API_KEY." });
	}

	try {
		const quotationsResp = await sapRead(`RfqSet('${odataEscape(rfqId)}')/RfqToQuotations`);
		const allQuotations = (quotationsResp.data && quotationsResp.data.d && quotationsResp.data.d.results) || [];
		const received = allQuotations.filter((q) => q.QuoteStatus === "RECEIVED" || q.QuoteStatus === "AWARDED");

		if (received.length === 0) {
			return res.status(400).json({ success: false, message: "Chua co bao gia nao RECEIVED de so sanh." });
		}

		// An danh hoa: VendorNo that -> ma tam V1/V2/..., giu bang map o server de dich nguoc sau
		const anonMap = {};
		const anonymized = received.map(function (q, idx) {
			const code = "V" + (idx + 1);
			// Dich nguoc ve "Ten NCC (ma)" chu khong chi ma so: nguoi doc khong nho
			// 0080000012 la ai. Ten van KHONG duoc gui cho AI, chi ghep lai o buoc dich
			// nguoc sau khi da co cau tra loi.
			const vendorName = String(q.VendorName || "").trim();
			anonMap[code] = vendorName
				? `${vendorName} (${q.VendorNo})`
				: String(q.VendorNo);
			return {
				vendorCode: code,
				quotedPrice: Number(q.QuotedPrice) || 0,
				currency: q.Currency || "VND",
				leadTimeDays: Number(q.LeadTimeDays) || 0,
				paymentTerms: describePaymentTerms(q.PaymentTerms),
				warrantyMonths: Number(q.WarrantyMonths) || 0,
				legalDocsOk: q.LegalDocsOk === "X"
			};
		});

		// Prompt PHAI viet tieng Viet co dau: truoc day prompt viet khong dau nen Claude
		// bat chuoc van phong do va tra ve nguyen doan tieng Viet khong dau, nguoi dung
		// doc rat kho. Yeu cau co dau mot cach tuong minh o cuoi.
		//
		// Dinh dang tra loi (dong "NCC DE XUAT:" + gach dau dong "- ") duoc FE parse rieng de
		// ve bong bong co ket luan noi bat + danh sach tieu chi ro rang, thay vi 1 doan van xuoi
		// dai kho doc (feedback 15/08: "muon no ket luan gop y NCC nao luon", "format de nhin
		// hon") — xem _formatAiMessageHtml trong RFQ02.controller.js (giong het RFQ01).
		const prompt = `Bạn là chuyên gia mua hàng. Dưới đây là các báo giá đã ẩn danh hóa `
			+ `(không có tên/email nhà cung cấp thật) cho RFQ ${rfqId}:\n`
			+ `${JSON.stringify(anonymized, null, 2)}\n\n`
			+ `Hãy đánh giá lần lượt theo 5 tiêu chí, xếp theo mức độ quan trọng giảm dần, rồi kết `
			+ `luận nên chọn nhà cung cấp nào:\n`
			+ `1. Giá báo (quotedPrice) — thấp hơn thì tốt hơn, nêu rõ chênh lệch bao nhiêu tiền.\n`
			+ `2. Thời gian giao hàng (leadTimeDays) — ngắn hơn thì tốt hơn.\n`
			+ `3. Công nợ / điều khoản thanh toán (paymentTerms) — được trả càng chậm thì càng có lợi cho dòng tiền.\n`
			+ `4. Bảo hành (warrantyMonths) — dài hơn thì tốt hơn.\n`
			+ `5. Hồ sơ pháp lý (legalDocsOk) — thiếu hồ sơ là rủi ro đáng kể.\n\n`
			+ `QUAN TRỌNG VỀ ĐỊNH DẠNG TRẢ LỜI — bám sát đúng cấu trúc sau, không thêm ký tự trang `
			+ `trí nào khác (không #, ##, **, đánh số thứ tự):\n`
			+ `Dòng 1: viết đúng "NCC ĐỀ XUẤT: " theo sau là đúng 1 mã vendorCode (ví dụ `
			+ `"NCC ĐỀ XUẤT: V2") — mã nhà cung cấp nên chọn, không thêm chữ nào khác trên dòng này.\n`
			+ `Dòng 2: để trống.\n`
			+ `Từ dòng 3: viết 3-5 dòng, MỖI dòng bắt đầu bằng "- " rồi tới 1 câu ngắn gọn bám vào `
			+ `đúng 5 tiêu chí trên (có thể gộp tiêu chí nào không có gì nổi bật, ưu tiên nêu tiêu chí `
			+ `quyết định vì sao chọn NCC này thay vì các NCC còn lại).\n\n`
			+ `Toàn bộ nội dung viết bằng TIẾNG VIỆT CÓ DẤU đầy đủ (ví dụ viết "đề xuất chọn nhà cung `
			+ `cấp", tuyệt đối không viết "de xuat chon nha cung cap"). Kết quả sẽ được hiển thị trong `
			+ `khung chat trên giao diện, đã tự động tô đậm dòng "NCC ĐỀ XUẤT" và các gạch đầu dòng — `
			+ `không viết markdown nào khác ngoài đúng 2 quy ước trên.`;

		const aiText = await callClaude(prompt, 1200);

		// Dich nguoc ma an danh (V1/V2/...) trong cau tra loi ve VendorNo that, dung word boundary
		// de tranh the V1 khop nham vao trong V10 khi co >=10 NCC.
		// Dung ham thay the (khong dung chuoi) vi gia tri thay the gio chua TEN NCC:
		// String.replace se dien giai $&, $', $1... trong chuoi thay the, ten NCC co
		// ky tu $ se ra sai. Ham callback tra ve nguyen van, khong dien giai gi.
		let translatedText = aiText;
		Object.keys(anonMap).forEach(function (code) {
			translatedText = translatedText.replace(
				new RegExp("\\b" + code + "\\b", "g"),
				function () { return anonMap[code]; }
			);
		});

		console.log(
			"[AI compare-quotations] " + new Date().toISOString()
			+ " rfqId=" + rfqId + " soNCCGuiVaoAI=" + anonymized.length
		);

		return res.json({ success: true, rfqId, recommendation: translatedText, vendorCount: anonymized.length });
	} catch (error) {
		const message = extractSapErrorMessage(error);
		console.error("[POST /api/ai/compare-quotations] THAT BAI:", message);
		return res.status(502).json({ success: false, message });
	}
});

// ============================================================================
// HOI DAP AI TUONG TAC (feedback QDAVY 13/08: "AI van chua the chat hay tuong
// tac duoc nhi?"). Nguoi dung hoi them 1 cau tren nen du lieu dang xem:
//   context = "recommend-vendor"  -> FE gui kem danh sach vendors (nhu RFQ-01)
//   context = "compare-quotations" -> FE gui kem rfqId, server tu doc bao gia
// Van AN DANH HOA het ten/email NCC truoc khi goi AI va dich nguoc sau khi co
// cau tra loi — dung co che word-boundary nhu 2 route AI co dinh o tren.
// KHONG gui cau tra loi truoc do cua AI len lai (trong do da co ten NCC that
// sau buoc dich nguoc) — moi cau hoi la 1 luot doc lap tren du lieu an danh.
// ============================================================================
router.post("/api/ai/ask", async (req, res) => {
	const { context, question, rfqId, vendors, materialName, materialGroup, quantity, budget } = req.body || {};

	if (!process.env.ANTHROPIC_API_KEY) {
		return res.status(500).json({ success: false, message: "Thieu ANTHROPIC_API_KEY." });
	}
	const sQuestion = String(question || "").trim();
	if (!sQuestion) {
		return res.status(400).json({ success: false, message: "Thieu cau hoi (question)." });
	}
	if (sQuestion.length > 500) {
		return res.status(400).json({ success: false, message: "Cau hoi qua dai (toi da 500 ky tu)." });
	}

	try {
		const anonMap = {};
		let dataDescription = "";

		if (context === "compare-quotations") {
			if (!rfqId) {
				return res.status(400).json({ success: false, message: "Thieu rfqId." });
			}
			if (!process.env.SAP_HOST) {
				return res.status(503).json({ success: false, message: "He thong SAP chua duoc cau hinh (thieu SAP_HOST)." });
			}
			const quotationsResp = await sapRead(`RfqSet('${odataEscape(rfqId)}')/RfqToQuotations`);
			const allQuotations = (quotationsResp.data && quotationsResp.data.d && quotationsResp.data.d.results) || [];
			const received = allQuotations.filter((q) => q.QuoteStatus === "RECEIVED" || q.QuoteStatus === "AWARDED");
			if (received.length === 0) {
				return res.status(400).json({ success: false, message: "Chua co bao gia nao de hoi AI." });
			}
			const anonymized = received.map(function (q, idx) {
				const code = "V" + (idx + 1);
				const vendorName = String(q.VendorName || "").trim();
				anonMap[code] = vendorName ? `${vendorName} (${q.VendorNo})` : String(q.VendorNo);
				return {
					vendorCode: code,
					quotedPrice: Number(q.QuotedPrice) || 0,
					currency: q.Currency || "VND",
					leadTimeDays: Number(q.LeadTimeDays) || 0,
					paymentTerms: describePaymentTerms(q.PaymentTerms),
					warrantyMonths: Number(q.WarrantyMonths) || 0,
					legalDocsOk: q.LegalDocsOk === "X"
				};
			});
			dataDescription = `Các báo giá đã ẩn danh hóa cho RFQ ${rfqId}:\n`
				+ JSON.stringify(anonymized, null, 2);
		} else if (context === "recommend-vendor") {
			if (!Array.isArray(vendors) || vendors.length === 0) {
				return res.status(400).json({ success: false, message: "Thieu danh sach nha cung cap (vendors)." });
			}
			// Dung chung anonymizeVendorsForAI + computeVendorPerformanceStats voi
			// /api/ai/recommend-vendor — truoc day 2 route nay copy nguyen doan an danh hoa,
			// sua 1 cho quen cho kia (xem PHU_LUC_KY_THUAT_VendorSet.md muc 4.1).
			const performanceStats = await computeVendorPerformanceStats();
			const anonymized = anonymizeVendorsForAI(vendors, anonMap, performanceStats);
			dataDescription = `Nhu cầu mua sắm:\n`
				+ `- Vật tư: ${materialName || "Không rõ"} (nhóm: ${materialGroup || "Không rõ"})\n`
				+ `- Số lượng: ${quantity || "Không rõ"}\n`
				+ `- Ngân sách dự kiến: ${budget || "Không rõ"} VND\n`
				+ `- Danh sách nhà cung cấp đã ẩn danh hóa: ${JSON.stringify(anonymized, null, 2)}\n`
				+ VENDOR_FIELD_EXPLANATION;
		} else {
			return res.status(400).json({ success: false, message: "context khong hop le (recommend-vendor | compare-quotations)." });
		}

		const prompt = `Bạn là chuyên gia mua hàng đang hỗ trợ nhân viên Purchasing. `
			+ `Dưới đây là dữ liệu (đã ẩn danh hóa, không có tên/email nhà cung cấp thật):\n`
			+ `${dataDescription}\n\n`
			+ `Câu hỏi của người dùng: "${sQuestion}"\n\n`
			+ `Trả lời đúng trọng tâm câu hỏi, dựa trên dữ liệu ở trên. Nếu dữ liệu không đủ để trả lời, `
			+ `nói rõ thiếu gì thay vì suy đoán. Khi nhắc tới nhà cung cấp thì dùng mã vendorCode (V1, V2...).\n\n`
			+ `QUAN TRỌNG VỀ HÌNH THỨC TRẢ LỜI: viết bằng TIẾNG VIỆT CÓ DẤU đầy đủ. Trả lời thẳng vào `
			+ `câu hỏi trước bằng 1-2 câu văn xuôi bình thường; nếu câu hỏi cần liệt kê/so sánh nhiều `
			+ `nhà cung cấp hoặc nhiều tiêu chí thì được dùng thêm các dòng gạch đầu dòng bắt đầu bằng `
			+ `"- " (mỗi ý 1 dòng riêng, khung chat sẽ tự tô lại thành danh sách dễ đọc). KHÔNG dùng `
			+ `markdown nào khác (không #, ##, **, đánh số thứ tự). Tối đa 5-6 câu/gạch đầu dòng.`;

		const aiText = await callClaude(prompt, 1500);

		let translatedText = aiText;
		Object.keys(anonMap).forEach(function (code) {
			if (anonMap[code]) {
				translatedText = translatedText.replace(
					new RegExp("\\b" + code + "\\b", "g"),
					function () { return anonMap[code]; }
				);
			}
		});

		console.log(
			"[AI ask] " + new Date().toISOString()
			+ " context=" + context + (rfqId ? " rfqId=" + rfqId : "")
			+ " doDaiCauHoi=" + sQuestion.length + " soNCCGuiVaoAI=" + Object.keys(anonMap).length
		);

		return res.json({ success: true, answer: translatedText });
	} catch (error) {
		const message = extractSapErrorMessage(error);
		console.error("[POST /api/ai/ask] THAT BAI:", message);
		return res.status(502).json({ success: false, message: "Khong the goi AI: " + message });
	}
});
module.exports = router;
