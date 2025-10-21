// service/playwrightService.js
require("dotenv").config();
const path = require("path");
const logger = require(path.resolve(__dirname, "documentation", "logger"));

const ADMIN_URL = "https://turacion.com/Admin/Product/List";
const LOGIN_URL =
  "https://turacion.com/login?ReturnUrl=%2FAdmin%2FProduct%2FList";

const READ_ONLY = process.env.READ_ONLY === "true";

async function login(page) {
  // 1) Intento entrar directo al admin (por si ya hay sesión)
  await page.goto(ADMIN_URL, { waitUntil: "domcontentloaded" });

  // 2) Si redirige a /login, completar credenciales
  if (page.url().includes("/login")) {
    await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded" });

    // (opcional) aceptar cookies si existiera algún banner
    const cookieButtons = [
      'button:has-text("Aceptar")',
      'button:has-text("Acepto")',
      "#onetrust-accept-btn-handler",
      ".cookie-accept, .cookies-accept",
    ];
    for (const sel of cookieButtons) {
      try {
        const el = await page.$(sel);
        if (el) {
          await el.click({ timeout: 1000 }).catch(() => {});
          break;
        }
      } catch {}
    }

    await page.waitForSelector("#Email", { timeout: 60000 });
    await page.fill("#Email", process.env.TURACION_EMAIL);
    await page.fill("#Password", process.env.TURACION_PASSWORD);

    await Promise.all([
      page.waitForNavigation({ waitUntil: "networkidle" }),
      page.click('input.button-1.login-button[type="submit"]'),
    ]);
  }

  // 3) Verificamos que estamos en la lista del admin
  await page.waitForSelector("#SearchProductName", { timeout: 60000 });
  logger.info("✅ Login realizado con éxito");
}

async function procesarSku(page, sku) {
  let resumenCompleto = "";
  let RegaloAEleccion = "No";
  let resumenML = "";
  let resumenWeb = "";
  let titulo = "";
  let resumenesPorEnlace = [];
  let descripcionML = null;
  let descripcionLarga = null;
  let descripcionCompleta = null;

  logger.info(`\n🔎 Buscando SKU: ${sku}`);
  const skuNormalized = String(sku).replace(/\s+/g, "").toLowerCase();

  // Siempre partimos de la lista y hacemos una búsqueda "limpia"
  await page.goto(ADMIN_URL, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#SearchProductName", { timeout: 30000 });

  await page.fill("#SearchProductName", "");
  await page.type("#SearchProductName", String(sku));
  await Promise.all([
    page.waitForLoadState("networkidle"),
    page.press("#SearchProductName", "Enter"),
  ]);

  await page.waitForSelector('tr[role="row"]', { timeout: 30000 });

  const filas = await page.$$('tr[role="row"]');
  let enlacesAProcesar = [];

  for (const fila of filas) {
    const celdas = await fila.$$("td");
    if (celdas.length < 4) continue;

    const tituloRaw = await fila.$eval("td:nth-child(3)", (el) =>
      el.textContent.toLowerCase()
    );

    // Filtramos títulos que no nos interesan
    if (
      tituloRaw.includes("promo express") ||
      tituloRaw.includes("mvdeo mascotas")
    ) {
      continue;
    }
    // Guardamos último título "válido" visto
    titulo = tituloRaw;

    const skuRaw = await fila.$eval("td:nth-child(4)", (el) =>
      el.textContent.replace(/\s+/g, "").toLowerCase()
    );

    if (skuRaw === skuNormalized) {
      const boton = await fila.$("button.btn, a.btn");
      if (boton) {
        const tagName = await boton.evaluate((el) => el.tagName.toLowerCase());
        if (tagName === "a") {
          const href = await boton.getAttribute("href");
          if (href) enlacesAProcesar.push(href);
        }
      }
    }
  }

  if (enlacesAProcesar.length === 0) {
    logger.info(`❌ No se encontraron enlaces para SKU ${sku}`);
    return {
      resumenCompleto:
        "No se encontró publicación ni en la web ni en Mercado Libre",
      resumenML: "No se encontró publicación en Mercado Libre",
      resumenWeb: "No se encontró publicación en la web",
      RegaloAEleccion: "No",
      titulo,
      resumenesPorEnlace,
      descripcionCompleta: "No tiene descripción completa",
    };
  }

  // Primer pasada: sólo chequeos (descripciones / regalo / ML)
  let indicesConRegalo = [];
  for (let i = 0; i < enlacesAProcesar.length; i++) {
    const href = enlacesAProcesar[i];
    const urlParaNavegar = new URL(href, ADMIN_URL).href;

    await page.goto(urlParaNavegar, { waitUntil: "networkidle" });

    // Descripción larga (TinyMCE)
    try {
      const frame = page.frameLocator("#FullDescription_ifr");
      const body = frame.locator("body#tinymce");
      await body.waitFor({ state: "visible", timeout: 5000 });

      const innerHTML = await body.evaluate((el) => el.innerHTML.trim());
      const innerText = await body.evaluate((el) => el.innerText.trim());
      const descripcionVacia =
        innerHTML === "" || innerHTML === "<p><br></p>" || innerText === "";

      descripcionLarga = descripcionVacia ? "No tiene descripción" : "Tiene descripción";
    } catch (err) {
      logger.warn(
        `⚠️ No se pudo verificar el contenido de TinyMCE para SKU ${sku}: ${err.message}`
      );
    }

    // Descripción corta (ML)
    try {
      const descripcionCorta = await page.$eval("#ShortDescription", (el) =>
        el.value.trim()
      );
      descripcionML =
        !descripcionCorta || descripcionCorta === ""
          ? "No tiene descripcionML"
          : "Tiene descripcionML";
    } catch (err) {
      logger.warn(
        `⚠️ No se pudo verificar la descripción corta para SKU ${sku}: ${err.message}`
      );
    }

    if (
      descripcionML === "No tiene descripcionML" ||
      descripcionLarga === "No tiene descripción"
    ) {
      descripcionCompleta = "No tiene descripción completa";
    } else if (
      descripcionML === "Tiene descripcionML" &&
      descripcionLarga === "Tiene descripción"
    ) {
      descripcionCompleta = "Tiene descripción completa";
    }

    // Regalo (si hay filas en el grid de atributos)
    try {
      const filasRegalo = await page.$$(
        '#productattributemappings-grid tbody tr[role="row"]'
      );
      if (filasRegalo.length > 0) indicesConRegalo.push(i);
    } catch {}

    // Volvemos a la lista para garantizar estado limpio si hiciera falta
    await page.goto(ADMIN_URL, { waitUntil: "networkidle" });
    await page.waitForSelector('tr[role="row"]', { timeout: 30000 });
  }

  // Segunda pasada: publicación Web/ML + (opcionalmente) aplicar cambios
  for (let i = 0; i < enlacesAProcesar.length; i++) {
    const href = enlacesAProcesar[i];
    const urlParaNavegar = new URL(href, ADMIN_URL).href;

    await page.goto(urlParaNavegar, { waitUntil: "networkidle" });

    // Determinar si debemos "activar" checkboxes en esta publicación
    let activarCheckboxes = false;
    if (indicesConRegalo.length > 0) {
      activarCheckboxes = indicesConRegalo.includes(i);
      if (activarCheckboxes) RegaloAEleccion = "Si";
    } else {
      activarCheckboxes = true;
      RegaloAEleccion = "No";
    }

    if (!READ_ONLY && activarCheckboxes) {
      const checkboxes = ["#Published", "#VisibleIndividually"];
      for (const selector of checkboxes) {
        await page.waitForSelector(selector, { timeout: 15000 });
        if (!(await page.isChecked(selector))) {
          await page.check(selector);
          logger.info(`☑️  Checkbox ${selector} fue chequeado.`);
        }
      }
      const selectorDisable = "#DisableBuyButton";
      await page.waitForSelector(selectorDisable, { timeout: 15000 });
      if (await page.isChecked(selectorDisable)) {
        await page.click(selectorDisable);
        logger.info(`☑️  Checkbox ${selectorDisable} fue deshabilitado.`);
      }
      logger.info("✅ Checkboxes activados para este enlace.");
    } else {
      logger.info(READ_ONLY ? "🔎 Modo lectura: no se aplican cambios" : "🔕 No se activan checkboxes para este enlace.");
    }

    // Método de inventario
    try {
      await page.waitForSelector("#ManageInventoryMethodId", { timeout: 15000 });
      const options = await page.$$("#ManageInventoryMethodId option");
      let found = false;
      for (const option of options) {
        const text = (await option.textContent()) || "";
        if (text.includes("Seguimiento de inventario")) {
          const value = await option.getAttribute("value");
          const selectedValue = await page.$eval(
            "#ManageInventoryMethodId",
            (el) => el.value
          );
          if (!READ_ONLY && selectedValue !== value) {
            await page.selectOption("#ManageInventoryMethodId", value);
            logger.info('✅ Se seleccionó "Seguimiento de inventario".');
          } else {
            logger.info('ℹ️ "Seguimiento de inventario" ya estaba seleccionado.');
          }
          found = true;
          break;
        }
      }
      if (!found) {
        logger.info('⚠️ No se encontró "Seguimiento de inventario" en el método.');
      }
    } catch (err) {
      logger.warn(`⚠️ Error verificando método de inventario: ${err.message}`);
    }

    // Mercado Libre: estados
    const selectorContenedor = "#productsList-grid";
    await page.waitForSelector(`${selectorContenedor} tbody`, { timeout: 15000 });
    const filasML = await page.$$(`${selectorContenedor} tbody tr`);

    let hayActivo = false;
    let hayBajoRevision = false;

    if (filasML.length === 0) {
      logger.info("ℹ️ No hay publicaciones de ML en la grilla.");
    } else {
      for (const filaML of filasML) {
        const estadoSpan = await filaML.$("span.grid-report-item");
        if (!estadoSpan) continue;
        const clases = (await estadoSpan.getAttribute("class")) || "";
        if (clases.includes("green")) hayActivo = true;
        else if (clases.includes("red")) hayBajoRevision = true;
      }
    }

    if (!READ_ONLY) {
      // Guardar cambios si corresponde
      try {
        await page.click('button[name="save-continue"]', { timeout: 10000 });
      } catch {}
    }

    const publicadoEnWeb = await page.isChecked("#Published").catch(() => false);

    // Categoría/marca especial
    let marca = null;
    try {
      await page.waitForSelector('li[role="option"] span', { timeout: 10000 });
      const opciones = await page.$$eval('li[role="option"] span', (spans) =>
        spans.map((s) => s.textContent.trim().toLowerCase())
      );
      const marcasEspeciales = [
        "acana",
        "orijen",
        "guabi",
        "gran plus",
        "naturalis",
        "formula natural",
        "multivet",
      ];
      marca = opciones.find((o) => marcasEspeciales.includes(o)) || null;
    } catch (err) {
      logger.warn(`⚠️ No se pudieron leer categorías/marcas: ${err.message}`);
    }

    // Reglas ML
    if (marca) {
      if (!hayActivo && !hayBajoRevision) {
        resumenML = `No activo en ML por que es ${marca}`;
      } else if (hayActivo) {
        resumenML = `Marca ${marca}: Está activo en Mercado Libre pero debería revisarse`;
      } else {
        resumenML = "Marca no contemplada para reglas especiales";
      }
    } else {
      if (!hayActivo && !hayBajoRevision) {
        resumenML = "No está publicado en Mercado Libre";
      } else if (hayActivo && !hayBajoRevision) {
        resumenML = "Está publicado correctamente en Mercado Libre";
      } else if (hayActivo && hayBajoRevision) {
        resumenML =
          "Hay publicaciones activas y algunas bajo revisión en Mercado Libre";
      } else if (!hayActivo && hayBajoRevision) {
        resumenML =
          "Todas las publicaciones están bajo revisión en Mercado Libre";
      }
    }

    resumenWeb = publicadoEnWeb
      ? "Está publicado en la web"
      : "No está publicado en la web";

    resumenCompleto = `${resumenML} y ${resumenWeb}`;
    resumenesPorEnlace.push(
      `🔗 Publicación ${i + 1}: ${resumenML} | ${resumenWeb} | Regalo a elección: ${RegaloAEleccion}`
    );

    logger.info(`Resumen completo: ${resumenCompleto}`);

    // Regresamos a la lista para continuar con el próximo enlace
    await page.goto(ADMIN_URL, { waitUntil: "networkidle" });
    await page.waitForSelector('tr[role="row"]', { timeout: 30000 });
  }

  return {
    resumenCompleto,
    resumenML,
    resumenWeb,
    RegaloAEleccion,
    titulo,
    resumenesPorEnlace,
    descripcionCompleta,
  };
}

module.exports = { procesarSku, login };
