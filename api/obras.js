// Alta y edición de obras desde el tablero (oct-2026). Recibe el formulario
// como JSON y lo reenvía al Apps Script (doPost) con la clave secreta.
// Solo pueden operar los mails de OBRAS_EDITORES; el usuario que queda en el
// historial es el de la sesión, nunca el que diga el cuerpo.
import { sessionFromRequestHeaders, OBRAS_EDITORES } from '../lib/session.js';

const APPS_SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbwXe_MLjncMNA4-v8GLfmvhQFZG0cuMeXzSHIBccBIUUTTpXEvJuLhek-mC_S4twVCu9A/exec';
const OPS_OK = new Set(['altaObra', 'agregarCert', 'editarCert', 'borrarCert', 'estadoCert']);
const CAMPOS_OK = ['op', 'nombre', 'cliente', 'oficina', 'tipo', 'obra', 'certNombre', 'certNombreAntes',
  'estado', 'estadoObra', 'montoTotal', 'anticipo', 'montoCert', 'periodo', 'fila'];

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ status: 'error', message: 'Método no permitido' });
  try {
    const session = await sessionFromRequestHeaders(req.headers);
    if (!session) return res.status(401).json({ status: 'error', message: 'No autorizado' });
    if (!OBRAS_EDITORES.has(session.email)) return res.status(403).json({ status: 'error', message: 'Tu usuario no puede cargar obras' });
    if (req.headers['x-requested-with'] !== 'ingeco-dashboard') return res.status(403).json({ status: 'error', message: 'Origen no permitido' });

    const body = (req.body && typeof req.body === 'object') ? req.body : {};
    if (!OPS_OK.has(body.op)) return res.status(400).json({ status: 'error', message: 'Operación no permitida' });
    const limpio = { action: 'obras', usuario: session.email, key: process.env.APPS_SCRIPT_KEY || '' };
    for (const k of CAMPOS_OK) {
      if (body[k] == null) continue;
      limpio[k] = String(body[k]).slice(0, 300);
    }

    const upstream = await fetch(APPS_SCRIPT_URL, {
      method: 'POST',
      redirect: 'follow',
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'IngecoDashboardProxy/2.0' },
      body: JSON.stringify(limpio),
    });
    if (!upstream.ok) return res.status(502).json({ status: 'error', message: 'Apps Script HTTP ' + upstream.status });
    let data;
    try { data = JSON.parse(await upstream.text()); }
    catch { return res.status(502).json({ status: 'error', message: 'Apps Script no devolvió JSON' }); }
    res.status(200).json(data);
  } catch (err) {
    res.status(500).json({ status: 'error', message: 'Error interno' });
  }
}

export const config = { maxDuration: 60 };
