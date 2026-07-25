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

	// Nguong leo thang phe duyet — phai khop voi buildApprovalFlags() trong server.js.
	// 300 trieu la con so chinh thuc trong Business Blueprint (muc "Executive Approval
	// Required"). Con so 100 trieu la nguong noi bo nhom da thong nhat truoc do — neu
	// doi, sua o day va o server.js cho khop.
	var CEO_THRESHOLD = 300000000;   // > 300 trieu -> can CEO duyet them
	var CFO_THRESHOLD = 100000000;   // > 100 trieu -> can CFO xem ky

	function emptyCatalogItem() {
		return {
			isFreeText: false,
			materialNo: "", materialType: "", description: "", uom: "",
			quantity: null, estimatedValue: null,
			costCenter: "", internalOrder: "", assetNo: ""
		};
	}

	function emptyFreeTextItem() {
		return {
			isFreeText: true,
			materialNo: "FREE_TEXT", materialType: "ZROH", description: "", uom: "PC",
			quantity: 1, estimatedValue: null,
			costCenter: "", internalOrder: "", assetNo: ""
		};
	}

	return Controller.extend("com.qdavy.procurement.controller.PR01", {

		onInit: function () {
			var oModel = new JSONModel({
				materials: [],
				materialsLoading: true,
				header: { currency: "VND" },
				items: [],         // Danh sach nhieu vat tu
				totalText: "0",    // Tong gia tri da format, hien o thanh qdTotalBar
				escalationText: "" // Canh bao leo thang, rong = an MessageStrip
			});
			this.getView().setModel(oModel);
			this._loadMaterials();
		},

		// Tinh lai tong tien + canh bao moi khi so luong/don gia thay doi
		onItemValueChange: function () {
			this._recalcTotal();
		},

		_recalcTotal: function () {
			var oModel = this.getView().getModel();
			var aItems = oModel.getProperty("/items") || [];

			var fTotal = aItems.reduce(function (sum, item) {
				return sum + (Number(item.estimatedValue) || 0);
			}, 0);

			oModel.setProperty("/totalText", fTotal.toLocaleString("vi-VN"));

			// Bao truoc cho nguoi de nghi biet PR se phai qua nhung cap nao
			var sWarn = "";
			if (fTotal > CEO_THRESHOLD) {
				sWarn = "Giá trị vượt 300 triệu VND — đề nghị này sẽ cần CFO duyệt và leo thang lên CEO phê duyệt.";
			} else if (fTotal > CFO_THRESHOLD) {
				sWarn = "Giá trị vượt 100 triệu VND — đề nghị này sẽ được CFO xem xét kỹ trước khi duyệt.";
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
				})
				.catch(function (oError) {
					oModel.setProperty("/materialsLoading", false);
					MessageBox.error(oError.message);
				});
		},

		// Thêm dòng vật tư từ Danh mục
		onAddItem: function () {
			var oModel = this.getView().getModel();
			// Copy mang truoc khi push - JSONModel dua vao so sanh reference/deepEqual
			// trong checkUpdate(), mutate thang mang goc se khien binding khong thay doi va khong re-render UI
			var aItems = oModel.getProperty("/items").slice();
			aItems.push(emptyCatalogItem());
			oModel.setProperty("/items", aItems);
		},

		// Thêm dòng vật tư TỰ DO (Không có trong danh mục)
		onAddFreeTextItem: function () {
			var oModel = this.getView().getModel();
			// Copy mang truoc khi push - xem giai thich trong onAddItem
			var aItems = oModel.getProperty("/items").slice();
			aItems.push(emptyFreeTextItem());
			oModel.setProperty("/items", aItems);
		},

		// Xóa 1 dòng vật tư khỏi danh sách — nut Delete nam ngay trong card (CustomListItem),
		// khong con dung Table mode="Delete" nua nen lay bindingContext truc tiep tu nguon
		// phat sinh event (nut bam), khong phai qua oEvent.getParameter("listItem").
		onDeleteItem: function (oEvent) {
			var sPath = oEvent.getSource().getBindingContext().getPath();
			var iIndex = parseInt(sPath.split("/").pop(), 10);

			var oModel = this.getView().getModel();
			// Copy mang truoc khi splice - xem giai thich trong onAddItem
			var aItems = oModel.getProperty("/items").slice();
			aItems.splice(iIndex, 1);
			oModel.setProperty("/items", aItems);
			this._recalcTotal();
		},

		// Tự động map dữ liệu khi chọn vật tư từ dropdown
		onMaterialChange: function (oEvent) {
			var oSelect = oEvent.getSource();
			var sKey = oSelect.getSelectedKey();
			var sPath = oSelect.getBindingContext().getPath();
			var oModel = this.getView().getModel();

			var aMaterials = oModel.getProperty("/materials");
			var oMaterial = aMaterials.filter(function (m) { return m.MaterialNo === sKey; })[0];

			if (oMaterial) {
				oModel.setProperty(sPath + "/materialNo", oMaterial.MaterialNo);
				oModel.setProperty(sPath + "/materialType", oMaterial.MaterialType);
				oModel.setProperty(sPath + "/description", oMaterial.Description);
				oModel.setProperty(sPath + "/uom", oMaterial.BaseUoM);

				// QUAN TRONG: xoa du lieu hach toan cu khi doi vat tu, tranh truong hop
				// doi tu ZAST (tai san, dung Asset No) sang vat tu thuong (dung Cost
				// Center/Internal Order) hoac nguoc lai ma van con dinh gia tri cu, dan
				// den hach toan sai ma khong ai de y (Input bi visible="false" nen nguoi
				// dung khong con nhin thay de tu xoa).
				if (oMaterial.MaterialType === "ZAST") {
					oModel.setProperty(sPath + "/costCenter", "");
					oModel.setProperty(sPath + "/internalOrder", "");
				} else {
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

			// Validate từng dòng vật tư
			for (var i = 0; i < aItems.length; i++) {
				var item = aItems[i];
				var idx = i + 1;

				if (!item.quantity || Number(item.quantity) <= 0) {
					MessageBox.warning("Dòng " + idx + ": Vui lòng nhập số lượng hợp lệ.");
					return;
				}
				if (!item.estimatedValue || Number(item.estimatedValue) <= 0) {
					MessageBox.warning("Dòng " + idx + ": Vui lòng nhập giá trị ước tính hợp lệ.");
					return;
				}
				if (item.materialType === "ZAST" && !item.assetNo) {
					MessageBox.warning("Dòng " + idx + ": Vật tư tài sản (ZAST) bắt buộc phải có Asset No.");
					return;
				}
				if (item.materialType !== "ZAST" && !item.costCenter && !item.internalOrder) {
					MessageBox.warning("Dòng " + idx + ": Vui lòng nhập Cost Center hoặc Internal Order.");
					return;
				}
			}

			// Tính tổng tiền PR để gửi sang BE làm căn cứ duyệt leo thang
			var nTotalPRValue = aItems.reduce(function (sum, item) {
				return sum + Number(item.estimatedValue);
			}, 0);

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
					// TODO xac nhan lai voi BE: ten field co dung "needsLegalReview"/
					// "needsProcurementHeadReview" khong, hay day la nham lan voi
					// CFO/CEO — Blueprint chi mo ta luong Requester -> Truong BP mua
					// sam -> CFO -> CEO, khong co vai tro "Phap che/Legal" nao ca.
					if (oApproval.needsLegalReview) {
						aWarnings.push("• Cần Phòng Phụ trách xem trước (giá trị > 100 triệu VND)");
					}
					if (oApproval.needsProcurementHeadReview) {
						aWarnings.push("• Cần Trưởng Bộ phận Mua sắm xem trước (giá trị > 300 triệu VND)");
					}

					// Thong bao dang SAP GUI: dan dau bang so PR that, nhu man ME51N bao
					// "Purchase requisition number 10000042 created".
					var sMsg = "✓ Đã tạo Purchase Requisition số " + sPrNumber + "\n\n"
						+ "Gồm " + iItemCount + " dòng vật tư, đang chờ phê duyệt.\n"
						+ "Có thể tra cứu bằng ME53N với mã PR: " + sPrNumber + ".";
					if (aWarnings.length) {
						sMsg += "\n\nLưu ý leo thang phê duyệt:\n" + aWarnings.join("\n");
					}

					MessageBox.success(sMsg, {
						title: "Tạo PR thành công — " + sPrNumber,
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

		// ── Fetch co timeout + phan biet loi theo status code (giong Login) ──────

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
						.catch(function () { return {}; }) // response khong phai JSON hop le
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