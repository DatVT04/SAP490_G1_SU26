sap.ui.define([
	"sap/ui/core/mvc/Controller",
	"sap/ui/model/json/JSONModel",
	"sap/m/MessageBox",
	"sap/m/MessageToast",
	"sap/ui/model/Filter",
	"sap/ui/model/FilterOperator",
	"com/qdavy/procurement/model/Config"
], function (Controller, JSONModel, MessageBox, MessageToast, Filter, FilterOperator, Config) {
	"use strict";

	var BACKEND = Config.BACKEND;

	return Controller.extend("com.qdavy.procurement.controller.RFQ01", {

		onInit: function () {
			this.getView().setModel(new JSONModel({
				PendingPRs: [],
				Vendors: [],
				aiText: "",
				busyAi: false,
				selectedVendorCount: 0
			}));

			// Hien vong xoay NGAY khi bat busy. Mac dinh UI5 tre 1 giay: trong 1 giay do
			// trang trong nhu binh thuong nhung da bi khoa, nguoi dung bam khong an va
			// tuong la loi giao dien (phai F5). Dat 0 de trang thai cho luon nhin thay duoc.
			this.getView().setBusyIndicatorDelay(0);

			// Khong cho chon Deadline trong qua khu — truoc day DatePicker khong co minDate
			// nen chon duoc ca ngay da qua, chi bi bo lo (khong bao gio ai kiem tra ca FE lan BE).
			var oToday = new Date();
			oToday.setHours(0, 0, 0, 0);
			var oDeadlinePicker = this.getView().byId("dpDeadline");
			oDeadlinePicker.setMinDate(oToday);
			oDeadlinePicker.setBusyIndicatorDelay(0);

			// Goi y san han nop = hom nay + 7 ngay (van sua duoc), do gan nhu lan nao
			// nguoi dung cung phai tu mo lich chon mot ngay trong tuan toi.
			var oDefaultDeadline = new Date(oToday.getTime());
			oDefaultDeadline.setDate(oDefaultDeadline.getDate() + 7);
			oDeadlinePicker.setDateValue(oDefaultDeadline);

			this.getView().byId("pendingPRTable").setBusyIndicatorDelay(0);
			this.getView().byId("vendorTable").setBusyIndicatorDelay(0);

			this._loadPendingPRs();
			this._loadVendors();

			this.getOwnerComponent().getRouter()
				.getRoute("rfq01")
				.attachPatternMatched(this._onRouteMatched, this);
		},

		_onRouteMatched: function () {
			this.getView().byId("rfqCreationArea").setVisible(false);
			this._currentPR = null;
			this.getView().getModel().setProperty("/aiText", "");
			this._loadPendingPRs();
		},

		// ── 1. PR DA DUOC PURCHASING DUYET HOP LE (PENDING_RFQ) — chi trang thai nay
		// moi duoc mo RFQ. (Truoc day lay PENDING_PURCHASING, da doi theo quy trinh moi:
		// Purchasing phai bam Duyet tren PR-02 truoc, PR moi xuat hien o day.) ──
		_loadPendingPRs: function () {
			var oView = this.getView();
			// CHI khoa rieng bang PR, khong khoa ca view: truoc day dung oView.setBusy(true)
			// nen trong suot thoi gian goi API (SAP OData + cold start cua serverless co the
			// vai giay) thi DatePicker va nut "Tao & Gui RFQ" o card 3 cung bi khoa theo,
			// dung dung dan toi trieu chung "bam khong an, phai F5".
			var oTable = oView.byId("pendingPRTable");
			oTable.setBusy(true);

			fetch(BACKEND + "/api/approval/pending?role=PURCHASING&status=PENDING_RFQ")
				.then(function (r) { return r.json(); })
				.then(function (res) {
					oTable.setBusy(false);
					if (res && res.success) {
						// PR da gan RfqId nghia la RFQ da duoc tao roi (dang o buoc gui/nhap
						// bao gia ben RFQ-02) -> khong hien o man tao RFQ nua, tranh tao trung.
						var aMapped = (res.data || []).filter(function (pr) {
							return !pr.RfqId;
						}).map(function (pr) {
							var aItems = pr.items || [];
							var firstItem = aItems[0] || {};
							var sDesc = aItems.length > 1
								? (firstItem.Description || "") + " (+ " + (aItems.length - 1) + " vật tư khác)"
								: (firstItem.Description || "");
							return {
								PRId: pr.PRId || pr.InternalId || "",
								SapPRId: pr.SapPRId || "",
								Description: sDesc,
								RequesterEmail: pr.RequesterEmail || "",
								TotalValue: pr.TotalValue || 0,
								Currency: pr.Currency || "VND",
								_items: aItems
							};
						});
						oView.getModel().setProperty("/PendingPRs", aMapped);
					}
				})
				.catch(function () {
					oTable.setBusy(false);
					MessageToast.show("Không thể lấy danh sách PR từ máy chủ.");
				});
		},

		// ── 2. DANH SACH NCC TU SAP ──
		_loadVendors: function () {
			var oView = this.getView();
			var oTable = oView.byId("vendorTable");
			oTable.setBusy(true);
			fetch(BACKEND + "/api/vendors")
				.then(function (r) { return r.json(); })
				.then(function (res) {
					oTable.setBusy(false);
					if (res && res.success) {
						oView.getModel().setProperty("/Vendors", res.data || []);
					}
				})
				.catch(function () {
					oTable.setBusy(false);
					MessageToast.show("Không tải được danh sách Nhà cung cấp.");
				});
		},

		onVendorSelectionChange: function () {
			var iCount = this.getView().byId("vendorTable").getSelectedItems().length;
			this.getView().getModel().setProperty("/selectedVendorCount", iCount);
		},

		// Tim PR dang cho xu ly theo ma PR / mo ta / email nguoi yeu cau.
		// Loc client tren binding /PendingPRs — khong goi lai SAP.
		onPendingPRSearch: function (oEvent) {
			var sQuery = (oEvent.getParameter("newValue") !== undefined
				? oEvent.getParameter("newValue")
				: oEvent.getParameter("query")) || "";
			var oTable = this.getView().byId("pendingPRTable");
			var oBinding = oTable && oTable.getBinding("items");
			if (!oBinding) { return; }
			if (!sQuery.trim()) {
				oBinding.filter([]);
				return;
			}
			oBinding.filter(new Filter({
				filters: [
					new Filter("PRId", FilterOperator.Contains, sQuery),
					new Filter("Description", FilterOperator.Contains, sQuery),
					new Filter("RequesterEmail", FilterOperator.Contains, sQuery)
				],
				and: false
			}));
		},

		// Loc danh sach NCC theo ma / ten / email — loc phia client tren binding,
		// khong goi lai SAP (feedback QDAVY 13/08: kho tim NCC khi danh sach dai).
		onVendorSearch: function (oEvent) {
			var sQuery = (oEvent.getParameter("newValue") !== undefined
				? oEvent.getParameter("newValue")
				: oEvent.getParameter("query")) || "";
			var oBinding = this.getView().byId("vendorTable").getBinding("items");
			if (!oBinding) { return; }
			if (!sQuery.trim()) {
				oBinding.filter([]);
				return;
			}
			oBinding.filter(new Filter({
				filters: [
					new Filter("VendorNo", FilterOperator.Contains, sQuery),
					new Filter("VendorName", FilterOperator.Contains, sQuery),
					new Filter("Email", FilterOperator.Contains, sQuery)
				],
				and: false
			}));
		},

		// NCC vua duoc tao them tren SAP (BP/XK01) -> tai lai ma khong can F5 ca trang.
		onReloadVendorsPress: function () {
			this._loadVendors();
			MessageToast.show("Đang tải lại danh sách Nhà cung cấp từ SAP...");
		},

		onPRSelect: function (oEvent) {
			var oSelectedItem = oEvent.getParameter("listItem");
			if (!oSelectedItem) { return; }
			var oContext = oSelectedItem.getBindingContext();
			var oPRData = oContext ? oContext.getObject() : null;
			if (!oPRData) { return; }

			this._currentPR = oPRData;
			this.getView().byId("rfqCreationArea").setVisible(true);
			this.getView().getModel().setProperty("/aiText", "");
			this.getView().byId("vendorTable").removeSelections(true);
			this.getView().getModel().setProperty("/selectedVendorCount", 0);
		},

		// ── 3. AI GOI Y NCC (dua tren vat tu dong dau + ngan sach cua PR dang chon) ──
		onAiSuggestPress: function () {
			if (!this._currentPR) {
				MessageToast.show("Hãy chọn một PR trước.");
				return;
			}
			var oModel = this.getView().getModel();
			var aVendors = oModel.getProperty("/Vendors") || [];
			if (aVendors.length === 0) {
				MessageToast.show("Chưa có danh sách Nhà cung cấp để AI phân tích.");
				return;
			}

			var firstItem = (this._currentPR._items || [])[0] || {};
			oModel.setProperty("/busyAi", true);

			fetch(BACKEND + "/api/ai/recommend-vendor", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					materialName: firstItem.Description || "",
					materialGroup: firstItem.MaterialType || "",
					quantity: firstItem.Quantity || "",
					budget: this._currentPR.TotalValue || "",
					vendors: aVendors
				})
			})
				.then(function (r) { return r.json(); })
				.then(function (res) {
					oModel.setProperty("/busyAi", false);
					if (res && res.success) {
						oModel.setProperty("/aiText", res.recommendation || "");
					} else {
						MessageToast.show((res && res.message) || "AI không phản hồi.");
					}
				})
				.catch(function () {
					oModel.setProperty("/busyAi", false);
					MessageToast.show("Không gọi được AI gợi ý.");
				});
		},

		// ── 3b. HOI THEM AI (chat tuong tac tren nen du lieu NCC dang xem) ──
		// Server van an danh hoa ten/email NCC truoc khi goi AI nhu nut goi y chinh.
		onAiAskPress: function () {
			var oModel = this.getView().getModel();
			var oInput = this.getView().byId("inAiQuestion");
			var sQuestion = (oInput.getValue() || "").trim();

			if (!sQuestion) {
				MessageToast.show("Hãy nhập câu hỏi trước.");
				return;
			}
			var aVendors = oModel.getProperty("/Vendors") || [];
			if (aVendors.length === 0) {
				MessageToast.show("Chưa có danh sách Nhà cung cấp để hỏi AI.");
				return;
			}

			var firstItem = ((this._currentPR && this._currentPR._items) || [])[0] || {};
			oModel.setProperty("/busyAi", true);

			fetch(BACKEND + "/api/ai/ask", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					context: "recommend-vendor",
					question: sQuestion,
					vendors: aVendors,
					materialName: firstItem.Description || "",
					materialGroup: firstItem.MaterialType || "",
					quantity: firstItem.Quantity || "",
					budget: (this._currentPR && this._currentPR.TotalValue) || ""
				})
			})
				.then(function (r) { return r.json(); })
				.then(function (res) {
					oModel.setProperty("/busyAi", false);
					if (res && res.success) {
						// Noi Q/A vao van ban goi y dang hien de giu mach hoi dap
						var sPrev = oModel.getProperty("/aiText") || "";
						oModel.setProperty("/aiText",
							sPrev + "\n\n— Hỏi: " + sQuestion + "\n— AI: " + (res.answer || ""));
						oInput.setValue("");
					} else {
						MessageToast.show((res && res.message) || "AI không phản hồi.");
					}
				})
				.catch(function () {
					oModel.setProperty("/busyAi", false);
					MessageToast.show("Không gọi được AI.");
				});
		},

		// ── 4. TAO RFQ TREN SAP + GUI EMAIL MOI BAO GIA ──
		onCreateAndSendRFQ: function () {
			var that = this;
			var oView = this.getView();

			if (!this._currentPR) {
				MessageBox.warning("Hãy chọn một PR trước khi tạo RFQ.");
				return;
			}

			var aSelected = oView.byId("vendorTable").getSelectedItems().map(function (oItem) {
				return oItem.getBindingContext().getObject();
			});
			if (aSelected.length === 0) {
				MessageBox.warning("Hãy chọn ít nhất 1 Nhà cung cấp để mời báo giá.");
				return;
			}

			var oDeadlinePicker = oView.byId("dpDeadline");
			var sDeadline = oDeadlinePicker.getValue();
			if (!sDeadline) {
				MessageBox.warning("Hãy chọn hạn nộp báo giá (Deadline).");
				return;
			}
			// Phong truong hop go tay/paste ngay qua khu (minDate chi chan luc bam vao lich).
			var oDeadlineDate = oDeadlinePicker.getDateValue();
			var oToday = new Date();
			oToday.setHours(0, 0, 0, 0);
			if (oDeadlineDate && oDeadlineDate < oToday) {
				MessageBox.warning("Hạn nộp báo giá không được ở quá khứ. Vui lòng chọn lại.");
				return;
			}

			var fnSubmit = function () { that._submitRFQ(aSelected, sDeadline); };

			// Chi canh bao (khong chan cung): 1 NCC van hop le nhung se phai nhap
			// ly do sole-source khi chot o man RFQ-02.
			if (aSelected.length < 2) {
				MessageBox.confirm(
					"Bạn chỉ mời 1 Nhà cung cấp báo giá. Khi chốt kết quả sẽ bắt buộc nhập lý do chỉ định 1 NCC (sole source). Tiếp tục?",
					{
						title: "Chỉ có 1 Nhà cung cấp",
						onClose: function (sAction) {
							if (sAction === MessageBox.Action.OK) { fnSubmit(); }
						}
					}
				);
				return;
			}
			fnSubmit();
		},

		_submitRFQ: function (aSelectedVendors, sDeadline) {
			var that = this;
			var oView = this.getView();
			var oUser = this.getOwnerComponent().getModel("user").getData() || {};
			var oPR = this._currentPR;

			oView.setBusy(true);

			fetch(BACKEND + "/api/rfq/create", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					prId: oPR.PRId,
					sapPrNumber: oPR.SapPRId || "",
					vendorIds: aSelectedVendors.map(function (v) { return v.VendorNo; }),
					createdBy: oUser.email || "",
					currency: oPR.Currency || "VND"
				})
			})
				.then(function (r) {
					return r.json().then(function (body) { return { status: r.status, body: body }; });
				})
				.then(function (oResult) {
					if (!oResult.body || !oResult.body.success) {
						throw new Error((oResult.body && oResult.body.message) || "Tạo RFQ thất bại.");
					}
					var sRfqId = oResult.body.rfqId;

					// Tao xong thi gui email ngay trong cung 1 thao tac
					return fetch(BACKEND + "/api/rfq/" + encodeURIComponent(sRfqId) + "/send", {
						method: "POST",
						headers: { "Content-Type": "application/json" },
						// sentBy: de email gui NCC co Reply-To la dung nguoi mua dang
						// phu trach, khong phai hom thu ky thuat chung.
						body: JSON.stringify({ deadline: sDeadline, sentBy: oUser.email || "" })
					})
						.then(function (r) {
							return r.json().then(function (body) { return { rfqId: sRfqId, body: body }; });
						});
				})
				.then(function (oSendResult) {
					oView.setBusy(false);
					var oBody = oSendResult.body || {};
					var sMsg = "Đã tạo RFQ " + oSendResult.rfqId + " cho PR " + oPR.PRId + ".";
					if (oBody.success) {
						sMsg += " Đã gửi email mời báo giá tới " + oBody.emailsSent + "/" + oBody.totalVendors + " NCC.";
						// NCC thieu email truoc day bi bo qua am tham (`continue` trong
						// vong lap gui mail) — khong ai biet ho khong he nhan duoc thu.
						var aNoEmail = oBody.vendorsWithoutEmail || [];
						if (aNoEmail.length) {
							sMsg += "\n\nCHƯA GỬI ĐƯỢC cho " + aNoEmail.length + " NCC vì chưa có email trong master: "
								+ aNoEmail.join(", ") + ". Vào RFQ-02 để lấy link báo giá riêng gửi cho họ bằng cách khác.";
						}
						if (oBody.emailsFailed) {
							sMsg += "\n\n" + oBody.emailsFailed + " thư bị lỗi khi gửi — có thể gửi nhắc lại ở màn RFQ-02.";
						}
					} else {
						sMsg += " LƯU Ý: gửi email thất bại (" + (oBody.message || "không rõ lý do") + ") — có thể gửi lại sau.";
					}
					MessageBox.success(sMsg, {
						title: "Tạo RFQ thành công — " + oSendResult.rfqId,
						onClose: function () {
							oView.byId("rfqCreationArea").setVisible(false);
							that._currentPR = null;
							oView.getModel().setProperty("/selectedVendorCount", 0);
							that._loadPendingPRs();
						}
					});
				})
				.catch(function (error) {
					oView.setBusy(false);
					MessageBox.error(error.message || "Không tạo được RFQ.");
				});
		},

		formatCurrency: function (fValue) {
			if (fValue === undefined || fValue === null || fValue === "") { return "0"; }
			return Number(fValue).toLocaleString("vi-VN");
		},

		onNavBack: function () {
			this.getOwnerComponent().getRouter().navTo("dashboard");
		}
	});
});
