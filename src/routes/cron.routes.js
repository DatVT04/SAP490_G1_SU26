/**
 * Job dinh ky Vercel goi vao (nhac NCC nop bao gia).
 *
 * Tach ra tu server.js (ban goc 4520 dong) ngay 15/08/2026.
 * Noi dung ham giu nguyen 100%, chi them phan require/exports o dau va cuoi file.
 */


const express = require("express");
const { RFQ_REMIND_ON_DAYS_LEFT } = require("../config/alerts");
const { daysUntilDeadline } = require("../lib/html");
const { extractSapErrorMessage, sapRead } = require("../lib/sap-client");
const { sendRfqInviteEmails } = require("../services/rfq-mail.service");
const { appBaseUrl } = require("../services/rfq-portal.service");
const { loadRfqContext, prLabelOf } = require("../services/rfq.service");

const router = express.Router();


router.get("/api/cron/rfq-reminders", async (req, res) => {
	// Vercel Cron gui header Authorization: Bearer <CRON_SECRET>. Neu khong dat
	// CRON_SECRET thi route bi khoa han — endpoint nay gui mail ra ngoai, de mo
	// cho ca internet goi la mo duong spam NCC.
	const secret = String(process.env.CRON_SECRET || "").trim();
	if (!secret) {
		return res.status(503).json({ success: false, message: "CRON_SECRET chua duoc cau hinh — route nhac tu dong dang tat." });
	}
	if (String(req.headers.authorization || "") !== "Bearer " + secret) {
		return res.status(401).json({ success: false, message: "Unauthorized." });
	}
	if (!process.env.SAP_HOST) {
		return res.status(503).json({ success: false, message: "He thong SAP chua duoc cau hinh (thieu SAP_HOST)." });
	}

	try {
		const rfqResp = await sapRead("RfqSet");
		const rfqs = (rfqResp.data && rfqResp.data.d && rfqResp.data.d.results) || [];
		const targets = rfqs.filter(function (rfq) {
			const status = String(rfq.Status || "").toUpperCase();
			if (status !== "SENT" && status !== "QUOTATIONS_RECEIVED") { return false; }
			const daysLeft = daysUntilDeadline(rfq.Deadline);
			return daysLeft != null && RFQ_REMIND_ON_DAYS_LEFT.indexOf(daysLeft) >= 0;
		});

		const report = [];
		for (const rfq of targets) {
			const rfqId = String(rfq.RfqId);
			try {
				const ctx = await loadRfqContext(rfqId);
				if (!ctx) { continue; }
				const pending = ctx.quotations.filter((q) => q.QuoteStatus === "PENDING");
				if (pending.length === 0) { continue; }

				const mailResult = await sendRfqInviteEmails({
					rfqId: rfqId,
					quotations: pending,
					prLabel: prLabelOf(ctx.rfq, ctx.pr),
					deadline: ctx.rfq.Deadline,
					items: (ctx.pr && ctx.pr.items) || [],
					baseUrl: appBaseUrl(req),
					buyerEmail: process.env.EMAIL_USER,
					isReminder: true
				});
				report.push({ rfqId: rfqId, daysLeft: daysUntilDeadline(rfq.Deadline), reminded: mailResult.sent, failed: mailResult.failed });
			} catch (error) {
				console.error("[GET /api/cron/rfq-reminders] Bo qua RFQ " + rfqId + ":", extractSapErrorMessage(error));
			}
		}

		console.log("[GET /api/cron/rfq-reminders] Da xu ly " + report.length + " RFQ:", JSON.stringify(report));
		return res.json({ success: true, processed: report.length, detail: report });
	} catch (error) {
		const message = extractSapErrorMessage(error);
		console.error("[GET /api/cron/rfq-reminders] THAT BAI:", message);
		return res.status(502).json({ success: false, message });
	}
});
module.exports = router;
