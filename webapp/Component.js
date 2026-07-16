sap.ui.define([
	"sap/ui/core/UIComponent",
	"sap/ui/model/json/JSONModel"
], function (UIComponent, JSONModel) {
	"use strict";

	// Cac route can dang nhap moi vao duoc - go thang URL (VD #/create-po) khi chua login
	// se bi day nguoc ve man Login.
	var PROTECTED_ROUTES = ["dashboard", "pr01", "pr02", "po01"];

	return UIComponent.extend("com.qdavy.procurement.Component", {
		metadata: {
			manifest: "json"
		},

		init: function () {
			UIComponent.prototype.init.apply(this, arguments);

			this.setModel(new JSONModel({
				email: "",
				fullName: "",
				pernr: "",
				role: "",
				position: "",
				costCenter: "",
				isLoggedIn: false
			}), "user");

			this.getRouter().attachRouteMatched(this._onRouteMatched, this);
			this.getRouter().initialize();
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
