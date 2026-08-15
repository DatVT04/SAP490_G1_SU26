/**
 * Tai nguyen dung chung cho cac email gui ra ngoai (nha cung cap).
 *
 * Tai sao logo lai nam duoi dang base64 trong file .js thay vi doc tu
 * webapp/images/: tren Vercel, `webapp/**` duoc build bang @vercel/static nen
 * KHONG duoc dong goi vao serverless function cua `api/index.js` — fs.readFile
 * tro toi do se ENOENT khi chay that (chay local thi van OK, nen loai bug nay
 * chi lo ra sau khi deploy). Nhung o dang chuoi thi khong phu thuoc filesystem.
 *
 * Dung cach nao de hien logo trong email:
 *   - <img src="https://.../logo.png">  -> Gmail proxy anh, nhieu client chan
 *     anh remote cho tới khi nguoi doc bam "hien thi hinh anh".
 *   - <img src="data:image/png;base64,..."> -> Gmail chan thang, khong hien.
 *   - dinh kem inline + cid: (dang dung) -> hien ngay, khong can bam gi.
 *
 * File nguon: D:\SAPCapstoneSu26\QDAVY-owl-light.svg (SVG khong dung truc tiep
 * duoc trong email — hau het mail client khong render SVG), da render sang PNG
 * 360x315, nen palette 128 mau, ~10KB.
 */

const QDAVY_LOGO_CID = "qdavy-logo";

const QDAVY_LOGO_PNG_BASE64 =
	"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";

/** Mau lay tu chinh logo QDAVY (xem QDAVY-owl-light.svg). */
const BRAND = {
	navy: "#0B1F3F",
	blueDark: "#123E8F",
	blue: "#2E7CF6",
	amber: "#F5A623",
	slate: "#5A7098",
	line: "#E3E9F2",
	bg: "#F1F4F9"
};

/** Attachment inline cho nodemailer — dung chung cho moi email co logo. */
function qdavyLogoAttachment() {
	return {
		filename: "qdavy-logo.png",
		content: Buffer.from(QDAVY_LOGO_PNG_BASE64, "base64"),
		contentType: "image/png",
		cid: QDAVY_LOGO_CID
	};
}

module.exports = { QDAVY_LOGO_CID, QDAVY_LOGO_PNG_BASE64, BRAND, qdavyLogoAttachment };
