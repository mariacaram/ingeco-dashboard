// Sesión del tablero: cookie HttpOnly con un JWT firmado (HS256) por el
// servidor. La usan las funciones de /api y el middleware (Edge runtime),
// por eso solo depende de `jose` y de APIs web estándar (sin Node-only).
import { SignJWT, jwtVerify } from 'jose';

// Quién puede entrar y con qué rol. Los mails no son secretos: el secreto es
// que Google confirme la identidad (ID token firmado) y la firma de la sesión.
export const ALLOWED_USERS = {
  'marcoskatz@grupoingeco.com.ar': 'directorio',
  'adriankoss@grupoingeco.com.ar': 'directorio',
  'mariacaram94@gmail.com':        'directorio',
  'adegregorio@grupoingeco.com.ar': 'directorio',      // Agustín — Obras a cobrar, Maestro, precios
  'sergiocangemi@grupoingeco.com.ar': 'directorio',    // Sergio — Obras a cobrar, Maestro
  'nicobdallagata@gmail.com':       'administracion',  // Nico — Partes diarios, Repuestos (no ve sueldos)
};

export const COOKIE_NAME = '__Host-ingeco_session'; // prefijo __Host-: solo https, Path=/, sin Domain
export const SESSION_HOURS = 12;
const ISSUER = 'ingeco-dashboard';

function secretKey() {
  const s = process.env.SESSION_SECRET || '';
  if (s.length < 32) throw new Error('SESSION_SECRET no configurado (mínimo 32 caracteres)');
  return new TextEncoder().encode(s);
}

export function roleFor(email) {
  const e = String(email || '').trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(ALLOWED_USERS, e) ? ALLOWED_USERS[e] : null;
}

export async function signSession(email, role) {
  return new SignJWT({ role })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(email)
    .setIssuer(ISSUER)
    .setAudience(ISSUER)
    .setIssuedAt()
    .setExpirationTime(SESSION_HOURS + 'h')
    .sign(secretKey());
}

// Devuelve { email, role } o null. Vuelve a chequear el allowlist: si un mail
// se saca de la lista, sus sesiones vigentes dejan de servir al instante.
export async function verifySession(token) {
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, secretKey(), { issuer: ISSUER, audience: ISSUER, algorithms: ['HS256'] });
    const email = String(payload.sub || '').toLowerCase();
    const role = roleFor(email);
    if (!role) return null;
    return { email, role };
  } catch {
    return null;
  }
}

export function readCookie(cookieHeader, name) {
  const h = cookieHeader || '';
  for (const part of h.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    if (part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}

export function sessionCookie(token) {
  const maxAge = SESSION_HOURS * 3600;
  return `${COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}

export function clearCookie() {
  return `${COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

export async function sessionFromRequestHeaders(headers) {
  const cookie = typeof headers.get === 'function' ? headers.get('cookie') : headers.cookie;
  return verifySession(readCookie(cookie, COOKIE_NAME));
}
