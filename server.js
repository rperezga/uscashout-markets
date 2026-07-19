const express = require('express');
const path = require('path');
const fs = require('fs');
const OpenAI = require('openai');
const { startBurnWatcher } = require('./xrplBurnWatcher');

// ===== Variables de entorno (.env) =====
// Carga un .env local sin dependencias externas (formato KEY=VALUE por línea).
// SEGURIDAD: las claves NUNCA deben ir hardcodeadas en el código fuente.
(function loadEnvFile() {
    try {
        const envPath = path.join(__dirname, '.env');
        if (!fs.existsSync(envPath)) return;
        const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith('#')) continue;
            const eq = trimmed.indexOf('=');
            if (eq === -1) continue;
            const key = trimmed.slice(0, eq).trim();
            const value = trimmed.slice(eq + 1).trim();
            if (key && !(key in process.env)) process.env[key] = value;
        }
    } catch (e) {
        console.warn('No se pudo leer .env:', e.message);
    }
})();

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const CRYPTOPANIC_TOKEN = process.env.CRYPTOPANIC_TOKEN || '';

// Cliente OpenAI opcional: si no hay clave, el dashboard funciona igual
// (las noticias usan el análisis heurístico local como fallback).
const openai = OPENAI_API_KEY ? new OpenAI({ apiKey: OPENAI_API_KEY }) : null;
if (!openai) console.warn('⚠️ OPENAI_API_KEY no configurada (.env): el análisis IA de noticias usará el fallback heurístico.');

const app = express();

// NOTA: Estas constantes deben declararse ANTES del bloque del Burn Watcher.
// (Bugfix: antes estaban después y el bloque de "sembrado" fallaba silenciosamente
// por Temporal Dead Zone al referenciar DATA_FILE antes de su declaración).
const PORT = process.env.PORT || 3000;
// V2.7: bind SOLO a loopback por defecto — detrás del túnel (o en local) nadie más debe alcanzar
// el puerto directamente. HOST=0.0.0.0 explícito si algún día se quiere exponer en LAN.
const HOST = process.env.HOST || '127.0.0.1';
const DATA_FILE = path.join(__dirname, 'data.json');
const WHALE_THRESHOLD = 50000; // Umbral para detectar transferencias grandes

// V2.2 (roadmap #16): amountToXrp() y el resto de funciones puras de cálculo
// (RSI, MACD/EMA, drawdown, Pearson, percentil/VaR, retornos diarios) viven
// ahora en lib/calc.js — se extrajeron SOLO las funciones sin I/O para poder
// testearlas con `node --test` sin arrancar el servidor completo (ver test/calc.test.js).
// Mantiene el mismo tope de sanidad de siempre: ningún pago real de XRP supera 2B
// (el mayor movimiento recurrente es el escrow de Ripple, 1B); si tras normalizar
// el número sigue siendo mayor, la unidad venía mal de la fuente → se descarta (0).
const { amountToXrp, _dailyReturns, _mean, _stdDev, _smaLast, _emaArray, _rsiWilder, _maxDrawdown, _pearson, _percentile } = require('./lib/calc');

// ===== V2.0: ESCRITURA SERIALIZADA de data.json =====
// PROBLEMA REAL detectado en producción: el burn watcher escribe de forma asíncrona
// (cada ~30 s) mientras los fetchers hacen su propio leer-todo → modificar → escribir-todo.
// Dos read-modify-write concurrentes se pisan (lost update) y dejaban nodos MEZCLADOS
// de ciclos distintos (ej.: dailyBurn de un ciclo con scenarioComparisons de otro,
// visibles a la vez en el tab Burn con valores contradictorios).
// SOLUCIÓN: todos los escritores pasan por withDataFile(), que encadena las escrituras
// en una promesa única: leer FRESCO → mutar solo su nodo → escribir atómico.
let _dataFileLock = Promise.resolve();
function withDataFile(mutator) {
    _dataFileLock = _dataFileLock.then(() => {
        const data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
        mutator(data);
        safeWriteFile(DATA_FILE, JSON.stringify(data, null, 2), 'utf8');
    }).catch(e => console.error('withDataFile error:', e.message));
    return _dataFileLock;
}

// Función de escritura atómica para prevenir corrupción de archivos
function safeWriteFile(filePath, content, encoding) {
    const tempPath = filePath + '.tmp';
    try {
        fs.writeFileSync(tempPath, content, encoding);
        fs.renameSync(tempPath, filePath);
    } catch (error) {
        console.error(`Error escribiendo de forma atómica en ${filePath}:`, error);
        try {
            if (fs.existsSync(tempPath)) {
                fs.unlinkSync(tempPath);
            }
        } catch (_) {}
        throw error;
    }
}

// ===== XRPL Burn Watcher (real-time burn via WebSocket + REST fallback) =====
let burnWatcherSnapshot = null;
const burnWatcher = startBurnWatcher({
    onUpdate: (snap) => {
        burnWatcherSnapshot = snap;
        // Persistir el último snapshot dentro de data.json bajo burnImpact.realtime.
        // V2.0: vía withDataFile para no pisar las escrituras de los fetchers (race condition
        // que dejaba nodos mezclados de ciclos distintos).
        if (!fs.existsSync(DATA_FILE)) return;
        withDataFile((j) => {
            j.burnImpact = j.burnImpact || {};
            j.burnImpact.realtime = snap;
        });
    }
});

// Sembrar el watcher con buckets previos del data.json (resiliencia ante reinicios)
try {
    if (fs.existsSync(DATA_FILE)) {
        const j = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
        if (j.burnImpact && j.burnImpact.realtime) burnWatcher.injectSeed(j.burnImpact.realtime);
    }
} catch (e) { /* ignore seed errors */ }

const MONITORED_WALLETS = [
    { address: "rLNaPhS9K78Dbi4oAppSKXijcyS8YDXM6F", label: "Upbit Cold Wallet", type: "exchange" },
    { address: "rEb8p7u3v4R8MmdM9mD5dz7tS8S5VjR69C", label: "Binance Cold Wallet", type: "exchange" },
    { address: "rUge8AnpS5pYvR76L2pAmfR32Kx2yJ5C5", label: "Ripple Escrow / Ops", type: "whale" },
    { address: "rw58mG5idZ8D93Y4mZq9XW4dKqL7Q8rG", label: "Bithumb Cold", type: "exchange" },
    { address: "r9U8fJpYrdpNoS9mHkEvpX1J5vWzGjF2V2", label: "Kraken Cold", type: "exchange" },
    { address: "rDsbeomae4FXwgQTJp9Rs64Qg9vDiTCdBv", label: "XRPScan Sample Whale", type: "whale" }
];

// ===== V2.6: ENDURECIMIENTO PARA PRODUCCIÓN =====
// El dashboard pasa de "solo localhost" a publicarse por HTTPS (Cloudflare Tunnel).
// Estas tres piezas son el mínimo para exponerlo sin sustos. Sin dependencias npm
// (fiel a la filosofía cero-build): las cabeceras se ponen a mano.

// 1) trust proxy: detrás del túnel/reverse proxy, req.ip sería SIEMPRE la IP del
// proxy → el rate-limit de login (lib/auth.js) trataría a todo el mundo como un
// único cliente (bloqueo colectivo o rate-limit inútil). Con esto Express lee la
// IP real de X-Forwarded-For. El '1' = un salto de proxy (Cloudflare Tunnel).
app.set('trust proxy', 1);

// 2) Cabeceras de seguridad. La CSP es la red de contención del XSS: aunque se
// colara HTML malicioso, el navegador NO ejecutaría scripts inline ni de dominios
// ajenos. script-src permite hoy jsdelivr porque Chart.js viene del CDN (con versión
// fijada); en cuanto se self-hostee (ver nota en index.html), quitar jsdelivr de aquí
// y la política queda cerrada a 'self'.
// 'unsafe-inline' en style-src SÍ es necesario: las tarjetas usan estilos inline.
// En script-src NO se pone: ahí es donde vive el riesgo real.
const IS_PROD = process.env.NODE_ENV === 'production' || process.env.PUBLIC_HTTPS === '1';
app.use((req, res, next) => {
    res.setHeader('Content-Security-Policy', [
        "default-src 'self'",
        "script-src 'self'",
        "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
        "font-src 'self' https://fonts.gstatic.com",
        "img-src 'self' data:",
        "connect-src 'self'",
        "frame-ancestors 'none'",
        "base-uri 'self'",
        "form-action 'self'"
    ].join('; '));
    res.setHeader('X-Frame-Options', 'DENY');              // anti-clickjacking
    res.setHeader('X-Content-Type-Options', 'nosniff');    // no adivinar tipos MIME
    res.setHeader('Referrer-Policy', 'no-referrer');
    if (IS_PROD) {
        // Solo tiene sentido bajo HTTPS real (si se manda en http, el navegador lo ignora).
        res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    }
    next();
});

// 3) Middleware para parsear bodies JSON en peticiones POST.
// Límite explícito: todos los bodies del dashboard son diminutos (login, umbral,
// un ajuste). Sin límite, un POST gigante consume memoria del servidor porque sí.
app.use(express.json({ limit: '32kb' }));

// ===== V2.3: BASE DE DATOS + AUTENTICACIÓN =====
// dashboard.db (SQLite nativo de Node) o dashboard-db.json como fallback si el
// Node instalado no trae node:sqlite (< 22.5). Usuarios multicuenta con scrypt,
// sesiones HttpOnly y ajustes por usuario (cantidad de "My Crypto", idioma).
// TODOS los endpoints /api/* (salvo /api/auth/*) exigen sesión — la información
// del usuario queda detrás del sign-in.
const dbLayer = require('./lib/db');
const { registerAuthRoutes, requireAuth } = require('./lib/auth');
console.log(`BD activa: ${dbLayer.getEngine() === 'sqlite' ? 'SQLite nativo (dashboard.db)' : 'fallback JSON (dashboard-db.json) — Node sin node:sqlite'}`);
registerAuthRoutes(app);

// Ajustes por usuario (claves permitidas explícitamente: nada arbitrario en BD)
const ALLOWED_SETTINGS = new Set(['myXrpAmount', 'lang', 'activeCoin']);
// V2.5: cantidades de "My Crypto" por moneda (myAmount_<coingeckoId>) — patrón
// cerrado para no abrir la allowlist a claves arbitrarias.
const SETTING_KEY_PATTERN = /^myAmount_[a-z0-9-]{2,50}$/;

app.get('/api/settings', requireAuth, (req, res) => {
    try {
        res.json(dbLayer.getAllSettings(req.user.id));
    } catch (e) {
        res.status(500).json({ error: 'No se pudieron leer los ajustes.' });
    }
});

app.post('/api/settings', requireAuth, (req, res) => {
    try {
        const { key, value } = req.body || {};
        // V2.5: además de la allowlist fija, se aceptan cantidades por moneda
        // (myAmount_<coingeckoId>) con patrón cerrado.
        if (!ALLOWED_SETTINGS.has(key) && !SETTING_KEY_PATTERN.test(String(key))) return res.status(400).json({ error: 'Clave de ajuste no permitida.' });
        if (String(value).length > 200) return res.status(400).json({ error: 'Valor demasiado largo.' });
        dbLayer.setSetting(req.user.id, key, value);
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: 'No se pudo guardar el ajuste.' });
    }
});

// Verifica y crea el archivo data.json si no existe al iniciar el servidor
const initialData = {
    marketData: {},
    onChainData: {},
    technicals: {},
    sentiment: {},
    events: {},
    whaleTracker: {
        summary: {
            largeTransfers24h: 0,
            totalVolume24h: 0,
            exchangeFlowNet: 0,
            lastUpdated: ""
        },
        largeTransfers: [],
        // Bugfix: antes esta clave se llamaba "monitoredWallets" pero todo el código
        // lee "trackedWallets" — el tracker arrancaba sin wallets si data.json venía del initialData.
        trackedWallets: [
            { address: "rLNaPhS9K78Dbi4oAppSKXijcyS8YDXM6F", label: "Upbit", type: "exchange" },
            { address: "rEb8p7u3v4R8MmdM9mD5dz7tS8S5VjR69C", label: "Binance", type: "exchange" },
            { address: "rUge8AnpS5pYvR76L2pAmfR32Kx2yJ5C5", label: "Ripple", type: "whale" },
            { address: "rw58mG5idZ8D93Y4mZq9XW4dKqL7Q8rG", label: "Bithumb", type: "exchange" }
        ],
        selectedWallet: null,
        walletHistory: [],
        walletHistoryCache: {}
    },
    // V2.2 (roadmap #1): sin API gratuita conocida para flujos de ETF de XRP — nodo
    // manual-actualizable. Editar a mano en data.json (ver docs/GUIA-TABS.md "Cómo
    // actualizar ETFs") con la fuente y fecha del dato; nunca se autofetchea.
    etfFlows: null
};

if (!fs.existsSync(DATA_FILE)) {
    console.log('El archivo data.json no existe. Creando archivo con estructura inicial...');
    safeWriteFile(DATA_FILE, JSON.stringify(initialData, null, 2), 'utf8');
}

// ============================================================
// Bugfix (v2.2): en la verificación en vivo de Semana 3 se detectaron HTTP 429
// (rate-limit) de CoinGecko en varios fetchers a la vez (correlación BTC/ETH,
// volumen por exchange) — el ciclo ahora hace más llamadas a CoinGecko que antes
// (se sumaron ETH y volumen por exchange en esta misma sesión) y el free tier
// sin key es estricto con ráfagas. Wrapper compartido: si CoinGecko devuelve 429,
// espera y reintenta UNA vez antes de rendirse (cada fetcher sigue tolerando el
// fallo final igual que antes, esto solo reduce cuántas veces ocurre).
// ============================================================
// V2.6 — Todo fetch a una API externa lleva TIMEOUT.
// Bugfix: `await fetch(url)` sin timeout puede quedarse colgado indefinidamente si
// la API acepta la conexión y no responde nunca (no falla, simplemente no vuelve).
// Eso congelaba el ciclo de refresco entero. AbortSignal.timeout es nativo en Node 18+.
const FETCH_TIMEOUT_MS = 12000;
async function fetchWithTimeout(url, options = {}, timeoutMs = FETCH_TIMEOUT_MS) {
    try {
        return await fetch(url, { ...options, signal: AbortSignal.timeout(timeoutMs) });
    } catch (e) {
        if (e.name === 'TimeoutError' || e.name === 'AbortError') {
            throw new Error(`Timeout (${timeoutMs} ms) consultando ${String(url).split('?')[0]}`);
        }
        throw e;
    }
}

async function coingeckoFetch(url, retries = 1) {
    const resp = await fetchWithTimeout(url);
    if (resp.status === 429 && retries > 0) {
        console.warn(`CoinGecko 429 (rate-limit) en ${url.split('?')[0]}, reintentando en 15s...`);
        await new Promise(r => setTimeout(r, 15000));
        return coingeckoFetch(url, retries - 1);
    }
    return resp;
}

// Consulta datos de mercado desde CoinGecko public API
async function fetchMarketData() {
    try {
        const response = await coingeckoFetch('https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&ids=ripple&order=market_cap_desc&per_page=1&page=1&sparkline=false');
        const apiDataArray = await response.json();
        
        if (apiDataArray && Array.isArray(apiDataArray) && apiDataArray.length > 0) {
            const rippleData = apiDataArray[0];
            
            // Leer y parsear el archivo actual
            const rawData = fs.readFileSync(DATA_FILE, 'utf8');
            const data = JSON.parse(rawData);
            
            // Actualizar el nodo de marketData
            data.marketData = {
                price: rippleData.current_price,
                priceChange24h: rippleData.price_change_percentage_24h || 0,
                marketCap: rippleData.market_cap,
                marketCapChange24h: rippleData.market_cap_change_percentage_24h || 0,
                volume24h: rippleData.total_volume,
                lastUpdated: new Date().toISOString()
            };
            
            // V2.0: escribir solo el nodo propio sobre estado fresco (sin pisar a otros)
            await withDataFile(d => { d.marketData = data.marketData; });
            console.log('Datos de CoinGecko integrados correctamente en data.json');
        }
    } catch (error) {
        console.error('Error sincronizando con CoinGecko:', error);
    }
}

// Consulta datos On-Chain desde XRPScan API
async function fetchOnChainData() {
    try {
        const responseLog = await fetchWithTimeout('https://api.xrpscan.com/api/v1/ledger/');
        const apiData = await responseLog.json();
        
        let tps = 0;
        let activeAddresses = 0;
        let activeAddressesEstimated = true; // true mientras se use la fórmula proporcional

        // Como la API de /api/v1/metrics de XRPScan actualmente devuelve 404 (eliminada/restringida),
        // calcularemos el TPS en tiempo real (más preciso) usando el array de 'ledgers' que sí funciona.
        if (apiData && apiData.ledgers && apiData.ledgers.length > 1) {
            const firstLedger = apiData.ledgers[0];
            const lastLedger = apiData.ledgers[apiData.ledgers.length - 1];
            
            const timeDiffSeconds = firstLedger.close_time - lastLedger.close_time;
            
            if (timeDiffSeconds > 0) {
                const totalTxsInWindow = apiData.ledgers.reduce((acc, l) => acc + (l.tx_count || 0), 0);
                tps = parseFloat((totalTxsInWindow / timeDiffSeconds).toFixed(2));
            }
            
            // Aproximación proporcional para cuentas activas si el endpoint original ha muerto. 
            // Historicamente, ~50,000 cuentas hacen ~1,200,000 tx diarias (aprox 15 TPS).
            activeAddresses = Math.floor(25000 + (tps * 1800)); 
        }

        let tpsChange24h = 0;
        let activeAddressesChange24h = 0;

        try {
            const metricsResponse = await fetchWithTimeout('https://api.xrpscan.com/api/v1/metrics');
            if (metricsResponse.ok) {
                const metricsText = await metricsResponse.text();
                if (metricsText.startsWith('[')) {
                    const metricsData = JSON.parse(metricsText);
                    if (Array.isArray(metricsData) && metricsData.length > 1) {
                        const sortedMetrics = [...metricsData].sort((a, b) => {
                            if (a.date && b.date) return new Date(b.date) - new Date(a.date);
                            return 0;
                        });

                        const latest = sortedMetrics[0];
                        const previous = sortedMetrics[1];

                        const latestTx = latest.txCount || latest.tx_count || 0;
                        const previousTx = previous.txCount || previous.tx_count || 0;
                        const latestAcc = latest.activeAccounts || latest.active_accounts || latest.activeCount || 0;
                        const previousAcc = previous.activeAccounts || previous.active_accounts || previous.activeCount || 0;

                        if (latestTx > 0) {
                            tps = parseFloat((latestTx / 86400).toFixed(2));
                            if (previousTx > 0) {
                                tpsChange24h = ((latestTx - previousTx) / previousTx) * 100;
                            }
                        }

                        if (latestAcc > 0) {
                            activeAddresses = latestAcc;
                            activeAddressesEstimated = false; // dato real de la API de métricas
                            if (previousAcc > 0) {
                                activeAddressesChange24h = ((latestAcc - previousAcc) / previousAcc) * 100;
                            }
                        }
                    }
                }
            }
        } catch (metricsError) {
            console.error('API Metrics de XRPScan no disponible, se usó cálculo en tiempo real.');
        }

        if (apiData && apiData.ledgers && apiData.ledgers.length > 0) {
            const latestLedgerObj = apiData.ledgers[0];
            
            const rawData = fs.readFileSync(DATA_FILE, 'utf8');
            const data = JSON.parse(rawData);
            
            const totalCoinsXrp = Math.floor(latestLedgerObj.total_coins / 1000000);
            
            data.onChainData = {
                currentLedger: latestLedgerObj.ledger_index,
                totalCoins: totalCoinsXrp,
                tps: tps > 0 ? tps : (data.onChainData.tps || 0),
                tpsChange24h: tpsChange24h,
                activeAddresses: activeAddresses > 0 ? activeAddresses : (data.onChainData.activeAddresses || 0),
                activeAddressesEstimated: activeAddressesEstimated,
                activeAddressesChange24h: activeAddressesChange24h,
                lastUpdated: new Date().toISOString()
            };
            
            await withDataFile(d => { d.onChainData = data.onChainData; });
            console.log('Datos On-Chain y de Métricas (con variaciones) integrados en data.json');
        }
    } catch (error) {
        console.error('Error sincronizando On-Chain con XRPScan:', error);
    }
}

// Consulta datos históricos para el gráfico desde CoinGecko API
async function fetchChartData() {
    try {
        const response = await coingeckoFetch('https://api.coingecko.com/api/v3/coins/ripple/market_chart?vs_currency=usd&days=365');
        const apiData = await response.json();
        
        if (apiData && apiData.prices) {
            // Leer y parsear el archivo actual
            const rawData = fs.readFileSync(DATA_FILE, 'utf8');
            const data = JSON.parse(rawData);
            
            // Extraer y guardar array simple de timestamp/precios
            await withDataFile(d => { d.chartData = apiData.prices; });
            console.log('Datos Históricos de Gráfico (CoinGecko) integrados en data.json');
        }
    } catch (error) {
        console.error('Error sincronizando gráfica con CoinGecko:', error);
    }
}

// Calcular Indicadores Técnicos usando data.json (chartData)
async function calculateTechnicals() {
    try {
        const rawData = fs.readFileSync(DATA_FILE, 'utf8');
        const data = JSON.parse(rawData);
        
        if (data.chartData && data.chartData.length > 0) {
            // BUGFIX: antes se usaba slice(-7) asumiendo velas diarias, pero chartData
            // puede venir en resolución de minutos/horas si el usuario cambió la gráfica
            // a 1D/7D (el soporte/resistencia "de 7 días" acababa siendo de ~35 minutos).
            // Ahora la ventana de 7 días se calcula por TIMESTAMP real.
            const lastTs = data.chartData[data.chartData.length - 1][0];
            const spanDays = (lastTs - data.chartData[0][0]) / 86400000;
            if (spanDays < 2 && data.technicals && data.technicals.support) {
                console.warn('Technicals: chartData cubre menos de 2 días, se conservan los técnicos previos.');
                return;
            }
            const sevenDaysAgo = lastTs - 7 * 86400000;
            const prices = data.chartData.filter(item => item[0] >= sevenDaysAgo).map(item => item[1]);
            
            // Soporte y Resistencia en el marco temporal (7 días)
            const soporte = Math.min(...prices);
            const resistencia = Math.max(...prices);

            // Bugfix (purga v2.2): antes se calculaba aquí un RSI naive (ganancias/pérdidas
            // acumuladas sobre la ventana de 7 días, sin suavizado de Wilder) y se guardaba
            // en technicals.rsi. La UI nunca lo consumió: usa el RSI 14 Wilder real de
            // advancedMetrics.momentum.rsi14 (ver _rsiWilder). Campo eliminado para no
            // mantener dos "RSI" contradictorios en data.json.
            const technicals = {
                support: soporte,
                resistance: resistencia,
                lastUpdated: new Date().toISOString()
            };
            await withDataFile(d => { d.technicals = technicals; });
            console.log('Indicadores Técnicos calculados y guardados en data.json');
        }
    } catch (error) {
        console.error('Error calculando indicadores técnicos:', error);
    }
}

// ============================================================
// MÉTRICAS AVANZADAS DE INVERSIÓN (Advanced Investment Metrics)
// Calcula sobre el histórico diario (365d) de chartData:
// RSI 14 (Wilder), SMA 20/50/200, cruces (Golden/Death Cross),
// MACD (12,26,9), Bandas de Bollinger, volatilidad anualizada,
// max drawdown, Sharpe, VaR 95%, retornos por periodo, máx/mín 52
// semanas, correlación con BTC, ratio Volumen/MarketCap y un
// score compuesto EDUCATIVO con insights interpretados.
// ============================================================

// (_dailyReturns, _mean, _stdDev, _smaLast, _emaArray, _rsiWilder, _maxDrawdown,
// _pearson, _percentile viven en lib/calc.js — ver el require() al inicio del archivo)

// ============================================================
// V2.3: SPY (S&P 500) — histórico diario para correlación con el mercado
// tradicional. Fuente primaria: Yahoo Finance chart API (sin key; requiere
// User-Agent de navegador). Fallback: Stooq (CSV diario, sin key).
// Devuelve [{date:'YYYY-MM-DD', close}] del último año, o null si ambas fallan.
// ============================================================
async function fetchSpyDailySeries() {
    // Intento 1: Yahoo Finance
    try {
        const resp = await fetchWithTimeout('https://query1.finance.yahoo.com/v8/finance/chart/SPY?range=1y&interval=1d', {
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
        });
        if (resp.ok) {
            const j = await resp.json();
            const r = j && j.chart && j.chart.result && j.chart.result[0];
            const ts = r && r.timestamp;
            const closes = r && r.indicators && r.indicators.quote && r.indicators.quote[0] && r.indicators.quote[0].close;
            if (Array.isArray(ts) && Array.isArray(closes) && ts.length > 90) {
                const out = [];
                for (let i = 0; i < ts.length; i++) {
                    if (typeof closes[i] === 'number' && isFinite(closes[i])) {
                        out.push({ date: new Date(ts[i] * 1000).toISOString().slice(0, 10), close: closes[i] });
                    }
                }
                if (out.length > 90) return out;
            }
        }
        console.warn(`SPY: Yahoo respondió ${resp.status} o con datos insuficientes, probando Stooq...`);
    } catch (e) {
        console.warn('SPY: Yahoo no disponible, probando Stooq...', e.message);
    }
    // Intento 2: Stooq (CSV: Date,Open,High,Low,Close,Volume)
    try {
        const resp = await fetchWithTimeout('https://stooq.com/q/d/l/?s=spy.us&i=d');
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const csv = await resp.text();
        const lines = csv.trim().split(/\r?\n/);
        if (lines.length < 90 || !/^date,open/i.test(lines[0])) throw new Error('CSV inesperado');
        const cutoff = new Date(Date.now() - 370 * 86400000).toISOString().slice(0, 10);
        const out = [];
        for (let i = 1; i < lines.length; i++) {
            const cols = lines[i].split(',');
            const date = cols[0];
            const close = parseFloat(cols[4]);
            if (date >= cutoff && isFinite(close) && close > 0) out.push({ date, close });
        }
        if (out.length > 90) return out;
        throw new Error('serie demasiado corta');
    } catch (e) {
        console.warn('SPY: Stooq tampoco disponible:', e.message);
        return null;
    }
}

async function calculateAdvancedMetrics() {
    try {
        const rawData = fs.readFileSync(DATA_FILE, 'utf8');
        const data = JSON.parse(rawData);

        if (!data.chartData || !Array.isArray(data.chartData) || data.chartData.length < 60) {
            console.warn('AdvancedMetrics: chartData insuficiente, se omite el cálculo.');
            return;
        }

        // PROTECCIÓN: si el usuario cambió la gráfica a 1D/7D, chartData ya no es
        // el histórico diario de 365 días. Solo recalculamos con ventana >= ~180 días.
        const spanDays = (data.chartData[data.chartData.length - 1][0] - data.chartData[0][0]) / 86400000;
        if (spanDays < 180) {
            console.warn(`AdvancedMetrics: ventana de ${spanDays.toFixed(0)}d insuficiente, se conservan métricas previas.`);
            return;
        }

        const prices = data.chartData.map(p => p[1]);
        const currentPrice = (data.marketData && data.marketData.price) || prices[prices.length - 1];
        const returns = _dailyReturns(prices);

        // --- "Holders underwater" aproximado (roadmap #10) ---
        // Aproximación metodológica honesta (NO es precio realizado on-chain real,
        // que requeriría trazar cada UTXO/cuenta): % de días del último año en los
        // que el cierre fue MAYOR que el precio actual — proxy de cuánta "ventana
        // de compra" del año quedó por encima de donde está XRP hoy. Cuantos más
        // días de cierre superior, más probable que una porción grande de compradores
        // recientes esté en pérdidas no realizadas.
        const daysAboveCurrent = prices.filter(p => p > currentPrice).length;
        const underwaterApprox = {
            pctDaysAboveCurrentPrice: parseFloat(((daysAboveCurrent / prices.length) * 100).toFixed(1)),
            daysSampled: prices.length,
            methodology: 'estimación metodológica: % de días del último año con cierre por encima del precio actual (proxy, no precio realizado on-chain real)',
            methodologyEn: 'methodological estimate: % of days over the past year closing above the current price (a proxy, not real on-chain realized price)',
            estimated: true
        };

        // --- Tendencia: SMAs y cruces ---
        const sma20 = _smaLast(prices, 20);
        const sma50 = _smaLast(prices, 50);
        const sma200 = _smaLast(prices, 200);
        const sma50Prev = prices.length > 201 ? _smaLast(prices.slice(0, -1), 50) : null;
        const sma200Prev = prices.length > 201 ? _smaLast(prices.slice(0, -1), 200) : null;
        let crossSignal = 'NINGUNO';
        if (sma50 && sma200 && sma50Prev && sma200Prev) {
            if (sma50 > sma200 && sma50Prev <= sma200Prev) crossSignal = 'GOLDEN_CROSS';
            else if (sma50 < sma200 && sma50Prev >= sma200Prev) crossSignal = 'DEATH_CROSS';
            else if (sma50 > sma200) crossSignal = 'TENDENCIA_ALCISTA';
            else crossSignal = 'TENDENCIA_BAJISTA';
        }

        // --- MACD (12, 26, 9) ---
        const ema12 = _emaArray(prices, 12);
        const ema26 = _emaArray(prices, 26);
        const macdLine = prices.map((_, i) => (ema12[i] != null && ema26[i] != null) ? ema12[i] - ema26[i] : null).filter(v => v != null);
        const signalArr = _emaArray(macdLine, 9);
        const macd = macdLine.length ? macdLine[macdLine.length - 1] : null;
        const macdSignal = signalArr.length ? signalArr[signalArr.length - 1] : null;
        const macdHist = (macd != null && macdSignal != null) ? macd - macdSignal : null;

        // --- Bandas de Bollinger (20, 2σ) ---
        let bollinger = null;
        if (prices.length >= 20) {
            const w = prices.slice(-20);
            const mid = _mean(w);
            const sd = _stdDev(w);
            const upper = mid + 2 * sd, lower = mid - 2 * sd;
            const percentB = (upper - lower) > 0 ? (currentPrice - lower) / (upper - lower) : 0.5;
            bollinger = {
                upper: parseFloat(upper.toFixed(4)),
                middle: parseFloat(mid.toFixed(4)),
                lower: parseFloat(lower.toFixed(4)),
                percentB: parseFloat(percentB.toFixed(3)),
                bandwidthPct: parseFloat((((upper - lower) / mid) * 100).toFixed(2))
            };
        }

        // --- Riesgo ---
        const ret30 = returns.slice(-30);
        const ret90 = returns.slice(-90);
        const vol30Annualized = _stdDev(ret30) * Math.sqrt(365) * 100;
        const vol90Annualized = _stdDev(ret90) * Math.sqrt(365) * 100;
        const maxDrawdown1y = _maxDrawdown(prices);
        const sharpe90 = _stdDev(ret90) > 0 ? (_mean(ret90) / _stdDev(ret90)) * Math.sqrt(365) : 0;
        const sortedRet90 = [...ret90].sort((a, b) => a - b);
        const var95Daily = _percentile(sortedRet90, 0.05) * 100; // pérdida diaria esperada en el peor 5%

        // --- Rendimiento por periodos ---
        const perfPeriod = (days) => {
            if (prices.length <= days) return null;
            const past = prices[prices.length - 1 - days];
            return past > 0 ? parseFloat((((currentPrice - past) / past) * 100).toFixed(2)) : null;
        };
        const performance = {
            d7: perfPeriod(7),
            d30: perfPeriod(30),
            d90: perfPeriod(90),
            d365: perfPeriod(Math.min(364, prices.length - 1))
        };

        // --- 52 semanas ---
        const high52w = Math.max(...prices);
        const low52w = Math.min(...prices);
        const fromHighPct = ((currentPrice - high52w) / high52w) * 100;
        const fromLowPct = ((currentPrice - low52w) / low52w) * 100;

        // --- Correlación con BTC ---
        let btcCorrelation30 = null, btcCorrelation90 = null, btcPerf30 = null;
        try {
            const btcResp = await coingeckoFetch('https://api.coingecko.com/api/v3/coins/bitcoin/market_chart?vs_currency=usd&days=365');
            if (!btcResp.ok) throw new Error(`HTTP ${btcResp.status}`); // Bugfix: sin este check, un 429 (rate-limit) devolvía JSON sin 'prices' y fallaba en silencio
            const btcData = await btcResp.json();
            if (btcData && Array.isArray(btcData.prices) && btcData.prices.length > 90) {
                const btcPrices = btcData.prices.map(p => p[1]);
                const btcReturns = _dailyReturns(btcPrices);
                btcCorrelation30 = _pearson(returns.slice(-30), btcReturns.slice(-30));
                btcCorrelation90 = _pearson(returns.slice(-90), btcReturns.slice(-90));
                const btcPast30 = btcPrices[btcPrices.length - 31];
                if (btcPast30 > 0) btcPerf30 = ((btcPrices[btcPrices.length - 1] - btcPast30) / btcPast30) * 100;
            }
        } catch (e) {
            console.warn('AdvancedMetrics: no se pudo obtener histórico BTC para correlación:', e.message);
        }

        // Bugfix (v2.2): el fetch de ETH añadido para roadmap #15 iba pegado al de BTC
        // sin pausa — dos llamadas seguidas a CoinGecko a veces disparaban un 429 que
        // antes fallaba en silencio (ver check .ok arriba). Se espacía un poco.
        await new Promise(r => setTimeout(r, 1500));

        // --- Correlación con ETH (roadmap #15) ---
        let ethCorrelation30 = null, ethCorrelation90 = null, ethPerf30 = null;
        try {
            const ethResp = await coingeckoFetch('https://api.coingecko.com/api/v3/coins/ethereum/market_chart?vs_currency=usd&days=365');
            if (!ethResp.ok) throw new Error(`HTTP ${ethResp.status}`);
            const ethData = await ethResp.json();
            if (ethData && Array.isArray(ethData.prices) && ethData.prices.length > 90) {
                const ethPrices = ethData.prices.map(p => p[1]);
                const ethReturns = _dailyReturns(ethPrices);
                ethCorrelation30 = _pearson(returns.slice(-30), ethReturns.slice(-30));
                ethCorrelation90 = _pearson(returns.slice(-90), ethReturns.slice(-90));
                const ethPast30 = ethPrices[ethPrices.length - 31];
                if (ethPast30 > 0) ethPerf30 = ((ethPrices[ethPrices.length - 1] - ethPast30) / ethPast30) * 100;
            }
        } catch (e) {
            console.warn('AdvancedMetrics: no se pudo obtener histórico ETH para correlación:', e.message);
        }

        // --- Correlación con SPY (S&P 500) — V2.3 ---
        // XRP cotiza 7 días/semana; SPY solo días hábiles de bolsa. Si se correlacionan
        // los arrays "en crudo" las fechas se desalinean y el resultado es basura.
        // Se alinean por FECHA (solo días donde AMBOS tienen cierre) y se usan las
        // últimas 21/63 SESIONES bursátiles (≈ 1 y 3 meses de calendario).
        let spyCorrelation30 = null, spyCorrelation90 = null, spyPerf30 = null;
        try {
            const spySeries = await fetchSpyDailySeries();
            if (spySeries && spySeries.length > 90) {
                const xrpByDate = new Map();
                for (const p of data.chartData) xrpByDate.set(new Date(p[0]).toISOString().slice(0, 10), p[1]);
                const alignedXrp = [], alignedSpy = [];
                for (const s of spySeries) {
                    const x = xrpByDate.get(s.date);
                    if (typeof x === 'number') { alignedXrp.push(x); alignedSpy.push(s.close); }
                }
                if (alignedXrp.length > 70) {
                    const xrpR = _dailyReturns(alignedXrp);
                    const spyR = _dailyReturns(alignedSpy);
                    spyCorrelation30 = _pearson(xrpR.slice(-21), spyR.slice(-21)); // ~1 mes bursátil
                    spyCorrelation90 = _pearson(xrpR.slice(-63), spyR.slice(-63)); // ~3 meses bursátiles
                    const past = alignedSpy[alignedSpy.length - 22];
                    if (past > 0) spyPerf30 = ((alignedSpy[alignedSpy.length - 1] - past) / past) * 100;
                    console.log(`SPY: correlación calculada sobre ${alignedXrp.length} sesiones alineadas por fecha.`);
                } else {
                    console.warn(`SPY: solo ${alignedXrp.length} sesiones alineadas (<70), se omite la correlación.`);
                }
            }
        } catch (e) {
            console.warn('AdvancedMetrics: no se pudo calcular correlación con SPY:', e.message);
        }

        // --- Liquidez ---
        const volMcapRatio = (data.marketData && data.marketData.marketCap > 0)
            ? (data.marketData.volume24h / data.marketData.marketCap) * 100
            : null;

        // --- RSI 14 real (Wilder, ventana diaria completa) ---
        const rsi14 = _rsiWilder(prices, 14);

        // --- Score compuesto EDUCATIVO (0-100) ---
        // Combina tendencia, momentum, sentimiento y flujo. NO es asesoramiento financiero.
        // V2.4 i18n: cada factor lleva detail (ES) + detailEn — el frontend elige
        // según el idioma activo (mismo patrón en insights y dailyBrief).
        let score = 50;
        const scoreFactors = [];
        if (sma50 != null) {
            const f = currentPrice > sma50 ? 10 : -10;
            score += f;
            scoreFactors.push({ factor: 'Precio vs SMA50', factorEn: 'Price vs SMA50', impact: f,
                detail: currentPrice > sma50 ? 'Por encima (alcista)' : 'Por debajo (bajista)',
                detailEn: currentPrice > sma50 ? 'Above (bullish)' : 'Below (bearish)' });
        }
        if (sma200 != null) {
            const f = currentPrice > sma200 ? 15 : -15;
            score += f;
            scoreFactors.push({ factor: 'Precio vs SMA200', factorEn: 'Price vs SMA200', impact: f,
                detail: currentPrice > sma200 ? 'Tendencia mayor alcista' : 'Tendencia mayor bajista',
                detailEn: currentPrice > sma200 ? 'Major trend bullish' : 'Major trend bearish' });
        }
        if (macdHist != null) {
            const f = macdHist > 0 ? 10 : -10;
            score += f;
            scoreFactors.push({ factor: 'MACD', factorEn: 'MACD', impact: f,
                detail: macdHist > 0 ? 'Momentum positivo' : 'Momentum negativo',
                detailEn: macdHist > 0 ? 'Positive momentum' : 'Negative momentum' });
        }
        if (rsi14 != null) {
            let f = 0, det = 'Zona neutral', detEn = 'Neutral zone';
            if (rsi14 > 70) { f = -10; det = 'Sobrecompra (>70): riesgo de corrección'; detEn = 'Overbought (>70): correction risk'; }
            else if (rsi14 >= 55) { f = 5; det = 'Momentum saludable'; detEn = 'Healthy momentum'; }
            else if (rsi14 < 30) { f = 5; det = 'Sobreventa (<30): posible rebote técnico'; detEn = 'Oversold (<30): possible technical bounce'; }
            else if (rsi14 < 45) { f = -5; det = 'Momentum débil'; detEn = 'Weak momentum'; }
            score += f;
            scoreFactors.push({ factor: 'RSI 14', factorEn: 'RSI 14', impact: f, detail: det, detailEn: detEn });
        }
        if (data.sentiment && data.sentiment.value != null) {
            let f = 0, det = 'Sentimiento neutral', detEn = 'Neutral sentiment';
            if (data.sentiment.value <= 25) { f = 5; det = 'Miedo extremo (señal contraria)'; detEn = 'Extreme fear (contrarian signal)'; }
            else if (data.sentiment.value >= 75) { f = -5; det = 'Codicia extrema (señal de cautela)'; detEn = 'Extreme greed (caution signal)'; }
            score += f;
            scoreFactors.push({ factor: 'Fear & Greed', factorEn: 'Fear & Greed', impact: f, detail: det, detailEn: detEn });
        }
        if (data.orderFlow && data.orderFlow.buyPercent != null) {
            let f = 0, det = 'Flujo equilibrado', detEn = 'Balanced flow';
            if (data.orderFlow.buyPercent > 55) { f = 5; det = 'Predomina presión compradora'; detEn = 'Buy pressure dominates'; }
            else if (data.orderFlow.buyPercent < 45) { f = -5; det = 'Predomina presión vendedora'; detEn = 'Sell pressure dominates'; }
            score += f;
            scoreFactors.push({ factor: 'Order Flow (Binance)', factorEn: 'Order Flow (Binance)', impact: f, detail: det, detailEn: detEn });
        }
        score = Math.max(0, Math.min(100, score));
        let scoreLabel = 'NEUTRAL', scoreLabelEn = 'NEUTRAL';
        if (score >= 65) { scoreLabel = 'SESGO ALCISTA'; scoreLabelEn = 'BULLISH BIAS'; }
        else if (score <= 40) { scoreLabel = 'SESGO BAJISTA'; scoreLabelEn = 'BEARISH BIAS'; }

        // --- Insights interpretados (V2.4: bilingües — text ES + textEn) ---
        const insights = [];
        if (crossSignal === 'GOLDEN_CROSS') insights.push({ icon: '🟢', level: 'positivo',
            text: 'Golden Cross detectado: la SMA50 acaba de cruzar por encima de la SMA200, históricamente una señal alcista de medio plazo.',
            textEn: 'Golden Cross detected: the SMA50 just crossed above the SMA200 — historically a medium-term bullish signal.' });
        if (crossSignal === 'DEATH_CROSS') insights.push({ icon: '🔴', level: 'negativo',
            text: 'Death Cross detectado: la SMA50 cruzó por debajo de la SMA200, señal de debilidad de medio plazo.',
            textEn: 'Death Cross detected: the SMA50 crossed below the SMA200 — a medium-term weakness signal.' });
        if (rsi14 != null && rsi14 > 70) insights.push({ icon: '⚠️', level: 'negativo',
            text: `RSI en ${rsi14.toFixed(1)} (sobrecompra). El precio podría estar extendido; entradas a estos niveles tienen peor ratio riesgo/beneficio.`,
            textEn: `RSI at ${rsi14.toFixed(1)} (overbought). Price may be extended; entries at these levels historically carry a worse risk/reward ratio.` });
        if (rsi14 != null && rsi14 < 30) insights.push({ icon: '💡', level: 'positivo',
            text: `RSI en ${rsi14.toFixed(1)} (sobreventa). Históricamente estas zonas preceden rebotes técnicos, aunque pueden extenderse en tendencias bajistas fuertes.`,
            textEn: `RSI at ${rsi14.toFixed(1)} (oversold). These zones have historically preceded technical bounces, though they can extend in strong downtrends.` });
        if (bollinger && bollinger.percentB > 1) insights.push({ icon: '▲', level: 'neutro',
            text: 'El precio cerró por encima de la banda superior de Bollinger: fuerte momentum, pero estadísticamente extendido.',
            textEn: 'Price closed above the upper Bollinger band: strong momentum, but statistically extended.' });
        if (bollinger && bollinger.percentB < 0) insights.push({ icon: '▼', level: 'neutro',
            text: 'El precio cerró por debajo de la banda inferior de Bollinger: presión vendedora extrema o capitulación.',
            textEn: 'Price closed below the lower Bollinger band: extreme selling pressure or capitulation.' });
        if (vol30Annualized > 90) insights.push({ icon: '⚠️', level: 'negativo',
            text: `Volatilidad anualizada de ${vol30Annualized.toFixed(0)}% (30d): muy alta. Dimensiona posiciones con cautela; el VaR diario al 95% es ${var95Daily.toFixed(1)}%.`,
            textEn: `Annualized volatility of ${vol30Annualized.toFixed(0)}% (30d): very high. Size positions carefully; daily 95% VaR is ${var95Daily.toFixed(1)}%.` });
        if (maxDrawdown1y < -40) insights.push({ icon: '▼', level: 'neutro',
            text: `El drawdown máximo del último año fue ${maxDrawdown1y.toFixed(1)}%. Quien compró en máximos llegó a soportar esa caída: define tu tolerancia antes de entrar.`,
            textEn: `Max drawdown over the past year was ${maxDrawdown1y.toFixed(1)}%. Anyone who bought the top endured that fall: define your tolerance before entering.` });
        if (btcCorrelation30 != null && btcCorrelation30 > 0.7) insights.push({ icon: '🔗', level: 'neutro',
            text: `Correlación con BTC de ${(btcCorrelation30 * 100).toFixed(0)}% (30d): XRP se mueve en gran medida con Bitcoin. Vigila el contexto macro de BTC, no solo las noticias de Ripple.`,
            textEn: `BTC correlation of ${(btcCorrelation30 * 100).toFixed(0)}% (30d): XRP largely moves with Bitcoin. Watch BTC's macro context, not just Ripple news.` });
        if (btcCorrelation30 != null && btcCorrelation30 < 0.3) insights.push({ icon: '🔓', level: 'neutro',
            text: `Correlación con BTC baja (${(btcCorrelation30 * 100).toFixed(0)}% a 30d): XRP está cotizando con narrativa propia (noticias legales, adopción, escrow).`,
            textEn: `Low BTC correlation (${(btcCorrelation30 * 100).toFixed(0)}% over 30d): XRP is trading on its own narrative (legal news, adoption, escrow).` });
        if (volMcapRatio != null && volMcapRatio < 2) insights.push({ icon: '💧', level: 'negativo',
            text: `Ratio Volumen/MarketCap de ${volMcapRatio.toFixed(2)}%: liquidez relativamente baja; movimientos bruscos pueden amplificarse.`,
            textEn: `Volume/MarketCap ratio of ${volMcapRatio.toFixed(2)}%: relatively low liquidity; sharp moves can get amplified.` });
        if (volMcapRatio != null && volMcapRatio > 8) insights.push({ icon: '🔥', level: 'neutro',
            text: `Ratio Volumen/MarketCap de ${volMcapRatio.toFixed(2)}%: actividad de trading inusualmente alta, suele coincidir con eventos o cambios de tendencia.`,
            textEn: `Volume/MarketCap ratio of ${volMcapRatio.toFixed(2)}%: unusually high trading activity, often coinciding with events or trend changes.` });
        if (fromHighPct < -50) insights.push({ icon: '↕', level: 'neutro',
            text: `El precio está ${Math.abs(fromHighPct).toFixed(0)}% por debajo del máximo de 52 semanas ($${high52w.toFixed(4)}). Recuperarlo exigiría una subida del ${(((high52w / currentPrice) - 1) * 100).toFixed(0)}%.`,
            textEn: `Price is ${Math.abs(fromHighPct).toFixed(0)}% below the 52-week high ($${high52w.toFixed(4)}). Reclaiming it would require a ${(((high52w / currentPrice) - 1) * 100).toFixed(0)}% rise.` });
        if (sharpe90 > 1) insights.push({ icon: '🏆', level: 'positivo',
            text: `Sharpe (90d) de ${sharpe90.toFixed(2)}: el retorno reciente ha compensado bien el riesgo asumido.`,
            textEn: `Sharpe (90d) of ${sharpe90.toFixed(2)}: recent returns have compensated well for the risk taken.` });
        if (sharpe90 < 0) insights.push({ icon: '⚖️', level: 'negativo',
            text: `Sharpe (90d) negativo (${sharpe90.toFixed(2)}): en los últimos 3 meses el riesgo asumido no se ha visto recompensado.`,
            textEn: `Negative Sharpe (90d) (${sharpe90.toFixed(2)}): over the past 3 months the risk taken has not paid off.` });

        data.advancedMetrics = {
            momentum: {
                rsi14: rsi14 != null ? parseFloat(rsi14.toFixed(2)) : null,
                macd: macd != null ? parseFloat(macd.toFixed(5)) : null,
                macdSignal: macdSignal != null ? parseFloat(macdSignal.toFixed(5)) : null,
                macdHistogram: macdHist != null ? parseFloat(macdHist.toFixed(5)) : null,
                bollinger: bollinger
            },
            trend: {
                sma20: sma20 != null ? parseFloat(sma20.toFixed(4)) : null,
                sma50: sma50 != null ? parseFloat(sma50.toFixed(4)) : null,
                sma200: sma200 != null ? parseFloat(sma200.toFixed(4)) : null,
                priceVsSma50Pct: sma50 ? parseFloat((((currentPrice - sma50) / sma50) * 100).toFixed(2)) : null,
                priceVsSma200Pct: sma200 ? parseFloat((((currentPrice - sma200) / sma200) * 100).toFixed(2)) : null,
                crossSignal: crossSignal
            },
            risk: {
                volatility30dAnnualizedPct: parseFloat(vol30Annualized.toFixed(2)),
                volatility90dAnnualizedPct: parseFloat(vol90Annualized.toFixed(2)),
                maxDrawdown1yPct: parseFloat(maxDrawdown1y.toFixed(2)),
                sharpeRatio90d: parseFloat(sharpe90.toFixed(2)),
                var95DailyPct: parseFloat(var95Daily.toFixed(2))
            },
            underwaterApprox: underwaterApprox,
            performance: performance,
            range52w: {
                high: parseFloat(high52w.toFixed(4)),
                low: parseFloat(low52w.toFixed(4)),
                fromHighPct: parseFloat(fromHighPct.toFixed(2)),
                fromLowPct: parseFloat(fromLowPct.toFixed(2))
            },
            correlation: {
                btc30d: btcCorrelation30 != null ? parseFloat(btcCorrelation30.toFixed(3)) : null,
                btc90d: btcCorrelation90 != null ? parseFloat(btcCorrelation90.toFixed(3)) : null,
                btcPerf30dPct: btcPerf30 != null ? parseFloat(btcPerf30.toFixed(2)) : null,
                // V2.2 (roadmap #15): ETH como referencia de "índice altcoins" — CoinGecko no
                // expone histórico gratuito de market cap total del mercado (solo snapshot vía
                // /global), así que se usa ETH (el altcoin de mayor peso) como proxy práctico.
                eth30d: ethCorrelation30 != null ? parseFloat(ethCorrelation30.toFixed(3)) : null,
                eth90d: ethCorrelation90 != null ? parseFloat(ethCorrelation90.toFixed(3)) : null,
                ethPerf30dPct: ethPerf30 != null ? parseFloat(ethPerf30.toFixed(2)) : null,
                // V2.3: SPY (S&P 500) — el puente con el mercado tradicional. Sesiones
                // bursátiles alineadas por fecha (21/63 ≈ 1/3 meses de calendario).
                spy30d: spyCorrelation30 != null ? parseFloat(spyCorrelation30.toFixed(3)) : null,
                spy90d: spyCorrelation90 != null ? parseFloat(spyCorrelation90.toFixed(3)) : null,
                spyPerf30dPct: spyPerf30 != null ? parseFloat(spyPerf30.toFixed(2)) : null,
                spyNote: 'Correlación con SPY sobre sesiones bursátiles alineadas por fecha (SPY no cotiza fines de semana). Fuente: Yahoo Finance con fallback Stooq.'
            },
            liquidity: {
                volumeMarketCapRatioPct: volMcapRatio != null ? parseFloat(volMcapRatio.toFixed(2)) : null
            },
            compositeScore: {
                value: score,
                label: scoreLabel,
                labelEn: scoreLabelEn,
                factors: scoreFactors,
                disclaimer: 'Indicador educativo basado en reglas técnicas. NO constituye asesoramiento financiero.'
            },
            insights: insights,
            lastUpdated: new Date().toISOString()
        };

        await withDataFile(d => { d.advancedMetrics = data.advancedMetrics; });
        console.log(`Métricas Avanzadas calculadas: score ${score} (${scoreLabel}), ${insights.length} insights.`);
    } catch (error) {
        console.error('Error calculando métricas avanzadas:', error);
    }
}

// Consulta Sentimiento del Mercado desde Alternative.me
async function fetchSentimentData() {
    try {
        const response = await fetchWithTimeout('https://api.alternative.me/fng/?limit=1');
        const apiData = await response.json();
        
        if (apiData && apiData.data && apiData.data.length > 0) {
            const current = apiData.data[0];
            
            const rawData = fs.readFileSync(DATA_FILE, 'utf8');
            const data = JSON.parse(rawData);
            
            // Guardar en el nodo sentiment
            const sentiment = {
                value: parseInt(current.value, 10),
                classification: current.value_classification,
                lastUpdated: new Date().toISOString()
            };
            await withDataFile(d => { d.sentiment = sentiment; });
            console.log('Datos de Sentimiento calculados y guardados en data.json');
        }
    } catch (error) {
        console.error('Error sincronizando sentimiento del mercado:', error);
    }
}

// Consulta datos de flujo de órdenes (Buy/Sell Pressure) desde Binance
// Volumen spot de XRP por exchange (roadmap #14): complementa Buy/Sell Pressure
// (que solo mide Binance) con dónde se negocia XRP de verdad. CoinGecko /tickers
// es gratuito y sin key (ROADMAP-V2.md, notas de fuentes verificadas 2026-07-03).
async function fetchExchangeVolumeData() {
    try {
        const response = await coingeckoFetch('https://api.coingecko.com/api/v3/coins/ripple/tickers?include_exchange_logo=false');
        const json = await response.json();
        const tickers = Array.isArray(json?.tickers) ? json.tickers : [];
        if (tickers.length === 0) {
            console.warn('Volumen por exchange: CoinGecko no devolvió tickers, se omite el ciclo.');
            return;
        }

        // Varios pares por exchange (XRP/USDT, XRP/USD...) — agregar por nombre de mercado.
        const byExchange = new Map();
        for (const t of tickers) {
            const name = t.market?.name;
            const volUsd = t.converted_volume?.usd;
            if (!name || typeof volUsd !== 'number' || volUsd <= 0) continue;
            byExchange.set(name, (byExchange.get(name) || 0) + volUsd);
        }

        const totalVolumeUsd = Array.from(byExchange.values()).reduce((s, v) => s + v, 0);
        const ranked = Array.from(byExchange.entries())
            .map(([name, volumeUsd]) => ({ name, volumeUsd, pct: totalVolumeUsd > 0 ? parseFloat(((volumeUsd / totalVolumeUsd) * 100).toFixed(2)) : 0 }))
            .sort((a, b) => b.volumeUsd - a.volumeUsd)
            .slice(0, 8);

        const exchangeVolume = {
            top: ranked,
            totalVolumeUsd: parseFloat(totalVolumeUsd.toFixed(2)),
            exchangeCount: byExchange.size,
            source: 'CoinGecko /coins/ripple/tickers',
            lastUpdated: new Date().toISOString()
        };
        await withDataFile(d => { d.exchangeVolume = exchangeVolume; });
        console.log(`Volumen por exchange: top ${ranked[0]?.name || '--'} (${ranked[0]?.pct ?? 0}%), ${byExchange.size} exchanges vistos.`);
    } catch (error) {
        console.error('Error obteniendo volumen por exchange:', error.message);
    }
}

async function fetchOrderFlowData() {
    try {
        const response = await fetchWithTimeout('https://data-api.binance.vision/api/v3/klines?symbol=XRPUSDT&interval=1h&limit=24');
        const klines = await response.json();
        
        if (klines && Array.isArray(klines) && klines.length > 0) {
            let totalBuyVolume = 0;
            let totalVolume = 0;
            let totalBuyValueUsd = 0;
            let totalValueUsd = 0;

            klines.forEach(candle => {
                // [5] = Volume (XRP), [7] = Quote Volume (USDT/USD)
                // [9] = Taker buy base volume (XRP), [10] = Taker buy quote volume (USDT/USD)
                totalVolume += parseFloat(candle[5]);
                totalBuyVolume += parseFloat(candle[9]);
                totalValueUsd += parseFloat(candle[7]);
                totalBuyValueUsd += parseFloat(candle[10]);
            });

            const sellVolume = totalVolume - totalBuyVolume;
            const sellValueUsd = totalValueUsd - totalBuyValueUsd;
            const buyPercent = (totalBuyVolume / totalVolume) * 100;
            const sellPercent = (sellVolume / totalVolume) * 100;

            const rawData = fs.readFileSync(DATA_FILE, 'utf8');
            const data = JSON.parse(rawData);
            
            const orderFlow = {
                buyVolume: totalBuyVolume,
                sellVolume: sellVolume,
                totalVolume: totalVolume,
                buyValueUsd: totalBuyValueUsd,
                sellValueUsd: sellValueUsd,
                totalValueUsd: totalValueUsd,
                buyPercent: parseFloat(buyPercent.toFixed(2)),
                sellPercent: parseFloat(sellPercent.toFixed(2)),
                timeWindow: "Últimas 24 horas",
                lastUpdated: new Date().toISOString()
            };
            await withDataFile(d => { d.orderFlow = orderFlow; });
            console.log('Datos de Order Flow (24h con Valores USD) integrados en data.json');
        }
    } catch (error) {
        console.error('Error sincronizando order flow con Binance:', error);
    }
}

// ============================================================
// ESCROW REAL DESDE EL XRPL (roadmap #3, v2.2)
// Sustituye la tabla mensual hardcodeada (se quedaba obsoleta cada mes) por una
// lectura on-chain: descubre las cuentas de escrow de Ripple ("Ripple 1".."Ripple 55"
// en la lista well-known de XRPScan, ya usada para las wallets del Whale Tracker) y
// consulta account_objects type=escrow de cada una vía xrplcluster.com (JSON-RPC,
// verificado accesible — ver CLAUDE.md). Cualquier objeto Escrow devuelto está POR
// DEFINICIÓN todavía bloqueado (el XRPL borra el ledger entry al hacer EscrowFinish/
// EscrowCancel), así que sumar Amount de todas las cuentas da el total real restante.
// ============================================================

let _rippleEscrowAccountsCache = null;
let _rippleEscrowAccountsCacheTime = 0;
const RIPPLE_ESCROW_ACCOUNTS_CACHE_MS = 24 * 60 * 60 * 1000; // 24h: la lista casi no cambia

async function discoverRippleEscrowAccounts() {
    const now = Date.now();
    if (_rippleEscrowAccountsCache && (now - _rippleEscrowAccountsCacheTime) < RIPPLE_ESCROW_ACCOUNTS_CACHE_MS) {
        return _rippleEscrowAccountsCache;
    }
    const resp = await fetchWithTimeout('https://api.xrpscan.com/api/v1/names/well-known');
    if (!resp.ok) throw new Error(`well-known HTTP ${resp.status}`);
    const list = await resp.json();
    if (!Array.isArray(list)) throw new Error('well-known no devolvió un array');
    // Las cuentas de escrow de Ripple aparecen como {name:"Ripple", desc:"9"|"22"|...}
    // (mismo esquema que XRPScan usa para "Binance 1", "Binance 2", etc.)
    const accounts = list
        .filter(x => x && x.account && String(x.name).trim() === 'Ripple' && /^\d+$/.test(String(x.desc || '')))
        .map(x => x.account);
    if (accounts.length > 0) {
        _rippleEscrowAccountsCache = accounts;
        _rippleEscrowAccountsCacheTime = now;
    }
    return accounts;
}

// account_objects type=escrow para una cuenta, vía XRPL JSON-RPC (xrplcluster.com)
async function fetchAccountEscrowObjects(account) {
    const resp = await fetchWithTimeout('https://xrplcluster.com/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            method: 'account_objects',
            params: [{ account, type: 'escrow', ledger_index: 'validated', limit: 200 }]
        })
    });
    if (!resp.ok) throw new Error(`xrplcluster HTTP ${resp.status}`);
    const j = await resp.json();
    if (j.result && Array.isArray(j.result.account_objects)) {
        return j.result.account_objects.filter(o => o.LedgerEntryType === 'Escrow');
    }
    return [];
}

const RIPPLE_EPOCH_OFFSET_S = 946684800; // 2000-01-01T00:00:00Z, epoch usado por FinishAfter/CancelAfter

// Lee on-chain el total real bloqueado en escrow y las próximas liberaciones.
async function fetchEscrowOnChainData() {
    try {
        const accounts = await discoverRippleEscrowAccounts();
        if (!accounts.length) {
            console.warn('Escrow on-chain: no se pudo descubrir la lista de cuentas de Ripple (well-known); se conserva el nodo previo.');
            return;
        }
        let totalDrops = 0;
        let activeEscrows = 0;
        const seenIndex = new Set();
        const upcoming = [];
        for (const account of accounts) {
            try {
                const objs = await fetchAccountEscrowObjects(account);
                for (const o of objs) {
                    if (o.index && seenIndex.has(o.index)) continue;
                    if (o.index) seenIndex.add(o.index);
                    const amt = typeof o.Amount === 'string' ? parseFloat(o.Amount) : parseFloat((o.Amount && o.Amount.value) || 0);
                    if (!isFinite(amt) || amt <= 0) continue;
                    totalDrops += amt;
                    activeEscrows++;
                    if (typeof o.FinishAfter === 'number') {
                        upcoming.push({
                            account,
                            amountXrp: parseFloat((amt / 1e6).toFixed(2)),
                            finishAfter: new Date((o.FinishAfter + RIPPLE_EPOCH_OFFSET_S) * 1000).toISOString()
                        });
                    }
                }
            } catch (accErr) {
                console.warn(`Escrow on-chain: fallo consultando ${account}:`, accErr.message);
            }
            // Anti-rate-limit: xrplcluster.com es público y compartido.
            await new Promise(r => setTimeout(r, 120));
        }
        upcoming.sort((a, b) => new Date(a.finishAfter) - new Date(b.finishAfter));
        const totalXrp = totalDrops / 1e6;

        const escrowOnChain = {
            totalRemainingXrp: parseFloat(totalXrp.toFixed(2)),
            totalRemainingB: parseFloat((totalXrp / 1e9).toFixed(3)),
            accountsScanned: accounts.length,
            activeEscrows,
            nextRelease: upcoming[0] || null,
            upcoming: upcoming.slice(0, 5),
            source: 'XRPL on-chain (account_objects type=escrow, xrplcluster.com)',
            lastUpdated: new Date().toISOString()
        };
        await withDataFile(d => { d.escrowOnChain = escrowOnChain; });
        console.log(`Escrow real leído on-chain: ${totalXrp.toLocaleString('en-US', { maximumFractionDigits: 0 })} XRP en ${activeEscrows} escrows activos (${accounts.length} cuentas escaneadas)`);
    } catch (error) {
        console.error('Error leyendo escrow on-chain:', error.message);
    }
}

// Actualizar información de eventos (Ej. Escrow de Ripple)
async function updateEvents() {
    try {
        const rawData = fs.readFileSync(DATA_FILE, 'utf8');
        const data = JSON.parse(rawData);

        // Calcular días hasta el primer día del próximo mes
        const now = new Date();
        const currentYear = now.getFullYear();
        const currentMonth = now.getMonth();
        // El mes siguiente (si currentMonth es 11, js ajusta el año a +1 y mes a 0 automáticamente para January)
        const firstOfNextMonth = new Date(currentYear, currentMonth + 1, 1);

        const diffTime = Math.abs(firstOfNextMonth - now);
        const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));

        const previousMonth = new Date(currentYear, currentMonth - 1, 1);
        const prevMonthName = previousMonth.toLocaleString('es-ES', { month: 'long', year: 'numeric' });

        // V2.2: el total restante en escrow ya NO sale de una tabla hardcodeada — viene
        // de escrowOnChain (lectura real del XRPL, ver fetchEscrowOnChainData arriba).
        // El desglose liberado/devuelto/neto del ciclo anterior SÍ sigue siendo una
        // aproximación típica (1000/800/200 XRP) hasta que history.json (roadmap #6)
        // permita calcular el delta real mes a mes; se marca "estimated" para la UI.
        const onChain = data.escrowOnChain;
        const hasOnChain = onChain && typeof onChain.totalRemainingB === 'number';
        const typicalReturned = 800;
        const remainingEscrowB = hasOnChain ? onChain.totalRemainingB : 33.5;

        // V2.4 i18n: nombre del mes también en inglés para el frontend bilingüe
        const prevMonthNameEn = previousMonth.toLocaleString('en-US', { month: 'long', year: 'numeric' });

        const events = {
            daysUntilEscrow: diffDays,
            escorowNote: "Próxima liberación programada: 1B XRP",
            escorowNoteEn: "Next scheduled release: 1B XRP",
            previousCycle: {
                month: prevMonthName.charAt(0).toUpperCase() + prevMonthName.slice(1),
                monthEn: prevMonthNameEn,
                released: 1000,
                returned: typicalReturned,
                net: 1000 - typicalReturned,
                remainingEscrow: remainingEscrowB,
                remainingEscrowSource: hasOnChain ? 'on-chain (XRPL)' : 'fallback',
                remainingEscrowUpdated: hasOnChain ? onChain.lastUpdated : null,
                // El TOTAL restante (remainingEscrow) es real on-chain cuando hasOnChain=true.
                // El desglose liberado/devuelto/neto sigue siendo una aproximación típica
                // (1000/800/200 XRP) hasta que history.json (roadmap #6) permita calcular
                // el delta real mes a mes — por eso "estimated" se mantiene true para que
                // la UI siga marcando ese desglose como "≈ típico" y no lo presente como real.
                estimated: true
            },
            lastUpdated: new Date().toISOString()
        };
        await withDataFile(d => { d.events = events; });
        console.log('Datos de Eventos actualizados en data.json');
    } catch (error) {
        console.error('Error calculando actualización de eventos:', error);
    }
}

// Calcular Proyecciones y Escenarios
async function calculateProjections() {
    try {
        const rawData = fs.readFileSync(DATA_FILE, 'utf8');
        const data = JSON.parse(rawData);
        
        if (data.marketData && data.marketData.price && data.technicals && data.technicals.support) {
            const currentPrice = data.marketData.price;
            const support = data.technicals.support;
            const resistance = data.technicals.resistance;
            
            // Simulación de Escenarios
            const escenarioBajista = Math.min(currentPrice * 0.85, support);
            const escenarioNeutral = currentPrice * 1.05; // Solo guardamos límite superior aproximativo
            const escenarioAlcista = Math.max(currentPrice * 1.20, resistance);
            
            const projections = {
                bajista: {
                    price: parseFloat(escenarioBajista.toFixed(4)),
                    description: "Caída del 15% o toque de soporte",
                    descriptionEn: "15% drop or support touch"
                },
                neutral: {
                    price: parseFloat(currentPrice.toFixed(4)),
                    description: "Fluctuación lateral del +/- 5%",
                    descriptionEn: "Sideways range of +/- 5%"
                },
                alcista: {
                    price: parseFloat(escenarioAlcista.toFixed(4)),
                    description: "Subida del 20% o ruptura de resistencia",
                    descriptionEn: "20% rise or resistance breakout"
                },
                lastUpdated: new Date().toISOString()
            };
            await withDataFile(d => { d.projections = projections; });
            console.log('Proyecciones calculadas en data.json');
        }
    } catch (error) {
        console.error('Error calculando proyecciones:', error);
    }
}

// Obtener Noticias de XRP y mercado influyente (BTC, ETH, Regulaciones)
async function fetchNewsData() {
    try {
        let newsItems = [];
        const fifteenDaysAgo = new Date();
        fifteenDaysAgo.setDate(fifteenDaysAgo.getDate() - 15);
        
        // Cargar noticias existentes para caché
        let newsCache = new Map();
        try {
            if (fs.existsSync(DATA_FILE)) {
                const currentData = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
                if (Array.isArray(currentData.newsFeed)) {
                    currentData.newsFeed.forEach(n => {
                        if (n.url) newsCache.set(n.url, n);
                    });
                }
            }
        } catch (cacheErr) {
            console.error('Error cargando caché de noticias:', cacheErr.message);
        }
        
        // V2.0: clasificador de relevancia — un dashboard de XRP debe priorizar noticias
        // de XRP/Ripple; lo demás se marca como "contexto macro" (la UI lo etiqueta).
        const isXrpRelated = (item) => /xrp|ripple|rlusd|xrpl/i.test(`${item.title || ''} ${item.description || ''}`);

        try {
            // Intento con CryptoPanic — SOLO XRP como primario (antes XRP,BTC,ETH y el
            // feed acababa dominado por titulares de Bitcoin).
            if (!CRYPTOPANIC_TOKEN) throw new Error('CRYPTOPANIC_TOKEN no configurado en .env, usando fallback RSS');
            const response = await fetchWithTimeout(`https://cryptopanic.com/api/v1/posts/?auth_token=${CRYPTOPANIC_TOKEN}&currencies=XRP&kind=news`);
            const apiData = await response.json();

            if (apiData && apiData.results && apiData.results.length > 0) {
                // Filtrar noticias de los últimos 15 días y mapear
                newsItems = apiData.results
                    .filter(item => new Date(item.published_at) >= fifteenDaysAgo)
                    .slice(0, 6)
                    .map(item => ({
                        title: item.title,
                        url: item.url,
                        published_at: item.published_at,
                        description: item.votes ? `Relevancia: ${item.votes.positive || 0} 👍` : ''
                    }));
            }
            if (newsItems.length === 0) throw new Error('CryptoPanic sin resultados de XRP, usando fallback RSS');
        } catch (cpError) {
            console.error('CryptoPanic falló, usando fallback RSS multicapa...');
            try {
                // Ripple primero (fuente principal); BTC/regulación solo como contexto macro
                const rssUrls = [
                    'https://cointelegraph.com/rss/tag/ripple',
                    'https://cointelegraph.com/rss/tag/bitcoin',
                    'https://cointelegraph.com/rss/tag/regulation'
                ];

                for (const url of rssUrls) {
                    const fallbackResponse = await fetchWithTimeout(`https://api.rss2json.com/v1/api.json?rss_url=${url}`);
                    const fallbackData = await fallbackResponse.json();
                    if (fallbackData && fallbackData.items) {
                        const mapped = fallbackData.items
                            .filter(item => new Date(item.pubDate) >= fifteenDaysAgo)
                            .map(item => ({
                                title: item.title || 'Noticia de Mercado',
                                url: item.link || '#',
                                published_at: item.pubDate || new Date().toISOString(),
                                description: item.content ? item.content.substring(0, 100) + '...' : ''
                            }));
                        newsItems = [...newsItems, ...mapped];
                    }
                }
                // V2.0: primero las de XRP/Ripple (por fecha), después el contexto macro.
                // Dedupe por TÍTULO normalizado: la misma noticia llega con URLs distintas
                // (parámetros de tracking) y aparecía duplicada en el feed.
                const dedup = Array.from(new Map(newsItems.map(n => [String(n.title || '').toLowerCase().trim(), n])).values());
                const xrpNews = dedup.filter(isXrpRelated).sort((a, b) => new Date(b.published_at) - new Date(a.published_at));
                const macroNews = dedup.filter(n => !isXrpRelated(n)).sort((a, b) => new Date(b.published_at) - new Date(a.published_at));
                newsItems = [...xrpNews, ...macroNews].slice(0, 6);

            } catch (fallbackError) {
                console.error('El fallback RSS también falló:', fallbackError.message);
                newsItems = [];
            }
        }

        // Etiquetar relevancia para que la UI distinga XRP directo vs contexto macro
        // (+ dedupe por título también en la ruta de CryptoPanic)
        newsItems = Array.from(new Map(newsItems.map(n => [String(n.title || '').toLowerCase().trim(), n])).values())
            .map(n => ({ ...n, xrpRelated: isXrpRelated(n) }));
        
        if (newsItems.length > 0) {
            console.log('--- Analizando noticias con Inteligencia Artificial (OpenAI) ---');
            
            const enrichedNews = await Promise.all(newsItems.map(async (item) => {
                // Verificar caché
                const cached = newsCache.get(item.url);
                if (cached && cached.summary_es && cached.impact_analysis && cached.sentiment) {
                    console.log(`Reutilizando caché de IA para noticia: ${item.title}`);
                    return {
                        ...item,
                        summary_es: cached.summary_es,
                        impact_analysis: cached.impact_analysis,
                        sentiment: cached.sentiment
                    };
                }

                try {
                    if (!openai) throw new Error('Sin OPENAI_API_KEY: se usa análisis heurístico local');
                    const prompt = `Analiza esta noticia para un inversor de XRP y genera un JSON en ESPAÑOL:
{
  "summary_es": "Resumen ejecutivo en español, sin términos en inglés si es posible (max 2 líneas).",
  "impact_analysis": "Explicación educativa de POR QUÉ afecta a XRP. Analiza correlación con BTC, efectos legales de Ripple o psicología del mercado (max 5 líneas).",
  "sentiment": "POSITIVO", "NEGATIVO" o "NEUTRO"
}

Título: ${item.title}
Descripción: ${item.description || "Sin descripción"}`;

                    const completion = await openai.chat.completions.create({
                        model: "gpt-4o-mini",
                        messages: [
                            { role: "system", content: "Eres un analista financiero de ÉLITE especializado en XRP. Tu misión es educar al usuario. Escribes exclusivamente en ESPAÑOL NEUTRO." },
                            { role: "user", content: prompt }
                        ],
                        response_format: { type: "json_object" }
                    });

                    const aiResult = JSON.parse(completion.choices[0].message.content);
                    return {
                        ...item,
                        summary_es: aiResult.summary_es,
                        impact_analysis: aiResult.impact_analysis,
                        sentiment: aiResult.sentiment
                    };
                } catch (aiError) {
                    console.error('Error al analizar noticia con OpenAI:', aiError.message);
                    // Fallback a lógica básica si OpenAI falla
                    const text = (item.title + " " + (item.description || "")).toLowerCase();
                    const isNeg = ["bearish", "crash", "lawsuit", "sec", "drop", "hack", "dump", "investigation", "fines", "bajista", "cae"].some(k => text.includes(k));
                    return {
                        ...item,
                        summary_es: `Análisis temporal: ${item.title}`,
                        impact_analysis: isNeg ? "Alerta de riesgo detectada. Posible presión bajista por correlación o temor regulatorio." : "Evento de mercado estándar. Se recomienda monitorear niveles de soporte.",
                        sentiment: isNeg ? "NEGATIVO" : "NEUTRO"
                    };
                }
            }));

            await withDataFile(d => { d.newsFeed = enrichedNews; });
            console.log('Datos de Noticias enriquecidos con IA REAL en data.json');
        }
    } catch (error) {
        console.error('Error sincronizando noticias de impacto en XRP:', error);
    }
}

// Descubre wallets reales de exchanges/Ripple desde la lista pública "well-known" de XRPScan.
// MOTIVO: 5 de las 6 direcciones hardcodeadas originales eran INVÁLIDAS (404 Invalid address),
// por lo que el Whale Tracker vivía permanentemente de datos mock.
let wellKnownLoaded = false;
async function refreshTrackedWalletsFromWellKnown() {
    if (wellKnownLoaded) return;
    try {
        const resp = await fetchWithTimeout('https://api.xrpscan.com/api/v1/names/well-known');
        if (!resp.ok) return;
        const list = await resp.json();
        if (!Array.isArray(list) || list.length === 0) return;

        const norm = (s) => String(s || '').toLowerCase();
        // V2.0: preferir cuentas VERIFICADAS de la lista well-known y aceptar variantes
        // del nombre ("Binance", "Binance 3", "Binance cold"...) en lugar de igualdad exacta.
        const pick = (name, label, type, max = 1) => list
            .filter(x => x && x.account && norm(x.name).startsWith(name))
            .sort((a, b) => (b.verified === true) - (a.verified === true))
            .slice(0, max)
            .map((x, i) => ({ address: x.account, label: max > 1 ? `${label} ${x.desc || (i + 1)}` : label, type, verified: x.verified === true }));

        const candidates = [
            ...pick('binance', 'Binance', 'exchange', 2),
            ...pick('upbit', 'Upbit', 'exchange', 1),
            ...pick('bithumb', 'Bithumb', 'exchange', 1),
            ...pick('kraken', 'Kraken', 'exchange', 1),
            ...pick('ripple', 'Ripple', 'whale', 2)
        ];
        if (candidates.length < 3) return; // lista sospechosa: mantener wallets actuales

        // Wallet de muestra con actividad garantizada (única válida del set original)
        candidates.push({ address: 'rDsbeomae4FXwgQTJp9Rs64Qg9vDiTCdBv', label: 'XRPScan Sample Whale', type: 'whale' });

        await withDataFile(d => {
            d.whaleTracker = d.whaleTracker || {};
            d.whaleTracker.trackedWallets = candidates;
            // Las transferencias previas venían de wallets inválidas o mocks: limpiar
            d.whaleTracker.largeTransfers = [];
        });
        wellKnownLoaded = true;
        console.log(`Whale Tracker: ${candidates.length} wallets REALES cargadas desde XRPScan well-known.`);
    } catch (e) {
        console.warn('No se pudo cargar well-known wallets, se mantienen las actuales:', e.message);
    }
}

// Consulta datos de ballenas (Whale Tracker) de forma real
async function fetchWhaleData() {
    try {
        console.log('--- Iniciando Sincronización Whale Tracker (XRPSCAN) ---');
        const rawData = fs.readFileSync(DATA_FILE, 'utf8');
        const data = JSON.parse(rawData);

        // Asegurar que la estructura existe
        if (!data.whaleTracker) {
            data.whaleTracker = {
                summary: { largeTransfers24h: 0, totalVolume24h: 0, exchangeFlowNet: 0, lastUpdated: "" },
                largeTransfers: [],
                trackedWallets: MONITORED_WALLETS,
                walletHistory: [],
                walletHistoryCache: {}
            };
        }

        // Resiliencia: si data.json viene de una versión previa sin trackedWallets, sembrarlas
        if (!Array.isArray(data.whaleTracker.trackedWallets) || data.whaleTracker.trackedWallets.length === 0) {
            data.whaleTracker.trackedWallets = MONITORED_WALLETS.map(w => ({ ...w }));
        }

        // V2.2 (roadmap #9): umbral configurable desde la UI sin tocar código —
        // se guarda en data.json (whaleTracker.threshold) vía POST /api/whale-threshold.
        // Fallback al valor por defecto si nunca se configuró o es inválido.
        const threshold = (typeof data.whaleTracker.threshold === 'number' && data.whaleTracker.threshold > 0)
            ? data.whaleTracker.threshold
            : WHALE_THRESHOLD;

        let allLargeTxs = [];
        let totalVolume = 0;
        let exchangeIn = 0;
        let exchangeOut = 0;

        // 1. Actualizar info y txs de wallets monitoreadas
        for (const wallet of data.whaleTracker.trackedWallets) {
            try {
                // Obtener balance y info básica
                const accResp = await fetchWithTimeout(`https://api.xrpscan.com/api/v1/account/${wallet.address}`);
                if (accResp.ok) {
                    const accInfo = await accResp.json();
                    wallet.balance = accInfo.xrpBalance ? parseFloat(accInfo.xrpBalance) : (accInfo.balance ? parseFloat(accInfo.balance) : 0);
                    // La API respondió: esta wallet ya no es mock, limpiar la etiqueta heredada del seed
                    wallet.label = String(wallet.label || '').replace(' (MOCK)', '');
                }

                // Obtener transacciones recientes
                const txResp = await fetchWithTimeout(`https://api.xrpscan.com/api/v1/account/${wallet.address}/transactions`);
                if (txResp.ok) {
                    const txs = await txResp.json();
                    const list = Array.isArray(txs) ? txs : (txs.transactions || []);
                    // Filtrar por umbral de ballena (amountToXrp normaliza drops → XRP)
                    const whaleTxs = list.filter(tx => {
                        const amount = amountToXrp(tx.Amount);
                        return amount >= threshold;
                    }).map(tx => {
                        const amount = amountToXrp(tx.Amount);
                        const isOut = tx.Account === wallet.address;
                        
                        // Track flow for summary
                        if (wallet.type === 'exchange') {
                            if (isOut) exchangeOut += amount;
                            else exchangeIn += amount;
                        }
                        totalVolume += amount;

                        return {
                            hash: tx.hash,
                            from: tx.Account,
                            to: tx.Destination || "Multi-Sig / Escrow",
                            amount: amount,
                            timestamp: tx.date || tx.Timestamp || new Date().toISOString(),
                            type: tx.TransactionType,
                            walletLabel: wallet.label
                        };
                    });

                    allLargeTxs = [...allLargeTxs, ...whaleTxs];
                }
                // Pequeño delay para no saturar
                await new Promise(r => setTimeout(r, 200));
            } catch (err) {
                console.error(`Error procesando wallet ${wallet.label}:`, err.message);
            }
        }

        // 2. Limpiar duplicados (txs entre dos wallets monitoreadas) y ordenar
        const uniqueTxs = Array.from(new Map(allLargeTxs.map(tx => [tx.hash, tx])).values());
        
        // PROTECCIÓN: Solo actualizar si obtuvimos datos reales. 
        // Si allLargeTxs está vacío después de recorrer todo, puede ser un fallo masivo de API o red.
        // En ese caso, conservamos lo que había (Mocks o data anterior válida).
        if (uniqueTxs.length === 0 && data.whaleTracker.largeTransfers.length > 0) {
            console.warn('Whale Tracker: No se detectaron nuevas txs, conservando data previa/mock.');
            return;
        }

        uniqueTxs.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

        // 3. Actualizar Summary — BUGFIX: los KPIs dicen "24h" pero antes sumaban TODO el
        // historial reciente que devolviera la API. Ahora el summary se calcula solo con
        // transacciones de las últimas 24 horas reales.
        const cutoff24h = Date.now() - 24 * 3600 * 1000;
        const txs24h = uniqueTxs.filter(t => {
            const ts = new Date(t.timestamp).getTime();
            return !isNaN(ts) && ts >= cutoff24h;
        });
        const isExchange = (addr) => data.whaleTracker.trackedWallets.some(w => w.address === addr && w.type === 'exchange');
        let in24 = 0, out24 = 0;
        txs24h.forEach(t => {
            if (isExchange(t.to)) in24 += t.amount;
            if (isExchange(t.from)) out24 += t.amount;
        });

        // V2.1: conservar las transferencias ya almacenadas ANTES de reemplazarlas —
        // alimentan el log histórico de flujo (si no, cada reinicio perdería días de datos).
        const prevStoredTxs = Array.isArray(data.whaleTracker.largeTransfers) ? data.whaleTracker.largeTransfers : [];

        data.whaleTracker.largeTransfers = uniqueTxs.slice(0, 50);
        data.whaleTracker.summary = {
            largeTransfers24h: txs24h.length,
            totalVolume24h: txs24h.reduce((s, t) => s + t.amount, 0),
            exchangeFlowNet: in24 - out24,
            threshold: threshold, // V2.2: umbral efectivamente usado este ciclo (roadmap #9)
            lastUpdated: new Date().toISOString()
        };

        // ===== V2.1: LÍNEA DE TIEMPO DEL FLUJO (24h horaria / 7d diaria) =====
        // Los ~25 txs por wallet que da XRPScan son una foto; para contar la HISTORIA
        // del flujo se persiste un log rodante de eventos (7 días, dedupe por hash)
        // que crece ciclo a ciclo — mismo patrón que los buckets del burn watcher.
        const classifyDir = (tx) => {
            const toEx = isExchange(tx.to);
            const fromEx = isExchange(tx.from);
            if (toEx && !fromEx) return 'in';    // entra a exchange (oferta de venta)
            if (fromEx && !toEx) return 'out';   // sale de exchange (acumulación)
            return 'w2w';                        // entre ballenas / entre exchanges (neutro)
        };
        const cutoff7d = Date.now() - 7 * 24 * 3600 * 1000;
        const prevEvents = Array.isArray(data.whaleTracker.flowEvents) ? data.whaleTracker.flowEvents : [];
        const seenHashes = new Set(prevEvents.map(e => e.hash));
        // Unión de lo recién bajado + lo que ya estaba almacenado (dedupe por hash)
        const txPool = Array.from(new Map([...prevStoredTxs, ...uniqueTxs].map(t => [t.hash, t])).values());
        const freshEvents = txPool
            .filter(t => t.hash && !String(t.hash).startsWith('MOCK') && !seenHashes.has(t.hash))
            .map(t => ({ hash: t.hash, ts: new Date(t.timestamp).getTime(), dir: classifyDir(t), amount: t.amount }))
            .filter(e => isFinite(e.ts) && e.amount > 0 && e.amount <= 2e9);
        let flowEvents = [...prevEvents, ...freshEvents]
            .filter(e => e && isFinite(e.ts) && e.ts >= cutoff7d && e.amount > 0 && e.amount <= 2e9)
            .sort((a, b) => a.ts - b.ts);
        if (flowEvents.length > 3000) flowEvents = flowEvents.slice(-3000);

        // Buckets: 24 horarios y 7 diarios (alineados a hora/día UTC por floor del timestamp)
        const bucketize = (events, sizeMs, count) => {
            const now = Date.now();
            const startOfCurrent = Math.floor(now / sizeMs) * sizeMs;
            const buckets = [];
            for (let i = count - 1; i >= 0; i--) {
                const bStart = startOfCurrent - i * sizeMs;
                buckets.push({ start: bStart, inXrp: 0, outXrp: 0, w2wXrp: 0, txCount: 0 });
            }
            const first = buckets[0].start;
            for (const e of events) {
                if (e.ts < first) continue;
                const idx = Math.min(Math.floor((e.ts - first) / sizeMs), count - 1);
                const b = buckets[idx];
                if (!b) continue;
                if (e.dir === 'in') b.inXrp += e.amount;
                else if (e.dir === 'out') b.outXrp += e.amount;
                else b.w2wXrp += e.amount;
                b.txCount++;
            }
            return buckets;
        };
        const totalsIn = (events, sinceTs) => {
            const t = { inXrp: 0, outXrp: 0, w2wXrp: 0, txCount: 0 };
            for (const e of events) {
                if (e.ts < sinceTs) continue;
                if (e.dir === 'in') t.inXrp += e.amount;
                else if (e.dir === 'out') t.outXrp += e.amount;
                else t.w2wXrp += e.amount;
                t.txCount++;
            }
            t.netXrp = t.inXrp - t.outXrp; // positivo = entra a exchanges (bajista)
            return t;
        };

        data.whaleTracker.flowEvents = flowEvents;
        data.whaleTracker.flowTimeline = {
            hourly: bucketize(flowEvents, 3600 * 1000, 24),
            daily: bucketize(flowEvents, 24 * 3600 * 1000, 7),
            totals24h: totalsIn(flowEvents, Date.now() - 24 * 3600 * 1000),
            totals7d: totalsIn(flowEvents, cutoff7d),
            oldestEventTs: flowEvents.length ? flowEvents[0].ts : null,
            demo: flowEvents.length === 0 && uniqueTxs.some(t => String(t.hash || '').startsWith('MOCK')),
            lastUpdated: new Date().toISOString()
        };

        // V2.0: merge sobre estado fresco preservando el caché de historiales que otro
        // endpoint pudiera haber escrito mientras este fetch (lento) estaba en curso.
        await withDataFile(d => {
            const freshCache = (d.whaleTracker && d.whaleTracker.walletHistoryCache) || {};
            d.whaleTracker = data.whaleTracker;
            d.whaleTracker.walletHistoryCache = { ...(data.whaleTracker.walletHistoryCache || {}), ...freshCache };
        });
        console.log(`Whale Tracker REAL: ${uniqueTxs.length} txs grandes (${txs24h.length} en 24h). Flujo Exchange 24h: ${(in24 - out24).toFixed(0)} XRP.`);
    } catch (error) {
        console.error('Error crítico en Whale Tracker:', error);
    }
}



// --- SUPPLY DISTRIBUTION LOGIC ---
async function fetchSupplyDistributionData() {
    try {
        console.log('--- Sincronizando Supply Distribution (XRPL Metrics) ---');
        const rawData = fs.readFileSync(DATA_FILE, 'utf8');
        const data = JSON.parse(rawData);

        // V2.0: el endpoint /api/v1/network/metrics de XRPScan devuelve 404 (verificado
        // el 2026-07-03) — el fallback constante se usaba SIEMPRE. Ahora el total real
        // viene de onChainData.totalCoins (ledger en vivo) o del burn watcher.
        let totalCoins = 99987000000;
        if (data.onChainData && data.onChainData.totalCoins > 90e9) {
            totalCoins = data.onChainData.totalCoins;
        } else if (burnWatcherSnapshot && burnWatcherSnapshot.lastTotalCoins > 90e9) {
            totalCoins = burnWatcherSnapshot.lastTotalCoins;
        }

        const maxSupply = 100000000000;
        const currentTotal = totalCoins;
        // CONSISTENCIA: antes se usaba 39.8B hardcodeado, contradiciendo el módulo de
        // Eventos (~33.6B). Ahora se deriva del último ciclo de escrow conocido si existe
        // (v2.2: ese ciclo a su vez viene de escrowOnChain, lectura real del XRPL — ver
        // fetchEscrowOnChainData — así Suministro y la tarjeta Escrow del tab Mercado
        // muestran siempre el mismo total on-chain).
        let escrowSupply = 35500000000; // fallback conservador
        let escrowIsOnChain = false;
        if (data.events && data.events.previousCycle && data.events.previousCycle.remainingEscrow > 0) {
            escrowSupply = data.events.previousCycle.remainingEscrow * 1e9; // viene en miles de millones
            escrowIsOnChain = data.events.previousCycle.remainingEscrowSource === 'on-chain (XRPL)';
        }
        const circulatingSupply = currentTotal - escrowSupply;
        
        const exchangeSupply = circulatingSupply * 0.12;
        const whaleSupply = circulatingSupply * 0.65;
        const freeFloat = circulatingSupply - exchangeSupply - whaleSupply;

        const supplyDistribution = {
            maxSupply: maxSupply,
            circulatingSupply: circulatingSupply,
            circulatingPercent: (circulatingSupply / maxSupply) * 100,
            escrowSupply: escrowSupply,
            escrowPercent: (escrowSupply / maxSupply) * 100,
            exchangeSupply: exchangeSupply,
            exchangePercent: (exchangeSupply / maxSupply) * 100,
            whaleSupply: whaleSupply,
            whalePercent: (whaleSupply / maxSupply) * 100,
            freeFloatEstimate: freeFloat,
            freeFloatPercent: (freeFloat / maxSupply) * 100,
            totalBurned: maxSupply - currentTotal,
            estimatedFields: escrowIsOnChain
                ? ["exchangeSupply", "whaleSupply", "freeFloatEstimate"]
                : ["exchangeSupply", "whaleSupply", "freeFloatEstimate", "escrowSupply"],
            lastUpdated: new Date().toISOString()
        };

        await withDataFile(d => { d.supplyDistribution = supplyDistribution; });
        console.log('Supply Distribution actualizado.');
    } catch (error) { console.error('Error en Distribution:', error); }
}

// --- BURN IMPACT LOGIC ---
async function fetchBurnImpactData() {
    try {
        console.log('--- Sincronizando Burn Impact (XRPL Trends) ---');
        const rawData = fs.readFileSync(DATA_FILE, 'utf8');
        const data = JSON.parse(rawData);

        let totalCoins = 99987000000;
        // Si el watcher tiene datos reales, usamos su dailyAvgBurn; si no, fallback estimado
        let dailyBurn = (burnWatcherSnapshot && burnWatcherSnapshot.dailyAvgBurn > 0)
            ? burnWatcherSnapshot.dailyAvgBurn
            : 2450;
        const burnIsReal = !!(burnWatcherSnapshot && burnWatcherSnapshot.dailyAvgBurn > 0);

        // Cobertura real: cuántas de las últimas 24 horas tienen quema MEDIDA (no sembrada).
        // Permite a la UI distinguir "Real (24h)" de "Extrapolado de Nh de datos".
        let realCoverageHours = 0;
        if (burnWatcherSnapshot && Array.isArray(burnWatcherSnapshot.hourly)) {
            const since24 = Date.now() - 24 * 3600 * 1000;
            realCoverageHours = burnWatcherSnapshot.hourly
                .filter(b => !b.seeded && new Date(b.hourStart).getTime() >= since24).length;
        }

        // V2.0: /api/v1/network/metrics está muerto (404) — usar fuentes vivas:
        // el propio watcher (total_coins del XRPL en tiempo real) o el ledger de XRPScan.
        if (burnWatcherSnapshot && burnWatcherSnapshot.lastTotalCoins > 90e9) {
            totalCoins = burnWatcherSnapshot.lastTotalCoins;
        } else if (data.onChainData && data.onChainData.totalCoins > 90e9) {
            totalCoins = data.onChainData.totalCoins;
        }

        const currentBurned = 100000000000 - totalCoins;
        
        // --- Cálculo de Proyección de Agotamiento ---
        const calculateDepletion = (supplyBase, dailyBurnRate) => {
            if (!dailyBurnRate || dailyBurnRate <= 0) return { notComputable: true, reason: "Daily burn is zero or unavailable" };
            
            const daysToBurn = supplyBase / dailyBurnRate;
            const yearsToBurn = daysToBurn / 365;
            
            // Helper para formatear duraciones humanas (V2.4: bilingüe ES/EN)
            const formatDuration = (years, en = false) => {
                if (years < 1) return `${Math.round(years * 365)} ${en ? 'days' : 'días'}`;
                if (years < 100) return `${Math.round(years)} ${en ? 'years' : 'años'}`;
                if (years < 1000) return `${(years / 100).toFixed(1)} ${en ? 'centuries' : 'siglos'}`;
                if (years < 1000000) return `${Math.round(years / 1000).toLocaleString()} ${en ? 'millennia' : 'milenios'}`;
                return `${(years / 1000000).toFixed(2)} ${en ? 'million years' : 'millones de años'}`;
            };

            return {
                supplyBase: supplyBase,
                dailyBurn: dailyBurnRate,
                daysToBurn: daysToBurn,
                yearsToBurn: yearsToBurn,
                formattedDuration: formatDuration(yearsToBurn),
                formattedDurationEn: formatDuration(yearsToBurn, true),
                isTheoretical: true,
                isLinearProjection: true
            };
        };

        // Bases de suministro (aproximadas según data actual)
        const circulatingSupply = data.supplyDistribution ? data.supplyDistribution.circulatingSupply : 60187000000;
        
        const burnImpact = {
            dailyBurn: dailyBurn,
            dailyBurnEstimated: !burnIsReal,
            realCoverageHours: realCoverageHours,
            totalBurned: currentBurned,
            burnRateTrend: burnIsReal ? "Medido en vivo del XRPL" : "Promedio histórico estimado",
            burnRateTrendEn: burnIsReal ? "Measured live from the XRPL" : "Estimated historical average",
            supplyImpactProjections: [
                { period: "30 Días", periodEn: "30 Days", burned: dailyBurn * 30 },
                { period: "90 Días", periodEn: "90 Days", burned: dailyBurn * 90 },
                { period: "1 Año", periodEn: "1 Year", burned: dailyBurn * 365 },
                { period: "5 Años", periodEn: "5 Years", burned: dailyBurn * 365 * 5 },
                { period: "10 Años", periodEn: "10 Years", burned: dailyBurn * 365 * 10 }
            ],
            // "medium" refleja el ritmo actual real/estimado (antes era un 2450 fijo que
            // contradecía al KPI de Daily Burn Rate mostrado justo al lado)
            scenarioComparisons: { low: 1200, medium: Math.round(dailyBurn), high: 8500 },
            burnCompletionProjection: {
                basedOnMaxSupply: calculateDepletion(100000000000, dailyBurn),
                basedOnTotalSupply: calculateDepletion(totalCoins, dailyBurn),
                basedOnCirculatingSupply: calculateDepletion(circulatingSupply, dailyBurn)
            },
            estimatedFields: burnIsReal ? ["burnCompletionProjection"] : ["dailyBurn", "burnCompletionProjection"],
            lastUpdated: new Date().toISOString()
        };

        // V2.0: realtime SIEMPRE el más fresco (el watcher escribe ese subnodo cada ~30 s;
        // antes un merge desordenado dejaba dailyBurn y scenarios de ciclos distintos).
        await withDataFile(d => {
            const freshRealtime = (d.burnImpact && d.burnImpact.realtime) || null;
            d.burnImpact = burnImpact;
            d.burnImpact.realtime = burnWatcherSnapshot || freshRealtime;
        });
        console.log('Burn Impact (con proyecciones de agotamiento) actualizado.');
    } catch (error) { console.error('Error en Burn Impact:', error); }
}

// Genera historial falso para cuentas que no existen en la API o fallan
function generateMockHistory(address) {
    const types = ['Payment', 'OfferCreate', 'TrustSet'];
    return Array.from({ length: 15 }, (_, i) => {
        const isOut = Math.random() > 0.5;
        const from = isOut ? address : "rDsbeomae4FXwgQTJp9Rs64Qg9vDiTCdBv";
        const to = isOut ? "rEb8p7u3v4R8MmdM9mD5dz7tS8S5VjR69C" : address;
        
        // Determinar subtipo para mock
        const fromIsExchange = MONITORED_WALLETS.some(w => w.address === from && w.type === 'exchange');
        const toIsExchange = MONITORED_WALLETS.some(w => w.address === to && w.type === 'exchange');
        
        let subtype = 'Movimiento Interno';
        if (isOut && toIsExchange) subtype = 'Venta';
        else if (!isOut && fromIsExchange) subtype = 'Compra';

        return {
            hash: `MOCK_TX_${address}_${i}`,
            timestamp: new Date(Date.now() - i * 3600000 * 2).toISOString(),
            type: types[Math.floor(Math.random() * types.length)],
            from: from,
            to: to,
            amount: Math.floor(Math.random() * 500000) + 1000,
            direction: isOut ? 'OUT' : 'IN',
            subtype: subtype
        };
    });
}

// Obtener historial de una cuenta específica
async function fetchWalletHistory(address) {
    // PROTECCIÓN: Si no es una dirección válida de XRP (ej: "Unknown Whale"), devolver MOCK
    if (!address || !address.startsWith('r') || address.length < 25) {
        console.log(`Generando historial MOCK para dirección no válida: ${address}`);
        return generateMockHistory(address);
    }

    try {
        const response = await fetchWithTimeout(`https://api.xrpscan.com/api/v1/account/${address}/transactions`);
        
        // Si la API da 404 u otro error, devolver MOCK en lugar de error para que la UI no se rompa
        if (!response.ok) {
            console.warn(`API XRPScan respondió ${response.status} para ${address}. Usando fallback MOCK.`);
            return generateMockHistory(address);
        }
        
        const apiData = await response.json();
        const transactions = Array.isArray(apiData) ? apiData : (apiData.transactions || []);
        
        const rawData = fs.readFileSync(DATA_FILE, 'utf8');
        const data = JSON.parse(rawData);

        const history = transactions.slice(0, 50).map(tx => {
            const isOut = tx.Account === address;
            const from = tx.Account;
            const to = tx.Destination || tx.Account;
            
            // Determinar subtipo (Compra, Venta, Movimiento Interno)
            const fromIsExchange = MONITORED_WALLETS.some(w => w.address === from && w.type === 'exchange');
            const toIsExchange = MONITORED_WALLETS.some(w => w.address === to && w.type === 'exchange');
            
            let subtype = 'Movimiento Interno';
            if (isOut && toIsExchange) subtype = 'Venta';
            else if (!isOut && fromIsExchange) subtype = 'Compra';

            return {
                hash: tx.hash,
                timestamp: tx.date || tx.Timestamp,
                type: tx.TransactionType,
                from: from,
                to: to,
                amount: amountToXrp(tx.Amount),
                direction: isOut ? 'OUT' : 'IN',
                subtype: subtype
            };
        });

        // Actualizar cache (V2.0: escritura serializada para no pisar al ciclo de refresco)
        await withDataFile(d => {
            d.whaleTracker = d.whaleTracker || {};
            d.whaleTracker.walletHistory = history;
            d.whaleTracker.selectedWallet = address;
            d.whaleTracker.walletHistoryCache = d.whaleTracker.walletHistoryCache || {};
            d.whaleTracker.walletHistoryCache[address] = {
                data: history,
                timestamp: new Date().toISOString()
            };
        });
        return history;
    } catch (error) {
        console.error(`Error crítico consultando historial de ${address}, usando MOCK:`, error.message);
        return generateMockHistory(address);
    }
}

// ===== V2.0: SANEADO de datos whale heredados =====
// data.json puede arrastrar transferencias escritas por versiones previas SIN la
// normalización de drops (montos de billones de XRP, imposibles: el supply es 100B).
// La protección "conservar data previa si el fetch no trae nada" las perpetuaba.
// Esta migración descarta cualquier monto físicamente imposible y recalcula el summary.
function sanitizeWhaleData() {
    try {
        if (!fs.existsSync(DATA_FILE)) return;
        const data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
        const wt = data.whaleTracker;
        if (!wt || !Array.isArray(wt.largeTransfers)) return;

        const MAX_SANE = 2e9; // ningún pago real supera 2B XRP
        const before = wt.largeTransfers.length;
        const clean = wt.largeTransfers.filter(tx => tx && isFinite(tx.amount) && tx.amount > 0 && tx.amount <= MAX_SANE);
        const summaryBad = wt.summary && (wt.summary.totalVolume24h > 20e9 || !isFinite(wt.summary.totalVolume24h));

        if (clean.length === before && !summaryBad) return; // nada que sanear

        const cutoff24h = Date.now() - 24 * 3600 * 1000;
        const isExchange = (addr) => (wt.trackedWallets || []).some(w => w.address === addr && w.type === 'exchange');
        const txs24h = clean.filter(t => {
            const ts = new Date(t.timestamp).getTime();
            return !isNaN(ts) && ts >= cutoff24h;
        });
        let in24 = 0, out24 = 0;
        txs24h.forEach(t => {
            if (isExchange(t.to)) in24 += t.amount;
            if (isExchange(t.from)) out24 += t.amount;
        });

        wt.largeTransfers = clean;
        wt.summary = {
            largeTransfers24h: txs24h.length,
            totalVolume24h: txs24h.reduce((s, t) => s + t.amount, 0),
            exchangeFlowNet: in24 - out24,
            lastUpdated: new Date().toISOString()
        };
        // V2.1: sanear también el log de eventos de flujo
        if (Array.isArray(wt.flowEvents)) {
            wt.flowEvents = wt.flowEvents.filter(e => e && isFinite(e.amount) && e.amount > 0 && e.amount <= MAX_SANE);
        }
        safeWriteFile(DATA_FILE, JSON.stringify(data, null, 2), 'utf8');
        console.log(`SANEADO whale: ${before - clean.length} transferencias con unidades corruptas descartadas; summary recalculado.`);
    } catch (e) {
        console.error('Error saneando datos whale:', e.message);
    }
}

// --- SEEDING: Datos Mock para Whale Tracker ---
function seedWhaleTrackerMockData() {
    try {
        if (!fs.existsSync(DATA_FILE)) return;
        const rawData = fs.readFileSync(DATA_FILE, 'utf8');
        const data = JSON.parse(rawData);
        
        console.log('Sembrando datos MOCK para Whale Tracker...');
        data.whaleTracker = {
            summary: {
                largeTransfers24h: 5,
                totalVolume24h: 2500000,
                exchangeFlowNet: 500000,
                lastUpdated: new Date().toISOString()
            },
            trackedWallets: [
                { address: "rLNaPhS9K78Dbi4oAppSKXijcyS8YDXM6F", label: "Upbit Cold Wallet (MOCK)", type: "exchange", balance: 450000000 },
                { address: "rEb8p7u3v4R8MmdM9mD5dz7tS8S5VjR69C", label: "Binance Cold Wallet (MOCK)", type: "exchange", balance: 1200000000 },
                { address: "rDsbeomae4FXwgQTJp9Rs64Qg9vDiTCdBv", label: "Whale Wallet A (MOCK)", type: "whale", balance: 5000000000 },
                { address: "rw58mG5idZ8D93Y4mZq9XW4dKqL7Q8rG", label: "Bithumb Cold (MOCK)", type: "exchange", balance: 350000000 }
            ],
            largeTransfers: [
                { hash: "MOCK_TX_1", from: "rDsbeomae4FXwgQTJp9Rs64Qg9vDiTCdBv", to: "rEb8p7u3v4R8MmdM9mD5dz7tS8S5VjR69C", amount: 1200000, timestamp: new Date().toISOString(), type: "Payment", walletLabel: "Binance Cold Wallet (MOCK)" },
                { hash: "MOCK_TX_2", from: "rDsbeomae4FXwgQTJp9Rs64Qg9vDiTCdBv", to: "rLNaPhS9K78Dbi4oAppSKXijcyS8YDXM6F", amount: 850000, timestamp: new Date(Date.now() - 3600000).toISOString(), type: "Payment", walletLabel: "Ripple Escrow (MOCK)" },
                { hash: "MOCK_TX_3", from: "rLNaPhS9K78Dbi4oAppSKXijcyS8YDXM6F", to: "rEb8p7u3v4R8MmdM9mD5dz7tS8S5VjR69C", amount: 500000, timestamp: new Date(Date.now() - 7200000).toISOString(), type: "Payment", walletLabel: "Upbit Cold Wallet (MOCK)" },
                { hash: "MOCK_TX_4", from: "rEb8p7u3v4R8MmdM9mD5dz7tS8S5VjR69C", to: "rLNaPhS9K78Dbi4oAppSKXijcyS8YDXM6F", amount: 2000000, timestamp: new Date(Date.now() - 10800000).toISOString(), type: "Payment", walletLabel: "Upbit Cold Wallet (MOCK)" },
                { hash: "MOCK_TX_5", from: "rw58mG5idZ8D93Y4mZq9XW4dKqL7Q8rG", to: "rDsbeomae4FXwgQTJp9Rs64Qg9vDiTCdBv", amount: 150000, timestamp: new Date(Date.now() - 14400000).toISOString(), type: "Payment", walletLabel: "Bithumb Cold (MOCK)" }
            ],
            exchangeFlows: [
                { exchange: "Binance", type: "IN", amount: 5000000, timestamp: new Date().toISOString() },
                { exchange: "Upbit", type: "OUT", amount: 2000000, timestamp: new Date().toISOString() }
            ],
            walletHistory: [],
            walletHistoryCache: {}
        };
        
        safeWriteFile(DATA_FILE, JSON.stringify(data, null, 2), 'utf8');
        console.log('--- SEED: Whale Tracker Mock Data inyectada ---');
    } catch (e) {
        console.error('Error sembrando mock data:', e);
    }
}

// ============================================================
// V2.0/V2.2: DERIVADOS — funding rate y open interest de XRP
// Fuente base: Kraken Futures (API pública, accesible desde EE. UU.;
// Binance Futures y Bybit están geobloqueados — verificado 2026-07-03).
// Por qué importa: el funding indica hacia dónde está cargado el
// apalancamiento (positivo = largos pagan; negativo = cortos pagan),
// y el open interest cuánto dinero especulativo hay en juego.
// roadmap #11 (v2.2): intenta sumar OKX como segundo venue (API pública,
// sin key). Si OKX no responde (geobloqueo u otro motivo) se degrada sin
// romper nada: el nodo queda igual que antes, solo con Kraken.
// ============================================================
// V2.6: renombrada de fetchWithTimeout a fetchJsonWithTimeout — el nombre ahora dice
// lo que hace (devuelve el JSON ya parseado, no la Response) y evita colisionar con el
// helper genérico fetchWithTimeout() de arriba, que sí devuelve la Response cruda.
async function fetchJsonWithTimeout(url, ms) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ms);
    try {
        const resp = await fetch(url, { signal: controller.signal });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        return await resp.json();
    } finally {
        clearTimeout(timer);
    }
}

// OKX Futures (perpetuo XRP-USDT-SWAP): 3 llamadas públicas cortas, sin key.
// Si alguna falla o tarda (geobloqueo), se descarta OKX entero para no mezclar
// datos parciales — el ciclo sigue con Kraken como venue único, igual que antes.
async function fetchOkxDerivatives() {
    const instId = 'XRP-USDT-SWAP';
    const [fundingJson, oiJson, markJson] = await Promise.all([
        fetchJsonWithTimeout(`https://www.okx.com/api/v5/public/funding-rate?instId=${instId}`, 6000),
        fetchJsonWithTimeout(`https://www.okx.com/api/v5/public/open-interest?instType=SWAP&instId=${instId}`, 6000),
        fetchJsonWithTimeout(`https://www.okx.com/api/v5/public/mark-price?instType=SWAP&instId=${instId}`, 6000)
    ]);
    const f = fundingJson && fundingJson.data && fundingJson.data[0];
    const oi = oiJson && oiJson.data && oiJson.data[0];
    const mk = markJson && markJson.data && markJson.data[0];
    if (!f || !oi || !mk) throw new Error('respuesta incompleta de OKX');

    const markPrice = parseFloat(mk.markPx) || 0;
    const oiXrp = parseFloat(oi.oiCcy) || 0; // open interest en la moneda subyacente (XRP)
    // OKX expresa fundingRate como la tasa del período actual. Para XRP el período
    // habitual es 8h (verificar fundingTime-nextFundingTime si se audita a futuro);
    // se asume 8h como los demás venues del sector para poder comparar/agregar.
    const funding8h = parseFloat(f.fundingRate) || 0;

    return {
        name: 'OKX Futures (XRP-USDT-SWAP)',
        markPrice,
        fundingRate8hPct: funding8h * 100,
        fundingRateAnnualPct: 0, // se recalcula en fetchDerivativesData() con la fórmula común a todos los venues
        openInterestXrp: oiXrp,
        openInterestUsd: oiXrp * markPrice
    };
}

async function fetchDerivativesData() {
    try {
        const resp = await fetchWithTimeout('https://futures.kraken.com/derivatives/api/v3/tickers/PF_XRPUSD');
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const j = await resp.json();
        const t = j && j.ticker;
        if (!t || t.suspended) throw new Error('ticker no disponible');

        const markPrice = parseFloat(t.markPrice) || 0;
        const oiXrp = parseFloat(t.openInterest) || 0;
        // Bugfix (validación multi-moneda, v2.5): el fundingRate de Kraken Futures es
        // ABSOLUTO (USD por unidad de subyacente), NO una tasa relativa — el relativo
        // es fundingRate / markPrice. Con XRP a ~$1-3 el error era un factor pequeño y
        // pasó desapercibido; con BTC ($60k+) el agregado mostraba +373%/8h. Se
        // normaliza aquí igual que en fetchCoinDerivatives.
        const fundingHourly = markPrice > 0 ? (parseFloat(t.fundingRate) || 0) / markPrice : 0;
        const fundingPredHourly = markPrice > 0 ? (parseFloat(t.fundingRatePrediction) || 0) / markPrice : 0;

        const krakenVenue = {
            name: 'Kraken Futures (PF_XRPUSD)',
            markPrice: markPrice,
            fundingRate8hPct: fundingHourly * 8 * 100,
            fundingRateAnnualPct: fundingHourly * 24 * 365 * 100,
            openInterestXrp: oiXrp,
            openInterestUsd: oiXrp * markPrice
        };

        const venues = [krakenVenue];
        let okxError = null;
        try {
            const okxVenue = await fetchOkxDerivatives();
            okxVenue.fundingRateAnnualPct = (okxVenue.fundingRate8hPct / 100) * (365 * 3) * 100; // 3 periodos de 8h/día
            venues.push(okxVenue);
        } catch (okxErr) {
            okxError = okxErr.message;
            console.warn('Derivados: OKX no disponible (se conserva solo Kraken):', okxErr.message);
        }

        // Agregado ponderado por OI en USD entre los venues disponibles.
        const totalOiUsd = venues.reduce((s, v) => s + (v.openInterestUsd || 0), 0);
        const weightedFunding8h = totalOiUsd > 0
            ? venues.reduce((s, v) => s + v.fundingRate8hPct * (v.openInterestUsd || 0), 0) / totalOiUsd
            : venues[0].fundingRate8hPct;
        const totalOiXrp = venues.reduce((s, v) => s + (v.openInterestXrp || 0), 0);

        const derivatives = {
            venue: venues.length > 1 ? `Agregado ${venues.length} venues (${venues.map(v => v.name.split(' ')[0]).join(' + ')})` : krakenVenue.name,
            venues: venues,
            venueCount: venues.length,
            okxUnavailableReason: okxError,
            markPrice: markPrice, // referencia (Kraken), útil para consumidores existentes
            fundingRateHourlyPct: fundingHourly * 100,
            fundingRate8hPct: weightedFunding8h,          // agregado ponderado si hay ≥2 venues
            fundingRateAnnualPct: weightedFunding8h * (365 * 3),
            fundingPredictionHourlyPct: fundingPredHourly * 100,
            openInterestXrp: totalOiXrp,
            openInterestUsd: totalOiUsd,
            volume24hXrp: parseFloat(t.vol24h) || 0,
            change24hPct: parseFloat(t.change24h) || 0,
            note: venues.length > 1
                ? `Agregado de ${venues.length} venues (funding ponderado por OI en USD): ${venues.map(v => v.name).join(', ')}. Sigue sin ser el 100% del mercado global (faltan Binance/Bybit, geobloqueados en EE. UU.).`
                : 'Solo Kraken Futures: es una muestra del mercado de derivados, no el agregado global.' + (okxError ? ` (Se intentó sumar OKX, no disponible: ${okxError})` : ''),
            lastUpdated: new Date().toISOString()
        };

        await withDataFile(d => { d.derivatives = derivatives; });
        console.log(`Derivados (${venues.length} venue${venues.length > 1 ? 's' : ''}): funding ${derivatives.fundingRate8hPct.toFixed(4)}%/8h · OI ${Math.round(totalOiXrp).toLocaleString('en-US')} XRP`);
    } catch (error) {
        console.error('Error obteniendo derivados (Kraken Futures):', error.message);
    }
}

// ============================================================
// V2.0: ECOSISTEMA — contexto de mercado global + RLUSD
// Fuente: CoinGecko (/global y ripple-usd). Los inversores de XRP
// siguen el crecimiento de RLUSD porque cada transacción RLUSD en
// el XRPL liquida usando XRP (proxy de adopción institucional).
// ============================================================
async function fetchEcosystemData() {
    try {
        const ecosystem = { lastUpdated: new Date().toISOString() };

        try {
            const gResp = await coingeckoFetch('https://api.coingecko.com/api/v3/global');
            if (gResp.ok) {
                const g = await gResp.json();
                const mc = g && g.data ? g.data : {};
                ecosystem.btcDominancePct = mc.market_cap_percentage ? mc.market_cap_percentage.btc : null;
                ecosystem.xrpDominancePct = mc.market_cap_percentage ? mc.market_cap_percentage.xrp : null;
                ecosystem.totalMarketCapUsd = mc.total_market_cap ? mc.total_market_cap.usd : null;
                ecosystem.marketCapChange24hPct = mc.market_cap_change_percentage_24h_usd != null ? mc.market_cap_change_percentage_24h_usd : null;
            }
        } catch (e) { console.warn('CoinGecko /global no disponible:', e.message); }

        try {
            const rResp = await coingeckoFetch('https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&ids=ripple-usd');
            if (rResp.ok) {
                const arr = await rResp.json();
                if (Array.isArray(arr) && arr[0]) {
                    ecosystem.rlusdMarketCapUsd = arr[0].market_cap || null;
                    ecosystem.rlusdVolume24hUsd = arr[0].total_volume || null;
                }
            }
        } catch (e) { console.warn('CoinGecko ripple-usd no disponible:', e.message); }

        if (ecosystem.btcDominancePct == null && ecosystem.rlusdMarketCapUsd == null) {
            throw new Error('sin datos de CoinGecko');
        }

        await withDataFile(d => { d.ecosystem = ecosystem; });
        console.log('Ecosistema actualizado (dominancias + RLUSD).');
    } catch (error) {
        console.error('Error obteniendo datos de ecosistema:', error.message);
    }
}

// ============================================================
// V2.2: RLUSD — SPLIT XRPL vs ETHEREUM (roadmap #12)
// RLUSD es multi-chain (XRPL + Ethereum). Vía gateway_balances (XRPL JSON-RPC)
// leemos las obligations reales del issuer en el XRPL (supply emitido en XRPL);
// la diferencia contra el market cap total (CoinGecko, ya en data.ecosystem)
// es la porción implícita en Ethereum. Ripple no publica un endpoint que separe
// esto directamente, así que es una resta, no un dato directo — se marca 'estimated'.
// ============================================================
const RLUSD_XRPL_ISSUER = 'rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De';

// Los currency codes no estándar (todo lo que no sea un código ISO de 3 letras)
// se almacenan en el ledger como 160 bits = 40 caracteres hex. rippled/xrplcluster
// devuelve ese hex crudo en gateway_balances, no lo decodifica. Decodificamos
// nosotros y comparamos por el texto resultante en vez de asumir un hex fijo.
function decodeXrplCurrencyCode(code) {
    if (typeof code !== 'string') return '';
    if (code.length === 3) return code.toUpperCase();
    if (code.length === 40 && /^[0-9A-Fa-f]+$/.test(code)) {
        let out = '';
        for (let i = 0; i < code.length; i += 2) {
            const byte = parseInt(code.substr(i, 2), 16);
            if (byte > 0) out += String.fromCharCode(byte);
        }
        return out.trim().toUpperCase();
    }
    return code.toUpperCase();
}

async function fetchRlusdSplitData() {
    try {
        const resp = await fetchWithTimeout('https://xrplcluster.com/', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                method: 'gateway_balances',
                params: [{ account: RLUSD_XRPL_ISSUER, ledger_index: 'validated', strict: true }]
            })
        });
        if (!resp.ok) throw new Error(`xrplcluster HTTP ${resp.status}`);
        const j = await resp.json();
        const obligations = (j.result && j.result.obligations) || {};
        let xrplSupply = null;
        for (const [code, value] of Object.entries(obligations)) {
            if (decodeXrplCurrencyCode(code) === 'RLUSD') {
                xrplSupply = parseFloat(value);
                break;
            }
        }
        if (xrplSupply == null || !isFinite(xrplSupply)) {
            console.warn('RLUSD split: gateway_balances no devolvió obligations de RLUSD (issuer sin trustlines emitidas o formato inesperado); se conserva el nodo previo.');
            return;
        }

        // Market cap total (XRPL + Ethereum) viene de data.ecosystem (CoinGecko, ya fetcheado en el ciclo)
        const rawData = fs.readFileSync(DATA_FILE, 'utf8');
        const data = JSON.parse(rawData);
        const totalSupplyUsd = data.ecosystem && typeof data.ecosystem.rlusdMarketCapUsd === 'number'
            ? data.ecosystem.rlusdMarketCapUsd
            : null;

        const rlusdSplit = {
            xrplSupplyUsd: parseFloat(xrplSupply.toFixed(2)),
            totalSupplyUsd: totalSupplyUsd,
            xrplPct: null,
            ethereumImpliedUsd: null,
            ethereumImpliedPct: null,
            estimated: true,
            note: 'Supply en XRPL es on-chain real (gateway_balances). La porción "Ethereum" es la diferencia contra el market cap total de CoinGecko, no un dato directo de Ethereum: es una estimación.',
            source: 'XRPL on-chain (gateway_balances, xrplcluster.com) + CoinGecko (market cap total)',
            lastUpdated: new Date().toISOString()
        };

        if (totalSupplyUsd != null && totalSupplyUsd > 0) {
            rlusdSplit.xrplPct = parseFloat(((xrplSupply / totalSupplyUsd) * 100).toFixed(1));
            const ethImplied = Math.max(0, totalSupplyUsd - xrplSupply);
            rlusdSplit.ethereumImpliedUsd = parseFloat(ethImplied.toFixed(2));
            rlusdSplit.ethereumImpliedPct = parseFloat((100 - rlusdSplit.xrplPct).toFixed(1));
        } else {
            console.warn('RLUSD split: sin market cap total (data.ecosystem no disponible aún); se guarda solo el supply on-chain de XRPL.');
        }

        await withDataFile(d => { d.rlusdSplit = rlusdSplit; });
        console.log(`RLUSD split: ${xrplSupply.toLocaleString('en-US')} USD en XRPL` + (rlusdSplit.xrplPct != null ? ` (${rlusdSplit.xrplPct}% del total)` : ' (sin % — falta market cap total)'));
    } catch (error) {
        console.error('Error obteniendo split RLUSD XRPL/Ethereum:', error.message);
    }
}

// ============================================================
// V2.2: ACTIVIDAD AMM/DEX EN EL XRPL (roadmap #13)
// XRPScan expone /amm/pools con los pools AMM nativos del protocolo (no es un
// DEX externo: es una feature del propio ledger, XLS-30). El endpoint no pagina
// por tamaño ni expone el total de pools (se habla de ~28K en la red completa),
// así que tomamos una MUESTRA (las primeras N que devuelve la API, orden estable
// por creación) y sumamos SOLO los pools emparejados con XRP (la inmensa mayoría).
// Para un AMM de producto constante (x*y=k, como el del XRPL) el valor en USD de
// cada lado del pool es matemáticamente IGUAL en todo momento: por eso el TVL de
// cada pool = 2 × (reserva XRP × precio XRP). No es una aproximación de esa parte;
// lo que sí es aproximado es el TOTAL, porque es TVL de la muestra, no de la red.
// ============================================================
const AMM_POOLS_SAMPLE_SIZE = 300;

async function fetchAmmDexData() {
    try {
        const resp = await fetchWithTimeout(`https://api.xrpscan.com/api/v1/amm/pools?limit=${AMM_POOLS_SAMPLE_SIZE}`);
        if (!resp.ok) throw new Error(`XRPScan HTTP ${resp.status}`);
        const pools = await resp.json();
        if (!Array.isArray(pools)) throw new Error('respuesta inesperada (no es array)');

        const rawData = fs.readFileSync(DATA_FILE, 'utf8');
        const data = JSON.parse(rawData);
        const xrpPrice = (data.marketData && data.marketData.price) || 0;

        const xrpPools = pools.filter(p => p && p.Asset && p.Asset.currency === 'XRP' && typeof p.Balance === 'number' && p.Balance > 0);

        const ranked = xrpPools.map(p => {
            const reserveXrp = p.Balance / 1e6;
            const tvlUsd = xrpPrice > 0 ? reserveXrp * 2 * xrpPrice : null;
            const asset2Name = (p.Asset2Name && p.Asset2Name.name) || decodeXrplCurrencyCode(p.Asset2.currency) || p.Asset2.currency;
            return {
                token: asset2Name,
                issuer: p.Asset2.issuer || null,
                verified: !!(p.Asset2Name && p.Asset2Name.verified),
                reserveXrp: parseFloat(reserveXrp.toFixed(2)),
                tvlUsd: tvlUsd != null ? parseFloat(tvlUsd.toFixed(2)) : null,
                tradingFeePct: typeof p.TradingFee === 'number' ? parseFloat((p.TradingFee / 1000).toFixed(3)) : null
            };
        }).sort((a, b) => b.reserveXrp - a.reserveXrp);

        const totalReserveXrp = ranked.reduce((s, p) => s + p.reserveXrp, 0);
        const totalTvlUsd = xrpPrice > 0 ? totalReserveXrp * 2 * xrpPrice : null;

        const ammDex = {
            poolsSampled: pools.length,
            xrpPairedPoolsSampled: xrpPools.length,
            totalReserveXrpSample: parseFloat(totalReserveXrp.toFixed(2)),
            totalTvlUsdSample: totalTvlUsd != null ? parseFloat(totalTvlUsd.toFixed(2)) : null,
            topPools: ranked.slice(0, 8),
            estimated: true,
            note: `Muestra de las primeras ${pools.length} pools AMM que devuelve XRPScan (el API no expone el universo completo ni un TVL agregado global). TVL por pool es exacto para el tamaño de muestra: en un AMM de producto constante, el valor de cada lado del pool es igual, así que TVL = 2× el lado XRP al precio actual.`,
            source: 'XRPL on-chain (AMM pools vía XRPScan /amm/pools)',
            lastUpdated: new Date().toISOString()
        };

        await withDataFile(d => { d.ammDex = ammDex; });
        console.log(`AMM/DEX: ${xrpPools.length} pools XRP en muestra de ${pools.length}, TVL muestra ≈ $${Math.round(totalTvlUsd || 0).toLocaleString('en-US')}`);
    } catch (error) {
        console.error('Error obteniendo actividad AMM/DEX:', error.message);
    }
}

// ============================================================
// V2.0: RESUMEN DIARIO (dailyBrief) — el corazón del tab "Resumen".
// Cruza TODAS las señales ya calculadas y produce un veredicto en
// lenguaje llano SIN IA (reglas deterministas: funciona siempre,
// incluso sin claves API). Se regenera al final de cada ciclo.
// ============================================================
async function buildDailyBrief() {
    try {
        const data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
        const señales = [];
        const am = data.advancedMetrics || {};
        const price = (data.marketData && data.marketData.price) || 0;

        // V2.4 i18n: cada señal lleva text (ES) + textEn y area + areaEn — el
        // frontend elige según el idioma activo, sin re-generar nada en cliente.

        // 1) Tendencia de fondo (SMA200)
        if (am.trend && am.trend.sma200 != null) {
            const above = am.trend.priceVsSma200Pct >= 0;
            señales.push({
                area: 'Tendencia de fondo',
                areaEn: 'Major trend',
                tone: above ? 'pos' : 'neg',
                text: above
                    ? `Precio ${am.trend.priceVsSma200Pct.toFixed(1)}% POR ENCIMA de la media de 200 días: la tendencia mayor es alcista.`
                    : `Precio ${Math.abs(am.trend.priceVsSma200Pct).toFixed(1)}% POR DEBAJO de la media de 200 días: la tendencia mayor sigue bajista. Los rebotes dentro de esta condición suelen ser vulnerables.`,
                textEn: above
                    ? `Price ${am.trend.priceVsSma200Pct.toFixed(1)}% ABOVE the 200-day average: the major trend is bullish.`
                    : `Price ${Math.abs(am.trend.priceVsSma200Pct).toFixed(1)}% BELOW the 200-day average: the major trend remains bearish. Bounces under this condition tend to be fragile.`
            });
        }

        // 2) Momentum (MACD + RSI)
        if (am.momentum && am.momentum.macdHistogram != null) {
            const macdPos = am.momentum.macdHistogram > 0;
            const rsi = am.momentum.rsi14;
            let rsiTxt = '', rsiTxtEn = '';
            if (rsi != null) {
                if (rsi > 70) { rsiTxt = ` RSI en ${rsi.toFixed(0)} (sobrecompra: cuidado con entrar tarde).`; rsiTxtEn = ` RSI at ${rsi.toFixed(0)} (overbought: careful about chasing).`; }
                else if (rsi < 30) { rsiTxt = ` RSI en ${rsi.toFixed(0)} (sobreventa: zona que históricamente precede rebotes).`; rsiTxtEn = ` RSI at ${rsi.toFixed(0)} (oversold: a zone that has historically preceded bounces).`; }
                else { rsiTxt = ` RSI en ${rsi.toFixed(0)} (zona neutral).`; rsiTxtEn = ` RSI at ${rsi.toFixed(0)} (neutral zone).`; }
            }
            señales.push({
                area: 'Momentum',
                areaEn: 'Momentum',
                tone: macdPos ? 'pos' : 'neg',
                text: (macdPos ? 'MACD positivo: el impulso de corto plazo favorece a los compradores.' : 'MACD negativo: el impulso de corto plazo sigue vendedor.') + rsiTxt,
                textEn: (macdPos ? 'Positive MACD: short-term momentum favors buyers.' : 'Negative MACD: short-term momentum remains with sellers.') + rsiTxtEn
            });
        }

        // 3) Sentimiento (contrario)
        if (data.sentiment && data.sentiment.value != null) {
            const v = data.sentiment.value;
            let tone = 'info';
            let txt = `Fear & Greed en ${v} (neutral): el sentimiento no da señal contraria.`;
            let txtEn = `Fear & Greed at ${v} (neutral): sentiment gives no contrarian signal.`;
            if (v <= 25) {
                tone = 'pos';
                txt = `Fear & Greed en ${v} (miedo extremo). Señal CONTRARIA: los suelos históricos se han formado en estas zonas — interesa a compradores pacientes, no garantiza el rebote inmediato.`;
                txtEn = `Fear & Greed at ${v} (extreme fear). CONTRARIAN signal: historical bottoms have formed in these zones — of interest to patient buyers, no guarantee of an immediate bounce.`;
            } else if (v >= 75) {
                tone = 'warn';
                txt = `Fear & Greed en ${v} (codicia extrema). Señal contraria: históricamente precede correcciones.`;
                txtEn = `Fear & Greed at ${v} (extreme greed). Contrarian signal: historically precedes corrections.`;
            }
            señales.push({ area: 'Sentimiento', areaEn: 'Sentiment', tone, text: txt, textEn: txtEn });
        }

        // 4) Ballenas (flujo a exchanges) — V2.1: usa la línea de tiempo (misma fuente que el tab)
        if (data.whaleTracker && (data.whaleTracker.flowTimeline || data.whaleTracker.summary)) {
            const tl = data.whaleTracker.flowTimeline;
            const flow = tl && tl.totals24h ? tl.totals24h.netXrp : ((data.whaleTracker.summary && data.whaleTracker.summary.exchangeFlowNet) || 0);
            const hasMock = (data.whaleTracker.largeTransfers || []).some(tx => String(tx.hash || '').startsWith('MOCK'));
            if (hasMock && (!tl || !tl.totals24h || tl.totals24h.txCount === 0)) {
                señales.push({ area: 'Ballenas', areaEn: 'Whales', tone: 'info',
                    text: 'Sin transferencias grandes reales detectadas en las wallets vigiladas (se muestran ejemplos DEMO en el tab Ballenas).',
                    textEn: 'No real large transfers detected in the watched wallets (DEMO examples are shown in the Whales tab).' });
            } else if (Math.abs(flow) < 1) {
                señales.push({ area: 'Ballenas', areaEn: 'Whales', tone: 'info',
                    text: 'Flujo neto a exchanges ≈ 0 en 24h: las ballenas vigiladas no están posicionando XRP para vender ni retirando en masa.',
                    textEn: 'Net exchange flow ≈ 0 over 24h: the watched whales are neither positioning XRP to sell nor withdrawing en masse.' });
            } else if (flow > 0) {
                señales.push({ area: 'Ballenas', areaEn: 'Whales', tone: 'neg',
                    text: `${Math.round(flow).toLocaleString('en-US')} XRP netos ENTRARON a exchanges en 24h: oferta lista para venderse (presión bajista potencial).`,
                    textEn: `${Math.round(flow).toLocaleString('en-US')} net XRP FLOWED INTO exchanges over 24h: supply positioned to sell (potential bearish pressure).` });
            } else {
                señales.push({ area: 'Ballenas', areaEn: 'Whales', tone: 'pos',
                    text: `${Math.round(Math.abs(flow)).toLocaleString('en-US')} XRP netos SALIERON de exchanges en 24h: acumulación en wallets frías (se retira oferta del mercado).`,
                    textEn: `${Math.round(Math.abs(flow)).toLocaleString('en-US')} net XRP LEFT exchanges over 24h: accumulation into cold wallets (supply being pulled off the market).` });
            }
        }

        // 5) Derivados (funding)
        if (data.derivatives && data.derivatives.fundingRate8hPct != null) {
            const f8 = data.derivatives.fundingRate8hPct;
            let tone = 'info';
            let txt = `Funding ≈ ${f8.toFixed(4)}%/8h (neutro): el apalancamiento no está cargado hacia ningún lado.`;
            let txtEn = `Funding ≈ ${f8.toFixed(4)}%/8h (neutral): leverage isn't loaded in either direction.`;
            if (f8 > 0.01) {
                tone = 'warn';
                txt = `Funding positivo (${f8.toFixed(4)}%/8h): los largos apalancados pagan por mantener posición — optimismo apalancado, vulnerable a barridos si el precio cae.`;
                txtEn = `Positive funding (${f8.toFixed(4)}%/8h): leveraged longs pay to hold — leveraged optimism, vulnerable to liquidation sweeps if price falls.`;
            } else if (f8 < -0.01) {
                tone = 'pos';
                txt = `Funding negativo (${f8.toFixed(4)}%/8h): los cortos pagan por mantener posición — pesimismo saturado que a veces precede rebotes (short squeeze).`;
                txtEn = `Negative funding (${f8.toFixed(4)}%/8h): shorts pay to hold — saturated pessimism that sometimes precedes bounces (short squeeze).`;
            }
            const venue = data.derivatives.venue || 'Kraken Futures';
            señales.push({ area: 'Derivados', areaEn: 'Derivatives', tone,
                text: txt + ` (Muestra: ${venue}).`,
                textEn: txtEn + ` (Sample: ${venue}).` });
        }

        // 6) Presión spot
        if (data.orderFlow && data.orderFlow.buyPercent != null) {
            const bp = data.orderFlow.buyPercent;
            señales.push({
                area: 'Presión spot',
                areaEn: 'Spot pressure',
                tone: bp > 55 ? 'pos' : (bp < 45 ? 'neg' : 'info'),
                text: bp > 55 ? `Compradores dominan el spot de Binance (${bp}% del volumen taker).`
                    : bp < 45 ? `Vendedores dominan el spot de Binance (${(100 - bp).toFixed(2)}% del volumen taker).`
                    : `Spot equilibrado en Binance (${bp}% compras): sin señal direccional.`,
                textEn: bp > 55 ? `Buyers dominate Binance spot (${bp}% of taker volume).`
                    : bp < 45 ? `Sellers dominate Binance spot (${(100 - bp).toFixed(2)}% of taker volume).`
                    : `Balanced spot on Binance (${bp}% buys): no directional signal.`
            });
        }

        // 7) Riesgo (solo si es alto — no meter ruido)
        if (am.risk && am.risk.volatility30dAnnualizedPct > 90) {
            señales.push({ area: 'Riesgo', areaEn: 'Risk', tone: 'warn',
                text: `Volatilidad anualizada de ${am.risk.volatility30dAnnualizedPct.toFixed(0)}%: dimensiona posiciones con cautela (VaR diario 95%: ${am.risk.var95DailyPct}%).`,
                textEn: `Annualized volatility of ${am.risk.volatility30dAnnualizedPct.toFixed(0)}%: size positions carefully (daily 95% VaR: ${am.risk.var95DailyPct}%).` });
        }

        // Veredicto global por conteo de señales
        const pos = señales.filter(s => s.tone === 'pos').length;
        const neg = señales.filter(s => s.tone === 'neg').length;
        let tone = 'info';
        let headline = 'Contexto mixto: señales contradictorias, sin ventaja clara para ninguna dirección.';
        let headlineEn = 'Mixed context: contradictory signals, no clear edge in either direction.';
        if (pos - neg >= 2) {
            tone = 'pos';
            headline = 'El conjunto de señales se inclina ALCISTA a corto plazo — recuerda que ninguna señal es garantía.';
            headlineEn = 'The overall signals lean BULLISH short-term — remember no signal is a guarantee.';
        } else if (neg - pos >= 2) {
            tone = 'neg';
            headline = 'El conjunto de señales se inclina BAJISTA — el contexto pide más prudencia de lo habitual.';
            headlineEn = 'The overall signals lean BEARISH — the context calls for extra caution.';
        }

        // Niveles clave para vigilar
        const t = data.technicals || {};
        const psico = price >= 1 ? Math.floor(price * 2) / 2 : Math.floor(price * 10) / 10; // 1.11 → 1.00
        const niveles = {
            soporte: t.support || null,
            resistencia: t.resistance || null,
            psicologico: psico > 0 ? psico : null,
            nota: 'Soporte/resistencia calculados sobre los últimos 7 días; el nivel psicológico es la cifra redonda que el mercado vigila.',
            notaEn: 'Support/resistance computed over the last 7 days; the psychological level is the round number the market watches.'
        };

        // Calidad de datos: qué nodos están frescos y cuáles obsoletos
        const now = Date.now();
        const ageMin = (iso) => iso ? Math.round((now - new Date(iso).getTime()) / 60000) : null;
        const fuentes = [
            ['Precio (CoinGecko)', 'Price (CoinGecko)', data.marketData && data.marketData.lastUpdated],
            ['On-chain (XRPScan)', 'On-chain (XRPScan)', data.onChainData && data.onChainData.lastUpdated],
            ['Presión spot (Binance)', 'Spot pressure (Binance)', data.orderFlow && data.orderFlow.lastUpdated],
            ['Sentimiento (Alternative.me)', 'Sentiment (Alternative.me)', data.sentiment && data.sentiment.lastUpdated],
            ['Ballenas (XRPScan)', 'Whales (XRPScan)', data.whaleTracker && data.whaleTracker.summary && data.whaleTracker.summary.lastUpdated],
            ['Derivados (Kraken/OKX)', 'Derivatives (Kraken/OKX)', data.derivatives && data.derivatives.lastUpdated],
            ['Ecosistema (CoinGecko)', 'Ecosystem (CoinGecko)', data.ecosystem && data.ecosystem.lastUpdated],
            ['Escrow (XRPL on-chain)', 'Escrow (XRPL on-chain)', data.escrowOnChain && data.escrowOnChain.lastUpdated],
            ['RLUSD split (XRPL on-chain)', 'RLUSD split (XRPL on-chain)', data.rlusdSplit && data.rlusdSplit.lastUpdated],
            ['Volumen por exchange (CoinGecko)', 'Volume by exchange (CoinGecko)', data.exchangeVolume && data.exchangeVolume.lastUpdated],
            ['AMM/DEX (XRPScan)', 'AMM/DEX (XRPScan)', data.ammDex && data.ammDex.lastUpdated]
        ];
        const dataQuality = fuentes.map(([name, nameEn, iso]) => ({
            source: name,
            sourceEn: nameEn,
            ageMinutes: ageMin(iso),
            stale: iso ? ageMin(iso) > 20 : true
        }));

        const dailyBrief = { headline, headlineEn, tone, señales, niveles, dataQuality, generatedAt: new Date().toISOString() };
        await withDataFile(d => { d.dailyBrief = dailyBrief; });
        console.log(`Resumen diario generado: ${pos} señales positivas, ${neg} negativas → ${tone}.`);
    } catch (error) {
        console.error('Error generando el resumen diario:', error.message);
    }
}

// ============================================================
// HISTORY.JSON: SNAPSHOTS DIARIOS (roadmap #6, v2.2)
// Archivo separado de data.json (no pasa por withDataFile: es un array append-only
// propio, sin los escritores concurrentes de data.json que motivaron esa cola).
// Se toma como referencia el ÚLTIMO ciclo de refresco de cada día natural: cada
// ciclo hace upsert de la entrada de "hoy" (se sobreescribe con datos más frescos
// hasta que el día cambia y queda fijada). Sin esto el dashboard solo sabe decir
// "ahora" — desbloquea sparklines (#7), holders underwater (#10) y backtesting (#19).
// ============================================================
const HISTORY_FILE = path.join(__dirname, 'history.json');
const HISTORY_MAX_DAYS = 400; // ~13 meses de histórico antes de rotar entradas antiguas

function readHistoryFile() {
    try {
        if (!fs.existsSync(HISTORY_FILE)) return [];
        const raw = fs.readFileSync(HISTORY_FILE, 'utf8');
        const arr = JSON.parse(raw);
        return Array.isArray(arr) ? arr : [];
    } catch (e) {
        console.error('Error leyendo history.json (se trata como vacío):', e.message);
        return [];
    }
}

async function appendDailyHistorySnapshot() {
    try {
        const rawData = fs.readFileSync(DATA_FILE, 'utf8');
        const data = JSON.parse(rawData);
        const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD (UTC)

        const snapshot = {
            date: today,
            price: data.marketData?.price ?? null,
            score: data.advancedMetrics?.compositeScore?.value ?? null,
            whaleExchangeFlowNet: data.whaleTracker?.summary?.exchangeFlowNet ?? null,
            fundingRate8hPct: data.derivatives?.fundingRate8hPct ?? null,
            openInterestXrp: data.derivatives?.openInterestXrp ?? null,
            rlusdMarketCapUsd: data.ecosystem?.rlusdMarketCapUsd ?? null,
            fearGreed: data.sentiment?.value ?? null,
            dailyBurnXrp: data.burnImpact?.dailyBurn ?? null,
            btcDominancePct: data.ecosystem?.btcDominancePct ?? null,
            xrpDominancePct: data.ecosystem?.xrpDominancePct ?? null,
            escrowRemainingB: data.escrowOnChain?.totalRemainingB ?? null,
            capturedAt: new Date().toISOString()
        };

        let history = readHistoryFile();
        const idx = history.findIndex(h => h.date === today);
        if (idx >= 0) {
            history[idx] = snapshot; // upsert: última lectura del día gana
        } else {
            history.push(snapshot);
        }
        // Rotación: conservar como máximo HISTORY_MAX_DAYS entradas más recientes
        if (history.length > HISTORY_MAX_DAYS) {
            history = history.slice(history.length - HISTORY_MAX_DAYS);
        }

        safeWriteFile(HISTORY_FILE, JSON.stringify(history, null, 2), 'utf8');
        console.log(`history.json: snapshot de ${today} guardado (${history.length} días acumulados).`);
    } catch (error) {
        console.error('Error guardando snapshot diario en history.json:', error.message);
    }
}

// Función para refrescar todos los datos de forma secuencial y segura (evitando límites de tasa de API)
let refreshInProgress = false; // V2.0: el refresh manual podía solaparse con el automático
// ============================================================
// V2.5 — MULTI-MONEDA (fase 1)
//
// Diseño: la ruta de XRP NO se toca — sus nodos siguen en el top-level de
// data.json y su ciclo (refreshAllData) queda intacto. Las demás monedas
// viven bajo `data.coins[<coingeckoId>]` con los nodos GENÉRICOS: marketData
// (incluye supply), chartData, technicals, projections, advancedMetrics,
// orderFlow (si cotiza en Binance), derivatives (Kraken/OKX si existen),
// exchangeVolume, newsFeed (CryptoPanic sin IA) y dailyBrief bilingüe.
// Lo específico del XRPL (ballenas, escrow, burn, RLUSD, AMM, ETFs) no
// tiene equivalente multi-cadena en fase 1 y el frontend lo oculta.
//
// Refresco: la moneda activa (elegida en la UI) se refresca en cada ciclo
// de 5 min; las demás rotan una por ciclo (≈30 min con 6-8 monedas). El
// ciclo multi-moneda arranca desfasado ~2,5 min del ciclo XRP para no
// competir por el rate limit de CoinGecko en la misma ráfaga.
// ============================================================

const COINS = [
    { id: 'ripple',           symbol: 'XRP',  name: 'XRP',         iso20022: true,  legacy: true,  binance: 'XRPUSDT',  kraken: 'PF_XRPUSD',  okx: 'XRP-USDT-SWAP',  ctTag: 'ripple' },
    { id: 'stellar',          symbol: 'XLM',  name: 'Stellar',     iso20022: true,  legacy: false, binance: 'XLMUSDT',  kraken: 'PF_XLMUSD',  okx: 'XLM-USDT-SWAP',  ctTag: 'stellar' },
    { id: 'xdce-crowd-sale',  symbol: 'XDC',  name: 'XDC Network', iso20022: true,  legacy: false, binance: null,       kraken: null,         okx: null,             ctTag: null },
    { id: 'algorand',         symbol: 'ALGO', name: 'Algorand',    iso20022: true,  legacy: false, binance: 'ALGOUSDT', kraken: 'PF_ALGOUSD', okx: 'ALGO-USDT-SWAP', ctTag: 'algorand' },
    { id: 'hedera-hashgraph', symbol: 'HBAR', name: 'Hedera',      iso20022: true,  legacy: false, binance: 'HBARUSDT', kraken: 'PF_HBARUSD', okx: 'HBAR-USDT-SWAP', ctTag: 'hedera' },
    { id: 'iota',             symbol: 'IOTA', name: 'IOTA',        iso20022: true,  legacy: false, binance: 'IOTAUSDT', kraken: null,         okx: 'IOTA-USDT-SWAP', ctTag: 'iota' },
    { id: 'quant-network',    symbol: 'QNT',  name: 'Quant',       iso20022: true,  legacy: false, binance: 'QNTUSDT',  kraken: null,         okx: null,             ctTag: null },
    { id: 'bitcoin',          symbol: 'BTC',  name: 'Bitcoin',     iso20022: false, legacy: false, binance: 'BTCUSDT',  kraken: 'PF_XBTUSD',  okx: 'BTC-USDT-SWAP',  ctTag: 'bitcoin' },
    { id: 'ethereum',         symbol: 'ETH',  name: 'Ethereum',    iso20022: false, legacy: false, binance: 'ETHUSDT',  kraken: 'PF_ETHUSD',  okx: 'ETH-USDT-SWAP',  ctTag: 'ethereum' }
];
const coinById = (id) => COINS.find(c => c.id === id) || null;

let activeGenericCoin = null;        // id de la moneda activa NO-XRP (null = XRP)
let coinRotationIdx = 0;             // rotación de refresco de fondo
let genericRefreshInProgress = false;

// Nivel psicológico razonable para cualquier rango de precio (el de XRP
// asumía precios ~1 USD; BTC necesita miles, no medios dólares).
function psychologicalLevel(price) {
    if (!isFinite(price) || price <= 0) return null;
    if (price >= 10000) return Math.floor(price / 1000) * 1000;
    if (price >= 1000) return Math.floor(price / 100) * 100;
    if (price >= 100) return Math.floor(price / 10) * 10;
    if (price >= 1) return Math.floor(price * 2) / 2;
    return Math.floor(price * 10) / 10;
}

// --- Mercado + supply (una sola llamada a /coins/markets) ---
async function fetchCoinMarket(coin) {
    const resp = await coingeckoFetch(`https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&ids=${coin.id}&order=market_cap_desc&per_page=1&page=1&sparkline=false`);
    const arr = await resp.json();
    if (!Array.isArray(arr) || !arr[0]) throw new Error(`CoinGecko sin datos para ${coin.id}`);
    const m = arr[0];
    const marketData = {
        price: m.current_price,
        priceChange24h: m.price_change_percentage_24h || 0,
        marketCap: m.market_cap,
        marketCapChange24h: m.market_cap_change_percentage_24h || 0,
        volume24h: m.total_volume,
        // Para el tab Suministro genérico (no-XRP): datos de supply de CoinGecko
        circulatingSupply: m.circulating_supply || null,
        totalSupply: m.total_supply || null,
        maxSupply: m.max_supply || null,
        ath: m.ath || null,
        athChangePct: m.ath_change_percentage != null ? m.ath_change_percentage : null,
        lastUpdated: new Date().toISOString()
    };
    await withDataFile(d => {
        d.coins = d.coins || {};
        d.coins[coin.id] = d.coins[coin.id] || {};
        d.coins[coin.id].marketData = marketData;
    });
    return marketData;
}

// --- Gráfica 365d + técnicos + proyecciones + métricas (sobre la misma serie) ---
async function fetchCoinChartAndMetrics(coin) {
    const resp = await coingeckoFetch(`https://api.coingecko.com/api/v3/coins/${coin.id}/market_chart?vs_currency=usd&days=365`);
    const api = await resp.json();
    if (!api || !Array.isArray(api.prices) || api.prices.length < 30) throw new Error(`CoinGecko sin histórico para ${coin.id}`);
    const chartData = api.prices;
    const prices = chartData.map(p => p[1]);
    const currentPrice = prices[prices.length - 1];

    // Técnicos 7d (mismo criterio que calculateTechnicals: soporte/resistencia por ventana real)
    const sevenDaysAgo = Date.now() - 7 * 86400000;
    const last7 = chartData.filter(p => p[0] >= sevenDaysAgo).map(p => p[1]);
    const support = last7.length >= 2 ? Math.min(...last7) : null;
    const resistance = last7.length >= 2 ? Math.max(...last7) : null;
    const technicals = {
        support: support != null ? parseFloat(support.toFixed(6)) : null,
        resistance: resistance != null ? parseFloat(resistance.toFixed(6)) : null,
        lastUpdated: new Date().toISOString()
    };

    // Proyecciones (misma metodología que calculateProjections, bilingüe)
    const projections = (support && resistance) ? {
        bajista: { price: parseFloat(Math.min(currentPrice * 0.85, support).toFixed(6)), description: 'Caída del 15% o toque de soporte', descriptionEn: '15% drop or support touch' },
        neutral: { price: parseFloat(currentPrice.toFixed(6)), description: 'Fluctuación lateral del +/- 5%', descriptionEn: 'Sideways range of +/- 5%' },
        alcista: { price: parseFloat(Math.max(currentPrice * 1.20, resistance).toFixed(6)), description: 'Subida del 20% o ruptura de resistencia', descriptionEn: '20% rise or resistance breakout' },
        lastUpdated: new Date().toISOString()
    } : null;

    // Métricas genéricas (subset del calculateAdvancedMetrics de XRP: sin
    // correlaciones BTC/ETH/SPY en fase 1 — costarían 2-3 llamadas extra por moneda)
    const advancedMetrics = computeGenericMetrics(coin, chartData);

    await withDataFile(d => {
        d.coins = d.coins || {};
        d.coins[coin.id] = d.coins[coin.id] || {};
        d.coins[coin.id].chartData = chartData;
        d.coins[coin.id].technicals = technicals;
        if (projections) d.coins[coin.id].projections = projections;
        if (advancedMetrics) d.coins[coin.id].advancedMetrics = advancedMetrics;
    });
}

// Núcleo de métricas sin I/O (usa las funciones puras de lib/calc)
function computeGenericMetrics(coin, chartData) {
    try {
        const spanDays = (chartData[chartData.length - 1][0] - chartData[0][0]) / 86400000;
        if (spanDays < 60) return null; // resolución insuficiente: no calcular basura
        const prices = chartData.map(p => p[1]);
        const currentPrice = prices[prices.length - 1];
        const returns = _dailyReturns(prices);

        const sma20 = _smaLast(prices, 20), sma50 = _smaLast(prices, 50), sma200 = _smaLast(prices, 200);
        const rsi14 = _rsiWilder(prices, 14);

        // MACD (12,26,9) con las EMAs de lib/calc
        let macdHist = null;
        try {
            const ema12 = _emaArray(prices, 12), ema26 = _emaArray(prices, 26);
            const macdArr = prices.map((_, i) => (ema12[i] != null && ema26[i] != null) ? ema12[i] - ema26[i] : null).filter(v => v != null);
            const signalArr = _emaArray(macdArr, 9);
            if (macdArr.length && signalArr.length) macdHist = macdArr[macdArr.length - 1] - signalArr[signalArr.length - 1];
        } catch (e) { /* MACD opcional */ }

        let crossSignal = 'NINGUNO';
        if (sma50 != null && sma200 != null) crossSignal = sma50 > sma200 ? 'TENDENCIA_ALCISTA' : 'TENDENCIA_BAJISTA';

        const r30 = returns.slice(-30), r90 = returns.slice(-90);
        const vol30 = _stdDev(r30) * Math.sqrt(365) * 100;
        const vol90 = _stdDev(r90) * Math.sqrt(365) * 100;
        // Bugfix (validación multi-moneda): _maxDrawdown YA devuelve % (BTC mostraba
        // -5307% por el doble ×100) y _percentile espera array ORDENADO con p en 0-1
        // (el VaR salía NaN). Misma convención que la ruta XRP (sortedRet90, 0.05).
        const maxDd = _maxDrawdown(prices.slice(-365));
        const sharpe90 = _stdDev(r90) > 0 ? (_mean(r90) / _stdDev(r90)) * Math.sqrt(365) : 0;
        const var95 = _percentile(r90.slice().sort((a, b) => a - b), 0.05) * 100;

        const pAt = (n) => prices.length > n ? prices[prices.length - 1 - n] : null;
        const perf = (n) => { const p = pAt(n); return p > 0 ? parseFloat((((currentPrice - p) / p) * 100).toFixed(2)) : null; };
        const high52 = Math.max(...prices), low52 = Math.min(...prices);

        // Score compuesto: mismas reglas técnicas que XRP (sin F&G/orderflow aquí —
        // el sentimiento es global y la presión spot puede no existir para la moneda)
        let score = 50;
        const factors = [];
        if (sma50 != null) { const f = currentPrice > sma50 ? 10 : -10; score += f; factors.push({ factor: 'Precio vs SMA50', factorEn: 'Price vs SMA50', impact: f, detail: currentPrice > sma50 ? 'Por encima (alcista)' : 'Por debajo (bajista)', detailEn: currentPrice > sma50 ? 'Above (bullish)' : 'Below (bearish)' }); }
        if (sma200 != null) { const f = currentPrice > sma200 ? 15 : -15; score += f; factors.push({ factor: 'Precio vs SMA200', factorEn: 'Price vs SMA200', impact: f, detail: currentPrice > sma200 ? 'Tendencia mayor alcista' : 'Tendencia mayor bajista', detailEn: currentPrice > sma200 ? 'Major trend bullish' : 'Major trend bearish' }); }
        if (macdHist != null) { const f = macdHist > 0 ? 10 : -10; score += f; factors.push({ factor: 'MACD', factorEn: 'MACD', impact: f, detail: macdHist > 0 ? 'Momentum positivo' : 'Momentum negativo', detailEn: macdHist > 0 ? 'Positive momentum' : 'Negative momentum' }); }
        if (rsi14 != null) {
            let f = 0, det = 'Zona neutral', detEn = 'Neutral zone';
            if (rsi14 > 70) { f = -10; det = 'Sobrecompra (>70): riesgo de corrección'; detEn = 'Overbought (>70): correction risk'; }
            else if (rsi14 >= 55) { f = 5; det = 'Momentum saludable'; detEn = 'Healthy momentum'; }
            else if (rsi14 < 30) { f = 5; det = 'Sobreventa (<30): posible rebote técnico'; detEn = 'Oversold (<30): possible technical bounce'; }
            else if (rsi14 < 45) { f = -5; det = 'Momentum débil'; detEn = 'Weak momentum'; }
            score += f; factors.push({ factor: 'RSI 14', factorEn: 'RSI 14', impact: f, detail: det, detailEn: detEn });
        }
        score = Math.max(0, Math.min(100, score));
        let label = 'NEUTRAL', labelEn = 'NEUTRAL';
        if (score >= 65) { label = 'SESGO ALCISTA'; labelEn = 'BULLISH BIAS'; }
        else if (score <= 40) { label = 'SESGO BAJISTA'; labelEn = 'BEARISH BIAS'; }

        // Insights genéricos bilingües (subset técnico)
        const insights = [];
        if (rsi14 != null && rsi14 > 70) insights.push({ icon: '⚠️', level: 'negativo',
            text: `RSI en ${rsi14.toFixed(1)} (sobrecompra). El precio podría estar extendido; entradas a estos niveles tienen peor ratio riesgo/beneficio.`,
            textEn: `RSI at ${rsi14.toFixed(1)} (overbought). Price may be extended; entries at these levels historically carry a worse risk/reward ratio.` });
        if (rsi14 != null && rsi14 < 30) insights.push({ icon: '💡', level: 'positivo',
            text: `RSI en ${rsi14.toFixed(1)} (sobreventa). Históricamente estas zonas preceden rebotes técnicos.`,
            textEn: `RSI at ${rsi14.toFixed(1)} (oversold). These zones have historically preceded technical bounces.` });
        if (vol30 > 90) insights.push({ icon: '⚠️', level: 'negativo',
            text: `Volatilidad anualizada de ${vol30.toFixed(0)}% (30d): muy alta. Dimensiona posiciones con cautela; el VaR diario al 95% es ${var95.toFixed(1)}%.`,
            textEn: `Annualized volatility of ${vol30.toFixed(0)}% (30d): very high. Size positions carefully; daily 95% VaR is ${var95.toFixed(1)}%.` });
        if (maxDd < -40) insights.push({ icon: '▼', level: 'neutro',
            text: `El drawdown máximo del último año fue ${maxDd.toFixed(1)}%. Define tu tolerancia antes de entrar.`,
            textEn: `Max drawdown over the past year was ${maxDd.toFixed(1)}%. Define your tolerance before entering.` });
        const fromHighPct = high52 > 0 ? ((currentPrice - high52) / high52) * 100 : 0;
        if (fromHighPct < -50) insights.push({ icon: '↕', level: 'neutro',
            text: `El precio está ${Math.abs(fromHighPct).toFixed(0)}% por debajo del máximo de 52 semanas. Recuperarlo exigiría una subida del ${(((high52 / currentPrice) - 1) * 100).toFixed(0)}%.`,
            textEn: `Price is ${Math.abs(fromHighPct).toFixed(0)}% below the 52-week high. Reclaiming it would require a ${(((high52 / currentPrice) - 1) * 100).toFixed(0)}% rise.` });
        if (sharpe90 > 1) insights.push({ icon: '🏆', level: 'positivo',
            text: `Sharpe (90d) de ${sharpe90.toFixed(2)}: el retorno reciente ha compensado bien el riesgo asumido.`,
            textEn: `Sharpe (90d) of ${sharpe90.toFixed(2)}: recent returns have compensated well for the risk taken.` });
        if (sharpe90 < 0) insights.push({ icon: '⚖️', level: 'negativo',
            text: `Sharpe (90d) negativo (${sharpe90.toFixed(2)}): en los últimos 3 meses el riesgo asumido no se ha visto recompensado.`,
            textEn: `Negative Sharpe (90d) (${sharpe90.toFixed(2)}): over the past 3 months the risk taken has not paid off.` });

        return {
            momentum: { rsi14: rsi14 != null ? parseFloat(rsi14.toFixed(2)) : null, macdHistogram: macdHist != null ? parseFloat(macdHist.toFixed(6)) : null, bollinger: null },
            trend: {
                sma20: sma20 != null ? parseFloat(sma20.toFixed(6)) : null,
                sma50: sma50 != null ? parseFloat(sma50.toFixed(6)) : null,
                sma200: sma200 != null ? parseFloat(sma200.toFixed(6)) : null,
                priceVsSma50Pct: sma50 ? parseFloat((((currentPrice - sma50) / sma50) * 100).toFixed(2)) : null,
                priceVsSma200Pct: sma200 ? parseFloat((((currentPrice - sma200) / sma200) * 100).toFixed(2)) : null,
                crossSignal
            },
            risk: {
                volatility30dAnnualizedPct: parseFloat(vol30.toFixed(2)),
                volatility90dAnnualizedPct: parseFloat(vol90.toFixed(2)),
                maxDrawdown1yPct: parseFloat(maxDd.toFixed(2)),
                sharpeRatio90d: parseFloat(sharpe90.toFixed(2)),
                var95DailyPct: parseFloat(var95.toFixed(2))
            },
            performance: { d7: perf(7), d30: perf(30), d90: perf(90), d365: perf(Math.min(365, prices.length - 1)) },
            range52w: {
                high: parseFloat(high52.toFixed(6)),
                low: parseFloat(low52.toFixed(6)),
                fromHighPct: parseFloat(fromHighPct.toFixed(2)),
                fromLowPct: parseFloat((low52 > 0 ? ((currentPrice - low52) / low52) * 100 : 0).toFixed(2))
            },
            compositeScore: {
                value: score, label, labelEn, factors,
                disclaimer: 'Indicador educativo basado en reglas técnicas. NO constituye asesoramiento financiero.'
            },
            insights,
            lastUpdated: new Date().toISOString()
        };
    } catch (e) {
        console.warn(`Métricas genéricas de ${coin.symbol} fallaron:`, e.message);
        return null;
    }
}

// --- Presión spot (Binance, si la moneda cotiza allí) ---
async function fetchCoinOrderFlow(coin) {
    if (!coin.binance) return;
    const response = await fetchWithTimeout(`https://data-api.binance.vision/api/v3/klines?symbol=${coin.binance}&interval=1h&limit=24`);
    const klines = await response.json();
    if (!Array.isArray(klines) || klines.length === 0) throw new Error(`Binance sin klines para ${coin.binance}`);
    let vol = 0, buyVol = 0, usd = 0, buyUsd = 0;
    klines.forEach(c => { vol += parseFloat(c[5]); buyVol += parseFloat(c[9]); usd += parseFloat(c[7]); buyUsd += parseFloat(c[10]); });
    const orderFlow = {
        buyVolume: buyVol, sellVolume: vol - buyVol, totalVolume: vol,
        buyValueUsd: buyUsd, sellValueUsd: usd - buyUsd, totalValueUsd: usd,
        buyPercent: parseFloat(((buyVol / vol) * 100).toFixed(2)),
        sellPercent: parseFloat((((vol - buyVol) / vol) * 100).toFixed(2)),
        timeWindow: 'Últimas 24 horas',
        lastUpdated: new Date().toISOString()
    };
    await withDataFile(d => { d.coins = d.coins || {}; d.coins[coin.id] = d.coins[coin.id] || {}; d.coins[coin.id].orderFlow = orderFlow; });
}

// --- Derivados (Kraken Futures + OKX, según disponibilidad por moneda) ---
async function fetchOkxVenueFor(instId) {
    const [fundingJson, oiJson, markJson] = await Promise.all([
        fetchJsonWithTimeout(`https://www.okx.com/api/v5/public/funding-rate?instId=${instId}`, 6000),
        fetchJsonWithTimeout(`https://www.okx.com/api/v5/public/open-interest?instType=SWAP&instId=${instId}`, 6000),
        fetchJsonWithTimeout(`https://www.okx.com/api/v5/public/mark-price?instType=SWAP&instId=${instId}`, 6000)
    ]);
    const f = fundingJson && fundingJson.data && fundingJson.data[0];
    const oi = oiJson && oiJson.data && oiJson.data[0];
    const mk = markJson && markJson.data && markJson.data[0];
    if (!f || !oi || !mk) throw new Error('respuesta incompleta de OKX');
    const markPrice = parseFloat(mk.markPx) || 0;
    const oiCoin = parseFloat(oi.oiCcy) || 0;
    const funding8h = (parseFloat(f.fundingRate) || 0) * 100;
    return { name: `OKX Futures (${instId})`, markPrice, fundingRate8hPct: funding8h, fundingRateAnnualPct: funding8h * 365 * 3, openInterestXrp: oiCoin, openInterestUsd: oiCoin * markPrice };
}

async function fetchCoinDerivatives(coin) {
    if (!coin.kraken && !coin.okx) return;
    const venues = [];
    let krakenTicker = null;
    if (coin.kraken) {
        try {
            const resp = await fetchWithTimeout(`https://futures.kraken.com/derivatives/api/v3/tickers/${coin.kraken}`);
            if (resp.ok) {
                const j = await resp.json();
                const tk = j && j.ticker;
                if (tk && !tk.suspended) {
                    krakenTicker = tk;
                    const markPrice = parseFloat(tk.markPrice) || 0;
                    const oiCoin = parseFloat(tk.openInterest) || 0;
                    // Bugfix (validación multi-moneda): el fundingRate de Kraken Futures
                    // es ABSOLUTO (USD por unidad); el relativo = fundingRate / markPrice.
                    // Con XRP (~$1-3) el sesgo pasaba desapercibido; con BTC daba +373%/8h.
                    const fH = markPrice > 0 ? (parseFloat(tk.fundingRate) || 0) / markPrice : 0;
                    venues.push({ name: `Kraken Futures (${coin.kraken})`, markPrice, fundingRate8hPct: fH * 8 * 100, fundingRateAnnualPct: fH * 24 * 365 * 100, openInterestXrp: oiCoin, openInterestUsd: oiCoin * markPrice });
                }
            }
        } catch (e) { console.warn(`Derivados ${coin.symbol}: Kraken no disponible:`, e.message); }
    }
    if (coin.okx) {
        try { venues.push(await fetchOkxVenueFor(coin.okx)); }
        catch (e) { console.warn(`Derivados ${coin.symbol}: OKX no disponible:`, e.message); }
    }
    if (venues.length === 0) return; // sin venue: se conserva el nodo anterior si existía

    const totalOiUsd = venues.reduce((s, v) => s + (v.openInterestUsd || 0), 0);
    const weighted8h = totalOiUsd > 0 ? venues.reduce((s, v) => s + v.fundingRate8hPct * (v.openInterestUsd || 0), 0) / totalOiUsd : venues[0].fundingRate8hPct;
    const derivatives = {
        venue: venues.length > 1 ? `Agregado ${venues.length} venues (${venues.map(v => v.name.split(' ')[0]).join(' + ')})` : venues[0].name,
        venues, venueCount: venues.length,
        markPrice: venues[0].markPrice,
        fundingRate8hPct: weighted8h,
        fundingRateAnnualPct: weighted8h * 365 * 3,
        fundingPredictionHourlyPct: krakenTicker ? (parseFloat(krakenTicker.fundingRatePrediction) || 0) * 100 : undefined,
        openInterestXrp: venues.reduce((s, v) => s + (v.openInterestXrp || 0), 0), // unidades de la MONEDA (nombre heredado)
        openInterestUsd: totalOiUsd,
        volume24hXrp: krakenTicker ? (parseFloat(krakenTicker.vol24h) || 0) : null,
        change24hPct: krakenTicker ? (parseFloat(krakenTicker.change24h) || 0) : null,
        note: `Muestra de ${venues.length} venue${venues.length > 1 ? 's' : ''} público${venues.length > 1 ? 's' : ''} — no es el mercado global de derivados.`,
        lastUpdated: new Date().toISOString()
    };
    await withDataFile(d => { d.coins = d.coins || {}; d.coins[coin.id] = d.coins[coin.id] || {}; d.coins[coin.id].derivatives = derivatives; });
}

// --- Volumen por exchange (CoinGecko tickers) ---
async function fetchCoinExchangeVolume(coin) {
    const resp = await coingeckoFetch(`https://api.coingecko.com/api/v3/coins/${coin.id}/tickers?include_exchange_logo=false`);
    if (!resp.ok) throw new Error(`tickers HTTP ${resp.status}`);
    const j = await resp.json();
    const tickers = (j && Array.isArray(j.tickers)) ? j.tickers : [];
    if (tickers.length === 0) return;
    const byExchange = new Map();
    tickers.forEach(t => {
        const name = t.market && t.market.name ? t.market.name : 'Desconocido';
        const vol = t.converted_volume && t.converted_volume.usd ? t.converted_volume.usd : 0;
        byExchange.set(name, (byExchange.get(name) || 0) + vol);
    });
    const totalVolumeUsd = Array.from(byExchange.values()).reduce((a, b) => a + b, 0);
    const top = Array.from(byExchange.entries())
        .map(([name, volumeUsd]) => ({ name, volumeUsd, pct: totalVolumeUsd > 0 ? parseFloat(((volumeUsd / totalVolumeUsd) * 100).toFixed(2)) : 0 }))
        .sort((a, b) => b.volumeUsd - a.volumeUsd)
        .slice(0, 10);
    const exchangeVolume = { top, totalVolumeUsd, exchangeCount: byExchange.size, source: `CoinGecko /coins/${coin.id}/tickers`, lastUpdated: new Date().toISOString() };
    await withDataFile(d => { d.coins = d.coins || {}; d.coins[coin.id] = d.coins[coin.id] || {}; d.coins[coin.id].exchangeVolume = exchangeVolume; });
}

// --- Noticias (CryptoPanic por símbolo → fallback RSS de Cointelegraph por tag,
//     el mismo mecanismo rss2json que usa la ruta XRP; sin IA en fase 1) ---
async function fetchCoinNews(coin) {
    try {
        let items = [];
        if (CRYPTOPANIC_TOKEN) {
            try {
                const response = await fetchWithTimeout(`https://cryptopanic.com/api/v1/posts/?auth_token=${CRYPTOPANIC_TOKEN}&currencies=${coin.symbol}&kind=news`);
                const j = await response.json();
                if (j && Array.isArray(j.results)) {
                    items = j.results.slice(0, 12).map(item => ({
                        title: item.title,
                        url: item.url,
                        published_at: item.published_at,
                        description: item.votes ? `Relevancia: ${item.votes.positive || 0} 👍` : ''
                    }));
                }
            } catch (e) { console.warn(`CryptoPanic ${coin.symbol}:`, e.message); }
        }
        if (items.length === 0 && coin.ctTag) {
            const resp = await fetchWithTimeout(`https://api.rss2json.com/v1/api.json?rss_url=https://cointelegraph.com/rss/tag/${coin.ctTag}`);
            const j = await resp.json();
            if (j && Array.isArray(j.items)) {
                const fifteenDaysAgo = new Date(Date.now() - 15 * 86400000);
                items = j.items
                    .filter(item => new Date(item.pubDate) >= fifteenDaysAgo)
                    .slice(0, 10)
                    .map(item => ({
                        title: item.title || 'Noticia de Mercado',
                        url: item.link || '#',
                        published_at: item.pubDate || new Date().toISOString(),
                        description: item.content ? item.content.replace(/<[^>]*>?/gm, '').substring(0, 120) + '...' : ''
                    }));
            }
        }
        if (items.length > 0) {
            await withDataFile(d => { d.coins = d.coins || {}; d.coins[coin.id] = d.coins[coin.id] || {}; d.coins[coin.id].newsFeed = items; });
        }
    } catch (e) { console.warn(`Noticias de ${coin.symbol} no disponibles:`, e.message); }
}

// --- Brief bilingüe genérico (subset del buildDailyBrief de XRP) ---
async function buildCoinBrief(coin) {
    try {
        const data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
        const node = (data.coins && data.coins[coin.id]) || {};
        const am = node.advancedMetrics || {};
        const price = (node.marketData && node.marketData.price) || 0;
        const señales = [];

        if (am.trend && am.trend.sma200 != null) {
            const above = am.trend.priceVsSma200Pct >= 0;
            señales.push({
                area: 'Tendencia de fondo', areaEn: 'Major trend', tone: above ? 'pos' : 'neg',
                text: above
                    ? `Precio ${am.trend.priceVsSma200Pct.toFixed(1)}% POR ENCIMA de la media de 200 días: la tendencia mayor es alcista.`
                    : `Precio ${Math.abs(am.trend.priceVsSma200Pct).toFixed(1)}% POR DEBAJO de la media de 200 días: la tendencia mayor sigue bajista.`,
                textEn: above
                    ? `Price ${am.trend.priceVsSma200Pct.toFixed(1)}% ABOVE the 200-day average: the major trend is bullish.`
                    : `Price ${Math.abs(am.trend.priceVsSma200Pct).toFixed(1)}% BELOW the 200-day average: the major trend remains bearish.`
            });
        }
        if (am.momentum && am.momentum.macdHistogram != null) {
            const macdPos = am.momentum.macdHistogram > 0;
            const rsi = am.momentum.rsi14;
            const rsiTxt = rsi != null ? ` RSI en ${rsi.toFixed(0)}.` : '';
            const rsiTxtEn = rsi != null ? ` RSI at ${rsi.toFixed(0)}.` : '';
            señales.push({
                area: 'Momentum', areaEn: 'Momentum', tone: macdPos ? 'pos' : 'neg',
                text: (macdPos ? 'MACD positivo: el impulso de corto plazo favorece a los compradores.' : 'MACD negativo: el impulso de corto plazo sigue vendedor.') + rsiTxt,
                textEn: (macdPos ? 'Positive MACD: short-term momentum favors buyers.' : 'Negative MACD: short-term momentum remains with sellers.') + rsiTxtEn
            });
        }
        if (data.sentiment && data.sentiment.value != null) {
            const v = data.sentiment.value;
            let tone = 'info';
            let txt = `Fear & Greed en ${v} (neutral): el sentimiento del mercado cripto no da señal contraria.`;
            let txtEn = `Fear & Greed at ${v} (neutral): crypto market sentiment gives no contrarian signal.`;
            if (v <= 25) { tone = 'pos'; txt = `Fear & Greed en ${v} (miedo extremo): señal contraria que vigilan los compradores pacientes.`; txtEn = `Fear & Greed at ${v} (extreme fear): a contrarian signal patient buyers watch.`; }
            else if (v >= 75) { tone = 'warn'; txt = `Fear & Greed en ${v} (codicia extrema): históricamente precede correcciones.`; txtEn = `Fear & Greed at ${v} (extreme greed): historically precedes corrections.`; }
            señales.push({ area: 'Sentimiento', areaEn: 'Sentiment', tone, text: txt + ' (Índice global del mercado cripto.)', textEn: txtEn + ' (Global crypto market index.)' });
        }
        if (node.derivatives && node.derivatives.fundingRate8hPct != null) {
            const f8 = node.derivatives.fundingRate8hPct;
            let tone = 'info', txt = `Funding ≈ ${f8.toFixed(4)}%/8h (neutro).`, txtEn = `Funding ≈ ${f8.toFixed(4)}%/8h (neutral).`;
            if (f8 > 0.01) { tone = 'warn'; txt = `Funding positivo (${f8.toFixed(4)}%/8h): optimismo apalancado, vulnerable a barridos.`; txtEn = `Positive funding (${f8.toFixed(4)}%/8h): leveraged optimism, vulnerable to sweeps.`; }
            else if (f8 < -0.01) { tone = 'pos'; txt = `Funding negativo (${f8.toFixed(4)}%/8h): pesimismo saturado que a veces precede rebotes.`; txtEn = `Negative funding (${f8.toFixed(4)}%/8h): saturated pessimism that sometimes precedes bounces.`; }
            señales.push({ area: 'Derivados', areaEn: 'Derivatives', tone, text: txt, textEn: txtEn });
        }
        if (node.orderFlow && node.orderFlow.buyPercent != null) {
            const bp = node.orderFlow.buyPercent;
            señales.push({
                area: 'Presión spot', areaEn: 'Spot pressure',
                tone: bp > 55 ? 'pos' : (bp < 45 ? 'neg' : 'info'),
                text: bp > 55 ? `Compradores dominan el spot de Binance (${bp}% del volumen taker).` : bp < 45 ? `Vendedores dominan el spot de Binance (${(100 - bp).toFixed(2)}% del volumen taker).` : `Spot equilibrado en Binance (${bp}% compras): sin señal direccional.`,
                textEn: bp > 55 ? `Buyers dominate Binance spot (${bp}% of taker volume).` : bp < 45 ? `Sellers dominate Binance spot (${(100 - bp).toFixed(2)}% of taker volume).` : `Balanced spot on Binance (${bp}% buys): no directional signal.`
            });
        }
        if (am.risk && am.risk.volatility30dAnnualizedPct > 90) {
            señales.push({ area: 'Riesgo', areaEn: 'Risk', tone: 'warn',
                text: `Volatilidad anualizada de ${am.risk.volatility30dAnnualizedPct.toFixed(0)}%: dimensiona posiciones con cautela (VaR diario 95%: ${am.risk.var95DailyPct}%).`,
                textEn: `Annualized volatility of ${am.risk.volatility30dAnnualizedPct.toFixed(0)}%: size positions carefully (daily 95% VaR: ${am.risk.var95DailyPct}%).` });
        }

        const pos = señales.filter(s => s.tone === 'pos').length;
        const neg = señales.filter(s => s.tone === 'neg').length;
        let tone = 'info';
        let headline = 'Contexto mixto: señales contradictorias, sin ventaja clara para ninguna dirección.';
        let headlineEn = 'Mixed context: contradictory signals, no clear edge in either direction.';
        if (pos - neg >= 2) { tone = 'pos'; headline = 'El conjunto de señales se inclina ALCISTA a corto plazo — recuerda que ninguna señal es garantía.'; headlineEn = 'The overall signals lean BULLISH short-term — remember no signal is a guarantee.'; }
        else if (neg - pos >= 2) { tone = 'neg'; headline = 'El conjunto de señales se inclina BAJISTA — el contexto pide más prudencia de lo habitual.'; headlineEn = 'The overall signals lean BEARISH — the context calls for extra caution.'; }

        const t = node.technicals || {};
        const niveles = {
            soporte: t.support || null,
            resistencia: t.resistance || null,
            psicologico: psychologicalLevel(price),
            nota: 'Soporte/resistencia calculados sobre los últimos 7 días; el nivel psicológico es la cifra redonda que el mercado vigila.',
            notaEn: 'Support/resistance computed over the last 7 days; the psychological level is the round number the market watches.'
        };
        const now = Date.now();
        const ageMin = (iso) => iso ? Math.round((now - new Date(iso).getTime()) / 60000) : null;
        const fuentes = [
            [`Precio ${coin.symbol} (CoinGecko)`, `${coin.symbol} price (CoinGecko)`, node.marketData && node.marketData.lastUpdated],
            ['Sentimiento (Alternative.me)', 'Sentiment (Alternative.me)', data.sentiment && data.sentiment.lastUpdated],
            ['Presión spot (Binance)', 'Spot pressure (Binance)', node.orderFlow && node.orderFlow.lastUpdated],
            ['Derivados (Kraken/OKX)', 'Derivatives (Kraken/OKX)', node.derivatives && node.derivatives.lastUpdated],
            ['Volumen por exchange (CoinGecko)', 'Volume by exchange (CoinGecko)', node.exchangeVolume && node.exchangeVolume.lastUpdated]
        ];
        const dataQuality = fuentes.filter(f => f[2] !== undefined).map(([name, nameEn, iso]) => ({ source: name, sourceEn: nameEn, ageMinutes: ageMin(iso), stale: iso ? ageMin(iso) > 20 : true }));

        const dailyBrief = { headline, headlineEn, tone, señales, niveles, dataQuality, generatedAt: new Date().toISOString() };
        await withDataFile(d => { d.coins = d.coins || {}; d.coins[coin.id] = d.coins[coin.id] || {}; d.coins[coin.id].dailyBrief = dailyBrief; });
    } catch (e) {
        console.error(`Error generando brief de ${coin.symbol}:`, e.message);
    }
}

// --- Orquestador por moneda: FASE A (rápida, lo esencial) + FASE B (resto) ---
async function refreshCoinGeneric(id, { fastOnly = false } = {}) {
    const coin = coinById(id);
    if (!coin || coin.legacy) return; // XRP va por su ciclo de siempre
    const delay = (ms) => new Promise(r => setTimeout(r, ms));
    try {
        // FASE A — mercado + gráfica/técnicos/métricas/proyecciones + brief
        await fetchCoinMarket(coin);
        await delay(2000);
        await fetchCoinChartAndMetrics(coin);
        await buildCoinBrief(coin);
        await withDataFile(d => { d.coins = d.coins || {}; d.coins[coin.id] = d.coins[coin.id] || {}; d.coins[coin.id].lastFastAt = new Date().toISOString(); });
        if (fastOnly) return;

        // FASE B — presión spot, derivados, volumen, noticias (+ brief actualizado)
        await delay(1500);
        try { await fetchCoinOrderFlow(coin); } catch (e) { console.warn(`OrderFlow ${coin.symbol}:`, e.message); }
        await delay(1500);
        try { await fetchCoinDerivatives(coin); } catch (e) { console.warn(`Derivados ${coin.symbol}:`, e.message); }
        await delay(2500);
        try { await fetchCoinExchangeVolume(coin); } catch (e) { console.warn(`Volumen ${coin.symbol}:`, e.message); }
        await delay(1500);
        await fetchCoinNews(coin);
        await buildCoinBrief(coin);
        await withDataFile(d => { d.coins = d.coins || {}; d.coins[coin.id] = d.coins[coin.id] || {}; d.coins[coin.id].lastCycleAt = new Date().toISOString(); });
        console.log(`Multi-moneda: ciclo completo de ${coin.symbol} terminado.`);
    } catch (e) {
        console.error(`Multi-moneda: fallo refrescando ${coin.symbol}:`, e.message);
    }
}

// --- Ciclo multi-moneda: activa cada 5 min + una de fondo por ciclo (~30 min el resto) ---
async function multiCoinCycle() {
    if (genericRefreshInProgress) return;
    genericRefreshInProgress = true;
    try {
        if (activeGenericCoin) await refreshCoinGeneric(activeGenericCoin);

        // Rotación de fondo: una moneda no-activa por ciclo, si está obsoleta (>25 min)
        const rotables = COINS.filter(c => !c.legacy && c.id !== activeGenericCoin);
        if (rotables.length > 0) {
            const coin = rotables[coinRotationIdx % rotables.length];
            coinRotationIdx++;
            let stale = true;
            try {
                const data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
                const last = data.coins && data.coins[coin.id] && data.coins[coin.id].lastCycleAt;
                stale = !last || (Date.now() - new Date(last).getTime()) > 25 * 60000;
            } catch (e) { /* si no se puede leer, refrescar */ }
            if (stale) await refreshCoinGeneric(coin.id);
        }
    } finally {
        genericRefreshInProgress = false;
    }
}

async function refreshAllData() {
    if (refreshInProgress) {
        console.warn('refreshAllData ya está en curso: se omite este disparo para evitar dobles escrituras.');
        return;
    }
    refreshInProgress = true;
    console.log('--- Iniciando Actualización de Datos ---');
    const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));
    try {
        await fetchMarketData();
        await delay(2500);

        await fetchOnChainData();
        await delay(2500);

        await fetchChartData();
        await delay(2000);

        await calculateTechnicals();
        await delay(1000);

        await fetchSentimentData();
        await delay(1000);

        await fetchOrderFlowData();
        await delay(1000);

        await fetchExchangeVolumeData(); // V2.2: volumen spot por exchange (roadmap #14)
        await delay(3000); // Bugfix: más margen antes del siguiente tramo denso en llamadas a CoinGecko (BTC+ETH)

        await calculateAdvancedMetrics();
        await delay(2000);

        await fetchDerivativesData();   // V2.0: funding + open interest (Kraken Futures)
        await delay(1000);

        // Bugfix (v2.2): con las llamadas nuevas a CoinGecko de este ciclo (ETH para
        // correlación, tickers para volumen por exchange) se vio "sin datos de
        // CoinGecko" aquí en la primera verificación en vivo — rate-limit del free
        // tier por ráfaga de llamadas. Se sube el delay previo de 1s a 3s para dar
        // más margen; fetchEcosystemData ya conserva el nodo anterior si falla.
        await delay(2000);
        await fetchEcosystemData();     // V2.0: dominancias + RLUSD (CoinGecko)
        await delay(1000);

        await fetchRlusdSplitData();    // V2.2: split RLUSD XRPL vs Ethereum (roadmap #12)
        await delay(500);

        await fetchAmmDexData();        // V2.2: actividad AMM/DEX on-chain (roadmap #13)
        await delay(1000);

        await fetchEscrowOnChainData(); // V2.2: escrow real leído del XRPL (roadmap #3)
        await delay(500);

        await updateEvents();
        await calculateProjections();
        await fetchNewsData();
        await refreshTrackedWalletsFromWellKnown(); // wallets reales (solo la primera vez)
        await fetchWhaleData();
        await fetchSupplyDistributionData();
        await fetchBurnImpactData();

        await buildDailyBrief();        // V2.0: veredicto en lenguaje llano (tab Resumen)
        await appendDailyHistorySnapshot(); // V2.2: snapshot diario en history.json (roadmap #6)

        console.log('--- Ciclo de Actualización Completado ---');
    } catch (error) {
        console.error('Error durante la actualización de datos:', error);
    } finally {
        refreshInProgress = false;
    }
}

// Inicializar todos los datos al arrancar de forma secuencial y segura
(async () => {
    // Solo sembramos si data.json no existe o no tiene whaleTracker
    let needsSeed = true;
    try {
        if (fs.existsSync(DATA_FILE)) {
            const currentData = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
            if (currentData.whaleTracker && currentData.whaleTracker.largeTransfers && currentData.whaleTracker.largeTransfers.length > 0) {
                needsSeed = false;
            }
        }
    } catch (e) {}

    if (needsSeed) {
        seedWhaleTrackerMockData();
    }

    // V2.0: sanear montos imposibles heredados de versiones con el bug de unidades
    sanitizeWhaleData();

    // V2.5: restaurar la moneda activa entre reinicios (persistida en data.json)
    try {
        const cur = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
        if (cur.activeCoin && coinById(cur.activeCoin) && !coinById(cur.activeCoin).legacy) {
            activeGenericCoin = cur.activeCoin;
            console.log(`Multi-moneda: moneda activa restaurada → ${coinById(cur.activeCoin).symbol}`);
        }
    } catch (e) { /* sin estado previo */ }

    await refreshAllData();

    // V2.5: ciclo multi-moneda desfasado ~2,5 min del ciclo XRP para no chocar
    // con sus ráfagas de CoinGecko (comparten el mismo rate limit del free tier).
    setTimeout(() => {
        multiCoinCycle();
        setInterval(multiCoinCycle, 300000);
    }, 150000);
})();

// Auto-Refresh: Programar la ejecución en bucle cada 5 minutos (300000ms)
setInterval(async () => {
    console.log('--- Iniciando Refresh Automático ---');
    await refreshAllData();
}, 300000);

// Servir la carpeta estática "public" donde estará el frontend
app.use(express.static(path.join(__dirname, 'public')));

// Endpoint GET /api/data - Envía el contenido del JSON al frontend
// V2.3: requiere sesión — el dashboard entero queda detrás del sign-in.
app.get('/api/data', requireAuth, (req, res) => {
    try {
        const rawData = fs.readFileSync(DATA_FILE, 'utf8');
        // Parseamos y volvemos a enviarlo como JSON
        const data = JSON.parse(rawData);
        res.json(data);
    } catch (error) {
        console.error('Error leyendo data.json:', error);
        res.status(500).json({ error: 'No se pudo leer la base de datos local JSON' });
    }
});

// Endpoint GET /api/chart/:days - Obtiene historial dinámico de precios
// V2.5: acepta ?coin=<coingeckoId> — sin parámetro sigue siendo XRP (compat).
app.get('/api/chart/:days', requireAuth, async (req, res) => {
    try {
        const days = req.params.days;
        const coinId = req.query.coin && coinById(req.query.coin) ? req.query.coin : 'ripple';
        const response = await coingeckoFetch(`https://api.coingecko.com/api/v3/coins/${coinId}/market_chart?vs_currency=usd&days=${days}`);
        const apiData = await response.json();

        if (apiData && apiData.prices) {
            // Actualizar el nodo correspondiente (V2.0: escritura serializada).
            // XRP mantiene su chartData top-level; el resto escribe en coins.<id>.
            if (coinId === 'ripple') {
                await withDataFile(d => { d.chartData = apiData.prices; });
            } else {
                await withDataFile(d => {
                    d.coins = d.coins || {};
                    d.coins[coinId] = d.coins[coinId] || {};
                    d.coins[coinId].chartData = apiData.prices;
                });
            }
            res.json(apiData.prices);
        } else {
            res.status(400).json({ error: 'Estructura inválida de CoinGecko' });
        }
    } catch (error) {
        console.error('Error fetching dynamic chart:', error);
        res.status(500).json({ error: 'Error del servidor consultando la API de CoinGecko' });
    }
});

// ============================================================
// V2.5 — Endpoints multi-moneda
// ============================================================

// Lista de monedas soportadas + capacidades por moneda (para pintar el selector
// y que el frontend sepa qué tarjetas tienen fuente de datos).
app.get('/api/coins', requireAuth, (req, res) => {
    res.json({
        active: activeGenericCoin || 'ripple',
        coins: COINS.map(c => ({
            id: c.id, symbol: c.symbol, name: c.name,
            iso20022: c.iso20022, legacy: !!c.legacy,
            hasOrderFlow: !!c.binance || !!c.legacy,
            hasDerivatives: !!(c.kraken || c.okx) || !!c.legacy
        }))
    });
});

// Activa una moneda: la marca como prioritaria para el ciclo y, si sus datos
// están fríos, dispara un refresco inmediato (FASE A síncrona para que la UI
// tenga algo que pintar; FASE B sigue en segundo plano).
app.post('/api/coins/activate', requireAuth, async (req, res) => {
    try {
        const id = req.body && req.body.id;
        const coin = coinById(id);
        if (!coin) return res.status(400).json({ error: 'Moneda no soportada.' });

        activeGenericCoin = coin.legacy ? null : coin.id;
        await withDataFile(d => { d.activeCoin = coin.legacy ? null : coin.id; });

        if (coin.legacy) return res.json({ ok: true, coin: coin.id, refreshed: false });

        // ¿Datos fríos? (sin FASE A o con más de 5 min)
        let needsFast = true;
        try {
            const data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
            const last = data.coins && data.coins[coin.id] && data.coins[coin.id].lastFastAt;
            needsFast = !last || (Date.now() - new Date(last).getTime()) > 5 * 60000;
        } catch (e) { /* refrescar */ }

        if (needsFast) {
            await refreshCoinGeneric(coin.id, { fastOnly: true }); // ~2 llamadas, unos segundos
            refreshCoinGeneric(coin.id).catch(() => { /* FASE B en segundo plano */ });
        }
        res.json({ ok: true, coin: coin.id, refreshed: needsFast });
    } catch (error) {
        console.error('Error activando moneda:', error);
        res.status(500).json({ error: 'No se pudo activar la moneda.' });
    }
});

// Endpoint GET /api/wallet-history/:address - Obtiene historial de cuenta
app.get('/api/wallet-history/:address', requireAuth, async (req, res) => {
    try {
        const address = req.params.address;
        const rawData = fs.readFileSync(DATA_FILE, 'utf8');
        const data = JSON.parse(rawData);

        // Verificar cache (10 minutos)
        const cached = data.whaleTracker.walletHistoryCache[address];
        if (cached && (new Date() - new Date(cached.timestamp) < 600000)) {
            console.log(`Usando cache para ${address}`);
            return res.json(cached.data);
        }

        const history = await fetchWalletHistory(address);
        res.json(history);
    } catch (error) {
        console.error('Error fetching wallet history:', error);
        res.status(500).json({ error: 'No se pudo obtener el historial de la cuenta' });
    }
});

// Endpoint GET /api/history - Snapshots diarios acumulados (roadmap #6)
app.get('/api/history', requireAuth, (req, res) => {
    try {
        res.json(readHistoryFile());
    } catch (error) {
        console.error('Error leyendo history.json:', error);
        res.status(500).json({ error: 'No se pudo leer el histórico diario' });
    }
});

// Endpoint POST /api/whale-threshold - Umbral de "transferencia grande" configurable
// desde la UI (roadmap #9) sin tocar código. Persiste en whaleTracker.threshold vía
// withDataFile y dispara un refresco inmediato del Whale Tracker para feedback rápido.
app.post('/api/whale-threshold', requireAuth, async (req, res) => {
    try {
        const threshold = parseFloat(req.body && req.body.threshold);
        if (!isFinite(threshold) || threshold <= 0) {
            return res.status(400).json({ error: 'El umbral debe ser un número positivo de XRP.' });
        }
        await withDataFile(d => {
            d.whaleTracker = d.whaleTracker || {};
            d.whaleTracker.threshold = threshold;
        });
        fetchWhaleData().catch(e => console.error('Error refrescando Whale Tracker tras cambiar umbral:', e.message));
        res.json({ success: true, threshold });
    } catch (error) {
        console.error('Error guardando umbral whale:', error);
        res.status(500).json({ error: 'No se pudo guardar el umbral.' });
    }
});

let lastRefreshTime = 0;
const REFRESH_COOLDOWN_MS = 30000; // 30 segundos de cooldown

// Endpoint POST /api/refresh - Ejecuta un refresco de datos en el servidor
app.post('/api/refresh', requireAuth, async (req, res) => {
    const now = Date.now();
    if (now - lastRefreshTime < REFRESH_COOLDOWN_MS) {
        const waitSec = Math.ceil((REFRESH_COOLDOWN_MS - (now - lastRefreshTime)) / 1000);
        return res.status(429).json({ error: `Por favor espera ${waitSec} segundos antes de refrescar de nuevo.` });
    }

    lastRefreshTime = now;
    console.log('--- Iniciando Actualización Manual Solicitada ---');
    try {
        await refreshAllData();
        res.json({ success: true, message: 'Datos actualizados correctamente' });
    } catch (error) {
        console.error('Error en refresh manual:', error);
        res.status(500).json({ error: 'No se pudo refrescar la información' });
    }
});

// V2.6 — GET /health: liveness check SIN autenticación (lo consultan pm2 y el
// Cloudflare Tunnel, que no tienen sesión). No expone datos de usuario: solo si el
// proceso vive, qué motor de BD hay y si los ciclos de datos están corriendo.
app.get('/health', (req, res) => {
    let lastCycleAt = null;
    try {
        const d = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
        lastCycleAt = (d.marketData && d.marketData.lastUpdated) || null;
    } catch (e) { /* si no se puede leer, se reporta como null */ }
    res.json({
        ok: true,
        uptimeSeconds: Math.round(process.uptime()),
        db: dbLayer.getEngine(),
        lastCycleAt,
        burnWatcher: burnWatcherSnapshot ? 'active' : 'starting'
    });
});

// Ruta principal para servir index.html
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Iniciar el servidor
const server = app.listen(PORT, HOST, () => {
    console.log(`USCashout Markets (crypto dashboard) v2.7 running on http://${HOST}:${PORT}${IS_PROD ? ' (modo PRODUCCIÓN: cookie Secure + HSTS)' : ''}`);
});

// ===== V2.6: ROBUSTEZ DEL PROCESO (necesario para correr bajo pm2) =====
// Antes, un rechazo de promesa no capturado en cualquier fetcher podía tumbar el
// proceso entero y dejar el dashboard caído hasta un reinicio manual. Ahora se
// registra y el servidor SIGUE VIVO: un fallo de una API externa no debe matar la app.
process.on('unhandledRejection', (reason) => {
    console.error('⚠️ Promesa rechazada sin capturar (el servidor sigue vivo):', reason && reason.message ? reason.message : reason);
});
process.on('uncaughtException', (err) => {
    console.error('⚠️ Excepción no capturada (el servidor sigue vivo):', err && err.message ? err.message : err);
});

// Cierre limpio: al parar (pm2 stop / Ctrl+C) se deja de aceptar peticiones y se
// espera a que termine la escritura de data.json en curso, para no dejar un .tmp
// a medias ni un data.json corrupto.
let shuttingDown = false;
async function gracefulShutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n${signal} recibido — cerrando ordenadamente...`);
    server.close(() => console.log('Servidor HTTP cerrado.'));
    try {
        await _dataFileLock; // espera la escritura pendiente (cola de withDataFile)
        console.log('Escrituras de data.json completadas.');
    } catch (e) { /* ya se loguea dentro de withDataFile */ }
    setTimeout(() => process.exit(0), 500).unref();
}
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));