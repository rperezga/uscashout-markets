// xrplBurnWatcher.js
// Sigue total_coins del XRPL via WebSocket (con fallback REST) y construye
// histórico horario de XRP quemados (fees burned). Hasta 7 días (168h).
//
// Uso:
//   const { startBurnWatcher } = require('./xrplBurnWatcher');
//   const watcher = startBurnWatcher({
//       onUpdate: (snapshot) => { ... persist to data.json ... }
//   });
//
// El callback `onUpdate(snapshot)` se llama:
//   - Cuando se calcula un nuevo burn (cada ~30s)
//   - Cuando se sella un bucket horario
//
// snapshot:
// {
//   mode: 'websocket' | 'rest' | 'starting' | 'failed',
//   lastEventAt: ISOString,
//   lastTotalCoins: number (en XRP, no drops),
//   lastLedgerBurn: number,        // XRP quemados desde la medición previa
//   lastLedgerIndex: number | null,
//   ratePerSec: number,            // XRP/s estimado a partir del último delta
//   hourly: [ { hourStart: ISO, burned: number, samples: int } ],  // 7 días
//   lastHourBurned: number,        // suma del bucket actual (parcial) + previo cerrado
//   last24hBurned: number,         // suma últimas 24 horas
//   dailyAvgBurn: number,          // promedio diario (de hourly disponible)
// }

const https = require('https');

const XRPL_WS_ENDPOINTS = [
    'wss://xrplcluster.com',
    'wss://s2.ripple.com',
    'wss://xrpl.ws'
];
const XRPL_HTTPS_ENDPOINT = 'https://xrplcluster.com/';

const MAX_HOURS = 7 * 24;                  // 168 horas = 7 días
const SAMPLE_INTERVAL_MS = 30 * 1000;      // pedir server_info cada 30s
const REST_POLL_INTERVAL_MS = 60 * 1000;   // fallback REST cada 60s
const WS_RECONNECT_MAX_DELAY = 60 * 1000;  // backoff máximo

function hourBucketKey(d = new Date()) {
    const x = new Date(d);
    x.setMinutes(0, 0, 0);
    return x.toISOString();
}

function startBurnWatcher({ onUpdate, log = console.log }) {
    let WS;
    try { WS = require('ws'); } catch (e) {
        log('[xrplBurnWatcher] ⚠️ paquete "ws" no instalado. Solo modo REST disponible.');
        WS = null;
    }

    const state = {
        mode: 'starting',
        lastEventAt: null,
        lastTotalCoins: null,
        lastLedgerBurn: 0,
        lastLedgerIndex: null,
        ratePerSec: 0,
        hourly: [],             // [{ hourStart, burned, samples, seeded? }]
        lastHourBurned: 0,      // solo buckets REALES
        last24hBurned: 0,       // solo buckets REALES
        dailyAvgBurn: 0,        // solo buckets REALES (0 si aún no hay data real)
        seeded: false,          // true si el gráfico contiene buckets sembrados (estimados)
    };

    // Recalcula métricas derivadas usando SOLO buckets reales.
    // HONESTIDAD DE DATOS: los buckets sembrados existen para que el gráfico no
    // arranque vacío, pero jamás deben contar como "quema real" (antes el server
    // los tomaba como dailyAvgBurn real y etiquetaba el KPI como "Real (24h)").
    function recomputeDerived(now = new Date()) {
        const realBuckets = state.hourly.filter(b => !b.seeded);
        const currentKey = hourBucketKey(now);
        const cur = realBuckets.find(b => b.hourStart === currentKey);
        state.lastHourBurned = cur ? cur.burned : 0;

        const since24h = now.getTime() - 24 * 3600 * 1000;
        state.last24hBurned = realBuckets
            .filter(b => new Date(b.hourStart).getTime() >= since24h)
            .reduce((s, b) => s + b.burned, 0);

        if (realBuckets.length > 0) {
            const totalBurned = realBuckets.reduce((s, b) => s + b.burned, 0);
            state.dailyAvgBurn = (totalBurned / realBuckets.length) * 24;
        } else {
            state.dailyAvgBurn = 0;
        }

        state.seeded = state.hourly.some(b => b.seeded);
    }

    // ===== Helpers de bucket =====
    function seedInitialHourlyData() {
        if (state.hourly && state.hourly.length > 0) return;

        log('[xrplBurnWatcher] 🌱 Sembrando buckets ESTIMADOS (marcados seeded) para que el gráfico no arranque vacío...');
        const now = new Date();
        const baseHourlyBurn = 102; // ~2450 XRP / 24 horas (promedio histórico aproximado)

        for (let i = 24; i >= 1; i--) {
            const t = new Date(now.getTime() - i * 3600 * 1000);
            t.setMinutes(0, 0, 0);
            const key = t.toISOString();
            // Variación aleatoria (+/- 20%) solo con fines visuales; va marcado como seeded
            const randomVariance = (Math.random() * 40 - 20) / 100;
            const burned = parseFloat((baseHourlyBurn * (1 + randomVariance)).toFixed(2));
            state.hourly.push({
                hourStart: key,
                burned: burned,
                samples: 0,
                seeded: true
            });
        }

        state.hourly.sort((a, b) => a.hourStart.localeCompare(b.hourStart));
        recomputeDerived(now);
    }

    function recordSample(totalCoinsXRP, ledgerIndex) {
        const now = new Date();
        if (state.lastTotalCoins != null) {
            const delta = state.lastTotalCoins - totalCoinsXRP;
            // delta < 0 puede pasar por escrow release? Pero total_coins sólo baja en mainnet.
            // Ignoramos deltas negativos o absurdamente grandes para evitar ruido.
            if (delta > 0 && delta < 1_000_000) {
                state.lastLedgerBurn = delta;
                const elapsedSec = state.lastEventAt
                    ? Math.max(1, (now.getTime() - new Date(state.lastEventAt).getTime()) / 1000)
                    : 30;
                state.ratePerSec = delta / elapsedSec;

                // Asignar al bucket horario actual
                const key = hourBucketKey(now);
                let bucket = state.hourly.find(b => b.hourStart === key);
                if (!bucket) {
                    bucket = { hourStart: key, burned: 0, samples: 0, seeded: false };
                    state.hourly.push(bucket);
                }
                // Si el bucket actual era sembrado, lo reiniciamos: a partir de ahora es data real
                if (bucket.seeded) {
                    bucket.burned = 0;
                    bucket.samples = 0;
                    bucket.seeded = false;
                }
                bucket.burned += delta;
                bucket.samples += 1;

                // Trim a últimos 168 buckets
                state.hourly.sort((a, b) => a.hourStart.localeCompare(b.hourStart));
                if (state.hourly.length > MAX_HOURS) {
                    state.hourly = state.hourly.slice(-MAX_HOURS);
                }
            }
        }
        state.lastTotalCoins = totalCoinsXRP;
        state.lastLedgerIndex = ledgerIndex ?? state.lastLedgerIndex;
        state.lastEventAt = now.toISOString();

        // Recomputar derivados (solo buckets reales)
        recomputeDerived(now);

        if (typeof onUpdate === 'function') {
            try { onUpdate(getSnapshot()); }
            catch (e) { log('[xrplBurnWatcher] onUpdate error:', e.message); }
        }
    }

    function getSnapshot() {
        return JSON.parse(JSON.stringify(state));
    }

    function injectSeed(seed) {
        // Permite restaurar buckets desde data.json al reinicio
        if (!seed || !Array.isArray(seed.hourly) || seed.hourly.length === 0) {
            seedInitialHourlyData();
            return;
        }
        state.hourly = seed.hourly.slice(-MAX_HOURS);
        if (seed.lastTotalCoins) state.lastTotalCoins = seed.lastTotalCoins;
        if (seed.lastEventAt)    state.lastEventAt = seed.lastEventAt;
        if (seed.lastLedgerIndex)state.lastLedgerIndex = seed.lastLedgerIndex;

        // Recomputar derivados a partir del seed inyectado (solo buckets reales)
        recomputeDerived(new Date());
    }

    // ===== WebSocket =====
    let ws = null;
    let wsAlive = false;
    let wsReconnectDelay = 2000;
    let wsTimer = null;
    let wsEndpointIdx = 0;
    let nextReqId = 1;

    // Bugfix: esta función se invocaba en los handlers de close/error pero no
    // existía, provocando ReferenceError y dejando el watcher muerto tras la
    // primera desconexión. Implementa backoff exponencial + fallback REST.
    let reconnectPending = false;
    function scheduleReconnect() {
        if (reconnectPending) return;
        reconnectPending = true;
        // Mientras el WS está caído, mantener datos vía REST
        startRestPolling();
        const delay = wsReconnectDelay;
        wsReconnectDelay = Math.min(wsReconnectDelay * 2, WS_RECONNECT_MAX_DELAY);
        log(`[xrplBurnWatcher] Reintentando WebSocket en ${Math.round(delay / 1000)}s...`);
        setTimeout(() => {
            reconnectPending = false;
            wsConnect();
        }, delay);
    }

    function wsConnect() {
        if (!WS) return startRestPolling();
        const url = XRPL_WS_ENDPOINTS[wsEndpointIdx % XRPL_WS_ENDPOINTS.length];
        wsEndpointIdx++;
        log(`[xrplBurnWatcher] Conectando WebSocket a ${url}...`);
        try {
            ws = new WS(url, { handshakeTimeout: 10000 });
        } catch (e) {
            log('[xrplBurnWatcher] Error creando WS:', e.message);
            scheduleReconnect();
            return;
        }

        ws.on('open', () => {
            log('[xrplBurnWatcher] ✅ WebSocket conectado a', url);
            wsAlive = true;
            wsReconnectDelay = 2000;
            state.mode = 'websocket';
            // Pedir info de ledger inmediato y luego cada 30s
            requestLedgerInfo();
            clearInterval(wsTimer);
            wsTimer = setInterval(requestLedgerInfo, SAMPLE_INTERVAL_MS);
            // Cancelar polling REST si estaba activo
            stopRestPolling();
        });

        ws.on('message', (raw) => {
            try {
                const msg = JSON.parse(raw.toString());
                handleWSMessage(msg);
            } catch (e) {
                // ignorar
            }
        });

        ws.on('close', () => {
            log('[xrplBurnWatcher] WebSocket cerrado.');
            wsAlive = false;
            clearInterval(wsTimer);
            wsTimer = null;
            scheduleReconnect();
        });

        ws.on('error', (err) => {
            log('[xrplBurnWatcher] WS error:', err.message);
            wsAlive = false;
            try { ws.terminate(); } catch(e) {}
        });
    }

    function requestLedgerInfo() {
        if (!ws || !wsAlive) return;
        try {
            ws.send(JSON.stringify({
                id: nextReqId++,
                command: 'ledger',
                ledger_index: 'validated'
            }));
        } catch(e) { /* ignore */ }
    }

    function handleWSMessage(msg) {
        // Respuesta a ledger
        if (msg.type === 'response' && msg.status === 'success' && msg.result?.ledger) {
            const ledger = msg.result.ledger;
            const seq = parseInt(ledger.ledger_index, 10);
            const totalCoinsRaw = parseFloat(ledger.total_coins);
            if (seq && !isNaN(totalCoinsRaw)) {
                const xrp = totalCoinsRaw > 1e15 ? totalCoinsRaw / 1e6 : totalCoinsRaw;
                recordSample(xrp, seq);
            }
        }
    }

    // ===== Fallback REST =====
    let restTimer = null;
    function startRestPolling() {
        if (restTimer) return;
        log('[xrplBurnWatcher] Iniciando polling REST cada 60s.');
        pollRest();
        restTimer = setInterval(pollRest, REST_POLL_INTERVAL_MS);
    }
    function stopRestPolling() {
        if (restTimer) {
            clearInterval(restTimer);
            restTimer = null;
            log('[xrplBurnWatcher] Polling REST detenido (WS activo).');
        }
    }

    function pollRest() {
        const body = JSON.stringify({
            method: 'ledger',
            params: [{ ledger_index: 'validated' }]
        });
        const req = https.request(XRPL_HTTPS_ENDPOINT, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': body.length },
            timeout: 10000
        }, (res) => {
            let data = '';
            res.on('data', c => data += c);
            res.on('end', () => {
                try {
                    const j = JSON.parse(data);
                    if (j.result && j.result.status === 'success' && j.result.ledger) {
                        const ledger = j.result.ledger;
                        const seq = parseInt(ledger.ledger_index, 10);
                        const totalCoinsRaw = parseFloat(ledger.total_coins);
                        if (seq && !isNaN(totalCoinsRaw)) {
                            const xrp = totalCoinsRaw > 1e15 ? totalCoinsRaw / 1e6 : totalCoinsRaw;
                            if (state.mode !== 'websocket') state.mode = 'rest';
                            recordSample(xrp, seq);
                        }
                    }
                } catch (e) { /* ignore */ }
            });
        });
        req.on('error', e => log('[xrplBurnWatcher] REST error:', e.message));
        req.on('timeout', () => req.destroy());
        req.write(body);
        req.end();
    }

    // ===== Boot =====
    log('[xrplBurnWatcher] Iniciando watcher (WS preferido, REST fallback).');
    
    // Si al arrancar no hay nada, sembramos datos iniciales para la UI
    if (state.hourly.length === 0) {
        seedInitialHourlyData();
    }

    if (WS) {
        wsConnect();
    } else {
        state.mode = 'rest';
        startRestPolling();
    }

    return {
        getSnapshot,
        injectSeed,
        stop() {
            try { ws && ws.close(); } catch(e) {}
            clearInterval(wsTimer);
            clearInterval(restTimer);
        }
    };
}

module.exports = { startBurnWatcher };
