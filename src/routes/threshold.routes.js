/**
 * Man cau hinh nguong duyet theo Internal Order.
 *
 * Tach ra tu server.js (ban goc 4520 dong) ngay 15/08/2026.
 * Noi dung ham giu nguyen 100%, chi them phan require/exports o dau va cuoi file.
 */


const express = require("express");
const { normalizeOrderNo, saveThresholds, thresholdStore } = require("../lib/store");

const router = express.Router();


// --- Ngưỡng theo Internal Order ---
router.get("/api/thresholds", (req, res) => {
	return res.json({ success: true, byIO: thresholdStore.byIO });
});

router.put("/api/thresholds", (req, res) => {
	const body = req.body || {};

	if (body.internalOrder != null) {
		const key = normalizeOrderNo(body.internalOrder);
		if (!key) {
			return res.status(400).json({ success: false, message: "Internal Order khong hop le." });
		}
		if (body.threshold == null || body.threshold === "") {
			delete thresholdStore.byIO[key];
		} else {
			thresholdStore.byIO[key] = Number(body.threshold);
		}
	}

	if (body.byIO && typeof body.byIO === "object") {
		Object.keys(body.byIO).forEach(function (io) {
			const key = normalizeOrderNo(io);
			if (!key) { return; }
			if (body.byIO[io] == null || body.byIO[io] === "") {
				delete thresholdStore.byIO[key];
			} else {
				thresholdStore.byIO[key] = Number(body.byIO[io]);
			}
		});
	}

	saveThresholds();
	return res.json({ success: true, byIO: thresholdStore.byIO });
});
module.exports = router;
