// Público: el login necesita el Client ID de Google (no es un secreto).
export default function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.status(200).json({ clientId: process.env.GOOGLE_CLIENT_ID || '' });
}
