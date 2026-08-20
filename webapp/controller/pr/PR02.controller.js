sap.ui.define([
	"sap/ui/core/mvc/Controller",
	"sap/ui/model/json/JSONModel",
	"sap/m/MessageBox",
	"sap/m/MessageToast",
	"sap/m/Dialog",
	"sap/m/DialogType",
	"sap/m/Button",
	"sap/m/ButtonType",
	"sap/m/TextArea",
	"sap/m/VBox",
	"sap/m/Label",
	"sap/m/Text",
	"sap/m/List",
	"sap/m/StandardListItem",
	"sap/m/MessageStrip",
	"com/qdavy/procurement/model/Config"
], function (
	Controller, JSONModel, MessageBox, MessageToast,
	Dialog, DialogType, Button, ButtonType,
	TextArea, VBox, Label, Text,
	List, StandardListItem, MessageStrip,
	Config
) {
	"use strict";

	var BACKEND = Config.BACKEND;
	var REQUEST_TIMEOUT_MS = 15000;

	// 18/08/2026: man nay CHI con Purchasing (cua duyet 1 — duyet la tao PR that
	// tren SAP). CFO/CEO duyet DON HANG tren man PO-02 sau khi da co gia bao that.
	function isApproverRole(sRole) {
		return sRole === "PURCHASING";
	}

	return Controller.extend("com.qdavy.procurement.controller.pr.PR02", {

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
			this.getView().setModel(new JSONModel({
				pending: [],
				loading: false
			}));

			this.getOwnerComponent().getRouter()
				.getRoute("pr02")
				.attachPatternMatched(this._onRouteMatched, this);
		},

		_onRouteMatched: function () {
			var sRole = String(this.getOwnerComponent().getModel("user").getProperty("/role") || "").toUpperCase();
			if (sRole === "CFO" || sRole === "CEO") {
				// CFO/CEO gio duyet o cap DON HANG — dua thang sang PO-02.
				this.getOwnerComponent().getRouter().navTo("po02");
				return;
			}
			if (!isApproverRole(sRole)) {
				MessageBox.error("Bạn không có quyền truy cập màn này. Chỉ Bộ phận mua sắm (Purchasing).");
				this.getOwnerComponent().getRouter().navTo("dashboard");
				return;
			}
			this._loadPending();
		},

		_loadPending: function () {
			var oView = this.getView();
			var oModel = oView.getModel();
			var sRole = String(this.getOwnerComponent().getModel("user").getProperty("/role") || "").toUpperCase();

			if (!isApproverRole(sRole)) {
				return;
			}

			oModel.setProperty("/loading", true);
			oView.setBusy(true);

			this._fetchWithTimeout(BACKEND + "/api/approval/pending?role=" + encodeURIComponent(sRole))
				.then(function (oResult) {
					oView.setBusy(false);
					oModel.setProperty("/loading", false);

					if (!oResult || !oResult.success) {
						MessageBox.error((oResult && oResult.message) || "Không tải được danh sách đề nghị đang chờ duyệt.");
						return;
					}

					var aData = (oResult.data || []).sort(function (a, b) {
						var aScore = (a.needsProcurementHeadReview ? 2 : 0) + (a.needsLegalReview ? 1 : 0);
						var bScore = (b.needsProcurementHeadReview ? 2 : 0) + (b.needsLegalReview ? 1 : 0);
						if (bScore !== aScore) { return bScore - aScore; }
						// Cung muc uu tien thi don MOI nhat len tren — de nguoi duyet
						// khong phai keo xuong tan cuoi tim don vua gui.
						return new Date(b.CreatedAt || 0) - new Date(a.CreatedAt || 0);
					});

					// Giu ban day du de SearchField loc client-side (khong goi lai server)
					this._aAllPending = aData;
					this._applyPendingFilter();
				}.bind(this))
				.catch(function (oError) {
					oView.setBusy(false);
					oModel.setProperty("/loading", false);
					MessageBox.error(oError.message || "Không thể kết nối tới máy chủ.");
				});
		},

		onRefreshPress: function () {
			this._loadPending();
		},

		// ── TIM KIEM NHANH TRONG DANH SACH CHO DUYET ──
		// (feedback QDAVY 13/08: man kho phan biet cac don PR, nhieu don phai keo luot)
		onPendingSearch: function (oEvent) {
			this._sPendingQuery = (oEvent.getParameter("newValue") !== undefined
				? oEvent.getParameter("newValue")
				: oEvent.getParameter("query")) || "";
			this._applyPendingFilter();
		},

		_applyPendingFilter: function () {
			var aAll = this._aAllPending || [];
			var sQuery = (this._sPendingQuery || "").trim().toLowerCase();
			var aShown = aAll;

			if (sQuery) {
				aShown = aAll.filter(function (pr) {
					if (String(pr.PRId || "").toLowerCase().indexOf(sQuery) !== -1) { return true; }
					if (String(pr.SapPRId || "").toLowerCase().indexOf(sQuery) !== -1) { return true; }
					if (String(pr.RequesterEmail || "").toLowerCase().indexOf(sQuery) !== -1) { return true; }
					return (pr.items || []).some(function (it) {
						return String(it.Description || "").toLowerCase().indexOf(sQuery) !== -1
							|| String(it.MaterialNo || "").toLowerCase().indexOf(sQuery) !== -1;
					});
				});
			}

			this.getView().getModel().setProperty("/pending", aShown);
		},

		getPendingCount: function (aPending) {
			return aPending ? aPending.length : 0;
		},

		getProcurementHeadReviewCount: function (aPending) {
			if (!aPending) { return 0; }
			return aPending.filter(function (p) {
				return !!p.needsProcurementHeadReview;
			}).length;
		},

		getLegalReviewCount: function (aPending) {
			if (!aPending) { return 0; }
			return aPending.filter(function (p) {
				return !!p.needsLegalReview;
			}).length;
		},

		// ── FORMATTER CHO KHOI "CAN CU DUYET" ──
		// Tach thanh nhieu formatter nho thay vi nhoi vao expression binding: chuoi
		// tieng Viet co dau + so tien dinh dang vi-VN viet trong XML rat de vo.

		_money: function (nValue) {
			return (Number(nValue) || 0).toLocaleString("vi-VN");
		},

		formatBudgetHead: function (sCostCenter, sIO, nThreshold) {
			var s = "Bộ phận " + (sCostCenter || "—");
			if (sIO) { s += " · IO " + sIO; }
			if (nThreshold != null) {
				s += " · ngân sách " + this._money(nThreshold) + " VND";
			} else {
				s += " · chưa đặt ngưỡng ngân sách";
			}
			return s;
		},

		formatBudgetDetail: function (nCommitted, nThisRequest, nRemaining) {
			var s = "Đã cam kết từ các đề nghị đang chạy: " + this._money(nCommitted) + " VND";
			if (nRemaining != null) {
				s += " · còn lại " + this._money(nRemaining) + " VND";
			}
			s += " · đề nghị này " + this._money(nThisRequest) + " VND";
			return s;
		},

		formatBudgetAfter: function (nThreshold, nRemainingAfter) {
			if (nThreshold == null) {
				return "Chưa đặt ngưỡng cho bộ phận này — không kiểm soát được ngân sách";
			}
			if (nRemainingAfter < 0) {
				return "Duyệt đề nghị này sẽ VƯỢT ngân sách " + this._money(Math.abs(nRemainingAfter)) + " VND";
			}
			return "Duyệt xong còn lại " + this._money(nRemainingAfter) + " VND";
		},

		// Do = vuot ngan sach; vang = con duoi 20% (sap het); xanh = con thoai mai.
		formatBudgetState: function (nThreshold, nRemainingAfter) {
			if (nThreshold == null) { return "None"; }
			if (nRemainingAfter < 0) { return "Error"; }
			if (nRemainingAfter < Number(nThreshold) * 0.2) { return "Warning"; }
			return "Success";
		},

		formatDuplicate: function (sMaterialNo, sDisplayId, sCostCenter, nQuantity, sUoM, sStatus) {
			return (this.formatMatNo(sMaterialNo) || "?") + " — đề nghị " + (sDisplayId || "?")
				+ " (bộ phận " + (sCostCenter || "?") + ", "
				+ (Number(nQuantity) || 0) + " " + (sUoM || "") + ", "
				+ (sStatus || "") + ")";
		},

		formatValue: function (fValue, sCurrency) {
			if (fValue === undefined || fValue === null) { return ""; }
			return Number(fValue).toLocaleString("vi-VN") + " " + (sCurrency || "VND");
		},

		// Chu thich gia uoc tinh ban dau, chi hien voi PR da qua RFQ. Sau khi chot NCC
		// thi TotalValue = gia bao that, con EstimatedTotalValue giu gia luc lap PR —
		// CFO can thay ca hai de biet chenh lech bao nhieu so voi du toan.
		formatEstimateNote: function (fEstimated, sCurrency) {
			if (fEstimated === undefined || fEstimated === null || fEstimated === "") { return ""; }
			return "(ước tính ban đầu: "
				+ Number(fEstimated).toLocaleString("vi-VN") + " " + (sCurrency || "VND") + ")";
		},

		// dd-MM-yyyy HH:mm theo gio nguoi xem — truoc day view hien nguyen chuoi ISO
		// "2026-08-13T10:25:00.000Z" (feedback QDAVY 13/08: gio giac sai/kho doc).
		formatDateTime: function (sIso) {
			if (!sIso) { return ""; }
			var d = new Date(sIso);
			if (isNaN(d.getTime())) { return String(sIso); }
			var pad = function (n) { return String(n).padStart(2, "0"); };
			return pad(d.getHours()) + ":" + pad(d.getMinutes()) + " "
				+ pad(d.getDate()) + "-" + pad(d.getMonth() + 1) + "-" + d.getFullYear();
		},

		// ── DIALOG SO SANH BAO GIA CHO NGUOI DUYET (CFO/CEO) ──
		// Hien de xuat cua nhan vien (gia uoc tinh luc lap PR) canh tung bao gia NCC
		// tra ve, kem ly do Purchasing chot — nguoi duyet khong phai mo RFQ-02 (man
		// ho khong co quyen vao) de biet bang so sanh trong nhu the nao.
		onViewComparePress: function (oEvent) {
			var oPR = oEvent.getSource().getBindingContext().getObject();
			if (!oPR || !oPR.RfqId) {
				MessageBox.error("Đề nghị này không có RFQ để so sánh.");
				return;
			}
			var that = this;
			var oView = this.getView();
			oView.setBusy(true);

			this._fetchWithTimeout(BACKEND + "/api/rfq/" + encodeURIComponent(oPR.RfqId) + "/compare")
				.then(function (oResult) {
					oView.setBusy(false);
					if (!oResult || !oResult.success) {
						MessageBox.error((oResult && oResult.message) || "Không tải được bảng so sánh báo giá.");
						return;
					}
					that._openCompareDialog(oPR, oResult);
				})
				.catch(function (oError) {
					oView.setBusy(false);
					MessageBox.error(oError.message || "Không thể kết nối tới máy chủ.");
				});
		},

		_openCompareDialog: function (oPR, oResult) {
			var that = this;
			var aQuotes = oResult.quotations || [];
			var aPendingVendors = oResult.pendingVendors || [];
			var oRfq = oResult.rfq || {};

			var oContent = new VBox({ renderType: "Bare" }).addStyleClass("sapUiSmallMargin");

			// 1. De xuat cua nhan vien (can cu de doi chieu)
			oContent.addItem(new MessageStrip({
				text: "Đề xuất của nhân viên " + (oPR.RequesterEmail || "")
					+ ": giá trị ước tính " + this.formatValue(
						oPR.EstimatedTotalValue != null ? oPR.EstimatedTotalValue : oPR.TotalValue,
						oPR.Currency)
					+ ((oPR.items && oPR.items.length)
						? " — " + oPR.items.map(function (it) {
							return (it.Description || it.MaterialNo || "?") + " × " + it.Quantity + " " + (it.UoM || "");
						}).join(", ")
						: ""),
				type: "Information",
				showIcon: true
			}).addStyleClass("sapUiSmallMarginBottom"));

			// 2. Tung bao gia NCC tra ve (NCC thang danh dau ro)
			var oList = new List({ showSeparators: "Inner" });
			aQuotes.forEach(function (q) {
				var bAwarded = String(q.VendorNo) === String(oPR.RfqAwardedVendor)
					|| q.QuoteStatus === "AWARDED";
				oList.addItem(new StandardListItem({
					title: (q.VendorName || "NCC") + " (" + q.VendorNo + ")" + (bAwarded ? "  ✓ ĐÃ CHỐT" : ""),
					description: "Giá: " + Number(q.QuotedPrice || 0).toLocaleString("vi-VN") + " " + (q.Currency || "VND")
						+ " · Giao: " + (q.LeadTimeDays || 0) + " ngày"
						+ " · Thanh toán: " + (q.PaymentTermsLabel || q.PaymentTerms || "—")
						+ " · BH: " + (q.WarrantyMonths || 0) + " tháng"
						+ " · Pháp lý: " + (q.LegalDocsOk === "X" ? "đủ hồ sơ" : "THIẾU hồ sơ")
						+ (q.SourceNote ? " · Căn cứ: " + q.SourceNote : ""),
					icon: bAwarded ? "sap-icon://accept" : "sap-icon://supplier",
					infoState: bAwarded ? "Success" : "None",
					info: bAwarded ? "NCC thắng" : "",
					wrapping: true
				}));
			});
			oContent.addItem(oList);

			// 3. NCC duoc moi nhung khong gui bao gia + ly do chot
			if (aPendingVendors.length > 0) {
				oContent.addItem(new Text({
					text: "Không gửi báo giá: " + aPendingVendors.map(function (v) {
						return (v.VendorName || "") + " (" + v.VendorNo + ")";
					}).join(", ")
				}).addStyleClass("sapUiSmallMarginTop"));
			}
			if (oRfq.AwardReason || oPR.RfqAwardReason) {
				oContent.addItem(new Text({
					text: "Lý do Purchasing chọn: " + (oRfq.AwardReason || oPR.RfqAwardReason)
				}).addStyleClass("sapUiTinyMarginTop"));
			}

			var oDialog = new Dialog({
				title: "So sánh báo giá — " + oPR.RfqId,
				contentWidth: "42rem",
				content: [oContent],
				endButton: new Button({
					text: "Đóng",
					press: function () { oDialog.close(); }
				}),
				afterClose: function () { oDialog.destroy(); }
			});
			this.getView().addDependent(oDialog);
			oDialog.open();
		},

		onDetailPress: function (oEvent) {
			var oPR = oEvent.getSource().getBindingContext().getObject();
			if (!oPR || !oPR.PRId) {
				MessageBox.error("Không xác định được mã đề nghị.");
				return;
			}
			this.getOwnerComponent().getRouter().navTo("prdetail", {
				prId: oPR.PRId
			});
		},

		onApprovePress: function (oEvent) {
			var oPR = oEvent.getSource().getBindingContext().getObject();
			this._openDecisionDialog(oPR.PRId, oPR.TotalValue, oPR.Currency, "APPROVED");
		},

		onRejectPress: function (oEvent) {
			var oPR = oEvent.getSource().getBindingContext().getObject();
			this._openDecisionDialog(oPR.PRId, oPR.TotalValue, oPR.Currency, "REJECTED");
		},

		_openDecisionDialog: function (sPRId, nTotalValue, sCurrency, sStatus) {
			var that = this;
			var bIsApprove = sStatus === "APPROVED";

			var sRoleHint = bIsApprove
				? "\n\nSau khi duyệt, hệ thống TẠO PR THẬT trên SAP (tra được ở ME53N) và chuyển sang bước hỏi giá (RFQ-01)."
				: "\n\nTừ chối là KẾT THÚC đề nghị này — người tạo nhận lý do và có thể lập đề nghị mới (dữ liệu được điền sẵn).";

			var sAction = bIsApprove ? "PHÊ DUYỆT" : "TỪ CHỐI";
			var sSummary = "Đề nghị: " + sPRId
				+ "\nGiá trị: " + Number(nTotalValue).toLocaleString("vi-VN") + " " + (sCurrency || "VND")
				+ "\nHành động: " + sAction
				+ sRoleHint;

			var sReasonLabel = "Lý do từ chối (bắt buộc)";
			var oTextArea = new TextArea({
				width: "100%",
				rows: 3,
				maxLength: 255,
				placeholder: bIsApprove
					? "Ghi chú phê duyệt (tùy chọn)"
					: sReasonLabel
			});

			var oDialog = new Dialog({
				type: DialogType.Message,
				title: bIsApprove ? "Xác nhận phê duyệt" : "Xác nhận từ chối",
				content: [
					new VBox({
						items: [
							new Text({ text: sSummary, wrapping: true }).addStyleClass("sapUiSmallMarginBottom"),
							new Label({
								text: bIsApprove ? "Ghi chú (tùy chọn):" : sReasonLabel + ":",
								required: !bIsApprove
							}),
							oTextArea
						]
					})
				],
				beginButton: new Button({
					text: bIsApprove ? "Phê duyệt" : "Từ chối",
					type: bIsApprove ? ButtonType.Accept : ButtonType.Reject,
					press: function () {
						var sComment = oTextArea.getValue().trim();
						if (!bIsApprove && !sComment) {
							oTextArea.setValueState("Error");
							oTextArea.setValueStateText("Vui lòng nhập lý do từ chối.");
							return;
						}
						oDialog.close();
						that._submitDecision(sPRId, sStatus, sComment);
					}
				}),
				endButton: new Button({
					text: "Hủy",
					press: function () { oDialog.close(); }
				}),
				afterClose: function () { oDialog.destroy(); }
			});

			this.getView().addDependent(oDialog);
			oDialog.open();
		},

		_submitDecision: function (sPRId, sStatus, sComment) {
			var oView = this.getView();
			var oUser = this.getOwnerComponent().getModel("user").getData();
			var sRole = String(oUser.role || "").toUpperCase();

			if (!isApproverRole(sRole)) {
				MessageBox.error("Bạn không có quyền phê duyệt đề nghị mua sắm.");
				return;
			}

			oView.setBusy(true);

			this._fetchWithTimeout(BACKEND + "/api/approval/" + encodeURIComponent(sPRId), {
				method: "PATCH",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					status: sStatus,
					comment: sComment,
					decidedByEmail: oUser.email,
					decidedByRole: sRole
				})
			})
				.then(function (oResult) {
					oView.setBusy(false);

					if (!oResult || !oResult.success) {
						MessageBox.error((oResult && oResult.message) || "Không cập nhật được trạng thái. Vui lòng thử lại.");
						return;
					}

					var sMsg;
					if (sStatus === "APPROVED" && oResult.sapPrNumber) {
						// Duyet = da TAO PR THAT tren SAP ngay tai buoc nay (ME51N).
						sMsg = "Đã duyệt " + sPRId + ".\n"
							+ "Đã tạo PR trên SAP — số PR: " + oResult.sapPrNumber + " (tra cứu ME53N).\n"
							+ "Tiếp theo: tạo RFQ hỏi giá nhà cung cấp trên màn RFQ-01.";
						MessageBox.success(sMsg, { title: "Đã duyệt — PR " + oResult.sapPrNumber });
					} else if (sStatus === "APPROVED") {
						MessageToast.show("Đã phê duyệt " + sPRId + ".", { duration: 4000 });
					} else {
						MessageBox.warning(
							"Đã từ chối " + sPRId + ".\nNgười tạo đã được thông báo kèm lý do, có thể lập đề nghị mới.",
							{ title: "Đã từ chối" }
						);
					}

					var fnKeep = function (pr) {
						return pr.PRId !== sPRId
							&& pr.InternalId !== sPRId
							&& !(oResult.approval && pr.PRId === oResult.approval.PRId);
					};
					// Loc ca ban day du (nguon cua SearchField) lan ban dang hien
					this._aAllPending = (this._aAllPending || []).filter(fnKeep);
					this._applyPendingFilter();
				}.bind(this))
				.catch(function (oError) {
					oView.setBusy(false);
					MessageBox.error(oError.message || "Không thể kết nối tới máy chủ.");
				});
		},

		onNavBack: function () {
			this.getOwnerComponent().getRouter().navTo("dashboard");
		},

		_fetchWithTimeout: function (sUrl, oOptions) {
			var oAbort = (typeof AbortController !== "undefined") ? new AbortController() : null;
			var iTimer = oAbort
				? setTimeout(function () { oAbort.abort(); }, REQUEST_TIMEOUT_MS)
				: null;

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
								throw new Error((oBody && oBody.message) || "Máy chủ đang gặp sự cố. Vui lòng thử lại sau.");
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
						throw new Error("Không thể kết nối tới máy chủ. Vui lòng kiểm tra server đang chạy.");
					}
					throw oError;
				});
		}
	});
});