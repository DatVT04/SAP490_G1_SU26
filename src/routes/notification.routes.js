/**
 * Chuong thong bao.
 *
 * Tach ra tu server.js (ban goc 4520 dong) ngay 15/08/2026.
 * Noi dung ham giu nguyen 100%, chi them phan require/exports o dau va cuoi file.
 */


const express = require("express");
const { notificationStore, saveNotifications } = require("../lib/store");
const { buildAgingAlerts } = require("../services/approval.service");
const { buildRfqAlerts } = require("../services/rfq.service");

const router = express.Router();


router.get("/api/notifications", async (req, res) => {
	const { email } = req.query;
	const role = String(req.query.role || "").toUpperCase();
	if (!email) {
		return res.status(400).json({ success: false, message: "Thieu email." });
	}
	const list = notificationStore
		.filter((n) => n.toEmail.toLowerCase() === String(email).toLowerCase())
		.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

	// Canh bao aging + canh bao RFQ dat len dau danh sach — la viec can xu ly
	// ngay, khong phai lich su. Chay song song vi doc 2 nguon SAP khac nhau.
	const [agingAlerts, rfqAlerts] = await Promise.all([
		buildAgingAlerts(role, String(email)),
		buildRfqAlerts(role, String(email))
	]);
	return res.json({ success: true, data: rfqAlerts.concat(agingAlerts).concat(list) });
});

router.patch("/api/notifications/:id/read", (req, res) => {
	const id = Number(req.params.id);
	const n = notificationStore.find((x) => x.id === id);
	if (!n) {
		return res.status(404).json({ success: false, message: "Khong tim thay thong bao." });
	}
	n.read = true;
	saveNotifications();
	return res.json({ success: true });
});
module.exports = router;
