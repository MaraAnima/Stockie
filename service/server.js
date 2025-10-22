
require("dotenv").config();
const fs = require("fs");
const express = require("express");
const path = require("path");
const { chromium } = require("playwright");
const logger = require(path.resolve(__dirname, "documentation", "logger"));
const { login, procesarSku } = require(path.resolve(__dirname, "playwrightService"));
const { getDay, upsertResult, deleteResult } = require(path.resolve(__dirname, "storage"));

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ---------- Config ----------
const PORT = process.env.PORT || 4000;
const HEADLESS = process.env.HEADLESS !== "false";
const SLOWMO = Number(process.env.SLOWMO || 0);
const READ_ONLY_DEFAULT = process.env.READ_ONLY === "true";

// ---------- Static ----------
app.use(express.static(path.join(__dirname, "public")));

// ---------- Playwright sesión persistente ----------
const AUTH_STATE_PATH = path.join(__dirname, ".auth", "state.json");
fs.mkdirSync(path.dirname(AUTH_STATE_PATH), { recursive: true });

let browser = null;
let page = null;
let isLogged = false;

function contextOptions(storageStatePath) {
  return {
    storageState: fs.existsSync(storageStatePath) ? storageStatePath : undefined,
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123 Safari/537.36",
    locale: "es-ES",
    timezoneId: "America/Montevideo",
    viewport: { width: 1280, height: 900 },
  };
}

async function newContext(headlessWanted, storageStatePath) {
  if (!browser) {
    browser = await chromium.launch({
      headless: headlessWanted,
      slowMo: SLOWMO,
      args: ["--disable-blink-features=AutomationControlled"],
    });
  }
  const ctx = await browser.newContext(contextOptions(storageStatePath));
  const pg = await ctx.newPage();
  await pg.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => false });
  });
  return { ctx, pg };
}

async function checkAdmin(pg) {
  try {
    await pg.goto("https://turacion.com/Admin/Product/List", { waitUntil: "domcontentloaded" });
    await pg.waitForSelector("#SearchProductName", { timeout: 20000 });
    return true;
  } catch {
    return false;
  }
}

async function bootstrapLoginAndSaveState() {
  const tempBrowser = await chromium.launch({
    headless: false,
    slowMo: Math.max(SLOWMO, 50),
    args: ["--disable-blink-features=AutomationControlled"],
  });
  const tempCtx = await tempBrowser.newContext(contextOptions(undefined));
  const tempPage = await tempCtx.newPage();
  await tempPage.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => false });
  });

  try {
    await login(tempPage);
    await tempCtx.storageState({ path: AUTH_STATE_PATH });
    logger.info("✅ Sesión guardada en .auth/state.json");
  } finally {
    await tempBrowser.close();
  }
}

async function ensureSession(headlessWanted = HEADLESS) {
  if (browser && page && isLogged) return;

  if (!fs.existsSync(AUTH_STATE_PATH)) {
    logger.info("No hay sesión guardada. Login visible por única vez…");
    await bootstrapLoginAndSaveState();
  }

  const { pg } = await newContext(headlessWanted, AUTH_STATE_PATH);
  page = pg;

  if (!(await checkAdmin(page))) {
    try { fs.unlinkSync(AUTH_STATE_PATH); } catch {}
    logger.info("Sesión inválida. Re-haciendo login visible…");
    await bootstrapLoginAndSaveState();

    const { pg: pg2 } = await newContext(headlessWanted, AUTH_STATE_PATH);
    page = pg2;

    if (!(await checkAdmin(page))) {
      logger.warn("Intentando login programático…");
      await login(page);
      if (!(await checkAdmin(page))) throw new Error("No se pudo autenticar en el admin.");
      await page.context().storageState({ path: AUTH_STATE_PATH });
    }
  }
  isLogged = true;
}

// ---------- Helpers ----------
const todayStr = () => {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};


function parseSkus(input) {
  if (!input) return [];


  if (Array.isArray(input)) {
    return input.map((s) => String(s).trim()).filter(Boolean);
  }


  return String(input)
    .split(/\r?\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function toCsv(rows) {
  const headers = [
    "SKU",
    "Título",
    "Web",
    "ML",
    "Regalo a elección",
    "Resumen",
    "Descripción completa",
  ];
  const escape = (v = "") => `"${String(v).replace(/"/g, '""')}"`;
  const body = rows.map((r) =>
    [
      r.sku,
      r.titulo,
      r.web ? "Si" : "No",
      r.ml ? "Si" : "No",
      r.regalo ? "Si" : "No",
      r.resumen,
      r.descripcionCompleta,
    ]
      .map(escape)
      .join(",")
  );
  return [headers.join(","), ...body].join("\n");
}

// ---------- Rutas UI ----------
app.get("/", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.get("/config", (_req, res) => {
  res.json({ readOnlyDefault: READ_ONLY_DEFAULT, headlessDefault: HEADLESS, today: todayStr() });
});


app.get("/history", (req, res) => {
  const date = (req.query.date || todayStr()).trim();
  const { day } = getDay(date);
  res.json({ date, rows: day });
});


app.post("/run", async (req, res) => {
  try {
    const runId = Date.now();
    const date = (req.body.date || todayStr()).trim();
    const readOnly =
      typeof req.body.readOnly === "boolean"
        ? req.body.readOnly
        : READ_ONLY_DEFAULT;

    process.env.READ_ONLY = readOnly ? "true" : "false";

   
    const raw = parseSkus(req.body.skus || "");
    if (!raw.length) {
      return res.status(400).json({ error: "Sin SKUs" });
    }
    const uniqueSkus = [...new Set(raw.map(s => s.toLowerCase()))];
    const { day: already } = getDay(date);
    const alreadySet = new Set(already.map(r => String(r.sku).trim().toLowerCase()));
    const skus = uniqueSkus.filter(s => !alreadySet.has(s)); // los que realmente se procesan

    await ensureSession();

   
    res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders?.();

    for (let i = 0; i < skus.length; i++) {
      const skuLower = skus[i];
      const sku = raw.find(x => x.toLowerCase() === skuLower) || skuLower;

      try {
        logger.info(`[${runId}] Procesando SKU ${sku}`);
        const result = await procesarSku(page, sku);

      
        const resumenes = result?.resumenesPorEnlace || [];
        let enWeb = false, enML = false, conRegalo = false;
        for (const r of resumenes) {
          const t = r.toLowerCase();
          if (t.includes("publicado en la web")) enWeb = true;
          if (t.includes("mercado libre") && (t.includes("activo") || t.includes("publicado"))) enML = true;
          if (t.includes("regalo a elección: si")) conRegalo = true;
        }
        const resumenML = (result?.resumenML || "").toLowerCase();
        const resumenWeb = (result?.resumenWeb || "").toLowerCase();
        if (!enWeb && resumenWeb.includes("está publicado")) enWeb = true;
        if (!enML && (resumenML.includes("publicado") || resumenML.includes("activo"))) enML = true;

        const row = {
          sku,
          titulo: result?.titulo || "",
          web: enWeb,
          ml: enML,
          regalo: conRegalo,
          resumen: `${enWeb ? "Está en Web" : "No está en Web"}, ${enML ? "Está en ML" : "No está en ML"}, ${conRegalo ? "Con regalo" : "Sin regalo"}`,
          descripcionCompleta: result?.descripcionCompleta || "",
        };

        
        upsertResult(date, row);

       
        res.write(JSON.stringify({ type: "progress", current: i + 1, total: skus.length, sku }) + "\n");
      } catch (err) {
        logger.error(`Error en SKU ${sku}: ${err.message}`);
        const row = {
          sku,
          titulo: "",
          web: false,
          ml: false,
          regalo: false,
          resumen: `Error al procesar: ${err.message}`,
          descripcionCompleta: "",
        };
        upsertResult(date, row);
        res.write(JSON.stringify({ type: "progress", current: i + 1, total: skus.length, sku, error: true }) + "\n");
      }
    }

   
    const { day } = getDay(date);
    res.write(JSON.stringify({ type: "done", date, rows: day }) + "\n");
    res.end();
  } catch (e) {
    logger.error(`Fallo general /run: ${e.message}`);
   
    try {
      res.write(JSON.stringify({ type: "error", message: e.message }) + "\n");
    } catch {}
    res.status(500).end();
  }
});


app.post("/recheck", async (req, res) => {
  try {
    const date = (req.body.date || todayStr()).trim();
    const sku = String(req.body.sku || "").trim();
    if (!sku) return res.status(400).json({ error: "SKU requerido" });

    await ensureSession(HEADLESS);

    const result = await procesarSku(page, sku);

    const resumenes = result?.resumenesPorEnlace || [];
    let enWeb = false, enML = false, conRegalo = false;

    for (const r of resumenes) {
      const t = r.toLowerCase();
      if (t.includes("publicado en la web")) enWeb = true;
      if (t.includes("mercado libre") && (t.includes("activo") || t.includes("publicado"))) enML = true;
      if (t.includes("regalo a elección: si")) conRegalo = true;
    }

    const resumenML = (result?.resumenML || "").toLowerCase();
    const resumenWeb = (result?.resumenWeb || "").toLowerCase();
    if (!enWeb && resumenWeb.includes("está publicado")) enWeb = true;
    if (!enML && (resumenML.includes("publicado") || resumenML.includes("activo"))) enML = true;

    const row = {
      sku,
      titulo: result?.titulo || "",
      web: enWeb,
      ml: enML,
      regalo: conRegalo,
      resumen: `${enWeb ? "Está en Web" : "No está en Web"}, ${enML ? "Está en ML" : "No está en ML"}, ${conRegalo ? "Con regalo" : "Sin regalo"}`,
      descripcionCompleta: result?.descripcionCompleta || "",
    };

    upsertResult(date, row);
    res.json({ date, row });
  } catch (e) {
    logger.error(`Recheck error: ${e.message}`);
    res.status(500).json({ error: e.message });
  }
});


app.delete("/result", (req, res) => {
  const date = (req.query.date || todayStr()).trim();
  const sku = String(req.query.sku || "").trim();
  if (!sku) return res.status(400).json({ error: "SKU requerido" });
  deleteResult(date, sku);
  const { day } = getDay(date);
  res.json({ date, rows: day });
});


app.get("/export", (req, res) => {
  try {
    const date = (req.query.date || todayStr()).trim();
    const { day } = getDay(date);
    const csv = toCsv(day);
    res.setHeader("Content-Disposition", `attachment; filename=auditoria_${date}.csv`);
    res.type("text/csv").send(csv);
  } catch {
    res.status(400).send("Bad request");
  }
});


process.on("SIGINT", async () => {
  try { if (browser) await browser.close(); } finally { process.exit(0); }
});

app.listen(PORT, () => {
  logger.info(` UI lista en http://localhost:${PORT}`);
});
