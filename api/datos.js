// Proxy serverless: el navegador llama a /api/datos y este endpoint
// pide los datos a Apps Script desde el servidor (sin contexto multi-cuenta de Google).
// Evita el problema de redirect /u/N/ y el bloqueo CORS.

const APPS_SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbwXe_MLjncMNA4-v8GLfmvhQFZG0cuMeXzSHIBccBIUUTTpXEvJuLhek-mC_S4twVCu9A/exec';

export default async function handler(req, res) {
  try {
    const cache = req.query.cache === '1' ? '?cache=1' : '';
    const url = APPS_SCRIPT_URL + cache;

    const upstream = await fetch(url, {
      method: 'GET',
      redirect: 'follow',
      headers: { 'User-Agent': 'IngecoDashboardProxy/1.0' },
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
      res.status(502).json({ status: 'error', message: 'Apps Script no devolvió JSON', preview: text.slice(0, 200) });
      return;
    }

    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.status(200).json(data);
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
}

export const config = { maxDuration: 60 };
