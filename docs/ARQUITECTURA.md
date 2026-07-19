# Arquitectura y funcionamiento interno

## Visión general

El proyecto es una aplicación monolítica local con tres piezas:

1. **`server.js`** (backend Express): orquesta todos los fetchers de datos externos, calcula métricas derivadas y persiste el estado completo en `data.json`. Expone una API mínima al frontend.
2. **`xrplBurnWatcher.js`**: módulo independiente que mantiene una conexión WebSocket con el XRPL (con fallback a polling REST) para medir la quema real de XRP, agregándola en buckets horarios de hasta 7 días.
3. **`public/`** (frontend vanilla): una sola página con pestañas. `app.js` pide `GET /api/data` y renderiza todo con `innerHTML` + Chart.js.

## Flujo de datos

```
APIs externas ──> fetchers (server.js) ──> data.json ──> GET /api/data ──> app.js ──> DOM
     ▲                                        ▲
  cada 5 min (setInterval backend)            │
                                  XRPL WS ──> burnWatcher.onUpdate
Frontend re-fetch cada ~5.1 min (setInterval en app.js)
```

### Ciclo de sincronización (cada 300 s)

Orden secuencial con delays escalonados para respetar rate limits gratuitos:

1. `fetchMarketData()` — CoinGecko `/coins/markets` → `marketData`
2. `fetchOnChainData()` — XRPScan ledgers (+ `/metrics` si responde) → `onChainData` (TPS calculado de la ventana de ledgers; cuentas activas **aproximadas** por fórmula si la API de métricas falla)
3. `fetchChartData()` — CoinGecko 365d → `chartData`
4. `calculateTechnicals()` — soporte/resistencia/RSI **de 7 días** sobre `chartData` → `technicals`
5. `fetchSentimentData()` — Alternative.me → `sentiment`
6. `fetchOrderFlowData()` — Binance klines 24×1h, taker buy volume → `orderFlow`
7. `calculateAdvancedMetrics()` — métricas de inversión sobre `chartData` 365d + histórico BTC → `advancedMetrics` (ver `METRICAS_E_INSIGHTS.md`)
8. `updateEvents()` — countdown del escrow (1 del mes) + historial **hardcodeado** de ciclos → `events`
9. `calculateProjections()` — escenarios ±% sobre precio actual → `projections`
10. `fetchNewsData()` — CryptoPanic (fallback RSS Cointelegraph) + análisis OpenAI por noticia → `newsFeed`
11. `fetchWhaleData()` — balance y txs de wallets monitoreadas (XRPScan), filtro ≥50k XRP → `whaleTracker`
12. `fetchSupplyDistributionData()` / `fetchBurnImpactData()` → `supplyDistribution`, `burnImpact`

### Burn Watcher

- Conecta a `wss://xrplcluster.com` (rotando entre 3 endpoints) y pide el ledger validado cada 30 s.
- La quema se infiere del **descenso de `total_coins`** entre muestras; deltas negativos o absurdos se descartan.
- Si el WS cae: backoff exponencial (2s → 60s máx.) y mientras tanto polling REST cada 60 s.
- Al arrancar sin histórico siembra 24 buckets sintéticos (~102 XRP/h ±20%) para que la UI no esté vacía; se sustituyen al llegar datos reales. El snapshot se persiste en `data.json → burnImpact.realtime` y se re-inyecta al reiniciar.

## Persistencia: data.json como base de datos

Cada fetcher hace el ciclo `readFileSync → JSON.parse → mutar nodo → writeFileSync`. Esto es simple pero tiene implicaciones:

- **No hay atomicidad**: el watcher escribe cada ~30 s y los fetchers también; una escritura simultánea podría corromper el fichero (riesgo bajo en Node single-thread, pero real si el proceso muere a mitad de un write).
- **El fichero crece**: `chartData` (365 puntos), 50 transferencias whale, caches de historial, buckets horarios…
- `POST /api/data` permite a cualquier cliente local **sobrescribir todo** sin validación.

## Frontend

- `app.js` (~1650 líneas) concentra todo: fetch, formateo y render con template literals. Estilos mayormente inline.
- `localStorage` guarda la cantidad de XRP del usuario ("My Crypto").
- Chart.js para: precio histórico, flujo whale, historial de wallet, burn por hora.
- El selector 1D/7D/1M/1Y llama a `/api/chart/:days`, que **sobrescribe `chartData` en data.json** — efecto lateral importante: los indicadores técnicos del siguiente ciclo se calcularían sobre la ventana elegida. `calculateAdvancedMetrics()` se protege de esto (omite el recálculo si la ventana es <180 días), `calculateTechnicals()` no.

## Bugs corregidos en esta revisión

1. **TDZ en `server.js`**: el bloque que re-inyectaba el seed del burn watcher usaba `DATA_FILE` antes de su declaración (`const` más abajo). El `try/catch` se tragaba el `ReferenceError`, así que la resiliencia ante reinicios nunca funcionó. → Constantes movidas arriba.
2. **`scheduleReconnect` inexistente en `xrplBurnWatcher.js`**: se llamaba en los handlers de `close`/`error` del WS pero no estaba definida; tras la primera desconexión el watcher moría con `ReferenceError` y no volvía a conectar. → Implementada con backoff exponencial + fallback REST.

## Puntos débiles conocidos (resumen)

Detalle y plan en `MEJORAS_CORTO_PLAZO.md` / `MEJORAS_LARGO_PLAZO.md`:

- Claves de API hardcodeadas en `server.js` (OpenAI, CryptoPanic).
- Direcciones de wallets monitoreadas posiblemente inválidas (varias no parecen direcciones XRPL reales) y datos mock mezclados con reales.
- `escrowHistory` y `escrowSupply` (39.8B) hardcodeados — se desactualizan solos.
- Estimaciones presentadas junto a datos reales (cuentas activas, distribución exchange/whale/free float) — están marcadas, pero la fórmula es arbitraria.
- Sin tests, sin linter, sin manejo de concurrencia de escritura.
