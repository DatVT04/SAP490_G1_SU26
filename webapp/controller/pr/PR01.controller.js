sap.ui.define([
	"sap/ui/core/mvc/Controller",
	"sap/ui/model/json/JSONModel",
	"sap/m/MessageBox",
	"sap/m/MessageToast",
	"com/qdavy/procurement/model/Config"
], function (Controller, JSONModel, MessageBox, MessageToast, Config) {
	"use strict";

	var BACKEND = Config.BACKEND;
	var REQUEST_TIMEOUT_MS = 20000;
	var LEGAL_WARN_THRESHOLD = 100000000;

	var VN_CC = {
		"CCOPS": "Phòng Vận hành",
		"CCBUS": "Phòng Kinh doanh",
		"CCFIN": "Phòng Tài chính",
		"CCHR": "Phòng Nhân sự",
		"CCIT": "Phòng CNTT",
		"CCADM": "Phòng Hành chính",
		"CCPUR": "Phòng Mua hàng",
		"CCTECH": "Phòng Công nghệ"
	};

	function emptyCatalogItem(defaults) {
		defaults = defaults || {};
		return {
			isFreeText: false,
			materialNo: "",
			materialType: "",
			acctAssignCat: "K",
			description: "",
			uom: "",
			quantity: null,
			estimatedValue: null,
			costCenter: defaults.costCenter || "",
			internalOrder: "",
			internalOrderText: "",
			filteredInternalOrders: [],
			assetNo: ""
		};
	}

	function syncAcctAssignCat(aItems) {
		(aItems || []).forEach(function (it) {
			it.acctAssignCat = it.materialType === "ZAST" ? "A" : "K";
		});
	}

	function lineTotal(item) {
		return (Number(item.quantity) || 0) * (Number(item.estimatedValue) || 0);
	}

	function sumItems(aItems) {
		return (aItems || []).reduce(function (sum, item) {
			return sum + lineTotal(item);
		}, 0);
	}

	return Controller.extend("com.qdavy.procurement.controller.pr.PR01", {

		onInit: function () {
			var oModel = new JSONModel({
				materials: [],
				materialsLoading: true,
				costCenters: [],
				internalOrders: [],
				header: { currency: "VND" },
				items: [emptyCatalogItem()],
				totalText: "0",
				escalationText: "",
				notifications: [],
				ioThresholds: {}
			});
			this.getView().setModel(oModel);

			this._ioToCostCenter = {};
			this._costCenterToIOs = {};
			this._defaultIO = "";
			this._defaultCC = "";
			this._userCC = "";
			this._resubmitOf = null;

			this._loadMaterials();
			this._loadAccountingLists();
			this._loadThresholds();

			this.getOwnerComponent().getRouter()
				.getRoute("pr01")
				.attachPatternMatched(this._onRouteMatched, this);
		},

		_onRouteMatched: function () {
			this._loadNotifications();
			this._applyResubmitIfAny();
			var oModel = this.getView().getModel();
			var aItems = oModel.getProperty("/items") || [];
			if (aItems.length === 0) {
				oModel.setProperty("/items", [this._newItem()]);
				this._recalcTotal();
			}
		},

		_applyResubmitIfAny: function () {
			var oComp = this.getOwnerComponent();
			var oResubmitModel = oComp.getModel("resubmit");
			if (!oResubmitModel) { return; }

			var oData = oResubmitModel.getData() || {};
			oComp.setModel(null, "resubmit");
			if (!oData.internalId) { return; }

			this._resubmitOf = oData.internalId;

			var oModel = this.getView().getModel();
			var aOldItems = (oData.items || []).map(function (it) {
				return {
					isFreeText: !!it.isFreeText,
					materialNo: it.MaterialNo || "",
					materialType: it.MaterialType || "",
					acctAssignCat: it.AcctAssignCat || (it.MaterialType === "ZAST" ? "A" : "K"),
					description: it.Description || "",
					uom: it.UoM || "",
					quantity: Number(it.Quantity) || null,
					estimatedValue: Number(it.EstimatedValue) || null,
					costCenter: it.CostCenter || "",
					internalOrder: it.InternalOrder || "",
					internalOrderText: "",
					filteredInternalOrders: [],
					assetNo: it.AssetNo || ""
				};
			});
			if (aOldItems.length === 0) {
				aOldItems = [this._newItem()];
			}
			aOldItems.forEach(function (item) { this._refreshIOListOfItem(item); }, this);

			oModel.setProperty("/header/currency", oData.currency || "VND");
			oModel.setProperty("/items", aOldItems);
			this._recalcTotal();

			MessageBox.information(
				"Bạn đang sửa lại đề nghị " + oData.prId + " bị Purchasing trả lại."
				+ (oData.returnReason ? ("\n\nLý do trả lại: " + oData.returnReason) : "")
				+ "\n\nDữ liệu cũ đã được điền sẵn — sửa xong bấm Gửi.",
				{ title: "Sửa & gửi lại đề nghị" }
			);
		},

		_newItem: function () {
			var oItem = emptyCatalogItem(this._getDefaults());
			this._refreshIOListOfItem(oItem);
			return oItem;
		},

		_getDefaults: function () {
			return { costCenter: this._defaultCC || "" };
		},

		_ioListFor: function (sCostCenter) {
			var sCC = String(sCostCenter || "").trim();
			if (!sCC) { return []; }
			var aCodes = (this._costCenterToIOs && this._costCenterToIOs[sCC]) || [];
			var aAllIO = this.getView().getModel().getProperty("/internalOrders") || [];
			return aAllIO.filter(function (io) {
				return aCodes.indexOf(io.InternalOrder) !== -1;
			});
		},

		_refreshIOListOfItem: function (item) {
			var aIO = this._ioListFor(item.costCenter);
			item.filteredInternalOrders = aIO;

			var sIO = String(item.internalOrder || "").trim();
			var oPicked = aIO.filter(function (io) { return io.InternalOrder === sIO; })[0];

			if (!oPicked) {
				oPicked = aIO.length === 1 ? aIO[0] : (aIO[0] || null);
				item.internalOrder = oPicked ? oPicked.InternalOrder : "";
			}

			item.internalOrderText = oPicked
				? (oPicked.InternalOrder + (oPicked.Description ? " — " + oPicked.Description : ""))
				: (item.costCenter ? "Phòng này chưa gán ngân sách" : "—");
		},

		_applyDefaultsToEmptyItems: function () {
			var oModel = this.getView().getModel();
			var aItems = oModel.getProperty("/items") || [];
			var bChanged = false;
			var sCC = this._defaultCC;
			var that = this;

			aItems.forEach(function (item) {
				if (!item.costCenter && sCC) {
					item.costCenter = sCC;
					bChanged = true;
				}
				var before = item.internalOrder;
				that._refreshIOListOfItem(item);
				if (item.internalOrder !== before) { bChanged = true; }
			});
			if (bChanged) {
				oModel.setProperty("/items", aItems.slice());
				this._recalcTotal();
			}
		},

		_loadThresholds: function () {
			var oModel = this.getView().getModel();
			var that = this;
			this._fetchWithTimeout(BACKEND + "/api/thresholds")
				.then(function (oResult) {
					if (oResult && oResult.success) {
						oModel.setProperty("/ioThresholds", oResult.byIO || {});
						that._recalcTotal();
					}
				})
				.catch(function () { /* ignore */ });
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
					if (!aUnread.length) { return; }
					var oLatest = aUnread[0];
					MessageBox.information(oLatest.message, {
						title: "Thông báo đề nghị " + (oLatest.prId || ""),
						onClose: function () { that._markNotificationRead(oLatest.id); }
					});
				})
				.catch(function () { /* ignore */ });
		},

		_markNotificationRead: function (nId) {
			if (!nId) { return; }
			this._fetchWithTimeout(BACKEND + "/api/notifications/" + nId + "/read", {
				method: "PATCH",
				headers: { "Content-Type": "application/json" },
				body: "{}"
			}).catch(function () { /* ignore */ });
		},

		_loadAccountingLists: function () {
			var oModel = this.getView().getModel();
			var that = this;

			this._fetchWithTimeout(BACKEND + "/api/cost-centers")
				.then(function (oResult) {
					if (!oResult || !oResult.success) { return; }
					var aCC = (oResult.data || []).map(function (cc) {
						var code = String(cc.CostCenter || "").trim();
						var vn = VN_CC[code] || VN_CC[code.replace(/^0+/, "")];
						return {
							CostCenter: code,
							Description: vn || cc.Description || code
						};
					});
					oModel.setProperty("/costCenters", aCC);

					var sUserCC = String(
						that.getOwnerComponent().getModel("user").getProperty("/costCenter") || ""
					).trim();
					if (sUserCC) {
						var bInList = aCC.some(function (cc) {
							return String(cc.CostCenter) === sUserCC;
						});
						if (!bInList) {
							aCC = [{
								CostCenter: sUserCC,
								Description: VN_CC[sUserCC] || (sUserCC + " — bộ phận của bạn")
							}].concat(aCC);
							oModel.setProperty("/costCenters", aCC);
						}
						that._userCC = sUserCC;
						that._defaultCC = sUserCC;
					} else if (aCC.length > 0 && !that._defaultCC) {
						that._defaultCC = aCC[0].CostCenter || "";
					}
					that._applyDefaultsToEmptyItems();
				})
				.catch(function () { /* ignore */ });

			this._fetchWithTimeout(BACKEND + "/api/internal-orders")
				.then(function (oResult) {
					if (!oResult || !oResult.success) { return; }
					var aIO = oResult.data || [];
					oModel.setProperty("/internalOrders", aIO);
					that._ioToCostCenter = oResult.ioToCostCenter || {};
					that._costCenterToIOs = oResult.costCenterToIOs || {};

					var oTh = oModel.getProperty("/ioThresholds") || {};
					aIO.forEach(function (io) {
						if (io.Budget != null && Number(io.Budget) > 0) {
							oTh[io.InternalOrder] = Number(io.Budget);
						}
					});
					oModel.setProperty("/ioThresholds", oTh);

					if (aIO.length > 0) {
						that._defaultIO = aIO[0].InternalOrder || "";
						if (that._defaultIO && that._ioToCostCenter[that._defaultIO] && !that._userCC) {
							that._defaultCC = that._ioToCostCenter[that._defaultIO];
						}
					}
					that._applyDefaultsToEmptyItems();
					that._recalcTotal();
				})
				.catch(function () { /* ignore */ });
		},

		onCostCenterSelect: function (oEvent) {
			var oCtx = oEvent.getSource().getBindingContext();
			if (!oCtx) {
				this._recalcTotal();
				return;
			}
			var sPath = oCtx.getPath();
			var oModel = this.getView().getModel();
			var oItem = oModel.getProperty(sPath);
			this._refreshIOListOfItem(oItem);
			oModel.setProperty(sPath, oItem);
			oModel.refresh(true);
			this._recalcTotal();
		},

		onItemValueChange: function () {
			this._recalcTotal();
		},

		_recalcTotal: function () {
			var oModel = this.getView().getModel();
			var aItems = oModel.getProperty("/items") || [];
			syncAcctAssignCat(aItems);

			var fTotal = sumItems(aItems);
			var oTh = oModel.getProperty("/ioThresholds") || {};
			oModel.setProperty("/totalText", fTotal.toLocaleString("vi-VN"));

			var sWarn = "";
			var bOverIO = false;
			var sHitIO = "";
			var nHitTh = null;

			aItems.forEach(function (it) {
				var sIO = String(it.internalOrder || "").trim();
				if (!sIO) { return; }
				var nTh = oTh[sIO];
				if (nTh == null) { return; }
				nTh = Number(nTh);
				if (!isNaN(nTh) && fTotal > nTh) {
					bOverIO = true;
					if (nHitTh == null || nTh < nHitTh) {
						nHitTh = nTh;
						sHitIO = sIO;
					}
				}
			});

			if (bOverIO) {
				sWarn = "Tổng giá trị vượt ngưỡng Internal Order " + sHitIO
					+ " (" + Number(nHitTh).toLocaleString("vi-VN") + " VND) — sau CFO sẽ leo thang lên CEO.";
			} else if (fTotal > LEGAL_WARN_THRESHOLD) {
				sWarn = "Giá trị lớn (> 100 triệu VND) — CFO sẽ xem xét kỹ.";
			} else if (aItems.some(function (it) { return !!String(it.internalOrder || "").trim(); })) {
				sWarn = "Đề nghị tính vào ngân sách của phòng. Leo CEO khi vượt ngưỡng đã cấu hình.";
			}
			oModel.setProperty("/escalationText", sWarn);
		},

		_loadMaterials: function () {
			var oModel = this.getView().getModel();
			oModel.setProperty("/materialsLoading", true);
			this._fetchWithTimeout(BACKEND + "/api/materials")
				.then(function (oResult) {
					oModel.setProperty("/materialsLoading", false);
					if (!oResult || !oResult.success) {
						MessageBox.error((oResult && oResult.message) || "Không tải được danh sách vật tư.");
						return;
					}
					oModel.setProperty("/materials", oResult.data || []);
				})
				.catch(function (oError) {
					oModel.setProperty("/materialsLoading", false);
					MessageBox.error(oError.message);
				});
		},

		onAddItem: function () {
			var oModel = this.getView().getModel();
			var aItems = oModel.getProperty("/items").slice();
			aItems.push(this._newItem());
			oModel.setProperty("/items", aItems);
			this._recalcTotal();
		},

		onDeleteItem: function (oEvent) {
			var oCtx = oEvent.getSource().getBindingContext();
			if (!oCtx) { return; }
			var iIndex = parseInt(oCtx.getPath().split("/").pop(), 10);
			var oModel = this.getView().getModel();
			var aItems = oModel.getProperty("/items").slice();
			if (aItems.length <= 1) {
				MessageToast.show("Phải có ít nhất 1 dòng vật tư.");
				return;
			}
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
			if (!oMaterial) { return; }

			var sType = String(oMaterial.MaterialType || "").trim().toUpperCase();
			var bAsset = (sType === "ZAST");

			oModel.setProperty(sPath + "/materialNo", oMaterial.MaterialNo);
			oModel.setProperty(sPath + "/materialType", sType);
			oModel.setProperty(sPath + "/description", oMaterial.Description || "");
			oModel.setProperty(sPath + "/uom", oMaterial.BaseUoM || "PC");
			oModel.setProperty(sPath + "/acctAssignCat", bAsset ? "A" : "K");

			// ZAST và hàng thường: đều giữ / gán CC + IO
			if (!bAsset) {
				oModel.setProperty(sPath + "/assetNo", "");
			}
			if (!oModel.getProperty(sPath + "/costCenter") && this._defaultCC) {
				oModel.setProperty(sPath + "/costCenter", this._defaultCC);
			}
			var oItem = oModel.getProperty(sPath);
			this._refreshIOListOfItem(oItem);
			oModel.setProperty(sPath, oItem);

			this._recalcTotal();
		},

		onResetPress: function () {
			var aItems = this.getView().getModel().getProperty("/items") || [];
			if (aItems.length === 0) { return; }
			MessageBox.confirm("Xóa toàn bộ dòng và tạo lại 1 dòng trống?", {
				actions: [MessageBox.Action.YES, MessageBox.Action.NO],
				emphasizedAction: MessageBox.Action.NO,
				onClose: function (sAction) {
					if (sAction === MessageBox.Action.YES) {
						this.getView().getModel().setProperty("/items", [this._newItem()]);
						this._recalcTotal();
					}
				}.bind(this)
			});
		},

		onSubmitPress: function () {
			var oView = this.getView();
			var oModel = oView.getModel();
			var aItems = oModel.getProperty("/items");
			var sCurrency = oModel.getProperty("/header/currency") || "VND";
			var oUser = this.getOwnerComponent().getModel("user").getData();

			syncAcctAssignCat(aItems);

			if (!aItems || aItems.length === 0) {
				MessageBox.warning("Vui lòng thêm ít nhất 1 vật tư vào danh sách.");
				return;
			}

			for (var i = 0; i < aItems.length; i++) {
				var item = aItems[i];
				var idx = i + 1;

				if (!item.materialNo) {
					MessageBox.warning("Dòng " + idx + ": Vui lòng chọn vật tư.");
					return;
				}
				if (!item.description) {
					MessageBox.warning("Dòng " + idx + ": Vui lòng nhập Mô tả.");
					return;
				}
				if (!item.quantity || Number(item.quantity) <= 0) {
					MessageBox.warning("Dòng " + idx + ": Vui lòng nhập số lượng hợp lệ.");
					return;
				}
				if (!item.estimatedValue || Number(item.estimatedValue) <= 0) {
					MessageBox.warning("Dòng " + idx + ": Vui lòng nhập đơn giá hợp lệ.");
					return;
				}
				// Mọi dòng (kể cả ZAST) bắt buộc Bộ phận
				if (!item.costCenter) {
					MessageBox.warning("Dòng " + idx + ": Vui lòng chọn Bộ phận (Cost Center).");
					return;
				}
				// ZAST thêm bắt buộc Asset
				if (item.materialType === "ZAST") {
					if (!String(item.assetNo || "").trim()) {
						MessageBox.warning("Dòng " + idx + ": Vật tư Tài sản (ZAST) bắt buộc nhập Asset No.");
						return;
					}
				}
			}

			var nTotalPRValue = sumItems(aItems);
			oView.setBusy(true);
			var bIsResubmit = !!this._resubmitOf;

			this._fetchWithTimeout(BACKEND + "/api/approval/submit", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					requesterEmail: oUser.email,
					currency: sCurrency,
					totalPRValue: nTotalPRValue,
					items: aItems,
					resubmitOf: this._resubmitOf || undefined
				})
			})
				.then(function (oResult) {
					oView.setBusy(false);
					if (!oResult || !oResult.success) {
						MessageBox.error((oResult && oResult.message) || "Không tạo được đề nghị mua sắm.");
						return;
					}
					var oApproval = oResult.approval || {};
					var sPrNumber = oApproval.PRId || "";
					var iItemCount = (oApproval.items && oApproval.items.length) || 0;
					var aWarnings = [];
					if (oApproval.needsProcurementHeadReview) {
						aWarnings.push("Vượt ngưỡng IO — sau CFO leo CEO.");
					} else if (oApproval.needsLegalReview) {
						aWarnings.push("Giá trị lớn — CFO xem xét kỹ.");
					}
					var sMsg = "✓ Đã gửi đề nghị " + sPrNumber
						+ (bIsResubmit ? " (bản gửi lại)" : "") + "\n\n"
						+ "Gồm " + iItemCount + " dòng, tổng "
						+ nTotalPRValue.toLocaleString("vi-VN") + " " + sCurrency + ".\n"
						+ "Đang chờ Purchasing xem xét.";
					if (aWarnings.length) {
						sMsg += "\n\nLưu ý: " + aWarnings.join(" ");
					}
					this._resubmitOf = null;
					MessageBox.success(sMsg, {
						title: "Đã gửi — " + sPrNumber,
						onClose: function () {
							oModel.setProperty("/items", [this._newItem()]);
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
			return fetch(sUrl, Object.assign({}, oOptions || {}, {
				signal: oAbort ? oAbort.signal : undefined
			}))
				.then(function (oResponse) {
					if (iTimer) { clearTimeout(iTimer); }
					return oResponse.json().catch(function () { return {}; }).then(function (oBody) {
						if (oResponse.status === 401 || oResponse.status === 403) {
							throw new Error("Bạn không có quyền. Vui lòng đăng nhập lại.");
						}
						if (oResponse.status >= 500) {
							throw new Error((oBody && oBody.message) || "Máy chủ đang gặp sự cố.");
						}
						return oBody;
					});
				})
				.catch(function (oError) {
					if (iTimer) { clearTimeout(iTimer); }
					if (oError && oError.name === "AbortError") {
						throw new Error("Server phản hồi quá lâu.");
					}
					if (oError instanceof TypeError) {
						throw new Error("Không thể kết nối tới máy chủ.");
					}
					throw oError;
				});
		}
	});
});