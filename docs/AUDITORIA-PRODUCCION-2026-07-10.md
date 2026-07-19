# Auditoría para producción — XRP Analytics Dashboard — 2026-07-10

Revisor: Fable. Objetivo: sacarlo a producción con seguridad. Verificado leyendo el código real (server.js, lib/auth.js, lib/db.js, public/app.js, index.html, package.json, .env, .gitignore) y **arrancando el servidor** (Node v22.22.3): levanta, degrada con elegancia sin red, y `/api/data` responde **401 sin sesión** (auth OK).

## Veredicto

El proyecto está **bien construido** para lo que es: arquitectura clara, concurrencia de escritura resuelta (`withDataFile`), auth con scrypt correcta, degradación elegante, honestidad de datos ejemplar. **Pero NO está listo para exponerse a internet tal cual.** Hay **1 fallo de seguridad crítico (XSS)** y varias piezas que un despliegue público necesita y que hoy faltan. Con los P0 y P1 resueltos (1–2 días de trabajo), es publicable con confianza.

Contexto que condiciona todo: hoy es un dashboard **single-user/self-hosted en localhost**. "Producción" para ti = detrás de Cloudflare Tunnel en Kali (como careflow/kryndel). Priorizo con ese destino.

---

## P0 — BLOQUEANTES (arreglar antes de exponer)

### 1. XSS almacenado vía titulares de noticias — CRÍTICO
`public/app.js` (~línea 566-618) construye las tarjetas de noticias con `newsContainer.innerHTML` e **interpola `news.title` y la descripción sin escapar**. `cleanDesc` solo hace `.replace(/<[^>]*>?/gm,'')` (quita tags, pero no neutraliza entidades ni atributos rotos), y `news.title` va **directo**. La fuente es externa (CryptoPanic / RSS de Cointelegraph): un titular con `<img src=x onerror=alert(document.cookie)>` ejecutaría JS en tu sesión.
- **Por qué importa:** aunque la cookie es HttpOnly (el token no se roba por JS), un XSS puede disparar acciones autenticadas (cambiar umbral, ajustes) y leer todo lo que ves. Con más usuarios, es escalada directa.
- **Desarrollo:** añadir un helper `escapeHtml(s)` (5 líneas: reemplaza `& < > " '`) y aplicarlo a **todo** dato de origen externo antes de interpolar: `news.title`, `news.description`, `news.source`, cualquier campo de `newsFeed`, y revisar los otros 72 usos de `innerHTML` marcando los que tocan datos no controlados (nombres de wallet, símbolos de moneda vía API, etc.). Alternativa más robusta para las tarjetas: construir con `textContent`/`createElement` en vez de plantilla de string.
- **DoD:** un titular de prueba con `<script>`/`<img onerror>` se muestra como texto literal; test manual documentado.

### 2. Sin cabeceras de seguridad (CSP, X-Frame-Options, etc.)
No hay `helmet` ni cabeceras equivalentes. Sin `Content-Security-Policy` el XSS del punto 1 no tiene contención; sin `X-Frame-Options`/`frame-ancestors` el dashboard es clickjackeable.
- **Desarrollo:** como el proyecto es cero-dependencias, añadir un middleware propio (20 líneas) que ponga: `Content-Security-Policy` (permitiendo `self` + el CDN de Chart.js — o mejor, self-hostear Chart.js y cerrar la CSP a `self`), `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `Strict-Transport-Security` (ya que irá tras HTTPS del túnel). Si aceptas UNA dependencia, `helmet` lo hace de fábrica — decisión tuya vs la filosofía cero-build.
- **DoD:** las cabeceras aparecen en la respuesta; la CSP no rompe Chart.js ni la app.

### 3. Cookie `Secure` al exponer fuera de localhost
`lib/auth.js` emite la cookie **sin `Secure`** a propósito (documentado para localhost). En producción tras HTTPS hay que activarlo o la cookie de sesión viaja sin protección de transporte.
- **Desarrollo:** `sessionCookie()` debe añadir `Secure` cuando `NODE_ENV=production` (o una env `PUBLIC_HTTPS=1`). Mantener el comportamiento localhost para dev. Verificar que SameSite=Strict no rompa nada tras el túnel (no debería).
- **DoD:** en modo producción la cabecera `Set-Cookie` incluye `Secure`.

### 4. `trust proxy` ausente → rate-limit e IP inútiles tras el túnel
El rate-limit de login (`lib/auth.js`) y los logs usan `req.ip`. Detrás de Cloudflare Tunnel/reverse proxy, `req.ip` será la IP del proxy (la misma para todos) salvo que Express confíe en `X-Forwarded-For`. Resultado: o bloqueas a todos a la vez, o el rate-limit no distingue atacantes.
- **Desarrollo:** `app.set('trust proxy', 1)` (o el nº de saltos real) y verificar que `req.ip` refleja la IP real del cliente vía `X-Forwarded-For` que inyecta Cloudflare. Ajustar el rate-limit para que opere sobre esa IP.
- **DoD:** dos clientes distintos tras el túnel tienen `req.ip` distinto en los logs.

---

## P1 — IMPORTANTES (antes de considerarlo "producción de verdad")

### 5. Robustez del proceso: sin manejo global de errores ni cierre limpio
No hay `process.on('uncaughtException')` ni `unhandledRejection` ni manejo de `SIGTERM`/`SIGINT`. Un rechazo no capturado en un fetcher puede tumbar el proceso; sin cierre limpio, pm2 lo reinicia pero puedes dejar un `.tmp` a medias o el WS colgado.
- **Desarrollo:** handlers de `uncaughtException`/`unhandledRejection` que **loguean y NO matan** el proceso (o lo matan de forma controlada para que pm2 reinicie), y un `SIGTERM`/`SIGINT` que cierra el servidor HTTP, el WebSocket del burn watcher y hace flush del `withDataFile` pendiente. Encaja con tu deploy pm2.
- **DoD:** una excepción simulada en un fetcher no tumba el server; `pm2 stop` cierra sin dejar `.tmp`.

### 6. Endpoint `/health` para el túnel y pm2
No existe. Un despliegue tras Cloudflare Tunnel + pm2 necesita un liveness check barato (es literalmente lo que hiciste en careflow).
- **Desarrollo:** `GET /health` **sin `requireAuth`** que devuelva `{ ok, engine, lastCycleAt, burnWatcher: connected|polling, uptime }`. Útil además para ver de un vistazo si los ciclos corren.
- **DoD:** `curl /health` responde 200 con estado real.

### 7. Fetches externos sin timeout → fetchers colgados
`coingeckoFetch()` y la mayoría de fetchers hacen `await fetch(url)` sin `AbortController` (solo hay 1 timeout en todo server.js). Si una API se cuelga (no responde, no falla), el ciclo entero se bloquea y `refreshInProgress` puede quedar atascado.
- **Desarrollo:** envolver todos los `fetch` externos con un helper `fetchWithTimeout(url, ms=10000)` usando `AbortSignal.timeout(ms)` (nativo en Node 22). Aplicar a CoinGecko, Kraken Futures, CryptoPanic, XRPL REST, wallet history.
- **DoD:** un endpoint que no responde aborta a los ~10s y el ciclo continúa; log claro.

### 8. Body sin límite de tamaño
`app.use(express.json())` sin `limit`. Un POST gigante consume memoria innecesariamente (vector DoS trivial).
- **Desarrollo:** `express.json({ limit: '32kb' })` — los bodies del dashboard son diminutos (umbral, ajuste, login).
- **DoD:** un body > límite responde 413.

### 9. Chart.js desde CDN sin versión fija ni SRI
`index.html`: `<script src="https://cdn.jsdelivr.net/npm/chart.js"></script>` — coge **la última versión siempre** (un cambio mayor puede romper el dashboard sin que toques nada) y **sin `integrity`** (si el CDN se compromete, ejecutas su JS).
- **Desarrollo:** o bien fijar versión + SRI (`chart.js@4.4.x` con `integrity="sha384-..."` y `crossorigin`), o mejor **self-hostear** el fichero en `public/vendor/chart.min.js` (coherente con cero-build y permite cerrar la CSP a `self`). Recomiendo self-host.
- **DoD:** el dashboard carga Chart.js desde tu origen o con SRI; CSP sin `unsafe`.

---

## P2 — CALIDAD / HIGIENE (mejoran mantenibilidad, no bloquean)

### 10. No hay repositorio git
`sin repo git` confirmado. Para producción quieres historial, rollback y CI mínima como en tus otros proyectos.
- **Desarrollo:** `git init`, verificar que `.gitignore` cubre `.env`, `data.json`, `history.json`, `dashboard.db*` (lo hace ✓), commit inicial, subir a GitHub privado. Opcional: un workflow de Actions que corra `npm test`.

### 11. Versionado inconsistente
`package.json` dice **2.3.0**, el HTML muestra **2.0** (línea 19) y **2.3** (línea 91), y CLAUDE.md documenta hasta **v2.5**. Cache-busting manual (`app.js?v=23`, `style.css?v=10`, `i18n.js?v=5`) desincronizado del número de versión real.
- **Desarrollo:** una sola fuente de verdad para la versión (package.json), reflejarla en el HTML y, idealmente, derivar el `?v=` de ella. Subir package.json a 2.5.0 para que cuadre con la realidad documentada.

### 12. Carpeta `scratch/` en el árbol de producción
`scratch/` (fix.js, test_binance.js, test_metrics.js, update_data.js) son scripts de desarrollo. No deben viajar al deploy.
- **Desarrollo:** moverlos fuera del árbol servible o añadir `scratch/` a `.gitignore` y excluirlos del paquete de deploy. Confirmar que nada en runtime los requiere.

### 13. Cobertura de tests mínima
Solo `test/calc.test.js` (funciones puras). Bien como base, pero endpoints y auth no tienen tests.
- **Desarrollo:** no es bloqueante para self-host, pero para un CV vale la pena: 3-4 tests de integración (login→cookie→/api/data 200; sin cookie→401; rate-limit tras 8 intentos; settings allowlist rechaza clave arbitraria). Reusa el patrón de careflow (Supertest).

### 14. `data.json` como estado escala a UNA instancia
La arquitectura escribe estado de mercado en `data.json` (bien resuelto con `withDataFile`, pero es un lock **in-process**). Correcto para self-host single-process; **si algún día** corres 2+ instancias tras balanceador, el lock no las coordina.
- **Desarrollo:** no tocar ahora (YAGNI). Solo dejarlo documentado como límite conocido: "single-instance by design". Si escalara, el estado de mercado iría a SQLite/Redis.

---

## Lo que ya está BIEN (no tocar)

- **Concurrencia de escritura** (`withDataFile`): patrón correcto y bien razonado; resolvió un lost-update real. Escritura atómica con `.tmp`+rename ✓.
- **Auth**: scrypt + salt por usuario, `timingSafeEqual`, token en cookie con solo su SHA-256 en BD, HttpOnly + SameSite=Strict, invalidación de sesiones al cambiar contraseña, mensaje de login uniforme (no filtra si el usuario existe). Sólido.
- **Todos los `/api/*` llevan `requireAuth`** salvo `/api/auth/*` (verificado ruta por ruta). Allowlist de settings cerrada (`ALLOWED_SETTINGS` + patrón). 
- **Degradación elegante**: sin red, sin claves, sin node:sqlite → todo tiene fallback y lo dice en consola. Arranque verificado.
- **Honestidad de datos**: badges DEMO, flags `seeded`/`*Estimated`, tope de sanidad de 2B XRP. Ejemplar y coherente con tus convenciones.
- **Cero secretos hardcodeados**; `.env` fuera de git; `.gitignore` correcto.

---

## Plan de acción sugerido (orden)

**Día 1 — seguridad (P0):** #1 escape XSS (medio día, es el importante) → #2 cabeceras/CSP → #3 cookie Secure → #4 trust proxy. Con esto ya es *exponible*.
**Día 2 — robustez (P1):** #5 handlers de proceso + cierre limpio → #6 /health → #7 timeouts en fetch → #8 body limit → #9 Chart.js self-host/SRI. Con esto es *producción de verdad*.
**Cuando puedas (P2):** #10 git+CI → #11 versión única → #12 quitar scratch → #13 tests de integración → #14 documentar límite single-instance.

**Definición de "listo para producción":** P0 + P1 cerrados, `/health` verde tras el túnel, arranque limpio bajo pm2 con `NODE_ENV=production`, y un test manual de XSS que pasa. Los P2 se pueden hacer con el dashboard ya publicado.

> Nota honesta: pediste "estar seguro de que no haya que mejorar nada más". Ninguna auditoría puede garantizar cero mejoras futuras — pero con los P0/P1 resueltos no queda **nada que bloquee** una salida a producción responsable. Los P2 son pulido, no riesgo.
