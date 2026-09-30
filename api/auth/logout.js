import { clearCookie } from '../../lib/session.js';

export default function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ status: 'error', message: 'Método no permitido' });
  res.setHeader('Set-Cookie', clearCookie());
  res.status(200).json({ status: 'ok' });
}
