# USCashout Markets — Panel cripto multi-moneda (v2.7)

Dashboard de análisis cripto **multi-moneda** con **XRP como moneda principal**: resumen ejecutivo en lenguaje llano, mercado, derivados, técnico, on-chain, ballenas, suministro y quema en tiempo real. Node/Express **cero-build** (sin framework frontend, sin bundler), estado en `data.json`, usuarios en SQLite nativo, **bilingüe ES/EN**. En producción en [uscashout.com](https://uscashout.com).

> **Qué trae cada versión** — v2.0: tab Resumen (veredicto por reglas), derivados de Kraken Futures, escritura serializada de `data.json` · v2.3: **autenticación** (scrypt + sesiones HttpOnly, SQLite `node:sqlite`), ajustes por usuario · v2.4: **bilingüe completo** ES/EN (motor propio `i18n.js`, campos duales del servidor) · v2.5: **multi-moneda** — 9 monedas (ISO 20022: XRP, XLM, XDC, ALGO, HBAR, IOTA, QNT + BTC y ETH) con ciclo de refresco rotatorio y degradación elegante por fuente · v2.6: endurecimiento (XSS cerrado con `_esc()`/`_safeUrl()`, CSP propia, HSTS, trust proxy, timeouts en todo fetch, cierre limpio) · v2.7: Chart.js **self-hosted** (CSP `script-src 'self'`), bind loopback por defecto, marca **USCashout Markets**. Detalle en [`docs/CHANGELOG-V2.md`](docs/CHANGELOG-V2.md).

> ⚠️ **Propósito educativo.** Ninguna métrica, score o lectura constituye asesoramiento financiero.

## Inicio rápido

```bash
npm install
npm start
# Abrir http://localhost:3000
```

Requisitos: Node.js 18+ (con Node 22, SQLite nativo vía `node:sqlite`; sin él, fallback JSON automático).

> ★ El **primer usuario registrado se convierte en owner**. En un despliegue nuevo, regístrate tú antes de compartir la URL.

Claves en `.env` (copia `.env.example`; parser propio, sin dotenv). Sin claves todo funciona igual con fallbacks:

| Variable | Para qué | Si falta |
|---|---|---|
| `OPENAI_API_KEY` | Resumen e impacto de noticias con gpt-4o-mini | Análisis heurístico local |
| `CRYPTOPANIC_TOKEN` | Feed de noticias CryptoPanic | Fallback RSS (Cointelegraph) |
| `NODE_ENV=production` | Cookie `Secure` + HSTS (detrás de HTTPS) | Modo local http |
| `PORT` / `HOST` | Puerto y bind (default `3000` / `127.0.0.1`) | Defaults |

## Pestañas (9, en nav agrupada)

| Grupo | Pestañas | Contenido |
|---|---|---|
| **Inicio** | Resumen | La vista de 10 segundos: precio + sparkline, chips, veredicto y señales por reglas (`dailyBrief`), niveles a vigilar, frescura de cada fuente |
| **Mercado** | Mercado · Noticias · Derivados | Precio/mcap/volumen, gráfica 1D-1Y con lectura práctica, presión spot (Binance), Fear & Greed, escrow de Ripple, calculadora "My Crypto"; noticias analizadas con IA; funding/OI de Kraken Futures |
| **Análisis** | Análisis · Técnico | Score compuesto educativo con factores, insights; RSI, SMA 20/50/200, MACD, Bollinger, volatilidad, drawdown, Sharpe, VaR 95%, correlaciones |
| **On-Chain** *(XRP)* | Ballenas · Suministro · Quema | Transferencias ≥50k XRP con semántica direccional, wallets monitoreadas; circulante vs escrow vs quemado; quema en tiempo real (WebSocket XRPL) con proyecciones honestas |

Con una moneda no-XRP seleccionada, las secciones exclusivas del XRPL (ballenas, quema, escrow, RLUSD) se ocultan y el resto se adapta (`data-xrp-only`). La guía de lectura completa está en [`docs/GUIA-TABS.md`](docs/GUIA-TABS.md).

## Arquitectura

```
server.js            Backend Express: fetchers, cálculos, endpoints, ciclos XRP + multi-coin
lib/calc.js          Funciones PURAS de cálculo (RSI, MACD, VaR...) — testeadas (npm test)
lib/db.js            Persistencia usuarios/sesiones/ajustes: SQLite nativo con fallback JSON
lib/auth.js          Auth: scrypt, sesiones HttpOnly, rate-limit, requireAuth
xrplBurnWatcher.js   Watcher WebSocket/REST de quema en XRPL (~30 s por muestra)
data.json            Estado del dashboard, autogenerado (en .gitignore)
public/
  index.html         UI (9 tabs, overlay de auth, selector de monedas)
  app.js             Renderizado, gráficas y lecturas prácticas (bilingüe)
  i18n.js            Motor ES/EN: español es la fuente; diccionario solo con overrides EN
  style.css          Tema dark glassmorphism
  vendor/            Chart.js 4.4.7 self-hosted (CSP sin CDNs)
docs/                GUIA-TABS · AUDITORIA · CHANGELOG-V2 · ROADMAP
CLAUDE.md            Guía para trabajar en este código con un asistente IA
```

**Flujo de datos:** APIs públicas → `fetch*()`/`calculate*()` en `server.js` → **toda escritura pasa por `withDataFile()`** (cola serializada + escritura atómica) → el frontend consume `GET /api/data`. Ciclo XRP cada 5 min; ciclo multi-coin desfasado ~2,5 min (moneda activa + una de fondo rotando). El burn watcher escribe `burnImpact.realtime` cada ~30 s.

## Fuentes de datos

- **CoinGecko** — precio, mcap, histórico, dominancias y RLUSD; también las 8 monedas no-XRP
- **XRPScan** — ledger, cuentas, transacciones de wallets, lista well-known verificada
- **Binance (data-api pública)** — klines spot para presión compradora/vendedora
- **Kraken Futures** — funding rate y open interest de perpetuos (accesible desde EE. UU.)
- **Alternative.me** — índice Fear & Greed · **CryptoPanic/RSS** — noticias · **OpenAI** *(opcional)* — resumen IA
- **XRPL (xrplcluster.com)** — `total_coins` en tiempo real para el burn watcher

## API local (toda tras `requireAuth`, salvo `/api/auth/*` y `/health`)

- `POST /api/auth/{register,login,logout,change-password}` · `GET /api/auth/me`
- `GET /api/data` — el estado completo · `GET /api/settings` / `POST /api/settings` — ajustes por usuario
- `GET /api/coins` — registro de monedas · `POST /api/coins/activate` — cambia la moneda activa
- `GET /api/chart/:days?coin=<id>` — histórico (sin parámetro = XRP)
- `GET /api/wallet-history/:address` · `POST /api/refresh` (cooldown 30 s) · `GET /health` (liveness, sin auth)

## Honestidad de datos

La UI distingue tres calidades: **Real** (API/XRPL directo) · **Estimado** (badge `≈ estimado` — derivado con fórmulas) · **Demo** (badge `DEMO` — sembrado cuando la API no respondió, solo para ilustrar el formato). Todo lo que no es real está marcado, siempre.

## Producción

Con `NODE_ENV=production`: cookie de sesión `Secure`, HSTS, `trust proxy` (para el rate-limit real detrás de un túnel/proxy). CSP propia sin dependencias (`script-src 'self'` — Chart.js va self-hosted). El servidor escucha **solo en loopback** por defecto; exponlo con un reverse proxy o túnel HTTPS. `SIGTERM` espera la escritura pendiente de `data.json` antes de salir.

## Avisos

- Señales, scores y proyecciones son **educativas**, no asesoramiento financiero.
- Historia de bugs y auditorías: [`docs/AUDITORIA.md`](docs/AUDITORIA.md).
