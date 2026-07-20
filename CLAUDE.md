# CLAUDE.md — Guía para trabajar en este proyecto

> **Marca pública (v2.7)**: la app se publica como **USCashout Markets** en `uscashout.com`
> (panel cripto multi-moneda; XRP sigue siendo la moneda principal y la ruta legacy intacta).

Contexto esencial para que Claude (o cualquier asistente/dev) trabaje en el XRP Analytics Dashboard sin romper nada.

## Qué es

Dashboard local educativo de análisis de XRP. Stack: Node 18+ / Express, sin framework frontend, sin build step. **v2.8: toda la persistencia vive en MongoDB** (antes: `data.json` + SQLite). Frontend en vanilla JS + Chart.js (self-hosted). Todo el texto de UI está en **español**.

> **v2.8 — BD unificada en MongoDB.** Usuarios/sesiones/ajustes Y el estado de mercado (antes `data.json`/`history.json`) viven ahora en Mongo (el mismo Mongo del Kali que ExpedAi/careflow). `lib/mongo.js` conecta; `lib/db.js` (async) hace users/sessions/settings; `lib/state.js` mantiene el estado de mercado en **memoria** (lecturas síncronas) con persistencia debounced a Mongo. El server NO arranca sin Mongo (`MONGODB_URI`/`MONGO_DB` en `.env`). `withDataFile()` conserva su firma pero ahora muta el espejo en memoria + agenda guardado. `mongo-selftest.js` verifica la capa contra un Mongo real.

## Comandos

```bash
npm install        # deps: express, openai, ws
npm start          # node server.js → http://localhost:3000
npm test           # node --test test/calc.test.js (funciones puras de lib/calc.js)
# En Windows: run.bat (arranca con --experimental-sqlite si el Node lo acepta)
```

Verificación: arrancar el servidor y revisar consola + navegador. Hay tests de los cálculos puros (`test/calc.test.js`).

## Mapa del código

| Archivo | Qué contiene | Tamaño aprox. |
|---|---|---|
| `server.js` | TODO el backend: fetchers de APIs, cálculos, endpoints Express, ciclo de refresco, auth wiring | ~2.600 líneas |
| `lib/calc.js` | Funciones PURAS de cálculo (amountToXrp, RSI, MACD/EMA, drawdown, Pearson, VaR) — testeadas sin arrancar el server | ~150 líneas |
| `lib/db.js` | **v2.8** Persistencia MongoDB (async) — colecciones users/sessions/settings/counters. Ids de usuario enteros vía `counters`. Misma API de antes pero async | ~145 líneas |
| `lib/mongo.js` | **v2.8** Conexión única a MongoDB (`connect()`/`getDb()`), `MONGODB_URI`/`MONGO_DB` | ~55 líneas |
| `lib/state.js` | **v2.8** Estado de mercado + histórico en Mongo con espejo en memoria: `readState()`/`readStateRaw()` (copia fresca), `withDataFile()` (muta memoria + persiste debounced), `flush()` | ~110 líneas |
| `lib/auth.js` | **v2.3** Auth: scrypt, sesiones HttpOnly, rate-limit, `requireAuth`, rutas `/api/auth/*` | ~180 líneas |
| `xrplBurnWatcher.js` | Módulo autónomo: WebSocket al XRPL (fallback REST) que trackea `total_coins` y buckets de quema | ~400 líneas |
| `public/app.js` | Renderizado del frontend: `loadDashboardData()` + `render*()` + auth/i18n al final. **v2.4**: bilingüe completo (t(), `_isEn()`, `_pick()`) | ~3.300 líneas |
| `public/i18n.js` | **v2.4** Motor ES/EN: español es la fuente (en el HTML), diccionario solo con overrides EN. `t(clave, esText)` + `data-i18n` | ~420 líneas |
| `public/index.html` | **v2.4** 9 tabs en nav agrupada (Inicio: Resumen · Mercado: Mercado/Noticias/Derivados · Análisis: Análisis/Técnico · On-Chain: Ballenas/Suministro/Quema), overlay de auth, modales | ~700 líneas |
| `public/style.css` | Tema dark glassmorphism, variables en `:root`, componentes al final | ~2.000 líneas |

## Flujo de datos (crítico entenderlo)

1. Al arrancar: seed de mocks si `data.json` no tiene whale data → `sanitizeWhaleData()` (v2.0: purga montos imposibles heredados) → `refreshAllData()` secuencial con delays anti-rate-limit → repite cada 5 min (`setInterval`, con guard `refreshInProgress` contra solapes con el refresh manual).
2. **V2.0 — TODAS las escrituras de `data.json` pasan por `withDataFile(mutator)`**: cola serializada (promesa encadenada) que lee fresco, muta solo el nodo propio y escribe atómico con `safeWriteFile()`. Los fetchers leen sus inputs al inicio como siempre, pero la escritura final es `await withDataFile(d => { d.miNodo = valor; })`. Motivo real: el burn watcher (asíncrono, ~30 s) y los endpoints (`/api/chart`, `/api/wallet-history`) pisaban las escrituras del ciclo (lost update) y dejaban nodos MEZCLADOS de ciclos distintos — se vio en producción como dailyBurn y scenarios contradictorios en la misma pantalla. **Nunca añadas un `safeWriteFile(DATA_FILE, ...)` directo nuevo.**
3. El burn watcher escribe `burnImpact.realtime` cada ~30 s (vía `withDataFile`); `fetchBurnImpactData` preserva el `realtime` más fresco al reescribir su nodo.
4. Frontend: `GET /api/data` cada ~5,1 min + refresco de 30 s cuando el tab Quema en Vivo está activo y visible. `buildDailyBrief()` corre al FINAL de cada ciclo (cruza todos los nodos → tab Resumen).

## Autenticación y BD (v2.3 — leer antes de tocar endpoints)

- **TODOS los `/api/*` (salvo `/api/auth/*`) exigen sesión** con `requireAuth`. Cualquier endpoint nuevo que exponga datos del usuario DEBE llevar `requireAuth`. Sin sesión → 401 → el frontend muestra el overlay de login (`showAuthOverlay()` en app.js).
- **BD (v2.8 — MongoDB)**: `lib/db.js` habla con Mongo (async). Colecciones: `users`, `sessions`, `settings`, `counters` (autoincremento de ids), más `dashboard_state` y `dashboard_history` (estado de mercado, vía `lib/state.js`). El `.env` con `MONGODB_URI` (credenciales del Kali) está en `.gitignore` — NUNCA subir. El server hace `mongo.connect()` + `dbLayer.init()` + `state.init()` en el arranque ANTES de servir; una **puerta `mongoReady`** devuelve 503 a toda petición (salvo `/health`) hasta que la BD está lista.
- **Ajustes por usuario**: `myXrpAmount` y `lang` se guardan por cuenta vía `/api/settings` (allowlist `ALLOWED_SETTINGS` — no añadir claves arbitrarias). `localStorage` es solo caché/fallback.
- **Cookie sin `Secure`** a propósito (localhost/http). Si el dashboard se expone fuera de localhost, hace falta HTTPS + Secure (ver `lib/auth.js`).
- **Cambio de contraseña**: `POST /api/auth/change-password` (botón ⚙ en el chip de usuario). Exige la contraseña actual, invalida todas las sesiones del usuario y re-emite la cookie del navegador actual. Al añadir campos sensibles nuevos sigue este patrón (verificar credencial actual antes de mutar).

## Idioma (v2.4 — bilingüe COMPLETO)

- El **español es la fuente** y vive en el HTML/JS. `public/i18n.js` solo tiene overrides al inglés. En HTML usa `data-i18n="clave"` (va en un span interno si el elemento contiene iconos/inputs — el motor reemplaza innerHTML); en JS usa `t('clave', 'texto español')` para etiquetas estáticas.
- **Textos dinámicos con interpolación** (lecturas, veredictos): ternarios inline `_isEn() ? EN : ES` en app.js (helpers `_isEn()`, `_pick(es, en)`, `_dLoc()` arriba del todo). Más legible que un diccionario de plantillas.
- **Textos generados en el SERVIDOR** (señales del dailyBrief, insights, factores del score, proyecciones, escorowNote, burnRateTrend, formattedDuration, dataQuality): server.js emite **campos duales** (`text`/`textEn`, `area`/`areaEn`, `detail`/`detailEn`...) y el frontend elige con `_pick()`. Si añades un texto nuevo en server.js, añade SIEMPRE su variante `*En` — si falta, el frontend cae al español sin romperse.
- **Contenido externo**: títulos/descripciones de noticias se muestran en su idioma original; el resumen IA (`summary_es`) solo existe en español — en modo EN el modal usa la descripción original + análisis por reglas en inglés. La clasificación de Alternative.me llega en inglés y se traduce a ES en cliente.
- Al cambiar de idioma se dispara `langchange` (app.js lo escucha, persiste en la cuenta y re-renderiza todo). Incrementa `?v=` de i18n.js/app.js/style.css al tocarlos.

## Nodos de `data.json`

`marketData`, `onChainData`, `technicals`, `sentiment`, `events`, `chartData`, `orderFlow`, `projections`, `newsFeed`, `whaleTracker`, `supplyDistribution`, `burnImpact`, `advancedMetrics`, y desde v2.0: `derivatives` (funding/OI de Kraken Futures), `ecosystem` (dominancias + RLUSD de CoinGecko) y `dailyBrief` (veredicto por reglas del tab Resumen). **Todos esos nodos top-level son de XRP** (ruta legacy intacta). Desde v2.5: `coins.<coingeckoId>` con los nodos GENÉRICOS de cada moneda no-XRP (`marketData` con supply, `chartData`, `technicals`, `projections`, `advancedMetrics`, `orderFlow`, `derivatives`, `exchangeVolume`, `newsFeed`, `dailyBrief`, `lastFastAt`/`lastCycleAt`) y `activeCoin` (moneda activa persistida entre reinicios).

## Multi-moneda (v2.5 — fase 1)

- **Registro `COINS` en server.js**: monedas ISO 20022 (XRP, XLM, XDC, ALGO, HBAR, IOTA, QNT) + BTC y ETH, con id de CoinGecko y símbolos Binance/Kraken Futures/OKX por moneda (null = esa fuente no existe y se degrada con elegancia). Para añadir una moneda basta añadir una fila.
- **La ruta XRP NO se toca**: sus fetchers/ciclo/nodos siguen igual. Las demás monedas usan `refreshCoinGeneric(id)` → FASE A (mercado + gráfica/técnicos/métricas/brief, ~3 llamadas) y FASE B (presión spot, derivados, volumen, noticias). Todo escribe SOLO en `coins.<id>` vía `withDataFile`.
- **Ciclo**: `multiCoinCycle()` cada 5 min, desfasado ~2,5 min del ciclo XRP (comparten rate limit de CoinGecko): refresca la moneda activa + UNA de fondo rotando (resto ≈ cada 30 min). `POST /api/coins/activate` dispara FASE A síncrona si la moneda está fría.
- **Endpoints**: `GET /api/coins` (registro + capacidades), `POST /api/coins/activate`, y `GET /api/chart/:days?coin=<id>` (sin parámetro = XRP, compat).
- **Frontend**: selector en el header (persistido como setting `activeCoin`, igual que `lang`); `loadDashboardData()` reasigna su variable local a la vista `data.coins[id]` (+ `sentiment` compartido) — los renderers no cambian. `body.coin-generic` + `data-xrp-only` ocultan lo XRPL-exclusivo (Ballenas, Quema, escrow, RLUSD, AMM, ETF, on-chain). Las **alertas locales siguen vigilando XRP** sea cual sea la moneda en pantalla (a propósito). Unidades y textos usan `_coinSym()`.
- **My Crypto por moneda**: XRP conserva `myXrpAmount` (compat); el resto usa `myAmount_<coingeckoId>` (allowlist por patrón `SETTING_KEY_PATTERN` en server.js — no añadir claves arbitrarias fuera del patrón).
- **Límites honestos de fase 1**: sin correlaciones BTC/ETH/SPY para monedas genéricas (sección oculta), noticias sin enriquecimiento IA, histórico diario (history.json) solo de XRP.

## Mi Portafolio (v2.7.2 — vista consolidada de tenencias)

- **Tab "Mi Portafolio"** (primero en el grupo *Inicio*, `data-tab="portfolio"`): suma el valor real de TODAS las monedas que el usuario posee. Valor total + cambio 24h ponderado por valor, donut de asignación (Chart.js), tabla por moneda (cantidad/precio/24h/valor/%), panel para editar cantidades y estado vacío. `renderPortfolio()` en app.js — su **propio fetch**, independiente de la moneda activa; se dispara al activar el tab y al cargar si es el tab activo.
- **`GET /api/portfolio`** (`requireAuth`): lee las tenencias de los ajustes del usuario (`myXrpAmount` + `myAmount_<id>`, las MISMAS que "My Crypto"), pide precios de todas en UNA llamada `/simple/price` cacheada 60s (memoria, `_portfolioPriceCache`), y **cae a los precios guardados en `data.json`** si CoinGecko falla — nunca se queda en blanco. Devuelve holdings ordenados por valor, total, cambio 24h ponderado y asignación %. NO añade nodo a `data.json` (se computa al vuelo).
- El precio total 24h es ponderado por valor: `value24hAgo = value / (1 + cambio%/100)` por moneda, y el total se compara contra la suma — lo correcto para un portafolio, no un promedio simple de %.

## Producción / endurecimiento (v2.6 — leer antes de tocar frontend o cabeceras)

- **Escapado obligatorio de datos externos**: TODO dato que venga de una API (títulos y
  descripciones de noticias, labels/addresses/type de wallets de XRPScan, símbolos) pasa por
  **`_esc()`** antes de entrar en `innerHTML`, y las URLs externas por **`_safeUrl()`** antes de
  un `href`. Motivo: había un **XSS almacenado** real — `news.title` se interpolaba tal cual y un
  titular con `<img onerror=...>` ejecutaba JS. Quitar tags con regex NO basta. Los helpers están
  arriba del todo de `app.js`.
- **Nada de datos en atributos `onclick`**: las listas de ballenas pasan un **índice**
  (`openWalletFromFeed(i)` / `openWalletFromTracked(i)`) y la función lee el objeto del array en
  memoria. Antes se incrustaba el label de XRPScan dentro del atributo y una comilla simple rompía
  el HTML e inyectaba código. Si añades listas clicables, usa el mismo patrón.
- **Cabeceras de seguridad** (middleware propio en `server.js`, sin dependencias): CSP,
  `X-Frame-Options`, `nosniff`, `Referrer-Policy` y HSTS en producción. `script-src` NO lleva
  `unsafe-inline` (ahí vive el riesgo); `style-src` sí, porque las tarjetas usan estilos inline.
  Si añades un script de un dominio nuevo, hay que permitirlo explícitamente en la CSP o no cargará.
- **Producción se activa con `NODE_ENV=production`** (o `PUBLIC_HTTPS=1`): añade el flag `Secure` a
  la cookie de sesión y HSTS. En local NO se activa a propósito (el navegador no envía cookies
  Secure por http y no podrías entrar).
- **`app.set('trust proxy', 1)`**: detrás del Cloudflare Tunnel, sin esto `req.ip` sería la IP del
  proxy y el rate-limit de login trataría a todos los usuarios como uno solo.
- **Todo fetch externo lleva timeout**: usa `fetchWithTimeout(url)` (devuelve la Response) o
  `fetchJsonWithTimeout(url, ms)` (devuelve el JSON parseado). **Nunca `fetch()` pelado**: si una API
  acepta la conexión y no responde nunca, el ciclo de refresco entero se queda colgado.
- **`GET /health`** (sin auth): liveness para pm2 y el túnel. Es el ÚNICO endpoint sin `requireAuth`
  junto a `/api/auth/*`; no expone datos de usuario.
- **Cierre limpio**: `SIGTERM`/`SIGINT` esperan a que termine la escritura pendiente de `data.json`
  antes de salir. `unhandledRejection`/`uncaughtException` se registran pero NO matan el proceso.
- **Chart.js SELF-HOSTED (v2.7)**: `public/vendor/chart.umd.min.js` (4.4.7, del tarball oficial de npm);
  `cdn.jsdelivr.net` ya NO está en la CSP (`script-src 'self'`).
- **Bind loopback (v2.7)**: `app.listen(PORT, HOST)` con `HOST=127.0.0.1` por defecto (env para cambiarlo).
  Detrás del túnel nadie más debe alcanzar el puerto.

## Gotchas conocidos

- **APIs muertas/geobloqueadas (verificado 2026-07-03)**: XRPScan `/network/metrics`, `/metrics` y `/richlist` devuelven 404 — no las uses; el total de coins sale de `onChainData.totalCoins` o del watcher (`lastTotalCoins`). Binance Futures (`fapi.binance.com`) y Bybit están **geobloqueados en EE. UU.** — los derivados vienen de Kraken Futures (`PF_XRPUSD`). OJO (corregido en v2.5): el `fundingRate` de Kraken es **ABSOLUTO** (USD por unidad), no una tasa relativa — hay que dividirlo por `markPrice` antes de convertir a 8h/anualizado (con XRP a ~$1-3 el sesgo pasaba desapercibido; con BTC daba +373%/8h).
- **Sanidad de montos whale**: `amountToXrp()` descarta cualquier monto > 2B XRP (físicamente imposible; el mayor movimiento recurrente es el escrow de 1B). Si tocas el parsing de transacciones, mantén el tope: ya hubo un `data.json` contaminado mostrando "10,7 billones de XRP" en pantalla.
- **`chartData` es compartido y mutable**: `GET /api/chart/:days` lo sobrescribe con la resolución que pida el usuario (1D = velas de 5 min) y el ciclo lo reescribe a 365d cada ~5 min. Por eso `calculateAdvancedMetrics()` y `calculateTechnicals()` comprueban el *span* real por timestamp antes de calcular y conservan valores previos si la ventana es corta. En el frontend, `renderPriceChartForWindow()` (app.js) **recorta siempre la serie a la ventana del botón activo** y cachea por ventana (TTL 5 min) — sin eso, el re-render periódico pintaba 365d etiquetados como "1M". Mantén ambas protecciones en cualquier uso nuevo de `chartData`.
- **Claves API**: van en `.env` (cargado por un parser propio en `server.js`, sin dependencia dotenv). `openai` puede ser `null` — cualquier uso nuevo debe tolerar su ausencia.
- **Datos mock/seed**: el whale tracker siembra mocks si la API no da transferencias (hashes `MOCK_TX_*`), y el burn watcher siembra buckets con `seeded: true`. La UI los marca (badge `DEMO`, barras grises). Si añades fuentes de datos con fallback, sigue el mismo patrón: **marcar siempre lo que no es real** (`estimatedFields`, flags `*Estimated`, `seeded`).
- **Unidades**: los montos del whale tracker están en **XRP** (no USD). `total_coins` del XRPL viene en drops a veces (se normaliza dividiendo por 1e6 si supera umbrales). `previousCycle.remainingEscrow` está en **miles de millones** (33.6 = 33.6B).
- **Semántica del flujo a exchanges**: positivo = XRP *entrando* a exchanges = oferta de venta potencial (se pinta **rojo**); negativo = acumulación (verde). No lo inviertas.
- **IDs acoplados**: `app.js` busca decenas de IDs definidos en `index.html` (`price-chart-reading`, `burn-chart-sub`, `whale-kpi-flow-sub`, `supply-legend`, `wallet-reading`, `burn-completion-reading`...). Si renombras algo en HTML, busca su uso en `app.js`.
- **Cache-busting manual**: `index.html` referencia `style.css?v=N` y `app.js?v=N`. Incrementa `N` cuando cambies esos archivos.
- **Typo heredado**: `events.escorowNote` (sic) — se mantiene por compatibilidad con `data.json` existentes.

## Convenciones del proyecto

- Comentarios y strings de UI en español; los bugfixes se documentan con comentario `// Bugfix:` o `// BUGFIX:` explicando el porqué.
- Cada sección del frontend se renderiza dentro de su propio `try/catch` para que un fallo no tumbe el resto del dashboard.
- **Lecturas prácticas**: toda gráfica debe llevar una interpretación en lenguaje llano. Usa los helpers `readingHTML(tone, title, text)` / `setReading(elId, ...)` de `app.js` (tonos: `pos`, `neg`, `warn`, `info`) y el estilo `.chart-reading` de `style.css`. El texto debe decir *qué significa* el dato y *qué implica*, sin prometer resultados.
- Formato números: `Intl.NumberFormat('en-US')`; USD con 4 decimales para precio de XRP.
- Todo lo especulativo lleva disclaimer educativo. El tono de las lecturas es honesto: si una métrica no mueve el precio (ej. burn), se dice explícitamente.

## Cómo añadir una métrica nueva (receta)

1. En `server.js`: crear `fetchMiMetrica()` que construya el nodo y lo escriba con `await withDataFile(d => { d.miMetrica = {...}; })` con `lastUpdated` y flags `*Estimated` si aplica; añadirla a `refreshAllData()` con delay. Si la señal es relevante para el Resumen, añadir su regla a `buildDailyBrief()` y su fuente a la lista de `dataQuality`.
2. En `index.html`: añadir contenedor con ID (y contenedor de lectura si lleva gráfica).
3. En `app.js`: función `renderMiMetrica(data.miMetrica)` llamada desde `loadDashboardData()` dentro de try/catch, con su lectura práctica.
4. En `style.css`: reutilizar componentes existentes (`.card-row-item`, `.supply-kpi`, `.chart-reading`) antes de crear clases nuevas.
5. Actualizar `docs/GUIA-TABS.md` con cómo leer la métrica y bump del `?v=` en `index.html`.

## Qué NO hacer

- No hardcodear claves ni tokens (ya pasó; ver `docs/AUDITORIA.md`).
- No presentar datos simulados como reales: todo mock/estimación se etiqueta en la UI.
- No paralelizar los fetchers sin resolver la concurrencia de escritura en `data.json`.
- No usar `localStorage` para nada crítico (solo guarda la cantidad de "My Crypto").
- No añadir dependencias npm sin necesidad clara: la filosofía es cero-build y mínimas deps.
