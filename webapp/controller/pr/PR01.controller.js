sap.ui.define([
	"sap/ui/core/mvc/Controller",
	"sap/ui/model/json/JSONModel",
	"sap/m/MessageBox",
	"sap/m/MessageToast",
	"com/qdavy/procurement/model/Config",
	"com/qdavy/procurement/model/Msg"
], function (Controller, JSONModel, MessageBox, MessageToast, Config, Msg) {
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
		"CCPUR": "Phòng Mua sắm",
		"CCTECH": "Phòng Công nghệ"
	};

	// ── Kiem tra "Ly do de nghi mua" ────────────────────────────────────────
	// Bo luat nay PHAI GIONG HET ban o src/routes/approval.routes.js. Sua ben
	// nay thi sua ca ben kia, neu khong FE cho qua roi BE moi chan — nguoi dung
	// go xong moi bi tra ve.
	// Vi sao khong chi dem ky tu: du lieu that tren ZPR_DRAFT dang co nhung ly do
	// kieu "Gmail cong ty" (13 ky tu) — du nguong cu 10 ky tu nhung nguoi duyet
	// doc xong khong quyet duoc gi. Dem them so TU de loai chuoi ngan va chuoi
	// lap 1 ky tu ("aaaaaaaaaaaaaaaaaaaaaa" = 1 tu -> truot).
	var REASON_MIN_LEN = 20;
	var REASON_MAX_LEN = 255;
	var REASON_MIN_WORDS = 4;

	function checkPurchaseReason(sText) {
		var s = String(sText || "").trim();
		if (!s) {
			return { ok: false, message: "Vui lòng nhập Lý do đề nghị mua." };
		}
		// Kiem "qua dai" TRUOC "qua ngan"/"it tu": chuoi 260 ky tu lien khong dau
		// cach chi co 1 tu, neu de sau se bao nham "can it nhat 4 tu".
		if (s.length > REASON_MAX_LEN) {
			return { ok: false, message: "Lý do tối đa " + REASON_MAX_LEN + " ký tự (hiện tại "
				+ s.length + ")." };
		}
		if (s.length < REASON_MIN_LEN) {
			return { ok: false, message: "Lý do còn quá ngắn (" + s.length + "/" + REASON_MIN_LEN
				+ " ký tự) — hãy ghi rõ hiện trạng và hậu quả nếu không mua." };
		}
		if (s.split(/\s+/).length < REASON_MIN_WORDS) {
			return { ok: false, message: "Lý do cần là một câu có nghĩa (ít nhất " + REASON_MIN_WORDS
				+ " từ), không phải vài từ rời rạc." };
		}
		return { ok: true, message: "" };
	}

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
			filteredInternalOrders: []
		};
	}

	// 21/08/2026: da BO han o nhap ma tai san khoi PR-01. Nguoi de nghi khong con
	// khai bao tai san luc lap de nghi — moi dong deu hach toan vao Cost Center cua
	// phong (Cat 'K'). Viec gan the tai san chuyen sang buoc sau khi nhan hang.
	function syncAcctAssignCat(aItems) {
		(aItems || []).forEach(function (it) {
			it.acctAssignCat = "K";
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

		// ── MA VAT TU CHO NGUOI DOC ──
		// SAP luu ma vat tu danh so trong (internal numbering) o dang 18 ky tu, don
		// day so 0 vao dau: "000000000000100001". Do la quy uoc luu tru chu khong
		// phai ma that — chinh SAP GUI cung cat het so 0 dau khi hien (conversion
		// exit ALPHA). Ham nay lam dung viec do.
		//
		// CHI DOI CHO HIEN THI. Khoa gui len OData/SAP van phai la chuoi day du, nen
		// khong duoc dung ham nay cho thuoc tinh "key" cua ComboBox hay payload.
		formatMatNo: function (sNo) {
			var s = String(sNo === null || sNo === undefined ? "" : sNo).trim();
			// Chi rut gon ma TOAN SO va co so 0 dan dau. "MON-001", "LAP-01" giu nguyen.
			if (!/^0[0-9]+$/.test(s)) { return s; }
			return s.replace(/^0+/, "") || s;
		},

		onInit: function () {
			var oModel = new JSONModel({
				materials: [],
				materialsLoading: true,
				costCenters: [],
				internalOrders: [],
				header: {
					currency: "VND",
					purchaseReason: "",
					// Bo dem ky tu hien duoi o nhap ly do — xem _updatePurchaseReasonCounter.
					purchaseReasonCounter: "0/" + REASON_MAX_LEN
				},
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

			this._matConfig = {};

			this._loadMaterials();
			this._loadAccountingLists();
			this._loadThresholds();
			this._loadMaterialConfig();

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
					acctAssignCat: "K",
					description: it.Description || "",
					uom: it.UoM || "",
					quantity: nQuantity,
					estimatedValue: Number(it.EstimatedValue) || null,
					costCenter: it.CostCenter || "",
					internalOrder: it.InternalOrder || "",
					internalOrderText: "",
					filteredInternalOrders: []
				};
			});
			if (aOldItems.length === 0) {
				aOldItems = [this._newItem()];
			}
			aOldItems.forEach(function (item) { this._refreshIOListOfItem(item); }, this);

			oModel.setProperty("/header/currency", oData.currency || "VND");
			oModel.setProperty("/header/purchaseReason", oData.purchaseReason || "");
			// Dien lai ly do thi phai chay lai bo dem + vien mau, neu khong counter
			// van dung "0/255" trong khi o nhap da co chu.
			this._updatePurchaseReasonCounter(oData.purchaseReason || "");
			var oReasonArea = this.byId("taPurchaseReason");
			if (oReasonArea && (oData.purchaseReason || "").trim()) {
				var oResubmitCheck = checkPurchaseReason(oData.purchaseReason);
				oReasonArea.setValueState(oResubmitCheck.ok ? "Success" : "Error");
				oReasonArea.setValueStateText(oResubmitCheck.message);
			}
			oModel.setProperty("/items", aOldItems);
			this._recalcTotal();

			MessageBox.information(
				"Đề nghị " + oData.prId + " đã bị Phòng Mua sắm trả lại."
				+ (oData.returnReason ? ("\n\nLý do trả lại: " + oData.returnReason) : "")
				+ "\n\nDữ liệu cũ đã được điền sẵn. Vui lòng chỉnh sửa rồi nhấn Gửi đề nghị.",
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
							+ "vui lòng liên hệ quản trị hệ thống để bổ sung trước khi lập đề nghị.");
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

		/** 22000000 -> "22.000.000". Bang 0 thi tra chuoi rong de placeholder hien. */
		formatMoney: function (nValue) {
			var n = Number(nValue) || 0;
			return n ? n.toLocaleString("vi-VN") : "";
		},

		/**
		 * Nguoi de nghi go don gia.
		 *
		 * O nay hien so co dau phan cach nghin nen KHONG doc thang getValue()
		 * thanh so duoc ("22.000.000" -> NaN). Boc lay chu so truoc, ghi vao
		 * model, roi ep o hien lai dang da dinh dang.
		 *
		 * Vi sao phai setValue lai: neu nguoi dung go "22000000" trong khi model
		 * dang la 22000000 thi setProperty khong doi gia tri -> binding khong
		 * chay lai -> o van hien "22000000" khong co dau cham. setValue lam cho
		 * ket qua luon nhu nhau du go kieu nao.
		 */
		onItemPriceChange: function (oEvent) {
			var oInput = oEvent.getSource();
			var oCtx = oInput.getBindingContext();
			if (!oCtx) { return; }

			var nValue = Number(String(oInput.getValue() || "").replace(/\D/g, "")) || 0;
			oCtx.getModel().setProperty(oCtx.getPath() + "/estimatedValue", nValue);
			oInput.setValue(this.formatMoney(nValue));

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
				sWarn = "Tổng tiền vượt hạn mức " + Number(nHitTh).toLocaleString("vi-VN")
					+ " VND của ngân sách " + sHitIO
					+ ". Đề nghị sẽ cần CFO duyệt trước, rồi CEO duyệt lần nữa.";
			} else if (fTotal > LEGAL_WARN_THRESHOLD) {
				sWarn = "Đề nghị trên 100 triệu VND — CFO sẽ xem xét kỹ trước khi duyệt.";
			} else if (aItems.some(function (it) { return !!String(it.internalOrder || "").trim(); })) {
				sWarn = "Đề nghị này trừ vào ngân sách của phòng. Nếu tổng tiền vượt hạn mức của ngân sách đó thì cần thêm CEO duyệt.";
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
						MessageBox.error((oResult && oResult.message) || "Không tải được danh sách vật tư / dịch vụ. Vui lòng thử lại.");
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
				MessageToast.show("Đề nghị phải có ít nhất một dòng vật tư / dịch vụ.");
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

			oModel.setProperty(sPath + "/materialNo", oMaterial.MaterialNo);
			oModel.setProperty(sPath + "/materialType", sType);
			oModel.setProperty(sPath + "/description", oMaterial.Description || "");
			oModel.setProperty(sPath + "/uom", oMaterial.BaseUoM || "PC");
			oModel.setProperty(sPath + "/acctAssignCat", "K");

			// ZAST và hàng thường: đều giữ / gán CC + IO
			if (!oModel.getProperty(sPath + "/costCenter") && this._defaultCC) {
				oModel.setProperty(sPath + "/costCenter", this._defaultCC);
			}
			var oItem = oModel.getProperty(sPath);
			this._refreshIOListOfItem(oItem);
			oModel.setProperty(sPath, oItem);

			// Don gia lay tu MATERIAL MASTER (MM02 -> Accounting 1 -> Standard
			// price), MaterialSet tra ve cung danh sach vat tu.
			//
			// LUON GHI DE khi doi vat tu. Ban cu chi dien khi o dang trong, nen doi
			// vat tu lan 2 thi dong hang van giu gia cua vat tu TRUOC do — chon
			// TRAIN-001 (8 trieu) roi doi sang MOUSE-001 van hien 8 trieu. Don gia
			// thuoc ve vat tu, doi vat tu la no het hieu luc, y het cot Mo ta va DVT
			// deu duoc ghi de o tren.
			//
			// Vat tu moi chua khai gia -> XOA TRANG chu khong giu so cu, de nguoi de
			// nghi thay ngay la phai go tay (co them toast nhac ben duoi).
			var nMasterPrice = Number(oMaterial.StandardPrice || oMaterial.MovingPrice || 0);
			oModel.setProperty(sPath + "/estimatedValue", nMasterPrice > 0 ? nMasterPrice : 0);

			if (nMasterPrice <= 0) {
				MessageToast.show("Vật tư " + oItem.materialNo
					+ " chưa có giá trong material master (MM02) — vui lòng nhập tay.");
			}

			this._recalcTotal();
		},

		// Goi khi nguoi dung go xong So luong va roi khoi o (Enter/Tab).
		onQuantityChange: function () {
			this._recalcTotal();
		},

		// ── DANH MUC CAU HINH VAT TU (gia ke hoach + ma tai san) ──
		// Nguon: bang Z ZG1_MAT_CONFIG tren SAP. Tai 1 lan luc mo man de moi lan
		// chon vat tu khong phai goi lai server.
		_loadMaterialConfig: function () {
			var that = this;
			fetch(BACKEND + "/api/material-config")
				.then(function (r) { return r.json(); })
				.then(function (res) {
					that._matConfig = (res && res.byMaterial) || {};
				})
				.catch(function () {
					// Khong chan man hinh: thieu danh muc thi o Don gia va Ma tai san
					// de trong, nguoi de nghi van nhap tay duoc nhu truoc day.
					that._matConfig = {};
				});
		},

		// Chuan hoa khoa giong normalizeMaterialKey ben src/lib/store.js — SAP tra
		// ma vat tu luc co so 0 dem dau luc khong.
		_configOfMaterial: function (sMaterialNo) {
			var s = String(sMaterialNo || "").trim().toUpperCase();
			var oEmpty = { assetClass: "", assets: [] };
			if (!s) { return oEmpty; }
			var sKey = /^\d+$/.test(s) ? (s.replace(/^0+/, "") || "0") : s;
			var raw = (this._matConfig || {})[sKey];
			if (!raw) { return oEmpty; }
			var aAssets = (Array.isArray(raw.assets) ? raw.assets : [])
				.map(function (a) {
					if (a && typeof a === "object") {
						return { no: String(a.no || "").trim(), used: !!a.used };
					}
					return { no: String(a || "").trim(), used: false };
				})
				.filter(function (a) { return a.no; });
			return {
				assetClass: String(raw.assetClass || "").toUpperCase(),
				assets: aAssets
			};
		},

		// CHI cac ma CHUA DUNG. Moi tai san vat ly la 1 the rieng: ma da gan cho
		// lan mua truoc khong duoc dung lai cho lan mua sau (xem kho ma trong
		// src/services/material-config.service.js).
		// 21/08/2026: PR-01 khong con tach dong theo ma tai san (o nhap Asset da bo).
		// Giu ten ham de cho goi khong phai doi; nay chi tra ban sao danh sach dong
		// va don not truong asset con sot lai tu draft cua luong cu.
		_expandItemsForSubmit: function (aItems) {
			return (aItems || []).map(function (item) {
				var oCopy = Object.assign({}, item);
				delete oCopy.assetNumbers;
				delete oCopy.assetNo;
				return oCopy;
			});
		},

		/**
		 * Bao ngay luc dang go thay vi doi bam Gui moi hien MessageBox — nguoi dung
		 * khong phai doan minh sai cho nao. Chua go chu nao thi de yen (None),
		 * khong to do man hinh ngay khi vua mo.
		 */
		onPurchaseReasonLiveChange: function (oEvent) {
			var oTextArea = oEvent.getSource();
			var sValue = String(oEvent.getParameter("value") || "");
			this._updatePurchaseReasonCounter(sValue);

			if (!sValue.trim()) {
				oTextArea.setValueState("None");
				oTextArea.setValueStateText("");
				return;
			}
			var oCheck = checkPurchaseReason(sValue);
			oTextArea.setValueState(oCheck.ok ? "Success" : "Error");
			oTextArea.setValueStateText(oCheck.message);
		},

		/**
		 * Cap nhat bo dem "34/255" duoi o nhap.
		 * Dem theo do dai THO (khong trim) vi maxLength cua trinh duyet cung dem tho
		 * — de so tren man hinh trung voi so ky tu that su go duoc.
		 * Tu 230 ky tu tro len thi doi mau cam de nguoi dung biet sap cham tran.
		 */
		_updatePurchaseReasonCounter: function (sValue) {
			var oModel = this.getView().getModel();
			var sText = sValue != null
				? String(sValue)
				: String(oModel.getProperty("/header/purchaseReason") || "");
			var iLen = sText.length;
			oModel.setProperty("/header/purchaseReasonCounter",
				iLen >= REASON_MAX_LEN
					? iLen + "/" + REASON_MAX_LEN + " — đã đạt giới hạn"
					: iLen + "/" + REASON_MAX_LEN);
			// Doi mau bang addStyleClass chu khong binding vao thuoc tinh class:
			// XMLView khong ho tro binding cho class (bo qua im lang, khong bao loi).
			var oCounter = this.byId("txtReasonCounter");
			if (oCounter) {
				if (iLen >= 230) {
					oCounter.addStyleClass("qdReasonCounterWarn");
				} else {
					oCounter.removeStyleClass("qdReasonCounterWarn");
				}
			}
		},

		// Xoa vien do sau khi reset / gui thanh cong, neu khong o nhap se do mai.
		_clearPurchaseReasonState: function () {
			this._updatePurchaseReasonCounter("");
			var oTextArea = this.byId("taPurchaseReason");
			if (oTextArea) {
				oTextArea.setValueState("None");
				oTextArea.setValueStateText("");
			}
		},

		onResetPress: function () {
			var aItems = this.getView().getModel().getProperty("/items") || [];
			if (aItems.length === 0) { return; }
			MessageBox.confirm("Xóa toàn bộ dòng đã nhập và bắt đầu lại? Thao tác này không thể hoàn tác.", {
				actions: [MessageBox.Action.YES, MessageBox.Action.NO],
				emphasizedAction: MessageBox.Action.NO,
				onClose: function (sAction) {
					if (sAction === MessageBox.Action.YES) {
						this.getView().getModel().setProperty("/items", [this._newItem()]);
						this.getView().getModel().setProperty("/header/purchaseReason", "");
						this._clearPurchaseReasonState();
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
				MessageBox.warning("Đề nghị chưa có dòng nào. Vui lòng thêm ít nhất một vật tư / dịch vụ vào danh sách.");
				return;
			}

			// Ly do mua: can cu de Purchasing duyet NHU CAU. Chan o day cho nguoi
			// dung thay ngay; backend con mot lop chan nua (khong tin FE).
			var sPurchaseReason = String(oModel.getProperty("/header/purchaseReason") || "").trim();
			var oReasonCheck = checkPurchaseReason(sPurchaseReason);
			if (!oReasonCheck.ok) {
				var oReasonField = this.byId("taPurchaseReason");
				if (oReasonField) {
					oReasonField.setValueState("Error");
					oReasonField.setValueStateText(oReasonCheck.message);
					oReasonField.focus();
				}
				MessageBox.warning(oReasonCheck.message + "\n\n"
					+ "Người duyệt căn cứ vào mục này để ra quyết định. Ví dụ: \"Máy tính phòng Kế toán hỏng không sửa được, cần thay 2 máy để nhân viên tiếp tục làm việc\".");
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
						+ this._userCC + ". Vui lòng tải lại trang rồi nhập lại.");
					return;
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
					purchaseReason: sPurchaseReason,
					items: this._expandItemsForSubmit(aItems),
					resubmitOf: this._resubmitOf || undefined
				})
			})
				.then(function (oResult) {
					oView.setBusy(false);
					if (!oResult || !oResult.success) {
						Msg.fail(oResult, {
							title: "Không gửi được đề nghị",
							fallback: "Không tạo được đề nghị mua sắm. Dữ liệu bạn nhập vẫn còn trên màn hình, vui lòng thử gửi lại."
						});
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
						+ "Đang chờ Phòng Mua sắm xem xét — PR trên SAP sẽ được tạo sau khi duyệt.";
					if (aWarnings.length) {
						sMsg += "\n\nLưu ý: " + aWarnings.join(" ");
					}
					this._resubmitOf = null;
					MessageBox.success(sMsg, {
						title: "Đã gửi — " + sPrNumber,
						onClose: function () {
							oModel.setProperty("/items", [this._newItem()]);
							oModel.setProperty("/header/purchaseReason", "");
							this._clearPurchaseReasonState();
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
						throw new Error("Máy chủ phản hồi quá lâu.");
					}
					if (oError instanceof TypeError) {
						throw new Error("Không thể kết nối tới máy chủ. Vui lòng thử lại.");
					}
					throw oError;
				});
		}
	});
});