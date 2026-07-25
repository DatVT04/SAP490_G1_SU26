sap.ui.define([], function () {
	"use strict";

	/**
	 * BACKEND: base URL cho toàn bộ fetch() gọi Node.js API.
	 * - Khi chạy local (frontend localhost:8080 + backend localhost:3001, 2 port khac nhau,
	 *   2 origin khac nhau) -> phai goi tuyet doi "http://localhost:3001".
	 * - Khi deploy (VD Vercel) -> de trong "" de goi tuong doi "/api/..." cung origin voi
	 *   frontend, gia dinh backend duoc deploy chung domain qua vercel.json rewrites.
	 *   Neu backend deploy o domain rieng, doi dong duoi thanh URL that (VD "https://ten-app.vercel.app").
	 */
	var sHostname = window.location.hostname;
	var bIsLocal = sHostname === "localhost" || sHostname === "127.0.0.1";

	return {
		BACKEND: bIsLocal ? "http://localhost:3001" : "",

		/**
		 * Ghep Ho + Ten theo dung thu tu tieng Viet (Ho truoc, Ten/Ten dem sau).
		 * Khong dung truc tiep FullName tra ve tu SAP vi ben ABAP dang ghep theo
		 * thu tu Vorna+Nachn (kieu phuong Tay: Ten truoc, Ho sau) -> sai chieu hien thi.
		 * Sua o day (FE) thay vi sua ABAP theo yeu cau.
		 */
		buildFullName: function (sLastName, sFirstName, sFallback) {
			var sLast = (sLastName || "").trim();
			var sFirst = (sFirstName || "").trim();
			if (sLast || sFirst) {
				return (sLast + " " + sFirst).trim();
			}
			return sFallback || "";
		}
	};
});
