/**
 * Tra cuu nhan vien / email theo vai tro tu SAP.
 *
 * Tach ra tu server.js (ban goc 4520 dong) ngay 15/08/2026.
 * Noi dung ham giu nguyen 100%, chi them phan require/exports o dau va cuoi file.
 */


const axios = require("axios");
const { ODATA_SERVICE_PATH } = require("../config/org");
const { sapAuth } = require("../lib/sap-client");


async function fetchAllEmployeesFromSAP() {
	if (!process.env.SAP_HOST) { return []; }
	try {
		const response = await axios.get(
			`${process.env.SAP_HOST}${ODATA_SERVICE_PATH}/EmployeeSet`,
			{ params: { "$format": "json" }, auth: sapAuth() }
		);
		return (response.data && response.data.d && response.data.d.results) || [];
	} catch (error) {
		console.error("[fetchAllEmployeesFromSAP] Khong lay duoc danh sach nhan vien tu SAP:", error.message);
		return [];
	}
}

async function findEmailsByRole(role) {
	const list = await fetchAllEmployeesFromSAP();
	return list
		.filter(function (e) {
			return e.IsActive && String(e.Role || "").toUpperCase() === String(role).toUpperCase();
		})
		.map(function (e) { return e.Email; })
		.filter(Boolean);
}

/**
 * Tra cuu 1 nhan vien active theo email trong SAP EmployeeSet.
 * Dung chung cho ca 2 duong dang nhap (email-only cu va Google moi) de
 * khong lap code va de sau nay chi sua 1 cho neu doi cach query SAP.
 */
async function findActiveEmployeeByEmail(email) {
	const response = await axios.get(
		`${process.env.SAP_HOST}${ODATA_SERVICE_PATH}/EmployeeSet`,
		{
			params: { "$filter": `Email eq '${email}'`, "$format": "json" },
			auth: sapAuth(),
			timeout: 8000
		}
	);
	const results = (response.data && response.data.d && response.data.d.results) || [];
	return results.find(
		(emp) => emp.Email && emp.Email.toLowerCase() === String(email).toLowerCase()
	);
}
module.exports = {
	findActiveEmployeeByEmail,
	findEmailsByRole,
};
