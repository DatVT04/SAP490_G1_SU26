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
	"com/qdavy/procurement/model/Config"
], function (
	Controller, JSONModel, MessageBox, MessageToast,
	Dialog, DialogType, Button, ButtonType,
	TextArea, VBox, Label, Text,
	Config
) {
	"use strict";

	var BACKEND = Config.BACKEND;
	var REQUEST_TIMEOUT_MS = 15000;

	/**
	 * PO-02 — CUA DUYET 2 (18/08/2026, mo phong PO Release ME29N).
	 *
	 * "PR duyet nhu cau, PO duyet tien": Purchasing da duyet nhu cau va tao PR
	 * that o PR-02; toi day PO da duoc tao that tren SAP (PO-01) nhung CHUA gui
	 * cho NCC. CFO xem gia chot so voi du toan roi moi release — duyet xong he
	 * thong moi gui mail don hang. Vuot nguong IO thi CFO chuyen tiep CEO.
	 */
	return Controller.extend("com.qdavy.procurement.controller.po.PO02", {

		onInit: function () {
			this.getView().setModel(new JSONModel({
				pending: [],
				pageEyebrow: "Bước cuối · Duyệt đơn hàng",
				loading: false
			}));

			this.getOwnerComponent().getRouter()
				.getRoute("po02")
				.attachPatternMatched(this._onRouteMatched, this);
		},

		_onRouteMatched: function () {
			var sRole = String(this.getOwnerComponent().getModel("user").getProperty("/role") || "").toUpperCase();
			if (sRole !== "CFO" && sRole !== "CEO") {
				MessageBox.error("Chỉ CFO hoặc CEO được duyệt đơn hàng.");
				this.getOwnerComponent().getRouter().navTo("dashboard");
				return;
			}
			this.getView().getModel().setProperty(
				"/pageEyebrow",
				sRole === "CEO" ? "Bước cuối · CEO duyệt đơn vượt ngưỡng" : "Bước cuối · CFO duyệt đơn hàng"
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

			this._fetchWithTimeout(BACKEND + "/api/po/pending-approval?role=" + encodeURIComponent(sRole))
				.then(function (oResult) {
					oView.setBusy(false);
					oModel.setProperty("/loading", false);
					if (!oResult || !oResult.success) {
						MessageBox.error((oResult && oResult.message) || "Không tải được danh sách đơn hàng chờ duyệt.");
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
					MessageBox.error(oError.message || "Không thể kết nối tới máy chủ.");
				});
		},

		onRefreshPress: function () {
			this._loadPending();
		},

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

			var aPoNums = (oPR.PoGroups || [])
				.map(function (g) { return g.PoNumber; })
				.filter(Boolean);

			var sHint;
			if (bWillEscalate) {
				sHint = "\n\nĐơn này VƯỢT NGƯỠNG Internal Order — duyệt của bạn sẽ CHUYỂN TIẾP lên CEO, chưa gửi gì cho NCC.";
			} else if (bIsApprove) {
				sHint = "\n\nDuyệt xong hệ thống GỬI EMAIL đơn hàng cho nhà cung cấp ngay.";
			} else {
				sHint = "\n\nTừ chối: PO KHÔNG được gửi cho NCC. Purchasing sẽ chọn lại nhà cung cấp hoặc điều chỉnh rồi tạo PO mới.";
			}

			var sSummary = "PR: " + (oPR.DisplayId || oPR.PRId)
				+ (aPoNums.length ? "\nPO: " + aPoNums.join(", ") : "")
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
					? (bWillEscalate ? "Duyệt — sẽ chuyển CEO" : "Xác nhận duyệt & gửi NCC")
					: "Xác nhận từ chối đơn hàng",
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
					text: bIsApprove ? (bWillEscalate ? "Duyệt & chuyển CEO" : "Duyệt & gửi NCC") : "Từ chối",
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

			this._fetchWithTimeout(BACKEND + "/api/po/" + encodeURIComponent(oPR.PRId) + "/approval", {
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
						MessageBox.error((oResult && oResult.message) || "Không cập nhật được. Vui lòng thử lại.");
						return;
					}

					if (oResult.escalated) {
						MessageBox.information(
							"PR " + oPR.PRId + " đã chuyển lên CEO.\n"
							+ (oResult.reason || "Vượt ngưỡng IO — cần CEO duyệt.")
							+ "\nChưa gửi gì cho nhà cung cấp.",
							{ title: "Đã chuyển CEO" }
						);
					} else if (sAction === "APPROVED") {
						var aReleased = oResult.released || [];
						var aPoNums = aReleased.map(function (r) { return r.poNumber; }).filter(Boolean);
						var iSent = Number(oResult.emailsSent) || 0;
						var sMailLine = iSent >= aReleased.length && aReleased.length > 0
							? "Đã gửi email đơn hàng cho nhà cung cấp."
							: "Lưu ý: " + (aReleased.length - iSent) + "/" + aReleased.length
								+ " email chưa gửi được (kiểm tra email NCC trong master rồi gửi lại thủ công).";
						MessageBox.success(
							"Đã duyệt đơn hàng của PR " + oPR.PRId + "."
							+ (aPoNums.length ? "\nPO: " + aPoNums.join(", ") : "")
							+ "\n" + sMailLine,
							{ title: "PO đã duyệt" }
						);
					} else {
						MessageBox.warning(
							"Đã từ chối đơn hàng của PR " + oPR.PRId
							+ ".\nPO không được gửi cho NCC. Purchasing đã được thông báo để xử lý lại.",
							{ title: "Đã từ chối" }
						);
					}
					this._loadPending();
				}.bind(this))
				.catch(function (oError) {
					oView.setBusy(false);
					MessageBox.error(oError.message || "Không thể kết nối tới máy chủ.");
				});
		},

		// ── FORMATTERS ──

		formatValue: function (fValue, sCurrency) {
			if (fValue === undefined || fValue === null || fValue === "") { return "—"; }
			return Number(fValue).toLocaleString("vi-VN") + " " + (sCurrency || "VND");
		},

		// "% lech gia uoc tinh vs gia chot" — con so giup CFO phat hien NCC het gia.
		formatDiff: function (fEstimated, fFinal) {
			var nEst = Number(fEstimated);
			var nFin = Number(fFinal);
			if (!nEst || isNaN(nEst) || isNaN(nFin)) { return "không có dự toán để so"; }
			var nPct = ((nFin - nEst) / nEst) * 100;
			var sSign = nPct > 0 ? "+" : "";
			return sSign + nPct.toFixed(1).replace(".", ",") + "% so với dự toán";
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
						throw new Error("Server phản hồi quá lâu. Vui lòng kiểm tra mạng và thử lại.");
					}
					if (oError instanceof TypeError) {
						throw new Error("Không thể kết nối tới máy chủ.");
					}
					throw oError;
				});
		}
	});
});
