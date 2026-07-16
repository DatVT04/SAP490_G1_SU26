sap.ui.define([
	"sap/ui/core/mvc/Controller",
	"sap/ui/model/json/JSONModel",
	"sap/m/MessageBox",
	"sap/m/MessageToast",
	"com/qdavy/procurement/model/Config"
], function (Controller, JSONModel, MessageBox, MessageToast, Config) {
	"use strict";

	var BACKEND = Config.BACKEND;

	function emptyForm() {
		return {
			materialNo: "",
			materialType: "",
			description: "",
			uom: "",
			quantity: null,
			estimatedValue: null,
			currency: "VND",
			costCenter: "",
			assetNo: ""
		};
	}

	return Controller.extend("com.qdavy.procurement.controller.PR01", {
		onInit: function () {
			var oModel = new JSONModel({
				materials: [],
				form: emptyForm()
			});
			this.getView().setModel(oModel);
			this._loadMaterials();
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

		onMaterialChange: function (oEvent) {
			var sKey = oEvent.getParameter("selectedItem") && oEvent.getParameter("selectedItem").getKey();
			var oModel = this.getView().getModel();
			var aMaterials = oModel.getProperty("/materials");
			var oMaterial = aMaterials.filter(function (m) { return m.MaterialNo === sKey; })[0];

			if (!oMaterial) {
				return;
			}

			oModel.setProperty("/form/materialNo", oMaterial.MaterialNo);
			oModel.setProperty("/form/materialType", oMaterial.MaterialType);
			oModel.setProperty("/form/description", oMaterial.Description);
			oModel.setProperty("/form/uom", oMaterial.BaseUoM);
			// Đổi loại vật tư thì reset field không còn liên quan (Cost Center <-> Asset No).
			oModel.setProperty("/form/costCenter", "");
			oModel.setProperty("/form/assetNo", "");
		},

		onResetPress: function () {
			this.getView().getModel().setProperty("/form", emptyForm());
			this.byId("materialSelect").setSelectedKey("");
		},

		onSubmitPress: function () {
			var oView = this.getView();
			var oForm = oView.getModel().getProperty("/form");
			var oUser = this.getOwnerComponent().getModel("user").getData();

			if (!oForm.materialNo) {
				MessageBox.warning("Vui long chon vat tu.");
				return;
			}
			if (!oForm.quantity || Number(oForm.quantity) <= 0) {
				MessageBox.warning("Vui long nhap so luong hop le.");
				return;
			}
			if (!oForm.estimatedValue || Number(oForm.estimatedValue) <= 0) {
				MessageBox.warning("Vui long nhap gia tri uoc tinh hop le.");
				return;
			}
			if (oForm.materialType === "ZAST" && !oForm.assetNo) {
				MessageBox.warning("Vat tu tai san (ZAST) bat buoc phai co Asset No (tao qua AS01 ben SAP).");
				return;
			}
			if (oForm.materialType !== "ZAST" && !oForm.costCenter) {
				MessageBox.warning("Vui long nhap Cost Center.");
				return;
			}

			oView.setBusy(true);

			fetch(BACKEND + "/api/approval/submit", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					requesterEmail: oUser.email,
					materialNo: oForm.materialNo,
					materialType: oForm.materialType,
					description: oForm.description,
					quantity: Number(oForm.quantity),
					uom: oForm.uom,
					totalValue: Number(oForm.estimatedValue),
					currency: oForm.currency,
					costCenter: oForm.costCenter,
					assetNo: oForm.assetNo
				})
			})
				.then(function (oResponse) {
					return oResponse.json().then(function (oData) {
						return { status: oResponse.status, body: oData };
					});
				})
				.then(function (oResult) {
					oView.setBusy(false);

					if (!oResult.body || !oResult.body.success) {
						MessageBox.error((oResult.body && oResult.body.message) || "Khong tao duoc de nghi mua sam.");
						return;
					}

					var oApproval = oResult.body.approval;
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
