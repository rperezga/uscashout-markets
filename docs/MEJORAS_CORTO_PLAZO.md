# Mejoras a corto plazo (futuro cercano)

Ordenadas por prioridad. Las marcadas 🔴 deberían abordarse antes de seguir añadiendo funcionalidades.

## 🔴 1. Seguridad: claves de API hardcodeadas

`server.js` contiene en texto plano la clave de OpenAI (línea ~8) y el token de CryptoPanic (en `fetchNewsData`). Riesgos: si el código se comparte o sube a GitHub, cualquiera puede consumir tu cuota de OpenAI (con coste económico directo).

Plan: mover a variables de entorno (`process.env.OPENAI_API_KEY`), crear `.env` + `.gitignore`, y **rotar ambas claves** (la de OpenAI ya debe considerarse expuesta). Esfuerzo: 15 minutos.

## 🔴 2. Validar el `POST /api/data`

Hoy cualquier proceso local puede sobrescribir `data.json` entero sin validación, destruyendo todo el estado. Plan: eliminar el endpoint si no se usa, o validar el esquema y limitar a nodos concretos.

## 🔴 3. Wallets monitoreadas con direcciones dudosas

Varias direcciones de `MONITORED_WALLETS` no parecen direcciones XRPL válidas (longitud/checksum), por lo que el Whale Tracker cae al mock silenciosamente y el usuario ve datos "(MOCK)" creyendo que son casi reales. Plan: verificar cada dirección contra XRPScan, reemplazar por wallets reales conocidas (Binance, Upbit, Ripple las publican los exploradores) y mostrar un badge claro de "datos simulados" cuando se use el fallback.

## 4. Separar `chartData` del estado de los indicadores

El selector 1D/7D/1M/1Y sobrescribe `chartData` en `data.json`, así que `calculateTechnicals()` del siguiente ciclo calcula soporte/resistencia/RSI sobre la ventana que el usuario dejó seleccionada. `calculateAdvancedMetrics()` ya se protege (ignora ventanas <180 días); aplicar la misma protección o, mejor, guardar `chartData365` (para cálculos) separado de `chartDataView` (para la gráfica).

## 5. Datos hardcodeados que caducan solos

- `escrowHistory` en `updateEvents()` solo cubre dic-2025→mar-2026; desde abril usa un fallback genérico sin avisar.
- `escrowSupply: 39800000000` en Supply Distribution está fijo (el escrow real baja cada mes).
- Distribución exchange (12%) / whales (65%) son porcentajes inventados.

Plan: obtener el escrow real desde la API de XRPScan (cuenta de Ripple) o, mínimo, mostrar fecha del dato y badge "desactualizado" cuando tenga >1 mes.

## 6. Robustez de escritura en data.json

Implementar una pequeña cola de escritura (o write atómico: escribir a `data.json.tmp` + rename) para evitar corrupción si el proceso muere a mitad de un `writeFileSync`. El burn watcher escribe cada ~30 s, así que la ventana de riesgo es constante.

## 7. Control de costes de OpenAI

Cada ciclo (5 min) analiza hasta 5 noticias → hasta 1.440 llamadas/día aunque las noticias no cambien. Plan: cachear el análisis por URL/hash del título y solo analizar noticias nuevas. Reducción esperada: >95% de llamadas.

## 8. Limpieza de frontend

- `renderBurnChart()` apunta a un canvas `burnTrendChart` que no existe en el HTML (el real es `burnHourlyChart` que renderiza otra función) y usa datos simulados de meses fijos — eliminar o conectar a datos reales.
- Mover los estilos inline gigantes de `app.js` a clases CSS (ya existe el patrón en style.css).
- Manejar el caso de `localStorage` no disponible.

## 9. Calidad mínima

- `npm audit` y actualización de dependencias.
- Añadir `eslint` con configuración básica.
- Script `npm run dev` con `node --watch server.js` (Node 18+) para autoreload.
- Tests unitarios de las funciones puras nuevas (`_rsiWilder`, `_pearson`, `_maxDrawdown`…), que son fáciles de testear.

## 10. UX rápida

- Botón "refrescar ahora" en la UI (hoy hay que esperar al ciclo de 5 min).
- Mostrar estado de cada fuente de datos (ok / fallback / mock) en un panel de salud.
- Persistir la pestaña activa en `localStorage`.
