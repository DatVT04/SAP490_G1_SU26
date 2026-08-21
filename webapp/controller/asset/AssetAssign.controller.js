sap.ui.define([
	"sap/ui/core/mvc/Controller",
	"sap/ui/model/json/JSONModel",
	"sap/m/MessageBox",
	"sap/m/MessageToast",
	"sap/m/Dialog",
	"sap/m/DialogType",
	"sap/m/Button",
	"sap/m/ButtonType",
	"sap/m/Input",
	"sap/m/DatePicker",
	"sap/m/StepInput",
	"sap/m/VBox",
	"sap/m/Label",
	"sap/m/Text",
	"com/qdavy/procurement/model/Config",
	"com/qdavy/procurement/model/Msg"
], function (
	Controller, JSONModel, MessageBox, MessageToast,
	Dialog, DialogType, Button, ButtonType,
	Input, DatePicker, StepInput, VBox, Label, Text,
	Config, Msg
) {
	"use strict";

	var BACKEND = Config.BACKEND;
	var REQUEST_TIMEOUT_MS = 20000;

	/**
	 * Man GAN THE TAI SAN (role PURCHASING).
	 *
	 * Truoc day he thong khai san ma tai san cho tung vat tu roi PR-01 tu dien —
	 * tuc la coi moi vat tu duoc phep mua deu da la tai san san. Thuc te nguoc
	 * lai: mua ve roi moi lap the tai san. Man nay lam dung viec do — bam Tao the
	 * la app goi SAP tao asset master that (BAPI_FIXEDASSET_CREATE1), moi don vi
	 * so luong mot the.
	 *
	 * Bo phan Mua sam lam buoc nay vi ho la nguoi nhan hang va biet mon hang thuc
	 * te ve la cai gi; ho da theo de nghi tu PR-02 toi PO-01 nen khong phai ban
	 * giao ngu canh cho ai.
	 */
	return Controller.extend("com.qdavy.procurement.controller.asset.AssetAssign", {

		onInit: function () {
			this.getView().setModel(new JSONModel({ rows: [], openCount: 0 }));
			this.getOwnerComponent().getRouter()
				.getRoute("assetAssign")
				.attachPatternMatched(this._onRouteMatched, this);
		},

		_onRouteMatched: function () {
			if (this._role() !== "PURCHASING") {
				MessageBox.error("Chỉ Bộ phận Mua sắm được vào màn hình này.");
				this.getOwnerComponent().getRouter().navTo("dashboard");
				return;
			}
			this._load();
		},

		_role: function () {
			return String(this.getOwnerComponent().getModel("user").getProperty("/role") || "").toUpperCase();
		},

		_load: function () {
			var oView = this.getView();
			var oModel = oView.getModel();
			oView.setBusy(true);

			this._fetchWithTimeout(BACKEND + "/api/asset-assignment/pending")
				.then(function (oResult) {
					oView.setBusy(false);
					if (!oResult || !oResult.success) {
						MessageBox.error((oResult && oResult.message) || "Không tải được danh sách vật tư chờ gán thẻ.");
						return;
					}
					oModel.setProperty("/rows", oResult.data || []);
					oModel.setProperty("/openCount", Number(oResult.openCount) || 0);
				})
				.catch(function (oError) {
					oView.setBusy(false);
					MessageBox.error(oError.message || "Không thể kết nối tới máy chủ. Vui lòng thử lại.");
				});
		},

		onRefreshPress: function () {
			this._load();
		},

		onNavBack: function () {
			this.getOwnerComponent().getRouter().navTo("dashboard");
		},

		onCreatePress: function (oEvent) {
			var oRow = oEvent.getSource().getBindingContext().getObject();
			if (!oRow || oRow.Remaining <= 0) { return; }
			this._openCreateDialog(oRow);
		},

		_openCreateDialog: function (oRow) {
			var that = this;

			var oDesc = new Input({
				value: oRow.Description,
				maxLength: 50,
				width: "100%"
			});
			var oCount = new StepInput({
				value: oRow.Remaining,
				min: 1,
				max: oRow.Remaining,
				step: 1,
				width: "8rem"
			});
			var oDate = new DatePicker({
				valueFormat: "yyyy-MM-dd",
				displayFormat: "dd/MM/yyyy",
				dateValue: new Date(),
				width: "12rem"
			});

			var oDialog = new Dialog({
				type: DialogType.Standard,
				title: "Tạo thẻ tài sản",
				contentWidth: "28rem",
				content: [
					new VBox({
						class: "sapUiSmallMargin",
						items: [
							new Text({
								text: "Đề nghị " + (oRow.DisplayId || oRow.PRId)
									+ (oRow.PoNumber ? (" · PO " + oRow.PoNumber) : "")
									+ "\nVật tư: " + oRow.MaterialNo
									+ "\nBộ phận: " + (oRow.CostCenter || "—"),
								wrapping: true
							}).addStyleClass("sapUiSmallMarginBottom"),
							new Label({ text: "Tên thẻ tài sản:", required: true }),
							oDesc,
							new Label({ text: "Số thẻ cần tạo (mỗi đơn vị một thẻ):", required: true })
								.addStyleClass("sapUiTinyMarginTop"),
							oCount,
							new Label({ text: "Ngày vốn hoá:", required: true })
								.addStyleClass("sapUiTinyMarginTop"),
							oDate,
							new Text({
								text: "Thẻ được tạo trên SAP ngay khi bấm nút, số thẻ do SAP tự đánh theo nhóm tài sản. Thao tác này không hoàn tác được trong ứng dụng — muốn huỷ phải dùng AS06 trong SAP GUI.",
								wrapping: true
							}).addStyleClass("sapUiSmallMarginTop qdCellHint")
						]
					})
				],
				beginButton: new Button({
					text: "Tạo thẻ",
					type: ButtonType.Emphasized,
					press: function () {
						var sDesc = String(oDesc.getValue() || "").trim();
						if (!sDesc) {
							oDesc.setValueState("Error");
							oDesc.setValueStateText("Vui lòng nhập tên thẻ tài sản.");
							return;
						}
						oDialog.close();
						that._submit(oRow, {
							description: sDesc,
							count: oCount.getValue(),
							capitalizedOn: oDate.getValue()
						});
					}
				}),
				endButton: new Button({
					text: "Huỷ",
					press: function () { oDialog.close(); }
				}),
				afterClose: function () { oDialog.destroy(); }
			});

			this.getView().addDependent(oDialog);
			oDialog.open();
		},

		_submit: function (oRow, oInput) {
			var oView = this.getView();
			var oUser = this.getOwnerComponent().getModel("user").getData() || {};
			oView.setBusy(true);

			this._fetchWithTimeout(BACKEND + "/api/asset-assignment/create", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					prId: oRow.PRId,
					lineNo: oRow.LineNo,
					count: oInput.count,
					description: oInput.description,
					costCenter: oRow.CostCenter,
					capitalizedOn: oInput.capitalizedOn,
					role: this._role(),
					createdByEmail: oUser.email
				})
			})
				.then(function (oResult) {
					oView.setBusy(false);
					var aCreated = (oResult && oResult.created) || [];

					if (!oResult || (!oResult.success && aCreated.length === 0)) {
						Msg.fail(oResult, {
							title: "Không tạo được thẻ tài sản",
							fallback: "Không tạo được thẻ tài sản trên SAP. Vật tư vẫn giữ nguyên, bạn có thể thử lại."
						});
						return;
					}

					var sNums = aCreated.map(function (c) { return c.assetNo; }).join(", ");
					var sMsg = "Đã tạo " + aCreated.length + " thẻ tài sản trên SAP.\nMã thẻ: " + sNums;
					if (Number(oResult.remaining) > 0) {
						sMsg += "\n\nDòng này còn thiếu " + oResult.remaining + " thẻ.";
					}
					if (oResult.message) {
						sMsg += "\n\nLưu ý: " + oResult.message;
					}
					if (oResult.savedToSap === false) {
						sMsg += "\n\nThẻ đã tạo trên SAP nhưng chưa ghi được mã vào đề nghị"
							+ " — ứng dụng đang lưu tạm, hãy báo kỹ thuật kiểm tra PrDraftItemSet.";
					}
					MessageBox.success(sMsg, { title: "Đã tạo thẻ tài sản" });
					this._load();
				}.bind(this))
				.catch(function (oError) {
					oView.setBusy(false);
					MessageBox.error(oError.message || "Không thể kết nối tới máy chủ. Vui lòng thử lại.");
				});
		},

		// Fetch co hen gio: tao asset goi BAPI nen co the lau hon cac man khac.
		_fetchWithTimeout: function (sUrl, oOptions) {
			return new Promise(function (resolve, reject) {
				var bDone = false;
				var iTimer = setTimeout(function () {
					if (bDone) { return; }
					bDone = true;
					reject(new Error("Máy chủ không phản hồi sau " + (REQUEST_TIMEOUT_MS / 1000)
						+ " giây. Thẻ tài sản có thể đã được tạo — bấm Tải lại để kiểm tra trước khi thử lại."));
				}, REQUEST_TIMEOUT_MS);

				fetch(sUrl, oOptions || {})
					.then(function (r) { return r.json(); })
					.then(function (oJson) {
						if (bDone) { return; }
						bDone = true;
						clearTimeout(iTimer);
						resolve(oJson);
					})
					.catch(function (oErr) {
						if (bDone) { return; }
						bDone = true;
						clearTimeout(iTimer);
						reject(oErr);
					});
			});
		}
	});
});
