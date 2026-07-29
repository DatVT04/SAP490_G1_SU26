sap.ui.define([
	"sap/ui/core/mvc/Controller",
	"sap/ui/model/json/JSONModel",
	"sap/ui/core/format/NumberFormat",
	"sap/m/MessageBox",
	"sap/m/MessageToast",
	"com/qdavy/procurement/model/Config"
], function (Controller, JSONModel, NumberFormat, MessageBox, MessageToast, Config) {
	"use strict";

	var BACKEND = Config.BACKEND;

	var TILES_BY_ROLE = {
		REQUESTER:  ["pr01", "report", "history", "profile"],
		PURCHASING: ["pr02", "po01", "report", "history", "profile"],
		CFO:        ["pr02", "report", "history", "profile"],
		CEO:        ["pr02", "report", "config", "history", "profile"],
		ACC:        ["report", "history", "profile"]
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
				tileCount: 1,
				notifications: [],
				unreadCount: 0,
				notifBusy: false
			}), "dash");

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
			this._loadNotifications();
		},

		_buildGreeting: function () {
			var iHour = new Date().getHours();
			if (iHour < 11) { return "Chào buổi sáng"; }
			if (iHour < 14) { return "Chào buổi trưa"; }
			if (iHour < 18) { return "Chào buổi chiều"; }
			return "Chào buổi tối";
		},

		_loadStats: function () {
			var oModel = this.getView().getModel("dash");
			var sRole = String(this.getOwnerComponent().getModel("user").getProperty("/role") || "").toUpperCase();

			var sPendingUrl = BACKEND + "/api/approval/pending";
			if (sRole === "CFO" || sRole === "CEO" || sRole === "PURCHASING") {
				sPendingUrl += "?role=" + encodeURIComponent(sRole);
			}

			Promise.all([
				fetch(sPendingUrl).then(function (r) { return r.json(); }),
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
					oModel.setProperty("/pendingCount", "–");
					oModel.setProperty("/approvedCount", "–");
					oModel.setProperty("/pendingValueText", "–");
				});
		},

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

		_loadNotifications: function () {
			var oUser = this.getOwnerComponent().getModel("user").getData();
			var oModel = this.getView().getModel("dash");
			if (!oUser || !oUser.email) {
				oModel.setProperty("/notifications", []);
				oModel.setProperty("/unreadCount", 0);
				return;
			}

			oModel.setProperty("/notifBusy", true);

			fetch(BACKEND + "/api/notifications?email=" + encodeURIComponent(oUser.email))
				.then(function (r) { return r.json(); })
				.then(function (oResult) {
					oModel.setProperty("/notifBusy", false);
					var aList = (oResult && oResult.success && oResult.data) ? oResult.data : [];
					oModel.setProperty("/notifications", aList);
					var iUnread = aList.filter(function (n) { return !n.read; }).length;
					oModel.setProperty("/unreadCount", iUnread);
				})
				.catch(function () {
					oModel.setProperty("/notifBusy", false);
					oModel.setProperty("/notifications", []);
					oModel.setProperty("/unreadCount", 0);
				});
		},

		onNotifPress: function (oEvent) {
			var oBtn = oEvent.getSource();
			if (!this._oNotifPopover) {
				this._oNotifPopover = this.byId("notifPopover");
			}
			this._loadNotifications();
			this._oNotifPopover.openBy(oBtn);
		},

		onNotifItemPress: function (oEvent) {
			var oItem = oEvent.getSource().getBindingContext("dash").getObject();
			if (!oItem) { return; }

			MessageBox.information(oItem.message, {
				title: "Thông báo — " + (oItem.prId || ""),
				onClose: function () {
					this._markRead(oItem.id);
				}.bind(this)
			});
		},

		_markRead: function (nId) {
			if (!nId) { return; }
			var that = this;
			fetch(BACKEND + "/api/notifications/" + nId + "/read", {
				method: "PATCH",
				headers: { "Content-Type": "application/json" },
				body: "{}"
			})
				.then(function () {
					that._loadNotifications();
				})
				.catch(function () { /* im lang */ });
		},

		onMarkAllRead: function () {
			var aList = this.getView().getModel("dash").getProperty("/notifications") || [];
			var aUnread = aList.filter(function (n) { return !n.read; });
			if (aUnread.length === 0) {
				MessageToast.show("Không còn thông báo chưa đọc.");
				return;
			}
			var that = this;
			Promise.all(aUnread.map(function (n) {
				return fetch(BACKEND + "/api/notifications/" + n.id + "/read", {
					method: "PATCH",
					headers: { "Content-Type": "application/json" },
					body: "{}"
				});
			})).then(function () {
				MessageToast.show("Đã đánh dấu tất cả đã đọc.");
				that._loadNotifications();
			});
		},

		formatNotifTime: function (sIso) {
			if (!sIso) { return ""; }
			try {
				var d = new Date(sIso);
				return d.toLocaleString("vi-VN");
			} catch (e) {
				return sIso;
			}
		},

		onRefreshStats: function () {
			this._loadStats();
			this._loadNotifications();
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

		onNavToHistory: function () {
			this.getOwnerComponent().getRouter().navTo("history");
		},

		onNavToThresholdConfig: function () {
			this.getOwnerComponent().getRouter().navTo("thresholdConfig");
		},

		onNavToPOReport: function () {
			this.getOwnerComponent().getRouter().navTo("poReport");
		},

		onNavToProfile: function () {
			this.getOwnerComponent().getRouter().navTo("profile");
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
				firstName: "",
				lastName: "",
				phoneNumber: "",
				street: "",
				city: "",
				postalCode: "",
				isLoggedIn: false
			});
			this.getOwnerComponent().getRouter().navTo("login");
		}
	});
});