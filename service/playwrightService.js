require("dotenv").config();
const path = require("path");
const logger = require(path.resolve(__dirname, "documentation", "logger"));

async function login(page) {
  await page.goto(
    "https://turacion.com/login?ReturnUrl=%2FAdmin%2FProduct%2FList"
  );
  await page.fill("#Email", process.env.TURACION_EMAIL);
  await page.fill("#Password", process.env.TURACION_PASSWORD);

  await Promise.all([
    page.waitForNavigation({ waitUntil: "networkidle" }),
    page.click('input.button-1.login-button[type="submit"]'),
  ]);
  logger.info("✅ Login realizado con éxito");
}

async function procesarSku(page, sku) {
  let resumenCompleto = "";
  let RegaloAEleccion = "No";
  let resumenML = "";
  let resumenWeb = "";
  let marca = null;

  logger.info(`\n🔎 Buscando SKU: ${sku}`);
  const skuNormalized = String(sku).replace(/\s+/g, "").toLowerCase();

  await page.fill("#SearchProductName", String(sku));
  await page.press("#SearchProductName", "Enter");
  await page.waitForSelector('tr[role="row"]');
  await page.waitForTimeout(3000);

  const filas = await page.$$('tr[role="row"]');
  let enlacesAProcesar = [];

  for (const fila of filas) {
    const celdas = await fila.$$("td");
    if (celdas.length < 4) continue;

    const tituloRaw = await fila.$eval("td:nth-child(3)", (el) =>
      el.textContent.toLowerCase()
    );
    if (
      tituloRaw.includes("promo express") ||
      tituloRaw.includes("mvdeo mascotas")
    )
      continue;
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
    };
  }
  const baseUrl = "https://turacion.com/Admin/Product/List";

  let indicesConRegalo = [];
  for (let i = 0; i < enlacesAProcesar.length; i++) {
    const href = enlacesAProcesar[i];
    const urlParaNavegar = new URL(href, baseUrl).href;
    await Promise.all([
      page.waitForNavigation({ waitUntil: "networkidle" }),
      page.goto(urlParaNavegar),
    ]);
    const filasRegalo = await page.$$(
      '#productattributemappings-grid tbody tr[role="row"]'
    );
    if (filasRegalo.length > 0) {
      indicesConRegalo.push(i);
    }
    await Promise.all([
      page.waitForNavigation({ waitUntil: "networkidle" }),
      page.goto(baseUrl),
    ]);
  }

  for (let i = 0; i < enlacesAProcesar.length; i++) {
    const href = enlacesAProcesar[i];
    const urlParaNavegar = new URL(href, baseUrl).href;
    await Promise.all([
      page.waitForNavigation({ waitUntil: "networkidle" }),
      page.goto(urlParaNavegar),
    ]);
    let activarCheckboxes = false;
    if (indicesConRegalo.length > 0) {
      // Solo activar en los que tienen regalo
      activarCheckboxes = indicesConRegalo.includes(i);
      if (activarCheckboxes) RegaloAEleccion = "Si";
    } else {
      // Si ninguno tiene regalo, activar en todos
      activarCheckboxes = true;
      RegaloAEleccion = "No";
    }

    if (activarCheckboxes) {
      const checkboxes = ["#Published", "#VisibleIndividually"];
      for (const selector of checkboxes) {
        await page.waitForSelector(selector);
        if (!(await page.isChecked(selector))) {
          await page.check(selector);
          logger.info(`Checkbox ${selector} fue chequeado.`);
        }
      }
      const selectorDisable = "#DisableBuyButton";
      await page.waitForSelector(selectorDisable);
      if (await page.isChecked(selectorDisable)) {
        await page.click(selectorDisable);
        logger.info(`Checkbox ${selectorDisable} fue deshabilitado.`);
      }
      logger.info("✅ Checkboxes activados para este enlace.");
    } else {
      logger.info("🔕 No se activan checkboxes para este enlace.");
    }

    // Mercado Libre publicaciones
    const selectorContenedor = "#productsMeliList-grid_wrapper";
    await page.waitForSelector(`${selectorContenedor} tbody`);
    const filasML = await page.$$(`${selectorContenedor} tbody tr`);

    let hayActivo = false;
    let hayBajoRevision = false;
    if (filasML.length === 0) {
      logger.info("Es necesario Publicar el articulo de ML");
    }

    for (const filaML of filasML) {
      const estadoSpan = await filaML.$("span.grid-report-item");
      if (!estadoSpan) continue;
      const clases = await estadoSpan.getAttribute("class");
      if (clases.includes("green")) hayActivo = true;
      else if (clases.includes("red")) hayBajoRevision = true;
    }

    await page.click('button[name="save-continue"]');

    const publicadoEnEstaPublicacion = await page.isChecked("#Published");
    const publicadoEnWeb = publicadoEnEstaPublicacion;

    const marcasEspeciales = [
      "acana",
      "orijen",
      "guabi",
      "gran plus",
      "naturalis",
      "formula natural",
      "multivet",
    ];
    // Resumen
    await page.waitForSelector('li[role="option"] span'); // aseguramos que cargue

    // Obtenemos todas las opciones visibles
    const opciones = await page.$$eval('li[role="option"] span', (spans) =>
      spans.map((s) => s.textContent.trim().toLowerCase())
    );

    logger.info("Opciones detectadas en el DOM:", opciones);

    let marca = null;
    for (const opcion of opciones) {
      if (marcasEspeciales.includes(opcion)) {
        marca = opcion;
        break;
      }
    }

    if (marcasEspeciales.includes(marca)) {
      switch (marca) {
        case "acana":
        case "orijen":
        case "guabi":
        case "gran plus":
        case "naturalis":
        case "formula natural":
        case "multivet":
          if (!hayActivo && !hayBajoRevision) {
            resumenML = `No activo en ML por que es ${marca}`;
          } else if (hayActivo) {
            resumenML = `Marca ${marca}: Está activo en Mercado Libre pero debería revisarse`;
          }
          break;
        default:
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

    logger.info(`Resumen completo: ${resumenCompleto}`);

    // Volver a la lista para el siguiente enlace
    await Promise.all([
      page.waitForNavigation({ waitUntil: "networkidle" }),
      page.goto(baseUrl),
    ]);
    await page.waitForSelector('tr[role="row"]');
  }

  return {
    resumenCompleto,
    resumenML,
    resumenWeb,
    RegaloAEleccion,
  };
}
module.exports = { procesarSku, login };
