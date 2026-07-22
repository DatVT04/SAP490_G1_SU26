sap.ui.define([
    "sap/ui/core/mvc/Controller",
    "sap/ui/model/json/JSONModel",
    "sap/m/MessageBox",
    "sap/m/MessageToast",
    "sap/ui/core/format/NumberFormat" // Thêm thư viện để format số trong JS
], function (Controller, JSONModel, MessageBox, MessageToast, NumberFormat) {
    "use strict";

    return Controller.extend("com.qdavy.procurement.controller.ThresholdConfig", {
        
        // Tạo bộ format riêng cho tiền tệ để tái sử dụng nhanh trong JS
        _oPriceFormatter: NumberFormat.getIntegerInstance({
            groupingEnabled: true,
            groupingSeparator: "."
        }),

        // Khai báo formatter để View XML gọi trực tiếp
        formatter: {
            formatThresholdDesc: function (fValue) {
                if (!fValue) { return ""; }
                // Lấy instance format dấu chấm của Controller
                var oController = this.getView().getController();
                var sFormatted = oController._oPriceFormatter.format(fValue);
                
                return "Nếu PR có giá trị dưới " + sFormatted + " VND, hệ thống sẽ tự động chuyển tiếp tới CFO duyệt. " +
                       "Ngược lại, nếu từ " + sFormatted + " VND trở lên, PR bắt buộc phải có sự phê duyệt trực tiếp từ Tổng Giám Đốc (CEO).";
            }
        },

        onInit: function () {
            var oData = {
                prThreshold: 300000000, 
                isActive: true,
                history: [
                    { date: "13/07/2026", updatedBy: "CEO - Tran Thi Lan", oldValue: 200000000, newValue: 300000000, note: "Điều chỉnh theo biên bản họp Đồ án tuần 8" },
                    { date: "30/06/2026", updatedBy: "CEO - Tran Thi Lan", oldValue: 150000000, newValue: 200000000, note: "Tăng định mức chi tiêu phòng ban sản xuất" }
                ]
            };

            var oModel = new JSONModel(oData);
            this.getView().setModel(oModel, "thresholdModel");
        },

        onNavBack: function () {
            this.getOwnerComponent().getRouter().navTo("dashboard");
        },

        onSaveThreshold: function () {
            var oView = this.getView();
            var oModel = oView.getModel("thresholdModel");
            var fNewThreshold = oModel.getProperty("/prThreshold");
            var bIsActive = oModel.getProperty("/isActive");

            oView.setBusy(true);

            setTimeout(function () {
                oView.setBusy(false);

                var aHistory = oModel.getProperty("/history");
                var oCurrentUser = oView.getModel("user") ? oView.getModel("user").getProperty("/fullName") : "CEO - Tran Thi Lan";

                var oNewRecord = {
                    date: new Date().toLocaleDateString("vi-VN"),
                    updatedBy: oCurrentUser,
                    oldValue: aHistory.length > 0 ? aHistory[0].newValue : 300000000,
                    newValue: fNewThreshold,
                    note: bIsActive ? "Cập nhật định mức ngưỡng tự động từ Web App" : "Tạm ngắt áp dụng ngưỡng"
                };

                aHistory.unshift(oNewRecord); 
                oModel.setProperty("/history", aHistory);

                // Dùng bộ format _oPriceFormatter đã định nghĩa ở trên để hiển thị hộp thoại chuẩn xác nhất
                var sFormattedValue = this._oPriceFormatter.format(fNewThreshold);

                MessageBox.success(
                    "Hệ thống đã cập nhật ngưỡng duyệt mới thành công!\n\n" +
                    "Giá trị ngưỡng mới: " + sFormattedValue + " VND.\n" +
                    "Kể từ bây giờ, tất cả các đơn PR gửi lên sẽ tự động áp dụng quy tắc định tuyến này.",
                    { title: "Cập Nhật Thành Công" }
                );
            }.bind(this), 1200);
        }
    });
});