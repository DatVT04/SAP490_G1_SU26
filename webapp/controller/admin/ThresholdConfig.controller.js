sap.ui.define([
	"sap/ui/core/mvc/Controller",
	"sap/ui/model/json/JSONModel",
	"sap/m/MessageBox",
	"sap/m/MessageToast",
	"com/qdavy/procurement/model/Config",
	"com/qdavy/procurement/model/Msg"
], function (Controller, JSONModel, MessageBox, MessageToast, Config, Msg) {
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
				MessageBox.error("Chỉ CEO được phép mở màn hình Cấu hình hệ thống.");
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
		 * Ghep danh muc vat tu tu SAP (/api/materials) voi cau hinh dang luu
		 * (/api/material-config). Phai lay ca 2 vi cau hinh chi chua vat tu DA khai
		 * — muon khai them vat tu moi thi phai liet ke du (cung ly do voi bang nguong).
		 */
		_loadAssetMap: function () {
			var oModel = this.getView().getModel("assetModel");

			Promise.all([
				fetch(BACKEND + "/api/materials").then(function (r) { return r.json(); }),
				fetch(BACKEND + "/api/material-config").then(function (r) { return r.json(); })
			])
				.then(function (aResults) {
					var oMatRes = aResults[0] || {};
					var oMapRes = aResults[1] || {};
					if (!oMatRes.success) {
						MessageToast.show(oMatRes.message || "Không tải được danh mục vật tư từ SAP. Vui lòng thử lại.");
						return;
					}

					var oByMat = (oMapRes && oMapRes.byMaterial) || {};
					// Liet ke MOI vat tu, khong rieng ZAST: gia ke hoach ap dung cho ca
					// dich vu (ZSRV). Cot ma tai san tu khoa lai o dong khong phai ZAST.
					var aRows = (oMatRes.data || [])
						.map(function (m) {
							var sNo = String(m.MaterialNo || "").trim();
							var sKey = /^\d+$/.test(sNo.toUpperCase())
								? (sNo.replace(/^0+/, "") || "0")
								: sNo.toUpperCase();
							var sType = String(m.MaterialType || "").trim().toUpperCase();
							var oCfg = oByMat[sKey] || {};
							var aList = (Array.isArray(oCfg.assets) ? oCfg.assets : [])
								.map(function (a) {
									if (a && typeof a === "object") {
										return { no: String(a.no || "").trim(), used: !!a.used, usedByPr: String(a.usedByPr || "") };
									}
									return { no: String(a || "").trim(), used: false, usedByPr: "" };
								})
								.filter(function (a) { return a.no; });

							var aUsed = aList.filter(function (a) { return a.used; });

							return {
								materialNo: sNo,
								description: m.Description || "",
								materialType: sType,
								isAsset: sType === "ZAST",
								typeLabel: sType === "ZAST" ? "Tài sản" : (sType === "ZSRV" ? "Dịch vụ" : sType),
								assetClass: oCfg.assetClass || "",
								// O nhap chi chua ma CON TRONG; ma da dung hien rieng ben
								// duoi dang chi doc.
								assets: aList.filter(function (a) { return !a.used; })
									.map(function (a) { return a.no; }).join(", "),
								usedText: aUsed.length
									? "Đã dùng: " + aUsed.map(function (a) {
										return a.no + (a.usedByPr ? " (PR " + a.usedByPr + ")" : "");
									}).join(" · ")
									: ""
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
					MessageToast.show("Không tải được danh mục mã tài sản của vật tư. Vui lòng thử lại.");
				});
		},

		onClearAssetRow: function (oEvent) {
			var oCtx = oEvent.getSource().getBindingContext("assetModel");
			if (!oCtx) { return; }
			// Chi xoa phan khai duoc: ma DA DUNG khong dong o day (service giu lai).
			var oModel = this.getView().getModel("assetModel");
			oModel.setProperty(oCtx.getPath() + "/assets", "");
			oModel.setProperty(oCtx.getPath() + "/assetClass", "");
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
				var sClass = String(row.assetClass || "").trim().toUpperCase();
				// Khong ma tai san + khong nhom tai san = xoa khai bao vat tu do.
				oByMaterial[row.materialNo] = {
					assets: aList,
					assetClass: sClass
				};
				if (aList.length || sClass) { iSet += 1; }
			});

			oView.setBusy(true);

			fetch(BACKEND + "/api/material-config", {
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
						Msg.fail(res, {
							title: "Không lưu được danh mục",
							fallback: "Không lưu được danh mục mã tài sản. Thay đổi chưa được ghi nhận, vui lòng thử lại."
						});
						return;
					}
					if (res.warning) {
						MessageBox.warning(
							res.warning + "\n\n"
							+ "Thay đổi đã có hiệu lực ngay trên màn hình Lập đề nghị, nhưng chưa được lưu xuống SAP.",
							{ title: "Đã lưu trong ứng dụng" }
						);
						return;
					}
					MessageBox.success(
						"Đã lưu danh mục tài sản vào bảng ZG1_MAT_CONFIG trên SAP.\n\n"
						+ iSet + "/" + aRows.length + " vật tư đã khai nhóm tài sản hoặc còn mã tài sản trống.\n"
						+ "Đề nghị mua sắm lập từ bây giờ sẽ tự điền mã tài sản.",
						{ title: "Cập nhật thành công" }
					);
				})
				.catch(function () {
					oView.setBusy(false);
					MessageBox.error("Không thể kết nối tới máy chủ. Vui lòng thử lại.");
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
						MessageBox.error(oIoRes.message || "Không tải được danh sách Internal Order từ SAP. Vui lòng thử lại.");
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
					MessageBox.error("Không thể kết nối tới máy chủ. Vui lòng thử lại.");
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
				MessageBox.error("Ngưỡng phê duyệt phải là số không âm. Vui lòng kiểm tra lại các dòng đã nhập.");
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
						Msg.fail(res, {
							title: "Không lưu được cấu hình",
							fallback: "Không lưu được cấu hình ngưỡng phê duyệt. Thay đổi chưa được ghi nhận, vui lòng thử lại."
						});
						return;
					}
					MessageBox.success(
						"Đã lưu cấu hình ngưỡng.\n\n"
						+ iSet + " Internal Order đang có ngưỡng, "
						+ (aRows.length - iSet) + " Internal Order chưa đặt ngưỡng.\n"
						+ "Các đề nghị mua sắm gửi từ bây giờ sẽ áp dụng ngưỡng mới.",
						{ title: "Cập nhật thành công" }
					);
				})
				.catch(function () {
					oView.setBusy(false);
					MessageBox.error("Không thể kết nối tới máy chủ. Vui lòng thử lại.");
				});
		},

		onNavBack: function () {
			this.getOwnerComponent().getRouter().navTo("dashboard");
		}
	});
});
