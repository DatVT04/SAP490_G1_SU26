/**
 * Dang nhap (thuong + Google) va config gui cho FE.
 *
 * Tach ra tu server.js (ban goc 4520 dong) ngay 15/08/2026.
 * Noi dung ham giu nguyen 100%, chi them phan require/exports o dau va cuoi file.
 */


const express = require("express");
const axios = require("axios");
const { ORG_DEFAULTS } = require("../config/org");
const { PAYMENT_TERMS } = require("../config/payment-terms");
const { findActiveEmployeeByEmail } = require("../services/employee.service");

const router = express.Router();


// Cho frontend biet co the hien nut "Dang nhap voi Google" hay khong,
// va lay dung Client ID (khong bi coi la bi mat, an toan de tra ve public).
router.get("/api/config", (req, res) => {
	// orgDefaults: de PO-01 tu dien san Company Code / Purch Org / Purch Group
	// thay vi bat nguoi dung go tay moi lan (ban ghi PR khong he luu cac field nay).
	// paymentTerms: de RFQ-02 dung chung 1 danh muc voi backend/AI, khong hardcode
	// lai o view (tranh lech ma giua noi luu va noi hien thi).
	res.json({
		googleClientId: process.env.GOOGLE_CLIENT_ID || null,
		orgDefaults: ORG_DEFAULTS,
		paymentTerms: PAYMENT_TERMS
	});
});

/**
 * ⚠️ DANG NHAP CHI BANG EMAIL — KHONG CO YEU TO XAC THUC NAO.
 * Ai go dung 1 email dang active trong SAP la vao duoc, du khong phai chu
 * email do. Giu lai de test/dev khi chua cau hinh Google OAuth, nhung VE
 * BAN CHAT KHONG AN TOAN. Khi da co GOOGLE_CLIENT_ID, nen uu tien dung
 * /api/login/google va can nhac tat han duong nay o production.
 */
router.post("/api/login", async (req, res) => {
	const { email } = req.body || {};
	if (!email) {
		return res.status(400).json({ success: false, message: "Thieu email." });
	}

	if (!process.env.SAP_HOST) {
		return res.status(503).json({ success: false, message: "He thong SAP chua duoc cau hinh (thieu SAP_HOST)." });
	}

	try {
		const employee = await findActiveEmployeeByEmail(email);
		if (!employee || !employee.IsActive) {
			return res.status(401).json({ success: false, message: "Email khong ton tai hoac tai khoan da bi khoa." });
		}
		return res.json({ success: true, employee });
	} catch (error) {
		console.error("❌ [login] Loi ket noi SAP:", error.message);
		return res.status(502).json({ success: false, message: "Khong the ket noi toi he thong SAP." });
	}
});

/**
 * Dang nhap qua Google (khuyen nghi dung thay /api/login).
 * Google da xac minh danh tinh nguoi dung (mat khau + 2FA phia Google) va
 * ky so ID token — server chi can xac minh chu ky/audience qua endpoint
 * chinh thuc cua Google (khong them thu vien moi, tranh lap loi bundling
 * nhu tung gap voi nodemailer tren Vercel), sau do doi chieu email voi SAP.
 */
router.post("/api/login/google", async (req, res) => {
	const { credential } = req.body || {};
	if (!credential) {
		return res.status(400).json({ success: false, message: "Thieu Google ID token." });
	}
	if (!process.env.GOOGLE_CLIENT_ID) {
		return res.status(503).json({ success: false, message: "Dang nhap Google chua duoc cau hinh (thieu GOOGLE_CLIENT_ID)." });
	}

	let payload;
	try {
		const verifyResp = await axios.get(
			"https://oauth2.googleapis.com/tokeninfo",
			{ params: { id_token: credential }, timeout: 8000 }
		);
		payload = verifyResp.data;
	} catch (error) {
		console.error("❌ [login/google] Token khong hop le/het han:", error.message);
		return res.status(401).json({ success: false, message: "Phien dang nhap Google khong hop le hoac da het han, vui long thu lai." });
	}

	if (payload.aud !== process.env.GOOGLE_CLIENT_ID) {
		console.error("❌ [login/google] Sai audience — token khong phai cap cho app nay.");
		return res.status(401).json({ success: false, message: "Token khong hop le." });
	}
	if (payload.email_verified !== "true" && payload.email_verified !== true) {
		return res.status(401).json({ success: false, message: "Email Google chua duoc xac minh." });
	}

	const email = payload.email;
	if (!process.env.SAP_HOST) {
		return res.status(503).json({ success: false, message: "He thong SAP chua duoc cau hinh (thieu SAP_HOST)." });
	}

	try {
		const employee = await findActiveEmployeeByEmail(email);
		if (!employee || !employee.IsActive) {
			return res.status(401).json({
				success: false,
				message: `Email ${email} chua duoc cap quyen truy cap he thong (khong co trong SAP hoac da bi khoa).`
			});
		}
		return res.json({ success: true, employee, googlePicture: payload.picture || null });
	} catch (error) {
		console.error("❌ [login/google] Loi ket noi SAP:", error.message);
		return res.status(502).json({ success: false, message: "Khong the ket noi toi he thong SAP." });
	}
});
module.exports = router;
