# Métricas e Insights de Inversión

Guía de cada métrica de la pestaña **Análisis** (`data.advancedMetrics`, calculadas en `calculateAdvancedMetrics()` de `server.js` sobre el histórico diario de 365 días). Todas son educativas; ninguna constituye asesoramiento financiero.

## Momentum

**RSI 14 (Wilder)** — Índice de fuerza relativa con suavizado de Wilder sobre velas diarias (a diferencia del RSI "básico" de 7 días de la pestaña Mercado). Lectura: >70 sobrecompra (riesgo de corrección), <30 sobreventa (posible rebote), 45-60 zona sana. En tendencias fuertes puede permanecer en extremos mucho tiempo.

**MACD (12, 26, 9)** — Diferencia entre EMA12 y EMA26 con línea de señal EMA9. El histograma positivo indica momentum alcista creciente; el cruce de histograma de negativo a positivo suele preceder tramos alcistas (y viceversa).

**Bandas de Bollinger (20, 2σ)** — `%B` indica dónde está el precio dentro de las bandas: 0 = banda inferior, 1 = superior. Valores fuera de [0,1] son extremos estadísticos. El `bandwidth` mide compresión: bandas muy estrechas suelen preceder movimientos bruscos.

## Tendencia

**SMA 20 / 50 / 200** — Medias móviles simples. La relación del precio con la SMA200 define la tendencia mayor; con la SMA50, la intermedia. Se muestra la distancia porcentual del precio a cada una.

**Cruce de medias (Golden/Death Cross)** — Detecta el cruce de SMA50 sobre/bajo SMA200 comparando el valor de hoy con el de ayer. `GOLDEN_CROSS` y `DEATH_CROSS` son los eventos puntuales; `TENDENCIA_ALCISTA/BAJISTA` el estado vigente.

## Riesgo

**Volatilidad anualizada (30d/90d)** — Desviación estándar de retornos diarios × √365. Referencia: acciones ~15-25%, BTC ~40-70%, altcoins frecuentemente >80%. A mayor volatilidad, menor tamaño de posición razonable.

**Max Drawdown (1 año)** — Peor caída desde un máximo en el último año. Mide el dolor histórico real: es lo que habrías soportado comprando en el peor momento.

**Sharpe Ratio (90d)** — Retorno medio diario / desviación estándar × √365 (tasa libre de riesgo = 0). >1 bueno, >2 excelente, <0 el riesgo no se pagó.

**VaR 95% diario** — Percentil 5 de los retornos diarios de 90 días. "En un día malo típico (1 de cada 20), espera perder al menos X%". No cubre eventos extremos (colas).

## Rendimiento y rango

**Retornos 7d/30d/90d/1a** — Variación porcentual simple frente al precio de hace N días.

**Rango 52 semanas** — Máximo y mínimo del año, con distancia porcentual desde el precio actual. Útil para dimensionar el potencial de recuperación: estar -50% del máximo exige +100% para recuperarlo.

## Correlación y liquidez

**Correlación XRP-BTC (30d/90d)** — Pearson sobre retornos diarios. >0.7: XRP se mueve con el mercado (vigila BTC y macro). <0.3: XRP cotiza con narrativa propia (noticias Ripple/legales/escrow). Se incluye el retorno 30d de BTC como contexto.

**Volumen/MarketCap** — Volumen 24h como % del market cap. Proxy de liquidez y actividad: <2% baja (movimientos amplificados), 2-8% normal, >8% inusualmente alta (suele coincidir con eventos).

## Score compuesto (0-100)

Suma de reglas partiendo de 50, recortada a [0,100]:

| Factor | Impacto |
|---|---|
| Precio vs SMA50 | ±10 |
| Precio vs SMA200 | ±15 |
| Histograma MACD | ±10 |
| RSI 14 | +5 (55-70 o <30), −5 (30-45), −10 (>70) |
| Fear & Greed | +5 si ≤25 (contrarian), −5 si ≥75 |
| Order Flow Binance | ±5 según buyPercent >55 / <45 |

Etiquetas: ≥65 `SESGO ALCISTA`, ≤40 `SESGO BAJISTA`, resto `NEUTRAL`. Los factores individuales se muestran en la UI para que el usuario entienda *por qué* sale el score. Es un resumen de condiciones técnicas, no una recomendación: un score alcista puede coincidir con un techo de mercado.

## Insights automáticos

Reglas que generan texto interpretado cuando se cumplen condiciones notables: Golden/Death Cross, RSI en extremos, cierre fuera de Bollinger, volatilidad >90%, drawdown <−40%, correlación BTC >0.7 o <0.3, liquidez <2% o >8%, precio −50% del máximo 52s, Sharpe >1 o <0. Si no se cumple ninguna, la pestaña indica que no hay extremos técnicos.

## Métricas preexistentes (pestaña Mercado)

- **Soporte/Resistencia/RSI (7d)** de `calculateTechnicals()`: mín/máx de la semana y RSI sin suavizado — aproximación rápida, menos fiable que el RSI 14 de Análisis.
- **Proyecciones bajista/neutral/alcista**: bandas fijas ±15%/±5%/+20% ancladas a soporte/resistencia — son escenarios ilustrativos, no predicciones.
- **Buy/Sell Pressure**: % de volumen taker comprador en Binance (24h), proxy de agresividad de compradores frente a vendedores.
- **Fear & Greed**: índice de sentimiento de mercado cripto global (no específico de XRP).
