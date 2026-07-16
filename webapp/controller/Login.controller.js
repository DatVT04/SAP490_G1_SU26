sap.ui.define([
	"sap/ui/core/mvc/Controller",
	"sap/ui/model/json/JSONModel",
	"sap/m/MessageBox",
	"sap/m/MessageToast",
	"com/qdavy/procurement/model/Config"
], function (Controller, JSONModel, MessageBox, MessageToast, Config) {
	"use strict";

	return Controller.extend("com.qdavy.procurement.controller.Login", {
		onInit: function () {
			this.getView().setModel(new JSONModel({
				email: ""
			}));
		},

		onLoginPress: function () {
			var oView = this.getView();
			var sEmail = oView.getModel().getProperty("/email");

			if (!sEmail) {
				MessageBox.error("Vui lòng nhập email công ty.");
				return;
			}

			oView.setBusy(true);

			fetch(Config.BACKEND + "/api/login", {
				method: "POST",
				headers: {
					"Content-Type": "application/json"
				},
				body: JSON.stringify({ email: sEmail })
			})
				.then(function (oResponse) {
					return oResponse.json().then(function (oData) {
						return { status: oResponse.status, body: oData };
					});
				})
				.then(function (oResult) {
					oView.setBusy(false);

					if (!oResult.body || !oResult.body.success) {
						MessageBox.error((oResult.body && oResult.body.message) || "Đăng nhập thất bại. Email không tồn tại hoặc đã bị khóa.");
						return;
					}

					var oEmployee = oResult.body.employee;
					var oUserModel = this.getOwnerComponent().getModel("user");

					oUserModel.setData({
						email: oEmployee.Email,
						fullName: oEmployee.FullName,
						pernr: oEmployee.Pernr,
						role: oEmployee.Role,
						position: oEmployee.Position,
						costCenter: oEmployee.CostCenter,
						isLoggedIn: true
					});

					MessageToast.show("Xin chào " + oEmployee.FullName);
					this.getOwnerComponent().getRouter().navTo("dashboard");
				}.bind(this))
				.catch(function (oError) {
					oView.setBusy(false);
					MessageBox.error("Không thể kết nối tới máy chủ xác thực. Vui lòng thử lại sau.");
				});
		}
	});
});
