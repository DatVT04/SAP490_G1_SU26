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
		BACKEND: bIsLocal ? "http://localhost:3001" : ""
	};
});
