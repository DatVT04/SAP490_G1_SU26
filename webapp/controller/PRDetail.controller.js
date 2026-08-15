sap.ui.define([
	"sap/ui/core/mvc/Controller",
	"sap/ui/model/json/JSONModel",
	"sap/m/MessageBox",
	"sap/ui/core/routing/History",
	"com/qdavy/procurement/model/Config"
], function (Controller, JSONModel, MessageBox, RoutingHistory, Config) {
	"use strict";

	var BACKEND = Config.BACKEND;
	var REQUEST_TIMEOUT_MS = 15000;

	var STATUS_LABELS = {
		PENDING_PURCHASING: "Đang chờ Purchasing duyệt",
		PENDING_RFQ: "Đã duyệt hợp lệ — đang ở bước hỏi giá (RFQ)",
		RFQ_SENT: "Đã gửi RFQ tới nhà cung cấp, chờ báo giá",
		QUOTATIONS_RECEIVED: "Đã nhận báo giá, chờ Purchasing chốt nhà cung cấp",
		PENDING_CFO: "Đang chờ CFO duyệt",
		PENDING_CEO: "Đang chờ CEO duyệt (đã leo thang)",
		APPROVED: "Đã phê duyệt",
		REJECTED: "Đã từ chối",
		RETURNED: "Bị Purchasing trả lại — có thể sửa và gửi lại",
		CANCELLED: "Đã hủy (đã được gửi lại bằng đề nghị mới)",
		PO_CREATED: "Đã tạo Purchase Order",
		OPENED: "Đã mở",
		OPEN: "Đã mở"
	};

	var STATUS_STATES = {
		PENDING_PURCHASING: "Warning",
		PENDING_RFQ: "Warning",
		RFQ_SENT: "Warning",
		QUOTATIONS_RECEIVED: "Warning",
		PENDING_CFO: "Warning",
		PENDING_CEO: "Warning",
		APPROVED: "Success",
		REJECTED: "Error",
		RETURNED: "Error",
		CANCELLED: "None",
		PO_CREATED: "Success",
		OPENED: "Success",
		OPEN: "Success"
	};

	function formatViTime(sIso) {
		if (!sIso) { return ""; }
		try {
			var d = new Date(sIso);
			if (isNaN(d.getTime())) { return String(sIso); }
			var pad = function (n) { return String(n).padStart(2, "0"); };
			return pad(d.getHours()) + ":" + pad(d.getMinutes()) + " "
				+ pad(d.getDate()) + "-" + pad(d.getMonth() + 1) + "-" + d.getFullYear();
		} catch (e) {
			return String(sIso);
		}
	}

	/**
	 * Timeline kiểu tracking — thời gian thật từng bước
	 * Ưu tiên PurchasingAt / CfoAt / CeoAt; fallback UpdatedAt nếu PR cũ chưa có field.
	 */
	function buildTimeline(pr) {
		if (!pr) { return []; }

		var status = String(pr.Status || "").toUpperCase();
		var steps = [];

		// 1. Gửi đề nghị
		steps.push({
			title: "Gửi đề nghị",
			icon: "sap-icon://paper-plane",
			timeText: formatViTime(pr.CreatedAt),
			sub: pr.RequesterEmail || "",
			done: true,
			active: false
		});

		// 2. Purchasing
		var purchasingDone = !!(pr.PurchasingAction || pr.PurchasingApprovedBy);
		var purchasingActive = status === "PENDING_PURCHASING";
		var purchasingTime = pr.PurchasingAt || (purchasingDone ? pr.UpdatedAt : "");
		var purchasingSub = "";
		if (pr.PurchasingAction === "APPROVED") {
			purchasingSub = "Đã duyệt" + (pr.PurchasingApprovedBy ? " · " + pr.PurchasingApprovedBy : "");
		} else if (pr.PurchasingAction === "REJECTED") {
			// Purchasing từ chối = TRẢ LẠI để sửa (khác CFO/CEO từ chối là kết thúc hẳn)
			purchasingSub = (String(pr.Status || "").toUpperCase() === "RETURNED" ? "Trả lại để sửa" : "Từ chối")
				+ (pr.PurchasingApprovedBy ? " · " + pr.PurchasingApprovedBy : "");
		} else if (purchasingActive) {
			purchasingSub = "Đang chờ";
		}

		steps.push({
			title: "Purchasing",
			icon: pr.PurchasingAction === "REJECTED" ? "sap-icon://decline" : "sap-icon://cart",
			timeText: formatViTime(purchasingTime),
			sub: purchasingSub,
			done: purchasingDone,
			active: purchasingActive
		});

		var skipRest = pr.PurchasingAction === "REJECTED";

		// 3. RFQ — chỉ hiện với PR thực sự đi qua luồng hỏi giá (không phải PR nào cũng cần).
		// Nhận biết bằng RfqId đã gắn, hoặc PR đang đứng ở 1 trong 3 trạng thái RFQ.
		var RFQ_STATUSES = ["PENDING_RFQ", "RFQ_SENT", "QUOTATIONS_RECEIVED"];
		var rfqActive = RFQ_STATUSES.indexOf(status) !== -1;
		var hasRfq = !!pr.RfqId || rfqActive || !!pr.RfqAwardedVendor;

		if (!skipRest && hasRfq) {
			var rfqDone = !!pr.RfqAwardedVendor;
			var rfqSub = "";

			if (rfqDone) {
				rfqSub = "Đã chốt NCC " + pr.RfqAwardedVendor;
			} else if (status === "PENDING_RFQ") {
				rfqSub = "Đang lập yêu cầu báo giá";
			} else if (status === "RFQ_SENT") {
				rfqSub = "Đã gửi NCC, chờ báo giá";
			} else if (status === "QUOTATIONS_RECEIVED") {
				rfqSub = "Đã nhận báo giá, chờ chốt NCC";
			}

			// Các route RFQ chỉ cập nhật UpdatedAt chứ chưa ghi mốc thời gian riêng cho
			// từng bước RFQ, nên chỉ hiện giờ khi bước này đang/đã diễn ra — không bịa mốc.
			steps.push({
				title: "RFQ",
				icon: rfqDone ? "sap-icon://accept" : "sap-icon://email",
				timeText: (rfqDone || rfqActive) ? formatViTime(pr.UpdatedAt) : "",
				sub: rfqSub,
				done: rfqDone,
				active: rfqActive
			});
		}

		// 4. CFO
		if (!skipRest) {
			var cfoDone = !!(pr.CfoAction || pr.CfoProcessedBy);
			var cfoActive = status === "PENDING_CFO";
			var cfoTime = pr.CfoAt || (cfoDone ? pr.UpdatedAt : "");
			var cfoSub = "";
			if (pr.CfoAction === "APPROVED") {
				cfoSub = "Đã duyệt" + (pr.CfoProcessedBy ? " · " + pr.CfoProcessedBy : "");
			} else if (pr.CfoAction === "ESCALATED") {
				cfoSub = "Leo thang CEO" + (pr.CfoProcessedBy ? " · " + pr.CfoProcessedBy : "");
			} else if (pr.CfoAction === "REJECTED") {
				cfoSub = "Từ chối" + (pr.CfoProcessedBy ? " · " + pr.CfoProcessedBy : "");
			} else if (cfoActive) {
				cfoSub = "Đang chờ";
			} else if (purchasingDone && pr.PurchasingAction === "APPROVED") {
				cfoSub = "Tiếp theo";
			}

			steps.push({
				title: "CFO",
				icon: pr.CfoAction === "REJECTED"
					? "sap-icon://decline"
					: (pr.CfoAction === "ESCALATED" ? "sap-icon://arrow-top" : "sap-icon://customer-financial-fact-sheet"),
				timeText: formatViTime(cfoTime),
				sub: cfoSub,
				done: cfoDone,
				active: cfoActive
			});
		}

		// 5. CEO (khi cần)
		var needCeo = !skipRest && pr.CfoAction !== "REJECTED" && (
			pr.needsProcurementHeadReview
			|| pr.CfoAction === "ESCALATED"
			|| status === "PENDING_CEO"
			|| pr.CeoAction
			|| pr.CeoProcessedBy
		);

		if (needCeo) {
			var ceoDone = !!(pr.CeoAction || pr.CeoProcessedBy);
			var ceoActive = status === "PENDING_CEO";
			var ceoTime = pr.CeoAt || (ceoDone ? pr.UpdatedAt : "");
			var ceoSub = "";
			if (pr.CeoAction === "APPROVED") {
				ceoSub = "Đã duyệt" + (pr.CeoProcessedBy ? " · " + pr.CeoProcessedBy : "");
			} else if (pr.CeoAction === "REJECTED") {
				ceoSub = "Từ chối" + (pr.CeoProcessedBy ? " · " + pr.CeoProcessedBy : "");
			} else if (ceoActive) {
				ceoSub = "Đang chờ";
			}

			steps.push({
				title: "CEO",
				icon: pr.CeoAction === "REJECTED" ? "sap-icon://decline" : "sap-icon://manager",
				timeText: formatViTime(ceoTime),
				sub: ceoSub,
				done: ceoDone,
				active: ceoActive
			});
		}

		// 6. Kết thúc.
		// PO_CREATED PHAI tinh la da hoan tat: ngay sau khi tao PO, backend doi
		// Status APPROVED -> PO_CREATED (de PR bien khoi danh sach cho tao PO cua
		// PO-01), nen neu chi check APPROVED thi PR cang di xa (da co PO) buoc cuoi
		// lai cang hien "Chua hoan tat" (feedback 14/08). Voi pham vi do an
		// (GR/Invoice khong code), PO_CREATED chinh la trang thai ket thuc.
		var isApproved = status === "APPROVED" || status === "OPENED" || status === "OPEN";
		var isPoCreated = status === "PO_CREATED";
		var isRejected = status === "REJECTED";
		var finalDone = isApproved || isPoCreated || isRejected;
		var finalTime = finalDone ? (pr.UpdatedAt || pr.CeoAt || pr.CfoAt || pr.PurchasingAt || "") : "";
		var finalTitle = "Hoàn tất";
		var finalSub = "Chưa hoàn tất";
		var finalIcon = "sap-icon://complete";

		if (isPoCreated) {
			finalTitle = "Hoàn tất — Đã tạo PO";
			finalSub = pr.SapPRId ? ("PR SAP: " + pr.SapPRId) : "Đã tạo Purchase Order";
			finalIcon = "sap-icon://sales-order";
		} else if (isApproved) {
			finalTitle = "Đã phê duyệt";
			finalSub = (pr.SapPRId ? ("SAP: " + pr.SapPRId) : "Đã duyệt") + " — chờ tạo PO";
			finalIcon = "sap-icon://accept";
		} else if (isRejected) {
			finalTitle = "Từ chối";
			finalSub = pr.DecidedByRole ? ("Bởi " + pr.DecidedByRole) : "";
			finalIcon = "sap-icon://decline";
		}

		steps.push({
			title: finalTitle,
			icon: finalIcon,
			timeText: formatViTime(finalTime),
			sub: finalSub,
			done: finalDone,
			active: false
		});

		return steps;
	}

	function buildStatusHint(pr) {
		var st = String((pr && pr.Status) || "").toUpperCase();
		if (st === "PENDING_PURCHASING") {
			return { text: "Đang chờ Bộ phận mua sắm (Purchasing) xem xét.", type: "Warning" };
		}
		if (st === "PENDING_RFQ") {
			return { text: "Purchasing đang lập yêu cầu báo giá (RFQ) cho đề nghị này.", type: "Warning" };
		}
		if (st === "RFQ_SENT") {
			return { text: "RFQ đã được gửi tới nhà cung cấp, đang chờ báo giá.", type: "Warning" };
		}
		if (st === "QUOTATIONS_RECEIVED") {
			return { text: "Đã nhận được báo giá, đang chờ Purchasing chốt nhà cung cấp.", type: "Warning" };
		}
		if (st === "PENDING_CFO") {
			return { text: "Đã qua Purchasing — đang chờ CFO phê duyệt.", type: "Warning" };
		}
		if (st === "PENDING_CEO") {
			return { text: "Giá trị cao — đang chờ CEO phê duyệt.", type: "Warning" };
		}
		if (st === "APPROVED" || st === "OPENED" || st === "OPEN") {
			return {
				text: pr.SapPRId
					? ("Đã phê duyệt. Số PR SAP: " + pr.SapPRId + " (ME53N).")
					: "Đã phê duyệt.",
				type: "Success"
			};
		}
		if (st === "REJECTED") {
			return {
				text: "Đề nghị đã bị từ chối" + (pr.Comment ? (": " + pr.Comment) : "."),
				type: "Error"
			};
		}
		if (st === "RETURNED") {
			return {
				text: "Đề nghị bị Purchasing trả lại" + (pr.Comment ? (": " + pr.Comment) : ".")
					+ " Bạn có thể sửa và gửi lại bằng nút bên dưới.",
				type: "Error"
			};
		}
		if (st === "CANCELLED") {
			return {
				text: "Đề nghị đã hủy" + (pr.Comment ? (" — " + pr.Comment) : " (đã được gửi lại bằng đề nghị mới)."),
				type: "Information"
			};
		}
		if (st === "PO_CREATED") {
			return {
				text: "Đã tạo Purchase Order từ đề nghị này"
					+ (pr.SapPRId ? (" (PR SAP: " + pr.SapPRId + ")") : "") + ".",
				type: "Success"
			};
		}
		return { text: "", type: "Information" };
	}

	return Controller.extend("com.qdavy.procurement.controller.PRDetail", {

		onInit: function () {
			this.getView().setModel(new JSONModel({
				timeline: [],
				statusHint: "",
				statusStripType: "Information"
			}));

			this.getOwnerComponent().getRouter()
				.getRoute("prdetail")
				.attachPatternMatched(this._onRouteMatched, this);
		},

		_onRouteMatched: function (oEvent) {
			this._sPrId = oEvent.getParameter("arguments").prId;
			this._loadDetail();
		},

		onRefreshPress: function () {
			this._loadDetail();
		},

		_loadDetail: function () {
			var oView = this.getView();
			var oModel = oView.getModel();

			if (!this._sPrId) { return; }

			oView.setBusy(true);

			this._fetchWithTimeout(BACKEND + "/api/approval/" + encodeURIComponent(this._sPrId))
				.then(function (oResult) {
					oView.setBusy(false);
					if (!oResult || !oResult.success) {
						MessageBox.error((oResult && oResult.message) || "Không tải được chi tiết đề nghị mua sắm.");
						return;
					}
					var pr = oResult.data || {};
					var hint = buildStatusHint(pr);

					// Gộp data PR + timeline + hint vào 1 model
					pr.timeline = buildTimeline(pr);
					pr.statusHint = hint.text;
					pr.statusStripType = hint.type;

					// Chỉ chính người tạo mới được sửa & gửi lại, và chỉ khi PR đang RETURNED
					var sUserEmail = String(
						this.getOwnerComponent().getModel("user").getProperty("/email") || ""
					).toLowerCase();
					pr.canResubmit = String(pr.Status || "").toUpperCase() === "RETURNED"
						&& String(pr.RequesterEmail || "").toLowerCase() === sUserEmail;

					oModel.setData(pr);
				}.bind(this))
				.catch(function (oError) {
					oView.setBusy(false);
					MessageBox.error(oError.message);
				});
		},

		formatStatusText: function (sStatus) {
			return STATUS_LABELS[sStatus] || sStatus || "";
		},

		formatStatusState: function (sStatus) {
			return STATUS_STATES[sStatus] || "None";
		},

		formatValue: function (fValue, sCurrency) {
			if (fValue === undefined || fValue === null) { return ""; }
			return Number(fValue).toLocaleString("vi-VN") + " " + (sCurrency || "VND");
		},

		formatDateTime: function (sIso) {
			return formatViTime(sIso);
		},

		formatDecisionMeta: function (sEmail, sUpdatedAt) {
			var s = "Quyết định bởi: " + (sEmail || "—");
			if (sUpdatedAt) {
				s += " lúc " + formatViTime(sUpdatedAt);
			}
			return s;
		},

		// PR bị trả lại (RETURNED) → mang toàn bộ dữ liệu sang PR-01 để sửa & gửi lại.
		// Truyền qua model "resubmit" cấp Component (không cần thêm route param mới).
		onResubmitPress: function () {
			var pr = this.getView().getModel().getData() || {};
			this.getOwnerComponent().setModel(new JSONModel({
				internalId: pr.InternalId,
				prId: pr.PRId,
				returnReason: pr.Comment || "",
				currency: pr.Currency || "VND",
				items: pr.items || []
			}), "resubmit");
			this.getOwnerComponent().getRouter().navTo("pr01");
		},

		// Quay ve DUNG man vua roi khoi, khong doan theo role nua.
		//
		// Ban cu suy dich den tu role: Purchasing/CFO/CEO -> luon ve pr02 (Phe duyet).
		// Nhung 3 vai tro do cung mo chi tiet PR tu man Lich su de nghi (History.js:146),
		// nen bam Back tu Lich su lai nhay sang Phe duyet — sai man, va man Phe duyet
		// thuong rong nen nhin nhu mat du lieu.
		//
		// Man chi tiet co dung 2 loi vao: History va PR02. Thay vi doan, doc lich su
		// dieu huong cua router — dung ca khi sau nay them loi vao thu ba.
		onNavBack: function () {
			if (RoutingHistory.getInstance().getPreviousHash() !== undefined) {
				window.history.go(-1);
				return;
			}

			// Khong co lich su trong app (vd dan thang URL /#/pr-detail/... vao trinh
			// duyet): moi chon man theo role. navTo(..., true) de thay hash hien tai,
			// tranh de lai mot buoc lui vo nghia.
			var sRole = String(this.getOwnerComponent().getModel("user").getProperty("/role") || "").toUpperCase();
			var sTarget = "dashboard";
			if (sRole === "CFO" || sRole === "CEO" || sRole === "PURCHASING") {
				sTarget = "pr02";
			} else if (sRole === "REQUESTER") {
				sTarget = "history";
			}
			this.getOwnerComponent().getRouter().navTo(sTarget, {}, true);
		},

		_fetchWithTimeout: function (sUrl, oOptions) {
			var oAbort = (typeof AbortController !== "undefined") ? new AbortController() : null;
			var iTimer = oAbort ? setTimeout(function () { oAbort.abort(); }, REQUEST_TIMEOUT_MS) : null;

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
								throw new Error("Bạn không có quyền xem đề nghị này.");
							}
							if (oResponse.status === 404) {
								throw new Error("Không tìm thấy đề nghị mua sắm.");
							}
							if (oResponse.status >= 500) {
								throw new Error("Máy chủ đang gặp sự cố, vui lòng thử lại sau.");
							}
							return oBody;
						});
				})
				.catch(function (oError) {
					if (iTimer) { clearTimeout(iTimer); }
					if (oError && oError.name === "AbortError") {
						throw new Error("Server phản hồi quá lâu. Vui lòng thử lại.");
					}
					if (oError instanceof TypeError) {
						throw new Error("Không thể kết nối tới máy chủ.");
					}
					throw oError;
				});
		}
	});
});