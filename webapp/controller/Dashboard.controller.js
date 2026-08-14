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

	// Tile "report" (Bao cao tien do) da go khoi tat ca vai tro: tien trinh cua PR gio
	// nam trong "Lich su de nghi" (man History + PRDetail timeline) nen tile nay trung
	// lap va gay nhieu. View/route poReport van giu nguyen, chi khong hien tren dashboard.
	var TILES_BY_ROLE = {
		REQUESTER:  ["pr01", "history"],
		PURCHASING: ["materialCreate", "pr02", "rfq01", "rfq02", "po01", "history"],
		CFO:        ["pr02", "history"],
		CEO:        ["pr02", "config", "history"],
		ACC:        ["history"]
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
				pendingValueUnit: "VND",
				tileCount: 1,
				notifications: [],
				unreadCount: 0,
				notifBusy: false
			}), "dash");

			this.getOwnerComponent().getRouter()
				.getRoute("dashboard")
				.attachPatternMatched(this._onRouteMatched, this);

			// Loi chao doi theo gio trong ngay — cap nhat lai moi 5 phut de
			// khong bi "dinh" (VD mo tab tu sang, ngoi lam viec toi trua/chieu
			// van thay "Chao buoi sang" vi khong ai bam lai vao Dashboard).
			this._iGreetingInterval = setInterval(function () {
				this.getView().getModel("dash").setProperty("/greeting", this._buildGreeting());
			}.bind(this), 5 * 60 * 1000);
		},

		onExit: function () {
			if (this._iGreetingInterval) {
				clearInterval(this._iGreetingInterval);
			}
		},

		// VBox khong ho tro su kien press nen gan click bang attachBrowserEvent —
		// chi gan 1 lan (onAfterRendering chay lai moi lan re-render).
		onAfterRendering: function () {
			if (this._bKpiWired) { return; }
			this._bKpiWired = true;

			var that = this;
			var oPending = this.byId("kpiPendingCard");
			var oApproved = this.byId("kpiApprovedCard");
			var oValue = this.byId("kpiValueCard");

			if (oPending) { oPending.attachBrowserEvent("click", function () { that._navFromKpi("pending"); }); }
			if (oApproved) { oApproved.attachBrowserEvent("click", function () { that._navFromKpi("approved"); }); }
			if (oValue) { oValue.attachBrowserEvent("click", function () { that._navFromKpi("pending"); }); }
		},

		// Dieu huong theo vai tro: nguoi duyet -> man phe duyet PR-02 / tao PO;
		// requester/ACC khong co quyen PR-02 -> ve Lich su de nghi.
		_navFromKpi: function (sKind) {
			var oRouter = this.getOwnerComponent().getRouter();
			var sRole = String(this.getOwnerComponent().getModel("user").getProperty("/role") || "").toUpperCase();
			var bApprover = sRole === "PURCHASING" || sRole === "CFO" || sRole === "CEO";

			if (sKind === "approved") {
				// PR da duyet: Purchasing tiep tuc tao PO tu day; role khac xem lich su.
				oRouter.navTo(sRole === "PURCHASING" ? "po01" : "history");
				return;
			}
			oRouter.navTo(bApprover ? "pr02" : "history");
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

					// Cong don RIENG theo tung loai tien — truoc day cong thang TotalValue
					// bat ke Currency nen PR 1.000 USD hien thanh "1.000 VND" (feedback
					// QDAVY 13/08: "tien VND vs USD dang khong khop nhau").
					var oTotals = {};
					aPending.forEach(function (pr) {
						var sCur = pr.Currency || "VND";
						oTotals[sCur] = (oTotals[sCur] || 0) + (Number(pr.TotalValue) || 0);
					});

					var aCurrencies = Object.keys(oTotals);
					var sText;
					var sUnit;
					if (aCurrencies.length === 0) {
						sText = "0";
						sUnit = "VND";
					} else if (aCurrencies.length === 1) {
						sText = this._formatCompact(oTotals[aCurrencies[0]]);
						sUnit = aCurrencies[0];
					} else {
						// Nhieu loai tien: khong cong lan vao nhau, hien tung dong tien ro rang
						sText = aCurrencies.map(function (sCur) {
							return this._formatCompact(oTotals[sCur]) + " " + sCur;
						}.bind(this)).join(" · ");
						sUnit = "theo từng loại tiền";
					}

					oModel.setProperty("/pendingCount", String(aPending.length));
					oModel.setProperty("/approvedCount", String(aApproved.length));
					oModel.setProperty("/pendingValueText", sText);
					oModel.setProperty("/pendingValueUnit", sUnit);
				}.bind(this))
				.catch(function () {
					oModel.setProperty("/pendingCount", "–");
					oModel.setProperty("/approvedCount", "–");
					oModel.setProperty("/pendingValueText", "–");
					oModel.setProperty("/pendingValueUnit", "VND");
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

			// Gui kem role de server sinh canh bao "PR treo lau" cho nguoi duyet
			// (Purchasing/CFO/CEO) — xem buildAgingAlerts() phia server.
			fetch(BACKEND + "/api/notifications?email=" + encodeURIComponent(oUser.email)
				+ "&role=" + encodeURIComponent(oUser.role || ""))
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
			// Canh bao aging (id "aging-...") khong nam trong notificationStore —
			// tu tinh lai moi lan tu trang thai PR, xu ly xong PR la tu bien mat,
			// nen khong co gi de PATCH read ca.
			if (String(nId).indexOf("aging-") === 0) { return; }
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
			var aUnread = aList.filter(function (n) { return !n.read && String(n.id).indexOf("aging-") !== 0; });
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

		onNavToMaterialCreate: function () {
			this.getOwnerComponent().getRouter().navTo("materialCreate");
		},

		onNavToPR02: function () {
			this.getOwnerComponent().getRouter().navTo("pr02");
		},

		onNavToPO01: function () {
			this.getOwnerComponent().getRouter().navTo("po01");
		},

		onNavToRFQ01: function () {
			this.getOwnerComponent().getRouter().navTo("rfq01");
		},

		onNavToRFQ02: function () {
			this.getOwnerComponent().getRouter().navTo("rfq02");
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

		onAvatarPress: function (oEvent) {
			if (!this._oUserMenuPopover) {
				this._oUserMenuPopover = this.byId("userMenuPopover");
			}
			this._oUserMenuPopover.openBy(oEvent.getSource());
		},

		onLogoutPress: function () {
			if (this._oUserMenuPopover) {
				this._oUserMenuPopover.close();
			}
			var oUserModel = this.getOwnerComponent().getModel("user");
			oUserModel.setData({
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
			});
			this.getOwnerComponent().getRouter().navTo("login");
		}
	});
});