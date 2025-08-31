const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");
const logger = require(path.resolve(__dirname, "documentation", "logger"));
const { procesarSku, login } = require(path.resolve(
  __dirname,
  "playwrightService"
));
const { authorize, actualizarCelda } = require(path.resolve(
  __dirname,
  "googleSheets"
));
const enviarMailError = require(path.resolve(
  __dirname,
  "documentation",
  "mailer"
));
const { descargarExcel, obtenerSkusDesdeArchivoLocal } = require(path.resolve(
  __dirname,
  "excelService"
));
(async () => {
  try {
    const browser = await chromium.launch({ headless: false });
    const page = await browser.newPage();

    // URL del Excel público
    const urlExcelPublico =
      "https://docs.google.com/spreadsheets/d/1iSHcrq5ZoLx-Ol92U8uxlO6Nau6sXIE6fMjaVACggRw/export?format=xlsx";

    const rutaLocal = path.resolve(__dirname, "downloads", "temp.xlsx");

    // 1. Descargar Excel localmente
    await descargarExcel(urlExcelPublico, rutaLocal);

    // 2. Leer SKUs desde archivo local
    const skus = obtenerSkusDesdeArchivoLocal(rutaLocal);
    logger.info(`SKUs encontrados:${skus}`);

    // 3. Autenticar con Google Sheets API
    const credentials = JSON.parse(fs.readFileSync("credentials.json"));
    const auth = await authorize(credentials);

    const spreadsheetId = "1iSHcrq5ZoLx-Ol92U8uxlO6Nau6sXIE6fMjaVACggRw";
    const hoy = new Date();
    const pad = (n) => n.toString().padStart(2, "0");
    const hoja = `${hoy.getFullYear()}-${pad(hoy.getMonth() + 1)}-${pad(
      hoy.getDate()
    )}`;

    // 4. Login al sitio con playwright
    await login(page);

    // 5. Procesar SKUs y actualizar fecha en Google Sheets
    for (const sku of skus) {
      const {
        resumenCompleto = "",
        resumenML = "",
        resumenWeb = "",
        RegaloAEleccion = "No",
      } = (await procesarSku(page, sku)) || {};

      const filaIndex = skus.indexOf(sku) + 2; // +2: porque header en fila 1

      // Actualizar columna C con fecha
      const rangoFecha = `${hoja}!C${filaIndex}`;
      const fechaHoy = new Date().toLocaleDateString();
      await actualizarCelda(auth, spreadsheetId, rangoFecha, fechaHoy);

      // Actualizar columna D con resumen
      const rangoResumen = `${hoja}!D${filaIndex}`;
      const rangoStock = `${hoja}!E${filaIndex}`;

      await actualizarCelda(
        auth,
        spreadsheetId,
        `${hoja}!D${filaIndex}`,
        resumenWeb.includes("No se encontró publicación") ||
          resumenWeb.includes("No está publicado")
          ? "No"
          : "Si"
      );
      await actualizarCelda(
        auth,
        spreadsheetId,
        `${hoja}!E${filaIndex}`,
        RegaloAEleccion
      );
      await actualizarCelda(
        auth,
        spreadsheetId,
        `${hoja}!F${filaIndex}`,
        resumenML.includes("No") ||
          resumenML.includes(
            "Todas las publicaciones están bajo revisión en Mercado Libre"
          )
          ? "No"
          : "Si"
      );
      await actualizarCelda(
        auth,
        spreadsheetId,
        `${hoja}!G${filaIndex}`,
        resumenCompleto
      );
      logger.info(`✅ Datos actualizados en ${sku}`);
    }

    await browser.close();
  } catch (error) {
    logger.error("❌ Error en el proceso:", error);
    await enviarMailError(
      "Error en Bot de stock",
      `Ocurrió un error: ${error.message}\nStack: ${error.stack}`
    );
  }
})();
