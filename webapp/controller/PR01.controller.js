sap.ui.define([
	"sap/ui/core/mvc/Controller",
	"sap/ui/model/json/JSONModel",
	"sap/m/MessageBox",
	"sap/m/MessageToast",
	"com/qdavy/procurement/model/Config"
], function (Controller, JSONModel, MessageBox, MessageToast, Config) {
	"use strict";

	var BACKEND = Config.BACKEND;

	// Nguong leo thang phe duyet — phai khop voi buildApprovalFlags() trong server.js
	var CEO_THRESHOLD = 300000000;   // > 300 trieu -> can CEO duyet them
	var CFO_THRESHOLD = 100000000;   // > 100 trieu -> can CFO xem ky

	return Controller.extend("com.qdavy.procurement.controller.PR01", {
		onInit: function () {
			var oModel = new JSONModel({
				materials: [],
				header: { currency: "VND" },
				items: [],        // Danh sach nhieu vat tu
				totalText: "0",   // Tong gia tri da format, hien o thanh qdTotalBar
				escalationText: ""// Canh bao leo thang, rong = an MessageStrip
			});
			this.getView().setModel(oModel);
			this._loadMaterials();
		},

		// Tinh lai tong tien + canh bao moi khi so luong/don gia thay doi
		onItemValueChange: function () {
			this._recalcTotal();
		},

		_recalcTotal: function () {
			var oModel = this.getView().getModel();
			var aItems = oModel.getProperty("/items") || [];

			var fTotal = aItems.reduce(function (sum, item) {
				return sum + (Number(item.estimatedValue) || 0);
			}, 0);

			oModel.setProperty("/totalText", fTotal.toLocaleString("vi-VN"));

			// Bao truoc cho nguoi de nghi biet PR se phai qua nhung cap nao
			var sWarn = "";
			if (fTotal > CEO_THRESHOLD) {
				sWarn = "Giá trị vượt 300 triệu VND — đề nghị này sẽ cần CFO duyệt và leo thang lên CEO phê duyệt.";
			} else if (fTotal > CFO_THRESHOLD) {
				sWarn = "Giá trị vượt 100 triệu VND — đề nghị này sẽ được CFO xem xét kỹ trước khi duyệt.";
			}
			oModel.setProperty("/escalationText", sWarn);
		},

		_loadMaterials: function () {
			var oView = this.getView();
			fetch(BACKEND + "/api/materials")
				.then(function (oResponse) { return oResponse.json(); })
				.then(function (oResult) {
					if (oResult && oResult.success) {
						oView.getModel().setProperty("/materials", oResult.data || []);
					}
				})
				.catch(function () {
					MessageBox.error("Khong tai duoc danh sach vat tu.");
				});
		},

		// Thêm dòng vật tư từ Danh mục
		onAddItem: function () {
			var oModel = this.getView().getModel();
			var aItems = oModel.getProperty("/items");
			aItems.push({
				isFreeText: false,
				materialNo: "",
				materialType: "",
				description: "",
				uom: "",
				quantity: null,
				estimatedValue: null,
				costCenter: "",
				internalOrder: "",
				assetNo: ""
			});
			oModel.setProperty("/items", aItems);
		},

		// Thêm dòng vật tư TỰ DO (Không có trong danh mục)
		onAddFreeTextItem: function () {
			var oModel = this.getView().getModel();
			var aItems = oModel.getProperty("/items");
			aItems.push({
				isFreeText: true,
				materialNo: "FREE_TEXT", // Mã đánh dấu vật tư ngoài danh mục
				materialType: "ZROH",   // Mặc định loại hàng hóa/vật tư
				description: "",
				uom: "PC",
				quantity: 1,
				estimatedValue: null,
				costCenter: "",
				internalOrder: "",
				assetNo: ""
			});
			oModel.setProperty("/items", aItems);
		},

		// Xóa 1 dòng vật tư khỏi bảng
		onDeleteItem: function (oEvent) {
			var oItem = oEvent.getParameter("listItem");
			var sPath = oItem.getBindingContext().getPath();
			var iIndex = parseInt(sPath.split("/").pop(), 10);
			
			var oModel = this.getView().getModel();
			var aItems = oModel.getProperty("/items");
			aItems.splice(iIndex, 1);
			oModel.setProperty("/items", aItems);
			this._recalcTotal();
		},

		// Tự động map dữ liệu khi chọn vật tư từ dropdown
		onMaterialChange: function (oEvent) {
			var oSelect = oEvent.getSource();
			var sKey = oSelect.getSelectedKey();
			var sPath = oSelect.getBindingContext().getPath();
			var oModel = this.getView().getModel();
			
			var aMaterials = oModel.getProperty("/materials");
			var oMaterial = aMaterials.filter(function (m) { return m.MaterialNo === sKey; })[0];

			if (oMaterial) {
				oModel.setProperty(sPath + "/materialNo", oMaterial.MaterialNo);
				oModel.setProperty(sPath + "/materialType", oMaterial.MaterialType);
				oModel.setProperty(sPath + "/description", oMaterial.Description);
				oModel.setProperty(sPath + "/uom", oMaterial.BaseUoM);
			}
			this._recalcTotal();
		},

		onResetPress: function () {
			this.getView().getModel().setProperty("/items", []);
			this._recalcTotal();
		},

		onSubmitPress: function () {
			var oView = this.getView();
			var oModel = oView.getModel();
			var aItems = oModel.getProperty("/items");
			var sCurrency = oModel.getProperty("/header/currency");
			var oUser = this.getOwnerComponent().getModel("user").getData();

			if (!aItems || aItems.length === 0) {
				MessageBox.warning("Vui long them it nhat 1 vat tu vao danh sach.");
				return;
			}

			// Validate từng dòng vật tư
			for (var i = 0; i < aItems.length; i++) {
				var item = aItems[i];
				var idx = i + 1;

				if (!item.description) {
					MessageBox.warning("Dong " + idx + ": Vui long nhap mo ta/ten vat tu.");
					return;
				}
				if (!item.quantity || Number(item.quantity) <= 0) {
					MessageBox.warning("Dong " + idx + ": Vui long nhap so luong hop le.");
					return;
				}
				if (!item.estimatedValue || Number(item.estimatedValue) <= 0) {
					MessageBox.warning("Dong " + idx + ": Vui long nhap gia tri uoc tinh hop le.");
					return;
				}
				if (item.materialType === "ZAST" && !item.assetNo) {
					MessageBox.warning("Dong " + idx + ": Vat tu tai san (ZAST) bat buoc phai co Asset No.");
					return;
				}
				if (item.materialType !== "ZAST" && !item.costCenter && !item.internalOrder) {
					MessageBox.warning("Dong " + idx + ": Vui long nhap Cost Center hoac Internal Order.");
					return;
				}
			}

			// Tính tổng tiền PR để gửi sang BE làm căn cứ duyệt leo thang
			var nTotalPRValue = aItems.reduce(function (sum, item) {
				return sum + Number(item.estimatedValue);
			}, 0);

			oView.setBusy(true);

			// Gửi Payload chứa mảng các items xuống Backend
			fetch(BACKEND + "/api/approval/submit", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					requesterEmail: oUser.email,
					currency: sCurrency,
					totalPRValue: nTotalPRValue,
					items: aItems // Truyền danh sách items
				})
			})
			.then(function (oResponse) { return oResponse.json(); })
			.then(function (oResult) {
				oView.setBusy(false);
				if (!oResult.success) {
					MessageBox.error(oResult.message || "Khong tao duoc de nghi mua sam.");
					return;
				}

				var oApproval = oResult.approval;
					var aWarnings = [];
					if (oApproval.needsLegalReview) {
						aWarnings.push("- Can Phap che xem truoc (gia tri > 100 trieu VND)");
					}
					if (oApproval.needsProcurementHeadReview) {
						aWarnings.push("- Can Truong Bo phan Mua sam xem truoc (gia tri > 300 trieu VND)");
					}

					var sMsg = "Da tao de nghi mua sam " + oApproval.PRId + ".";
					if (aWarnings.length) {
						sMsg += "\n\nLuu y leo thang phe duyet:\n" + aWarnings.join("\n");
					}
					// Canh bao ro neu PR chi luu local, KHONG ghi duoc vao SAP that
					// (thuong do MaterialNo chua ton tai ben SAP - chua chay MM01).
					if (oResult.sapIntegration === "failed") {
						sMsg += "\n\nCANH BAO: PR chua duoc ghi vao SAP that"
							+ (oResult.sapErrorMessage ? " - " + oResult.sapErrorMessage : "")
							+ ". PR nay se KHONG xem duoc bang ME53N.";
					}

					MessageBox.success(sMsg, {
						title: "PR-01",
						onClose: function () {
							this.onResetPress();
							this.getOwnerComponent().getRouter().navTo("dashboard");
						}.bind(this)
					});
				}.bind(this))
				.catch(function () {
					oView.setBusy(false);
					MessageBox.error("Khong the ket noi toi may chu.");
				});
		},

		onNavBack: function () {
			this.getOwnerComponent().getRouter().navTo("dashboard");
		}
	});
});