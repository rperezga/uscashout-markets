# Auditoría del proyecto — 2 de julio de 2026

Revisión completa de código y funcionalidad (tab por tab) del XRP Analytics Dashboard. Cada hallazgo indica severidad y estado.

## Resumen

| Severidad | Encontrados | Corregidos |
|---|---|---|
| 🔴 Crítica | 2 | 2 |
| 🟠 Alta | 5 | 5 |
| 🟡 Media | 6 | 6 |
| 🔵 Baja / deuda técnica | 5 | documentados |

---

## 🔴 Críticos

### 1. API key de OpenAI hardcodeada en `server.js`
La clave `sk-proj-...` estaba en texto plano en el código (línea 8), y el token de CryptoPanic también (en la URL del fetch). Cualquiera con acceso al archivo (o a un repo donde se subiera) podía usar tu cuenta de OpenAI.

**Corregido:** ambas claves se movieron a `.env` (cargado por un parser propio sin dependencias). `server.js` funciona sin claves usando fallbacks. `.gitignore` creado cubriendo `.env`.

**⚠️ ACCIÓN PENDIENTE TUYA:** la clave estuvo expuesta — revócala y genera una nueva en <https://platform.openai.com/api-keys>. Actualiza `.env` con la nueva.

### 2. Datos simulados presentados como reales
Tres casos donde el usuario no podía distinguir dato real de inventado:
- El gráfico "Burn por hora" decía **"Data real del XRPL"** mientras mostraba buckets sembrados con valores aleatorios (±20% sobre 102 XRP/h).
- Las transferencias whale de ejemplo (hashes `MOCK_TX_*`) se mostraban en el feed sin ninguna marca.
- El historial de wallet inventado (`generateMockHistory`) se mostraba en el modal como si fuera real.

**Corregido:** los buckets sembrados llevan flag `seeded` y se pintan en gris con subtítulo explicativo (los reales en rojo); al llegar el primer dato real de una hora, el bucket sembrado se reinicia. El feed y el modal muestran badge `DEMO` y aviso naranja cuando los datos son de demostración. Además, los buckets sembrados ya no cuentan para `dailyAvgBurn`/`last24hBurned` (antes el KPI "Daily Burn Rate" podía etiquetar como "Real (24h)" un promedio inventado).

---

## 🟠 Altos

### 3. Soporte/Resistencia calculados sobre ~35 minutos en vez de 7 días
`calculateTechnicals()` hacía `chartData.slice(-7)` asumiendo velas diarias. Si el usuario cambiaba la gráfica a 1D (velas de 5 min), el "soporte/resistencia de 7 días" pasaba a calcularse sobre los últimos 35 minutos, y el RSI igual. Esto contaminaba también las Proyecciones (que derivan de soporte/resistencia).

**Corregido:** la ventana de 7 días se filtra por timestamp real, y si `chartData` cubre <2 días se conservan los técnicos previos (mismo patrón de protección que ya tenía `calculateAdvancedMetrics`).

### 4. Volumen y flujo whale mostrados como USD siendo XRP
`renderWhaleTracker()` formateaba `totalVolume24h` y `exchangeFlowNet` (ambos en XRP) con `$`. Un volumen de "2.500.000 XRP" aparecía como "$2,500,000" — error de unidad de ~2x al precio actual.

**Corregido:** se muestran como XRP.

### 5. Semántica invertida del flujo neto a exchanges
El KPI pintaba **verde** el flujo positivo, pero flujo positivo = XRP *entrando* a exchanges = oferta lista para venderse (señal bajista). Inducía la lectura contraria.

**Corregido:** positivo = rojo con explicación "entrando a exchanges: aumenta la oferta"; negativo = verde "acumulación en wallets frías". El KPI incluye subtítulo dinámico.

### 6. `initialData` creaba `monitoredWallets` pero el código lee `trackedWallets`
Si `data.json` nacía del `initialData`, el whale tracker iteraba sobre `undefined` y fallaba silenciosamente (capturado por try/catch) hasta que el seed de mocks lo tapaba.

**Corregido:** clave renombrada a `trackedWallets` + guard en `fetchWhaleData()` que siembra las wallets desde `MONITORED_WALLETS` si faltan.

### 7. Cifras de escrow contradictorias entre tabs
Supply Distribution usaba 39,8B hardcodeado; la tarjeta de Eventos decía ~33,6B restantes. Dos tabs del mismo dashboard se contradecían.

**Corregido:** Supply Distribution deriva el escrow del último ciclo conocido (`events.previousCycle.remainingEscrow`), con fallback conservador de 35,5B.

---

## 🟡 Medios

### 8. Gráfica muerta con datos inventados
`renderBurnChart()` apuntaba a un canvas inexistente (`burnTrendChart`) con datos mensuales hardcodeados `[2100, 2300, ...]`. Código muerto que confundía. **Corregido:** eliminada; la gráfica horaria real la sustituye.

### 9. Cuentas activas estimadas sin indicarlo
Cuando la API de métricas de XRPScan falla, las cuentas activas se estiman con la fórmula `25000 + tps*1800` sin que el usuario lo supiera. **Corregido:** flag `activeAddressesEstimated` en backend + badge `≈ estimado` con tooltip en la UI.

### 10. Gráficas sin interpretación
La gráfica de precio, la de burn, la de flujo whale (parcial), el modal de wallet y varias tarjetas no decían qué implicaba lo mostrado. **Corregido:** sistema de "lecturas prácticas" (`readingHTML`/`setReading` + `.chart-reading`) con interpretación dinámica en: gráfica de precio (posición en rango), buy/sell (diferencial USD), escrow (dilución real), proyecciones (metodología + señal contraria F&G), score (factores dominantes), flujo whale (desglose y dirección), wallet (perfil acumulación/distribución), burn horario (proyección anual como % del circulante) y agotamiento (conclusión).

### 11. Barra de supply sin leyenda
Los tres colores de la barra apilada solo se identificaban con `title` al hacer hover. **Corregido:** leyenda visible con porcentajes.

### 12. Sin `.gitignore` ni gestión de secretos
No existía `.gitignore`: un `git init` + push habría subido `node_modules`, `data.json` y las claves. **Corregido:** `.gitignore` + `.env` + `.env.example`.

### 13. README desactualizado y docs inexistentes
El README referenciaba `docs/ARQUITECTURA.md`, `docs/METRICAS_E_INSIGHTS.md`, etc. que **no existían**, y documentaba un endpoint `POST /api/data` que no está en el código. **Corregido:** README reescrito reflejando la realidad; carpeta `docs/` creada (esta auditoría, `GUIA-TABS.md`, `ROADMAP.md`) + `CLAUDE.md`.

---

## 🔵 Bajos / deuda técnica (documentados, no bloqueantes)

14. **Typo `escorowNote`** en `events` — se mantiene por compatibilidad con `data.json` existentes; renombrar requiere migración trivial.
15. **Historial de escrow hardcodeado** (`escrowHistory` con 4 meses de 2025-2026): desde julio 2026 cae siempre al valor por defecto `{released: 1000, returned: 800}`. Debería obtenerse de una API o actualizarse mensualmente (ver ROADMAP).
16. **Direcciones de wallets sin verificar**: varias de `MONITORED_WALLETS` devuelven 404 en XRPScan (por eso saltan los mocks). Conviene sustituirlas por direcciones reales verificadas de exchanges (ver ROADMAP).
17. **`app.js` monolítico** (~1.600 líneas) con estilos inline en templates. Funciona, pero dificulta el mantenimiento; candidato a modularización (ver ROADMAP).
18. **Estimaciones de distribución** (12% exchanges / 65% whales) son constantes plausibles, no datos on-chain. Están marcadas como `Estimated` en la UI; sustituibles por datos de rich-list (ver ROADMAP).

---

## Estado por tab tras la auditoría

| Tab | Estado | Cambios aplicados |
|---|---|---|
| Mercado | ✅ Funcional | Lecturas en precio, presión, escrow, proyecciones/F&G; badge estimado en cuentas activas |
| Análisis | ✅ Funcional | Lectura del score; base de cálculo protegida (ya existía) |
| Whale Tracker | ✅ Funcional | Unidades XRP, semántica de flujo corregida, badges DEMO, lectura de wallet |
| Supply Distribution | ✅ Funcional | Escrow consistente, leyenda, 3 lecturas prácticas |
| Burn Impact | ✅ Funcional | Seeded vs real distinguido, gráfica muerta eliminada, lecturas de ritmo y agotamiento |
