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

	function emptyItem(defaults) {
		defaults = defaults || {};
		return {
			materialNo: "",
			materialType: "",
			description: "",
			uom: "",
			quantity: null,
			estimatedValue: null,
			costCenter: defaults.costCenter || "",
			internalOrder: defaults.internalOrder || "",
			assetNo: ""
		};
	}

	function lineTotal(item) {
		return (Number(item.quantity) || 0) * (Number(item.estimatedValue) || 0);
	}

	function sumItems(aItems) {
		return (aItems || []).reduce(function (sum, it) {
			return sum + lineTotal(it);
		}, 0);
	}

	return Controller.extend("com.qdavy.procurement.controller.PR01", {

		onInit: function () {
			this.getView().setModel(new JSONModel({
				materials: [],
				materialsLoading: true,
				glAccounts: [],
				costCenters: [],
				internalOrders: [],
				header: { currency: "VND" },
				items: [emptyItem()],
				totalText: "0",
				escalationText: "",
				ioThresholds: {}
			}));

			this._ioToCC = {};   // IO → CC
			this._ccToIOs = {};  // CC → [IO, IO, ...]
			this._allIOs = [];
			this._defaultCC = "";
			this._defaultIO = "";
			this._defaultCC = "";

			this._loadMaterials();
			this._loadCCAndIO();
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
				oModel.setProperty("/items", [emptyCatalogItem(this._getDefaults())]);
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
					assetNo: it.AssetNo || ""
				};
			});
			if (aOldItems.length === 0) {
				aOldItems = [emptyCatalogItem(this._getDefaults())];
			}

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

		_getDefaults: function () {
			return {
				internalOrder: this._defaultIO || "",
				costCenter: this._defaultCC || ""
			};
		},

		_refreshAllRows: function () {
			var oModel = this.getView().getModel();
			var aItems = oModel.getProperty("/items") || [];
			var bChanged = false;
			var sIO = this._defaultIO;
			var sCC = this._defaultCC;

			aItems.forEach(function (item) {
				if (item.materialType === "ZAST") {
					item.filteredInternalOrders = [];
					item.costCenter = "";
					item.internalOrder = "";
					return;
				}
				if (!item.costCenter && sCC) {
					item.costCenter = sCC;
					bChanged = true;
				}
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

		// Cost Center va Internal Order gio la 2 lua chon LOAI TRU NHAU theo acctAssignCat
		// (K hoac F) - khong con tu dien cheo sang nhau nhu truoc, vi tren SAP that chi 1
		// trong 2 duoc dung lam account assignment that su.
		onInternalOrderSelect: function () {
			this._recalcTotal();
		},

		onCostCenterSelect: function () {
			this._recalcTotal();
		},

		// User doi giua "Cost Center" / "Internal Order" cho 1 dong - xoa gia tri cua truong
		// vua bi an di de khong gui nham len SAP mot gia tri khong con hien thi tren UI.
		onAcctAssignCatChange: function (oEvent) {
			var oCtx = oEvent.getSource().getBindingContext();
			if (!oCtx) { return; }

			var sPath = oCtx.getPath();
			var oModel = this.getView().getModel();
			var sCat = oModel.getProperty(sPath + "/acctAssignCat");

			if (sCat === "K") {
				oModel.setProperty(sPath + "/internalOrder", "");
			} else if (sCat === "F") {
				oModel.setProperty(sPath + "/costCenter", "");
			}
			this._recalcTotal();
		},

		onItemValueChange: function () {
			this._recalcTotal();
		},

		_recalcTotal: function () {
			var oModel = this.getView().getModel();
			var aItems = oModel.getProperty("/items") || [];
			var def = that._defaults();
			aItems.forEach(function (it) {
				// Chi tinh nguong khi dong nay THAT SU dung Internal Order lam account
				// assignment (Cat 'F') - Cost Center (K) va Asset (A) khong lien quan IO.
				if (it.acctAssignCat !== "F") { return; }
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
			} else if (aItems.some(function (it) { return it.acctAssignCat === "F" && !!String(it.internalOrder || "").trim(); })) {
				sWarn = "Đề nghị gắn Internal Order. Leo CEO chỉ khi vượt ngưỡng ngân sách IO trên SAP.";
			}

			oModel.setProperty("/escalationText", sWarn);
		},

		_loadMaterials: function () {
			var oModel = this.getView().getModel();
			oModel.setProperty("/materialsLoading", true);
			this._fetch(BACKEND + "/api/materials")
				.then(function (res) {
					oModel.setProperty("/materialsLoading", false);
					if (!res || !res.success) {
						MessageBox.error((res && res.message) || "Không tải được vật tư từ SAP.");
						return;
					}
					oModel.setProperty("/materials", res.data || []);
				})
				.catch(function (e) {
					oModel.setProperty("/materialsLoading", false);
					MessageBox.error(e.message || "Không tải được vật tư.");
				});
		},

		onMaterialChange: function (oEvent) {
			var oSrc = oEvent.getSource();
			var sKey = oSrc.getSelectedKey();
			var oCtx = oSrc.getBindingContext();
			if (!oCtx) { return; }
			var sPath = oCtx.getPath();
			var oModel = this.getView().getModel();

			if (!sKey) {
				oModel.setProperty(sPath + "/materialNo", "");
				oModel.setProperty(sPath + "/materialType", "");
				oModel.setProperty(sPath + "/description", "");
				oModel.setProperty(sPath + "/uom", "");
				this._recalc();
				return;
			}

			var oMat = (oModel.getProperty("/materials") || []).filter(function (m) {
				return m.MaterialNo === sKey;
			})[0];

			if (oMaterial) {
				oModel.setProperty(sPath + "/materialNo", oMaterial.MaterialNo);
				oModel.setProperty(sPath + "/materialType", oMaterial.MaterialType || "");
				oModel.setProperty(sPath + "/description", oMaterial.Description || "");
				oModel.setProperty(sPath + "/uom", oMaterial.BaseUoM || "PC");

				if (oMaterial.MaterialType === "ZAST") {
					// Vật tư Tài sản → account assignment luôn là Asset (Cat A), khóa Cost Center/Internal Order.
					oModel.setProperty(sPath + "/acctAssignCat", "A");
					oModel.setProperty(sPath + "/costCenter", "");
					oModel.setProperty(sPath + "/internalOrder", "");
				} else {
					var sCurrentCat = oModel.getProperty(sPath + "/acctAssignCat");
					if (sCurrentCat === "A" || !sCurrentCat) {
						oModel.setProperty(sPath + "/acctAssignCat", "K");
					}
					oModel.setProperty(sPath + "/assetNo", "");
				}
			}
			this._recalcTotal();
		},

		onResetPress: function () {
			MessageBox.confirm("Xóa hết dòng và tạo lại 1 dòng trống?", {
				actions: [MessageBox.Action.YES, MessageBox.Action.NO],
				onClose: function (act) {
					if (act === MessageBox.Action.YES) {
						this.getView().getModel().setProperty("/items", [emptyItem(this._defaults())]);
						this._recalc();
					}
				}.bind(this)
			});
		},

		onSubmitPress: function () {
			var oView = this.getView();
			var oModel = oView.getModel();
			var aItems = oModel.getProperty("/items") || [];
			var oUser = this.getOwnerComponent().getModel("user").getData();

			if (!aItems.length) {
				MessageBox.warning("Thêm ít nhất 1 vật tư.");
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
				// Account assignment: chỉ 1 trong 3 áp dụng theo dòng, không còn bắt điền cả CC+IO+GL cùng lúc.
				// GL Account không còn là input của user — server tự tính theo category (xem defaultGLAccount()).
				if (item.materialType === "ZAST") {
					if (!String(item.assetNo || "").trim()) {
						MessageBox.warning("Dòng " + idx + ": Vật tư loại Tài sản (ZAST) bắt buộc nhập Asset No.");
						return;
					}
				} else if (item.acctAssignCat === "F") {
					if (!String(item.internalOrder || "").trim()) {
						MessageBox.warning("Dòng " + idx + ": Vui lòng chọn Internal Order.");
						return;
					}
				} else {
					if (!item.costCenter) {
						MessageBox.warning("Dòng " + idx + ": Vui lòng chọn Cost Center.");
						return;
					}
				}
			}

			var total = sumItems(aItems);
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
				.then(function (res) {
					oView.setBusy(false);
					if (!res || !res.success) {
						MessageBox.error((res && res.message) || "Gửi đề nghị thất bại.");
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
							oModel.setProperty("/items", [emptyItem(this._defaults())]);
							this._recalc();
							this.getOwnerComponent().getRouter().navTo("dashboard");
						}.bind(this)
					});
				}.bind(this))
				.catch(function (e) {
					oView.setBusy(false);
					MessageBox.error(e.message);
				});
		},

		onNavBack: function () {
			this.getOwnerComponent().getRouter().navTo("dashboard");
		},

		_fetch: function (url, options) {
			var ctrl = (typeof AbortController !== "undefined") ? new AbortController() : null;
			var timer = ctrl ? setTimeout(function () { ctrl.abort(); }, REQUEST_TIMEOUT_MS) : null;
			return fetch(url, Object.assign({}, options || {}, { signal: ctrl ? ctrl.signal : undefined }))
				.then(function (r) {
					if (timer) { clearTimeout(timer); }
					return r.json().catch(function () { return {}; }).then(function (body) {
						if (r.status === 401 || r.status === 403) {
							throw new Error("Không có quyền. Đăng nhập lại.");
						}
						if (r.status >= 500) {
							throw new Error((body && body.message) || "Lỗi máy chủ.");
						}
						return body;
					});
				})
				.catch(function (e) {
					if (timer) { clearTimeout(timer); }
					if (e && e.name === "AbortError") { throw new Error("Server quá lâu."); }
					if (e instanceof TypeError) { throw new Error("Không kết nối được server."); }
					throw e;
				});
		}
	});
});