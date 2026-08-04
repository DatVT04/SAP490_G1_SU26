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

	function isApproverRole(sRole) {
		return sRole === "PURCHASING" || sRole === "CFO" || sRole === "CEO";
	}

	return Controller.extend("com.qdavy.procurement.controller.PR02", {

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
			if (!isApproverRole(sRole)) {
				MessageBox.error("Bạn không có quyền truy cập màn phê duyệt. Chỉ Purchasing, CFO hoặc CEO.");
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

		formatValue: function (fValue, sCurrency) {
			if (fValue === undefined || fValue === null) { return ""; }
			return Number(fValue).toLocaleString("vi-VN") + " " + (sCurrency || "VND");
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
			var sRole = String(this.getOwnerComponent().getModel("user").getProperty("/role") || "").toUpperCase();

			var sRoleHint = "";
			if (bIsApprove && sRole === "PURCHASING") {
				sRoleHint = "\n\nSau khi bạn duyệt, đề nghị sẽ chuyển sang CFO (chưa ghi SAP).";
			} else if (bIsApprove && sRole === "CFO") {
				sRoleHint = "\n\n≤ ngưỡng Internal Order: ghi SAP ngay. Vượt ngưỡng IO: chuyển CEO.";
			} else if (bIsApprove && sRole === "CEO") {
				sRoleHint = "\n\nDuyệt cuối → hệ thống ghi PR lên SAP và cấp số PR thật.";
			}

			var sSummary = "PR: " + sPRId
				+ "\nGiá trị: " + Number(nTotalValue).toLocaleString("vi-VN") + " " + (sCurrency || "VND")
				+ "\nHành động: " + (bIsApprove ? "PHÊ DUYỆT" : "TỪ CHỐI")
				+ sRoleHint;

			var oTextArea = new TextArea({
				width: "100%",
				rows: 3,
				maxLength: 255,
				placeholder: bIsApprove
					? "Ghi chú phê duyệt (tùy chọn)"
					: "Lý do từ chối (bắt buộc)"
			});

			var oDialog = new Dialog({
				type: DialogType.Message,
				title: bIsApprove ? "Xác nhận phê duyệt" : "Xác nhận từ chối",
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
					if (oResult.forwarded === "CFO") {
						sMsg = sPRId + " đã chuyển sang CFO.\nNgười tạo và CFO đã được thông báo. Chưa ghi SAP.";
						MessageBox.information(sMsg, { title: "Đã chuyển CFO" });
					} else if (oResult.escalated) {
						sMsg = sPRId + " đã chuyển lên CEO.\n"
							+ (oResult.reason || "Vượt ngưỡng — cần CEO.")
							+ "\nNgười tạo và CEO đã được thông báo. Chưa ghi SAP.";
						MessageBox.information(sMsg, { title: "Leo thang CEO" });
					} else if (sStatus === "APPROVED") {
						if (oResult.sapIntegration === "created" && oResult.sapPrNumber) {
							sMsg = "Đã phê duyệt " + sPRId + ".\n"
								+ "Đã ghi SAP — số PR: " + oResult.sapPrNumber + " (ME53N).\n"
								+ "Người tạo đã được thông báo.";
							MessageBox.success(sMsg, { title: "Phê duyệt thành công" });
						} else if (oResult.sapPrNumber) {
							MessageBox.success("Đã phê duyệt. Số PR SAP: " + oResult.sapPrNumber + " (ME53N).", {
								title: "Phê duyệt thành công"
							});
						} else {
							MessageToast.show("Đã phê duyệt " + sPRId + ".", { duration: 4000 });
						}
					} else {
						MessageBox.warning("Đã từ chối " + sPRId + ".\nNgười tạo đã được thông báo.", {
							title: "Đã từ chối"
						});
					}

					var oModel = oView.getModel();
					var aFiltered = (oModel.getProperty("/pending") || [])
						.filter(function (pr) {
							return pr.PRId !== sPRId
								&& pr.InternalId !== sPRId
								&& !(oResult.approval && pr.PRId === oResult.approval.PRId);
						});
					oModel.setProperty("/pending", aFiltered);
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