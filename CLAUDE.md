# INGECO — Dashboard Ejecutivo

Dashboard de una sola página (SPA) para el directorio de INGECO. Muestra contribución marginal por obra, estado financiero (cobros), planta de asfalto, taller mecánico, rentabilidad, etc. Desplegado en Vercel: **ingeco-dashboard.vercel.app**.

## Arquitectura (3 piezas, en 2 repos/plataformas distintas)

1. **`index.html`** — TODO el frontend (HTML+CSS+JS inline, un solo archivo, ~330KB). Esta es la ÚNICA fuente de verdad del frontend. Se sirve como raíz del sitio en Vercel.
   - **`dashboard_ingeco.html` es un archivo LEGACY, no se usa ni se sirve.** No editarlo — es fácil confundirse por el nombre.
2. **`apps_script_ingeco.gs`** — backend en Google Apps Script. Lee Google Sheets (OC insumos, remitos de asfalto, cobros, MO/TANGO, alquiler de equipos, ajuste de stock, etc.), arma un JSON grande (`buildData()`) y lo expone vía `doGet()` como Web App.
3. **`api/datos.js`** — proxy serverless de Vercel. El navegador llama a `/api/datos` (evita problemas de CORS y de redirect multi-cuenta de Google) y este proxy reenvía al Web App de Apps Script.

## ⚠️ Flujo de deploy — la parte que más confunde

- **`index.html` (y `api/datos.js`, `vercel.json`)**: al hacer `git push` a `main`, Vercel autodespliega. No hace falta nada más.
- **`apps_script_ingeco.gs`**: un `git push` **NO actualiza nada en producción**. GitHub y Google Apps Script son sistemas totalmente independientes. Para que un cambio en el `.gs` tenga efecto real:
  1. Abrir el proyecto en script.google.com (vinculado a la cuenta de Google de INGECO).
  2. Pegar el contenido actualizado de `apps_script_ingeco.gs`.
  3. **Implementar → Administrar implementaciones → editar (lápiz) la implementación existente → Nueva versión → Implementar.**
     - Usar "editar implementación existente", NO "nueva implementación" — eso último cambiaría la URL del Web App y rompería `APPS_SCRIPT_URL` tanto en `index.html` como en `api/datos.js`.
  4. Ejecutar manualmente la función `actualizarNocturno()` desde el editor para refrescar el caché (`PropertiesService`) que usa `?cache=1`.
- Siempre que se toque el `.gs`, avisarle al usuario explícitamente que falta este paso manual — es el error más común en este proyecto.

## URL del Apps Script

Está hardcodeada en dos lugares (deben coincidir siempre):
- `index.html` → `const APPS_SCRIPT_URL = '...'`
- `api/datos.js` → `const APPS_SCRIPT_URL = '...'`

## Autenticación del dashboard (Google Sign-In + sesión de servidor)

Desde sep-2026 NO hay contraseñas en el frontend. El acceso lo controla el servidor:

- **`lib/session.js`**: allowlist `ALLOWED_USERS` (mail → rol `directorio`/`administracion`), firma y verificación del JWT de sesión (HS256 con `SESSION_SECRET`), cookie `__Host-ingeco_session` (HttpOnly, Secure, SameSite=Lax, 12 h).
- **`middleware.js`** (Vercel Edge): sin sesión válida no se sirve NADA salvo `/login.html`, `/Logo.png` y `/api/auth/*`. Páginas → redirect a login; `/api/*` → 401.
- **`login.html`**: botón "Sign in with Google" (Google Identity Services). El ID token va a `POST /api/auth/login`, que lo verifica contra las claves públicas de Google (`jose`), exige `email_verified` y mail en el allowlist, y emite la cookie.
- **`api/auth/me.js`** devuelve `{email, role}`; `index.html` lo llama al arrancar (`bootAuth`) para aplicar el rol. `api/auth/logout.js` borra la cookie.
- **`api/datos.js`**: exige sesión, solo reenvía parámetros conocidos, agrega `key=APPS_SCRIPT_KEY` y para escrituras (`action=ajusteStock`) exige el header `X-Requested-With: ingeco-dashboard` (anti-CSRF). El navegador nunca llama a Apps Script directo (`APPS_SCRIPT_URL` en index.html es `/api/datos`).
- **`doGet` del `.gs`** rechaza todo pedido cuya `key` no coincida con la huella `API_KEY_SHA256` del código (o con la Script Property `API_KEY` si existiera). No usar la pantalla "Propiedades del script" para la clave: al guardar regraba también el caché (>9 KB por clave) y falla en silencio. Para rotar: clave nueva en Vercel (`APPS_SCRIPT_KEY`) + huella nueva en el `.gs` (`printf '%s' CLAVE | shasum -a 256`).
- `vercel.json`: CSP, HSTS, nosniff, X-Frame-Options DENY, no-store. `.vercelignore` evita desplegar el `.gs`, el HTML legacy, demos y docs.

Variables de entorno en Vercel (Settings → Environment Variables, Production): `GOOGLE_CLIENT_ID` (OAuth Client ID tipo Web, con origen autorizado `https://ingeco-dashboard.vercel.app`), `SESSION_SECRET` (≥32 caracteres aleatorios), `APPS_SCRIPT_KEY` (su SHA-256 es `API_KEY_SHA256` en el `.gs`). Sin `GOOGLE_CLIENT_ID` el login muestra un aviso y nadie entra.

Regla (oct-2026): solo cuentas @grupoingeco.com.ar, salvo María (mariacaram94@gmail.com, y mindloopia.auth@gmail.com como cuenta de prueba del rol Administración) y Gonzalo (cpngonzalo@gmail.com). Para dar acceso a alguien: agregar el mail en `ALLOWED_USERS` y pushear. Además hay que agregarlo como usuario de prueba en Google Cloud (proyecto ingeco-dashboard → Google Auth Platform → Público) y sacar ahí a quien se quite. Para sacarlo: quitarlo — sus sesiones vigentes dejan de servir al instante porque `verifySession` vuelve a chequear el allowlist.

Para testear la UI en el preview local (sin Vercel no hay middleware ni cookie): el `bootAuth` va a redirigir a `/login.html` porque `/api/auth/me` no existe. Para probar solo la UI, en la consola del preview: `document.body.classList.add('authed'); applyRole('directorio','test')` después de anular la redirección (o inyectar datos antes de que corra `bootAuth`).

## Cómo levantar el preview local

No hay servidor propio — es un HTML estático. Usar `mcp__Claude_Preview__preview_start` con este `.claude/launch.json` (ya existe en el repo):
```json
{
  "version": "0.0.1",
  "configurations": [
    { "name": "static", "runtimeExecutable": "npx", "runtimeArgs": ["-y","serve","-l","5500","."], "port": 5500 }
  ]
}
```
Sin conexión a Drive/Apps Script, el dashboard muestra "Datos locales — presioná Actualizar datos para conectar". Para probar UI con datos, inyectar mocks vía `preview_eval` (asignar directamente a las variables globales `stockData`, `COBROS_ESTEBAN`, `OC_INSUMOS`, etc. y llamar al `render*()` correspondiente).

## Validar sintaxis antes de pushear

`index.html` no tiene build step. Antes de commitear, chequear que el JS inline no tenga errores de sintaxis:
```bash
node -e "
const fs = require('fs');
const html = fs.readFileSync('index.html', 'utf8');
const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
scripts.forEach((s, i) => { try { new Function(s); } catch(e) { console.log('block', i, 'ERROR:', e.message); } });
"
```
Para el `.gs`, copiarlo a un `.js` temporal y correr `node --check` (Node no reconoce la extensión `.gs`).

## Modelo de datos: stock de asfalto (el más delicado)

Vive en `leerStockAsfalto()` (`.gs`) y `renderStockDisplay()` / `openStockDetallePanel()` (`index.html`). Hay **dos stocks independientes**, cada uno con su propio "checkpoint" de ajuste manual (fecha + valor):

- **Asfalto (materia prima)**: se ajusta a mano (Agustín). Sube con ingresos del formulario, baja con producción (tanto de mezcla caliente como de frío, cada tn de mezcla producida consume 1/20 tn de asfalto).
- **Frío terminado (buffer en el predio)**: también se ajusta a mano. Las salidas de remito tipo "frío" se sirven primero de este buffer; si el buffer no alcanza, el excedente se produce en el momento y **también** descuenta asfalto (nunca queda negativo, el piso es 0).
- Cada ajuste manual reinicia el cálculo de ingresos/consumo de ESE stock desde su propia fecha — la hoja "Ajuste de stock" tiene una columna F con el tipo (`asfalto`/`frio`); filas viejas sin esa columna se leen como `asfalto`.
- El endpoint de ajuste (`action=ajusteStock`) usa `fetchJSONP()` (fetch con fallback a `<script>` JSONP) — no un JSONP puro — porque el JSONP puro es frágil ante bloqueadores/extensiones del navegador.

## Caché del Apps Script y cómo pegar el `.gs` (aprendido sep-2026)

- El caché vive en Script Properties (cuota **500 KB en total**). Cada bloque se guarda **comprimido** (gzip+base64 con prefijo `gz:`) vía `_cacheSet`/`_cacheGet`; sin compresión las OC con detalle fila por fila superaban la cuota y el bloque `_oc` quedaba en `{}`. Nunca volver a `PROPS.setProperty(JSON.stringify(...))` directo.
- `exec?action=diag&key=API_KEY` devuelve nombre y tamaño de cada clave guardada más una prueba de escritura comprimida; `action=limpiar` borra claves que no son del caché actual. Es la forma rápida de diagnosticar "sin dato" en el tablero.
- Al copiar el `.gs` al portapapeles desde la terminal usar `LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8 pbcopy < apps_script_ingeco.gs`. Sin eso los acentos llegan corruptos al editor (`'ÓRDENES'` deja de coincidir y el lector de OC cae a otra pestaña).
- Un `doGet` en vivo (sin `cache=1`, con `key`) reconstruye y guarda el caché: sirve para forzar la actualización sin tocar el editor. El trigger `actualizarHorario` hace lo mismo cada hora.
- Los triggers corren el código **guardado**; la Web App corre la **versión implementada**. Después de pegar hay que hacer las dos cosas: guardar y publicar nueva versión.

## Recordatorios por mail (oct-2026)

Al final del `.gs`: `RECORDATORIOS` (persona, mail, frecuencia `lunes`/`mensual`/`quincena`, archivos). Hoy: Agustín y Sergio (Obras a cobrar + Maestro), Agustín mensual (precios), Guillermo (OC), Roberto (remitos), Nico vía mantenimiento@ (partes diarios + repuestos), Romina (gastos de estructura), Mauro (TANGO, días 3 y 17). Esteban (cobros). Todos con copia a Gonzalo (`RECORDATORIOS_CC`). Cada archivo del mail enlaza su instructivo (campo `instructivo` = ID de un Google Doc "v2 · oct-2026" en las carpetas de Instructivos de Drive; los .docx/.pdf viejos quedaron como histórico y tienen columnas desactualizadas). La pestaña Manual del tablero enlaza los mismos Docs. Cada persona con mail en `RECORDATORIOS` también tiene que estar en `ALLOWED_USERS` y como usuario de prueba de la app OAuth en Google Cloud (proyecto ingeco-dashboard → Público), si no, no puede entrar. `enviarRecordatorios()` corre por trigger diario a las 8 (`crearTriggerRecordatorios()`) y manda los lunes y, a Mauro, los días 3 y 17. Salen desde la cuenta dueña del script (María; pasará a Gonzalo). Con `RECORDATORIOS_MODO_PRUEBA = true` todo le llega a `RECORDATORIOS_PRUEBA_A` con el destinatario real en el asunto; desde el 7-oct-2026 está en `false` (envío real). El código de mails no necesita publicar versión nueva de la Web App (los triggers corren el código guardado). El manifiesto (`appsscript.json`, solo en el editor) declara `oauthScopes` explícitos: para mandar mails hubo que agregar `https://www.googleapis.com/auth/script.send_mail` (oct-2026) y María tuvo que autorizarlo ejecutando una función desde el editor. Si se agrega otro servicio de Google, sumar su scope ahí o falla con "Specified permissions are not sufficient".

## Precios cargados desde el tablero (✎) — planilla "Ajustes del tablero" (oct-2026)

Antes vivían solo en `localStorage` y se perdían al cambiar de navegador o cuenta. Ahora se guardan en la planilla `FILE_IDS.ajustesTablero` (carpeta TABLERO INGECO) vía `action=guardarAjuste` (proxy con header anti-CSRF; el usuario lo pone el servidor desde la sesión). Es un historial: una fila por cambio, gana la última de cada (Tipo, Clave, Desde); Valor vacío = borrado. `doGet` adjunta `ajustesTablero` en vivo incluso con `cache=1`. En el front, `aplicarAjustesServidor()` reemplaza las copias locales y sube una vez lo que un navegador tenga y la planilla no (migración). Tipos: `provision`, `asfalto`, `asfaltoUsd`, `ingresosPlanta`.

## Otras cosas no obvias del dominio

- **OC Insumos**: hay que distinguir obras "INT" (internas: Predio Warnes, Planta de Asfalto, Planta de Trituración — no son obras de construcción real) de obras reales. `getOCPlantaInterna()` filtra solo las internas; `getOCPlanta()` excluye las internas (para el total de obras). El campo `obra` de cada ítem de OC debe leerse de la columna **OBRA GENERAL** de la planilla de Guillermo Konicek, no de "OBRA PARTICULAR" (son columnas distintas con nombres parecidos, `_findCol` matchea por substring así que hay que priorizar `'obra general'` antes que `'obra'` en el array de keywords).
- **MO prorrateada (mano de obra)**: cuando no hay dato real cargado del mes en TANGO, se estima tomando el último mes con datos y prorrateando por días transcurridos (`getMOEstimado()` / `getMOEstimadoPlanta()`, ambas envoltorios de `getMOEstimadoGenerico()`). Por obra, se prorratea por tn de asfalto caliente despachado a esa obra sobre el total del mes.
- **`fmtM(n)`**: formatea en millones con coma decimal y punto de miles (estilo es-AR), ej. `$5.068,4M`.
