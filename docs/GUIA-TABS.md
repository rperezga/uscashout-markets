# Guía de pestañas — qué muestra cada una y cómo leerla

Documentación funcional del dashboard, tab por tab. Cada gráfica incluye una **lectura práctica** en pantalla (caja con borde de color bajo la gráfica); aquí se explica además la lógica detrás de cada una.

Convención de colores de las lecturas: verde = implicación alcista, rojo = bajista, ámbar = precaución/aviso, azul = contexto neutro.

## Navegación (v2.4)

La barra de navegación vive en su propia fila bajo el header y agrupa las 9 páginas en 4 secciones: **Inicio** (Resumen), **Mercado** (Mercado, Noticias, Derivados), **Análisis** (Análisis, Técnico) y **On-Chain** (Ballenas, Suministro, Quema en Vivo). En pantallas estrechas la barra scrollea en horizontal y oculta las etiquetas de grupo. El dashboard recuerda el último tab visitado entre recargas (dato no crítico, `localStorage`). Cada página lleva un acento de color en el borde izquierdo de sus tarjetas como guía visual: violeta = Análisis, ámbar = Técnico, celeste = Noticias, índigo = Derivados, azul = Suministro, rojo = Quema.

## Selector de moneda (v2.5)

El desplegable del header cambia la moneda activa del dashboard: XRP + las ISO 20022 (XLM, XDC, ALGO, HBAR, IOTA, QNT) + BTC y ETH. Con una moneda no-XRP activa, las páginas genéricas (Resumen, Mercado, Noticias, Derivados, Análisis, Técnico y un Suministro simplificado con circulante/total/máximo de CoinGecko) muestran los datos de esa moneda; lo exclusivo del XRP Ledger (Ballenas, Quema en Vivo, escrow, RLUSD, AMM/DEX, ETFs, on-chain XRPScan, correlaciones) se oculta hasta volver a XRP. La moneda elegida se guarda en tu cuenta. La moneda activa se refresca cada 5 min y el resto rota de fondo (~30 min); al cambiar a una moneda "fría" el servidor trae lo esencial en unos segundos. Si una moneda no cotiza en Binance (p. ej. XDC) o no tiene futuros públicos accesibles, esas tarjetas lo indican en vez de inventar datos. **Las alertas locales siguen vigilando XRP** aunque estés viendo otra moneda.

## Idioma (v2.4)

El botón 🌐 del header alterna ES/EN y el idioma se guarda en tu cuenta. Desde v2.4 la cobertura es **completa**: UI estática, lecturas prácticas, veredictos, señales del Resumen, insights, alertas y modales cambian de idioma al instante (las señales e insights llegan bilingües del servidor). Excepción honesta: el contenido externo — titulares/descripciones de noticias se muestran en su idioma original, y el "Resumen en Español" enriquecido con IA solo existe en español (en modo EN el modal muestra la descripción original y un análisis por reglas en inglés).

## Alertas locales (botón del header, v2.2)

Botón "🔔 Alertas" junto a "Refrescar", visible en cualquier tab. Abre un modal para activar notificaciones nativas del navegador (Notification API) cuando se cumplen condiciones técnicas: RSI cruza sobrecompra/sobreventa, Golden/Death Cross, precio toca soporte/resistencia/nivel psicológico, el funding cambia de signo, o el flujo neto a exchanges supera un umbral que tú defines. La configuración se guarda en `localStorage` (nunca sale de tu navegador) y solo se dispara una notificación por **transición** de estado — no repite el mismo aviso cada ciclo mientras la condición se mantiene. **Limitación honesta:** solo funciona mientras la pestaña del dashboard sigue abierta; no hay servidor de notificaciones push.

---

## 0. Resumen (tab por defecto — v2.0)

La vista de 10 segundos: abrirla debe responder "¿cómo está XRP ahora y qué tengo que vigilar hoy?" sin tocar nada.

### Hero
Precio + cambio 24h + sparkline de 30 días + market cap/volumen, y chips de: **Score técnico** (0-100), **Miedo/Codicia**, **Próximo escrow** (días) y **Posición en el rango de 52 semanas** (0% = mínimo anual, 100% = máximo). **Cómo leerlo:** el chip de rango contextualiza el precio al instante — un 3% significa "pegado a los mínimos del año".

### "El mercado de XRP, en cristiano"
Veredicto global + señales por área (tendencia, momentum, sentimiento, ballenas, derivados, presión spot, riesgo), generadas por reglas deterministas en el servidor (`buildDailyBrief()`), sin IA. El veredicto se inclina alcista/bajista cuando hay ≥2 señales netas de diferencia. **Cómo leerlo:** cada señal explica qué significa Y qué implica; el color del punto da el sesgo. No es una recomendación: es el estado de los indicadores.

### Niveles a vigilar
Soporte y resistencia de 7 días con distancia % desde el precio (dice "roto"/"superada" si el precio los cruzó) + el nivel psicológico (cifra redonda). **Cómo leerlo:** son los precios donde históricamente reacciona el mercado a corto plazo; romper el psicológico ($1.00 en 2026) suele acelerar el movimiento.

### Derivados / Ecosistema (mini)
Resumen de las tarjetas homónimas del tab Derivados (ver abajo).

### Frescura de datos
Píldora por fuente con "hace X min" (ámbar si >20 min). **Para qué sirve:** saber si lo que ves es actual o si una API está caída — honestidad de datos en un vistazo.

---

## 1. Mercado

v2.4: este tab quedó enfocado en precio y actividad spot (6 tarjetas). Noticias, Escrow, Proyecciones, Derivados, Ecosistema, AMM y ETFs viven ahora en sus propias páginas.

### Datos de Mercado
Precio spot, market cap y volumen 24h desde CoinGecko, con badges de variación 24h. **Cómo leerlo:** los badges comparan contra hace exactamente 24h; una variación de precio positiva con volumen alto tiene más fiabilidad que la misma variación con volumen bajo.

### My Crypto
Calculadora local de portafolio: introduces tus XRP y calcula valor actual, cambio 24h y valor en los escenarios bajista/alcista de la sección Proyecciones (tab Análisis desde v2.4). El dato se guarda solo en tu navegador (`localStorage`), nunca sale de tu máquina.

### Gráfica de Precio (1D / 7D / 1M / 1Y)
Histórico de CoinGecko con la resolución que corresponda al periodo. La serie mostrada se recorta **siempre** a la ventana del botón activo (v2.4: antes el refresco periódico podía pintar el año entero con "1M" seleccionado), y cada ventana se cachea 5 min — alternar entre botones es instantáneo y no gasta cuota de API. Si CoinGecko rechaza un cambio de ventana (rate limit), el botón se revierte y la lectura lo avisa; reintenta en unos segundos. **Lectura automática bajo la gráfica:** variación % del periodo, rango mín–máx, y en qué parte del rango está el precio ahora (0% = mínimo, 100% = máximo). *Interpretación:* precio pegado al máximo del periodo (>80%) = zona de resistencia, entrar ahí tiene peor ratio riesgo/beneficio; pegado al mínimo (<20%) = zona de soporte que se vigila para rebotes, pero un soporte puede romperse. La zona media no da señal.

### Datos On-Chain
Ledger actual, TPS promedio, cuentas activas y supply total desde XRPScan. Si la API de métricas no responde, las cuentas activas se estiman a partir del TPS y aparece el badge `≈ estimado`. **Cómo leerlo:** TPS y cuentas activas crecientes = uso real de la red creciendo, independiente del precio; es la métrica de "salud" menos manipulable del tab.

### Buy/Sell Pressure
Volumen taker de compra vs venta en Binance spot (XRPUSDT, 24h). **Lectura automática:** además del %, muestra el diferencial neto en USD. *Interpretación:* >55% sostenido en una dirección suele acompañar tramos direccionales; 45-55% es ruido. Limitación honesta: es solo Binance spot, no todo el mercado ni derivados.

### Volumen por Exchange (v2.2)
Top exchanges por volumen spot de XRP en 24h (CoinGecko `/coins/ripple/tickers`), con nº total de exchanges detectados. **Cómo leerlo:** complementa a Buy/Sell Pressure (que solo mira Binance) mostrando dónde se negocia XRP de verdad. Si los exchanges surcoreanos (Upbit, Bithumb, Coinone, Korbit) suman más del 15% del volumen visible, aparece un aviso: Corea históricamente lidera rallies de XRP (el "kimchi premium"), así que un salto de volumen ahí puede anticipar movimiento antes que en Occidente.

---

## 2. Noticias (v2.4: página propia)

Antes era una card compacta del tab Mercado; ahora el feed ocupa la página completa en un grid fluido de tarjetas.

### Noticias e Impacto
Feed de CryptoPanic (o RSS fallback) enriquecido con IA (si hay `OPENAI_API_KEY`): resumen en español, análisis de por qué afecta a XRP y sentimiento POSITIVO/NEGATIVO/NEUTRO. Clic en una noticia abre el detalle. **Cómo leerlo:** el sentimiento es orientativo; lo útil es el análisis de impacto (correlación BTC, frentes legales de Ripple, psicología). Las noticias que no son de XRP directo llevan el badge `CONTEXTO MACRO`.

---

## 3. Derivados & Ecosistema (v2.4: página propia)

Grid 2×2 a página completa con las cuatro tarjetas de contexto institucional/DeFi (antes apretadas al fondo del tab Mercado).

### Derivados (v2.0, multi-venue desde v2.2)
Funding rate (equivalente 8h, anualizado y predicción) y open interest de XRP, agregados entre **Kraken Futures** y **OKX Futures** (las dos fuentes públicas de derivados accesibles desde EE. UU. verificadas; Binance/Bybit geobloquean). Si OKX no responde en un ciclo concreto, la tarjeta degrada sola a mostrar solo Kraken — sin romper nada. **Cómo leerlo:** funding positivo = los largos apalancados pagan por mantener posición (optimismo apalancado, vulnerable a liquidaciones en cascada si cae); funding negativo = los cortos pagan (pesimismo saturado que a veces precede short squeezes). El OI dice cuánto dinero especulativo hay en juego. El desglose por venue (debajo de la lectura) muestra funding y OI de cada exchange por separado. *Limitación honesta:* sigue sin ser el 100% del mercado global de derivados (~$1.1B) — faltan Binance y Bybit.

### Ecosistema XRP (v2.0, split RLUSD desde v2.2)
**RLUSD emitido** (market cap del stablecoin de Ripple, CoinGecko) + **dominancia de XRP y BTC** + **RLUSD en XRPL vs Ethereum**. **Cómo leerlo:** RLUSD creciendo = más liquidación institucional vía XRPL = adopción real de la infraestructura (en 2026 >50% de RLUSD vive en el XRPL); dominancia BTC alta = el dinero sigue refugiado en Bitcoin; cuando rota hacia altcoins, la dominancia de XRP lo refleja. El split XRPL/Ethereum lee el supply real on-chain del issuer de RLUSD en el XRPL (`gateway_balances`, dato exacto) y calcula la porción en Ethereum restando contra el market cap total de CoinGecko (por eso se marca `≈estimado` — es una diferencia, no un dato directo de la cadena Ethereum).

### Actividad AMM/DEX (v2.2)
Muestra de pools AMM nativos del XRP Ledger (protocolo XLS-30, vía XRPScan), ordenados por TVL. **Cómo leerlo:** más TVL en un pool XRP/token implica más profundidad para intercambiar ese token sin mover mucho el precio — es la narrativa de "utilidad real" del XRPL más allá de la especulación de precio. *Metodología:* en un AMM de producto constante (el modelo del XRPL), el valor de cada lado del pool es matemáticamente igual, así que el TVL mostrado (2× el lado XRP al precio actual) es exacto; lo que es una **muestra**, no un dato exacto, es que solo se escanean las primeras ~300 pools (XRPScan no expone el total de la red, que ronda las 28.000 pools) — no representa el TVL agregado de todo el ecosistema AMM.

### ETFs Spot de XRP (v2.2)
AUM total, XRP en custodia, flujo neto de la última semana y acumulado desde el lanzamiento de los 7 ETFs spot de XRP en EE. UU. **Cómo leerlo:** rachas de varias semanas seguidas de entradas netas indican demanda institucional estable (absorbe oferta del mercado abierto); una semana de salidas no define tendencia por sí sola, pero cortar una racha larga sí es una señal a vigilar. *Limitación honesta explícita en la tarjeta:* no existe una API gratuita para flujos de ETF de XRP — este nodo se actualiza **a mano**, nunca en cada ciclo de refresco. La tarjeta siempre muestra la fecha del dato (`asOf`) y la fuente citada para que sepas qué tan actual es.

**Cómo actualizar `etfFlows` manualmente:** edita el nodo `etfFlows` en `data.json` (raíz del proyecto) con el servidor parado o justo antes de un refresco, y guarda:
```json
"etfFlows": {
  "aumUsd": 1000000000,
  "xrpInCustody": 966600000,
  "etfCount": 7,
  "weeklyNetFlowUsd": 23000000,
  "weeklyStreakWeeks": 8,
  "cumulativeNetFlowUsd": 1470000000,
  "asOf": "2026-07-02",
  "source": "Nombre de la fuente que consultaste",
  "manual": true,
  "lastUpdated": "2026-07-03T21:30:00.000Z"
}
```
Buenas fuentes para buscar estos datos: Cointelegraph, SoSoValue, xrp-insights.com, informes trimestrales de Ripple. Actualízalo cuando cambie el flujo semanal (idealmente cada semana).

---

## 4. Análisis

Síntesis interpretada: score, insights y escenarios. Las métricas técnicas puras (RSI, MACD, riesgo, correlaciones) viven desde v2.4 en el tab **Técnico**. Todas las métricas se calculan sobre el histórico diario de 365 días (protegido: si `chartData` está en otra resolución, se conservan los valores previos).

### Score de Inversión (Educativo)
0-100 combinando: precio vs SMA50 (±10) y vs SMA200 (±15), MACD (±10), RSI (±5/-10), Fear & Greed contrario (±5) y order flow (±5). ≥65 = sesgo alcista, ≤40 = bajista. **Lectura automática:** identifica el factor que más suma y el que más resta. *Interpretación:* es un termómetro de contexto técnico, NO una orden de compra/venta — un score alto puede coincidir con sobrecompra.

### Evolución del Score (v2.2)
Sparkline con el histórico diario del score (`history.json`, un snapshot por día). **Cómo leerlo:** el valor de hoy importa menos que la tendencia — "35→55 esta semana" dice más que "55" solo. Nota de cobertura honesta mientras se acumula histórico ("solo hay N día(s) registrado(s)"): crece un punto por día sin que tengas que hacer nada.

### Insights Automáticos
Señales generadas por reglas: Golden/Death Cross, RSI en extremos, cierres fuera de Bandas de Bollinger, volatilidad muy alta (con VaR), drawdowns, correlación BTC alta/baja, liquidez, distancia al máximo 52s, Sharpe. Cada una explica su implicación en el propio texto.

### Proyecciones + Fear & Greed (v2.4: movida desde Mercado)
Tres escenarios de precio derivados del soporte/resistencia de 7 días (±15/20%) y el índice Fear & Greed. **Lectura automática:** explica que los escenarios son rangos de volatilidad de referencia (no predicciones) y añade la señal contraria del sentimiento: miedo extremo (≤25) ha coincidido históricamente con suelos; codicia extrema (≥75) precede correcciones. El escenario resaltado visualmente sigue al sentimiento actual.

---

## 5. Técnico (v2.4: página propia)

Las métricas técnicas puras que antes compartían página con el Score. Mismo cálculo y protecciones (histórico diario de 365 días).

### Tendencia & Momentum
RSI 14 diario (Wilder), MACD (12,26,9), SMAs 20/50/200 con distancia % del precio, señal de cruce y %B de Bollinger. **Cómo leerlo:** SMA200 es el divisor tendencia mayor alcista/bajista; el MACD histograma positivo y creciente confirma momentum; RSI >70 sobrecompra / <30 sobreventa (en tendencias fuertes pueden mantenerse extremos).

### Métricas de Riesgo
Volatilidad anualizada 30/90d, max drawdown 1 año, Sharpe 90d y VaR 95% diario. **Cómo leerlo:** el VaR dice "en el 5% de peores días esperables pierdes al menos X%" — sirve para dimensionar posición; el drawdown recuerda cuánto llegó a caer quien compró en máximos; Sharpe <0 = el riesgo asumido no se pagó en los últimos 3 meses.

**Holders "bajo el agua" (aprox., v2.2):** % de días del último año con cierre por encima del precio actual — proxy de cuánta "ventana de compra" del año quedó más cara que hoy. **Cómo leerlo:** cuanto más alto, más probable que una porción grande de compradores recientes esté en pérdidas no realizadas, lo que puede generar presión de venta al recuperar su "punto de equilibrio". *Limitación honesta explícita (badge `≈ estimado`):* NO es precio realizado on-chain real (eso requeriría trazar cada cuenta/UTXO) — es una aproximación metodológica sobre el histórico de precio.

### Rendimiento & Rango 52s
Retornos 7/30/90/365d y distancia al máximo/mínimo de 52 semanas. **Cómo leerlo:** la distancia al máximo indica cuánto tendría que subir para recuperarlo (una caída del 50% exige +100%).

### Correlación BTC & Liquidez (ETH desde v2.2)
Correlación de retornos diarios XRP-BTC y XRP-ETH (30/90d) y ratio Volumen/MarketCap. ETH se usa como proxy de "mercado altcoin" (marcado `proxy altcoins` en la UI) porque CoinGecko no expone histórico gratuito de un índice altcoin agregado. **Cómo leerlo:** correlación >70% con ambos = XRP se mueve con el mercado cripto general, vigila el macro antes que las noticias de Ripple; <30% con ambos = narrativa propia (frentes legales, adopción, escrow). Ratio Vol/MCap <2% = liquidez baja, movimientos amplificados; >8% = actividad inusual, suele coincidir con eventos.

---

## 6. Whale Tracker (Ballenas)

Vigila un conjunto de wallets (exchanges y ballenas) vía XRPScan y filtra transferencias ≥50.000 XRP por defecto.

### Umbral de transferencia grande (v2.2)
Input editable en la parte superior del tab: cambia qué cuenta como "transferencia grande" sin tocar código. Al pulsar Guardar, se persiste en el servidor (`data.json`) y dispara un recálculo inmediato del Whale Tracker con el nuevo umbral — los KPIs y el feed se actualizan solos.

### KPIs superiores
Transferencias grandes 24h, volumen total movido (en XRP) y **flujo neto a exchanges**. *Semántica del flujo:* positivo (rojo) = XRP entrando a exchanges = oferta lista para venderse = presión bajista potencial; negativo (verde) = XRP saliendo a wallets frías = acumulación. El subtítulo del KPI lo explica en vivo.

### ¿Qué han hecho las ballenas? — línea de tiempo del flujo (v2.1)
Rediseño completo del antiguo gráfico de 3 barras. **Estructura:** (1) veredicto en una frase con color (acumulación / presión de venta / equilibrio / solo entre ballenas); (2) KPIs de la ventana (entró, salió, neto, entre ballenas, nº txs); (3) gráfica temporal con toggle **24h por hora / 7 días por día**: barras rojas hacia arriba = XRP entrando a exchanges, verdes hacia abajo = saliendo hacia wallets frías, violetas = entre ballenas (neutro), línea discontinua = neto acumulado.

**Cómo leerla:** la línea del cero es la frontera — actividad por encima significa oferta posicionándose para vender (bajista), por debajo acumulación en frío (alcista a medio plazo). El patrón sostenido importa más que un pico aislado (una barra única puede ser un movimiento interno de un exchange). El histórico se acumula mientras el servidor corre (XRPScan solo da transacciones recientes); una nota de cobertura lo indica mientras se llena.

### Evolución del flujo neto (v2.2)
Sparkline de barras con el histórico diario de `exchangeFlowNet` (`history.json`, un snapshot por día — mismo mecanismo que la sparkline del Score en Análisis). Rojas = neto entrando a exchanges (oferta), verdes = neto saliendo a wallets frías (acumulación). Misma nota de cobertura honesta mientras se acumula histórico.

### Grandes Transferencias y Wallets Monitoreadas
Feed clicable. Las transferencias de ejemplo llevan badge `DEMO` y aviso naranja — no son movimientos reales. Clic en cualquier wallet abre el detalle.

### Modal de detalle de wallet
Stats (ops, entradas, salidas, volumen), gráfica de flujo por operación (verde entra / rojo sale), filtros y tabla con subtipo: *Compra* (retiro desde exchange), *Venta* (envío a exchange), *Movimiento Interno*. **Lectura automática:** clasifica el perfil de la cuenta como acumulación (neto entrante), distribución (neto saliente) o neutro, y avisa si el historial es de demostración.

---

## 7. Suministro (Supply Distribution + Ripple Escrow)

v2.4: la tarjeta de Ripple Escrow vive ahora aquí, al lado de la distribución — temáticamente es suministro bloqueado.

### Barra apilada + leyenda
Circulante (azul), escrow de Ripple (gris) y quemado (rojo, ampliado para ser visible: real ~0,01%). La cifra de escrow se deriva de `events.previousCycle.remainingEscrow`, que desde v2.2 es una lectura real on-chain del XRPL (ver roadmap #3) — por eso siempre coincide con la tarjeta de Escrow de este mismo tab, mismo dato y mismo timestamp.

### Desglose estimado
Exchanges (~12% del circulante), whales (~65%) y free float — **son estimaciones** (badge `Estimated`), no datos on-chain exactos.

### Insights (lecturas)
1. **Escrow:** cuánto controla Ripple y la dilución máxima mensual que puede introducir (1B ≈ % del circulante calculado en vivo) vs la real histórica (<0,5%).
2. **Liquidez:** el free float es lo realmente disponible para trading minorista; cuanto menor, más violentos los movimientos en ambas direcciones.
3. **Concentración:** pocas cuentas concentran gran parte del supply — la razón de ser del Whale Tracker.

### Ripple Escrow (v2.4: movida desde Mercado)
Cuenta atrás para la liberación mensual (1B XRP el día 1) y desglose del ciclo anterior: liberado / devuelto / neto en circulación. **Lectura automática:** calcula qué % del circulante representó el neto del mes pasado. *Interpretación:* históricamente Ripple devuelve 70-80% al escrow, así que la dilución real mensual suele ser <0,5% del circulante — el evento genera más titulares que presión de venta. La lectura avisa en ámbar si un mes se devuelve menos de lo habitual.

**Total real on-chain (v2.2):** bajo la cuenta atrás, la línea "✓ On-chain XRPL" muestra el total efectivamente bloqueado en escrow ahora mismo, leído directamente del XRPL (`account_objects type=escrow` de las cuentas de escrow de Ripple vía `xrplcluster.com`) — no una estimación. Incluye nº de escrows activos, cuentas escaneadas y antigüedad del dato. El desglose liberado/devuelto/neto del recuadro "Ciclo Anterior" sigue marcado `≈ típico`: son cifras representativas del patrón habitual de Ripple (libera 1000M, devuelve ~800M), no el dato exacto de ese mes — calcularlo exacto requiere histórico diario (ver roadmap #6). El total en escrow (la barra apilada y esta tarjeta) sí es siempre el mismo dato real, con el mismo timestamp.

---

## 8. Quema en Vivo (Burn Impact)

### Monitor en Vivo
Conexión WebSocket al XRPL (badge de fuente: `XRPL Live · WS` / `REST poll` / `Estimado`). Muestra total quemado histórico con contador animado, quema desde que abriste el tab, última hora y últimas 24h **reales**.

### Burn por hora (gráfica 24h)
Barras **rojas = quema real** medida del XRPL; **grises = estimación inicial** sembrada para que la gráfica no arranque vacía (el subtítulo indica cuántas horas siguen siendo estimadas; se van reemplazando con datos reales). **Lectura automática:** proyecta el ritmo real a un año y lo expresa como % del circulante. *Conclusión honesta:* la quema del XRPL (fees anti-spam) es del orden de milésimas de % anual — no es un mecanismo deflacionario que mueva el precio, digan lo que digan los titulares.

### Proyecciones de Impacto y Escenarios
Quema acumulada a 30d/90d/1a/5a/10a con el ritmo actual, y comparación con escenarios bajo (1.200), actual y alto (8.500 XRP/día).

### Full Supply Burn Projection
Tiempo hasta agotar max supply / total restante / circulante al ritmo actual (proyección lineal teórica). **Lectura automática:** pone la cifra (típicamente decenas de milenios) en contexto: la "escasez por quema" no es un argumento de inversión a escala humana.
