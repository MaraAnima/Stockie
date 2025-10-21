// service/storage.js
const fs = require("fs");
const path = require("path");

const DATA_DIR = path.join(__dirname, "data");
const DB_PATH = path.join(DATA_DIR, "audits.json");

function ensure() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(DB_PATH)) fs.writeFileSync(DB_PATH, JSON.stringify({ days: {} }, null, 2));
}

function readDB() {
  ensure();
  return JSON.parse(fs.readFileSync(DB_PATH, "utf8"));
}

function writeDB(db) {
  ensure();
  fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
}

function getDay(dateStr) {
  const db = readDB();
  const day = db.days[dateStr] || [];
  return { db, day };
}

function saveResults(dateStr, rows) {
  const db = readDB();
  db.days[dateStr] = rows;
  writeDB(db);
}

function upsertResult(dateStr, row) {
  const { db, day } = getDay(dateStr);
  const idx = day.findIndex((r) => String(r.sku).trim().toLowerCase() === String(row.sku).trim().toLowerCase());
  if (idx >= 0) day[idx] = row; else day.push(row);
  db.days[dateStr] = day;
  writeDB(db);
}

function deleteResult(dateStr, sku) {
  const { db, day } = getDay(dateStr);
  const next = day.filter((r) => String(r.sku).trim().toLowerCase() !== String(sku).trim().toLowerCase());
  db.days[dateStr] = next;
  writeDB(db);
}

module.exports = {
  readDB,
  getDay,
  saveResults,
  upsertResult,
  deleteResult,
};
