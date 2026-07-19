# Auditoría profunda v3 + funciones nuevas — 3 de julio de 2026

Auditoría completa del sistema tras el trabajo de la instancia B (v2.2: tests, escrow on-chain, history.json, alertas, derivados multi-venue, RLUSD split, AMM/DEX, volumen por exchange, ETH) e implementación de lo pedido: **correlación con SPY, toggle de idioma ES/EN, base de datos SQLite y sign-in multiusuario seguro**. Todo verificado en vivo (servidor arrancado + navegador, login real, tab por tab).

---

## Parte 1 — Auditoría del estado heredado (v2.2)

### Veredicto general: sólido. La arquitectura se mantuvo coherente.

Lo que se revisó y quedó **verificado correcto**:

- **`withDataFile()` intacto**: las 20+ escrituras a `data.json` siguen pasando por la cola serializada. La instancia B añadió 6 fetchers nuevos (escrow on-chain, RLUSD split, AMM/DEX, volumen por exchange, ETH, history) y **todos** respetan el patrón. Cero `safeWriteFile(DATA_FILE,...)` directos nuevos. Confirmado con grep: solo los 4 usos legítimos (el propio `withDataFile`, `sanitizeWhaleData`, seed y el creador inicial).
- **Tope de sanidad whale (2B XRP)**: `amountToXrp()` se movió a `lib/calc.js` conservando el tope. El test `calc.test.js` incluye explícitamente el caso "drops corruptos > 2B → 0" — el bug que rompió la v1 ahora tiene red de seguridad.
- **Honestidad de datos**: todo lo estimado sigue etiquetado. Verificado en vivo: `≈ estimado` en holders underwater, `≈ típico` en el desglose de escrow, `estimated:true` en RLUSD split y AMM/DEX, notas de "muestra" en derivados y AMM. Nada simulado se presenta como real.
- **APIs muertas/geobloqueadas**: respetadas. Ningún fetcher usa `/network/metrics` (404) ni Binance/Bybit futures (geobloqueo). Kraken + OKX para derivados, con degradación limpia si OKX falla.
- **`coingeckoFetch()` con reintento a 429**: aplicado a las 7 llamadas a CoinGecko. Buen patrón. (Ver observación abajo sobre su límite real.)
- **Tests (roadmap #16)**: 27 tests sobre funciones puras extraídas a `lib/calc.js`, sin duplicar lógica (server.js las `require()`). Sólido.

### Observaciones (no bloqueantes, anotadas para el roadmap)

1. **CoinGecko sigue tocando su rate-limit ocasionalmente.** En la verificación en vivo tras reiniciar, la correlación **ETH quedó en "--"** un ciclo (BTC sí calculó porque va antes en la cola; ETH cayó por un 429 aunque `coingeckoFetch` reintenta a 15s). No es regresión: es el free tier de CoinGecko bajo ráfaga. La correlación con SPY **no se ve afectada** porque viene de Yahoo/Stooq. Se resuelve solo al siguiente ciclo. Mitigación futura: mover el histórico de BTC/ETH a un fetch cada N ciclos en vez de cada ciclo (los precios diarios no cambian intra-hora).
2. **Nodo legado `supplyOverview`**: la instancia B lo purgó en #5. Verificado ausente en `data.json` actual.
3. **`chartData` mutable**: la protección por span (timestamp real) sigue intacta en `calculateTechnicals` y `calculateAdvancedMetrics`. La correlación SPY nueva **reutiliza esa misma protección** (opera sobre el array ya validado).

---

## Parte 2 — Funciones nuevas implementadas (v2.3)

### 1. Correlación con SPY (S&P 500) ✅ verificado en vivo

- Fuente: **Yahoo Finance** (`query1.finance.yahoo.com/v8/finance/chart/SPY`, con User-Agent de navegador) y **fallback Stooq** (CSV diario). Ambas sin API key. Verificado alcanzable desde la máquina del usuario.
- **Alineación por fecha**: XRP cotiza 7 días/semana, SPY solo días hábiles. Correlacionar los arrays "en crudo" desalinea las fechas y da basura. La implementación cruza por fecha ISO (solo sesiones donde AMBOS tienen cierre) y usa las últimas **21/63 sesiones bursátiles** (≈ 1 y 3 meses de calendario), no 30/90 días naturales.
- UI: 3 filas nuevas en "Correlación BTC & Liquidez" (XRP-SPY 30d/90d + rendimiento SPY 30d) y la lectura conjunta ahora distingue "arrastrado por cripto" vs "activo de riesgo global (vigila tasas y bolsa)" vs "narrativa propia".
- **Verificado en vivo:** "Correlación XRP-SPY (30d): 28% · Débil: narrativa propia", 90d: 24%, rendimiento SPY 30d: −1.95%.

### 2. Toggle de idioma ES/EN ✅ verificado en vivo

- `public/i18n.js`: el **español es el idioma fuente** (vive en el HTML/JS). El diccionario solo guarda los overrides al inglés. `data-i18n="clave"` en elementos estáticos + `t('clave','texto ES')` en JS. Si falta una traducción, degrada al español en vez de romper.
- Botón 🌐 en el header; el idioma se persiste en `localStorage` y, si hay sesión, **también en la cuenta del usuario** (BD), así viaja entre navegadores.
- **Alcance de esta fase (como se acordó):** toda la UI estática (menús, títulos, KPIs, botones, leyendas, niveles, frescura de datos) + los veredictos principales por tono. Las **lecturas largas generadas por reglas** (textos de cada señal del brief, insights, lecturas prácticas de cada gráfica) siguen en español — se marca explícitamente en la UI ("Detailed signal texts are currently Spanish-only") y queda como tarea pendiente en el roadmap.
- **Verificado en vivo:** al pulsar EN, nav → "Overview/Market/Analysis/Whales/Supply/Live Burn", hero → "TECHNICAL SCORE/FEAR-GREED/NEXT ESCROW/52-WEEK RANGE", veredicto → "The overall signals lean BULLISH short-term...", niveles → "Support/Resistance/Psychological", "Data freshness". El botón pasa a "ES" para volver.

### 3. Base de datos SQLite + sign-in multiusuario seguro ✅ verificado en vivo

- **Motor: `lib/db.js`** usa el **SQLite nativo de Node** (`node:sqlite`) → archivo `dashboard.db`, cero dependencias npm y cero instalación. Si el Node instalado no lo trae (< 22.5), cae automáticamente a un **fallback JSON** (`dashboard-db.json`) con la misma API y escritura atómica. `run.bat` pasa `--experimental-sqlite` si el runtime lo acepta (inofensivo donde ya no hace falta). **Verificado:** `dashboard.db` (32 KB) se creó al arrancar → SQLite nativo activo.
- **Auth: `lib/auth.js`**:
  - Contraseñas con **scrypt** (`node:crypto`), salt de 16 bytes por usuario. Nunca se guarda la contraseña, solo salt+hash. Comparación con `timingSafeEqual`.
  - Sesiones: token aleatorio de 32 bytes en **cookie HttpOnly + SameSite=Strict**. En la BD se guarda solo el **SHA-256 del token** (robar `dashboard.db` no da tokens usables). Expiración 30 días + purga periódica.
  - **Rate-limit** en memoria por IP (8 intentos / 10 min) contra fuerza bruta.
  - Mensaje de login idéntico exista o no el usuario (no filtra qué usuarios existen).
  - **Multiusuario**: registro abierto; el **primer** usuario creado recibe rol `owner`.
- **Protección**: TODOS los endpoints `/api/*` (data, chart, wallet-history, history, whale-threshold, refresh) exigen sesión con `requireAuth`. Sin login → 401 → el frontend muestra el overlay de acceso.
- **Ajustes por usuario** (`/api/settings`, tabla `settings`): la cantidad de "My Crypto" y el idioma se guardan **por cuenta** (viajan entre navegadores). `localStorage` queda como caché/fallback. Claves permitidas en allowlist explícita (nada arbitrario en BD).
- **Verificado en vivo:** overlay de acceso aparece sin sesión (modo "Crear cuenta" auto-detectado por ser el primer usuario); creé la cuenta `roger`; el dashboard cargó con el chip "roger · Salir" en el header; sin errores de consola. Endpoints protegidos confirmados (el 401 dispara el overlay).

- **Cambiar contraseña tras el login** (`POST /api/auth/change-password`): botón ⚙ junto al nombre de usuario en el header → modal con contraseña actual + nueva + repetir. Verifica la contraseña ACTUAL antes de cambiarla (una cookie robada no basta), invalida TODAS las sesiones del usuario al cambiarla (incluidos otros dispositivos) y re-emite la cookie de este navegador para no auto-expulsarte. **Verificado en vivo end-to-end:** contraseña actual incorrecta → rechazada ("La contraseña actual es incorrecta"); cambio correcto → éxito y modal se cierra solo; logout + login con la contraseña NUEVA → entra; la antigua deja de funcionar. Confirma que el cambio persiste en SQLite.

- ⚠️ **Nota de seguridad honesta**: la cookie NO lleva flag `Secure` a propósito, porque el dashboard corre en `http://localhost`. **Si algún día se expone fuera de localhost, hace falta HTTPS + cookie Secure.** Documentado en `lib/auth.js`.

---

## Archivos nuevos/tocados en v2.3

| Archivo | Cambio |
|---|---|
| `lib/db.js` | **NUEVO** — capa de persistencia (SQLite nativo + fallback JSON), API estrecha users/sessions/settings |
| `lib/auth.js` | **NUEVO** — scrypt, sesiones HttpOnly, rate-limit, `requireAuth`, rutas `/api/auth/*` |
| `public/i18n.js` | **NUEVO** — motor ES/EN (español fuente, overrides EN) |
| `server.js` | `fetchSpyDailySeries()` + correlación SPY alineada por sesión; require db/auth; `requireAuth` en todos los `/api/*`; endpoints `/api/settings` |
| `public/index.html` | overlay de auth, chip de usuario+logout, botón idioma, `data-i18n` en toda la UI estática, carga de `i18n.js`, `?v=7`/`?v=16` |
| `public/app.js` | gate de auth (401→overlay), login/registro/logout, ajustes por usuario, `t()` en textos dinámicos clave, filas SPY + lectura |
| `public/style.css` | estilos de auth overlay, chip de usuario, idioma |
| `run.bat` | detección del flag `--experimental-sqlite` |
| `test.bat` | **NUEVO** — corre tests + reporta motor de BD a `docs/test-output.txt` |
| `.gitignore` | añade `dashboard.db`, `dashboard-db.json`, `history.json` |
| `package.json` | v2.3.0 |

## Qué queda pendiente (para la instancia B / próxima sesión)
1. **Traducir las lecturas largas al inglés** (brief, insights, lecturas prácticas de gráficas). Hoy en español con aviso en la UI. Es el grueso de texto restante; conviene un diccionario de plantillas paramétricas o generar ambas versiones en el servidor.
2. **ETH correlación intermitente** por rate-limit de CoinGecko: mover el histórico BTC/ETH a un fetch cada N ciclos (los precios diarios no cambian intra-hora) en vez de cada 5 min.
3. Roadmap #17-20 (móvil, WebSocket, backtesting, modularización) siguen pendientes según lo que reportó la instancia B.
