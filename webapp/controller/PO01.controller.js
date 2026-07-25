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
						oView.getModel().setProperty("/approvedPRs", aData);

						var aMapped = aData.map(function (pr) {
							var aItems = pr.items || [];
							var firstItem = aItems[0] || {};
							var sDesc = aItems.length > 1
								? (firstItem.Description || "") + " (+thêm " + (aItems.length - 1) + " vật tư)"
								: (firstItem.Description || pr.Description || "");

							// FIX: Lấy EstimatedValue từ SAP trước, nếu không có mới lấy TotalValue
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
								EstimatedValue: fValue, // Đã gán đúng giá trị từ SAP OData
								Currency: pr.Currency || "VND",
								Status: pr.Status,
								_items: aItems
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

		// ── Formatters ────────────────────────────────────────────────────────

		formatCurrency: function (fValue) {
			if (fValue === undefined || fValue === null || fValue === "") { return "0"; }
			return Number(fValue).toLocaleString("vi-VN");
		},

		formatRating: function (fRating) {
			return (fRating !== undefined && fRating !== null) ? Number(fRating).toFixed(1) + "*" : "";
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

			// Lưu lại PR đang chọn vào controller để dùng khi submit
			this._currentPR = oPRData;

			// Hiển thị khu vực form bên phải
			this.getView().byId("poCreationArea").setVisible(true);

			// Điền thông tin PR vào các thẻ hiển thị phía trên (Khu vực 2)
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

			// Reset Form nhập liệu (Khu vực 4)
			this.getView().byId("inSelectedVendor").setSelectedKey("");
			this.getView().byId("inSelectedVendor").setValue("");
			this.getView().byId("inFinalPrice").setValue(this.formatCurrency(oPRData.EstimatedValue));

			// Gọi AI gợi ý NCC
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
					{ VendorNo: "0050000007", VendorName: "Cong ty TNHH Dell Viet Nam", Rating: 4.5, PriceProposal: Math.round(fEstimatedValue * 0.97), AiReason: "Khop 100% ky thuat, gia re hon 3% so voi ngan sach. Thoi gian giao hang 7 ngay." },
					{ VendorNo: "0050000009", VendorName: "Cong ty TNHH HP Viet Nam", Rating: 3.8, PriceProposal: Math.round(fEstimatedValue * 0.90), AiReason: "Gia tot nhat. Thoi gian giao hang 10 ngay, bao hanh noi dia." }
				];
			} else if (sM.indexOf("SERVER") >= 0 || sM.indexOf("NAS") >= 0 || sM.indexOf("SWITCH") >= 0) {
				aMockAIVendors = [
					{ VendorNo: "0050000009", VendorName: "Cong ty TNHH HP Viet Nam", Rating: 4.8, PriceProposal: Math.round(fEstimatedValue * 0.97), AiReason: "Xep hang toi uu - lich su cap hang Server on dinh, mien phi lap dat cau hinh rack." },
					{ VendorNo: "0050000007", VendorName: "Cong ty TNHH Dell Viet Nam", Rating: 4.5, PriceProposal: Math.round(fEstimatedValue * 1.02), AiReason: "Cao hon ngan sach 2%, giao hang 7 ngay, ho tro ky thuat tot." }
				];
			} else {
				// SW-LIC, CLOUD, SUPPLY, MAINT, TRAIN, CONSULT
				aMockAIVendors = [
					{ VendorNo: "0050000008", VendorName: "Cong ty CP Microsoft Viet Nam", Rating: 4.0, PriceProposal: Math.round(fEstimatedValue * 0.95), AiReason: "Phu hop vat tu dich vu/phan mem. Giao hang nhanh 5 ngay." },
					{ VendorNo: "0050000007", VendorName: "Cong ty TNHH Dell Viet Nam", Rating: 4.5, PriceProposal: Math.round(fEstimatedValue * 1.0), AiReason: "NCC da dang, co the cung cap nhieu chung loai vat tu CNTT." }
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

			// Dùng setSelectedKey để ComboBox map chính xác mã Vendor
			this.getView().byId("inSelectedVendor").setSelectedKey(oVendorData.VendorNo);

			// Gán giá gợi ý từ AI đã được format dấu chấm phân cách nghìn
			this.getView().byId("inFinalPrice").setValue(this.formatCurrency(oVendorData.PriceProposal));
		},

		// XÁC NHẬN TẠO PO
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

			// Tự đóng gói nếu danh sách items rỗng
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

			// CHUẨN HÓA DỮ LIỆU ITEMS (Map PascalCase -> camelCase & gán CostCenter/NetPrice)
			var aFormattedItems = aRawItems.map(function (item) {
				return {
					preqNo: item.preqNo || item.PRNumber || item.PRId || sPRId,
					materialNo: item.materialNo || item.MaterialNo || "",
					materialType: item.materialType || item.MaterialType || "ZSRV",
					description: item.description || item.Description || "",
					quantity: Number(item.quantity || item.Quantity || 1),
					uom: item.uom || item.UoM || "EA",
					// Nếu đơn giá từng dòng không có, chia đều hoặc lấy fFinalPrice
					netPrice: Number(item.netPrice || item.NetPrice || item.Price || fFinalPrice),
					// Đảm bảo luôn lấy CostCenter (ưu tiên camelCase -> PascalCase -> mặc định CCADM)
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
					items: aFormattedItems // Gửi mảng đã chuẩn hóa
				})
			})
				.then(function (r) { return r.json(); })
				.then(function (res) {
					oView.setBusy(false);
					if (res && res.success) {
						MessageBox.success("Tạo PO thành công! Mã PO: " + (res.poNumber || res.poId), {
							onClose: function () {
								this._currentPR = null;
								this._onRouteMatched();
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

		// ── Vá-3: PR→PO dropdown methods (dùng khi view có Select#prSelect) ──

		onLoadFromPRPress: function () {
			var oModel = this.getView().getModel();
			var sSelectedPRId = oModel.getProperty("/selectedPRId");
			var aApprovedPRs = oModel.getProperty("/approvedPRs") || [];
			var oPR = aApprovedPRs.filter(function (pr) { return pr.PRId === sSelectedPRId; })[0];

			if (!oPR) { MessageBox.warning("Vui long chon mot PR da duyet."); return; }

			var aRawItems = oPR.items || [];
			var aFormItems;
			if (aRawItems.length > 0) {
				aFormItems = aRawItems.map(function (item) {
					return {
						materialNo: item.MaterialNo || "",
						materialType: item.MaterialType || "",
						description: item.Description || "",
						uom: item.UoM || "",
						quantity: Number(item.Quantity) || null,
						netPrice: null,             // User tu nhap don gia thuong luong
						costCenter: item.CostCenter || "CCADM",
						assetNo: item.AssetNo || "",
						preqNo: oPR.PRId           // BANFN — toan bo items thuoc cung 1 PR
					};
				});
			} else {
				aFormItems = [{
					materialNo: oPR.MaterialNo || "",
					materialType: oPR.MaterialType || "",
					description: oPR.Description || "",
					uom: oPR.UoM || "",
					quantity: Number(oPR.Quantity) || null,
					netPrice: null,
					costCenter: oPR.CostCenter || "",
					assetNo: oPR.AssetNo || "",
					preqNo: oPR.PRId
				}];
			}

			oModel.setProperty("/items", aFormItems);
			this._recalcTotal();
			MessageToast.show("Da load " + aFormItems.length + " vat tu tu " + oPR.PRId + ". Vui long nhap don gia.");
		},

		onItemMaterialChange: function (oEvent) {
			var sKey = oEvent.getParameter("selectedItem") && oEvent.getParameter("selectedItem").getKey();
			var oModel = this.getView().getModel();
			var oMaterial = (oModel.getProperty("/materials") || []).filter(function (m) { return m.MaterialNo === sKey; })[0];
			var sPath = oEvent.getSource().getBindingContext().getPath();
			if (!oMaterial) { return; }

			oModel.setProperty(sPath + "/materialType", oMaterial.MaterialType);
			oModel.setProperty(sPath + "/description", oMaterial.Description);
			oModel.setProperty(sPath + "/uom", oMaterial.BaseUoM);

			// Gán mặc định CCADM nếu chưa có thay vì gán rỗng ""
			var sCurrentCC = oModel.getProperty(sPath + "/costCenter");
			if (!sCurrentCC) {
				oModel.setProperty(sPath + "/costCenter", "CCADM");
			}
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
			var aItems = (oModel.getProperty("/items") || []).slice();
			aItems.push(emptyItem());
			oModel.setProperty("/items", aItems);
		},

		onRemoveItemPress: function (oEvent) {
			var oModel = this.getView().getModel();
			var sPath = oEvent.getSource().getBindingContext().getPath();
			var iIndex = Number(sPath.split("/").pop());
			var aItems = (oModel.getProperty("/items") || []).slice();
			if (aItems.length <= 1) { MessageBox.warning("Purchase Order can co it nhat 1 vat tu."); return; }
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
					budget: (oFirstItem.netPrice && oFirstItem.quantity)
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

		// Format giá trực tiếp khi người dùng gõ
		onFinalPriceLiveChange: function (oEvent) {
			var oInput = oEvent.getSource();
			var sValue = oEvent.getParameter("newValue");

			var oDomRef = oInput.getFocusDomRef();
			var iCursorPos = oDomRef ? oDomRef.selectionStart : 0;

			// FIX: đếm số CHỮ SỐ đứng trước con trỏ (bỏ qua dấu chấm phân cách),
			// thay vì dùng độ dài chuỗi thô. Cách cũ dùng độ dài chuỗi ký tự làm
			// mốc "vị trí cũ" nên khi dấu chấm bị chèn/dịch chuyển giữa các lần
			// gõ (vd 5.000 -> 50.000), việc đặt lại con trỏ bị lệch, khiến ký tự
			// gõ tiếp theo chèn nhầm vị trí và sinh ra số sai (vd 500000 ra 555000).
			var iDigitsBeforeCursor = sValue.slice(0, iCursorPos).replace(/\D/g, "").length;

			// 1. Chỉ giữ lại chữ số
			var sCleanValue = sValue.replace(/\D/g, "");

			if (sCleanValue) {
				// 2. Format dấu chấm phân cách hàng nghìn
				var sFormattedValue = new Intl.NumberFormat("vi-VN").format(sCleanValue);
				oInput.setValue(sFormattedValue);

				// 3. Đặt lại con trỏ ngay sau chữ số thứ N (N = số chữ số đã gõ
				// trước đó), bất kể dấu chấm nằm ở đâu trong chuỗi mới.
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
		},

		// onSubmitPress: dùng khi view có form manual
		onSubmitPress: function () {
			var oView = this.getView();
			var oModel = oView.getModel();
			var sVendorNo = oModel.getProperty("/vendorNo");
			var aItems = oModel.getProperty("/items") || [];

			if (!sVendorNo) { MessageBox.warning("Vui long chon nha cung cap."); return; }

			// Sửa đoạn check trong onSubmitPress:
			for (var i = 0; i < aItems.length; i++) {
				var item = aItems[i];
				var sCostCenter = item.costCenter || item.CostCenter; // Lấy cả 2 kiểu viết hoa/thường
				var sMaterialType = item.materialType || item.MaterialType;
				var sMaterialNo = item.materialNo || item.MaterialNo;

				if (!sMaterialNo || !item.quantity || !(item.netPrice || item.NetPrice)) {
					MessageBox.warning("Vui long dien day du Vat tu / So luong / Don gia cho tat ca dong.");
					return;
				}
				if (sMaterialType === "ZAST" && !(item.assetNo || item.AssetNo)) {
					MessageBox.warning("Vat tu " + sMaterialNo + " la tai san (ZAST), bat buoc phai co Asset No.");
					return;
				}
				if (sMaterialType !== "ZAST" && !sCostCenter) {
					MessageBox.warning("Vat tu " + sMaterialNo + " bat buoc phai co Cost Center.");
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
							assetNo: item.assetNo,
							preqNo: item.preqNo || ""
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
		}
	});
});