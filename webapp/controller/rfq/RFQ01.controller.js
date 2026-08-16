sap.ui.define([
	"sap/ui/core/mvc/Controller",
	"sap/ui/model/json/JSONModel",
	"sap/m/MessageBox",
	"sap/m/MessageToast",
	"sap/ui/model/Filter",
	"sap/ui/model/FilterOperator",
	"com/qdavy/procurement/model/Config"
], function (Controller, JSONModel, MessageBox, MessageToast, Filter, FilterOperator, Config) {
	"use strict";

	var BACKEND = Config.BACKEND;

	return Controller.extend("com.qdavy.procurement.controller.rfq.RFQ01", {

		onInit: function () {
			this.getView().setModel(new JSONModel({
				PendingPRs: [],
				Vendors: [],
				// aiMessages: mang {role:"user"|"ai", text} — nguon du lieu that cua khung chat.
				// aiChatHtml: HTML da render san tu aiMessages (xem _renderAiChat), view chi
				// bind vao day de hien bong bong cuon duoc thay vi 1 MessageStrip dai dan.
				aiMessages: [],
				aiChatHtml: "",
				busyAi: false,
				selectedVendorCount: 0,
				hasSelectedPR: false,
				selectedPRLabel: "",
				// ── TACH RFQ THEO NHOM DONG (16/08/2026) ──
				// PRItems: cac dong vat tu cua PR dang chon. Moi dong co them:
				//   _assigned   = dong nay da nam trong 1 RFQ khac (khong tick lai duoc)
				//   _assignedTo = ma RFQ dang giu dong do, de hien cho nguoi dung biet
				// selectedLineCount: so dong dang tick — nut "Tao & Gui RFQ" doi > 0.
				// groupHint: cau tom tat trang thai chia nhom hien tren MessageStrip.
				PRItems: [],
				selectedLineCount: 0,
				groupHint: "",
				busyGroupAi: false,
				// aiGroups: cac the "AI goi y chia nhom" dang hien (xem _showGroupSuggestion)
				aiGroups: []
			}));

			// Hien vong xoay NGAY khi bat busy. Mac dinh UI5 tre 1 giay: trong 1 giay do
			// trang trong nhu binh thuong nhung da bi khoa, nguoi dung bam khong an va
			// tuong la loi giao dien (phai F5). Dat 0 de trang thai cho luon nhin thay duoc.
			this.getView().setBusyIndicatorDelay(0);

			// Khong cho chon Deadline trong qua khu — truoc day DatePicker khong co minDate
			// nen chon duoc ca ngay da qua, chi bi bo lo (khong bao gio ai kiem tra ca FE lan BE).
			var oToday = new Date();
			oToday.setHours(0, 0, 0, 0);
			var oDeadlinePicker = this.getView().byId("dpDeadline");
			oDeadlinePicker.setMinDate(oToday);
			oDeadlinePicker.setBusyIndicatorDelay(0);

			// Goi y san han nop = hom nay + 7 ngay (van sua duoc), do gan nhu lan nao
			// nguoi dung cung phai tu mo lich chon mot ngay trong tuan toi.
			var oDefaultDeadline = new Date(oToday.getTime());
			oDefaultDeadline.setDate(oDefaultDeadline.getDate() + 7);
			oDeadlinePicker.setDateValue(oDefaultDeadline);

			this.getView().byId("pendingPRTable").setBusyIndicatorDelay(0);
			this.getView().byId("vendorTable").setBusyIndicatorDelay(0);

			this._loadPendingPRs();
			this._loadVendors();

			this.getOwnerComponent().getRouter()
				.getRoute("rfq01")
				.attachPatternMatched(this._onRouteMatched, this);
		},

		_onRouteMatched: function () {
			this._clearPRSelection();
			this._loadPendingPRs();
		},

		// Xoa trang thai PR dang chon. KHONG con setVisible(false) tren vung ben phai:
		// vung do la mot contentArea cua sap.ui.layout.Splitter, ma Splitter chi chia lai
		// be rong cho cac area o lan render dau. Neu area bat dau bang visible="false"
		// thi luc setVisible(true) sau nay Splitter khong tinh lai layout -> cot phai ra
		// mot mang trang, phai bam qua lai giua 2 PR (ep invalidate them lan nua) moi hien.
		// Nay vung phai LUON duoc render, chi doi noi dung theo PR dang chon.
		_clearPRSelection: function () {
			var oView = this.getView();
			this._currentPR = null;
			oView.getModel().setProperty("/aiMessages", []);
			oView.getModel().setProperty("/aiChatHtml", "");
			oView.getModel().setProperty("/hasSelectedPR", false);
			oView.getModel().setProperty("/selectedPRLabel", "");
			oView.getModel().setProperty("/selectedVendorCount", 0);
			oView.getModel().setProperty("/PRItems", []);
			oView.getModel().setProperty("/selectedLineCount", 0);
			oView.getModel().setProperty("/groupHint", "");
			oView.getModel().setProperty("/aiGroups", []);
			var oVendorTable = oView.byId("vendorTable");
			if (oVendorTable) { oVendorTable.removeSelections(true); }
			var oItemTable = oView.byId("prItemTable");
			if (oItemTable) { oItemTable.removeSelections(true); }
		},

		// ── CHUAN HOA SO DONG ──
		// FE/SAP co the ra "1" hoac "00001" tuy cho. Phai dem 0 ve dung 5 ky tu truoc
		// khi so sanh, khong thi cung 1 dong ma bi coi la 2 dong khac nhau. Giong het
		// normalizeLineNo() ben src/services/rfq.service.js — sua ben nao nho sua ben kia.
		_normalizeLineNo: function (vValue) {
			var s = String(vValue === undefined || vValue === null ? "" : vValue).trim();
			if (!s) { return ""; }
			return /^\d+$/.test(s) ? ("00000" + s).slice(-5) : s;
		},

		// Tu danh sach RFQ doc tu /api/rfq -> map { <khoa PR> : { <soDong>: <maRFQ> } }.
		// Khoa PR gom ca PrId lan SapPrNumber vi RfqSet luu 1 trong 2 tuy thoi diem tao.
		// RFQ co ItemLines RONG = RFQ kieu cu, phu kin TOAN BO dong cua PR (quy uoc da
		// chot o backend) — danh dau bang "*" de ham tra cuu hieu la "het dong roi".
		_buildAssignedMap: function (aRfqs) {
			var that = this;
			var mMap = {};
			(aRfqs || []).forEach(function (rfq) {
				var aKeys = [String(rfq.PrId || "").trim(), String(rfq.SapPrNumber || "").trim()]
					.filter(Boolean);
				if (aKeys.length === 0) { return; }
				var sLines = String(rfq.ItemLines || "").trim();
				var aLines = sLines ? sLines.split(",") : ["*"];
				aKeys.forEach(function (sKey) {
					mMap[sKey] = mMap[sKey] || {};
					aLines.forEach(function (sLine) {
						var sNorm = sLine === "*" ? "*" : that._normalizeLineNo(sLine);
						if (sNorm) { mMap[sKey][sNorm] = String(rfq.RfqId || ""); }
					});
				});
			});
			return mMap;
		},

		/** Ma RFQ dang giu dong nay, hoac "" neu dong con trong. */
		_assignedRfqOf: function (mAssigned, oPR, sLineNo) {
			var that = this;
			var aKeys = [oPR.PRId, oPR.SapPRId, oPR.InternalId]
				.map(function (v) { return String(v || "").trim(); })
				.filter(Boolean);
			var sHit = "";
			aKeys.forEach(function (sKey) {
				var mLines = mAssigned[sKey];
				if (!mLines) { return; }
				if (mLines["*"]) { sHit = sHit || mLines["*"]; }
				var sNorm = that._normalizeLineNo(sLineNo);
				if (mLines[sNorm]) { sHit = sHit || mLines[sNorm]; }
			});
			return sHit;
		},

		// ── 1. PR DA DUOC PURCHASING DUYET HOP LE (PENDING_RFQ) — chi trang thai nay
		// moi duoc mo RFQ. (Truoc day lay PENDING_PURCHASING, da doi theo quy trinh moi:
		// Purchasing phai bam Duyet tren PR-02 truoc, PR moi xuat hien o day.) ──
		_loadPendingPRs: function () {
			var oView = this.getView();
			var that = this;
			// CHI khoa rieng bang PR, khong khoa ca view: truoc day dung oView.setBusy(true)
			// nen trong suot thoi gian goi API (SAP OData + cold start cua serverless co the
			// vai giay) thi DatePicker va nut "Tao & Gui RFQ" o card 3 cung bi khoa theo,
			// dung dung dan toi trieu chung "bam khong an, phai F5".
			var oTable = oView.byId("pendingPRTable");
			oTable.setBusy(true);

			// Doc SONG SONG danh sach PR cho xu ly va TOAN BO RFQ da co. Truoc day chi
			// can PR: 1 PR = 1 RFQ nen chi viec loc `!pr.RfqId` la du. Nay 1 PR co the
			// co NHIEU RFQ (moi nhom dong 1 cai), nen phai doi chieu tung DONG xem con
			// dong nao chua duoc gan khong — con thi PR van phai hien o day de tao tiep.
			Promise.all([
				fetch(BACKEND + "/api/approval/pending?role=PURCHASING&status=PENDING_RFQ")
					.then(function (r) { return r.json(); }),
				fetch(BACKEND + "/api/rfq")
					.then(function (r) { return r.json(); })
					.catch(function () { return { success: false, data: [] }; })
			])
				.then(function (aRes) {
					oTable.setBusy(false);
					var resPR = aRes[0];
					var resRfq = aRes[1];
					if (!resPR || !resPR.success) { return; }

					var mAssigned = that._buildAssignedMap((resRfq && resRfq.data) || []);
					that._assignedMap = mAssigned;

					var aMapped = (resPR.data || []).map(function (pr) {
						var aItems = pr.items || [];
						var aFree = aItems.filter(function (it) {
							return !that._assignedRfqOf(mAssigned, pr, it.LineNo);
						});
						return { _pr: pr, _items: aItems, _free: aFree };
					}).filter(function (o) {
						// Con it nhat 1 dong chua co RFQ thi PR moi con viec de lam o man nay.
						return o._free.length > 0;
					}).map(function (o) {
						var pr = o._pr;
						var firstItem = o._items[0] || {};
						var sDesc = o._items.length > 1
							? (firstItem.Description || "") + " (+ " + (o._items.length - 1) + " vật tư khác)"
							: (firstItem.Description || "");
						return {
							PRId: pr.PRId || pr.InternalId || "",
							SapPRId: pr.SapPRId || "",
							InternalId: pr.InternalId || "",
							Description: sDesc,
							RequesterEmail: pr.RequesterEmail || "",
							TotalValue: pr.TotalValue || 0,
							Currency: pr.Currency || "VND",
							// Hien ngay tren danh sach: PR nao dang chia do dang thi biet lien,
							// khoi phai bam vao moi thay.
							LineSummary: o._free.length === o._items.length
								? o._items.length + " dòng"
								: (o._items.length - o._free.length) + "/" + o._items.length + " dòng đã có RFQ",
							_items: o._items
						};
					});
					oView.getModel().setProperty("/PendingPRs", aMapped);
					that._autoSelectFirstPR();
				})
				.catch(function () {
					oTable.setBusy(false);
					MessageToast.show("Không thể lấy danh sách PR từ máy chủ.");
				});
		},

		// ── 2. DANH SACH NCC TU SAP ──
		_loadVendors: function () {
			var oView = this.getView();
			var oTable = oView.byId("vendorTable");
			oTable.setBusy(true);
			fetch(BACKEND + "/api/vendors")
				.then(function (r) { return r.json(); })
				.then(function (res) {
					oTable.setBusy(false);
					if (res && res.success) {
						oView.getModel().setProperty("/Vendors", res.data || []);
					}
				})
				.catch(function () {
					oTable.setBusy(false);
					MessageToast.show("Không tải được danh sách Nhà cung cấp.");
				});
		},

		onVendorSelectionChange: function () {
			var iCount = this.getView().byId("vendorTable").getSelectedItems().length;
			this.getView().getModel().setProperty("/selectedVendorCount", iCount);
		},

		// Tim PR dang cho xu ly theo ma PR / mo ta / email nguoi yeu cau.
		// Loc client tren binding /PendingPRs — khong goi lai SAP.
		onPendingPRSearch: function (oEvent) {
			var sQuery = (oEvent.getParameter("newValue") !== undefined
				? oEvent.getParameter("newValue")
				: oEvent.getParameter("query")) || "";
			var oTable = this.getView().byId("pendingPRTable");
			var oBinding = oTable && oTable.getBinding("items");
			if (!oBinding) { return; }
			if (!sQuery.trim()) {
				oBinding.filter([]);
				return;
			}
			oBinding.filter(new Filter({
				filters: [
					new Filter("PRId", FilterOperator.Contains, sQuery),
					new Filter("Description", FilterOperator.Contains, sQuery),
					new Filter("RequesterEmail", FilterOperator.Contains, sQuery)
				],
				and: false
			}));
		},

		// Loc danh sach NCC theo ma / ten / email — loc phia client tren binding,
		// khong goi lai SAP (feedback QDAVY 13/08: kho tim NCC khi danh sach dai).
		onVendorSearch: function (oEvent) {
			var sQuery = (oEvent.getParameter("newValue") !== undefined
				? oEvent.getParameter("newValue")
				: oEvent.getParameter("query")) || "";
			var oBinding = this.getView().byId("vendorTable").getBinding("items");
			if (!oBinding) { return; }
			if (!sQuery.trim()) {
				oBinding.filter([]);
				return;
			}
			oBinding.filter(new Filter({
				filters: [
					new Filter("VendorNo", FilterOperator.Contains, sQuery),
					new Filter("VendorName", FilterOperator.Contains, sQuery),
					new Filter("Email", FilterOperator.Contains, sQuery)
				],
				and: false
			}));
		},

		// NCC vua duoc tao them tren SAP (BP/XK01) -> tai lai ma khong can F5 ca trang.
		onReloadVendorsPress: function () {
			this._loadVendors();
			MessageToast.show("Đang tải lại danh sách Nhà cung cấp từ SAP...");
		},

		onPRSelect: function (oEvent) {
			var oSelectedItem = oEvent.getParameter("listItem");
			if (!oSelectedItem) { return; }
			this._applyPRSelection(oSelectedItem);
		},

		_applyPRSelection: function (oSelectedItem) {
			var oContext = oSelectedItem && oSelectedItem.getBindingContext();
			var oPRData = oContext ? oContext.getObject() : null;
			if (!oPRData) { return; }

			var that = this;
			var oView = this.getView();
			this._currentPR = oPRData;
			oView.getModel().setProperty("/aiMessages", []);
			oView.getModel().setProperty("/aiChatHtml", "");
			oView.getModel().setProperty("/aiGroups", []);
			oView.getModel().setProperty("/hasSelectedPR", true);
			oView.getModel().setProperty(
				"/selectedPRLabel",
				"PR " + (oPRData.PRId || "") + " · " + (oPRData.Description || "")
			);
			oView.byId("vendorTable").removeSelections(true);
			oView.getModel().setProperty("/selectedVendorCount", 0);

			// Do bang dong vat tu de nguoi dung chon nhung dong thuoc nhom RFQ lan nay.
			var mAssigned = this._assignedMap || {};
			var aRows = (oPRData._items || []).map(function (it) {
				var sRfq = that._assignedRfqOf(mAssigned, oPRData, it.LineNo);
				return {
					LineNo: it.LineNo || "",
					MaterialNo: it.MaterialNo || "",
					Description: it.Description || "",
					Quantity: it.Quantity || 0,
					UoM: it.UoM || "",
					EstimatedValue: it.EstimatedValue || 0,
					Currency: oPRData.Currency || "VND",
					_assigned: !!sRfq,
					_assignedTo: sRfq || "",
					StatusText: sRfq ? ("Đã thuộc " + sRfq) : "Chưa có RFQ"
				};
			});
			oView.getModel().setProperty("/PRItems", aRows);
			oView.getModel().setProperty("/selectedLineCount", 0);

			var oItemTable = oView.byId("prItemTable");
			if (oItemTable) { oItemTable.removeSelections(true); }

			// Mac dinh tick san MOI dong con trong: PR chi mua tu 1 NCC (da so truong hop)
			// thi nguoi dung khong phai lam gi them, bam Tao & Gui la xong nhu truoc day.
			// Muon tach nhom thi bo tick bot — chu dong hon la bat tick tay tu dau.
			this._selectFreeLines();
			this._updateGroupHint();
		},

		/** Tick san toan bo dong chua thuoc RFQ nao. */
		_selectFreeLines: function () {
			var oView = this.getView();
			var oTable = oView.byId("prItemTable");
			if (!oTable) { return; }
			var aRows = oView.getModel().getProperty("/PRItems") || [];
			var fnApply = function () {
				oTable.removeSelections(true);
				oTable.getItems().forEach(function (oItem) {
					var oCtx = oItem.getBindingContext();
					var oRow = oCtx && oCtx.getObject();
					if (oRow && !oRow._assigned) { oTable.setSelectedItem(oItem, true); }
				});
				this.onItemSelectionChange();
			}.bind(this);

			// JSONModel.setProperty cap nhat binding dong bo nen thuong da co items ngay;
			// neu chua (lan render dau) thi doi updateFinished. Giong _autoSelectFirstPR.
			if (oTable.getItems().length >= aRows.length && aRows.length > 0) {
				fnApply();
			} else {
				oTable.attachEventOnce("updateFinished", fnApply);
			}
		},

		onItemSelectionChange: function () {
			var oTable = this.getView().byId("prItemTable");
			if (!oTable) { return; }
			// Chan tick nhung dong da thuoc RFQ khac: chung van hien de nguoi dung biet
			// PR nay dang chia do dang, nhung khong duoc gan lai vao RFQ moi.
			var aInvalid = oTable.getSelectedItems().filter(function (oItem) {
				var oCtx = oItem.getBindingContext();
				var oRow = oCtx && oCtx.getObject();
				return oRow && oRow._assigned;
			});
			if (aInvalid.length) {
				aInvalid.forEach(function (oItem) { oTable.setSelectedItem(oItem, false); });
				MessageToast.show("Dòng này đã thuộc một RFQ khác của PR — không thể đưa vào RFQ mới.");
			}
			this.getView().getModel().setProperty("/selectedLineCount", oTable.getSelectedItems().length);
			this._updateGroupHint();
		},

		_updateGroupHint: function () {
			var oModel = this.getView().getModel();
			var aRows = oModel.getProperty("/PRItems") || [];
			var iTotal = aRows.length;
			var iAssigned = aRows.filter(function (r) { return r._assigned; }).length;
			var iSelected = oModel.getProperty("/selectedLineCount") || 0;
			var iFree = iTotal - iAssigned;

			var sHint = "PR có " + iTotal + " dòng. ";
			if (iAssigned > 0) { sHint += iAssigned + " dòng đã thuộc RFQ trước đó. "; }
			sHint += "Đang chọn " + iSelected + "/" + iFree + " dòng còn lại cho RFQ này.";
			if (iSelected > 0 && iSelected < iFree) {
				sHint += " Sau khi gửi xong nhóm này, PR vẫn ở lại đây để bạn tạo tiếp nhóm cho "
					+ (iFree - iSelected) + " dòng còn lại.";
			}
			oModel.setProperty("/groupHint", sHint);
		},

		// Tu dong chon dong PR dau tien khi vao man / sau khi tai lai danh sach, de cot
		// phai co noi dung ngay thay vi bat nguoi dung phai bam. JSONModel.setProperty()
		// cap nhat binding DONG BO nen "updateFinished" thuong da ban ra TRUOC khi ham
		// nay kip attachEventOnce -> phai kiem tra getItems() trong luc truoc.
		_autoSelectFirstPR: function () {
			var oTable = this.getView().byId("pendingPRTable");
			if (!oTable) { return; }
			var fnSelectFirst = function () {
				var aItems = oTable.getItems();
				if (aItems.length === 0) {
					this._clearPRSelection();
					return;
				}
				// Vua tao xong 1 nhom cho PR nay ma no con dong chua hoi gia -> chon lai
				// DUNG PR do thay vi nhay ve PR dau danh sach, de nguoi dung lam tiep nhom
				// sau ngay. _reselectPRId chi dung 1 lan roi xoa.
				var oTarget = aItems[0];
				if (this._reselectPRId) {
					var sWanted = String(this._reselectPRId);
					var oMatch = aItems.filter(function (oItem) {
						var oRow = oItem.getBindingContext() && oItem.getBindingContext().getObject();
						return oRow && String(oRow.PRId) === sWanted;
					})[0];
					if (oMatch) { oTarget = oMatch; }
					this._reselectPRId = null;
				}
				oTable.setSelectedItem(oTarget, true);
				this._applyPRSelection(oTarget);
			}.bind(this);

			if (oTable.getItems().length > 0) {
				fnSelectFirst();
			} else {
				oTable.attachEventOnce("updateFinished", fnSelectFirst);
			}
		},

		// ── Khung chat AI: /aiMessages ({role, text}) la nguon du lieu that, ham nay ve lai
		// thanh HTML (bong bong user/AI) roi ghi vao /aiChatHtml de view render + tu cuon.
		// Dung sap.ui.core.HTML thay vi MessageStrip/FormattedText — truoc day toan bo lich
		// su chat bi noi chuoi vao 1 MessageStrip duy nhat, khong co khung cuon rieng, cang
		// hoi nhieu the card cang phinh dai ra (feedback 15/08: "chat xong khong nhin het
		// duoc"). FormattedText khong dung duoc vi bo loc HTML cua no xoa mat class/mau nen
		// bong bong; sap.ui.core.HTML khong loc nen giu duoc style, doi lai phai tu escape
		// text nguoi dung/AI truoc khi noi vao chuoi HTML (xem _escapeHtml).
		_escapeHtml: function (sText) {
			return String(sText || "")
				.replace(/&/g, "&amp;")
				.replace(/</g, "&lt;")
				.replace(/>/g, "&gt;")
				.replace(/"/g, "&quot;");
		},

		// Tin cua AI co the co dong ket luan "NCC ĐỀ XUẤT..." + cac gach dau dong "- " (xem quy
		// uoc dinh dang trong prompt o server.js: /api/ai/recommend-vendor,
		// /api/ai/compare-quotations, /api/ai/ask). Ham nay parse quy uoc do thanh HTML de nguoi
		// dung thay ngay ket luan + tung tieu chi ro rang, thay vi phai doc het 1 doan van xuoi
		// dai (feedback 15/08: "muon no ket luan gop y NCC nao luon", "format de nhin hon hon").
		// Tin cua NGUOI DUNG (cau hoi) khong qua ham nay trong _renderAiChat — chi la text
		// thuong, khong can parse gach dau dong.
		_formatAiMessageHtml: function (sText) {
			var that = this;
			var sConclusionPrefix = "NCC ĐỀ XUẤT";
			var aLines = String(sText || "").split("\n");
			var sHtml = "";
			var aBulletBuffer = [];

			function flushBullets() {
				if (aBulletBuffer.length === 0) { return; }
				sHtml += '<ul class="qdAiCriteriaList">' + aBulletBuffer.map(function (s) {
					return "<li>" + that._escapeHtml(s) + "</li>";
				}).join("") + "</ul>";
				aBulletBuffer = [];
			}

			aLines.forEach(function (sLine) {
				var sTrim = sLine.trim();
				if (!sTrim) { return; } // dong trong chi de tach doan, khong render gi
				if (sTrim.indexOf(sConclusionPrefix) === 0) {
					flushBullets();
					var iColon = sTrim.indexOf(":");
					var sValue = (iColon >= 0 ? sTrim.substring(iColon + 1) : "").trim();
					sHtml += '<div class="qdAiConclusion"><span class="qdAiConclusionLabel">'
						+ '🏆 NCC đề xuất</span><span class="qdAiConclusionValue">'
						+ that._escapeHtml(sValue) + "</span></div>";
				} else if (sTrim.indexOf("- ") === 0 || sTrim.indexOf("• ") === 0) {
					aBulletBuffer.push(sTrim.substring(2).trim());
				} else {
					flushBullets();
					sHtml += '<p class="qdAiParagraph">' + that._escapeHtml(sTrim) + "</p>";
				}
			});
			flushBullets();

			// AI khong tra loi dung quy uoc (hiem, vd loi mang giua chung) thi van hien nguyen
			// van thay vi mat trang — fallback an toan.
			return sHtml || ('<p class="qdAiParagraph">' + that._escapeHtml(sText) + "</p>");
		},

		_renderAiChat: function () {
			var oView = this.getView();
			var oModel = oView.getModel();
			var aMessages = oModel.getProperty("/aiMessages") || [];
			var that = this;

			// Nhan "AI goi y" / "Ban hoi" CHI hien khi DOI nguoi noi. Truoc day bong bong
			// nao cung deo nhan, nen 2-3 luot AI tra loi lien tiep la man hinh lap lai chu
			// "AI GOI Y" may lan lien, nhin nhu bi trung lap (feedback 16/08). Cac luot noi
			// tiep cua cung mot nguoi gio chi con bong bong, giong moi app chat binh thuong.
			var sHtml = aMessages.map(function (m, idx) {
				var bUser = m.role === "user";
				var bFollow = idx > 0 && aMessages[idx - 1].role === m.role;
				var sRowClass = "qdAiChatRow " + (bUser ? "qdAiChatRowUser" : "qdAiChatRowAi")
					+ (bFollow ? " qdAiChatRowFollow" : "");
				var sBubbleClass = "qdAiChatBubble " + (bUser ? "qdAiChatBubbleUser" : "qdAiChatBubbleAi");
				// pending = o da dat truoc, dang cho server tra loi. Ve 3 cham nhay thay vi
				// bong bong rong, de nguoi dung biet AI dang xu ly chu khong phai bi treo.
				var sBody = bUser
					? that._escapeHtml(m.text).replace(/\n/g, "<br/>")
					: (m.pending
						? '<span class="qdAiChatTyping"><i></i><i></i><i></i></span>'
						: that._formatAiMessageHtml(m.text));
				var sLabelHtml = bFollow
					? ""
					: '<span class="qdAiChatLabel">' + (bUser ? "Bạn hỏi" : "AI gợi ý") + '</span>';
				// Avatar chi ve o luot dau cua AI; luot noi tiep van giu 1 o AN (Ghost) de
				// bong bong khong bi thut ra sat le trai, lech voi bong bong phia tren.
				var sAvatar = bUser
					? ""
					: '<span class="qdAiChatAvatar' + (bFollow ? " qdAiChatAvatarGhost" : "") + '">AI</span>';
				return '<div class="' + sRowClass + '">' + sAvatar
					+ '<div class="' + sBubbleClass + '">' + sLabelHtml + sBody + '</div>'
					+ '</div>';
			}).join("");

			oModel.setProperty("/aiChatHtml", sHtml);

			// Tu cuon xuong tin moi nhat. setProperty cap nhat model dong bo nhung UI5 render
			// DOM bat dong bo (1 tick sau) — doi setTimeout 0 la du de scrollHeight moi da co.
			setTimeout(function () {
				var oScroll = oView.byId("aiChatScroll");
				if (oScroll && oScroll.getDomRef && oScroll.getDomRef()) {
					var oDom = oScroll.getDomRef("scroll") || oScroll.getDomRef();
					if (oDom) { oDom.scrollTop = oDom.scrollHeight; }
				}
			}, 0);
		},

		// ── 3. AI GOI Y NCC (dua tren vat tu dong dau + ngan sach cua PR dang chon) ──
		onAiSuggestPress: function () {
			if (!this._currentPR) {
				MessageToast.show("Hãy chọn một PR trước.");
				return;
			}
			var oModel = this.getView().getModel();
			var that = this;
			var aVendors = oModel.getProperty("/Vendors") || [];
			if (aVendors.length === 0) {
				MessageToast.show("Chưa có danh sách Nhà cung cấp để AI phân tích.");
				return;
			}

			var firstItem = (this._currentPR._items || [])[0] || {};
			oModel.setProperty("/busyAi", true);

			fetch(BACKEND + "/api/ai/recommend-vendor", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					materialName: firstItem.Description || "",
					materialGroup: firstItem.MaterialType || "",
					quantity: firstItem.Quantity || "",
					budget: this._currentPR.TotalValue || "",
					vendors: aVendors
				})
			})
				.then(function (r) { return r.json(); })
				.then(function (res) {
					oModel.setProperty("/busyAi", false);
					if (res && res.success) {
						// Bam lai "AI goi y NCC" thi bat dau lai mach chat tu dau (khong noi
						// vao lich su hoi dap cu cua goi y truoc — de tranh lan lon 2 lan goi y).
						oModel.setProperty("/aiMessages", [{ role: "ai", text: res.recommendation || "" }]);
						that._renderAiChat();
					} else {
						MessageToast.show((res && res.message) || "AI không phản hồi.");
					}
				})
				.catch(function () {
					oModel.setProperty("/busyAi", false);
					MessageToast.show("Không gọi được AI gợi ý.");
				});
		},

		// ── 3a. AI GOI Y CHIA NHOM DONG THEO NCC ──
		// Khac "AI goi y NCC" o tren (goi y 1 NCC cho ca PR): nut nay tra loi "PR nay
		// nen tach thanh may RFQ, moi nhom gom dong nao, moi ai". Ket qua dung de TICK
		// SAN checkbox — nguoi mua van sua tay thoai mai truoc khi bam gui, AI chi lam
		// ban nhap. Mot NCC co the ban nhieu nganh hang nen gop/tach lai la binh thuong.
		onAiSuggestGroupsPress: function () {
			var that = this;
			var oModel = this.getView().getModel();

			if (!this._currentPR) {
				MessageToast.show("Hãy chọn một PR trước.");
				return;
			}
			var aVendors = oModel.getProperty("/Vendors") || [];
			if (aVendors.length === 0) {
				MessageToast.show("Chưa có danh sách Nhà cung cấp để AI phân tích.");
				return;
			}
			// Chi hoi AI ve nhung dong CHUA thuoc RFQ nao — dong da chot roi thi khong
			// con gi de chia nua, dua vao chi lam nhieu context va de AI goi y nham.
			var aFree = (oModel.getProperty("/PRItems") || []).filter(function (r) { return !r._assigned; });
			if (aFree.length === 0) {
				MessageToast.show("Mọi dòng của PR này đều đã thuộc một RFQ.");
				return;
			}
			if (aFree.length === 1) {
				MessageToast.show("Chỉ còn 1 dòng — không cần chia nhóm, chọn NCC rồi gửi luôn.");
				return;
			}

			oModel.setProperty("/busyGroupAi", true);

			fetch(BACKEND + "/api/ai/suggest-rfq-groups", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ items: aFree, vendors: aVendors })
			})
				.then(function (r) { return r.json(); })
				.then(function (res) {
					oModel.setProperty("/busyGroupAi", false);
					if (!res || !res.success) {
						MessageToast.show((res && res.message) || "AI không phản hồi.");
						return;
					}
					// AI tra ve khong dung JSON: van hien nguyen van trong khung chat de
					// nguoi dung tu doc va chia tay, thay vi mat trang khong biet vi sao.
					if (!res.parsed || !(res.groups || []).length) {
						oModel.setProperty("/aiMessages", [{
							role: "ai",
							text: res.raw || "AI chưa đưa ra được phương án chia nhóm cho PR này."
						}]);
						that._renderAiChat();
						return;
					}
					that._aiGroups = res.groups;
					that._showGroupSuggestion(res);
				})
				.catch(function () {
					oModel.setProperty("/busyGroupAi", false);
					MessageToast.show("Không gọi được AI gợi ý chia nhóm.");
				});
		},

		/**
		 * Hien phuong an AI de xuat duoi dang THE (card) ngay trong trang — moi nhom 1 the
		 * co chip dong vat tu, chip NCC, ly do va nut "Ap dung". Truoc day dung
		 * MessageBox.show do nguyen ca doan van AI vao 1 hop thoai he thong: vua to vua
		 * che het man hinh, nut bam la chuoi text dai, va chan moi thao tac khac
		 * (feedback 16/08: "form nay to va xau qua"). The nam trong trang nen nguoi dung
		 * nhin duoc ca 2-3 nhom canh nhau, doi qua lai giua cac nhom thoai mai.
		 */
		_showGroupSuggestion: function (oRes) {
			var oModel = this.getView().getModel();
			var aGroups = oRes.groups || [];
			var aVendors = oModel.getProperty("/Vendors") || [];
			var mVendorName = {};
			aVendors.forEach(function (v) { mVendorName[String(v.VendorNo)] = v.VendorName || v.VendorNo; });

			var aPRItems = oModel.getProperty("/PRItems") || [];
			var mItemDesc = {};
			aPRItems.forEach(function (it) {
				mItemDesc[this._normalizeLineNo(it.LineNo)] = it.Description || it.LineNo;
			}.bind(this));

			// View-model cho tung the: chip hien MO TA vat tu (nguoi doc hieu ngay) thay vi
			// so dong kho hieu; ly do cat ngan — ban day du AI viet van nam trong g.reason,
			// ai can doc them thi bam "Hoi AI" o khung chat.
			var aCards = aGroups.map(function (g, i) {
				return {
					idx: i,
					name: g.name || ("Nhóm " + (i + 1)),
					lines: g.lines,
					vendorNos: g.vendorNos,
					itemChips: g.lines.map(function (l) {
						return mItemDesc[this._normalizeLineNo(l)] || ("Dòng " + l);
					}.bind(this)),
					vendorChips: g.vendorNos.map(function (no) { return mVendorName[no] || no; }),
					hasVendors: g.vendorNos.length > 0,
					reason: g.reason || "",
					applied: false
				};
			}.bind(this));

			oModel.setProperty("/aiGroups", aCards);

			// Khung chat chi con 1 cau dan ngan + canh bao dong bi sot (neu co) — noi dung
			// chinh da nam tren the, khong lap lai ca doan van nua.
			var sText = "Tôi đề xuất tách PR này thành " + aCards.length + " nhóm — xem các thẻ bên dưới, "
				+ "bấm \"Áp dụng\" ở nhóm muốn làm trước. Đây chỉ là bản nháp, bạn vẫn sửa lại được.";
			if ((oRes.missingLines || []).length) {
				sText += "\n- LƯU Ý: tôi chưa xếp được nhóm cho dòng " + oRes.missingLines.join(", ")
					+ " — bạn tự tích tay cho các dòng này.";
			}
			oModel.setProperty("/aiMessages", [{ role: "ai", text: sText }]);
			this._renderAiChat();
		},

		/** Bam "Ap dung" tren 1 the nhom. */
		onApplyGroupPress: function (oEvent) {
			var oCtx = oEvent.getSource().getBindingContext();
			var oCard = oCtx && oCtx.getObject();
			if (!oCard) { return; }
			this._applyGroupSuggestion(oCard);

			// Danh dau the dang ap dung de vien no sang len — nguoi dung biet minh dang
			// lam nhom nao trong khi cac the khac van bam doi qua lai duoc.
			var oModel = this.getView().getModel();
			var aCards = (oModel.getProperty("/aiGroups") || []).map(function (c) {
				return Object.assign({}, c, { applied: c.idx === oCard.idx });
			});
			oModel.setProperty("/aiGroups", aCards);
		},

		/** Dong day the goi y (nguoi dung muon tu chia tay). */
		onDismissGroupsPress: function () {
			this.getView().getModel().setProperty("/aiGroups", []);
		},

		/** Tick san dong + NCC theo 1 nhom AI de xuat. */
		_applyGroupSuggestion: function (oGroup) {
			var that = this;
			var oView = this.getView();
			var oItemTable = oView.byId("prItemTable");
			var oVendorTable = oView.byId("vendorTable");

			var mWanted = {};
			(oGroup.lines || []).forEach(function (l) { mWanted[that._normalizeLineNo(l)] = true; });

			if (oItemTable) {
				oItemTable.removeSelections(true);
				oItemTable.getItems().forEach(function (oItem) {
					var oRow = oItem.getBindingContext() && oItem.getBindingContext().getObject();
					if (oRow && !oRow._assigned && mWanted[that._normalizeLineNo(oRow.LineNo)]) {
						oItemTable.setSelectedItem(oItem, true);
					}
				});
				this.onItemSelectionChange();
			}

			var mVendor = {};
			(oGroup.vendorNos || []).forEach(function (no) { mVendor[String(no)] = true; });
			if (oVendorTable) {
				oVendorTable.removeSelections(true);
				oVendorTable.getItems().forEach(function (oItem) {
					var oRow = oItem.getBindingContext() && oItem.getBindingContext().getObject();
					if (oRow && mVendor[String(oRow.VendorNo)]) {
						oVendorTable.setSelectedItem(oItem, true);
					}
				});
				this.onVendorSelectionChange();
			}

			MessageToast.show("Đã tích sẵn nhóm \"" + oGroup.name + "\". Kiểm tra lại rồi bấm Tạo & Gửi RFQ.");
		},

		// ── 3b. HOI THEM AI (chat tuong tac tren nen du lieu NCC dang xem) ──
		// Server van an danh hoa ten/email NCC truoc khi goi AI nhu nut goi y chinh.
		onAiAskPress: function () {
			var oModel = this.getView().getModel();
			var that = this;
			var oInput = this.getView().byId("inAiQuestion");
			var sQuestion = (oInput.getValue() || "").trim();

			if (!sQuestion) {
				MessageToast.show("Hãy nhập câu hỏi trước.");
				return;
			}
			var aVendors = oModel.getProperty("/Vendors") || [];
			if (aVendors.length === 0) {
				MessageToast.show("Chưa có danh sách Nhà cung cấp để hỏi AI.");
				return;
			}

			var firstItem = ((this._currentPR && this._currentPR._items) || [])[0] || {};
			oModel.setProperty("/busyAi", true);

			// Them tin cua nguoi dung vao chat NGAY (khong doi API tra ve) de UX phan hoi tuc
			// thi — giong moi app chat khac, thay vi man hinh dung yen cho toi khi co ket qua.
			//
			// VA DAT SAN 1 O TRONG cho cau tra loi NGAY DUOI cau hoi vua gui.
			// Truoc day cau tra loi duoc .push() vao CUOI mang luc no ve tu server, nen hoi
			// lien 2 cau (chua kip tra loi cau dau) la thu tu thanh Q1, Q2, A1, A2 — cau hoi
			// don cuc mot cho, cau tra loi don cuc mot cho, nhin nhu bi lap va khong con la
			// hoi-dap tuan tu nua (feedback 16/08). Nay moi cau tra loi biet cho cua no.
			var sSlotId = "ai-" + Date.now() + "-" + Math.round(Math.random() * 1e6);
			var aMessages = (oModel.getProperty("/aiMessages") || []).slice();
			aMessages.push({ role: "user", text: sQuestion });
			aMessages.push({ role: "ai", text: "", pending: true, id: sSlotId });
			oModel.setProperty("/aiMessages", aMessages);
			that._renderAiChat();
			oInput.setValue("");

			// Dien cau tra loi (hoac loi) vao DUNG o da dat truoc, tra cuu theo id chu khong
			// theo vi tri — vi tri co the doi neu nguoi dung bam "AI goi y" (ham do reset ca
			// mach chat) trong luc dang cho tra loi.
			var fnFillSlot = function (sText) {
				var aNext = (oModel.getProperty("/aiMessages") || []).slice();
				for (var i = 0; i < aNext.length; i++) {
					if (aNext[i] && aNext[i].id === sSlotId) {
						aNext[i] = { role: "ai", text: sText, id: sSlotId };
						oModel.setProperty("/aiMessages", aNext);
						that._renderAiChat();
						return;
					}
				}
				// Khong tim thay o = mach chat da bi reset -> bo qua, khong noi vao cuoi.
			};

			fetch(BACKEND + "/api/ai/ask", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					context: "recommend-vendor",
					question: sQuestion,
					vendors: aVendors,
					materialName: firstItem.Description || "",
					materialGroup: firstItem.MaterialType || "",
					quantity: firstItem.Quantity || "",
					budget: (this._currentPR && this._currentPR.TotalValue) || ""
				})
			})
				.then(function (r) { return r.json(); })
				.then(function (res) {
					oModel.setProperty("/busyAi", false);
					if (res && res.success) {
						fnFillSlot(res.answer || "");
					} else {
						// Loi cung phai hien TRONG mach chat, khong chi bung toast roi de lai
						// bong bong "dang soan..." treo vinh vien.
						fnFillSlot("Xin lỗi, tôi chưa trả lời được câu này. "
							+ ((res && res.message) || "AI không phản hồi."));
						MessageToast.show((res && res.message) || "AI không phản hồi.");
					}
				})
				.catch(function () {
					oModel.setProperty("/busyAi", false);
					fnFillSlot("Không gọi được AI (lỗi kết nối). Bạn thử hỏi lại giúp tôi.");
					MessageToast.show("Không gọi được AI.");
				});
		},

		// ── 4. TAO RFQ TREN SAP + GUI EMAIL MOI BAO GIA ──
		onCreateAndSendRFQ: function () {
			var that = this;
			var oView = this.getView();

			if (!this._currentPR) {
				MessageBox.warning("Hãy chọn một PR trước khi tạo RFQ.");
				return;
			}

			var aSelected = oView.byId("vendorTable").getSelectedItems().map(function (oItem) {
				return oItem.getBindingContext().getObject();
			});
			if (aSelected.length === 0) {
				MessageBox.warning("Hãy chọn ít nhất 1 Nhà cung cấp để mời báo giá.");
				return;
			}

			// Dong vat tu thuoc RFQ lan nay. Khong tick dong nao = khong biet dang hoi
			// gia cai gi, chan luon thay vi de backend tu doan.
			var aLines = (oView.byId("prItemTable").getSelectedItems() || []).map(function (oItem) {
				return oItem.getBindingContext().getObject().LineNo;
			});
			if (aLines.length === 0) {
				MessageBox.warning("Hãy chọn ít nhất 1 dòng vật tư để đưa vào RFQ này.");
				return;
			}

			var oDeadlinePicker = oView.byId("dpDeadline");
			var sDeadline = oDeadlinePicker.getValue();
			if (!sDeadline) {
				MessageBox.warning("Hãy chọn hạn nộp báo giá (Deadline).");
				return;
			}
			// Phong truong hop go tay/paste ngay qua khu (minDate chi chan luc bam vao lich).
			var oDeadlineDate = oDeadlinePicker.getDateValue();
			var oToday = new Date();
			oToday.setHours(0, 0, 0, 0);
			if (oDeadlineDate && oDeadlineDate < oToday) {
				MessageBox.warning("Hạn nộp báo giá không được ở quá khứ. Vui lòng chọn lại.");
				return;
			}

			var fnSubmit = function () { that._submitRFQ(aSelected, sDeadline, aLines); };

			// Chi canh bao (khong chan cung): 1 NCC van hop le nhung se phai nhap
			// ly do sole-source khi chot o man RFQ-02.
			if (aSelected.length < 2) {
				MessageBox.confirm(
					"Bạn chỉ mời 1 Nhà cung cấp báo giá. Khi chốt kết quả sẽ bắt buộc nhập lý do chỉ định 1 NCC (sole source). Tiếp tục?",
					{
						title: "Chỉ có 1 Nhà cung cấp",
						onClose: function (sAction) {
							if (sAction === MessageBox.Action.OK) { fnSubmit(); }
						}
					}
				);
				return;
			}
			fnSubmit();
		},

		_submitRFQ: function (aSelectedVendors, sDeadline, aItemLines) {
			var that = this;
			var oView = this.getView();
			var oUser = this.getOwnerComponent().getModel("user").getData() || {};
			var oPR = this._currentPR;

			oView.setBusy(true);

			fetch(BACKEND + "/api/rfq/create", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					prId: oPR.PRId,
					sapPrNumber: oPR.SapPRId || "",
					vendorIds: aSelectedVendors.map(function (v) { return v.VendorNo; }),
					createdBy: oUser.email || "",
					currency: oPR.Currency || "VND",
					// Danh sach dong PR thuoc RFQ nay. Backend luu vao ZG1_RFQ-ITEM_LINES va
					// tu do loc dong khi gui mail moi bao gia + khi NCC mo portal.
					itemLines: aItemLines || []
				})
			})
				.then(function (r) {
					return r.json().then(function (body) { return { status: r.status, body: body }; });
				})
				.then(function (oResult) {
					if (!oResult.body || !oResult.body.success) {
						throw new Error((oResult.body && oResult.body.message) || "Tạo RFQ thất bại.");
					}
					var sRfqId = oResult.body.rfqId;
					// So dong cua PR con chua duoc gan vao RFQ nao — backend tinh giup,
					// FE dua vao day de biet co giu PR lai cho nguoi dung tao nhom tiep khong.
					that._lastRemainingLines = Number(oResult.body.remainingLines) || 0;

					// Tao xong thi gui email ngay trong cung 1 thao tac
					return fetch(BACKEND + "/api/rfq/" + encodeURIComponent(sRfqId) + "/send", {
						method: "POST",
						headers: { "Content-Type": "application/json" },
						// sentBy: de email gui NCC co Reply-To la dung nguoi mua dang
						// phu trach, khong phai hom thu ky thuat chung.
						body: JSON.stringify({ deadline: sDeadline, sentBy: oUser.email || "" })
					})
						.then(function (r) {
							return r.json().then(function (body) { return { rfqId: sRfqId, body: body }; });
						});
				})
				.then(function (oSendResult) {
					oView.setBusy(false);
					var oBody = oSendResult.body || {};
					var sMsg = "Đã tạo RFQ " + oSendResult.rfqId + " cho PR " + oPR.PRId + ".";
					if (oBody.success) {
						sMsg += " Đã gửi email mời báo giá tới " + oBody.emailsSent + "/" + oBody.totalVendors + " NCC.";
						// NCC thieu email truoc day bi bo qua am tham (`continue` trong
						// vong lap gui mail) — khong ai biet ho khong he nhan duoc thu.
						var aNoEmail = oBody.vendorsWithoutEmail || [];
						if (aNoEmail.length) {
							sMsg += "\n\nCHƯA GỬI ĐƯỢC cho " + aNoEmail.length + " NCC vì chưa có email trong master: "
								+ aNoEmail.join(", ") + ". Vào RFQ-02 để lấy link báo giá riêng gửi cho họ bằng cách khác.";
						}
						if (oBody.emailsFailed) {
							sMsg += "\n\n" + oBody.emailsFailed + " thư bị lỗi khi gửi — có thể gửi nhắc lại ở màn RFQ-02.";
						}
					} else {
						sMsg += " LƯU Ý: gửi email thất bại (" + (oBody.message || "không rõ lý do") + ") — có thể gửi lại sau.";
					}
					// PR chia nhieu nhom: gui xong nhom nay van con dong chua hoi gia. Noi ro
					// va GIU PR lai (khong _clearPRSelection) de nguoi dung tao tiep nhom sau —
					// truoc day man hinh luon nhay ve trang thai "chua chon PR", nguoi dung se
					// tuong da xong ca PR trong khi moi lam duoc 1 phan.
					var iRemaining = that._lastRemainingLines || 0;
					if (iRemaining > 0) {
						sMsg += "\n\nPR này còn " + iRemaining + " dòng chưa có RFQ. "
							+ "Màn hình sẽ giữ nguyên PR để bạn chọn nhóm tiếp theo.";
					}
					MessageBox.success(sMsg, {
						title: "Tạo RFQ thành công — " + oSendResult.rfqId,
						onClose: function () {
							var sKeepPRId = iRemaining > 0 ? oPR.PRId : null;
							that._clearPRSelection();
							that._reselectPRId = sKeepPRId;
							that._loadPendingPRs();
						}
					});
				})
				.catch(function (error) {
					oView.setBusy(false);
					MessageBox.error(error.message || "Không tạo được RFQ.");
				});
		},

		formatCurrency: function (fValue) {
			if (fValue === undefined || fValue === null || fValue === "") { return "0"; }
			return Number(fValue).toLocaleString("vi-VN");
		},

		onNavBack: function () {
			this.getOwnerComponent().getRouter().navTo("dashboard");
		}
	});
});
