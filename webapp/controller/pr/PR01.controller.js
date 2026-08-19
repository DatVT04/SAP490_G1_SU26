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
			assetNumbers: []
		};
	}

	// Tai san (ZAST): moi don vi so luong can 1 ma Asset rieng (khong gop chung
	// 1 ma cho ca dong nhieu so luong) — moi ma se thanh 1 dong PR rieng (Quantity=1)
	// khi gui len SAP, xem _expandItemsForSubmit.
	//
	// aMapped = cac ma tai san da khai san cho vat tu nay (danh muc anh xa, xem
	// /api/asset-map). Dien lan luot vao cac o; o nao vuot qua so ma da khai thi
	// de trong cho nguoi de nghi nhap tay.
	function buildAssetNumbers(sMaterialType, nQuantity, sFirstAssetNo, aMapped) {
		if (sMaterialType !== "ZAST") { return []; }
		var n = Math.max(1, Math.floor(Number(nQuantity) || 0));
		var aMap = aMapped || [];
		var aResult = [];
		for (var i = 0; i < n; i++) {
			var sValue = (i === 0 && sFirstAssetNo) ? sFirstAssetNo : (aMap[i] || "");
			aResult.push({ value: sValue });
		}
		return aResult;
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

			this._assetMap = {};

			this._loadMaterials();
			this._loadAccountingLists();
			this._loadThresholds();
			this._loadAssetMap();

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
				var sMaterialType = it.MaterialType || "";
				var nQuantity = Number(it.Quantity) || null;
				return {
					isFreeText: !!it.isFreeText,
					materialNo: it.MaterialNo || "",
					materialType: sMaterialType,
					acctAssignCat: it.AcctAssignCat || (sMaterialType === "ZAST" ? "A" : "K"),
					description: it.Description || "",
					uom: it.UoM || "",
					quantity: nQuantity,
					estimatedValue: Number(it.EstimatedValue) || null,
					costCenter: it.CostCenter || "",
					internalOrder: it.InternalOrder || "",
					internalOrderText: "",
					filteredInternalOrders: [],
					assetNumbers: buildAssetNumbers(sMaterialType, nQuantity, it.AssetNo || "")
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
				// Da khoa bo phan (that._userCC) thi GHI DE, khong chi dien khi trong:
				// dong cu con giu bo phan khac (vd nguoi dung doi tai khoan tren cung
				// trinh duyet) van phai bi keo ve dung bo phan cua tai khoan hien tai.
				if (that._userCC && item.costCenter !== that._userCC) {
					item.costCenter = that._userCC;
					bChanged = true;
				} else if (!item.costCenter && sCC) {
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

					// ── KHOA BO PHAN THEO TAI KHOAN ────────────────────────────────
					// Moi nguoi CHI duoc lap de nghi mua sam cho chinh bo phan cua minh.
					// Bo phan lay tu EmployeeSet-CostCenter tren SAP (Login.controller.js
					// do vao model "user"), khong phai nguoi dung tu khai — nen them tai
					// khoan requester cho phong moi la tu dong khoa dung phong do, khong
					// phai sua code (yeu cau 16/08).
					var sUserCC = String(
						that.getOwnerComponent().getModel("user").getProperty("/costCenter") || ""
					).trim();
					if (sUserCC) {
						var oMine = aCC.filter(function (cc) {
							return String(cc.CostCenter) === sUserCC;
						})[0] || {
							CostCenter: sUserCC,
							Description: VN_CC[sUserCC] || sUserCC
						};

						// Danh sach chi con DUNG 1 bo phan -> khong con gi de chon nham.
						oModel.setProperty("/costCenters", [oMine]);
						oModel.setProperty("/lockCostCenter", true);
						oModel.setProperty("/lockedCostCenterText",
							oMine.Description === sUserCC
								? sUserCC
								: oMine.Description + " (" + sUserCC + ")");
						oModel.setProperty("/costCenterHint", "");

						that._userCC = sUserCC;
						that._defaultCC = sUserCC;
					} else {
						// Tai khoan chua duoc gan Cost Center tren SAP: khong doan bua mot
						// phong nao do cho no chay: chon nham phong la sai ca hach toan lan
						// ngan sach. Mo lai o chon + bao ro de bo phan nhan su bo sung.
						oModel.setProperty("/lockCostCenter", false);
						oModel.setProperty("/costCenterHint",
							"Tài khoản của bạn chưa được gán Bộ phận (Cost Center) trên SAP — "
							+ "vui lòng báo quản trị bổ sung trong EmployeeSet trước khi lập đề nghị.");
						if (aCC.length > 0 && !that._defaultCC) {
							that._defaultCC = aCC[0].CostCenter || "";
						}
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
						MessageBox.error((oResult && oResult.message) || "Không tải được danh sách vật tư / dịch vụ.");
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
				MessageToast.show("Phải có ít nhất 1 dòng.");
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
			if (!oModel.getProperty(sPath + "/costCenter") && this._defaultCC) {
				oModel.setProperty(sPath + "/costCenter", this._defaultCC);
			}
			var oItem = oModel.getProperty(sPath);
			this._refreshIOListOfItem(oItem);
			// Doi sang vat tu khac: xoa cac ma tai san cua vat tu CU truoc, neu
			// khong _syncAssetNumbers se coi chung la "nguoi dung tu nhap" va giu
			// lai — dong PR se mang ma tai san cua mat hang khac.
			oItem.assetNumbers = [];
			this._syncAssetNumbers(oItem);
			oModel.setProperty(sPath, oItem);

			var aMapped = this._assetsOfMaterial(oItem.materialNo);
			if (bAsset && aMapped.length === 0) {
				MessageToast.show("Vật tư " + oItem.materialNo
					+ " chưa khai mã tài sản trong Cấu hình — nhập tay mã tài sản (AS01).");
			}

			this._recalcTotal();
		},

		// Goi khi nguoi dung go xong So luong va roi khoi o (Enter/Tab): tu dong
		// sinh du so o Asset theo so luong (chi ap dung cho vat tu Tai san ZAST).
		onQuantityChange: function (oEvent) {
			var oCtx = oEvent.getSource().getBindingContext();
			if (!oCtx) { return; }
			var sPath = oCtx.getPath();
			var oModel = this.getView().getModel();
			var oItem = oModel.getProperty(sPath);
			this._syncAssetNumbers(oItem);
			oModel.setProperty(sPath, oItem);
			this._recalcTotal();
		},

		// ── DANH MUC ANH XA VAT TU -> MA TAI SAN ──
		// SAP khong co lien ket san Material <-> Asset (MM va FI-AA la 2 module
		// khac nhau), nen quan he nay do Ke toan khai o man Cau hinh. Tai 1 lan
		// luc mo man de moi lan chon vat tu khong phai goi lai server.
		_loadAssetMap: function () {
			var that = this;
			fetch(BACKEND + "/api/asset-map")
				.then(function (r) { return r.json(); })
				.then(function (res) {
					that._assetMap = (res && res.byMaterial) || {};
				})
				.catch(function () {
					// Khong chan man hinh: thieu danh muc thi o Asset de trong,
					// nguoi de nghi van nhap tay duoc nhu truoc day.
					that._assetMap = {};
				});
		},

		// Chuan hoa khoa giong normalizeMaterialKey ben src/lib/store.js — SAP tra
		// ma vat tu luc co so 0 dem dau luc khong.
		_assetsOfMaterial: function (sMaterialNo) {
			var s = String(sMaterialNo || "").trim().toUpperCase();
			if (!s) { return []; }
			var sKey = /^\d+$/.test(s) ? (s.replace(/^0+/, "") || "0") : s;
			var raw = (this._assetMap || {})[sKey];
			if (raw == null || raw === "") { return []; }
			var aList = Array.isArray(raw) ? raw : String(raw).split(",");
			return aList.map(function (x) { return String(x || "").trim(); }).filter(Boolean);
		},

		// Giu lai gia tri Asset da nhap theo dung vi tri khi resize mang assetNumbers
		// (khong xoa sach roi nhap lai khi nguoi dung sua so luong). O nao con
		// trong thi dien tiep tu danh muc anh xa.
		_syncAssetNumbers: function (item) {
			if (item.materialType !== "ZAST") {
				item.assetNumbers = [];
				return;
			}
			var n = Math.max(1, Math.floor(Number(item.quantity) || 0));
			var aOld = item.assetNumbers || [];
			var aMapped = this._assetsOfMaterial(item.materialNo);
			var aNew = [];
			for (var i = 0; i < n; i++) {
				var sOld = (aOld[i] && String(aOld[i].value || "").trim()) || "";
				// Nguoi dung da sua tay thi TON TRONG gia tri do, khong ghi de bang
				// danh muc — danh muc chi dien vao o dang trong.
				aNew.push({ value: sOld || (aMapped[i] || "") });
			}
			item.assetNumbers = aNew;
		},

		// Vat tu Tai san (ZAST) so luong > 1: moi ma Asset thanh 1 dong PR rieng
		// (Quantity=1) de SAP luu dung 1 Asset / 1 dong, khong gop nhieu Asset vao
		// chung 1 dong. Backend (approval.routes.js) khong doi gi — van nhan
		// items[].assetNo nhu truoc, chi la gio co the co nhieu dong hon input.
		_expandItemsForSubmit: function (aItems) {
			var aResult = [];
			aItems.forEach(function (item) {
				if (item.materialType === "ZAST" && item.assetNumbers && item.assetNumbers.length > 1) {
					item.assetNumbers.forEach(function (oAsset) {
						var oSplit = Object.assign({}, item);
						oSplit.quantity = 1;
						oSplit.assetNo = oAsset.value;
						delete oSplit.assetNumbers;
						aResult.push(oSplit);
					});
				} else {
					var oCopy = Object.assign({}, item);
					oCopy.assetNo = (item.assetNumbers && item.assetNumbers[0] && item.assetNumbers[0].value) || "";
					delete oCopy.assetNumbers;
					aResult.push(oCopy);
				}
			});
			return aResult;
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
				MessageBox.warning("Vui lòng thêm ít nhất 1 dòng vật tư / dịch vụ vào danh sách.");
				return;
			}

			for (var i = 0; i < aItems.length; i++) {
				var item = aItems[i];
				var idx = i + 1;

				if (!item.materialNo) {
					MessageBox.warning("Dòng " + idx + ": Vui lòng chọn vật tư / dịch vụ.");
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
				// Lop chan thu 2 (lop 1 la o nhap da khoa, lop 3 la backend): du lieu cu
				// trong model van co the mang bo phan khac neu nguoi dung doi tai khoan
				// giua chung ma khong tai lai trang.
				if (this._userCC && item.costCenter !== this._userCC) {
					MessageBox.error("Dòng " + idx + ": bạn chỉ được lập đề nghị cho bộ phận "
						+ this._userCC + ". Vui lòng tải lại trang.");
					return;
				}
				// ZAST thêm bắt buộc đủ Asset No cho từng đơn vị số lượng
				if (item.materialType === "ZAST") {
					var aAssets = item.assetNumbers || [];
					if (aAssets.length !== Number(item.quantity)
						|| aAssets.some(function (a) { return !String(a.value || "").trim(); })) {
						MessageBox.warning("Dòng " + idx + ": Vật tư Tài sản (ZAST) bắt buộc nhập đủ "
							+ item.quantity + " mã Asset (mỗi đơn vị số lượng 1 mã).");
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
					items: this._expandItemsForSubmit(aItems),
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
					// Ma hien thi: chua co PR that -> "DN-<InternalId>" (backend tinh san
					// DisplayId; fallback tu ghep cho ban ghi cu).
					var sPrNumber = oApproval.DisplayId || ("DN-" + (oApproval.PRId || ""));
					var iItemCount = (oApproval.items && oApproval.items.length) || 0;
					var aWarnings = [];
					if (oApproval.needsProcurementHeadReview) {
						aWarnings.push("Dự kiến vượt ngưỡng IO — đơn hàng (PO) sẽ cần CEO duyệt.");
					} else if (oApproval.needsLegalReview) {
						aWarnings.push("Giá trị lớn — CFO sẽ xem kỹ khi duyệt đơn hàng.");
					}
					var sMsg = "✓ Đã gửi đề nghị " + sPrNumber
						+ (bIsResubmit ? " (bản gửi lại)" : "") + "\n\n"
						+ "Gồm " + iItemCount + " dòng, tổng "
						+ nTotalPRValue.toLocaleString("vi-VN") + " " + sCurrency + ".\n"
						+ "Đang chờ Purchasing xem xét — PR trên SAP sẽ được tạo khi Purchasing duyệt.";
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