// ============================================================
// INGECO Dashboard — Backend (Google Apps Script Web App)
// ============================================================
// INSTALACIÓN — leer instrucciones abajo antes de desplegar
//
// 1. Ir a https://script.google.com → Nuevo proyecto
// 2. Borrar el código vacío y pegar ESTE archivo completo
// 3. Implementar → Nueva implementación → Aplicación web
//    - Tipo: Aplicación web
//    - Ejecutar como: Yo (tu cuenta Google)
//    - Acceso: Cualquier usuario
// 4. Hacer clic en "Implementar" y autorizar el acceso a Drive
// 5. Copiar la URL que aparece ("URL de la aplicación web")
// 6. En dashboard_ingeco.html, reemplazar:
//      const APPS_SCRIPT_URL = '';
//    por:
//      const APPS_SCRIPT_URL = 'https://script.google.com/macros/s/TU_ID/exec';
// 7. (Opcional pero recomendado) Ejecutar configurarTriggerNocturno()
//    UNA VEZ desde el editor para activar actualizaciones automáticas
// ============================================================

// IDs de los archivos en Google Drive
const FILE_IDS = {
  tangoFolder:  '1hQZoJovbFDHNsJhNiGMEueH1bLfXuuCP',              // Carpeta liquidaciones TANGO (Mauro) — un archivo por mes
  ocInsumos:    '1_lhq9c1MddkrK1Tf0kexRtgqw5aPhmZWiQkAIRjpfxs',  // OC Insumos — Google Sheet (Guillermo)
  maestroObras: '1VbG7DPqaOSlYkvQxbxag-4P2sOoRJQwWGccbx9OMyBM',  // Maestro de Obras con COD_OBRA
  fernandoObras:'1vGY8-saBKS4XAwd4RRqacNYRS7W0KV9brDBEo3_Jn0A',  // Obras activas (Fernando Solís)
  equiposFlota: '1PEcPzwrQ8kE2evmUlrFq9wPbgWOR92MPl3LEqcSYbIk',  // Equipos + PF mensual (Adrián)
  usageEquipos:     '1e_emRVEUxTaNtLxeC0wXIWKzcKuoulZkFSS9O1e0XHo',  // Partes diarios — hoja única (Nico)
  repuestosEquipos: '1JpXjGTJwlvMuEI-rFTd4KeKvzd708-yuSLAhIRuCFC0',  // Compra de repuestos — hoja ENTREGAS (Nico)
  remitosAsfalto:   '13z7EEuVIedOwl85d_f8MEoJGCEioZO7m9Cbn8MWxihI',  // REMITOS OFICIALES (Roberto)
  ajusteStock:    '1yZArsIKYMfq9UPUXyiASXtDNXyubTjFx3PPW2VjG-uA',  // Formulario Ingreso Asfalto Agustín
  precioAsfalto:  '1lqKTXtDLT2FxyXurxjU1uE4epDOKs5SP8AXu5wAUsJ4',  // Precio de mercado asfalto $/tn por mes
};

// Tipo de cambio USD → ARS oficial promedio mensual (Banco Nación Argentina)
// Actualizar cada mes con el promedio del período
const TC_USD_MENSUAL = { feb: 1430, mar: 1413, abr: 1397, may: 1381, jun: 1170 };

// Cache en PropertiesService — evita leer Drive en cada request
const PROPS = PropertiesService.getScriptProperties();
const CACHE_KEY = 'ingeco_cache';

// ============================================================
// ENDPOINT PRINCIPAL — el dashboard llama a esta URL
// ============================================================
function doGet(e) {
  try {
    const callback = e && e.parameter && e.parameter.callback;
    const action   = e && e.parameter && e.parameter.action;

    // ── Ajuste de stock ──────────────────────────────────────────
    if (action === 'ajusteStock') {
      const stockAntes = parseFloat((e.parameter.stockAntes || '0').replace(',', '.'));
      const stockNuevo = parseFloat((e.parameter.stockNuevo || '0').replace(',', '.'));
      const usuario    = e.parameter.usuario || 'Agustín';
      const resultado  = guardarAjusteStock(stockAntes, stockNuevo, usuario);
      const json       = JSON.stringify(resultado);
      if (callback) {
        return ContentService.createTextOutput(callback + '(' + json + ')')
          .setMimeType(ContentService.MimeType.JAVASCRIPT);
      }
      return ContentService.createTextOutput(json).setMimeType(ContentService.MimeType.JSON);
    }

    const useCache  = e && e.parameter && e.parameter.cache === '1';

    let data;
    if (useCache) {
      const cached = PROPS.getProperty(CACHE_KEY);
      data = cached ? JSON.parse(cached) : buildData();
      // Cada campo grande se guarda en su propia clave (límite 9 KB por propiedad)
      if (data && !data.generadoPorObra) {
        const cachedObras = PROPS.getProperty(CACHE_KEY + '_obras');
        if (cachedObras) data.generadoPorObra = JSON.parse(cachedObras);
      }
      if (data && !data.alquilerEquipos) {
        const cachedAlquiler = PROPS.getProperty(CACHE_KEY + '_alquiler');
        if (cachedAlquiler) data.alquilerEquipos = JSON.parse(cachedAlquiler);
      }
      if (data && !data.moCtroCosto) {
        const cachedMo = PROPS.getProperty(CACHE_KEY + '_mo');
        if (cachedMo) data.moCtroCosto = JSON.parse(cachedMo);
      }
      if (data && !data.ocInsumos) {
        const cachedOc = PROPS.getProperty(CACHE_KEY + '_oc');
        if (cachedOc) data.ocInsumos = JSON.parse(cachedOc);
      }
      if (data && !data.remitosAsfalto) {
        const cachedRem = PROPS.getProperty(CACHE_KEY + '_remitos');
        if (cachedRem) data.remitosAsfalto = JSON.parse(cachedRem);
      }
    } else {
      data = buildData();
      // Guardar cada campo en su propia clave — PropertiesService tiene límite de 9 KB por propiedad
      try {
        PROPS.setProperty(CACHE_KEY, JSON.stringify({ status: data.status, timestamp: data.timestamp }));
      } catch(ce) { Logger.log('Cache write error: ' + ce); }
      try {
        if (data.generadoPorObra) PROPS.setProperty(CACHE_KEY + '_obras', JSON.stringify(data.generadoPorObra));
      } catch(ce) { Logger.log('Cache write (obras) error: ' + ce); }
      try {
        if (data.alquilerEquipos) PROPS.setProperty(CACHE_KEY + '_alquiler', JSON.stringify(data.alquilerEquipos));
      } catch(ce) { Logger.log('Cache write (alquiler) error: ' + ce); }
      try {
        if (data.moCtroCosto) PROPS.setProperty(CACHE_KEY + '_mo', JSON.stringify(data.moCtroCosto));
      } catch(ce) { Logger.log('Cache write (mo) error: ' + ce); }
      try {
        if (data.ocInsumos) PROPS.setProperty(CACHE_KEY + '_oc', JSON.stringify(data.ocInsumos));
      } catch(ce) { Logger.log('Cache write (oc) error: ' + ce); }
      try {
        if (data.remitosAsfalto) PROPS.setProperty(CACHE_KEY + '_remitos', JSON.stringify(data.remitosAsfalto));
      } catch(ce) { Logger.log('Cache write (remitos) error: ' + ce); }
    }

    const json = JSON.stringify(data);

    // JSONP: el dashboard llama con ?callback=xxx para evitar el bloqueo CORS
    if (callback) {
      return ContentService
        .createTextOutput(callback + '(' + json + ')')
        .setMimeType(ContentService.MimeType.JAVASCRIPT);
    }
    return ContentService
      .createTextOutput(json)
      .setMimeType(ContentService.MimeType.JSON);

  } catch (err) {
    const errJson = JSON.stringify({ status: 'error', message: err.toString() });
    const callback = e && e.parameter && e.parameter.callback;
    if (callback) {
      return ContentService.createTextOutput(callback + '(' + errJson + ')')
        .setMimeType(ContentService.MimeType.JAVASCRIPT);
    }
    return ContentService.createTextOutput(errJson).setMimeType(ContentService.MimeType.JSON);
  }
}

// ============================================================
// ACTUALIZACIÓN NOCTURNA — ejecutada por el trigger automático
// ============================================================
function actualizarNocturno() {
  try {
    const data = buildData();
    PROPS.setProperty(CACHE_KEY, JSON.stringify({ status: data.status, timestamp: data.timestamp }));
    if (data.generadoPorObra) PROPS.setProperty(CACHE_KEY + '_obras',   JSON.stringify(data.generadoPorObra));
    if (data.alquilerEquipos) PROPS.setProperty(CACHE_KEY + '_alquiler', JSON.stringify(data.alquilerEquipos));
    if (data.moCtroCosto)     PROPS.setProperty(CACHE_KEY + '_mo',       JSON.stringify(data.moCtroCosto));
    if (data.ocInsumos)       PROPS.setProperty(CACHE_KEY + '_oc',       JSON.stringify(data.ocInsumos));
    if (data.remitosAsfalto)  PROPS.setProperty(CACHE_KEY + '_remitos',  JSON.stringify(data.remitosAsfalto));
    Logger.log('Cache actualizado: ' + data.timestamp);
  } catch (err) {
    Logger.log('Error en trigger nocturno: ' + err.toString());
  }
}

// ============================================================
// CONSTRUIR EL OBJETO DE DATOS COMPLETO
// ============================================================
function buildData() {
  const result = {
    status:      'ok',
    timestamp:   new Date().toISOString(),
    moCtroCosto: leerTangoMO(),
    ocInsumos:   leerOCInsumos(),
  };
  try { result.generadoPorObra  = leerGeneradoPorObra(); }
  catch(e) { Logger.log('generadoPorObra error: ' + e); result.generadoPorObra = null; }
  try { result.alquilerEquipos  = leerAlquilerEquipos(); }
  catch(e) { Logger.log('alquilerEquipos error: ' + e); result.alquilerEquipos = null; }
  try { result.remitosAsfalto   = leerRemitosAsfalto(); }
  catch(e) { Logger.log('remitosAsfalto error: ' + e); result.remitosAsfalto = null; }
  try { result.repuestosEquipos = leerRepuestosEquipos(); }
  catch(e) { Logger.log('repuestosEquipos error: ' + e); result.repuestosEquipos = null; }
  try {
    result.stockAsfalto = leerStockAsfalto(result.remitosAsfalto);
    // _detalle tiene objetos Date internos — no se envía al dashboard
    if (result.remitosAsfalto) delete result.remitosAsfalto._detalle;
  }
  catch(e) { Logger.log('stockAsfalto error: ' + e); result.stockAsfalto = null; }
  try { result.precioAsfalto = leerPrecioAsfalto(); }
  catch(e) { Logger.log('precioAsfalto error: ' + e); result.precioAsfalto = null; }
  return result;
}

// ============================================================
// TANGO — MO por Centro de Costo (1° Quincena)
// ============================================================
// Lee todos los archivos de la carpeta de Mauro y devuelve { ene: [...], feb: [...], abr: [...] }
function leerTangoMO() {
  try {
    const folder  = DriveApp.getFolderById(FILE_IDS.tangoFolder);
    const files   = folder.getFiles();
    const resultado = {};

    while (files.hasNext()) {
      const file    = files.next();
      const nombre  = file.getName().toUpperCase();

      // Detectar mes desde el nombre del archivo
      // Soporta formato numérico "MM-YYYY" (ej: "01-2026 QUINCENAS") y texto (ENE, FEB...)
      let mes = null;
      const mNum = nombre.match(/^(\d{2})-\d{4}/);
      if (mNum) {
        const n = parseInt(mNum[1]);
        const MAP = { 1:'ene', 2:'feb', 3:'mar', 4:'abr', 5:'may', 6:'jun',
                      7:'jul', 8:'ago', 9:'sep', 10:'oct', 11:'nov', 12:'dic' };
        mes = MAP[n] || null;
      } else if (nombre.includes('ENE') || nombre.includes('ENERO'))    mes = 'ene';
      else if (nombre.includes('FEB') || nombre.includes('FEBRERO'))  mes = 'feb';
      else if (nombre.includes('MAR') || nombre.includes('MARZO'))    mes = 'mar';
      else if (nombre.includes('ABR') || nombre.includes('ABRIL'))    mes = 'abr';

      if (!mes) {
        Logger.log('Tango — no se detectó mes en: ' + file.getName() + ' — omitido');
        continue;
      }

      Logger.log('Tango — procesando "' + file.getName() + '" → ' + mes);
      const data = parsearArchivoTangoMO(file);
      if (data && data.length > 0) resultado[mes] = data;
    }

    Logger.log('Tango MO — meses cargados: ' + Object.keys(resultado).join(', '));
    return resultado;

  } catch (err) {
    Logger.log('leerTangoMO error: ' + err.toString());
    return null;
  }
}

// Parsea un archivo de TANGO (Google Sheet o CSV) y devuelve [{centro, monto}]
// Si es Google Sheet: suma todas las pestañas (= ambas quincenas del mes)
function parsearArchivoTangoMO(file) {
  try {
    const mime = file.getMimeType();
    if (mime === 'application/vnd.google-apps.spreadsheet') {
      return parsearGSheetTangoMO(file);
    }
    // Fallback CSV/TXT
    return parsearCsvTangoMO(file);
  } catch (err) {
    Logger.log('parsearArchivoTangoMO error (' + file.getName() + '): ' + err.toString());
    return null;
  }
}

// Lee un Google Sheet con N pestañas (quincenas) y acumula los totales por obra
// Soporta dos formatos de TANGO:
//   Formato A: columnas OBRA + TOTAL QUINCENA C/REDONDEO PARA PAGO EN EFECTIVO
//   Formato B: columnas CTRO COSTO + NETO (resumen por centro de costo)
function parsearGSheetTangoMO(file) {
  const ss     = SpreadsheetApp.openById(file.getId());
  const sheets = ss.getSheets();
  const totales = {}; // key = "centro||clasificacion"

  for (const sheet of sheets) {
    const rows = sheet.getDataRange().getValues();

    let hdrIdx = -1, iClave = -1, iMonto = -1, iClasif = -1, modo = null;

    for (let i = 0; i < Math.min(25, rows.length); i++) {
      const cells = rows[i].map(c => String(c).toUpperCase().trim());

      // Formato A: OBRA + TOTAL QUINCENA (planilla por empleado con obra asignada)
      const iObra   = cells.findIndex(c => c === 'OBRA');
      const iTotalQ = cells.findIndex(c => c.includes('TOTAL') && c.includes('QUINCENA'));
      if (iObra >= 0 && iTotalQ >= 0) {
        hdrIdx = i; iClave = iObra; iMonto = iTotalQ; modo = 'obra';
        iClasif = cells.findIndex(c => c.includes('CLASIF'));
        break;
      }

      // Formato B: CTRO/CENTRO + NETO (resumen por centro de costo)
      const iCtro = cells.findIndex(c => c.includes('CTRO') || c.includes('CENTRO'));
      const iNeto = cells.findIndex(c => c === 'NETO' || c.endsWith('NETO'));
      if (iCtro >= 0 && iNeto >= 0) {
        hdrIdx = i; iClave = iCtro; iMonto = iNeto; modo = 'ctro';
        iClasif = cells.findIndex(c => c.includes('CLASIF'));
        break;
      }
    }

    if (hdrIdx < 0) {
      Logger.log('Tango GSheet [' + sheet.getName() + '] — no se encontró header compatible, omitida');
      continue;
    }
    Logger.log('Tango GSheet [' + sheet.getName() + '] — modo=' + modo + ' hdr=' + hdrIdx + ' iClave=' + iClave + ' iMonto=' + iMonto + ' iClasif=' + iClasif);

    for (let i = hdrIdx + 1; i < rows.length; i++) {
      const row   = rows[i];
      const clave = String(row[iClave] || '').trim();
      if (!clave || clave.toUpperCase().includes('TOTAL') || clave === '') continue;

      const raw   = row[iMonto];
      const monto = typeof raw === 'number' ? raw : parsearMonto(String(raw || ''));
      if (!monto || monto <= 0) continue;

      const key    = modo === 'ctro' ? mapearCentro(clave) : clave;
      const clasif = iClasif >= 0 ? String(row[iClasif] || '').trim() || 'Obra' : 'Obra';
      const totKey = key + '||' + clasif;
      totales[totKey] = (totales[totKey] || 0) + monto;
    }
  }

  const result = Object.entries(totales)
    .map(([totKey, monto]) => {
      const sep = totKey.indexOf('||');
      return {
        centro:         sep >= 0 ? totKey.substring(0, sep) : totKey,
        monto:          Math.round(monto),
        clasificacion:  sep >= 0 ? totKey.substring(sep + 2) : 'Obra',
      };
    })
    .filter(r => r.monto > 100)
    .sort((a, b) => b.monto - a.monto);

  Logger.log('Tango GSheet "' + file.getName() + '" — ' + result.length + ' obras/centros, total=' +
    result.reduce((s, r) => s + r.monto, 0));
  return result;
}

// Fallback: parsea un CSV/TXT de TANGO exportado
function parsearCsvTangoMO(file) {
  let content;
  try {
    content = file.getBlob().getDataAsString('UTF-8');
  } catch (e) {
    content = file.getBlob().getDataAsString('ISO-8859-1');
  }

  const lines      = content.split('\n').map(l => l.trim()).filter(l => l.length > 0);
  const headerLine = lines.find(l => l.toUpperCase().includes('CTRO') && l.toUpperCase().includes('NETO'));
  if (!headerLine) return null;

  const sep     = headerLine.includes(';') ? ';' : (headerLine.includes('\t') ? '\t' : ',');
  const headers = headerLine.split(sep).map(h => h.trim().replace(/^"|"$/g, ''));
  const iCtro   = headers.findIndex(h => h.toUpperCase().includes('CTRO'));
  const iNeto   = headers.findIndex(h => h.toUpperCase() === 'NETO' || h.toUpperCase().endsWith('NETO'));
  if (iCtro < 0 || iNeto < 0) return null;

  const totales  = {};
  const startIdx = lines.indexOf(headerLine) + 1;
  for (let i = startIdx; i < lines.length; i++) {
    const cells = lines[i].split(sep).map(c => c.trim().replace(/^"|"$/g, ''));
    if (cells.length <= Math.max(iCtro, iNeto)) continue;
    const ctro = cells[iCtro];
    if (!ctro || ctro.toUpperCase().includes('TOTAL')) continue;
    const neto = parseFloat(cells[iNeto].replace(/\./g, '').replace(',', '.'));
    if (isNaN(neto) || neto <= 0) continue;
    const clave = mapearCentro(ctro);
    totales[clave] = (totales[clave] || 0) + neto;
  }

  return Object.entries(totales)
    .map(([centro, monto]) => ({ centro, monto: Math.round(monto) }))
    .filter(r => r.monto > 100)
    .sort((a, b) => b.monto - a.monto);
}

// Mapea el texto crudo de CTRO COSTO a la etiqueta usada en el dashboard
function mapearCentro(ctro) {
  const t = ctro.toUpperCase();
  if (t.includes('TALLER'))                               return 'Taller mecánico';
  if (t.includes('PTA.ASFALTO') || t.includes('PLANTA'))  return 'Planta de Asfalto (Pta.Asfalto)';
  if (t.includes('ASFALTO') || t.includes('TRITUR'))      return 'Asfalto / Trituradora (sector)';
  if (t.includes('357') || t.includes('QUILMES'))          return 'Ruta 357 - Quilmes';
  if (t.includes('PAVIM'))                                 return 'Pavimentación';
  if (t.includes('TRANSP'))                                return 'Transporte';
  if (t.includes('WARNES') || t.includes('PREDIO'))        return 'Predio Warnes';
  if (t.includes('ALDER') || t.includes('CORR') || t.includes('CANT')) return 'Otros (Alderetes / Corrientes / Cantera)';
  return ctro; // devolver tal cual si no hay mapeo
}

// ============================================================
// OC INSUMOS — Google Sheet de Guillermo Konicek
// ============================================================
function leerOCInsumos() {
  try {
    const ss    = SpreadsheetApp.openById(FILE_IDS.ocInsumos);
    const sheet = ss.getSheets()[0];
    const rows  = sheet.getDataRange().getValues();

    if (rows.length < 2) return null;

    // Detectar fila de encabezados (busca "fecha" o "monto" en alguna celda)
    let hdrIdx = 0;
    for (let i = 0; i < Math.min(5, rows.length); i++) {
      const rowStr = rows[i].map(c => String(c).toLowerCase()).join('|');
      if (rowStr.includes('fecha') || rowStr.includes('monto') || rowStr.includes('importe')) {
        hdrIdx = i;
        break;
      }
    }

    const headers = rows[hdrIdx].map(h => String(h).toLowerCase().trim());
    Logger.log('OC Insumos — headers detectados: ' + headers.join(' | '));

    // Columna O (índice 14): nombre de obra según el Maestro (Guillermo)
    // Columna C (índice 2): Proveedor
    // Columna F (índice 5): Monto
    // Columna D (índice 3): fecha fact
    const COL_FECHA = _findCol(headers, ['fecha']) ?? 3;
    const COL_MONTO = _findCol(headers, ['monto', 'importe', 'total']) ?? 5;
    const COL_OBRA  = 14; // Columna O — nombre obra como aparece en el Maestro
    const COL_PROV  = _findCol(headers, ['proveedor', 'prov']) ?? 2; // Columna C

    Logger.log('OC Insumos — cols: fecha=' + COL_FECHA + ' monto=' + COL_MONTO + ' obra=' + COL_OBRA + ' prov=' + COL_PROV);

    const acum = {};

    for (let i = hdrIdx + 1; i < rows.length; i++) {
      const row = rows[i];

      const mes = parsearMes(row[COL_FECHA]);
      if (!mes) continue;

      const monto = parsearMonto(row[COL_MONTO]);
      if (!monto || monto <= 0) continue;

      const obraRaw = String(row[COL_OBRA] || '').trim();
      const obra = obraRaw || 'Sin clasificar';

      const proveedorRaw = String(row[COL_PROV] || '').trim();
      const proveedor = proveedorRaw || 'Sin especificar';

      if (!acum[mes]) acum[mes] = { items: {}, total: 0, nOC: 0 };
      if (!acum[mes].items[obra]) acum[mes].items[obra] = { monto: 0, nOC: 0, proveedores: {} };
      if (!acum[mes].items[obra].proveedores[proveedor]) acum[mes].items[obra].proveedores[proveedor] = { monto: 0, nOC: 0 };
      acum[mes].items[obra].proveedores[proveedor].monto += monto;
      acum[mes].items[obra].proveedores[proveedor].nOC  += 1;
      acum[mes].items[obra].monto += monto;
      acum[mes].items[obra].nOC  += 1;
      acum[mes].total += monto;
      acum[mes].nOC   += 1;
    }

    // Convertir a formato del dashboard
    const resultado = {};
    for (const [mes, data] of Object.entries(acum)) {
      if (data.nOC === 0) continue;
      resultado[mes] = {
        total: Math.round(data.total),
        nOC:   data.nOC,
        items: Object.entries(data.items)
          .map(([obra, v]) => ({
            obra,
            monto: Math.round(v.monto),
            nOC: v.nOC,
            proveedores: Object.entries(v.proveedores)
              .map(([proveedor, pv]) => ({ proveedor, monto: Math.round(pv.monto), nOC: pv.nOC }))
              .sort((a, b) => b.monto - a.monto)
          }))
          .sort((a, b) => b.monto - a.monto)
      };
    }

    Logger.log('OC Insumos — resultado: ' + JSON.stringify(resultado).substring(0, 500));
    return resultado;

  } catch (err) {
    Logger.log('leerOCInsumos error: ' + err.toString());
    return null;
  }
}

// ============================================================
// FUNCIONES AUXILIARES
// ============================================================

function _findCol(headers, keywords) {
  for (const kw of keywords) {
    const idx = headers.findIndex(h => h.includes(kw));
    if (idx >= 0) return idx;
  }
  return null;
}

function parsearMes(fechaRaw) {
  if (!fechaRaw) return null;
  let mes = null;

  if (fechaRaw instanceof Date) {
    // Apps Script devuelve objetos Date para celdas con fecha
    mes = fechaRaw.getMonth() + 1; // getMonth() es 0-indexed
  } else {
    const s = String(fechaRaw).trim();
    // Formato D/M/YYYY o DD/MM/YYYY (común en Argentina)
    const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if (m) mes = parseInt(m[2]);
  }

  const MAP = ['ene','feb','mar','abr','may','jun','jul','ago','sep','oct','nov','dic'];
  return (mes >= 1 && mes <= 12) ? MAP[mes - 1] : null;
}

// Parsea el contenido de "Período de realización" y devuelve un mesKey ('ene'..'dic')
// para el año curYear, o null si no es parseable / pertenece a otro año.
function _parseMesKey(raw, curYear) {
  const MAP = ['ene','feb','mar','abr','may','jun','jul','ago','sep','oct','nov','dic'];
  const NOMBRE = { enero:1, febrero:2, marzo:3, abril:4, mayo:5, junio:6,
                   julio:7, agosto:8, septiembre:9, octubre:10, noviembre:11, diciembre:12 };
  if (!raw && raw !== 0) return null;
  if (raw instanceof Date) {
    if (isNaN(raw.getTime())) return null;
    if (raw.getFullYear() !== curYear) return null;
    return MAP[raw.getMonth()];
  }
  const s = String(raw).trim().toLowerCase();
  if (!s || s === '-') return null;

  // DD/MM/YYYY o D/M/YY (formato argentino)
  const mDate = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (mDate) {
    var y = parseInt(mDate[3]); if (y < 100) y += 2000;
    if (y !== curYear) return null;
    var m = parseInt(mDate[2]);
    return (m >= 1 && m <= 12) ? MAP[m - 1] : null;
  }

  // Extraer año si está presente; si no coincide con curYear, descartar
  var year = curYear;
  var yMatch = s.match(/\b(\d{4})\b/);
  if (yMatch) { year = parseInt(yMatch[1]); }
  if (year !== curYear) return null;

  // Nombre completo: "enero 2026", "marzo"
  for (var nombre in NOMBRE) {
    if (s.indexOf(nombre) >= 0) return MAP[NOMBRE[nombre] - 1];
  }
  // Clave corta: "ene", "feb"...
  for (var i = 0; i < MAP.length; i++) {
    if (s.indexOf(MAP[i]) >= 0) return MAP[i];
  }
  // Número puro 1-12
  var n = parseInt(s);
  if (!isNaN(n) && n >= 1 && n <= 12) return MAP[n - 1];
  return null;
}

function parsearMonto(raw) {
  if (raw === null || raw === undefined || raw === '') return 0;
  if (typeof raw === 'number') return raw;
  const s = String(raw).replace(/\s/g, '').replace(/\$/g, '');
  // Formato argentino: punto como separador de miles, coma como decimal
  const limpio = s.replace(/\./g, '').replace(',', '.');
  return parseFloat(limpio) || 0;
}

function clasificarObra(texto) {
  const t = (texto || '').toUpperCase();
  if (t.includes('357')  || t.includes('QUILMES'))                        return 'Ruta 357 - Quilmes';
  if (t.includes('PILAR')|| t.includes('COUNTRY'))                        return 'Country del Pilar';
  if ((t.includes('PLANTA') || t.includes('PTA')) && t.includes('ASF'))   return 'Planta Asfalto';
  if (t.includes('CORRIENTES'))                                            return 'Corrientes';
  if (t.includes('SMT')  || t.includes('MUNIC') || t.includes('MUNICIPIO')) return 'Obras Municipio SMT';
  if (t.includes('VARIA')|| t.includes('GRAL')  || t.includes('GENERAL')) return 'Obras Varias / General';
  if (t === '' || t === '-' || t === 'N/A')                                return 'Sin clasificar / Otros';
  // Si no hay match pero hay texto, incluirlo en Obras Varias
  return 'Sin clasificar / Otros';
}

// ============================================================
// MAESTRO DE OBRAS — lista de obras activas con COD_OBRA
// ============================================================
function leerMaestroObras() {
  try {
    const ss    = SpreadsheetApp.openById(FILE_IDS.maestroObras);
    // Buscar pestaña "Maestro de Obras" o usar la primera
    const sheet = ss.getSheetByName('Maestro de Obras') || ss.getSheets()[0];
    const rows  = sheet.getDataRange().getValues();

    // Encontrar fila de encabezados (contiene COD_OBRA)
    let hdrIdx = 0;
    for (let i = 0; i < Math.min(5, rows.length); i++) {
      const rowStr = rows[i].map(c => String(c).toUpperCase()).join('|');
      if (rowStr.includes('COD_OBRA') || rowStr.includes('COD OBRA')) { hdrIdx = i; break; }
    }

    const headers = rows[hdrIdx].map(h => String(h).toLowerCase().trim());
    const iCod    = _findCol(headers, ['cod_obra', 'cod obra', 'codigo', 'código']);
    const iNombre = _findCol(headers, ['nombre_canonico', 'nombre canonico', 'nombre']);
    const iCliente= _findCol(headers, ['cliente']);
    const iFuente = _findCol(headers, ['fuente']);
    const iTipo   = _findCol(headers, ['tipo_contrato', 'tipo contrato', 'tipo']);
    const iEstado = _findCol(headers, ['estado']);

    if (iCod === null || iNombre === null) {
      Logger.log('leerMaestroObras: columnas no encontradas. Headers: ' + headers.join('|'));
      return {};
    }

    const obras = {};
    for (let i = hdrIdx + 1; i < rows.length; i++) {
      const row    = rows[i];
      const cod    = String(row[iCod]    || '').trim();
      const nombre = String(row[iNombre] || '').trim();
      const estado = iEstado !== null ? String(row[iEstado] || '').trim() : 'Activa';

      if (!cod || !nombre || estado !== 'Activa') continue;

      obras[cod] = {
        nombre:  nombre,
        cliente: iCliente !== null ? String(row[iCliente] || '').trim() : '',
        fuente:  iFuente  !== null ? String(row[iFuente]  || '').trim() : '',
        tipo:    iTipo    !== null ? String(row[iTipo]    || '').trim() : '',
      };
    }

    Logger.log('Maestro de Obras — ' + Object.keys(obras).length + ' obras activas');
    return obras;

  } catch (err) {
    Logger.log('leerMaestroObras error: ' + err.toString());
    return {};
  }
}

// ============================================================
// FERNANDO SOLÍS — generado teórico por COD_OBRA
// ============================================================
function leerGeneradoFernando() {
  try {
    const ss      = SpreadsheetApp.openById(FILE_IDS.fernandoObras);
    const sheets  = ss.getSheets();
    const curYear = new Date().getFullYear();

    // Columnas fijas por pestaña (índice 0 = col A).
    // OBRAS DE MUNICIPIO: MontoTotal=F(5), Monto=G(6), Período=R(17), Estado$=E(4), filtrar "A Cobrar"
    // VIALIDAD1:          MontoTotal=H(7), Monto=I(8), Período=U(20), sin filtro de estado
    // OTROS INGRESOS:     Monto=F(5), Fecha ejecución=P(15), sin filtro de estado
    // iMontoFallback: si Monto=0, usar esta columna (Monto Total = valor del contrato)
    const TAB_CONFIG = {
      'OBRAS DE MUNICIPIO': { iMonto: 6,  iMontoFallback: 5,    iPeriodo: 17, iEstado: 4,    estadoFiltro: ['a cobrar', 'cobrada'], iCod: null, iNom: null },
      'VIALIDAD1':          { iMonto: 8,  iMontoFallback: 7,    iPeriodo: 20, iEstado: null,  estadoFiltro: null,       iCod: 19,   iNom: 0 },
      'OTROS INGRESOS':     { iMonto: 5,  iMontoFallback: null, iPeriodo: 15, iEstado: null,  estadoFiltro: null,       iCod: 16,   iNom: 0 },
    };

    const aCobrarPorCodigo  = {};
    const aCobrarPorMes     = {}; // { mesKey: { cod: monto } }
    const aCobrarSinMes     = {}; // cod: monto — sin período válido en año actual
    const nombrePorCodigo   = {};
    const detallesPorCodigo = {};
    const tabSrcPorCodigo   = {}; // cod → 'MUNICIPIO' | 'VIALIDAD1' | 'OTROS INGRESOS'

    for (const sheet of sheets) {
      const tabName = sheet.getName().trim().toUpperCase();

      // Buscar la configuración que corresponde a esta pestaña
      let cfg = null;
      for (const key of Object.keys(TAB_CONFIG)) {
        if (tabName.includes(key)) { cfg = TAB_CONFIG[key]; break; }
      }
      if (!cfg) continue;

      const rows = sheet.getDataRange().getValues();
      if (rows.length < 2) continue;

      // Detectar la fila de encabezados para saber dónde empieza la data
      let hdrIdx = 0;
      for (let i = 0; i < Math.min(6, rows.length); i++) {
        const rowStr = rows[i].map(c => String(c).toLowerCase()).join('|');
        if (rowStr.includes('monto') || rowStr.includes('código') || rowStr.includes('codigo')) {
          hdrIdx = i; break;
        }
      }

      // Para OBRAS DE MUNICIPIO buscamos código y nombre dinámicamente
      let iCodigo = 0;
      let iNombre = 1;
      const esMunicipio = tabName.includes('OBRAS DE MUNICIPIO');
      if (esMunicipio) {
        const headers = rows[hdrIdx].map(h => String(h).toLowerCase().trim());
        const ci = _findCol(headers, ['código', 'codigo', 'cod_obra', 'cod']);
        if (ci !== null) iCodigo = ci;
        const ni = _findCol(headers, ['nombre obra', 'nombre']);
        if (ni !== null) iNombre = ni;
      }

      // Para VIALIDAD1 y Otros Ingresos usamos la pestaña como clave única
      const tabKey    = sheet.getName().trim().toUpperCase().replace(/\s+/g, '-');
      const tabNombre = sheet.getName().trim();

      Logger.log('Fernando [' + sheet.getName() + ']: iMonto=' + cfg.iMonto +
                 ' iPeriodo=' + cfg.iPeriodo + ' iEstado=' + cfg.iEstado);

      for (let i = hdrIdx + 1; i < rows.length; i++) {
        const row = rows[i];

        // Filtro de estado (solo OBRAS DE MUNICIPIO)
        if (cfg.iEstado !== null && cfg.estadoFiltro !== null) {
          const estado = String(row[cfg.iEstado] || '').trim().toLowerCase();
          const allowed = Array.isArray(cfg.estadoFiltro) ? cfg.estadoFiltro : [cfg.estadoFiltro];
          if (!allowed.includes(estado)) continue;
        }

        // Monto fijo por columna; si es 0, usa Monto Total como estimado del contrato
        let monto = parsearMonto(row[cfg.iMonto]);
        if (monto === 0 && cfg.iMontoFallback !== null) monto = parsearMonto(row[cfg.iMontoFallback]);
        if (monto < 0) continue;

        // Código/nombre — MUNICIPIO usa detección dinámica; VIALIDAD1/OTROS usan iCod/iNom fijos
        let cod, nombre;
        if (esMunicipio) {
          cod    = String(row[iCodigo] || '').trim() || 'SIN-CODIGO';
          nombre = String(row[iNombre] || '').trim() || cod;
        } else if (cfg.iCod !== null) {
          cod    = String(row[cfg.iCod] || '').trim() || tabKey;
          nombre = String(row[cfg.iNom] || '').trim() || cod;
        } else {
          cod    = tabKey;
          nombre = tabNombre;
        }

        // Período → clave de mes
        const mesKey = _parseMesKey(row[cfg.iPeriodo], curYear);

        if (mesKey) {
          if (!aCobrarPorMes[mesKey]) aCobrarPorMes[mesKey] = {};
          aCobrarPorMes[mesKey][cod] = (aCobrarPorMes[mesKey][cod] || 0) + monto;
        } else {
          aCobrarSinMes[cod] = (aCobrarSinMes[cod] || 0) + monto;
        }
        aCobrarPorCodigo[cod] = (aCobrarPorCodigo[cod] || 0) + monto;

        if (!nombrePorCodigo[cod] && nombre) nombrePorCodigo[cod] = nombre;
        if (!tabSrcPorCodigo[cod]) {
          tabSrcPorCodigo[cod] = esMunicipio ? 'MUNICIPIO'
            : tabName.includes('VIALIDAD') ? 'VIALIDAD1' : 'OTROS INGRESOS';
        }
        if (!detallesPorCodigo[cod]) detallesPorCodigo[cod] = [];
        detallesPorCodigo[cod].push({ nombre: nombre || cod, codigo: cod, monto: Math.round(monto) });
      }
    }

    Logger.log('Fernando Solís — CODs: ' + Object.keys(aCobrarPorCodigo).length +
               ' | por mes: ' + Object.keys(aCobrarPorMes).join(',') +
               ' | sin mes: ' + Object.keys(aCobrarSinMes).length);
    return {
      aCobrar:        aCobrarPorCodigo,
      aCobrarPorMes:  aCobrarPorMes,
      aCobrarSinMes:  aCobrarSinMes,
      nombreFernando: nombrePorCodigo,
      detalles:       detallesPorCodigo,
      tabSrc:         tabSrcPorCodigo,
      tabsSinPeriodo: [],
    };

  } catch (err) {
    Logger.log('leerGeneradoFernando error: ' + err.toString());
    return { generado: {}, tabsSinPeriodo: [] };
  }
}

// ============================================================
// COMBINAR MAESTRO + FERNANDO → GENERADO TEÓRICO POR OBRA
// ============================================================
function leerGeneradoPorObra() {
  try {
    const maestro = leerMaestroObras();
    const { aCobrar, aCobrarPorMes, aCobrarSinMes, nombreFernando, detalles, tabSrc, tabsSinPeriodo } = leerGeneradoFernando();

    // Helper: construye lista de obras desde un mapa { cod: monto }
    function _buildObras(montoPorCod) {
      var list = [];
      for (var cod in montoPorCod) {
        if (cod === 'SIN-CODIGO') continue;
        var montoRed = Math.round(montoPorCod[cod]);
        if (montoRed < 0) continue;
        var info = maestro[cod];
        if (info && info.fuente === 'INTERNO') continue;
        list.push({
          cod_obra: cod,
          nombre:   info ? info.nombre : (nombreFernando[cod] || cod),
          cliente:  info ? info.cliente : '—',
          tipo:     info ? info.tipo    : '—',
          aCobrar:  montoRed,
          items:    detalles[cod] || [],
          tabSrc:   tabSrc ? (tabSrc[cod] || null) : null,
        });
      }
      list.sort(function(a, b) { return b.aCobrar - a.aCobrar; });
      return list;
    }

    // Lista plana (sin filtro de mes) — compatibilidad con caché viejo
    const obras = _buildObras(aCobrar);

    // Filas sin código al final
    const montoSinCod = Math.round(aCobrar['SIN-CODIGO'] || 0);
    if (montoSinCod > 0) {
      obras.push({ cod_obra: '—', nombre: 'Obra sin asignación de código',
                   cliente: '—', tipo: '—', aCobrar: montoSinCod });
    }

    // Obras sin período de realización — van a una categoría separada en el dashboard
    const obrasSinPeriodo = _buildObras(aCobrarSinMes);
    const sinCodSinPeriodo = Math.round(aCobrarSinMes['SIN-CODIGO'] || 0);
    if (sinCodSinPeriodo > 0) {
      obrasSinPeriodo.push({ cod_obra: '—', nombre: 'Obra sin asignación de código',
                             cliente: '—', tipo: '—', aCobrar: sinCodSinPeriodo });
    }

    // Mapa por mes: solo obras con período explícito
    const obrasPorMes = {};
    const MESES_KEYS  = ['ene','feb','mar','abr','may','jun','jul','ago','sep','oct','nov','dic'];
    for (var mi = 0; mi < MESES_KEYS.length; mi++) {
      var mes = MESES_KEYS[mi];
      var mesPeriodo = aCobrarPorMes[mes];
      if (!mesPeriodo) continue;
      var list = _buildObras(mesPeriodo);
      // SIN-CODIGO del mes
      var sinCodMes = Math.round(mesPeriodo['SIN-CODIGO'] || 0);
      if (sinCodMes > 0) {
        list.push({ cod_obra: '—', nombre: 'Obra sin asignación de código',
                    cliente: '—', tipo: '—', aCobrar: sinCodMes });
      }
      if (list.length > 0) obrasPorMes[mes] = list;
    }

    Logger.log('obrasPorMes — meses: ' + Object.keys(obrasPorMes).join(',') +
               ' | sinPeriodo: ' + obrasSinPeriodo.length);
    return { obras: obras, obrasPorMes: obrasPorMes, obrasSinPeriodo: obrasSinPeriodo, tabsSinPeriodo: tabsSinPeriodo };

  } catch (err) {
    Logger.log('leerGeneradoPorObra error: ' + err.toString());
    return { obras: [], tabsSinPeriodo: [] };
  }
}

// ============================================================
// ALQUILER INTERNO DE EQUIPOS — Partes diarios (una pestaña por equipo)
// Fuente precios: equiposFlota (COD → PF en USD)
// Fuente uso:     usageEquipos (una pestaña por COD_EQUIPO)
// Costo por obra: prorrateado por horas trabajadas en el mes
// TC: dólar oficial promedio mensual (TC_USD_MENSUAL)
// ============================================================

// Devuelve el TC mensual desde la tabla hardcodeada o, si no está,
// lo obtiene automáticamente del promedio diario de estadisticasbcra.site
function fetchTCMensual(mesKey) {
  if (TC_USD_MENSUAL[mesKey] != null) return TC_USD_MENSUAL[mesKey];

  const MES_NUM = { ene:'01', feb:'02', mar:'03', abr:'04', may:'05', jun:'06',
                    jul:'07', ago:'08', sep:'09', oct:'10', nov:'11', dic:'12' };
  const mesNum = MES_NUM[mesKey];
  if (!mesNum) return 1400;

  const year = String(new Date().getFullYear());
  const prefix = year + '-' + mesNum + '-';

  try {
    const url = 'https://api.estadisticasbcra.site/usd_of';
    const resp = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
    if (resp.getResponseCode() !== 200) return 1400;

    const data = JSON.parse(resp.getContentText());
    const dias = data.filter(function(item) { return item.d && item.d.startsWith(prefix); });
    if (dias.length === 0) return 1400;

    const avg = Math.round(dias.reduce(function(s, i) { return s + i.v; }, 0) / dias.length);
    Logger.log('TC auto-fetch ' + mesKey + ' ' + year + ': ' + avg + ' (n=' + dias.length + ')');
    TC_USD_MENSUAL[mesKey] = avg; // cache para re-uso dentro de la misma ejecución
    return avg;
  } catch(e) {
    Logger.log('fetchTCMensual(' + mesKey + ') error: ' + e);
    return 1400;
  }
}

function leerAlquilerEquipos() {
  try {
    // 1. Leer precios — buscar en todas las hojas la que tenga CÓDIGO + PF
    const ssPrecios = SpreadsheetApp.openById(FILE_IDS.equiposFlota);
    // ── Detección de precios por PATRÓN de código de equipo (ej: CF-05, RDL-02) ──
    // No busca texto de headers (puede estar en celdas combinadas que getValues() no retorna).
    // Escanea todas las celdas buscando el primer valor que match /^[A-Z]{2,4}-\d{2,3}$/ y
    // auto-detecta las columnas de PRECIO y COEFICIENTE buscando headers en filas previas.
    const COD_EQUIPO_RE = /^[A-Z]{2,4}-\d{2,3}$/;

    const precios = {};

    for (const sheetP of ssPrecios.getSheets()) {
      const rows = sheetP.getDataRange().getValues();
      Logger.log('equiposFlota — revisando hoja: ' + sheetP.getName() + ' (' + rows.length + ' filas)');

      // Paso 1: encontrar la primera fila de datos con código de equipo
      let iCod = -1, iDataStart = -1;
      for (let r = 0; r < rows.length; r++) {
        for (let c = 0; c < rows[r].length; c++) {
          const v = String(rows[r][c] || '').trim().toUpperCase();
          if (COD_EQUIPO_RE.test(v)) { iCod = c; iDataStart = r; break; }
        }
        if (iCod >= 0) break;
      }
      if (iCod < 0) { Logger.log('  → sin códigos de equipo, saltando'); continue; }
      Logger.log('  → códigos encontrados en fila=' + iDataStart + ' col=' + iCod);

      // Paso 2: detectar columnas de precio y coeficiente buscando en filas de header previas
      let iPrecio = -1, iCoef = -1, iClasif = -1, iMarca = -1, iModelo = -1, iPF = -1;
      for (let r = Math.max(0, iDataStart - 4); r <= iDataStart; r++) {
        const cells = rows[r].map(c => String(c).toLowerCase().trim());
        cells.forEach(function(v, ci) {
          if (iPrecio < 0 && v === 'precio')                                        iPrecio = ci;
          if (iCoef   < 0 && (v === 'coeficiente' || v.startsWith('coef')))         iCoef   = ci;
          if (iClasif < 0 && (v.includes('clasif')))                                iClasif = ci;
          if (iMarca  < 0 && v === 'marca')                                          iMarca  = ci;
          if (iModelo < 0 && v === 'modelo')                                         iModelo = ci;
          if (iPF     < 0 && (v === 'pf' || v === 'p.f.' || v.startsWith('pf ')))  iPF     = ci;
        });
      }
      Logger.log('  → cols: iCod=' + iCod + ' iPrecio=' + iPrecio + ' iCoef=' + iCoef + ' iPF=' + iPF + ' iClasif=' + iClasif);

      if (iPrecio < 0 && iPF < 0) { Logger.log('  → sin columna PRECIO ni PF, saltando'); continue; }

      // Paso 3: leer todas las filas de datos
      let nLeidos = 0;
      for (let r = iDataStart; r < rows.length; r++) {
        const row = rows[r];
        const cod = String(row[iCod] || '').trim().toUpperCase();
        if (!COD_EQUIPO_RE.test(cod)) continue;

        // PF: columna PF directa, o calculada como precio × coeficiente
        let pf = 0;
        if (iPF >= 0) {
          pf = typeof row[iPF] === 'number' ? row[iPF]
             : parseFloat(String(row[iPF]).replace(',', '.')) || 0;
        }
        if (pf <= 0 && iPrecio >= 0 && iCoef >= 0) {
          const precio = typeof row[iPrecio] === 'number' ? row[iPrecio] : parseFloat(String(row[iPrecio]).replace(',', '.')) || 0;
          const coef   = typeof row[iCoef]   === 'number' ? row[iCoef]   : parseFloat(String(row[iCoef]).replace(',', '.'))   || 0;
          pf = Math.round(precio * coef * 10) / 10;
        }
        if (pf <= 0) continue;

        precios[cod] = {
          pf_usd:        pf,
          clasificacion: iClasif >= 0 ? String(row[iClasif] || '').trim() : '',
          marca:         iMarca  >= 0 ? String(row[iMarca]  || '').trim() : '',
          modelo:        iModelo >= 0 ? String(row[iModelo] || '').trim() : ''
        };
        nLeidos++;
      }
      Logger.log('  → ' + nLeidos + ' equipos leídos de esta hoja');
    }

    Logger.log('Precios total: ' + Object.keys(precios).length + ' equipos — ' + Object.keys(precios).slice(0,8).join(', '));
    if (Object.keys(precios).length === 0) return null;

    // 2. Leer partes diarios — hoja única "PARTES DIARIOS"
    // Col A(0)=Fecha, B(1)=Equipo, C(2)=Código equipo, F(5)=Obra, I(8)=Total horas, Q(16)=Código obra
    const ssUso  = SpreadsheetApp.openById(FILE_IDS.usageEquipos);
    // Buscar la hoja de partes diarios por nombre (flexible) o por contenido
    let sheetPD = null;
    for (const s of ssUso.getSheets()) {
      const n = s.getName().toUpperCase().replace(/\s+/g,'');
      if (n.includes('PARTESDIARIOS') || n.includes('PARTES')) { sheetPD = s; break; }
    }
    if (!sheetPD) sheetPD = ssUso.getSheets()[0];
    Logger.log('Partes diarios — usando hoja: ' + sheetPD.getName());
    const rowsPD  = sheetPD.getDataRange().getValues();

    const COL_FECHA_PD    = 0;  // A: Fecha
    const COL_COD_EQ      = 2;  // C: Código de equipo
    const COL_OBRA_PD     = 5;  // F: Nombre de obra
    const COL_HORAS_PD    = 8;  // I: Total de horas
    const COL_COD_OBRA_PD = 17; // R: Código de obra (preferido para agrupar — confirmado por usuario)

    let hdrPD = 0;
    for (let i = 0; i < Math.min(5, rowsPD.length); i++) {
      const rowStr = rowsPD[i].map(c => String(c).toLowerCase()).join('|');
      if (rowStr.includes('fecha') || rowStr.includes('equipo') || rowStr.includes('hora')) {
        hdrPD = i; break;
      }
    }
    Logger.log('Partes diarios — hoja: ' + sheetPD.getName() + ' hdr=' + hdrPD + ' filas=' + rowsPD.length);

    // acum[mes][cod] = { _total: horas, [obra]: horas }
    const acum = {};

    for (let i = hdrPD + 1; i < rowsPD.length; i++) {
      const row = rowsPD[i];
      const mes = parsearMes(row[COL_FECHA_PD]);
      if (!mes) continue;

      const codEq = String(row[COL_COD_EQ] || '').trim();
      if (!codEq || !precios[codEq]) continue;

      const codObra = String(row[COL_COD_OBRA_PD] || '').trim();
      const nomObra = String(row[COL_OBRA_PD]     || '').trim();
      const obra    = (codObra && codObra !== '-') ? codObra
                    : (nomObra  && nomObra  !== '-') ? nomObra : 'Sin asignar';

      const horas = typeof row[COL_HORAS_PD] === 'number' ? row[COL_HORAS_PD]
                  : parsearHoras(row[COL_HORAS_PD]);
      if (horas <= 0) continue;

      if (!acum[mes]) acum[mes] = {};
      if (!acum[mes][codEq]) acum[mes][codEq] = { _total: 0 };
      if (!acum[mes][codEq][obra]) acum[mes][codEq][obra] = 0;
      acum[mes][codEq][obra]  += horas;
      acum[mes][codEq]._total += horas;
    }

    // 3. Calcular costos prorrateados por horas
    const resultado = {};
    for (const mes of Object.keys(acum)) {
      const tc = fetchTCMensual(mes);
      const porObra = {};
      let totalMes  = 0;

      for (const [cod, datos] of Object.entries(acum[mes])) {
        const info       = precios[cod];
        const totalHoras = datos._total;
        if (!info || totalHoras <= 0) continue;

        const pfArs = info.pf_usd * tc;

        for (const [obra, horas] of Object.entries(datos)) {
          if (obra === '_total') continue;
          const costoArs = Math.round((horas / totalHoras) * pfArs);
          if (!porObra[obra]) porObra[obra] = { costoArs: 0, horasTot: 0, equipos: [] };
          porObra[obra].costoArs += costoArs;
          porObra[obra].horasTot += horas;
          porObra[obra].equipos.push({
            codigo:       cod,
            clasificacion: info.clasificacion,
            marca:        info.marca,
            modelo:       info.modelo,
            pfUsd:        info.pf_usd,
            horas:        Math.round(horas * 10) / 10,
            costoArs:     costoArs
          });
          totalMes += costoArs;
        }
      }

      if (Object.keys(porObra).length === 0) continue;

      resultado[mes] = {
        totalArs: totalMes,
        tcUsd:    tc,
        porObra:  Object.entries(porObra)
          .map(([obra, v]) => ({
            obra,
            costoArs: v.costoArs,
            horasTot: Math.round(v.horasTot * 10) / 10,
            equipos:  v.equipos.sort((a, b) => b.costoArs - a.costoArs)
          }))
          .sort((a, b) => b.costoArs - a.costoArs)
      };
    }

    Logger.log('Alquiler equipos — meses con datos: ' + Object.keys(resultado).join(', '));
    return resultado;

  } catch (err) {
    Logger.log('leerAlquilerEquipos error: ' + err.toString());
    return null;
  }
}

function parsearHoras(raw) {
  if (!raw || raw === '' || raw === '-') return 0;
  if (raw instanceof Date) return raw.getUTCHours() + raw.getUTCMinutes() / 60;
  if (typeof raw === 'number') {
    if (raw > 0 && raw < 1) return raw * 24; // fracción de día (Google Sheets)
    return raw;
  }
  if (typeof raw === 'string') {
    const s = raw.trim();
    if (!s || s === '-' || s === '\\-') return 0;
    const m = s.match(/^(\d+):(\d+)$/);
    if (m) return parseInt(m[1]) + parseInt(m[2]) / 60;
    const n = parseFloat(s);
    if (!isNaN(n)) return n;
  }
  return 0;
}

// ============================================================
// PRECIO DE MERCADO ASFALTO — $/tn por tipo y mes
// Fuente: Google Sheet cargado por María Caram
// Formato: col A = Mes ("enero 2026"), col B = Valor caliente [Tn], col C = Valor frío [Tn]
// Devuelve: { feb: { caliente: X, frio: Y }, mar: {...}, ... }
// ============================================================
function leerPrecioAsfalto() {
  try {
    const ss    = SpreadsheetApp.openById(FILE_IDS.precioAsfalto);
    const sheet = ss.getSheets()[0];
    const rows  = sheet.getDataRange().getValues();

    const MES_NOMBRE = {
      enero:1, febrero:2, marzo:3, abril:4, mayo:5, junio:6,
      julio:7, agosto:8, septiembre:9, octubre:10, noviembre:11, diciembre:12,
      january:1, february:2, march:3, april:4, may:5, june:6,
      july:7, august:8, september:9, october:10, november:11, december:12,
    };
    const NUM_KEY = ['ene','feb','mar','abr','may','jun','jul','ago','sep','oct','nov','dic'];

    // Detectar fila de encabezado: buscar columna con "MES" y columna con "CALIENTE"
    let iMes = -1, iCal = -1, iFrio = -1, hdrIdx = -1;
    for (let i = 0; i < Math.min(5, rows.length); i++) {
      const cells = rows[i].map(c => String(c).toUpperCase().trim());
      const iM = cells.findIndex(c => c === 'MES' || c === 'FECHA' || c === 'PERÍODO');
      const iC = cells.findIndex(c => c.includes('CALIENTE'));
      const iF = cells.findIndex(c => c.includes('FRIO') || c.includes('FRÍO') || c.includes('FRIA') || c.includes('FRÍA'));
      if (iM >= 0 && (iC >= 0 || iF >= 0)) {
        hdrIdx = i; iMes = iM; iCal = iC; iFrio = iF; break;
      }
    }
    if (hdrIdx < 0) {
      Logger.log('precioAsfalto: no se encontró encabezado — buscando por posición (A=mes, B=cal, C=frío)');
      // Fallback: asumir columnas A, B, C
      hdrIdx = 0; iMes = 0; iCal = 1; iFrio = 2;
    }
    Logger.log('precioAsfalto hdr=' + hdrIdx + ' iMes=' + iMes + ' iCal=' + iCal + ' iFrio=' + iFrio);

    const parsePrecio = function(raw) {
      if (raw == null || raw === '') return null;
      if (typeof raw === 'number') return raw > 0 ? Math.round(raw) : null;
      const n = parseFloat(String(raw).replace(/[$. ]/g, '').replace(',', '.'));
      return !isNaN(n) && n > 0 ? Math.round(n) : null;
    };

    const curYear = new Date().getFullYear();
    const resultado = {};

    for (let i = hdrIdx + 1; i < rows.length; i++) {
      const rawMes = String(rows[i][iMes] instanceof Date
        ? Utilities.formatDate(rows[i][iMes], 'America/Argentina/Buenos_Aires', 'MMMM yyyy')
        : rows[i][iMes] || '').toLowerCase().trim();
      if (!rawMes) continue;

      // Parsear "enero 2026", "febrero", "feb", "2" — extraer mes y año
      const tokens = rawMes.split(/[\s,/-]+/);
      let mesNum = null, year = curYear;
      for (const t of tokens) {
        const n = parseInt(t);
        if (!isNaN(n) && n >= 2000) { year = n; continue; }
        if (!isNaN(n) && n >= 1 && n <= 12) { mesNum = n; continue; }
        const nombre = MES_NOMBRE[t] || MES_NOMBRE[t.slice(0, 3)];
        if (nombre) mesNum = nombre;
      }
      if (!mesNum || year !== curYear) continue;

      const pCal  = iCal  >= 0 ? parsePrecio(rows[i][iCal])  : null;
      const pFrio = iFrio >= 0 ? parsePrecio(rows[i][iFrio]) : null;
      if (pCal == null && pFrio == null) continue;

      const mesKey = NUM_KEY[mesNum - 1];
      resultado[mesKey] = { caliente: pCal, frio: pFrio };
    }

    Logger.log('precioAsfalto — ' + JSON.stringify(resultado));
    return resultado;

  } catch (e) {
    Logger.log('leerPrecioAsfalto error: ' + e);
    return null;
  }
}

// ============================================================
// REPUESTOS DE EQUIPOS — costo real de compras por mes
// Fuente: Google Sheet de Nico — hoja "ENTREGAS"
// Col C(2)=Fecha, E(4)=Código equipo, J(9)=Costo
// ============================================================
function leerRepuestosEquipos() {
  try {
    const ss    = SpreadsheetApp.openById(FILE_IDS.repuestosEquipos);
    const sheet = ss.getSheetByName('ENTREGAS') || ss.getSheets()[0];
    const rows  = sheet.getDataRange().getValues();

    const COL_FECHA  = 2;  // C
    const COL_COD_EQ = 4;  // E
    const COL_COSTO  = 9;  // J

    let hdrIdx = 0;
    for (let i = 0; i < Math.min(5, rows.length); i++) {
      const rowStr = rows[i].map(c => String(c).toLowerCase()).join('|');
      if (rowStr.includes('fecha') || rowStr.includes('costo') || rowStr.includes('código')) {
        hdrIdx = i; break;
      }
    }
    Logger.log('Repuestos — hoja: ' + sheet.getName() + ' hdr=' + hdrIdx);

    const resultado = {};
    for (let i = hdrIdx + 1; i < rows.length; i++) {
      const row  = rows[i];
      const mes  = parsearMes(row[COL_FECHA]);
      if (!mes) continue;
      const codEq = String(row[COL_COD_EQ] || '').trim();
      const costo = parsearMonto(row[COL_COSTO]);
      if (!costo || costo <= 0) continue;

      if (!resultado[mes]) resultado[mes] = { total: 0, items: [] };
      resultado[mes].total += costo;
      resultado[mes].items.push({ codEq, costo: Math.round(costo) });
    }
    for (const mes of Object.keys(resultado)) resultado[mes].total = Math.round(resultado[mes].total);

    Logger.log('Repuestos equipos — meses: ' + Object.keys(resultado).join(','));
    return resultado;
  } catch (err) {
    Logger.log('leerRepuestosEquipos error: ' + err.toString());
    return null;
  }
}

// ============================================================
// REMITOS OFICIALES — Tn Caliente y Frío producidas por mes
// Fuente: Google Sheet de Roberto
// Columnas clave: CANT. (cantidad en TN), U.D. (debe ser "TN"),
//   DESCRIPCION (ASFALTO CALIENTE / ASFALTO FRIO), Mes, Año
// ============================================================
function leerRemitosAsfalto() {
  try {
    const ss     = SpreadsheetApp.openById(FILE_IDS.remitosAsfalto);
    const sheets = ss.getSheets();
    const TZ = 'America/Argentina/Buenos_Aires';
    const MES_MAP = { 1:'ene', 2:'feb', 3:'mar', 4:'abr', 5:'may', 6:'jun',
                      7:'jul', 8:'ago', 9:'sep', 10:'oct', 11:'nov', 12:'dic' };
    const resultado = {};
    const detalle   = []; // por fila, con Date real — solo se usa internamente

    for (const sheet of sheets) {
      const rows = sheet.getDataRange().getValues();

      // Buscar fila de encabezados que tenga CANT. y U.D./U.M.
      let hdrIdx = -1, iCant = -1, iUD = -1, iDesc = -1, iMes = -1, iAnio = -1, iFecha = -1, iObra = -1;
      for (let i = 0; i < Math.min(20, rows.length); i++) {
        const cells = rows[i].map(c => String(c).toUpperCase().trim());
        // Acepta CANT.+U.D. (formato clásico) O DESCRIPCION+MES (formato nuevo Roberto)
        const iC = cells.findIndex(c => c === 'CANT.' || c === 'CANT' || c === 'CANTIDAD' || c === 'TOTAL');
        const iU = cells.findIndex(c => c === 'U.D.' || c === 'U.M.' || c === 'UD' || c === 'UNIDAD' || c === 'I');
        const iDt = cells.findIndex(c => c === 'DESCRIPCION' || c === 'DESCRIPCIÓN');
        const iMt = cells.findIndex(c => c === 'MES');
        if ((iC >= 0 && iU >= 0) || (iDt >= 0 && iMt >= 0)) {
          hdrIdx = i;
          iCant  = iC >= 0 ? iC : (iDt >= 0 ? iDt - 2 : -1); // CANT suele estar 2 cols antes de DESCRIPCION
          iUD    = iU >= 0 ? iU : (iDt >= 0 ? iDt - 1 : -1); // U.D. suele estar 1 col antes
          iDesc  = iDt >= 0 ? iDt : cells.findIndex(c => c === 'DESCRIPCION' || c === 'DESCRIPCIÓN');
          iMes   = iMt >= 0 ? iMt : cells.findIndex(c => c === 'MES');
          iAnio  = cells.findIndex(c => c === 'AÑO' || c === 'ANO');
          iFecha = cells.findIndex(c => c === 'FECHA');
          iObra  = cells.findIndex(c => c === 'OBRA');
          break;
        }
      }
      if (hdrIdx < 0) continue;
      Logger.log('Remitos [' + sheet.getName() + ']: hdr=' + hdrIdx + ' iCant=' + iCant + ' iUD=' + iUD + ' iDesc=' + iDesc + ' iMes=' + iMes + ' iAnio=' + iAnio + ' iObra=' + iObra);

      for (let i = hdrIdx + 1; i < rows.length; i++) {
        const row = rows[i];

        // Validar unidad: si la columna existe debe ser TN; si no existe, filtrar por descripción
        if (iUD >= 0) {
          const ud = String(row[iUD] || '').toUpperCase().trim();
          if (ud !== 'TN') continue;
        }

        const desc = String(iDesc >= 0 ? row[iDesc] || '' : '').toUpperCase().trim();
        if (!desc.includes('ASFALTO')) continue;

        const cant = typeof row[iCant] === 'number' ? row[iCant]
                   : parseFloat(String(row[iCant] || '').replace(',', '.')) || 0;
        if (cant <= 0) continue;

        const tipo = desc.includes('CALIENTE') ? 'caliente'
                   : (desc.includes('FRI') || desc.includes('FRÍO')) ? 'frio' : null;
        const obra = iObra >= 0 ? String(row[iObra] || '').trim() : '';

        // ── Fecha exacta (columna FECHA, formato mm/dd/aaaa) ──────────────────
        var fechaObj = null;
        if (iFecha >= 0 && row[iFecha] !== '' && row[iFecha] != null) {
          var rawF = row[iFecha];
          if (rawF instanceof Date) {
            fechaObj = new Date(rawF.getFullYear(), rawF.getMonth(), rawF.getDate());
          } else {
            var parts = String(rawF).trim().split('/');
            if (parts.length === 3) {
              var m = parseInt(parts[0]), d = parseInt(parts[1]), y = parseInt(parts[2]);
              if (y < 100) y += 2000;
              if (!isNaN(m) && !isNaN(d) && !isNaN(y)) fechaObj = new Date(y, m - 1, d, 0, 0, 0);
            }
          }
        }

        // ── Mes/año para el agregado mensual ────────────────────────────────
        var mesNum, anioNum;
        if (fechaObj && !isNaN(fechaObj.getTime())) {
          mesNum  = fechaObj.getMonth() + 1;
          anioNum = fechaObj.getFullYear();
          // Guardar en detalle con objeto Date real
          detalle.push({ fecha: fechaObj, fechaStr: Utilities.formatDate(fechaObj, TZ, 'dd/MM/yyyy'), tipo: tipo, cant: Math.round(cant * 10) / 10, obra: obra });
        } else {
          // Fallback: columnas MES / AÑO
          var mesRaw  = row[iMes],  anioRaw = row[iAnio];
          mesNum  = typeof mesRaw  === 'number' ? mesRaw  : parseInt(String(mesRaw  || ''));
          anioNum = typeof anioRaw === 'number' ? anioRaw : parseInt(String(anioRaw || ''));
          if (isNaN(mesNum) || isNaN(anioNum)) continue;
          if (anioNum < 100) anioNum += 2000;
        }
        if (anioNum !== 2026) continue;
        const mesKey = MES_MAP[mesNum];
        if (!mesKey) continue;

        if (!resultado[mesKey]) resultado[mesKey] = { caliente: 0, frio: 0, total: 0, porObra: {} };
        if (tipo === 'caliente') {
          resultado[mesKey].caliente += cant;
          if (obra) {
            if (!resultado[mesKey].porObra[obra]) resultado[mesKey].porObra[obra] = { caliente: 0, frio: 0 };
            resultado[mesKey].porObra[obra].caliente = Math.round((resultado[mesKey].porObra[obra].caliente + cant) * 10) / 10;
          }
        } else if (tipo === 'frio') {
          resultado[mesKey].frio += cant;
          if (obra) {
            if (!resultado[mesKey].porObra[obra]) resultado[mesKey].porObra[obra] = { caliente: 0, frio: 0 };
            resultado[mesKey].porObra[obra].frio = Math.round((resultado[mesKey].porObra[obra].frio + cant) * 10) / 10;
          }
        }
        resultado[mesKey].total += cant;
      }
    }

    // Redondear a 1 decimal
    for (const mes of Object.keys(resultado)) {
      const r = resultado[mes];
      r.caliente = Math.round(r.caliente * 10) / 10;
      r.frio     = Math.round(r.frio     * 10) / 10;
      r.total    = Math.round(r.total    * 10) / 10;
    }

    Logger.log('Remitos Asfalto 2026: ' + JSON.stringify(resultado));
    Logger.log('Remitos detalle: ' + detalle.length + ' filas con fecha exacta');
    resultado._detalle = detalle; // Date objects — se borra antes de serializar
    return resultado;

  } catch (err) {
    Logger.log('leerRemitosAsfalto error: ' + err.toString());
    return null;
  }
}

function jsonResponse(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

// ============================================================
// CONFIGURAR TRIGGER NOCTURNO
// Ejecutar esta función UNA SOLA VEZ desde el editor de Scripts
// (Menú: Ejecutar → configurarTriggerNocturno)
// ============================================================
function configurarTriggerNocturno() {
  // Eliminar triggers previos para esta función
  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === 'actualizarNocturno')
    .forEach(t => ScriptApp.deleteTrigger(t));

  // Crear trigger: todos los días entre 3:00 y 4:00 AM (hora de la cuenta Google)
  ScriptApp.newTrigger('actualizarNocturno')
    .timeBased()
    .everyDays(1)
    .atHour(3)
    .create();

  Logger.log('✓ Trigger nocturno creado: actualizarNocturno se ejecutará todos los días ~3 AM');
}

// ============================================================
// FUNCIÓN DE DIAGNÓSTICO
// Ejecutar desde el editor para ver qué datos devuelve el script
// antes de desplegar. Ver el resultado en Ver → Registros.
// ============================================================
function diagnostico() {
  Logger.log('=== DIAGNÓSTICO INGECO APPS SCRIPT ===');
  Logger.log('Timestamp: ' + new Date().toISOString());

  Logger.log('\n--- TANGO MO ---');
  const mo = leerTangoMO();
  Logger.log(mo ? JSON.stringify(mo, null, 2) : 'NULL (error al leer)');

  Logger.log('\n--- OC INSUMOS ---');
  const oc = leerOCInsumos();
  Logger.log(oc ? JSON.stringify(oc, null, 2) : 'NULL (error al leer)');

  Logger.log('\n--- GENERADO POR OBRA (Fernando Solís + Maestro) ---');
  const gpo = leerGeneradoPorObra();
  Logger.log(gpo ? JSON.stringify(gpo, null, 2).substring(0, 1000) : 'NULL (error al leer)');

  Logger.log('\n--- ALQUILER EQUIPOS ---');
  const alq = leerAlquilerEquipos();
  Logger.log(alq ? JSON.stringify(alq, null, 2).substring(0, 1000) : 'NULL (error al leer)');

  Logger.log('\n--- REMITOS ASFALTO ---');
  const rem = leerRemitosAsfalto();
  Logger.log(rem ? JSON.stringify(rem, null, 2) : 'NULL (error al leer)');

  Logger.log('\n=== FIN DIAGNÓSTICO ===');
}

// ============================================================
// DIAGNÓSTICO ESPECÍFICO DE EQUIPOS
// Ejecutar desde el editor → Ver → Registros
// ============================================================
// ============================================================
// DIAGNÓSTICO ESPECÍFICO DE ALQUILER — para detectar por qué no encuentra datos
// Ejecutar desde el editor → Ver → Registros
// ============================================================
function diagnosticoAlquiler() {
  Logger.log('=== DIAGNÓSTICO ALQUILER ===');

  // 1. Archivo de TARIFAS
  try {
    const ss = SpreadsheetApp.openById(FILE_IDS.equiposFlota);
    Logger.log('Tarifas — hojas: ' + ss.getSheets().map(s => s.getName()).join(', '));
    for (const sheet of ss.getSheets()) {
      const rows = sheet.getDataRange().getValues();
      Logger.log('Hoja "' + sheet.getName() + '" — filas: ' + rows.length);
      Logger.log('  Primeras 5 filas (cols 0-7):');
      for (let i = 0; i < Math.min(5, rows.length); i++) {
        Logger.log('    ' + i + ': ' + rows[i].slice(0,8).map(c => JSON.stringify(c)).join(' | '));
      }
    }
  } catch(e) { Logger.log('ERROR tarifas: ' + e); }

  // 2. Archivo de PARTES DIARIOS
  try {
    const ss = SpreadsheetApp.openById(FILE_IDS.usageEquipos);
    Logger.log('\nPartes diarios — hojas: ' + ss.getSheets().map(s => s.getName()).join(', '));
    for (const sheet of ss.getSheets()) {
      const rows = sheet.getDataRange().getValues();
      Logger.log('Hoja "' + sheet.getName() + '" — filas: ' + rows.length);
      Logger.log('  Primeras 5 filas (cols A-I):');
      for (let i = 0; i < Math.min(5, rows.length); i++) {
        Logger.log('    ' + i + ': ' + rows[i].slice(0,9).map(c => JSON.stringify(c)).join(' | '));
      }
      // Buscar filas de marzo
      const marzo = rows.filter((r, i) => i > 0 && r[0] instanceof Date && r[0].getMonth() === 2);
      Logger.log('  Filas de marzo: ' + marzo.length);
      if (marzo.length > 0) {
        Logger.log('  Muestra de marzo: ' + marzo.slice(0,3).map(r => 'cod=' + JSON.stringify(r[2]) + ' horas=' + JSON.stringify(r[8])).join(' | '));
      }
    }
  } catch(e) { Logger.log('ERROR partes diarios: ' + e); }

  // 3. Probar leerAlquilerEquipos completo
  Logger.log('\n--- RESULTADO leerAlquilerEquipos ---');
  try {
    const alq = leerAlquilerEquipos();
    if (!alq) { Logger.log('RESULTADO: null — la función no pudo leer los datos'); }
    else {
      const meses = Object.keys(alq);
      Logger.log('Meses con datos: ' + meses.join(', '));
      meses.forEach(function(m) {
        const d = alq[m];
        Logger.log('  ' + m + ': totalArs=' + d.totalArs + ' tcUsd=' + d.tcUsd + ' obras=' + (d.porObra ? d.porObra.length : 0));
      });
    }
  } catch(e) { Logger.log('ERROR en leerAlquilerEquipos: ' + e); }

  Logger.log('=== FIN DIAGNÓSTICO ALQUILER ===');
}

function diagnosticoEquipos() {
  Logger.log('=== DIAGNÓSTICO EQUIPOS ===');

  // 1. Precios
  try {
    const ssP = SpreadsheetApp.openById(FILE_IDS.equiposFlota);
    const rowsP = ssP.getSheets()[0].getDataRange().getValues();
    Logger.log('Precios — total filas: ' + rowsP.length);
    Logger.log('Precios — primeras 12 filas col0: ' + rowsP.slice(0, 12).map((r,i) => i + ': ' + JSON.stringify(r[0])).join(' | '));

    let hdrPIdx = 0;
    for (let i = 0; i < Math.min(10, rowsP.length); i++) {
      const cells = rowsP[i].map(c => String(c).toUpperCase().trim());
      if (cells.some(c => c === 'CÓDIGO' || c === 'CODIGO')) { hdrPIdx = i; break; }
    }
    Logger.log('Precios — header en fila: ' + hdrPIdx);
    Logger.log('Precios — headers: ' + rowsP[hdrPIdx].join(' | '));

    const hP = rowsP[hdrPIdx].map(h => String(h).toLowerCase().trim());
    const iCod = _findCol(hP, ['código', 'codigo']);
    const iPF  = _findCol(hP, ['pf']);
    Logger.log('Precios — iCod=' + iCod + ' iPF=' + iPF);

    let count = 0;
    for (let i = hdrPIdx + 1; i < rowsP.length; i++) {
      const cod = String(rowsP[i][iCod] || '').trim();
      const pf  = rowsP[i][iPF];
      if (cod && pf) { Logger.log('  precio: ' + cod + ' → PF=' + pf); count++; }
    }
    Logger.log('Precios — equipos encontrados: ' + count);
  } catch(e) { Logger.log('ERROR leyendo precios: ' + e); }

  // 2. Partes diarios
  try {
    const ssU = SpreadsheetApp.openById(FILE_IDS.usageEquipos);
    const sheets = ssU.getSheets();
    Logger.log('\nPartes diarios — pestañas (' + sheets.length + '): ' + sheets.map(s => s.getName()).join(', '));

    for (const sheet of sheets) {
      const cod = sheet.getName().trim();
      Logger.log('\n-- Pestaña: ' + cod);
      const rows = sheet.getDataRange().getValues();
      Logger.log('  Total filas: ' + rows.length);
      Logger.log('  Col0 primeras 15 filas: ' + rows.slice(0, 15).map((r, i) => i + ':' + JSON.stringify(r[0])).join(' | '));

      let hdrIdx = -1;
      for (let i = 0; i < Math.min(15, rows.length); i++) {
        if (String(rows[i][0]).toUpperCase().trim() === 'FECHA') { hdrIdx = i; break; }
      }
      Logger.log('  Header FECHA en fila: ' + hdrIdx);
      if (hdrIdx >= 0) {
        Logger.log('  Headers: ' + rows[hdrIdx].slice(0, 20).join(' | '));
        // Mostrar primeras 3 filas de datos
        for (let i = hdrIdx + 1; i < Math.min(hdrIdx + 4, rows.length); i++) {
          const r = rows[i];
          Logger.log('  Fila ' + i + ': fecha=' + JSON.stringify(r[0]) + ' obra=' + JSON.stringify(r[2]) + ' col12=' + JSON.stringify(r[12]) + ' col17=' + JSON.stringify(r[17]));
        }
      }
    }
  } catch(e) { Logger.log('ERROR leyendo partes diarios: ' + e); }

  Logger.log('\n=== FIN DIAGNÓSTICO EQUIPOS ===');
}

// ============================================================
// AJUSTE DE STOCK DE ASFALTO
// ============================================================

function guardarAjusteStock(stockAntes, stockNuevo, usuario) {
  try {
    const ss    = SpreadsheetApp.openById(FILE_IDS.ajusteStock);
    const sheet = ss.getSheetByName('Ajuste de stock');
    if (!sheet) {
      return { status: 'error', message: 'No se encontró la pestaña "Ajuste de stock"' };
    }
    const tz    = 'America/Argentina/Buenos_Aires';
    const now   = new Date();
    const fecha = Utilities.formatDate(now, tz, 'dd/MM/yyyy');
    const hora  = Utilities.formatDate(now, tz, 'HH:mm:ss');
    sheet.appendRow([fecha, hora, usuario, stockAntes, stockNuevo]);
    Logger.log('Ajuste de stock guardado: ' + stockAntes + ' → ' + stockNuevo + ' (' + usuario + ')');
    return { status: 'ok', stockNuevo: stockNuevo, timestamp: now.toISOString() };
  } catch (err) {
    Logger.log('guardarAjusteStock error: ' + err.toString());
    return { status: 'error', message: err.toString() };
  }
}

// remitosData: resultado ya calculado de leerRemitosAsfalto() — se reutiliza para no leer Drive dos veces
function leerStockAsfalto(remitosData) {
  const TZ = 'America/Argentina/Buenos_Aires';
  // Punto de partida fijo (corte real confirmado por Agustín)
  const BASE_STOCK  = 700;
  const BASE_FECHA  = new Date(2026, 4, 7, 0, 0, 0); // 07/05/2026
  const BASE_USUARIO = 'Agustín';

  try {
    const ss = SpreadsheetApp.openById(FILE_IDS.ajusteStock);

    // ── 1. Checkpoint: último ajuste manual ──────────────────────
    let stockBase   = BASE_STOCK;
    let fechaBase   = BASE_FECHA;
    let usuarioBase = BASE_USUARIO;

    const sheetAjuste = ss.getSheetByName('Ajuste de stock');
    if (sheetAjuste && sheetAjuste.getLastRow() >= 2) {
      const lastRow = sheetAjuste.getLastRow();
      const row = sheetAjuste.getRange(lastRow, 1, 1, 5).getValues()[0];
      const nuevoStock = Number(row[4]);
      if (!isNaN(nuevoStock) && nuevoStock >= 0) {
        stockBase = nuevoStock;
        const parts = String(row[0] || '').split('/');
        if (parts.length === 3) {
          fechaBase = new Date(parseInt(parts[2]), parseInt(parts[1]) - 1, parseInt(parts[0]));
        }
        usuarioBase = String(row[2] || BASE_USUARIO);
      }
    }

    // ── 2. Ingresos desde formulario (solo después del checkpoint) ──
    let ingresos = 0;
    const ingresosDetalle = [];
    const sheetForm = ss.getSheetByName('Respuestas de formulario 1');

    if (sheetForm && sheetForm.getLastRow() >= 2) {
      const rows    = sheetForm.getDataRange().getValues();
      const headers = rows[0].map(function(h) { return String(h).toLowerCase().trim(); });
      Logger.log('StockAsfalto — Form headers: ' + headers.join(' | '));

      // Detectar columna de cantidad de asfalto ingresado
      const iQty = headers.findIndex(function(h) {
        return h.includes('cantidad') || h.includes('tonelada') ||
               h.includes('kilogra') || h.includes(' tn') || h === 'tn' ||
               (h.includes('asfalto') && !h.includes('marca'));
      });
      Logger.log('StockAsfalto — iQty=' + iQty + (iQty >= 0 ? ' ("' + headers[iQty] + '")' : ' (no encontrado)'));

      if (iQty >= 0) {
        for (var i = 1; i < rows.length; i++) {
          var rawFecha = rows[i][0];
          var fechaForm = rawFecha instanceof Date ? rawFecha : new Date(rawFecha);
          if (!fechaForm || isNaN(fechaForm.getTime())) continue;
          if (fechaForm <= fechaBase) continue;

          var raw = rows[i][iQty];
          var qtyKg = typeof raw === 'number' ? raw
                    : parseFloat(String(raw || '').replace(',', '.')) || 0;
          if (qtyKg <= 0) continue;
          var qty = qtyKg / 1000; // formulario carga en kg → convertir a tn

          ingresos += qty;
          ingresosDetalle.push({
            fecha:    Utilities.formatDate(fechaForm, TZ, 'dd/MM/yyyy'),
            cantidad: Math.round(qty * 10) / 10
          });
        }
      }
    }

    // ── 3. Consumo desde REMITOS ─────────────────────────────────────────────
    // 500 tn mezcla requieren 25 tn asfalto → tn asfalto = tn mezcla / 20
    const RATIO = 20;
    let consumo = 0;
    const consumoDetalle = [];
    const remitos = remitosData || {};

    if (remitos._detalle && remitos._detalle.length > 0) {
      // ── Modo exacto: fecha por fila, incluir si fecha >= fechaBase ──────────
      // Se usa >= para incluir remitos cargados el mismo día del ajuste de stock
      var filasFiltradas = remitos._detalle.filter(function(r) { return r.fecha >= fechaBase; });
      Logger.log('StockAsfalto — detalle exacto: ' + filasFiltradas.length + ' filas >= ' + Utilities.formatDate(fechaBase, TZ, 'dd/MM/yyyy'));

      for (var f = 0; f < filasFiltradas.length; f++) {
        var r = filasFiltradas[f];
        var tnAsfalto = r.cant / RATIO;
        consumo += tnAsfalto;
        consumoDetalle.push({
          fecha:     r.fechaStr,
          tipo:      r.tipo,
          caliente:  r.tipo === 'caliente' ? r.cant : 0,
          frio:      r.tipo === 'frio'     ? r.cant : 0,
          tnMezcla:  r.cant,
          tnAsfalto: Math.round(tnAsfalto * 10) / 10,
          exacto:    true,
        });
      }
    } else {
      // ── Fallback: pro-rateo mensual si no hay fechas exactas ────────────────
      const MES_NUM = { ene:1, feb:2, mar:3, abr:4, may:5, jun:6,
                        jul:7, ago:8, sep:9, oct:10, nov:11, dic:12 };
      for (var mes in remitos) {
        var numMes = MES_NUM[mes];
        if (!numMes) continue;
        var inicioMes = new Date(2026, numMes - 1, 1);
        var finMes    = new Date(2026, numMes, 0);
        if (finMes < fechaBase) continue;

        var tnMezcla = remitos[mes].total || 0;
        var fraccion = 1;
        if (inicioMes < fechaBase && fechaBase <= finMes) {
          var diasMes       = finMes.getDate();
          var diasRestantes = Math.max(0, diasMes - fechaBase.getDate());
          fraccion          = diasRestantes / diasMes;
        }
        var tnAsfaltoM = (tnMezcla * fraccion) / RATIO;
        consumo += tnAsfaltoM;
        consumoDetalle.push({
          mes:       mes,
          tnMezcla:  Math.round(tnMezcla * fraccion * 10) / 10,
          tnAsfalto: Math.round(tnAsfaltoM * 10) / 10,
          pct:       Math.round(fraccion * 100),
          caliente:  Math.round((remitos[mes].caliente || 0) * fraccion * 10) / 10,
          frio:      Math.round((remitos[mes].frio     || 0) * fraccion * 10) / 10,
        });
      }
    }

    const stockActual = stockBase + ingresos - consumo;
    Logger.log('StockAsfalto: base=' + stockBase + ' + ing=' + ingresos + ' - cons=' + consumo + ' = ' + stockActual);

    return {
      valor:           Math.round(stockActual * 10) / 10,
      stockBase:       stockBase,
      fechaBase:       Utilities.formatDate(fechaBase, TZ, 'dd/MM/yyyy'),
      usuarioBase:     usuarioBase,
      ingresos:        Math.round(ingresos * 10) / 10,
      consumo:         Math.round(consumo * 10) / 10,
      ingresosDetalle: ingresosDetalle,
      consumoDetalle:  consumoDetalle,
    };

  } catch (err) {
    Logger.log('leerStockAsfalto error: ' + err.toString());
    return { valor: BASE_STOCK, stockBase: BASE_STOCK, ingresos: 0, consumo: 0,
             fechaBase: Utilities.formatDate(BASE_FECHA, 'America/Argentina/Buenos_Aires', 'dd/MM/yyyy'),
             usuarioBase: BASE_USUARIO, ingresosDetalle: [], consumoDetalle: [] };
  }
}
