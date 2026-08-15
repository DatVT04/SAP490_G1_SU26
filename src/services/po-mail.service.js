/**
 * Gui email Purchase Order cho NCC.
 *
 * Tach ra tu server.js (ban goc 4520 dong) ngay 15/08/2026.
 * Noi dung ham giu nguyen 100%, chi them phan require/exports o dau va cuoi file.
 */


const { getMailTransporter } = require("../lib/mailer");


// gửi mail Vendor
async function sendPOEmailToVendor(vendorEmail, poNumber, data) {

	if (!vendorEmail) {
		return false;
	}

	const rows = (data.items || []).map(function (item) {
		return `
        <tr>
            <td>${item.materialNo || ""}</td>
            <td>${item.description || ""}</td>
            <td>${item.quantity || ""}</td>
            <td>${item.uom || ""}</td>
            <td>${Number(item.netPrice || 0).toLocaleString("vi-VN")}</td>
        </tr>`;
	}).join("");

	const html = `
        <h2>Purchase Order Notification</h2>

        <p>Dear Vendor,</p>

        <p>
            A new Purchase Order has been created.
        </p>

        <table border="1" cellpadding="6" cellspacing="0">
            <tr>
                <td><b>PO Number</b></td>
                <td>${poNumber}</td>
            </tr>

            <tr>
                <td><b>Company Code</b></td>
                <td>${data.companyCode}</td>
            </tr>

            <tr>
                <td><b>Document Date</b></td>
                <td>${data.docDate}</td>
            </tr>

            <tr>
                <td><b>Currency</b></td>
                <td>${data.currency}</td>
            </tr>
        </table>

        <br>

        <table border="1" cellpadding="6" cellspacing="0">
            <tr>
                <th>Material</th>
                <th>Description</th>
                <th>Quantity</th>
                <th>UoM</th>
                <th>Net Price</th>
            </tr>

            ${rows}

        </table>

        <br>

        <p>
            Please review the Purchase Order and prepare the requested goods.
        </p>

        <br>

        <p>Regards,</p>

        <p>Purchasing Department</p>
    `;

	const transporter = getMailTransporter();
	if (!transporter) {
		console.error("⚠️ Bo qua gui email PO (nodemailer khong san sang):", poNumber);
		return false;
	}

	try {
		await transporter.sendMail({

			from: process.env.EMAIL_USER,

			to: vendorEmail,

			subject: `Purchase Order ${poNumber}`,

			html

		});

		return true;
	} catch (e) {
		console.error("⚠️ Gui email PO that bai:", e.message);
		return false;
	}
}
module.exports = {
	sendPOEmailToVendor,
};
