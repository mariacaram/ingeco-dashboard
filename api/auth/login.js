// Recibe el ID token que emite Google Identity Services en el navegador,
// lo verifica contra las claves públicas de Google y, si el mail está en el
// allowlist, emite la cookie de sesión. Nunca se confía en nada que mande
// el cliente salvo la firma de Google.
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { roleFor, signSession, sessionCookie } from '../../lib/session.js';

const GOOGLE_JWKS = createRemoteJWKSet(new URL('https://www.googleapis.com/oauth2/v3/certs'));

// Limitador básico por IP (por instancia): frena fuerza bruta / abuso del endpoint.
const hits = new Map();
function rateLimited(ip) {
  const now = Date.now();
  const w = hits.get(ip) || { n: 0, t: now };
  if (now - w.t > 60000) { w.n = 0; w.t = now; }
  w.n++; hits.set(ip, w);
  return w.n > 20;
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ status: 'error', message: 'Método no permitido' });

  // CSRF: el pedido tiene que venir de nuestra propia página
  const host = req.headers['x-forwarded-host'] || req.headers.host || '';
  const origin = req.headers.origin || '';
  if (!origin || new URL(origin).host !== host) return res.status(403).json({ status: 'error', message: 'Origen no permitido' });

  const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'ip';
  if (rateLimited(ip)) return res.status(429).json({ status: 'error', message: 'Demasiados intentos, esperá un minuto' });

  const clientId = process.env.GOOGLE_CLIENT_ID;
  if (!clientId) return res.status(500).json({ status: 'error', message: 'GOOGLE_CLIENT_ID no configurado' });

  const credential = req.body && typeof req.body.credential === 'string' ? req.body.credential : '';
  if (!credential || credential.length > 4096) return res.status(400).json({ status: 'error', message: 'Credencial inválida' });

  let payload;
  try {
    ({ payload } = await jwtVerify(credential, GOOGLE_JWKS, {
      issuer: ['https://accounts.google.com', 'accounts.google.com'],
      audience: clientId,
      maxTokenAge: '10 minutes',
    }));
  } catch (err) {
    return res.status(401).json({ status: 'error', message: 'Google no validó la identidad' });
  }

  const email = String(payload.email || '').trim().toLowerCase();
  if (!email || payload.email_verified !== true) return res.status(401).json({ status: 'error', message: 'Mail sin verificar' });

  const role = roleFor(email);
  if (!role) {
    // Respuesta uniforme: no revela qué mails sí están habilitados
    return res.status(403).json({ status: 'error', message: 'Esta cuenta no tiene acceso al tablero', email });
  }

  const token = await signSession(email, role);
  res.setHeader('Set-Cookie', sessionCookie(token));
  res.status(200).json({ status: 'ok', email, role });
}
