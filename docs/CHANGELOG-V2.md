# Changelog v2.x — 3 de julio de 2026

## v2.3 — SPY, idioma ES/EN, base de datos y sign-in seguro

Auditoría profunda completa en `docs/AUDITORIA-V3.md`. Resumen de lo nuevo (todo verificado en vivo con login real):

- **Correlación con SPY (S&P 500)** en el tab Análisis. Fuente Yahoo Finance con fallback Stooq (ambas sin key). Alineación por SESIÓN bursátil (SPY no cotiza fines de semana) — 21/63 sesiones ≈ 1/3 meses. La lectura conjunta ahora distingue "arrastrado por cripto" vs "activo de riesgo global (vigila bolsa/tasas)" vs "narrativa propia". Verificado: XRP-SPY 28% (30d) / 24% (90d).
- **Toggle de idioma ES/EN** (botón 🌐 en el header). Español es el idioma fuente; `public/i18n.js` guarda solo los overrides al inglés. Traduce toda la UI estática (menús, títulos, KPIs, botones, leyendas, niveles, frescura de datos) + veredictos principales. Las lecturas largas por reglas siguen en español con aviso explícito en la UI. El idioma se guarda en la cuenta (viaja entre navegadores).
- **Base de datos SQLite** (`lib/db.js`): SQLite nativo de Node (`dashboard.db`), cero deps, con fallback JSON automático si el runtime no lo trae. Solo usuarios/sesiones/ajustes — el estado del dashboard sigue en `data.json`/`history.json`.
- **Sign-in multiusuario seguro** (`lib/auth.js`): contraseñas con scrypt+salt, sesiones en cookie HttpOnly/SameSite=Strict (en BD solo el SHA-256 del token), rate-limit por IP, primer usuario = owner. TODOS los `/api/*` protegidos con `requireAuth`. "My Crypto" y el idioma se guardan por usuario.
- **Nota de seguridad**: cookie sin `Secure` porque corre en localhost/http. Exponerlo fuera de localhost exigiría HTTPS + Secure.
- Pendiente documentado: traducir las lecturas largas al inglés; suavizar el rate-limit de CoinGecko en la correlación ETH (mover el histórico BTC/ETH a cada N ciclos).

---

## v2.2 (continuación 3) — Semana 3 del roadmap: derivados multi-venue, RLUSD split, AMM/DEX, volumen por exchange, correlación ETH

**Roadmap #11 — Derivados multi-venue:**
- `fetchDerivativesData()` suma **OKX Futures** (`XRP-USDT-SWAP`) a Kraken: 3 llamadas públicas cortas sin key (`funding-rate`, `open-interest`, `mark-price`) con timeout de 6s vía `AbortController` (`fetchWithTimeout()`). Verificado en vivo que OKX es alcanzable desde el servidor del usuario (mi sandbox de pruebas lo tuvo geobloqueado/timeout — no es lo mismo).
- Si OKX responde: `derivatives.venues[]` con el desglose por venue, y los campos raíz (`fundingRate8hPct`, `openInterestXrp/Usd`) pasan a ser el **agregado ponderado por Open Interest en USD** entre ambos venues. Si OKX falla: degrada limpio a solo-Kraken, exactamente igual que antes (`okxUnavailableReason` queda registrado para diagnóstico).
- Tarjeta Derivados (Mercado) y mini-card de Resumen actualizadas para mostrar el desglose por venue y el nombre dinámico del agregado (antes decían "Kraken Futures" fijo en 3 sitios distintos del código).

**Roadmap #12 — RLUSD on-ledger: split XRPL vs Ethereum:**
- `fetchRlusdSplitData()`: `gateway_balances` (XRPL JSON-RPC, `xrplcluster.com`) sobre el issuer mainnet de RLUSD para leer el supply real on-chain en el XRPL. Nueva función `decodeXrplCurrencyCode()` decodifica el currency code hex de 40 caracteres a texto en vez de asumir un valor fijo de antemano.
- La porción "Ethereum" se infiere restando ese supply contra `data.ecosystem.rlusdMarketCapUsd` (CoinGecko) — se marca `estimated:true` porque es una diferencia, no un dato directo.
- Nodo nuevo `rlusdSplit`. Tarjeta Ecosistema (Mercado) muestra "RLUSD en XRPL: $X (Y%)" + "≈Ethereum: $Z (W%)" con lectura práctica. Verificado en vivo: 53.5% en XRPL / 46.5% en Ethereum.

**Roadmap #13 — Actividad XRPL: AMM y DEX:**
- `fetchAmmDexData()`: XRPScan `/api/v1/amm/pools` (sin key), muestra de 300 pools filtradas a pares con XRP. Insight matemático usado: en un AMM de producto constante (x·y=k, el modelo del XRPL), el valor USD de cada lado del pool es igual en todo momento, así que TVL por pool = 2×(reserva XRP × precio) es **exacto** para la muestra — lo aproximado es que es TVL de la muestra (300 pools), no de las ~28K de toda la red (documentado explícitamente en la UI, no se presenta como agregado global).
- Tarjeta nueva "Actividad AMM/DEX" (tab Mercado): top pools por reserva XRP con badge de verificado, TVL, y lectura práctica. Verificado en vivo: TVL muestra ≈ $22.8M sobre 300 pools XRP.

**Roadmap #14 — Panel de volumen por exchange:**
- `fetchExchangeVolumeData()`: CoinGecko `/coins/ripple/tickers`, agregado por exchange. Tarjeta nueva "Volumen por Exchange" con barras top-5 y aviso automático si la concentración surcoreana (Upbit/Bithumb/Coinone/Korbit) supera 15%. Verificado en vivo: CoinUp.io liderando (14.25%), 61-62 exchanges detectados.

**Roadmap #15 — Correlación ETH + proxy de altcoins:**
- Extendido el cálculo de correlación (ya existente para BTC) a ETH, mismo Pearson sobre retornos diarios de 30d/90d. Etiquetado explícitamente `proxy altcoins` en la UI porque CoinGecko no expone histórico gratuito de "mercado total". Lectura conjunta BTC+ETH. Verificado en vivo: 90%/85% BTC, 92%/86% ETH.

**Bug real cazado en la verificación en vivo de esta semana — rate-limit de CoinGecko en cascada:**
- Las 2 llamadas nuevas a CoinGecko (#14 y #15) empujaron el ciclo por encima del rate-limit del free tier. Como ningún fetcher comprobaba `resp.ok`, un 429 devolvía JSON sin los campos esperados y el código lo trataba como "sin datos" sin loggear el motivo — **rompiendo en silencio también la correlación BTC y el volumen por exchange**, que llevaban funcionando desde v2.0/antes de esta sesión.
- Corregido con `coingeckoFetch()`: wrapper compartido que reintenta una vez tras 15s si ve un 429, aplicado a las 7 llamadas a CoinGecko del ciclo (`fetchMarketData`, `fetchChartData`, correlación BTC, correlación ETH, `fetchExchangeVolumeData`, `fetchEcosystemData` ×2, y el endpoint on-demand `/api/chart/:days`). Añadido chequeo `.ok` explícito en los fetches de correlación (antes fallaban en silencio). Delays ampliados en el tramo denso del ciclo (`fetchExchangeVolumeData` → `calculateAdvancedMetrics` → `fetchEcosystemData`).
- Verificado en vivo tras el fix: ciclo completo sin 429; en una ejecución posterior apareció un 429 aislado en `fetchEcosystemData` y el reintento automático lo resolvió sin intervención (log: "CoinGecko 429 (rate-limit)... reintentando en 15s..." seguido de "Ecosistema actualizado").
- Efecto secundario conocido y aceptado: si `fetchEcosystemData` necesita su reintento de 15s, `fetchRlusdSplitData` (que corre justo después) puede leer `data.ecosystem` todavía no actualizado ese ciclo concreto — se degrada mostrando solo el supply on-chain de XRPL sin el % (mismo patrón de "conserva estado anterior" del resto del proyecto) y se autocorrige en el siguiente ciclo (~5 min después).

### Archivos tocados (continuación 3, v2.2 — Semana 3)
| Archivo | Cambio |
|---|---|
| `server.js` | `coingeckoFetch()`, `fetchWithTimeout()`, `fetchOkxDerivatives()`, `decodeXrplCurrencyCode()`, `fetchRlusdSplitData()`, `fetchAmmDexData()`, `fetchExchangeVolumeData()` (ya existente de sesión previa, sin cambios de fondo), extensión de correlación ETH en `calculateAdvancedMetrics()`, `dataQuality` con 3 fuentes nuevas |
| `public/app.js` | `renderAmmDex()`, extensión de `renderEcosystem()` (split RLUSD), extensión de `renderDerivatives()` (desglose por venue), textos dinámicos de venue en el brief de Resumen |
| `public/index.html` | Tarjeta "Actividad AMM/DEX" (Mercado), badges "Kraken + OKX" (3 sitios, antes fijos en "Kraken Futures"), `?v=15` |

---

## v2.2 (continuación 2) — Semana 2 del roadmap: sparklines, alertas, umbral configurable, holders underwater

**Roadmap #7 — Sparklines de score y flujo whale:**
- Nueva sección "Evolución del Score" (tab Análisis) y "Evolución del flujo neto" (tab Ballenas), alimentadas por `GET /api/history` (fetch separado de `/api/data`, cacheado en `historyCache`).
- `renderScoreSparkline()` / `renderWhaleFlowSparkline()` en `app.js`, con nota de cobertura honesta ("histórico en construcción: solo hay N día(s) registrado(s)...") mientras `history.json` se llena — mismo patrón que el log `flowEvents` del Whale Tracker (v2.1).

**Roadmap #8 — Sistema de alertas locales:**
- Modal "Alertas" (botón nuevo en el header): 5 condiciones activables (RSI 30/70, Golden/Death Cross, niveles soporte/resistencia/psicológico, cambio de signo del funding, flujo whale sobre umbral configurable). Config en `localStorage`.
- `checkAlerts()` corre en cada ciclo del frontend; solo notifica en **transiciones** de estado (guardadas también en `localStorage`) para no repetir el mismo aviso cada ~5 min.
- Browser Notification API nativa, con notificación de prueba al guardar la configuración y estado del permiso visible en el modal.

**Roadmap #9 — Umbral whale configurable:**
- Input + botón "Guardar" en el tab Ballenas. Nuevo endpoint `POST /api/whale-threshold`, persiste en `whaleTracker.threshold` vía `withDataFile` y dispara un refresco inmediato de `fetchWhaleData()`. `fetchWhaleData()` ahora lee `data.whaleTracker.threshold` en vez de la constante fija `WHALE_THRESHOLD`.
- **Bug real cazado en verificación en vivo:** el input mostraba brevemente el umbral anterior justo después de guardar uno nuevo (leía `summary.threshold`, que tarda el ciclo completo de `fetchWhaleData()` en refrescarse, en vez del campo de nivel superior que se actualiza al instante). Corregido en la misma sesión.

**Roadmap #10 — Holders underwater (aproximado):**
- `underwaterApprox` en `advancedMetrics.risk`: % de días del último año con cierre por encima del precio actual (sobre el mismo array de 365 días protegido por span que ya usa `calculateAdvancedMetrics`). Mostrado en "Métricas de Riesgo" (tab Análisis) con badge `≈ estimado` y metodología explícita en el tooltip — nunca se presenta como precio realizado on-chain real.

### Archivos tocados (continuación 2, v2.2)
| Archivo | Cambio |
|---|---|
| `server.js` | `underwaterApprox` en `calculateAdvancedMetrics()`, umbral configurable en `fetchWhaleData()`, endpoint `POST /api/whale-threshold` |
| `public/app.js` | `loadHistoryData()`, `renderScoreSparkline()`, `renderWhaleFlowSparkline()`, modal de Alertas (`checkAlerts()`, `loadAlertsConfig()`/`saveAlertsConfig()`, `notifyAlert()`), UI de umbral whale, lectura de `underwaterApprox` |
| `public/index.html` | Botón + modal "Alertas", secciones de sparkline en Análisis/Ballenas, input de umbral whale, `?v=12` |

---

## v2.2 (continuación) — history.json + ETFs spot de XRP

**Roadmap #6 — `history.json`, snapshots diarios:**
- `appendDailyHistorySnapshot()`: archivo nuevo `history.json` (fuera de `data.json`, sin pasar por `withDataFile` — es un array append-only propio sin escritores concurrentes). Upsert por día natural: cada ciclo de refresco sobreescribe la entrada de "hoy"; al cambiar el día queda fijada como snapshot final de esa fecha.
- Campos por snapshot: `date`, `price`, `score`, `whaleExchangeFlowNet`, `fundingRate8hPct`, `openInterestXrp`, `rlusdMarketCapUsd`, `fearGreed`, `dailyBurnXrp`, `btcDominancePct`, `xrpDominancePct`, `escrowRemainingB`, `capturedAt`.
- Rotación automática: conserva como máximo 400 días (~13 meses).
- Nuevo endpoint `GET /api/history`.
- Wired al final de `refreshAllData()`. Sin uso en la UI todavía — es la capa de persistencia que desbloquea sparklines (#7), holders underwater (#10) y backtesting (#19) en próximas sesiones.

**Roadmap #1 — Tracker de flujos de ETFs de XRP:**
- Nodo `etfFlows` en `data.json`: manual-actualizable, **nunca autofetcheado** (no hay fetcher en `refreshAllData()` — confirmado que sigue sin existir una API gratuita para esto). Sembrado con datos reales de investigación web al 2026-07-02: 7 ETFs spot de XRP en EE. UU., ~$1.0B AUM, 966.6M XRP en custodia, 8ª semana consecutiva de entradas netas (+$23M la última semana), $1.47B acumulado desde el lanzamiento (fuentes: Cointelegraph, Binance Square, WEEX).
- Tarjeta nueva "ETFs Spot de XRP" en el tab Mercado (`#etf-flows-card`, `renderEtfFlows()` en `app.js`): AUM, flujo semanal, acumulado, lectura práctica sensible a la racha de semanas, y nota de "actualización manual" con fuente y fecha del dato siempre visibles (nunca se presenta como dato en vivo).
- `initialData.etfFlows = null` en `server.js`: instalaciones nuevas arrancan con la tarjeta en estado "sin datos — actualízalo a mano", nunca con un placeholder que parezca real.

**Roadmap #4 — Cohortes de holders: ⛔ BLOQUEADO.** `ledger.exposed` cerró permanentemente (confirmado visitando el sitio). Bithomp requiere API key (registro de cuenta de terceros — no es algo que pueda hacer en tu nombre). Ver detalle y alternativas propuestas en `ROADMAP-V2.md`.

### Archivos tocados (continuación v2.2)
| Archivo | Cambio |
|---|---|
| `server.js` | `appendDailyHistorySnapshot()`, `readHistoryFile()`, endpoint `/api/history`, `initialData.etfFlows` |
| `public/app.js` | `renderEtfFlows()`, wired en `loadDashboardData()` |
| `public/index.html` | Tarjeta `#etf-flows-card` en tab Mercado, `?v=8` |
| `data.json` | Nodo `etfFlows` sembrado con datos reales al 2026-07-02 |
| `history.json` | Archivo nuevo (creado en el primer ciclo tras reiniciar) |

---

## v2.2 — Escrow real on-chain + purga de deuda técnica

**Roadmap #5 — Purga de deuda técnica:**
- `technicals.rsi` (RSI naive de 7 días, ganancias/pérdidas acumuladas sin suavizado Wilder) eliminado de `calculateTechnicals()`. Nunca lo consumía la UI (usa `advancedMetrics.momentum.rsi14`, el RSI 14 Wilder real); mantenerlo suponía dos "RSI" distintos y potencialmente contradictorios en `data.json`.
- Nodo muerto `supplyOverview` purgado de `data.json` (congelado desde el 25 de abril; nada lo escribía ni lo leía desde v2.0, cuando `supplyDistribution` lo sustituyó).
- `fix.js` (script de reparación puntual de `app.js`, ya no necesario) movido a `scratch/`.

**Roadmap #3 — Escrow real leído del XRPL:**
- Nueva `fetchEscrowOnChainData()`: descubre las cuentas de escrow de Ripple ("Ripple 1".."Ripple 55") vía la lista well-known de XRPScan (`/api/v1/names/well-known`, ya usada para las wallets reales del Whale Tracker — mismo `name`/`desc` que "Binance 1", "Binance 2"...) y consulta `account_objects type=escrow` de cada una vía `xrplcluster.com` (JSON-RPC POST, mismo endpoint que ya usa `xrplBurnWatcher.js`). Cualquier objeto Escrow devuelto está por definición aún bloqueado (el XRPL borra el ledger entry al ejecutar `EscrowFinish`/`EscrowCancel`), así que sumar `Amount` de todas las cuentas da el total real restante — sin tabla mensual que mantener a mano.
- Nodo nuevo `escrowOnChain`: `totalRemainingXrp`, `totalRemainingB`, `accountsScanned`, `activeEscrows`, `nextRelease`, `upcoming` (próximas 5 liberaciones por `FinishAfter`), `source`, `lastUpdated`.
- `updateEvents()` ya no usa la tabla `escrowHistory` hardcodeada (4 meses, quedaba obsoleta cada mes): `previousCycle.remainingEscrow` sale de `escrowOnChain.totalRemainingB` cuando la lectura on-chain tiene éxito (`remainingEscrowSource: 'on-chain (XRPL)'`), con fallback a 33.5B solo si falla completamente.
- `fetchSupplyDistributionData()` ya derivaba `escrowSupply` de `events.previousCycle.remainingEscrow` — al quedar ese campo respaldado por datos reales, Suministro y la tarjeta Escrow de Mercado muestran automáticamente la misma cifra on-chain, con el mismo timestamp. `estimatedFields` deja de listar `escrowSupply` cuando el origen es on-chain.
- UI (`app.js`): nueva línea "✓ On-chain XRPL" bajo la tarjeta de Escrow con el total real, nº de escrows activos, cuentas escaneadas y antigüedad del dato. El desglose liberado/devuelto/neto del ciclo anterior sigue marcado `≈ típico` (ver Deuda conocida).
- `buildDailyBrief()`: `Escrow (XRPL on-chain)` añadido a la lista de `dataQuality` del tab Resumen.
- **Deuda conocida (documentada, no bloqueante):** el desglose mensual liberado/devuelto/neto sigue siendo una aproximación típica (1000/800/200 XRP), no un dato real por mes — calcularlo exacto requiere diffear el total on-chain día a día, lo cual depende de `history.json` (roadmap #6, aún no implementado en esta sesión). Se marca `estimated:true` explícitamente para que la UI no lo presente como medido.

### Archivos tocados (v2.2)
| Archivo | Cambio |
|---|---|
| `server.js` | `discoverRippleEscrowAccounts()`, `fetchAccountEscrowObjects()`, `fetchEscrowOnChainData()`, `updateEvents()` reescrito sin tabla hardcodeada, `fetchSupplyDistributionData()` propaga el origen on-chain, `calculateTechnicals()` sin `rsi`, `buildDailyBrief()` con nueva fuente de `dataQuality`, wired en `refreshAllData()` |
| `public/app.js` | Línea "✓ On-chain XRPL" en la tarjeta Escrow, tooltip del badge `≈ típico` actualizado |
| `public/index.html` | `?v=7` |
| `data.json` | `technicals.rsi` y `supplyOverview` purgados |
| `fix.js` → `scratch/fix.js` | Movido |

---

## v2.1 — Rediseño completo del tab Ballenas (línea de tiempo de flujo)

**Problema:** el gráfico de 3 barras estáticas agregaba ~50 transferencias sin dimensión temporal — no contaba QUÉ pasó ni CUÁNDO, y sus totales (688M "a wallets") contradecían al KPI de 24h (0 XRP) porque mezclaban ventanas distintas.

**Rediseño (formato estándar de "exchange netflow", como CryptoQuant/Glassnode):**
- **Veredicto primero:** una frase grande con color dice al instante qué pasó ("ACUMULACIÓN: salieron X XRP netos...", "PRESIÓN DE VENTA...", "solo movimientos entre ballenas...").
- **Línea de tiempo con toggle 24h (por hora) / 7 días (por día):** barras rojas hacia arriba = XRP entrando a exchanges; verdes hacia abajo = saliendo hacia wallets frías; violetas = entre ballenas (neutro); línea discontinua = neto acumulado de la ventana. La línea del cero separa visualmente venta de acumulación.
- **KPIs de la ventana:** entró / salió / neto / entre ballenas / nº transferencias — mismas cifras que el gráfico y que el KPI superior (una sola fuente de verdad: `flowTimeline`).
- **Feed con dirección:** cada transferencia lleva chip "→ a exchange" (rojo) / "← desde exchange" (verde) / "↔ entre ballenas" (violeta) + tiempo relativo.
- **Histórico persistente:** nuevo log rodante `whaleTracker.flowEvents` (7 días, dedupe por hash, se conserva entre reinicios y se une con lo ya almacenado) → buckets `flowTimeline.hourly/daily` + totales 24h/7d calculados en el servidor. La señal "Ballenas" del tab Resumen usa la misma fuente.
- **Honestidad:** nota de cobertura ("histórico en construcción: hay datos desde hace Xh") mientras el log se llena — XRPScan solo devuelve las transacciones recientes, el dashboard acumula el resto con el tiempo.

---

# Changelog v2.0 — 3 de julio de 2026

Rediseño profundo orientado a usabilidad: **cada tab debe ser útil con solo abrirlo y cada gráfica debe hablar por sí sola**. Todo se verificó ejecutando el sistema en vivo (servidor + navegador, tab por tab) antes y después de los cambios.

---

## Bugs críticos encontrados en la revisión en vivo (y corregidos)

### 1. 🔴 Whale Tracker mostraba volúmenes imposibles (billones de XRP)
**Síntoma en pantalla:** "Volumen Ballenas (24h): 10,755,256,293,134 XRP" — 107× el supply total de XRP. Transferencias individuales de "8,819,991,780,000 XRP".
**Causa raíz:** `data.json` arrastraba transferencias escritas por una versión anterior sin la normalización drops→XRP, y la protección "conservar data previa si el fetch no trae nada" las perpetuaba para siempre.
**Corrección:**
- `sanitizeWhaleData()` en el arranque: descarta cualquier monto > 2B XRP (físicamente imposible: el mayor movimiento recurrente es el escrow de 1B) y recalcula el summary.
- `amountToXrp()` ahora también tolera `Amount` numérico y aplica el mismo tope de sanidad.
- Resultado verificado en vivo: volumen 24h pasó de 10.7 billones → **11.76M XRP** con transferencias reales (351.8K, 230K, 100K...).

### 2. 🔴 Race condition en las escrituras de `data.json` (valores contradictorios en pantalla)
**Síntoma en pantalla:** el tab Quema mostraba "Daily Burn Rate: 8.624 XRP/día" y a 30 cm "Escenario Actual: 2.450" — el mismo dato, dos valores.
**Causa raíz:** el burn watcher escribe `burnImpact.realtime` cada ~30 s de forma asíncrona con su propio leer-todo→escribir-todo, mientras los fetchers hacen lo mismo. Dos read-modify-write concurrentes se pisan (lost update) y dejan nodos mezclados de ciclos distintos. También podían chocar `/api/chart/:days`, `/api/wallet-history` y un refresh manual solapado con el automático.
**Corrección:** `withDataFile()` — cola de escritura serializada (promesa encadenada): cada escritor lee FRESCO, muta solo su nodo y escribe atómico. Todos los escritores migrados (15 puntos de escritura). Guard `refreshInProgress` para evitar ciclos solapados. El frontend además fuerza que "Actual" muestre siempre el mismo número que el KPI.

### 3. 🔴 Endpoints muertos de XRPScan usados en producción
`https://api.xrpscan.com/api/v1/network/metrics` y `/api/v1/metrics` devuelven **404** (verificado 2026-07-03). Supply Distribution y Burn Impact caían SIEMPRE al fallback constante (99.987B).
**Corrección:** el total real ahora viene de `onChainData.totalCoins` (ledger vivo) o del propio watcher (`lastTotalCoins` del XRPL). El "Total Burned" pasó de un valor congelado a 14,359,480 XRP real.

### 4. 🟠 Etiqueta "(MOCK)" sobre datos reales
Las wallets vigiladas mostraban "Binance Cold Wallet (MOCK)" con transferencias reales al lado (sin badge DEMO porque los hashes eran reales). Mezcla tóxica: datos reales con apariencia de falsos y viceversa.
**Corrección:** el sufijo "(MOCK)" se convierte en badge `DEMO` explícito solo cuando corresponde; las cuentas verificadas de la lista well-known de XRPScan llevan badge ✓; se prefieren cuentas `verified:true` y el matching de nombres acepta variantes ("Binance 3", "Binance cold").

### 5. 🟠 Lectura de la gráfica de precio recortada
La lectura práctica (posición en el rango, % del periodo) quedaba cortada por el borde inferior de la tarjeta. **Corrección:** la lectura vive fuera del contenedor del canvas y las filas del grid ya no se comprimen por debajo de su contenido (`minmax`).

### 6. 🟠 Noticias: un dashboard de XRP dominado por titulares de Bitcoin
CryptoPanic se consultaba con `currencies=XRP,BTC,ETH` y el fallback RSS mezclaba sin priorizar: 4 de 5 noticias eran de BTC.
**Corrección:** primario solo XRP; el fallback ordena XRP/Ripple primero; lo demás se etiqueta `CONTEXTO MACRO` en la UI; dedupe por título (la misma noticia llegaba duplicada con URLs de tracking distintas).

### 7. 🟡 "Extrapolado de 0h de datos reales"
El KPI de burn podía presumir de dato real con 0 horas de cobertura. **Corrección:** lógica de etiquetas honesta (estimado / cobertura parcial <1h / extrapolado de Nh / real 24h) y `burnRateTrend` deja de ser un texto fijo decorativo.

### 8. 🟡 Otros
- Ciclo de escrow no cargado en el historial → se marca `estimated` y la UI muestra "≈ típico" (antes presentaba 1000/800 como dato del mes).
- Ejes del chart de flujo whale con "2000000.0M" → formateador B/M/K.
- Números de supply ilegibles (66,487,000,000) → formato compacto 66.49B con detalle en tooltip.
- Favicon añadido; título con versión; sin errores de consola verificado.

---

## Nuevas capacidades v2.0

### Tab "Resumen" (nuevo, tab por defecto) — la vista de 10 segundos
- **Hero:** precio grande + cambio 24h + sparkline de 30 días + cap/volumen + chips de score técnico, Fear & Greed, próximo escrow y posición en el rango 52s.
- **"El mercado de XRP, en cristiano":** veredicto global + 6-7 señales (tendencia, momentum, sentimiento, ballenas, derivados, presión spot, riesgo) generadas por `buildDailyBrief()` en el servidor con **reglas deterministas** (sin IA: funciona siempre, sin claves).
- **Niveles a vigilar:** soporte/resistencia 7d con distancia % (y "roto/superada" cuando el precio los cruza) + nivel psicológico.
- **Frescura de datos:** píldoras por fuente (Precio, On-chain, Spot, Sentimiento, Ballenas, Derivados, Ecosistema) con "hace X min" y aviso si >20 min — el usuario siempre sabe qué tan actual es lo que ve.

### Derivados (tarjeta nueva en Mercado + mini en Resumen)
Funding rate (equivalente 8h + anualizado + predicción) y open interest de XRP desde **Kraken Futures** — elegido porque Binance Futures y Bybit están **geobloqueados en EE. UU.** (verificado en vivo). Lectura práctica del signo del funding (largos pagan / cortos pagan) y nota honesta de que es una muestra, no el agregado global.

### Ecosistema XRP (tarjeta nueva en Mercado + mini en Resumen)
- **RLUSD emitido** (market cap, CoinGecko) — el termómetro público de adopción institucional de Ripple: cada operación RLUSD en el XRPL liquida usando XRP.
- **Dominancia XRP y BTC** + variación del mercado total — contexto macro de rotación.

### Precio siempre visible
Chip de precio + 24h en el header, en cualquier tab.

### Investigación que sustenta las novedades (julio 2026)
Lo que los inversores de XRP siguen hoy: flujos de los 7 ETFs spot de EE. UU. (~$1.5B acumulado desde nov-2025), acumulación whale (wallets ≥1M XRP en máximos), netflows de exchanges, open interest (~$1.1B agregado, mínimos anuales) y funding, RLUSD (~$1.6B, >50% en XRPL), RWA tokenizado en XRPL ($2.25B ATH), escrow mensual y niveles $1.00 / $1.18-1.22. Los que tienen fuente pública gratuita ya están en el dashboard; el resto está priorizado en `ROADMAP-V2.md`.

---

## Archivos tocados

| Archivo | Cambio |
|---|---|
| `server.js` | `withDataFile()` + 15 escritores migrados, `sanitizeWhaleData()`, `fetchDerivativesData()`, `fetchEcosystemData()`, `buildDailyBrief()`, endpoints muertos sustituidos, noticias XRP-first con dedupe, wallets verificadas, guard de refresh |
| `public/index.html` | Tab Resumen completo, nav en español, tarjetas Derivados/Ecosistema, chip de precio en header, favicon, `?v=5` |
| `public/app.js` | `renderResumen()`, `renderDerivatives()`, `renderEcosystem()`, `renderHeaderPrice()`, `fmtCompact()`, badges DEMO/✓/macro, consistencia burn, arreglos de formato |
| `public/style.css` | Estilos Resumen/hero/chips/señales/niveles/calidad, derivados, badges, scroll del tab Mercado, filas `minmax`, mini-cards de comparación |
| `package.json` | v2.0.0 |

## Deuda conocida que queda (ver ROADMAP-V2.md)
- El gráfico "Flujo de Dinero" agrega las últimas ~50 transferencias almacenadas, no una ventana de 24h estricta.
- `technicals.rsi` (RSI acumulativo 7d, naive) sigue calculándose aunque la UI ya no lo usa — candidato a eliminarse.
- El nodo legado `supplyOverview` en `data.json` está muerto desde abril y puede purgarse.
- `fix.js` en la raíz es un script de reparación histórico; mover a `scratch/` o borrar.
- El historial de escrow requiere carga manual mensual (o mejor: leerlo del XRPL, ver roadmap #3).
