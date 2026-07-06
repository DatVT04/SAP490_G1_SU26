sap.ui.define([
	"sap/ui/core/mvc/Controller"
], function (Controller) {
	"use strict";

	return Controller.extend("com.qdavy.procurement.controller.Dashboard", {
		onInit: function () {},

		onNavToPR01: function () {
			this.getOwnerComponent().getRouter().navTo("pr01");
		},

		onNavToPR02: function () {
			this.getOwnerComponent().getRouter().navTo("pr02");
		},

		onNavToPO01: function () {
			this.getOwnerComponent().getRouter().navTo("po01");
		},

		onLogoutPress: function () {
			var oUserModel = this.getOwnerComponent().getModel("user");
			oUserModel.setData({
				email: "",
				fullName: "",
				pernr: "",
				role: "",
				position: "",
				costCenter: "",
				isLoggedIn: false
			});
			this.getOwnerComponent().getRouter().navTo("login");
		}
	});
});
