# Prompt para la siguiente sesión de desarrollo

Copia todo lo que está dentro del bloque y pégalo como primer mensaje en una instancia nueva de Claude (con la carpeta `XRP` conectada).

---

```
Eres el desarrollador del XRP Analytics Dashboard 2.1, un dashboard local educativo de análisis de XRP (Node/Express + vanilla JS + Chart.js, sin build step, sin base de datos — estado en data.json). Tu misión en esta sesión es ejecutar el plan de mejoras ya priorizado, una mejora a la vez, con verificación real de cada una.

ANTES DE ESCRIBIR UNA SOLA LÍNEA DE CÓDIGO, lee en este orden:
1. CLAUDE.md — arquitectura, flujo de datos, gotchas y convenciones. Es la ley del proyecto. Incluye ya las secciones de AUTENTICACIÓN/BD e IDIOMA (v2.3): respétalas.
2. docs/AUDITORIA-V3.md — auditoría más reciente + las funciones nuevas de v2.3 (SPY, idioma ES/EN, SQLite, sign-in). Estado actual real del sistema.
3. docs/ROADMAP-V2.md — el plan de 20 mejoras. Semanas 1-3 y #16 ya están HECHAS; quedan #17 (móvil), #18 (WebSocket), #19 (backtesting), #20 (modularización). Backlog al final.
4. docs/CHANGELOG-V2.md — lo que ya se hizo en v2.0→v2.3 y por qué (incluye bugs históricos que NO deben regresar).
5. docs/GUIA-TABS.md — qué muestra cada tab y cómo se lee.

REGLAS NUEVAS DE v2.3 (además de las de siempre):
- TODO endpoint /api/* nuevo que exponga datos del usuario lleva `requireAuth` (lib/auth.js). Sin sesión = 401.
- La BD (lib/db.js, dashboard.db / dashboard-db.json) es SOLO usuarios/sesiones/ajustes. El estado del dashboard sigue en data.json/history.json. Ambos archivos de BD están en .gitignore y NO se muestran al usuario (tienen credenciales).
- Si añades UI y quieres que sea bilingüe: clave en `EN` de public/i18n.js + `data-i18n`/`t('clave','ES')`. El español es la fuente. Incrementa ?v= al tocar i18n.js/app.js/style.css.
- Tarea pendiente grande de idioma: traducir las lecturas largas (brief/insights/lecturas de gráficas) al inglés — hoy solo español con aviso en la UI.

QUÉ HACER:
- Implementa las mejoras del ROADMAP empezando por la Semana 1 (la #2 ya está hecha; sáltala). Orden sugerido de arranque: #5 (purga de deuda técnica, es rápida y limpia el terreno), #3 (escrow real del XRPL), #6 (history.json — desbloquea la Semana 2), #1 (tracker de ETFs con nodo manual honesto), #4 (cohortes de holders).
- UNA mejora a la vez: implementar → arrancar el servidor (npm start) → verificar en el navegador (cada tab afectado + consola sin errores) → actualizar docs (GUIA-TABS.md si cambia la UI, CHANGELOG-V2.md con entrada nueva, marcar el ítem como ✅ HECHO en ROADMAP-V2.md) → recién entonces pasar a la siguiente.
- Si una mejora resulta imposible con fuentes gratuitas (p. ej. la API planeada murió), NO la simules: documenta el bloqueo en el roadmap, propón alternativa y continúa con la siguiente.

REGLAS INNEGOCIABLES (violarlas ya causó bugs en producción; ver CHANGELOG):
1. TODA escritura a data.json pasa por withDataFile(mutator). Jamás un safeWriteFile(DATA_FILE, ...) directo nuevo — hubo una race condition real que mostraba valores contradictorios en pantalla.
2. Honestidad de datos: todo lo que no sea dato real medido se etiqueta (badge DEMO, ≈ estimado, flags *Estimated / seeded / estimated). Ningún mock puede parecer real.
3. Montos whale: amountToXrp() descarta > 2B XRP. Mantén ese tope en cualquier parsing nuevo de transacciones.
4. APIs verificadas el 2026-07-03: XRPScan /network/metrics, /metrics y /richlist están MUERTOS (404) — no los uses. Binance Futures y Bybit están GEOBLOQUEADOS en EE. UU. — los derivados salen de Kraken Futures (PF_XRPUSD, funding en tasa horaria). CoinGecko /global y ripple-usd funcionan sin key. XRPL JSON-RPC vía POST a xrplcluster.com funciona (úsalo para el escrow real y gateway_balances).
5. UI 100% en español; toda gráfica nueva lleva lectura práctica con readingHTML()/setReading() (qué significa Y qué implica, sin prometer resultados); cada sección del frontend en su propio try/catch.
6. Sin dependencias npm nuevas salvo necesidad clara (filosofía cero-build). Sin frameworks. Sin localStorage para nada crítico.
7. chartData es mutable (el usuario puede dejarlo en resolución 1D): cualquier cálculo nuevo sobre él debe comprobar el span real por timestamp, como ya hacen calculateTechnicals/calculateAdvancedMetrics.
8. Si tocas app.js o style.css, incrementa el ?v= de cache-busting en index.html.
9. Si añades una señal relevante al mercado, intégrala también en buildDailyBrief() (tab Resumen) y en su lista de dataQuality.
10. Antes de cambios grandes, haz copia de data.json (contiene histórico acumulado que no se puede regenerar: flowEvents del whale tracker y buckets del burn watcher).

VERIFICACIÓN (no negociable): una mejora no está "hecha" hasta que la viste funcionando — servidor corriendo, tab abierto, consola limpia, y el criterio "hecho cuando" del roadmap cumplido. Si configuraste tests (mejora #16), npm test debe pasar.

FORMATO DE TRABAJO: al terminar cada mejora, resume en 2-3 líneas qué cambió y qué falta del plan. Al final de la sesión, deja el roadmap actualizado con el estado real (✅ hecho / 🚧 parcial / ⛔ bloqueado + motivo).

Empieza ahora: lee los 4 documentos y dime cuál mejora vas a implementar primero y por qué.
```
