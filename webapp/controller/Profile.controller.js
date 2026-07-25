sap.ui.define([
	"sap/ui/core/mvc/Controller",
	"sap/ui/model/json/JSONModel",
	"sap/m/MessageBox",
	"sap/m/MessageToast",
	"com/qdavy/procurement/model/Config"
], function (Controller, JSONModel, MessageBox, MessageToast, Config) {
	"use strict";

	var BACKEND = Config.BACKEND;

	// Gioi han do dai trung khop voi thuoc tinh Entity Type "Employee" ben SEGW
	// (FirstName/LastName Edm.String maxlength 40, PhoneNumber 30, Street 60, City 40, PostalCode 10).
	var FIELD_LIMITS = {
		lastName: { max: 40, label: "Họ" },
		firstName: { max: 40, label: "Tên" },
		phoneNumber: { max: 30, label: "Số điện thoại" },
		street: { max: 60, label: "Địa chỉ" },
		city: { max: 40, label: "Thành phố" },
		postalCode: { max: 10, label: "Mã bưu điện" }
	};

	return Controller.extend("com.qdavy.procurement.controller.Profile", {

		onInit: function () {
			this.getView().setModel(new JSONModel({
				lastName: "",
				firstName: "",
				phoneNumber: "",
				street: "",
				city: "",
				postalCode: ""
			}), "profile");

			this.getOwnerComponent().getRouter()
				.getRoute("profile")
				.attachPatternMatched(this._onRouteMatched, this);
		},

		// Moi lan vao man Profile, dong bo lai form tu model "user" hien tai
		// (phong truong hop nguoi dung vao/ra nhieu lan, tranh hien du lieu cu).
		_onRouteMatched: function () {
			var oUser = this.getOwnerComponent().getModel("user").getData();
			this.getView().getModel("profile").setData({
				lastName: oUser.lastName || "",
				firstName: oUser.firstName || "",
				phoneNumber: oUser.phoneNumber || "",
				street: oUser.street || "",
				city: oUser.city || "",
				postalCode: oUser.postalCode || ""
			});
		},

		onNavBack: function () {
			this.getOwnerComponent().getRouter().navTo("dashboard");
		},

		onSaveProfile: function () {
			var oView = this.getView();
			var oProfileModel = oView.getModel("profile");
			var oProfile = oProfileModel.getData();
			var oUserModel = this.getOwnerComponent().getModel("user");
			var sEmail = oUserModel.getProperty("/email");

			// Cat khoang trang thua o dau/cuoi truoc khi validate va gui di
			Object.keys(FIELD_LIMITS).forEach(function (sKey) {
				if (typeof oProfile[sKey] === "string") {
					oProfile[sKey] = oProfile[sKey].trim();
				}
			});
			oProfileModel.setData(oProfile);

			if (!oProfile.lastName || !oProfile.firstName) {
				MessageBox.error("Vui lòng nhập đầy đủ Họ và Tên.");
				return;
			}

			// Validate do dai tung truong theo dung gioi han da khai bao ben SAP (SEGW)
			var aTooLong = Object.keys(FIELD_LIMITS).filter(function (sKey) {
				var oLimit = FIELD_LIMITS[sKey];
				return (oProfile[sKey] || "").length > oLimit.max;
			});
			if (aTooLong.length > 0) {
				var sDetails = aTooLong.map(function (sKey) {
					var oLimit = FIELD_LIMITS[sKey];
					return oLimit.label + " (tối đa " + oLimit.max + " ký tự)";
				}).join(", ");
				MessageBox.error("Các trường sau đang vượt quá độ dài cho phép: " + sDetails + ".");
				return;
			}

			// Validate dinh dang so dien thoai VN (neu co nhap):
			// - Chi chua so, khoang trang, +()- khi go
			// - Sau khi bo dau cach/gach ngang/ngoac, phai la 0xxxxxxxxx (10-11 so)
			//   hoac +84xxxxxxxxx (9-10 so sau +84)
			if (oProfile.phoneNumber) {
				if (!/^[0-9+()\-\s]+$/.test(oProfile.phoneNumber)) {
					MessageBox.error("Số điện thoại chỉ được chứa chữ số và các ký tự +, -, (, ).");
					return;
				}
				var sDigitsOnly = oProfile.phoneNumber.replace(/[\s\-()]/g, "");
				if (!/^(0[0-9]{9,10}|\+84[0-9]{9,10})$/.test(sDigitsOnly)) {
					MessageBox.error("Số điện thoại không hợp lệ. Định dạng đúng: bắt đầu bằng 0 hoặc +84, theo sau là 9-10 chữ số (VD: 0912345678).");
					return;
				}
			}

			// Validate ma buu dien VN (neu co nhap): chi chua so, dung 5-6 chu so
			if (oProfile.postalCode) {
				if (!/^[0-9]+$/.test(oProfile.postalCode)) {
					MessageBox.error("Mã bưu điện chỉ được chứa chữ số.");
					return;
				}
				if (oProfile.postalCode.length < 5 || oProfile.postalCode.length > 6) {
					MessageBox.error("Mã bưu điện không hợp lệ. Việt Nam dùng mã bưu điện gồm 5-6 chữ số (VD: 100000).");
					return;
				}
			}

			oView.setBusy(true);

			fetch(BACKEND + "/api/profile", {
				method: "PATCH",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					email: sEmail,
					lastName: oProfile.lastName,
					firstName: oProfile.firstName,
					phoneNumber: oProfile.phoneNumber,
					street: oProfile.street,
					city: oProfile.city,
					postalCode: oProfile.postalCode
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
						MessageBox.error((oResult.body && oResult.body.message) || "Cập nhật hồ sơ thất bại.");
						return;
					}

					// Dong bo lai model "user" toan cuc (Dashboard/header dang hien
					// fullName cu) tu du lieu SAP tra ve sau khi ghi thanh cong.
					var oEmployee = oResult.body.employee;
					if (oEmployee) {
						var sNewLastName = oEmployee.LastName || oProfile.lastName;
						var sNewFirstName = oEmployee.FirstName || oProfile.firstName;
						oUserModel.setProperty("/fullName", Config.buildFullName(sNewLastName, sNewFirstName, oEmployee.FullName));
						oUserModel.setProperty("/firstName", sNewFirstName);
						oUserModel.setProperty("/lastName", sNewLastName);
						oUserModel.setProperty("/phoneNumber", oEmployee.PhoneNumber || oProfile.phoneNumber);
						oUserModel.setProperty("/street", oEmployee.Street || oProfile.street);
						oUserModel.setProperty("/city", oEmployee.City || oProfile.city);
						oUserModel.setProperty("/postalCode", oEmployee.PostalCode || oProfile.postalCode);
					}

					MessageToast.show(this.getView().getModel("i18n").getResourceBundle().getText("profileSaveSuccess"));
				}.bind(this))
				.catch(function () {
					oView.setBusy(false);
					MessageBox.error("Không thể kết nối tới máy chủ. Vui lòng thử lại sau.");
				});
		}
	});
});
