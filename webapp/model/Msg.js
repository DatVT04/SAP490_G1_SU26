sap.ui.define([
	"sap/m/MessageBox"
], function (MessageBox) {
	"use strict";

	// ════════════════════════════════════════════════════════════════════════
	// HIEN LOI CHO NGUOI DUNG — mot cho duy nhat cho ca he thong
	//
	// Van de truoc day: loi tu SAP/BAPI duoc noi thang vao hop thoai do, nen
	// nguoi mua hang doc duoc nhung dong nhu:
	//
	//   "Item 001 Order 600165 budget exceeded; No instance of object type
	//    PurchaseRequisition has been created. External reference: # 1"
	//
	// Do la thong diep danh cho lap trinh vien, khong phai cho nguoi dung. Ho
	// khong biet phai lam gi tiep, va nhin vao chi thay "he thong hong".
	//
	// Cach lam theo SAP Fiori: hop thoai chi hien MOT cau ngan noi ro chuyen
	// gi da xay ra va NGUOI DUNG PHAI LAM GI. Nguyen van loi ky thuat nam
	// trong muc "Xem chi tiet" — nguoi dung binh thuong khong phai doc, con
	// khi bao loi thi chup man hinh ra la co du thong tin de tra.
	// ════════════════════════════════════════════════════════════════════════

	// Dau hieu nhan biet mot chuoi la loi KY THUAT chu khong phai cau danh cho
	// nguoi dung. Backend cua nhom co nhieu route tra thang message cua SAP;
	// gap cac mau nay thi day xuong phan chi tiet thay vi hien len tieu de.
	var RX_TECHNICAL = new RegExp([
		"no instance of object type",
		"budget exceeded",
		"an exception was raised",
		"external reference",
		"http\\s*\\d{3}",
		"\\bbapi",
		"sy-subrc",
		"/iwbep",
		"/iwfnd",
		"gateway",
		"internal server error",
		"<html",
		"undefined",
		"null pointer",
		"\\bexception\\b"
	].join("|"), "i");

	function textOf(x) {
		return String(x === null || x === undefined ? "" : x).trim();
	}

	/**
	 * Gom moi thu co the la thong tin ky thuat: message cua SAP, danh sach
	 * errordetails, ma HTTP. Tra ve chuoi de dat vao muc "Xem chi tiet".
	 */
	function technicalOf(oResult, sMaybeTechnicalMessage) {
		var aParts = [];
		var r = oResult || {};

		if (sMaybeTechnicalMessage) { aParts.push(sMaybeTechnicalMessage); }

		var sDetail = textOf(r.detail || r.sapErrorMessage);
		if (sDetail && aParts.indexOf(sDetail) === -1) { aParts.push(sDetail); }

		var aSap = r.sapErrorDetails || [];
		if (aSap.length) {
			aParts.push(aSap.map(function (d) {
				return "• [" + (d.severity || "?") + "] " + textOf(d.message)
					+ (d.code ? "  (" + d.code + ")" : "");
			}).join("\n"));
		}

		if (r.sapHttpStatus) { aParts.push("HTTP " + r.sapHttpStatus); }

		return aParts.filter(Boolean).join("\n\n");
	}

	return {

		/**
		 * Bao that bai mot thao tac.
		 *
		 * @param {object} oResult  Ket qua tra ve tu backend (hoac doi tuong
		 *                          Error). Doc cac truong: userMessage, kind,
		 *                          message, detail, sapErrorMessage,
		 *                          sapErrorDetails, sapHttpStatus.
		 * @param {object} mOptions
		 *        - fallback {string} BAT BUOC: cau tieng Viet mo ta viec gi
		 *          khong lam duoc va nguoi dung nen lam gi. Dung khi backend
		 *          khong tra ve cau nao doc duoc.
		 *        - title {string} Tieu de hop thoai.
		 */
		fail: function (oResult, mOptions) {
			var o = mOptions || {};
			var r = oResult || {};

			// 1) Backend noi ro day la cau danh cho nguoi dung -> uu tien dung.
			var sUser = textOf(r.userMessage);

			// 2) Chua co thi xet den message: chi dung lam tieu de neu no KHONG
			//    phai loi ky thuat va du ngan de doc.
			var sRaw = textOf(r.message);
			var bRawIsTechnical = !sRaw || sRaw.length > 220 || RX_TECHNICAL.test(sRaw);

			if (!sUser && !bRawIsTechnical) { sUser = sRaw; }

			var sText = sUser || textOf(o.fallback)
				|| "Không thực hiện được thao tác. Vui lòng thử lại.";

			var sTech = technicalOf(r, bRawIsTechnical ? sRaw : "");

			var mBox = { title: textOf(o.title) || "Không thực hiện được" };
			if (sTech) { mBox.details = sTech; }

			// Vuot ngan sach KHONG phai su co he thong — do la kiem soat cua
			// SAP dang lam dung viec. Hien mau canh bao (vang) thay vi loi (do)
			// de nguoi duyet hieu la "he thong chan co ly do", khong phai "hong".
			if (String(r.kind || "").toUpperCase() === "BUDGET_EXCEEDED" || r.budgetBlocked) {
				MessageBox.warning(sText, mBox);
			} else {
				MessageBox.error(sText, mBox);
			}
		},

		/**
		 * Bao that bai khi khong goi duoc backend (mat mang, server chet).
		 * Khong co gi de hien chi tiet ngoai message cua trinh duyet.
		 */
		offline: function (oError, sWhat) {
			var sTech = textOf(oError && oError.message);
			var mBox = { title: "Không kết nối được máy chủ" };
			if (sTech) { mBox.details = sTech; }
			MessageBox.error(
				"Không thể kết nối tới máy chủ nên chưa " + (sWhat || "thực hiện được thao tác")
				+ ". Vui lòng kiểm tra kết nối mạng rồi thử lại.",
				mBox
			);
		}
	};
});
