const fs = require("fs");
const path = require("path");
const http = require("http");
const { google } = require("googleapis");
const logger = require(path.resolve(__dirname, "documentation", "logger"));

const SCOPES = [
  "https://www.googleapis.com/auth/spreadsheets",
  "https://www.googleapis.com/auth/drive.file",
];

const TOKEN_PATH = path.resolve(__dirname, "..", "token.json");
const CREDENTIALS_PATH = path.resolve(__dirname, "..", "credentials.json");

async function authorize() {
  const credentials = JSON.parse(fs.readFileSync(CREDENTIALS_PATH, "utf8"));
  const { client_secret, client_id, redirect_uris } = credentials.installed;

  const oAuth2Client = new google.auth.OAuth2(
    client_id,
    client_secret,
    redirect_uris[0] || "http://localhost:3000/oauth2callback"
  );

  if (fs.existsSync(TOKEN_PATH)) {
    try {
      const token = JSON.parse(fs.readFileSync(TOKEN_PATH, "utf8"));
      oAuth2Client.setCredentials(token);

      const sheets = google.sheets({ version: "v4", auth: oAuth2Client });
      await sheets.spreadsheets.get({
        spreadsheetId: process.env.SPREADSHEET_ID,
      });
      return oAuth2Client;
    } catch (err) {
      logger.warn("Token inválido o sin acceso, se regenerará");
      fs.unlinkSync(TOKEN_PATH);
    }
  }
  return getNewToken(oAuth2Client);
}

function getNewToken(oAuth2Client) {
  return new Promise((resolve, reject) => {
    const authUrl = oAuth2Client.generateAuthUrl({
      access_type: "offline",
      prompt: "consent", // asegura refresh_token
      scope: SCOPES,
    });
    logger.info(`Abrí este link para autorizar:\n${authUrl}`);

    const server = http.createServer(async (req, res) => {
      if (req.url.startsWith("/oauth2callback")) {
        const urlParams = new URL(req.url, "http://localhost:3000");
        const code = urlParams.searchParams.get("code");

        try {
          const { tokens } = await oAuth2Client.getToken(code);
          oAuth2Client.setCredentials(tokens);
          fs.writeFileSync(TOKEN_PATH, JSON.stringify(tokens, null, 2));
          res.end("✅ Autorización completa, ya podés cerrar esta ventana.");
          logger.info("Token guardado en token.json");
          server.close();
          resolve(tokens);
        } catch (err) {
          res.end("❌ Error en la autorización.");
          logger.error(err);
          server.close();
          reject(err);
        }
      }
    });

    server.listen(3000, () => {
      logger.info(
        "Esperando autorización en http://localhost:3000/oauth2callback ..."
      );
    });
  });
}

async function actualizarCelda(auth, spreadsheetId, rango, valor) {
  const sheets = google.sheets({ version: "v4", auth });
  const resource = { values: [[valor]] };

  return sheets.spreadsheets.values.update({
    spreadsheetId,
    range: rango,
    valueInputOption: "RAW",
    resource,
  });
}
async function obtenerValorCelda(auth, spreadsheetId, rango) {
  const sheets = google.sheets({ version: "v4", auth });
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: rango, // Ejemplo: "Hoja1!C2"
  });
  const values = res.data.values;
  if (values && values.length > 0 && values[0].length > 0) {
    return values[0][0];
  }
  return "";
}

module.exports = { authorize, actualizarCelda, obtenerValorCelda };
