sap.ui.define([
	"sap/ui/core/mvc/Controller",
	"sap/ui/model/json/JSONModel",
	"sap/ui/model/Filter",
	"sap/ui/model/FilterOperator",
	"sap/ui/core/format/NumberFormat",
	"sap/m/MessageBox",
	"com/qdavy/procurement/model/Config"
], function (Controller, JSONModel, Filter, FilterOperator, NumberFormat, MessageBox, Config) {
	"use strict";

	var BACKEND = Config.BACKEND;
	var oMoneyFormat = NumberFormat.getFloatInstance({
		groupingEnabled: true,
		groupingSeparator: ".",
		decimalSeparator: ",",
		maxFractionDigits: 0
	});

	return Controller.extend("com.qdavy.procurement.controller.common.History", {

		onInit: function () {
			this.getView().setModel(new JSONModel({
				pageTitle: "Lịch sử đề nghị",
				pendingTitle: "Đang chờ xử lý",
				historyTitle: "Lịch sử đã xử lý",
				pendingCountText: "0",
				historyCountText: "0",
				showPending: false,
				pending: [],
				history: [],
				busy: false
			}), "hist");

			this.getOwnerComponent().getRouter()
				.getRoute("history")
				.attachPatternMatched(this._onRouteMatched, this);
		},

		_onRouteMatched: function () {
			this._loadHistory();
		},

		_loadHistory: function () {
			var oUser = this.getOwnerComponent().getModel("user").getData() || {};
			var oModel = this.getView().getModel("hist");
			var sEmail = oUser.email || "";
			var sRole = String(oUser.role || "").toUpperCase();

			if (!sEmail) {
				oModel.setProperty("/pending", []);
				oModel.setProperty("/history", []);
				return;
			}

			oModel.setProperty("/busy", true);

			var bApprover = (sRole === "PURCHASING" || sRole === "CFO" || sRole === "CEO");
			oModel.setProperty("/showPending", bApprover);

			if (sRole === "REQUESTER") {
				oModel.setProperty("/pageTitle", "Lịch sử đề nghị của tôi");
				oModel.setProperty("/historyTitle", "Toàn bộ đề nghị đã tạo");
			} else if (sRole === "PURCHASING") {
				oModel.setProperty("/pageTitle", "Purchasing — Pending & History");
				oModel.setProperty("/pendingTitle", "Chờ Purchasing duyệt");
				oModel.setProperty("/historyTitle", "Đã xử lý (Purchasing)");
			} else if (sRole === "CFO") {
				oModel.setProperty("/pageTitle", "CFO — Pending & History");
				oModel.setProperty("/pendingTitle", "Chờ CFO duyệt");
				oModel.setProperty("/historyTitle", "Đã xử lý (CFO)");
			} else if (sRole === "CEO") {
				oModel.setProperty("/pageTitle", "CEO — Pending & History");
				oModel.setProperty("/pendingTitle", "Chờ CEO duyệt");
				oModel.setProperty("/historyTitle", "Đã xử lý (CEO)");
			} else {
				oModel.setProperty("/pageTitle", "Lịch sử đề nghị");
				oModel.setProperty("/historyTitle", "Đã duyệt / Từ chối");
			}

			var sUrl = BACKEND + "/api/approval/history"
				+ "?email=" + encodeURIComponent(sEmail)
				+ "&role=" + encodeURIComponent(sRole);

			fetch(sUrl)
				.then(function (r) { return r.json(); })
				.then(function (oResult) {
					oModel.setProperty("/busy", false);
					var aPending = (oResult && oResult.pending) ? oResult.pending : [];
					var aHistory = (oResult && oResult.history) ? oResult.history : [];

					oModel.setProperty("/pending", aPending);
					oModel.setProperty("/history", aHistory);
					oModel.setProperty("/pendingCountText", aPending.length + " đề nghị");
					oModel.setProperty("/historyCountText", aHistory.length + " đề nghị");
				})
				.catch(function () {
					oModel.setProperty("/busy", false);
					oModel.setProperty("/pending", []);
					oModel.setProperty("/history", []);
					oModel.setProperty("/pendingCountText", "0 đề nghị");
					oModel.setProperty("/historyCountText", "0 đề nghị");
					MessageBox.error("Không tải được lịch sử đề nghị.");
				});
		},

		onRefresh: function () {
			this._loadHistory();
		},

		onSearch: function (oEvent) {
			var sQuery = (oEvent.getParameter("newValue") || "").trim();
			var aFilters = [];

			if (sQuery) {
				aFilters = [
					new Filter({
						filters: [
							new Filter("PRId", FilterOperator.Contains, sQuery),
							new Filter("SapPRId", FilterOperator.Contains, sQuery),
							new Filter("RequesterEmail", FilterOperator.Contains, sQuery)
						],
						and: false
					})
				];
			}

			var oPending = this.byId("pendingTable");
			if (oPending && oPending.getBinding("items")) {
				oPending.getBinding("items").filter(aFilters);
			}
			var oHistory = this.byId("historyTable");
			if (oHistory && oHistory.getBinding("items")) {
				oHistory.getBinding("items").filter(aFilters);
			}
		},

		onItemPress: function (oEvent) {
			var oCtx = oEvent.getSource().getBindingContext("hist");
			if (!oCtx) { return; }
			var oItem = oCtx.getObject();
			if (!oItem) { return; }

			var sPrId = oItem.PRId || oItem.InternalId || oItem.SapPRId;
			if (sPrId) {
				this.getOwnerComponent().getRouter().navTo("prdetail", { prId: sPrId });
			}
		},

		formatStatus: function (s) {
			s = String(s || "").toUpperCase();
			var map = {
				PENDING_PURCHASING: "Chờ Purchasing",
				PENDING_RFQ: "Đã duyệt hợp lệ — chờ hỏi giá (RFQ)",
				RFQ_SENT: "Đã gửi RFQ, chờ báo giá",
				QUOTATIONS_RECEIVED: "Đã có báo giá",
				PENDING_CFO: "Chờ CFO",
				PENDING_CEO: "Chờ CEO",
				APPROVED: "Đã duyệt",
				REJECTED: "Từ chối",
				RETURNED: "Bị trả lại — cần sửa & gửi lại",
				CANCELLED: "Đã hủy (đã gửi lại bản mới)",
				PO_CREATED: "Đã tạo PO",
				OPENED: "Đã mở",
				OPEN: "Mở"
			};
			return map[s] || s;
		},

		formatStatusState: function (s) {
			s = String(s || "").toUpperCase();
			if (s === "APPROVED" || s === "OPENED" || s === "OPEN" || s === "PO_CREATED") { return "Success"; }
			if (s === "REJECTED") { return "Error"; }
			if (s === "RETURNED") { return "Error"; }
			if (s === "CANCELLED") { return "None"; }
			if (s === "RFQ_SENT" || s === "QUOTATIONS_RECEIVED") { return "Warning"; }
			if (s.indexOf("PENDING") === 0) { return "Warning"; }
			return "None";
		},

		formatMoney: function (v) {
			return oMoneyFormat.format(Number(v) || 0);
		},

		formatDate: function (sIso) {
			if (!sIso) { return "—"; }
			try {
				return new Date(sIso).toLocaleString("vi-VN");
			} catch (e) {
				return sIso;
			}
		},

		onNavBack: function () {
			this.getOwnerComponent().getRouter().navTo("dashboard");
		}
	});
});