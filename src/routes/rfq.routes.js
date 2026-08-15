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
const { notifyCfo, notifyRequester } = require("../services/notify.service");
const { fetchPrDraftById, fetchPrDraftByRfq, updatePrDraft } = require("../services/pr.service");
const { sendRfqInviteEmails } = require("../services/rfq-mail.service");
const { appBaseUrl, rfqQuoteLink } = require("../services/rfq-portal.service");
const { backfillQuotationEmails, generateNextRfqId, loadRfqContext, prLabelOf, promoteRfqAfterQuotation, resolveQuotationEmails } = require("../services/rfq.service");
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
	const { prId, sapPrNumber, vendorIds, createdBy, currency } = req.body || {};

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
	// tạo RFQ ở đây. Chặn tạo trùng bằng check RfqId đã gắn.
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
	if (prRecord.RfqId) {
		return res.status(400).json({
			success: false,
			message: "PR " + prId + " da co RFQ " + prRecord.RfqId + " — khong tao trung."
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
			RfqToQuotations: rfqToQuotations
		}, session);

		// RFQ da tao thanh cong tren SAP -> gan RfqId vao PR (Status van PENDING_RFQ,
		// RfqId != rong la dau hieu "da co RFQ, dang o buoc gui/nhap bao gia").
		prRecord.RfqId = rfqId;
		prRecord.UpdatedAt = new Date().toISOString();
		await updatePrDraft(prRecord.InternalId, { RfqId: rfqId }, session);

		notifyRequester(
			prRecord,
			"Đề nghị " + prRecord.PRId + " đang được Purchasing gửi yêu cầu báo giá (RFQ " + rfqId + ") tới nhà cung cấp."
		);

		return res.status(201).json({ success: true, rfqId, status: "DRAFT" });
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
	const normalizedDeadlineCheck = normalizeSapDeadline(deadline);
	if (normalizedDeadlineCheck && normalizedDeadlineCheck < sapDateOnly()) {
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
			items: (pr && pr.items) || [],
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
		if (pr && pr.Status === "PENDING_RFQ") {
			await updatePrDraft(pr.InternalId, { Status: "RFQ_SENT" });
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
			items: (pr && pr.items) || [],
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
		const session = await sapFetchCsrfToken();

		await sapWrite(
			"MERGE",
			`QuotationSet(RfqId='${odataEscape(id)}',VendorNo='${odataEscape(vendorNo)}')`,
			{
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
			},
			session
		);

		await promoteRfqAfterQuotation(id, session);

		return res.json({ success: true });
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

// 5) Chot NCC thang — bat buoc >=2 bao gia RECEIVED + ly do, chuyen PR goc sang PENDING_CFO
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

		// Cap nhat trang thai PR goc sang PENDING_CFO tren PrDraftSet.
		const rfqResp = await sapRead(`RfqSet('${odataEscape(id)}')`);
		const rfq = rfqResp.data && rfqResp.data.d;
		const prRecord = rfq && await fetchPrDraftByRfq(rfq);
		if (prRecord) {
			// Tinh lai co/khong vuot nguong CEO tren GIA THAT tu bao gia thang, khong dung
			// gia uoc tinh luc tao PR nua — gia uoc tinh va gia thuong luong co the lech nhau
			// đủ để đổi kết quả escalation. Giữ lại giá ước tính ban đầu để audit trail.
			// PHAI dung ban theo CostCenter: item khong con InternalOrder nen ban goc
			// luon tra needsProcurementHeadReview=false -> PR vuot ngan sach van truot
			// thang qua CFO, khong bao gio leo CEO.
			const recalculatedFlags = await buildApprovalFlagsByCostCenter(finalValue, prRecord.items);

			if (prRecord.EstimatedTotalValue == null) {
				prRecord.EstimatedTotalValue = prRecord.TotalValue;
			}
			prRecord.TotalValue = finalValue;
			prRecord.Currency = finalCurrency;
			prRecord.needsProcurementHeadReview = recalculatedFlags.needsProcurementHeadReview;
			prRecord.needsLegalReview = recalculatedFlags.needsLegalReview;
			prRecord.ioThreshold = recalculatedFlags.ioThreshold;
			prRecord.escalationIO = recalculatedFlags.escalationIO;

			prRecord.Status = "PENDING_CFO";
			prRecord.UpdatedAt = new Date().toISOString();
			prRecord.RfqId = id;
			prRecord.RfqAwardedVendor = String(vendorNo);
			prRecord.RfqFinalValue = finalValue;

			await updatePrDraft(prRecord.InternalId, {
				EstimatedTotalValue: String(prRecord.EstimatedTotalValue),
				TotalValue: String(finalValue),
				Currency: finalCurrency,
				NeedsProcurementHeadReview: boolToSapX(recalculatedFlags.needsProcurementHeadReview),
				NeedsLegalReview: boolToSapX(recalculatedFlags.needsLegalReview),
				IoThreshold: recalculatedFlags.ioThreshold != null ? String(recalculatedFlags.ioThreshold) : "0",
				EscalationIO: recalculatedFlags.escalationIO || "",
				Status: "PENDING_CFO",
				RfqId: id,
				RfqAwardedVendor: String(vendorNo),
				RfqFinalValue: String(finalValue)
			});

			notifyRequester(
				prRecord,
				"RFQ " + id + " da chon nha cung cap " + vendorNo + ". De nghi " + prRecord.PRId + " chuyen sang cho CFO xem xet."
			);
			await notifyCfo(
				prRecord.PRId,
				"RFQ " + id + " da chon NCC " + vendorNo + " — gia tri bao gia "
				+ Number(finalValue).toLocaleString("vi-VN") + " " + finalCurrency + ". Cho CFO duyet."
			);
		} else {
			console.error(`[POST /api/rfq/${id}/award] Khong tim thay PR tuong ung tren SAP de cap nhat trang thai.`);
		}

		return res.json({ success: true, finalValue, awardedVendor: String(vendorNo) });
	} catch (error) {
		const message = extractSapErrorMessage(error);
		console.error(`[POST /api/rfq/${id}/award] THAT BAI:`, message);
		return res.status(502).json({ success: false, message });
	}
});
module.exports = router;
