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

// 22/08/2026: bo endpoint PUT /api/thresholds. Man "Cau hinh he thong" cua CEO
// da go, khong con cho nao sua nguong tu web. Nguong la cau hinh co dinh trong
// data/thresholds.json (mo phong characteristic gia tri cua release strategy),
// chi doc bang GET o tren de PR-01 canh bao truoc khi gui.

module.exports = router;
