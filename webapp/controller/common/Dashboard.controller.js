sap.ui.define([
	"sap/ui/core/mvc/Controller",
	"sap/ui/model/json/JSONModel",
	"sap/ui/core/format/NumberFormat",
	"sap/m/MessageBox",
	"sap/m/MessageToast",
	"com/qdavy/procurement/model/Config",
	"com/qdavy/procurement/model/Session"
], function (Controller, JSONModel, NumberFormat, MessageBox, MessageToast, Config, Session) {
	"use strict";

	var BACKEND = Config.BACKEND;

	// Man "Bao cao tien do PO" (POReport) da bi XOA HAN ngay 15/08/2026: view va controller
	// la 2 phien ban lech nhau (6 o KPI la so cung trong XML, 3 bieu do va bang khong bind
	// dung model, 8 handler view goi khong ton tai trong controller) nen man do chua bao gio
	// chay dung. Tien trinh cua PR xem o "Lich su de nghi" (History + timeline PRDetail).
	// Can lay lai thi checkout tu git truoc commit nay.
	// 21/08/2026: CFO/CEO duyet DE NGHI o man PO-02 (sau khi chot NCC, truoc khi tao PO).
	var TILES_BY_ROLE = {
		REQUESTER:  ["pr01", "history"],
		PURCHASING: ["materialCreate", "pr02", "rfq01", "rfq02", "po01", "assetAssign", "history"],
		CFO:        ["po02", "history"],
		CEO:        ["po02", "config", "history"],
		// 21/08/2026: ACC KHONG co man nao tren web. Theo luong cua nhom, ke toan
		// lam viec truc tiep trong SAP GUI (MIGO nhan hang, MIRO kiem hoa don) —
		// khong phai chua kip lam man cho ho, ma la co y khong lam.
		ACC:        []
	};

	var oValueFormat = NumberFormat.getIntegerInstance({
		groupingEnabled: true,
		groupingSeparator: "."
	});

	return Controller.extend("com.qdavy.procurement.controller.common.Dashboard", {

		onInit: function () {
			this.getView().setModel(new JSONModel({
				greeting: this._buildGreeting(),
				pendingCount: "–",
				approvedCount: "–",
				pendingValueText: "–",
				pendingValueUnit: "VND",
				kpiPendingLabel: "PR chờ duyệt",
				kpiApprovedLabel: "PR đã duyệt",
				kpiValueLabel: "Giá trị chờ duyệt",
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
			if (sRole === "CFO" || sRole === "CEO") {
				// Hang cho cua CFO/CEO gio la DON HANG cho duyet (PO-02).
				oRouter.navTo("po02");
				return;
			}
			oRouter.navTo(bApprover ? "pr02" : "history");
		},

		_onRouteMatched: function () {
			var sRole = this.getOwnerComponent().getModel("user").getProperty("/role");
			var oModel = this.getView().getModel("dash");
			var aTiles = TILES_BY_ROLE[sRole] || [];
			oModel.setProperty("/tileCount", aTiles.length);
			oModel.setProperty("/greeting", this._buildGreeting());

			// Nhan KPI noi dung ro dem cai gi theo tung vai tro — de con so tren the
			// khop voi man hinh mo ra khi bam (feedback 14/08).
			var sUpper = String(sRole || "").toUpperCase();
			if (sUpper === "PURCHASING") {
				oModel.setProperty("/kpiPendingLabel", "PR chờ tôi duyệt");
				oModel.setProperty("/kpiApprovedLabel", "Đã chốt nhà cung cấp — chờ tạo đơn hàng");
				oModel.setProperty("/kpiValueLabel", "Giá trị chờ duyệt");
			} else if (sUpper === "CFO" || sUpper === "CEO") {
				oModel.setProperty("/kpiPendingLabel", "Đề nghị chờ tôi duyệt");
				oModel.setProperty("/kpiApprovedLabel", "PR tôi đã xử lý");
				oModel.setProperty("/kpiValueLabel", "Giá trị chờ duyệt");
			} else {
				oModel.setProperty("/kpiPendingLabel", "Đề nghị của tôi đang xử lý");
				oModel.setProperty("/kpiApprovedLabel", "Đề nghị của tôi đã duyệt");
				oModel.setProperty("/kpiValueLabel", "Giá trị đang chờ của tôi");
			}

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

		// ============================================================
		// KPI phai khop DUNG voi danh sach ma the do dan toi khi bam
		// (feedback 14/08: "cac con so dang sai — link vao thi phai
		// the hien dung con so cua trang thai do").
		// - PURCHASING: cho duyet = hang cho cua PR-02, da duyet = danh
		//   sach cho tao PO cua PO-01.
		// - CFO/CEO:    cho duyet = hang cho cua PR-02, "da xu ly" = so
		//   PR chinh ho da quyet (tab lich su cua ho).
		// - REQUESTER/ACC: chi tinh PR CUA CHINH HO (truoc day dem toan
		//   he thong nen hien ca PR test 1.000 USD cua nguoi khac).
		// ============================================================
		_loadStats: function () {
			var oModel = this.getView().getModel("dash");
			var oUser = this.getOwnerComponent().getModel("user").getData() || {};
			var sRole = String(oUser.role || "").toUpperCase();

			// ACC khong hien khoi KPI nao (xem Dashboard.view.xml) — goi API chi ton
			// mot vong tuong tac voi SAP roi vut ket qua di.
			if (sRole === "ACC") { return; }

			// Trang thai "dang xu ly" tren duong di cua 1 PR (chua ket thuc)
			var A_INFLIGHT = ["PENDING_PURCHASING", "PENDING_RFQ", "RFQ_SENT", "QUOTATIONS_RECEIVED", "PENDING_CFO", "PENDING_CEO"];
			var A_DONE_OK = ["APPROVED", "PO_CREATED", "OPENED", "OPEN"];

			var fnFail = function () {
				oModel.setProperty("/pendingCount", "–");
				oModel.setProperty("/approvedCount", "–");
				oModel.setProperty("/pendingValueText", "–");
				oModel.setProperty("/pendingValueUnit", "VND");
			};

			if (sRole === "PURCHASING" || sRole === "CFO" || sRole === "CEO") {
				var aRequests = [
					fetch(BACKEND + "/api/approval/pending?role=" + encodeURIComponent(sRole))
						.then(function (r) { return r.json(); })
				];
				if (sRole === "PURCHASING") {
					// KPI2 = dung danh sach PO-01 dang doc (APPROVED cho tao PO)
					aRequests.push(fetch(BACKEND + "/api/approval/approved").then(function (r) { return r.json(); }));
				} else {
					// KPI2 cua CFO/CEO = so PR chinh ho DA XU LY (khop tab lich su cua ho)
					aRequests.push(
						fetch(BACKEND + "/api/approval/history?email=" + encodeURIComponent(oUser.email || "")
							+ "&role=" + encodeURIComponent(sRole))
							.then(function (r) { return r.json(); })
					);
				}

				Promise.all(aRequests)
					.then(function (aResults) {
						var aPending = (aResults[0] && aResults[0].data) || [];
						var iSecond = sRole === "PURCHASING"
							? ((aResults[1] && aResults[1].data) || []).length
							: ((aResults[1] && aResults[1].history) || []).length;

						oModel.setProperty("/pendingCount", String(aPending.length));
						oModel.setProperty("/approvedCount", String(iSecond));
						this._setPendingValue(aPending);
					}.bind(this))
					.catch(fnFail);
				return;
			}

			// REQUESTER / ACC: dem tren dung nguon cua man "Lich su de nghi"
			// (/api/approval/history) — voi requester la PR cua chinh ho.
			fetch(BACKEND + "/api/approval/history?email=" + encodeURIComponent(oUser.email || "")
				+ "&role=" + encodeURIComponent(sRole || "REQUESTER"))
				.then(function (r) { return r.json(); })
				.then(function (oResult) {
					var aAll = ((oResult && oResult.history) || []).concat((oResult && oResult.pending) || []);
					var aInflight = aAll.filter(function (pr) {
						return A_INFLIGHT.indexOf(String(pr.Status || "").toUpperCase()) !== -1;
					});
					var aDone = aAll.filter(function (pr) {
						return A_DONE_OK.indexOf(String(pr.Status || "").toUpperCase()) !== -1;
					});

					oModel.setProperty("/pendingCount", String(aInflight.length));
					oModel.setProperty("/approvedCount", String(aDone.length));
					this._setPendingValue(aInflight);
				}.bind(this))
				.catch(fnFail);
		},

		// Tong gia tri cua danh sach dang cho — cong don RIENG theo tung loai tien
		// (truoc day cong thang bat ke Currency nen 1.000 USD hien thanh "1.000 VND").
		_setPendingValue: function (aPending) {
			var oModel = this.getView().getModel("dash");
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
				sText = aCurrencies.map(function (sCur) {
					return this._formatCompact(oTotals[sCur]) + " " + sCur;
				}.bind(this)).join(" · ");
				sUnit = "theo từng loại tiền";
			}
			oModel.setProperty("/pendingValueText", sText);
			oModel.setProperty("/pendingValueUnit", sUnit);
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
				MessageToast.show("Không có thông báo chưa đọc.");
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
				MessageToast.show("Đã đánh dấu tất cả thông báo là đã đọc.");
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

		onNavToPO02: function () {
			this.getOwnerComponent().getRouter().navTo("po02");
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

		onNavToAssetAssign: function () {
			this.getOwnerComponent().getRouter().navTo("assetAssign");
		},

		onNavToThresholdConfig: function () {
			this.getOwnerComponent().getRouter().navTo("thresholdConfig");
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
			// Xoa token khoi sessionStorage. Neu khong xoa, bam F5 ngay sau khi Dang
			// xuat se khoi phuc lai dung cai phien vua thoat.
			Session.clear();
			this.getOwnerComponent().getModel("user").setData(Session.emptyUser());

			this.getOwnerComponent().getRouter().navTo("login");
		}
	});
});