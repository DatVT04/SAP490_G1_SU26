sap.ui.define([
    "sap/ui/core/mvc/Controller",
    "sap/ui/model/json/JSONModel",
    "sap/ui/model/Filter",
    "sap/ui/model/FilterOperator",
    "sap/m/MessageToast"
], function (Controller, JSONModel, Filter, FilterOperator, MessageToast) {
    "use strict";

    return Controller.extend("com.qdavy.procurement.controller.POReport", {
        onInit: function () {
            // 1. Khởi tạo một JSONModel rỗng để chứa dữ liệu UI báo cáo đúng chuẩn SAP thật
            var oModel = new JSONModel({
                poRecords: [],
                selectedPO: null
            });
            this.getView().setModel(oModel, "reportModel");

            // 2. Tải dữ liệu PO trực tiếp từ SAP Backend thông qua Node.js Proxy
            this._loadPODataFromSAP();
        },

        /**
         * 🚀 HÀM ĐỌC DỮ LIỆU: Kết nối trực tiếp với OData Service của SAP (Qua Node.js trung chuyển)
         */
        _loadPODataFromSAP: function () {
            var oView = this.getView();
            var oReportModel = oView.getModel("reportModel");
            
            oView.setBusy(true); // Bật hiệu ứng xoay tròn loading

            var that = this;

            $.ajax({
                url: "http://localhost:3001/api/po/report",
                method: "GET",
                dataType: "json",
                success: function (response) {
                    oView.setBusy(false); // Tắt xoay tròn khi có kết quả
                    
                    if (response && response.success) {
                        var aRawPoRecords = response.data || [];
                        
                        // Khớp nối dữ liệu thật: Tính toán Tỷ lệ giả lập dựa trên trạng thái thật từ SAP
                        aRawPoRecords = aRawPoRecords.map(function (record) {
                            // Vì SAP thật hiện tại chưa phân tách trường Item chi tiết, tạm thời gán 100% nếu đã tạo thành công sang SAP
                            record.DeliveryRate = record.Status === "CREATED" ? 100 : 0;
                            return record;
                        });

                        // Đẩy dữ liệu sạch từ SAP thật lên giao diện bảng công khai
                        oReportModel.setProperty("/poRecords", aRawPoRecords);
                        oReportModel.setProperty("/selectedPO", null);
                    } else {
                        sap.m.MessageToast.show("Không lấy được dữ liệu từ hệ thống SAP!");
                    }
                },
                error: function (xhr, status, error) {
                    oView.setBusy(false); // Tắt xoay tròn kể cả khi lỗi mạng
                    sap.m.MessageToast.show("Lỗi kết nối tới Server Node.js Backend!");
                    console.error("AJAX Error: ", error);
                }
            });
        },

        /**
         * 🎯 HÀM CLICK CHỌN DÒNG: Đẩy dữ liệu dòng được chọn vào selectedPO để hiển thị tiến độ ngang
         * (Đã bổ sung logic dịch trạng thái chữ sang số StepActive để kích hoạt CSS)
         */
        onPOSelect: function (oEvent) {
            var oContext = oEvent.getSource().getBindingContext("reportModel");
            var oSelectedData = oContext.getObject();
            
            // ✨ BỔ SUNG: Ánh xạ chuỗi Status chữ từ SAP sang số bước cụ thể
            if (oSelectedData && oSelectedData.Status) {
                switch (oSelectedData.Status) {
                    case "CREATED":
                        oSelectedData.StepActive = 5; // Bước 5: Đã tạo PO sang SAP
                        break;
                    case "DELIVERED":
                        oSelectedData.StepActive = 6; // Bước 6: Nhập kho hoàn tất
                        break;
                    default:
                        // Nếu có các trạng thái duyệt nội bộ (Yêu cầu, Trưởng BP, CFO, CEO) thì map tiếp ở đây
                        oSelectedData.StepActive = 1; // Mặc định dừng ở bước 1
                        break;
                }
            } else {
                oSelectedData.StepActive = 1;
            }
            
            // Đẩy object đã có trường StepActive vào Model để XML và CSS tính toán
            this.getView().getModel("reportModel").setProperty("/selectedPO", oSelectedData);
        },

        /**
         * ↩️ Quay lại màn hình Dashboard chính
         */
        onNavBack: function () {
            this.getOwnerComponent().getRouter().navTo("dashboard");
        },

        /**
         * 🔍 Tìm kiếm & Lọc nhanh trên giao diện bảng (Đã sửa lại khớp trường SAP thật)
         */
        onFilterChange: function () {
            var sSearchQuery = this.getView().byId("filterSearch").getValue();
            var sStatusKey = this.getView().byId("filterStatus").getSelectedKey();
            var aFinalFilters = [];

            // 1. Tìm kiếm nhanh theo Số PO hoặc Tên Nhà Cung Cấp
            if (sSearchQuery && sSearchQuery.length > 0) {
                var oFilterPo = new Filter("PoNumber", FilterOperator.Contains, sSearchQuery);
                var oFilterVendor = new Filter("VendorName", FilterOperator.Contains, sSearchQuery);
                aFinalFilters.push(new Filter({ filters: [oFilterPo, oFilterVendor], and: false }));
            }

            // 2. Lọc theo trạng thái thực tế từ SAP (Trường Status thay vì StatusCode cũ)
            if (sStatusKey && sStatusKey !== "ALL") {
                aFinalFilters.push(new Filter("Status", FilterOperator.EQ, sStatusKey));
            }

            // Thực thi lọc dữ liệu trên Table
            var oTable = this.getView().byId("reportTable");
            if (oTable && oTable.getBinding("items")) {
                oTable.getBinding("items").filter(aFinalFilters);
            }
            
            // Ẩn khu vực chi tiết tiến độ khi người dùng thay đổi bộ lọc
            this.getView().getModel("reportModel").setProperty("/selectedPO", null);
        },

        /**
         * 🔄 Nút bấm REFRESH trên bảng dữ liệu
         */
        onRefreshReport: function () {
            // Xóa sạch các ô nhập bộ lọc về mặc định để tránh nghẽn dữ liệu hiển thị
            this.getView().byId("filterSearch").setValue("");
            this.getView().byId("filterStatus").setSelectedKey("ALL");
            
            // Gọi lại hàm kết nối để kéo dữ liệu mới nhất
            this._loadPODataFromSAP();
            
            MessageToast.show("Đã cập nhật dữ liệu báo cáo thời gian thực từ SAP!");
        }
    });
});