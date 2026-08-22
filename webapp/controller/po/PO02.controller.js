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
	"com/qdavy/procurement/model/Config",
	"com/qdavy/procurement/model/Msg"
], function (
	Controller, JSONModel, MessageBox, MessageToast,
	Dialog, DialogType, Button, ButtonType,
	TextArea, VBox, Label, Text,
	Config, Msg
) {
	"use strict";

	var BACKEND = Config.BACKEND;
	var REQUEST_TIMEOUT_MS = 15000;

	/**
	 * PO-02 — CFO/CEO DUYET DE NGHI MUA SAM (21/08/2026, buoc 9-11 so do TO-BE).
	 *
	 * Purchasing da duyet nhu cau va tao PR that o PR-02, da hoi gia va chot NCC
	 * o RFQ-02. Toi day gia da la GIA THAT nen CFO doi chieu voi du toan roi
	 * quyet; vuot nguong IO thi chuyen tiep CEO. Duyet xong Purchasing moi vao
	 * PO-01 tao don hang — CHUA co PO nao ton tai o man nay, nen tu choi la dong
	 * de nghi lai, khong de lai chung tu mo coi tren SAP.
	 */
	return Controller.extend("com.qdavy.procurement.controller.po.PO02", {

		onInit: function () {
			this.getView().setModel(new JSONModel({
				pending: [],
				pageEyebrow: "Phê duyệt · Đề nghị mua sắm",
				loading: false
			}));

			this.getOwnerComponent().getRouter()
				.getRoute("po02")
				.attachPatternMatched(this._onRouteMatched, this);
		},

		_onRouteMatched: function () {
			var sRole = String(this.getOwnerComponent().getModel("user").getProperty("/role") || "").toUpperCase();
			if (sRole !== "CFO" && sRole !== "CEO") {
				MessageBox.error("Chỉ CFO hoặc CEO được phép duyệt đề nghị ở bước này.");
				this.getOwnerComponent().getRouter().navTo("dashboard");
				return;
			}
			this.getView().getModel().setProperty(
				"/pageEyebrow",
				sRole === "CEO" ? "Phê duyệt · CEO duyệt đề nghị vượt hạn mức" : "Phê duyệt · CFO duyệt đề nghị"
			);
			this._loadPending();
		},

		_loadPending: function () {
			var oView = this.getView();
			var oModel = oView.getModel();
			var sRole = String(this.getOwnerComponent().getModel("user").getProperty("/role") || "").toUpperCase();
			if (sRole !== "CFO" && sRole !== "CEO") { return; }

			oModel.setProperty("/loading", true);
			oView.setBusy(true);

			this._fetchWithTimeout(BACKEND + "/api/pr-approval/pending?role=" + encodeURIComponent(sRole))
				.then(function (oResult) {
					oView.setBusy(false);
					oModel.setProperty("/loading", false);
					if (!oResult || !oResult.success) {
						MessageBox.error((oResult && oResult.message) || "Không tải được danh sách đề nghị chờ duyệt. Vui lòng thử lại.");
						return;
					}
					var aData = (oResult.data || []).sort(function (a, b) {
						return new Date(b.UpdatedAt || 0) - new Date(a.UpdatedAt || 0);
					});
					oModel.setProperty("/pending", aData);
				})
				.catch(function (oError) {
					oView.setBusy(false);
					oModel.setProperty("/loading", false);
					MessageBox.error(oError.message || "Không thể kết nối tới máy chủ. Vui lòng thử lại.");
				});
		},

		// onRefreshPress da XOA 21/08/2026 cung luc bo nut "Tải lại". Du lieu van
		// duoc nap lai moi lan vao man; tai lai bang F5 cung khong con mat phien.

		onDetailPress: function (oEvent) {
			var oPR = oEvent.getSource().getBindingContext().getObject();
			if (!oPR || !oPR.PRId) { return; }
			this.getOwnerComponent().getRouter().navTo("prdetail", { prId: oPR.PRId });
		},

		onApprovePress: function (oEvent) {
			var oPR = oEvent.getSource().getBindingContext().getObject();
			this._openDecisionDialog(oPR, "APPROVED");
		},

		onRejectPress: function (oEvent) {
			var oPR = oEvent.getSource().getBindingContext().getObject();
			this._openDecisionDialog(oPR, "REJECTED");
		},

		_openDecisionDialog: function (oPR, sAction) {
			var that = this;
			var bIsApprove = sAction === "APPROVED";
			var sRole = String(this.getOwnerComponent().getModel("user").getProperty("/role") || "").toUpperCase();
			var bWillEscalate = bIsApprove && sRole === "CFO" && !!oPR.needsProcurementHeadReview;

			var aVendors = (oPR.AwardGroups || [])
				.map(function (g) { return g.AwardedVendorName || g.AwardedVendor; })
				.filter(Boolean);

			var sHint;
			if (bWillEscalate) {
				sHint = "\n\nĐề nghị này vượt hạn mức ngân sách nên sau khi bạn duyệt sẽ được chuyển tiếp lên CEO. Chưa có đơn hàng nào được tạo.";
			} else if (bIsApprove) {
				sHint = "\n\nDuyệt xong, Phòng Mua sắm sẽ tạo đơn hàng trên SAP và hệ thống gửi email cho nhà cung cấp.";
			} else {
				sHint = "\n\nNếu từ chối, đề nghị kết thúc tại đây. Chưa có đơn hàng nào được tạo nên không phát sinh xử lý trên SAP.";
			}

			var sSummary = "PR: " + (oPR.DisplayId || oPR.PRId)
				+ (aVendors.length ? "\nNhà cung cấp: " + aVendors.join(", ") : "")
				+ "\nGiá ước tính: " + this.formatValue(oPR.EstimatedTotalValue != null ? oPR.EstimatedTotalValue : oPR.TotalValue, oPR.Currency)
				+ "\nGiá chốt: " + this.formatValue(oPR.TotalValue, oPR.Currency)
				+ " (" + this.formatDiff(oPR.EstimatedTotalValue, oPR.TotalValue) + ")"
				+ sHint;

			var oTextArea = new TextArea({
				width: "100%",
				rows: 3,
				maxLength: 255,
				placeholder: bIsApprove ? "Ghi chú duyệt (tùy chọn)" : "Lý do từ chối (bắt buộc)"
			});

			var oDialog = new Dialog({
				type: DialogType.Message,
				title: bIsApprove
					? (bWillEscalate ? "Duyệt — sẽ chuyển CEO" : "Xác nhận phê duyệt đề nghị")
					: "Xác nhận từ chối đề nghị",
				content: [
					new VBox({
						items: [
							new Text({ text: sSummary, wrapping: true }).addStyleClass("sapUiSmallMarginBottom"),
							new Label({
								text: bIsApprove ? "Ghi chú (tùy chọn):" : "Lý do từ chối (bắt buộc):",
								required: !bIsApprove
							}),
							oTextArea
						]
					})
				],
				beginButton: new Button({
					text: bIsApprove ? (bWillEscalate ? "Duyệt & chuyển CEO" : "Duyệt đề nghị") : "Từ chối",
					type: bIsApprove ? ButtonType.Accept : ButtonType.Reject,
					press: function () {
						var sComment = oTextArea.getValue().trim();
						if (!bIsApprove && !sComment) {
							oTextArea.setValueState("Error");
							oTextArea.setValueStateText("Vui lòng nhập lý do từ chối.");
							return;
						}
						oDialog.close();
						that._submitDecision(oPR, sAction, sComment);
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

		_submitDecision: function (oPR, sAction, sComment) {
			var oView = this.getView();
			var oUser = this.getOwnerComponent().getModel("user").getData() || {};
			var sRole = String(oUser.role || "").toUpperCase();

			oView.setBusy(true);

			this._fetchWithTimeout(BACKEND + "/api/pr-approval/" + encodeURIComponent(oPR.PRId), {
				method: "PATCH",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					action: sAction,
					comment: sComment,
					decidedByEmail: oUser.email,
					decidedByRole: sRole
				})
			})
				.then(function (oResult) {
					oView.setBusy(false);
					if (!oResult || !oResult.success) {
						Msg.fail(oResult, {
							title: "Không cập nhật được đề nghị",
							fallback: "Không cập nhật được trạng thái đề nghị. Đề nghị vẫn ở trạng thái chờ duyệt, vui lòng thử lại."
						});
						return;
					}

					if (oResult.escalated) {
						MessageBox.information(
							"Đề nghị " + oPR.PRId + " đã được chuyển lên CEO phê duyệt.\n"
							+ (oResult.reason || "Giá trị vượt ngưỡng phê duyệt của CFO.")
							+ "\nChưa có đơn hàng nào được tạo.",
							{ title: "Đã chuyển CEO" }
						);
					} else if (sAction === "APPROVED") {
						MessageBox.success(
							"Đã phê duyệt đề nghị " + oPR.PRId + "."
							+ "\nPhòng Mua sắm đã nhận được thông báo để tạo đơn hàng ở màn hình PO-01.",
							{ title: "Đã phê duyệt" }
						);
					} else {
						MessageBox.warning(
							"Đã từ chối đề nghị " + oPR.PRId
							+ ".\nChưa có đơn hàng nào được tạo. Phòng Mua sắm đã nhận được thông báo.",
							{ title: "Đã từ chối" }
						);
					}
					this._loadPending();
				}.bind(this))
				.catch(function (oError) {
					oView.setBusy(false);
					MessageBox.error(oError.message || "Không thể kết nối tới máy chủ. Vui lòng thử lại.");
				});
		},

		// ── FORMATTERS ──

		// ── FORMATTER CHO KHOI "CAN CU CHOT GIA" ──
		// Nguon so lieu: Evidence do decision-context.service dung tu ZG1_QUOTATION.

		_money: function (nValue) {
			return (Number(nValue) || 0).toLocaleString("vi-VN");
		},

		formatCompetition: function (nInvited, nReceived) {
			return "Mời " + (Number(nInvited) || 0) + " nhà cung cấp · nhận được "
				+ (Number(nReceived) || 0) + " báo giá";
		},

		formatPriceRange: function (nLowest, nHighest, nChosen) {
			if (!Number(nChosen)) { return "Chưa đọc được giá của nhà cung cấp được chọn."; }
			// Chi 1 bao gia thi "thap nhat X · da chon X" doc rat vo nghia (2 con so
			// giong het nhau) — noi thang la gia bao nhieu.
			if (!Number(nHighest) || Number(nHighest) === Number(nLowest)) {
				if (Number(nLowest) === Number(nChosen)) {
					return "Giá đã báo: " + this._money(nChosen) + " VND";
				}
			}
			return "Báo giá thấp nhất " + this._money(nLowest) + " VND · cao nhất "
				+ this._money(nHighest) + " VND · đã chọn " + this._money(nChosen) + " VND";
		},

		// Ba ket cuc: chi co 1 bao gia (khong co gi de so), chon gia cao hon gia thap
		// nhat (phai giai trinh), hoac chon dung gia thap nhat (khong con gi de hoi).
		//
		// 21/08/2026 sua chu: ban cu viet "cần lý do chỉ định thầu" — CFO doc tuong la
		// HE THONG DANG THIEU ly do, trong khi ly do da bat buoc nhap tu luc chot NCC
		// (rfq.routes.js chan 400 neu thieu) va dang hien ngay ben duoi. Cau moi chi
		// NEU SU THAT, khong doi hoi them viec.
		formatPriceVerdict: function (bIsLowest, nExtra, bSingle) {
			if (bSingle) {
				return "Chỉ nhận được 1 báo giá — không có giá khác để so sánh";
			}
			if (bIsLowest) { return "Đã chọn báo giá thấp nhất"; }
			return "Không chọn báo giá thấp nhất — chọn cao hơn " + this._money(nExtra)
				+ " VND, xem lý do bên dưới";
		},

		// Mau: chi 1 bao gia la dieu CAN LUU Y (vang), khong phai LOI (do) — ly do chi
		// dinh thau da co san, khong co gi hong ca.
		formatPriceVerdictState: function (bIsLowest, nExtra, bSingle) {
			if (bSingle) { return "Warning"; }
			return bIsLowest ? "Success" : "Warning";
		},

		// ── LY DO CHOT NCC ──
		// Backend ghep 2 ly do vao MOT chuoi khi chi co 1 bao gia:
		//   "[SOLE SOURCE] <ly do chi dinh thau> | <ly do chon NCC>"
		// (xem rfq.routes.js). Truoc day man nay in nguyen chuoi do ra man hinh nen
		// CFO doc thay "Lý do chọn: [SOLE SOURCE] oke | oke" — dau ngoac vuong va dau
		// gach dung la ky hieu noi bo, khong phai thu de nguoi dung doc. Tach lam 2
		// dong co nhan rieng.
		_splitAwardReason: function (sReason) {
			var s = String(sReason || "").trim();
			var m = /^\[SOLE SOURCE\]\s*([\s\S]*?)\s*\|\s*([\s\S]*)$/.exec(s);
			if (m) { return { sole: m[1].trim(), pick: m[2].trim() }; }
			return { sole: "", pick: s };
		},

		hasSoleSourceReason: function (sReason) {
			return !!this._splitAwardReason(sReason).sole;
		},

		formatSoleSourceReason: function (sReason) {
			var o = this._splitAwardReason(sReason);
			return o.sole ? ("Lý do chỉ định 1 nhà cung cấp: " + o.sole) : "";
		},

		formatAwardReason: function (sReason) {
			var o = this._splitAwardReason(sReason);
			return "Lý do chọn nhà cung cấp này: " + (o.pick || "(chưa ghi)");
		},

		formatVendorTerms: function (bLegalOk, sPaymentTerms, nLeadTime, nWarranty) {
			var a = [];
			a.push("Hồ sơ pháp lý: " + (bLegalOk ? "đủ" : "chưa đủ"));
			if (sPaymentTerms) { a.push("Thanh toán: " + sPaymentTerms); }
			if (Number(nLeadTime) > 0) { a.push("Giao trong " + nLeadTime + " ngày"); }
			if (Number(nWarranty) > 0) { a.push("Bảo hành " + nWarranty + " tháng"); }
			return a.join(" · ");
		},
		formatValue: function (fValue, sCurrency) {
			if (fValue === undefined || fValue === null || fValue === "") { return "—"; }
			return Number(fValue).toLocaleString("vi-VN") + " " + (sCurrency || "VND");
		},

		// Lech giua gia uoc tinh luc lap de nghi va gia chot sau bao gia.
		//
		// 21/08/2026 sua chu: ban cu tra ve "+3,6% so với dự toán" — hai van de.
		// (1) Nhan cot ben tren viet "Giá ước tính ban đầu" nhung cau nay lai goi la
		//     "dự toán" -> nguoi doc tuong la hai con so khac nhau.
		// (2) Chi co % ma khong co so tien: CFO duyet TIEN, "+3,6%" khong tra loi duoc
		//     cau hoi "dat hon bao nhieu".
		formatDiff: function (fEstimated, fFinal) {
			var nEst = Number(fEstimated);
			var nFin = Number(fFinal);
			if (!nEst || isNaN(nEst) || isNaN(nFin)) { return "Không có giá ước tính để so sánh"; }
			var nGap = nFin - nEst;
			if (nGap === 0) { return "Bằng đúng giá ước tính"; }
			var nPct = Math.abs((nGap / nEst) * 100).toFixed(1).replace(".", ",");
			return (nGap > 0 ? "Cao hơn giá ước tính " : "Thấp hơn giá ước tính ")
				+ this._money(Math.abs(nGap)) + " VND (" + (nGap > 0 ? "+" : "−") + nPct + "%)";
		},

		formatDiffState: function (fEstimated, fFinal) {
			var nEst = Number(fEstimated);
			var nFin = Number(fFinal);
			if (!nEst || isNaN(nEst) || isNaN(nFin)) { return "None"; }
			var nPct = ((nFin - nEst) / nEst) * 100;
			if (nPct > 10) { return "Error"; }
			if (nPct > 0) { return "Warning"; }
			return "Success";
		},

		formatDateTime: function (sIso) {
			if (!sIso) { return ""; }
			var d = new Date(sIso);
			if (isNaN(d.getTime())) { return String(sIso); }
			var pad = function (n) { return String(n).padStart(2, "0"); };
			return pad(d.getHours()) + ":" + pad(d.getMinutes()) + " "
				+ pad(d.getDate()) + "-" + pad(d.getMonth() + 1) + "-" + d.getFullYear();
		},

		onNavBack: function () {
			this.getOwnerComponent().getRouter().navTo("dashboard");
		},

		_fetchWithTimeout: function (sUrl, oOptions) {
			var oAbort = (typeof AbortController !== "undefined") ? new AbortController() : null;
			var iTimer = oAbort ? setTimeout(function () { oAbort.abort(); }, REQUEST_TIMEOUT_MS) : null;

			return fetch(sUrl, Object.assign({}, oOptions || {}, {
				signal: oAbort ? oAbort.signal : undefined
			}))
				.then(function (oResponse) {
					if (iTimer) { clearTimeout(iTimer); }
					return oResponse.json()
						.catch(function () { return {}; })
						.then(function (oBody) {
							if (oResponse.status === 401 || oResponse.status === 403) {
								throw new Error((oBody && oBody.message) || "Bạn không có quyền thực hiện thao tác này.");
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
						throw new Error("Máy chủ phản hồi quá lâu. Vui lòng kiểm tra mạng rồi thử lại.");
					}
					if (oError instanceof TypeError) {
						throw new Error("Không thể kết nối tới máy chủ. Vui lòng thử lại.");
					}
					throw oError;
				});
		}
	});
});
