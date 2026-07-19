// ============================================================
// lib/calc.js — funciones puras de cálculo financiero/estadístico.
// V2.2 (roadmap #16): extraídas de server.js SOLO estas funciones puras
// (sin I/O, sin fs, sin fetch, sin estado global) para poder testearlas con
// `node --test` sin arrancar el servidor completo. El resto de server.js
// (fetchers, endpoints, ciclo de refresco) sigue como monolito a propósito —
// esa modularización más grande es el roadmap #20, y se hace al final,
// después de tener tests que la respalden.
//
// server.js hace `require('./lib/calc')` y usa estas mismas funciones:
// no hay dos copias divergentes del mismo cálculo.
// ============================================================

// BUGFIX CRÍTICO (unidades): normaliza el campo Amount de XRPScan/XRPL a XRP.
// - String: drops crudos del XRPL → dividir por 1e6.
// - Number: drops numéricos → dividir por 1e6.
// - Objeto {currency:'XRP', value}: XRPScan devuelve value EN DROPS → dividir por 1e6.
//   Verificado contra la API real: un Payment de 257.256 XRP llega como value=257256000000.
//   Antes NO se dividía y el dashboard mostraba volúmenes imposibles (billones de XRP).
// - Objeto de otra currency (token/IOU): no es XRP → 0 (se ignora en métricas whale).
// V2.0 SANIDAD: ningún pago real supera 2B XRP (el mayor movimiento recurrente es el
// escrow de Ripple, 1B). Si tras normalizar el número sigue siendo mayor, la unidad
// venía mal de la fuente → se descarta (0) en lugar de contaminar los KPIs.
function amountToXrp(Amount) {
    if (!Amount) return 0;
    let xrp = 0;
    if (typeof Amount === 'string') xrp = parseFloat(Amount) / 1e6;
    else if (typeof Amount === 'number') xrp = Amount / 1e6;
    else {
        if (Amount.currency && Amount.currency !== 'XRP') return 0;
        const v = parseFloat(Amount.value || 0);
        xrp = isNaN(v) ? 0 : v / 1e6;
    }
    if (!isFinite(xrp) || xrp < 0 || xrp > 2e9) return 0;
    return xrp;
}

function _dailyReturns(prices) {
    const r = [];
    for (let i = 1; i < prices.length; i++) {
        if (prices[i - 1] > 0) r.push(prices[i] / prices[i - 1] - 1);
    }
    return r;
}

function _mean(arr) { return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0; }

function _stdDev(arr) {
    if (arr.length < 2) return 0;
    const m = _mean(arr);
    return Math.sqrt(arr.reduce((s, v) => s + (v - m) * (v - m), 0) / (arr.length - 1));
}

function _smaLast(values, period) {
    if (values.length < period) return null;
    return _mean(values.slice(-period));
}

function _emaArray(values, period) {
    // Devuelve array alineado con `values` (null hasta tener `period` datos)
    const out = new Array(values.length).fill(null);
    if (values.length < period) return out;
    const k = 2 / (period + 1);
    let ema = _mean(values.slice(0, period));
    out[period - 1] = ema;
    for (let i = period; i < values.length; i++) {
        ema = values[i] * k + ema * (1 - k);
        out[i] = ema;
    }
    return out;
}

function _rsiWilder(prices, period = 14) {
    if (prices.length < period + 1) return null;
    let gains = 0, losses = 0;
    for (let i = 1; i <= period; i++) {
        const d = prices[i] - prices[i - 1];
        if (d >= 0) gains += d; else losses -= d;
    }
    let avgG = gains / period, avgL = losses / period;
    for (let i = period + 1; i < prices.length; i++) {
        const d = prices[i] - prices[i - 1];
        avgG = (avgG * (period - 1) + Math.max(d, 0)) / period;
        avgL = (avgL * (period - 1) + Math.max(-d, 0)) / period;
    }
    if (avgL === 0) return 100;
    return 100 - 100 / (1 + avgG / avgL);
}

function _maxDrawdown(prices) {
    let peak = prices[0], maxDD = 0;
    for (const p of prices) {
        if (p > peak) peak = p;
        const dd = (p - peak) / peak;
        if (dd < maxDD) maxDD = dd;
    }
    return maxDD * 100; // negativo, en %
}

function _pearson(a, b) {
    const n = Math.min(a.length, b.length);
    if (n < 5) return null;
    const x = a.slice(-n), y = b.slice(-n);
    const mx = _mean(x), my = _mean(y);
    let num = 0, dx = 0, dy = 0;
    for (let i = 0; i < n; i++) {
        num += (x[i] - mx) * (y[i] - my);
        dx += (x[i] - mx) ** 2;
        dy += (y[i] - my) ** 2;
    }
    if (dx === 0 || dy === 0) return null;
    return num / Math.sqrt(dx * dy);
}

function _percentile(sortedArr, p) {
    if (!sortedArr.length) return 0;
    const idx = (sortedArr.length - 1) * p;
    const lo = Math.floor(idx), hi = Math.ceil(idx);
    if (lo === hi) return sortedArr[lo];
    return sortedArr[lo] + (sortedArr[hi] - sortedArr[lo]) * (idx - lo);
}

module.exports = {
    amountToXrp,
    _dailyReturns,
    _mean,
    _stdDev,
    _smaLast,
    _emaArray,
    _rsiWilder,
    _maxDrawdown,
    _pearson,
    _percentile
};
