sap.ui.define([
	"sap/ui/core/mvc/Controller",
	"sap/ui/model/json/JSONModel",
	"sap/ui/core/format/NumberFormat",
	"com/qdavy/procurement/model/Config"
], function (Controller, JSONModel, NumberFormat, Config) {
	"use strict";

	var BACKEND = Config.BACKEND;

	// Bao nhieu tile moi role duoc thay — dung de hien empty state khi = 0.
	// Phai khop voi dieu kien visible trong Dashboard.view.xml.
	var TILES_BY_ROLE = {
		REQUESTER:  ["pr01", "report"],
		PURCHASING: ["pr02", "po01", "report"],
		CFO:        ["pr02", "report"],
		CEO:        ["pr02", "report", "config"],
		ACC:        ["report"]
	};

	var oValueFormat = NumberFormat.getIntegerInstance({
		groupingEnabled: true,
		groupingSeparator: "."
	});

	return Controller.extend("com.qdavy.procurement.controller.Dashboard", {

		onInit: function () {
			this.getView().setModel(new JSONModel({
				greeting: this._buildGreeting(),
				pendingCount: "–",
				approvedCount: "–",
				pendingValueText: "–",
				tileCount: 1   // gia dinh co tile, tinh lai o onRouteMatched
			}), "dash");

			// Route matched: moi lan quay ve dashboard deu load lai so lieu,
			// vi user co the vua duyet/tao PR o man khac.
			this.getOwnerComponent().getRouter()
				.getRoute("dashboard")
				.attachPatternMatched(this._onRouteMatched, this);
		},

		_onRouteMatched: function () {
			var sRole = this.getOwnerComponent().getModel("user").getProperty("/role");
			var aTiles = TILES_BY_ROLE[sRole] || [];
			this.getView().getModel("dash").setProperty("/tileCount", aTiles.length);
			this.getView().getModel("dash").setProperty("/greeting", this._buildGreeting());
			this._loadStats();
		},

		// Chao theo buoi trong ngay — nho nhung lam giao dien co "hoi nguoi"
		_buildGreeting: function () {
			var iHour = new Date().getHours();
			if (iHour < 11) { return "Chào buổi sáng"; }
			if (iHour < 14) { return "Chào buổi trưa"; }
			if (iHour < 18) { return "Chào buổi chiều"; }
			return "Chào buổi tối";
		},

		_loadStats: function () {
			var oModel = this.getView().getModel("dash");

			Promise.all([
				fetch(BACKEND + "/api/approval/pending").then(function (r) { return r.json(); }),
				fetch(BACKEND + "/api/approval/approved").then(function (r) { return r.json(); })
			])
				.then(function (aResults) {
					var aPending  = (aResults[0] && aResults[0].data) || [];
					var aApproved = (aResults[1] && aResults[1].data) || [];

					var fTotal = aPending.reduce(function (sum, pr) {
						return sum + (Number(pr.TotalValue) || 0);
					}, 0);

					oModel.setProperty("/pendingCount", String(aPending.length));
					oModel.setProperty("/approvedCount", String(aApproved.length));
					oModel.setProperty("/pendingValueText", this._formatCompact(fTotal));
				}.bind(this))
				.catch(function () {
					// Backend chua chay — hien dau gach thay vi de trong hoac bao loi om som
					oModel.setProperty("/pendingCount", "–");
					oModel.setProperty("/approvedCount", "–");
					oModel.setProperty("/pendingValueText", "–");
				});
		},

		// 55.000.000 -> "55,0 tr" ; 1.200.000.000 -> "1,20 tỷ"
		_formatCompact: function (fValue) {
			if (!fValue) { return "0"; }
			if (fValue >= 1000000000) {
				return (fValue / 1000000000).toFixed(2).replace(".", ",") + " tỷ";
			}
			if (fValue >= 1000000) {
				return (fValue / 1000000).toFixed(1).replace(".", ",") + " tr";
			}
			return oValueFormat.format(fValue);
		},

		onRefreshStats: function () {
			this._loadStats();
		},

		onNavToPR01: function () {
			this.getOwnerComponent().getRouter().navTo("pr01");
		},

		onNavToPR02: function () {
			this.getOwnerComponent().getRouter().navTo("pr02");
		},

		onNavToPO01: function () {
			this.getOwnerComponent().getRouter().navTo("po01");
		},

		onNavToThresholdConfig: function () {
			this.getOwnerComponent().getRouter().navTo("thresholdConfig");
		},

		onNavToPOReport: function () {
			this.getOwnerComponent().getRouter().navTo("poReport");
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
