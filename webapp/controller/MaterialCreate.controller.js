sap.ui.define([
    "sap/ui/core/mvc/Controller",
    "sap/ui/model/json/JSONModel",
    "sap/m/MessageBox",
    "sap/m/MessageToast",
    "sap/ui/core/routing/History",
    "sap/ui/core/ValueState"
], function (Controller, JSONModel, MessageBox, MessageToast, History, ValueState) {
    "use strict";

    var DEFAULTS = {
        materialType: "ZAST",
        industrySector: "S",
        plant: "QDPL",
        storageLocation: "QDSL",
        description: "",
        baseUnit: "",
        materialGroup: "",
        purchasingGroup: "",
        purchaseOrderText: "",
        language: "EN",
        busy: false,
        uoms: [],
        materialGroups: [],
        purchasingGroups: []
    };

    return Controller.extend("com.qdavy.procurement.controller.MaterialCreate", {
        onInit: function () {
            this.getView().setModel(new JSONModel(this._buildFormData(DEFAULTS)), "form");

            var oRouter = this.getOwnerComponent().getRouter();
            var oRoute = oRouter.getRoute("MaterialCreate");
            if (oRoute) {
                oRoute.attachPatternMatched(this._onRouteMatched, this);
            } else {
                this._loadValueHelps("ZAST");
            }
        },

        _onRouteMatched: function () {
            var oUserModel = this.getOwnerComponent().getModel("user");
            var sRole = oUserModel ? String(oUserModel.getProperty("/role") || "").toUpperCase() : "";

            if (sRole && sRole !== "PURCHASING") {
                MessageBox.error("Chức năng tạo danh mục chỉ dành cho Purchasing.", {
                    onClose: this.onBack.bind(this)
                });
                return;
            }

            this._loadValueHelps(this.getView().getModel("form").getProperty("/materialType"));
        },

        _buildFormData: function (oBase) {
            var oData = Object.assign({}, oBase);
            return Object.assign(oData, this._getTypePresentation(oData.materialType));
        },

        _getTypePresentation: function (sType) {
            var bService = sType === "ZSRV";

            return {
                isAsset: !bService,
                isService: bService,
                materialTypeText: bService
                    ? "ZSRV – QDAVY Service Type"
                    : "ZAST – QDAVY Asset/Material Type",
                pageTitle: bService ? "Tạo mới dịch vụ" : "Tạo mới vật tư/tài sản",
                sectionTitle: bService ? "Thông tin dịch vụ" : "Thông tin vật tư/tài sản",
                nameLabel: bService ? "Tên dịch vụ" : "Tên vật tư",
                namePlaceholder: bService
                    ? "Ví dụ: Dịch vụ Microsoft 365"
                    : "Ví dụ: Laptop Dell Inspiron 15 3000",
                unitLabel: bService ? "Đơn vị tính dịch vụ" : "Đơn vị tính cơ bản",
                groupLabel: bService ? "Nhóm dịch vụ" : "Nhóm vật tư",
                groupPlaceholder: bService ? "Chọn nhóm dịch vụ" : "Chọn nhóm vật tư",
                detailLabel: bService
                    ? "Mô tả chi tiết / Phạm vi dịch vụ"
                    : "Mô tả chi tiết / Thông số kỹ thuật",
                detailPlaceholder: bService
                    ? "Mô tả gói dịch vụ, phạm vi công việc và kết quả bàn giao..."
                    : "Mô tả cấu hình, thông số kỹ thuật, yêu cầu bảo hành...",
                detailRequired: bService,
                submitText: bService ? "Tạo dịch vụ" : "Tạo vật tư"
            };
        },

        onMaterialTypeChange: function (oEvent) {
            var sType = oEvent.getSource().getSelectedKey();
            var oModel = this.getView().getModel("form");
            var oPresentation = this._getTypePresentation(sType);

            oModel.setProperty("/materialType", sType);
            Object.keys(oPresentation).forEach(function (sKey) {
                oModel.setProperty("/" + sKey, oPresentation[sKey]);
            });
            oModel.setProperty("/storageLocation", sType === "ZAST" ? "QDSL" : "");
            oModel.setProperty("/materialGroup", "");
            oModel.setProperty("/baseUnit", "");
            oModel.setProperty("/purchasingGroup", "");

            this._clearValueStates();
            this._loadValueHelps(sType);
        },

        _loadValueHelps: async function (sType) {
            var oModel = this.getView().getModel("form");
            oModel.setProperty("/busy", true);

            try {
                var oResponse = await fetch("/api/material-master/value-help?type=" + encodeURIComponent(sType), {
                    headers: { "Accept": "application/json" }
                });
                var oResult = await oResponse.json();

                if (!oResponse.ok || !oResult.success) {
                    throw new Error(oResult.message || "Không tải được danh mục SAP.");
                }

                oModel.setProperty("/uoms", oResult.data.uoms || []);
                oModel.setProperty("/materialGroups", oResult.data.materialGroups || []);
                oModel.setProperty("/purchasingGroups", oResult.data.purchasingGroups || []);
            } catch (oError) {
                MessageToast.show("Không tải được value help SAP; đang dùng dữ liệu dự phòng.");
                oModel.setProperty("/uoms", this._fallbackUoms());
                oModel.setProperty("/materialGroups", this._fallbackGroups(sType));
                oModel.setProperty("/purchasingGroups", []);
            } finally {
                oModel.setProperty("/busy", false);
            }
        },

        _fallbackUoms: function () {
            return [
                { code: "PC", description: "Piece" },
                { code: "EA", description: "Each" },
                { code: "MON", description: "Month" },
                { code: "YR", description: "Year" },
                { code: "H", description: "Hour" },
                { code: "DAY", description: "Day" }
            ];
        },

        _fallbackGroups: function (sType) {
            return sType === "ZSRV"
                ? [{ code: "Z20V", description: "QDAVY Service Group" }]
                : [{ code: "Z10V", description: "QDAVY Asset/Material Group" }];
        },

        onRequiredFieldLiveChange: function (oEvent) {
            var oControl = oEvent.getSource();
            var bValid = Boolean(String(oControl.getValue() || "").trim());
            oControl.setValueState(bValid ? ValueState.None : ValueState.Error);
            oControl.setValueStateText(bValid ? "" : "Trường này không được để trống.");
        },

        onRequiredSelectionChange: function (oEvent) {
            var oControl = oEvent.getSource();
            var bValid = Boolean(oControl.getSelectedKey());
            oControl.setValueState(bValid ? ValueState.None : ValueState.Error);
            oControl.setValueStateText(bValid ? "" : "Vui lòng chọn một giá trị hợp lệ.");
        },

        onDetailLiveChange: function (oEvent) {
            var oModel = this.getView().getModel("form");
            if (!oModel.getProperty("/detailRequired")) {
                return;
            }
            var oControl = oEvent.getSource();
            var bValid = Boolean(String(oControl.getValue() || "").trim());
            oControl.setValueState(bValid ? ValueState.None : ValueState.Error);
            oControl.setValueStateText(bValid ? "" : "Dịch vụ cần có mô tả phạm vi chi tiết.");
        },

        _validate: function () {
            var oModel = this.getView().getModel("form");
            var aChecks = [
                {
                    control: this.byId("descriptionInput"),
                    valid: Boolean(String(oModel.getProperty("/description") || "").trim()),
                    message: "Vui lòng nhập tên vật tư/dịch vụ."
                },
                {
                    control: this.byId("baseUnitCombo"),
                    valid: Boolean(oModel.getProperty("/baseUnit")),
                    message: "Vui lòng chọn đơn vị tính."
                },
                {
                    control: this.byId("materialGroupCombo"),
                    valid: Boolean(oModel.getProperty("/materialGroup")),
                    message: "Vui lòng chọn nhóm vật tư/dịch vụ."
                }
            ];

            if (oModel.getProperty("/detailRequired")) {
                aChecks.push({
                    control: this.byId("detailTextArea"),
                    valid: Boolean(String(oModel.getProperty("/purchaseOrderText") || "").trim()),
                    message: "Vui lòng nhập mô tả chi tiết/phạm vi dịch vụ."
                });
            }

            var bValid = true;
            aChecks.forEach(function (oCheck) {
                oCheck.control.setValueState(oCheck.valid ? ValueState.None : ValueState.Error);
                oCheck.control.setValueStateText(oCheck.valid ? "" : oCheck.message);
                bValid = bValid && oCheck.valid;
            });

            return bValid;
        },

        onCreateMaterial: function () {
            if (!this._validate()) {
                MessageBox.warning("Vui lòng hoàn thành các trường bắt buộc trước khi tạo.");
                return;
            }

            var oModel = this.getView().getModel("form");
            var oData = oModel.getData();
            var oUserModel = this.getOwnerComponent().getModel("user");
            var sEmail = oUserModel ? oUserModel.getProperty("/email") : "";

            var oPayload = {
                materialNo: String(oData.materialNo).trim(),
                materialType: oData.materialType,
                industrySector: "S",
                plant: "QDPL",
                storageLocation: oData.materialType === "ZAST" ? "QDSL" : "",
                description: String(oData.description).trim(),
                baseUnit: oData.baseUnit,
                materialGroup: oData.materialGroup,
                purchasingGroup: oData.purchasingGroup || "",
                purchaseOrderText: String(oData.purchaseOrderText || "").trim(),
                language: oData.language || "EN",
                createdByEmail: sEmail,
                createdByRole: "PURCHASING"
            };

            MessageBox.confirm(
                "Tạo " + (oData.materialType === "ZSRV" ? "dịch vụ" : "vật tư/tài sản")
                + " mới trên SAP?",
                {
                    title: "Xác nhận tạo danh mục",
                    emphasizedAction: MessageBox.Action.OK,
                    onClose: function (sAction) {
                        if (sAction === MessageBox.Action.OK) {
                            this._submitCreate(oPayload);
                        }
                    }.bind(this)
                }
            );
        },

        _submitCreate: async function (oPayload) {
            var oModel = this.getView().getModel("form");
            oModel.setProperty("/busy", true);

            try {
                var oResponse = await fetch("/api/material-master/create", {
                    method: "POST",
                    headers: { "Content-Type": "application/json", "Accept": "application/json" },
                    body: JSON.stringify(oPayload)
                });
                var oResult = await oResponse.json();

                if (!oResponse.ok || !oResult.success) {
                    throw new Error(oResult.message || "SAP không tạo được danh mục.");
                }

                var sMaterialNo = oResult.materialNumber || (oResult.data && oResult.data.materialNumber) || "";
                MessageBox.success(
                    "Tạo thành công.\nMã SAP: " + (sMaterialNo || "SAP đã tiếp nhận"),
                    {
                        title: "Hoàn tất",
                        onClose: function () {
                            this.onReset();
                        }.bind(this)
                    }
                );
            } catch (oError) {
                MessageBox.error(oError.message || "Không thể tạo danh mục trên SAP.");
            } finally {
                oModel.setProperty("/busy", false);
            }
        },

        onReset: function () {
            var oModel = this.getView().getModel("form");
            var sType = oModel.getProperty("/materialType") || "ZAST";
            var aUoms = oModel.getProperty("/uoms") || [];
            var aGroups = oModel.getProperty("/materialGroups") || [];
            var aPurchasingGroups = oModel.getProperty("/purchasingGroups") || [];

            var oReset = this._buildFormData(Object.assign({}, DEFAULTS, {
                materialType: sType,
                storageLocation: sType === "ZAST" ? "QDSL" : "",
                uoms: aUoms,
                materialGroups: aGroups,
                purchasingGroups: aPurchasingGroups
            }));

            oModel.setData(oReset);
            this._clearValueStates();
        },

        _clearValueStates: function () {
            [
                "descriptionInput",
                "baseUnitCombo",
                "materialGroupCombo",
                "detailTextArea"
            ].forEach(function (sId) {
                var oControl = this.byId(sId);
                if (oControl) {
                    oControl.setValueState(ValueState.None);
                    oControl.setValueStateText("");
                }
            }.bind(this));
        },

        onBack: function () {
            var sPreviousHash = History.getInstance().getPreviousHash();
            if (sPreviousHash !== undefined) {
                window.history.go(-1);
            } else {
                this.getOwnerComponent().getRouter().navTo("Dashboard", {}, true);
            }
        }
    });
});
