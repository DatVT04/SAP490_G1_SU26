/**
 * Nha cung cap: doc VendorSet, an danh cho AI, thong ke hieu suat.
 *
 * Tach ra tu server.js (ban goc 4520 dong) ngay 15/08/2026.
 * Noi dung ham giu nguyen 100%, chi them phan require/exports o dau va cuoi file.
 */


const axios = require("axios");
const { ODATA_SERVICE_PATH } = require("../config/org");
const { describePaymentTerms } = require("../config/payment-terms");
const { extractSapErrorMessage, odataEscape, sapAuth, sapRead } = require("../lib/sap-client");


/** Lay toan bo NCC tu SAP VendorSet (dung chung cho /api/vendors va cac route RFQ). */
async function fetchAllVendorsFromSAP() {
	if (!process.env.SAP_HOST) { return []; }
	// timeout bat buoc: ham nay gio nam tren duong di cua /api/approval/pending
	// (qua enrichWithRfqAward), SAP treo ma khong co timeout la treo ca man phe duyet.
	const response = await axios.get(
		`${process.env.SAP_HOST}${ODATA_SERVICE_PATH}/VendorSet`,
		{ params: { "$format": "json" }, auth: sapAuth(), timeout: 20000 }
	);
	const results = (response.data && response.data.d && response.data.d.results) || [];
	return results.map((v) => ({
		...v,
		VendorNo: v.VendorNo || v.Lifnr || v.Vendor || "",
		VendorName: v.VendorName || v.Name1 || v.Name || `Nhà cung cấp ${v.VendorNo || v.Lifnr}`
	}));
}

/**
 * An danh hoa danh sach NCC truoc khi gui cho AI. Ten/email/MST khong bao gio roi khoi
 * he thong; anonMap giu anh xa nguoc de dich lai sau khi co ket qua. Dung chung cho ca
 * /api/ai/recommend-vendor va /api/ai/ask (context recommend-vendor) — truoc day 2 route
 * nay copy y het doan nay, sua 1 cho quen cho kia la bug chac chan dinh (xem
 * PHU_LUC_KY_THUAT_VendorSet.md muc 4.1).
 *
 * Cac field country/city/category/incoterms/leadTimeDays doc tu VendorSet HIEN CHUA co
 * (VendorSet 15/08/2026 moi chi tra CompanyCode/VendorNo/VendorName/AccountGroup/Email/
 * Rating — da kiem chung truc tiep qua OData that) nen se ra chuoi rong/0 cho toi khi
 * SEGW+ABAP+nhap lieu 34 NCC lam xong. Code van dung duoc luon tu bay gio, khong can sua
 * lai lan 2 khi SAP-side xong.
 */
function anonymizeVendorsForAI(vendors, anonMap, performanceStats) {
	performanceStats = performanceStats || {};
	return vendors.map(function (v, idx) {
		const code = "V" + (idx + 1);
		const vendorNo = String(v.VendorNo || v.Lifnr || "");
		const vendorName = String(v.VendorName || v.Name1 || "").trim();
		anonMap[code] = vendorName ? `${vendorName} (${vendorNo})` : vendorNo;
		const perf = performanceStats[vendorNo] || null;
		return {
			vendorCode: code,
			country: v.Country || v.Land1 || "",
			city: v.City || v.Ort01 || "",
			category: v.Category || v.Sortl || "",
			paymentTerms: describePaymentTerms(v.PaymentTerms || v.Zterm),
			currency: v.Currency || v.Waers || "",
			incoterms: v.Incoterms || v.Inco1 || "",
			leadTimeDays: Number(v.PlanDelivTime || v.Plifz || 0) || 0,
			// Lich su tu cac RFQ DA HOAN TAT truoc do (doc tu ZG1_QUOTATION qua RfqSet — xem
			// computeVendorPerformanceStats). null/0 nghia la NCC nay chua tung tham gia RFQ
			// nao trong he thong, KHONG phai NCC kem — prompt ben duoi co nhac AI dieu nay.
			pastQuoteCount: perf ? perf.quoteCount : 0,
			pastAwardedCount: perf ? perf.awardedCount : 0,
			pastAvgLeadTimeDays: perf ? perf.avgLeadTimeDays : null,
			pastLegalDocsOkRate: perf ? perf.legalDocsOkRate : null
		};
	});
}

/**
 * Tinh "diem hieu suat" NCC tu cac RFQ DA CO BAO GIA truoc do (ZG1_QUOTATION, doc qua
 * RfqSet('X')/RfqToQuotations) — khong dung master data tinh (LFA1/LFM1) ma dung chinh
 * hanh vi thuc te trong app: da tung duoc moi may lan, thang thau may lan, giao co dung
 * han khong, co nop du chung tu phap ly khong. Nguon nay KHONG can SEGW/ABAP gi them vi
 * da nam san trong OData model hien co — chay duoc ngay ke ca khi VendorSet chua mo rong.
 *
 * CO Y bo qua gia trung binh: gia phu thuoc rat nhieu vao loai vat tu (mua thep khac mua
 * laptop), tinh trung binh chung tren nhieu RFQ khac nhau se sai lech, danh gia sau nay
 * neu can (theo tung nhom vat tu) — nam ngoai scope lan sua nay.
 *
 * Loi doc lich su KHONG duoc lam hong luong AI goi y chinh — luon tra ve {} thay vi nem
 * loi, AI se chi thieu phan "hieu suat" chu khong crash ca request.
 */
async function computeVendorPerformanceStats() {
	if (!process.env.SAP_HOST) { return {}; }
	try {
		const rfqResp = await sapRead("RfqSet");
		const allRfqs = (rfqResp.data && rfqResp.data.d && rfqResp.data.d.results) || [];
		// Chi can RFQ da tung nhan bao gia — RFQ moi tao (DRAFT/SENT, chua ai bao gia) khong
		// co gi de gom, doc them cung phi thoi gian. Dung dung 2 gia tri Status that cua
		// RfqSet (xem cac cho MERGE Status trong file nay: DRAFT/SENT/QUOTATIONS_RECEIVED/
		// AWARDED) — KHONG phai QuoteStatus cua tung dong Quotation (RECEIVED/AWARDED/PENDING).
		const relevantRfqs = allRfqs.filter((r) => ["QUOTATIONS_RECEIVED", "AWARDED"].indexOf(r.Status) !== -1);
		if (!relevantRfqs.length) { return {}; }

		const quotationLists = await Promise.all(relevantRfqs.map(async function (rfq) {
			try {
				const resp = await sapRead(`RfqSet('${odataEscape(rfq.RfqId)}')/RfqToQuotations`);
				return (resp.data && resp.data.d && resp.data.d.results) || [];
			} catch (error) {
				console.error(
					"[computeVendorPerformanceStats] Doc quotations RFQ " + rfq.RfqId + " that bai:",
					extractSapErrorMessage(error)
				);
				return [];
			}
		}));

		const raw = {};
		quotationLists.forEach(function (quotations) {
			quotations.forEach(function (q) {
				// Bo qua PENDING (NCC chua bao gia — khong phan anh gi ve hieu suat).
				if (q.QuoteStatus !== "RECEIVED" && q.QuoteStatus !== "AWARDED") { return; }
				const key = String(q.VendorNo || "");
				if (!key) { return; }
				if (!raw[key]) {
					raw[key] = { quoteCount: 0, awardedCount: 0, leadTimeSum: 0, leadTimeCount: 0, legalDocsOkCount: 0 };
				}
				const s = raw[key];
				s.quoteCount += 1;
				if (q.QuoteStatus === "AWARDED") { s.awardedCount += 1; }
				const leadTime = Number(q.LeadTimeDays);
				if (leadTime > 0) { s.leadTimeSum += leadTime; s.leadTimeCount += 1; }
				if (q.LegalDocsOk === "X") { s.legalDocsOkCount += 1; }
			});
		});

		const result = {};
		Object.keys(raw).forEach(function (vendorNo) {
			const s = raw[vendorNo];
			result[vendorNo] = {
				quoteCount: s.quoteCount,
				awardedCount: s.awardedCount,
				avgLeadTimeDays: s.leadTimeCount ? Math.round(s.leadTimeSum / s.leadTimeCount) : null,
				legalDocsOkRate: s.quoteCount ? Math.round((s.legalDocsOkCount / s.quoteCount) * 100) : null
			};
		});
		return result;
	} catch (error) {
		console.error("[computeVendorPerformanceStats] That bai:", extractSapErrorMessage(error));
		return {};
	}
}

// Doan giai thich y nghia field, dung chung cho ca 2 route AI ve NCC — xem ghi chu o
// anonymizeVendorsForAI ve field nao co the rong/0.
const VENDOR_FIELD_EXPLANATION =
	`- Ý nghĩa các trường: category là ngành hàng nhà cung cấp đang kinh doanh (ưu tiên khớp với `
	+ `vật tư đang cần mua), leadTimeDays là số ngày giao hàng dự kiến theo master data SAP, `
	+ `incoterms là điều kiện giao hàng, country/city là nơi đặt trụ sở. `
	+ `pastQuoteCount/pastAwardedCount/pastAvgLeadTimeDays/pastLegalDocsOkRate là lịch sử thực tế `
	+ `từ các RFQ đã hoàn tất trước đó trong hệ thống (số lần từng được mời báo giá, số lần trúng `
	+ `thầu, thời gian giao trung bình theo ngày, tỉ lệ phần trăm lần nộp đủ chứng từ pháp lý) — `
	+ `giá trị 0 hoặc null có nghĩa là nhà cung cấp đó CHƯA TỪNG tham gia RFQ nào trong hệ thống, `
	+ `KHÔNG có nghĩa là nhà cung cấp kém, đừng loại nhà cung cấp chỉ vì thiếu lịch sử.\n`
	+ `Nếu nhiều trường đang trống hoặc bằng 0 (dữ liệu nhà cung cấp trên SAP chưa được bổ sung `
	+ `đầy đủ), hãy nói rõ đang thiếu dữ liệu gì thay vì suy đoán, và chỉ dựa vào những trường `
	+ `thực sự có giá trị.\n`;
module.exports = {
	VENDOR_FIELD_EXPLANATION,
	anonymizeVendorsForAI,
	computeVendorPerformanceStats,
	fetchAllVendorsFromSAP,
};
