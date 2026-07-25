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

	return Controller.extend("com.qdavy.procurement.controller.PR02", {

		// ── Lifecycle ────────────────────────────────────────────────────────

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
			var sRole = this.getOwnerComponent().getModel("user").getProperty("/role");
			if (sRole === "REQUESTER") {
				MessageBox.error("Bạn không có quyền truy cập màn phê duyệt. Chỉ Trưởng bộ phận mua sắm hoặc CEO mới có thể phê duyệt.");
				this.getOwnerComponent().getRouter().navTo("dashboard");
				return;
			}
			this._loadPending();
		},

		// ── Data loading ─────────────────────────────────────────────────────

		_loadPending: function () {
			var oView  = this.getView();
			var oModel = oView.getModel();

			oModel.setProperty("/loading", true);
			oView.setBusy(true);

			this._fetchWithTimeout(BACKEND + "/api/approval/pending")
				.then(function (oResult) {
					oView.setBusy(false);
					oModel.setProperty("/loading", false);

					if (!oResult || !oResult.success) {
						MessageBox.error((oResult && oResult.message) || "Không tải được danh sách đề nghị mua sắm đang chờ duyệt.");
						return;
					}

					// Sắp xếp: PR leo thang lên trước
					var aData = (oResult.data || []).sort(function (a, b) {
						var aScore = (a.needsProcurementHeadReview ? 2 : 0) + (a.needsLegalReview ? 1 : 0);
						var bScore = (b.needsProcurementHeadReview ? 2 : 0) + (b.needsLegalReview ? 1 : 0);
						return bScore - aScore;
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

		// ── Formatters ────────────────────────────────────────────────────────

		getPendingCount: function(aPending) {
			return aPending ? aPending.length : 0;
		},

		getProcurementHeadReviewCount: function(aPending) {
			if (!aPending) return 0;
			return aPending.filter(function(p) {
				return !!p.needsProcurementHeadReview;
			}).length;
		},

		getLegalReviewCount: function(aPending) {
			if (!aPending) return 0;
			return aPending.filter(function(p) {
				return !!p.needsLegalReview;
			}).length;
		},

		formatValue: function (fValue, sCurrency) {
			if (fValue === undefined || fValue === null) { return ""; }
			return Number(fValue).toLocaleString("vi-VN") + " " + (sCurrency || "VND");
		},

		// ── Decision dialog ───────────────────────────────────────────────────

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

			var sSummary = "PR: " + sPRId
				+ "\nGiá trị: " + Number(nTotalValue).toLocaleString("vi-VN") + " " + (sCurrency || "VND")
				+ "\nHành động: " + (bIsApprove ? "PHÊ DUYỆT" : "TỪ CHỐI");

			var oTextArea = new TextArea({
				id: "decisionComment",
				width: "100%",
				rows: 3,
				maxLength: 255,
				placeholder: bIsApprove
					? "Ghi chú phê duyệt (tùy chọn)"
					: "Lý do từ chối (bắt buộc)"
			});

			var oDialog = new Dialog({
				type: bIsApprove ? DialogType.Message : DialogType.Message,
				title: bIsApprove ? "Xác nhận phê duyệt" : "Xác nhận từ chối",
				content: [
					new VBox({
						items: [
							new Text({ text: sSummary, wrapping: true }).addStyleClass("sapUiSmallMarginBottom"),
							new Label({ text: bIsApprove ? "Ghi chú (tùy chọn):" : "Lý do từ chối (bắt buộc):", required: !bIsApprove }),
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

		// ── Submit decision ───────────────────────────────────────────────────

		_submitDecision: function (sPRId, sStatus, sComment) {
			var oView  = this.getView();
			var oUser  = this.getOwnerComponent().getModel("user").getData();

			var sRole = oUser.role;
			if (!sRole || sRole === "REQUESTER") {
				MessageBox.error("Bạn không có quyền phê duyệt đề nghị mua sắm.");
				return;
			}

			oView.setBusy(true);

			this._fetchWithTimeout(BACKEND + "/api/approval/" + encodeURIComponent(sPRId), {
				method: "PATCH",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					status:          sStatus,
					comment:         sComment,
					decidedByEmail:  oUser.email,
					decidedByRole:   oUser.role
				})
			})
				.then(function (oResult) {
					oView.setBusy(false);

					if (!oResult || !oResult.success) {
						MessageBox.error((oResult && oResult.message) || "Không cập nhật được trạng thái. Vui lòng thử lại.");
						return;
					}

					var sMsg = sStatus === "APPROVED"
						? "Đã phê duyệt " + sPRId + ". Bộ phận mua sắm sẽ tiến hành tạo PO."
						: "Đã từ chối " + sPRId + ". Người đề nghị sẽ nhận được thông báo.";

					if (oResult.sapStatus === "released") {
						sMsg += "\nPR đã được Release trong SAP (ME53N: " + sPRId + ").";
					}

					MessageToast.show(sMsg, { duration: 3000 });

					// Optimistic UI update
					var oModel  = oView.getModel();
					var aFiltered = (oModel.getProperty("/pending") || [])
						.filter(function (pr) { return pr.PRId !== sPRId; });
					oModel.setProperty("/pending", aFiltered);

				}.bind(this))
				.catch(function (oError) {
					oView.setBusy(false);
					MessageBox.error(oError.message || "Không thể kết nối tới máy chủ.");
				});
		},

		// ── Navigation ────────────────────────────────────────────────────────

		onNavBack: function () {
			this.getOwnerComponent().getRouter().navTo("dashboard");
		},

		// ── Fetch với timeout ─────────────────────────────────────────────────

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
								throw new Error("Máy chủ đang gặp sự cố. Vui lòng thử lại sau.");
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