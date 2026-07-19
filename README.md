# XRP Analytics Dashboard 2.0

Dashboard local de análisis para XRP: **resumen ejecutivo en lenguaje llano**, mercado, derivados, ecosistema (RLUSD/dominancias), on-chain, ballenas, distribución de suministro y quema en tiempo real. Todo corre en tu máquina con un servidor Node/Express que agrega APIs públicas y persiste el estado en `data.json`.

> **Novedades v2.0** (2026-07-03): tab **Resumen** (la vista de 10 segundos, con veredicto por reglas y frescura de datos), tarjetas de **Derivados** (funding/OI reales de Kraken Futures) y **Ecosistema** (RLUSD + dominancias), noticias XRP-first, escritura serializada de `data.json` (elimina valores contradictorios), saneado del Whale Tracker (unidades) y precio siempre visible en el header. Detalle completo en [`docs/CHANGELOG-V2.md`](docs/CHANGELOG-V2.md); plan del próximo mes en [`docs/ROADMAP-V2.md`](docs/ROADMAP-V2.md).

> ⚠️ **Propósito educativo.** Ninguna métrica, score o lectura de este dashboard constituye asesoramiento financiero.

## Inicio rápido

```bash
npm install
npm start
# Abrir http://localhost:3000
```

Requisitos: Node.js 18+ (usa `fetch` nativo).

Configura tus claves en `.env` (copia `.env.example`). Sin claves el dashboard funciona igual: el análisis de noticias usa un fallback heurístico local y las noticias vienen de RSS.

| Variable | Para qué | Si falta |
|---|---|---|
| `OPENAI_API_KEY` | Resumen e impacto de noticias con gpt-4o-mini | Análisis heurístico local |
| `CRYPTOPANIC_TOKEN` | Feed de noticias CryptoPanic | Fallback RSS (Cointelegraph) |

## Pestañas

| Pestaña | Contenido |
|---|---|
| **Resumen** *(v2.0, por defecto)* | Precio + sparkline 30d, chips (score, F&G, escrow, rango 52s), veredicto y señales en lenguaje llano (`dailyBrief`, reglas sin IA), niveles a vigilar, mini derivados/ecosistema y frescura de cada fuente de datos |
| **Mercado** | Precio, market cap, volumen, gráfica histórica (1D/7D/1M/1Y) con lectura práctica, datos on-chain (TPS, ledger, cuentas activas), Buy/Sell pressure (Binance) con diferencial neto, Fear & Greed con lectura contraria, proyecciones, ciclo de Ripple Escrow con lectura de dilución, noticias XRP-first analizadas con IA, calculadora "My Crypto", **Derivados** (funding/OI, Kraken Futures) y **Ecosistema XRP** (RLUSD, dominancias) |
| **Análisis** | Score compuesto educativo (0-100) con lectura de factores, insights automáticos, RSI 14, SMA 20/50/200, MACD, Bollinger, volatilidad, max drawdown, Sharpe, VaR 95%, retornos por periodo, rango 52 semanas, correlación con BTC, liquidez |
| **Whale Tracker** | Grandes transferencias (≥50k XRP), wallets monitoreadas, flujo neto a exchanges con semántica direccional (entra = oferta de venta, sale = acumulación), perfil acumulación/distribución por wallet |
| **Supply Distribution** | Circulante vs escrow vs quemado con leyenda, estimaciones de exchanges/whales/free float (marcadas), lectura de dilución mensual real del escrow |
| **Burn Impact** | Quema de XRP en tiempo real (WebSocket XRPL con fallback REST), gráfica horaria que distingue datos reales (rojo) de estimación inicial (gris), proyecciones de agotamiento con conclusión honesta |

La guía de **cómo leer cada gráfica** está en [`docs/GUIA-TABS.md`](docs/GUIA-TABS.md).

## Arquitectura

```
server.js            Backend Express: fetchers, cálculos y API (ciclo cada 5 min)
xrplBurnWatcher.js   Watcher WebSocket/REST de quema en XRPL (~30 s por muestra)
data.json            Almacenamiento local autogenerado (en .gitignore)
.env                 Claves privadas (en .gitignore) — ver .env.example
public/
  index.html         UI (pestañas, modales y layout)
  app.js             Renderizado, gráficas Chart.js y lecturas prácticas
  style.css          Tema dark glassmorphism
docs/
  GUIA-TABS.md       Qué muestra cada tab y cómo leer cada gráfica
  AUDITORIA.md       Auditoría: bugs encontrados y corregidos
  ROADMAP.md         Mejoras futuras propuestas
CLAUDE.md            Guía para trabajar en este código con Claude
```

**Flujo de datos:** APIs públicas → funciones `fetch*()`/`calculate*()` en `server.js` → escritura atómica en `data.json` → el frontend consume `GET /api/data` y renderiza. El watcher de burn escribe además `burnImpact.realtime` con cada muestra.

## Fuentes de datos

- **CoinGecko** — precio, market cap, histórico de precios (XRP y BTC para correlación), **global/dominancias y RLUSD** *(v2.0)*
- **XRPScan** — ledger, cuentas y transacciones de wallets, lista well-known verificada *(ojo: `/network/metrics` y `/metrics` están muertos — 404)*
- **Binance (data-api pública)** — klines XRPUSDT para presión compradora/vendedora *(spot; sus futuros están geobloqueados en EE. UU.)*
- **Kraken Futures** *(v2.0)* — funding rate y open interest del perpetuo XRP (accesible desde EE. UU.)
- **Alternative.me** — índice Fear & Greed
- **CryptoPanic + Cointelegraph RSS (fallback)** — noticias (XRP primero; lo macro se etiqueta)
- **OpenAI (gpt-4o-mini, opcional)** — resumen e impacto de noticias en español
- **XRPL (xrplcluster.com)** — `total_coins` en tiempo real para el burn watcher

## API local

- `GET /api/data` — devuelve todo el `data.json`
- `GET /api/chart/:days` — histórico de precios (proxy CoinGecko); ⚠️ sobrescribe `chartData`
- `GET /api/wallet-history/:address` — historial de una wallet (caché 10 min)
- `POST /api/refresh` — refresco manual completo (cooldown 30 s)

## Honestidad de datos

La UI distingue tres calidades de dato:

- **Real** — de una API o del XRPL directamente.
- **Estimado** (badge amarillo `≈ estimado` / `Estimated`) — derivado con fórmulas: cuentas activas desde TPS, split exchanges/whales/free float del supply.
- **Demo** (badge `DEMO` + aviso naranja) — datos sembrados cuando la API no respondió, solo para ilustrar el formato.

## Avisos

- Las claves ya **no** están hardcodeadas; viven en `.env`. La clave de OpenAI que estuvo expuesta en `server.js` debe **rotarse** (ver `docs/AUDITORIA.md`).
- Señales, scores y proyecciones son **educativas**, no asesoramiento financiero.
