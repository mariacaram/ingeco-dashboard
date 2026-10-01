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
  ocInsumos:    '1UWUIW4sNtRBa90nYoGg88ghGK8SyyjKe9UdZLRcHMEE',  // Órdenes de Compra — Google Sheet (Guillermo) — hoja "ÓRDENES"
  maestroObras: '1VbG7DPqaOSlYkvQxbxag-4P2sOoRJQwWGccbx9OMyBM',  // Maestro de Obras con COD_OBRA
  fernandoObras:'1Hl8HZqrH6lMwnAGpitA37ZGLg4szTcFGK7vmv92qkBA',  // Obras activas (archivo de Julia — LEGACY, reemplazado por agustinObras)
  agustinObras: '1YldZRtbLh17Xqczl-omI0zjHcgvrhvp3QOsjWffEm_s',  // Obras a cobrar (Agustín) — Monto Total / Anticipo / Monto a certificar
  estebanSheet: '1EwrHdUkCBER10vBZyrQBodJOrfEr2p94QlfYZ7ewSmY',    // Cobros reales (Esteban) — una pestaña por mes (Google Sheets)
  equiposFlota: '1PEcPzwrQ8kE2evmUlrFq9wPbgWOR92MPl3LEqcSYbIk',  // Equipos + PF mensual (Adrián)
  usageEquipos:     '1e_emRVEUxTaNtLxeC0wXIWKzcKuoulZkFSS9O1e0XHo',  // Partes diarios — hoja única (Nico)
  repuestosEquipos: '1JpXjGTJwlvMuEI-rFTd4KeKvzd708-yuSLAhIRuCFC0',  // Compra de repuestos — hoja ENTREGAS (Nico)
  remitosAsfalto:   '1_c6El5XDWoy84J7UAe8xlA1WC03IdklQyraMZEbQiEs',  // REMITOS OFICIALES (Roberto)
  remitosAmaicha:   '1k5tUEAHh_ecCY81Y7oGAcxMz6hQ0A0Fna4ewLWPIuUg',  // Mezcla despachada desde Amaicha (Ruta 357) — Fecha | Obra | Cantidad | Unidad (María)
  ajusteStock:    '1yZArsIKYMfq9UPUXyiASXtDNXyubTjFx3PPW2VjG-uA',  // Formulario Ingreso Asfalto Agustín
  precioAsfalto:  '1lqKTXtDLT2FxyXurxjU1uE4epDOKs5SP8AXu5wAUsJ4',  // Precio de mercado asfalto $/tn por mes
  gastosEstructura: '1beFIrKD6ljPKjjssuWP-_TmTH8vr1TktBnVDuX9nxyM', // Libro mayor de gastos admin. (Gastos de Estructura)
};

// Tipo de cambio USD → ARS oficial promedio mensual (Banco Nación Argentina)
// Actualizar cada mes con el promedio del período
const TC_USD_MENSUAL = { feb: 1430, mar: 1413, abr: 1397, may: 1381, jun: 1427 };

// Cache en PropertiesService — evita leer Drive en cada request
const PROPS = PropertiesService.getScriptProperties();
const CACHE_KEY = 'ingeco_cache';

// Huella SHA-256 (hex) de la clave que manda el proxy de Vercel.
// Para rotar la clave: generar una nueva, cargarla en Vercel (APPS_SCRIPT_KEY)
// y reemplazar esta huella por la de la clave nueva.
const API_KEY_SHA256 = '4192fb16eaa180a9ee4c261a5f68b896264829fb737d5e0da0b34089f9d12e56';
function _sha256Hex(txt) {
  return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(txt), Utilities.Charset.UTF_8)
    .map(b => ('0' + ((b + 256) % 256).toString(16)).slice(-2)).join('');
}
function _claveValida(k) {
  if (!k) return false;
  const prop = PROPS.getProperty('API_KEY');
  if (prop && k === prop) return true;
  return _sha256Hex(k) === API_KEY_SHA256;
}

// Caché en Script Properties (tope 500 KB total, 9 KB "oficiales" por clave).
// Cada bloque se guarda comprimido (gzip + base64, ~4-6x más chico) con el
// prefijo "gz:"; al leer se acepta también el JSON plano viejo (sep-2026:
// las OC con detalle fila por fila hicieron saltar la cuota).
function _cacheSet(key, obj) {
  const json = JSON.stringify(obj);
  const gz = 'gz:' + Utilities.base64Encode(Utilities.gzip(Utilities.newBlob(json, 'application/json')).getBytes());
  PROPS.setProperty(key, gz.length < json.length ? gz : json);
}
function _cacheGet(key) {
  const raw = PROPS.getProperty(key);
  if (!raw) return null;
  try {
    if (raw.indexOf('gz:') === 0) {
      const bytes = Utilities.base64Decode(raw.substring(3));
      return JSON.parse(Utilities.ungzip(Utilities.newBlob(bytes, 'application/x-gzip')).getDataAsString());
    }
    return JSON.parse(raw);
  } catch (e) { Logger.log('cacheGet error ' + key + ': ' + e); return null; }
}

// ============================================================
// ENDPOINT PRINCIPAL — el dashboard llama a esta URL
// ============================================================
function doGet(e) {
  try {
    // Clave compartida con el proxy de Vercel (variable APPS_SCRIPT_KEY).
    // Todo pedido sin la clave correcta se rechaza. Se valida contra su huella
    // SHA-256 (la huella no permite reconstruir la clave). No se usa la
    // pantalla de Propiedades del script porque al guardar desde ahí se
    // regraban también las claves grandes del caché y el guardado falla
    // en silencio (oct-2026). Si existiera la propiedad API_KEY, también vale.
    if (!_claveValida(e && e.parameter && e.parameter.key)) {
      return ContentService.createTextOutput(JSON.stringify({ status: 'error', message: 'No autorizado' }))
        .setMimeType(ContentService.MimeType.JSON);
    }
    const callback = e && e.parameter && e.parameter.callback;
    const action   = e && e.parameter && e.parameter.action;

    // ── Diagnóstico del almacén de propiedades (cuota 500 KB) ─────────
    // action=diag → nombre y tamaño de cada clave (nunca el valor).
    // action=limpiar → borra claves que no son del caché actual ni API_KEY.
    if (action === 'diag' || action === 'limpiar') {
      const props = PROPS.getProperties();
      const validas = {};
      ['', '_obras', '_alquiler', '_mo', '_moq', '_oc', '_remitos', '_cobros_est', '_stock', '_precio', '_gest', '_repuestos', '_fechas']
        .forEach(sfx => { validas[CACHE_KEY + sfx] = true; });
      validas['API_KEY'] = true;
      const claves = Object.keys(props).map(k => ({ k: k, len: (props[k] || '').length, gz: (props[k] || '').indexOf('gz:') === 0, valida: !!validas[k] }));
      let borradas = [];
      if (action === 'limpiar') {
        claves.filter(c => !c.valida).forEach(c => { PROPS.deleteProperty(c.k); borradas.push(c.k); });
      }
      // Prueba de escritura comprimida (para diagnosticar fallas de gzip/cuota)
      let prueba = 'ok';
      try {
        const obj = { x: new Array(3000).fill('prueba de compresión ÓRDENES').join(' ') };
        _cacheSet(CACHE_KEY + '_probe', obj);
        const raw = PROPS.getProperty(CACHE_KEY + '_probe') || '';
        const back = _cacheGet(CACHE_KEY + '_probe');
        prueba = 'escrito ' + raw.length + ' bytes (' + raw.substring(0, 3) + ') · lectura ' + (back && back.x === obj.x ? 'ok' : 'FALLA');
        PROPS.deleteProperty(CACHE_KEY + '_probe');
      } catch (pe) { prueba = 'ERROR: ' + pe; }
      const out = { status: 'ok', total: claves.reduce((s, c) => s + c.len, 0), claves: claves, borradas: borradas, prueba: prueba };
      return ContentService.createTextOutput(JSON.stringify(out)).setMimeType(ContentService.MimeType.JSON);
    }

    // ── Ajuste de stock ──────────────────────────────────────────
    if (action === 'ajusteStock') {
      const stockAntes = parseFloat((e.parameter.stockAntes || '0').replace(',', '.'));
      const stockNuevo = parseFloat((e.parameter.stockNuevo || '0').replace(',', '.'));
      const usuario    = e.parameter.usuario || 'Agustín';
      const tipo       = e.parameter.tipo || 'asfalto';
      const fecha      = e.parameter.fecha || null; // dd/MM/yyyy opcional — fecha retroactiva del corte
      const resultado  = guardarAjusteStock(stockAntes, stockNuevo, usuario, tipo, fecha);
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
      const cached = _cacheGet(CACHE_KEY);
      data = cached ? cached : buildData();
      // Cada campo grande se guarda en su propia clave (límite 9 KB por propiedad)
      if (data && !data.generadoPorObra) {
        const cachedObras = _cacheGet(CACHE_KEY + '_obras');
        if (cachedObras) data.generadoPorObra = cachedObras;
      }
      if (data && !data.alquilerEquipos) {
        const cachedAlquiler = _cacheGet(CACHE_KEY + '_alquiler');
        if (cachedAlquiler) data.alquilerEquipos = cachedAlquiler;
      }
      if (data && !data.moCtroCosto) {
        const cachedMo = _cacheGet(CACHE_KEY + '_mo');
        if (cachedMo) data.moCtroCosto = cachedMo;
      }
      if (data && !data.moQuincenas) {
        const cachedMoQ = _cacheGet(CACHE_KEY + '_moq');
        if (cachedMoQ) data.moQuincenas = cachedMoQ;
      }
      if (data && !data.ocInsumos) {
        const cachedOc = _cacheGet(CACHE_KEY + '_oc');
        if (cachedOc) data.ocInsumos = cachedOc;
      }
      if (data && !data.remitosAsfalto) {
        const cachedRem = _cacheGet(CACHE_KEY + '_remitos');
        if (cachedRem) data.remitosAsfalto = cachedRem;
      }
      if (data && !data.cobrosEsteban) {
        const cachedCob = _cacheGet(CACHE_KEY + '_cobros_est');
        if (cachedCob) data.cobrosEsteban = cachedCob;
      }
      if (data && !data.stockAsfalto) {
        const cachedStock = _cacheGet(CACHE_KEY + '_stock');
        if (cachedStock) data.stockAsfalto = cachedStock;
      }
      if (data && !data.precioAsfalto) {
        const cachedPrecio = _cacheGet(CACHE_KEY + '_precio');
        if (cachedPrecio) data.precioAsfalto = cachedPrecio;
      }
      if (data && !data.gastosEstructura) {
        const cachedGest = _cacheGet(CACHE_KEY + '_gest');
        if (cachedGest) data.gastosEstructura = cachedGest;
      }
      if (data && !data.repuestosEquipos) {
        const cachedRep = _cacheGet(CACHE_KEY + '_repuestos');
        if (cachedRep) data.repuestosEquipos = cachedRep;
      }
      if (data && !data.fechasFuentes) {
        const cachedFechas = _cacheGet(CACHE_KEY + '_fechas');
        if (cachedFechas) data.fechasFuentes = cachedFechas;
      }
    } else {
      data = buildData();
      // Guardar cada campo en su propia clave — PropertiesService tiene límite de 9 KB por propiedad
      try {
        _cacheSet(CACHE_KEY, { status: data.status, timestamp: data.timestamp });
      } catch(ce) { Logger.log('Cache write error: ' + ce); }
      try {
        if (data.generadoPorObra) _cacheSet(CACHE_KEY + '_obras', data.generadoPorObra);
      } catch(ce) { Logger.log('Cache write (obras) error: ' + ce); }
      try {
        if (data.alquilerEquipos) _cacheSet(CACHE_KEY + '_alquiler', data.alquilerEquipos);
      } catch(ce) { Logger.log('Cache write (alquiler) error: ' + ce); }
      try {
        if (data.moCtroCosto) _cacheSet(CACHE_KEY + '_mo', data.moCtroCosto);
      } catch(ce) { Logger.log('Cache write (mo) error: ' + ce); }
      try {
        if (data.moQuincenas) _cacheSet(CACHE_KEY + '_moq', data.moQuincenas);
      } catch(ce) { Logger.log('Cache write (moq) error: ' + ce); }
      try {
        if (data.ocInsumos && Object.keys(data.ocInsumos).length) _cacheSet(CACHE_KEY + '_oc', data.ocInsumos);
      } catch(ce) { Logger.log('Cache write (oc) error: ' + ce); }
      try {
        if (data.remitosAsfalto) _cacheSet(CACHE_KEY + '_remitos', data.remitosAsfalto);
      } catch(ce) { Logger.log('Cache write (remitos) error: ' + ce); }
      try {
        if (data.cobrosEsteban) _cacheSet(CACHE_KEY + '_cobros_est', data.cobrosEsteban);
      } catch(ce) { Logger.log('Cache write (cobros_est) error: ' + ce); }
      try {
        if (data.stockAsfalto) _cacheSet(CACHE_KEY + '_stock', data.stockAsfalto);
      } catch(ce) { Logger.log('Cache write (stock) error: ' + ce); }
      try {
        if (data.precioAsfalto) _cacheSet(CACHE_KEY + '_precio', data.precioAsfalto);
      } catch(ce) { Logger.log('Cache write (precio) error: ' + ce); }
      try {
        if (data.gastosEstructura) _cacheSet(CACHE_KEY + '_gest', data.gastosEstructura);
      } catch(ce) { Logger.log('Cache write (gest) error: ' + ce); }
      try {
        if (data.repuestosEquipos) _cacheSet(CACHE_KEY + '_repuestos', data.repuestosEquipos);
      } catch(ce) { Logger.log('Cache write (repuestos) error: ' + ce); }
      try {
        if (data.fechasFuentes) _cacheSet(CACHE_KEY + '_fechas', data.fechasFuentes);
      } catch(ce) { Logger.log('Cache write (fechas) error: ' + ce); }
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
// ============================================================
// ACTUALIZACIÓN HORARIA
// Wrapper para el trigger cada 1 hora: refresca el caché solo entre las
// 6 y las 22 (hora argentina) para no gastar cuota de ejecución de noche.
// SETUP (una sola vez): ejecutar crearTriggerHorario() desde el editor.
// ============================================================
function actualizarHorario() {
  const hora = parseInt(Utilities.formatDate(new Date(), 'America/Argentina/Buenos_Aires', 'H'), 10);
  if (hora < 6 || hora > 22) { Logger.log('actualizarHorario: fuera de horario (' + hora + 'h), no se actualiza'); return; }
  actualizarNocturno();
}

// Crea (o recrea) el trigger horario. Ejecutar UNA VEZ desde el editor.
// Borra triggers previos de actualizarHorario/actualizarNocturno para no duplicar.
function crearTriggerHorario() {
  ScriptApp.getProjectTriggers().forEach(function(t) {
    const fn = t.getHandlerFunction();
    if (fn === 'actualizarHorario' || fn === 'actualizarNocturno') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('actualizarHorario').timeBased().everyHours(1).create();
  Logger.log('Trigger horario creado: actualizarHorario() cada 1 hora (activo de 6 a 22h)');
}

function actualizarNocturno() {
  try {
    const data = buildData();
    _cacheSet(CACHE_KEY, { status: data.status, timestamp: data.timestamp });
    if (data.generadoPorObra) _cacheSet(CACHE_KEY + '_obras', data.generadoPorObra);
    if (data.alquilerEquipos) _cacheSet(CACHE_KEY + '_alquiler', data.alquilerEquipos);
    if (data.moCtroCosto)     _cacheSet(CACHE_KEY + '_mo', data.moCtroCosto);
    if (data.moQuincenas)     _cacheSet(CACHE_KEY + '_moq', data.moQuincenas);
    if (data.ocInsumos && Object.keys(data.ocInsumos).length) _cacheSet(CACHE_KEY + '_oc', data.ocInsumos);
    if (data.remitosAsfalto)  _cacheSet(CACHE_KEY + '_remitos', data.remitosAsfalto);
    if (data.cobrosEsteban)   _cacheSet(CACHE_KEY + '_cobros_est', data.cobrosEsteban);
    if (data.stockAsfalto)    _cacheSet(CACHE_KEY + '_stock', data.stockAsfalto);
    if (data.precioAsfalto)   _cacheSet(CACHE_KEY + '_precio', data.precioAsfalto);
    if (data.gastosEstructura) _cacheSet(CACHE_KEY + '_gest', data.gastosEstructura);
    if (data.repuestosEquipos) _cacheSet(CACHE_KEY + '_repuestos', data.repuestosEquipos);
    if (data.fechasFuentes)   _cacheSet(CACHE_KEY + '_fechas', data.fechasFuentes);
    // Espejo de cobros reales en el archivo de Agustín (pestaña autogenerada)
    try { escribirCobrosEnAgustin(data.cobrosEsteban); }
    catch (e) { Logger.log('escribirCobrosEnAgustin error: ' + e); }
    Logger.log('Cache actualizado: ' + data.timestamp);
  } catch (err) {
    Logger.log('Error en trigger nocturno: ' + err.toString());
  }
}

// ============================================================
// ESPEJO DE COBROS EN EL ARCHIVO DE AGUSTÍN
// Mantiene una pestaña autogenerada "Cobros (auto - no editar)" con cada
// cobro real registrado por Esteban (deduplicado entre hojas mensuales),
// para que en el mismo archivo de Agustín se vea qué entró y qué falta
// contra su "Monto a certificar". No toca ninguna otra pestaña.
// ============================================================
function escribirCobrosEnAgustin(cobros) {
  if (!cobros) return;
  const ss = SpreadsheetApp.openById(FILE_IDS.agustinObras);
  const NOMBRE = 'Cobros (auto - no editar)';
  let sh = ss.getSheetByName(NOMBRE);
  if (!sh) sh = ss.insertSheet(NOMBRE);
  const filas = [['Mes', 'Fecha real de cobro', 'Obra / Código', 'Concepto', 'Importe']];
  const vistos = {};
  const MESES_KEYS = ['ene','feb','mar','abr','may','jun','jul','ago','sep','oct','nov','dic'];
  const MES_LBL = { ene:'Enero', feb:'Febrero', mar:'Marzo', abr:'Abril', may:'Mayo', jun:'Junio',
                    jul:'Julio', ago:'Agosto', sep:'Septiembre', oct:'Octubre', nov:'Noviembre', dic:'Diciembre' };
  MESES_KEYS.forEach(function(mes) {
    const cm = cobros[mes];
    if (!cm || !cm.cobrados) return;
    cm.cobrados.forEach(function(it) {
      const k = (it.obra || '') + '|' + (it.concepto || '') + '|' + (it.importe || 0);
      if (vistos[k]) return; // mismo cobro repetido en dos hojas mensuales
      vistos[k] = true;
      filas.push([MES_LBL[mes] || mes, it.fechaReal || '', it.obra || '', it.concepto || '', it.importe || 0]);
    });
  });
  sh.clearContents();
  sh.getRange(1, 1, filas.length, 5).setValues(filas);
  sh.getRange(1, 1, 1, 5).setFontWeight('bold');
  Logger.log('Cobros espejados en archivo Agustín: ' + (filas.length - 1) + ' filas');
}

// ============================================================
// CONSTRUIR EL OBJETO DE DATOS COMPLETO
// ============================================================
function buildData() {
  const tangoData = leerTangoMO();
  const result = {
    status:      'ok',
    timestamp:   new Date().toISOString(),
    moCtroCosto: tangoData.porCentro,
    moQuincenas: tangoData.quincenas, // { mes: [{nombre, total, totalObra, totalTaller, totalPlanta}] }
    ocInsumos:   leerOCInsumos(),
  };
  try { result.generadoPorObra  = leerGeneradoPorObra(); }
  catch(e) { Logger.log('generadoPorObra error: ' + e); result.generadoPorObra = null; }
  try { result.alquilerEquipos  = leerAlquilerEquipos(); }
  catch(e) { Logger.log('alquilerEquipos error: ' + e); result.alquilerEquipos = null; }
  try { result.remitosAsfalto   = leerRemitosAsfalto(); }
  catch(e) { Logger.log('remitosAsfalto error: ' + e); result.remitosAsfalto = null; }
  try { result.cobrosEsteban    = leerCobrosEsteban(); }
  catch(e) { Logger.log('cobrosEsteban error: ' + e); result.cobrosEsteban = null; }
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
  try { result.gastosEstructura = leerGastosEstructura(); }
  catch(e) { Logger.log('gastosEstructura error: ' + e); result.gastosEstructura = null; }
  try { result.fechasFuentes = leerFechasFuentes(); }
  catch(e) { Logger.log('fechasFuentes error: ' + e); result.fechasFuentes = null; }
  return result;
}

// ============================================================
// FECHAS DE ÚLTIMA MODIFICACIÓN DE LOS ARCHIVOS FUENTE (pestaña Fuentes de Datos)
// Lee vía DriveApp la fecha real de última modificación de cada archivo, para
// no depender de que alguien actualice a mano la columna en FUENTES (index.html).
// ============================================================
function leerFechasFuentes() {
  const resultado = {};
  const claves = ['ocInsumos', 'maestroObras', 'fernandoObras', 'agustinObras', 'estebanSheet',
    'equiposFlota', 'usageEquipos', 'repuestosEquipos', 'remitosAsfalto',
    'ajusteStock', 'precioAsfalto', 'gastosEstructura'];
  claves.forEach(function(k) {
    try {
      resultado[k] = DriveApp.getFileById(FILE_IDS[k]).getLastUpdated().toISOString();
    } catch (e) {
      Logger.log('leerFechasFuentes: error en ' + k + ': ' + e);
    }
  });
  // tangoFolder es una carpeta con un archivo por mes — usar el modificado más reciente
  try {
    const files = DriveApp.getFolderById(FILE_IDS.tangoFolder).getFiles();
    let masReciente = null;
    while (files.hasNext()) {
      const f = files.next();
      const d = f.getLastUpdated();
      if (!masReciente || d > masReciente) masReciente = d;
    }
    if (masReciente) resultado.tangoFolder = masReciente.toISOString();
  } catch (e) {
    Logger.log('leerFechasFuentes: error en tangoFolder: ' + e);
  }
  return resultado;
}

// ============================================================
// TANGO — MO por Centro de Costo (1° Quincena)
// ============================================================
// Lee todos los archivos de la carpeta de Mauro y devuelve
// { porCentro: { ene: [{centro,monto,clasificacion}], ... },
//   quincenas: { ene: [{nombre, total, totalObra, totalTaller, totalPlanta}], ... } }
function leerTangoMO() {
  try {
    const folder  = DriveApp.getFolderById(FILE_IDS.tangoFolder);
    const files   = folder.getFiles();
    const resultado = {};
    const resultadoQuincenas = {};

    while (files.hasNext()) {
      const file    = files.next();
      const nombre  = file.getName().toUpperCase();

      // Detectar mes desde el nombre del archivo
      // Soporta "MM-YYYY" con o sin espacios (ej: "01-2026", "05 - 2026") y texto (ENE..DIC)
      // El patrón "MM - YYYY" puede venir con prefijo ("Copia de 09 - 2026
      // QUINCENAS", sep-2026): se busca en cualquier parte del nombre, no solo
      // al inicio. Si trae año y no es el año en curso, se omite.
      let mes = null;
      const MAP = { 1:'ene', 2:'feb', 3:'mar', 4:'abr', 5:'may', 6:'jun',
                    7:'jul', 8:'ago', 9:'sep', 10:'oct', 11:'nov', 12:'dic' };
      const mNum = nombre.match(/(?:^|[^\d])(\d{1,2})\s*-\s*(\d{4})(?!\d)/);
      if (mNum) {
        if (parseInt(mNum[2]) !== new Date().getFullYear()) {
          Logger.log('Tango — "' + file.getName() + '" es de otro año (' + mNum[2] + ') — omitido');
          continue;
        }
        mes = MAP[parseInt(mNum[1])] || null;
      } else if (nombre.includes('ENE'))  mes = 'ene';
      else if (nombre.includes('FEB'))    mes = 'feb';
      else if (nombre.includes('MARZO') || nombre.includes('MAR')) mes = 'mar';
      else if (nombre.includes('ABR'))    mes = 'abr';
      else if (nombre.includes('MAY'))    mes = 'may';
      else if (nombre.includes('JUN'))    mes = 'jun';
      else if (nombre.includes('JUL'))    mes = 'jul';
      else if (nombre.includes('AGO'))    mes = 'ago';
      else if (nombre.includes('SEP'))    mes = 'sep';
      else if (nombre.includes('OCT'))    mes = 'oct';
      else if (nombre.includes('NOV'))    mes = 'nov';
      else if (nombre.includes('DIC'))    mes = 'dic';

      if (!mes) {
        Logger.log('Tango — no se detectó mes en: ' + file.getName() + ' — omitido');
        continue;
      }

      // Si hay dos archivos para el mismo mes (ej. el original y una "Copia de"),
      // gana el que NO es copia; a igualdad, el modificado más recientemente.
      const esCopia = /^COPIA\s+DE/.test(nombre);
      const prev = resultado[mes] ? resultado[mes]._meta : null;
      if (prev && (prev.esCopia === esCopia ? prev.modif >= file.getLastUpdated().getTime() : !prev.esCopia)) {
        Logger.log('Tango — "' + file.getName() + '" duplica el mes ' + mes + ' (ya cargado "' + prev.nombre + '") — omitido');
        continue;
      }

      Logger.log('Tango — procesando "' + file.getName() + '" → ' + mes);
      const data = parsearArchivoTangoMO(file);
      if (data && data.rows && data.rows.length > 0) {
        resultado[mes] = data.rows;
        Object.defineProperty(resultado[mes], '_meta', { value: { nombre: file.getName(), esCopia: esCopia, modif: file.getLastUpdated().getTime() }, enumerable: false });
        resultadoQuincenas[mes] = data.quincenas || [];
      }
    }

    Logger.log('Tango MO — meses cargados: ' + Object.keys(resultado).join(', '));
    return { porCentro: resultado, quincenas: resultadoQuincenas };

  } catch (err) {
    Logger.log('leerTangoMO error: ' + err.toString());
    return { porCentro: null, quincenas: null };
  }
}

// Parsea un archivo de TANGO (Google Sheet o CSV) y devuelve { rows: [{centro, monto, clasificacion}], quincenas: [...] }
// Si es Google Sheet: cada pestaña es una quincena; se suman para el total del mes
// y también se exponen por separado en `quincenas` para el detalle del cálculo.
function parsearArchivoTangoMO(file) {
  try {
    const mime = file.getMimeType();
    if (mime === 'application/vnd.google-apps.spreadsheet') {
      return parsearGSheetTangoMO(file);
    }
    // Fallback CSV/TXT — no tiene noción de quincenas separadas
    return { rows: parsearCsvTangoMO(file) || [], quincenas: [] };
  } catch (err) {
    Logger.log('parsearArchivoTangoMO error (' + file.getName() + '): ' + err.toString());
    return null;
  }
}

// Lee un Google Sheet con N pestañas (quincenas) y acumula los totales por obra
// Soporta dos formatos de TANGO:
//   Formato A: columnas OBRA + TOTAL QUINCENA C/REDONDEO PARA PAGO EN EFECTIVO
//   Formato B: columnas CTRO COSTO + NETO (resumen por centro de costo)
// Col S "Clasificación" quedó DEPRECADA (sep-2026): cuando la quincena trae la
// col R nueva (nombres del Maestro), la clasificación se deriva del nombre.
// Estas categorías internas NO van a la parte de obras.
// Acepta las variantes de nombre de la col E vieja ("Pta. Asfalto",
// "Trituradora", "Predio Warner"…) porque cuando Mauro no completa la col R
// se cae a esa columna (sep-2026). La trituradora va a Planta (María, oct-2026).
function clasificarMOPorNombre(nombre) {
  const n = String(nombre || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  if (/taller/.test(n)) return 'Taller';
  if (/(planta|pta\.?)\s*(de\s*)?asfalt/.test(n) || /tritura/.test(n)) return 'Pta. Asfalto';
  if (/predio|cantera|administraci/.test(n)) return 'Interno';
  return 'Obra';
}

function parsearGSheetTangoMO(file) {
  const ss     = SpreadsheetApp.openById(file.getId());
  const sheets = ss.getSheets();
  const totales = {}; // key = "centro||clasificacion" — acumulado de TODAS las quincenas
  const quincenas = []; // [{nombre, total, totalObra, totalTaller, totalPlanta}] — una por pestaña

  for (const sheet of sheets) {
    const rows = sheet.getDataRange().getValues();

    let hdrIdx = -1, iClave = -1, iMonto = -1, iClasif = -1, modo = null, iClaveFallback = -1;

    for (let i = 0; i < Math.min(25, rows.length); i++) {
      const cells = rows[i].map(c => String(c).toUpperCase().trim());

      // Formato A: OBRA + TOTAL QUINCENA (planilla por empleado con obra asignada).
      // Hay DOS columnas candidatas: "TOTAL QUINCENA" y "TOTAL QUINCENA C/REDONDEO
      // PARA PAGO EN EFECTIVO". Cuál de las dos trae el monto real varía según la
      // quincena (en una puede venir vacía "TOTAL QUINCENA" y el dato estar solo en
      // la de redondeo, o viceversa) — por eso NO alcanza con quedarse con la
      // primera que matchee ambas palabras. Se prioriza la de "REDONDEO" (es el
      // total final de pago) y se cae a la plana solo si no existe esa columna.
      // Desde jul-2026 hay DOS columnas "OBRA": la vieja de texto libre (col E)
      // y la nueva con nombres del Maestro de obras (col R, junto a
      // "Clasificación"). Se prioriza la ÚLTIMA (la del Maestro) y se cae a la
      // vieja fila a fila si la nueva viene vacía. En archivos viejos con una
      // sola columna, ambas apuntan al mismo índice.
      const iObra          = cells.lastIndexOf('OBRA');
      const iObraVieja     = cells.indexOf('OBRA');
      const iTotalRedondeo = cells.findIndex(c => c.includes('TOTAL') && c.includes('QUINCENA') && c.includes('REDONDEO'));
      const iTotalPlano    = cells.findIndex(c => c.includes('TOTAL') && c.includes('QUINCENA') && !c.includes('REDONDEO'));
      const iTotalQ = iTotalRedondeo >= 0 ? iTotalRedondeo : iTotalPlano;
      if (iObra >= 0 && iTotalQ >= 0) {
        hdrIdx = i; iClave = iObra; iMonto = iTotalQ; modo = 'obra';
        iClaveFallback = iObraVieja !== iObra ? iObraVieja : -1;
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

    // Totales de ESTA pestaña (quincena), por clasificación — para el detalle del cálculo
    let qTotal = 0, qObra = 0, qTaller = 0, qPlanta = 0;

    // Valores de error de fórmula (#N/A, #REF!, …): no son un centro de costo,
    // se ignoran y se cae a la columna vieja (María, sep-2026)
    const _esError = v => String(v || '').trim().charAt(0) === '#'; // #N/A, #REF!, #¡VALOR!, …
    for (let i = hdrIdx + 1; i < rows.length; i++) {
      const row   = rows[i];
      let clave = String(row[iClave] || '').trim();
      if (_esError(clave)) clave = '';
      if (!clave && iClaveFallback >= 0) {
        const alt = String(row[iClaveFallback] || '').trim();
        clave = _esError(alt) ? '' : alt;
      }
      if (!clave || clave.toUpperCase().includes('TOTAL') || clave === '') continue;

      const raw   = row[iMonto];
      const monto = typeof raw === 'number' ? raw : parsearMonto(String(raw || ''));
      if (!monto || monto <= 0) continue;

      const key    = modo === 'ctro' ? mapearCentro(clave) : clave;
      // Con la col R nueva (dos columnas OBRA) la clasificación sale del nombre
      // del Maestro — EXCEPTO los "Maquinista" de la col S: son los operadores
      // de equipos del Taller, van a MO Taller aunque la col R tenga una obra.
      // En archivos viejos (una sola col OBRA) se sigue usando la col S.
      let clasif;
      if (modo === 'obra' && iClaveFallback >= 0) {
        const colS = iClasif >= 0 ? String(row[iClasif] || '').trim() : '';
        // Lo que está imputado a la Planta (asfalto o trituradora) es costo de
        // Planta aunque sea un maquinista; el resto de los maquinistas sigue
        // siendo costo del Taller (operan equipos del Taller en las obras).
        const porNombre = clasificarMOPorNombre(clave);
        clasif = porNombre === 'Pta. Asfalto' ? porNombre : (/maquinista/i.test(colS) ? 'Maquinista' : porNombre);
      } else {
        clasif = iClasif >= 0 ? String(row[iClasif] || '').trim() || 'Obra' : 'Obra';
      }
      const totKey = key + '||' + clasif;
      totales[totKey] = (totales[totKey] || 0) + monto;

      qTotal += monto;
      if (clasif === 'Taller' || clasif === 'Maquinista') qTaller += monto;
      else if (clasif === 'Pta. Asfalto') qPlanta += monto;
      else if (clasif === 'Interno') { /* Predio/Trituración/Cantera/Admin — no es MO de obras */ }
      else qObra += monto;
    }

    if (qTotal > 0) {
      quincenas.push({
        nombre:      sheet.getName().trim(),
        total:       Math.round(qTotal),
        totalObra:   Math.round(qObra),
        totalTaller: Math.round(qTaller),
        totalPlanta: Math.round(qPlanta),
      });
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
    result.reduce((s, r) => s + r.monto, 0) + ' | quincenas: ' + quincenas.map(q => q.nombre + '=' + q.total).join(', '));
  return { rows: result, quincenas: quincenas };
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
    // Hoja "ÓRDENES": el nombre puede venir con la Ó en distinta forma Unicode
    // (getSheetByName('ÓRDENES') fallaba y caía a la última pestaña, que hoy es
    // "Maestro de obras" → resultado vacío, sep-2026). Se compara sin acentos y,
    // si aun así no aparece, se toma la pestaña cuyo encabezado tiene PROVEEDOR y MONTO.
    const _sinAcentos = t => String(t || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase().trim();
    const hojas = ss.getSheets();
    let sheet = hojas.find(sh => _sinAcentos(sh.getName()) === 'ORDENES')
             || hojas.find(sh => /ORDENES/.test(_sinAcentos(sh.getName())));
    if (!sheet) {
      sheet = hojas.find(sh => {
        const h = sh.getRange(1, 1, Math.min(5, sh.getLastRow() || 1), sh.getLastColumn() || 1).getValues()
          .map(r => r.map(c => _sinAcentos(c)).join('|')).join('||');
        return h.indexOf('PROVEEDOR') >= 0 && h.indexOf('MONTO') >= 0;
      }) || hojas[0];
    }
    Logger.log('OC Insumos — hoja usada: ' + sheet.getName());
    const rows  = sheet.getDataRange().getValues();

    if (rows.length < 2) return null;

    // Maestro de obras → set de obras INTERNAS (CLIENTE == "INT" en col D).
    // Abre el archivo separado del maestro directamente por su ID.
    const intSet = {};
    try {
      const ssMaestro = SpreadsheetApp.openById(FILE_IDS.maestroObras);
      // La primera pestaña tiene la tabla con CODIGO|NOMBRE DE OBRA|N° DE OBRA|CLIENTE|...
      let sheetMaestro = null;
      ssMaestro.getSheets().forEach(sh => {
        if (!sheetMaestro) {
          const n = sh.getName().toLowerCase();
          if (n.includes('maestro') || n.includes('obra')) sheetMaestro = sh;
        }
      });
      if (!sheetMaestro) sheetMaestro = ssMaestro.getSheets()[0];
      const mrows = sheetMaestro.getDataRange().getValues();
      let mh = 0;
      for (let i = 0; i < Math.min(5, mrows.length); i++) {
        const s = mrows[i].map(c => String(c).toLowerCase()).join('|');
        if (s.includes('nombre de obra') || s.includes('cliente')) { mh = i; break; }
      }
      const mheaders = mrows[mh].map(h => String(h).toLowerCase().trim());
      const cNom = _findCol(mheaders, ['nombre de obra', 'nombre']) ?? 1;
      const cCli = _findCol(mheaders, ['cliente']) ?? 3;
      for (let i = mh + 1; i < mrows.length; i++) {
        const nom = String(mrows[i][cNom] || '').trim();
        const cli = String(mrows[i][cCli] || '').trim().toUpperCase();
        if (nom && cli === 'INT') intSet[nom.toLowerCase()] = true;
      }
      Logger.log('OC Insumos — obras INT desde maestro: ' + JSON.stringify(Object.keys(intSet)));
    } catch (e) {
      Logger.log('OC Insumos — error leyendo maestro: ' + e);
    }

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

    // Estructura nueva (Guillermo):
    //  A Nº ORDEN · B PROVEEDOR · C FECHA · D DESCRIPCIÓN · E MONTO · F OBRA · G ESTADO · H CÓDIGO OBRA
    const COL_FECHA  = _findCol(headers, ['fecha']) ?? 2;
    const COL_MONTO  = _findCol(headers, ['monto', 'importe', 'total']) ?? 4;
    const COL_PROV   = _findCol(headers, ['proveedor', 'prov']) ?? 1;
    const COL_COD    = _findCol(headers, ['código obra', 'codigo obra', 'cod obra', 'cod_obra']) ?? 7;
    const COL_OBRA   = _findCol(headers, ['obra general', 'obra']) ?? 5;
    const COL_ESTADO = _findCol(headers, ['estado', 'status']) ?? 6;
    const COL_DESC   = _findCol(headers, ['descripción', 'descripcion', 'detalle']) ?? 3;
    const COL_ORDEN  = _findCol(headers, ['n° orden', 'nº orden', 'n orden', 'orden']) ?? 0;
    const COL_PART   = _findCol(headers, ['obra particular 1', 'obra particular']);
    const gidOC = sheet.getSheetId();

    Logger.log('OC Insumos — cols: fecha=' + COL_FECHA + ' monto=' + COL_MONTO + ' obra=' + COL_OBRA + ' cod=' + COL_COD + ' prov=' + COL_PROV + ' estado=' + COL_ESTADO);

    const acum = {};

    for (let i = hdrIdx + 1; i < rows.length; i++) {
      const row = rows[i];

      const mes = parsearMes(row[COL_FECHA]);
      if (!mes) continue;

      const monto = parsearMonto(row[COL_MONTO]);
      if (!monto || monto <= 0) continue;

      const obraNom = String(row[COL_OBRA] || '').trim();
      const codigo  = String(COL_COD !== null ? row[COL_COD] || '' : '').trim();
      const obra    = obraNom || codigo || 'Sin clasificar';
      // Clave de agrupación: código de obra (col H), si no el nombre
      const key     = codigo || obraNom || 'Sin clasificar';

      const proveedorRaw = String(row[COL_PROV] || '').trim();
      const proveedor = proveedorRaw || 'Sin especificar';

      const estadoRaw  = String(row[COL_ESTADO] || '').trim();
      const esAceptada = estadoRaw.toLowerCase().includes('acept');
      const esPendiente = estadoRaw.toLowerCase().includes('pend');

      if (!acum[mes]) acum[mes] = { items: {}, total: 0, nOC: 0, moh: {}, mohTotal: 0, mohN: 0, sinObra: [] };

      // OC sin obra asignada (OBRA GENERAL vacía o "Obra no disponible"): se
      // guardan una por una con su fila para que desde el tablero se pueda ir
      // directo a corregirlas en la planilla (María, sep-2026).
      if (!obraNom || /^obra no disponible$/i.test(obraNom)) {
        let fechaStr = '';
        const fr = row[COL_FECHA];
        if (fr instanceof Date && !isNaN(fr.getTime())) fechaStr = Utilities.formatDate(fr, 'America/Argentina/Buenos_Aires', 'dd/MM');
        else { const mF = String(fr || '').match(/^(\d{1,2})\/(\d{1,2})/); if (mF) fechaStr = ('0' + mF[1]).slice(-2) + '/' + ('0' + mF[2]).slice(-2); }
        if (acum[mes].sinObra.length < 300) acum[mes].sinObra.push({
          fila: i + 1, gid: gidOC,
          orden: String(row[COL_ORDEN] || '').trim(),
          fecha: fechaStr,
          proveedor: proveedor,
          desc: String(row[COL_DESC] || '').trim().slice(0, 80),
          particular: COL_PART != null ? String(row[COL_PART] || '').trim() : '',
          obra: obraNom || '',
          monto: Math.round(monto),
        });
      }

      // MO de hormigón tercerizada: Guillermo la marca en DESCRIPCIÓN como
      // "Mano de obra" (o similar). No es un insumo — se acumula aparte para
      // mostrarla como columna propia en contribución marginal.
      const descRaw = String(row[COL_DESC] || '').trim();
      if (/mano\s*de\s*obra/i.test(descRaw)) {
        if (!acum[mes].moh[key]) acum[mes].moh[key] = { obra: obra, codigo: codigo, monto: 0, nOC: 0, proveedores: {} };
        const m = acum[mes].moh[key];
        if (!m.proveedores[proveedor]) m.proveedores[proveedor] = { monto: 0, nOC: 0 };
        m.proveedores[proveedor].monto += monto;
        m.proveedores[proveedor].nOC  += 1;
        m.monto += monto;
        m.nOC   += 1;
        acum[mes].mohTotal += monto;
        acum[mes].mohN     += 1;
        continue; // no sumar como insumo
      }
      if (!acum[mes].items[key]) acum[mes].items[key] = { obra: obra, codigo: codigo, monto: 0, nOC: 0, aceptadas: 0, pendientes: 0, proveedores: {} };
      if (!acum[mes].items[key].proveedores[proveedor]) acum[mes].items[key].proveedores[proveedor] = { monto: 0, nOC: 0, aceptadas: 0, pendientes: 0 };
      acum[mes].items[key].proveedores[proveedor].monto += monto;
      acum[mes].items[key].proveedores[proveedor].nOC  += 1;
      if (esAceptada)  { acum[mes].items[key].proveedores[proveedor].aceptadas += 1; acum[mes].items[key].aceptadas += 1; }
      if (esPendiente) { acum[mes].items[key].proveedores[proveedor].pendientes += 1; acum[mes].items[key].pendientes += 1; }
      acum[mes].items[key].monto += monto;
      acum[mes].items[key].nOC  += 1;
      acum[mes].total += monto;
      acum[mes].nOC   += 1;
    }

    // Convertir a formato del dashboard
    const resultado = {};
    for (const [mes, data] of Object.entries(acum)) {
      if (data.nOC === 0 && data.mohN === 0) continue;
      resultado[mes] = {
        total: Math.round(data.total),
        nOC:   data.nOC,
        sinObra: { n: (data.sinObra || []).length, total: (data.sinObra || []).reduce((s2, x) => s2 + x.monto, 0), items: (data.sinObra || []).sort((a, b) => b.monto - a.monto) },
        items: Object.entries(data.items)
          .map(([key, v]) => ({
            obra: v.obra,
            codigo: v.codigo || '',
            monto: Math.round(v.monto),
            nOC: v.nOC,
            // Interno si la OBRA GENERAL figura como CLIENTE=INT en el maestro
            esInt: !!intSet[(v.codigo || key).toLowerCase()],
            aceptadas: v.aceptadas,
            pendientes: v.pendientes,
            proveedores: Object.entries(v.proveedores)
              .map(([proveedor, pv]) => ({ proveedor, monto: Math.round(pv.monto), nOC: pv.nOC, aceptadas: pv.aceptadas, pendientes: pv.pendientes }))
              .sort((a, b) => b.monto - a.monto)
          }))
          .sort((a, b) => b.monto - a.monto)
      };
      // MO de hormigón tercerizada del mes (aparte de los insumos)
      resultado[mes].moHormigon = {
        total: Math.round(data.mohTotal),
        nOC:   data.mohN,
        items: Object.entries(data.moh)
          .map(([key, v]) => ({
            obra: v.obra,
            codigo: v.codigo || '',
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

// Normaliza un nombre de obra para hacer matching robusto entre planillas:
// minúsculas, sin acentos, espacios colapsados.
function _normObra(s) {
  return String(s || '')
    .trim()
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '') // saca acentos
    .replace(/\s+/g, ' ');
}

function parsearMes(fechaRaw) {
  if (!fechaRaw) return null;
  let mes = null;
  // El tablero es de UN año: una fecha de otro año no pertenece a ningún mes
  // (antes se tomaba solo el mes y una fila de 2025 caía en el mes de 2026).
  const anioTablero = new Date().getFullYear();

  if (fechaRaw instanceof Date) {
    if (isNaN(fechaRaw.getTime())) return null;
    // Apps Script guarda fechas como medianoche UTC → usar getUTCMonth() para evitar desfase con UTC-3
    if (fechaRaw.getUTCFullYear() !== anioTablero) return null;
    mes = fechaRaw.getUTCMonth() + 1;
  } else {
    const s = String(fechaRaw).trim();
    // Formato D/M/YYYY o DD/MM/YYYY (común en Argentina)
    const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if (m) {
      if (parseInt(m[3]) !== anioTablero) return null;
      mes = parseInt(m[2]);
    }
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
    if (raw.getUTCFullYear() !== curYear) return null;
    return MAP[raw.getUTCMonth()];
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

    // Encontrar fila de encabezados (contiene COD_OBRA, o CODIGO + NOMBRE)
    let hdrIdx = 0;
    for (let i = 0; i < Math.min(5, rows.length); i++) {
      const rowStr = rows[i].map(c => String(c).toUpperCase()).join('|');
      if (rowStr.includes('COD_OBRA') || rowStr.includes('COD OBRA') ||
          (rowStr.includes('CODIGO') && rowStr.includes('NOMBRE'))) { hdrIdx = i; break; }
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

      // Estado vacío = activa (la columna existe pero no siempre se completa)
      if (!nombre || (estado && estado !== 'Activa')) continue;

      const info = {
        nombre:  nombre,
        cliente: iCliente !== null ? String(row[iCliente] || '').trim() : '',
        fuente:  iFuente  !== null ? String(row[iFuente]  || '').trim() : '',
        tipo:    iTipo    !== null ? String(row[iTipo]    || '').trim() : '',
      };
      // Indexar por código real (si hay) y por nombre en minúsculas — Fernando
      // usa el nombre de obra (col B del maestro) como código en sus pestañas.
      if (cod && cod !== '-') {
        obras[cod] = info;
        obras[cod.toLowerCase()] = info;
      }
      obras[nombre.toLowerCase()] = info;
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
    // VIALIDAD1:          MontoTotal=H(7), Monto=I(8), Período=U(20), Estado=F(5) (A Cobrar/Cobrado/A Emitir), sin filtro
    // OTROS INGRESOS:     Monto=F(5), Código=P(15), Período de realización=Q(16), sin filtro de estado
    // iMontoFallback: si Monto=0, usar esta columna (Monto Total = valor del contrato)
    const TAB_CONFIG = {
      'OBRAS DE MUNICIPIO': { iMonto: 6,  iMontoFallback: 5,    iPeriodo: 17, iEstado: 4,    estadoFiltro: ['a cobrar', 'cobrada'], iCod: null, iNom: null },
      'VIALIDAD1':          { iMonto: 8,  iMontoFallback: 7,    iPeriodo: 20, iEstado: 5,    estadoFiltro: null,       iCod: 19,   iNom: 0 },
      'OTROS INGRESOS':     { iMonto: 5,  iMontoFallback: null, iPeriodo: 16, iEstado: null,  estadoFiltro: null,       iCod: 15,   iNom: 0 },
    };

    const aCobrarPorCodigo  = {};
    const aCobrarPorMes     = {}; // { mesKey: { cod: monto } }
    const aCobrarSinMes     = {}; // cod: monto — sin período válido en año actual
    const nombrePorCodigo   = {};
    const detallesPorCodigo = {}; // cod: [items] — todos los renglones del código
    const detallesPorMes    = {}; // { mesKey: { cod: [items] } } — renglones con ese período
    const detallesSinMes    = {}; // cod: [items] — renglones sin período válido
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

        // Monto: SOLO la columna "Monto" (G para Municipio) — el certificado a cobrar.
        // No se usa el Monto Total (col F) como fallback: si G está vacío/0, suma 0.
        let monto = parsearMonto(row[cfg.iMonto]);
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

        // Estado del certificado (col E "Estado$" en Municipio): "A Cobrar" / "Cobrada"
        const estado = cfg.iEstado !== null ? String(row[cfg.iEstado] || '').trim() : '';

        // Período → clave de mes
        const mesKey = _parseMesKey(row[cfg.iPeriodo], curYear);
        // fila/gid: para armar el deep-link a la celda exacta del Sheet desde el tablero
        const item = { nombre: nombre || cod, codigo: cod, monto: Math.round(monto), estado: estado,
                       fila: i + 1, gid: sheet.getSheetId() };

        if (mesKey) {
          if (!aCobrarPorMes[mesKey]) aCobrarPorMes[mesKey] = {};
          aCobrarPorMes[mesKey][cod] = (aCobrarPorMes[mesKey][cod] || 0) + monto;
          if (!detallesPorMes[mesKey]) detallesPorMes[mesKey] = {};
          if (!detallesPorMes[mesKey][cod]) detallesPorMes[mesKey][cod] = [];
          detallesPorMes[mesKey][cod].push(item);
        } else {
          aCobrarSinMes[cod] = (aCobrarSinMes[cod] || 0) + monto;
          if (!detallesSinMes[cod]) detallesSinMes[cod] = [];
          detallesSinMes[cod].push(item);
        }
        aCobrarPorCodigo[cod] = (aCobrarPorCodigo[cod] || 0) + monto;

        if (!nombrePorCodigo[cod] && nombre) nombrePorCodigo[cod] = nombre;
        if (!tabSrcPorCodigo[cod]) {
          tabSrcPorCodigo[cod] = esMunicipio ? 'MUNICIPIO'
            : tabName.includes('VIALIDAD') ? 'VIALIDAD1' : 'OTROS INGRESOS';
        }
        if (!detallesPorCodigo[cod]) detallesPorCodigo[cod] = [];
        detallesPorCodigo[cod].push(item);
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
      detallesPorMes: detallesPorMes,
      detallesSinMes: detallesSinMes,
      tabSrc:         tabSrcPorCodigo,
      tabsSinPeriodo: [],
    };

  } catch (err) {
    Logger.log('leerGeneradoFernando error: ' + err.toString());
    return { generado: {}, tabsSinPeriodo: [] };
  }
}

// ============================================================
// OBRAS A COBRAR (AGUSTÍN) — reemplaza al archivo de Julia como fuente de
// certificación. Una fila por concepto: Nombre | Estado $ | Monto Total |
// Anticipo financiero | Monto a certificar | ... | Código | Período.
// Devuelve la MISMA forma intermedia que leerGeneradoFernando() para que
// leerGeneradoPorObra() y todo el frontend sigan funcionando sin cambios.
// ============================================================
function leerAgustinIntermedio() {
  const vacio = { aCobrar: {}, aCobrarPorMes: {}, aCobrarSinMes: {}, nombreFernando: {},
                  detalles: {}, detallesPorMes: {}, detallesSinMes: {}, tabSrc: {}, tabsSinPeriodo: [] };
  try {
    const ss = SpreadsheetApp.openById(FILE_IDS.agustinObras);
    const sheet = ss.getSheets()[0];
    const gid = sheet.getSheetId();
    const rows = sheet.getDataRange().getValues();
    const curYear = new Date().getFullYear();

    let hdrIdx = 0;
    for (let i = 0; i < Math.min(6, rows.length); i++) {
      const s = rows[i].map(c => String(c).toLowerCase()).join('|');
      if (s.includes('monto a certificar') || s.includes('nombre obra')) { hdrIdx = i; break; }
    }
    const headers = rows[hdrIdx].map(h => String(h).toLowerCase().trim());
    const iNom  = _findCol(headers, ['nombre obra', 'nombre']) ?? 0;
    const iEst  = _findCol(headers, ['estado $', 'estado$']) ?? 1;
    const iTot  = _findCol(headers, ['monto total']) ?? 2;
    const iAnt  = _findCol(headers, ['anticipo']) ?? 3;
    const iCert = _findCol(headers, ['monto a certificar', 'certificar']) ?? 4;
    const iCod  = _findCol(headers, ['código', 'codigo']) ?? 8;
    const iPer  = _findCol(headers, ['período de realización', 'periodo de realizacion', 'período', 'periodo']) ?? 9;
    Logger.log('Agustín — cols: nom=' + iNom + ' est=' + iEst + ' cert=' + iCert + ' cod=' + iCod + ' per=' + iPer);

    const out = { aCobrar: {}, aCobrarPorMes: {}, aCobrarSinMes: {}, nombreFernando: {},
                  detalles: {}, detallesPorMes: {}, detallesSinMes: {}, tabSrc: {}, tabsSinPeriodo: [] };

    for (let i = hdrIdx + 1; i < rows.length; i++) {
      const row = rows[i];
      const nombre = String(row[iNom] || '').trim();
      if (!nombre) continue;
      const nlow = nombre.toLowerCase();
      // Filas de resumen al pie de la hoja
      if (nlow.indexOf('total') === 0 || nlow.indexOf('sin expediente') === 0 || nlow.indexOf('con expediente') === 0) continue;

      const estadoRaw  = String(row[iEst] || '').trim();
      const montoTotal = parsearMonto(row[iTot]);
      const anticipo   = parsearMonto(row[iAnt]);
      const aCert      = parsearMonto(row[iCert]);
      const esCobrada  = /cobrad/i.test(estadoRaw);

      // Monto del ítem: lo que falta certificar. Si está Cobrada y no queda
      // saldo, lo cobrado (anticipo o total) para el desglose de Cobradas.
      // EXCEPCIÓN — fila MADRE (sep-2026): sin Monto a certificar y SIN
      // Período es la fila-resumen del contrato (solo documenta el Monto
      // Total); no suma nunca, diga lo que diga el Estado. Así Agustín puede
      // marcarla "Cobrada" cuando la etapa cerró sin duplicar los montos.
      const perVacio = row[iPer] == null || String(row[iPer]).trim() === '' || String(row[iPer]).trim() === '-';
      const esMadre = aCert <= 0 && perVacio;
      let monto = aCert > 0 ? aCert : 0;
      if (esCobrada && monto <= 0 && !esMadre) monto = anticipo > 0 ? anticipo : (montoTotal > 0 ? montoTotal : 0);
      // Estado normalizado: Cobrada / A Cobrar (cualquier otro texto con saldo
      // pendiente cuenta como A Cobrar, ej. "Total")
      const estado = esCobrada ? 'Cobrada' : (monto > 0 ? 'A Cobrar' : (estadoRaw || ''));

      const cod = String(row[iCod] || '').trim() || 'SIN-CODIGO';
      const mesKey = _parseMesKey(row[iPer], curYear);
      const item = { nombre: nombre, codigo: cod, monto: Math.round(monto), estado: estado,
                     montoTotal: Math.round(montoTotal || 0), anticipo: Math.round(anticipo || 0),
                     fila: i + 1, gid: gid };

      if (mesKey) {
        if (!out.aCobrarPorMes[mesKey]) out.aCobrarPorMes[mesKey] = {};
        out.aCobrarPorMes[mesKey][cod] = (out.aCobrarPorMes[mesKey][cod] || 0) + item.monto;
        if (!out.detallesPorMes[mesKey]) out.detallesPorMes[mesKey] = {};
        if (!out.detallesPorMes[mesKey][cod]) out.detallesPorMes[mesKey][cod] = [];
        out.detallesPorMes[mesKey][cod].push(item);
      } else {
        out.aCobrarSinMes[cod] = (out.aCobrarSinMes[cod] || 0) + item.monto;
        if (!out.detallesSinMes[cod]) out.detallesSinMes[cod] = [];
        out.detallesSinMes[cod].push(item);
      }
      out.aCobrar[cod] = (out.aCobrar[cod] || 0) + item.monto;
      if (!out.nombreFernando[cod]) out.nombreFernando[cod] = cod === 'SIN-CODIGO' ? nombre : cod;
      if (!out.detalles[cod]) out.detalles[cod] = [];
      out.detalles[cod].push(item);
    }

    Logger.log('Agustín — códigos: ' + Object.keys(out.aCobrar).length +
               ' | por mes: ' + Object.keys(out.aCobrarPorMes).join(','));
    return out;
  } catch (err) {
    Logger.log('leerAgustinIntermedio error: ' + err.toString());
    return vacio;
  }
}

// ============================================================
// COMBINAR MAESTRO + AGUSTÍN → GENERADO TEÓRICO POR OBRA
// (antes usaba leerGeneradoFernando — archivo de Julia, hoy legacy)
// ============================================================
function leerGeneradoPorObra() {
  try {
    const maestro = leerMaestroObras();
    const { aCobrar, aCobrarPorMes, aCobrarSinMes, nombreFernando, detalles, detallesPorMes, detallesSinMes, tabSrc, tabsSinPeriodo } = leerAgustinIntermedio();

    // Helper: construye lista de obras desde un mapa { cod: monto }.
    // detMap = mapa de detalles a usar (todos, los del mes, o los sin período).
    function _buildObras(montoPorCod, detMap) {
      var list = [];
      for (var cod in montoPorCod) {
        if (cod === 'SIN-CODIGO') continue;
        var montoRed = Math.round(montoPorCod[cod]);
        if (montoRed < 0) continue;
        var info = maestro[cod] || maestro[String(cod).toLowerCase().trim()];
        if (info && info.fuente === 'INTERNO') continue;
        list.push({
          cod_obra: cod,
          nombre:   info ? info.nombre : (nombreFernando[cod] || cod),
          cliente:  info ? info.cliente : '—',
          tipo:     info ? info.tipo    : '—',
          aCobrar:  montoRed,
          items:    (detMap && detMap[cod]) || [],
          tabSrc:   tabSrc ? (tabSrc[cod] || null) : null,
        });
      }
      list.sort(function(a, b) { return b.aCobrar - a.aCobrar; });
      return list;
    }

    // Lista plana (sin filtro de mes) — compatibilidad con caché viejo
    const obras = _buildObras(aCobrar, detalles);

    // Filas sin código al final
    const montoSinCod = Math.round(aCobrar['SIN-CODIGO'] || 0);
    if (montoSinCod > 0) {
      obras.push({ cod_obra: '—', nombre: 'Obra sin asignación de código',
                   cliente: '—', tipo: '—', aCobrar: montoSinCod });
    }

    // Obras sin período de realización — van a una categoría separada en el dashboard
    const obrasSinPeriodo = _buildObras(aCobrarSinMes, detallesSinMes);
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
      var list = _buildObras(mesPeriodo, detallesPorMes[mes]);
      // SIN-CODIGO del mes
      var sinCodMes = Math.round(mesPeriodo['SIN-CODIGO'] || 0);
      if (sinCodMes > 0) {
        list.push({ cod_obra: '—', nombre: 'Obra sin asignación de código',
                    cliente: '—', tipo: '—', aCobrar: sinCodMes });
      }
      if (list.length > 0) obrasPorMes[mes] = list;
    }

    // Mapa clave (minúsculas) → TIPO_CONTRATO del maestro. Lo usa el dashboard
    // para clasificar obras que no vienen de Fernando (OC/remitos/alquiler).
    const tipos = {};
    Object.keys(maestro).forEach(function(k) {
      if (maestro[k] && maestro[k].tipo) tipos[k.toLowerCase()] = maestro[k].tipo;
    });

    Logger.log('obrasPorMes — meses: ' + Object.keys(obrasPorMes).join(',') +
               ' | sinPeriodo: ' + obrasSinPeriodo.length);
    return { obras: obras, obrasPorMes: obrasPorMes, obrasSinPeriodo: obrasSinPeriodo, tabsSinPeriodo: tabsSinPeriodo, tipos: tipos };

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

// TC USD oficial promedio del mes (compra/venta) desde api.argentinadatos.com.
// La API anterior (estadisticasbcra.site) dejó de responder y todo caía en el
// respaldo fijo de 1.400 — julio a septiembre 2026 se valuaron mal (María).
function fetchTCMensual(mesKey) {
  const MAP = ['ene','feb','mar','abr','may','jun','jul','ago','sep','oct','nov','dic'];
  const idx = MAP.indexOf(mesKey);
  if (idx < 0) return TC_USD_MENSUAL[mesKey] || 1400;
  // Serie diaria del dólar oficial (misma fuente que usa el tablero para el
  // precio del asfalto). Se baja una vez por ejecución y se promedia por mes.
  if (!fetchTCMensual._prom) {
    fetchTCMensual._prom = {};
    try {
      const resp = UrlFetchApp.fetch('https://api.argentinadatos.com/v1/cotizaciones/dolares/oficial', { muteHttpExceptions: true });
      if (resp.getResponseCode() === 200) {
        const year = String(new Date().getFullYear());
        const acc = {};
        JSON.parse(resp.getContentText()).forEach(function(r) {
          if (!r || !r.fecha || String(r.fecha).indexOf(year) !== 0) return;
          const m = parseInt(String(r.fecha).slice(5, 7)); if (!(m >= 1 && m <= 12)) return;
          const v = ((+r.compra || 0) + (+r.venta || 0)) / 2; if (!(v > 0)) return;
          const k = MAP[m - 1]; (acc[k] = acc[k] || { s: 0, n: 0 }); acc[k].s += v; acc[k].n++;
        });
        Object.keys(acc).forEach(function(k) { fetchTCMensual._prom[k] = Math.round(acc[k].s / acc[k].n * 100) / 100; });
        Logger.log('TC dólar oficial promedio por mes: ' + JSON.stringify(fetchTCMensual._prom));
      } else {
        Logger.log('TC API: error HTTP ' + resp.getResponseCode() + ' — usando respaldo');
      }
    } catch (e) {
      Logger.log('TC API error: ' + e + ' — usando respaldo');
    }
  }
  if (fetchTCMensual._prom[mesKey]) return fetchTCMensual._prom[mesKey];
  // Sin datos del mes (mes futuro o API caída): último mes anterior con dato,
  // después la tabla de respaldo, después 1400.
  for (var k = idx - 1; k >= 0; k--) if (fetchTCMensual._prom[MAP[k]]) return fetchTCMensual._prom[MAP[k]];
  return TC_USD_MENSUAL[mesKey] || 1400;
}

// "Alquiler de equipos" (col OBRA GENERAL de Partes diarios): el taller le
// alquila máquinas a OTRAS empresas — no es una obra de INGECO. Se usa para
// separar ese costo del prorrateo por obra (no es gasto de obra, es ingreso
// de taller, ver leerAlquilerEquipos).
function esAlquilerExterno(obra) {
  return String(obra || '').trim().toLowerCase() === 'alquiler de equipos';
}

// "Planta de Trituración", "Cantera", "Planta de Asfalto" (col OBRA GENERAL de
// Partes diarios): son centros internos de la Planta de Asfalto, no obras de
// INGECO. Su costo de alquiler de equipos es un costo de PLANTA, no de obra.
function _normSinTilde(s) {
  return String(s || '').trim().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
}
const CENTROS_PLANTA_ALQUILER = ['planta de trituracion', 'cantera', 'planta de asfalto'];
function esCentroPlanta(obra) {
  return CENTROS_PLANTA_ALQUILER.includes(_normSinTilde(obra));
}
// "Predio Warnes": depósito/predio de INGECO, tampoco es una obra. Su costo de
// alquiler de equipos es un gasto de Estructura, no de obra ni de Planta.
function esCentroPredio(obra) {
  return _normSinTilde(obra) === 'predio warnes';
}
// Cualquier bucket de "OBRA GENERAL" que NO es una obra real de INGECO
// (ni alquiler externo, ni centro interno de planta, ni Predio Warnes) — no
// debe imputarse como costo de obra en el prorrateo de alquiler.
function esAlquilerNoObra(obra) {
  return esAlquilerExterno(obra) || esCentroPlanta(obra) || esCentroPredio(obra);
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
    // Col A(0)=Fecha B(1)=Equipo C(2)=Código equipo F(5)=Obra Particular I(8)=Total horas P(15)=Obra General
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

    // Columnas por NOMBRE de encabezado (la planilla cambió de layout en sep-2026:
    // horas pasó de I a J "TIEMPO TRABAJO (HR)" y Obra General de P a R).
    // Las posiciones viejas quedan como fallback si no se reconoce el header.
    let COL_FECHA_PD    = 0;  // A: Fecha
    let COL_COD_EQ      = 2;  // C: Código de equipo
    let COL_OBRA_PART   = 5;  // F: Ubicación / Obra Particular (destino del alquiler a terceros)
    let COL_HORAS_PD    = 8;  // fallback layout viejo: I = Total de horas
    let COL_COD_OBRA_PD = 15; // fallback layout viejo: P = Obra General

    let hdrPD = 0;
    for (let i = 0; i < Math.min(5, rowsPD.length); i++) {
      const rowStr = rowsPD[i].map(c => String(c).toLowerCase()).join('|');
      if (rowStr.includes('fecha') || rowStr.includes('equipo') || rowStr.includes('hora')) {
        hdrPD = i;
        // Sin acentos ni variantes Unicode para comparar nombres
        const cells = rowsPD[i].map(c => String(c).toUpperCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim());
        const iFe = cells.findIndex(c => c === 'FECHA');
        const iCo = cells.findIndex(c => c === 'CODIGO' || c === 'COD. EQUIPO' || c === 'CODIGO EQUIPO');
        const iHs = cells.findIndex(c => /TIEMPO.*TRABAJO|HORAS TRABAJADAS|TOTAL.*HORAS?$/.test(c));
        const iOg = cells.findIndex(c => c === 'OBRA GENERAL');
        const iOp = cells.findIndex(c => c.indexOf('OBRA PARTICULAR') >= 0);
        if (iOp >= 0) COL_OBRA_PART   = iOp;
        if (iFe >= 0) COL_FECHA_PD    = iFe;
        if (iCo >= 0) COL_COD_EQ      = iCo;
        if (iHs >= 0) COL_HORAS_PD    = iHs;
        if (iOg >= 0) COL_COD_OBRA_PD = iOg;
        break;
      }
    }
    Logger.log('Partes diarios — hoja: ' + sheetPD.getName() + ' hdr=' + hdrPD + ' filas=' + rowsPD.length
      + ' cols: fecha=' + COL_FECHA_PD + ' cod=' + COL_COD_EQ + ' horas=' + COL_HORAS_PD + ' obra=' + COL_COD_OBRA_PD);

    // acum[mes][cod] = { _total: horas, [obra]: horas }
    const acum = {};

    for (let i = hdrPD + 1; i < rowsPD.length; i++) {
      const row = rowsPD[i];
      const mes = parsearMes(row[COL_FECHA_PD]);
      if (!mes) continue;

      const codEq = String(row[COL_COD_EQ] || '').trim();
      if (!codEq || !precios[codEq]) continue;

      // Agrupar SIEMPRE por OBRA GENERAL (col P). Es la columna canónica que
      // mantiene Nico; la col F ("Obra Particular", ej. "Ruinas de Quilmes —
      // Ruta 357") tiene nombres locales que crean obras fantasma en el tablero.
      // Si la fila no tiene OBRA GENERAL cargada, va a "Sin asignar" (no se
      // inventa el nombre desde la col F) — así se preservan horas y costo del
      // equipo sin distorsionar el prorrateo, y se ve el hueco de carga.
      const codObra = String(row[COL_COD_OBRA_PD] || '').trim();
      const obra    = (codObra && codObra !== '-') ? codObra : 'Sin asignar';

      const horas = typeof row[COL_HORAS_PD] === 'number' ? row[COL_HORAS_PD]
                  : parsearHoras(row[COL_HORAS_PD]);
      if (horas <= 0) continue;

      if (!acum[mes]) acum[mes] = {};
      if (!acum[mes][codEq]) acum[mes][codEq] = { _total: 0 };
      if (!acum[mes][codEq][obra]) acum[mes][codEq][obra] = 0;
      acum[mes][codEq][obra]  += horas;
      acum[mes][codEq]._total += horas;
      // Destino real del alquiler a terceros (col Ubicación/Obra Particular) —
      // alimenta la sección "Alquiler de equipos" del tablero
      if (esAlquilerExterno(obra)) {
        const destPart = String(row[COL_OBRA_PART] || '').trim() || 'Sin destino';
        if (!acum[mes][codEq]._dest) acum[mes][codEq]._dest = {};
        acum[mes][codEq]._dest[destPart] = Math.round(((acum[mes][codEq]._dest[destPart] || 0) + horas) * 10) / 10;
      }
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
          if (obra.charAt(0) === '_') continue; // _total, _dest
          const costoArs = Math.round((horas / totalHoras) * pfArs);
          if (!porObra[obra]) porObra[obra] = { costoArs: 0, horasTot: 0, equipos: [] };
          porObra[obra].costoArs += costoArs;
          porObra[obra].horasTot += horas;
          const eqEntry = {
            codigo:       cod,
            clasificacion: info.clasificacion,
            marca:        info.marca,
            modelo:       info.modelo,
            pfUsd:        info.pf_usd,
            horas:        Math.round(horas * 10) / 10,
            costoArs:     costoArs
          };
          // Alquiler a terceros: a qué obras/destinos fue el equipo (col F)
          if (esAlquilerExterno(obra) && datos._dest) eqEntry.destinos = datos._dest;
          porObra[obra].equipos.push(eqEntry);
          totalMes += costoArs;
        }
      }

      if (Object.keys(porObra).length === 0) continue;

      // "Alquiler de equipos" (taller alquilando a OTRAS empresas — ingreso de
      // taller), "Planta de Trituración"/"Cantera"/"Planta de Asfalto" (costos
      // internos de la Planta) y "Predio Warnes" (costo de Estructura) NO son
      // obras de INGECO — no deben imputarse como costo de obra en Margen
      // (por obra / por tipo de contratación).
      let costoExterno = 0, costoPlanta = 0, costoPredio = 0;
      Object.entries(porObra).forEach(([obra, v]) => {
        if (esAlquilerExterno(obra)) costoExterno += v.costoArs;
        else if (esCentroPlanta(obra)) costoPlanta += v.costoArs;
        else if (esCentroPredio(obra)) costoPredio += v.costoArs;
      });

      resultado[mes] = {
        totalArs:    totalMes,
        totalObras:  totalMes - costoExterno - costoPlanta - costoPredio,
        totalPlanta: costoPlanta,
        totalPredio: costoPredio,
        tcUsd:      tc,
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
// GASTOS DE ESTRUCTURA — libro mayor de gastos administrativos
// Fuente: Google Sheet (1beFIr...) — columnas:
//   Cuenta | Fecha | Modelo | Tipo comprobante | Numero Comprobante |
//   Proveedor | Razón social | Exportado | Debe | Haber | Categoria
// Solo se toma la porción ADMINISTRATIVA (cuentas "... - ADMIN: ..."):
// se excluye el combustible/distribución (cuenta 806 - DIST: COMBUST...).
// Agrupado por MES (de la Fecha) y por CUENTA contable.
// ============================================================
function leerGastosEstructura() {
  try {
    const ss = SpreadsheetApp.openById(FILE_IDS.gastosEstructura);
    const _num = function(v) {
      if (typeof v === 'number') return v;
      if (v == null || v === '') return 0;
      // Formato exportado US: coma=miles, punto=decimal → sacar comas
      const n = parseFloat(String(v).replace(/,/g, '').replace(/[^\d.\-]/g, ''));
      return isNaN(n) ? 0 : n;
    };

    // Separa "670 - ADMIN: GTOS LICIT. EN TRAMITE" → { codigo:'670', nombre:'Gtos Licit. En Tramite' }
    const _parseCuenta = function(raw) {
      const s = String(raw || '').trim();
      const mCod = s.match(/^(\d+)\s*-\s*/);
      const codigo = mCod ? mCod[1] : '';
      let nombre = s.replace(/^\d+\s*-\s*/, '');       // saca "670 - "
      nombre = nombre.replace(/^ADMIN\s*:\s*/i, '');    // saca "ADMIN: "
      return { codigo: codigo, nombre: nombre.trim() || s, full: s };
    };

    // acum[mes][cuentaFull] = { codigo, nombre, full, total, facturas: [...] }
    const acum = {};

    // Una pestaña por mes (Junio, Julio 26, AGOSTO 26…): se leen TODAS las que
    // tengan encabezado Cuenta/Debe. El mes sale de la Fecha de cada fila, no
    // del nombre de la pestaña (oct-2026: antes solo se leía la primera).
    ss.getSheets().forEach(function(sheet) {
    const rows = sheet.getDataRange().getValues();
    if (!rows || rows.length < 2) return;

    let hdr = -1;
    for (let i = 0; i < Math.min(5, rows.length); i++) {
      const cells = rows[i].map(c => String(c).toLowerCase().trim());
      if (cells.some(c => c === 'cuenta') && cells.some(c => c === 'debe')) { hdr = i; break; }
    }
    if (hdr < 0) { Logger.log('gastosEstructura [' + sheet.getName() + '] sin encabezado Cuenta/Debe, omitida'); return; }

    const H = rows[hdr].map(c => String(c).toLowerCase().trim());
    const iCuenta = _findCol(H, ['cuenta']);
    const iFecha  = _findCol(H, ['fecha']);
    const iComp   = _findCol(H, ['numero comprobante', 'nro comprobante', 'comprobante']);
    const iProv   = _findCol(H, ['razón social', 'razon social', 'proveedor']);
    const iDebe   = _findCol(H, ['debe']);
    const iHaber  = _findCol(H, ['haber']);
    if (iCuenta == null || iFecha == null || iDebe == null) {
      Logger.log('gastosEstructura [' + sheet.getName() + ']: faltan columnas clave — cuenta/fecha/debe');
      return;
    }

    for (let i = hdr + 1; i < rows.length; i++) {
      const row = rows[i];
      const cuentaRaw = String(row[iCuenta] || '').trim();
      if (!cuentaRaw) continue;

      // Solo ADMINISTRATIVO — se filtra por el nombre de cuenta (robusto ante el
      // typo de la col Categoria, que etiqueta mal "698 - ADMIN: ATENCION MEDICA").
      // Se excluye "DIST: COMBUST..." (combustible/distribución).
      if (!/ADMIN/i.test(cuentaRaw)) continue;

      const mes = parsearMes(row[iFecha]);
      if (!mes) continue;

      const monto = _num(row[iDebe]) - (iHaber != null ? _num(row[iHaber]) : 0);
      if (monto === 0) continue;

      const c = _parseCuenta(cuentaRaw);
      if (!acum[mes]) acum[mes] = {};
      if (!acum[mes][c.full]) acum[mes][c.full] = { codigo: c.codigo, nombre: c.nombre, full: c.full, total: 0, facturas: [] };
      const g = acum[mes][c.full];
      g.total += monto;
      g.facturas.push({
        fecha:       row[iFecha] instanceof Date
                       ? Utilities.formatDate(row[iFecha], 'America/Argentina/Buenos_Aires', 'dd/MM/yyyy')
                       : String(row[iFecha] || ''),
        proveedor:   iProv != null ? String(row[iProv] || '').trim() : '',
        comprobante: iComp != null ? String(row[iComp] || '').trim() : '',
        monto:       Math.round(monto),
      });
    }
    });

    // Armar salida por mes: cuentas ordenadas por total desc, con subtotal y total del mes
    const resultado = {};
    Object.keys(acum).forEach(function(mes) {
      const cuentas = Object.keys(acum[mes]).map(function(k) {
        const g = acum[mes][k];
        return {
          codigo:   g.codigo,
          nombre:   g.nombre,
          cuenta:   g.full,
          total:    Math.round(g.total),
          nFacturas: g.facturas.length,
          facturas: g.facturas.sort(function(a, b) { return b.monto - a.monto; }),
        };
      }).sort(function(a, b) { return b.total - a.total; });
      const total = cuentas.reduce(function(s, c) { return s + c.total; }, 0);
      resultado[mes] = { total: total, porCuenta: cuentas };
    });

    Logger.log('gastosEstructura — meses: ' + Object.keys(resultado).join(', '));
    return resultado;

  } catch (e) {
    Logger.log('leerGastosEstructura error: ' + e);
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
    const ss = SpreadsheetApp.openById(FILE_IDS.repuestosEquipos);
    // La planilla se reestructuró (sep-2026): la hoja pasó a llamarse
    // "REGISTRO ENTREGAS" (hay también "FORMULARIO ENTREGA", que no es un
    // registro). Se busca por nombre y las columnas se detectan por header.
    const sheets = ss.getSheets();
    const sheet = ss.getSheetByName('REGISTRO ENTREGAS')
      || sheets.find(sh => /ENTREGA/i.test(sh.getName()) && !/FORMULARIO/i.test(sh.getName()))
      || ss.getSheetByName('ENTREGAS')
      || sheets[0];
    const rows = sheet.getDataRange().getValues();
    const gid  = sheet.getSheetId();

    let hdrIdx = -1, iFecha = -1, iCod = -1, iCosto = -1, iEq = -1, iProv = -1, iRazon = -1, iObraG = -1, iNEnt = -1, iOrden = -1, iResumen = -1;
    for (let i = 0; i < Math.min(10, rows.length); i++) {
      const h = rows[i].map(c => String(c).toUpperCase().trim());
      const f = h.findIndex(c => c === 'FECHA' || c.indexOf('FECHA') === 0);
      const c = h.findIndex(c => c === 'COSTO' || c.indexOf('COSTO') === 0);
      if (f >= 0 && c >= 0) {
        hdrIdx = i; iFecha = f; iCosto = c;
        iCod     = h.findIndex(x => x === 'CÓDIGO 1' || x === 'CODIGO 1' || x === 'CÓDIGO' || x === 'CODIGO');
        iEq      = h.findIndex(x => x.indexOf('EQUIPO/SECTOR') === 0 || x === 'EQUIPO');
        iProv    = h.findIndex(x => x.indexOf('PROVEEDOR') === 0);
        iRazon   = h.findIndex(x => x.indexOf('RAZÓN') === 0 || x.indexOf('RAZON') === 0);
        iObraG   = h.findIndex(x => x.indexOf('OBRA GENERAL') === 0);
        iNEnt    = h.findIndex(x => x.indexOf('N° ENTREGA') === 0 || x.indexOf('Nº ENTREGA') === 0 || x.indexOf('N ENTREGA') === 0);
        iOrden   = h.findIndex(x => x.indexOf('N° ORDEN') === 0 || x.indexOf('Nº ORDEN') === 0);
        iResumen = h.findIndex(x => x.indexOf('RESUMEN') === 0);
        break;
      }
    }
    if (hdrIdx < 0) {
      // Formato viejo (hoja ENTREGAS sin header reconocible): C fecha, E código, J costo
      hdrIdx = 0; iFecha = 2; iCod = 4; iCosto = 9;
    }
    Logger.log('Repuestos — hoja: ' + sheet.getName() + ' hdr=' + hdrIdx + ' fecha=' + iFecha + ' cod=' + iCod + ' costo=' + iCosto);

    const resultado = {};
    for (let i = hdrIdx + 1; i < rows.length; i++) {
      const row  = rows[i];
      const mes  = parsearMes(row[iFecha]);
      if (!mes) continue;
      const costo = parsearMonto(row[iCosto]);
      if (!costo || costo <= 0) continue;
      const codEq = iCod >= 0 ? String(row[iCod] || '').trim() : '';
      const eq    = iEq >= 0 ? String(row[iEq] || '').trim() : '';

      if (!resultado[mes]) resultado[mes] = { total: 0, items: [], gid: gid };
      resultado[mes].total += costo;
      // Campos mínimos por entrega: el caché de Script Properties tiene cuota
      // (500 KB en total), así que no se guarda el detalle largo de cada fila.
      const it = { codEq: codEq || (eq && !/—/.test(eq) ? eq : ''), costo: Math.round(costo), fila: i + 1 };
      if (eq && eq.indexOf('—') < 0)    it.equipo    = eq.slice(0, 40);
      if (iProv >= 0 && row[iProv])     it.proveedor = String(row[iProv]).trim().slice(0, 40);
      if (iRazon >= 0 && row[iRazon])   it.razon     = String(row[iRazon]).trim().slice(0, 30);
      if (iNEnt >= 0 && row[iNEnt])     it.nEntrega  = String(row[iNEnt]).trim();
      if (iResumen >= 0 && row[iResumen]) it.resumen = String(row[iResumen]).trim().slice(0, 50);
      resultado[mes].items.push(it);
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
// Planilla de Amaicha: Fecha | Obra | Cantidad | Unidad (una fila por día).
// Agrega las tn a resultado[mes].porObra[obra] (caliente, det, dias) y marca
// cada salida con src:'amaicha' para que el tablero linkee a esa planilla.
function _mergeRemitosAmaicha(resultado, TZ) {
  const ss = SpreadsheetApp.openById(FILE_IDS.remitosAmaicha);
  const sheet = ss.getSheets()[0];
  if (!sheet) return;
  const rows = sheet.getDataRange().getValues();
  if (rows.length < 2) return;
  const MAP = ['ene','feb','mar','abr','may','jun','jul','ago','sep','oct','nov','dic'];
  const curYear = new Date().getFullYear();
  let hdrIdx = 0;
  for (let i = 0; i < Math.min(5, rows.length); i++) {
    const h = rows[i].map(c => String(c).toUpperCase().trim()).join('|');
    if (h.indexOf('FECHA') >= 0 && h.indexOf('CANTIDAD') >= 0) { hdrIdx = i; break; }
  }
  const headers = rows[hdrIdx].map(h => String(h).toUpperCase().trim());
  const iF = headers.findIndex(h => h.indexOf('FECHA') >= 0);
  const iO = headers.findIndex(h => h.indexOf('OBRA') >= 0);
  const iC = headers.findIndex(h => h.indexOf('CANTIDAD') >= 0 || h === 'TN');
  const iU = headers.findIndex(h => h.indexOf('UNIDAD') >= 0);
  if (iF < 0 || iC < 0) { Logger.log('remitosAmaicha: sin columnas FECHA/CANTIDAD'); return; }
  const gid = sheet.getSheetId();
  let nFilas = 0, tnTotal = 0;
  for (let i = hdrIdx + 1; i < rows.length; i++) {
    const row = rows[i];
    const cant = parsearMonto(row[iC]);
    if (!(cant > 0)) continue;
    if (iU >= 0) {
      const ud = String(row[iU] || '').toUpperCase().trim();
      if (ud && ud !== 'TN' && ud !== 'TON' && ud !== 'TONS' && ud !== 'TM' && ud !== 'TONELADAS') continue;
    }
    // Fecha: Date o dd/mm/yyyy. Solo el año del tablero.
    let fechaObj = null;
    const rawF = row[iF];
    if (rawF instanceof Date) fechaObj = rawF;
    else {
      const m = String(rawF || '').trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
      if (m) { let y = parseInt(m[3]); if (y < 100) y += 2000; fechaObj = new Date(y, parseInt(m[2]) - 1, parseInt(m[1])); }
    }
    if (!fechaObj || isNaN(fechaObj.getTime())) continue;
    if (fechaObj.getFullYear() !== curYear) continue;
    const mesKey = MAP[fechaObj.getMonth()];
    const obra = String(iO >= 0 ? row[iO] || '' : '').trim() || 'Ruta 357 - Quilmes';
    if (!resultado[mesKey]) resultado[mesKey] = { caliente: 0, frio: 0, total: 0, porObra: {}, obrasSalida: {}, gid: gid };
    const R = resultado[mesKey];
    if (!R.porObra[obra]) R.porObra[obra] = { caliente: 0, frio: 0 };
    const po = R.porObra[obra];
    po.caliente = Math.round((po.caliente + cant) * 10) / 10;
    po.amaicha  = Math.round(((po.amaicha || 0) + cant) * 10) / 10;
    const destino = 'Amaicha (planta en obra)';
    if (!po.det) po.det = [];
    let e = po.det.find(x => x.s === 'caliente' && x.d === destino);
    if (!e) { e = { s: 'caliente', d: destino, t: 0 }; po.det.push(e); }
    e.t = Math.round((e.t + cant) * 10) / 10;
    if (!po.dias) po.dias = [];
    const fStr = Utilities.formatDate(fechaObj, TZ, 'dd/MM');
    let ed = po.dias.find(x => x.f === fStr && x.s === 'caliente' && x.d === destino);
    if (!ed) { ed = { f: fStr, s: 'caliente', d: destino, t: 0, fs: [], src: 'amaicha', gid: gid }; po.dias.push(ed); }
    ed.t = Math.round((ed.t + cant) * 10) / 10;
    if (ed.fs.indexOf(i + 1) < 0) ed.fs.push(i + 1);
    // Resumen por mes (para el tablero): cuánto vino de Amaicha
    R.amaicha = Math.round(((R.amaicha || 0) + cant) * 10) / 10;
    nFilas++; tnTotal += cant;
  }
  Logger.log('remitosAmaicha: ' + nFilas + ' filas, ' + tnTotal + ' tn sumadas a la obra (no a planta/stock)');
}

function leerRemitosAsfalto() {
  try {
    const ss     = SpreadsheetApp.openById(FILE_IDS.remitosAsfalto);
    // Hoja de remitos: "REMITOS" (nombre actual) o "General" (nombre viejo).
    // Se evita "Maestro de obras" y similares.
    let sheetGeneral = ss.getSheetByName('REMITOS') || ss.getSheetByName('Remitos')
                    || ss.getSheetByName('General') || ss.getSheetByName('GENERAL');
    if (!sheetGeneral) {
      sheetGeneral = ss.getSheets().find(sh => !/maestro/i.test(sh.getName())) || ss.getSheets()[0];
    }
    const sheets = sheetGeneral ? [sheetGeneral] : [];
    const TZ = 'America/Argentina/Buenos_Aires';
    const MES_MAP = { 1:'ene', 2:'feb', 3:'mar', 4:'abr', 5:'may', 6:'jun',
                      7:'jul', 8:'ago', 9:'sep', 10:'oct', 11:'nov', 12:'dic' };
    const resultado = {};
    const detalle   = []; // por fila, con Date real — solo se usa internamente

    for (const sheet of sheets) {
      const rows = sheet.getDataRange().getValues();

      // Buscar fila de encabezados que tenga CANT. y U.D./U.M.
      let hdrIdx = -1, iCant = -1, iUD = -1, iDesc = -1, iMes = -1, iAnio = -1, iFecha = -1, iObra = -1, iDest = -1, iTipoCol = -1;
      let iCant2 = -1, iUD2 = -1, iDesc2 = -1; // segundo material por fila (layout sep-2026)
      for (let i = 0; i < Math.min(20, rows.length); i++) {
        // Sin acentos ni variantes Unicode: "DESCRIPCIÓN" (NFC o NFD) → "DESCRIPCION"
        const cells = rows[i].map(c => String(c).toUpperCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim());
        // Layout sep-2026: "CANTIDAD 1"/"CANTIDAD 2", "UNIDAD 1"/"UNIDAD 2", "DESCRIPCIÓN 1"/"DESCRIPCIÓN 2"
        const iC = cells.findIndex(c => c === 'CANT.' || c === 'CANT' || c === 'CANTIDAD' || c === 'CANTIDAD 1' || c === 'TOTAL' || c === 'TN' || c === 'TONELADAS');
        const iU = cells.findIndex(c => c === 'U.D.' || c === 'U.M.' || c === 'UD' || c === 'UI' || c === 'U.I.' || c === 'UNIDAD' || c === 'UNIDAD 1' || c === 'I');
        const iDt = cells.findIndex(c => c === 'DESCRIPCION' || c === 'DESCRIPCIÓN' || c === 'DESCRIPCION 1' || c === 'DESCRIPCIÓN 1' || c === 'PRODUCTO' || c === 'ARTICULO' || c === 'ARTÍCULO' || c === 'MATERIAL' || c === 'ITEM');
        const iMt = cells.findIndex(c => c === 'MES');
        // Obra: preferir OBRA GENERAL (col K). Fallback a OBRA / OBRA PARTICULAR / DESTINO.
        let iOb = cells.findIndex(c => c === 'OBRA GENERAL');
        if (iOb < 0) iOb = cells.findIndex(c => c === 'OBRA' || c === 'OBRA PARTICULAR' || c === 'DESTINO' || c === 'CLIENTE');
        // Destino/cliente del remito (col H) — importa en las provisiones a terceros
        let iDs = cells.findIndex(c => c === 'DESTINO' || c === 'CLIENTE' || c === 'OBRA PARTICULAR');
        if (iDs === iOb) iDs = -1; // no duplicar si la obra ya sale de esa columna
        const iFe = cells.findIndex(c => c === 'FECHA');
        if ((iC >= 0 && iU >= 0) || (iDt >= 0 && iMt >= 0) || (iC >= 0 && iDt >= 0) || (iDt >= 0 && iOb >= 0) || (iC >= 0 && iOb >= 0)) {
          hdrIdx = i;
          iCant  = iC >= 0 ? iC : (iDt >= 0 ? iDt - 2 : -1);
          iUD    = iU >= 0 ? iU : -1;
          iDesc  = iDt >= 0 ? iDt : -1;
          iMes   = iMt >= 0 ? iMt : cells.findIndex(c => c === 'MES');
          iAnio  = cells.findIndex(c => c === 'AÑO' || c === 'ANO');
          iFecha = iFe >= 0 ? iFe : cells.findIndex(c => c === 'FECHA');
          iObra  = iOb;
          iDest  = iDs >= 0 ? iDs : 7; // col H por defecto
          iTipoCol = cells.findIndex(c => c === 'TIPO'); // col F (convención jun-2026)
          iCant2 = cells.findIndex(c => c === 'CANTIDAD 2');
          iUD2   = cells.findIndex(c => c === 'UNIDAD 2');
          iDesc2 = cells.findIndex(c => c === 'DESCRIPCION 2' || c === 'DESCRIPCIÓN 2');
          break;
        }
      }
      // Fallback para planilla General (Roberto): col A=Fecha, B=TN, E=Descripción, K=Obra
      if (hdrIdx < 0) {
        Logger.log('Remitos [' + sheet.getName() + ']: sin header reconocido — aplicando fallback B=TN, E=Desc, H=Destino, K=Obra');
        hdrIdx = 0; iCant = 1; iUD = -1; iDesc = 4; iMes = -1; iAnio = -1; iFecha = 0; iObra = 10; iDest = 7;
      }
      Logger.log('Remitos [' + sheet.getName() + ']: hdr=' + hdrIdx + ' iCant=' + iCant + ' iUD=' + iUD + ' iDesc=' + iDesc + ' iMes=' + iMes + ' iAnio=' + iAnio + ' iObra=' + iObra);

      for (let i = hdrIdx + 1; i < rows.length; i++) {
        const row = rows[i];

        const obra = iObra >= 0 ? String(row[iObra] || '').trim() : '';

        // ── Fecha exacta (columna FECHA) — se calcula para CUALQUIER remito ──
        var fechaObj = null, _esUTC = false;
        if (iFecha >= 0 && row[iFecha] !== '' && row[iFecha] != null) {
          var rawF = row[iFecha];
          if (rawF instanceof Date) {
            // Usar UTC para evitar desfase UTC-3 (medianoche UTC = día anterior en Argentina)
            fechaObj = new Date(Date.UTC(rawF.getUTCFullYear(), rawF.getUTCMonth(), rawF.getUTCDate()));
            _esUTC = true;
          } else {
            _esUTC = false;
            var parts = String(rawF).trim().split('/');
            if (parts.length === 3) {
              // Formato es-AR: día/mes/año. Si el primer número no puede ser
              // día (>31) o el segundo no puede ser mes (>12), se invierte.
              var a = parseInt(parts[0]), b = parseInt(parts[1]), y = parseInt(parts[2]);
              if (y < 100) y += 2000;
              var d, m;
              if (a > 12 && b <= 12)      { d = a; m = b; } // 31/07 → día/mes
              else if (b > 12 && a <= 12) { d = b; m = a; } // 07/31 → mes/día
              else                        { d = a; m = b; } // ambiguo → día/mes (es-AR)
              if (!isNaN(m) && !isNaN(d) && !isNaN(y)) fechaObj = new Date(y, m - 1, d, 0, 0, 0);
            }
          }
        }

        // ── Mes/año para el agregado mensual ────────────────────────────────
        var mesNum, anioNum;
        if (fechaObj && !isNaN(fechaObj.getTime())) {
          mesNum  = fechaObj.getUTCMonth() + 1;
          anioNum = fechaObj.getUTCFullYear();
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

        if (!resultado[mesKey]) resultado[mesKey] = { caliente: 0, frio: 0, total: 0, porObra: {}, obrasSalida: {}, gid: sheet.getSheetId() };
        if (!resultado[mesKey].obrasSalida) resultado[mesKey].obrasSalida = {};

        // ── Registrar la obra de CUALQUIER salida (piedra, escombro, base, asfalto, etc.) ──
        if (obra) resultado[mesKey].obrasSalida[obra] = (resultado[mesKey].obrasSalida[obra] || 0) + 1;

        // Col TIPO (convención jun-2026): Provision / Carpeta Ingeco / Bacheo Ingeco
        const tipoColRaw = iTipoCol >= 0 ? String(row[iTipoCol] || '').trim() : '';
        const tipoColU   = tipoColRaw.toUpperCase();
        // Destino/cliente del remito (col H) — relevante en provisiones a terceros
        const destino = iDest >= 0 ? String(row[iDest] || '').trim() : '';

        // Una fila puede traer hasta 2 materiales (layout sep-2026:
        // DESCRIPCIÓN 1/CANTIDAD 1/UNIDAD 1 y DESCRIPCIÓN 2/CANTIDAD 2/UNIDAD 2)
        const matSlots = [[iDesc, iCant, iUD]];
        if (iDesc2 >= 0 || iCant2 >= 0) matSlots.push([iDesc2, iCant2, iUD2]);
        for (var slot = 0; slot < matSlots.length; slot++) {
        const iDescS = matSlots[slot][0], iCantS = matSlots[slot][1], iUDS = matSlots[slot][2];
        // Sin acentos: "FRÍO" (NFC o NFD) → "FRIO" — los includes() de abajo quedan estables
        const desc = String(iDescS >= 0 ? row[iDescS] || '' : '').toUpperCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();
        const cantRaw = typeof row[iCantS] === 'number' ? row[iCantS]
                   : parseFloat(String(row[iCantS] || '').replace(',', '.')) || 0;
        // UNIDAD: si la cantidad viene en KG (Pavimax embolsado, sep-2026) se
        // convierte a toneladas; en TN/TON queda igual. Otras unidades (M3,
        // LTS, viaje) no son toneladas y siguen su camino normal.
        const udRaw = iUDS >= 0 ? String(row[iUDS] || '').toUpperCase().trim() : '';
        const esKg  = udRaw === 'KG' || udRaw === 'KGS' || udRaw === 'KILOS' || udRaw === 'KILOGRAMOS';
        const cant  = esKg ? Math.round(cantRaw) / 1000 : cantRaw;

        // ── Desglose por CATEGORÍA para provisiones/ventas (convención jun-2026):
        // descripción normalizada + col TIPO + destino, incluye áridos en M3.
        // El precio (y el certificado teórico) depende de esta combinación.
        if (cant > 0 && /^(provisi|venta de|muestra)/i.test(obra || '')) {
          const CAT_ARIDOS = { '0-6': '0-6', '6-19': '6-19', '19-36': '19-36',
                               'BASE': 'Base', 'BRUTO': 'Bruto', 'ESCOMBRO': 'Escombro', 'FRESADO': 'Fresado' };
          let dsCat = null;
          if (desc.includes('PAVIMAX')) dsCat = 'Pavimax';
          else if (desc.includes('ASFALTO') && desc.includes('CALIENTE')) dsCat = 'Asfalto en caliente';
          else if (desc.includes('ASFALTO') && (desc.includes('FRI') || desc.includes('FRÍO'))) dsCat = 'Asfalto en frío';
          else if (CAT_ARIDOS[desc]) dsCat = CAT_ARIDOS[desc];
          if (dsCat) {
            const udC = esKg ? 'TN' : udRaw;
            // Pavimax se mide en BOLSAS de 25 kg (María, sep-2026): la cantidad
            // puede venir en KG (÷25), en TN (×40) o directamente en bolsas.
            const uCat = dsCat === 'Pavimax' ? 'Bolsa' : (dsCat.indexOf('Asfalto') === 0 ? 'TN' : (udC || 'M3'));
            if (!resultado[mesKey].porObra[obra]) resultado[mesKey].porObra[obra] = { caliente: 0, frio: 0 };
            const po = resultado[mesKey].porObra[obra];
            if (!po.cat) po.cat = [];
            let ec = null;
            for (var qc = 0; qc < po.cat.length; qc++) {
              const x = po.cat[qc];
              if (x.ds === dsCat && (x.tp || '') === tipoColRaw && x.d === destino && x.u === uCat) { ec = x; break; }
            }
            if (!ec) { ec = { ds: dsCat, tp: tipoColRaw, d: destino, u: uCat, t: 0 }; po.cat.push(ec); }
            let cantCat = cant;
            if (dsCat === 'Pavimax') {
              const esTn = udRaw === 'TN' || udRaw === 'TON' || udRaw === 'TONS' || udRaw === 'TM' || udRaw === 'TONELADAS';
              cantCat = esKg ? cantRaw / 25 : (esTn ? cantRaw * 40 : cantRaw);
            }
            ec.t = Math.round((ec.t + cantCat) * 10) / 10;
          }
        }

        // ── De acá en adelante: solo asfalto en toneladas (para tn y prorrateo de MO) ──
        if (iUDS >= 0) {
          const ud = esKg ? 'TN' : udRaw;
          if (ud !== 'TN' && ud !== 'TON' && ud !== 'TONS' && ud !== 'TM' && ud !== 'TONELADAS') continue;
        }
        // Pavimax es asfalto frío embolsado: en los remitos la descripción dice
        // solo "Pavimax" (sin la palabra asfalto) — cuenta igual como frío
        // Pavimax es una unidad aparte (bolsas de 25 kg, ver po.cat): no suma
        // a las tn de asfalto caliente/frío (María, sep-2026)
        if (!desc.includes('ASFALTO') || desc.includes('PAVIMAX')) continue;
        if (cant <= 0) continue;
        const tipo = desc.includes('CALIENTE') ? 'caliente'
                   : (desc.includes('FRI') || desc.includes('FRÍO')) ? 'frio' : null;
        // Sub-destino del caliente: descripción vieja ("...para carpeta/bacheo")
        // o col TIPO nueva ("Carpeta Ingeco" / "Bacheo Ingeco")
        const subTipo = tipo === 'caliente'
          ? ((desc.includes('CARPETA') || tipoColU === 'CARPETA INGECO') ? 'carpeta'
             : (desc.includes('BACHEO') || tipoColU === 'BACHEO INGECO') ? 'bacheo' : null)
          : null;

        if (fechaObj && !isNaN(fechaObj.getTime())) {
          detalle.push({ fecha: fechaObj, fechaStr: Utilities.formatDate(fechaObj, _esUTC ? 'UTC' : TZ, 'dd/MM/yyyy'), tipo: tipo, cant: Math.round(cant * 10) / 10, obra: obra });
        }

        // Detalle legible por obra: tipo + sub-destino (carpeta/bacheo) + cliente (col H).
        // Se agrega en porObra[obra].det = [{s, d, t}] agrupado por (s|d).
        // Además, salidas por FECHA en porObra[obra].dias = [{f, s, d, t}]
        // (agrupado por fecha+tipo+destino) — alimenta el subdetalle del
        // tablero "ver salidas por fecha" (María, sep-2026).
        const _addDet = function(obraKey, s, d, t) {
          const po = resultado[mesKey].porObra[obraKey];
          if (fechaObj && !isNaN(fechaObj.getTime())) {
            if (!po.dias) po.dias = [];
            // fechaObj de celdas Date se arma en UTC (medianoche UTC): formatear
            // en UTC, si no en Argentina cae al día anterior (sep-2026)
            const fStr = Utilities.formatDate(fechaObj, _esUTC ? 'UTC' : TZ, 'dd/MM');
            let ed = null;
            for (var qd = 0; qd < po.dias.length; qd++) {
              if (po.dias[qd].f === fStr && po.dias[qd].s === s && po.dias[qd].d === d) { ed = po.dias[qd]; break; }
            }
            // fs = filas del remito que componen la entrada (para linkear al sheet)
            if (!ed) { ed = { f: fStr, s: s, d: d, t: 0, fs: [] }; po.dias.push(ed); }
            ed.t = Math.round((ed.t + t) * 10) / 10;
            if (ed.fs.indexOf(i + 1) < 0) ed.fs.push(i + 1);
          }
          if (!po.det) po.det = [];
          let e = null;
          for (var q = 0; q < po.det.length; q++) { if (po.det[q].s === s && po.det[q].d === d) { e = po.det[q]; break; } }
          if (!e) { e = { s: s, d: d, t: 0 }; po.det.push(e); }
          e.t = Math.round((e.t + t) * 10) / 10;
          // Corte 30/07 (frío → Muni SMT): tc = tn despachadas desde el día 30
          // inclusive. El tablero usa tc para el corte de julio (8 tn base + tc).
          if (mesKey === 'jul' && s === 'frio' && /san miguel de tucum/i.test(d || '')
              && fechaObj && !isNaN(fechaObj.getTime()) && fechaObj.getUTCDate() >= 30) {
            e.tc = Math.round(((e.tc || 0) + t) * 10) / 10;
          }
        };

        if (tipo === 'caliente') {
          resultado[mesKey].caliente += cant;
          if (subTipo) resultado[mesKey][subTipo] = Math.round(((resultado[mesKey][subTipo] || 0) + cant) * 10) / 10;
          if (obra) {
            if (!resultado[mesKey].porObra[obra]) resultado[mesKey].porObra[obra] = { caliente: 0, frio: 0 };
            resultado[mesKey].porObra[obra].caliente = Math.round((resultado[mesKey].porObra[obra].caliente + cant) * 10) / 10;
            if (subTipo) resultado[mesKey].porObra[obra][subTipo] = Math.round(((resultado[mesKey].porObra[obra][subTipo] || 0) + cant) * 10) / 10;
            _addDet(obra, subTipo || 'caliente', destino, cant);
          }
        } else if (tipo === 'frio') {
          resultado[mesKey].frio += cant;
          if (obra) {
            if (!resultado[mesKey].porObra[obra]) resultado[mesKey].porObra[obra] = { caliente: 0, frio: 0 };
            resultado[mesKey].porObra[obra].frio = Math.round((resultado[mesKey].porObra[obra].frio + cant) * 10) / 10;
            _addDet(obra, 'frio', destino, cant);
          }
        }
        resultado[mesKey].total += cant;
        } // fin loop de materiales (slot 1 y 2)
      }
    }

    // Redondear a 1 decimal
    for (const mes of Object.keys(resultado)) {
      const r = resultado[mes];
      r.caliente = Math.round(r.caliente * 10) / 10;
      r.frio     = Math.round(r.frio     * 10) / 10;
      r.total    = Math.round(r.total    * 10) / 10;
    }

    // Mezcla despachada desde Amaicha (Ruta 357): no pasa por los remitos de
    // Tucumán. Se suma SOLO a la obra (tn, detalle y salidas por fecha) para
    // el costo de asfalto del margen — no a la producción de la planta ni al
    // stock, porque no se fabricó en Tucumán (María, sep-2026).
    try { _mergeRemitosAmaicha(resultado, TZ); }
    catch (eA) { Logger.log('remitosAmaicha error: ' + eA); }

    Logger.log('Remitos Asfalto 2026: ' + JSON.stringify(resultado));
    Logger.log('Remitos detalle: ' + detalle.length + ' filas con fecha exacta');
    resultado._detalle = detalle; // Date objects — se borra antes de serializar
    return resultado;

  } catch (err) {
    Logger.log('leerRemitosAsfalto error: ' + err.toString());
    return null;
  }
}

// ============================================================
// COBROS REALES — Planilla de Esteban (una pestaña por mes)
// Columnas: OBRA | CLIENTE | CONCEPTO | PERIODO | IMPORTE |
//           FECHA PROBABLE DE COBRO | FECHA REAL DE COBRO | COD
//
// Categorías por col G (FECHA REAL DE COBRO):
//   - Fecha      → "cobrado"    (ingreso efectivo)
//   - "F"        → "facturado"  (facturado, pendiente de cobro)
//   - vacío      → "sinFecha"   (sin fecha probable de cobro)
//
// Se leen filas hasta encontrar "TOTAL" en col C (CONCEPTO).
// Las filas DESPUÉS del TOTAL van a "menosProbable" (tabla separada).
// ============================================================
// Mes de una fecha, sin exigir un año puntual: "11/05/2026", "dic-25",
// "Mayo 2026"… Devuelve 'ene'…'dic' o null. Se usa para las pestañas
// históricas, donde cada fila puede ser de un año distinto.
function _mesKeyLibre(raw) {
  const MAP = ['ene','feb','mar','abr','may','jun','jul','ago','sep','oct','nov','dic'];
  if (!raw && raw !== 0) return null;
  if (raw instanceof Date && !isNaN(raw.getTime())) return MAP[raw.getMonth()];
  const s = String(raw).trim().toLowerCase();
  if (!s) return null;
  const mDate = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
  if (mDate) { const m = parseInt(mDate[2]); return (m >= 1 && m <= 12) ? MAP[m - 1] : null; }
  const NOMBRE = { enero:1, febrero:2, marzo:3, abril:4, mayo:5, junio:6, julio:7,
                   agosto:8, septiembre:9, octubre:10, noviembre:11, diciembre:12,
                   ene:1, feb:2, mar:3, abr:4, may:5, jun:6, jul:7, ago:8, sep:9, oct:10, nov:11, dic:12 };
  for (const n of Object.keys(NOMBRE)) {
    if (s === n || s.indexOf(n) === 0) return MAP[NOMBRE[n] - 1];
  }
  return null;
}

// Mete un ítem suelto en el mes que le corresponde dentro del resultado de
// leerCobrosEsteban, creando el mes si no existía y actualizando totales.
function _mergeCobroEnMes(resultado, mesKey, item) {
  if (!resultado[mesKey]) {
    resultado[mesKey] = {
      totalCobrado: 0, totalFacturado: 0, totalNoCobrado: 0, totalSinFecha: 0, totalMenosProbable: 0,
      nCobrado: 0, nFacturado: 0, nNoCobrado: 0, nSinFecha: 0, nMenosProbable: 0,
      cobrados: [], facturados: [], noCobrados: [], sinFecha: [], menosProbable: [],
    };
  }
  const R = resultado[mesKey];
  const MAPA = {
    cobrado:       ['cobrados',      'totalCobrado',       'nCobrado'],
    facturado:     ['facturados',    'totalFacturado',     'nFacturado'],
    noCobrado:     ['noCobrados',    'totalNoCobrado',     'nNoCobrado'],
    sinFecha:      ['sinFecha',      'totalSinFecha',      'nSinFecha'],
    menosProbable: ['menosProbable', 'totalMenosProbable', 'nMenosProbable'],
  };
  const dest = MAPA[item.categoria] || MAPA.cobrado;
  R[dest[0]].push(item);
  R[dest[1]] += item.importe || 0;
  R[dest[2]] += 1;
}

function leerCobrosEsteban() {
  try {
    const ss = SpreadsheetApp.openById(FILE_IDS.estebanSheet);
    const MES_TAB = {
      'enero':'ene','febrero':'feb','marzo':'mar','abril':'abr',
      'mayo':'may','junio':'jun','julio':'jul','agosto':'ago',
      'septiembre':'sep','octubre':'oct','noviembre':'nov','diciembre':'dic'
    };
    const resultado = {};
    const historicos = []; // filas de pestañas históricas, se reparten al final

    for (const sheet of ss.getSheets()) {
      const tabRaw = sheet.getName().trim().toLowerCase();
      let mesKey = null;
      for (const nombre of Object.keys(MES_TAB)) {
        if (tabRaw === nombre || tabRaw.startsWith(nombre + ' ') || tabRaw.startsWith(nombre + '-')) {
          mesKey = MES_TAB[nombre]; break;
        }
      }
      // Pestaña histórica (ej. "Anterior a junio"): no representa un mes —
      // cada fila se asigna al mes de SU propia fecha de cobro. Permite
      // cargar de una vez los cobros previos a que Esteban empezara a
      // registrar mes a mes (María, sep-2026).
      const esHistorico = !mesKey && /anterior|histor|previo/i.test(tabRaw);
      if (!mesKey && !esHistorico) continue;

      const rows = sheet.getDataRange().getValues();
      if (rows.length < 2) continue;

      // Detectar fila de encabezados
      let hdrIdx = 0;
      for (let i = 0; i < Math.min(8, rows.length); i++) {
        const rowStr = rows[i].map(c => String(c).toUpperCase().trim()).join('|');
        if (rowStr.includes('OBRA') && rowStr.includes('IMPORTE')) { hdrIdx = i; break; }
      }
      const headers = rows[hdrIdx].map(h => String(h).toUpperCase().trim());
      Logger.log('CobrosEsteban [' + sheet.getName() + '] hdr=' + hdrIdx + ' headers: ' + headers.join(' | '));

      const iObra      = _findCobCol(headers, ['OBRA']);
      const iCliente   = _findCobCol(headers, ['CLIENTE']);
      const iConcepto  = _findCobCol(headers, ['CONCEPTO']);
      const iPeriodo   = _findCobCol(headers, ['PERIODO','PERÍODO']);
      const iImporte   = _findCobCol(headers, ['IMPORTE']);
      const iFechaProb = _findCobCol(headers, ['PROBABLE']);
      const iFechaReal = _findCobCol(headers, ['REAL']);
      const iCod       = _findCobCol(headers, ['COD']);

      if (iObra === null || iImporte === null) {
        Logger.log('CobrosEsteban [' + sheet.getName() + '] — sin columnas OBRA/IMPORTE, omitida');
        continue;
      }

      const cobrados      = [];
      const facturados    = [];
      const noCobrados    = [];
      const sinFecha      = [];
      const menosProbable = [];
      let totalCobrado = 0, totalFacturado = 0, totalNoCobrado = 0, totalSinFecha = 0, totalMenosProbable = 0;
      let pastTotal = false;

      for (let i = hdrIdx + 1; i < rows.length; i++) {
        const row = rows[i];

        // Detectar fila TOTAL en col CONCEPTO → separador de secciones
        const conceptoRaw = String(iConcepto !== null ? row[iConcepto] || '' : '').trim();
        if (!pastTotal && conceptoRaw.toUpperCase() === 'TOTAL') {
          pastTotal = true;
          continue;
        }

        const importe = parsearMonto(iImporte !== null ? row[iImporte] : 0);
        if (importe <= 0) continue;
        const obra = String(iObra !== null ? row[iObra] || '' : '').trim();
        // No saltear filas sin OBRA: en la planilla de Esteban algunas filas (p.ej. Air Liquide)
        // tienen el cliente en col B y la col A vacía. Usamos el cliente como fallback.

        const item = {
          obra:      obra,
          cliente:   iCliente   !== null ? String(row[iCliente]   || '').trim() : '',
          concepto:  conceptoRaw,
          periodo:   iPeriodo   !== null ? String(row[iPeriodo]   || '').trim() : '',
          importe:   Math.round(importe),
          fechaProb: iFechaProb !== null ? _fmtFecha(row[iFechaProb]) : '',
          fechaReal: iFechaReal !== null ? _fmtFecha(row[iFechaReal]) : '',
          cod:       iCod       !== null ? String(row[iCod]       || '').trim() : '',
          fila:      i + 1,                 // fila real del Sheet (deep-link desde el tablero)
          gid:       sheet.getSheetId(),
        };

        // Categorizar por valor RAW de col G (antes de formatear).
        // La marca explícita de col G (fecha real, F, N/C) gana SIEMPRE sobre
        // la posición: una fila facturada o cobrada debajo del TOTAL no es
        // "menos probable". Solo las filas sin marca debajo del TOTAL lo son.
        const gRaw = iFechaReal !== null ? row[iFechaReal] : '';
        const gStr = String(gRaw || '').trim();

        if (gStr === '' || gStr === '-') {
          if (esHistorico) {
            // La pestaña histórica existe justamente para registrar cobros ya
            // realizados: una fila sin marca (o sin columna de fecha real) es
            // un cobro hecho, no un pendiente.
            item.categoria = 'cobrado';
            cobrados.push(item);
            totalCobrado += importe;
          } else if (pastTotal) {
            item.categoria = 'menosProbable';
            menosProbable.push(item);
            totalMenosProbable += importe;
          } else {
            item.categoria = 'sinFecha';
            sinFecha.push(item);
            totalSinFecha += importe;
          }
        } else if (gStr.toUpperCase() === 'F') {
          item.categoria = 'facturado';
          item.fechaReal = '';
          facturados.push(item);
          totalFacturado += importe;
        } else if (gStr.toUpperCase() === 'N/C') {
          item.categoria = 'noCobrado';
          item.fechaReal = '';
          noCobrados.push(item);
          totalNoCobrado += importe;
        } else {
          item.categoria = 'cobrado';
          cobrados.push(item);
          totalCobrado += importe;
        }
      }

      const sortByImporte = function(a, b) { return b.importe - a.importe; };
      cobrados.sort(sortByImporte);
      facturados.sort(sortByImporte);
      noCobrados.sort(sortByImporte);
      sinFecha.sort(sortByImporte);
      menosProbable.sort(sortByImporte);

      if (esHistorico) {
        // Se guardan para repartirlos DESPUÉS de procesar todas las pestañas,
        // así no se pisan con los meses que tienen su propia pestaña.
        [cobrados, facturados, noCobrados, sinFecha, menosProbable].forEach(function(arr) {
          arr.forEach(function(it) { historicos.push(it); });
        });
        Logger.log('CobrosEsteban [histórico "' + sheet.getName() + '"]: ' + historicos.length + ' filas para repartir por fecha');
        continue;
      }

      resultado[mesKey] = {
        totalCobrado:       Math.round(totalCobrado),
        totalFacturado:     Math.round(totalFacturado),
        totalNoCobrado:     Math.round(totalNoCobrado),
        totalSinFecha:      Math.round(totalSinFecha),
        totalMenosProbable: Math.round(totalMenosProbable),
        nCobrado:           cobrados.length,
        nFacturado:         facturados.length,
        nNoCobrado:         noCobrados.length,
        nSinFecha:          sinFecha.length,
        nMenosProbable:     menosProbable.length,
        cobrados:           cobrados,
        facturados:         facturados,
        noCobrados:         noCobrados,
        sinFecha:           sinFecha,
        menosProbable:      menosProbable,
      };
      Logger.log('CobrosEsteban [' + mesKey + ']: cobrado=' + cobrados.length + ' $' + Math.round(totalCobrado) +
                 ' | facturado=' + facturados.length + ' $' + Math.round(totalFacturado) +
                 ' | noCobrado=' + noCobrados.length + ' $' + Math.round(totalNoCobrado) +
                 ' | sinFecha=' + sinFecha.length + ' $' + Math.round(totalSinFecha) +
                 ' | menosProbable=' + menosProbable.length);
    }

    // Repartir las filas de pestañas históricas en el mes de su propia fecha
    // (fecha real de cobro > fecha probable > período). Las de años anteriores
    // caen en el mes que indiquen igual: lo que importa es que el cobro exista
    // para los acumulados y las auditorías.
    if (historicos.length) {
      const anioTablero = new Date().getFullYear();
      historicos.forEach(function(it) {
        const ref = it.fechaReal || it.fechaProb || it.periodo || '';
        let mk = _mesKeyLibre(ref) || 'ene';
        // Años anteriores ("dic-25", "jul-25"): se acumulan en el primer mes
        // del año del tablero. Así suman en los acumulados y auditorías sin
        // aparecer como actividad de un mes que todavía no ocurrió.
        const my = String(ref).match(/(\d{2,4})\s*$/);
        if (my) {
          let y = parseInt(my[1]); if (y < 100) y += 2000;
          if (y && y < anioTablero) mk = 'ene';
        }
        _mergeCobroEnMes(resultado, mk, it);
      });
      // Reordenar por importe los meses tocados
      Object.keys(resultado).forEach(function(mk) {
        ['cobrados', 'facturados', 'noCobrados', 'sinFecha', 'menosProbable'].forEach(function(c) {
          resultado[mk][c].sort(function(a, b) { return b.importe - a.importe; });
        });
      });
      Logger.log('CobrosEsteban — ' + historicos.length + ' filas históricas repartidas por fecha');
    }

    Logger.log('CobrosEsteban — meses: ' + Object.keys(resultado).join(', '));
    return resultado;

  } catch (err) {
    Logger.log('leerCobrosEsteban error: ' + err.toString());
    return null;
  }
}

// Helper: busca la primera columna cuyo header incluya alguna de las keywords
function _findCobCol(headers, keywords) {
  for (const kw of keywords) {
    const idx = headers.findIndex(function(h) { return h.includes(kw); });
    if (idx >= 0) return idx;
  }
  return null;
}

// Formatea una celda de fecha (Date o string) como DD/MM/YYYY
function _fmtFecha(raw) {
  if (!raw || raw === '') return '';
  if (raw instanceof Date) {
    if (isNaN(raw.getTime())) return '';
    const d = raw.getUTCDate(), m = raw.getUTCMonth() + 1, y = raw.getUTCFullYear();
    return (d < 10 ? '0' : '') + d + '/' + (m < 10 ? '0' : '') + m + '/' + y;
  }
  const s = String(raw).trim();
  return s === '' ? '' : s;
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
// ============================================================
// AUTORIZAR FETCH EXTERNO (UrlFetchApp)
// Ejecutar UNA SOLA VEZ desde el editor para otorgar el permiso
// de llamadas a internet (requerido para auto-fetch TC del BCRA)
// ============================================================
function autorizarFetchExterno() {
  try {
    const resp = UrlFetchApp.fetch('https://api.estadisticasbcra.site/usd_of', { muteHttpExceptions: true });
    const data = JSON.parse(resp.getContentText());
    const hoy  = data[data.length - 1];
    Logger.log('✅ Permiso concedido. Último TC oficial BCRA: $' + hoy.v + ' (' + hoy.d + ')');
  } catch(e) {
    Logger.log('Error: ' + e);
  }
}

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
// DIAGNÓSTICO ESPECÍFICO: OBRAS (nuevo archivo)
// Ejecutar desde el editor → Ver → Registros
// ============================================================
function diagnosticoObras() {
  Logger.log('=== DIAGNÓSTICO OBRAS ===');
  const curYear = new Date().getFullYear();
  Logger.log('Año actual: ' + curYear);

  const ss = SpreadsheetApp.openById(FILE_IDS.fernandoObras);
  Logger.log('Archivo: ' + ss.getName());
  Logger.log('Pestañas: ' + ss.getSheets().map(s => s.getName()).join(', '));

  const TAB_CONFIG = {
    'OBRAS DE MUNICIPIO': { iMonto: 6, iMontoFallback: 5, iPeriodo: 17, iEstado: 4, estadoFiltro: ['a cobrar', 'cobrada'] },
    'VIALIDAD1':          { iMonto: 8, iMontoFallback: 7,  iPeriodo: 20, iEstado: null, estadoFiltro: null },
    'OTROS INGRESOS':     { iMonto: 5, iMontoFallback: null, iPeriodo: 15, iEstado: null, estadoFiltro: null },
  };

  for (const sheet of ss.getSheets()) {
    const tabName = sheet.getName().trim().toUpperCase();
    let cfg = null;
    for (const key of Object.keys(TAB_CONFIG)) {
      if (tabName.includes(key)) { cfg = TAB_CONFIG[key]; break; }
    }
    if (!cfg) continue;

    const rows = sheet.getDataRange().getValues();
    Logger.log('\n--- Pestaña: ' + sheet.getName() + ' (' + rows.length + ' filas) ---');

    // Mostrar primeras 3 filas para ver estructura
    for (let i = 0; i < Math.min(3, rows.length); i++) {
      Logger.log('  Fila ' + i + ': ' + rows[i].slice(0, 20).map(function(c, ci) {
        return ci + '=' + JSON.stringify(c instanceof Date ? c.toISOString() : c);
      }).join(' | '));
    }

    // Contar filas por estado y parsear períodos
    const resumen = {};
    let nProcesadas = 0, nFiltradas = 0;
    const estadosFiltrados = {};
    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];
      if (cfg.iEstado !== null) {
        const estado = String(row[cfg.iEstado] || '').trim().toLowerCase();
        if (!cfg.estadoFiltro.includes(estado)) {
          nFiltradas++;
          estadosFiltrados[estado || '(vacío)'] = (estadosFiltrados[estado || '(vacío)'] || 0) + 1;
          // Mostrar si tiene período
          const rawP = row[cfg.iPeriodo];
          const mk = _parseMesKey(rawP, curYear);
          if (mk) Logger.log('  ⚠ FILTRADA con período ' + mk + ': estado="' + estado + '" | periodo=' + JSON.stringify(rawP instanceof Date ? rawP.toISOString() : rawP));
          continue;
        }
      }
      nProcesadas++;
      const rawPeriodo = row[cfg.iPeriodo];
      let periodoStr = rawPeriodo instanceof Date ? rawPeriodo.toISOString() : JSON.stringify(rawPeriodo);
      const mesKey = _parseMesKey(rawPeriodo, curYear);
      resumen[mesKey || 'SIN-MES'] = (resumen[mesKey || 'SIN-MES'] || 0) + 1;
    }
    Logger.log('  Procesadas: ' + nProcesadas + ' | Filtradas por estado: ' + nFiltradas);
    Logger.log('  Estados filtrados: ' + JSON.stringify(estadosFiltrados));
    Logger.log('  Distribución por mes: ' + JSON.stringify(resumen));
  }

  Logger.log('\n=== FIN DIAGNÓSTICO OBRAS ===');
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

// fechaCustom (opcional): dd/MM/yyyy — permite cargar retroactivamente la
// fecha real del corte en vez de usar siempre "hoy" (ej. Agustín carga hoy
// un ajuste que en los hechos se hizo la semana pasada). Si no es un formato
// válido, se ignora y se usa la fecha actual como siempre.
function guardarAjusteStock(stockAntes, stockNuevo, usuario, tipo, fechaCustom) {
  try {
    const ss    = SpreadsheetApp.openById(FILE_IDS.ajusteStock);
    const sheet = ss.getSheetByName('Ajuste de stock');
    if (!sheet) {
      return { status: 'error', message: 'No se encontró la pestaña "Ajuste de stock"' };
    }
    const tz    = 'America/Argentina/Buenos_Aires';
    const now   = new Date();
    let fecha   = Utilities.formatDate(now, tz, 'dd/MM/yyyy');
    const hora  = Utilities.formatDate(now, tz, 'HH:mm:ss');
    if (fechaCustom) {
      const m = String(fechaCustom).trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
      if (m) fecha = m[1].padStart(2, '0') + '/' + m[2].padStart(2, '0') + '/' + m[3];
    }
    const tipoN = (String(tipo || 'asfalto').toLowerCase().trim() === 'frio') ? 'frio' : 'asfalto';
    // Col F = tipo ('asfalto' | 'frio'). Filas viejas sin col F se leen como 'asfalto'.
    sheet.appendRow([fecha, hora, usuario, stockAntes, stockNuevo, tipoN]);
    Logger.log('Ajuste de stock (' + tipoN + ') guardado: ' + stockAntes + ' → ' + stockNuevo + ' (' + usuario + ') fecha=' + fecha);
    return { status: 'ok', stockNuevo: stockNuevo, tipo: tipoN, fecha: fecha, timestamp: now.toISOString() };
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

    // ── 1. Checkpoint: último ajuste manual de asfalto (materia prima) ──
    // Hoja "Ajuste de stock": A fecha · B hora · C usuario · D antes · E nuevo · F tipo
    // Modelo simplificado: un solo stock de asfalto. Tanto caliente como frío
    // se producen consumiendo asfalto (÷20) — ya no hay buffer de frío aparte,
    // así que los ajustes de tipo 'frio' (legado) se ignoran.
    let stockBase   = BASE_STOCK;
    let fechaBase   = BASE_FECHA;
    let usuarioBase = BASE_USUARIO;

    const sheetAjuste = ss.getSheetByName('Ajuste de stock');
    if (sheetAjuste && sheetAjuste.getLastRow() >= 2) {
      const rowsAj = sheetAjuste.getDataRange().getValues();
      for (var a = 1; a < rowsAj.length; a++) {
        var valAj = Number(rowsAj[a][4]);
        if (isNaN(valAj) || valAj < 0) continue;
        // Se ignoran los ajustes de tipo 'frio' (modelo anterior): el frío ya no
        // es un stock aparte. Solo cuenta el checkpoint de asfalto.
        var tipoAj = String(rowsAj[a][5] || 'asfalto').toLowerCase().trim();
        if (tipoAj === 'frio' || tipoAj === 'frío') continue;
        // Col A puede venir como Date (celda formateada como fecha — lo normal) o
        // como texto "dd/MM/yyyy" (filas viejas). Manejar ambos casos.
        var celdaFecha = rowsAj[a][0];
        var fAj = null;
        if (celdaFecha instanceof Date && !isNaN(celdaFecha.getTime())) {
          var sF = Utilities.formatDate(celdaFecha, TZ, 'dd/MM/yyyy').split('/');
          fAj = new Date(parseInt(sF[2]), parseInt(sF[1]) - 1, parseInt(sF[0]));
        } else {
          var partsAj = String(celdaFecha || '').trim().split('/');
          if (partsAj.length === 3) fAj = new Date(parseInt(partsAj[2]), parseInt(partsAj[1]) - 1, parseInt(partsAj[0]));
        }
        var usrAj = String(rowsAj[a][2] || BASE_USUARIO);
        // Gana la fecha más RECIENTE, no la última fila cargada — permite cargar
        // ajustes retroactivos sin pisar un checkpoint más nuevo ya guardado.
        if (!fAj || fAj >= fechaBase) { stockBase = valAj; if (fAj) fechaBase = fAj; usuarioBase = usrAj; }
      }
    }

    // ── 2. Ingresos desde formulario (solo después del checkpoint) ──
    let ingresos = 0;
    const ingresosDetalle = [];
    let costoAsfaltoTotal = 0, tnAsfaltoComprado = 0, precioAsfaltoTn = null;
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
      // Columna "Costo total" — costo de compra del asfalto (materia prima)
      const iCosto = headers.findIndex(function(h) { return h.includes('costo'); });
      Logger.log('StockAsfalto — iQty=' + iQty + ' iCosto=' + iCosto +
                 (iQty >= 0 ? ' ("' + headers[iQty] + '")' : ' (qty no encontrado)'));

      // Precio de referencia del asfalto: costo total ÷ tn compradas, sobre TODAS
      // las cargas del formulario que tengan costo cargado (no solo post-checkpoint).
      var kgAsfaltoConCosto = 0;

      if (iQty >= 0) {
        for (var i = 1; i < rows.length; i++) {
          var rawFecha = rows[i][0];
          var fechaForm = rawFecha instanceof Date ? rawFecha : new Date(rawFecha);
          if (!fechaForm || isNaN(fechaForm.getTime())) continue;

          var raw = rows[i][iQty];
          var qtyKg = typeof raw === 'number' ? raw
                    : parseFloat(String(raw || '').replace(',', '.')) || 0;

          // Costo del asfalto (materia prima) — se acumula aunque la carga sea
          // anterior al checkpoint, porque es un precio de compra de referencia.
          if (iCosto >= 0 && qtyKg > 0) {
            var costoRaw = rows[i][iCosto];
            var costo = typeof costoRaw === 'number' ? costoRaw
                      : parseFloat(String(costoRaw || '').replace(/[.$\s]/g, '').replace(',', '.')) || 0;
            if (costo > 0) { costoAsfaltoTotal += costo; kgAsfaltoConCosto += qtyKg; }
          }

          // Ingresos al stock: solo cargas posteriores al checkpoint.
          if (fechaForm <= fechaBase) continue;
          if (qtyKg <= 0) continue;
          var qty = qtyKg / 1000; // formulario carga en kg → convertir a tn

          ingresos += qty;
          ingresosDetalle.push({
            fecha:    Utilities.formatDate(fechaForm, TZ, 'dd/MM/yyyy'),
            cantidad: Math.round(qty * 10) / 10
          });
        }
      }

      tnAsfaltoComprado = kgAsfaltoConCosto / 1000;
      precioAsfaltoTn   = tnAsfaltoComprado > 0 ? costoAsfaltoTotal / tnAsfaltoComprado : null;
    }

    // ── 3. Consumo desde REMITOS ─────────────────────────────────────────────
    // Modelo simplificado: TODA la mezcla despachada (caliente + frío) se produce
    // consumiendo asfalto (tn asfalto = tn mezcla / 20). Sin buffer de frío.
    const RATIO = 20;
    let consumo = 0;            // asfalto materia prima consumido (caliente + frío) / 20
    const consumoDetalle = [];  // todas las salidas (para el detalle de movimientos)
    const remitos = remitosData || {};

    if (remitos._detalle && remitos._detalle.length > 0) {
      var salidas = remitos._detalle.slice().sort(function(a, b) { return a.fecha - b.fecha; });
      for (var f = 0; f < salidas.length; f++) {
        var r = salidas[f];
        if (r.fecha < fechaBase) continue;
        consumo += r.cant / RATIO;
        consumoDetalle.push({ fecha: r.fechaStr, tipo: r.tipo,
                              caliente: r.tipo === 'frio' ? 0 : r.cant,
                              frio:     r.tipo === 'frio' ? r.cant : 0,
                              tnMezcla: r.cant, tnAsfalto: Math.round((r.cant / RATIO) * 10) / 10, exacto: true });
      }
      Logger.log('StockAsfalto — salidas: ' + consumoDetalle.length + ' (consumo asfalto: ' + consumo + ' tn)');
    } else {
      // ── Fallback: pro-rateo mensual si no hay fechas exactas ────────────────
      const MES_NUM = { ene:1, feb:2, mar:3, abr:4, may:5, jun:6,
                        jul:7, ago:8, sep:9, oct:10, nov:11, dic:12 };
      for (var mes in remitos) {
        var numMes = MES_NUM[mes];
        if (!numMes) continue;
        var inicioMes = new Date(2026, numMes - 1, 1);
        var finMes    = new Date(2026, numMes, 0);
        var calMes    = remitos[mes].caliente || 0;
        var frioMes   = remitos[mes].frio     || 0;

        if (finMes >= fechaBase) {
          var frac = 1;
          if (inicioMes < fechaBase && fechaBase <= finMes) {
            frac = Math.max(0, finMes.getDate() - fechaBase.getDate()) / finMes.getDate();
          }
          consumo += ((calMes + frioMes) * frac) / RATIO;
        }
        consumoDetalle.push({
          mes:       mes,
          tnMezcla:  Math.round((calMes + frioMes) * 10) / 10,
          tnAsfalto: Math.round(((calMes + frioMes) / RATIO) * 10) / 10,
          caliente:  Math.round(calMes  * 10) / 10,
          frio:      Math.round(frioMes * 10) / 10,
          pct:       100,
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
      // Costo del asfalto (materia prima) desde el formulario "Costo total"
      costoAsfaltoTotal: Math.round(costoAsfaltoTotal),
      tnAsfaltoComprado: Math.round(tnAsfaltoComprado * 10) / 10,
      precioAsfaltoTn:   precioAsfaltoTn != null ? Math.round(precioAsfaltoTn) : null,
    };

  } catch (err) {
    Logger.log('leerStockAsfalto error: ' + err.toString());
    return { valor: BASE_STOCK, stockBase: BASE_STOCK, ingresos: 0, consumo: 0,
             fechaBase: Utilities.formatDate(BASE_FECHA, 'America/Argentina/Buenos_Aires', 'dd/MM/yyyy'),
             usuarioBase: BASE_USUARIO, ingresosDetalle: [], consumoDetalle: [] };
  }
}

// ============================================================
// RECORDATORIOS POR MAIL A QUIENES ALIMENTAN LOS ARCHIVOS
// ============================================================
// - Lunes a las 8: a cada responsable con frecuencia 'lunes'.
// - Días 3 y 17 de cada mes: a los de frecuencia 'quincena' (Mauro), dos días
//   después de que cierra cada quincena.
// Salen desde la cuenta dueña de este script (hoy María). Para cambiar de
// remitente (ej. Gonzalo como coordinador) hay que pasar el proyecto a su cuenta.
//
// MODO PRUEBA: mientras RECORDATORIOS_MODO_PRUEBA sea true, TODOS los mails le
// llegan a RECORDATORIOS_PRUEBA_A, con el destinatario real en el asunto.
// Cuando los mails de la lista estén completos y revisados, pasarlo a false.
//
// Puesta en marcha (una sola vez, desde el editor):
//   1. Ejecutar probarRecordatorios() → pide autorización para enviar mails
//      y manda todos los recordatorios de muestra a RECORDATORIOS_PRUEBA_A.
//   2. Ejecutar crearTriggerRecordatorios() → deja programado el envío diario
//      a las 8 (la función decide si hoy corresponde mandar y a quién).

const RECORDATORIOS_MODO_PRUEBA = true;
const RECORDATORIOS_PRUEBA_A    = 'mariacaram94@gmail.com';
const RECORDATORIOS_CC          = 'cpngonzalo@gmail.com';   // copia a todos (Gonzalo, coordinador) — vacío = sin copia
const RECORDATORIOS_DIAS_VIEJO  = 7;    // días sin cambios para marcar el archivo como desactualizado
const URL_TABLERO = 'https://ingeco-dashboard.vercel.app';

// email: uno o varios separados por coma. Vacío = no se envía (se registra en el log).
// frecuencia: 'lunes' (todos los lunes), 'mensual' (primer lunes del mes),
// 'quincena' (días 3 y 17).
// Por archivo: cols = columnas que lee el tablero (no cambiarles el título);
// obraCol = columna donde va el nombre de la obra tal cual el Maestro;
// maestro = pestaña del archivo que trae sola la lista del Maestro de obras.
// instructivo = ID del Google Doc con el instructivo (carpetas de Instructivos en Drive).
const RECORDATORIOS = [
  { nombre: 'Agustín y Sergio', email: 'adegregorio@grupoingeco.com.ar,sergiocangemi@grupoingeco.com.ar', frecuencia: 'lunes',
    archivos: [
      { fileKey: 'agustinObras', instructivo: '1GtZ5jMOIND3WKAYKK2kFvVMeegwtYP0DZ6aQ_EJfldg', titulo: 'Obras a cobrar',
        que: 'Certificados del mes con su período de realización, y marcar como "Cobrada" lo que ya se cobró.',
        cols: ['Nombre Obra', 'Estado $', 'Monto Total', 'Anticipo financiero', 'Monto a certificar', 'Código', 'Período de realización'],
        obraCol: 'Código', maestro: 'Maestro de obras' },
      { fileKey: 'maestroObras', instructivo: '1E4f3DovCKRbzQ0z-DqIIof3O__FBJhBJmY_tBHqzhsI', titulo: 'Maestro de obras',
        que: 'Solo si hay una obra nueva: agregarla en una fila nueva con su nombre, cliente y tipo de contrato. No cambiar el nombre de una obra que ya existe: las otras planillas copian esta lista.',
        cols: ['NOMBRE DE OBRA', 'CLIENTE', 'TIPO_CONTRATO', 'ESTADO'] },
    ] },
  { nombre: 'Agustín', email: 'adegregorio@grupoingeco.com.ar', frecuencia: 'mensual',
    archivos: [{ fileKey: 'equiposFlota', instructivo: '19rwnaUSO4RG1ZZ-q3S70Emh4VjinfsX4gAJdTlxWels', titulo: 'Tarifas y precios del mes',
      que: 'Actualizar los precios del mes.',
      cols: ['CÓDIGO', 'PF'] }] },
  { nombre: 'Esteban',   email: 'esaguir@grupoingeco.com.ar', frecuencia: 'lunes',
    archivos: [{ fileKey: 'estebanSheet', instructivo: '15l2ZYx7WsChKyGNc4Lkd7-v-uMM5T1wqYSfQV5AaZko', titulo: 'Cobros (planilla por mes)',
      que: 'Cobros de la semana con fecha real de cobro, facturas emitidas y fechas probables de lo pendiente. Cada mes nuevo va en una pestaña con el nombre del mes (ej. "Octubre") y las mismas columnas.',
      cols: ['OBRA', 'CLIENTE', 'CONCEPTO', 'IMPORTE', 'FECHA PROBABLE', 'FECHA REAL'],
      obraCol: 'OBRA', maestro: 'Maestro de obras' }] },
  { nombre: 'Guillermo', email: 'compras1@grupoingeco.com.ar', frecuencia: 'lunes',
    archivos: [{ fileKey: 'ocInsumos', instructivo: '1W0M0JvTawzOzEIbZAGLhHSU5-xsQoyC00C8Hwt0oDa8', titulo: 'Órdenes de compra de insumos',
      que: 'OC de la semana con la OBRA GENERAL completa (sin "Obra no disponible").',
      cols: ['N° ORDEN', 'PROVEEDOR', 'FECHA', 'DESCRIPCIÓN', 'MONTO', 'OBRA GENERAL'],
      obraCol: 'OBRA GENERAL', maestro: 'Maestro de obras' }] },
  { nombre: 'Roberto',   email: 'deposito@grupoingeco.com.ar', frecuencia: 'lunes',
    archivos: [{ fileKey: 'remitosAsfalto', instructivo: '1xmtQ6uYIQaF9emb73TRk3nos8cnGbFGUC9z4XbEqVfA', titulo: 'Remitos oficiales',
      que: 'Remitos de la semana con OBRA GENERAL, destino, unidad (TON o KG) y fecha del año en curso.',
      cols: ['FECHA', 'CANTIDAD 1', 'UNIDAD 1', 'DESCRIPCIÓN 1', 'DESTINO', 'OBRA GENERAL'],
      obraCol: 'OBRA GENERAL', maestro: 'Maestro de obras' }] },
  { nombre: 'Nico',      email: 'nicobdallagata@gmail.com', frecuencia: 'lunes',
    archivos: [
      { fileKey: 'usageEquipos', instructivo: '1ZO5ygH-1qVKZm7dp8lgex0i6VCR0JyYydQPCM6r4_w0', titulo: 'Partes diarios de equipos', que: 'Horas por equipo y obra de toda la semana.',
        cols: ['FECHA', 'CÓDIGO', 'TIEMPO TRABAJO (HR)', 'OBRA GENERAL'],
        obraCol: 'OBRA GENERAL', maestro: 'Maestro de obras' },
      { fileKey: 'repuestosEquipos', instructivo: '12TcS_Mm_eYR2xyUdli27cfVsP3OwEhuidyD8P-Eu9BY', titulo: 'Pedidos y entregas de repuestos', que: 'Entregas de la semana con costo y equipo, en la pestaña REGISTRO ENTREGAS.',
        cols: ['FECHA', 'CÓDIGO 1', 'COSTO', 'OBRA GENERAL'] },
    ] },
  { nombre: 'Romina',    email: 'contabilidad2@grupoingeco.com.ar', frecuencia: 'lunes',
    archivos: [{ fileKey: 'gastosEstructura', instructivo: '1btdqRIgsDz4KzY-hpvmoOgl3BfLz1UqkkYLxFrSr2q8', titulo: 'Gastos de estructura (libro mayor)',
      que: 'Gastos administrativos del mes, cada uno con su cuenta. Cada mes nuevo va en una pestaña nueva con las mismas columnas.',
      cols: ['Cuenta', 'Fecha', 'Numero Comprobante', 'Razón social', 'Debe', 'Haber'] }] },
  { nombre: 'Mauro',     email: 'sueldos01@grupoingeco.com.ar', frecuencia: 'quincena',
    archivos: [{ fileKey: 'tangoFolder', instructivo: '1ppN0EWc83Pg3SlDLQ-5S-TML5c8_meWxUBpJpNTzmB8', carpeta: true, titulo: 'Quincenas TANGO (carpeta)',
      que: 'La quincena que cerró, con la columna OBRA (R) completa. Taller y Planta de Asfalto con su nombre.',
      cols: ['OBRA (columna R)', 'Maquinista (columna S)'],
      obraCol: 'OBRA (columna R)', maestro: 'Maestro de obra' }] },
];

function _urlArchivoRecordatorio(a) {
  const id = FILE_IDS[a.fileKey];
  return a.carpeta ? 'https://drive.google.com/drive/folders/' + id : 'https://docs.google.com/spreadsheets/d/' + id + '/edit';
}

function _htmlRecordatorio(p, fechas) {
  const TZ = 'America/Argentina/Buenos_Aires';
  const hoy = new Date();
  const filas = p.archivos.map(function(a) {
    const iso = fechas[a.fileKey];
    let ult = 'sin dato', viejo = false;
    if (iso) {
      const d = new Date(iso);
      const dias = Math.floor((hoy - d) / 86400000);
      ult = Utilities.formatDate(d, TZ, 'dd/MM/yyyy') + (dias > 0 ? ' (hace ' + dias + ' día' + (dias !== 1 ? 's' : '') + ')' : ' (hoy)');
      viejo = dias > RECORDATORIOS_DIAS_VIEJO;
    }
    return '<tr>' +
      '<td style="padding:10px 12px;border-top:1px solid #e2e8f0;vertical-align:top;"><a href="' + _urlArchivoRecordatorio(a) + '" style="color:#1b3a5c;font-weight:700;text-decoration:none;">' + a.titulo + ' ↗</a>' +
      '<div style="color:#475569;font-size:13px;margin-top:4px;">' + a.que + '</div>' +
      (a.instructivo ? '<div style="font-size:12.5px;margin-top:6px;"><a href="https://docs.google.com/document/d/' + a.instructivo + '/edit" style="color:#1d4ed8;font-weight:700;">📘 Ver instructivo (2 minutos) ↗</a></div>' : '') +
      (a.cols && a.cols.length ? '<div style="color:#475569;font-size:12.5px;margin-top:6px;"><b>Columnas que lee el tablero:</b> ' + a.cols.join(' · ') + '</div>' : '') +
      (a.maestro ? '<div style="color:#475569;font-size:12.5px;margin-top:4px;"><b>Nombre de la obra:</b> en ' + a.obraCol + ', copiado tal cual de la pestaña <b>"' + a.maestro + '"</b> de este mismo archivo (se actualiza sola).</div>' : '') +
      '</td>' +
      '<td style="padding:10px 12px;border-top:1px solid #e2e8f0;vertical-align:top;white-space:nowrap;font-size:13px;color:' + (viejo ? '#b91c1c;font-weight:700' : '#475569') + ';">' +
        ult + (viejo ? '<br>⚠ desactualizado' : '') + '</td>' +
    '</tr>';
  }).join('');
  const intro = p.frecuencia === 'quincena'
    ? 'Cerró la quincena: te pedimos cargar la liquidación en la carpeta de TANGO.'
    : p.frecuencia === 'mensual'
    ? 'Recordatorio mensual: te pedimos actualizar los precios del mes.'
    : 'Recordatorio semanal: te pedimos dejar al día tu archivo antes del miércoles.';
  return '<div style="font-family:Arial,Helvetica,sans-serif;color:#0f172a;max-width:620px;">' +
    '<p style="font-size:15px;">Hola ' + p.nombre + ',</p>' +
    '<p style="font-size:14px;color:#334155;">' + intro + ' Con esa información se arma el Dashboard Ejecutivo.</p>' +
    '<div style="background:#fef2f2;border:1px solid #fecaca;border-radius:8px;padding:10px 14px;margin:0 0 14px;font-size:14px;color:#7f1d1d;">' +
      '<b>Importante:</b> no agregues, borres ni muevas columnas, y no les cambies el título. El tablero las busca por su nombre: si cambian, deja de leer el archivo.' +
    '</div>' +
    '<table style="border-collapse:collapse;width:100%;border:1px solid #e2e8f0;border-radius:8px;">' +
      '<tr style="background:#f8fafc;"><th style="text-align:left;padding:8px 12px;font-size:12px;color:#64748b;">Archivo y qué actualizar</th>' +
      '<th style="text-align:left;padding:8px 12px;font-size:12px;color:#64748b;">Última modificación</th></tr>' +
      filas +
    '</table>' +
    '<div style="background:#f0f7ff;border:1px solid #bfdbfe;border-radius:8px;padding:12px 14px;margin-top:16px;font-size:14px;color:#1e3a5f;">' +
      '<b>Cuando termines de cargar, verificá que se vea en el tablero:</b>' +
      '<ol style="margin:8px 0 0 18px;padding:0;line-height:1.6;">' +
        '<li>Entrá a <a href="' + URL_TABLERO + '" style="color:#1d4ed8;font-weight:700;">' + URL_TABLERO.replace('https://', '') + '</a> con tu cuenta de Google de INGECO.</li>' +
        '<li>Tocá <b>Actualizar datos</b> (arriba a la derecha) y esperá a que termine.</li>' +
        '<li>Recargá la página y revisá que aparezca lo que cargaste.</li>' +
      '</ol>' +
    '</div>' +
    '<p style="font-size:13px;color:#64748b;margin-top:16px;">Gracias.<br>INGECO · Dashboard Ejecutivo</p>' +
  '</div>';
}

function _enviarRecordatorio(p, fechas) {
  const destino = RECORDATORIOS_MODO_PRUEBA ? RECORDATORIOS_PRUEBA_A : p.email;
  if (!destino) { Logger.log('Recordatorio a ' + p.nombre + ': sin mail cargado, no se envía'); return false; }
  const asunto = (RECORDATORIOS_MODO_PRUEBA ? '[PRUEBA → ' + p.nombre + (p.email ? ' <' + p.email + '>' : ' (sin mail)') + '] ' : '') +
    (p.frecuencia === 'quincena' ? 'INGECO · Cargar la quincena en TANGO'
      : p.frecuencia === 'mensual' ? 'INGECO · Actualizar precios del mes'
      : 'INGECO · Actualizar ' + p.archivos.map(function(a) { return a.titulo; }).join(' y '));
  const opts = { name: 'INGECO Dashboard', htmlBody: _htmlRecordatorio(p, fechas) };
  if (RECORDATORIOS_CC && !RECORDATORIOS_MODO_PRUEBA) opts.cc = RECORDATORIOS_CC;
  MailApp.sendEmail(destino, asunto, 'Recordatorio de actualización de archivos del Dashboard INGECO.', opts);
  Logger.log('Recordatorio enviado: ' + p.nombre + ' → ' + destino);
  return true;
}

// Corre todos los días a las 8 (trigger); decide si hoy toca y a quién.
function enviarRecordatorios() {
  const TZ = 'America/Argentina/Buenos_Aires';
  const diaSemana = parseInt(Utilities.formatDate(new Date(), TZ, 'u'), 10); // 1 = lunes
  const diaMes = parseInt(Utilities.formatDate(new Date(), TZ, 'd'), 10);
  const toca = RECORDATORIOS.filter(function(p) {
    return (p.frecuencia === 'lunes' && diaSemana === 1)
      || (p.frecuencia === 'mensual' && diaSemana === 1 && diaMes <= 7)
      || (p.frecuencia === 'quincena' && (diaMes === 3 || diaMes === 17));
  });
  if (!toca.length) { Logger.log('Recordatorios: hoy no corresponde enviar'); return; }
  const fechas = leerFechasFuentes();
  toca.forEach(function(p) { try { _enviarRecordatorio(p, fechas); } catch (e) { Logger.log('Recordatorio ' + p.nombre + ' error: ' + e); } });
}

// Manda AHORA todos los recordatorios (en modo prueba, todos a RECORDATORIOS_PRUEBA_A).
function probarRecordatorios() {
  const fechas = leerFechasFuentes();
  RECORDATORIOS.forEach(function(p) { _enviarRecordatorio(p, fechas); });
}

function crearTriggerRecordatorios() {
  ScriptApp.getProjectTriggers()
    .filter(function(t) { return t.getHandlerFunction() === 'enviarRecordatorios'; })
    .forEach(function(t) { ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('enviarRecordatorios').timeBased().everyDays(1).atHour(8).inTimezone('America/Argentina/Buenos_Aires').create();
  Logger.log('Trigger de recordatorios creado: todos los días a las 8 (envía lunes, primer lunes del mes y días 3/17)');
}
