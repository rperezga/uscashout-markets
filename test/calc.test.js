// V2.2 (roadmap #16): tests de las funciones puras de cálculo financiero.
// Ejecutar con: npm test  (usa node --test, sin dependencias nuevas).
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
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
} = require('../lib/calc');

// ---------- amountToXrp ----------
test('amountToXrp: string en drops se convierte a XRP', () => {
    assert.equal(amountToXrp('257256000000'), 257256);
});

test('amountToXrp: number en drops se convierte a XRP', () => {
    assert.equal(amountToXrp(1000000), 1);
});

test('amountToXrp: objeto {currency:"XRP", value} viene en DROPS (bug real de XRPScan)', () => {
    // Verificado contra la API real: un Payment de 257.256 XRP llega como value=257256000000
    assert.equal(amountToXrp({ currency: 'XRP', value: '257256000000' }), 257256);
});

test('amountToXrp: objeto de otra currency (IOU/token) no es XRP -> 0', () => {
    assert.equal(amountToXrp({ currency: 'USD', value: '1000', issuer: 'rSomeIssuer' }), 0);
});

test('amountToXrp: null/undefined/0 -> 0', () => {
    assert.equal(amountToXrp(null), 0);
    assert.equal(amountToXrp(undefined), 0);
    assert.equal(amountToXrp(0), 0);
});

test('amountToXrp: tope de sanidad de 2B XRP descarta montos imposibles (bug real: "10,7 billones" en pantalla)', () => {
    // Escrow más grande conocido es 1B; cualquier cosa muy por encima de 2B es un
    // error de unidades en la fuente (drops sin dividir, etc.), no un pago real.
    const drops3B = (3e9 * 1e6).toString(); // 3B XRP expresados (mal) en drops-de-drops
    assert.equal(amountToXrp(drops3B), 0);
    assert.equal(amountToXrp({ currency: 'XRP', value: (3e9 * 1e6).toString() }), 0);
});

test('amountToXrp: justo por debajo del tope (2B) sí se acepta', () => {
    const justUnder = (1.9e9 * 1e6).toString(); // 1.9B XRP en drops
    assert.equal(amountToXrp(justUnder), 1.9e9);
});

test('amountToXrp: montos negativos se descartan', () => {
    assert.equal(amountToXrp('-1000000'), 0);
});

// ---------- _dailyReturns / _mean / _stdDev ----------
test('_dailyReturns: retornos porcentuales entre días consecutivos', () => {
    const r = _dailyReturns([100, 110, 99]);
    assert.equal(r.length, 2);
    assert.ok(Math.abs(r[0] - 0.10) < 1e-9);
    assert.ok(Math.abs(r[1] - (-0.10)) < 1e-9);
});

test('_mean: media simple, array vacío -> 0', () => {
    assert.equal(_mean([1, 2, 3, 4]), 2.5);
    assert.equal(_mean([]), 0);
});

test('_stdDev: desviación estándar muestral, <2 elementos -> 0', () => {
    assert.equal(_stdDev([1]), 0);
    assert.ok(Math.abs(_stdDev([2, 4, 4, 4, 5, 5, 7, 9]) - 2.138089935) < 1e-6);
});

// ---------- _smaLast ----------
test('_smaLast: media de los últimos N valores', () => {
    assert.equal(_smaLast([1, 2, 3, 4, 5], 3), 4); // (3+4+5)/3
    assert.equal(_smaLast([1, 2], 5), null); // no hay suficientes datos
});

// ---------- _emaArray (base de MACD) ----------
test('_emaArray: null hasta tener "period" datos, luego EMA', () => {
    const values = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    const ema = _emaArray(values, 3);
    assert.equal(ema[0], null);
    assert.equal(ema[1], null);
    assert.ok(ema[2] !== null); // primer valor calculable = mean(values.slice(0,3))
    assert.equal(ema[2], 2); // mean(1,2,3)
    assert.equal(ema.length, values.length);
});

test('_emaArray: MACD = EMA12 - EMA26 requiere suficiente historia (sanity vía composición)', () => {
    const prices = Array.from({ length: 30 }, (_, i) => 100 + i); // tendencia alcista simple
    const ema12 = _emaArray(prices, 12);
    const ema26 = _emaArray(prices, 26);
    const last = prices.length - 1;
    assert.ok(ema12[last] !== null && ema26[last] !== null);
    // En una tendencia alcista sostenida, la EMA corta (12) debe ir por delante de la larga (26)
    assert.ok(ema12[last] > ema26[last]);
});

// ---------- _rsiWilder ----------
test('_rsiWilder: sin datos suficientes -> null', () => {
    assert.equal(_rsiWilder([1, 2, 3], 14), null);
});

test('_rsiWilder: subida constante -> RSI 100 (sin pérdidas)', () => {
    const prices = Array.from({ length: 20 }, (_, i) => 100 + i); // siempre sube
    assert.equal(_rsiWilder(prices, 14), 100);
});

test('_rsiWilder: caída constante -> RSI cercano a 0', () => {
    const prices = Array.from({ length: 20 }, (_, i) => 200 - i); // siempre baja
    const rsi = _rsiWilder(prices, 14);
    assert.ok(rsi < 1);
});

test('_rsiWilder: precios planos -> RSI 100 (implementación trata "sin pérdidas" como fuerza compradora total, incluso sin ganancias)', () => {
    // Nota: avgLosses === 0 devuelve 100 en la implementación actual, sin distinguir
    // "todo sube" de "no se mueve nada". Es el comportamiento real de la función, no
    // un caso que deba dar 50 — este test documenta ese edge case explícitamente.
    const prices = new Array(20).fill(100);
    assert.equal(_rsiWilder(prices, 14), 100);
});

// ---------- _maxDrawdown ----------
test('_maxDrawdown: caída desde el máximo, expresado negativo en %', () => {
    // Sube a 100 (pico), cae a 50 -> drawdown -50%
    const dd = _maxDrawdown([80, 100, 90, 50, 60]);
    assert.equal(dd, -50);
});

test('_maxDrawdown: serie siempre creciente -> 0 (nunca hay caída desde el pico)', () => {
    assert.equal(_maxDrawdown([10, 20, 30, 40]), 0);
});

// ---------- _pearson ----------
test('_pearson: correlación perfecta positiva -> 1', () => {
    const a = [1, 2, 3, 4, 5, 6];
    const b = [2, 4, 6, 8, 10, 12];
    assert.ok(Math.abs(_pearson(a, b) - 1) < 1e-9);
});

test('_pearson: correlación perfecta negativa -> -1', () => {
    const a = [1, 2, 3, 4, 5, 6];
    const b = [12, 10, 8, 6, 4, 2];
    assert.ok(Math.abs(_pearson(a, b) - (-1)) < 1e-9);
});

test('_pearson: menos de 5 puntos -> null (muestra insuficiente)', () => {
    assert.equal(_pearson([1, 2, 3], [1, 2, 3]), null);
});

test('_pearson: varianza cero en una serie -> null (evita división por 0)', () => {
    assert.equal(_pearson([1, 1, 1, 1, 1], [1, 2, 3, 4, 5]), null);
});

// ---------- _percentile (base del VaR 95%) ----------
test('_percentile: percentil 5 (VaR 95% diario) sobre retornos ordenados', () => {
    const sorted = [-10, -5, -2, -1, 0, 1, 2, 3, 4, 5].sort((x, y) => x - y);
    // idx = (10-1)*0.05 = 0.45 -> interpola entre sorted[0]=-10 y sorted[1]=-5:
    // -10 + (-5 - -10) * 0.45 = -10 + 2.25 = -7.75
    const p5 = _percentile(sorted, 0.05);
    assert.ok(Math.abs(p5 - (-7.75)) < 1e-9);
});

test('_percentile: array vacío -> 0', () => {
    assert.equal(_percentile([], 0.05), 0);
});

test('_percentile: percentil 0 y 1 devuelven los extremos', () => {
    const sorted = [1, 2, 3, 4, 5];
    assert.equal(_percentile(sorted, 0), 1);
    assert.equal(_percentile(sorted, 1), 5);
});
