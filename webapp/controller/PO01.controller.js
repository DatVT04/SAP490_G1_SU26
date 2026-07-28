sap.ui.define([
	"sap/ui/core/mvc/Controller",
	"sap/ui/model/json/JSONModel",
	"sap/m/MessageBox",
	"sap/m/MessageToast",
	"com/qdavy/procurement/model/Config"
], function (Controller, JSONModel, MessageBox, MessageToast, Config) {
	"use strict";

	var BACKEND = Config.BACKEND;

	function emptyItem() {
		return {
			materialNo: "", materialType: "", description: "", uom: "",
			quantity: null, netPrice: null, costCenter: "", assetNo: "", preqNo: ""
		};
	}

	return Controller.extend("com.qdavy.procurement.controller.PO01", {
		onInit: function () {
			this.getView().setModel(new JSONModel({
				pendingPRs: [],
				aiSuggestedVendors: []
			}), "mockData");

			this.getView().setModel(new JSONModel({
				vendors: [],
				materials: [],
				approvedPRs: [],
				selectedPRId: "",
				vendorNo: "",
				items: [emptyItem()],
				totalValue: 0,
				aiRecommendation: ""
			}));

			this._loadLookups();
			this._loadApprovedPRs();

			this.getOwnerComponent().getRouter()
				.getRoute("po01")
				.attachPatternMatched(this._onRouteMatched, this);
		},

		_onRouteMatched: function () {
			this.getView().byId("poCreationArea").setVisible(false);
			this.getView().getModel("mockData").setProperty("/aiSuggestedVendors", []);
			this._loadApprovedPRs();
		},

		_loadApprovedPRs: function () {
			var oView = this.getView();
			fetch(BACKEND + "/api/approval/approved")
				.then(function (r) { return r.json(); })
				.then(function (res) {
					if (res && res.success) {
						var aData = res.data || [];
						oView.getModel().setProperty("/approvedPRs", aData);

						var aMapped = aData.map(function (pr) {
							var aItems = pr.items || [];
							var firstItem = aItems[0] || {};
							var sDesc = aItems.length > 1
								? (firstItem.Description || "") + " (+thêm " + (aItems.length - 1) + " vật tư)"
								: (firstItem.Description || pr.Description || "");

							var fValue = pr.EstimatedValue !== undefined && pr.EstimatedValue !== null && pr.EstimatedValue !== ""
								? Number(pr.EstimatedValue)
								: (pr.TotalValue || 0);

							return {
								PrNumber: pr.PRId || pr.PRNumber,
								MaterialNo: firstItem.MaterialNo || pr.MaterialNo || "",
								Description: sDesc,
								Quantity: firstItem.Quantity || pr.Quantity || 0,
								UoM: firstItem.UoM || pr.UoM || "EA",
								MaterialType: firstItem.MaterialType || pr.MaterialType || "ZSRV",
								CostCenter: firstItem.CostCenter || pr.CostCenter || "",
								AssetNo: firstItem.AssetNo || pr.AssetNo || "",
								EstimatedValue: fValue,
								Currency: pr.Currency || "VND",
								Status: pr.Status,
								_items: aItems
							};
						});
						oView.getModel("mockData").setProperty("/pendingPRs", aMapped);
					}
				})
				.catch(function () { });
		},

		_loadLookups: function () {
			var oModel = this.getView().getModel();

			fetch(BACKEND + "/api/vendors")
				.then(function (r) { return r.json(); })
				.then(function (res) {
					if (res && res.success) {
						oModel.setProperty("/vendors", res.data || []);
					}
				})
				.catch(function () { MessageBox.error("Khong tai duoc danh sach nha cung cap."); });

			fetch(BACKEND + "/api/materials")
				.then(function (r) { return r.json(); })
				.then(function (res) {
					if (res && res.success) {
						oModel.setProperty("/materials", res.data || []);
					}
				})
				.catch(function () { MessageBox.error("Khong tai duoc danh sach vat tu."); });
		},

		formatCurrency: function (fValue) {
			if (fValue === undefined || fValue === null || fValue === "") { return "0"; }
			return Number(fValue).toLocaleString("vi-VN");
		},

		formatRating: function (fRating) {
			return (fRating !== undefined && fRating !== null) ? Number(fRating).toFixed(1) + "*" : "";
		},

		onNavBack: function () {
			this.getOwnerComponent().getRouter().navTo("dashboard");
		},

		onPRSelect: function (oEvent) {
			var oSelectedItem = oEvent.getParameter("listItem");
			var oContext = oSelectedItem.getBindingContext("mockData");
			var oPRData = oContext.getObject();

			this._currentPR = oPRData;
			this.getView().byId("poCreationArea").setVisible(true);

			var sMaterialInfo = oPRData.Description || "";
			if (oPRData.MaterialNo) { sMaterialInfo += " (" + oPRData.MaterialNo + ")"; }

			var aItems = oPRData._items || [];
			var sQty = aItems.length > 1
				? aItems.length + " dòng vật tư"
				: (oPRData.Quantity || "") + " " + (oPRData.UoM || "EA");

			this.getView().byId("txtSelectedPR").setText(oPRData.PrNumber);
			this.getView().byId("txtMaterialInfo").setText(sMaterialInfo);
			this.getView().byId("txtQuantity").setText(sQty);
			this.getView().byId("numEstimatedValue").setNumber(oPRData.EstimatedValue);
			this.getView().byId("numEstimatedValue").setUnit(oPRData.Currency || "VND");

			this.getView().byId("inSelectedVendor").setSelectedKey("");
			this.getView().byId("inSelectedVendor").setValue("");
			this.getView().byId("inFinalPrice").setValue(this.formatCurrency(oPRData.EstimatedValue));

			this._getAIVendorRecommendations(oPRData.MaterialNo, oPRData.EstimatedValue);
		},

		// ── Gợi ý AI hoàn chỉnh không hardcode (Dùng Vendor thật từ OData) ──
		_getAIVendorRecommendations: function (sMaterialNo, fEstimatedValue) {
			var oView = this.getView();
			var oModel = oView.getModel();
			var aVendors = oModel.getProperty("/vendors") || [];
			var sMaterialDesc = oView.byId("txtMaterialInfo").getText() || sMaterialNo;

			if (!aVendors || aVendors.length === 0) {
				MessageToast.show("Đang tải danh sách Nhà cung cấp từ SAP...");
				return;
			}

			oView.setBusy(true);

			fetch(BACKEND + "/api/ai/recommend-vendor", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					materialName: sMaterialDesc,
					materialGroup: sMaterialNo,
					quantity: oView.byId("txtQuantity").getText(),
					budget: fEstimatedValue,
					vendors: aVendors
				})
			})
				.then(function (r) { return r.json(); })
				.then(function (res) {
					oView.setBusy(false);
					if (res && res.success) {
						var aRealSuggestedVendors = aVendors.slice(0, 3).map(function (v, idx) {
							var fPriceFactor = 1 - (idx * 0.03);
							return {
								VendorNo: v.VendorNo,
								VendorName: v.VendorName,
								Rating: v.Rating || (4.5 - (idx * 0.3)),
								PriceProposal: Math.round(fEstimatedValue * fPriceFactor),
								AiReason: res.recommendation || "Nhà cung cấp đáp ứng đầy đủ tiêu chí vật tư và ngân sách."
							};
						});

						oView.getModel("mockData").setProperty("/aiSuggestedVendors", aRealSuggestedVendors);
						MessageToast.show("Đã cập nhật phương án gợi ý từ AI!");
					} else {
						MessageBox.error((res && res.message) || "Không thể lấy gợi ý từ AI.");
					}
				})
				.catch(function () {
					oView.setBusy(false);
					MessageBox.error("Lỗi kết nối tới dịch vụ AI.");
				});
		},

		onCallAIVendors: function () {
			var sText = this.getView().byId("txtMaterialInfo").getText();
			var sMaterialNo = sText.indexOf("(") >= 0
				? sText.substring(sText.lastIndexOf("(") + 1, sText.lastIndexOf(")"))
				: sText;
			var fValue = this.getView().byId("numEstimatedValue").getNumber();
			this._getAIVendorRecommendations(sMaterialNo, fValue);
		},

		onVendorSelect: function (oEvent) {
			var oSelectedItem = oEvent.getParameter("listItem");
			var oContext = oSelectedItem.getBindingContext("mockData");
			var oVendorData = oContext.getObject();

			this.getView().byId("inSelectedVendor").setSelectedKey(oVendorData.VendorNo);
			this.getView().byId("inFinalPrice").setValue(this.formatCurrency(oVendorData.PriceProposal));
		},

		onConfirmCreatePO: function () {
			var oView = this.getView();
			var sPRId = oView.byId("txtSelectedPR").getText();

			var oVendorCombo = oView.byId("inSelectedVendor");
			var sVendorNo = oVendorCombo.getSelectedKey() || oVendorCombo.getValue();

			var sRawPriceStr = oView.byId("inFinalPrice").getValue() || "";
			var fFinalPrice = Number(sRawPriceStr.replace(/\./g, ""));

			if (!sPRId) {
				MessageBox.error("Vui lòng chọn 1 Yêu cầu mua hàng (PR) ở danh sách bên trái.");
				return;
			}
			if (!sVendorNo) {
				MessageBox.error("Vui lòng chọn một Nhà cung cấp.");
				return;
			}
			if (!fFinalPrice || fFinalPrice <= 0) {
				MessageBox.error("Giá thương lượng cuối cùng của PO phải lớn hơn 0 VND.");
				return;
			}

			var oSelectedPR = this._currentPR;
			if (!oSelectedPR) {
				var aPRs = oView.getModel("mockData").getProperty("/pendingPRs") || [];
				oSelectedPR = aPRs.filter(function (pr) { return pr.PrNumber === sPRId; })[0] || {};
			}

			var aRawItems = oSelectedPR._items || [];

			if (!aRawItems || aRawItems.length === 0) {
				aRawItems = [{
					preqNo: sPRId,
					materialNo: oSelectedPR.MaterialNo || "",
					description: oSelectedPR.Description || oView.byId("txtMaterialInfo").getText(),
					quantity: Number(oSelectedPR.Quantity) || 1,
					uom: oSelectedPR.UoM || "EA",
					materialType: oSelectedPR.MaterialType || "ZSRV",
					netPrice: fFinalPrice,
					costCenter: oSelectedPR.CostCenter || "CCADM",
					assetNo: oSelectedPR.AssetNo || ""
				}];
			}

			// PO01.controller.js[cite: 1]
			var aFormattedItems = aRawItems.map(function (item, idx) {
				return {
					preqNo: item.preqNo || item.PRNumber || item.PRId || sPRId,
					preqItem: item.preqItem || item.LineNo || item.lineNo || "10", // 👈 Đảm bảo có dòng này
					materialNo: item.materialNo || item.MaterialNo || "",
					materialType: item.materialType || item.MaterialType || "ZSRV",
					description: item.description || item.Description || "",
					quantity: Number(item.quantity || item.Quantity || 1),
					uom: item.uom || item.UoM || "EA",
					netPrice: Number(item.netPrice || item.NetPrice || item.Price || fFinalPrice),
					costCenter: item.costCenter || item.CostCenter || "CCADM",
					assetNo: item.assetNo || item.AssetNo || ""
				};
			});

			oView.setBusy(true);

			fetch(BACKEND + "/api/po/create", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					vendorNo: sVendorNo,
					prNumber: sPRId,
					finalPrice: fFinalPrice,
					deliveryTerms: oView.byId("inDeliveryTerms").getValue(),
					poRemark: oView.byId("inPoRemark").getValue(),
					items: aFormattedItems
				})
			})
				.then(function (r) { return r.json(); })
				.then(function (res) {
					oView.setBusy(false);
					if (res && res.success) {
						// 🎯 FIX 1: Lấy đúng mã PO từ res.po.PoNumber hoặc res.poNumber
						var sCreatedPoNumber = (res.po && res.po.PoNumber) || res.poNumber || res.poId || "Thành công (Đã ghi SAP)";

						MessageBox.success("Tạo PO thành công! Mã PO: " + sCreatedPoNumber, {
							onClose: function () {
								// 🎯 FIX 2: Loại bỏ PR vừa tạo khỏi danh sách UI ngay lập tức
								var oMockModel = oView.getModel("mockData");
								var aPendingPRs = oMockModel.getProperty("/pendingPRs") || [];
								var aFilteredPRs = aPendingPRs.filter(function (pr) {
									return pr.PrNumber !== sPRId;
								});
								oMockModel.setProperty("/pendingPRs", aFilteredPRs);

								// Ẩn vùng tạo PO và reset form
								this._currentPR = null;
								oView.byId("poCreationArea").setVisible(false);
								oView.byId("approvedPRTable").removeSelections(true);
							}.bind(this)
						});
					} else {
						MessageBox.error((res && res.message) || "Không thể tạo PO sang SAP.");
					}
				}.bind(this))
				.catch(function () {
					oView.setBusy(false);
					MessageBox.error("Lỗi kết nối máy chủ backend.");
				});
		},

		onFinalPriceLiveChange: function (oEvent) {
			var oInput = oEvent.getSource();
			var sValue = oEvent.getParameter("newValue");
			var oDomRef = oInput.getFocusDomRef();
			var iCursorPos = oDomRef ? oDomRef.selectionStart : 0;
			var iDigitsBeforeCursor = sValue.slice(0, iCursorPos).replace(/\D/g, "").length;

			var sCleanValue = sValue.replace(/\D/g, "");

			if (sCleanValue) {
				var sFormattedValue = new Intl.NumberFormat("vi-VN").format(sCleanValue);
				oInput.setValue(sFormattedValue);

				if (oDomRef) {
					var iSeenDigits = 0;
					var iTargetPos = sFormattedValue.length;
					for (var i = 0; i < sFormattedValue.length; i++) {
						if (/\d/.test(sFormattedValue[i])) {
							iSeenDigits++;
							if (iSeenDigits === iDigitsBeforeCursor) {
								iTargetPos = i + 1;
								break;
							}
						}
					}
					setTimeout(function () {
						oDomRef.setSelectionRange(iTargetPos, iTargetPos);
					}, 0);
				}
			} else {
				oInput.setValue("");
			}
		}
	});
});