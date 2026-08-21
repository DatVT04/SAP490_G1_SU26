sap.ui.define([
	"com/qdavy/procurement/model/Config"
], function (Config) {
	"use strict";

	/**
	 * Quan ly phien dang nhap phia frontend.
	 *
	 * VAN DE (truoc 21/08/2026): trang thai dang nhap chi nam trong model "user" cua
	 * Component, ma Component duoc dung lai tu dau moi lan trinh duyet load trang ->
	 * bam F5 la mat sach, route guard day nguoc ve man Login.
	 *
	 * CACH GIAI QUYET: luu lai DUY NHAT chuoi ID token do Google ky so. KHONG luu
	 * email/role/pernr, vi nhung thu do sua duoc bang DevTools trong 5 giay; con token
	 * thi khong sua duoc (doi 1 ky tu la chu ky hong, backend loai ngay). Moi lan F5,
	 * Component cam token nay hoi lai POST /api/login/google -- endpoint DA CO SAN,
	 * khong sua gi ben backend -- de backend tu xac minh chu ky + audience voi Google
	 * roi doi chieu email voi SAP. Vai tro (role) luon lay tu SAP, khong bao gio tu
	 * trinh duyet.
	 *
	 * HAN CHE DA BIET: Google ID token chi song 1 gio. Qua 1 gio ma F5 thi backend tra
	 * 401, module nay xoa token va nguoi dung phai bam dang nhap lai. Muon het han che
	 * nay thi bat auto_select cua Google Identity Services (xem ghi chu trong
	 * Login.controller.js) -- chua lam.
	 */

	// sessionStorage (khong phai localStorage): dong tab la het phien, dung dung y nghia
	// "phien lam viec". Mo tab moi thi dang nhap lai.
	var STORAGE_KEY = "qdavy.googleCredential";

	// sessionStorage nem exception trong vai truong hop (che do rieng tu cua Safari cu,
	// trinh duyet chan luu tru cho site) -> boc try/catch de app van chay binh thuong,
	// chi la mat tinh nang nho phien chu khong trang trang.
	function _read() {
		try {
			return window.sessionStorage.getItem(STORAGE_KEY);
		} catch (e) {
			return null;
		}
	}

	function _write(sValue) {
		try {
			window.sessionStorage.setItem(STORAGE_KEY, sValue);
		} catch (e) {
			// Bo qua: khong luu duoc thi hanh vi quay ve nhu cu (F5 phai dang nhap lai).
		}
	}

	function _erase() {
		try {
			window.sessionStorage.removeItem(STORAGE_KEY);
		} catch (e) {
			// Bo qua.
		}
	}

	// Lay 2 ky tu dau cua phan truoc @ trong email lam initials cho sap.m.Avatar khi
	// khong co anh Google -- VD "requestersu26@gmail.com" -> "RE". Lay tu EMAIL chu
	// khong tu ten SAP, vi ten SAP co the khong khop voi ten Google that.
	function _initials(sEmail) {
		var sLocal = String(sEmail || "").split("@")[0];
		return sLocal.slice(0, 2).toUpperCase();
	}

	return {

		// Trang thai "chua ai dang nhap". Dung cho ca luc khoi tao Component lan luc
		// bam Dang xuat, de 2 noi khong bi lech field nhu truoc day.
		emptyUser: function () {
			return {
				email: "",
				fullName: "",
				pernr: "",
				role: "",
				position: "",
				costCenter: "",
				avatarUrl: "",
				avatarInitials: "",
				firstName: "",
				lastName: "",
				phoneNumber: "",
				street: "",
				city: "",
				postalCode: "",
				isLoggedIn: false
			};
		},

		// Doi ban ghi nhan vien tra ve tu backend thanh du lieu cho model "user".
		// Dung chung boi ca luc dang nhap lan luc khoi phuc phien sau F5 -> 2 duong
		// khong the lech nhau.
		buildUser: function (oEmployee, sGooglePicture) {
			return {
				email: oEmployee.Email,
				fullName: Config.buildFullName(oEmployee.LastName, oEmployee.FirstName, oEmployee.FullName),
				pernr: oEmployee.Pernr,
				role: oEmployee.Role,
				position: oEmployee.Position,
				costCenter: oEmployee.CostCenter,
				avatarUrl: sGooglePicture || "",
				avatarInitials: _initials(oEmployee.Email),
				firstName: oEmployee.FirstName || "",
				lastName: oEmployee.LastName || "",
				phoneNumber: oEmployee.PhoneNumber || "",
				street: oEmployee.Street || "",
				city: oEmployee.City || "",
				postalCode: oEmployee.PostalCode || "",
				isLoggedIn: true
			};
		},

		hasCredential: function () {
			return !!_read();
		},

		save: function (sCredential) {
			if (sCredential) {
				_write(sCredential);
			}
		},

		clear: function () {
			_erase();
		},

		/**
		 * Khoi phuc phien sau khi load trang.
		 * Tra ve Promise -> du lieu model "user" neu token con hop le, null neu khong.
		 * KHONG BAO GIO reject, de Component cu the goi .then() roi chay tiep.
		 */
		restore: function () {
			var sCredential = _read();
			if (!sCredential) {
				return Promise.resolve(null);
			}

			var that = this;
			return fetch(Config.BACKEND + "/api/login/google", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ credential: sCredential })
			})
				.then(function (oResponse) {
					return oResponse.json();
				})
				.then(function (oData) {
					if (!oData || !oData.success || !oData.employee) {
						// Token het han (qua 1 gio) hoac email da bi khoa trong SAP.
						// Xoa han de lan F5 sau khoi goi mang vo ich.
						_erase();
						return null;
					}
					return that.buildUser(oData.employee, oData.googlePicture);
				})
				.catch(function () {
					// Mat mang / backend chet / SAP khong phan hoi: GIU token lai (khac
					// voi truong hop 401 o tren) de lan F5 sau con thu lai duoc. Lan nay
					// nguoi dung bi day ve man Login.
					return null;
				});
		}
	};
});
