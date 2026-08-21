require("dotenv").config();
const express = require("express");
const cors = require("cors");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const { QDAVY_LOGO_CID, BRAND, qdavyLogoAttachment } = require("./mail-assets");
// Hang so/state nam trong cac module con nhung khoi dong server van can dung.
const { ODATA_SERVICE_PATH, PORT } = require("./src/config/org");
const { DATA_DIR } = require("./src/lib/store");


const app = express();
app.use(cors());
app.use(express.json());

app.get("/api/health", (req, res) => res.json({ ok: true }));
app.use(express.static(path.join(__dirname, "webapp")));
// ============================================================================
// GAN CAC NHOM ROUTE
// Moi file duoi day la 1 express.Router() giu NGUYEN duong dan day du
// (vd "/api/rfq/:id/send"), nen thu tu gan o day khong lam doi URL nao.
// Thu tu duoi day dung bang thu tu dang ky trong server.js ban goc.
// ============================================================================
app.use(require("./src/routes/masterdata.routes.js"));
app.use(require("./src/routes/material.routes.js"));
app.use(require("./src/routes/threshold.routes.js"));
app.use(require("./src/routes/material-config.routes.js"));
app.use(require("./src/routes/auth.routes.js"));
app.use(require("./src/routes/ai.routes.js"));
app.use(require("./src/routes/approval.routes.js"));
app.use(require("./src/routes/notification.routes.js"));
app.use(require("./src/routes/po.routes.js"));
app.use(require("./src/routes/asset.routes.js"));
app.use(require("./src/routes/rfq-public.routes.js"));
app.use(require("./src/routes/rfq.routes.js"));
app.use(require("./src/routes/cron.routes.js"));


if (require.main === module) {
	app.listen(PORT, () => {
		console.log(`QDAVY Procurement API: http://localhost:${PORT}`);
		console.log(process.env.SAP_HOST
			? `OData: ${process.env.SAP_HOST}${ODATA_SERVICE_PATH}`
			: "Che do: mock (SAP_HOST chua cau hinh)");
		console.log("[DATA] Folder:", DATA_DIR);
		console.log("[LOGIC] Leo CEO theo ngưỡng Internal Order (khong con 300tr co dinh)");
	});
}

module.exports = app;