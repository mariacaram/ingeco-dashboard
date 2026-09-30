// Proxy serverless: el navegador llama a /api/datos y este endpoint pide los
// datos a Apps Script desde el servidor. Exige sesión válida (además del
// middleware, por defensa en profundidad), solo reenvía parámetros conocidos
// y agrega la clave secreta que Apps Script exige (APPS_SCRIPT_KEY).
import { sessionFromRequestHeaders } from '../lib/session.js';

const APPS_SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbwXe_MLjncMNA4-v8GLfmvhQFZG0cuMeXzSHIBccBIUUTTpXEvJuLhek-mC_S4twVCu9A/exec';
const PARAMS_OK = ['cache', 'action', 'tipo', 'stockAntes', 'stockNuevo', 'usuario', 'fecha'];
const ACTIONS_OK = new Set(['ajusteStock']);

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  try {
    const session = await sessionFromRequestHeaders(req.headers);
    if (!session) return res.status(401).json({ status: 'error', message: 'No autorizado' });

    const p = new URLSearchParams();
    for (const k of PARAMS_OK) {
      const v = req.query[k];
      if (v != null && v !== '') p.set(k, String(v).slice(0, 200));
    }
    const action = p.get('action');
    if (action) {
      if (!ACTIONS_OK.has(action)) return res.status(400).json({ status: 'error', message: 'Acción no permitida' });
      // Escrituras: solo desde fetch() de la propia página (un link o un form
      // no pueden poner este header) — evita CSRF por navegación.
      if (req.headers['x-requested-with'] !== 'ingeco-dashboard') return res.status(403).json({ status: 'error', message: 'Origen no permitido' });
      p.set('usuario', session.email);
    }
    if (process.env.APPS_SCRIPT_KEY) p.set('key', process.env.APPS_SCRIPT_KEY);

    const url = APPS_SCRIPT_URL + (p.toString() ? '?' + p.toString() : '');
    const upstream = await fetch(url, {
      method: 'GET',
      redirect: 'follow',
      headers: { 'User-Agent': 'IngecoDashboardProxy/2.0' },
    });

    if (!upstream.ok) {
      res.status(502).json({ status: 'error', message: 'Apps Script HTTP ' + upstream.status });
      return;
    }

    const text = await upstream.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      res.status(502).json({ status: 'error', message: 'Apps Script no devolvió JSON' });
      return;
    }
    res.status(200).json(data);
  } catch (err) {
    res.status(500).json({ status: 'error', message: 'Error interno' });
  }
}

export const config = { maxDuration: 60 };
