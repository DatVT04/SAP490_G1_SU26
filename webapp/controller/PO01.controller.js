sap.ui.define([
	"sap/ui/core/mvc/Controller",
	"sap/ui/model/json/JSONModel",
	"sap/m/MessageBox",
	"sap/m/MessageToast",
	"com/qdavy/procurement/model/Config"
], function (Controller, JSONModel, MessageBox, MessageToast, Config) {
	"use strict";

	var BACKEND = Config.BACKEND;

	return Controller.extend("com.qdavy.procurement.controller.PO01", {

		onInit: function () {
			this._orgDefaults = {};

			// Tạo model 1 lần duy nhất ở đây. Trước đây _loadApprovedPRs() gọi
			// setModel(new JSONModel(...)) nên nếu /api/vendors trả về TRƯỚC thì
			// danh sách vendor vừa nạp bị ghi đè mất — ComboBox NCC rỗng ngẫu nhiên
			// tuỳ tốc độ mạng. Giờ 2 request chỉ setProperty vào cùng 1 model.
			this.getView().setModel(new JSONModel({
				PurchaseRequisitions: [],
				poItems: [],
				Vendors: []
			}));

			this._loadOrgDefaults();
			this._loadApprovedPRs();
			this._loadVendors();

			// Khong cho chon ngay qua khu tren ca 2 DatePicker (Doc Date / Delivery Date).
			// minDate chi chan duoc thao tac qua lich; van go tay duoc ngay qua khu nen
			// onConfirmCreatePO ben duoi phai validate lai lan nua truoc khi gui SAP.
			var oToday = this._todayDateOnly();
			this.getView().byId("inDocDate").setMinDate(oToday);
			this.getView().byId("inDeliveryDate").setMinDate(oToday);

			this.getOwnerComponent().getRouter()
				.getRoute("po01")
				.attachPatternMatched(this._onRouteMatched, this);
		},

		// Tra ve Date() tai 00:00 gio dia phuong (khong dung new Date().toISOString()
		// vi no quy ve UTC, co the lech 1 ngay tuy timezone nguoi dung).
		_todayDateOnly: function () {
			var d = new Date();
			d.setHours(0, 0, 0, 0);
			return d;
		},

		_todayIso: function () {
			var d = this._todayDateOnly();
			var sMonth = String(d.getMonth() + 1).padStart(2, "0");
			var sDay = String(d.getDate()).padStart(2, "0");
			return d.getFullYear() + "-" + sMonth + "-" + sDay;
		},

		// Org data (Company Code / Purch Org / Purch Group) khong duoc luu tren ban ghi PR,
		// nen truoc day 3 o nay luon rong va nguoi dung phai go tay moi lan tao PO.
		// Lay tu /api/config de dung chung 1 nguon voi backend (ORG_DEFAULTS trong server.js).
		_loadOrgDefaults: function () {
			var that = this;
			fetch(BACKEND + "/api/config")
				.then(function (r) { return r.json(); })
				.then(function (cfg) {
					that._orgDefaults = (cfg && cfg.orgDefaults) || {};
				})
				.catch(function () { /* im lang — van cho go tay neu khong lay duoc */ });
		},

		_onRouteMatched: function () {
			this.getView().byId("poCreationArea").setVisible(false);
			// Bang Table giu trang thai "selected" tren tung control theo VI TRI (index),
			// khong dong bo voi model. Khong xoa o day thi lan sau quay lai, dong o
			// cung vi tri van mang co selected=true tu truoc -> bam lai KHONG bao
			// selectionChange (vi UI5 thay "khong co gi thay doi") -> panel ben phai
			// khong mo. Phai xoa tay moi lan vao lai man.
			this.getView().byId("approvedPRTable").removeSelections(true);
			this._loadApprovedPRs();
		},

		// ── 1. ĐỌC DỮ LIỆU PR ĐÃ DUYỆT TỪ API ──
		_loadApprovedPRs: function () {
			var oView = this.getView();
			oView.setBusy(true);

			fetch(BACKEND + "/api/approval/approved")
				.then(function (r) { return r.json(); })
				.then(function (res) {
					oView.setBusy(false);
					if (res && res.success) {
						var aRawData = res.data || [];

						var aMappedPRs = aRawData.map(function (pr) {
							var aItems = pr.items || [];
							var firstItem = aItems[0] || {};

							var sDesc = aItems.length > 1
								? (firstItem.Description || "") + " (+ " + (aItems.length - 1) + " vật tư khác)"
								: (firstItem.Description || "");

							return {
								PrNumber: pr.SapPRId || pr.PRId || pr.InternalId || "",
								CompanyCode: pr.CompanyCode || firstItem.CompanyCode || "",
								PurchOrg: pr.PurchOrg || firstItem.PurchOrg || "",
								PurchGroup: pr.PurchGroup || firstItem.PurchGroup || "",
								MaterialNo: firstItem.MaterialNo || "",
								Description: sDesc,
								Quantity: firstItem.Quantity || 0,
								UoM: firstItem.UoM || "",
								EstimatedValue: pr.TotalValue || firstItem.EstimatedValue || 0,
								Currency: pr.Currency || "",
								RequesterEmail: pr.RequesterEmail || "",
								CostCenter: firstItem.CostCenter || "",
								Plant: firstItem.Plant || "",
								AssetNo: firstItem.AssetNo || "",
								// Ket qua chot NCC tu luong RFQ (do /api/rfq/:id/award ghi lai
								// tren chinh ban ghi approval nay) — dung de tu dien vendor + gia,
								// khong bat nguoi mua go tay lai gia da thuong luong.
								RfqId: pr.RfqId || "",
								RfqAwardedVendor: pr.RfqAwardedVendor || "",
								RfqFinalValue: pr.RfqFinalValue != null ? pr.RfqFinalValue : null,
								EstimatedTotalValue: pr.EstimatedTotalValue != null ? pr.EstimatedTotalValue : null,
								_items: aItems
							};
						});

						var oModel = oView.getModel();
						oModel.setProperty("/PurchaseRequisitions", aMappedPRs);
						oModel.setProperty("/poItems", []);

						if (aMappedPRs.length > 0) {
							this._autoSelectFirstPR();
						}
					}
				}.bind(this))
				.catch(function () {
					oView.setBusy(false);
					MessageToast.show("Không thể lấy danh sách PR từ máy chủ.");
				});
		},

		// ── 2. ĐỌC DANH SÁCH VENDOR TỪ ODATA ──
		_loadVendors: function () {
			var oView = this.getView();
			fetch(BACKEND + "/api/vendors")
				.then(function (r) { return r.json(); })
				.then(function (res) {
					if (res && res.success) {
						oView.getModel().setProperty("/Vendors", res.data || []);
					}
				})
				.catch(function () {
					MessageToast.show("Không tải được danh sách Nhà cung cấp từ SAP.");
				});
		},

		formatCurrency: function (fValue) {
			if (fValue === undefined || fValue === null || fValue === "") { return "0"; }
			return Number(fValue).toLocaleString("vi-VN");
		},

		onNavBack: function () {
			this.getOwnerComponent().getRouter().navTo("dashboard");
		},

		// Tu dong chon dong PR dau tien sau khi danh sach load xong, de khung ben phai
		// (Card 2-6) hien ra ngay khi vao man PO thay vi bat nguoi dung phai bam chon.
		// JSONModel.setProperty() cap nhat binding DONG BO nen "updateFinished" thuong
		// da ban ra TRUOC khi ham nay kip attachEventOnce() -> listener gan sau khong
		// bao gio duoc goi (day la ly do ban dau khong hoat dung). Kiem tra getItems()
		// ngay lap tuc truoc, chi cho vao "updateFinished" khi thuc su chua co du lieu.
		_autoSelectFirstPR: function () {
			var oTable = this.getView().byId("approvedPRTable");
			var fnSelectFirst = function () {
				var aItems = oTable.getItems();
				if (aItems.length === 0) { return; }
				oTable.setSelectedItem(aItems[0], true);
				this._applyPRSelection(aItems[0]);
			}.bind(this);

			if (oTable.getItems().length > 0) {
				fnSelectFirst();
			} else {
				oTable.attachEventOnce("updateFinished", fnSelectFirst);
			}
		},

		// ── 3. SỰ KIỆN KHI CHỌN DÒNG PR (FIX KHÔNG CRASH) ──
		onPRSelect: function (oEvent) {
			var oSelectedItem = oEvent.getParameter("listItem");
			if (!oSelectedItem) { return; }
			this._applyPRSelection(oSelectedItem);
		},

		_applyPRSelection: function (oSelectedItem) {
			try {
				var oContext = oSelectedItem.getBindingContext();
				var oPRData = oContext ? oContext.getObject() : null;

				if (!oPRData) { return; }

				this._currentPR = oPRData;
				var oView = this.getView();
				var oModel = oView.getModel();

				// 1. Mở hiển thị vùng tạo PO bên phải
				oView.byId("poCreationArea").setVisible(true);

				var aItems = oPRData._items || [];
				var firstItem = aItems[0] || {};

				// 2. Điền dữ liệu thông tin PR tham chiếu (Card 1)
				oView.byId("txtSelectedPR").setText(oPRData.PrNumber ? (oPRData.PrNumber + " / " + (firstItem.LineNo || "00001")) : "");
				oView.byId("txtRequester").setText(oPRData.RequesterEmail || "");
				oView.byId("txtMaterialInfo").setText((firstItem.Description || oPRData.Description || "") + (firstItem.MaterialNo ? " (" + firstItem.MaterialNo + ")" : ""));
				oView.byId("txtQuantity").setText((firstItem.Quantity || oPRData.Quantity || 0) + " " + (firstItem.UoM || oPRData.UoM || ""));
				oView.byId("numEstimatedValue").setNumber(this.formatCurrency(oPRData.EstimatedValue));
				oView.byId("numEstimatedValue").setUnit(oPRData.Currency || "");

				// 3. Đổ dữ liệu tổ chức (Card 2).
				// Bản ghi PR không lưu org data, nên lấy mặc định từ /api/config (ORG_DEFAULTS
				// bên server) — vẫn cho sửa tay nếu PR nào đó thực sự khác.
				var oOrg = this._orgDefaults || {};
				oView.byId("inCompanyCode").setValue(oPRData.CompanyCode || oOrg.companyCode || "");
				oView.byId("inPurchOrg").setValue(oPRData.PurchOrg || oOrg.purchOrg || "");
				oView.byId("inPurchGroup").setValue(oPRData.PurchGroup || oOrg.purchGroup || "");
				oView.byId("inCurrency").setValue(oPRData.Currency || oOrg.currency || "");

				// 4. Tính đơn giá khởi tạo.
				// Ưu tiên GIÁ THẬT từ báo giá đã chốt qua RFQ (RfqFinalValue là tổng giá trị
				// PR theo báo giá thắng, giống cách /api/rfq/:id/award ghi vào approvalStore);
				// chỉ khi PR không đi qua RFQ mới rơi về giá ước tính lúc lập PR.
				var fQty = Number(firstItem.Quantity || oPRData.Quantity || 1);
				var bFromRfq = oPRData.RfqFinalValue != null && Number(oPRData.RfqFinalValue) > 0;
				var fBaseValue = bFromRfq ? Number(oPRData.RfqFinalValue) : Number(oPRData.EstimatedValue || 0);
				// VND khong co phan thap phan. Lam tron ngay tai day de tranh dau "."
				// bi regex \D o onRecalculateTotal/onConfirmCreatePO nuot mat, khien
				// Net Price bi thoi phong gap boi (vd 333333.33 -> 33333333).
				var fUnitPrice = fQty > 0 ? Math.round(fBaseValue / fQty) : Math.round(fBaseValue);
				oView.byId("inNetPrice").setValue(fUnitPrice);

				// 5. Kế thừa nhà cung cấp đã thắng thầu (nếu PR này đi qua RFQ)
				this._applyRfqAward(oPRData, fBaseValue, bFromRfq);

				// 6. Cập nhật mảng /poItems cho Bảng Card 3
				var aTableItems = aItems.map(function(it, idx) {
					return {
						// Danh so 00001, 00002... khop cach CREATE_DEEP_ENTITY danh so dong PR
						// khi tao tren SAP. Truoc day dung buoc 10 (00010) theo kieu SAP
						// standard nen tra EBAN khong thay dong nao.
						LineNo: it.LineNo || String(idx + 1).padStart(5, "0"),
						PreqNo: oPRData.PrNumber || "",
						MaterialNo: it.MaterialNo || "",
						Description: it.Description || "",
						Quantity: it.Quantity || 0,
						UoM: it.UoM || "",
						NetPrice: fUnitPrice,
						Currency: oPRData.Currency || "",
						// PrDraftItemSet ben SAP khong co truong Plant (PR luon hardcode
						// plant='QDPL' phia ABAP, xem create_pr_deep.abap) nen it.Plant
						// luon rong — dien san QDPL tu ORG_DEFAULTS, van cho sua tay o bang.
						Plant: it.Plant || oOrg.plant || "QDPL",
						CostCenter: it.CostCenter || ""
					};
				});

				if (aTableItems.length === 0) {
					aTableItems.push({
						LineNo: "00001",
						PreqNo: oPRData.PrNumber || "",
						MaterialNo: oPRData.MaterialNo || "",
						Description: oPRData.Description || "",
						Quantity: oPRData.Quantity || 0,
						UoM: oPRData.UoM || "",
						NetPrice: fUnitPrice,
						Currency: oPRData.Currency || "",
						Plant: oPRData.Plant || oOrg.plant || "QDPL",
						CostCenter: oPRData.CostCenter || ""
					});
				}

				oModel.setProperty("/poItems", aTableItems);
				this.onRecalculateTotal();

			} catch (err) {
				console.error("Lỗi khi chọn dòng PR:", err);
			}
		},

		// ── 3b. KẾ THỪA NCC + GIÁ TỪ BÁO GIÁ ĐÃ CHỐT (RFQ-02) ──
		// Trước đây người mua phải tự nhớ ai thắng thầu rồi chọn lại tay, giá cũng gõ lại —
		// vừa mất thời gian vừa dễ lệch so với giá đã chốt. Giờ đọc thẳng RfqAwardedVendor /
		// RfqFinalValue mà /api/rfq/:id/award đã ghi lên chính bản ghi PR này.
		_applyRfqAward: function (oPRData, fBaseValue, bFromRfq) {
			var oView = this.getView();
			var oStrip = oView.byId("msRfqInherited");
			var oVendorBox = oView.byId("inSelectedVendor");

			if (!bFromRfq || !oPRData.RfqAwardedVendor) {
				oVendorBox.setSelectedKey("");
				oView.byId("inVendorEmail").setValue("");
				if (oStrip) {
					oStrip.setVisible(false);
				}
				return;
			}

			var sVendorNo = String(oPRData.RfqAwardedVendor);
			oVendorBox.setSelectedKey(sVendorNo);

			// Lấy email/tên NCC từ danh sách /Vendors đã tải sẵn, thay vì bắt chọn lại
			var oModel = oView.getModel();
			var aVendors = (oModel && oModel.getProperty("/Vendors")) || [];
			var oVendor = aVendors.filter(function (v) {
				return String(v.VendorNo) === sVendorNo;
			})[0];

			if (oVendor) {
				oView.byId("inVendorEmail").setValue(oVendor.Email || "");
			}

			if (oStrip) {
				var sVendorLabel = oVendor
					? (oVendor.VendorName + " (" + sVendorNo + ")")
					: sVendorNo;
				oStrip.setText(
					"Đã tự điền từ báo giá thắng của RFQ " + (oPRData.RfqId || "")
					+ ": " + sVendorLabel
					+ " — tổng giá chốt " + this.formatCurrency(fBaseValue)
					+ " " + (oPRData.Currency || "")
					+ (oPRData.EstimatedTotalValue != null
						? " (ước tính ban đầu: " + this.formatCurrency(oPRData.EstimatedTotalValue) + ")"
						: "")
					+ ". Vẫn sửa được nếu cần."
				);
				oStrip.setVisible(true);
			}
		},

		// ── 4. CHỌN VENDOR -> LẤY EMAIL TỪ ODATA ──
		onVendorChange: function (oEvent) {
			var oSelectedItem = oEvent.getParameter("selectedItem");
			var oView = this.getView();

			if (oSelectedItem) {
				var oContext = oSelectedItem.getBindingContext();
				var oVendor = oContext ? oContext.getObject() : null;

				if (oVendor) {
					oView.byId("inVendorEmail").setValue(oVendor.Email || "");
				}
			}
		},

		// So dien thoai VN: bo het ky tu khong phai so (khoang trang, dau -, ngoac...)
		// roi kiem tra dang 0xxxxxxxxx (10 so) hoac +84xxxxxxxxx (9 so sau ma vung).
		// Cho phep rong vi khong phai field nao cung bat buoc (vd inBuyerAddress).
		_isValidPhone: function (sPhone) {
			if (!sPhone || !sPhone.trim()) { return true; }
			var sDigitsOnly = sPhone.replace(/[\s\-().]/g, "");
			return /^(0\d{9}|\+84\d{9})$/.test(sDigitsOnly);
		},

		// ── 4b. VALIDATE SỐ ĐIỆN THOẠI (LIVE) ──
		onPhoneChange: function (oEvent) {
			var oInput = oEvent.getSource();
			var sValue = oEvent.getParameter("value");

			if (this._isValidPhone(sValue)) {
				oInput.setValueState("None");
			} else {
				oInput.setValueState("Error");
				oInput.setValueStateText("Số điện thoại không hợp lệ. VD: 0912345678 hoặc +84912345678.");
			}
		},

		// ── 5. TÍNH TOÁN TIỀN TỰ ĐỘNG ──
		onRecalculateTotal: function () {
			var oView = this.getView();
			var sNetPriceRaw = oView.byId("inNetPrice").getValue() || "0";
			var fNetPrice = Number(sNetPriceRaw.toString().replace(/\D/g, "")) || 0;

			var oPR = this._currentPR || {};
			var aItems = oPR._items || [];
			var firstItem = aItems[0] || {};
			var fQty = Number(firstItem.Quantity || oPR.Quantity || 1);

			var fTotal = fNetPrice * fQty;
			var sCurrency = oView.byId("inCurrency").getValue() || oPR.Currency || "";

			oView.byId("numTotalValue").setNumber(this.formatCurrency(fTotal));
			oView.byId("numTotalValue").setUnit(sCurrency);

			// Cập nhật giá lại trong mảng bảng
			var oModel = oView.getModel();
			var aPoItems = oModel.getProperty("/poItems") || [];
			aPoItems.forEach(function(item) {
				item.NetPrice = fNetPrice;
				item.Currency = sCurrency;
			});
			oModel.setProperty("/poItems", aPoItems);
		},

		// ── 6. PHÁT HÀNH PO VÀ GỬI MAIL ──
		onConfirmCreatePO: function () {
			var oView = this.getView();
			var oPR = this._currentPR;

			if (!oPR) {
				MessageBox.error("Vui lòng chọn một PR từ danh sách bên trái.");
				return;
			}

			var sVendorNo = oView.byId("inSelectedVendor").getSelectedKey();
			var sVendorEmail = oView.byId("inVendorEmail").getValue();
			var sCompanyCode = oView.byId("inCompanyCode").getValue();
			var sPurchOrg = oView.byId("inPurchOrg").getValue();
			var sPurchGroup = oView.byId("inPurchGroup").getValue();
			var sDocType = oView.byId("inDocType").getValue();
			var sDocDate = oView.byId("inDocDate").getValue();
			var sDeliveryDate = oView.byId("inDeliveryDate").getValue();
			var sCurrency = oView.byId("inCurrency").getValue();
			var sBuyerPhone = oView.byId("inBuyerAddress").getValue();
			var sReceiverPhone = oView.byId("inReceiverPhone").getValue();

			var sNetPriceRaw = oView.byId("inNetPrice").getValue() || "0";
			var fNetPrice = Number(sNetPriceRaw.toString().replace(/\D/g, "")) || 0;

			// minDate tren DatePicker chi chan qua thao tac click lich, nguoi dung van go
			// tay duoc chuoi ngay qua khu (hoac ngay sai dinh dang khien getValue() tra ve
			// gia tri khong khop valueFormat) — validate lai bang string so sanh ISO
			// (yyyy-MM-dd so sanh duoc truc tiep nhu chuoi vi cung do dai, cung thu tu).
			var sTodayIso = this._todayIso();
			if (sDocDate && sDocDate < sTodayIso) {
				MessageBox.error("Ngày lập chứng từ (Doc Date) không được là ngày trong quá khứ.");
				return;
			}
			if (sDeliveryDate && sDeliveryDate < sTodayIso) {
				MessageBox.error("Ngày nhận hàng dự kiến không được là ngày trong quá khứ.");
				return;
			}

			if (!this._isValidPhone(sReceiverPhone)) {
				MessageBox.error("Số điện thoại người nhận không hợp lệ. VD: 0912345678 hoặc +84912345678.");
				return;
			}
			if (!this._isValidPhone(sBuyerPhone)) {
				MessageBox.error("Số điện thoại (người đại diện) không hợp lệ. VD: 0912345678 hoặc +84912345678.");
				return;
			}

			if (!sCompanyCode) { MessageBox.error("Vui lòng nhập Mã công ty (Company Code)."); return; }
			if (!sPurchOrg) { MessageBox.error("Vui lòng nhập Tổ chức mua hàng (Purchasing Org)."); return; }
			if (!sPurchGroup) { MessageBox.error("Vui lòng nhập Nhóm mua hàng (Purchasing Group)."); return; }
			if (!sDocDate) { MessageBox.error("Vui lòng chọn Ngày lập chứng từ (Doc Date)."); return; }
			if (!sVendorNo) { MessageBox.error("Vui lòng chọn Nhà cung cấp (Vendor)."); return; }
			if (!sReceiverPhone || !sReceiverPhone.trim()) { MessageBox.error("Vui lòng nhập Số điện thoại người nhận."); return; }
			if (!sVendorEmail || !sVendorEmail.trim()) { MessageBox.error("Vui lòng nhập Email Nhà cung cấp."); return; }
			if (fNetPrice <= 0) { MessageBox.error("Đơn giá thương lượng phải lớn hơn 0."); return; }

			var oModel = oView.getModel();
			var aTableItems = oModel.getProperty("/poItems") || [];

			var aItemsPayload = aTableItems.map(function (it, idx) {
				return {
					preqNo: oPR.PrNumber,
					// (idx + 1), KHONG phai (idx + 1) * 10. PR do app tao ra qua
					// CREATE_DEEP_ENTITY duoc danh so dong 00001, 00002... chu khong theo
					// buoc 10 nhu SAP standard, nen gui 00010 se khong tra thay dong nao
					// trong EBAN ("PR ... item 00010 not found").
					preqItem: it.LineNo || String(idx + 1).padStart(5, "0"),
					materialNo: it.MaterialNo || "",
					description: it.Description || "",
					quantity: Number(it.Quantity || 1),
					uom: it.UoM || "",
					netPrice: fNetPrice,
					costCenter: it.CostCenter || "",
					plant: it.Plant || "",
					assetNo: it.AssetNo || ""
				};
			});

			var oPayload = {
				vendorNo: sVendorNo,
				vendorEmail: sVendorEmail.trim(),
				prNumber: oPR.PrNumber,
				companyCode: sCompanyCode,
				purchOrg: sPurchOrg,
				purchGroup: sPurchGroup,
				docType: sDocType,
				docDate: sDocDate,
				currency: sCurrency,
				items: aItemsPayload
			};

			oView.setBusy(true);

			fetch(BACKEND + "/api/po/create", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(oPayload)
			})
				.then(function (r) { return r.json(); })
				.then(function (res) {
					oView.setBusy(false);
					if (res && res.success) {
						var sPoNum = res.poNumber || (res.po && res.po.PoNumber) || "PO_SUCCESS";
						var sMailInfo = res.emailSent ? "\nĐã gửi mail xác nhận đến: " + sVendorEmail.trim() : "";

						MessageBox.success("Tạo Purchase Order thành công!\nMã PO: " + sPoNum + sMailInfo, {
							onClose: function () {
								this._currentPR = null;
								oView.byId("poCreationArea").setVisible(false);
								oView.byId("approvedPRTable").removeSelections(true);
								this._loadApprovedPRs();
							}.bind(this)
						});
					} else {
						MessageBox.error((res && res.message) || "Không thể khởi tạo PO trên SAP.");
					}
				}.bind(this))
				.catch(function () {
					oView.setBusy(false);
					MessageBox.error("Không thể kết nối đến máy chủ backend.");
				});
		}
	});
});