/**
 * Lop goi OData SAP: auth, CSRF token, doc/ghi entity, boc tach message loi.
 *
 * Tach ra tu server.js (ban goc 4520 dong) ngay 15/08/2026.
 * Noi dung ham giu nguyen 100%, chi them phan require/exports o dau va cuoi file.
 */


const axios = require("axios");
const { ODATA_SERVICE_PATH } = require("../config/org");


function sapAuth() {
	return {
		username: process.env.SAP_USER,
		password: process.env.SAP_PASS
	};
}

// ============================================================================
// HELPER SAP OData DUNG CHUNG CHO CAC ROUTE RFQ (RfqSet / QuotationSet)
// Tai su dung dung pattern CSRF token da dung trong createPRInSAP() o tren.
// ============================================================================

/** Escape dau nhay don trong gia tri key OData (vd RfqSet('...')) de tranh loi cu phap. */
function odataEscape(v) {
	return String(v == null ? "" : v).replace(/'/g, "''");
}

async function sapFetchCsrfToken() {
	const tokenResponse = await axios.get(
		`${process.env.SAP_HOST}${ODATA_SERVICE_PATH}`,
		{ auth: sapAuth(), headers: { "X-CSRF-Token": "Fetch", "sap-language": "EN" } }
	);
	return {
		csrfToken: tokenResponse.headers["x-csrf-token"],
		cookies: tokenResponse.headers["set-cookie"]
	};
}

/** POST/MERGE vao 1 entity path (vd "RfqSet" hoac "RfqSet('RFQ-2026-0001')"). Truyen session de tai su dung 1 CSRF token cho nhieu lan ghi lien tiep. */
async function sapWrite(method, entityPath, data, session) {
	const s = session || await sapFetchCsrfToken();
	return axios({
		method,
		url: `${process.env.SAP_HOST}${ODATA_SERVICE_PATH}/${entityPath}`,
		data,
		auth: sapAuth(),
		headers: {
			"Content-Type": "application/json",
			"X-CSRF-Token": s.csrfToken,
			"Cookie": s.cookies ? s.cookies.join("; ") : "",
			"sap-language": "EN"
		}
	});
}

/** GET 1 entity path (vd "RfqSet('RFQ-2026-0001')/RfqToQuotations"). */
async function sapRead(entityPath) {
	return axios.get(
		`${process.env.SAP_HOST}${ODATA_SERVICE_PATH}/${entityPath}`,
		{ params: { "$format": "json" }, auth: sapAuth(), timeout: 20000 }
	);
}

/** Rut gon message loi tu SAP OData (hoac API ngoai nhu Anthropic) de tra ve FE, khong nuot loi. */
function extractSapErrorMessage(error) {
	const errorDetails = error.response?.data?.error?.innererror?.errordetails;
	if (Array.isArray(errorDetails)) {
		const realErrors = errorDetails
			.filter((d) => d.severity === "error" && d.code !== "/IWBEP/CX_MGW_BUSI_EXCEPTION")
			.map((d) => d.message);
		if (realErrors.length) { return realErrors.join("; "); }
	}
	const odataMsg = error.response?.data?.error?.message?.value;
	if (odataMsg) { return odataMsg; }
	const rawMsg = error.response?.data?.error?.message;
	if (typeof rawMsg === "string" && rawMsg) { return rawMsg; }
	if (error.response) {
		return `HTTP ${error.response.status}: ${JSON.stringify(error.response.data).slice(0, 300)}`;
	}
	return error.message;
}
module.exports = {
	extractSapErrorMessage,
	odataEscape,
	sapAuth,
	sapFetchCsrfToken,
	sapRead,
	sapWrite,
};
