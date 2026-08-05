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
				email: "",
				googleAvailable: false
			}));

			this._loadGoogleConfig();
		},

		/**
		 * Hoi backend xem GOOGLE_CLIENT_ID da duoc cau hinh chua. Neu co thi
		 * nap script Google Identity Services va ve nut "Dang nhap voi Google"
		 * vao div qdGoogleBtnMount. Neu chua cau hinh, an han nut nay di — chi
		 * con duong dang nhap email (giu tuong thich nguoc, khong lam vo app
		 * cua nhung ai chua tao Google OAuth Client ID).
		 */
		_loadGoogleConfig: function () {
			var oModel = this.getView().getModel();

			fetch(Config.BACKEND + "/api/config")
				.then(function (oResponse) { return oResponse.json(); })
				.then(function (oData) {
					var sClientId = oData && oData.googleClientId;
					if (!sClientId) { return; }

					oModel.setProperty("/googleAvailable", true);
					this._sGoogleClientId = sClientId;
					this._renderGoogleButtonWhenReady();
				}.bind(this))
				.catch(function () {
					// Khong lay duoc config -> coi nhu chua bat Google, van con email login.
				});
		},

		_renderGoogleButtonWhenReady: function () {
			if (!this._sGoogleClientId) { return; }

			var fnInit = function () {
				if (this._bGoogleButtonRendered) { return; }

				var oMount = document.getElementById("qdGoogleBtnMount");
				// core:HTML render vao DOM khong dong bo voi luc script Google load
				// xong — neu chua thay div thi thu lai vai lan thay vi bo cuoc.
				if (!oMount || !window.google) {
					if (!this._iGoogleRetries) { this._iGoogleRetries = 0; }
					if (this._iGoogleRetries < 20) {
						this._iGoogleRetries++;
						setTimeout(fnInit, 200);
					}
					return;
				}

				window.google.accounts.id.initialize({
					client_id: this._sGoogleClientId,
					callback: this._onGoogleCredentialResponse.bind(this)
				});
				window.google.accounts.id.renderButton(oMount, {
					theme: "outline",
					size: "large",
					width: 320,
					text: "signin_with",
					locale: "vi"
				});
				this._bGoogleButtonRendered = true;
			}.bind(this);

			if (window.google && window.google.accounts) {
				fnInit();
				return;
			}

			if (!document.getElementById("qdGoogleGsiScript")) {
				var oScript = document.createElement("script");
				oScript.id = "qdGoogleGsiScript";
				oScript.src = "https://accounts.google.com/gsi/client";
				oScript.async = true;
				oScript.defer = true;
				oScript.onload = fnInit;
				document.head.appendChild(oScript);
			} else {
				document.getElementById("qdGoogleGsiScript").addEventListener("load", fnInit);
			}
		},

		/**
		 * Google da xac thuc nguoi dung that (mat khau + 2FA phia Google) va
		 * tra ve 1 ID token da ky so trong response.credential. Gui thang len
		 * backend de backend tu xac minh chu ky + doi chieu voi SAP — frontend
		 * khong tu quyet dinh gi ca, tranh gia mao.
		 */
		_onGoogleCredentialResponse: function (oResponse) {
			var oView = this.getView();
			oView.setBusy(true);

			fetch(Config.BACKEND + "/api/login/google", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ credential: oResponse.credential })
			})
				.then(function (oHttpResponse) {
					return oHttpResponse.json().then(function (oData) {
						return { status: oHttpResponse.status, body: oData };
					});
				})
				.then(this._handleLoginResult.bind(this))
				.catch(function () {
					oView.setBusy(false);
					MessageBox.error("Không thể kết nối tới máy chủ xác thực. Vui lòng thử lại sau.");
				});
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
				.then(this._handleLoginResult.bind(this))
				.catch(function (oError) {
					oView.setBusy(false);
					MessageBox.error("Không thể kết nối tới máy chủ xác thực. Vui lòng thử lại sau.");
				});
		},

		/**
		 * Dung chung cho ca 2 duong dang nhap (email-only va Google): nhan ket
		 * qua tu backend, dung sai thi bao loi, dung thi ghi vao model "user"
		 * va chuyen sang Dashboard.
		 */
		_handleLoginResult: function (oResult) {
			var oView = this.getView();
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
				// Anh dai dien: co that neu dang nhap qua Google (payload.picture tu
				// /api/login/google), rong neu dang nhap bang email — luc do UI hien
				// initials (2 chu cai dau) thay vi anh, xem sap.m.Avatar o Dashboard.
				avatarUrl: oResult.body.googlePicture || "",
				avatarInitials: this._computeInitials(sFullName),
				// Cac field con lai chi con dung noi bo (khong con man Profile de sua),
				// giu lai phong khi can hien thi/doi chieu sau nay.
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
		},

		// Lay toi da 2 ky tu dau (tu dau + tu cuoi cua ten day du) lam initials
		// cho sap.m.Avatar khi khong co anh Google — VD "Vu Tien Đạt" -> "VĐ".
		_computeInitials: function (sFullName) {
			var aParts = String(sFullName || "").trim().split(/\s+/).filter(Boolean);
			if (aParts.length === 0) { return ""; }
			if (aParts.length === 1) { return aParts[0].charAt(0).toUpperCase(); }
			return (aParts[0].charAt(0) + aParts[aParts.length - 1].charAt(0)).toUpperCase();
		}
	});
});
