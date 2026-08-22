/**
 * RFQ noi bo: tao, gui, nhac, nhap bao gia, so sanh, trao thau.
 *
 * Tach ra tu server.js (ban goc 4520 dong) ngay 15/08/2026.
 * Noi dung ham giu nguyen 100%, chi them phan require/exports o dau va cuoi file.
 */


const express = require("express");
const { describePaymentTerms } = require("../config/payment-terms");
const { extractSapErrorMessage, odataEscape, sapFetchCsrfToken, sapRead, sapWrite } = require("../lib/sap-client");
const { boolToSapX, normalizeSapDeadline, rfqTimesToIso, sapDateOnly, sapTimestamp } = require("../lib/sap-format");
const { buildApprovalFlagsByCostCenter } = require("../services/approval.service");
const { notifyCfo, notifyPurchasing, notifyRequester } = require("../services/notify.service");
const { fetchPrDraftById, fetchPrDraftByRfq, updatePrDraft } = require("../services/pr.service");
const { sendRfqInviteEmails } = require("../services/rfq-mail.service");
const { appBaseUrl, rfqQuoteLink } = require("../services/rfq-portal.service");
const { backfillQuotationEmails, coveredLineSet, fetchRfqsByPr, formatItemLines, generateNextRfqId, itemsOfRfq, loadRfqContext, normalizeLineNo, parseItemLines, prFullyCovered, prLabelOf, promoteRfqAfterQuotation, resolveQuotationEmails } = require("../services/rfq.service");
const { fetchAllVendorsFromSAP } = require("../services/vendor.service");

const router = express.Router();


// 0) Danh sach RFQ (cho man RFQ-02 chon RFQ dang xu ly) — doc thang tu RfqSet
router.get("/api/rfq", async (req, res) => {
	if (!process.env.SAP_HOST) {
		return res.status(503).json({ success: false, message: "He thong SAP chua duoc cau hinh (thieu SAP_HOST)." });
	}
	try {
		const response = await sapRead("RfqSet");
		let results = (response.data && response.data.d && response.data.d.results) || [];

		const statusFilter = String(req.query.status || "").toUpperCase();
		if (statusFilter) {
			results = results.filter((r) => String(r.Status || "").toUpperCase() === statusFilter);
		}

		// Moi nhat len dau — CreatedAt la chuoi YYYYMMDDHHMMSS nen so sanh chuoi la du
		results.sort((a, b) => String(b.CreatedAt || "").localeCompare(String(a.CreatedAt || "")));

		// Doi timestamp 14 ky tu ve ISO UTC de FE format ve gio dia phuong nguoi xem
		return res.json({ success: true, data: results.map(rfqTimesToIso) });
	} catch (error) {
		const message = extractSapErrorMessage(error);
		console.error("[GET /api/rfq] THAT BAI:", message);
		return res.status(502).json({ success: false, message });
	}
});

// 1) Tao RFQ tu 1 PR + danh sach NCC duoc moi
router.post("/api/rfq/create", async (req, res) => {
	// itemLines: danh sach so dong PR thuoc nhom nay (mang ["00001","00003"] hoac
	// chuoi "00001,00003"). BO TRONG = lay toan bo dong CHUA duoc gan vao RFQ nao —
	// nho vay RFQ01 ban cu (chua biet tach nhom) goi len van chay dung nhu truoc.
	const { prId, sapPrNumber, vendorIds, createdBy, currency, itemLines } = req.body || {};

	if (!process.env.SAP_HOST) {
		return res.status(503).json({ success: false, message: "He thong SAP chua duoc cau hinh (thieu SAP_HOST)." });
	}
	if (!prId) {
		return res.status(400).json({ success: false, message: "Thieu prId." });
	}
	if (!Array.isArray(vendorIds) || vendorIds.length < 1) {
		return res.status(400).json({ success: false, message: "Phai chon it nhat 1 nha cung cap de gui RFQ." });
	}

	// Máy trạng thái theo quy trình TO-BE đã chốt: Purchasing phải DUYỆT PR trước
	// (PENDING_PURCHASING → PENDING_RFQ qua PATCH /api/approval/:id), rồi mới được
	// tạo RFQ ở đây.
	let prRecord;
	try {
		prRecord = await fetchPrDraftById(prId);
	} catch (error) {
		const message = extractSapErrorMessage(error);
		console.error("[POST /api/rfq/create] Doc PrDraft THAT BAI:", message);
		return res.status(502).json({ success: false, message });
	}
	if (!prRecord) {
		return res.status(404).json({ success: false, message: "Khong tim thay PR " + prId + " tren SAP." });
	}
	if (prRecord.Status !== "PENDING_RFQ") {
		return res.status(400).json({
			success: false,
			message: "PR " + prId + " dang o trang thai " + prRecord.Status
				+ ". Purchasing phai duyet PR (chuyen sang PENDING_RFQ) truoc khi tao RFQ."
		});
	}
	// ── XAC DINH NHOM DONG CHO RFQ NAY ──────────────────────────────────────
	// Truoc day o day chan cung "PR da co RfqId thi khong tao trung". Nay 1 PR duoc
	// phep co NHIEU RFQ (moi nhom dong 1 RFQ, gui cho nhom NCC khac nhau), nen doi
	// sang chan theo DONG: moi dong PR chi duoc nam trong dung 1 RFQ.
	let existingRfqs = [];
	try {
		existingRfqs = await fetchRfqsByPr(prRecord);
	} catch (error) {
		const message = extractSapErrorMessage(error);
		console.error("[POST /api/rfq/create] Doc RfqSet THAT BAI:", message);
		return res.status(502).json({ success: false, message });
	}

	const prItems = prRecord.items || [];
	if (prItems.length === 0) {
		return res.status(400).json({ success: false, message: "PR " + prId + " khong co dong vat tu nao." });
	}

	const covered = coveredLineSet(existingRfqs, prItems);
	const requested = Array.isArray(itemLines) ? itemLines.map(String) : parseItemLines(itemLines);
	let targetLines;

	if (requested.length === 0) {
		targetLines = prItems
			.map(function (it) { return it.LineNo; })
			.filter(function (l) { return !covered.has(normalizeLineNo(l)); });
		if (targetLines.length === 0) {
			return res.status(400).json({
				success: false,
				message: "Moi dong cua PR " + prId + " deu da nam trong mot RFQ — khong con dong nao de tao RFQ moi."
			});
		}
	} else {
		const known = new Set(prItems.map(function (it) { return normalizeLineNo(it.LineNo); }));
		const unknown = requested.filter(function (l) { return !known.has(normalizeLineNo(l)); });
		if (unknown.length) {
			return res.status(400).json({
				success: false,
				message: "PR " + prId + " khong co dong: " + unknown.join(", ")
			});
		}
		const dup = requested.filter(function (l) { return covered.has(normalizeLineNo(l)); });
		if (dup.length) {
			return res.status(400).json({
				success: false,
				message: "Cac dong sau da nam trong RFQ khac cua PR nay: " + dup.join(", ")
			});
		}
		targetLines = requested;
	}

	const itemLinesValue = formatItemLines(targetLines);
	// ITEM_LINES la CHAR255 ben SAP — ABAP cat cut am tham khong bao loi (da dinh 1
	// lan voi ZPR_DRAFT-RFQID CHAR10, xem CLAUDE.md). Chan tu day cho ro rang.
	if (itemLinesValue.length > 255) {
		return res.status(400).json({
			success: false,
			message: "Nhom nay co qua nhieu dong (" + targetLines.length + ") — vuot suc chua cua ITEM_LINES (255 ky tu). Chia nho nhom ra."
		});
	}

	try {
		const rfqId = await generateNextRfqId();
		const session = await sapFetchCsrfToken();

		const allVendors = await fetchAllVendorsFromSAP();
		const vendorMap = {};
		allVendors.forEach(function (v) { vendorMap[String(v.VendorNo)] = v; });

		// Gui 1 deep-entity POST duy nhat (RFQ header + mang RfqToQuotations long ben
		// trong) thay vi POST RfqSet roi loop POST QuotationSet rieng. Ly do: simple
		// <EntitySet>_CREATE_ENTITY tren SAP bi Gateway framework tu choi khi goi qua
		// Basic Auth (user ky thuat DEV-261) voi loi "Property 'RfqId' ... invalid
		// value" — da xac nhan qua nhieu vong test (SEGW creatable flag, generate lai
		// runtime objects, xoa cache /IWBEP/CACHE_CLEANUP deu khong het), trong khi goi
		// qua session trinh duyet/SAP GUI thi luon thanh cong. CREATE_DEEP_ENTITY (nhu
		// PrDraftSet/PurchaseRequisitionHeaderSet dang dung) khong bi loi nay. Xem
		// memory: SAP490_G1 RFQ deep entity fix.
		const rfqToQuotations = vendorIds.map(function (vendorId) {
			const vendorInfo = vendorMap[String(vendorId)] || {};
			return {
				VendorNo: String(vendorId),
				VendorName: vendorInfo.VendorName || "",
				VendorEmail: vendorInfo.Email || vendorInfo.VendorEmail || "",
				QuotedPrice: "0",
				Currency: currency || "VND",
				LeadTimeDays: 0,
				PaymentTerms: "",
				WarrantyMonths: 0,
				LegalDocsOk: "",
				QuoteStatus: "PENDING",
				EnteredBy: "",
				EnteredAt: "",
				SourceNote: ""
			};
		});

		await sapWrite("POST", "RfqSet", {
			RfqId: rfqId,
			PrId: String(prId),
			SapPrNumber: sapPrNumber ? String(sapPrNumber) : "",
			CreatedBy: createdBy || "",
			CreatedAt: sapTimestamp(),
			SentAt: "",
			Deadline: "",
			Status: "DRAFT",
			AwardedVendor: "",
			AwardReason: "",
			AwardedBy: "",
			AwardedAt: "",
			FinalValue: "0",
			Currency: currency || "VND",
			ItemLines: itemLinesValue,
			RfqToQuotations: rfqToQuotations
		}, session);

		// ZPR_DRAFT-RFQID chi la 1 field CHAR10, khong chua noi N ma RFQ. Nay no chi
		// con y nghia "RFQ DAU TIEN cua PR nay", giu lai de cac man hinh cu chua doc
		// theo danh sach khong vo. NGUON SU THAT day du la RfqSet loc theo PrId
		// (fetchRfqsByPr) — code moi phai dung ham do, dung tin RfqId nua.
		const remainingLines = prItems.filter(function (it) {
			return !covered.has(normalizeLineNo(it.LineNo))
				&& parseItemLines(itemLinesValue).indexOf(normalizeLineNo(it.LineNo)) === -1;
		}).length;

		if (!prRecord.RfqId) {
			prRecord.RfqId = rfqId;
			prRecord.UpdatedAt = new Date().toISOString();
			await updatePrDraft(prRecord.InternalId, { RfqId: rfqId }, session);
		}

		notifyRequester(
			prRecord,
			"Đề nghị " + prRecord.PRId + " đang được Phòng Mua sắm gửi yêu cầu báo giá (RFQ " + rfqId + ") tới nhà cung cấp."
		);

		return res.status(201).json({
			success: true,
			rfqId,
			status: "DRAFT",
			itemLines: itemLinesValue,
			// So dong cua PR chua duoc gan vao RFQ nao — FE dua vao day de biet con
			// phai tao them nhom nua hay da phu kin ca PR.
			remainingLines: remainingLines
		});
	} catch (error) {
		const message = extractSapErrorMessage(error);
		console.error("[POST /api/rfq/create] THAT BAI:", message);
		return res.status(502).json({ success: false, message });
	}
});

// 2) Gui email RFQ toi cac NCC da moi + chuyen trang thai sang SENT
router.post("/api/rfq/:id/send", async (req, res) => {
	const { id } = req.params;
	const { deadline, sentBy } = req.body || {};

	if (!process.env.SAP_HOST) {
		return res.status(503).json({ success: false, message: "He thong SAP chua duoc cau hinh (thieu SAP_HOST)." });
	}

	// Khong tin FE: du DatePicker da chan minDate, request van co the bi sua tay (Postman, DevTools...).
	//
	// BUG DA SUA 21/08/2026: ban cu viet `if (normalizedDeadlineCheck && ... < today)`
	// — tuc la deadline RONG hoac KHONG PARSE DUOC thi bo qua kiem tra luon.
	// normalizeSapDeadline chi boc duoc dang yyyy-MM-dd/yyyymmdd; khi FE lo gui
	// chuoi dd/MM/yyyy (luc nguoi dung go tay) no tra ve "" -> guard bi tat -> RFQ
	// gui di binh thuong va Deadline khong duoc luu len SAP. Gio thieu/sai dinh dang
	// la CHAN HAN.
	const normalizedDeadlineCheck = normalizeSapDeadline(deadline);
	if (!normalizedDeadlineCheck) {
		return res.status(400).json({
			success: false,
			message: "Thieu han nop bao gia hoac ngay khong hop le (can dang YYYY-MM-DD)."
		});
	}
	if (normalizedDeadlineCheck < sapDateOnly()) {
		return res.status(400).json({ success: false, message: "Han nop bao gia khong duoc o qua khu." });
	}

	try {
		const ctx = await loadRfqContext(id);
		if (!ctx) {
			return res.status(404).json({ success: false, message: "Khong tim thay RFQ " + id + "." });
		}
		const { rfq, quotations, pr } = ctx;

		const resolved = await resolveQuotationEmails(quotations);
		const mailResult = await sendRfqInviteEmails({
			rfqId: id,
			quotations: resolved,
			prLabel: prLabelOf(rfq, pr),
			deadline: normalizeSapDeadline(deadline),
			// Chi cac dong THUOC RFQ nay (ItemLines) — khong gui ca ro hang cua PR cho
			// moi NCC nua. Xem itemsOfRfq/rfq.service.js.
			items: itemsOfRfq(rfq, (pr && pr.items) || []),
			baseUrl: appBaseUrl(req),
			buyerEmail: sentBy || process.env.EMAIL_USER,
			isReminder: false
		});
		await backfillQuotationEmails(id, resolved);

		const normalizedDeadline = normalizeSapDeadline(deadline);
		const mergeData = {
			Status: "SENT",
			SentAt: sapTimestamp()
		};
		if (normalizedDeadline) { mergeData.Deadline = normalizedDeadline; }

		await sapWrite("MERGE", `RfqSet('${odataEscape(id)}')`, mergeData);

		// Chuyen PR goc sang RFQ_SENT (khong ha cap neu vi ly do nao do da qua giai doan sau).
		//
		// CHI chuyen khi MOI dong cua PR da nam trong mot RFQ. Truoc day gui xong 1 RFQ
		// la doi trang thai ngay — dung khi 1 PR = 1 RFQ, nhung tu khi tach nhom thi
		// SAI: gui nhom 1 (1/3 dong) xong la PR roi khoi Status=PENDING_RFQ va bien mat
		// khoi man RFQ-01, 2 dong con lai khong bao gio duoc hoi gia nua (bug 16/08).
		if (pr && pr.Status === "PENDING_RFQ") {
			if (await prFullyCovered(pr)) {
				await updatePrDraft(pr.InternalId, { Status: "RFQ_SENT" });
			} else {
				console.log(`[POST /api/rfq/${id}/send] PR ${pr.PRId} con dong chua co RFQ — giu Status PENDING_RFQ de tao tiep nhom sau.`);
			}
		}

		return res.json({
			success: true,
			emailsSent: mailResult.sent,
			totalVendors: quotations.length,
			// FE canh bao ro: NCC khong co email trong VendorSet thi khong bao gio
			// nhan duoc thu, truoc day am tham bi bo qua (`continue`) khong ai biet.
			vendorsWithoutEmail: mailResult.noEmailVendors,
			emailsFailed: mailResult.failed
		});
	} catch (error) {
		const message = extractSapErrorMessage(error);
		console.error(`[POST /api/rfq/${id}/send] THAT BAI:`, message);
		return res.status(502).json({ success: false, message });
	}
});

// 2b) Gui NHAC cho cac NCC chua nop bao gia (QuoteStatus = PENDING).
// Thu cong tu man RFQ-02 hoac tu dong qua GET /api/cron/rfq-reminders.
router.post("/api/rfq/:id/remind", async (req, res) => {
	const { id } = req.params;
	const { sentBy } = req.body || {};

	if (!process.env.SAP_HOST) {
		return res.status(503).json({ success: false, message: "He thong SAP chua duoc cau hinh (thieu SAP_HOST)." });
	}

	try {
		const ctx = await loadRfqContext(id);
		if (!ctx) {
			return res.status(404).json({ success: false, message: "Khong tim thay RFQ " + id + "." });
		}
		const { rfq, quotations, pr } = ctx;

		if (rfq.Status === "AWARDED") {
			return res.status(400).json({ success: false, message: "RFQ " + id + " da chot NCC — khong gui nhac nua." });
		}
		if (rfq.Status === "DRAFT") {
			return res.status(400).json({ success: false, message: "RFQ " + id + " chua gui lan nao — hay bam gui o man RFQ-01 truoc." });
		}

		const pending = quotations.filter((q) => q.QuoteStatus === "PENDING");
		if (pending.length === 0) {
			return res.json({ success: true, emailsSent: 0, totalVendors: 0, message: "Tat ca NCC da nop bao gia — khong can nhac." });
		}

		// Chinh cho nay quan trong nhat: NCC bi thieu email luc tao RFQ ma sau do
		// master da duoc bo sung thi lan nhac nay se toi duoc ho.
		const resolved = await resolveQuotationEmails(pending);
		const mailResult = await sendRfqInviteEmails({
			rfqId: id,
			quotations: resolved,
			prLabel: prLabelOf(rfq, pr),
			deadline: rfq.Deadline,
			// Chi cac dong THUOC RFQ nay (ItemLines) — khong gui ca ro hang cua PR cho
			// moi NCC nua. Xem itemsOfRfq/rfq.service.js.
			items: itemsOfRfq(rfq, (pr && pr.items) || []),
			baseUrl: appBaseUrl(req),
			buyerEmail: sentBy || process.env.EMAIL_USER,
			isReminder: true
		});
		await backfillQuotationEmails(id, resolved);

		return res.json({
			success: true,
			emailsSent: mailResult.sent,
			totalVendors: pending.length,
			vendorsWithoutEmail: mailResult.noEmailVendors,
			emailsFailed: mailResult.failed
		});
	} catch (error) {
		const message = extractSapErrorMessage(error);
		console.error(`[POST /api/rfq/${id}/remind] THAT BAI:`, message);
		return res.status(502).json({ success: false, message });
	}
});

// RFQ o cac trang thai nay coi nhu DA XONG: khong nhap/sua bao gia duoc nua.
// Phai khop danh sach cung ten ben RFQ02.controller.js (giao dien an the nhap).
const RFQ_CLOSED_STATUSES = ["AWARDED", "PO_CREATED", "PO_RELEASED", "PO_REJECTED"];

// 3) Nhap tay 1 bao gia cho 1 NCC (bat buoc ghi ai nhap/luc nao/can cu gi — audit trail)
router.post("/api/rfq/:id/quotation", async (req, res) => {
	const { id } = req.params;
	const {
		vendorNo, quotedPrice, currency, leadTimeDays,
		paymentTerms, warrantyMonths, legalDocsOk, sourceNote, enteredBy
	} = req.body || {};

	if (!process.env.SAP_HOST) {
		return res.status(503).json({ success: false, message: "He thong SAP chua duoc cau hinh (thieu SAP_HOST)." });
	}
	if (!vendorNo) {
		return res.status(400).json({ success: false, message: "Thieu vendorNo." });
	}
	if (quotedPrice == null || quotedPrice === "" || Number(quotedPrice) <= 0) {
		return res.status(400).json({ success: false, message: "Gia bao gia (quotedPrice) khong hop le." });
	}
	if (!sourceNote || !String(sourceNote).trim()) {
		return res.status(400).json({ success: false, message: "Bat buoc nhap sourceNote (can cu nhap bao gia, vd email NCC ngay nao)." });
	}

	try {
		// RFQ da chot NCC / da thanh don hang thi KHOA: bao gia luc nay khong con
		// khop don hang da phat hanh cho NCC nua. Giao dien da an the nhap bao gia,
		// nhung khong tin FE — goi thang API van ghi duoc (giong cach da chan han
		// nop bao gia qua khu o /api/rfq/:id/send).
		const rfqHeadResp = await sapRead(`RfqSet('${odataEscape(id)}')`);
		const rfqHead = (rfqHeadResp.data && rfqHeadResp.data.d) || null;
		if (!rfqHead) {
			return res.status(404).json({ success: false, message: "Khong tim thay RFQ " + id + "." });
		}
		if (RFQ_CLOSED_STATUSES.indexOf(String(rfqHead.Status || "").toUpperCase()) !== -1) {
			return res.status(409).json({
				success: false,
				message: "RFQ " + id + " da khoa (trang thai " + rfqHead.Status
					+ ") — khong nhap hay sua bao gia duoc nua vi don hang da phat hanh theo bao gia hien tai."
			});
		}

		const session = await sapFetchCsrfToken();

		// NCC phai NAM TRONG danh sach duoc moi cua chinh RFQ nay. Dong QuotationSet
		// cua tung NCC duoc tao ngay luc /api/rfq/create, nen khong tim thay dong
		// nghia la NCC nay chua tung duoc moi bao gia.
		//
		// Vi sao CHAN (21/08/2026): dung nghiep vu mua hang, phai gui yeu cau bao gia
		// di thi moi co bao gia de nhap — nhap gia cho NCC chua moi la tao chung tu
		// khong co goc (SAP standard cung vay: ME47 chi nhap duoc tren RFQ da ton
		// tai). Giao dien da bo nhom "ngoai danh sach moi" khoi dropdown, nhung
		// khong tin FE — goi thang API van ghi duoc neu khong chan o day.
		const existingResp = await sapRead(`RfqSet('${odataEscape(id)}')/RfqToQuotations`);
		const existingQuotes = (existingResp.data && existingResp.data.d && existingResp.data.d.results) || [];
		const currentQuote = existingQuotes.find((q) => String(q.VendorNo) === String(vendorNo)) || null;
		if (!currentQuote) {
			return res.status(400).json({
				success: false,
				message: "NCC " + vendorNo + " khong nam trong danh sach duoc moi bao gia cua RFQ " + id
					+ ". Phai gui yeu cau bao gia cho NCC nay truoc (man RFQ-01) roi moi nhap duoc bao gia."
			});
		}

		const payload = {
			QuotedPrice: String(quotedPrice),
			Currency: currency || "VND",
			LeadTimeDays: Number(leadTimeDays) || 0,
			PaymentTerms: paymentTerms || "",
			WarrantyMonths: Number(warrantyMonths) || 0,
			LegalDocsOk: legalDocsOk ? "X" : "",
			QuoteStatus: "RECEIVED",
			EnteredBy: enteredBy || "",
			EnteredAt: sapTimestamp(),
			SourceNote: String(sourceNote).trim()
		};

		await sapWrite(
			"MERGE",
			`QuotationSet(RfqId='${odataEscape(id)}',VendorNo='${odataEscape(vendorNo)}')`,
			payload,
			session
		);

		await promoteRfqAfterQuotation(id, session);

		return res.json({
			success: true,
			// Gio chi con truong hop cap nhat bao gia cua NCC da duoc moi — nhanh
			// "created" da bi chan o tren. Giu field de FE cu khong vo.
			mode: "updated",
			previousPrice: currentQuote ? currentQuote.QuotedPrice : null
		});
	} catch (error) {
		const message = extractSapErrorMessage(error);
		console.error(`[POST /api/rfq/${id}/quotation] THAT BAI:`, message);
		return res.status(502).json({ success: false, message });
	}
});

// 4) Bang so sanh bao gia cho 1 RFQ
router.get("/api/rfq/:id/compare", async (req, res) => {
	const { id } = req.params;

	if (!process.env.SAP_HOST) {
		return res.status(503).json({ success: false, message: "He thong SAP chua duoc cau hinh (thieu SAP_HOST)." });
	}

	try {
		const rfqResp = await sapRead(`RfqSet('${odataEscape(id)}')`);
		const rfq = rfqResp.data && rfqResp.data.d;
		if (!rfq) {
			return res.status(404).json({ success: false, message: "Khong tim thay RFQ " + id + "." });
		}

		const quotationsResp = await sapRead(`RfqSet('${odataEscape(id)}')/RfqToQuotations`);
		const allQuotations = (quotationsResp.data && quotationsResp.data.d && quotationsResp.data.d.results) || [];

		const received = allQuotations.filter((q) => q.QuoteStatus === "RECEIVED" || q.QuoteStatus === "AWARDED");
		// Va email tu master cho cac NCC chua co email luc tao RFQ, de man RFQ-02
		// hien dung "co the nhac duoc" thay vi "chua co email" (xem
		// resolveQuotationEmails). Chi doc, khong ghi nguoc o day.
		const pending = await resolveQuotationEmails(allQuotations.filter((q) => q.QuoteStatus === "PENDING"));

		// Kem theo PR goc (header + tung dong item) de man RFQ-02 hien duoc "da yeu cau
		// bao gia cai gi" — truoc day chi tra ve moi ma RFQ, nguoi nhap bao gia khong
		// biet minh dang doi bao gia cho vat tu nao, so luong bao nhieu.
		// Doc PR loi thi van tra bang so sanh (pr = null), khong chan ca man hinh.
		let pr = null;
		try {
			pr = await fetchPrDraftByRfq(rfq);
		} catch (error) {
			console.error(`[GET /api/rfq/${id}/compare] Doc PR goc that bai:`, extractSapErrorMessage(error));
		}

		// CHI tra ve nhung dong THUOC RFQ NAY. 1 PR gio co the tach thanh nhieu RFQ
		// (moi nhom dong 1 cai) — man RFQ-02 hien "Noi dung yeu cau" tu pr.items, neu
		// de nguyen ca PR thi nguoi mua nhin thay ca 3 dong trong khi RFQ nay chi hoi
		// gia 1 dong (bug 16/08). TotalValue cung tinh lai theo dong cua nhom, khong
		// dung tong ca PR nua. ItemLines rong = RFQ om ca PR, chay y nhu cu.
		if (pr && Array.isArray(pr.items)) {
			const groupItems = itemsOfRfq(rfq, pr.items);
			const groupTotal = groupItems.reduce(function (sum, it) {
				return sum + (Number(it.EstimatedValue) || 0);
			}, 0);
			pr = Object.assign({}, pr, {
				items: groupItems,
				// Giu tong ca PR o field rieng de FE nao can van doc duoc.
				PrTotalValue: pr.TotalValue,
				TotalValue: groupTotal > 0 ? groupTotal : pr.TotalValue
			});
		}

		return res.json({
			success: true,
			rfq: rfqTimesToIso(rfq),
			pr,
			// PaymentTermsLabel: dich san ma dieu khoan (NET30...) sang nhan tieng Viet
			// de PR-02 (dialog so sanh cho CFO) va PO-01 dung duoc ma khong phai tu tra
			// danh muc /api/config.
			quotations: received.map(function (q) {
				return Object.assign(rfqTimesToIso(q), {
					PaymentTermsLabel: describePaymentTerms(q.PaymentTerms)
				});
			}),
			// QuoteLink: dung link portal ma chinh NCC do da nhan trong email, de
			// Purchasing copy gui lai qua Zalo/dien thoai khi NCC bao "khong thay mail".
			pendingVendors: pending.map((q) => ({
				VendorNo: q.VendorNo,
				VendorName: q.VendorName,
				VendorEmail: q.VendorEmail || "",
				// true = email nay lay tu master NCC chu KHONG phai dia chi da gui
				// RFQ luc dau (luc do master chua co email) -> chua tung nhan thu moi.
				EmailFromMaster: !!q.EmailFromMaster,
				QuoteLink: rfqQuoteLink(appBaseUrl(req), id, q.VendorNo)
			}))
		});
	} catch (error) {
		const message = extractSapErrorMessage(error);
		console.error(`[GET /api/rfq/${id}/compare] THAT BAI:`, message);
		return res.status(502).json({ success: false, message });
	}
});

// 5) Chot NCC thang — bat buoc >=2 bao gia RECEIVED + ly do. Moi nhom chot xong
// -> PR sang PENDING_CFO: CFO/CEO duyet DE NGHI truoc (buoc 9-11 so do TO-BE),
// PO-01 chi tao don hang sau khi da duyet xong (buoc 12).
router.post("/api/rfq/:id/award", async (req, res) => {
	const { id } = req.params;
	const { vendorNo, awardReason, awardedBy, soleSourceReason } = req.body || {};

	if (!process.env.SAP_HOST) {
		return res.status(503).json({ success: false, message: "He thong SAP chua duoc cau hinh (thieu SAP_HOST)." });
	}
	if (!vendorNo) {
		return res.status(400).json({ success: false, message: "Thieu vendorNo." });
	}
	if (!awardReason || !String(awardReason).trim()) {
		return res.status(400).json({ success: false, message: "Bat buoc nhap ly do chon nha cung cap (awardReason)." });
	}

	try {
		const quotationsResp = await sapRead(`RfqSet('${odataEscape(id)}')/RfqToQuotations`);
		const quotations = (quotationsResp.data && quotationsResp.data.d && quotationsResp.data.d.results) || [];
		const receivedCount = quotations.filter((q) => q.QuoteStatus === "RECEIVED" || q.QuoteStatus === "AWARDED").length;

		if (receivedCount < 1) {
			return res.status(400).json({ success: false, message: "Chua co bao gia nao duoc nhan." });
		}
		if (receivedCount === 1 && (!soleSourceReason || !String(soleSourceReason).trim())) {
			return res.status(400).json({ success: false, message: "Chi co 1 bao gia — bat buoc nhap ly do chi dinh 1 nha cung cap (sole source)." });
		}

		const winner = quotations.find((q) => String(q.VendorNo) === String(vendorNo));
		if (!winner) {
			return res.status(404).json({ success: false, message: "Khong tim thay bao gia cua nha cung cap " + vendorNo + " trong RFQ nay." });
		}
		if (winner.QuoteStatus !== "RECEIVED" && winner.QuoteStatus !== "AWARDED") {
			return res.status(400).json({ success: false, message: "Nha cung cap " + vendorNo + " chua co bao gia RECEIVED." });
		}

		const finalValue = winner.QuotedPrice;
		const finalCurrency = winner.Currency || "VND";
		const session = await sapFetchCsrfToken();

		const finalAwardReason = receivedCount === 1
			? "[SOLE SOURCE] " + String(soleSourceReason).trim() + " | " + String(awardReason).trim()
			: String(awardReason).trim();

		await sapWrite("MERGE", `RfqSet('${odataEscape(id)}')`, {
			Status: "AWARDED",
			AwardedVendor: String(vendorNo),
			AwardReason: finalAwardReason,
			AwardedBy: awardedBy || "",
			AwardedAt: sapTimestamp(),
			FinalValue: String(finalValue),
			Currency: finalCurrency
		}, session);

		await sapWrite(
			"MERGE",
			`QuotationSet(RfqId='${odataEscape(id)}',VendorNo='${odataEscape(vendorNo)}')`,
			{ QuoteStatus: "AWARDED" },
			session
		);

		// Cap nhat trang thai PR goc sang PENDING_CFO tren PrDraftSet (21/08/2026 —
		// quay ve dung so do TO-BE: duyet DE NGHI xong moi tao don hang).
		const rfqResp = await sapRead(`RfqSet('${odataEscape(id)}')`);
		const rfq = rfqResp.data && rfqResp.data.d;
		const prRecord = rfq && await fetchPrDraftByRfq(rfq);

		// ── CHO DU MOI NHOM ROI MOI DAY PR LEN CFO ──────────────────────────────
		// 1 PR gio co the co N RFQ (moi nhom dong 1 NCC). Chot xong nhom nay ma cac
		// nhom con lai chua co bao gia thi CHUA duoc chuyen PR sang AWARDED —
		// gia tong cua PR se thieu. Doc lai TAT CA RFQ cua PR (ban vua
		// MERGE o tren da nam trong ket qua doc lai nay) roi moi quyet dinh.
		let siblingRfqs = [];
		if (prRecord) {
			try {
				siblingRfqs = await fetchRfqsByPr(prRecord);
			} catch (error) {
				console.error(`[POST /api/rfq/${id}/award] Doc cac RFQ anh em that bai:`, extractSapErrorMessage(error));
				siblingRfqs = [];
			}
		}
		const pendingGroups = siblingRfqs
			.filter(function (r) { return String(r.Status || "").toUpperCase() !== "AWARDED"; })
			.map(function (r) { return String(r.RfqId); });

		if (prRecord && pendingGroups.length > 0) {
			console.log(`[POST /api/rfq/${id}/award] PR ${prRecord.PRId} con ${pendingGroups.length} nhom chua chot `
				+ `(${pendingGroups.join(", ")}) — giu nguyen trang thai PR, chua day len CFO.`);
			return res.json({
				success: true,
				finalValue,
				awardedVendor: String(vendorNo),
				pendingGroups: pendingGroups,
				prPromoted: false
			});
		}

		// Tat ca nhom da chot -> gia tri PR = TONG gia trung thau cua moi nhom.
		const groupTotal = siblingRfqs.reduce(function (sum, r) {
			return sum + (Number(r.FinalValue) || 0);
		}, 0);
		const prFinalValue = siblingRfqs.length > 1 ? groupTotal : finalValue;
		const isMultiGroup = siblingRfqs.length > 1;

		if (prRecord) {
			// Tinh lai co/khong vuot nguong CEO tren GIA THAT tu bao gia thang, khong dung
			// gia uoc tinh luc tao PR nua — gia uoc tinh va gia thuong luong co the lech nhau
			// đủ để đổi kết quả escalation. Giữ lại giá ước tính ban đầu để audit trail.
			// PHAI dung ban theo CostCenter: item khong con InternalOrder nen ban goc
			// luon tra needsProcurementHeadReview=false -> PR vuot ngan sach van truot
			// thang qua CFO, khong bao gio leo CEO.
			const recalculatedFlags = await buildApprovalFlagsByCostCenter(prFinalValue, prRecord.items);

			if (prRecord.EstimatedTotalValue == null) {
				prRecord.EstimatedTotalValue = prRecord.TotalValue;
			}
			prRecord.TotalValue = prFinalValue;
			prRecord.Currency = finalCurrency;
			prRecord.needsProcurementHeadReview = recalculatedFlags.needsProcurementHeadReview;
			prRecord.needsLegalReview = recalculatedFlags.needsLegalReview;
			prRecord.ioThreshold = recalculatedFlags.ioThreshold;
			prRecord.escalationIO = recalculatedFlags.escalationIO;

			prRecord.Status = "PENDING_CFO";
			prRecord.UpdatedAt = new Date().toISOString();
			prRecord.RfqId = id;
			// PR nhieu nhom = nhieu NCC thang thau khac nhau -> 1 field RfqAwardedVendor
			// khong the dai dien cho ca PR. De RONG co y: PO-01 doc field nay de tu dien
			// san NCC + don gia; neu dien 1 NCC trong khi gia la TONG cua ca 3 nhom thi
			// se de ra dung cai loi "moi dong deu mang gia ca don" da gap. PO-01 se doc
			// theo tung RFQ o ban sua sau; tu gio toi luc do, PR nhieu nhom bat nguoi mua
			// chon NCC tay (hanh vi cu, an toan).
			prRecord.RfqAwardedVendor = isMultiGroup ? "" : String(vendorNo);
			prRecord.RfqFinalValue = prFinalValue;

			await updatePrDraft(prRecord.InternalId, {
				EstimatedTotalValue: String(prRecord.EstimatedTotalValue),
				TotalValue: String(prFinalValue),
				Currency: finalCurrency,
				NeedsProcurementHeadReview: boolToSapX(recalculatedFlags.needsProcurementHeadReview),
				NeedsLegalReview: boolToSapX(recalculatedFlags.needsLegalReview),
				IoThreshold: recalculatedFlags.ioThreshold != null ? String(recalculatedFlags.ioThreshold) : "0",
				EscalationIO: recalculatedFlags.escalationIO || "",
				Status: "PENDING_CFO",
				RfqId: id,
				RfqAwardedVendor: isMultiGroup ? "" : String(vendorNo),
				RfqFinalValue: String(prFinalValue)
			});

			const groupNote = isMultiGroup
				? " (tong " + siblingRfqs.length + " nhom bao gia)"
				: "";

			notifyRequester(
				prRecord,
				"RFQ " + id + " đã chọn nhà cung cấp " + vendorNo + ". Đề nghị " + prRecord.PRId
				+ " đã chuyển sang CFO phê duyệt" + groupNote + " — duyệt xong Phòng Mua sắm mới tạo đơn hàng."
			);
			await notifyPurchasing(
				prRecord.PRId,
				"RFQ " + id + " đã chốt nhà cung cấp " + vendorNo + " — giá "
				+ Number(prFinalValue).toLocaleString("vi-VN") + " " + finalCurrency + groupNote
				+ ". Đề nghị đang chờ CFO phê duyệt; sau khi duyệt, Phòng Mua sắm tạo đơn hàng ở màn hình PO-01."
			);
			await notifyCfo(
				prRecord.PRId,
				"Đề nghị " + prRecord.PRId + " đã chốt nhà cung cấp — giá "
				+ Number(prFinalValue).toLocaleString("vi-VN") + " " + finalCurrency + groupNote
				+ ", đang chờ bạn phê duyệt."
				+ (recalculatedFlags.needsProcurementHeadReview ? " Lưu ý: vượt ngưỡng IO — sau CFO sẽ cần CEO duyệt." : "")
			);
		} else {
			console.error(`[POST /api/rfq/${id}/award] Khong tim thay PR tuong ung tren SAP de cap nhat trang thai.`);
		}

		return res.json({
			success: true,
			finalValue,
			awardedVendor: String(vendorNo),
			pendingGroups: [],
			prPromoted: !!prRecord,
			prTotalValue: prFinalValue,
			groupCount: siblingRfqs.length
		});
	} catch (error) {
		const message = extractSapErrorMessage(error);
		console.error(`[POST /api/rfq/${id}/award] THAT BAI:`, message);
		return res.status(502).json({ success: false, message });
	}
});
module.exports = router;
