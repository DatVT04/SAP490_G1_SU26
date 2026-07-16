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
			materialNo: "",
			materialType: "",
			description: "",
			uom: "",
			quantity: null,
			netPrice: null,
			costCenter: "",
			assetNo: ""
		};
	}

	return Controller.extend("com.qdavy.procurement.controller.PO01", {
		onInit: function () {
			var oModel = new JSONModel({
				vendors: [],
				materials: [],
				vendorNo: "",
				items: [emptyItem()],
				totalValue: 0,
				aiRecommendation: ""
			});
			this.getView().setModel(oModel);
			this._loadLookups();
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

		formatRating: function (fRating) {
			return fRating !== undefined && fRating !== null ? Number(fRating).toFixed(1) + "*" : "";
		},

		onItemMaterialChange: function (oEvent) {
			var sKey = oEvent.getParameter("selectedItem") && oEvent.getParameter("selectedItem").getKey();
			var oModel = this.getView().getModel();
			var oMaterial = (oModel.getProperty("/materials") || []).filter(function (m) { return m.MaterialNo === sKey; })[0];
			var sPath = oEvent.getSource().getBindingContext().getPath();

			if (!oMaterial) {
				return;
			}

			oModel.setProperty(sPath + "/materialType", oMaterial.MaterialType);
			oModel.setProperty(sPath + "/description", oMaterial.Description);
			oModel.setProperty(sPath + "/uom", oMaterial.BaseUoM);
			oModel.setProperty(sPath + "/costCenter", "");
			oModel.setProperty(sPath + "/assetNo", "");
		},

		onItemValueChange: function () {
			this._recalcTotal();
		},

		_recalcTotal: function () {
			var oModel = this.getView().getModel();
			var aItems = oModel.getProperty("/items") || [];
			var fTotal = aItems.reduce(function (sum, item) {
				return sum + (Number(item.quantity) || 0) * (Number(item.netPrice) || 0);
			}, 0);
			oModel.setProperty("/totalValue", fTotal.toLocaleString("vi-VN"));
		},

		onAddItemPress: function () {
			var oModel = this.getView().getModel();
			var aItems = oModel.getProperty("/items") || [];
			aItems.push(emptyItem());
			oModel.setProperty("/items", aItems);
		},

		onRemoveItemPress: function (oEvent) {
			var oModel = this.getView().getModel();
			var sPath = oEvent.getSource().getBindingContext().getPath();
			var iIndex = Number(sPath.split("/").pop());
			var aItems = oModel.getProperty("/items") || [];

			if (aItems.length <= 1) {
				MessageBox.warning("Purchase Order can co it nhat 1 vat tu.");
				return;
			}

			aItems.splice(iIndex, 1);
			oModel.setProperty("/items", aItems);
			this._recalcTotal();
		},

		onAiSuggestPress: function () {
			var oModel = this.getView().getModel();
			var aItems = oModel.getProperty("/items") || [];
			var oFirstItem = aItems[0];

			if (!oFirstItem || !oFirstItem.materialNo) {
				MessageBox.warning("Vui long chon it nhat 1 vat tu truoc khi xin goi y AI.");
				return;
			}

			this.getView().setBusy(true);

			fetch(BACKEND + "/api/ai/recommend-vendor", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					materialName: oFirstItem.description,
					materialGroup: oFirstItem.materialType,
					quantity: oFirstItem.quantity,
					budget: oFirstItem.netPrice && oFirstItem.quantity ? oFirstItem.netPrice * oFirstItem.quantity : undefined,
					vendors: oModel.getProperty("/vendors")
				})
			})
				.then(function (r) { return r.json(); })
				.then(function (res) {
					this.getView().setBusy(false);
					if (!res || !res.success) {
						MessageBox.error((res && res.message) || "Khong the goi y nha cung cap luc nay.");
						return;
					}
					oModel.setProperty("/aiRecommendation", res.recommendation);
				}.bind(this))
				.catch(function () {
					this.getView().setBusy(false);
					MessageBox.error("Khong the ket noi toi dich vu AI.");
				}.bind(this));
		},

		onSubmitPress: function () {
			var oView = this.getView();
			var oModel = oView.getModel();
			var sVendorNo = oModel.getProperty("/vendorNo");
			var aItems = oModel.getProperty("/items") || [];

			if (!sVendorNo) {
				MessageBox.warning("Vui long chon nha cung cap.");
				return;
			}

			for (var i = 0; i < aItems.length; i++) {
				var item = aItems[i];
				if (!item.materialNo || !item.quantity || !item.netPrice) {
					MessageBox.warning("Vui long dien day du Vat tu / So luong / Don gia cho tat ca dong.");
					return;
				}
				if (item.materialType === "ZAST" && !item.assetNo) {
					MessageBox.warning("Vat tu " + item.materialNo + " la tai san (ZAST), bat buoc phai co Asset No.");
					return;
				}
				if (item.materialType !== "ZAST" && !item.costCenter) {
					MessageBox.warning("Vat tu " + item.materialNo + " bat buoc phai co Cost Center.");
					return;
				}
			}

			oView.setBusy(true);

			fetch(BACKEND + "/api/po/create", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					vendorNo: sVendorNo,
					items: aItems.map(function (item) {
						return {
							materialNo: item.materialNo,
							materialType: item.materialType,
							description: item.description,
							quantity: Number(item.quantity),
							uom: item.uom,
							netPrice: Number(item.netPrice),
							costCenter: item.costCenter,
							assetNo: item.assetNo
						};
					})
				})
			})
				.then(function (oResponse) {
					return oResponse.json().then(function (oData) {
						return { status: oResponse.status, body: oData };
					});
				})
				.then(function (oResult) {
					oView.setBusy(false);

					if (!oResult.body || !oResult.body.success) {
						MessageBox.error((oResult.body && oResult.body.message) || "Khong tao duoc Purchase Order.");
						return;
					}

					var oPo = oResult.body.po;
					var sPoNumber = (oPo && (oPo.PoNumber || oPo.PONumber)) || "(SAP tra ve)";

					MessageBox.success("Da tao Purchase Order " + sPoNumber + ".", {
						title: "PO-01",
						onClose: function () {
							oModel.setProperty("/vendorNo", "");
							oModel.setProperty("/items", [emptyItem()]);
							oModel.setProperty("/totalValue", 0);
							oModel.setProperty("/aiRecommendation", "");
							this.getOwnerComponent().getRouter().navTo("dashboard");
						}.bind(this)
					});
				}.bind(this))
				.catch(function () {
					oView.setBusy(false);
					MessageBox.error("Khong the ket noi toi may chu.");
				});
		},

		onNavBack: function () {
			this.getOwnerComponent().getRouter().navTo("dashboard");
		}
	});
});
