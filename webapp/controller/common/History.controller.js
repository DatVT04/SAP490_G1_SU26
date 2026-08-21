sap.ui.define([
	"sap/ui/core/mvc/Controller",
	"sap/ui/model/json/JSONModel",
	"sap/ui/model/Filter",
	"sap/ui/core/format/NumberFormat",
	"sap/m/MessageBox",
	"com/qdavy/procurement/model/Config"
], function (Controller, JSONModel, Filter, NumberFormat, MessageBox, Config) {
	"use strict";

	var BACKEND = Config.BACKEND;
	var oMoneyFormat = NumberFormat.getFloatInstance({
		groupingEnabled: true,
		groupingSeparator: ".",
		decimalSeparator: ",",
		maxFractionDigits: 0
	});

	var VN_CC = {
		"CCOPS": "Phòng Vận hành",
		"CCBUS": "Phòng Kinh doanh",
		"CCFIN": "Phòng Tài chính",
		"CCHR": "Phòng Nhân sự",
		"CCIT": "Phòng CNTT",
		"CCADM": "Phòng Hành chính",
		"CCPUR": "Phòng Mua hàng",
		"CCTECH": "Phòng Công nghệ",
		"CCTEC": "Phòng Công nghệ"
	};

	return Controller.extend("com.qdavy.procurement.controller.common.History", {

		onInit: function () {
			this._ccToIOs = {};
			this._ioToCC = {};

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

			this._loadCcIoMaps();

			this.getOwnerComponent().getRouter()
				.getRoute("history")
				.attachPatternMatched(this._onRouteMatched, this);
		},

		_onRouteMatched: function () {
			// 21/08/2026: ACC khong con man nao tren app (lam viec trong SAP GUI).
			// Chan ca duong go thang #/history tren thanh dia chi, khong chi an tile.
			var sRole = String(this.getOwnerComponent().getModel("user").getProperty("/role") || "").toUpperCase();
			if (sRole === "ACC") {
				this.getOwnerComponent().getRouter().navTo("dashboard");
				return;
			}
			this._loadHistory();
		},

		/** Map CC ↔ IO để hiển thị cặp đủ hai cột */
		_loadCcIoMaps: function () {
			var that = this;
			fetch(BACKEND + "/api/internal-orders")
				.then(function (r) { return r.json(); })
				.then(function (res) {
					if (!res || !res.success) { return; }
					that._ccToIOs = res.costCenterToIOs || {};
					that._ioToCC = res.ioToCostCenter || {};
					(res.data || []).forEach(function (io) {
						var sIO = String(io.InternalOrder || "").trim();
						var sCC = String(io.CostCenter || "").trim();
						if (!sIO || !sCC) { return; }
						that._ioToCC[sIO] = sCC;
						if (!that._ccToIOs[sCC]) { that._ccToIOs[sCC] = []; }
						if (that._ccToIOs[sCC].indexOf(sIO) === -1) {
							that._ccToIOs[sCC].push(sIO);
						}
					});
					var oModel = that.getView().getModel("hist");
					if (oModel) { oModel.refresh(true); }
				})
				.catch(function () { /* ignore */ });
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
				oModel.setProperty("/pendingTitle", "Đề nghị chờ CFO phê duyệt");
				oModel.setProperty("/historyTitle", "Đã xử lý (CFO)");
			} else if (sRole === "CEO") {
				oModel.setProperty("/pageTitle", "CEO — Pending & History");
				oModel.setProperty("/pendingTitle", "Đề nghị chờ CEO phê duyệt");
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
					MessageBox.error("Không tải được lịch sử đề nghị mua sắm. Vui lòng thử lại.");
				});
		},

		onRefresh: function () {
			this._loadCcIoMaps();
			this._loadHistory();
		},

		onSearch: function (oEvent) {
			var sQuery = (oEvent.getParameter("newValue") || "").trim().toLowerCase();
			var that = this;

			function matchRow(oCtx) {
				if (!sQuery) { return true; }
				var o = oCtx.getObject() || {};
				var sPR = String(o.PRId || "") + " " + String(o.SapPRId || "");
				var sEmail = String(o.RequesterEmail || "");
				var sCC = that.formatCostCenters(o).toLowerCase();
				var sIO = that.formatInternalOrders(o).toLowerCase();
				return (sPR + " " + sEmail + " " + sCC + " " + sIO).toLowerCase().indexOf(sQuery) !== -1;
			}

			var aFilters = sQuery ? [new Filter({ path: "", test: matchRow })] : [];

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

		_getItems: function (oPR) {
			if (!oPR) { return []; }
			if (Array.isArray(oPR.items)) { return oPR.items; }
			if (Array.isArray(oPR.Items)) { return oPR.Items; }
			if (Array.isArray(oPR.to_Items)) { return oPR.to_Items; }
			return [];
		},

		/** Thu thập cặp CC+IO, thiếu bên nào thì suy từ map */
		_collectPairs: function (oPR) {
			var aItems = this._getItems(oPR);
			var aPairs = [];
			var that = this;

			function add(sCC, sIO) {
				sCC = String(sCC || "").trim();
				sIO = String(sIO || "").trim();
				if (sCC && !sIO) {
					var a = that._ccToIOs[sCC] || [];
					sIO = a.length ? String(a[0]) : "";
				}
				if (sIO && !sCC) {
					sCC = String(that._ioToCC[sIO] || "").trim();
				}
				if (!sCC && !sIO) { return; }
				aPairs.push({ cc: sCC, io: sIO });
			}

			aItems.forEach(function (it) {
				if (!it) { return; }
				add(
					it.CostCenter || it.costCenter || it.Kostl,
					it.InternalOrder || it.internalOrder || it.Aufnr || it.OrderNo
				);
			});

			if (aPairs.length === 0 && oPR) {
				add(oPR.CostCenter || oPR.costCenter, oPR.InternalOrder || oPR.internalOrder);
			}

			var seen = {};
			return aPairs.filter(function (p) {
				var k = p.cc + "|" + p.io;
				if (seen[k]) { return false; }
				seen[k] = true;
				return true;
			});
		},

		formatCostCenters: function (oPR) {
			var a = this._collectPairs(oPR);
			if (!a.length) { return "—"; }
			var aOut = [];
			var seen = {};
			a.forEach(function (p) {
				if (!p.cc || seen[p.cc]) { return; }
				seen[p.cc] = true;
				aOut.push(VN_CC[p.cc] || p.cc);
			});
			return aOut.length ? aOut.join(", ") : "—";
		},

		formatInternalOrders: function (oPR) {
			var a = this._collectPairs(oPR);
			if (!a.length) { return "—"; }
			var aOut = [];
			var seen = {};
			a.forEach(function (p) {
				if (!p.io || seen[p.io]) { return; }
				seen[p.io] = true;
				aOut.push(p.io);
			});
			return aOut.length ? aOut.join(", ") : "—";
		},

		formatStatus: function (s) {
			s = String(s || "").toUpperCase();
			var map = {
				PENDING_PURCHASING: "Chờ Purchasing",
				PENDING_RFQ: "Đã duyệt hợp lệ — chờ hỏi giá (RFQ)",
				RFQ_SENT: "Đã gửi RFQ, chờ báo giá",
				QUOTATIONS_RECEIVED: "Đã có báo giá",
				AWARDED: "Đã chốt nhà cung cấp (luồng cũ)",
				PENDING_CFO: "Chờ CFO phê duyệt",
				PENDING_CEO: "Chờ CEO phê duyệt",
				APPROVED: "Đã duyệt — chờ tạo đơn hàng",
				REJECTED: "Từ chối — có thể lập lại",
				RETURNED: "Bị trả lại (luồng cũ)",
				CANCELLED: "Đã hủy (luồng cũ)",
				PO_CREATED: "Đã tạo đơn hàng và gửi nhà cung cấp",
				PO_RELEASED: "Đơn hàng đã duyệt và gửi nhà cung cấp",
				PO_REJECTED: "PO bị từ chối",
				OPENED: "Đã mở",
				OPEN: "Mở"
			};
			return map[s] || s;
		},

		formatStatusState: function (s) {
			s = String(s || "").toUpperCase();
			if (s === "APPROVED" || s === "OPENED" || s === "OPEN" || s === "PO_CREATED" || s === "PO_RELEASED") { return "Success"; }
			if (s === "REJECTED" || s === "RETURNED" || s === "PO_REJECTED") { return "Error"; }
			if (s === "CANCELLED") { return "None"; }
			if (s === "RFQ_SENT" || s === "QUOTATIONS_RECEIVED" || s === "AWARDED") { return "Warning"; }
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