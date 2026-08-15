/**
 * Ban tin trong ung dung cho tung vai tro (CEO, Purchasing, CFO...).
 *
 * Tach ra tu server.js (ban goc 4520 dong) ngay 15/08/2026.
 * Noi dung ham giu nguyen 100%, chi them phan require/exports o dau va cuoi file.
 */


const { BRAND } = require("../../mail-assets");
const { htmlEscape } = require("../lib/html");
const { getMailTransporter } = require("../lib/mailer");
const { extractSapErrorMessage } = require("../lib/sap-client");
const { pushNotification } = require("../lib/store");
const { findEmailsByRole } = require("./employee.service");


function notifyRequester(record, message) {
	pushNotification(record.RequesterEmail, record.PRId, message);
}

async function notifyCeos(prId, message) {
	const emails = await findEmailsByRole("CEO");
	emails.forEach(function (email) {
		pushNotification(email, prId, message);
	});
}

async function notifyPurchasing(prId, message) {
	const emails = await findEmailsByRole("PURCHASING");
	emails.forEach(function (email) {
		pushNotification(email, prId, message);
	});
}

async function notifyCfo(prId, message) {
	const emails = await findEmailsByRole("CFO");
	emails.forEach(function (email) {
		pushNotification(email, prId, message);
	});
}

/**
 * Bao cho Purchasing biet vua co bao gia moi vao — day chinh la cau tra loi cho
 * "khong le cu ngoi cho mail?": he thong chu dong bao thay vi nguoi phai canh.
 * Gui ca 2 duong (email + thong bao trong app) vi notificationStore la file/RAM,
 * tren Vercel co the mat khi doi instance; con email thi chac chan toi noi.
 */
async function notifyPurchasingNewQuote(rfqId, prLabel, quotation) {
	const priceText = Number(quotation.QuotedPrice || 0).toLocaleString("vi-VN") + " " + (quotation.Currency || "VND");
	const vendorText = (quotation.VendorName || "") + " (" + quotation.VendorNo + ")";
	const message = "NCC " + vendorText + " vừa gửi báo giá " + priceText + " cho RFQ " + rfqId
		+ (prLabel ? " (PR " + prLabel + ")" : "") + " — vào RFQ-02 để so sánh và chốt.";

	let emails = [];
	try {
		emails = await findEmailsByRole("PURCHASING");
	} catch (error) {
		console.error("[notifyPurchasingNewQuote] Khong doc duoc email Purchasing:", extractSapErrorMessage(error));
	}
	emails.forEach(function (email) { pushNotification(email, prLabel || rfqId, message); });

	const transporter = getMailTransporter();
	if (!transporter || emails.length === 0) { return; }
	try {
		await transporter.sendMail({
			from: { name: "QDAVY Procurement", address: process.env.EMAIL_USER },
			to: emails.join(","),
			subject: "[Báo giá mới] " + rfqId + " — " + vendorText,
			text: message,
			html: '<p style="font-family:Arial,sans-serif;font-size:14px;color:' + BRAND.navy + '">' + htmlEscape(message) + '</p>'
		});
	} catch (mailError) {
		console.error("[notifyPurchasingNewQuote] Gui mail bao Purchasing that bai:", mailError.message);
	}
}
module.exports = {
	notifyCeos,
	notifyCfo,
	notifyPurchasing,
	notifyPurchasingNewQuote,
	notifyRequester,
};
