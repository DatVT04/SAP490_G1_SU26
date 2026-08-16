sap.ui.define([
	"sap/ui/core/mvc/Controller",
	"sap/ui/model/json/JSONModel",
	"sap/m/MessageBox",
	"sap/m/MessageToast",
	"sap/ui/model/Filter",
	"sap/ui/model/FilterOperator",
	"com/qdavy/procurement/model/Config"
], function (Controller, JSONModel, MessageBox, MessageToast, Filter, FilterOperator, Config) {
	"use strict";

	var BACKEND = Config.BACKEND;

	var RFQ_STATUS_LABELS = {
		DRAFT: "Nháp",
		SENT: "Đã gửi NCC",
		QUOTATIONS_RECEIVED: "Đã có báo giá",
		AWARDED: "Đã chốt NCC"
	};

	return Controller.extend("com.qdavy.procurement.controller.rfq.RFQ02", {

		onInit: function () {
			this.getView().setModel(new JSONModel({
				Rfqs: [],
				rfq: null,
				pr: null,
				quotations: [],
				pendingVendors: [],
				vendorChoices: [],
				paymentTerms: [],
				// aiMessages: mang {role:"user"|"ai", text} — nguon du lieu that cua khung chat.
				// aiChatHtml: HTML da render san tu aiMessages (xem _renderAiChat), view chi
				// bind vao day (giong RFQ-01 — feedback 15/08: "khung chat be ti, hoi xong
				// khong nhin het duoc doan chat", cung bug o ca 2 trang vi copy code nhau).
				aiMessages: [],
				aiChatHtml: "",
				busyAi: false
			}));

			this._loadPaymentTerms();

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
					MessageToast.show("Không tải được danh mục điều khoản thanh toán.");
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
						MessageToast.show((res && res.message) || "Không tải được danh sách RFQ.");
					}
				})
				.catch(function () {
					oTable.setBusy(false);
					MessageToast.show("Không thể kết nối máy chủ để lấy danh sách RFQ.");
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

			// "Dang cho" = tat ca tru AWARDED (gom DRAFT/SENT/QUOTATIONS_RECEIVED),
			// khong liet ke tung trang thai de sau nay them trang thai moi khong sot.
			var sStatus = this._sRfqStatusKey || "OPEN";
			if (sStatus === "AWARDED") {
				aFilters.push(new Filter("Status", FilterOperator.EQ, "AWARDED"));
			} else if (sStatus === "OPEN") {
				aFilters.push(new Filter("Status", FilterOperator.NE, "AWARDED"));
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
			this._loadCompare();
		},

		// ── 2. BANG SO SANH (rfq + quotations + NCC con thieu) ──
		_loadCompare: function () {
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
						MessageToast.show((res && res.message) || "Không tải được dữ liệu RFQ " + sRfqId + ".");
						return;
					}
					oModel.setProperty("/rfq", res.rfq || null);
					oModel.setProperty("/pr", res.pr || null);
					oModel.setProperty("/quotations", res.quotations || []);
					oModel.setProperty("/pendingVendors", res.pendingVendors || []);

					// NCC duoc phep nhap bao gia: ca NCC chua nop (PENDING) lan NCC da nop
					// (de sua lai bao gia nhap nham). Truoc day 2 nhom nay tron lan nhau
					// khong phan biet gi, nhin vao tuong he thong cho nhap trung -> gan
					// nhan ro rang va xep NCC chua nop len truoc.
					var aChoices = (res.pendingVendors || []).map(function (v) {
						return {
							VendorNo: v.VendorNo,
							VendorName: v.VendorName,
							ChoiceLabel: v.VendorNo + " — " + (v.VendorName || "") + "  ·  chưa nộp báo giá"
						};
					}).concat(
						(res.quotations || []).map(function (q) {
							return {
								VendorNo: q.VendorNo,
								VendorName: q.VendorName,
								ChoiceLabel: q.VendorNo + " — " + (q.VendorName || "") + "  ·  đã nhập, chọn để sửa lại"
							};
						})
					);
					oModel.setProperty("/vendorChoices", aChoices);

					oWorkArea.setVisible(true);
				})
				.catch(function () {
					oWorkArea.setBusy(false);
					MessageToast.show("Không thể kết nối máy chủ.");
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
				"Gửi email nhắc tới " + (aPending.length - iNoEmail) + " NCC chưa gửi báo giá?"
					+ (iNoEmail > 0 ? "\n\n" + iNoEmail + " NCC không có email trong master sẽ bị bỏ qua — cần liên hệ bằng cách khác." : ""),
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
									MessageBox.error((res && res.message) || "Gửi nhắc thất bại.");
									return;
								}
								MessageToast.show("Đã gửi nhắc tới " + res.emailsSent + "/" + res.totalVendors + " NCC."
									+ (res.emailsFailed ? " (" + res.emailsFailed + " thư gửi lỗi)" : ""));
							})
							.catch(function () {
								oView.setBusy(false);
								MessageBox.error("Không thể kết nối máy chủ để gửi nhắc.");
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
				MessageToast.show("Không có link cho NCC này.");
				return;
			}

			// navigator.clipboard chi chay tren HTTPS hoac localhost — moi truong
			// khac phai co duong lui, neu khong nguoi dung bam xong khong thay gi.
			var fnFallback = function () {
				MessageBox.information(oVendor.QuoteLink, {
					title: "Link báo giá của " + (oVendor.VendorName || oVendor.VendorNo),
					details: "Sao chép thủ công đoạn link ở trên rồi gửi cho NCC."
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

		// ── 3. LUU 1 BAO GIA (audit trail: enteredBy tu user model, sourceNote bat buoc) ──
		onSaveQuotation: function () {
			var that = this;
			var oView = this.getView();
			var oUser = this.getOwnerComponent().getModel("user").getData() || {};

			var sVendor = oView.byId("selQuoteVendor").getSelectedKey();
			var sPrice = oView.byId("inQuotePrice").getValue();
			var sSource = oView.byId("inQuoteSource").getValue();

			if (!sVendor) {
				MessageBox.warning("Hãy chọn Nhà cung cấp.");
				return;
			}
			if (!sPrice || Number(sPrice) <= 0) {
				MessageBox.warning("Giá báo phải là số dương.");
				return;
			}
			if (!sSource || !sSource.trim()) {
				MessageBox.warning("Bắt buộc nhập căn cứ (SourceNote) — ví dụ email NCC ngày nào.");
				return;
			}

			oView.setBusy(true);

			fetch(BACKEND + "/api/rfq/" + encodeURIComponent(this._currentRfqId) + "/quotation", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					vendorNo: sVendor,
					quotedPrice: Number(sPrice),
					currency: "VND",
					leadTimeDays: Number(oView.byId("inQuoteLeadTime").getValue()) || 0,
					paymentTerms: oView.byId("inQuotePayment").getSelectedKey() || "",
					warrantyMonths: Number(oView.byId("inQuoteWarranty").getValue()) || 0,
					legalDocsOk: oView.byId("cbQuoteLegal").getSelected(),
					sourceNote: sSource.trim(),
					enteredBy: oUser.email || ""
				})
			})
				.then(function (r) {
					return r.json().then(function (body) { return { status: r.status, body: body }; });
				})
				.then(function (oResult) {
					oView.setBusy(false);
					if (!oResult.body || !oResult.body.success) {
						MessageBox.error((oResult.body && oResult.body.message) || "Lưu báo giá thất bại.");
						return;
					}
					MessageToast.show("Đã lưu báo giá của NCC " + sVendor + ".");
					that._clearQuotationForm();
					that._loadCompare();
					that._loadRfqList();
				})
				.catch(function () {
					oView.setBusy(false);
					MessageBox.error("Không thể kết nối máy chủ để lưu báo giá.");
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
						MessageToast.show((res && res.message) || "AI không phản hồi.");
					}
				})
				.catch(function () {
					oModel.setProperty("/busyAi", false);
					MessageToast.show("Không gọi được AI so sánh báo giá.");
				});
		},

		// ── 4b. HOI THEM AI — chat tuong tac tren cac bao gia cua RFQ dang chon ──
		onAiAskPress: function () {
			var oModel = this.getView().getModel();
			var that = this;
			var oInput = this.getView().byId("inAiQuestion");
			var sQuestion = (oInput.getValue() || "").trim();

			if (!sQuestion) {
				MessageToast.show("Hãy nhập câu hỏi trước.");
				return;
			}
			if (!this._currentRfqId) {
				MessageToast.show("Hãy chọn một RFQ trước.");
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
							+ ((res && res.message) || "AI không phản hồi."));
						MessageToast.show((res && res.message) || "AI không phản hồi.");
					}
				})
				.catch(function () {
					oModel.setProperty("/busyAi", false);
					fnFillSlot("Không gọi được AI (lỗi kết nối). Bạn thử hỏi lại giúp tôi.");
					MessageToast.show("Không gọi được AI.");
				});
		},

		// ── 5. CHOT NCC THANG — PR goc chuyen sang PENDING_CFO, gia cap nhat theo bao gia that ──
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
				MessageBox.warning("Hãy chọn Nhà cung cấp thắng.");
				return;
			}
			if (!sReason || !sReason.trim()) {
				MessageBox.warning("Bắt buộc nhập lý do chọn Nhà cung cấp.");
				return;
			}
			if (aQuotations.length === 1 && (!sSoleSource || !sSoleSource.trim())) {
				MessageBox.warning("Chỉ có 1 báo giá — bắt buộc nhập lý do chỉ định 1 NCC (sole source).");
				return;
			}

			MessageBox.confirm(
				"Chốt NCC " + sVendor + " cho RFQ " + this._currentRfqId
				+ "? PR gốc sẽ chuyển sang chờ CFO duyệt với giá báo thật.",
				{
					title: "Xác nhận chốt Nhà cung cấp",
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
									MessageBox.error((oResult.body && oResult.body.message) || "Chốt NCC thất bại.");
									return;
								}
								MessageBox.success(
									"Đã chốt NCC " + oResult.body.awardedVendor + " — giá "
									+ Number(oResult.body.finalValue).toLocaleString("vi-VN")
									+ " VND. PR gốc đã chuyển sang chờ CFO duyệt.",
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
								MessageBox.error("Không thể kết nối máy chủ để chốt NCC.");
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

		formatRfqStatusState: function (s) {
			s = String(s || "").toUpperCase();
			if (s === "AWARDED") { return "Success"; }
			if (s === "QUOTATIONS_RECEIVED") { return "Information"; }
			if (s === "SENT") { return "Warning"; }
			return "None";
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
