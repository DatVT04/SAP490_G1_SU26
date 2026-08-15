/**
 * Dung va gui email moi/nhac bao gia cho NCC.
 *
 * Tach ra tu server.js (ban goc 4520 dong) ngay 15/08/2026.
 * Noi dung ham giu nguyen 100%, chi them phan require/exports o dau va cuoi file.
 */


const { BRAND, QDAVY_LOGO_CID, qdavyLogoAttachment } = require("../../mail-assets");
const { PAYMENT_TERMS } = require("../config/payment-terms");
const { daysUntilDeadline, formatDeadlineVi, htmlEscape } = require("../lib/html");
const { getMailTransporter } = require("../lib/mailer");
const { rfqQuoteLink } = require("./rfq-portal.service");


/**
 * Dung noi dung email moi bao gia.
 *
 * Nguyen tac noi dung:
 *  - KHONG gui gia tri uoc tinh cua PR cho NCC (EstimatedValue). Do la ngan
 *    sach noi bo; lo ra thi bao gia nao cung se bam sat con so do.
 *  - Liet ke du dung cac truong ma man RFQ-02 bat NHAP, de neu NCC tra loi
 *    bang email thuong thi trong mail cung co san moi thu, khong phai hoi lai.
 *  - Luon co ban plain-text (`text`): mail chi co HTML bi cham diem spam cao
 *    hon han, va mot so he thong mua hang cua NCC doc plain-text.
 */
function buildRfqEmail(opts) {
	const isReminder = !!opts.isReminder;
	const rfqId = String(opts.rfqId || "");
	const vendorName = String(opts.vendorName || opts.vendorNo || "Quý Nhà cung cấp");
	const prLabel = String(opts.prLabel || "");
	const deadlineVi = opts.deadline ? formatDeadlineVi(opts.deadline) : "";
	const daysLeft = opts.deadline ? daysUntilDeadline(opts.deadline) : null;
	const items = Array.isArray(opts.items) ? opts.items : [];
	const quoteLink = String(opts.quoteLink || "");
	const buyerEmail = String(opts.buyerEmail || process.env.EMAIL_USER || "");

	const subject = (isReminder ? "[Nhắc lần " + (opts.reminderCount || 1) + "] " : "")
		+ "Mời báo giá " + rfqId
		+ (deadlineVi ? " — hạn nộp " + deadlineVi : "");

	const deadlineNote = deadlineVi
		? (daysLeft != null && daysLeft < 0
			? "Đã quá hạn " + Math.abs(daysLeft) + " ngày"
			: (daysLeft != null ? "Còn " + daysLeft + " ngày" : ""))
		: "";

	// ── Bang vat tu can bao gia ──────────────────────────────────────────
	const itemRows = items.length
		? items.map(function (it, idx) {
			const maNvl = it.MaterialNo
				? htmlEscape(it.MaterialNo)
				: '<span style="color:' + BRAND.slate + '">Hàng/dịch vụ mô tả tự do</span>';
			return '<tr>'
				+ '<td style="padding:10px 8px;border-bottom:1px solid ' + BRAND.line + ';color:' + BRAND.slate + ';font-size:13px;text-align:center">' + (idx + 1) + '</td>'
				+ '<td style="padding:10px 8px;border-bottom:1px solid ' + BRAND.line + ';font-size:14px;color:' + BRAND.navy + '"><b>' + htmlEscape(it.Description || "(không có mô tả)") + '</b><br><span style="font-size:12px;color:' + BRAND.slate + '">' + maNvl + '</span></td>'
				+ '<td style="padding:10px 8px;border-bottom:1px solid ' + BRAND.line + ';font-size:14px;color:' + BRAND.navy + ';text-align:right;white-space:nowrap"><b>' + htmlEscape(Number(it.Quantity || 0).toLocaleString("vi-VN")) + '</b> ' + htmlEscape(it.UoM || "") + '</td>'
				+ '</tr>';
		}).join("")
		: '<tr><td colspan="3" style="padding:14px 8px;color:' + BRAND.slate + ';font-size:13px">Chi tiết hàng hoá/dịch vụ sẽ được gửi trong thư trả lời. Vui lòng liên hệ đầu mối bên dưới.</td></tr>';

	// ── Bang cac truong bat buoc trong bao gia ───────────────────────────
	const fieldRows = [
		["Tổng giá báo (VND, đã gồm VAT)", "Bắt buộc. Ghi rõ đơn giá từng dòng nếu có nhiều dòng."],
		["Thời gian giao hàng (số ngày)", "Tính từ ngày ký hợp đồng/nhận PO. Ghi 0 nếu giao ngay."],
		["Điều khoản thanh toán", PAYMENT_TERMS.map(function (t) { return t.label; }).join(" · ")],
		["Thời gian bảo hành (số tháng)", "Ghi 0 nếu hàng hoá/dịch vụ không có bảo hành."],
		["Hồ sơ pháp lý", "Giấy phép kinh doanh, mã số thuế, chứng nhận/uỷ quyền phân phối (nếu có)."]
	].map(function (row) {
		return '<tr>'
			+ '<td style="padding:9px 10px;border-bottom:1px solid ' + BRAND.line + ';font-size:13px;color:' + BRAND.navy + ';white-space:nowrap"><b>' + row[0] + '</b></td>'
			+ '<td style="padding:9px 10px;border-bottom:1px solid ' + BRAND.line + ';font-size:13px;color:' + BRAND.slate + '">' + row[1] + '</td>'
			+ '</tr>';
	}).join("");

	const infoRow = function (label, value, strong) {
		return '<tr>'
			+ '<td style="padding:7px 0;font-size:13px;color:' + BRAND.slate + ';white-space:nowrap">' + label + '</td>'
			+ '<td style="padding:7px 0 7px 16px;font-size:14px;color:' + BRAND.navy + ';text-align:right">' + (strong ? '<b>' + value + '</b>' : value) + '</td>'
			+ '</tr>';
	};

	const html = '<!DOCTYPE html>'
+ '<html lang="vi"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>' + htmlEscape(subject) + '</title></head>'
+ '<body style="margin:0;padding:0;background:' + BRAND.bg + ';">'
+ '<div style="display:none;max-height:0;overflow:hidden;opacity:0">'
	+ 'Mời báo giá ' + htmlEscape(rfqId) + (deadlineVi ? ' — hạn nộp ' + deadlineVi : '') + '. Quý vị có thể gửi báo giá trực tuyến chỉ trong 1 phút.'
+ '</div>'
+ '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:' + BRAND.bg + ';padding:24px 12px;font-family:-apple-system,BlinkMacSystemFont,\'Segoe UI\',Roboto,Arial,sans-serif">'
+ '<tr><td align="center">'
+ '<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:600px;max-width:100%;background:#ffffff;border-radius:14px;overflow:hidden;box-shadow:0 2px 14px rgba(11,31,63,.08)">'

	// Header: logo tren nen trang + thanh gradient
+ '<tr><td align="center" style="padding:26px 24px 18px">'
	+ '<img src="cid:' + QDAVY_LOGO_CID + '" width="150" alt="QDAVY Global Group" style="display:block;border:0;width:150px;height:auto">'
+ '</td></tr>'
+ '<tr><td style="height:4px;background:linear-gradient(90deg,' + BRAND.blueDark + ' 0%,' + BRAND.blue + ' 100%);background-color:' + BRAND.blue + ';font-size:0;line-height:0">&nbsp;</td></tr>'

	// Tieu de
+ '<tr><td style="padding:26px 32px 6px">'
	+ '<div style="font-size:11px;letter-spacing:2px;color:' + BRAND.slate + ';text-transform:uppercase">'
		+ (isReminder ? 'Thư nhắc · Reminder' : 'Thư mời báo giá · Request for Quotation')
	+ '</div>'
	+ '<div style="font-size:26px;font-weight:700;color:' + BRAND.navy + ';padding-top:4px">' + htmlEscape(rfqId) + '</div>'
+ '</td></tr>'

	// Loi chao
+ '<tr><td style="padding:14px 32px 0;font-size:14px;line-height:1.65;color:' + BRAND.navy + '">'
	+ '<p style="margin:0 0 10px">Kính gửi <b>' + htmlEscape(vendorName) + '</b>,</p>'
	+ '<p style="margin:0">'
		+ (isReminder
			? 'Chúng tôi đã gửi thư mời báo giá cho yêu cầu mua sắm dưới đây nhưng chưa nhận được phản hồi của Quý công ty. Rất mong Quý công ty dành ít phút gửi báo giá trước hạn.'
			: 'Công ty QDAVY Global Group trân trọng kính mời Quý công ty gửi báo giá cho yêu cầu mua sắm dưới đây.')
	+ '</p>'
+ '</td></tr>'

	// The thong tin
+ '<tr><td style="padding:18px 32px 0">'
	+ '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:' + BRAND.bg + ';border-radius:10px;padding:6px 16px">'
	+ '<tr><td style="padding:10px 16px">'
		+ '<table role="presentation" width="100%" cellpadding="0" cellspacing="0">'
		+ infoRow('Mã yêu cầu báo giá', htmlEscape(rfqId), true)
		+ (prLabel ? infoRow('Mã đề nghị mua hàng', htmlEscape(prLabel)) : '')
		+ (deadlineVi
			? infoRow('Hạn nộp báo giá',
				'<span style="color:' + (daysLeft != null && daysLeft < 0 ? '#C0392B' : BRAND.navy) + '">' + deadlineVi + '</span>'
				+ (deadlineNote ? ' <span style="font-size:12px;color:' + BRAND.slate + '">(' + deadlineNote + ')</span>' : ''), true)
			: '')
		+ infoRow('Đầu mối liên hệ', '<a href="mailto:' + htmlEscape(buyerEmail) + '" style="color:' + BRAND.blueDark + ';text-decoration:none">' + htmlEscape(buyerEmail) + '</a>')
		+ '</table>'
	+ '</td></tr></table>'
+ '</td></tr>'

	// Bang vat tu
+ '<tr><td style="padding:24px 32px 0">'
	+ '<div style="font-size:13px;font-weight:700;color:' + BRAND.navy + ';padding-bottom:8px">NỘI DUNG CẦN BÁO GIÁ</div>'
	+ '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse">'
	+ '<tr style="background:' + BRAND.navy + '">'
		+ '<th style="padding:9px 8px;font-size:11px;letter-spacing:.6px;color:#fff;text-align:center;width:34px">#</th>'
		+ '<th style="padding:9px 8px;font-size:11px;letter-spacing:.6px;color:#fff;text-align:left">HÀNG HOÁ / DỊCH VỤ</th>'
		+ '<th style="padding:9px 8px;font-size:11px;letter-spacing:.6px;color:#fff;text-align:right;white-space:nowrap">SỐ LƯỢNG</th>'
	+ '</tr>'
	+ itemRows
	+ '</table>'
+ '</td></tr>'

	// CTA portal
+ (quoteLink
	? '<tr><td style="padding:26px 32px 0">'
		+ '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid ' + BRAND.line + ';border-radius:12px">'
		+ '<tr><td align="center" style="padding:22px 20px">'
			+ '<div style="font-size:15px;font-weight:700;color:' + BRAND.navy + '">Gửi báo giá trực tuyến — nhanh hơn trả lời email</div>'
			+ '<div style="font-size:13px;color:' + BRAND.slate + ';padding:6px 0 16px;line-height:1.6">Không cần tạo tài khoản. Link dưới đây dành riêng cho Quý công ty và chỉ dùng cho yêu cầu ' + htmlEscape(rfqId) + '.</div>'
			+ '<a href="' + htmlEscape(quoteLink) + '" style="display:inline-block;background:' + BRAND.blueDark + ';color:#ffffff;font-size:15px;font-weight:700;text-decoration:none;padding:14px 30px;border-radius:9px">Nhập báo giá ngay &rarr;</a>'
			+ '<div style="font-size:11px;color:' + BRAND.slate + ';padding-top:14px;word-break:break-all;line-height:1.5">Nếu nút trên không bấm được, sao chép đường dẫn sau vào trình duyệt:<br><span style="color:' + BRAND.blueDark + '">' + htmlEscape(quoteLink) + '</span></div>'
		+ '</td></tr></table>'
	+ '</td></tr>'
	: '')

	// Bang truong bat buoc
+ '<tr><td style="padding:26px 32px 0">'
	+ '<div style="font-size:13px;font-weight:700;color:' + BRAND.navy + '">NẾU QUÝ CÔNG TY TRẢ LỜI BẰNG EMAIL</div>'
	+ '<div style="font-size:13px;color:' + BRAND.slate + ';padding:6px 0 10px;line-height:1.6">Vui lòng nêu đủ các mục sau để chúng tôi đưa vào bảng so sánh; thiếu mục nào chúng tôi sẽ phải hỏi lại và báo giá bị chậm xét.</div>'
	+ '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;border-top:2px solid ' + BRAND.line + '">'
	+ fieldRows
	+ '</table>'
+ '</td></tr>'

	// Ket
+ '<tr><td style="padding:22px 32px 0;font-size:14px;line-height:1.65;color:' + BRAND.navy + '">'
	+ '<p style="margin:0 0 10px">Báo giá nộp sau hạn vẫn được ghi nhận nhưng có thể không kịp đưa vào vòng xét chọn.</p>'
	+ '<p style="margin:0">Trân trọng cảm ơn,<br><b>Phòng Thu mua — QDAVY Global Group</b></p>'
+ '</td></tr>'

	// Footer
+ '<tr><td style="padding:24px 32px 28px">'
	+ '<div style="border-top:1px solid ' + BRAND.line + ';padding-top:14px;font-size:11px;line-height:1.7;color:' + BRAND.slate + '">'
		+ 'Thư này được gửi tự động từ Hệ thống Mua sắm QDAVY. Nếu thư rơi vào mục Spam/Quảng cáo, vui lòng đánh dấu <b>&ldquo;Không phải spam&rdquo;</b> và thêm '
		+ htmlEscape(buyerEmail) + ' vào danh bạ để nhận được các yêu cầu sau.<br>'
		+ 'Mọi thắc mắc xin liên hệ Phòng Thu mua qua địa chỉ ' + htmlEscape(buyerEmail) + '.'
	+ '</div>'
+ '</td></tr>'

+ '</table>'
+ '</td></tr></table></body></html>';

	// ── Ban plain-text ───────────────────────────────────────────────────
	const textItems = items.length
		? items.map(function (it, idx) {
			return "  " + (idx + 1) + ". " + (it.Description || "(khong co mo ta)")
				+ (it.MaterialNo ? " [" + it.MaterialNo + "]" : "")
				+ " — SL: " + Number(it.Quantity || 0).toLocaleString("vi-VN") + " " + (it.UoM || "");
		}).join("\n")
		: "  (Chi tiet se duoc gui trong thu tra loi)";

	const text = [
		(isReminder ? "THU NHAC — " : "") + "THU MOI BAO GIA " + rfqId,
		"",
		"Kinh gui " + vendorName + ",",
		"",
		isReminder
			? "Chung toi chua nhan duoc bao gia cua Quy cong ty cho yeu cau duoi day."
			: "QDAVY Global Group tran trong kinh moi Quy cong ty gui bao gia cho yeu cau mua sam duoi day.",
		"",
		"Ma yeu cau bao gia: " + rfqId,
		prLabel ? "Ma de nghi mua hang: " + prLabel : "",
		deadlineVi ? "Han nop bao gia: " + deadlineVi + (deadlineNote ? " (" + deadlineNote + ")" : "") : "",
		"Dau moi lien he: " + buyerEmail,
		"",
		"NOI DUNG CAN BAO GIA:",
		textItems,
		"",
		quoteLink ? "GUI BAO GIA TRUC TUYEN (khong can tai khoan):" : "",
		quoteLink || "",
		"",
		"NEU TRA LOI BANG EMAIL, xin neu du cac muc sau:",
		"  - Tong gia bao (VND, da gom VAT)",
		"  - Thoi gian giao hang (so ngay)",
		"  - Dieu khoan thanh toan (" + PAYMENT_TERMS.map(function (t) { return t.label; }).join(" / ") + ")",
		"  - Thoi gian bao hanh (so thang)",
		"  - Ho so phap ly: giay phep kinh doanh, ma so thue, chung nhan/uy quyen phan phoi",
		"",
		"Tran trong cam on,",
		"Phong Thu mua — QDAVY Global Group"
	].filter(function (line) { return line !== ""; }).join("\n");

	return { subject: subject, html: html, text: text };
}

/**
 * Gui email moi bao gia cho 1 danh sach quotation (1 dong = 1 NCC).
 * Dung chung cho /api/rfq/:id/send (lan dau) va /api/rfq/:id/remind (nhac).
 * Tra ve { sent, skipped, failed } — KHONG nem loi de 1 NCC sai email khong
 * chan ca lo mail con lai.
 */
async function sendRfqInviteEmails(opts) {
	const transporter = getMailTransporter();
	const result = { sent: 0, skipped: 0, failed: 0, noEmailVendors: [] };
	if (!transporter) {
		console.error("[sendRfqInviteEmails] Bo qua gui email (nodemailer khong san sang):", opts.rfqId);
		result.skipped = (opts.quotations || []).length;
		return result;
	}

	for (const q of (opts.quotations || [])) {
		if (!q.VendorEmail) {
			result.skipped++;
			result.noEmailVendors.push(String(q.VendorName || q.VendorNo || ""));
			continue;
		}
		const mail = buildRfqEmail({
			rfqId: opts.rfqId,
			vendorName: q.VendorName || q.VendorNo,
			vendorNo: q.VendorNo,
			prLabel: opts.prLabel,
			deadline: opts.deadline,
			items: opts.items,
			quoteLink: rfqQuoteLink(opts.baseUrl, opts.rfqId, q.VendorNo),
			buyerEmail: opts.buyerEmail,
			isReminder: opts.isReminder,
			reminderCount: opts.reminderCount
		});
		try {
			await transporter.sendMail({
				// Ten hien thi that ("QDAVY..." thay vi dia chi gmail tran) giup NCC
				// nhan ra nguoi gui va giup bo loc spam bot nghi ngo hon.
				from: { name: "QDAVY Global Group — Phòng Thu mua", address: process.env.EMAIL_USER },
				to: q.VendorEmail,
				replyTo: opts.buyerEmail || process.env.EMAIL_USER,
				subject: mail.subject,
				text: mail.text,
				html: mail.html,
				attachments: [qdavyLogoAttachment()],
				// Gom cac mail cua cung 1 RFQ vao 1 luong hoi thoai ben phia NCC.
				references: "<rfq-" + opts.rfqId + "@qdavy.local>"
			});
			result.sent++;
		} catch (mailError) {
			result.failed++;
			console.error("[sendRfqInviteEmails] Gui mail that bai cho " + q.VendorEmail + ":", mailError.message);
		}
	}
	return result;
}
module.exports = {
	sendRfqInviteEmails,
};
