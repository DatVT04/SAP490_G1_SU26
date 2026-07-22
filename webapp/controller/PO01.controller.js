sap.ui.define([
	"sap/ui/core/mvc/Controller",
	"sap/ui/model/json/JSONModel",
	"sap/m/MessageBox",
	"sap/m/MessageToast",
	"com/qdavy/procurement/model/Config"
], function (Controller, JSONModel, MessageBox, MessageToast, Config) {
	"use strict";

	var BACKEND = Config.BACKEND;

	// Item rỗng cho form PO manual
	function emptyItem() {
		return {
			materialNo: "", materialType: "", description: "", uom: "",
			quantity: null, netPrice: null, costCenter: "", assetNo: "", preqNo: ""
		};
	}

	return Controller.extend("com.qdavy.procurement.controller.PO01", {
		onInit: function () {
			// "mockData" model: feeds Splitter table (team UI) — populated from real backend
			this.getView().setModel(new JSONModel({
				pendingPRs: [],        // Approved PRs loaded from /api/approval/approved
				aiSuggestedVendors: [] // AI vendor suggestions per selected PR
			}), "mockData");

			// Default model: vendor/material lookups + Vá-3 dropdown binding
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

			// UI5 giu nguyen view khi dieu huong qua lai giua cac tab (khong huy/tao lai),
			// nen onInit chi chay 1 lan duy nhat. Phai gan patternMatched de moi lan quay
			// lai man nay deu tu dong tai lai danh sach PR da duyet moi nhat — tranh tinh
			// trang phai logout/login lai moi thay PR vua duoc duyet o man PR-02.
			this.getOwnerComponent().getRouter()
				.getRoute("po01")
				.attachPatternMatched(this._onRouteMatched, this);
		},

		_onRouteMatched: function () {
			// Dong khu vuc tao PO va xoa lua chon cu — tranh hien thi PR da bi xoa
			// khoi danh sach (VD da tao PO roi) nhung form van con giu du lieu cu.
			this.getView().byId("poCreationArea").setVisible(false);
			this.getView().getModel("mockData").setProperty("/aiSuggestedVendors", []);
			this._loadApprovedPRs();
		},

		// ── Data loading ──────────────────────────────────────────────────────

		// Load PR đã duyệt từ backend → populate bảng Splitter + dropdown Vá-3
		_loadApprovedPRs: function () {
			var oView = this.getView();
			fetch(BACKEND + "/api/approval/approved")
				.then(function (r) { return r.json(); })
				.then(function (res) {
					if (res && res.success) {
						var aData = res.data || [];
						// Default model (for dropdown / Vá-3)
						oView.getModel().setProperty("/approvedPRs", aData);

						// Map sang shape Splitter table (mockData binding).
						// PR moi co items[], lay summary tu item dau de hien thi tren bang.
						var aMapped = aData.map(function (pr) {
							var aItems   = pr.items || [];
							var firstItem = aItems[0] || {};
							var sDesc = aItems.length > 1
								? (firstItem.Description || "") + " (+thêm " + (aItems.length - 1) + " vật tư)"
								: (firstItem.Description || pr.Description || "");

							return {
								PrNumber:       pr.PRId,
								// Summary display — dung item dau tien neu co nhieu items
								MaterialNo:     firstItem.MaterialNo  || pr.MaterialNo  || "",
								Description:    sDesc,
								Quantity:       firstItem.Quantity    || pr.Quantity    || 0,
								UoM:            firstItem.UoM         || pr.UoM         || "EA",
								MaterialType:   firstItem.MaterialType|| pr.MaterialType|| "ZSRV",
								CostCenter:     firstItem.CostCenter  || pr.CostCenter  || "",
								AssetNo:        firstItem.AssetNo     || pr.AssetNo     || "",
								// Tong gia tri va tien te tu cap PR
								EstimatedValue: pr.TotalValue         || 0,
								Currency:       pr.Currency           || "VND",
								Status:         pr.Status,
								// Giu nguyen mang items goc de onConfirmCreatePO dung
								_items:         aItems
							};
						});
						oView.getModel("mockData").setProperty("/pendingPRs", aMapped);
					}
				})
				.catch(function () { /* silent — table stays empty */ });
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

		// ── Navigation ────────────────────────────────────────────────────────

		onNavBack: function () {
			this.getOwnerComponent().getRouter().navTo("dashboard");
		},

		// ── Splitter UI handlers (team's design) ─────────────────────────────

		// Khi click chọn 1 dòng PR ở bảng bên trái
		onPRSelect: function (oEvent) {
			var oSelectedItem = oEvent.getParameter("listItem");
			var oContext = oSelectedItem.getBindingContext("mockData");
			var oPRData = oContext.getObject();

			// Hiển thị khu vực bên phải
			this.getView().byId("poCreationArea").setVisible(true);

			// Dòng mô tả vật tư: dùng summary Description từ _loadApprovedPRs
			var sMaterialInfo = oPRData.Description || "";
			if (oPRData.MaterialNo) { sMaterialInfo += " (" + oPRData.MaterialNo + ")"; }

			// Hiển thị số lượng: neu co nhieu items thi hien "N dong vat tu"
			var aItems = oPRData._items || [];
			var sQty;
			if (aItems.length > 1) {
				sQty = aItems.length + " dòng vật tư";
			} else {
				sQty = (oPRData.Quantity || "") + " " + (oPRData.UoM || "PC");
			}

			// Điền thông tin PR vào Form chi tiết
			this.getView().byId("txtSelectedPR").setText(oPRData.PrNumber);
			this.getView().byId("txtMaterialInfo").setText(sMaterialInfo);
			this.getView().byId("txtQuantity").setText(sQty);
			this.getView().byId("numEstimatedValue").setNumber(oPRData.EstimatedValue);
			this.getView().byId("numEstimatedValue").setUnit(oPRData.Currency);

			// Reset form PO
			this.getView().byId("inSelectedVendor").setValue("");
			this.getView().byId("inFinalPrice").setValue(oPRData.EstimatedValue);

			// Gọi AI gợi ý NCC (dùng MaterialNo item đầu để phân loại)
			this._getAIVendorRecommendations(oPRData.MaterialNo, oPRData.EstimatedValue);
		},

		// AI vendor suggestions — dùng vendor số thật từ SAP (LIFNR 0050000007/8/9)
		_getAIVendorRecommendations: function (sMaterialNo, fEstimatedValue) {
			var oView = this.getView();
			oView.setBusy(true);

			var sM = sMaterialNo || "";
			var aMockAIVendors;

			if (sM.indexOf("LAPTOP") >= 0 || sM.indexOf("TABLET") >= 0 || sM.indexOf("PHONE") >= 0) {
				aMockAIVendors = [
					{ VendorNo: "0050000007", VendorName: "Cong ty TNHH Dell Viet Nam",   Rating: 4.5, PriceProposal: Math.round(fEstimatedValue * 0.97), AiReason: "Khop 100% ky thuat, gia re hon 3% so voi ngan sach. Thoi gian giao hang 7 ngay." },
					{ VendorNo: "0050000009", VendorName: "Cong ty TNHH HP Viet Nam",      Rating: 3.8, PriceProposal: Math.round(fEstimatedValue * 0.90), AiReason: "Gia tot nhat. Thoi gian giao hang 10 ngay, bao hanh noi dia." }
				];
			} else if (sM.indexOf("SERVER") >= 0 || sM.indexOf("NAS") >= 0 || sM.indexOf("SWITCH") >= 0) {
				aMockAIVendors = [
					{ VendorNo: "0050000009", VendorName: "Cong ty TNHH HP Viet Nam",      Rating: 4.8, PriceProposal: Math.round(fEstimatedValue * 0.97), AiReason: "Xep hang toi uu - lich su cap hang Server on dinh, mien phi lap dat cau hinh rack." },
					{ VendorNo: "0050000007", VendorName: "Cong ty TNHH Dell Viet Nam",    Rating: 4.5, PriceProposal: Math.round(fEstimatedValue * 1.02), AiReason: "Cao hon ngan sach 2%, giao hang 7 ngay, ho tro ky thuat tot." }
				];
			} else {
				// SW-LIC, CLOUD, SUPPLY, MAINT, TRAIN, CONSULT
				aMockAIVendors = [
					{ VendorNo: "0050000008", VendorName: "Cong ty CP Microsoft Viet Nam", Rating: 4.0, PriceProposal: Math.round(fEstimatedValue * 0.95), AiReason: "Phu hop vat tu dich vu/phan mem. Giao hang nhanh 5 ngay." },
					{ VendorNo: "0050000007", VendorName: "Cong ty TNHH Dell Viet Nam",    Rating: 4.5, PriceProposal: Math.round(fEstimatedValue * 1.0),  AiReason: "NCC da dang, co the cung cap nhieu chung loai vat tu CNTT." }
				];
			}

			setTimeout(function () {
				oView.setBusy(false);
				oView.getModel("mockData").setProperty("/aiSuggestedVendors", aMockAIVendors);
				MessageToast.show("Da cap nhat phuong an nha cung cap toi uu tu AI!");
			}, 800);
		},

		// Nhấp nút gọi lại AI tư vấn
		onCallAIVendors: function () {
			var sText = this.getView().byId("txtMaterialInfo").getText();
			var sMaterialNo = sText.indexOf("(") >= 0
				? sText.substring(sText.lastIndexOf("(") + 1, sText.lastIndexOf(")"))
				: sText;
			var fValue = this.getView().byId("numEstimatedValue").getNumber();
			this._getAIVendorRecommendations(sMaterialNo, fValue);
		},

		// Chọn NCC từ bảng AI gợi ý → đổ vào form
		onVendorSelect: function (oEvent) {
			var oSelectedItem = oEvent.getParameter("listItem");
			var oContext = oSelectedItem.getBindingContext("mockData");
			var oVendorData = oContext.getObject();

			this.getView().byId("inSelectedVendor").setValue(
				oVendorData.VendorName + " (" + oVendorData.VendorNo + ")"
			);
			this.getView().byId("inFinalPrice").setValue(oVendorData.PriceProposal);
		},

		// XÁC NHẬN TẠO PO → gọi real backend (thay mock setTimeout)
		onConfirmCreatePO: function () {
			var oView       = this.getView();
			var sPRId       = oView.byId("txtSelectedPR").getText();
			var sVendorInfo = oView.byId("inSelectedVendor").getValue();
			var fFinalPrice = Number(oView.byId("inFinalPrice").getValue());

			if (!sVendorInfo) {
				MessageBox.error("Vui long chon mot nha cung cap tu phuong an de xuat cua AI.");
				return;
			}
			if (!fFinalPrice || fFinalPrice <= 0) {
				MessageBox.error("Gia thuong luong cuoi cung cua PO phai lon hon 0 VND.");
				return;
			}

			// Tách VendorNo từ "VendorName (VendorNo)"
			var sVendorNo = sVendorInfo.substring(
				sVendorInfo.lastIndexOf("(") + 1,
				sVendorInfo.lastIndexOf(")")
			);

			// Lấy chi tiết PR để build item payload
			var aPRs = oView.getModel("mockData").getProperty("/pendingPRs") || [];
			var oPR  = aPRs.filter(function (pr) { return pr.PrNumber === sPRId; })[0] || {};

			// Build items tu _items[] (multi-item PR). Phan bo fFinalPrice theo ty le EstimatedValue.
			var aRawItems     = oPR._items || [];
			var fTotalEstimated = aRawItems.reduce(function (s, it) { return s + (Number(it.EstimatedValue) || 0); }, 0);
			var aPOItems;
			if (aRawItems.length > 0) {
				aPOItems = aRawItems.map(function (item) {
					// Don gia cho PO = fFinalPrice phan bo theo ty le uoc tinh moi item
					var fShare   = fTotalEstimated > 0 ? ((Number(item.EstimatedValue) || 0) / fTotalEstimated) : (1 / aRawItems.length);
					var fNetPrice = Math.round(fFinalPrice * fShare);
					return {
						materialNo:   item.MaterialNo   || "",
						materialType: item.MaterialType || "ZSRV",
						description:  item.Description  || "",
						quantity:     Number(item.Quantity) || 1,
						uom:          item.UoM          || "EA",
						netPrice:     fNetPrice,
						costCenter:   item.CostCenter   || "",
						assetNo:      item.AssetNo      || "",
						preqNo:       sPRId              // BANFN — lien ket EKPO toi PR nguon
					};
				});
			} else {
				// Fallback: single item tu flat fields (PR cu truoc khi refactor)
				aPOItems = [{
					materialNo:   oPR.MaterialNo   || "",
					materialType: oPR.MaterialType || "ZSRV",
					description:  oPR.Description  || "",
					quantity:     Number(oPR.Quantity) || 1,
					uom:          oPR.UoM          || "EA",
					netPrice:     fFinalPrice,
					costCenter:   oPR.CostCenter   || "",
					assetNo:      oPR.AssetNo      || "",
					preqNo:       sPRId
				}];
			}

			oView.setBusy(true);

			fetch(BACKEND + "/api/po/create", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ vendorNo: sVendorNo, items: aPOItems })
			})
				.then(function (oResp) {
					return oResp.json().then(function (d) { return { status: oResp.status, body: d }; });
				})
				.then(function (oResult) {
					oView.setBusy(false);

					if (!oResult.body || !oResult.body.success) {
						MessageBox.error((oResult.body && oResult.body.message) || "Khong tao duoc Purchase Order.");
						return;
					}

					var oPo       = oResult.body.po;
					var sPoNumber = (oPo && (oPo.PoNumber || oPo.PONumber)) || "(SAP tra ve)";

					MessageBox.success(
						"Da tao Purchase Order " + sPoNumber + " tu PR " + sPRId + ".",
						{
							title: "PO-01 Thanh cong",
							onClose: function () {
								// Xoá PR đã xử lý khỏi bảng chờ
								var oMock     = oView.getModel("mockData");
								var aFiltered = (oMock.getProperty("/pendingPRs") || [])
									.filter(function (pr) { return pr.PrNumber !== sPRId; });
								oMock.setProperty("/pendingPRs", aFiltered);
								oMock.setProperty("/aiSuggestedVendors", []);
								oView.byId("poCreationArea").setVisible(false);
							}
						}
					);
				}.bind(this))
				.catch(function () {
					oView.setBusy(false);
					MessageBox.error("Khong the ket noi toi may chu.");
				});
		},

		// ── Vá-3: PR→PO dropdown methods (dùng khi view có Select#prSelect) ──

		onLoadFromPRPress: function () {
			var oModel        = this.getView().getModel();
			var sSelectedPRId = oModel.getProperty("/selectedPRId");
			var aApprovedPRs  = oModel.getProperty("/approvedPRs") || [];
			var oPR           = aApprovedPRs.filter(function (pr) { return pr.PRId === sSelectedPRId; })[0];

			if (!oPR) { MessageBox.warning("Vui long chon mot PR da duyet."); return; }

			// PR moi co items[]. Map sang format form PO (camelCase, netPrice null de user nhap).
			var aRawItems = oPR.items || [];
			var aFormItems;
			if (aRawItems.length > 0) {
				aFormItems = aRawItems.map(function (item) {
					return {
						materialNo:   item.MaterialNo   || "",
						materialType: item.MaterialType || "",
						description:  item.Description  || "",
						uom:          item.UoM          || "",
						quantity:     Number(item.Quantity) || null,
						netPrice:     null,             // User tu nhap don gia thuong luong
						costCenter:   item.CostCenter   || "",
						assetNo:      item.AssetNo      || "",
						preqNo:       oPR.PRId           // BANFN — toan bo items thuoc cung 1 PR
					};
				});
			} else {
				// Fallback: PR cu (flat fields)
				aFormItems = [{
					materialNo:   oPR.MaterialNo   || "",
					materialType: oPR.MaterialType || "",
					description:  oPR.Description  || "",
					uom:          oPR.UoM           || "",
					quantity:     Number(oPR.Quantity) || null,
					netPrice:     null,
					costCenter:   oPR.CostCenter    || "",
					assetNo:      oPR.AssetNo        || "",
					preqNo:       oPR.PRId
				}];
			}

			oModel.setProperty("/items", aFormItems);
			this._recalcTotal();
			MessageToast.show("Da load " + aFormItems.length + " vat tu tu " + oPR.PRId + ". Vui long nhap don gia.");
		},

		formatRating: function (fRating) {
			return (fRating !== undefined && fRating !== null) ? Number(fRating).toFixed(1) + "*" : "";
		},

		onItemMaterialChange: function (oEvent) {
			var sKey      = oEvent.getParameter("selectedItem") && oEvent.getParameter("selectedItem").getKey();
			var oModel    = this.getView().getModel();
			var oMaterial = (oModel.getProperty("/materials") || []).filter(function (m) { return m.MaterialNo === sKey; })[0];
			var sPath     = oEvent.getSource().getBindingContext().getPath();
			if (!oMaterial) { return; }
			oModel.setProperty(sPath + "/materialType", oMaterial.MaterialType);
			oModel.setProperty(sPath + "/description",  oMaterial.Description);
			oModel.setProperty(sPath + "/uom",          oMaterial.BaseUoM);
			oModel.setProperty(sPath + "/costCenter",   "");
			oModel.setProperty(sPath + "/assetNo",      "");
		},

		onItemValueChange: function () { this._recalcTotal(); },

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
			// Copy mang truoc khi push - JSONModel dua vao deepEqual(reference cu, moi) trong
			// checkUpdate() de fire change; mutate thang mang goc se khien binding khong re-render UI
			var aItems = (oModel.getProperty("/items") || []).slice();
			aItems.push(emptyItem());
			oModel.setProperty("/items", aItems);
		},

		onRemoveItemPress: function (oEvent) {
			var oModel = this.getView().getModel();
			var sPath  = oEvent.getSource().getBindingContext().getPath();
			var iIndex = Number(sPath.split("/").pop());
			// Copy mang truoc khi splice - xem giai thich trong onAddItemPress
			var aItems = (oModel.getProperty("/items") || []).slice();
			if (aItems.length <= 1) { MessageBox.warning("Purchase Order can co it nhat 1 vat tu."); return; }
			aItems.splice(iIndex, 1);
			oModel.setProperty("/items", aItems);
			this._recalcTotal();
		},

		onAiSuggestPress: function () {
			var oModel     = this.getView().getModel();
			var aItems     = oModel.getProperty("/items") || [];
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
					materialName:  oFirstItem.description,
					materialGroup: oFirstItem.materialType,
					quantity:      oFirstItem.quantity,
					budget:        (oFirstItem.netPrice && oFirstItem.quantity)
						? oFirstItem.netPrice * oFirstItem.quantity : undefined,
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

		// onSubmitPress: dùng khi view có form manual (default model binding)
		onSubmitPress: function () {
			var oView     = this.getView();
			var oModel    = oView.getModel();
			var sVendorNo = oModel.getProperty("/vendorNo");
			var aItems    = oModel.getProperty("/items") || [];

			if (!sVendorNo) { MessageBox.warning("Vui long chon nha cung cap."); return; }

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
							materialNo:   item.materialNo,
							materialType: item.materialType,
							description:  item.description,
							quantity:     Number(item.quantity),
							uom:          item.uom,
							netPrice:     Number(item.netPrice),
							costCenter:   item.costCenter,
							assetNo:      item.assetNo,
							preqNo:       item.preqNo || ""
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
					var oPo       = oResult.body.po;
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
		}
	});
});
