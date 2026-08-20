sap.ui.define([
	"sap/ui/core/mvc/Controller",
	"sap/ui/model/json/JSONModel",
	"sap/m/MessageBox",
	"sap/m/MessageToast",
	"sap/ui/model/Filter",
	"sap/ui/model/FilterOperator",
	"com/qdavy/procurement/model/Config",
	"com/qdavy/procurement/model/Msg"
], function (Controller, JSONModel, MessageBox, MessageToast, Filter, FilterOperator, Config, Msg) {
	"use strict";

	var BACKEND = Config.BACKEND;

	return Controller.extend("com.qdavy.procurement.controller.po.PO01", {

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
			this._orgDefaults = {};

			// Tạo model 1 lần duy nhất ở đây. Trước đây _loadApprovedPRs() gọi
			// setModel(new JSONModel(...)) nên nếu /api/vendors trả về TRƯỚC thì
			// danh sách vendor vừa nạp bị ghi đè mất — ComboBox NCC rỗng ngẫu nhiên
			// tuỳ tốc độ mạng. Giờ 2 request chỉ setProperty vào cùng 1 model.
			this.getView().setModel(new JSONModel({
				PurchaseRequisitions: [],
				poItems: [],
				Vendors: [],
				paymentTerms: [],
				// ── PO THEO NHOM RFQ (16/08/2026) ──
				// 1 PR co the tach thanh nhieu RFQ, moi RFQ chot 1 NCC -> moi RFQ thanh
				// 1 PO rieng. RfqGroups do backend gan vao PR (xem enrichWithRfqAward).
				// Man nay lam TUNG NHOM MOT: chon nhom -> bang dong hang chi con dong cua
				// nhom do, NCC + gia lay theo bao gia da chot cua chinh nhom do.
				RfqGroups: [],
				hasMultiGroup: false,
				selectedGroupKey: "",
				groupHint: ""
			}));

			this._loadOrgDefaults();
			this._loadApprovedPRs();
			this._loadVendors();

      // Khong cho lap PO voi ngay trong qua khu (feedback QDAVY 13/08: "Cho tao PO
      // van chon duoc ngay truoc a?") — ap cho ca Doc Date lan Ngay nhan hang.
      var oToday = this._todayDateOnly();
      var oDocDate = this.getView().byId("inDocDate");
      var oDeliveryDate = this.getView().byId("inDeliveryDate");
      oDocDate.setMinDate(oToday);
      oDeliveryDate.setMinDate(oToday);
      // Doc Date mac dinh hom nay — truong hop pho bien nhat, van sua duoc (ve sau).
      oDocDate.setDateValue(new Date(oToday.getTime()));

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
					// Danh muc dieu khoan thanh toan dung chung voi RFQ-02/backend —
					// de dieu khoan tu bao gia thang chon tu dong dung o Select nay.
					that.getView().getModel().setProperty("/paymentTerms", (cfg && cfg.paymentTerms) || []);
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
								? (firstItem.Description || "") + " (+ " + (aItems.length - 1) + " dòng khác)"
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
								// Loai hach toan di kem doi tuong tuong ung: K = Cost Center,
								// A = Tai san, F = Internal Order. Thieu 2 truong nay thi bang
								// dong hang khong biet dong nao la tai san -> hien o Cost Center
								// trong tron (dong Cat A khong bao gio co cost center).
								AcctAssignCat: firstItem.AcctAssignCat || "",
								InternalOrder: firstItem.InternalOrder || "",
								// Ket qua chot NCC tu luong RFQ (do /api/rfq/:id/award ghi lai
								// tren chinh ban ghi approval nay) — dung de tu dien vendor + gia,
								// khong bat nguoi mua go tay lai gia da thuong luong.
								RfqId: pr.RfqId || "",
								RfqAwardedVendor: pr.RfqAwardedVendor || "",
								RfqFinalValue: pr.RfqFinalValue != null ? pr.RfqFinalValue : null,
								EstimatedTotalValue: pr.EstimatedTotalValue != null ? pr.EstimatedTotalValue : null,
								// Danh sach NHOM NCC (moi nhom = 1 RFQ da chot = 1 PO rieng).
								// BAT BUOC copy sang day: _applyPRSelection doc oPRData.RfqGroups,
								// ma object nay la object MOI do map() dung ra chu khong phai `pr`.
								// Thieu dong nay thi RfqGroups luon undefined -> man hinh roi ve
								// nhanh du phong "Toan bo PR": khong hien dropdown chon nhom, khong
								// tu dien NCC (vi PR nhieu nhom co RfqAwardedVendor = rong theo
								// dung thiet ke), va rai gia ca PR len TAT CA cac dong (bug 16/08).
								RfqGroups: pr.RfqGroups || [],
								RfqGroupCount: pr.RfqGroupCount || 0,
								RfqAllAwarded: !!pr.RfqAllAwarded,
								RfqAwardedVendorName: pr.RfqAwardedVendorName || "",
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
					MessageToast.show("Không tải được danh sách đề nghị mua sắm. Vui lòng thử lại.");
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
					MessageToast.show("Không tải được danh sách nhà cung cấp từ SAP. Vui lòng thử lại.");
				});
		},

		/** Dong chu nho duoi ten vat tu o danh sach PR ben trai. */
		formatMatQtyHint: function (sMatNo, nQty, sUoM) {
			return "Mã VT: " + this.formatMatNo(sMatNo)
				+ " | SL: " + (Number(nQty) || 0) + " " + (sUoM || "");
		},

		formatCurrency: function (fValue) {
			if (fValue === undefined || fValue === null || fValue === "") { return "0"; }
			return Number(fValue).toLocaleString("vi-VN");
		},

		// ── THANH TIEN TUNG DONG ──
		// Cot "Don gia mua" la don gia MOT DON VI (gia trung thau / so luong). Voi don
		// 55.000.000 mua 10 JHR thi o do hien 5.500.000 — dung, nhung nhin mot minh rat
		// de bi doc nham thanh "he thong chia sai 10 lan". Cot Thanh tien nay hien
		// SL x don gia de nguoi doc thay ngay 5.500.000 x 10 = 55.000.000.
		formatLineTotal: function (fPrice, fQty) {
			return this.formatCurrency((Number(fPrice) || 0) * (Number(fQty) || 0));
		},

		/** Dong chu nho duoi Thanh tien: "10 JHR x 5.500.000". */
		formatLineTotalHint: function (fPrice, fQty, sUoM) {
			var nQty = Number(fQty) || 0;
			var nPrice = Number(fPrice) || 0;
			if (!nQty || !nPrice) { return ""; }
			return nQty.toLocaleString("vi-VN") + " " + (sUoM || "")
				+ " × " + nPrice.toLocaleString("vi-VN");
		},

		// ── HACH TOAN TUNG DONG ──
		// K = Cost Center (chi phi phong ban) · A = Asset (tai san co dinh) ·
		// F = Internal Order. Cat suy ra tu du lieu neu PR cu chua luu AcctAssignCat:
		// co AssetNo -> A, co InternalOrder -> F, con lai -> K. Cung quy tac voi
		// deriveAcctAssignCat() ben src/services/pr.service.js — sua 1 ben phai sua ca 2.
		_acctCat: function (sCat, sAsset, sIo) {
			var s = String(sCat || "").trim().toUpperCase();
			if (s) { return s; }
			if (sAsset) { return "A"; }
			if (sIo) { return "F"; }
			return "K";
		},

		formatAcctCatLabel: function (sCat, sAsset, sIo) {
			switch (this._acctCat(sCat, sAsset, sIo)) {
				case "A": return "A · Tài sản";
				case "F": return "F · Internal Order";
				default: return "K · Cost Center";
			}
		},

		// Dong hach toan vao Cost Center thi cho sua tay (nguoi mua co the doi phong
		// ban chiu chi phi); Tai san / Internal Order thi CHI HIEN — ma tai san do
		// ke toan cap trong AS01, go tay o day la sai nguon su that.
		isAcctCostCenter: function (sCat, sAsset, sIo) {
			return this._acctCat(sCat, sAsset, sIo) === "K";
		},

		// Ban phu dinh: dung cho visible cua o chi-hien. KHONG viet
		// "{= !${parts:...formatter:...} }" trong XML — UI5 khong bao dam ho tro
		// formatter trong binding long trong expression binding.
		isAcctNotCostCenter: function (sCat, sAsset, sIo) {
			return this._acctCat(sCat, sAsset, sIo) !== "K";
		},

		formatAcctObject: function (sCat, sAsset, sIo) {
			switch (this._acctCat(sCat, sAsset, sIo)) {
				case "A": return sAsset || "(chưa có mã tài sản)";
				case "F": return sIo || "(chưa có mã lệnh)";
				default: return "";
			}
		},

		// Do = dong tai san nhung khong co ma tai san: phai xu ly truoc khi tao PO,
		// khong de hoi dong nhin thay o trong.
		formatAcctObjectState: function (sCat, sAsset, sIo) {
			switch (this._acctCat(sCat, sAsset, sIo)) {
				case "A": return sAsset ? "Success" : "Error";
				case "F": return sIo ? "Success" : "Error";
				default: return "None";
			}
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
		// Tim PR da duyet theo ma PR / mo ta / ma vat tu. Loc client tren binding
		// /PurchaseRequisitions — khong goi lai SAP.
		onApprovedPRSearch: function (oEvent) {
			var sQuery = (oEvent.getParameter("newValue") !== undefined
				? oEvent.getParameter("newValue")
				: oEvent.getParameter("query")) || "";
			var oTable = this.getView().byId("approvedPRTable");
			var oBinding = oTable && oTable.getBinding("items");
			if (!oBinding) { return; }
			if (!sQuery.trim()) {
				oBinding.filter([]);
				return;
			}
			oBinding.filter(new Filter({
				filters: [
					new Filter("PrNumber", FilterOperator.Contains, sQuery),
					new Filter("Description", FilterOperator.Contains, sQuery),
					new Filter("MaterialNo", FilterOperator.Contains, sQuery)
				],
				and: false
			}));
		},

		_autoSelectFirstPR: function () {
			var oTable = this.getView().byId("approvedPRTable");
			var fnSelectFirst = function () {
				var aItems = oTable.getItems();
				if (aItems.length === 0) { return; }
				// Vua tao PO cho 1 nhom cua PR nay ma no con nhom chua co don -> chon lai
				// DUNG PR do de lam tiep, thay vi nhay ve PR dau danh sach.
				var oTarget = aItems[0];
				if (this._reselectPrNumber) {
					var sWanted = String(this._reselectPrNumber);
					var oMatch = aItems.filter(function (oItem) {
						var oRow = oItem.getBindingContext() && oItem.getBindingContext().getObject();
						return oRow && String(oRow.PrNumber) === sWanted;
					})[0];
					if (oMatch) { oTarget = oMatch; }
					this._reselectPrNumber = null;
				}
				oTable.setSelectedItem(oTarget, true);
				this._applyPRSelection(oTarget);
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

				// 4. Dung san danh sach NHOM (moi nhom = 1 RFQ da chot = se thanh 1 PO).
				// PR khong di qua RFQ -> tao 1 nhom gia lap om toan bo dong, gia tri lay tu
				// du toan, de phan con lai cua man hinh chay y nhu truoc day.
				var aGroups = (oPRData.RfqGroups || []).filter(function (g) {
					var sSt = String(g.Status || "").toUpperCase();
					return sSt === "AWARDED" || sSt === "PO_CREATED";
				}).map(function (g) {
					var bDone = String(g.Status || "").toUpperCase() === "PO_CREATED";
					return {
						key: g.RfqId,
						RfqId: g.RfqId,
						ItemLines: g.ItemLines || "",
						VendorNo: g.AwardedVendor || "",
						VendorName: g.AwardedVendorName || "",
						FinalValue: Number(g.FinalValue) || 0,
						Done: bDone,
						Text: g.RfqId + " · " + (g.AwardedVendorName || g.AwardedVendor || "?")
							+ (bDone ? " (đã có PO)" : "")
					};
				});

				if (aGroups.length === 0) {
					aGroups = [{
						key: "__ALL__",
						RfqId: "",
						ItemLines: "",
						VendorNo: oPRData.RfqAwardedVendor || "",
						VendorName: oPRData.RfqAwardedVendorName || "",
						FinalValue: Number(oPRData.RfqFinalValue) > 0
							? Number(oPRData.RfqFinalValue)
							: Number(oPRData.TotalValue || oPRData.EstimatedValue || 0),
						Done: false,
						Text: "Toàn bộ PR"
					}];
				}

				// Nhom da co PO thi KHONG dua vao danh sach lam viec nua. De lai chi ton
				// tai kha nang bam "Tao PO" lan hai va an nguyen mot hop bao loi do cua SAP
				// ("PR already converted to PO ..."), trong khi that ra moi thu deu dung —
				// nguoi dung tuong he thong hong (feedback 16/08).
				var aPending = aGroups.filter(function (g) { return !g.Done; });

				if (aPending.length === 0) {
					// Moi nhom deu da co don hang: khong con viec gi de lam voi PR nay. An han
					// vung tao PO thay vi de nguoi dung bam roi an bao loi. PR se bien mat khoi
					// danh sach ben trai o lan tai lai sau (backend ha Status ve PO_CREATED
					// khi du nhom).
					this._currentGroup = null;
					oModel.setProperty("/RfqGroups", []);
					oModel.setProperty("/hasMultiGroup", false);
					oView.byId("poCreationArea").setVisible(false);
					MessageToast.show("Đề nghị " + (oPRData.PrNumber || "") + " đã tạo đủ đơn hàng cho tất cả các nhóm.");
					return;
				}

				oModel.setProperty("/RfqGroups", aPending);
				oModel.setProperty("/hasMultiGroup", aPending.length > 1);

				// Nhay thang vao nhom dau tien con thieu — bam lien tuc la lam het cac nhom
				// ma khong phai tu tim nhom nao chua xong.
				var oNext = aPending[0];
				oModel.setProperty("/selectedGroupKey", oNext.key);
				this._applyGroup(oNext);

			} catch (err) {
				console.error("Lỗi khi chọn dòng PR:", err);
			}
		},

		/** Doi sang 1 nhom khac tren dropdown. */
		onGroupChange: function (oEvent) {
			var sKey = oEvent.getSource().getSelectedKey();
			var aGroups = this.getView().getModel().getProperty("/RfqGroups") || [];
			var oGroup = aGroups.filter(function (g) { return g.key === sKey; })[0];
			if (oGroup) { this._applyGroup(oGroup); }
		},

		/**
		 * Do du lieu cua 1 NHOM vao man hinh: loc dong hang, dien NCC, phan bo gia.
		 */
		_applyGroup: function (oGroup) {
			var that = this;
			var oView = this.getView();
			var oModel = oView.getModel();
			var oPRData = this._currentPR || {};
			var oOrg = this._orgDefaults || {};
			var aItems = oPRData._items || [];

			this._currentGroup = oGroup;

			// Loc dong thuoc nhom. ItemLines rong = nhom om toan bo dong cua PR
			// (RFQ tao truoc 16/08/2026, hoac PR khong di qua RFQ) — quy uoc chung
			// voi backend, xem itemsOfRfq() trong src/services/rfq.service.js.
			var aLines = String(oGroup.ItemLines || "").split(",")
				.map(function (x) { return that._normalizeLineNo(x); })
				.filter(Boolean);
			var aGroupItems = aLines.length === 0
				? aItems.slice()
				: aItems.filter(function (it) {
					return aLines.indexOf(that._normalizeLineNo(it.LineNo)) >= 0;
				});

			var aTableItems = aGroupItems.map(function (it, idx) {
				return {
					// Danh so 00001, 00002... khop cach CREATE_DEEP_ENTITY danh so dong PR
					// khi tao tren SAP. Truoc day dung buoc 10 (00010) theo kieu SAP
					// standard nen tra EBAN khong thay dong nao.
					LineNo: it.LineNo || String(idx + 1).padStart(5, "0"),
					PreqNo: oPRData.PrNumber || "",
					MaterialNo: it.MaterialNo || "",
					Description: it.Description || "",
					Quantity: Number(it.Quantity) || 0,
					UoM: it.UoM || "",
					EstimatedValue: Number(it.EstimatedValue) || 0,
					MaterialType: it.MaterialType || "",
					NetPrice: 0,
					Currency: oPRData.Currency || "",
					// PrDraftItemSet ben SAP khong co truong Plant (PR luon hardcode
					// plant='QDPL' phia ABAP, xem create_pr_deep.abap) nen it.Plant
					// luon rong — dien san QDPL tu ORG_DEFAULTS, van cho sua tay o bang.
					Plant: it.Plant || oOrg.plant || "QDPL",
					CostCenter: it.CostCenter || "",
					// Doi tuong hach toan lay nguyen tu dong PR — KHONG doan lai o day.
					// PR da chot loai hach toan tu luc lap de nghi (xem mapSapItemToClient
					// trong src/services/pr.service.js), PO chi hien lai cho dung.
					AcctAssignCat: it.AcctAssignCat || "",
					AssetNo: it.AssetNo || "",
					InternalOrder: it.InternalOrder || ""
				};
			});

			if (aTableItems.length === 0) {
				aTableItems.push({
					LineNo: "00001",
					PreqNo: oPRData.PrNumber || "",
					MaterialNo: oPRData.MaterialNo || "",
					Description: oPRData.Description || "",
					Quantity: Number(oPRData.Quantity) || 0,
					UoM: oPRData.UoM || "",
					EstimatedValue: Number(oPRData.EstimatedValue) || 0,
					MaterialType: oPRData.MaterialType || "",
					NetPrice: 0,
					Currency: oPRData.Currency || "",
					Plant: oPRData.Plant || oOrg.plant || "QDPL",
					CostCenter: oPRData.CostCenter || "",
					AcctAssignCat: oPRData.AcctAssignCat || "",
					AssetNo: oPRData.AssetNo || "",
					InternalOrder: oPRData.InternalOrder || ""
				});
			}

			this._allocateGroupPrice(aTableItems, Number(oGroup.FinalValue) || 0);
			oModel.setProperty("/poItems", aTableItems);

			// Thong tin PR tham chieu doi theo nhom dang xem.
			var oFirst = aTableItems[0] || {};
			oView.byId("txtSelectedPR").setText(
				(oPRData.PrNumber || "") + (oGroup.RfqId ? " · " + oGroup.RfqId : "")
			);
			oView.byId("txtMaterialInfo").setText(
				aTableItems.length === 1
					? (oFirst.Description || "") + (oFirst.MaterialNo ? " (" + oFirst.MaterialNo + ")" : "")
					: aTableItems.length + " dòng trong nhóm này"
			);
			oView.byId("txtQuantity").setText(
				aTableItems.length === 1 ? (oFirst.Quantity + " " + (oFirst.UoM || "")) : "—"
			);

			// Dien NCC da thang thau CUA CHINH NHOM NAY.
			this._applyGroupVendor(oGroup);

			var aGroups = oModel.getProperty("/RfqGroups") || [];
			var iDone = aGroups.filter(function (g) { return g.Done; }).length;
			var sHint = aGroups.length > 1
				? ("PR này tách thành " + aGroups.length + " nhóm nhà cung cấp — mỗi nhóm sẽ thành 1 đơn hàng riêng. "
					+ "Đã tạo PO cho " + iDone + "/" + aGroups.length + " nhóm. Đang lập đơn cho "
					+ oGroup.Text + ".")
				: "";
			if (oGroup.Done) {
				sHint += " LƯU Ý: nhóm này đã có PO rồi — tạo lại sẽ bị SAP từ chối vì dòng PR đã được chuyển thành PO.";
			}
			oModel.setProperty("/groupHint", sHint);

			this.onRecalculateTotal();
		},

		/** Giong normalizeLineNo() ben src/services/rfq.service.js — sua ben nao nho ben kia. */
		_normalizeLineNo: function (vValue) {
			var s = String(vValue === undefined || vValue === null ? "" : vValue).trim();
			if (!s) { return ""; }
			return /^\d+$/.test(s) ? ("00000" + s).slice(-5) : s;
		},

		/**
		 * PHAN BO gia trung thau cua nhom xuong tung dong hang.
		 *
		 * Truoc day man hinh lay (tong gia / so luong DONG DAU TIEN) roi gan don gia do
		 * cho MOI dong -> tong PO = gia bao x so dong (bug 5,5 ty: NCC bao 1,1 ty, SAP ghi
		 * PO 5,5 ty vi PR co 5 dong). Nay chia theo TY TRONG DU TOAN cua tung dong nen
		 * tong PO luon dung bang gia da chot voi NCC.
		 *
		 * Han che da biet: portal bao gia hien chi thu 1 con so TONG cho ca nhom, nen day
		 * van la phan bo uoc luong chu chua phai don gia that tung dong. Nguoi mua SUA TAY
		 * duoc tren cot "Don gia mua" neu bao gia cua NCC co bang chi tiet.
		 */
		_allocateGroupPrice: function (aItems, fTotal) {
			if (!aItems || aItems.length === 0) { return; }

			var fWeightSum = aItems.reduce(function (sum, it) {
				return sum + (Number(it.EstimatedValue) || 0);
			}, 0);

			// Khong co du toan de chia ty trong (PR cu thieu EstimatedValue) -> chia deu.
			var bEven = fWeightSum <= 0;
			var fAllocatedAmount = 0;

			aItems.forEach(function (it, idx) {
				var fQty = Number(it.Quantity) || 0;
				var fPrice;

				if (idx === aItems.length - 1) {
					// Dong cuoi om phan con lai tinh theo THANH TIEN da phan bo (khong phai
					// theo "share" truoc khi chia so luong) — lam vay sai so lam tron cua cac
					// dong tren duoc bu lai o day thay vi cong don.
					var fRemain = fTotal - fAllocatedAmount;
					fPrice = fQty > 0 ? Math.round(fRemain / fQty) : Math.round(fRemain);
				} else {
					var fShare = bEven
						? fTotal / aItems.length
						: fTotal * ((Number(it.EstimatedValue) || 0) / fWeightSum);
					// VND khong co phan thap phan. Lam tron ngay tai day de tranh dau "."
					// bi regex \D o onItemPriceChange nuot mat, khien Net Price bi thoi
					// phong gap boi (vd 333333.33 -> 33333333).
					fPrice = fQty > 0 ? Math.round(fShare / fQty) : Math.round(fShare);
					fAllocatedAmount += fPrice * fQty;
				}

				it.NetPrice = fPrice;
			});
		},


		/** Chon san NCC thang thau cua nhom dang lap + hien nhan giai thich. */
		_applyGroupVendor: function (oGroup) {
			var oView = this.getView();
			var oStrip = oView.byId("msRfqInherited");
			var oVendorBox = oView.byId("inSelectedVendor");
			var sVendorNo = String(oGroup.VendorNo || "");

			if (!sVendorNo) {
				oVendorBox.setSelectedKey("");
				oView.byId("inVendorEmail").setValue("");
				if (oStrip) { oStrip.setVisible(false); }
				return;
			}

			oVendorBox.setSelectedKey(sVendorNo);

			// Email + MST lay tu danh sach /Vendors da tai san, khong bat chon lai tay.
			var aVendors = oView.getModel().getProperty("/Vendors") || [];
			var oVendor = aVendors.filter(function (v) {
				return String(v.VendorNo) === sVendorNo;
			})[0];
			if (oVendor) {
				oView.byId("inVendorEmail").setValue(oVendor.Email || "");
				this._fillVendorTaxCode(oVendor);
			}

			// Ke thua dieu khoan thanh toan + ngay giao tu bao gia thang CUA CHINH NHOM
			// nay (moi nhom 1 NCC, dieu khoan khac nhau) chu khong phai cua ca PR.
			if (oGroup.RfqId) {
				this._applyAwardedQuotationTerms({
					RfqId: oGroup.RfqId,
					RfqAwardedVendor: sVendorNo
				});
			}

			if (oStrip) {
				oStrip.setText(
					"Nhà cung cấp và giá bên dưới lấy từ báo giá đã chốt"
					+ (oGroup.RfqId ? " ở " + oGroup.RfqId : " qua RFQ")
					+ ": " + (oGroup.VendorName || sVendorNo)
					+ " — " + this.formatCurrency(oGroup.FinalValue) + " "
					+ (this._currentPR && this._currentPR.Currency ? this._currentPR.Currency : "")
					+ ". Đơn giá từng dòng được phân bổ theo tỷ trọng dự toán — sửa lại được nếu báo giá có bảng chi tiết."
				);
				oStrip.setVisible(true);
			}
		},

		// ── 3b. [KHONG CON DUNG] KE THUA NCC + GIA TU BAO GIA DA CHOT ──
		// Da thay bang _applyGroupVendor(): ham cu doc RfqAwardedVendor/RfqFinalValue o
		// CAP PR, chi dung khi 1 PR = 1 RFQ = 1 NCC. Tu 16/08/2026 PR co the tach nhieu
		// nhom, moi nhom 1 NCC + 1 gia rieng, nen phai doc theo NHOM. Giu lai ham nay de
		// khong lam vo nhanh nao khac dang goi toi — dung dung cho code moi.
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
				this._fillVendorTaxCode(oVendor);
			}

			// Ke thua not DIEU KHOAN THANH TOAN + NGAY GIAO du kien tu bao gia thang
			// (feedback QDAVY 13/08: moi thong tin tu luong truoc phai tu link sang PO).
			this._applyAwardedQuotationTerms(oPRData);

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

		// Ma so thue: lay tu Vendor Master neu SAP co tra ve (TaxCode/TaxNumber/Stcd1),
		// khong co thi de trong cho nhap tay nhu cu.
		_fillVendorTaxCode: function (oVendor) {
			var sTax = (oVendor && (oVendor.TaxCode || oVendor.TaxNumber || oVendor.Stcd1 || oVendor.TaxNumber1)) || "";
			// Ghi de KE CA khi rong. Truoc day co `if (sTax)` bao quanh: doi tu NCC co
			// MST sang NCC chua co MST thi o nay giu nguyen ma so cua NCC TRUOC DO —
			// tao PO cho NCC nay ma man hinh hien ma so thue cua NCC khac (bug 16/08).
			// LFA1-STCD1 hien con trong o vai NCC (vd 0080000013 FPT) nen tinh huong
			// nay xay ra that chu khong phai gia dinh.
			this.getView().byId("inVendorTaxCode").setValue(sTax);
		},

		// Doc bao gia THANG cua RFQ da chot de tu dien: dieu khoan thanh toan (cung bo ma
		// voi Select nho danh muc /api/config) va Ngay nhan hang du kien = hom nay +
		// LeadTimeDays NCC da cam ket. Van sua tay duoc sau khi tu dien.
		_applyAwardedQuotationTerms: function (oPRData) {
			var oView = this.getView();
			if (!oPRData || !oPRData.RfqId) { return; }

			fetch(BACKEND + "/api/rfq/" + encodeURIComponent(oPRData.RfqId) + "/compare")
				.then(function (r) { return r.json(); })
				.then(function (res) {
					if (!res || !res.success) { return; }
					var aQuotes = res.quotations || [];
					var oWin = aQuotes.filter(function (q) {
						return q.QuoteStatus === "AWARDED"
							|| String(q.VendorNo) === String(oPRData.RfqAwardedVendor);
					})[0];
					if (!oWin) { return; }

					if (oWin.PaymentTerms) {
						oView.byId("inPaymentTerms").setSelectedKey(oWin.PaymentTerms);
					}
					var iLeadDays = Number(oWin.LeadTimeDays) || 0;
					if (iLeadDays > 0) {
						var oEta = new Date();
						oEta.setHours(0, 0, 0, 0);
						oEta.setDate(oEta.getDate() + iLeadDays);
						oView.byId("inDeliveryDate").setDateValue(oEta);
					}
				})
				.catch(function () { /* im lang — nguoi dung van dien tay duoc */ });
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
					this._fillVendorTaxCode(oVendor);
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
		//
		// BAN CU (da bo): lay 1 o "Don gia thuong luong" roi GAN DE don gia do cho MOI
		// dong trong bang, va tinh tong = don gia x so luong dong DAU TIEN. Voi PR nhieu
		// dong thi tong PO gui len SAP = gia bao gia x so dong — chinh la bug PO 5,5 ty
		// (NCC bao 1,1 ty, 5 dong -> SAP ghi 5,5 ty).
		//
		// BAN NAY: don gia thuoc ve TUNG DONG (phan bo tu gia trung thau cua nhom, xem
		// _allocateGroupPrice), tong = tong(don gia x so luong) tren toan bang. Sua don
		// gia 1 dong khong con lam hong cac dong khac.
		onRecalculateTotal: function () {
			var oView = this.getView();
			var oModel = oView.getModel();
			var aPoItems = oModel.getProperty("/poItems") || [];
			var sCurrency = oView.byId("inCurrency").getValue()
				|| (this._currentPR && this._currentPR.Currency) || "";

			var fTotal = aPoItems.reduce(function (sum, it) {
				return sum + (Number(it.NetPrice) || 0) * (Number(it.Quantity) || 0);
			}, 0);

			aPoItems.forEach(function (it) { it.Currency = sCurrency; });
			oModel.setProperty("/poItems", aPoItems);

			oView.byId("numTotalValue").setNumber(this.formatCurrency(fTotal));
			oView.byId("numTotalValue").setUnit(sCurrency);

			// O "Don gia" chung o Card 2 gio chi con la thong tin tham khao (don gia
			// dong dau) — giu lai de khong vo binding cu, nhung KHONG con dieu khien
			// gia cua cac dong nua.
			var oNetPriceInput = oView.byId("inNetPrice");
			if (oNetPriceInput && aPoItems.length) {
				oNetPriceInput.setValue(this.formatCurrency(aPoItems[0].NetPrice));
			}
		},

		/** Nguoi mua sua don gia 1 dong trong bang -> tinh lai tong. */
		onItemPriceChange: function (oEvent) {
			var oCtx = oEvent.getSource().getBindingContext();
			if (oCtx) {
				var sRaw = String(oEvent.getSource().getValue() || "0");
				// Cho phep go "1.100.000" — bo het dau phan cach truoc khi doi sang so.
				var fVal = Number(sRaw.replace(/\D/g, "")) || 0;
				oCtx.getModel().setProperty(oCtx.getPath() + "/NetPrice", fVal);
			}
			this.onRecalculateTotal();
		},

		// ── 6. PHÁT HÀNH PO VÀ GỬI MAIL ──
		onConfirmCreatePO: function () {
			var oView = this.getView();
			var oPR = this._currentPR;

			if (!oPR) {
				MessageBox.error("Chưa chọn đề nghị mua sắm. Vui lòng chọn một đề nghị ở danh sách bên trái.");
				return;
			}

			// Chan trong truong hop nhom hien tai da co don hang (vd nguoi dung mo 2 tab,
			// hoac danh sach chua kip tai lai). De request di den SAP thi no tra ve
			// "PR already converted to PO ..." — dung ky thuat nhung doc nhu he thong hong.
			if (this._currentGroup && this._currentGroup.Done) {
				MessageBox.information("Nhóm này đã có đơn hàng trên SAP. Không cần tạo lại.",
					{ title: "Đã có đơn hàng" });
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
			var sBuyerName = oView.byId("inBuyerName").getValue();
			var sBuyerPhone = oView.byId("inBuyerAddress").getValue();
			var sDeliveryAddress = oView.byId("inDeliveryAddress").getValue();
			var sReceiverName = oView.byId("inReceiverName").getValue();
			var sReceiverPhone = oView.byId("inReceiverPhone").getValue();
			var sPaymentMethod = oView.byId("inPaymentMethod").getSelectedKey();
			var sPaymentTerms = oView.byId("inPaymentTerms").getSelectedKey();


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
				MessageBox.error("Số điện thoại người nhận hàng không hợp lệ. Ví dụ hợp lệ: 0912345678 hoặc +84912345678.");
				return;
			}
			if (!this._isValidPhone(sBuyerPhone)) {
				MessageBox.error("Số điện thoại người đại diện không hợp lệ. Ví dụ hợp lệ: 0912345678 hoặc +84912345678.");
				return;
			}

			if (!sCompanyCode) { MessageBox.error("Vui lòng nhập Mã công ty (Company Code)."); return; }
			if (!sPurchOrg) { MessageBox.error("Vui lòng nhập Tổ chức mua hàng (Purchasing Org)."); return; }
			if (!sPurchGroup) { MessageBox.error("Vui lòng nhập Nhóm mua hàng (Purchasing Group)."); return; }
			if (!sDocDate) { MessageBox.error("Vui lòng chọn Ngày lập chứng từ (Doc Date)."); return; }
			if (!sVendorNo) { MessageBox.error("Vui lòng chọn Nhà cung cấp (Vendor)."); return; }
			if (!sDeliveryAddress || !sDeliveryAddress.trim()) { MessageBox.error("Vui lòng nhập Địa chỉ giao hàng."); return; }
			if (!sReceiverName || !sReceiverName.trim()) { MessageBox.error("Vui lòng nhập Người nhận hàng."); return; }
			if (!sReceiverPhone || !sReceiverPhone.trim()) { MessageBox.error("Vui lòng nhập Số điện thoại người nhận."); return; }
			if (!sDeliveryDate) { MessageBox.error("Vui lòng chọn Ngày nhận hàng dự kiến."); return; }
			if (!sPaymentTerms) { MessageBox.error("Vui lòng chọn Điều khoản thanh toán."); return; }
			if (!sVendorEmail || !sVendorEmail.trim()) { MessageBox.error("Vui lòng nhập Email Nhà cung cấp."); return; }

			// oModel phai khai bao TRUOC khoi kiem tra don gia ben duoi. Truoc day dong
			// `var oModel = ...` nam sau khoi do: `var` bi hoisted nen oModel la undefined
			// tai thoi diem goi oModel.getProperty() -> TypeError -> UI5 nuot loi vao
			// console va nut "Tao PO" bam khong ra gi ca (bug 16/08).
			var oModel = oView.getModel();
			var aTableItems = oModel.getProperty("/poItems") || [];

			// Truoc day chi kiem tra o "Don gia thuong luong" chung > 0. Nay gia nam o
			// TUNG DONG nen phai soat tung dong — 1 dong gia 0 lot qua se tao PO sai tien.
			var aZeroLines = aTableItems.filter(function (it) {
				return !(Number(it.NetPrice) > 0);
			});
			if (aZeroLines.length) {
				MessageBox.error("Các dòng sau chưa có đơn giá: "
					+ aZeroLines.map(function (it) { return it.LineNo; }).join(", ")
					+ ". Vui lòng nhập đơn giá cho các dòng này trong bảng Chi tiết dòng hàng.");
				return;
			}

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
					// Don gia RIENG cua dong nay (da phan bo tu gia trung thau cua nhom,
					// nguoi mua co the sua tay) — KHONG con dung chung 1 don gia cho ca bang.
					netPrice: Number(it.NetPrice) || 0,
					costCenter: it.CostCenter || "",
					plant: it.Plant || "",
					// assetNo truoc day LUON rong: bang dong hang khong mang truong nay
					// nen it.AssetNo undefined. Gio da mang tu PR sang.
					assetNo: it.AssetNo || "",
					internalOrder: it.InternalOrder || "",
					acctAssignCat: it.AcctAssignCat || ""
				};
			});

			var oPayload = {
				vendorNo: sVendorNo,
				vendorEmail: sVendorEmail.trim(),
				prNumber: oPR.PrNumber,
				// Nhom (RFQ) ma don hang nay thuoc ve — backend danh dau nhom da co PO va
				// chi ha PR sang PO_CREATED khi MOI nhom deu xong.
				rfqId: (this._currentGroup && this._currentGroup.RfqId) || "",
				companyCode: sCompanyCode,
				purchOrg: sPurchOrg,
				purchGroup: sPurchGroup,
				docType: sDocType,
				docDate: sDocDate,
				currency: sCurrency,
				items: aItemsPayload,
				buyerName: sBuyerName.trim(),
				buyerPhone: sBuyerPhone.trim(),
				deliveryAddress: sDeliveryAddress.trim(),
				receiverName: sReceiverName.trim(),
				receiverPhone: sReceiverPhone.trim(),
				deliveryDate: sDeliveryDate,
				paymentMethod: sPaymentMethod,
				paymentTerms: sPaymentTerms
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
						// 18/08/2026: PO tao xong CHUA gui NCC — cho CFO/CEO duyet (PO-02).
						var sMailInfo = "\nĐơn hàng chưa được gửi cho nhà cung cấp. CFO duyệt ở màn hình PO-02, duyệt xong hệ thống mới gửi email.";

						// PR tach nhieu nhom: tao xong nhom nay van con nhom khac chua co don
						// hang. Khong roi man hinh nua ma tai lai danh sach de lam tiep nhom sau —
						// truoc day luon navTo("dashboard") nen nguoi dung tuong da xong ca PR.
						var iDone = Number(res.groupsDone) || 0;
						var iTotal = Number(res.groupsTotal) || 0;
						var bMoreGroups = iTotal > 1 && iDone < iTotal;
						var sGroupInfo = iTotal > 1
							? "\n\nĐã tạo PO cho " + iDone + "/" + iTotal + " nhóm của PR này."
								+ (bMoreGroups ? " Màn hình sẽ quay lại để bạn tạo đơn cho nhóm còn lại." : "")
							: "";

						MessageBox.success("Đã tạo đơn hàng trên SAP.\n\nMã đơn hàng: " + sPoNum + sMailInfo + sGroupInfo, {
							onClose: function () {
								if (bMoreGroups) {
									var sKeep = this._currentPR && this._currentPR.PrNumber;
									this._reselectPrNumber = sKeep;
									this._loadApprovedPRs();
									return;
								}
								this._currentPR = null;
								this.getOwnerComponent().getRouter().navTo("dashboard");
							}.bind(this)
						});
					} else {
						var sRaw = (res && res.message) || "";

						// "PR already converted to PO xxx" KHONG phai su co — don hang da ton
						// tai, mo he thong ra la thay. Hien dang thong bao trung tinh + tai lai
						// danh sach, thay vi hop bao loi do lam nguoi dung tuong hong nang.
						if (/already converted to PO/i.test(sRaw)) {
							var aPo = sRaw.match(/\b\d{10}\b/);
							MessageBox.information(
								"Yêu cầu mua hàng này đã được chuyển thành đơn hàng trên SAP"
								+ (aPo ? " (PO " + aPo[0] + ")" : "")
								+ ". Không cần tạo lại.",
								{ title: "Đã có đơn hàng" }
							);
							this._loadApprovedPRs();
							return;
						}

						// Loi cua SAP (message + errordetails + ma HTTP) duoc Msg gom lai
						// va day xuong muc "Xem chi tiet". Nguoi mua hang chi doc mot cau
						// noi ro don hang chua duoc tao va de nghi van con nguyen.
						Msg.fail(res, {
							title: "Không tạo được đơn hàng",
							fallback: "Không tạo được đơn hàng trên SAP. Đề nghị mua sắm vẫn giữ nguyên,"
								+ " bạn có thể kiểm tra lại thông tin rồi bấm Tạo PO lần nữa."
						});
					}
				}.bind(this))
				.catch(function () {
					oView.setBusy(false);
					MessageBox.error("Không thể kết nối tới máy chủ. Vui lòng thử lại.");
				});
		}
	});
});