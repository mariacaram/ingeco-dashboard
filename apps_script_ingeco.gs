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
  usageEquipos:   '1CPnhO1M78vwARe21ye_Xcr0hiLIrKtR3zzANsJgc5d4',  // Partes diarios por equipo (una pestaña por COD)
  remitosAsfalto: '13z7EEuVIedOwl85d_f8MEoJGCEioZO7m9Cbn8MWxihI',  // REMITOS OFICIALES (Nico Dall'Agata)
  ajusteStock:    '1yZArsIKYMfq9UPUXyiASXtDNXyubTjFx3PPW2VjG-uA',  // Formulario Ingreso Asfalto Agustín
};

// Tipo de cambio USD → ARS oficial promedio mensual (Banco Nación Argentina)
// Actualizar cada mes con el promedio del período
const TC_USD_MENSUAL = { feb: 1430, mar: 1413, abr: 1397 };

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
  try { result.stockAsfalto     = leerStockAsfalto(result.remitosAsfalto); }
  catch(e) { Logger.log('stockAsfalto error: ' + e); result.stockAsfalto = null; }
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

    const acum = {
      feb: { items: {}, total: 0, nOC: 0 },
      mar: { items: {}, total: 0, nOC: 0 },
      abr: { items: {}, total: 0, nOC: 0 }
    };

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

  if (mes === 2) return 'feb';
  if (mes === 3) return 'mar';
  if (mes === 4) return 'abr';
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
    const ss     = SpreadsheetApp.openById(FILE_IDS.fernandoObras);
    const sheets = ss.getSheets();

    // Pestañas a leer (el usuario confirmó que aún no tienen Período cargado)
    const TABS_OBJETIVO   = ['OBRAS DE MUNICIPIO', 'VIALIDAD1', 'OTROS INGRESOS'];
    const tabsSinPeriodo  = [...TABS_OBJETIVO]; // se notifica en el dashboard

    const aCobrarPorCodigo  = {};
    const nombrePorCodigo   = {};
    const detallesPorCodigo = {};

    for (const sheet of sheets) {
      const tabName = sheet.getName().toUpperCase().trim();
      const esObjetivo = TABS_OBJETIVO.some(t => tabName.includes(t));
      if (!esObjetivo) continue;

      const rows = sheet.getDataRange().getValues();
      if (rows.length < 2) continue;

      // Encontrar fila de encabezados (busca "código" o "monto")
      let hdrIdx = 0;
      for (let i = 0; i < Math.min(6, rows.length); i++) {
        const rowStr = rows[i].map(c => String(c).toLowerCase()).join('|');
        if (rowStr.includes('monto') || rowStr.includes('código') || rowStr.includes('codigo')) {
          hdrIdx = i; break;
        }
      }

      // Buscar columnas — búsqueda directa en lowercase, sin normalize
      const headers = rows[hdrIdx].map(h => String(h).toLowerCase().trim());

      const iCodigo = _findCol(headers, ['código', 'codigo', 'cod_obra', 'cod']);
      const iEstado = _findCol(headers, ['estado $', 'estado$', 'estado']);
      const iNombre = _findCol(headers, ['nombre obra', 'nombre']) ?? 0;
      // Separar "Monto Total" (valor contrato) de "Monto" (certificado específico)
      const iMontoTotal = headers.findIndex(h => h.includes('monto') && h.includes('total'));
      const iMonto      = headers.findIndex(h => h === 'monto' || (h.includes('monto') && !h.includes('total')));

      if (iCodigo === null || (iMonto < 0 && iMontoTotal < 0)) {
        Logger.log('Fernando [' + sheet.getName() + ']: columnas no encontradas. Headers: ' + headers.join('|'));
        continue;
      }

      Logger.log('Fernando [' + sheet.getName() + ']: iCodigo=' + iCodigo + ' iEstado=' + iEstado + ' iMonto=' + iMonto + ' iMontoTotal=' + iMontoTotal);

      for (let i = hdrIdx + 1; i < rows.length; i++) {
        const row = rows[i];
        let cod   = String(row[iCodigo] || '').trim();
        if (!cod) cod = 'SIN-CODIGO';

        // Solo incluir filas con Estado $ = "A Cobrar"
        if (iEstado !== null) {
          const estado = String(row[iEstado] || '').trim().toLowerCase();
          if (estado !== 'a cobrar') continue;
        }

        // Usar "Monto" si tiene valor, sino "Monto Total"
        let monto = iMonto >= 0 ? parsearMonto(row[iMonto]) : 0;
        if (monto <= 0 && iMontoTotal >= 0) monto = parsearMonto(row[iMontoTotal]);
        if (!monto || monto <= 0) continue;

        aCobrarPorCodigo[cod] = (aCobrarPorCodigo[cod] || 0) + monto;

        // Guardar nombre de la primera fila vista para este código
        const n = String(row[iNombre] || '').trim();
        if (!nombrePorCodigo[cod] && n) nombrePorCodigo[cod] = n;

        // Guardar ítem individual para el panel de detalle
        if (!detallesPorCodigo[cod]) detallesPorCodigo[cod] = [];
        detallesPorCodigo[cod].push({ nombre: n || cod, monto: Math.round(monto) });
      }
    }

    Logger.log('Fernando Solís — CODs con A Cobrar: ' + Object.keys(aCobrarPorCodigo).length);
    return { aCobrar: aCobrarPorCodigo, nombreFernando: nombrePorCodigo,
             detalles: detallesPorCodigo, tabsSinPeriodo: tabsSinPeriodo };

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
    const { aCobrar, nombreFernando, detalles, tabsSinPeriodo } = leerGeneradoFernando();

    const obras = [];
    // Iterar sobre TODOS los códigos de Fernando (no solo los del Maestro)
    for (const [cod, monto] of Object.entries(aCobrar)) {
      if (cod === 'SIN-CODIGO') continue;
      const montoRed = Math.round(monto);
      if (montoRed <= 0) continue;

      const info = maestro[cod];
      if (info && info.fuente === 'INTERNO') continue;

      obras.push({
        cod_obra: cod,
        nombre:   info ? info.nombre : (nombreFernando[cod] || cod),
        cliente:  info ? info.cliente : '—',
        tipo:     info ? info.tipo    : '—',
        aCobrar:  montoRed,
        items:    detalles[cod] || [],
      });
    }

    obras.sort((a, b) => b.aCobrar - a.aCobrar);

    // Filas sin código al final
    const montoSinCod = Math.round(aCobrar['SIN-CODIGO'] || 0);
    if (montoSinCod > 0) {
      obras.push({
        cod_obra: '—',
        nombre:   'Obra sin asignación de código',
        cliente:  '—',
        tipo:     '—',
        aCobrar:  montoSinCod,
      });
    }

    return { obras: obras, tabsSinPeriodo: tabsSinPeriodo };

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
function leerAlquilerEquipos() {
  try {
    // 1. Leer precios — solo equipos con PF definido (maquinaria pesada)
    const ssPrecios = SpreadsheetApp.openById(FILE_IDS.equiposFlota);
    const rowsPrecios = ssPrecios.getSheets()[0].getDataRange().getValues();

    let hdrPIdx = 0;
    for (let i = 0; i < Math.min(10, rowsPrecios.length); i++) {
      // Buscar la celda que sea EXACTAMENTE 'CÓDIGO' (no substring de "CÓDIGOS DE EQUIPOS")
      const cells = rowsPrecios[i].map(c => String(c).toUpperCase().trim());
      if (cells.some(c => c === 'CÓDIGO' || c === 'CODIGO')) { hdrPIdx = i; break; }
    }
    const hP = rowsPrecios[hdrPIdx].map(h => String(h).toLowerCase().trim());
    const iCod    = _findCol(hP, ['código', 'codigo']);
    const iPF     = _findCol(hP, ['pf']);
    const iClasif = _findCol(hP, ['clasificación', 'clasificacion']);
    const iMarca  = _findCol(hP, ['marca']);
    const iModelo = _findCol(hP, ['modelo']);
    if (iCod === null || iPF === null) return null;

    const precios = {};
    for (let i = hdrPIdx + 1; i < rowsPrecios.length; i++) {
      const row = rowsPrecios[i];
      const cod = String(row[iCod] || '').trim();
      const pf  = typeof row[iPF] === 'number' ? row[iPF]
                : parseFloat(String(row[iPF]).replace(',', '.')) || 0;
      if (!cod || pf <= 0) continue;
      precios[cod] = {
        pf_usd:       pf,
        clasificacion: String(row[iClasif] || '').trim(),
        marca:         String(row[iMarca]  || '').trim(),
        modelo:        String(row[iModelo] || '').trim()
      };
    }
    Logger.log('Equipos con PF: ' + Object.keys(precios).length);

    // 2. Leer uso — una pestaña por equipo (nombre pestaña = COD_EQUIPO)
    const ssUso  = SpreadsheetApp.openById(FILE_IDS.usageEquipos);
    const meses  = ['feb', 'mar', 'abr'];
    // acum[mes][cod] = { _total: horas, [obra]: horas }
    const acum = {};
    meses.forEach(m => { acum[m] = {}; });

    for (const sheet of ssUso.getSheets()) {
      const cod = sheet.getName().trim();
      if (!precios[cod]) continue;

      const rows = sheet.getDataRange().getValues();
      // Encontrar fila con FECHA en col 0
      let hdrIdx = -1;
      for (let i = 0; i < Math.min(15, rows.length); i++) {
        if (String(rows[i][0]).toUpperCase().trim() === 'FECHA') { hdrIdx = i; break; }
      }
      if (hdrIdx < 0) continue;

      // Columnas fijas según estructura conocida de los partes diarios
      const COL_FECHA     = 0;
      const COL_OBRA      = 2;
      const COL_HORAS_OP  = 7;  // HORARIOS OPERARIO / TOTAL (dato principal)
      const COL_HORAS_EQ  = 12; // HORARIOS EQUIPO / TOTAL
      const COL_HOROMETRO = 17; // HORÓMETRO / TOTAL

      meses.forEach(m => { if (!acum[m][cod]) acum[m][cod] = { _total: 0 }; });

      for (let i = hdrIdx + 1; i < rows.length; i++) {
        const row = rows[i];
        const mes = parsearMes(row[COL_FECHA]);
        if (!mes) continue;

        const obraRaw = String(row[COL_OBRA] || '').trim();
        const obra    = (obraRaw && obraRaw !== '-') ? obraRaw : 'Sin asignar';

        let horas = parsearHoras(row[COL_HORAS_OP]);   // Horarios Operario: dato principal
        if (horas <= 0) horas = parsearHoras(row[COL_HOROMETRO]);  // Horómetro: fallback si olvidaron cargar
        if (horas <= 0) horas = parsearHoras(row[COL_HORAS_EQ]);   // Horarios Equipo: último recurso
        if (horas <= 0) continue;

        if (!acum[mes][cod][obra]) acum[mes][cod][obra] = 0;
        acum[mes][cod][obra]  += horas;
        acum[mes][cod]._total += horas;
      }
    }

    // 3. Calcular costos prorrateados por horas
    const resultado = {};
    for (const mes of meses) {
      const tc = TC_USD_MENSUAL[mes] || 1400;
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
// REMITOS OFICIALES — Tn Caliente y Frío producidas por mes
// Fuente: Google Sheet de Nico Dall'Agata
// Columnas clave: CANT. (cantidad en TN), U.D. (debe ser "TN"),
//   DESCRIPCION (ASFALTO CALIENTE / ASFALTO FRIO), Mes, Año
// ============================================================
function leerRemitosAsfalto() {
  try {
    const ss     = SpreadsheetApp.openById(FILE_IDS.remitosAsfalto);
    const sheets = ss.getSheets();
    const MES_MAP = { 1:'ene', 2:'feb', 3:'mar', 4:'abr', 5:'may', 6:'jun',
                      7:'jul', 8:'ago', 9:'sep', 10:'oct', 11:'nov', 12:'dic' };
    const resultado = {};

    for (const sheet of sheets) {
      const rows = sheet.getDataRange().getValues();

      // Buscar fila de encabezados que tenga CANT. y U.D./U.M.
      let hdrIdx = -1, iCant = -1, iUD = -1, iDesc = -1, iMes = -1, iAnio = -1;
      for (let i = 0; i < Math.min(20, rows.length); i++) {
        const cells = rows[i].map(c => String(c).toUpperCase().trim());
        const iC = cells.findIndex(c => c === 'CANT.' || c === 'CANT' || c === 'CANTIDAD');
        const iU = cells.findIndex(c => c === 'U.D.' || c === 'U.M.' || c === 'UD' || c === 'UNIDAD');
        if (iC >= 0 && iU >= 0) {
          hdrIdx = i; iCant = iC; iUD = iU;
          iDesc = cells.findIndex(c => c === 'DESCRIPCION' || c === 'DESCRIPCIÓN');
          iMes  = cells.findIndex(c => c === 'MES');
          iAnio = cells.findIndex(c => c === 'AÑO' || c === 'ANO' || c === 'AÑO');
          break;
        }
      }
      if (hdrIdx < 0) continue;
      Logger.log('Remitos [' + sheet.getName() + ']: hdr=' + hdrIdx + ' iCant=' + iCant + ' iUD=' + iUD + ' iDesc=' + iDesc + ' iMes=' + iMes + ' iAnio=' + iAnio);

      for (let i = hdrIdx + 1; i < rows.length; i++) {
        const row = rows[i];

        const ud = String(row[iUD] || '').toUpperCase().trim();
        if (ud !== 'TN') continue;

        const desc = String(row[iDesc] || '').toUpperCase().trim();
        if (!desc.includes('ASFALTO')) continue;

        // Mes y año
        const mesRaw  = row[iMes];
        const anioRaw = row[iAnio];
        let mesNum  = typeof mesRaw  === 'number' ? mesRaw  : parseInt(String(mesRaw  || ''));
        let anioNum = typeof anioRaw === 'number' ? anioRaw : parseInt(String(anioRaw || ''));
        if (isNaN(mesNum) || isNaN(anioNum)) continue;
        if (anioNum < 100) anioNum += 2000; // 26 → 2026
        if (anioNum !== 2026) continue;

        const mesKey = MES_MAP[mesNum];
        if (!mesKey) continue;

        const cant = typeof row[iCant] === 'number' ? row[iCant]
                   : parseFloat(String(row[iCant] || '').replace(',', '.')) || 0;
        if (cant <= 0) continue;

        if (!resultado[mesKey]) resultado[mesKey] = { caliente: 0, frio: 0, total: 0 };
        if (desc.includes('CALIENTE'))                    resultado[mesKey].caliente += cant;
        else if (desc.includes('FRI') || desc.includes('FRÍO')) resultado[mesKey].frio     += cant;
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

    // ── 3. Consumo desde REMITOS (meses posteriores al checkpoint) ──
    // 500 tn mezcla requieren 25 tn de asfalto → tn asfalto = tn mezcla / 20
    const RATIO = 20;
    const MES_NUM = { ene:1, feb:2, mar:3, abr:4, may:5, jun:6,
                      jul:7, ago:8, sep:9, oct:10, nov:11, dic:12 };
    let consumo = 0;
    const consumoDetalle = [];
    const remitos = remitosData || {};

    for (var mes in remitos) {
      var numMes = MES_NUM[mes];
      if (!numMes) continue;
      var inicioMes = new Date(2026, numMes - 1, 1);
      // Solo meses que empiecen DESPUÉS del checkpoint
      if (inicioMes <= fechaBase) continue;
      var tnMezcla  = remitos[mes].total || 0;
      var tnAsfalto = tnMezcla / RATIO;
      consumo += tnAsfalto;
      consumoDetalle.push({
        mes:      mes,
        tnMezcla: Math.round(tnMezcla * 10) / 10,
        tnAsfalto: Math.round(tnAsfalto * 10) / 10
      });
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
