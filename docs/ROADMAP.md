# Roadmap — mejoras futuras propuestas

Priorizadas por impacto en la propuesta de valor vs esfuerzo. Las de "Corto plazo" son ejecutables en sesiones de 1-2 horas cada una.

## Corto plazo (alto impacto, bajo esfuerzo)

1. **Rotar la clave de OpenAI expuesta** — estuvo hardcodeada en `server.js`; revocar y regenerar. *(5 min, crítico)*
2. **Verificar las wallets monitoreadas** — varias direcciones de `MONITORED_WALLETS` devuelven 404 y disparan los mocks. Sustituirlas por cold wallets reales verificadas de exchanges (XRPScan las etiqueta públicamente) convertiría el Whale Tracker en 100% datos reales.
3. **Escrow dinámico** — leer el balance real de las cuentas de escrow de Ripple vía XRPL (`account_objects` tipo escrow) en lugar del historial hardcodeado que quedó congelado en marzo 2026. Eliminaría la última fuente de datos desactualizados.
4. **Alertas visuales de datos obsoletos** — si `lastUpdated` de cualquier nodo supera N minutos (API caída), mostrar un badge "datos de hace X min" en la tarjeta afectada.
5. **Umbral whale configurable** — input en la UI para ajustar el filtro de 50.000 XRP sin tocar código.

## Medio plazo (alto impacto, esfuerzo moderado)

6. **Histórico propio de métricas** — persistir snapshots diarios (score, flujo whale, burn, F&G) en un `history.json` para graficar la evolución del score y del flujo de exchanges en el tiempo. Hoy el dashboard solo muestra "ahora"; la evolución es donde está el valor analítico real.
7. **Sistema de alertas** — notificaciones (browser Notification API o Telegram bot) cuando: RSI cruce 30/70, flujo a exchanges supere un umbral, Golden/Death Cross, o el precio toque soporte/resistencia. Convierte el dashboard de consulta pasiva en herramienta activa.
8. **Rich-list real para Supply Distribution** — sustituir las constantes 12%/65% por datos de la rich-list de XRPScan agregados por categoría. Quitaría el badge "Estimated" a la mitad del tab.
9. **Backtesting simple del score** — guardar score diario vs retorno a 7/30 días y mostrar su precisión histórica ("cuando el score superó 65, el retorno medio a 30d fue X%"). Honestidad medible del indicador estrella.
10. **WebSocket al frontend** — hoy el frontend hace polling (5 min / 30 s en burn). Un WS del server al browser haría el burn monitor y el precio realmente en vivo sin recargas.
11. **Modo móvil completo** — el CSS tiene bases responsive pero el grid de 6 columnas del tab Mercado no colapsa bien en pantallas pequeñas.

## Largo plazo (transformadores)

12. **Multi-activo** — parametrizar el dashboard (config por moneda: id de CoinGecko, par de Binance, APIs on-chain) para replicarlo con ETH, SOL, etc. La arquitectura de nodos en `data.json` ya lo permite.
13. **SQLite en lugar de data.json** — el patrón lee-todo/escribe-todo funciona en local, pero limita histórico y concurrencia. SQLite (sin servidor) mantendría la filosofía cero-config habilitando series temporales largas.
14. **Panel de derivados** — funding rates, open interest y liquidaciones (APIs públicas de Binance/Bybit/Coinglass). La presión spot de Binance es una foto parcial; los derivados mueven el precio de XRP tanto o más.
15. **Análisis IA agregado del dashboard** — un resumen diario generado por IA que cruce TODAS las señales ("hoy: score 62, ballenas acumulando, burn estable, F&G en codicia → contexto mixto con sesgo X") en lenguaje natural. La infraestructura OpenAI ya existe para noticias.
16. **Tests automatizados** — al menos unit tests de los cálculos financieros (`_rsiWilder`, `_maxDrawdown`, `_pearson`, VaR) con casos conocidos, y un smoke test del server. Hoy cualquier regresión en las matemáticas pasaría inadvertida.
17. **Modularizar `app.js` y `server.js`** — separar por dominio (market, whale, burn, analysis) en módulos ES. Reduciría el riesgo de romper una sección al tocar otra.

## Ideas descartadas conscientemente

- **Trading automático / señales de compra-venta**: el proyecto es educativo; añadir ejecución de órdenes cambia el perfil de riesgo y la responsabilidad del código.
- **Framework frontend (React/Vue)**: el valor está en los datos, no en la UI; una migración costaría semanas sin mejorar la propuesta de valor.
