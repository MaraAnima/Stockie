const path = require("path");
const axios = require("axios");
const XLSX = require("xlsx");
const fs = require("fs");
const logger = require(path.resolve(__dirname, "documentation", "logger"));

async function descargarExcel(url, rutaLocal) {
  const response = await axios.get(url, { responseType: "arraybuffer" });
  fs.writeFileSync(rutaLocal, response.data);
  logger.info("✅ Excel descargado en:", rutaLocal);
}

function obtenerSkusDesdeArchivoLocal(rutaLocal) {
  const data = fs.readFileSync(rutaLocal);
  const workbook = XLSX.read(data, { type: "buffer" });
  const sheetName = workbook.SheetNames[0];
  const worksheet = workbook.Sheets[sheetName];

  const jsonDataRaw = XLSX.utils.sheet_to_json(worksheet, {
    header: 1,
    defval: "",
  });

  // Asumiendo columna SKU en índice 1 (segunda columna)
  const skus = jsonDataRaw
    .slice(1)
    .map((row) => row[1])
    .filter((sku) => sku && sku.toString().trim() !== "");

  return skus;
}

function actualizarFechaChequeo(rutaLocal, skusProcesados) {
  const workbook = XLSX.readFile(rutaLocal);
  const sheetName = workbook.SheetNames[0];
  const worksheet = workbook.Sheets[sheetName];
  const jsonData = XLSX.utils.sheet_to_json(worksheet, {
    header: 1,
    defval: "",
  });

  const now = new Date();
  const fechaHoy = new Date().toLocaleString(); // fecha + hora, según  configuración regional

  for (let i = 1; i < jsonData.length; i++) {
    const skuFila = String(jsonData[i][1]).trim();
    if (skusProcesados.includes(skuFila)) {
      jsonData[i][2] = fechaHoy;
    }
  }

  const nuevaHoja = XLSX.utils.aoa_to_sheet(jsonData);
  workbook.Sheets[sheetName] = nuevaHoja;
  XLSX.writeFile(workbook, rutaLocal);
  logger.info("✅ Fecha de chequeo actualizada en el Excel.");
}

module.exports = {
  descargarExcel,
  obtenerSkusDesdeArchivoLocal,
  actualizarFechaChequeo,
};
