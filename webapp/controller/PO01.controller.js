sap.ui.define([
	"sap/ui/core/mvc/Controller",
	"sap/ui/model/json/JSONModel",
	"sap/m/MessageBox",
	"sap/m/MessageToast"
], function (Controller, JSONModel, MessageBox, MessageToast) {
	"use strict";

	return Controller.extend("com.qdavy.procurement.controller.PO01", {
		onInit: function () {
			// Thiết lập dữ liệu Mock cục bộ khớp 100% với file MockData.js của dự án
			var oLocalMockData = {
				// PR đã được phê duyệt thành công, chờ xử lý tạo PO
				pendingPRs: [
					{
						PrNumber: "1000000001",
						MaterialNo: "LAPTOP-001",
						Description: "Dell Latitude 5540",
						Quantity: 10,
						EstimatedValue: 150000000,
						Currency: "VND",
						CostCenter: "CCTEC",
						Status: "APPROVED"
					},
					{
						PrNumber: "1000000002",
						MaterialNo: "SERVER-001",
						Description: "HP ProLiant DL360",
						Quantity: 2,
						EstimatedValue: 320000000,
						Currency: "VND",
						CostCenter: "CCBUS",
						Status: "APPROVED"
					}
				],
				// Dữ liệu giả lập kết quả gợi ý từ AI của BE-3
				aiSuggestedVendors: []
			};

			var oModel = new JSONModel(oLocalMockData);
			this.getView().setModel(oModel, "mockData");
		},

		onNavBack: function () {
			this.getOwnerComponent().getRouter().navTo("dashboard");
		},

		// Khi click chọn 1 dòng PR ở bảng bên trái
		onPRSelect: function (oEvent) {
			var oSelectedItem = oEvent.getParameter("listItem");
			var oContext = oSelectedItem.getBindingContext("mockData");
			var oPRData = oContext.getObject();

			// 1. Hiển thị khu vực bên phải
			this.getView().byId("poCreationArea").setVisible(true);

			// 2. Điền thông tin PR vào Form chi tiết
			this.getView().byId("txtSelectedPR").setText(oPRData.PrNumber);
			this.getView().byId("txtMaterialInfo").setText(oPRData.Description + " (" + oPRData.MaterialNo + ")");
			this.getView().byId("txtQuantity").setText(oPRData.Quantity + " PC");
			this.getView().byId("numEstimatedValue").setNumber(oPRData.EstimatedValue);
			this.getView().byId("numEstimatedValue").setUnit(oPRData.Currency);

			// Reset lại form thiết lập PO
			this.getView().byId("inSelectedVendor").setValue("");
			this.getView().byId("inFinalPrice").setValue(oPRData.EstimatedValue); // Tự điền giá đề xuất bằng giá PR gốc

			// 3. Tự động kích hoạt gọi gợi ý NCC (Giả lập hoặc gọi API BE-3)
			this._getAIVendorRecommendations(oPRData.MaterialNo, oPRData.EstimatedValue);
		},

		// Hàm giả lập kết nối tới Route AI của BE-3 (POST /api/ai/recommend-vendor)
		_getAIVendorRecommendations: function (sMaterialNo, fEstimatedValue) {
			var oView = this.getView();
			oView.setBusy(true);

			// Tuần 1: Tạo dữ liệu giả lập dựa theo vật tư được chọn
			var aMockAIVendors = [];
			if (sMaterialNo === "LAPTOP-001") {
				aMockAIVendors = [
					{ VendorNo: "80000001", VendorName: "Dell Vietnam Co. Ltd", Rating: 4.5, PriceProposal: 145000000, AiReason: "Khớp 100% kỹ thuật, giá rẻ hơn 5,000,000 VND so với ngân sách. Thời gian giao hàng nhanh (3 ngày)." },
					{ VendorNo: "80000003", VendorName: "Synnex FPT Vietnam", Rating: 4.0, PriceProposal: 150000000, AiReason: "Đại lý phân phối ủy quyền chuẩn trong nước, hỗ trợ xuất hóa đơn VAT nhanh, bảo hành nội địa tốt." }
				];
			} else {
				aMockAIVendors = [
					{ VendorNo: "80000002", VendorName: "HP Vietnam Co. Ltd", Rating: 4.8, PriceProposal: 310000000, AiReason: "Xếp hạng tối ưu nhất từ AI nhờ lịch sử cấp hàng Server ổn định, miễn phí lắp đặt cấu hình tủ rack." },
					{ VendorNo: "80000003", VendorName: "Synnex FPT Vietnam", Rating: 3.8, PriceProposal: 325000000, AiReason: "Giá cao hơn ngân sách dự kiến, thời gian giao hàng lâu hơn (10 ngày)." }
				];
			}

			// Giả lập độ trễ phản hồi của AI (1 giây)
			setTimeout(function () {
				oView.setBusy(false);
				oView.getModel("mockData").setProperty("/aiSuggestedVendors", aMockAIVendors);
				MessageToast.show("Đã cập nhật phương án nhà cung cấp tối ưu từ AI!");
			}, 1000);

			/* 
			KHI KẾT NỐI API THẬT CỦA BE-3 (Tuần 2-3):
			fetch("http://localhost:3001/api/ai/recommend-vendor", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ materialNo: sMaterialNo, value: fEstimatedValue })
			})
			.then(res => res.json())
			.then(data => {
				oView.setBusy(false);
				oView.getModel("mockData").setProperty("/aiSuggestedVendors", data.vendors);
			})
			.catch(err => {
				oView.setBusy(false);
				MessageBox.error("Không kết nối được AI Engine của BE-3.");
			});
			*/
		},

		// Nhấp nút thủ công gọi lại AI
		onCallAIVendors: function () {
			var sMaterialNo = this.getView().byId("txtMaterialInfo").getText().split("(")[1].replace(")", "");
			var fValue = this.getView().byId("numEstimatedValue").getNumber();
			this._getAIVendorRecommendations(sMaterialNo, fValue);
		},

		// Khi người dùng chọn một nhà cung cấp cụ thể trên bảng gợi ý
		onVendorSelect: function (oEvent) {
			var oSelectedItem = oEvent.getParameter("listItem");
			var oContext = oSelectedItem.getBindingContext("mockData");
			var oVendorData = oContext.getObject();

			// Đổ nhà cung cấp được chọn vào form điền thông tin bên dưới
			this.getView().byId("inSelectedVendor").setValue(oVendorData.VendorName + " (" + oVendorData.VendorNo + ")");
			this.getView().byId("inFinalPrice").setValue(oVendorData.PriceProposal);
		},

		// Sự kiện bấm nút XÁC NHẬN TẠO PO SANG SAP
		onConfirmCreatePO: function () {
			var oView = this.getView();
			var sPRId = oView.byId("txtSelectedPR").getText();
			var sVendorInfo = oView.byId("inSelectedVendor").getValue();
			var fFinalPrice = oView.byId("inFinalPrice").getValue();
			var sDeliveryTerms = oView.byId("inDeliveryTerms").getValue();

			if (!sVendorInfo) {
				MessageBox.error("Vui lòng chọn một nhà cung cấp từ phương án đề xuất của AI.");
				return;
			}

			if (fFinalPrice <= 0) {
				MessageBox.error("Giá thương lượng cuối cùng của PO phải lớn hơn 0 VND.");
				return;
			}

			oView.setBusy(true);

			// Tách lấy mã Vendor từ chuỗi "Name (VendorNo)"
			var sVendorNo = sVendorInfo.substring(sVendorInfo.lastIndexOf("(") + 1, sVendorInfo.lastIndexOf(")"));

			// Giả lập đẩy dữ liệu vào SAP ERP thành công qua BAPI_PO_CREATE1 (Tuần 1-2)
			setTimeout(function () {
				oView.setBusy(false);
				
				// Sinh mã PO ảo ngẫu nhiên bắt đầu bằng đầu số 45 (Theo cấu hình Number Range của nhóm bạn)
				var sGeneratedPONo = "45000" + Math.floor(10000 + Math.random() * 90000);

				MessageBox.success(
					"Đã lập phương án thành công!\n" +
					"Hệ thống đã gọi OData khởi chạy BAPI_PO_CREATE1 thành công trong SAP ERP.\n\n" +
					"Mã đơn mua hàng (PO) tạo thành công: " + sGeneratedPONo,
					{
						title: "Đồng bộ SAP thành công",
						onClose: function () {
							// Xóa PR đã làm xong khỏi bảng chờ ở màn hình bên trái
							var oModel = oView.getModel("mockData");
							var aPRs = oModel.getProperty("/pendingPRs");
							var aFilteredPRs = aPRs.filter(function (item) {
								return item.PrNumber !== sPRId;
							});
							oModel.setProperty("/pendingPRs", aFilteredPRs);
							
							// Ẩn bảng bên phải đi
							oView.byId("poCreationArea").setVisible(false);
						}
					}
				);
			}, 1500);

			/* 
			KHI ĐỒNG BỘ SAP QUA ODATA THẬT CỦA BE-2 (Tuần 2-3):
			// Gọi ODataModel của SAP UI5 tạo bản ghi thật
			var oODataModel = this.getView().getModel(); // Khai báo trong manifest
			var oNewPOPayload = {
				SourcePrNumber: sPRId,
				VendorNo: sVendorNo,
				Price: fFinalPrice.toString(),
				DeliveryTerms: sDeliveryTerms,
				DocType: "ZPO" // Theo tài liệu SPRO của nhóm
			};

			oODataModel.create("/PurchaseOrderHeaderSet", oNewPOPayload, {
				success: function (oData) {
					oView.setBusy(false);
					MessageBox.success("PO " + oData.PoNumber + " tạo thành công trong SAP!");
				},
				error: function (oError) {
					oView.setBusy(false);
					MessageBox.error("Thất bại khi lưu vào SAP: " + oError.message);
				}
			});
			*/
		}
	});
});