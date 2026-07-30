sap.ui.define([
	"sap/ui/core/mvc/Controller",
	"sap/ui/model/json/JSONModel",
	"sap/m/MessageBox",
	"sap/m/MessageToast",
	"com/qdavy/procurement/model/Config"
], function (Controller, JSONModel, MessageBox, MessageToast, Config) {
	"use strict";

	var BACKEND = Config.BACKEND;
	var REQUEST_TIMEOUT_MS = 15000;

	var CEO_THRESHOLD = 300000000;
	var CFO_THRESHOLD = 100000000;

	function emptyCatalogItem() {
		return {
			isFreeText: false,
			materialNo: "",
			materialType: "",
			description: "",
			uom: "",
			quantity: null,
			estimatedValue: null,
			costCenter: "",
			internalOrder: "",
			assetNo: "",
			glAccount: ""
		};
	}

	function emptyFreeTextItem() {
		return {
			isFreeText: true,
			materialNo: "FREE_TEXT",
			materialType: "ZROH",
			description: "",
			uom: "PC",
			quantity: 1,
			estimatedValue: null,
			costCenter: "",
			internalOrder: "",
			assetNo: "",
			glAccount: ""
		};
	}

	function lineTotal(item) {
		return (Number(item.quantity) || 0) * (Number(item.estimatedValue) || 0);
	}

	function sumItems(aItems) {
		return (aItems || []).reduce(function (sum, item) {
			return sum + lineTotal(item);
		}, 0);
	}

	return Controller.extend("com.qdavy.procurement.controller.PR01", {

		onInit: function () {
			var oModel = new JSONModel({
				materials: [],
				materialsLoading: true,
				glAccounts: [],
				costCenters: [],
				internalOrders: [],
				header: { currency: "VND" },
				items: [],
				totalText: "0",
				escalationText: "",
				notifications: []
			});
			this.getView().setModel(oModel);

			this._ioToCostCenter = {};
			this._costCenterToIOs = {};

			this._loadMaterials();
			this._loadAccountingLists();

			this.getOwnerComponent().getRouter()
				.getRoute("pr01")
				.attachPatternMatched(this._onRouteMatched, this);
		},

		_onRouteMatched: function () {
			this._loadNotifications();
		},

		_loadNotifications: function () {
			var oUser = this.getOwnerComponent().getModel("user").getData();
			if (!oUser || !oUser.email) { return; }

			var oModel = this.getView().getModel();
			var that = this;

			this._fetchWithTimeout(
				BACKEND + "/api/notifications?email=" + encodeURIComponent(oUser.email)
			)
				.then(function (oResult) {
					if (!oResult || !oResult.success) { return; }
					var aList = oResult.data || [];
					oModel.setProperty("/notifications", aList);

					var aUnread = aList.filter(function (n) { return !n.read; });
					if (aUnread.length === 0) { return; }

					var oLatest = aUnread[0];
					MessageBox.information(oLatest.message, {
						title: "Thông báo đề nghị " + (oLatest.prId || ""),
						onClose: function () {
							that._markNotificationRead(oLatest.id);
						}
					});
				})
				.catch(function () { /* im lang */ });
		},

		_markNotificationRead: function (nId) {
			if (!nId) { return; }
			this._fetchWithTimeout(BACKEND + "/api/notifications/" + nId + "/read", {
				method: "PATCH",
				headers: { "Content-Type": "application/json" },
				body: "{}"
			}).catch(function () { /* im lang */ });
		},

		_loadAccountingLists: function () {
			var oModel = this.getView().getModel();
			var that = this;

			this._fetchWithTimeout(BACKEND + "/api/gl-accounts")
				.then(function (oResult) {
					if (oResult.success) { oModel.setProperty("/glAccounts", oResult.data || []); }
				})
				.catch(function () { /* im lang */ });

			this._fetchWithTimeout(BACKEND + "/api/cost-centers")
				.then(function (oResult) {
					if (oResult.success) { oModel.setProperty("/costCenters", oResult.data || []); }
				})
				.catch(function () { /* im lang */ });

			this._fetchWithTimeout(BACKEND + "/api/internal-orders")
				.then(function (oResult) {
					if (oResult.success) {
						oModel.setProperty("/internalOrders", oResult.data || []);
						that._ioToCostCenter = oResult.ioToCostCenter || {};
						that._costCenterToIOs = oResult.costCenterToIOs || {};
					}
				})
				.catch(function () { /* im lang */ });
		},

		onInternalOrderSelect: function (oEvent) {
			var oItem = oEvent.getParameter("selectedItem");
			if (!oItem) { return; }

			var sIO = oItem.getKey();
			var sPath = oEvent.getSource().getBindingContext().getPath();
			var oModel = this.getView().getModel();
			var sMappedCC = this._ioToCostCenter[sIO];

			if (sMappedCC && !oModel.getProperty(sPath + "/costCenter")) {
				oModel.setProperty(sPath + "/costCenter", sMappedCC);
				MessageToast.show("Đã tự điền Cost Center " + sMappedCC + " (theo SAP Internal Order).");
			}
		},

		onCostCenterSelect: function (oEvent) {
			var oItem = oEvent.getParameter("selectedItem");
			if (!oItem) { return; }

			var sCC = oItem.getKey();
			var sPath = oEvent.getSource().getBindingContext().getPath();
			var oModel = this.getView().getModel();
			var aMappedIOs = this._costCenterToIOs[sCC] || [];

			if (aMappedIOs.length === 1 && !oModel.getProperty(sPath + "/internalOrder")) {
				oModel.setProperty(sPath + "/internalOrder", aMappedIOs[0]);
				MessageToast.show("Đã tự điền Internal Order " + aMappedIOs[0] + " (theo SAP).");
			} else if (aMappedIOs.length > 1) {
				MessageToast.show("Cost Center này gắn nhiều Internal Order — vui lòng chọn đúng IO.");
			}
		},

		onItemValueChange: function () {
			this._recalcTotal();
		},

		_recalcTotal: function () {
			var oModel = this.getView().getModel();
			var aItems = oModel.getProperty("/items") || [];
			var fTotal = sumItems(aItems);

			oModel.setProperty("/totalText", fTotal.toLocaleString("vi-VN"));

			var sWarn = "";
			if (fTotal > CEO_THRESHOLD) {
				sWarn = "Giá trị vượt 300 triệu VND — sau khi CFO duyệt sẽ leo thang lên CEO. Số PR SAP chỉ có sau khi duyệt cuối.";
			} else if (fTotal > CFO_THRESHOLD) {
				sWarn = "Giá trị vượt 100 triệu VND — CFO sẽ xem xét kỹ. Số PR SAP chỉ có sau khi phê duyệt.";
			}
			oModel.setProperty("/escalationText", sWarn);
		},

		_loadMaterials: function () {
			var oModel = this.getView().getModel();
			oModel.setProperty("/materialsLoading", true);

			this._fetchWithTimeout(BACKEND + "/api/materials")
				.then(function (oResult) {
					oModel.setProperty("/materialsLoading", false);
					if (!oResult.success) {
						MessageBox.error(oResult.message || "Không tải được danh sách vật tư.");
						return;
					}
					oModel.setProperty("/materials", oResult.data || []);

					// Giữ dòng chưa chọn là trống — không bị gán mã đầu tiên
					var aItems = oModel.getProperty("/items") || [];
					var bChanged = false;
					aItems.forEach(function (item) {
						if (!item.isFreeText && !item.description && item.materialNo) {
							item.materialNo = "";
							item.materialType = "";
							bChanged = true;
						}
					});
					if (bChanged) {
						oModel.setProperty("/items", aItems.slice());
					}
				})
				.catch(function (oError) {
					oModel.setProperty("/materialsLoading", false);
					MessageBox.error(oError.message);
				});
		},

		onAddItem: function () {
			var oModel = this.getView().getModel();
			var aItems = oModel.getProperty("/items").slice();
			aItems.push(emptyCatalogItem());
			oModel.setProperty("/items", aItems);
			this._recalcTotal();
		},

		onAddFreeTextItem: function () {
			var oModel = this.getView().getModel();
			var aItems = oModel.getProperty("/items").slice();
			aItems.push(emptyFreeTextItem());
			oModel.setProperty("/items", aItems);
			this._recalcTotal();
		},

		onDeleteItem: function (oEvent) {
			var sPath = oEvent.getSource().getBindingContext().getPath();
			var iIndex = parseInt(sPath.split("/").pop(), 10);

			var oModel = this.getView().getModel();
			var aItems = oModel.getProperty("/items").slice();
			aItems.splice(iIndex, 1);
			oModel.setProperty("/items", aItems);
			this._recalcTotal();
		},

		onMaterialChange: function (oEvent) {
			var oSource = oEvent.getSource();
			var sKey = oSource.getSelectedKey();
			var oCtx = oSource.getBindingContext();
			if (!oCtx) { return; }

			var sPath = oCtx.getPath();
			var oModel = this.getView().getModel();

			if (!sKey) {
				oModel.setProperty(sPath + "/materialNo", "");
				oModel.setProperty(sPath + "/materialType", "");
				oModel.setProperty(sPath + "/description", "");
				oModel.setProperty(sPath + "/uom", "");
				this._recalcTotal();
				return;
			}

			var aMaterials = oModel.getProperty("/materials") || [];
			var oMaterial = aMaterials.filter(function (m) {
				return m.MaterialNo === sKey;
			})[0];

			if (oMaterial) {
				oModel.setProperty(sPath + "/materialNo", oMaterial.MaterialNo);
				oModel.setProperty(sPath + "/materialType", oMaterial.MaterialType || "");
				oModel.setProperty(sPath + "/description", oMaterial.Description || "");
				oModel.setProperty(sPath + "/uom", oMaterial.BaseUoM || "PC");
				if (oMaterial.MaterialType !== "ZAST") {
					oModel.setProperty(sPath + "/assetNo", "");
				}
			}
			this._recalcTotal();
		},

		onResetPress: function () {
			var aItems = this.getView().getModel().getProperty("/items") || [];
			if (aItems.length === 0) { return; }

			MessageBox.confirm("Xóa toàn bộ " + aItems.length + " dòng vật tư đã nhập?", {
				actions: [MessageBox.Action.YES, MessageBox.Action.NO],
				emphasizedAction: MessageBox.Action.NO,
				onClose: function (sAction) {
					if (sAction === MessageBox.Action.YES) {
						this.getView().getModel().setProperty("/items", []);
						this._recalcTotal();
					}
				}.bind(this)
			});
		},

		onSubmitPress: function () {
			var oView = this.getView();
			var oModel = oView.getModel();
			var aItems = oModel.getProperty("/items");
			var sCurrency = oModel.getProperty("/header/currency");
			var oUser = this.getOwnerComponent().getModel("user").getData();

			if (!aItems || aItems.length === 0) {
				MessageBox.warning("Vui lòng thêm ít nhất 1 vật tư vào danh sách.");
				return;
			}

			for (var i = 0; i < aItems.length; i++) {
				var item = aItems[i];
				var idx = i + 1;

				if (!item.isFreeText && !item.materialNo) {
					MessageBox.warning("Dòng " + idx + ": Vui lòng chọn vật tư.");
					return;
				}
				if (!item.description) {
					MessageBox.warning("Dòng " + idx + ": Vui lòng nhập Mô tả (SAP bắt buộc phải có Kurztext).");
					return;
				}
				if (!item.quantity || Number(item.quantity) <= 0) {
					MessageBox.warning("Dòng " + idx + ": Vui lòng nhập số lượng hợp lệ.");
					return;
				}
				if (!item.estimatedValue || Number(item.estimatedValue) <= 0) {
					MessageBox.warning("Dòng " + idx + ": Vui lòng nhập giá trị ước tính hợp lệ.");
					return;
				}
				if (!item.glAccount) {
					MessageBox.warning("Dòng " + idx + ": Vui lòng chọn GL Account.");
					return;
				}
				if (!item.costCenter && !item.internalOrder) {
					MessageBox.warning("Dòng " + idx + ": Vui lòng chọn Cost Center hoặc Internal Order.");
					return;
				}
			}

			var nTotalPRValue = sumItems(aItems);

			oView.setBusy(true);

			this._fetchWithTimeout(BACKEND + "/api/approval/submit", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					requesterEmail: oUser.email,
					currency: sCurrency,
					totalPRValue: nTotalPRValue,
					items: aItems
				})
			})
				.then(function (oResult) {
					oView.setBusy(false);

					if (!oResult.success) {
						MessageBox.error(oResult.message || "Không tạo được đề nghị mua sắm.");
						return;
					}

					var oApproval = oResult.approval || {};
					var sPrNumber = oApproval.PRId || "";
					var iItemCount = (oApproval.items && oApproval.items.length) || 0;
					var aWarnings = [];
					if (oApproval.needsLegalReview) {
						aWarnings.push("Giá trị > 100 triệu VND — CFO sẽ xem xét kỹ.");
					}
					if (oApproval.needsProcurementHeadReview) {
						aWarnings.push("Giá trị > 300 triệu VND — sau CFO có thể leo thang CEO.");
					}

					var sMsg = "✓ Đã gửi đề nghị " + sPrNumber + "\n\n"
						+ "Gồm " + iItemCount + " dòng vật tư, tổng "
						+ nTotalPRValue.toLocaleString("vi-VN") + " " + sCurrency + ".\n"
						+ "Đang chờ Purchasing xem xét.\n"
						+ "Số PR trên SAP sẽ được cấp sau khi phê duyệt xong.\n"
						+ "Bạn sẽ nhận thông báo khi được duyệt hoặc bị từ chối.";
					if (aWarnings.length) {
						sMsg += "\n\nLưu ý: " + aWarnings.join(" ");
					}

					MessageBox.success(sMsg, {
						title: "Đã gửi đề nghị — " + sPrNumber,
						onClose: function () {
							oModel.setProperty("/items", []);
							this._recalcTotal();
							this.getOwnerComponent().getRouter().navTo("dashboard");
						}.bind(this)
					});
				}.bind(this))
				.catch(function (oError) {
					oView.setBusy(false);
					MessageBox.error(oError.message);
				});
		},

		onNavBack: function () {
			this.getOwnerComponent().getRouter().navTo("dashboard");
		},

		_fetchWithTimeout: function (sUrl, oOptions) {
			var oAbort = (typeof AbortController !== "undefined") ? new AbortController() : null;
			var iTimer = oAbort ? setTimeout(function () { oAbort.abort(); }, REQUEST_TIMEOUT_MS) : null;

			var oFetchOptions = Object.assign({}, oOptions, {
				signal: oAbort ? oAbort.signal : undefined
			});

			return fetch(sUrl, oFetchOptions)
				.then(function (oResponse) {
					if (iTimer) { clearTimeout(iTimer); }

					return oResponse.json()
						.catch(function () { return {}; })
						.then(function (oBody) {
							if (oResponse.status === 401 || oResponse.status === 403) {
								throw new Error("Bạn không có quyền thực hiện thao tác này. Vui lòng đăng nhập lại.");
							}
							if (oResponse.status >= 500) {
								throw new Error("Máy chủ đang gặp sự cố, vui lòng thử lại sau.");
							}
							return oBody;
						});
				})
				.catch(function (oError) {
					if (iTimer) { clearTimeout(iTimer); }
					if (oError && oError.name === "AbortError") {
						throw new Error("Server phản hồi quá lâu. Vui lòng kiểm tra mạng và thử lại.");
					}
					if (oError instanceof TypeError) {
						throw new Error("Không thể kết nối tới máy chủ. Vui lòng thử lại sau.");
					}
					throw oError;
				});
		}
	});
});