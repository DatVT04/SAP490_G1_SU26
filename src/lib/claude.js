/**
 * Goi Anthropic Messages API (co retry).
 *
 * Tach ra tu server.js (ban goc 4520 dong) ngay 15/08/2026.
 * Noi dung ham giu nguyen 100%, chi them phan require/exports o dau va cuoi file.
 */


const axios = require("axios");


/** Goi Anthropic Messages API (khong them SDK moi, dung axios cho dong bo voi phan con lai cua file). */
async function callClaudeOnce(promptText, maxTokens) {
	const response = await axios.post(
		"https://api.anthropic.com/v1/messages",
		{
			model: "claude-sonnet-5",
			max_tokens: maxTokens,
			messages: [{ role: "user", content: promptText }]
		},
		{
			headers: {
				"x-api-key": process.env.ANTHROPIC_API_KEY,
				"anthropic-version": "2023-06-01",
				"Content-Type": "application/json"
			},
			timeout: 60000
		}
	);
	const content = response.data && response.data.content;
	// Truoc day lay thang content[0].text — neu block dau tien khong phai type "text" (vi du
	// bi chen block khac truoc no) thi se ra chuoi rong ma khong bao loi gi ca, FE nhan
	// success:true nhung khong hien thi duoc gi. Doi sang tim dung block type "text".
	const textBlock = Array.isArray(content) && content.find((c) => c && c.type === "text" && c.text);
	return {
		text: textBlock ? textBlock.text : "",
		stopReason: response.data && response.data.stop_reason
	};
}

/**
 * callClaude voi xu ly stop_reason=max_tokens (feedback QDAVY 13/08: FE hien toast
 * "Claude khong tra ve noi dung text (stop_reason=max_tokens)"):
 * - Budget mac dinh nang tu 800 -> 1500: tieng Viet co dau ton token hon tieng Anh nhieu,
 *   500-800 token rat de bi cat giua chung.
 * - Neu van bi cat NHUNG da co text -> tra ve phan text da co (do hon la nem loi).
 * - Neu bi cat ma CHUA co text nao (model chua kip viet) -> thu lai 1 lan voi budget gap doi.
 */
async function callClaude(promptText, maxTokens) {
	const budget = maxTokens || 1500;
	let result = await callClaudeOnce(promptText, budget);

	if (!result.text && result.stopReason === "max_tokens") {
		console.error("[callClaude] Bi cat max_tokens truoc khi co text — thu lai voi budget x2 (" + budget * 2 + ").");
		result = await callClaudeOnce(promptText, budget * 2);
	}

	if (!result.text) {
		console.error("[callClaude] Khong tim thay text block trong phan hoi Claude. stop_reason=" + result.stopReason);
		throw new Error("AI không trả về được nội dung (stop_reason=" + result.stopReason + "). Vui lòng thử lại.");
	}
	if (result.stopReason === "max_tokens") {
		console.error("[callClaude] Tra loi bi cat o max_tokens — van tra ve phan da co.");
	}
	return result.text;
}
module.exports = {
	callClaude,
};
