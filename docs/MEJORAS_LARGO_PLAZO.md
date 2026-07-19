# Mejoras a largo plazo (futuro lejano)

Visión de evolución del proyecto una vez resueltas las prioridades de corto plazo.

## 1. Base de datos real con histórico propio

Sustituir `data.json` por SQLite (cero infraestructura, un fichero). Beneficios decisivos:

- Guardar **series temporales propias**: precio, TPS, burn, flujos whale, sentimiento… hoy cada refresh pisa el valor anterior y se pierde el histórico.
- Con histórico propio se desbloquean métricas imposibles ahora: evolución del score compuesto, backtesting de las señales, comparativa real de cuentas activas día a día, tendencia de quema mensual real (la gráfica actual usa datos simulados).
- Escrituras atómicas y consultas eficientes.

## 2. Backtesting del score compuesto

Una vez exista histórico: simular "¿qué habría pasado comprando con score >65 y reduciendo con <40?" frente a hold. Esto convierte el score de adorno en herramienta honesta — y permitirá calibrar los pesos de los factores con datos en lugar de intuición.

## 3. Alertas proactivas

Motor de alertas configurable (precio cruza nivel, RSI en extremo, Golden/Death Cross, transferencia whale > X, burn anómalo, cambio brusco de correlación con BTC) con notificaciones vía Telegram/Discord/email. Es el salto de "dashboard que miras" a "sistema que te avisa".

## 4. Cartera real multi-activo

Evolucionar "My Crypto" a un portfolio tracker: múltiples compras con fecha y precio (coste medio, P&L realizado/no realizado), varios activos (BTC, ETH…), histórico de valor de cartera y métricas de riesgo aplicadas a la cartera (VaR en €, drawdown de la cartera). Sincronización opcional de balances reales vía dirección XRPL pública (solo lectura).

## 5. Whale tracking serio

- Sustituir el polling de wallets por **suscripción WebSocket al XRPL** (`subscribe` a transacciones), detectando en tiempo real cualquier pago ≥ umbral en toda la red, no solo en 6 wallets.
- Etiquetado de direcciones mediante listas públicas (exchanges, Ripple, ODL corridors).
- Métrica de exchange netflow real acumulada por día (indicador adelantado clásico de presión vendedora/compradora).

## 6. Más fuentes y métricas de contexto

- **Derivados**: funding rates, open interest y liquidaciones de XRP (Binance/Bybit públicas) — el posicionamiento apalancado mueve el precio a corto plazo más que el spot.
- **Profundidad de libro**: bid/ask walls y slippage estimado para órdenes grandes.
- **Macro cripto**: dominancia BTC, DXY, estacionalidad.
- **On-chain XRPL avanzado**: volumen DEX/AMM nativo, nuevas cuentas por día, payments vs otros tipos de tx.

## 7. Arquitectura y despliegue

- Separar `server.js` (1.300+ líneas) en módulos: `fetchers/`, `metrics/`, `routes/`, `storage/`.
- TypeScript para los cálculos financieros (los errores de unidades drops/XRP ya han aparecido varias veces).
- Frontend: si la app sigue creciendo, migrar a componentes (Svelte/Vue ligero) o al menos a plantillas reutilizables; hoy `app.js` concentra ~1.700 líneas con HTML embebido.
- Dockerfile para correrlo en un NAS/Raspberry y acceder desde cualquier dispositivo de la red local; PWA para móvil.

## 8. IA con más contexto

- Pasar a la IA el contexto completo del mercado (score, RSI, flujos whale, burn) junto a la noticia para análisis de impacto más rico, no solo el titular.
- Un "informe diario" generado por IA combinando todas las métricas en 5 líneas accionables.
- Cachear y versionar los análisis para evaluar a posteriori la calidad de sus clasificaciones (¿las noticias "NEGATIVO" realmente precedieron caídas?).

## 9. Multi-activo

Generalizar el dashboard: la mayoría de fetchers ya son parametrizables por id de CoinGecko/símbolo de Binance. XRP quedaría como activo por defecto, con BTC/ETH como pestañas comparables y métricas de cartera cruzadas.

## Secuencia recomendada

1. SQLite + histórico propio (habilita casi todo lo demás)
2. Alertas Telegram (máximo valor/esfuerzo)
3. Whale tracking por suscripción XRPL
4. Backtesting del score
5. Derivados y profundidad de mercado
6. Refactor a módulos/TypeScript según crezca
