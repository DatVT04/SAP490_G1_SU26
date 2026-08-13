sap.ui.define([
	"sap/ui/core/mvc/Controller",
	"sap/ui/model/json/JSONModel",
	"sap/m/MessageBox",
	"sap/m/MessageToast",
	"com/qdavy/procurement/model/Config"
], function (Controller, JSONModel, MessageBox, MessageToast, Config) {
	"use strict";

	var BACKEND = Config.BACKEND;

	var RFQ_STATUS_LABELS = {
		DRAFT: "Nháp",
		SENT: "Đã gửi NCC",
		QUOTATIONS_RECEIVED: "Đã có báo giá",
		AWARDED: "Đã chốt NCC"
	};

	return Controller.extend("com.qdavy.procurement.controller.RFQ02", {

		onInit: function () {
			this.getView().setModel(new JSONModel({
				Rfqs: [],
				rfq: null,
				pr: null,
				quotations: [],
				pendingVendors: [],
				vendorChoices: [],
				aiText: "",
				busyAi: false
			}));

			// Khong de UI5 tre 1 giay moi ve spinner: trong 1 giay do man hinh trong
			// nhu binh thuong nhung da bi khoa, nguoi dung bam gi cung khong an
			// (dung bug da gap o RFQ-01 — "phai F5 moi bam duoc").
			this.getView().setBusyIndicatorDelay(0);
			this.getView().byId("rfqTable").setBusyIndicatorDelay(0);

			this._loadRfqList();

			this.getOwnerComponent().getRouter()
				.getRoute("rfq02")
				.attachPatternMatched(this._onRouteMatched, this);
		},

		_onRouteMatched: function () {
			this.getView().byId("rfqWorkArea").setVisible(false);
			this._currentRfqId = null;
			this.getView().getModel().setProperty("/aiText", "");
			this._loadRfqList();
		},

		// ── 1. DANH SACH RFQ TU SAP (RfqSet) ──
		_loadRfqList: function () {
			var oView = this.getView();
			// Chi khoa rieng bang danh sach RFQ, khong khoa ca view — neu khoa ca view
			// thi form nhap bao gia (checkbox/o nhap) ben phai cung bi khoa theo.
			var oTable = oView.byId("rfqTable");
			oTable.setBusy(true);

			fetch(BACKEND + "/api/rfq")
				.then(function (r) { return r.json(); })
				.then(function (res) {
					oTable.setBusy(false);
					if (res && res.success) {
						oView.getModel().setProperty("/Rfqs", res.data || []);
					} else {
						MessageToast.show((res && res.message) || "Không tải được danh sách RFQ.");
					}
				})
				.catch(function () {
					oTable.setBusy(false);
					MessageToast.show("Không thể kết nối máy chủ để lấy danh sách RFQ.");
				});
		},

		onRfqSelect: function (oEvent) {
			var oSelectedItem = oEvent.getParameter("listItem");
			if (!oSelectedItem) { return; }
			var oContext = oSelectedItem.getBindingContext();
			var oRfq = oContext ? oContext.getObject() : null;
			if (!oRfq) { return; }

			this._currentRfqId = oRfq.RfqId;
			this.getView().getModel().setProperty("/aiText", "");
			this._loadCompare();
		},

		// ── 2. BANG SO SANH (rfq + quotations + NCC con thieu) ──
		_loadCompare: function () {
			var oView = this.getView();
			var oModel = oView.getModel();
			var sRfqId = this._currentRfqId;
			if (!sRfqId) { return; }

			var oWorkArea = oView.byId("rfqWorkArea");
			oWorkArea.setBusyIndicatorDelay(0);
			oWorkArea.setBusy(true);

			fetch(BACKEND + "/api/rfq/" + encodeURIComponent(sRfqId) + "/compare")
				.then(function (r) { return r.json(); })
				.then(function (res) {
					oWorkArea.setBusy(false);
					if (!res || !res.success) {
						MessageToast.show((res && res.message) || "Không tải được dữ liệu RFQ " + sRfqId + ".");
						return;
					}
					oModel.setProperty("/rfq", res.rfq || null);
					oModel.setProperty("/pr", res.pr || null);
					oModel.setProperty("/quotations", res.quotations || []);
					oModel.setProperty("/pendingVendors", res.pendingVendors || []);

					// NCC duoc phep nhap bao gia: ca cho (PENDING) lan da nhap (sua lai)
					var aChoices = (res.pendingVendors || []).concat(
						(res.quotations || []).map(function (q) {
							return { VendorNo: q.VendorNo, VendorName: q.VendorName };
						})
					);
					oModel.setProperty("/vendorChoices", aChoices);

					oWorkArea.setVisible(true);
				})
				.catch(function () {
					oWorkArea.setBusy(false);
					MessageToast.show("Không thể kết nối máy chủ.");
				});
		},

		// ── 3. LUU 1 BAO GIA (audit trail: enteredBy tu user model, sourceNote bat buoc) ──
		onSaveQuotation: function () {
			var that = this;
			var oView = this.getView();
			var oUser = this.getOwnerComponent().getModel("user").getData() || {};

			var sVendor = oView.byId("selQuoteVendor").getSelectedKey();
			var sPrice = oView.byId("inQuotePrice").getValue();
			var sSource = oView.byId("inQuoteSource").getValue();

			if (!sVendor) {
				MessageBox.warning("Hãy chọn Nhà cung cấp.");
				return;
			}
			if (!sPrice || Number(sPrice) <= 0) {
				MessageBox.warning("Giá báo phải là số dương.");
				return;
			}
			if (!sSource || !sSource.trim()) {
				MessageBox.warning("Bắt buộc nhập căn cứ (SourceNote) — ví dụ email NCC ngày nào.");
				return;
			}

			oView.setBusy(true);

			fetch(BACKEND + "/api/rfq/" + encodeURIComponent(this._currentRfqId) + "/quotation", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					vendorNo: sVendor,
					quotedPrice: Number(sPrice),
					currency: "VND",
					leadTimeDays: Number(oView.byId("inQuoteLeadTime").getValue()) || 0,
					paymentTerms: oView.byId("inQuotePayment").getValue() || "",
					warrantyMonths: Number(oView.byId("inQuoteWarranty").getValue()) || 0,
					legalDocsOk: oView.byId("cbQuoteLegal").getSelected(),
					sourceNote: sSource.trim(),
					enteredBy: oUser.email || ""
				})
			})
				.then(function (r) {
					return r.json().then(function (body) { return { status: r.status, body: body }; });
				})
				.then(function (oResult) {
					oView.setBusy(false);
					if (!oResult.body || !oResult.body.success) {
						MessageBox.error((oResult.body && oResult.body.message) || "Lưu báo giá thất bại.");
						return;
					}
					MessageToast.show("Đã lưu báo giá của NCC " + sVendor + ".");
					that._clearQuotationForm();
					that._loadCompare();
					that._loadRfqList();
				})
				.catch(function () {
					oView.setBusy(false);
					MessageBox.error("Không thể kết nối máy chủ để lưu báo giá.");
				});
		},

		_clearQuotationForm: function () {
			var oView = this.getView();
			oView.byId("inQuotePrice").setValue("");
			oView.byId("inQuoteLeadTime").setValue("");
			oView.byId("inQuotePayment").setValue("");
			oView.byId("inQuoteWarranty").setValue("");
			oView.byId("cbQuoteLegal").setSelected(false);
			oView.byId("inQuoteSource").setValue("");
		},

		// ── 4. AI SO SANH BAO GIA (chi bat khi >=2 bao gia; server tu an danh hoa) ──
		onAiComparePress: function () {
			var oModel = this.getView().getModel();
			oModel.setProperty("/busyAi", true);

			fetch(BACKEND + "/api/ai/compare-quotations", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ rfqId: this._currentRfqId })
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
					MessageToast.show("Không gọi được AI so sánh báo giá.");
				});
		},

		// ── 5. CHOT NCC THANG — PR goc chuyen sang PENDING_CFO, gia cap nhat theo bao gia that ──
		onAwardPress: function () {
			var that = this;
			var oView = this.getView();
			var oModel = oView.getModel();
			var oUser = this.getOwnerComponent().getModel("user").getData() || {};

			var sVendor = oView.byId("selAwardVendor").getSelectedKey();
			var sReason = oView.byId("inAwardReason").getValue();
			var aQuotations = oModel.getProperty("/quotations") || [];
			var sSoleSource = aQuotations.length === 1
				? oView.byId("inSoleSourceReason").getValue()
				: "";

			if (!sVendor) {
				MessageBox.warning("Hãy chọn Nhà cung cấp thắng.");
				return;
			}
			if (!sReason || !sReason.trim()) {
				MessageBox.warning("Bắt buộc nhập lý do chọn Nhà cung cấp.");
				return;
			}
			if (aQuotations.length === 1 && (!sSoleSource || !sSoleSource.trim())) {
				MessageBox.warning("Chỉ có 1 báo giá — bắt buộc nhập lý do chỉ định 1 NCC (sole source).");
				return;
			}

			MessageBox.confirm(
				"Chốt NCC " + sVendor + " cho RFQ " + this._currentRfqId
				+ "? PR gốc sẽ chuyển sang chờ CFO duyệt với giá báo thật.",
				{
					title: "Xác nhận chốt Nhà cung cấp",
					onClose: function (sAction) {
						if (sAction !== MessageBox.Action.OK) { return; }

						oView.setBusy(true);
						fetch(BACKEND + "/api/rfq/" + encodeURIComponent(that._currentRfqId) + "/award", {
							method: "POST",
							headers: { "Content-Type": "application/json" },
							body: JSON.stringify({
								vendorNo: sVendor,
								awardReason: sReason.trim(),
								awardedBy: oUser.email || "",
								soleSourceReason: sSoleSource ? sSoleSource.trim() : ""
							})
						})
							.then(function (r) {
								return r.json().then(function (body) { return { status: r.status, body: body }; });
							})
							.then(function (oResult) {
								oView.setBusy(false);
								if (!oResult.body || !oResult.body.success) {
									MessageBox.error((oResult.body && oResult.body.message) || "Chốt NCC thất bại.");
									return;
								}
								MessageBox.success(
									"Đã chốt NCC " + oResult.body.awardedVendor + " — giá "
									+ Number(oResult.body.finalValue).toLocaleString("vi-VN")
									+ " VND. PR gốc đã chuyển sang chờ CFO duyệt.",
									{
										title: "Chốt RFQ thành công",
										onClose: function () {
											that._loadCompare();
											that._loadRfqList();
										}
									}
								);
							})
							.catch(function () {
								oView.setBusy(false);
								MessageBox.error("Không thể kết nối máy chủ để chốt NCC.");
							});
					}
				}
			);
		},

		// ── FORMATTERS ──
		formatCurrency: function (fValue) {
			if (fValue === undefined || fValue === null || fValue === "") { return "0"; }
			return Number(fValue).toLocaleString("vi-VN");
		},

		// K = Cost Center, F = Internal Order, A = Asset — kem doi tuong hach toan tuong ung
		formatAcctAssign: function (sCat, sCostCenter, sInternalOrder, sAssetNo) {
			switch (String(sCat || "").toUpperCase()) {
				case "K": return "K · Cost Center " + (sCostCenter || "—");
				case "F": return "F · Internal Order " + (sInternalOrder || "—");
				case "A": return "A · Tài sản " + (sAssetNo || "—");
				default: return sCat || "—";
			}
		},

		formatRfqStatus: function (s) {
			return RFQ_STATUS_LABELS[String(s || "").toUpperCase()] || s;
		},

		formatRfqStatusState: function (s) {
			s = String(s || "").toUpperCase();
			if (s === "AWARDED") { return "Success"; }
			if (s === "QUOTATIONS_RECEIVED") { return "Information"; }
			if (s === "SENT") { return "Warning"; }
			return "None";
		},

		// Chuoi SAP YYYYMMDD -> dd/MM/yyyy
		formatSapDate: function (s) {
			s = String(s || "");
			if (!/^\d{8}$/.test(s)) { return s || "(chưa đặt)"; }
			return s.slice(6, 8) + "/" + s.slice(4, 6) + "/" + s.slice(0, 4);
		},

		// Chuoi SAP YYYYMMDDHHMMSS -> dd/MM/yyyy HH:mm
		formatSapTimestamp: function (s) {
			s = String(s || "");
			if (!/^\d{14}$/.test(s)) { return s; }
			return s.slice(6, 8) + "/" + s.slice(4, 6) + "/" + s.slice(0, 4)
				+ " " + s.slice(8, 10) + ":" + s.slice(10, 12);
		},

		onNavBack: function () {
			this.getOwnerComponent().getRouter().navTo("dashboard");
		}
	});
});
