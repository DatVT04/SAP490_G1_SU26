sap.ui.define([
	"sap/ui/core/UIComponent",
	"sap/ui/model/json/JSONModel",
	"sap/ui/core/BusyIndicator",
	"com/qdavy/procurement/model/Session"
], function (UIComponent, JSONModel, BusyIndicator, Session) {
	"use strict";

	// Cac route can dang nhap moi vao duoc - go thang URL (VD #/create-po) khi chua login
	// se bi day nguoc ve man Login.
	// 21/08/2026: bo sung 6 route truoc day bi bo sot (prdetail, history, po02, rfq01,
	// rfq02, assetAssign) - go tay hash cua chung khi chua dang nhap la vao thang duoc,
	// vi chung khong nam trong danh sach nay.
	var PROTECTED_ROUTES = [
		"dashboard", "pr01", "pr02", "prdetail", "history",
		"po01", "po02", "rfq01", "rfq02",
		"thresholdConfig", "assetAssign"
	];

	return UIComponent.extend("com.qdavy.procurement.Component", {
		metadata: {
			manifest: "json"
		},

		init: function () {
			UIComponent.prototype.init.apply(this, arguments);

			this.setModel(new JSONModel(Session.emptyUser()), "user");

			this.getRouter().attachRouteMatched(this._onRouteMatched, this);

			// KHONG goi getRouter().initialize() o day nua. Neu goi ngay, route guard
			// se doc isLoggedIn = false (model vua tao) va da nguoi dung ve man Login
			// truoc khi kip hoi backend xem token con hieu luc khong -> chinh la loi
			// "cu F5 la van ra ngoai". Router chi duoc khoi dong sau khi biet ket qua.
			this._startRouterAfterSessionRestore();
		},

		/**
		 * Khoi phuc phien truoc, roi moi bat router.
		 *
		 * Nguoi chua tung dang nhap (khong co token) -> bat router ngay, khong cho doi,
		 * khong hien busy: trai nghiem vao lan dau y het truoc day.
		 *
		 * Nguoi da dang nhap va vua bam F5 -> hien busy khoang 1 nhip trong luc backend
		 * xac minh token voi Google + doi chieu email voi SAP, sau do model "user" duoc
		 * dien lai va router.initialize() doc hash hien tai de quay ve DUNG man dang xem
		 * truoc khi F5 (VD dang o #/pr02 thi van o #/pr02).
		 *
		 * Co tinh chap nhan phai cho backend tra loi thay vi doc san role tu sessionStorage:
		 * role doc tu trinh duyet la role sua duoc bang DevTools, role tu SAP thi khong.
		 */
		_startRouterAfterSessionRestore: function () {
			var oRouter = this.getRouter();

			if (!Session.hasCredential()) {
				oRouter.initialize();
				return;
			}

			BusyIndicator.show(0);

			Session.restore().then(function (oUser) {
				if (oUser) {
					this.getModel("user").setData(oUser);
				}
				// Khong con token hop le -> model van rong -> guard ben duoi tu day ve
				// Login. Khong can xu ly rieng o day.
				BusyIndicator.hide();
				oRouter.initialize();
			}.bind(this));
		},

		_onRouteMatched: function (oEvent) {
			var sRouteName = oEvent.getParameter("name");
			var bIsLoggedIn = this.getModel("user").getProperty("/isLoggedIn");

			if (PROTECTED_ROUTES.indexOf(sRouteName) !== -1 && !bIsLoggedIn) {
				this.getRouter().navTo("login", {}, true);
			}
		}
	});
});
