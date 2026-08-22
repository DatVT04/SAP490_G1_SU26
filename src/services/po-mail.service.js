/**
 * Gui email Purchase Order cho NCC.
 *
 * Tach ra tu server.js (ban goc 4520 dong) ngay 15/08/2026.
 * 19/08/2026: viet lai phan dung HTML — ban cu la <h2> + <table border="1">
 * tran, hien ra trong Gmail nhu tai lieu Word photocopy, va cac o thieu du
 * lieu (dia chi giao hang, dieu khoan) van in ra o trong / chu "Khong neu".
 * Ban moi dung chung ngon ngu thiet ke voi email moi bao gia (rfq-mail.service):
 * logo dinh kem cid, khung 600px, bang header nen navy, kem ban plain-text.
 *
 * NGUYEN TAC: o nao khong co du lieu thi KHONG in ra dong trong — hoac an han,
 * hoac thay bang cau noi ro se xac nhan sau. Mail gui ra ngoai cong ty, mot o
 * trong doc nhu he thong loi.
 */


const { BRAND, QDAVY_LOGO_CID, qdavyLogoAttachment } = require("../../mail-assets");
const { describePaymentMethod, describePaymentTerms } = require("../config/payment-terms");
const { htmlEscape } = require("../lib/html");
const { getMailTransporter } = require("../lib/mailer");


/** "2026-08-21" hoac "20260821" -> "21/08/2026". Chuoi khac dinh dang giu nguyen. */
function formatDateVi(value) {
	const s = String(value || "").trim();
	if (!s) { return ""; }
	const digits = s.replace(/-/g, "");
	if (!/^\d{8}$/.test(digits)) { return s; }
	return digits.slice(6, 8) + "/" + digits.slice(4, 6) + "/" + digits.slice(0, 4);
}

function formatMoney(value) {
	return Number(value || 0).toLocaleString("vi-VN");
}

/**
 * Dung noi dung email PO. Tach rieng khoi ham gui de test duoc va de sau nay
 * dung lai cho ban PDF dinh kem neu can.
 */
function buildPoEmail(poNumber, data) {
	data = data || {};
	const items = Array.isArray(data.items) ? data.items : [];
	const currency = String(data.currency || "VND");
	const vendorName = String(data.vendorName || "").trim() || "Quý Nhà cung cấp";
	const buyerEmail = String(data.buyerEmail || process.env.EMAIL_USER || "").trim();

	const subject = "Đơn đặt hàng " + poNumber + " — QDAVY Global Group";

	// ── Tong tien: cong tu tung dong de con so trong mail luon khop bang ben tren ──
	const total = items.reduce(function (sum, it) {
		return sum + (Number(it.netPrice) || 0) * (Number(it.quantity) || 0);
	}, 0);

	const cellBase = 'padding:10px 8px;border-bottom:1px solid ' + BRAND.line + ';font-size:13px;';

	const itemRows = items.length
		? items.map(function (it, idx) {
			const qty = Number(it.quantity) || 0;
			const price = Number(it.netPrice) || 0;
			const maVt = it.materialNo
				? htmlEscape(it.materialNo)
				: '<span style="color:' + BRAND.slate + '">Hàng hóa/dịch vụ mô tả tự do</span>';
			return '<tr>'
				+ '<td style="' + cellBase + 'color:' + BRAND.slate + ';text-align:center">' + (idx + 1) + '</td>'
				+ '<td style="' + cellBase + 'color:' + BRAND.navy + '"><b>' + htmlEscape(it.description || "(không có mô tả)") + '</b><br>'
				+ '<span style="font-size:12px;color:' + BRAND.slate + '">' + maVt + '</span></td>'
				+ '<td style="' + cellBase + 'color:' + BRAND.navy + ';text-align:right;white-space:nowrap">'
				+ '<b>' + htmlEscape(formatMoney(qty)) + '</b> ' + htmlEscape(it.uom || "") + '</td>'
				+ '<td style="' + cellBase + 'color:' + BRAND.navy + ';text-align:right;white-space:nowrap">' + htmlEscape(formatMoney(price)) + '</td>'
				+ '<td style="' + cellBase + 'color:' + BRAND.navy + ';text-align:right;white-space:nowrap"><b>' + htmlEscape(formatMoney(qty * price)) + '</b></td>'
				+ '</tr>';
		}).join("")
		: '<tr><td colspan="5" style="' + cellBase + 'color:' + BRAND.slate + '">Chi tiết dòng hàng được gửi kèm trong tài liệu đính kèm.</td></tr>';

	const infoRow = function (label, value, strong) {
		return '<tr>'
			+ '<td style="padding:7px 0;font-size:13px;color:' + BRAND.slate + ';white-space:nowrap">' + label + '</td>'
			+ '<td style="padding:7px 0 7px 16px;font-size:14px;color:' + BRAND.navy + ';text-align:right">'
			+ (strong ? '<b>' + value + '</b>' : value) + '</td>'
			+ '</tr>';
	};

	// ── Khoi giao hang / thanh toan ──────────────────────────────────────
	// Chi in dong NAO CO du lieu. Truoc day in het, nen mail fallback (khi
	// store /tmp mat tren Vercel) hien 3 o trong lien nhau.
	const deliveryPairs = [
		["Địa chỉ giao hàng", data.deliveryAddress],
		["Người nhận hàng", [data.receiverName, data.receiverPhone].filter(Boolean).join(" — ")],
		["Ngày giao dự kiến", formatDateVi(data.deliveryDate)]
	].filter(function (p) { return String(p[1] || "").trim(); });

	const paymentPairs = [
		["Hình thức thanh toán", data.paymentMethod ? describePaymentMethod(data.paymentMethod) : ""],
		["Điều khoản thanh toán", data.paymentTerms ? describePaymentTerms(data.paymentTerms) : ""]
	].filter(function (p) { return String(p[1] || "").trim(); });

	const pairTable = function (title, pairs, emptyNote) {
		const body = pairs.length
			? pairs.map(function (p) {
				return '<tr>'
					+ '<td style="padding:9px 10px;border-bottom:1px solid ' + BRAND.line + ';font-size:13px;color:' + BRAND.slate + ';white-space:nowrap">' + htmlEscape(p[0]) + '</td>'
					+ '<td style="padding:9px 10px;border-bottom:1px solid ' + BRAND.line + ';font-size:14px;color:' + BRAND.navy + '"><b>' + htmlEscape(p[1]) + '</b></td>'
					+ '</tr>';
			}).join("")
			: '<tr><td style="padding:9px 10px;border-bottom:1px solid ' + BRAND.line + ';font-size:13px;color:' + BRAND.slate + '" colspan="2">' + htmlEscape(emptyNote) + '</td></tr>';
		return '<tr><td style="padding:24px 32px 0">'
			+ '<div style="font-size:13px;font-weight:700;color:' + BRAND.navy + ';padding-bottom:8px">' + title + '</div>'
			+ '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;border-top:2px solid ' + BRAND.line + '">'
			+ body
			+ '</table>'
			+ '</td></tr>';
	};

	const html = '<!DOCTYPE html>'
		+ '<html lang="vi"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>' + htmlEscape(subject) + '</title></head>'
		+ '<body style="margin:0;padding:0;background:' + BRAND.bg + ';">'
		+ '<div style="display:none;max-height:0;overflow:hidden;opacity:0">'
		+ 'Đơn đặt hàng ' + htmlEscape(poNumber) + ' trị giá ' + htmlEscape(formatMoney(total)) + ' ' + htmlEscape(currency) + '. Vui lòng xác nhận trong 24 giờ.'
		+ '</div>'
		+ '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:' + BRAND.bg + ';padding:24px 12px;font-family:-apple-system,BlinkMacSystemFont,\'Segoe UI\',Roboto,Arial,sans-serif">'
		+ '<tr><td align="center">'
		+ '<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:600px;max-width:100%;background:#ffffff;border-radius:14px;overflow:hidden;box-shadow:0 2px 14px rgba(11,31,63,.08)">'

		// Header
		+ '<tr><td align="center" style="padding:26px 24px 18px">'
		+ '<img src="cid:' + QDAVY_LOGO_CID + '" width="150" alt="QDAVY Global Group" style="display:block;border:0;width:150px;height:auto">'
		+ '</td></tr>'
		+ '<tr><td style="height:4px;background:linear-gradient(90deg,' + BRAND.blueDark + ' 0%,' + BRAND.blue + ' 100%);background-color:' + BRAND.blue + ';font-size:0;line-height:0">&nbsp;</td></tr>'

		// Tieu de
		+ '<tr><td style="padding:26px 32px 6px">'
		+ '<div style="font-size:11px;letter-spacing:2px;color:' + BRAND.slate + ';text-transform:uppercase">Đơn đặt hàng &middot; Purchase Order</div>'
		+ '<div style="font-size:26px;font-weight:700;color:' + BRAND.navy + ';padding-top:4px">' + htmlEscape(poNumber) + '</div>'
		+ '</td></tr>'

		// Loi chao
		+ '<tr><td style="padding:14px 32px 0;font-size:14px;line-height:1.65;color:' + BRAND.navy + '">'
		+ '<p style="margin:0 0 10px">Kính gửi <b>' + htmlEscape(vendorName) + '</b>,</p>'
		+ '<p style="margin:0">Công ty QDAVY Global Group xác nhận đặt hàng theo báo giá đã thống nhất. Chi tiết đơn hàng như sau.</p>'
		+ '</td></tr>'

		// The thong tin
		+ '<tr><td style="padding:18px 32px 0">'
		+ '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:' + BRAND.bg + ';border-radius:10px">'
		+ '<tr><td style="padding:10px 16px">'
		+ '<table role="presentation" width="100%" cellpadding="0" cellspacing="0">'
		+ infoRow('Số đơn hàng', htmlEscape(poNumber), true)
		+ (data.prNumber ? infoRow('Mã đề nghị mua sắm', htmlEscape(String(data.prNumber))) : '')
		+ (formatDateVi(data.docDate) ? infoRow('Ngày chứng từ', htmlEscape(formatDateVi(data.docDate))) : '')
		+ infoRow('Tổng giá trị', '<span style="color:' + BRAND.blueDark + '">' + htmlEscape(formatMoney(total)) + ' ' + htmlEscape(currency) + '</span>', true)
		+ '</table>'
		+ '</td></tr></table>'
		+ '</td></tr>'

		// Bang dong hang
		+ '<tr><td style="padding:24px 32px 0">'
		+ '<div style="font-size:13px;font-weight:700;color:' + BRAND.navy + ';padding-bottom:8px">NỘI DUNG ĐƠN HÀNG</div>'
		+ '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse">'
		+ '<tr style="background:' + BRAND.navy + '">'
		+ '<th style="padding:9px 8px;font-size:11px;letter-spacing:.6px;color:#fff;text-align:center;width:30px">#</th>'
		+ '<th style="padding:9px 8px;font-size:11px;letter-spacing:.6px;color:#fff;text-align:left">HÀNG HÓA / DỊCH VỤ</th>'
		+ '<th style="padding:9px 8px;font-size:11px;letter-spacing:.6px;color:#fff;text-align:right;white-space:nowrap">SỐ LƯỢNG</th>'
		+ '<th style="padding:9px 8px;font-size:11px;letter-spacing:.6px;color:#fff;text-align:right;white-space:nowrap">ĐƠN GIÁ</th>'
		+ '<th style="padding:9px 8px;font-size:11px;letter-spacing:.6px;color:#fff;text-align:right;white-space:nowrap">THÀNH TIỀN</th>'
		+ '</tr>'
		+ itemRows
		+ '<tr>'
		+ '<td colspan="4" style="padding:12px 8px;font-size:13px;color:' + BRAND.navy + ';text-align:right"><b>TỔNG CỘNG (' + htmlEscape(currency) + ')</b></td>'
		+ '<td style="padding:12px 8px;font-size:15px;color:' + BRAND.blueDark + ';text-align:right;white-space:nowrap"><b>' + htmlEscape(formatMoney(total)) + '</b></td>'
		+ '</tr>'
		+ '</table>'
		+ '<div style="font-size:11px;color:' + BRAND.slate + ';padding-top:8px;line-height:1.6">Giá trên là giá đã thống nhất trong báo giá của Quý công ty.</div>'
		+ '</td></tr>'

		+ pairTable('GIAO HÀNG', deliveryPairs, 'Địa chỉ và thời gian giao hàng sẽ được đầu mối mua sắm xác nhận lại trước khi giao.')
		+ pairTable('THANH TOÁN', paymentPairs, 'Thanh toán theo điều khoản đã thống nhất trong báo giá.')

		// Viec can lam
		+ '<tr><td style="padding:26px 32px 0">'
		+ '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid ' + BRAND.line + ';border-radius:12px">'
		+ '<tr><td style="padding:18px 20px">'
		+ '<div style="font-size:14px;font-weight:700;color:' + BRAND.navy + '">Vui lòng xác nhận đơn hàng</div>'
		+ '<div style="font-size:13px;color:' + BRAND.slate + ';padding-top:6px;line-height:1.7">'
		+ 'Trả lời thư này trong <b>24 giờ</b> để xác nhận Quý công ty đã nhận đơn hàng và cam kết ngày giao. '
		+ 'Nếu có bất kỳ sai lệch nào về số lượng, đơn giá hoặc điều khoản so với báo giá, xin phản hồi ngay trước khi giao hàng.'
		+ '</div>'
		+ '</td></tr></table>'
		+ '</td></tr>'

		// Ket
		+ '<tr><td style="padding:22px 32px 0;font-size:14px;line-height:1.65;color:' + BRAND.navy + '">'
		+ '<p style="margin:0">Trân trọng cảm ơn,<br><b>Phòng Mua sắm — QDAVY Global Group</b>'
		+ (String(data.buyerName || "").trim()
			? '<br><span style="font-size:13px;color:' + BRAND.slate + '">Đầu mối: ' + htmlEscape(data.buyerName)
				+ (String(data.buyerPhone || "").trim() ? ' — ' + htmlEscape(data.buyerPhone) : '') + '</span>'
			: '')
		+ '</p>'
		+ '</td></tr>'

		// Footer
		+ '<tr><td style="padding:24px 32px 28px">'
		+ '<div style="border-top:1px solid ' + BRAND.line + ';padding-top:14px;font-size:11px;line-height:1.7;color:' + BRAND.slate + '">'
		+ 'Thư này được gửi tự động từ Hệ thống Mua sắm QDAVY sau khi đơn hàng được phê duyệt nội bộ. '
		+ (buyerEmail ? 'Mọi thắc mắc xin liên hệ Phòng Mua sắm qua địa chỉ ' + htmlEscape(buyerEmail) + '.' : '')
		+ '</div>'
		+ '</td></tr>'

		+ '</table>'
		+ '</td></tr></table></body></html>';

	// ── Ban plain-text (bat buoc: mail chi co HTML bi cham diem spam cao hon) ──
	const textItems = items.length
		? items.map(function (it, idx) {
			const qty = Number(it.quantity) || 0;
			const price = Number(it.netPrice) || 0;
			return "  " + (idx + 1) + ". " + (it.description || "(không có mô tả)")
				+ (it.materialNo ? " [" + it.materialNo + "]" : "")
				+ " — SL: " + formatMoney(qty) + " " + (it.uom || "")
				+ " — Đơn giá: " + formatMoney(price)
				+ " — Thành tiền: " + formatMoney(qty * price);
		}).join("\n")
		: "  (Chi tiết dòng hàng gửi kèm riêng)";

	const text = [
		"ĐƠN ĐẶT HÀNG " + poNumber,
		"",
		"Kính gửi " + vendorName + ",",
		"",
		"QDAVY Global Group xác nhận đặt hàng theo báo giá đã thống nhất.",
		"",
		"Số đơn hàng: " + poNumber,
		data.prNumber ? "Mã đề nghị mua sắm: " + data.prNumber : null,
		formatDateVi(data.docDate) ? "Ngày chứng từ: " + formatDateVi(data.docDate) : null,
		"Tổng giá trị: " + formatMoney(total) + " " + currency,
		"",
		"NỘI DUNG ĐƠN HÀNG:",
		textItems,
		"",
		deliveryPairs.length
			? "GIAO HÀNG:\n" + deliveryPairs.map(function (p) { return "  • " + p[0] + ": " + p[1]; }).join("\n")
			: "GIAO HÀNG: đầu mối mua sắm sẽ xác nhận lại trước khi giao.",
		"",
		paymentPairs.length
			? "THANH TOÁN:\n" + paymentPairs.map(function (p) { return "  • " + p[0] + ": " + p[1]; }).join("\n")
			: "THANH TOÁN: theo điều khoản đã thống nhất trong báo giá.",
		"",
		"Vui lòng trả lời thư này trong 24 giờ để xác nhận đơn hàng và ngày giao.",
		"Nếu có sai lệch so với báo giá, xin phản hồi trước khi giao hàng.",
		"",
		"Trân trọng cảm ơn,",
		"Phòng Mua sắm — QDAVY Global Group"
		// Loc null (dong dieu kien khong co du lieu) chu KHONG loc "" — chuoi rong
		// la dong trong co chu y, loc mat thi ban text dinh lien mot khoi kho doc.
	].filter(function (line) { return line !== null; }).join("\n");

	return { subject: subject, html: html, text: text };
}

async function sendPOEmailToVendor(vendorEmail, poNumber, data) {
	if (!vendorEmail) {
		return false;
	}

	const transporter = getMailTransporter();
	if (!transporter) {
		console.error("Bo qua gui email PO (nodemailer khong san sang):", poNumber);
		return false;
	}

	const mail = buildPoEmail(String(poNumber || ""), data || {});

	try {
		await transporter.sendMail({
			// Ten hien thi that thay vi dia chi gmail tran — NCC nhan ra nguoi gui
			// va bo loc spam bot nghi ngo hon (cung ly do o email moi bao gia).
			from: { name: "QDAVY Global Group — Phòng Mua sắm", address: process.env.EMAIL_USER },
			to: vendorEmail,
			replyTo: (data && data.buyerEmail) || process.env.EMAIL_USER,
			subject: mail.subject,
			text: mail.text,
			html: mail.html,
			attachments: [qdavyLogoAttachment()],
			// Gom mail cua cung 1 don hang vao 1 luong hoi thoai ben phia NCC.
			references: "<po-" + String(poNumber || "").replace(/[^\w.-]/g, "") + "@qdavy.local>"
		});

		return true;
	} catch (e) {
		console.error("Gui email PO that bai:", e.message);
		return false;
	}
}
module.exports = {
	buildPoEmail,
	sendPOEmailToVendor,
};
