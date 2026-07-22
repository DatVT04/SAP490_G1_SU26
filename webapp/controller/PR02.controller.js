sap.ui.define([
	"sap/ui/core/mvc/Controller",
	"sap/ui/model/json/JSONModel",
	"sap/m/MessageBox",
	"sap/m/MessageToast",
	"sap/m/Dialog",
	"sap/m/DialogType",
	"sap/m/Button",
	"sap/m/ButtonType",
	"sap/m/TextArea",
	"sap/m/VBox",
	"sap/m/Label",
	"com/qdavy/procurement/model/Config"
], function (Controller, JSONModel, MessageBox, MessageToast, Dialog, DialogType, Button, ButtonType, TextArea, VBox, Label, Config) {
	"use strict";

	var BACKEND = Config.BACKEND;

	return Controller.extend("com.qdavy.procurement.controller.PR02", {
		onInit: function () {
			this.getView().setModel(new JSONModel({ pending: [] }));

			// UI5 giu nguyen view khi dieu huong qua lai giua cac tab (khong huy/tao lai),
			// nen onInit chi chay 1 lan duy nhat. Phai gan patternMatched de moi lan
			// NGUOI DUNG QUAY LAI man nay deu tu dong tai lai danh sach PR moi nhat —
			// tranh tinh trang phai logout/login lai moi thay du lieu vua duyet o man khac.
			this.getOwnerComponent().getRouter()
				.getRoute("pr02")
				.attachPatternMatched(this._loadPending, this);
		},

		_loadPending: function () {
			var oView = this.getView();
			oView.setBusy(true);
			fetch(BACKEND + "/api/approval/pending")
				.then(function (oResponse) { return oResponse.json(); })
				.then(function (oResult) {
					oView.setBusy(false);
					if (oResult && oResult.success) {
						oView.getModel().setProperty("/pending", oResult.data || []);
					}
				})
				.catch(function () {
					oView.setBusy(false);
					MessageBox.error("Khong tai duoc danh sach de nghi mua sam dang cho duyet.");
				});
		},

		onRefreshPress: function () {
			this._loadPending();
		},

		formatQty: function (fQuantity, sUom) {
			if (fQuantity === undefined || fQuantity === null) {
				return "";
			}
			return fQuantity + " " + (sUom || "");
		},

		formatValue: function (fValue, sCurrency) {
			if (fValue === undefined || fValue === null) {
				return "";
			}
			var sFormatted = Number(fValue).toLocaleString("vi-VN");
			return sFormatted + " " + (sCurrency || "VND");
		},

		_openDecisionDialog: function (sPRId, sStatus, sTitle, sButtonType) {
			var that = this;
			var oTextArea = new TextArea({
				width: "100%",
				rows: 3,
				placeholder: this.getView().getModel("i18n") ?
					this.getView().getModel("i18n").getResourceBundle().getText("pr02CommentPlaceholder") :
					"Ghi chu (tuy chon)"
			});

			var oDialog = new Dialog({
				type: DialogType.Message,
				title: sTitle,
				content: [
					new VBox({
						items: [
							new Label({ text: "Ghi chu quyet dinh:" }),
							oTextArea
						]
					})
				],
				beginButton: new Button({
					text: sTitle,
					type: sButtonType,
					press: function () {
						oDialog.close();
						that._submitDecision(sPRId, sStatus, oTextArea.getValue());
					}
				}),
				endButton: new Button({
					text: "Huy",
					press: function () { oDialog.close(); }
				}),
				afterClose: function () { oDialog.destroy(); }
			});

			oDialog.open();
		},

		onApprovePress: function (oEvent) {
			var oPR = oEvent.getSource().getBindingContext().getObject();
			this._openDecisionDialog(oPR.PRId, "APPROVED", "Duyet", ButtonType.Accept);
		},

		onRejectPress: function (oEvent) {
			var oPR = oEvent.getSource().getBindingContext().getObject();
			this._openDecisionDialog(oPR.PRId, "REJECTED", "Tu choi", ButtonType.Reject);
		},

		_submitDecision: function (sPRId, sStatus, sComment) {
			var oView = this.getView();
			var oUser = this.getOwnerComponent().getModel("user").getData();

			oView.setBusy(true);
			fetch(BACKEND + "/api/approval/" + encodeURIComponent(sPRId), {
				method: "PATCH",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					status: sStatus,
					comment: sComment,
					decidedByEmail: oUser.email
				})
			})
				.then(function (oResponse) { return oResponse.json(); })
				.then(function (oResult) {
					oView.setBusy(false);
					if (!oResult || !oResult.success) {
						MessageBox.error((oResult && oResult.message) || "Khong cap nhat duoc trang thai.");
						return;
					}
					MessageToast.show(sPRId + " -> " + sStatus);
					this._loadPending();
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
