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
			// 1. Khởi tạo JSONModel rỗng cho báo cáo
			var oModel = new JSONModel({
				poRecords: [],
				selectedPO: null
			});
			this.getView().setModel(oModel, "reportModel");

			// 2. Tải dữ liệu lần đầu
			this._loadPODataFromSAP();

			// 3. Đăng ký tự động tải lại khi điều hướng lại màn hình này
			this.getOwnerComponent().getRouter()
				.getRoute("poReport")
				.attachPatternMatched(this._onRouteMatched, this);
		},

		_onRouteMatched: function () {
			this._loadPODataFromSAP();
		},

		/**
		 * 🚀 HÀM ĐỌC DỮ LIỆU: Dùng fetch() đồng bộ chuẩn với Config.BACKEND
		 */
		_loadPODataFromSAP: function () {
			var oView = this.getView();
			var oReportModel = oView.getModel("reportModel");

			oView.setBusy(true);

			fetch(BACKEND + "/api/po/report")
				.then(function (r) { return r.json(); })
				.then(function (response) {
					oView.setBusy(false);

					if (response && response.success) {
						var aRawPoRecords = response.data || [];

						aRawPoRecords = aRawPoRecords.map(function (record) {
							record.DeliveryRate = record.Status === "CREATED" ? 100 : 0;
							return record;
						});

						oReportModel.setProperty("/poRecords", aRawPoRecords);
						oReportModel.setProperty("/selectedPO", null);
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

		/**
		 * 🎯 HÀM CLICK CHỌN DÒNG
		 */
		onPOSelect: function (oEvent) {
			var oContext = oEvent.getSource().getBindingContext("reportModel");
			if (!oContext) { return; }
			var oSelectedData = Object.assign({}, oContext.getObject());

			if (oSelectedData && oSelectedData.Status) {
				switch (oSelectedData.Status) {
					case "CREATED":
						oSelectedData.StepActive = 5; // Bước 5: Đã tạo PO sang SAP
						break;
					case "DELIVERED":
						oSelectedData.StepActive = 6; // Bước 6: Nhập kho hoàn tất
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

		/**
		 * 🔍 Tìm kiếm & Lọc nhanh trên giao diện bảng
		 */
		onFilterChange: function () {
			var sSearchQuery = this.getView().byId("filterSearch").getValue();
			var sStatusKey = this.getView().byId("filterStatus").getSelectedKey();
			var aFinalFilters = [];

			if (sSearchQuery && sSearchQuery.length > 0) {
				var oFilterPo = new Filter("PoNumber", FilterOperator.Contains, sSearchQuery);
				var oFilterVendor = new Filter("VendorName", FilterOperator.Contains, sSearchQuery);
				aFinalFilters.push(new Filter({ filters: [oFilterPo, oFilterVendor], and: false }));
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
			MessageToast.show("Đã cập nhật dữ liệu báo cáo thời gian thực từ SAP!");
		}
	});
});