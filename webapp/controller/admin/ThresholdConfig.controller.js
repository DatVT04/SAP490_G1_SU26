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
			this.getView().setModel(new JSONModel({ rows: [] }), "assetModel");

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
			this._loadAssetMap();
		},

		onRefreshPress: function () {
			this._load();
			this._loadAssetMap();
		},

		/**
		 * Ghep danh muc vat tu tu SAP (/api/materials, loc ZAST) voi anh xa dang
		 * luu (/api/asset-map). Phai lay ca 2 vi anh xa chi chua vat tu DA khai —
		 * muon khai them vat tu moi thi phai liet ke du (cung ly do voi bang nguong).
		 */
		_loadAssetMap: function () {
			var oModel = this.getView().getModel("assetModel");

			Promise.all([
				fetch(BACKEND + "/api/materials").then(function (r) { return r.json(); }),
				fetch(BACKEND + "/api/asset-map").then(function (r) { return r.json(); })
			])
				.then(function (aResults) {
					var oMatRes = aResults[0] || {};
					var oMapRes = aResults[1] || {};
					if (!oMatRes.success) {
						MessageToast.show(oMatRes.message || "Không tải được danh mục vật tư từ SAP.");
						return;
					}

					var oByMat = (oMapRes && oMapRes.byMaterial) || {};
					var aRows = (oMatRes.data || [])
						.filter(function (m) {
							return String(m.MaterialType || "").trim().toUpperCase() === "ZAST";
						})
						.map(function (m) {
							var sNo = String(m.MaterialNo || "").trim();
							var sKey = /^\d+$/.test(sNo.toUpperCase())
								? (sNo.replace(/^0+/, "") || "0")
								: sNo.toUpperCase();
							var raw = oByMat[sKey];
							var aList = Array.isArray(raw) ? raw : (raw ? String(raw).split(",") : []);
							return {
								materialNo: sNo,
								description: m.Description || "",
								assets: aList.map(function (x) { return String(x || "").trim(); })
									.filter(Boolean).join(", ")
							};
						});

					oModel.setProperty("/rows", aRows);
					// Noi ro dang doc tu dau: bang Z tren SAP hay ban du phong trong
					// ung dung (khi phan SAP chua lam xong / SAP loi).
					if (oMapRes.warning) {
						MessageToast.show(oMapRes.warning);
					}
				})
				.catch(function () {
					MessageToast.show("Không tải được ánh xạ vật tư — tài sản.");
				});
		},

		onClearAssetRow: function (oEvent) {
			var oCtx = oEvent.getSource().getBindingContext("assetModel");
			if (!oCtx) { return; }
			this.getView().getModel("assetModel").setProperty(oCtx.getPath() + "/assets", "");
		},

		onSaveAssetMap: function () {
			var oView = this.getView();
			var aRows = oView.getModel("assetModel").getProperty("/rows") || [];

			var oByMaterial = {};
			var iSet = 0;
			aRows.forEach(function (row) {
				var aList = String(row.assets || "").split(",")
					.map(function (x) { return String(x || "").trim(); })
					.filter(Boolean);
				// Chuoi rong = xoa khai bao cua vat tu do (backend hieu mang rong la delete).
				oByMaterial[row.materialNo] = aList;
				if (aList.length) { iSet += 1; }
			});

			oView.setBusy(true);

			fetch(BACKEND + "/api/asset-map", {
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					byMaterial: oByMaterial,
					// Ghi kem nguoi sua vao bang Z tren SAP (cot CHANGED_BY) — cau hinh
					// anh huong toi hach toan tai san nen phai truy duoc ai doi.
					changedBy: String(this.getOwnerComponent().getModel("user").getProperty("/email") || "")
				})
			})
				.then(function (r) { return r.json(); })
				.then(function (res) {
					oView.setBusy(false);
					if (!res || !res.success) {
						MessageBox.error((res && res.message) || "Không lưu được ánh xạ tài sản.");
						return;
					}
					if (res.warning) {
						MessageBox.warning(
							res.warning + "\n\n"
							+ "Thay đổi vẫn áp dụng ngay cho màn Lập đề nghị, nhưng chưa nằm trên SAP.",
							{ title: "Đã lưu trong ứng dụng" }
						);
						return;
					}
					MessageBox.success(
						"Đã lưu ánh xạ vật tư — tài sản vào bảng ZG1_MAT_ASSET trên SAP.\n\n"
						+ iSet + "/" + aRows.length + " vật tư Tài sản đã có mã tài sản.\n"
						+ "Đề nghị mua sắm lập từ bây giờ sẽ tự điền mã tương ứng.",
						{ title: "Cập nhật thành công" }
					);
				})
				.catch(function () {
					oView.setBusy(false);
					MessageBox.error("Không thể kết nối tới máy chủ.");
				});
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
