/**
 * Gui email Purchase Order cho NCC.
 *
 * Tach ra tu server.js (ban goc 4520 dong) ngay 15/08/2026.
 * Noi dung ham giu nguyen 100%, chi them phan require/exports o dau va cuoi file.
 */


const { describePaymentMethod, describePaymentTerms } = require("../config/payment-terms");
const { getMailTransporter } = require("../lib/mailer");


// gửi mail Vendor
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
            A new Purchase Order has been created by QDAVY.
        </p>

        <table border="1" cellpadding="6" cellspacing="0">
            <tr>
                <td><b>PO Number</b></td>
                <td>${poNumber}</td>
            </tr>

            <tr>
                <td><b>Document Date</b></td>
                <td>${data.docDate}</td>
            </tr>

            <tr>
                <td><b>Currency</b></td>
                <td>${data.currency}</td>
            </tr>

            <tr>
                <td><b>Buyer Contact</b></td>
                <td>${data.buyerName || ""}${data.buyerPhone ? " — " + data.buyerPhone : ""}</td>
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

        <h3>Delivery / Ship-To</h3>
        <table border="1" cellpadding="6" cellspacing="0">
            <tr>
                <td><b>Delivery Address</b></td>
                <td>${data.deliveryAddress || ""}</td>
            </tr>

            <tr>
                <td><b>Goods Recipient</b></td>
                <td>${data.receiverName || ""}${data.receiverPhone ? " — " + data.receiverPhone : ""}</td>
            </tr>

            <tr>
                <td><b>Requested Delivery Date</b></td>
                <td>${data.deliveryDate || ""}</td>
            </tr>
        </table>

        <br>

        <h3>Payment</h3>
        <table border="1" cellpadding="6" cellspacing="0">
            <tr>
                <td><b>Payment Method</b></td>
                <td>${describePaymentMethod(data.paymentMethod)}</td>
            </tr>

            <tr>
                <td><b>Payment Terms</b></td>
                <td>${describePaymentTerms(data.paymentTerms)}</td>
            </tr>
        </table>

        <br>

        <p>
            Please review the Purchase Order and proceed with the requested goods/services according to the details above.
			If you have any questions, please contact the buyer.
        </p>

        <br>

        <p>Regards,</p>

        <p>Purchasing Department</p>
		 <p>QDAVY</p>
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
