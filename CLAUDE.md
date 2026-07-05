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

## Autenticación del dashboard

Login simple client-side (`const ROLES = {...}` en `index.html`, cerca de `doLogin()`). Dos roles: `directorio` y `administracion`, con contraseñas hardcodeadas en el JS (no es seguridad real, es solo para uso interno). Para testear sin loguearse manualmente en el navegador de Preview:
```js
sessionStorage.setItem('ingeco_auth','1');
sessionStorage.setItem('ingeco_role','directorio');
location.reload();
```

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

## Otras cosas no obvias del dominio

- **OC Insumos**: hay que distinguir obras "INT" (internas: Predio Warnes, Planta de Asfalto, Planta de Trituración — no son obras de construcción real) de obras reales. `getOCPlantaInterna()` filtra solo las internas; `getOCPlanta()` excluye las internas (para el total de obras). El campo `obra` de cada ítem de OC debe leerse de la columna **OBRA GENERAL** de la planilla de Guillermo Konicek, no de "OBRA PARTICULAR" (son columnas distintas con nombres parecidos, `_findCol` matchea por substring así que hay que priorizar `'obra general'` antes que `'obra'` en el array de keywords).
- **MO prorrateada (mano de obra)**: cuando no hay dato real cargado del mes en TANGO, se estima tomando el último mes con datos y prorrateando por días transcurridos (`getMOEstimado()` / `getMOEstimadoPlanta()`, ambas envoltorios de `getMOEstimadoGenerico()`). Por obra, se prorratea por tn de asfalto caliente despachado a esa obra sobre el total del mes.
- **`fmtM(n)`**: formatea en millones con coma decimal y punto de miles (estilo es-AR), ej. `$5.068,4M`.
