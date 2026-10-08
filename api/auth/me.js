import { sessionFromRequestHeaders, OBRAS_EDITORES } from '../../lib/session.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const s = await sessionFromRequestHeaders(req.headers);
  if (!s) return res.status(401).json({ status: 'error', message: 'No autorizado' });
  res.status(200).json({ status: 'ok', email: s.email, role: s.role, editaObras: OBRAS_EDITORES.has(s.email) });
}
