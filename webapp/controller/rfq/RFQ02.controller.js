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

	var RFQ_STATUS_LABELS = {
		DRAFT: "Nháp",
		// "Đã gửi NCC" cu doc luot rat de nham voi PO_RELEASED ("gửi NCC" lan 2,
		// nhung la gui don hang chu khong phai gui thu moi bao gia).
		SENT: "Đã mời báo giá",
		QUOTATIONS_RECEIVED: "Đã có báo giá",
		AWARDED: "Đã chốt NCC",
		// Trang thai nay do /api/po/create ghi len RfqSet khi nhom da thanh don hang.
		// Thieu o day thi formatRfqStatus tra ve nguyen ma "PO_CREATED" — lac quer giua
		// mot cot toan tieng Viet (bug 16/08).
		// Nhan noi VIEC DANG CHO AI chu khong ke lai viec da xong: nhin cot trang
		// thai la biet ai phai lam gi tiep.
		PO_CREATED: "Đã tạo đơn hàng",
		// Hai trang thai nay chi con tren ban ghi cu cua luong 2 cua duyet (18-20/08);
		// tu 21/08 khong sinh moi nua — giu nhan de bang lich su khong hien ma tho.
		// 21/08/2026: bo phan "(luong cu)" khoi nhan hien thi theo yeu cau — nguoi dung
		// khong biet "luong cu" la gi, doc vao chi thay kho hieu. Day van la trang thai
		// LEGACY, dung tuong la trang thai binh thuong khi doc code.
		PO_RELEASED: "Đã phát hành PO",
		PO_REJECTED: "PO bị từ chối"
	};

	// Cau giai thich hien khi ro chuot vao trang thai — noi thang buoc tiep theo
	// de nguoi moi dung khong phai doan. (Da bo icon: pill chi con chu + mau.)
	var RFQ_STATUS_HINTS = {
		DRAFT: "RFQ mới tạo, chưa gửi cho nhà cung cấp nào.",
		SENT: "Đã gửi thư mời báo giá — đang chờ nhà cung cấp trả lời.",
		QUOTATIONS_RECEIVED: "Đã có báo giá — đến lượt Purchasing so sánh và chốt NCC.",
		AWARDED: "Đã chốt nhà cung cấp — đề nghị đang chờ CFO/CEO phê duyệt trước khi tạo đơn hàng.",
		PO_CREATED: "Đã tạo đơn hàng trên SAP và gửi cho nhà cung cấp. RFQ này đã khoá.",
		PO_RELEASED: "PO đã được duyệt và gửi cho nhà cung cấp. RFQ này đã khoá.",
		PO_REJECTED: "Đơn hàng bị từ chối ở màn hình PO-02 — xem lý do tại đó."
	};

	// RFQ o cac trang thai nay la DA XONG VIEC: khong con gi de nhap bao gia hay chot
	// nua. Truoc day chi coi AWARDED la xong nen RFQ da tao PO van nam o tab "Dang cho".
	// Tu 19/08 gom ca PO_RELEASED/PO_REJECTED: RFQ da phat hanh PO gui NCC ma van sua
	// duoc bao gia la lo hong kiem soat noi bo (bao gia khong con khop don hang da gui).
	var RFQ_CLOSED_STATUSES = ["AWARDED", "PO_CREATED", "PO_RELEASED", "PO_REJECTED"];

	return Controller.extend("com.qdavy.procurement.controller.rfq.RFQ02", {

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

		/** "MON-001 · ZAST" — dong nhan dang vat tu tren bang so sanh bao gia. */
		formatMatLine: function (sMatNo, sMatType) {
			var sType = sMatType || "";
			return sMatNo
				? this.formatMatNo(sMatNo) + " · " + sType
				: "Nhập tay (free-text) · " + sType;
		},

		onInit: function () {
			this.getView().setModel(new JSONModel({
				Rfqs: [],
				rfq: null,
				// rfqOpen: RFQ dang chon con lam viec duoc khong (chua chot/chua thanh
				// PO). Tinh san o _loadCompare bang isRfqOpen roi view chi bind co nay —
				// khong nhung formatter vao trong expression binding {= ... }.
				rfqOpen: false,
				pr: null,
				quotations: [],
				pendingVendors: [],
				vendorChoices: [],
				paymentTerms: [],
				// allVendors: toan bo NCC tu master (VendorSet) — de dropdown nhap bao
				// gia chon duoc ca NCC NGOAI danh sach moi ban dau (them bao gia moi).
				allVendors: [],
				// quoteModeText/State: MessageStrip ngu canh tren form nhap bao gia —
				// dang SUA bao gia da co (Warning) hay THEM NCC ngoai danh sach (Information).
				quoteModeText: "",
				quoteModeState: "Information",
				// aiMessages: mang {role:"user"|"ai", text} — nguon du lieu that cua khung chat.
				// aiChatHtml: HTML da render san tu aiMessages (xem _renderAiChat), view chi
				// bind vao day (giong RFQ-01 — feedback 15/08: "khung chat be ti, hoi xong
				// khong nhin het duoc doan chat", cung bug o ca 2 trang vi copy code nhau).
				aiMessages: [],
				aiChatHtml: "",
				busyAi: false
			}));

			this._loadPaymentTerms();
			this._loadAllVendors();

			// Khong de UI5 tre 1 giay moi ve spinner: trong 1 giay do man hinh trong
			// nhu binh thuong nhung da bi khoa, nguoi dung bam gi cung khong an
			// (dung bug da gap o RFQ-01 — "phai F5 moi bam duoc").
			this.getView().setBusyIndicatorDelay(0);
			this.getView().byId("rfqTable").setBusyIndicatorDelay(0);

			this._loadRfqList();

			this.getOwnerComponent().getRouter()
				.getRoute("rfq02")
				.attachPatternMatched(this._onRouteMatched, this);
		},

		_onRouteMatched: function () {
			this.getView().byId("rfqWorkArea").setVisible(false);
			this._currentRfqId = null;
			this.getView().getModel().setProperty("/aiMessages", []);
			this.getView().getModel().setProperty("/aiChatHtml", "");
			this._loadRfqList();
		},

		// ── 0. DANH MUC DIEU KHOAN THANH TOAN ──
		// Lay tu /api/config thay vi hardcode trong view: backend dung chinh danh muc nay
		// de dich ma sang nhan tieng Viet khi gui cho AI, hardcode 2 noi la se lech.
		_loadPaymentTerms: function () {
			var oModel = this.getView().getModel();
			var that = this;

			fetch(BACKEND + "/api/config")
				.then(function (r) { return r.json(); })
				.then(function (res) {
					var aTerms = (res && res.paymentTerms) || [];
					oModel.setProperty("/paymentTerms", aTerms);
					that._paymentTermLabels = {};
					aTerms.forEach(function (t) {
						that._paymentTermLabels[String(t.code).toUpperCase()] = t.label;
					});
				})
				.catch(function () {
					// Khong chan man hinh: thieu danh muc thi Select rong, van nhap duoc
					// cac truong khac. Bao giá cu van hien nguyen van ma da luu.
					MessageToast.show("Không tải được danh mục điều khoản thanh toán. Vui lòng thử lại.");
				});
		},

		// ── 1. DANH SACH RFQ TU SAP (RfqSet) ──
		_loadRfqList: function () {
			var oView = this.getView();
			// Chi khoa rieng bang danh sach RFQ, khong khoa ca view — neu khoa ca view
			// thi form nhap bao gia (checkbox/o nhap) ben phai cung bi khoa theo.
			var oTable = oView.byId("rfqTable");
			var that = this;
			oTable.setBusy(true);

			fetch(BACKEND + "/api/rfq")
				.then(function (r) { return r.json(); })
				.then(function (res) {
					oTable.setBusy(false);
					if (res && res.success) {
						oView.getModel().setProperty("/Rfqs", res.data || []);
						// Ap lai bo loc ngay sau khi co du lieu: SegmentedButton dat
						// selectedKey="OPEN" trong XML KHONG ban selectionChange, nen
						// neu khong goi tay o day thi tab hien "Dang cho" nhung bang
						// van liet ke ca RFQ da chot.
						that._applyRfqFilter();
					} else {
						MessageToast.show((res && res.message) || "Không tải được danh sách yêu cầu báo giá. Vui lòng thử lại.");
					}
				})
				.catch(function () {
					oTable.setBusy(false);
					MessageToast.show("Không thể kết nối tới máy chủ. Vui lòng thử lại.");
				});
		},

		// ── TIM & LOC DANH SACH RFQ ────────────────────────────────────────────
		// Loc tai client tren mang /Rfqs da tai, khong goi lai SAP. Hai dieu kien
		// (tu khoa + trang thai) luon duoc gop lai trong _applyRfqFilter de cai nay
		// khong xoa cai kia — loi kinh dien khi moi handler tu goi binding.filter().

		_applyRfqFilter: function () {
			var oTable = this.byId("rfqTable");
			var oBinding = oTable && oTable.getBinding("items");
			if (!oBinding) { return; }

			var aFilters = [];
			var sQuery = String(this._sRfqQuery || "").trim();

			if (sQuery) {
				aFilters.push(new Filter({
					filters: [
						new Filter("RfqId", FilterOperator.Contains, sQuery),
						new Filter("PrId", FilterOperator.Contains, sQuery),
						new Filter("SapPrNumber", FilterOperator.Contains, sQuery)
					],
					and: false
				}));
			}

			// "Dang cho" = tat ca tru cac trang thai DA XONG (xem RFQ_CLOSED_STATUSES),
			// "Da chot" = dung cac trang thai do. Khai bao tap trung o 1 cho de sau nay
			// them trang thai ket thuc moi thi ca 2 tab cung dung, khong lech nhau.
			var sStatus = this._sRfqStatusKey || "OPEN";
			if (sStatus === "AWARDED") {
				aFilters.push(new Filter({
					filters: RFQ_CLOSED_STATUSES.map(function (sClosed) {
						return new Filter("Status", FilterOperator.EQ, sClosed);
					}),
					and: false
				}));
			} else if (sStatus === "OPEN") {
				// Nhieu Filter trong cung 1 mang duoc ListBinding AND lai voi nhau.
				RFQ_CLOSED_STATUSES.forEach(function (sClosed) {
					aFilters.push(new Filter("Status", FilterOperator.NE, sClosed));
				});
			}

			oBinding.filter(aFilters);
		},

		onRfqSearch: function (oEvent) {
			// liveChange tra "newValue", con nut kinh lup tra "query" — nhan ca hai.
			var sNew = oEvent.getParameter("newValue");
			this._sRfqQuery = (sNew !== undefined && sNew !== null)
				? sNew
				: (oEvent.getParameter("query") || "");
			this._applyRfqFilter();
		},

		onRfqStatusFilter: function (oEvent) {
			var oItem = oEvent.getParameter("item");
			this._sRfqStatusKey = oItem ? oItem.getKey() : "OPEN";
			this._applyRfqFilter();
		},

		onRfqSelect: function (oEvent) {
			var oSelectedItem = oEvent.getParameter("listItem");
			if (!oSelectedItem) { return; }
			var oContext = oSelectedItem.getBindingContext();
			var oRfq = oContext ? oContext.getObject() : null;
			if (!oRfq) { return; }

			this._currentRfqId = oRfq.RfqId;
			this.getView().getModel().setProperty("/aiMessages", []);
			this.getView().getModel().setProperty("/aiChatHtml", "");
			// Doi sang RFQ khac: xoa sach form nhap bao gia, khong de prefill/canh
			// bao ghi de cua RFQ truoc dinh lai.
			this._clearQuotationForm();
			this._loadCompare();
		},

		// ── 2. BANG SO SANH (rfq + quotations + NCC con thieu) ──
		_loadCompare: function () {
			var that = this;
			var oView = this.getView();
			var oModel = oView.getModel();
			var sRfqId = this._currentRfqId;
			if (!sRfqId) { return; }

			var oWorkArea = oView.byId("rfqWorkArea");
			oWorkArea.setBusyIndicatorDelay(0);
			oWorkArea.setBusy(true);

			fetch(BACKEND + "/api/rfq/" + encodeURIComponent(sRfqId) + "/compare")
				.then(function (r) { return r.json(); })
				.then(function (res) {
					oWorkArea.setBusy(false);
					if (!res || !res.success) {
						MessageToast.show((res && res.message) || "Không tải được dữ liệu của yêu cầu báo giá " + sRfqId + ".");
						return;
					}
					oModel.setProperty("/rfq", res.rfq || null);
					oModel.setProperty("/rfqOpen", that.isRfqOpen(res.rfq && res.rfq.Status));
					oModel.setProperty("/pr", res.pr || null);
					oModel.setProperty("/quotations", res.quotations || []);
					oModel.setProperty("/pendingVendors", res.pendingVendors || []);

					// Dropdown NCC gop tu 3 nguon (chua nop / da nop — sua lai / ngoai
					// danh sach moi — them moi); logic nam o _buildVendorChoices de goi
					// lai duoc khi /api/vendors ve cham hon /compare.
					that._buildVendorChoices();

					oWorkArea.setVisible(true);
				})
				.catch(function () {
					oWorkArea.setBusy(false);
					MessageToast.show("Không thể kết nối tới máy chủ. Vui lòng thử lại.");
				});
		},

		// ── 2b. NHAC NCC CHUA GUI BAO GIA ──
		// Backend chi gui cho NCC dang o QuoteStatus = PENDING, khong lam phien
		// NCC da nop roi.
		onRemindPending: function () {
			var that = this;
			var oView = this.getView();
			var oUser = this.getOwnerComponent().getModel("user").getData() || {};
			var aPending = oView.getModel().getProperty("/pendingVendors") || [];
			var iNoEmail = aPending.filter(function (v) { return !v.VendorEmail; }).length;

			MessageBox.confirm(
				"Gửi email nhắc tới " + (aPending.length - iNoEmail) + " nhà cung cấp chưa gửi báo giá?"
					+ (iNoEmail > 0 ? "\n\n" + iNoEmail + " nhà cung cấp chưa có email trong dữ liệu chủ sẽ bị bỏ qua. Vui lòng liên hệ bằng kênh khác." : ""),
				{
					title: "Nhắc nhà cung cấp",
					onClose: function (sAction) {
						if (sAction !== MessageBox.Action.OK) { return; }
						oView.setBusy(true);

						fetch(BACKEND + "/api/rfq/" + encodeURIComponent(that._currentRfqId) + "/remind", {
							method: "POST",
							headers: { "Content-Type": "application/json" },
							body: JSON.stringify({ sentBy: oUser.email || "" })
						})
							.then(function (r) { return r.json(); })
							.then(function (res) {
								oView.setBusy(false);
								if (!res || !res.success) {
									MessageBox.error((res && res.message) || "Không gửi được email nhắc. Vui lòng thử lại.");
									return;
								}
								MessageToast.show("Đã gửi email nhắc tới " + res.emailsSent + "/" + res.totalVendors + " nhà cung cấp."
									+ (res.emailsFailed ? " (" + res.emailsFailed + " thư gửi không thành công)" : ""));
							})
							.catch(function () {
								oView.setBusy(false);
								MessageBox.error("Không thể kết nối tới máy chủ. Vui lòng thử lại.");
							});
					}
				}
			);
		},

		// Sao chep link bao gia rieng cua 1 NCC — dung khi NCC bao "khong thay mail"
		// (roi vao Spam) va can gui lai qua Zalo/tin nhan.
		onCopyQuoteLink: function (oEvent) {
			var oCtx = oEvent.getSource().getBindingContext();
			var oVendor = oCtx ? oCtx.getObject() : null;
			if (!oVendor || !oVendor.QuoteLink) {
				MessageToast.show("Nhà cung cấp này chưa có link báo giá.");
				return;
			}

			// navigator.clipboard chi chay tren HTTPS hoac localhost — moi truong
			// khac phai co duong lui, neu khong nguoi dung bam xong khong thay gi.
			var fnFallback = function () {
				MessageBox.information(oVendor.QuoteLink, {
					title: "Link báo giá của " + (oVendor.VendorName || oVendor.VendorNo),
					details: "Vui lòng sao chép thủ công đường dẫn ở trên rồi gửi cho nhà cung cấp."
				});
			};

			if (navigator.clipboard && navigator.clipboard.writeText) {
				navigator.clipboard.writeText(oVendor.QuoteLink)
					.then(function () {
						MessageToast.show("Đã sao chép link báo giá của " + (oVendor.VendorName || oVendor.VendorNo) + ".");
					})
					.catch(fnFallback);
			} else {
				fnFallback();
			}
		},

		// ── 2c. NGUON NCC CHO FORM NHAP BAO GIA ──
		// Tai toan bo NCC tu master dung 1 lan luc mo man hinh — nhom "ngoai danh
		// sach moi" trong dropdown lay tu day.
		_loadAllVendors: function () {
			var oModel = this.getView().getModel();
			var that = this;

			fetch(BACKEND + "/api/vendors")
				.then(function (r) { return r.json(); })
				.then(function (res) {
					oModel.setProperty("/allVendors", (res && res.data) || []);
					// /compare co the da ve truoc — dung lai dropdown de nhom "ngoai
					// danh sach moi" khong bi thieu.
					that._buildVendorChoices();
				})
				.catch(function () {
					// Khong chan man hinh: thieu master thi van nhap/sua duoc bao gia
					// cua NCC da moi, chi khong them duoc NCC ngoai danh sach.
				});
		},

		// Gop 3 nhom NCC vao 1 dropdown, thu tu: chua nop -> da nop (chon de sua,
		// NCC bao lai gia lan 2) -> ngoai danh sach moi (them bao gia moi). Nhan
		// ghi ro tung nhom de nguoi nhap khong ghi de nham.
		_buildVendorChoices: function () {
			var oModel = this.getView().getModel();
			if (!this._currentRfqId) { return; }

			var aPending = oModel.getProperty("/pendingVendors") || [];
			var aQuots = oModel.getProperty("/quotations") || [];
			var aAll = oModel.getProperty("/allVendors") || [];

			var oInRfq = {};
			aPending.forEach(function (v) { oInRfq[String(v.VendorNo)] = true; });
			aQuots.forEach(function (q) { oInRfq[String(q.VendorNo)] = true; });

			var aChoices = aPending.map(function (v) {
				return {
					VendorNo: v.VendorNo,
					VendorName: v.VendorName,
					ChoiceLabel: v.VendorNo + " — " + (v.VendorName || "") + "  ·  chưa nộp báo giá"
				};
			}).concat(
				aQuots.map(function (q) {
					return {
						VendorNo: q.VendorNo,
						VendorName: q.VendorName,
						ChoiceLabel: q.VendorNo + " — " + (q.VendorName || "") + "  ·  đã nhập — chọn để sửa (báo lại giá)"
					};
				})
			).concat(
				aAll.filter(function (v) { return !oInRfq[String(v.VendorNo)]; })
					.map(function (v) {
						return {
							VendorNo: v.VendorNo,
							VendorName: v.VendorName,
							ChoiceLabel: v.VendorNo + " — " + (v.VendorName || "") + "  ·  ngoài danh sách mời — thêm mới"
						};
					})
			);
			oModel.setProperty("/vendorChoices", aChoices);
		},

		// Chon NCC trong dropdown: NCC DA co bao gia -> dien san so lieu cu de sua
		// (bao lai gia lan 2) + canh bao ghi de; NCC ngoai danh sach moi -> bao ro
		// se duoc them vao RFQ nay. SourceNote KHONG dien lai: can cu cua lan bao
		// gia moi bat buoc nhap moi (audit trail).
		onQuoteVendorChange: function () {
			var oView = this.getView();
			var oModel = oView.getModel();
			var sVendor = oView.byId("selQuoteVendor").getSelectedKey();

			var aQuots = oModel.getProperty("/quotations") || [];
			var oQuote = null;
			aQuots.forEach(function (q) {
				if (String(q.VendorNo) === String(sVendor)) { oQuote = q; }
			});

			if (oQuote) {
				oView.byId("inQuotePrice").setValue(Number(oQuote.QuotedPrice) ? String(Number(oQuote.QuotedPrice)) : "");
				oView.byId("inQuoteLeadTime").setValue(oQuote.LeadTimeDays ? String(oQuote.LeadTimeDays) : "");
				oView.byId("inQuotePayment").setSelectedKey(oQuote.PaymentTerms || "");
				oView.byId("inQuoteWarranty").setValue(oQuote.WarrantyMonths ? String(oQuote.WarrantyMonths) : "");
				oView.byId("cbQuoteLegal").setSelected(oQuote.LegalDocsOk === "X" || oQuote.LegalDocsOk === true);
				oView.byId("inQuoteSource").setValue("");
				oModel.setProperty("/quoteModeText",
					"Đang SỬA báo giá đã có của " + (oQuote.VendorName || sVendor)
					+ " (giá cũ " + this.formatCurrency(oQuote.QuotedPrice) + " VND) — lưu sẽ GHI ĐÈ, không giữ lại giá cũ.");
				oModel.setProperty("/quoteModeState", "Warning");
				return;
			}

			var bInvited = (oModel.getProperty("/pendingVendors") || []).some(function (v) {
				return String(v.VendorNo) === String(sVendor);
			});
			if (sVendor && !bInvited) {
				var sName = sVendor;
				(oModel.getProperty("/allVendors") || []).forEach(function (v) {
					if (String(v.VendorNo) === String(sVendor) && v.VendorName) { sName = v.VendorName; }
				});
				oModel.setProperty("/quoteModeText",
					"NCC " + sName + " không nằm trong danh sách mời ban đầu. Khi lưu, hệ thống sẽ thêm báo giá của nhà cung cấp này vào yêu cầu báo giá.");
				oModel.setProperty("/quoteModeState", "Information");
			} else {
				oModel.setProperty("/quoteModeText", "");
			}
		},

		// ── 3. LUU 1 BAO GIA (audit trail: enteredBy tu user model, sourceNote bat buoc) ──
		onSaveQuotation: function () {
			var that = this;
			var oView = this.getView();
			var oUser = this.getOwnerComponent().getModel("user").getData() || {};

			var sVendor = oView.byId("selQuoteVendor").getSelectedKey();
			var sPrice = oView.byId("inQuotePrice").getValue();
			var sSource = oView.byId("inQuoteSource").getValue();

			if (!sVendor) {
				MessageBox.warning("Vui lòng chọn nhà cung cấp.");
				return;
			}
			if (!sPrice || Number(sPrice) <= 0) {
				MessageBox.warning("Giá báo phải là số lớn hơn 0.");
				return;
			}
			if (!sSource || !sSource.trim()) {
				MessageBox.warning("Vui lòng nhập căn cứ của báo giá. Ví dụ: email nhà cung cấp gửi ngày 20/08/2026.");
				return;
			}

			var oPayload = {
				vendorNo: sVendor,
				quotedPrice: Number(sPrice),
				currency: "VND",
				leadTimeDays: Number(oView.byId("inQuoteLeadTime").getValue()) || 0,
				paymentTerms: oView.byId("inQuotePayment").getSelectedKey() || "",
				warrantyMonths: Number(oView.byId("inQuoteWarranty").getValue()) || 0,
				legalDocsOk: oView.byId("cbQuoteLegal").getSelected(),
				sourceNote: sSource.trim(),
				enteredBy: oUser.email || ""
			};

			// NCC da co bao gia -> day la GHI DE (bao lai gia lan 2): bat xac nhan
			// vi gia cu KHONG duoc giu lai (ZG1_QUOTATION 1 dong / NCC / RFQ).
			var oExisting = null;
			(oView.getModel().getProperty("/quotations") || []).forEach(function (q) {
				if (String(q.VendorNo) === String(sVendor)) { oExisting = q; }
			});
			if (oExisting) {
				MessageBox.confirm(
					"NCC " + (oExisting.VendorName || sVendor) + " đã có báo giá "
						+ this.formatCurrency(oExisting.QuotedPrice) + " VND.\n\nGhi đè bằng giá mới "
						+ this.formatCurrency(oPayload.quotedPrice) + " VND? Giá cũ sẽ bị thay thế và không thể khôi phục.",
					{
						title: "Sửa báo giá (báo lại giá lần 2)",
						onClose: function (sAction) {
							if (sAction !== MessageBox.Action.OK) { return; }
							that._postQuotation(oPayload);
						}
					}
				);
				return;
			}

			this._postQuotation(oPayload);
		},

		_postQuotation: function (oPayload) {
			var that = this;
			var oView = this.getView();
			oView.setBusy(true);

			fetch(BACKEND + "/api/rfq/" + encodeURIComponent(this._currentRfqId) + "/quotation", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(oPayload)
			})
				.then(function (r) {
					return r.json().then(function (body) { return { status: r.status, body: body }; });
				})
				.then(function (oResult) {
					oView.setBusy(false);
					if (!oResult.body || !oResult.body.success) {
						Msg.fail(oResult.body, {
							title: "Không lưu được báo giá",
							fallback: "Không lưu được báo giá lên SAP. Số liệu bạn nhập vẫn còn trên biểu mẫu, vui lòng thử lại."
						});
						return;
					}
					MessageToast.show(oResult.body.mode === "created"
						? "Đã thêm báo giá của nhà cung cấp " + oPayload.vendorNo + "."
						: "Đã cập nhật báo giá của nhà cung cấp " + oPayload.vendorNo + ".");
					that._clearQuotationForm();
					that._loadCompare();
					that._loadRfqList();
				})
				.catch(function () {
					oView.setBusy(false);
					MessageBox.error("Không thể kết nối tới máy chủ. Vui lòng thử lại.");
				});
		},

		_clearQuotationForm: function () {
			var oView = this.getView();
			// Bo chon NCC sau khi luu: Select mac dinh forceSelection=true nen neu khong
			// clear, o chon van dinh NCC vua nhap va lan nhap tiep theo rat de ghi de
			// nham vao dung NCC do.
			oView.byId("selQuoteVendor").setSelectedKey("");
			oView.byId("inQuotePrice").setValue("");
			oView.byId("inQuoteLeadTime").setValue("");
			oView.byId("inQuotePayment").setSelectedKey("");
			oView.byId("inQuoteWarranty").setValue("");
			oView.byId("cbQuoteLegal").setSelected(false);
			oView.byId("inQuoteSource").setValue("");
			// ComboBox: setSelectedKey("") khong xoa chu nguoi dung da go — xoa not,
			// va tat MessageStrip sua/them ngu canh.
			oView.byId("selQuoteVendor").setValue("");
			oView.getModel().setProperty("/quoteModeText", "");
		},

		// ── 4. AI SO SANH BAO GIA (chi bat khi >=2 bao gia; server tu an danh hoa) ──
		// ── Khung chat AI: /aiMessages ({role, text}) la nguon du lieu that, ham nay ve lai
		// thanh HTML (bong bong user/AI) roi ghi vao /aiChatHtml de view render + tu cuon.
		// Y het RFQ01.controller.js (_renderAiChat) — 2 trang dung chung 1 co che chat, xem
		// ghi chu day du ben do (feedback 15/08: "khung chat be ti, hoi xong khong nhin het
		// duoc doan chat"; MessageStrip khong co khung cuon rieng, FormattedText loc mat
		// class/mau nen bong bong nen dung sap.ui.core.HTML).
		_escapeHtml: function (sText) {
			return String(sText || "")
				.replace(/&/g, "&amp;")
				.replace(/</g, "&lt;")
				.replace(/>/g, "&gt;")
				.replace(/"/g, "&quot;");
		},

		// Tin cua AI co the co dong ket luan "NCC ĐỀ XUẤT..." + cac gach dau dong "- " (xem quy
		// uoc dinh dang trong prompt o server.js: /api/ai/recommend-vendor,
		// /api/ai/compare-quotations, /api/ai/ask). Ham nay parse quy uoc do thanh HTML de nguoi
		// dung thay ngay ket luan + tung tieu chi ro rang, thay vi phai doc het 1 doan van xuoi
		// dai (feedback 15/08: "muon no ket luan gop y NCC nao luon", "format de nhin hon hon").
		// Y het RFQ01.controller.js — xem ghi chu day du ben do. Tin cua NGUOI DUNG (cau hoi)
		// khong qua ham nay trong _renderAiChat — chi la text thuong, khong can parse gach dau dong.
		_formatAiMessageHtml: function (sText) {
			var that = this;
			var sConclusionPrefix = "NCC ĐỀ XUẤT";
			var aLines = String(sText || "").split("\n");
			var sHtml = "";
			var aBulletBuffer = [];

			function flushBullets() {
				if (aBulletBuffer.length === 0) { return; }
				sHtml += '<ul class="qdAiCriteriaList">' + aBulletBuffer.map(function (s) {
					return "<li>" + that._escapeHtml(s) + "</li>";
				}).join("") + "</ul>";
				aBulletBuffer = [];
			}

			aLines.forEach(function (sLine) {
				var sTrim = sLine.trim();
				if (!sTrim) { return; } // dong trong chi de tach doan, khong render gi
				if (sTrim.indexOf(sConclusionPrefix) === 0) {
					flushBullets();
					var iColon = sTrim.indexOf(":");
					var sValue = (iColon >= 0 ? sTrim.substring(iColon + 1) : "").trim();
					sHtml += '<div class="qdAiConclusion"><span class="qdAiConclusionLabel">'
						+ '🏆 NCC đề xuất</span><span class="qdAiConclusionValue">'
						+ that._escapeHtml(sValue) + "</span></div>";
				} else if (sTrim.indexOf("- ") === 0 || sTrim.indexOf("• ") === 0) {
					aBulletBuffer.push(sTrim.substring(2).trim());
				} else {
					flushBullets();
					sHtml += '<p class="qdAiParagraph">' + that._escapeHtml(sTrim) + "</p>";
				}
			});
			flushBullets();

			return sHtml || ('<p class="qdAiParagraph">' + that._escapeHtml(sText) + "</p>");
		},

		_renderAiChat: function () {
			var oView = this.getView();
			var oModel = oView.getModel();
			var aMessages = oModel.getProperty("/aiMessages") || [];
			var that = this;

			// Nhan "AI goi y" / "Ban hoi" CHI hien khi DOI nguoi noi. Truoc day bong bong
			// nao cung deo nhan, nen 2-3 luot AI tra loi lien tiep la man hinh lap lai chu
			// "AI GOI Y" may lan lien, nhin nhu bi trung lap (feedback 16/08). Cac luot noi
			// tiep cua cung mot nguoi gio chi con bong bong, giong moi app chat binh thuong.
			var sHtml = aMessages.map(function (m, idx) {
				var bUser = m.role === "user";
				var bFollow = idx > 0 && aMessages[idx - 1].role === m.role;
				var sRowClass = "qdAiChatRow " + (bUser ? "qdAiChatRowUser" : "qdAiChatRowAi")
					+ (bFollow ? " qdAiChatRowFollow" : "");
				var sBubbleClass = "qdAiChatBubble " + (bUser ? "qdAiChatBubbleUser" : "qdAiChatBubbleAi");
				// pending = o da dat truoc, dang cho server tra loi. Ve 3 cham nhay thay vi
				// bong bong rong, de nguoi dung biet AI dang xu ly chu khong phai bi treo.
				var sBody = bUser
					? that._escapeHtml(m.text).replace(/\n/g, "<br/>")
					: (m.pending
						? '<span class="qdAiChatTyping"><i></i><i></i><i></i></span>'
						: that._formatAiMessageHtml(m.text));
				var sLabelHtml = bFollow
					? ""
					: '<span class="qdAiChatLabel">' + (bUser ? "Bạn hỏi" : "AI gợi ý") + '</span>';
				// Avatar chi ve o luot dau cua AI; luot noi tiep van giu 1 o AN (Ghost) de
				// bong bong khong bi thut ra sat le trai, lech voi bong bong phia tren.
				var sAvatar = bUser
					? ""
					: '<span class="qdAiChatAvatar' + (bFollow ? " qdAiChatAvatarGhost" : "") + '">AI</span>';
				return '<div class="' + sRowClass + '">' + sAvatar
					+ '<div class="' + sBubbleClass + '">' + sLabelHtml + sBody + '</div>'
					+ '</div>';
			}).join("");

			oModel.setProperty("/aiChatHtml", sHtml);

			setTimeout(function () {
				var oScroll = oView.byId("aiChatScroll");
				if (oScroll && oScroll.getDomRef && oScroll.getDomRef()) {
					var oDom = oScroll.getDomRef("scroll") || oScroll.getDomRef();
					if (oDom) { oDom.scrollTop = oDom.scrollHeight; }
				}
			}, 0);
		},

		// ── 4. AI SO SANH BAO GIA (chi bat khi >=2 bao gia; server tu an danh hoa) ──
		onAiComparePress: function () {
			var oModel = this.getView().getModel();
			var that = this;
			oModel.setProperty("/busyAi", true);

			fetch(BACKEND + "/api/ai/compare-quotations", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ rfqId: this._currentRfqId })
			})
				.then(function (r) { return r.json(); })
				.then(function (res) {
					oModel.setProperty("/busyAi", false);
					if (res && res.success) {
						// Bam lai "AI so sanh bao gia" thi bat dau lai mach chat tu dau, giong
						// hanh vi "AI goi y NCC" o RFQ-01.
						oModel.setProperty("/aiMessages", [{ role: "ai", text: res.recommendation || "" }]);
						that._renderAiChat();
					} else {
						MessageToast.show((res && res.message) || "Trợ lý AI chưa phản hồi. Vui lòng thử lại sau.");
					}
				})
				.catch(function () {
					oModel.setProperty("/busyAi", false);
					MessageToast.show("Không kết nối được tới trợ lý AI. Vui lòng thử lại.");
				});
		},

		// ── 4b. HOI THEM AI — chat tuong tac tren cac bao gia cua RFQ dang chon ──
		onAiAskPress: function () {
			var oModel = this.getView().getModel();
			var that = this;
			var oInput = this.getView().byId("inAiQuestion");
			var sQuestion = (oInput.getValue() || "").trim();

			if (!sQuestion) {
				MessageToast.show("Vui lòng nhập câu hỏi.");
				return;
			}
			if (!this._currentRfqId) {
				MessageToast.show("Vui lòng chọn một yêu cầu báo giá trước.");
				return;
			}

			oModel.setProperty("/busyAi", true);

			// Them tin cua nguoi dung vao chat NGAY (khong doi API tra ve) de UX phan hoi tuc thi.
			//
			// VA DAT SAN 1 O TRONG cho cau tra loi NGAY DUOI cau hoi vua gui.
			// Truoc day cau tra loi duoc .push() vao CUOI mang luc no ve tu server, nen hoi
			// lien 2 cau (chua kip tra loi cau dau) la thu tu thanh Q1, Q2, A1, A2 — cau hoi
			// don cuc mot cho, cau tra loi don cuc mot cho, nhin nhu bi lap va khong con la
			// hoi-dap tuan tu nua (feedback 16/08). Nay moi cau tra loi biet cho cua no.
			var sSlotId = "ai-" + Date.now() + "-" + Math.round(Math.random() * 1e6);
			var aMessages = (oModel.getProperty("/aiMessages") || []).slice();
			aMessages.push({ role: "user", text: sQuestion });
			aMessages.push({ role: "ai", text: "", pending: true, id: sSlotId });
			oModel.setProperty("/aiMessages", aMessages);
			that._renderAiChat();
			oInput.setValue("");

			// Dien cau tra loi (hoac loi) vao DUNG o da dat truoc, tra cuu theo id chu khong
			// theo vi tri — vi tri co the doi neu nguoi dung bam "AI so sanh bao gia" (ham do
			// reset ca mach chat) trong luc dang cho tra loi.
			var fnFillSlot = function (sText) {
				var aNext = (oModel.getProperty("/aiMessages") || []).slice();
				for (var i = 0; i < aNext.length; i++) {
					if (aNext[i] && aNext[i].id === sSlotId) {
						aNext[i] = { role: "ai", text: sText, id: sSlotId };
						oModel.setProperty("/aiMessages", aNext);
						that._renderAiChat();
						return;
					}
				}
				// Khong tim thay o = mach chat da bi reset -> bo qua, khong noi vao cuoi.
			};

			fetch(BACKEND + "/api/ai/ask", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					context: "compare-quotations",
					rfqId: this._currentRfqId,
					question: sQuestion
				})
			})
				.then(function (r) { return r.json(); })
				.then(function (res) {
					oModel.setProperty("/busyAi", false);
					if (res && res.success) {
						fnFillSlot(res.answer || "");
					} else {
						// Loi cung phai hien TRONG mach chat, khong chi bung toast roi de lai
						// bong bong "dang soan..." treo vinh vien.
						fnFillSlot("Xin lỗi, tôi chưa trả lời được câu này. "
							+ ((res && res.message) || "Trợ lý AI chưa phản hồi. Vui lòng thử lại sau."));
						MessageToast.show((res && res.message) || "Trợ lý AI chưa phản hồi. Vui lòng thử lại sau.");
					}
				})
				.catch(function () {
					oModel.setProperty("/busyAi", false);
					fnFillSlot("Không gọi được AI (lỗi kết nối). Bạn thử hỏi lại giúp tôi.");
					MessageToast.show("Không kết nối được tới trợ lý AI. Vui lòng thử lại.");
				});
		},

		// ── 5. CHOT NCC THANG — PR goc chuyen sang AWARDED (cho tao PO), gia cap nhat theo bao gia that ──
		onAwardPress: function () {
			var that = this;
			var oView = this.getView();
			var oModel = oView.getModel();
			var oUser = this.getOwnerComponent().getModel("user").getData() || {};

			var sVendor = oView.byId("selAwardVendor").getSelectedKey();
			var sReason = oView.byId("inAwardReason").getValue();
			var aQuotations = oModel.getProperty("/quotations") || [];
			var sSoleSource = aQuotations.length === 1
				? oView.byId("inSoleSourceReason").getValue()
				: "";

			if (!sVendor) {
				MessageBox.warning("Vui lòng chọn nhà cung cấp trúng thầu.");
				return;
			}
			if (!sReason || !sReason.trim()) {
				MessageBox.warning("Vui lòng nhập lý do chọn nhà cung cấp.");
				return;
			}
			if (aQuotations.length === 1 && (!sSoleSource || !sSoleSource.trim())) {
				MessageBox.warning("Chỉ có một báo giá. Vui lòng nhập lý do chỉ định thầu (sole source).");
				return;
			}

			MessageBox.confirm(
				"Chốt nhà cung cấp " + sVendor + " cho yêu cầu báo giá " + this._currentRfqId
				+ "?\n\nSau khi tất cả các nhóm được chốt, Bộ phận Mua sắm sẽ tạo đơn hàng ở màn hình PO-01. CFO duyệt đơn hàng trước khi gửi cho nhà cung cấp.",
				{
					title: "Xác nhận chốt nhà cung cấp",
					onClose: function (sAction) {
						if (sAction !== MessageBox.Action.OK) { return; }

						oView.setBusy(true);
						fetch(BACKEND + "/api/rfq/" + encodeURIComponent(that._currentRfqId) + "/award", {
							method: "POST",
							headers: { "Content-Type": "application/json" },
							body: JSON.stringify({
								vendorNo: sVendor,
								awardReason: sReason.trim(),
								awardedBy: oUser.email || "",
								soleSourceReason: sSoleSource ? sSoleSource.trim() : ""
							})
						})
							.then(function (r) {
								return r.json().then(function (body) { return { status: r.status, body: body }; });
							})
							.then(function (oResult) {
								oView.setBusy(false);
								if (!oResult.body || !oResult.body.success) {
									Msg.fail(oResult.body, {
									title: "Không chốt được nhà cung cấp",
									fallback: "Không chốt được nhà cung cấp trúng thầu. Yêu cầu báo giá vẫn giữ nguyên, vui lòng thử lại."
								});
									return;
								}
								MessageBox.success(
									"Đã chốt nhà cung cấp " + oResult.body.awardedVendor + " với giá "
									+ Number(oResult.body.finalValue).toLocaleString("vi-VN")
									+ " VND.\n\nBước tiếp theo: tạo đơn hàng ở màn hình PO-01. CFO sẽ duyệt đơn hàng trước khi gửi cho nhà cung cấp.",
									{
										title: "Chốt RFQ thành công",
										onClose: function () {
											that._loadCompare();
											that._loadRfqList();
										}
									}
								);
							})
							.catch(function () {
								oView.setBusy(false);
								MessageBox.error("Không thể kết nối tới máy chủ. Vui lòng thử lại.");
							});
					}
				}
			);
		},

		// ── FORMATTERS ──

		// Ma dieu khoan thanh toan -> nhan tieng Viet. Bao gia cu nhap tay ("net5",
		// "net10") khong khop danh muc thi hien nguyen van, khong nuot mat du lieu.
		formatPaymentTerms: function (sCode) {
			var sRaw = String(sCode || "").trim();
			if (!sRaw) { return "—"; }
			var mLabels = this._paymentTermLabels || {};
			return mLabels[sRaw.toUpperCase()] || sRaw;
		},

		formatCurrency: function (fValue) {
			if (fValue === undefined || fValue === null || fValue === "") { return "0"; }
			return Number(fValue).toLocaleString("vi-VN");
		},

		// K = Cost Center, F = Internal Order, A = Asset — kem doi tuong hach toan tuong ung
		formatAcctAssign: function (sCat, sCostCenter, sInternalOrder, sAssetNo) {
			switch (String(sCat || "").toUpperCase()) {
				case "K": return "K · Cost Center " + (sCostCenter || "—");
				case "F": return "F · Internal Order " + (sInternalOrder || "—");
				case "A": return "A · Tài sản " + (sAssetNo || "—");
				default: return sCat || "—";
			}
		},

		formatRfqStatus: function (s) {
			return RFQ_STATUS_LABELS[String(s || "").toUpperCase()] || s;
		},

		// RFQ con lam viec duoc? Dung cho visible cua cac the THAO TAC (nhac NCC,
		// nhap bao gia, chot NCC). Khai o day thay vi viet '!== AWARDED' rai rac
		// trong XML — them 1 trang thai ket thuc moi chi phai sua RFQ_CLOSED_STATUSES.
		isRfqOpen: function (s) {
			return RFQ_CLOSED_STATUSES.indexOf(String(s || "").toUpperCase()) === -1;
		},

		isRfqClosed: function (s) {
			return RFQ_CLOSED_STATUSES.indexOf(String(s || "").toUpperCase()) !== -1;
		},

		// The ket qua hien cho ca 4 trang thai ket thuc, moi cai mot buoc tiep theo
		// khac nhau — truoc day cung mot dong "PR goc da chuyen sang cho CFO duyet"
		// cho moi truong hop, va cau do da sai tu khi doi sang luong 2 cua duyet
		// (CFO duyet PO chu khong duyet PR nua).
		formatAwardNextStep: function (s) {
			switch (String(s || "").toUpperCase()) {
				case "AWARDED": return "Bước tiếp theo: CFO/CEO phê duyệt đề nghị";
				case "PO_CREATED": return "Đã tạo đơn hàng và gửi cho nhà cung cấp";
				case "PO_RELEASED": return "PO đã được duyệt và gửi cho nhà cung cấp";
				case "PO_REJECTED": return "Đơn hàng đã bị từ chối — xem lý do ở màn hình PO-02";
				default: return "";
			}
		},

		// Bang mau doc duoc thanh cau: XAM = chua bat dau · VANG = dang cho nguoi
		// khac (NCC bao gia / CFO duyet) · XANH DUONG = den luot Purchasing lam ·
		// XANH LA = xong · DO = hong. Nho vay liec cot trang thai la biet viec nao
		// dang nam o minh.
		formatRfqStatusState: function (s) {
			switch (String(s || "").toUpperCase()) {
				case "PO_REJECTED": return "Error";
				case "PO_RELEASED": return "Success";
				case "SENT":
				case "PO_CREATED": return "Success";
				case "QUOTATIONS_RECEIVED":
				case "AWARDED": return "Information";
				default: return "None";
			}
		},

		formatRfqStatusHint: function (s) {
			return RFQ_STATUS_HINTS[String(s || "").toUpperCase()] || "";
		},

		// Chuoi SAP YYYYMMDD -> dd/MM/yyyy
		formatSapDate: function (s) {
			s = String(s || "");
			if (!/^\d{8}$/.test(s)) { return s || "(chưa đặt)"; }
			return s.slice(6, 8) + "/" + s.slice(4, 6) + "/" + s.slice(0, 4);
		},

		// Timestamp -> dd/MM/yyyy HH:mm THEO GIO NGUOI XEM.
		// Server nay tra ve ISO UTC (da quy doi tu chuoi 14 ky tu) — new Date() se tu
		// doi sang gio dia phuong. Van giu nhanh 14 ky tu cho du lieu cu chua quy doi.
		formatSapTimestamp: function (s) {
			s = String(s || "");
			if (/^\d{14}$/.test(s)) {
				return s.slice(6, 8) + "/" + s.slice(4, 6) + "/" + s.slice(0, 4)
					+ " " + s.slice(8, 10) + ":" + s.slice(10, 12);
			}
			var d = new Date(s);
			if (!s || isNaN(d.getTime())) { return s; }
			var pad = function (n) { return String(n).padStart(2, "0"); };
			return pad(d.getDate()) + "/" + pad(d.getMonth() + 1) + "/" + d.getFullYear()
				+ " " + pad(d.getHours()) + ":" + pad(d.getMinutes());
		},

		onNavBack: function () {
			this.getOwnerComponent().getRouter().navTo("dashboard");
		}
	});
});
