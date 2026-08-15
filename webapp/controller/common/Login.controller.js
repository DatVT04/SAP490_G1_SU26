sap.ui.define([
	"sap/ui/core/mvc/Controller",
	"sap/ui/model/json/JSONModel",
	"sap/m/MessageBox",
	"sap/m/MessageToast",
	"com/qdavy/procurement/model/Config"
], function (Controller, JSONModel, MessageBox, MessageToast, Config) {
	"use strict";

	return Controller.extend("com.qdavy.procurement.controller.common.Login", {
		onInit: function () {
			this.getView().setModel(new JSONModel({
				googleAvailable: false,
				// True sau khi da hoi xong /api/config (du co hay khong co Google) —
				// dung de quyet dinh co hien canh bao "chua cau hinh" hay khong,
				// tranh nham lan voi luc dang con cho load.
				googleConfigChecked: false
			}));

			this._loadGoogleConfig();
		},

		/**
		 * Hoi backend xem GOOGLE_CLIENT_ID da duoc cau hinh chua. Neu co thi nap
		 * script Google Identity Services va ve nut "Dang nhap voi Google" vao
		 * div qdGoogleBtnMount. Day gio la duong dang nhap DUY NHAT (khong con
		 * fallback go email) — neu chua cau hinh thi hien canh bao thay vi de
		 * trang trong khong biet lam sao dang nhap.
		 */
		_loadGoogleConfig: function () {
			var oModel = this.getView().getModel();

			fetch(Config.BACKEND + "/api/config")
				.then(function (oResponse) { return oResponse.json(); })
				.then(function (oData) {
					oModel.setProperty("/googleConfigChecked", true);
					var sClientId = oData && oData.googleClientId;
					if (!sClientId) { return; }

					oModel.setProperty("/googleAvailable", true);
					this._sGoogleClientId = sClientId;
					this._renderGoogleButtonWhenReady();
				}.bind(this))
				.catch(function () {
					oModel.setProperty("/googleConfigChecked", true);
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

		/**
		 * Nhan ket qua tu backend sau khi dang nhap Google: dung sai thi bao
		 * loi, dung thi ghi vao model "user" va chuyen sang Dashboard.
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
				// Anh dai dien lay tu tai khoan Google (payload.picture). Neu vi ly do
				// nao do khong co anh, fallback sang initials lay tu EMAIL (khong lay
				// tu ten SAP nua — ten SAP co the khong khop voi ten Google that).
				avatarUrl: oResult.body.googlePicture || "",
				avatarInitials: this._computeInitials(oEmployee.Email),
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

			MessageToast.show("Xin chào " + oEmployee.Email);
			this.getOwnerComponent().getRouter().navTo("dashboard");
		},

		// Lay 2 ky tu dau cua phan truoc @ trong email lam initials cho
		// sap.m.Avatar khi khong co anh Google — VD "requestersu26@gmail.com" -> "RE".
		_computeInitials: function (sEmail) {
			var sLocal = String(sEmail || "").split("@")[0];
			return sLocal.slice(0, 2).toUpperCase();
		}
	});
});
