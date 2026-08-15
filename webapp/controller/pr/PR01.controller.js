sap.ui.define([
	"sap/ui/core/mvc/Controller",
	"sap/ui/model/json/JSONModel",
	"sap/m/MessageBox",
	"sap/m/MessageToast",
	"com/qdavy/procurement/model/Config"
], function (Controller, JSONModel, MessageBox, MessageToast, Config) {
	"use strict";

	var BACKEND = Config.BACKEND;
	// 20s chứ không phải 15s: SAP Gateway lần gọi đầu trong ngày (cold start) hay
	// chạm 16-18s, timeout 15s làm PR-01 báo lỗi mạng oan.
	var REQUEST_TIMEOUT_MS = 20000;

	// Chỉ cảnh báo “giá trị lớn” — KHÔNG dùng để bắt buộc leo CEO (CEO theo ngưỡng IO từ SAP)
	var LEGAL_WARN_THRESHOLD = 100000000;

	function emptyCatalogItem(defaults) {
		defaults = defaults || {};
		return {
			isFreeText: false,
			materialNo: "",
			materialType: "",
			// Nguoi dung chi chon Cost Center. Category suy ra trong syncAcctAssignCat():
			// ZAST -> 'A', con lai -> 'K'. Khong con o chon K/F/A tren man hinh.
			acctAssignCat: "K",
			description: "",
			uom: "",
			quantity: null,
			estimatedValue: null,
			costCenter: defaults.costCenter || "",
			// Internal Order suy tu Cost Center (1 phong = 1 IO ngan sach), nguoi dung
			// khong nhap. Chi dung de tra nguong leo CEO, KHONG gui len SAP.
			internalOrder: "",
			internalOrderText: "",
			filteredInternalOrders: [],
			assetNo: ""
		};
	}

	// Chi con 2 loai account assignment: 'A' (vat tu Tai san) va 'K' (Cost Center).
	// Cau hinh cua nhom: moi phong ban = 1 Cost Center, moi Cost Center gan dung 1
	// Internal Order ngan sach -> IO khong phai mot "loai" rieng ma la ngan sach cua
	// chinh phong do, nen khong con Cat 'F'. IO chi dung de TRA NGUONG leo CEO.
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

		// PR bị Purchasing trả lại → PRDetail đẩy dữ liệu qua model "resubmit" cấp
		// Component. Điền sẵn toàn bộ dòng vật tư cũ để người tạo chỉ sửa chỗ cần sửa.
		// Model bị xóa ngay sau khi dùng (one-shot) để lần vào PR-01 sau không dính lại.
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
			// Bom danh sach IO cho tung dong cu, khong thi o Internal Order hien trong
			// du ban nuong da chon IO trong lan gui truoc.
			aOldItems.forEach(function (item) { this._refreshIOListOfItem(item); }, this);

			oModel.setProperty("/header/currency", oData.currency || "VND");
			oModel.setProperty("/items", aOldItems);
			this._recalcTotal();

			MessageBox.information(
				"Bạn đang sửa lại đề nghị " + oData.prId + " bị Purchasing trả lại."
				+ (oData.returnReason ? ("\n\nLý do trả lại: " + oData.returnReason) : "")
				+ "\n\nDữ liệu cũ đã được điền sẵn — sửa xong bấm Gửi, hệ thống sẽ tạo đề nghị mới và tự đóng bản cũ.",
				{ title: "Sửa & gửi lại đề nghị" }
			);
		},

		// Dong vat tu moi: dien san Cost Center mac dinh va IO ngan sach tuong ung.
		_newItem: function () {
			var oItem = emptyCatalogItem(this._getDefaults());
			this._refreshIOListOfItem(oItem);
			return oItem;
		},

		// Chi Cost Center — Internal Order suy ra tu no, khong phai mot lua chon rieng.
		_getDefaults: function () {
			return { costCenter: this._defaultCC || "" };
		},

		// Danh sach Internal Order thuoc ve DUNG mot Cost Center. Nguon la
		// costCenterToIOs do /api/internal-orders tra ve (server suy tu InternalOrderSet
		// + lich su PR). CC chua co IO nao -> tra mang rong, o IO se trong.
		_ioListFor: function (sCostCenter) {
			var sCC = String(sCostCenter || "").trim();
			if (!sCC) { return []; }

			var aCodes = (this._costCenterToIOs && this._costCenterToIOs[sCC]) || [];
			var aAllIO = this.getView().getModel().getProperty("/internalOrders") || [];

			return aAllIO.filter(function (io) {
				return aCodes.indexOf(io.InternalOrder) !== -1;
			});
		},

		// Cap nhat IO ngan sach cua 1 dong theo Cost Center dang chon, va chuoi hien thi
		// cho o chi doc. IO nay KHONG gui len SAP, chi de tra nguong leo CEO.
		_refreshIOListOfItem: function (item) {
			var aIO = this._ioListFor(item.costCenter);
			item.filteredInternalOrders = aIO;

			var sIO = String(item.internalOrder || "").trim();
			var oPicked = aIO.filter(function (io) { return io.InternalOrder === sIO; })[0];

			if (!oPicked) {
				// Du lieu that: moi phong ban gan DUNG 1 Internal Order ngan sach
				// ("IT Procurement Budget 2026 for CCxxx") nen suy thang ra duoc.
				// Phong nao co nhieu IO thi khong doan — de trong, nguong khong tinh.
				oPicked = aIO.length === 1 ? aIO[0] : null;
				item.internalOrder = oPicked ? oPicked.InternalOrder : "";
			}

			// Chuoi hien thi cho o chi doc — dung san o day de view khoi phai tra list.
			item.internalOrderText = oPicked
				? (oPicked.InternalOrder + (oPicked.Description ? " — " + oPicked.Description : ""))
				: (item.materialType === "ZAST" ? "" : "Phòng này chưa gán ngân sách");
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
				var iBefore = (item.filteredInternalOrders || []).length;
				that._refreshIOListOfItem(item);
				if ((item.filteredInternalOrders || []).length !== iBefore) { bChanged = true; }
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
				.catch(function () { /* im lang */ });
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

		// GL Account KHONG con la input cua user - tu server tinh theo Account Assignment
		// Category + Material Type (xem defaultGLAccount() trong server.js), nen bo fetch
		// /api/gl-accounts o day.
		_loadAccountingLists: function () {
			var oModel = this.getView().getModel();
			var that = this;

			this._fetchWithTimeout(BACKEND + "/api/cost-centers")
				.then(function (oResult) {
					if (oResult.success) {
						var aCC = oResult.data || [];
						oModel.setProperty("/costCenters", aCC);

						// UU TIEN Cost Center gan cho CHINH nhan vien dang dang nhap
						// (EmployeeSet.CostCenter, suy ra tu IT0001 tren SAP HCM). Day chinh
						// la ly do gan CC cho nhan vien: chi phi mua sam mac dinh do ve bo
						// phan cua ho, requester khong can biet ma SAP. Truoc day code lay
						// dai phan tu dau danh sach — CC cua nhan vien co gan cung khong
						// bao gio duoc dung (feedback 14/08).
						var sUserCC = String(
							that.getOwnerComponent().getModel("user").getProperty("/costCenter") || ""
						).trim();

						if (sUserCC) {
							// /api/cost-centers KHONG doc thang CSKS ma suy ra tu
							// InternalOrderSet + lich su PR (xem fetchInternalOrderMaster
							// trong server.js). Nen CC cua nhan vien co the CHUA tung xuat
							// hien o dau -> khong co trong list -> ComboBox setSelectedKey
							// se ra rong. Tu chen vao dau danh sach cho chac.
							var bInList = aCC.some(function (cc) {
								return String(cc.CostCenter) === sUserCC;
							});
							if (!bInList) {
								aCC = [{
									CostCenter: sUserCC,
									Description: sUserCC + " — bộ phận của bạn"
								}].concat(aCC);
								oModel.setProperty("/costCenters", aCC);
							}
							that._userCC = sUserCC;
							that._defaultCC = sUserCC;
						} else if (aCC.length > 0 && !that._defaultCC) {
							that._defaultCC = aCC[0].CostCenter || "";
						}
						that._applyDefaultsToEmptyItems();
					}
				})
				.catch(function () { /* im lang */ });

			this._fetchWithTimeout(BACKEND + "/api/internal-orders")
				.then(function (oResult) {
					if (oResult.success) {
						var aIO = oResult.data || [];
						oModel.setProperty("/internalOrders", aIO);
						that._ioToCostCenter = oResult.ioToCostCenter || {};
						// Map nguoc CC -> [IO]: day la cai lam cho o Internal Order chi
						// hien nhung IO thuoc dung bo phan vua chon.
						that._costCenterToIOs = oResult.costCenterToIOs || {};

						// Budget từ SAP (nếu API trả kèm trên từng IO)
						var oTh = oModel.getProperty("/ioThresholds") || {};
						aIO.forEach(function (io) {
							if (io.Budget != null && Number(io.Budget) > 0) {
								oTh[io.InternalOrder] = Number(io.Budget);
							}
						});
						oModel.setProperty("/ioThresholds", oTh);

						if (aIO.length > 0) {
							that._defaultIO = aIO[0].InternalOrder || "";
							// Chi de IO keo CC theo khi nhan vien KHONG co CC rieng —
							// CC gan cho nhan vien luon thang.
							if (that._defaultIO && that._ioToCostCenter[that._defaultIO] && !that._userCC) {
								that._defaultCC = that._ioToCostCenter[that._defaultIO];
							}
						}
						that._applyDefaultsToEmptyItems();
						that._recalcTotal();
					}
				})
				.catch(function () { /* im lang */ });
		},

		// Doi Cost Center thi o Internal Order (chi doc) phai cap nhat theo phong moi.
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

			// Suy lai Category truoc khi tinh bat cu thu gi: nguong IO ben duoi va
			// payload gui len SAP deu doc acctAssignCat.
			syncAcctAssignCat(aItems);

			var fTotal = sumItems(aItems);
			var oTh = oModel.getProperty("/ioThresholds") || {};

			oModel.setProperty("/totalText", fTotal.toLocaleString("vi-VN"));

			// So với ngưỡng IO (từ SAP /api/thresholds) — không còn 300tr cố định
			var sWarn = "";
			var bOverIO = false;
			var sHitIO = "";
			var nHitTh = null;

			aItems.forEach(function (it) {
				// Nguong tinh theo IO NGAN SACH cua phong ban gan voi dong nay. Vat tu
				// Tai san (Cat 'A') khong tinh vao ngan sach phong nen bo qua.
				if (it.materialType === "ZAST") { return; }
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
					+ " (" + Number(nHitTh).toLocaleString("vi-VN") + " VND) — sau CFO sẽ leo thang lên CEO. "
					+ "Số PR SAP chỉ có sau khi duyệt cuối.";
			} else if (fTotal > LEGAL_WARN_THRESHOLD) {
				sWarn = "Giá trị lớn (> 100 triệu VND) — CFO sẽ xem xét kỹ. "
					+ "Số PR SAP chỉ có sau khi phê duyệt.";
			} else if (aItems.some(function (it) { return !!String(it.internalOrder || "").trim(); })) {
				sWarn = "Đề nghị tính vào ngân sách của phòng. Leo CEO chỉ khi vượt ngưỡng ngân sách đã cấu hình.";
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

					var aItems = oModel.getProperty("/items") || [];
					var bChanged = false;
					aItems.forEach(function (item) {
						if (!item.description && item.materialNo) {
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

			if (oMaterial) {
				oModel.setProperty(sPath + "/materialNo", oMaterial.MaterialNo);
				oModel.setProperty(sPath + "/materialType", oMaterial.MaterialType || "");
				oModel.setProperty(sPath + "/description", oMaterial.Description || "");
				oModel.setProperty(sPath + "/uom", oMaterial.BaseUoM || "PC");

				if (oMaterial.MaterialType === "ZAST") {
					// Vật tư Tài sản → account assignment luôn là Asset (Cat A), xóa Cost Center/Internal Order.
					oModel.setProperty(sPath + "/costCenter", "");
					oModel.setProperty(sPath + "/internalOrder", "");
					oModel.setProperty(sPath + "/internalOrderText", "");
					oModel.setProperty(sPath + "/filteredInternalOrders", []);
				} else {
					oModel.setProperty(sPath + "/assetNo", "");
					// Doi tu ZAST ve vat tu thuong: tra lai Cost Center mac dinh cua nguoi
					// dung, khong de trong roi de server chan o buoc validate.
					if (!oModel.getProperty(sPath + "/costCenter") && this._defaultCC) {
						oModel.setProperty(sPath + "/costCenter", this._defaultCC);
					}
					var oItem = oModel.getProperty(sPath);
					this._refreshIOListOfItem(oItem);
					oModel.setProperty(sPath, oItem);
				}
			}
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
						this.getView().getModel().setProperty("/items", [
							this._newItem()
						]);
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

			// Chot lai Category ngay truoc khi gui, khong tin vao lan _recalcTotal cuoi:
			// day la field server dung de quyet dinh ghi chi phi vao CC hay vao IO.
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
					MessageBox.warning("Dòng " + idx + ": Vui lòng nhập giá trị ước tính hợp lệ.");
					return;
				}
				// Account assignment: ZAST bắt buộc Asset No (Cat 'A'), còn lại bắt buộc
				// Bộ phận (Cat 'K'). Internal Order không phải input của người dùng nên
				// không validate. GL Account server tự tính (xem defaultGLAccount()).
				if (item.materialType === "ZAST") {
					if (!String(item.assetNo || "").trim()) {
						MessageBox.warning("Dòng " + idx + ": Vật tư loại Tài sản (ZAST) bắt buộc nhập Asset No.");
						return;
					}
				} else if (!item.costCenter) {
					MessageBox.warning("Dòng " + idx + ": Vui lòng chọn Bộ phận (Cost Center).");
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
					items: aItems,
					resubmitOf: this._resubmitOf || undefined
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

					if (oApproval.needsProcurementHeadReview) {
						aWarnings.push(
							"Vượt ngưỡng Internal Order"
							+ (oApproval.escalationIO ? (" " + oApproval.escalationIO) : "")
							+ (oApproval.ioThreshold != null
								? (" (" + Number(oApproval.ioThreshold).toLocaleString("vi-VN") + " VND)")
								: "")
							+ " — sau CFO sẽ leo thang CEO."
						);
					} else if (oApproval.needsLegalReview) {
						aWarnings.push("Giá trị lớn — CFO sẽ xem xét kỹ.");
					}

					var sMsg = "✓ Đã gửi đề nghị " + sPrNumber
						+ (bIsResubmit ? " (bản gửi lại — đề nghị cũ đã tự đóng)" : "") + "\n\n"
						+ "Gồm " + iItemCount + " dòng vật tư, tổng "
						+ nTotalPRValue.toLocaleString("vi-VN") + " " + sCurrency + ".\n"
						+ "Đang chờ Purchasing xem xét.\n"
						+ "Số PR trên SAP sẽ được cấp sau khi phê duyệt xong.\n"
						+ "Bạn sẽ nhận thông báo khi được duyệt hoặc bị từ chối.";
					if (aWarnings.length) {
						sMsg += "\n\nLưu ý: " + aWarnings.join(" ");
					}

					this._resubmitOf = null;

					MessageBox.success(sMsg, {
						title: "Đã gửi đề nghị — " + sPrNumber,
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
								// Ưu tiên message thật server trả về (thường là lỗi SAP đã được
								// extractSapErrorMessage bóc ra) — nuốt hết thành câu chung chung
								// thì không ai biết PR hỏng vì GL sai hay vì thiếu Cost Center.
								throw new Error(
									(oBody && oBody.message) || "Máy chủ đang gặp sự cố, vui lòng thử lại sau."
								);
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