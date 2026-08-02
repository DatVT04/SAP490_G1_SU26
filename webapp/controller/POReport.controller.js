sap.ui.define([
	"sap/ui/core/mvc/Controller",
	"sap/ui/model/json/JSONModel",
	"sap/ui/model/Filter",
	"sap/ui/model/FilterOperator",
	"sap/m/MessageToast",
	"com/qdavy/procurement/model/Config"
], function (Controller, JSONModel, Filter, FilterOperator, MessageToast, Config) {
	"use strict";

	var BACKEND = Config.BACKEND;

	return Controller.extend("com.qdavy.procurement.controller.POReport", {
		onInit: function () {
			var oModel = new JSONModel({
				poRecords: [],
				selectedPO: null,
				userRoleLabel: "Người đề nghị",
				kpi: {
					totalCount: 0,
					totalValueFormatted: "0",
					createdCount: 0,
					deliveredCount: 0
				}
			});
			this.getView().setModel(oModel, "reportModel");

			this._loadPODataFromSAP();

			this.getOwnerComponent().getRouter()
				.getRoute("poReport")
				.attachPatternMatched(this._onRouteMatched, this);
		},

		_onRouteMatched: function () {
			this._loadPODataFromSAP();
		},

		_loadPODataFromSAP: function () {
			var oView = this.getView();
			var oReportModel = oView.getModel("reportModel");
			var self = this;

			// Lấy email đăng nhập từ Session
			var sUserEmail = sessionStorage.getItem("userEmail") || "requester@qdavy.com";
			var sRoleLabel = "Người đề nghị";
			if (sUserEmail.indexOf("purchasing") !== -1) { sRoleLabel = "Bộ phận Mua Sắm"; }
			else if (sUserEmail.indexOf("cfo") !== -1) { sRoleLabel = "Giám Đốc Tài Chính (CFO)"; }
			else if (sUserEmail.indexOf("ceo") !== -1) { sRoleLabel = "Tổng Giám Đốc (CEO)"; }

			oReportModel.setProperty("/userRoleLabel", sRoleLabel);

			oView.setBusy(true);

			fetch(BACKEND + "/api/po/report?email=" + encodeURIComponent(sUserEmail))
				.then(function (r) { return r.json(); })
				.then(function (response) {
					oView.setBusy(false);

					if (response && response.success) {
						var aRawPoRecords = response.data || [];

						oReportModel.setProperty("/poRecords", aRawPoRecords);
						oReportModel.setProperty("/selectedPO", null);

						// Tính toán số liệu KPI Summary
						self._calculateKPIs(aRawPoRecords, oReportModel);
					} else {
						MessageToast.show("Không lấy được dữ liệu từ hệ thống SAP!");
					}
				})
				.catch(function (error) {
					oView.setBusy(false);
					MessageToast.show("Lỗi kết nối tới Server Backend!");
					console.error("Fetch Error: ", error);
				});
		},

		_calculateKPIs: function (aRecords, oModel) {
			var iTotal = aRecords.length;
			var iCreated = 0;
			var iDelivered = 0;
			var fTotalValue = 0;

			aRecords.forEach(function (rec) {
				var val = Number(rec.TotalValue) || 0;
				fTotalValue += val;

				if (rec.Status === "DELIVERED") {
					iDelivered++;
				} else {
					iCreated++;
				}
			});

			oModel.setProperty("/kpi/totalCount", iTotal);
			oModel.setProperty("/kpi/createdCount", iCreated);
			oModel.setProperty("/kpi/deliveredCount", iDelivered);
			oModel.setProperty("/kpi/totalValueFormatted", fTotalValue.toLocaleString("vi-VN"));
		},

		onPOSelect: function (oEvent) {
			var oContext = oEvent.getSource().getBindingContext("reportModel");
			if (!oContext) { return; }
			var oSelectedData = Object.assign({}, oContext.getObject());

			if (oSelectedData && oSelectedData.Status) {
				switch (oSelectedData.Status) {
					case "CREATED":
						oSelectedData.StepActive = 5;
						break;
					case "DELIVERED":
						oSelectedData.StepActive = 6;
						break;
					default:
						oSelectedData.StepActive = 1;
						break;
				}
			} else {
				oSelectedData.StepActive = 1;
			}

			this.getView().getModel("reportModel").setProperty("/selectedPO", oSelectedData);
		},

		onNavBack: function () {
			this.getOwnerComponent().getRouter().navTo("dashboard");
		},

		onFilterChange: function () {
			var sSearchQuery = this.getView().byId("filterSearch").getValue();
			var sStatusKey = this.getView().byId("filterStatus").getSelectedKey();
			var aFinalFilters = [];

			if (sSearchQuery && sSearchQuery.length > 0) {
				var oFilterPo = new Filter("PoNumber", FilterOperator.Contains, sSearchQuery);
				var oFilterVendor = new Filter("VendorName", FilterOperator.Contains, sSearchQuery);
				var oFilterReq = new Filter("RequesterEmail", FilterOperator.Contains, sSearchQuery);
				aFinalFilters.push(new Filter({ filters: [oFilterPo, oFilterVendor, oFilterReq], and: false }));
			}

			if (sStatusKey && sStatusKey !== "ALL") {
				aFinalFilters.push(new Filter("Status", FilterOperator.EQ, sStatusKey));
			}

			var oTable = this.getView().byId("reportTable");
			if (oTable && oTable.getBinding("items")) {
				oTable.getBinding("items").filter(aFinalFilters);
			}

			this.getView().getModel("reportModel").setProperty("/selectedPO", null);
		},

		onRefreshReport: function () {
			this.getView().byId("filterSearch").setValue("");
			this.getView().byId("filterStatus").setSelectedKey("ALL");
			this._loadPODataFromSAP();
			MessageToast.show("Đã cập nhật dữ liệu báo cáo thời gian thực!");
		},

		onExportExcel: function () {
			MessageToast.show("Tính năng trích xuất Excel đang xử lý...");
		}
	});
});