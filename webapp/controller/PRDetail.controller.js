sap.ui.define([
	"sap/ui/core/mvc/Controller",
	"sap/ui/model/json/JSONModel",
	"sap/m/MessageBox",
	"com/qdavy/procurement/model/Config"
], function (Controller, JSONModel, MessageBox, Config) {
	"use strict";

	var BACKEND = Config.BACKEND;
	var REQUEST_TIMEOUT_MS = 15000;

	var STATUS_LABELS = {
		PENDING_CFO: "Đang chờ CFO duyệt",
		PENDING_CEO: "Đang chờ CEO duyệt (đã leo thang)",
		APPROVED: "Đã phê duyệt",
		REJECTED: "Đã từ chối"
	};

	var STATUS_STATES = {
		PENDING_CFO: "Warning",
		PENDING_CEO: "Warning",
		APPROVED: "Success",
		REJECTED: "Error"
	};

	return Controller.extend("com.qdavy.procurement.controller.PRDetail", {

		onInit: function () {
			this.getView().setModel(new JSONModel({}));

			this.getOwnerComponent().getRouter()
				.getRoute("prdetail")
				.attachPatternMatched(this._onRouteMatched, this);
		},

		_onRouteMatched: function (oEvent) {
			this._sPrId = oEvent.getParameter("arguments").prId;
			this._loadDetail();
		},

		onRefreshPress: function () {
			this._loadDetail();
		},

		_loadDetail: function () {
			var oView = this.getView();
			var oModel = oView.getModel();

			if (!this._sPrId) { return; }

			oView.setBusy(true);

			this._fetchWithTimeout(BACKEND + "/api/approval/" + encodeURIComponent(this._sPrId))
				.then(function (oResult) {
					oView.setBusy(false);
					if (!oResult || !oResult.success) {
						MessageBox.error((oResult && oResult.message) || "Không tải được chi tiết đề nghị mua sắm.");
						return;
					}
					oModel.setData(oResult.data || {});
				})
				.catch(function (oError) {
					oView.setBusy(false);
					MessageBox.error(oError.message);
				});
		},

		formatStatusText: function (sStatus) {
			return STATUS_LABELS[sStatus] || sStatus || "";
		},

		formatStatusState: function (sStatus) {
			return STATUS_STATES[sStatus] || "None";
		},

		formatValue: function (fValue, sCurrency) {
			if (fValue === undefined || fValue === null) { return ""; }
			return Number(fValue).toLocaleString("vi-VN") + " " + (sCurrency || "VND");
		},

		onNavBack: function () {
			// Quay lai PR02 neu la CFO/CEO, hoac Dashboard neu la nguoi tao PR
			var sRole = String(this.getOwnerComponent().getModel("user").getProperty("/role") || "").toUpperCase();
			if (sRole === "CFO" || sRole === "CEO") {
				this.getOwnerComponent().getRouter().navTo("pr02");
			} else {
				this.getOwnerComponent().getRouter().navTo("dashboard");
			}
		},

		_fetchWithTimeout: function (sUrl, oOptions) {
			var oAbort = (typeof AbortController !== "undefined") ? new AbortController() : null;
			var iTimer = oAbort ? setTimeout(function () { oAbort.abort(); }, REQUEST_TIMEOUT_MS) : null;

			var oFetchOptions = Object.assign({}, oOptions, {
				signal: oAbort ? oAbort.signal : undefined
			});

			return fetch(sUrl, oFetchOptions)
				.then(function (oResponse) {
					if (iTimer) { clearTimeout(iTimer); }
					return oResponse.json()
						.catch(function () { return {}; })
						.then(function (oBody) {
							if (oResponse.status === 401 || oResponse.status === 403) {
								throw new Error("Bạn không có quyền xem đề nghị này.");
							}
							if (oResponse.status === 404) {
								throw new Error("Không tìm thấy đề nghị mua sắm.");
							}
							if (oResponse.status >= 500) {
								throw new Error("Máy chủ đang gặp sự cố, vui lòng thử lại sau.");
							}
							return oBody;
						});
				})
				.catch(function (oError) {
					if (iTimer) { clearTimeout(iTimer); }
					if (oError && oError.name === "AbortError") {
						throw new Error("Server phản hồi quá lâu. Vui lòng thử lại.");
					}
					if (oError instanceof TypeError) {
						throw new Error("Không thể kết nối tới máy chủ.");
					}
					throw oError;
				});
		}
	});
});