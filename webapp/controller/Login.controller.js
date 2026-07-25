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
					var sFullName = Config.buildFullName(oEmployee.LastName, oEmployee.FirstName, oEmployee.FullName);

					oUserModel.setData({
						email: oEmployee.Email,
						fullName: sFullName,
						pernr: oEmployee.Pernr,
						role: oEmployee.Role,
						position: oEmployee.Position,
						costCenter: oEmployee.CostCenter,
						// Cac field ho so ca nhan (man Profile) — chi co du lieu that neu
						// ABAP GET_ENTITYSET da duoc mo rong doc them PA0006 (xem HUONG_DAN).
						// Neu chua lam ben SAP, cac field nay se rong — man Profile van mo
						// duoc, chi la form trong, khong loi.
						firstName: oEmployee.FirstName || "",
						lastName: oEmployee.LastName || "",
						phoneNumber: oEmployee.PhoneNumber || "",
						street: oEmployee.Street || "",
						city: oEmployee.City || "",
						postalCode: oEmployee.PostalCode || "",
						isLoggedIn: true
					});

					MessageToast.show("Xin chào " + sFullName);
					this.getOwnerComponent().getRouter().navTo("dashboard");
				}.bind(this))
				.catch(function (oError) {
					oView.setBusy(false);
					MessageBox.error("Không thể kết nối tới máy chủ xác thực. Vui lòng thử lại sau.");
				});
		}
	});
});
