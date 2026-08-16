/**
 * Route CONG KHAI (khong dang nhap) phuc vu trang quote.html cua NCC.
 *
 * Tach ra tu server.js (ban goc 4520 dong) ngay 15/08/2026.
 * Noi dung ham giu nguyen 100%, chi them phan require/exports o dau va cuoi file.
 */


const express = require("express");
const { PAYMENT_TERMS } = require("../config/payment-terms");
const { daysUntilDeadline, formatDeadlineVi } = require("../lib/html");
const { extractSapErrorMessage, odataEscape, sapWrite } = require("../lib/sap-client");
const { sapDateOnly, sapTimestamp, sapTsToIso } = require("../lib/sap-format");
const { notifyPurchasingNewQuote } = require("../services/notify.service");
const { verifyRfqPortalToken } = require("../services/rfq-portal.service");
const { itemsOfRfq, loadRfqContext, prLabelOf, promoteRfqAfterQuotation } = require("../services/rfq.service");

const router = express.Router();


// ── ROUTE CONG KHAI (KHONG DANG NHAP) — chi phuc vu trang quote.html ────────
// Bao mat: moi request bat buoc co token dung cho dung cap (RfqId, VendorNo).
// Tra ve DUY NHAT nhung gi NCC duoc phep thay: ma RFQ, han nop, mo ta + so
// luong vat tu. TUYET DOI khong tra EstimatedValue/TotalValue (ngan sach noi
// bo), khong tra danh sach NCC khac, khong tra bao gia cua NCC khac.

/** Doc du lieu de hien trang portal. */
router.get("/api/public/rfq/quote", async (req, res) => {
	const rfqId = String(req.query.rfq || "").trim();
	const vendorNo = String(req.query.v || "").trim();
	const token = String(req.query.t || "").trim();

	if (!rfqId || !vendorNo || !token) {
		return res.status(400).json({ success: false, message: "Đường dẫn không hợp lệ (thiếu tham số)." });
	}
	if (!verifyRfqPortalToken(rfqId, vendorNo, token)) {
		return res.status(403).json({ success: false, message: "Đường dẫn không hợp lệ hoặc đã hết hiệu lực. Vui lòng liên hệ Phòng Thu mua." });
	}
	if (!process.env.SAP_HOST) {
		return res.status(503).json({ success: false, message: "Hệ thống đang bảo trì, vui lòng thử lại sau." });
	}

	try {
		const ctx = await loadRfqContext(rfqId);
		if (!ctx) {
			return res.status(404).json({ success: false, message: "Không tìm thấy yêu cầu báo giá này." });
		}
		const mine = ctx.quotations.find((q) => String(q.VendorNo) === vendorNo);
		if (!mine) {
			return res.status(404).json({ success: false, message: "Quý công ty không nằm trong danh sách được mời báo giá của yêu cầu này." });
		}

		const daysLeft = daysUntilDeadline(ctx.rfq.Deadline);
		return res.json({
			success: true,
			rfqId: rfqId,
			prLabel: prLabelOf(ctx.rfq, ctx.pr),
			rfqStatus: ctx.rfq.Status,
			deadline: ctx.rfq.Deadline || "",
			deadlineText: ctx.rfq.Deadline ? formatDeadlineVi(ctx.rfq.Deadline) : "",
			daysLeft: daysLeft,
			overdue: daysLeft != null && daysLeft < 0,
			// Da chot NCC thi khoa form — nhan xong roi ma con cho nhap tiep la lam
			// nguoi ta mat cong vo ich.
			closed: ctx.rfq.Status === "AWARDED",
			awardedToMe: ctx.rfq.Status === "AWARDED" && String(ctx.rfq.AwardedVendor || "") === vendorNo,
			vendor: { VendorNo: mine.VendorNo, VendorName: mine.VendorName || "" },
			// Chi mo ta + so luong. Khong co gia tri uoc tinh.
			// itemsOfRfq: chi tra ve nhung dong THUOC RFQ NAY (ZG1_RFQ-ITEM_LINES).
			// 1 PR nhieu dong gio co the tach thanh nhieu RFQ gui cho nhung nhom NCC
			// khac nhau — NCC ban ban ghe khong duoc nhin thay dong switch Cisco, vua
			// vi khong lien quan vua vi do la thong tin mua sam cua NCC khac.
			// ItemLines rong (RFQ tao truoc 16/08/2026) = tra ve tat ca, y nhu cu.
			items: itemsOfRfq(ctx.rfq, (ctx.pr && ctx.pr.items) || []).map(function (it) {
				return {
					LineNo: it.LineNo,
					Description: it.Description || "",
					MaterialNo: it.MaterialNo || "",
					Quantity: it.Quantity || 0,
					UoM: it.UoM || ""
				};
			}),
			paymentTerms: PAYMENT_TERMS,
			currency: ctx.rfq.Currency || "VND",
			// Da nop roi thi do lai de NCC sua/xac nhan, khong bat go lai tu dau.
			submitted: mine.QuoteStatus === "RECEIVED" || mine.QuoteStatus === "AWARDED",
			current: (mine.QuoteStatus === "RECEIVED" || mine.QuoteStatus === "AWARDED") ? {
				quotedPrice: Number(mine.QuotedPrice) || 0,
				leadTimeDays: Number(mine.LeadTimeDays) || 0,
				paymentTerms: mine.PaymentTerms || "",
				warrantyMonths: Number(mine.WarrantyMonths) || 0,
				legalDocsOk: mine.LegalDocsOk === "X",
				enteredAt: sapTsToIso(mine.EnteredAt, 0)
			} : null
		});
	} catch (error) {
		console.error("[GET /api/public/rfq/quote] THAT BAI:", extractSapErrorMessage(error));
		return res.status(502).json({ success: false, message: "Không đọc được yêu cầu báo giá. Vui lòng thử lại sau ít phút." });
	}
});

/** NCC bam "Gửi báo giá" tren portal. */
router.post("/api/public/rfq/quote", async (req, res) => {
	const body = req.body || {};
	const rfqId = String(body.rfq || "").trim();
	const vendorNo = String(body.v || "").trim();
	const token = String(body.t || "").trim();

	if (!rfqId || !vendorNo || !verifyRfqPortalToken(rfqId, vendorNo, token)) {
		return res.status(403).json({ success: false, message: "Đường dẫn không hợp lệ hoặc đã hết hiệu lực." });
	}
	if (!process.env.SAP_HOST) {
		return res.status(503).json({ success: false, message: "Hệ thống đang bảo trì, vui lòng thử lại sau." });
	}

	const price = Number(body.quotedPrice);
	if (!isFinite(price) || price <= 0) {
		return res.status(400).json({ success: false, message: "Vui lòng nhập tổng giá báo hợp lệ (lớn hơn 0)." });
	}
	const contactName = String(body.contactName || "").trim();
	if (!contactName) {
		return res.status(400).json({ success: false, message: "Vui lòng nhập tên người gửi báo giá." });
	}
	// Ma dieu khoan phai nam trong danh muc — khong nhan chuoi tu do tu ben ngoai
	// (day la du lieu cong khai, ai cung POST duoc neu co link).
	const termCode = String(body.paymentTerms || "").trim().toUpperCase();
	if (termCode && !PAYMENT_TERMS.some((t) => t.code === termCode)) {
		return res.status(400).json({ success: false, message: "Điều khoản thanh toán không hợp lệ." });
	}

	try {
		const ctx = await loadRfqContext(rfqId);
		if (!ctx) {
			return res.status(404).json({ success: false, message: "Không tìm thấy yêu cầu báo giá này." });
		}
		const mine = ctx.quotations.find((q) => String(q.VendorNo) === vendorNo);
		if (!mine) {
			return res.status(404).json({ success: false, message: "Quý công ty không nằm trong danh sách được mời báo giá của yêu cầu này." });
		}
		if (ctx.rfq.Status === "AWARDED") {
			return res.status(409).json({ success: false, message: "Yêu cầu báo giá này đã kết thúc (đã chọn được nhà cung cấp)." });
		}

		const daysLeft = daysUntilDeadline(ctx.rfq.Deadline);
		const late = daysLeft != null && daysLeft < 0;
		const contactInfo = String(body.contactInfo || "").trim();

		// SourceNote/EnteredBy la field CHAR do dai co han tren ZG1_QUOTATION —
		// cat ngan chu dong o day, vi ABAP cat cut am tham khong bao loi (da dinh
		// 1 lan voi ZPR_DRAFT-RFQID CHAR10, xem CLAUDE.md).
		const sourceNote = ("NCC tự gửi qua Portal " + sapDateOnly() + " — " + contactName
			+ (contactInfo ? " (" + contactInfo + ")" : "")
			+ (late ? " [NỘP SAU HẠN]" : "")).slice(0, 100);

		await sapWrite(
			"MERGE",
			`QuotationSet(RfqId='${odataEscape(rfqId)}',VendorNo='${odataEscape(vendorNo)}')`,
			{
				QuotedPrice: String(price),
				Currency: ctx.rfq.Currency || "VND",
				LeadTimeDays: Number(body.leadTimeDays) || 0,
				PaymentTerms: termCode,
				WarrantyMonths: Number(body.warrantyMonths) || 0,
				LegalDocsOk: body.legalDocsOk ? "X" : "",
				QuoteStatus: "RECEIVED",
				EnteredBy: (contactInfo || contactName).slice(0, 40),
				EnteredAt: sapTimestamp(),
				SourceNote: sourceNote
			}
		);

		await promoteRfqAfterQuotation(rfqId);

		// Khong de loi gui thong bao lam hong ket qua da ghi thanh cong len SAP.
		try {
			await notifyPurchasingNewQuote(rfqId, prLabelOf(ctx.rfq, ctx.pr), {
				VendorNo: vendorNo,
				VendorName: mine.VendorName,
				QuotedPrice: price,
				Currency: ctx.rfq.Currency || "VND"
			});
		} catch (notifyError) {
			console.error("[POST /api/public/rfq/quote] Bao cho Purchasing that bai:", notifyError.message);
		}

		return res.json({ success: true, late: late });
	} catch (error) {
		console.error("[POST /api/public/rfq/quote] THAT BAI:", extractSapErrorMessage(error));
		return res.status(502).json({ success: false, message: "Không lưu được báo giá. Vui lòng thử lại hoặc gửi email cho Phòng Thu mua." });
	}
});
module.exports = router;
