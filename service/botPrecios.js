const fs = require("fs");
const path = require("path");
require("dotenv").config();
const { chromium } = require("playwright");
const logger = require(path.resolve(__dirname, "documentation", "logger"));
const { procesarSku, login } = require(path.resolve(
  __dirname,
  "playwrightService"
));
const { authorize, actualizarCelda, obtenerValorCelda } = require(path.resolve(
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
    const browser = await chromium.launch({ headless: false, slowMo: 75 });
    const page = await browser.newPage();

    const urlExcelPublico = process.env.URL_EXCEL_PUBLICO;

    const rutaLocal = path.resolve(__dirname, "downloads", "temp.xlsx");

    // 1. Descargar Excel localmente
    await descargarExcel(urlExcelPublico, rutaLocal);

    // 2. Leer SKUs desde archivo local
    const skus = obtenerSkusDesdeArchivoLocal(rutaLocal);
    logger.info(`SKUs encontrados:${skus}`);

    // 3. Autenticar con Google Sheets API
    const credentials = JSON.parse(fs.readFileSync("credentials.json"));
    const auth = await authorize(credentials);

    const spreadsheetId = process.env.SPREADSHEET_ID;
    const hoy = new Date();
    const pad = (n) => n.toString().padStart(2, "0");
    const hoja = `${hoy.getFullYear()}-${pad(hoy.getMonth() + 1)}-${pad(
      hoy.getDate()
    )}`;

    await login(page);

    for (const sku of skus) {
      const filaIndex = skus.indexOf(sku) + 2; // +2: porque header en fila 1

      const rangoDia = `${hoja}!C${filaIndex}`;
      const valorDia = await obtenerValorCelda(auth, spreadsheetId, rangoDia);

      if (valorDia && valorDia.trim() !== "") {
        logger.info(`SKU ${sku} ya procesado el día ${valorDia}, se omite.`);
        continue;
      }
      const {
        resumenCompleto = "",
        resumenML = "",
        resumenWeb = "",
        RegaloAEleccion = "No",
        titulo = "",
        resumenesPorEnlace = [],
      } = (await procesarSku(page, sku)) || {};
      console.log("TITULO:", titulo);

      // 🟡 Flags para detectar si alguna publicación cumple cada condición
      let algunaEnWeb = false;
      let algunaEnML = false;
      let algunaConRegalo = false;

      // 🟢 Evaluar cada resumen individual para detectar flags
      for (const resumen of resumenesPorEnlace) {
        if (resumen.includes("está publicado en la web")) algunaEnWeb = true;
        if (
          resumen.includes("publicado correctamente en Mercado Libre") ||
          resumen.includes("activas") ||
          resumen.includes("activo en Mercado Libre")
        ) {
          algunaEnML = true;
        }
        if (resumen.includes("Regalo a elección: Si")) algunaConRegalo = true;
      }

      // 🟢 Construir el resumen general
      let resumenCompletoFinal = "Este producto ";
      const partes = [];

      if (algunaEnWeb) partes.push("está en Web");
      if (algunaEnML) partes.push("está en Mercado Libre y en web");
      if (algunaConRegalo) partes.push("tiene regalo a elección");

      resumenCompletoFinal += partes.join(", ") + ".";

      // Actualizar columna C con fecha
      const rangoFecha = `${hoja}!C${filaIndex}`;
      const fechaHoy = new Date().toLocaleDateString();
      await actualizarCelda(auth, spreadsheetId, rangoFecha, fechaHoy);

      await actualizarCelda(
        auth,
        spreadsheetId,
        `${hoja}!A${filaIndex}`,
        titulo
      );

      await actualizarCelda(
        auth,
        spreadsheetId,
        `${hoja}!D${filaIndex}`,
        resumenesPorEnlace.includes("No se encontró publicación") ||
          resumenesPorEnlace.includes("No está publicado en la web")
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
        resumenesPorEnlace.includes("No está publicado en Mercado Libre") ||
          resumenesPorEnlace.includes(
            "Todas las publicaciones están bajo revisión en Mercado Libre"
          )
          ? "No"
          : "Si"
      );
      await actualizarCelda(
        auth,
        spreadsheetId,
        `${hoja}!G${filaIndex}`,
        resumenCompletoFinal.includes(
          "No se encontró publicación ni en la web ni en Mercado Libre"
        )
          ? "No se encuentra ni en Web ni en Mercado Libre"
          : resumenCompletoFinal
      );
      logger.info(`✅ Datos actualizados en ${sku}`);
    }
    // hay que agregar para la primera celda el titulo del producto para saber que se esta actualizando

    await browser.close();
  } catch (error) {
    logger.error("❌ Error en el proceso:", error);
    await enviarMailError(
      "Error en Bot de stock",
      `Ocurrió un error: ${error.message}\nStack: ${error.stack}`
    );
  }
})();
