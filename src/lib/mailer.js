/**
 * Khoi tao nodemailer transporter (lazy, dung chung cho moi loai mail).
 *
 * Tach ra tu server.js (ban goc 4520 dong) ngay 15/08/2026.
 * Noi dung ham giu nguyen 100%, chi them phan require/exports o dau va cuoi file.
 */




// nodemailer chỉ dùng cho tính năng phụ (gửi PO cho vendor qua email).
// Lazy-load + try/catch để nếu module thiếu/lỗi trên môi trường deploy
// (VD Vercel không bundle đúng nodemailer) thì CHỈ tính năng gửi mail bị
// tắt, không kéo sập toàn bộ server (login, PR, PO... vẫn chạy bình thường).
let _mailTransporter;
let _mailInitTried = false;
function getMailTransporter() {
	if (_mailInitTried) { return _mailTransporter; }
	_mailInitTried = true;
	try {
		const nodemailer = require("nodemailer");
		_mailTransporter = nodemailer.createTransport({
			service: "gmail",
			auth: {
				user: process.env.EMAIL_USER,
				pass: process.env.EMAIL_PASS
			}
		});
	} catch (e) {
		console.error("⚠️ Khong khoi tao duoc nodemailer (tinh nang gui email se bi tat):", e.message);
		_mailTransporter = null;
	}
	return _mailTransporter;
}
module.exports = {
	getMailTransporter,
};
