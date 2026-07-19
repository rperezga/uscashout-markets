# Roadmap v2.x — 20 mejoras para 1 mes

Plan de 4 semanas (≈5 mejoras/semana, sesiones de 1-3 h). Prioridad guiada por **lo que los inversores de XRP miran en 2026**: flujos de ETFs, acumulación whale por cohortes, netflows de exchanges, derivados (OI/funding), RLUSD/RWA en el XRPL, escrow y niveles clave. Cada ítem indica esfuerzo (S/M/L), fuente de datos y criterio de "hecho".

> Regla de la casa: todo dato no-real se etiqueta (`DEMO` / `≈ estimado` / `≈ típico`). Ninguna mejora puede romperla.

---

## Semana 1 — Datos que los inversores piden a gritos

**1. ~~Tracker de flujos de ETFs de XRP~~ ✅ HECHO (v2.2, 2026-07-03)** 🏆 *La métrica #1 de demanda institucional*
Confirmado: sigue sin existir API gratuita para flujos de ETF de XRP. Implementado tal como preveía el roadmap — nodo `etfFlows` manual-actualizable en `data.json` (`aumUsd`, `xrpInCustody`, `etfCount`, `weeklyNetFlowUsd`, `weeklyStreakWeeks`, `cumulativeNetFlowUsd`, `asOf`, `source`, `manual:true`), **nunca autofetcheado** (no hay `fetchEtfFlows()` en `refreshAllData()` — se edita a mano, ver `docs/GUIA-TABS.md`). Sembrado con datos reales de investigación web al 2026-07-02 (7 ETFs, ~$1.0B AUM, 966.6M XRP en custodia, 8ª semana consecutiva de entradas, +$23M la última semana, $1.47B acumulado — fuentes: Cointelegraph/Binance Square/WEEX). Tarjeta nueva "ETFs Spot de XRP" en el tab Mercado (`renderEtfFlows()`) con lectura práctica sensible a la racha de semanas, fecha del dato y fuente citada visibles siempre. Fase 2 (scraper best-effort) queda pendiente para cuando xrp-insights.com o SoSoValue publiquen API.

**2. ~~Netflow agregado de exchanges en ventana 24h/7d estricta~~ ✅ HECHO (v2.1, 2026-07-03)**
Implementado como rediseño completo del tab Ballenas: línea de tiempo horaria/diaria con toggle 24h/7d, veredicto, neto acumulado y log de eventos persistente (`flowEvents`). Sustituir por mejora complementaria: **añadir media móvil de 7 días del netflow** cuando haya suficiente histórico acumulado, para distinguir tendencia de ruido.

**3. ~~Escrow real leído del XRPL~~ ✅ HECHO (v2.2, 2026-07-03)**
Implementado `fetchEscrowOnChainData()`: descubre las ~55 cuentas "Ripple N" vía la lista well-known de XRPScan (mismo mecanismo que las wallets del Whale Tracker) y consulta `account_objects type=escrow` de cada una vía `xrplcluster.com` (POST JSON-RPC). El total real sustituye la tabla `escrowHistory` hardcodeada en `updateEvents()`; `supplyDistribution` deriva su `escrowSupply` del mismo nodo (`events.previousCycle.remainingEscrow`), así Suministro y la tarjeta Escrow de Mercado muestran siempre la misma cifra on-chain con timestamp (`data.escrowOnChain.lastUpdated`). Nodo nuevo: `escrowOnChain` (`totalRemainingB`, `activeEscrows`, `accountsScanned`, `nextRelease`, `source`). **Parcial (🚧):** el desglose mensual liberado/devuelto/neto sigue siendo una aproximación típica (1000/800/200 XRP) — calcularlo real requiere diffear snapshots día a día, bloqueado hasta que exista `history.json` (#6). Se marca `estimated:true` explícitamente en ese desglose para no presentarlo como dato real.

**4. Contador de "wallets millonarias" y cohortes (M) — ⛔ BLOQUEADO (2026-07-03)**
Verificado en vivo: **`ledger.exposed` cerró permanentemente** (el propio sitio lo confirma: "This project is no more", descontinuado por su mantenedor de XRPL Labs). La fuente alternativa, Bithomp, expone rich-list solo con **API key** — obtenerla implica crear una cuenta en un servicio de terceros, que es una acción que debo pedirte hacer a ti directamente (no puedo registrar cuentas en tu nombre). No completé este ítem esta sesión.
**Alternativa propuesta:** (a) tú generas una API key gratuita en Bithomp (bithomp.com → cuenta → API) y la añades a `.env` como `BITHOMP_API_KEY`; con eso implemento `fetchHolderCohorts()` en la próxima sesión sin fricción. (b) si prefieres cero registro, explorar en otra sesión con más tiempo `xrpintel.com`, `XRPL Services` o `XRPL Metrics` (mencionados por el propio ledger.exposed como sucesores) para ver si exponen conteos por cohorte sin key — no verificado todavía, sus fetches se agotaron por timeout durante esta sesión.
*Hecho cuando:* tarjeta "Cohortes de holders" con nº de wallets ≥1M y ≥10K XRP + variación semanal.

**5. ~~Purga de deuda técnica rápida~~ ✅ HECHO (v2.2, 2026-07-03)**
`technicals.rsi` naive eliminado de `calculateTechnicals()` (la UI ya usa el RSI 14 Wilder real de `advancedMetrics.momentum.rsi14`); nodo muerto `supplyOverview` purgado de `data.json` (sin lastUpdated desde abril, ninguna función lo escribía ni lo leía); `fix.js` movido a `scratch/`. El punto "añadir `escrowHistory` de jun-2026 real" queda obsoleto por el ítem #3: ya no existe una tabla `escrowHistory` que mantener — el total sale on-chain.

---

## Semana 2 — Histórico y alertas (de consulta pasiva a herramienta activa)

**6. ~~`history.json`: snapshots diarios de métricas~~ ✅ HECHO (v2.2, 2026-07-03)** 🏆 *Desbloquea todo lo demás*
Implementado `appendDailyHistorySnapshot()`: archivo nuevo `history.json` (array append-only, fuera de `data.json`/`withDataFile` — sin escritores concurrentes que serializar) con upsert por día natural (cada ciclo sobreescribe la entrada de "hoy" con el dato más fresco; al cambiar el día queda fijada). Campos por snapshot: `price`, `score` (compositeScore), `whaleExchangeFlowNet`, `fundingRate8hPct`, `openInterestXrp`, `rlusdMarketCapUsd`, `fearGreed`, `dailyBurnXrp`, `btcDominancePct`, `xrpDominancePct`, `escrowRemainingB`. Rotación automática a 400 días (~13 meses). Nuevo endpoint `GET /api/history`. Wired al final de `refreshAllData()`, tras `buildDailyBrief()`.
*Verificación pendiente de calendario:* el criterio literal ("7 días corriendo generan 7 snapshots") solo se puede confirmar dejando el servidor corriendo una semana. Verificado en esta sesión con el servidor reiniciado varias veces: consola muestra `history.json: snapshot de 2026-07-03 guardado (1 días acumulados)` y `GET /api/history` devuelve el snapshot completo con los 11 campos poblados, sin errores. Ahora sí tiene uso en la UI — ver #7.

**7. ~~Gráfica de evolución del score y del flujo whale~~ ✅ HECHO (v2.2, 2026-07-03)**
Sparklines de `history.json` en dos tabs nuevos: "Evolución del Score" (tab Análisis, línea verde/roja según sube/baja) y "Evolución del flujo neto" (tab Ballenas, barras rojas/verdes). Ambas con nota de cobertura honesta ("histórico en construcción: solo hay N día(s) registrado(s)...") — mismo patrón que el log `flowEvents` del Whale Tracker (v2.1). Verificado en vivo: con 1 solo día acumulado se ve un punto/barra único y la nota de cobertura correcta; crecerá día a día sin cambios de código.

**8. ~~Sistema de alertas locales~~ ✅ HECHO (v2.2, 2026-07-03)**
Modal "Alertas" (botón nuevo en el header) con 5 condiciones activables: RSI 30/70, Golden/Death Cross, precio toca soporte/resistencia/psicológico, funding cambia de signo, flujo a exchanges supera un umbral configurable. Config en `localStorage` (nunca sale del navegador). `checkAlerts()` corre en cada ciclo del frontend (~5 min) y solo notifica en **transiciones** (ej. RSI entra en sobrecompra), no cada vez que la condición sigue activa — el "estado anterior" también vive en `localStorage`. Usa `Notification.requestPermission()` + `new Notification(...)`, con notificación de prueba al guardar.
*Hecho cuando (verificado):* el modal abre, muestra el estado del permiso del navegador, guarda la config y dispara la notificación de prueba nativa al activar. Limitación honesta explícita en el propio modal: solo funciona con la pestaña abierta (no hay push server).

**9. ~~Umbral whale configurable en la UI~~ ✅ HECHO (v2.2, 2026-07-03)**
Input + botón "Guardar" en el tab Ballenas. `POST /api/whale-threshold` valida, persiste en `whaleTracker.threshold` vía `withDataFile` y dispara un refresco inmediato de `fetchWhaleData()`. El valor también se guarda en `localStorage` (`xrpWhaleThreshold`) para el navegador del usuario. **Bug real cazado y corregido en verificación en vivo:** el input volvía a mostrar el umbral viejo justo después de guardar, porque leía `summary.threshold` (que tarda unos segundos en refrescarse — todo el ciclo de `fetchWhaleData()`) en vez del campo `whaleTracker.threshold` de nivel superior (que `withDataFile` actualiza al instante). Corregido leyendo primero el campo de nivel superior. Verificado end-to-end: cambié el umbral a 75.000, confirmé "Umbral activo: 75.000 XRP", lo devolví a 50.000.

**10. ~~Detección de "holders underwater" / precio realizado aproximado~~ ✅ HECHO (v2.2, 2026-07-03)**
`underwaterApprox` en `advancedMetrics.risk`, calculado sobre el mismo array de precios de 365 días protegido por span (igual que el resto de `calculateAdvancedMetrics`): % de días del último año con cierre por encima del precio actual. Mostrado en la tarjeta "Métricas de Riesgo" del tab Análisis con badge `≈ estimado` (tooltip con la metodología exacta) y lectura práctica. Verificado en vivo: 95.9% de los últimos 366 días cerraron por encima del precio actual (coherente con el -68% desde máximos de 52 semanas que muestra la misma tarjeta). Etiquetado explícitamente como aproximación metodológica, no precio realizado on-chain real.

---

## Semana 3 — Profundidad de mercado y ecosistema

**11. ~~Agregado de derivados multi-venue~~ ✅ HECHO (v2.2, 2026-07-03)**
`fetchDerivativesData()` ahora intenta también **OKX Futures** (`XRP-USDT-SWAP`, API pública sin key: `funding-rate` + `open-interest` + `mark-price`) junto a Kraken. Verificado en vivo que OKX **sí es alcanzable** desde el servidor del usuario (a diferencia de Binance/Bybit, geobloqueados) — mi propio sandbox de pruebas no pudo confirmarlo por timeout, pero el server real sí. Si OKX responde, `derivatives.venues[]` guarda el desglose por venue y el nodo expone un **agregado ponderado por Open Interest en USD** (`fundingRate8hPct`, `openInterestXrp/Usd` a nivel raíz = agregado). Si OKX falla, degrada limpio a solo-Kraken exactamente como antes (try/catch aislado, `okxUnavailableReason` queda registrado). Tarjeta Derivados (Mercado + mini de Resumen) muestra ahora el desglose por venue línea a línea. Verificado en vivo: "Derivados (2 venues): funding -0.0021%/8h · OI 84,254,353 XRP", con Kraken y OKX listados por separado.
*Hecho cuando:* ✅ la tarjeta Derivados muestra 2 venues con desglose (Kraken Futures + OKX Futures).

**12. ~~RLUSD on-ledger: split XRPL vs Ethereum~~ ✅ HECHO (v2.2, 2026-07-03)**
`fetchRlusdSplitData()`: `gateway_balances` (XRPL JSON-RPC, `xrplcluster.com`) sobre el issuer mainnet de RLUSD (`rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De`) para leer el supply real on-chain en el XRPL. El currency code no-estándar se decodifica del hex de 40 caracteres a texto (`decodeXrplCurrencyCode()`) en vez de asumir un valor fijo, para no depender de adivinar el encoding exacto. La porción "Ethereum" se infiere restando ese supply contra el market cap total de RLUSD de CoinGecko (ya en `data.ecosystem`) — se etiqueta `estimated:true` porque es una diferencia, no un dato directo de Ethereum. Nodo nuevo `rlusdSplit`. Verificado en vivo: **"RLUSD en XRPL: $848.14M (53.5%) · ≈Ethereum: $737.09M (46.5%)"** en la tarjeta Ecosistema — coincide con el hito real de 2026 de que más de la mitad de RLUSD vive en el XRPL.
*Hecho cuando:* ✅ la tarjeta Ecosistema muestra "RLUSD en XRPL: $X (Y%)".

**13. ~~Actividad XRPL: AMM y DEX~~ ✅ HECHO (v2.2, 2026-07-03)**
`fetchAmmDexData()`: XRPScan expone `/api/v1/amm/pools` (pools AMM nativos del protocolo, XLS-30) sin key. La API no pagina por tamaño ni expone el total de la red (~28K pools mencionados en el roadmap), así que se toma una **muestra** de las primeras 300 pools y se filtra a las emparejadas con XRP (la inmensa mayoría). Insight de la sesión: en un AMM de producto constante (x·y=k, como el del XRPL), el valor en USD de cada lado del pool es matemáticamente **igual** en todo momento — por eso el TVL por pool (`2 × reserva_XRP × precio_XRP`) es exacto para el tamaño de muestra, no una aproximación; lo que sí es aproximado es que es TVL de la muestra, no de toda la red (se documenta así en la UI). Tarjeta nueva "Actividad AMM/DEX" en el tab Mercado con top pools por reserva XRP. Verificado en vivo: "300 pools XRP en muestra de 300, TVL muestra ≈ $22.8M" con RLUSD/XRP, CryptoLand/XRP, etc. listados.
*Hecho cuando:* ✅ TVL aproximado en pools + nº de pools, con metodología honesta sobre qué es muestra y qué es exacto.

**14. ~~Panel de liquidaciones y volumen por exchange~~ ✅ HECHO (v2.2, 2026-07-03)**
`fetchExchangeVolumeData()`: CoinGecko `/coins/ripple/tickers` (gratuito, sin key), agregado por exchange y ordenado por volumen. Tarjeta nueva "Volumen por Exchange" (Mercado) con barras top-5 y lectura que marca automáticamente cuando la concentración surcoreana (Upbit/Bithumb/Coinone/Korbit) supera el 15% — Corea suele liderar rallies de XRP. Verificado en vivo: CoinUp.io liderando con 14.25%, 61-62 exchanges detectados.
*Hecho cuando:* ✅ volumen spot por exchange visible, con nº de exchanges detectados.

**15. ~~Correlación ETH + índice altcoins~~ ✅ HECHO (v2.2, 2026-07-03)**
Se añadió correlación XRP-ETH (30d/90d) junto a la ya existente con BTC, mismo cálculo de Pearson sobre retornos diarios. CoinGecko no expone histórico gratuito de "mercado total" más allá del snapshot de `/global`, así que ETH (el altcoin de mayor peso) se usa como proxy práctico del mercado altcoin, dejado explícito en la UI (`proxy altcoins`). Lectura combinada: "XRP se mueve con el mercado" (alta correlación con ambos) vs "narrativa propia" (baja con ambos). Verificado en vivo: Correlación BTC 90%/85% (30d/90d), ETH 92%/86% — "Correlación alta con BTC (90%) y ETH (92%): el macro cripto general pesa más que las noticias específicas de Ripple en el corto plazo."
*Hecho cuando:* ✅ correlación con ETH visible junto a BTC, con lectura conjunta.

**Bug real cazado en la verificación en vivo de esta semana:** las 2 llamadas nuevas a CoinGecko (#14 y #15) empujaron el ciclo por encima del rate-limit del free tier — no solo fallaban las nuevas, sino que **rompían en silencio** la correlación BTC (que ya funcionaba desde v2.0) y el volumen por exchange, porque ninguna llamada a CoinGecko comprobaba `resp.ok` (un 429 devuelve JSON sin los campos esperados, y el código lo trataba como "sin datos" sin loggear el motivo real). Corregido con un wrapper compartido `coingeckoFetch()` (reintenta una vez tras 15s si ve un 429) aplicado a las 7 llamadas a CoinGecko del ciclo, más chequeo `.ok` explícito y delays ampliados en el tramo denso (`fetchExchangeVolumeData` → `calculateAdvancedMetrics` → `fetchEcosystemData`). Verificado en vivo tras el fix: ciclo completo sin 429, y cuando sí aparece uno ocasional, el reintento automático lo resuelve sin intervención.

---

## Semana 4 — Robustez, calidad y pulido

**16. Tests de los cálculos financieros (M)**
`node --test` (sin dependencias): RSI Wilder, MACD, drawdown, Pearson, VaR, `amountToXrp` (incluye el caso drops corruptos > 2B), `buildDailyBrief` (conteo de señales). Smoke test del server con `data.json` de fixture.
*Hecho cuando:* `npm test` pasa y el bug de unidades whale tendría un test que lo habría cazado.

**17. Modo móvil real (M)**
El grid de 6 columnas no colapsa bien. Media queries: Resumen → 1 columna, Mercado → 2, hero apilado. El Resumen es LA vista móvil.

**18. WebSocket servidor→navegador (M-L)**
Sustituir polling (5 min + 30 s burn) por push con el paquete `ws` ya instalado: precio y burn en vivo real, menos requests. Fallback a polling si el WS cae.

**19. Backtesting del score (M, requiere #6)**
"Cuando el score superó 65, el retorno medio a 30d fue X%" — honestidad medible del indicador estrella, con nº de muestras y aviso de ventana corta.

**20. Modularización de `server.js` y `app.js` (L)**
1.900 y 2.300 líneas monolíticas. Separar por dominio (`lib/market.js`, `lib/whales.js`, `lib/burn.js`, `lib/brief.js`; frontend por render-módulos). Sin build step, manteniendo la filosofía cero-deps. Hacerlo al final del mes: con tests (#16) ya existentes, el refactor es seguro.

---

## Extras fuera del plan de 20 (pedidos por el usuario — HECHOS en v2.3, 2026-07-03)
- ✅ **Correlación con SPY (S&P 500)** en Análisis (Yahoo + fallback Stooq, alineado por sesión bursátil).
- ✅ **Toggle de idioma ES/EN** (`public/i18n.js`) — UI estática + veredictos. Pendiente: traducir las lecturas largas (señales del brief, insights, lecturas de gráficas).
- ✅ **Base de datos SQLite** (`lib/db.js`, `dashboard.db`) con fallback JSON — solo usuarios/sesiones/ajustes.
- ✅ **Sign-in multiusuario seguro** (`lib/auth.js`): scrypt, sesiones HttpOnly, rate-limit, `requireAuth` en todos los `/api/*`. Ver `docs/AUDITORIA-V3.md`.

## Backlog (después del mes)
- **Traducir al inglés las lecturas largas** (brief/insights/lecturas) — el grueso de texto que quedó en español en v2.3.
- Multi-activo (parametrizar por moneda: CoinGecko id + par Binance + APIs on-chain).
- Resumen diario narrado por IA (la infraestructura OpenAI ya existe para noticias) — solo como complemento del brief determinista, nunca en su lugar.
- Export CSV/PNG de cualquier gráfica.
- Modo "kiosko" (rotación automática de tabs para segunda pantalla).
- Mover el histórico BTC/ETH a un fetch cada N ciclos (no cada 5 min) para no tocar el rate-limit de CoinGecko — hoy la correlación ETH cae a "--" algún ciclo.

## Notas de fuentes (verificadas 2026-07-03)
- **Kraken Futures** `futures.kraken.com/derivatives/api/v3/tickers/PF_XRPUSD` — funding/OI, sin key, funciona desde EE. UU. ✔
- **OKX Futures** `www.okx.com/api/v5/public/{funding-rate,open-interest,mark-price}?instId=XRP-USDT-SWAP` — sin key, verificado alcanzable desde el servidor del usuario (EE. UU.) ✔. Nota: mi propio entorno de pruebas (sandbox) SÍ lo tuvo geobloqueado/timeout — la disponibilidad real depende de la red del servidor que corre el dashboard, no asumir a priori.
- **Binance fapi / Bybit v5** — geobloqueados en EE. UU. ✖ (no reintentar sin VPN/proxy)
- **XRPScan** `/network/metrics` y `/metrics` — 404 (muertos) ✖ · `/names/well-known` (2.772 entradas, campo `verified`) ✔ · `/account/{addr}` y `/transactions` ✔ · `/richlist` — 404 ✖ (usar Bithomp con key) · `/amm/pools` (sin paginar por total, usar `limit`/`offset`) ✔
- **CoinGecko** `/global`, `/coins/markets?ids=ripple-usd`, `/coins/{id}/market_chart`, `/coins/ripple/tickers` ✔ sin key, pero **rate limit real más estricto de lo esperado en ráfaga** (visto 429 con ~5-7 llamadas en <30s incluso repartidas con delays de 1-1.5s) — usar siempre `coingeckoFetch()` (wrapper con reintento a 15s) en cualquier fetcher nuevo que la use, y espaciar llamadas consecutivas ≥2-3s.
- **XRPL JSON-RPC** `xrplcluster.com` POST ✔ (para escrow real, `gateway_balances` de RLUSD). Currency codes no-estándar (ej. RLUSD) vienen como hex de 40 caracteres — decodificar con `decodeXrplCurrencyCode()`, no asumir el valor fijo.
