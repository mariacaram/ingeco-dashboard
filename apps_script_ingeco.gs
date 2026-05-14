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
  tango1qAbr:   '1V9LinRvDGzerh1SEpdmLaQTBuDqj3gNn',              // TANGO LIQ — 1° Quinc. Abr 2026 (Mauro)
  ocInsumos:    '1_lhq9c1MddkrK1Tf0kexRtgqw5aPhmZWiQkAIRjpfxs',  // OC Insumos — Google Sheet (Guillermo)
  maestroObras: '1VbG7DPqaOSlYkvQxbxag-4P2sOoRJQwWGccbx9OMyBM',  // Maestro de Obras con COD_OBRA
  fernandoObras:'1vGY8-saBKS4XAwd4RRqacNYRS7W0KV9brDBEo3_Jn0A',  // Obras activas (Fernando Solís)
};

// Cache en PropertiesService — evita leer Drive en cada request
const PROPS = PropertiesService.getScriptProperties();
const CACHE_KEY = 'ingeco_cache';

// ============================================================
// ENDPOINT PRINCIPAL — el dashboard llama a esta URL
// ============================================================
function doGet(e) {
  try {
    const callback = e && e.parameter && e.parameter.callback;
    const useCache  = e && e.parameter && e.parameter.cache === '1';

    let data;
    if (useCache) {
      const cached = PROPS.getProperty(CACHE_KEY);
      data = cached ? JSON.parse(cached) : buildData();
    } else {
      data = buildData();
      PROPS.setProperty(CACHE_KEY, JSON.stringify(data));
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
    PROPS.setProperty(CACHE_KEY, JSON.stringify(data));
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
  // Nuevas fuentes — en bloque separado para que si fallan no rompan TANGO/OC
  try { result.generadoPorObra = leerGeneradoPorObra(); }
  catch(e) { Logger.log('generadoPorObra error: ' + e); result.generadoPorObra = null; }
  return result;
}

// ============================================================
// TANGO — MO por Centro de Costo (1° Quincena)
// ============================================================
function leerTangoMO() {
  try {
    // Intentar UTF-8 primero, luego ISO-8859-1 (TANGO suele usar Windows-1252 / Latin-1)
    let content;
    try {
      content = DriveApp.getFileById(FILE_IDS.tango1qAbr).getBlob().getDataAsString('UTF-8');
    } catch (e) {
      content = DriveApp.getFileById(FILE_IDS.tango1qAbr).getBlob().getDataAsString('ISO-8859-1');
    }

    const lines = content.split('\n').map(l => l.trim()).filter(l => l.length > 0);

    // Encontrar línea de encabezados (contiene CTRO COSTO y NETO)
    const headerLine = lines.find(l => l.toUpperCase().includes('CTRO') && l.toUpperCase().includes('NETO'));
    if (!headerLine) {
      Logger.log('TANGO: no se encontró línea de encabezados');
      return null;
    }

    // Detectar separador (punto y coma es lo más común en TANGO)
    const sep = headerLine.includes(';') ? ';' : (headerLine.includes('\t') ? '\t' : ',');
    const headers = headerLine.split(sep).map(h => h.trim().replace(/^"|"$/g, ''));

    const iCtro = headers.findIndex(h => h.toUpperCase().includes('CTRO'));
    const iNeto = headers.findIndex(h => h.toUpperCase() === 'NETO' || h.toUpperCase().endsWith('NETO'));

    if (iCtro < 0 || iNeto < 0) {
      Logger.log('TANGO: columnas no encontradas. Headers: ' + headers.join(' | '));
      return null;
    }

    const totales = {};
    const startIdx = lines.indexOf(headerLine) + 1;

    for (let i = startIdx; i < lines.length; i++) {
      const cells = lines[i].split(sep).map(c => c.trim().replace(/^"|"$/g, ''));
      if (cells.length <= Math.max(iCtro, iNeto)) continue;

      const ctro = cells[iCtro];
      if (!ctro || ctro.toUpperCase().includes('TOTAL') || ctro === '') continue;

      const netoStr = cells[iNeto].replace(/\./g, '').replace(',', '.');
      const neto = parseFloat(netoStr);
      if (isNaN(neto) || neto <= 0) continue;

      const clave = mapearCentro(ctro);
      totales[clave] = (totales[clave] || 0) + neto;
    }

    return Object.entries(totales)
      .map(([centro, quinc]) => ({ centro, quinc: Math.round(quinc) }))
      .filter(r => r.quinc > 100)
      .sort((a, b) => b.quinc - a.quinc);

  } catch (err) {
    Logger.log('leerTangoMO error: ' + err.toString());
    return null;
  }
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

    // Buscar columnas por nombre; si no, usar posiciones fijas conocidas del análisis previo
    // Estructura observada: | (vacío) | id | pedInt | fecha | facturas/obra | monto |
    const COL_FECHA = _findCol(headers, ['fecha']) ?? 3;
    const COL_MONTO = _findCol(headers, ['monto', 'importe', 'total']) ?? 5;
    const COL_OBRA  = _findCol(headers, ['obra', 'centro', 'destino', 'factura']) ?? 4;

    Logger.log('OC Insumos — cols: fecha=' + COL_FECHA + ' monto=' + COL_MONTO + ' obra=' + COL_OBRA);

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

      const obra = clasificarObra(String(row[COL_OBRA] || ''));

      if (!acum[mes].items[obra]) acum[mes].items[obra] = { monto: 0, nOC: 0 };
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
          .map(([obra, v]) => ({ obra, monto: Math.round(v.monto), nOC: v.nOC }))
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

    const generadoPorCodigo = {};

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
      const iMonto  = _findCol(headers, ['monto']);

      if (iCodigo === null || iMonto === null) {
        Logger.log('Fernando [' + sheet.getName() + ']: columnas no encontradas. Headers: ' + headers.join('|'));
        continue;
      }

      Logger.log('Fernando [' + sheet.getName() + ']: iCodigo=' + iCodigo + ' iMonto=' + iMonto);

      for (let i = hdrIdx + 1; i < rows.length; i++) {
        const row = rows[i];
        let cod   = String(row[iCodigo] || '').trim();
        if (!cod) continue;

        // Normalizar typo frecuente en planilla de Fernando: MUNSMT → MUNCMT
        cod = cod.replace(/^MUNSMT-/, 'MUNCMT-');

        const monto = parsearMonto(row[iMonto]);
        if (!monto || monto <= 0) continue;

        generadoPorCodigo[cod] = (generadoPorCodigo[cod] || 0) + monto;
      }
    }

    Logger.log('Fernando Solís — CODs con generado: ' + Object.keys(generadoPorCodigo).length);
    return { generado: generadoPorCodigo, tabsSinPeriodo: tabsSinPeriodo };

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
    const maestro               = leerMaestroObras();
    const { generado, tabsSinPeriodo } = leerGeneradoFernando();

    const obras = [];
    for (const [cod, info] of Object.entries(maestro)) {
      if (info.fuente === 'INTERNO') continue; // centros de costo internos no van en esta tabla
      obras.push({
        cod_obra: cod,
        nombre:   info.nombre,
        cliente:  info.cliente,
        fuente:   info.fuente,
        generado: Math.round(generado[cod] || 0),
      });
    }

    // Ordenar: primero las que tienen generado (mayor primero), luego las sin dato
    obras.sort((a, b) => b.generado - a.generado);

    return { obras: obras, tabsSinPeriodo: tabsSinPeriodo };

  } catch (err) {
    Logger.log('leerGeneradoPorObra error: ' + err.toString());
    return { obras: [], tabsSinPeriodo: [] };
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

  Logger.log('\n=== FIN DIAGNÓSTICO ===');
}
