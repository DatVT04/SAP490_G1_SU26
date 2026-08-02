sap.ui.define([
	"sap/ui/core/mvc/Controller",
	"sap/ui/model/json/JSONModel",
	"sap/m/MessageBox",
	"sap/m/MessageToast",
	"com/qdavy/procurement/model/Config"
], function (Controller, JSONModel, MessageBox, MessageToast, Config) {
	"use strict";

	var BACKEND = Config.BACKEND;

	return Controller.extend("com.qdavy.procurement.controller.PO01", {

		onInit: function () {
			this._loadApprovedPRs();
			this._loadVendors();

			this.getOwnerComponent().getRouter()
				.getRoute("po01")
				.attachPatternMatched(this._onRouteMatched, this);
		},

		_onRouteMatched: function () {
			this.getView().byId("poCreationArea").setVisible(false);
			this._loadApprovedPRs();
		},

		// ── 1. ĐỌC DỮ LIỆU PR ĐÃ DUYỆT TỪ API ──
		_loadApprovedPRs: function () {
			var oView = this.getView();
			oView.setBusy(true);

			fetch(BACKEND + "/api/approval/approved")
				.then(function (r) { return r.json(); })
				.then(function (res) {
					oView.setBusy(false);
					if (res && res.success) {
						var aRawData = res.data || [];

						var aMappedPRs = aRawData.map(function (pr) {
							var aItems = pr.items || [];
							var firstItem = aItems[0] || {};

							var sDesc = aItems.length > 1
								? (firstItem.Description || "") + " (+ " + (aItems.length - 1) + " vật tư khác)"
								: (firstItem.Description || "");

							return {
								PrNumber: pr.SapPRId || pr.PRId || pr.InternalId || "",
								CompanyCode: pr.CompanyCode || firstItem.CompanyCode || "",
								PurchOrg: pr.PurchOrg || firstItem.PurchOrg || "",
								PurchGroup: pr.PurchGroup || firstItem.PurchGroup || "",
								MaterialNo: firstItem.MaterialNo || "",
								Description: sDesc,
								Quantity: firstItem.Quantity || 0,
								UoM: firstItem.UoM || "",
								EstimatedValue: pr.TotalValue || firstItem.EstimatedValue || 0,
								Currency: pr.Currency || "",
								RequesterEmail: pr.RequesterEmail || "",
								CostCenter: firstItem.CostCenter || "",
								Plant: firstItem.Plant || "",
								AssetNo: firstItem.AssetNo || "",
								_items: aItems
							};
						});

						oView.setModel(new JSONModel({ 
							PurchaseRequisitions: aMappedPRs,
							poItems: [] 
						}));
					}
				})
				.catch(function () {
					oView.setBusy(false);
					MessageToast.show("Không thể lấy danh sách PR từ máy chủ.");
				});
		},

		// ── 2. ĐỌC DANH SÁCH VENDOR TỪ ODATA ──
		_loadVendors: function () {
			var oView = this.getView();
			fetch(BACKEND + "/api/vendors")
				.then(function (r) { return r.json(); })
				.then(function (res) {
					if (res && res.success) {
						var aVendors = res.data || [];
						var oModel = oView.getModel();
						if (oModel) {
							oModel.setProperty("/Vendors", aVendors);
						}
					}
				})
				.catch(function () {
					console.error("Lỗi tải danh sách Vendor từ OData.");
				});
		},

		formatCurrency: function (fValue) {
			if (fValue === undefined || fValue === null || fValue === "") { return "0"; }
			return Number(fValue).toLocaleString("vi-VN");
		},

		onNavBack: function () {
			this.getOwnerComponent().getRouter().navTo("dashboard");
		},

		// ── 3. SỰ KIỆN KHI CHỌN DÒNG PR (FIX KHÔNG CRASH) ──
		onPRSelect: function (oEvent) {
			console.log("CLICK");
			try {
				var oSelectedItem = oEvent.getParameter("listItem");
				if (!oSelectedItem) { return; }

				var oContext = oSelectedItem.getBindingContext();
				var oPRData = oContext ? oContext.getObject() : null;

				if (!oPRData) { return; }

				this._currentPR = oPRData;
				var oView = this.getView();
				var oModel = oView.getModel();

				// 1. Mở hiển thị vùng tạo PO bên phải
				oView.byId("poCreationArea").setVisible(true);

				var aItems = oPRData._items || [];
		console.log("=== RAW ITEMS ===");
console.table(aItems);		
				var firstItem = aItems[0] || {};

				// 2. Điền dữ liệu thông tin PR tham chiếu (Card 1)
				oView.byId("txtSelectedPR").setText(oPRData.PrNumber ? (oPRData.PrNumber + " / " + (firstItem.LineNo || "00010")) : "");
				oView.byId("txtRequester").setText(oPRData.RequesterEmail || "");
				oView.byId("txtMaterialInfo").setText((firstItem.Description || oPRData.Description || "") + (firstItem.MaterialNo ? " (" + firstItem.MaterialNo + ")" : ""));
				oView.byId("txtQuantity").setText((firstItem.Quantity || oPRData.Quantity || 0) + " " + (firstItem.UoM || oPRData.UoM || ""));
				oView.byId("numEstimatedValue").setNumber(this.formatCurrency(oPRData.EstimatedValue));
				oView.byId("numEstimatedValue").setUnit(oPRData.Currency || "");

				// 3. Đổ dữ liệu tổ chức (Card 2)
				oView.byId("inCompanyCode").setValue(oPRData.CompanyCode || "");
				oView.byId("inPurchOrg").setValue(oPRData.PurchOrg || "");
				oView.byId("inPurchGroup").setValue(oPRData.PurchGroup || "");
				oView.byId("inCurrency").setValue(oPRData.Currency || "");

				// 4. Tính đơn giá khởi tạo
				var fQty = Number(firstItem.Quantity || oPRData.Quantity || 1);
				var fUnitPrice = fQty > 0 ? (oPRData.EstimatedValue / fQty) : oPRData.EstimatedValue;
				oView.byId("inNetPrice").setValue(fUnitPrice);

				// 5. Cập nhật mảng /poItems cho Bảng Card 3
				var aTableItems = aItems.map(function(it, idx) {
					return {
						LineNo: it.LineNo || String((idx + 1) * 10).padStart(5, "0"),
						PreqNo: oPRData.PrNumber || "",
						MaterialNo: it.MaterialNo || "",
						Description: it.Description || "",
						Quantity: it.Quantity || 0,
						UoM: it.UoM || "",
						NetPrice: fUnitPrice,
						Currency: oPRData.Currency || "",
						Plant: it.Plant || "",
						CostCenter: it.CostCenter || ""
					};
				});
console.log("=== TABLE ITEMS ===");
console.table(aTableItems);
				if (aTableItems.length === 0) {
					aTableItems.push({
						LineNo: "00010",
						PreqNo: oPRData.PrNumber || "",
						MaterialNo: oPRData.MaterialNo || "",
						Description: oPRData.Description || "",
						Quantity: oPRData.Quantity || 0,
						UoM: oPRData.UoM || "",
						NetPrice: fUnitPrice,
						Currency: oPRData.Currency || "",
						Plant: oPRData.Plant || "",
						CostCenter: oPRData.CostCenter || ""
					});
				}

				oModel.setProperty("/poItems", aTableItems);
				this.onRecalculateTotal();

			} catch (err) {
				console.error("Lỗi khi chọn dòng PR:", err);
			}
		},

		// ── 4. CHỌN VENDOR -> LẤY EMAIL TỪ ODATA ──
		onVendorChange: function (oEvent) {
			var oSelectedItem = oEvent.getParameter("selectedItem");
			var oView = this.getView();

			if (oSelectedItem) {
				var oContext = oSelectedItem.getBindingContext();
				var oVendor = oContext ? oContext.getObject() : null;

				if (oVendor) {
					oView.byId("inVendorEmail").setValue(oVendor.Email || "");
				}
			}
		},

		// ── 5. TÍNH TOÁN TIỀN TỰ ĐỘNG ──
		onRecalculateTotal: function () {
			var oView = this.getView();
			var sNetPriceRaw = oView.byId("inNetPrice").getValue() || "0";
			var fNetPrice = Number(sNetPriceRaw.toString().replace(/\D/g, "")) || 0;

			var oPR = this._currentPR || {};
			var aItems = oPR._items || [];
			var firstItem = aItems[0] || {};
			var fQty = Number(firstItem.Quantity || oPR.Quantity || 1);

			var fTotal = fNetPrice * fQty;
			var sCurrency = oView.byId("inCurrency").getValue() || oPR.Currency || "";

			oView.byId("numTotalValue").setNumber(this.formatCurrency(fTotal));
			oView.byId("numTotalValue").setUnit(sCurrency);

			// Cập nhật giá lại trong mảng bảng
			var oModel = oView.getModel();
			var aPoItems = oModel.getProperty("/poItems") || [];
			aPoItems.forEach(function(item) {
				item.NetPrice = fNetPrice;
				item.Currency = sCurrency;
			});
			oModel.setProperty("/poItems", aPoItems);
		},

		// ── 6. PHÁT HÀNH PO VÀ GỬI MAIL ──
		onConfirmCreatePO: function () {
			var oView = this.getView();
			var oPR = this._currentPR;

			if (!oPR) {
				MessageBox.error("Vui lòng chọn một PR từ danh sách bên trái.");
				return;
			}

			var sVendorNo = oView.byId("inSelectedVendor").getSelectedKey();
			var sVendorEmail = oView.byId("inVendorEmail").getValue();
			var sCompanyCode = oView.byId("inCompanyCode").getValue();
			var sPurchOrg = oView.byId("inPurchOrg").getValue();
			var sPurchGroup = oView.byId("inPurchGroup").getValue();
			var sDocType = oView.byId("inDocType").getValue();
			var sDocDate = oView.byId("inDocDate").getValue();
			var sCurrency = oView.byId("inCurrency").getValue();

			var sNetPriceRaw = oView.byId("inNetPrice").getValue() || "0";
			var fNetPrice = Number(sNetPriceRaw.toString().replace(/\D/g, "")) || 0;

			if (!sCompanyCode) { MessageBox.error("Vui lòng nhập Mã công ty (Company Code)."); return; }
			if (!sPurchOrg) { MessageBox.error("Vui lòng nhập Tổ chức mua hàng (Purchasing Org)."); return; }
			if (!sPurchGroup) { MessageBox.error("Vui lòng nhập Nhóm mua hàng (Purchasing Group)."); return; }
			if (!sDocDate) { MessageBox.error("Vui lòng chọn Ngày lập chứng từ (Doc Date)."); return; }
			if (!sVendorNo) { MessageBox.error("Vui lòng chọn Nhà cung cấp (Vendor)."); return; }
			if (!sVendorEmail || !sVendorEmail.trim()) { MessageBox.error("Vui lòng nhập Email Nhà cung cấp."); return; }
			if (fNetPrice <= 0) { MessageBox.error("Đơn giá thương lượng phải lớn hơn 0."); return; }

			var oModel = oView.getModel();
			var aTableItems = oModel.getProperty("/poItems") || [];
console.log("=== PO ITEMS ===");
console.table(aTableItems);
			var aItemsPayload = aTableItems.map(function (it, idx) {
				return {
					preqNo: oPR.PrNumber,
					preqItem: it.LineNo || String((idx + 1) * 10).padStart(5, "0"),
					materialNo: it.MaterialNo || "",
					description: it.Description || "",
					quantity: Number(it.Quantity || 1),
					uom: it.UoM || "",
					netPrice: fNetPrice,
					costCenter: it.CostCenter || "",
					plant: it.Plant || "",
					assetNo: it.AssetNo || ""
				};
			});

			var oPayload = {
				vendorNo: sVendorNo,
				vendorEmail: sVendorEmail.trim(),
				prNumber: oPR.PrNumber,
				companyCode: sCompanyCode,
				purchOrg: sPurchOrg,
				purchGroup: sPurchGroup,
				docType: sDocType,
				docDate: sDocDate,
				currency: sCurrency,
				items: aItemsPayload
			};
console.log("=== PAYLOAD ===");
console.log(JSON.stringify(oPayload, null, 2));
			oView.setBusy(true);

			fetch(BACKEND + "/api/po/create", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(oPayload)
			})
				.then(function (r) { return r.json(); })
				.then(function (res) {
					oView.setBusy(false);
					if (res && res.success) {
						var sPoNum = res.poNumber || (res.po && res.po.PoNumber) || "PO_SUCCESS";
						var sMailInfo = res.emailSent ? "\nĐã gửi mail xác nhận đến: " + sVendorEmail.trim() : "";

						MessageBox.success("Tạo Purchase Order thành công!\nMã PO: " + sPoNum + sMailInfo, {
							onClose: function () {
								this._currentPR = null;
								oView.byId("poCreationArea").setVisible(false);
								this._loadApprovedPRs();
							}.bind(this)
						});
					} else {
						MessageBox.error((res && res.message) || "Không thể khởi tạo PO trên SAP.");
					}
				}.bind(this))
				.catch(function () {
					oView.setBusy(false);
					MessageBox.error("Không thể kết nối đến máy chủ backend.");
				});
		}
	});
});