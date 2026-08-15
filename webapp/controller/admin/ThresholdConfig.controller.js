sap.ui.define([
	"sap/ui/core/mvc/Controller",
	"sap/ui/model/json/JSONModel",
	"sap/m/MessageBox",
	"sap/m/MessageToast",
	"com/qdavy/procurement/model/Config"
], function (Controller, JSONModel, MessageBox, MessageToast, Config) {
	"use strict";

	var BACKEND = Config.BACKEND;

	return Controller.extend("com.qdavy.procurement.controller.admin.ThresholdConfig", {

		onInit: function () {
			this.getView().setModel(new JSONModel({ rows: [] }), "thresholdModel");

			this.getOwnerComponent().getRouter()
				.getRoute("thresholdConfig")
				.attachPatternMatched(this._onRouteMatched, this);
		},

		_onRouteMatched: function () {
			var sRole = String(this.getOwnerComponent().getModel("user").getProperty("/role") || "").toUpperCase();
			if (sRole !== "CEO") {
				MessageBox.error("Chỉ CEO mới được cấu hình ngưỡng phê duyệt.");
				this.getOwnerComponent().getRouter().navTo("dashboard");
				return;
			}
			this._load();
		},

		onRefreshPress: function () {
			this._load();
		},

		/**
		 * Ghép 2 nguồn: danh sách Internal Order thật từ SAP (/api/internal-orders) và
		 * ngưỡng đang lưu (/api/thresholds). Phải lấy cả 2 vì thresholds chỉ chứa những IO
		 * đã từng đặt ngưỡng — muốn CEO đặt ngưỡng cho IO mới thì phải liệt kê đủ IO.
		 */
		_load: function () {
			var oView = this.getView();
			var oModel = oView.getModel("thresholdModel");
			oView.setBusy(true);

			Promise.all([
				fetch(BACKEND + "/api/internal-orders").then(function (r) { return r.json(); }),
				fetch(BACKEND + "/api/thresholds").then(function (r) { return r.json(); })
			])
				.then(function (aResults) {
					oView.setBusy(false);

					var oIoRes = aResults[0] || {};
					var oThRes = aResults[1] || {};

					if (!oIoRes.success) {
						MessageBox.error(oIoRes.message || "Không tải được danh sách Internal Order từ SAP.");
						return;
					}

					var oByIO = (oThRes && oThRes.byIO) || {};
					var aRows = (oIoRes.data || []).map(function (io) {
						var sIO = io.InternalOrder || "";
						return {
							internalOrder: sIO,
							description: io.Description || sIO,
							costCenter: io.CostCenter || "",
							// null (không phải 0) khi chưa đặt ngưỡng — 0 sẽ bị hiểu là
							// "ngưỡng bằng 0" nghĩa là mọi PR đều leo thang CEO.
							threshold: oByIO[sIO] != null ? Number(oByIO[sIO]) : null
						};
					});

					oModel.setProperty("/rows", aRows);
				})
				.catch(function () {
					oView.setBusy(false);
					MessageBox.error("Không thể kết nối tới máy chủ.");
				});
		},

		onClearRow: function (oEvent) {
			var oCtx = oEvent.getSource().getBindingContext("thresholdModel");
			if (!oCtx) { return; }
			this.getView().getModel("thresholdModel")
				.setProperty(oCtx.getPath() + "/threshold", null);
		},

		onSaveThreshold: function () {
			var oView = this.getView();
			var oModel = oView.getModel("thresholdModel");
			var aRows = oModel.getProperty("/rows") || [];

			// byIO: chuỗi rỗng = xoá ngưỡng (backend hiểu null/"" là delete key)
			var oByIO = {};
			var iSet = 0;
			var bInvalid = false;

			aRows.forEach(function (row) {
				var v = row.threshold;
				if (v === null || v === undefined || v === "") {
					oByIO[row.internalOrder] = "";
					return;
				}
				var n = Number(v);
				if (isNaN(n) || n < 0) {
					bInvalid = true;
					return;
				}
				oByIO[row.internalOrder] = n;
				iSet += 1;
			});

			if (bInvalid) {
				MessageBox.error("Ngưỡng phải là số không âm. Vui lòng kiểm tra lại các dòng đã nhập.");
				return;
			}

			oView.setBusy(true);

			fetch(BACKEND + "/api/thresholds", {
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ byIO: oByIO })
			})
				.then(function (r) { return r.json(); })
				.then(function (res) {
					oView.setBusy(false);
					if (!res || !res.success) {
						MessageBox.error((res && res.message) || "Không lưu được cấu hình ngưỡng.");
						return;
					}
					MessageBox.success(
						"Đã lưu cấu hình ngưỡng.\n\n"
						+ iSet + " Internal Order đang có ngưỡng, "
						+ (aRows.length - iSet) + " IO không đặt ngưỡng.\n"
						+ "Các PR gửi lên từ bây giờ sẽ áp dụng ngay.",
						{ title: "Cập nhật thành công" }
					);
				})
				.catch(function () {
					oView.setBusy(false);
					MessageBox.error("Không thể kết nối tới máy chủ.");
				});
		},

		onNavBack: function () {
			this.getOwnerComponent().getRouter().navTo("dashboard");
		}
	});
});
