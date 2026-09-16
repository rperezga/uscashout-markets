// USCashout Markets (dashboard cripto multi-moneda) 2.x — frontend
document.addEventListener('DOMContentLoaded', loadDashboardData);

// V2.3: shim de i18n — si i18n.js no cargó por lo que sea, t() devuelve el español
// tal cual y la UI no se rompe.
if (typeof window.t !== 'function') {
    window.t = (key, esText) => esText !== undefined ? esText : key;
    window.getLang = () => 'es';
}
const t = window.t;

// V2.4 — i18n fase 2 (textos dinámicos): helpers.
// _isEn(): ¿idioma activo inglés? · _pick(es, en): elige el campo dual que
// emite el servidor (cae al español si falta la traducción) · _dLoc(): locale
// de fechas según idioma. Los textos generados con interpolación se traducen
// inline con _isEn() ? EN : ES (más legible que un diccionario de plantillas);
// las etiquetas estáticas siguen usando t(clave, es) + diccionario EN.
const _isEn = () => window.getLang && window.getLang() === 'en';
const _pick = (es, en) => (_isEn() && en) ? en : es;
const _dLoc = () => _isEn() ? 'en-US' : 'es-ES';

// ============================================================
// V2.6 — SEGURIDAD: escapado de contenido EXTERNO antes de innerHTML
//
// Bugfix (XSS almacenado): las tarjetas de noticias se construyen con innerHTML e
// interpolaban `news.title` y la descripción TAL CUAL. Esos textos vienen de fuera
// (CryptoPanic / RSS de Cointelegraph), así que un titular con `<img src=x
// onerror=...>` ejecutaba JavaScript dentro de la sesión del usuario. Quitar tags
// con una regex NO basta (no neutraliza comillas ni atributos rotos).
//
// REGLA: todo dato que venga de una API externa (títulos, descripciones, nombres,
// símbolos) pasa por _esc() antes de ir a innerHTML. Si el dato es nuestro (números
// calculados, textos de i18n), no hace falta.
// ============================================================
function _esc(value) {
    if (value === null || value === undefined) return '';
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}
window._esc = _esc;

// Sanea una URL externa antes de meterla en un href: solo http/https.
// Bloquea `javascript:` y `data:` (un enlace malicioso en una noticia ejecutaría
// código con solo hacer clic).
function _safeUrl(url) {
    try {
        const u = new URL(String(url), window.location.origin);
        return (u.protocol === 'http:' || u.protocol === 'https:') ? u.href : '#';
    } catch (e) {
        return '#';
    }
}
window._safeUrl = _safeUrl;

// ============================================================
// V2.5 — MULTI-MONEDA (fase 1)
// XRP ('ripple') sigue leyendo los nodos top-level de data.json (ruta
// intacta); las demás monedas leen data.coins[<id>]. El registro de
// monedas llega de GET /api/coins y la selección se persiste por usuario
// (setting 'activeCoin') con localStorage como arranque rápido.
// ============================================================
window._coinsRegistry = (() => {
    // Caché del registro para que _coinSym() acierte desde el primer render
    // (el fetch de /api/coins lo refresca en cuanto hay sesión).
    try { return JSON.parse(localStorage.getItem('xrpCoinsRegistry') || '[]'); } catch (e) { return []; }
})();
window._activeCoinId = (() => { try { return localStorage.getItem('xrpActiveCoinId') || 'ripple'; } catch (e) { return 'ripple'; } })();
const _isXrpActive = () => (window._activeCoinId || 'ripple') === 'ripple';
const _coinInfo = () => window._coinsRegistry.find(c => c.id === window._activeCoinId) || { id: 'ripple', symbol: 'XRP', name: 'XRP', legacy: true };
const _coinSym = () => _coinInfo().symbol || 'XRP';

// Clase global que oculta lo XRPL-exclusivo (data-xrp-only) vía CSS
document.addEventListener('DOMContentLoaded', () => {
    document.body.classList.toggle('coin-generic', !_isXrpActive());
});

// Selector del header: se puebla una vez desde /api/coins (requiere sesión)
let _coinSelectorInited = false;
function initCoinSelector() {
    if (_coinSelectorInited) return;
    _coinSelectorInited = true;
    fetch('/api/coins').then(r => r.ok ? r.json() : null).then(j => {
        if (!j || !Array.isArray(j.coins)) { _coinSelectorInited = false; return; }
        window._coinsRegistry = j.coins;
        try { localStorage.setItem('xrpCoinsRegistry', JSON.stringify(j.coins)); } catch (e) { /* no-op */ }
        const sel = document.getElementById('coin-selector');
        if (!sel) return;
        sel.innerHTML = j.coins.map(c =>
            `<option value="${c.id}">${c.symbol} — ${c.name}${c.iso20022 ? ' · ISO 20022' : ''}</option>`
        ).join('');
        sel.value = window._activeCoinId;
        sel.style.display = '';
        sel.addEventListener('change', () => setActiveCoin(sel.value));
    }).catch(() => { _coinSelectorInited = false; });
}

async function setActiveCoin(id, opts = {}) {
    if (!id || id === window._activeCoinId) return;
    const sel = document.getElementById('coin-selector');
    window._activeCoinId = id;
    try { localStorage.setItem('xrpActiveCoinId', id); } catch (e) { /* no-op */ }
    document.body.classList.toggle('coin-generic', id !== 'ripple');
    if (sel && sel.value !== id) sel.value = id;

    // Si el tab activo es XRPL-exclusivo (Ballenas/Quema), saltar a Resumen
    if (id !== 'ripple') {
        const activeBtn = document.querySelector('.nav-btn.active');
        if (activeBtn && activeBtn.hasAttribute('data-xrp-only')) {
            const resumenBtn = document.querySelector('.nav-btn[data-tab="resumen"]');
            if (resumenBtn) resumenBtn.click();
        }
    }

    // Persistir en la cuenta (mismo criterio que el idioma)
    if (opts.persist !== false && document.getElementById('user-chip')?.style.display !== 'none') {
        saveUserSetting('activeCoin', id);
    }

    // Activar en el servidor: si la moneda está fría dispara su FASE A
    // (mercado + gráfica/métricas) de forma síncrona — unos segundos.
    if (sel) sel.disabled = true;
    try {
        await fetch('/api/coins/activate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id })
        });
    } catch (e) { console.error('No se pudo activar la moneda en el servidor:', e); }
    if (sel) sel.disabled = false;

    await loadDashboardData();
}

// Limpia secciones visibles cuya fuente no existe para la moneda activa
// (sin esto, al cambiar de moneda quedaría contenido de la anterior).
function clearStaleGenericSections(view) {
    const sinDatos = (msg) => `<p class="analysis-loading">${msg}</p>`;
    const cargando = _isEn() ? 'Loading data for this coin (first cycle takes a few seconds)...' : 'Cargando datos de esta moneda (el primer ciclo tarda unos segundos)...';
    const put = (sel, html) => { const el = document.querySelector(sel); if (el) el.innerHTML = html; };

    if (!view.marketData) { put('#market-data .card-content', sinDatos(cargando)); put('#my-crypto .card-content', sinDatos(cargando)); }
    if (!view.orderFlow) {
        // Distinguir "sin fuente" (no cotiza en Binance) de "aún no cargó" (FASE B pendiente)
        const cap = _coinInfo();
        put('#market-pressure .card-content', sinDatos(cap.hasOrderFlow === false
            ? (_isEn() ? 'No spot pressure for this coin (not listed on Binance).' : 'Sin presión spot para esta moneda (no cotiza en Binance).')
            : cargando));
    }
    if (!view.projections) put('#projections .card-content', sinDatos(cargando));
    if (!view.newsFeed) put('#news-container', sinDatos(_isEn() ? 'No news feed for this coin yet.' : 'Aún no hay feed de noticias para esta moneda.'));
    if (!view.advancedMetrics) {
        ['#analysis-score', '#analysis-insights', '#analysis-trend', '#analysis-risk', '#analysis-perf'].forEach(s => put(s, sinDatos(cargando)));
    }
}

// Suministro genérico (no-XRP): circulante/total/máximo desde CoinGecko
function renderSupplyGeneric(md) {
    const box = document.getElementById('supply-generic-content');
    if (!box) return;
    const en = _isEn();
    if (!md || md.circulatingSupply == null) {
        box.innerHTML = `<p class="analysis-loading">${en ? 'No supply data for this coin yet.' : 'Aún no hay datos de suministro para esta moneda.'}</p>`;
        return;
    }
    const sym = _coinSym();
    const circ = md.circulatingSupply, total = md.totalSupply, max = md.maxSupply;
    const base = max || total || circ;
    const pct = base > 0 ? Math.min(100, (circ / base) * 100) : 100;
    const fmtAmt = (v) => v != null ? fmtCompact(v) + ' ' + sym : '--';

    const reading = max
        ? (en
            ? readingHTML('info', `${pct.toFixed(1)}% of the max supply is already circulating`, `${sym} has a hard cap of ${fmtCompact(max)} coins. The remaining ${fmtCompact(Math.max(0, base - circ))} may be locked, unvested or not yet emitted — check the project's emission schedule before treating scarcity as a thesis.`)
            : readingHTML('info', `El ${pct.toFixed(1)}% del suministro máximo ya circula`, `${sym} tiene un tope de ${fmtCompact(max)} monedas. Las ${fmtCompact(Math.max(0, base - circ))} restantes pueden estar bloqueadas, en vesting o sin emitir — revisa el calendario de emisión del proyecto antes de usar la escasez como tesis.`))
        : (en
            ? readingHTML('warn', 'No hard max supply', `${sym} has no fixed emission cap${total ? ` (current total: ${fmtCompact(total)})` : ''}. Dilution depends on the protocol's monetary policy.`)
            : readingHTML('warn', 'Sin suministro máximo fijo', `${sym} no tiene tope de emisión fijo${total ? ` (total actual: ${fmtCompact(total)})` : ''}. La dilución depende de la política monetaria del protocolo.`));

    box.innerHTML = `
        <div class="supply-generic-kpis">
            <div class="supply-kpi">
                <span class="kpi-label">${en ? 'Circulating' : 'Circulante'}</span>
                <span class="kpi-value">${fmtAmt(circ)}</span>
                <span class="kpi-sub">${en ? 'per CoinGecko' : 'según CoinGecko'}</span>
            </div>
            <div class="supply-kpi">
                <span class="kpi-label">Total</span>
                <span class="kpi-value">${fmtAmt(total)}</span>
                <span class="kpi-sub">${en ? 'issued (incl. locked)' : 'emitido (incl. bloqueado)'}</span>
            </div>
            <div class="supply-kpi">
                <span class="kpi-label">${en ? 'Max' : 'Máximo'}</span>
                <span class="kpi-value">${max != null ? fmtAmt(max) : '∞'}</span>
                <span class="kpi-sub">${max != null ? (en ? 'hard cap' : 'tope de emisión') : (en ? 'no fixed cap' : 'sin tope fijo')}</span>
            </div>
        </div>
        <div class="supply-generic-bar" title="${en ? 'Circulating vs remaining' : 'Circulante vs restante'}">
            <div class="seg-circ" style="width:${pct}%"></div>
            <div class="seg-rest" style="width:${100 - pct}%"></div>
        </div>
        <div class="supply-legend">
            <span class="legend-item"><span class="dot" style="background:#0ea5e9;"></span> ${en ? 'Circulating' : 'Circulante'} ${pct.toFixed(1)}%</span>
            <span class="legend-item"><span class="dot" style="background:#64748b;"></span> ${en ? 'Not circulating' : 'No circulante'} ${(100 - pct).toFixed(1)}%</span>
        </div>
        ${reading}
    `;
}

// ============================================================
// LECTURAS PRÁCTICAS — componente reutilizable
// Cada gráfica del dashboard incluye una interpretación en
// lenguaje llano para que cualquier usuario sepa QUÉ significa
// lo que está viendo y QUÉ implica (siempre educativo).
// ============================================================
function readingHTML(tone, title, text) {
    // ▲/▼ en lugar de emojis de gráfica: algunos sistemas no renderizan 📈/📉
    const icons = { pos: '▲', neg: '▼', warn: '⚠️', info: '💡' };
    return `
        <div class="chart-reading reading-${tone}">
            <span class="reading-icon">${icons[tone] || '💡'}</span>
            <div class="reading-body">
                <strong>${title}</strong>
                <span>${text}</span>
            </div>
        </div>`;
}

function setReading(elementId, tone, title, text) {
    const el = document.getElementById(elementId);
    if (el) el.innerHTML = readingHTML(tone, title, text);
}

// Formateadores globales reutilizables
const _fmtUsd = (v, d = 2) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: d, maximumFractionDigits: d }).format(Number(v) || 0);
const _fmtNum = (v) => new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(Number(v) || 0);
// V2.5: precio con decimales adaptativos — 4 para monedas sub-$100 (XRP, XLM...),
// 2 para precios grandes (BTC $62,836.00, no $62,836.0000).
const _fmtPrice = (v) => _fmtUsd(v, (Number(v) || 0) >= 100 ? 2 : 4);

// V2.2 (roadmap #7): snapshots diarios de history.json, para las sparklines de
// evolución del score (Análisis) y del flujo whale (Ballenas). Se cargan aparte
// de /api/data porque viven en un archivo distinto (ver server.js, GET /api/history).
let historyCache = [];
async function loadHistoryData() {
    try {
        const r = await fetch('/api/history');
        const arr = await r.json();
        historyCache = Array.isArray(arr) ? arr : [];
    } catch (e) {
        console.error('Error cargando /api/history:', e);
        historyCache = [];
    }
}

// ============================================================
// Mi Portafolio — el valor real de lo que tienes, consolidado
// ============================================================
const PF_COLORS = ['#3b82f6', '#8b5cf6', '#22c55e', '#f59e0b', '#ef4444', '#14b8a6', '#ec4899', '#eab308', '#64748b'];
let _pfDonutInstance = null;
let _pfLoading = false;

// Cantidad flexible: XRP se lee en miles (0 dec), BTC en fracciones (6 dec).
function _fmtNumFlex(v) {
    const n = Number(v) || 0;
    const d = n >= 1000 ? 0 : (n >= 1 ? 2 : 6);
    return new Intl.NumberFormat('en-US', { maximumFractionDigits: d }).format(n);
}

async function renderPortfolio() {
    const container = document.getElementById('portfolio-container');
    if (!container || _pfLoading) return;
    _pfLoading = true;
    try {
        const resp = await fetch('/api/portfolio');
        if (resp.status === 401) { showAuthOverlay(); return; }
        if (!resp.ok) throw new Error('portfolio ' + resp.status);
        _pfRender(container, await resp.json());
    } catch (e) {
        console.error('Error cargando portafolio:', e);
        container.innerHTML = `<div class="pf-empty glass-effect"><div class="pf-empty-ico">⚠️</div><p>${_pick('No se pudo cargar el portafolio. Reintenta en un momento.', 'Could not load your portfolio. Try again in a moment.')}</p></div>`;
    } finally {
        _pfLoading = false;
    }
}

// v2.8.1: el portafolio ya NO tiene panel de edición propio. La ÚNICA fuente de las
// cantidades es "My Crypto" (pestaña Mercado, por moneda) — así hay una sola verdad y no
// dos sitios que editar. Esta vista solo LEE y consolida.

function _pfReadingText(pf) {
    const top = pf.holdings[0];
    const pos = pf.totalChange24hValue >= 0;
    const conc = top && top.allocationPct >= 60;
    if (_isEn()) {
        const dir = pos ? 'up' : 'down';
        const c = conc ? ` Your portfolio is concentrated in ${top.symbol} (${top.allocationPct.toFixed(0)}%), so its price drives most of the move.` : '';
        return `Your holdings are worth ${_fmtUsd(pf.totalValue, 2)} right now — ${dir} ${_fmtUsd(Math.abs(pf.totalChange24hValue), 2)} in the last 24h.${c}`;
    }
    const dir = pos ? 'ha subido' : 'ha bajado';
    const c = conc ? ` Está concentrado en ${top.symbol} (${top.allocationPct.toFixed(0)}%), así que su precio manda casi todo el movimiento.` : '';
    return `Lo que tienes vale ${_fmtUsd(pf.totalValue, 2)} ahora mismo — ${dir} ${_fmtUsd(Math.abs(pf.totalChange24hValue), 2)} en las últimas 24h.${c}`;
}

function _pfDrawDonut(pf) {
    const canvas = document.getElementById('pf-donut');
    if (!canvas || !window.Chart) return;
    if (_pfDonutInstance) { try { _pfDonutInstance.destroy(); } catch (e) { /* no-op */ } _pfDonutInstance = null; }
    const labels = pf.holdings.map(h => h.symbol);
    const data = pf.holdings.map(h => Math.max(h.value || 0, 0));
    const colors = pf.holdings.map((h, i) => PF_COLORS[i % PF_COLORS.length]);
    _pfDonutInstance = new Chart(canvas.getContext('2d'), {
        type: 'doughnut',
        data: { labels, datasets: [{ data, backgroundColor: colors, borderColor: 'rgba(15,23,42,0.55)', borderWidth: 2 }] },
        options: {
            responsive: false,
            cutout: '68%',
            plugins: {
                legend: { display: false },
                tooltip: { callbacks: { label: (ctx) => `${ctx.label}: ${_fmtUsd(ctx.parsed, 2)} (${((ctx.parsed / (pf.totalValue || 1)) * 100).toFixed(1)}%)` } }
            }
        }
    });
}

// ---- Rendimiento en el tiempo (v2.8.2): valor del portafolio día/semana/mes + P&L ----
let _pfPerfInstance = null;
let _pfPerfSeries = null;
let _pfPerfPnl = null;
let _pfPerfGran = 'day';

async function _pfLoadPerformance() {
    const note = document.getElementById('pf-perf-note');
    try {
        const resp = await fetch('/api/portfolio/history?range=365');
        if (!resp.ok) throw new Error('history ' + resp.status);
        const data = await resp.json();
        _pfPerfSeries = Array.isArray(data.series) ? data.series : [];
        _pfPerfPnl = data.pnl || {};
        _pfWirePerfToggle();
        _pfRenderPerformance();
    } catch (e) {
        if (note) note.textContent = _pick('No se pudo cargar el rendimiento ahora mismo.', 'Could not load performance right now.');
    }
}

function _pfWirePerfToggle() {
    document.querySelectorAll('#pf-perf-toggle .pf-gran').forEach(btn => {
        btn.addEventListener('click', () => {
            _pfPerfGran = btn.getAttribute('data-gran');
            document.querySelectorAll('#pf-perf-toggle .pf-gran').forEach(b => b.classList.toggle('active', b === btn));
            _pfRenderPerformance();
        });
    });
}

// Agrega la serie diaria a día/semana/mes (el último valor de cada periodo manda).
function _pfAggregate(series, gran) {
    if (gran === 'day') return series.slice(-60);
    const keyOf = (date) => {
        if (gran === 'month') return date.slice(0, 7); // YYYY-MM
        const d = new Date(date + 'T00:00:00Z');
        const dow = (d.getUTCDay() + 6) % 7; // lunes = 0
        d.setUTCDate(d.getUTCDate() - dow);
        return d.toISOString().slice(0, 10); // fecha del lunes de esa semana
    };
    const byKey = new Map();
    for (const pt of series) byKey.set(keyOf(pt.date), pt);
    const out = [...byKey.values()];
    return gran === 'month' ? out.slice(-12) : out.slice(-26);
}

function _pfRenderPerformance() {
    if (!_pfPerfSeries) return;
    const agg = _pfAggregate(_pfPerfSeries, _pfPerfGran);

    const row = document.getElementById('pf-pnl-row');
    if (row) {
        const chip = (label, p) => {
            if (!p) return `<div class="pf-pnl-chip"><span class="pf-pnl-lbl">${label}</span><span class="pf-pnl-val muted">—</span></div>`;
            const pos = p.abs >= 0; const sign = pos ? '+' : '−';
            return `<div class="pf-pnl-chip"><span class="pf-pnl-lbl">${label}</span><span class="pf-pnl-val ${pos ? 'pos' : 'neg'}">${sign}${_fmtUsd(Math.abs(p.abs), 2)} · ${sign}${Math.abs(p.pct).toFixed(2)}%</span></div>`;
        };
        row.innerHTML = chip('24h', _pfPerfPnl.d1) + chip('7d', _pfPerfPnl.d7) + chip('30d', _pfPerfPnl.d30) + chip(_pick('Desde inicio', 'Since start'), _pfPerfPnl.sinceStart);
    }

    const canvas = document.getElementById('pf-perf-canvas');
    if (!canvas || !window.Chart) return;
    if (_pfPerfInstance) { try { _pfPerfInstance.destroy(); } catch (e) { /* no-op */ } _pfPerfInstance = null; }
    const labels = agg.map(p => p.date);
    const values = agg.map(p => p.value);
    const up = values.length >= 2 ? values[values.length - 1] >= values[0] : true;
    const color = up ? '#22c55e' : '#ef4444';
    _pfPerfInstance = new Chart(canvas.getContext('2d'), {
        type: 'line',
        data: { labels, datasets: [{ data: values, borderColor: color, backgroundColor: color + '22', fill: true, tension: 0.25, pointRadius: 0, borderWidth: 2 }] },
        options: {
            responsive: true, maintainAspectRatio: false,
            plugins: { legend: { display: false }, tooltip: { callbacks: { label: (c) => _fmtUsd(c.parsed.y, 2) } } },
            scales: {
                x: { grid: { display: false }, ticks: { color: '#64748b', maxTicksLimit: 8, font: { size: 10 } } },
                y: { grid: { color: 'rgba(255,255,255,0.05)' }, ticks: { color: '#64748b', font: { size: 10 }, callback: (v) => '$' + Intl.NumberFormat('en-US', { notation: 'compact' }).format(v) } }
            }
        }
    });

    const note = document.getElementById('pf-perf-note');
    if (note) {
        note.textContent = _pick(
            'La curva se reconstruye con tus tenencias actuales y precios históricos; desde que registraste tus monedas se guarda tu valor real cada día.',
            'The curve is reconstructed from your current holdings and historical prices; from when you registered your coins, your real value is saved each day.'
        );
    }
}

function _pfRender(container, pf) {
    const fmtUsd = (v) => _fmtUsd(v, 2);

    // Estado vacío: aún no ha metido cantidades (se editan en Mercado → My Crypto).
    if (!pf.holdings || pf.holdings.length === 0) {
        container.innerHTML = `
            <div class="pf-hero glass-effect">
                <div class="pf-hero-main">
                    <div class="pf-hero-label">${_pick('Valor total del portafolio', 'Total portfolio value')}</div>
                    <div class="pf-hero-value">${fmtUsd(0)}</div>
                </div>
            </div>
            <div class="pf-empty glass-effect">
                <div class="pf-empty-ico">💼</div>
                <p>${_pick('Aún no has añadido cantidades. Ve a <strong>Mercado</strong>, elige cada moneda en el selector de arriba y escribe cuánto tienes en <strong>“My Crypto”</strong>. Aquí verás el total consolidado.', 'No amounts yet. Go to <strong>Market</strong>, pick each coin in the selector at the top and enter how much you hold under <strong>“My Crypto”</strong>. This page shows the consolidated total.')}</p>
            </div>
            <div class="chart-reading reading-info"><span class="reading-icon">💡</span><div class="reading-body"><strong>${_pick('Privado y por cuenta', 'Private, per account')}</strong><span>${_pick('Tus cantidades se guardan en tu cuenta, cifradas junto a tu login. Nadie más las ve.', 'Your amounts are saved to your account, alongside your login. No one else sees them.')}</span></div></div>`;
        return;
    }

    const changePos = pf.totalChange24hValue >= 0;
    const arrow = changePos ? '▲' : '▼';
    const sign = changePos ? '+' : '−';
    const updated = pf.updatedAt ? new Date(pf.updatedAt).toLocaleTimeString(_dLoc(), { hour: '2-digit', minute: '2-digit' }) : '';
    const srcLabel = pf.source === 'stored'
        ? _pick('precios en caché', 'cached prices')
        : _pick('precios en vivo', 'live prices');

    const rowsHtml = pf.holdings.map((h, i) => {
        const color = PF_COLORS[i % PF_COLORS.length];
        const chPos = (h.change24hPct || 0) >= 0;
        const chTxt = h.change24hPct == null ? '—' : `${chPos ? '+' : ''}${h.change24hPct.toFixed(2)}%`;
        return `
            <tr>
                <td><span class="pf-dot" style="background:${color}"></span><span class="pf-sym">${h.symbol}</span> <span class="pf-name">${h.name}</span></td>
                <td class="pf-num">${_fmtNumFlex(h.amount)}</td>
                <td class="pf-num">${h.price != null ? _fmtPrice(h.price) : '—'}</td>
                <td class="pf-num" style="color:${chPos ? '#22c55e' : '#ef4444'}">${chTxt}</td>
                <td class="pf-num pf-val">${h.value != null ? fmtUsd(h.value) : '—'}</td>
            </tr>`;
    }).join('');

    const legendHtml = pf.holdings.map((h, i) => {
        const color = PF_COLORS[i % PF_COLORS.length];
        return `<div class="pf-leg-item"><span class="pf-dot" style="background:${color}"></span><span class="pf-sym">${h.symbol}</span><span class="pf-leg-pct">${(h.allocationPct || 0).toFixed(1)}%</span></div>`;
    }).join('');

    container.innerHTML = `
        <div class="pf-hero glass-effect pf-hero-row">
            <div class="pf-hero-main">
                <div class="pf-hero-label">${_pick('Valor total del portafolio', 'Total portfolio value')}</div>
                <div class="pf-hero-value">${fmtUsd(pf.totalValue)}</div>
                <div class="pf-hero-change ${changePos ? 'pos' : 'neg'}">${arrow} ${sign}${fmtUsd(Math.abs(pf.totalChange24hValue))} · ${sign}${Math.abs(pf.totalChange24hPct).toFixed(2)}% <span class="pf-hero-24">(24h)</span></div>
            </div>
            <div class="pf-pnl-row" id="pf-pnl-row"></div>
        </div>

        <div class="pf-grid3">
            <section class="pf-card glass-effect pf-alloc">
                <h2>${_pick('Asignación', 'Allocation')}</h2>
                <div class="pf-alloc-body">
                    <div class="pf-donut-wrap">
                        <canvas id="pf-donut" width="210" height="210"></canvas>
                        <div class="pf-donut-center"><span class="pf-donut-total">${fmtUsd(pf.totalValue)}</span><span class="pf-donut-sub">${_pick('total', 'total')}</span></div>
                    </div>
                    <div class="pf-legend">${legendHtml}</div>
                </div>
            </section>

            <section class="pf-card glass-effect pf-holdings">
                <h2>${_pick('Tenencias', 'Holdings')}</h2>
                <div class="pf-table-wrap">
                    <table class="pf-table">
                        <thead><tr>
                            <th>${_pick('Moneda', 'Coin')}</th>
                            <th class="pf-num">${_pick('Cantidad', 'Amount')}</th>
                            <th class="pf-num">${_pick('Precio', 'Price')}</th>
                            <th class="pf-num">24h</th>
                            <th class="pf-num">${_pick('Valor', 'Value')}</th>
                        </tr></thead>
                        <tbody>${rowsHtml}</tbody>
                    </table>
                </div>
            </section>

            <section class="pf-card glass-effect pf-perf">
                <div class="pf-perf-head">
                    <h2>${_pick('Rendimiento', 'Performance')}</h2>
                    <div class="pf-perf-toggle" id="pf-perf-toggle">
                        <button data-gran="day" class="pf-gran active">${_pick('Día', 'Day')}</button>
                        <button data-gran="week" class="pf-gran">${_pick('Semana', 'Week')}</button>
                        <button data-gran="month" class="pf-gran">${_pick('Mes', 'Month')}</button>
                    </div>
                </div>
                <div class="pf-perf-chart"><canvas id="pf-perf-canvas"></canvas></div>
            </section>
        </div>

        <p class="pf-foot">
            <span class="${changePos ? 'pf-foot-pos' : 'pf-foot-neg'}">${arrow}</span> ${_pfReadingText(pf)}
            <span class="pf-foot-sep">·</span> ${_pick('Para editar cantidades: <strong>Mercado → “My Crypto”</strong>.', 'To edit amounts: <strong>Market → “My Crypto”</strong>.')}
            <span class="pf-perf-note" id="pf-perf-note"></span>
        </p>`;

    _pfDrawDonut(pf);
    _pfLoadPerformance();
}

async function loadDashboardData() {
    let data;
    try {
        const response = await fetch('/api/data');
        // V2.3: el dashboard vive detrás del sign-in — sin sesión, mostrar login.
        if (response.status === 401) {
            showAuthOverlay();
            return;
        }
        data = await response.json();
    } catch (error) {
        console.error('Error fetching/parsing /api/data:', error);
        const marketContent = document.querySelector('#market-data .card-content');
        if (marketContent) {
            marketContent.innerHTML = `<div style="color: #ef4444; padding: 1rem;">${t('err.conexionCritica', 'Error de conexión crítico. data.json inaccesible.')}</div>`;
        }
        return;
    }
    hideAuthOverlay();
    await loadHistoryData();

    // Mi Portafolio: si es el tab activo al cargar, píntalo (su fetch es independiente).
    try { if (document.getElementById('portfolio-tab')?.classList.contains('active')) renderPortfolio(); } catch (e) { /* no-op */ }

    if (!data || typeof data !== 'object') {
        console.warn("data.json está vacío o corrompido, esperando primer refresh...");
        return;
    }

    // V2.5 — multi-moneda: con una moneda no-XRP activa, el resto de la función
    // renderiza la VISTA de esa moneda (data.coins[id] + sentiment compartido)
    // reasignando la variable local. Los renderers no cambian. Las alertas
    // locales siguen vigilando XRP (rawData) a propósito — están construidas
    // sobre sus nodos técnicos y de ballenas.
    initCoinSelector();
    const rawData = data;
    if (!_isXrpActive()) {
        const node = (data.coins && data.coins[window._activeCoinId]) || {};
        data = Object.assign({}, node, { sentiment: rawData.sentiment });
        clearStaleGenericSections(data);
        try { renderSupplyGeneric(data.marketData); } catch (e) { console.error('Error renderizando suministro genérico:', e); }
    }

    // --- MARKET DATA ---
    try {
        if (data.marketData && data.marketData.price !== undefined) {
            const marketContent = document.querySelector('#market-data .card-content');
            if (marketContent) {
                const fmtUsd = (v) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 }).format(Number(v) || 0);
                const fmtPrice = _fmtPrice; // V2.5: decimales adaptativos según magnitud

                const ch = data.marketData?.priceChange24h || 0;
                const up = ch >= 0;
                const mch = data.marketData?.marketCapChange24h || 0;
                const mup = mch >= 0;

                marketContent.className = 'card-content card-content-fill';

                marketContent.innerHTML = `
                    <div class="card-row-item">
                        <div class="card-row-left">
                            <div class="card-row-label">${t('md.precio', 'Precio (USD)')}</div>
                            <div class="card-row-value-large">${fmtPrice(data.marketData?.price)}</div>
                        </div>
                        <div class="card-row-right">
                            <div class="variation-badge ${up ? 'badge-up' : 'badge-down'}">
                                <span>${up ? '▲' : '▼'}</span>
                                ${up ? '+' : ''}${ch.toFixed(2)}%
                            </div>
                            <div class="variation-time">24h</div>
                        </div>
                    </div>
                    <div class="card-row-item">
                        <div class="card-row-left">
                            <div class="card-row-label">${t('md.cap', 'Capitalización')}</div>
                            <div class="card-row-value-medium">${fmtUsd(data.marketData?.marketCap || 0)}</div>
                        </div>
                        <div class="card-row-right">
                            <div class="variation-badge ${mup ? 'badge-up' : 'badge-down'}">
                                <span>${mup ? '▲' : '▼'}</span>
                                ${mup ? '+' : ''}${mch.toFixed(2)}%
                            </div>
                            <div class="variation-time">24h</div>
                        </div>
                    </div>
                    <div class="card-row-item-col">
                        <div class="card-row-label">${t('md.vol', 'Volumen (24h)')}</div>
                        <div class="card-row-value-medium">${fmtUsd(data.marketData?.volume24h || 0)}</div>
                    </div>
                `;
            }
        }
    } catch (e) { console.error('Error renderizando Market Data:', e); }

    // --- MY CRYPTO ---
    try {
        const myCryptoContent = document.querySelector('#my-crypto .card-content');
        if (myCryptoContent && data.marketData && data.marketData.price !== undefined) {
            const price = data.marketData.price;
            // V2.3: la cantidad vive en la BD por usuario (viaja contigo entre navegadores);
            // localStorage queda como caché local y fallback pre-login.
            // V2.5: clave por moneda — XRP conserva 'myXrpAmount' (compat), el resto
            // usa 'myAmount_<coingeckoId>' (allowlist por patrón en el servidor).
            const amountKey = _isXrpActive() ? 'myXrpAmount' : ('myAmount_' + window._activeCoinId);
            const savedXrp = (window._userSettings && window._userSettings[amountKey] != null && window._userSettings[amountKey] !== '')
                ? String(window._userSettings[amountKey])
                : (localStorage.getItem(amountKey) || '');
            const xrpAmount = parseFloat(savedXrp) || 0;

            const fmtUsd = (v) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 }).format(Number(v) || 0);
            const fmtXrp = (v) => new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 }).format(Number(v) || 0);

            // Cálculos de portfolio
            const totalValue = xrpAmount * price;
            const ch24 = data.marketData?.priceChange24h || 0;
            const change24hUsd = totalValue * (ch24 / 100);

            // Proyecciones del portfolio
            const projBajista = data.projections?.bajista?.price || price * 0.85;
            const projAlcista = data.projections?.alcista?.price || price * 1.20;
            const valBajista = xrpAmount * projBajista;
            const valAlcista = xrpAmount * projAlcista;

            myCryptoContent.className = 'card-content card-content-fill';

            myCryptoContent.innerHTML = `
                <div class="my-crypto-input-row">
                    <div class="card-row-label" style="white-space:nowrap; margin-bottom:0;">${_isXrpActive() ? t('mc.mis', 'Mis XRP') : `${_isEn() ? 'My' : 'Mis'} ${_coinSym()}`}</div>
                    <input id="xrp-amount-input" type="number" min="0" step="any" value="${savedXrp}" placeholder="0" class="my-crypto-input" />
                </div>
                <div class="my-crypto-value-row">
                    <div>
                        <div class="card-row-label">${t('mc.valor', 'Valor Total')}</div>
                        <div class="card-row-value-large" id="my-total-value">${fmtUsd(totalValue)}</div>
                    </div>
                    <div style="text-align:right;">
                        <div class="card-row-label">${t('mc.cambio', 'Cambio 24h')}</div>
                        <div class="card-row-value-large" style="color:${ch24 >= 0 ? '#22c55e' : '#ef4444'}; font-size:1.1rem;" id="my-change-value">${ch24 >= 0 ? '+' : ''}${fmtUsd(change24hUsd)}</div>
                    </div>
                </div>
                <div class="my-crypto-scenarios-grid">
                    <div class="my-crypto-scenario-bajista">
                        <div class="card-row-label" style="color:#ef4444; font-weight:700;">${t('mc.escBajista', 'Escenario Bajista')}</div>
                        <div class="card-row-value-medium" id="my-proj-bajista">${fmtUsd(valBajista)}</div>
                    </div>
                    <div class="my-crypto-scenario-alcista">
                        <div class="card-row-label" style="color:#22c55e; font-weight:700;">${t('mc.escAlcista', 'Escenario Alcista')}</div>
                        <div class="card-row-value-medium" id="my-proj-alcista">${fmtUsd(valAlcista)}</div>
                    </div>
                </div>
                <div class="my-crypto-footer">
                    ${xrpAmount > 0 ? fmtXrp(xrpAmount) + ' ' + _coinSym() + ' × ' + fmtUsd(price) + '/' + _coinSym() : (_isXrpActive() ? t('mc.ingresa', 'Ingresa tu cantidad de XRP arriba') : (_isEn() ? `Enter your ${_coinSym()} amount above` : `Ingresa tu cantidad de ${_coinSym()} arriba`))}
                </div>
            `;

            const input = document.getElementById('xrp-amount-input');
            if (input) {
                input.addEventListener('input', (e) => {
                    const val = e.target.value;
                    localStorage.setItem(amountKey, val);
                    saveUserSettingDebounced(amountKey, val); // V2.3: persistir en BD por usuario
                    const amt = parseFloat(val) || 0;
                    const tv = amt * price;
                    const c24usd = tv * (ch24 / 100);
                    const vB = amt * projBajista;
                    const vA = amt * projAlcista;

                    const el = (id) => document.getElementById(id);
                    if (el('my-total-value')) el('my-total-value').textContent = fmtUsd(tv);
                    if (el('my-change-value')) el('my-change-value').textContent = (ch24 >= 0 ? '+' : '') + fmtUsd(c24usd);
                    if (el('my-proj-bajista')) el('my-proj-bajista').textContent = fmtUsd(vB);
                    if (el('my-proj-alcista')) el('my-proj-alcista').textContent = fmtUsd(vA);

                    const summary = input.closest('.card-content').querySelector('div:last-child');
                    if (summary) {
                        summary.textContent = amt > 0 ? fmtXrp(amt) + ' ' + _coinSym() + ' × ' + fmtUsd(price) + '/' + _coinSym() : (_isXrpActive() ? t('mc.ingresa', 'Ingresa tu cantidad de XRP arriba') : (_isEn() ? `Enter your ${_coinSym()} amount above` : `Ingresa tu cantidad de ${_coinSym()} arriba`));
                    }
                });
                // v2.8.1: al salir del campo (blur/Enter) se guarda YA, sin debounce — la fuente
                // única de las tenencias del portafolio es este campo, así que no se puede perder.
                input.addEventListener('change', (e) => { saveUserSetting(amountKey, String(e.target.value || '').trim()); });
            }
        }
    } catch (e) { console.error('Error renderizando My Crypto:', e); }

    // --- ON-CHAIN DATA ---
    try {
        if (data.onChainData && data.onChainData.currentLedger !== undefined) {
            const onChainContent = document.querySelector('#onchain-data .card-content');
            if (onChainContent) {
                const formatNumber = (val) => new Intl.NumberFormat('en-US').format(Number(val) || 0);
                  // Helper para renderizar variaciones
                 const renderVariation = (val) => {
                     const up = val >= 0;
                     return `
                        <div class="card-row-right">
                            <div class="variation-badge ${up ? 'badge-up' : 'badge-down'}" style="padding: 0.15rem 0.4rem; font-size: 0.7rem;">
                                <span>${up ? '▲' : '▼'}</span>
                                ${up ? '+' : ''}${val.toFixed(2)}%
                            </div>
                            <div class="variation-time">24H</div>
                        </div>
                     `;
                 };

                 onChainContent.className = 'card-content card-content-fill';

                 onChainContent.innerHTML = `
                     <div class="card-row-item-col">
                         <div class="card-row-label" style="margin-bottom: 0.1rem;">${t('oc.ledger', 'Ledger Actual')}</div>
                         <div class="card-row-value-large">#${formatNumber(data.onChainData?.currentLedger)}</div>
                     </div>
                     <div class="card-row-item">
                         <div>
                             <div class="card-row-label" style="margin-bottom: 0.1rem;">${t('oc.tps', 'TPS Promedio (24h)')}</div>
                             <div class="card-row-value-medium">${data.onChainData?.tps !== undefined ? data.onChainData.tps.toFixed(2) : '0.00'}</div>
                         </div>
                         ${renderVariation(data.onChainData?.tpsChange24h || 0)}
                     </div>
                     <div class="card-row-item">
                         <div>
                             <div class="card-row-label" style="margin-bottom: 0.1rem;">${t('oc.cuentas', 'Cuentas Activas (24h)')}${data.onChainData?.activeAddressesEstimated ? ` <span class="badge-estimated-inline" title="${t('oc.estTitle', 'La API de métricas de XRPScan no respondió: valor aproximado derivado del TPS')}">${t('badge.estimado', '≈ estimado')}</span>` : ''}</div>
                             <div class="card-row-value-medium">${formatNumber(data.onChainData?.activeAddresses || 0)}</div>
                         </div>
                         ${renderVariation(data.onChainData?.activeAddressesChange24h || 0)}
                     </div>
                     <div class="card-row-item-col">
                         <div class="card-row-label" style="margin-bottom: 0.1rem;">Supply (XRP)</div>
                         <div class="card-row-value-medium">${formatNumber(data.onChainData?.totalCoins || 0)}</div>
                     </div>
                 `;
            }
        }
    } catch (e) { console.error('Error renderizando On-Chain Data:', e); }

    // --- CHART DATA INICIAL ---
    try {
        if (Array.isArray(data.chartData) && data.chartData.length > 0) {
            const activeBtn = document.querySelector('.timeline-btn.active');
            let days = '365';
            if (activeBtn) days = activeBtn.getAttribute('data-days');
            // BUGFIX: el ciclo de refresco reescribe chartData a 365d — renderizar
            // SIEMPRE recortando a la ventana del botón activo (antes, con "1M"
            // activo se pintaba el año entero etiquetado como 1 mes).
            renderPriceChartForWindow(data.chartData, days);
        }
    } catch (e) { console.error('Error renderizando Chart inicial:', e); }

    // --- MARKET PRESSURE (BUY/SELL) ---
    try {
        if (data.orderFlow) {
            const pressureContent = document.querySelector('#market-pressure .card-content');
            if (pressureContent) {
                const flow = data.orderFlow;
                const buyPct = flow.buyPercent || 0;
                const sellPct = flow.sellPercent || 0;
                const formatVol = (v) => new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(v || 0);
                const formatUsd = (v) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(v || 0);

                // Lectura práctica: diferencia neta en USD + qué implica el porcentaje
                const netUsd = (flow.buyValueUsd || 0) - (flow.sellValueUsd || 0);
                const fmtNetUsd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(Math.abs(netUsd));

                let interpretationText = _isEn()
                    ? `Balanced market: buys and sells nearly even (difference of ${fmtNetUsd}). No clear directional signal.`
                    : `Mercado equilibrado: compras y ventas casi parejas (diferencia de ${fmtNetUsd}). Sin señal direccional clara.`;
                let interpretationClass = 'interpretation-neutral';
                if (buyPct > 55) {
                    interpretationText = _isEn()
                        ? `Buy pressure dominates: ${fmtNetUsd} more was bought than sold in 24h (Binance spot). Sustained readings >55% often accompany bullish stretches.`
                        : `Predomina presión compradora: se compraron ${fmtNetUsd} más de lo que se vendió en 24h (Binance spot). Lecturas >55% sostenidas suelen acompañar tramos alcistas.`;
                    interpretationClass = 'interpretation-buy';
                } else if (sellPct > 55) {
                    interpretationText = _isEn()
                        ? `Sell pressure dominates: ${fmtNetUsd} more was sold than bought in 24h (Binance spot). Watch the supports if this reading persists.`
                        : `Predomina presión vendedora: se vendieron ${fmtNetUsd} más de lo que se compró en 24h (Binance spot). Vigila los soportes si la lectura se mantiene.`;
                    interpretationClass = 'interpretation-sell';
                }

                pressureContent.style.height = '100%';

                pressureContent.innerHTML = `
                    <div style="text-align: center; margin-bottom: 0.2rem;">
                        <span style="background: rgba(255,255,255,0.05); padding: 0.15rem 0.5rem; border-radius: 20px; font-size: 0.6rem; color: #94a3b8; font-weight: 600; text-transform: uppercase;">
                            ${_isEn() ? 'Last 24 hours' : (flow.timeWindow || '24 Horas')}
                        </span>
                    </div>

                    <div style="display: flex; justify-content: space-between; font-size: 0.75rem; font-weight: 800; margin-bottom: 0.2rem;">
                        <span style="color: #22c55e;">BUY ${buyPct}%</span>
                        <span style="color: #ef4444;">SELL ${sellPct}%</span>
                    </div>

                    <div class="pressure-bar-container" style="margin: 0.3rem 0; height: 10px;">
                        <div class="pressure-bar-buy" style="width: ${buyPct}%"></div>
                        <div class="pressure-bar-sell" style="width: ${sellPct}%"></div>
                    </div>

                    <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 0.4rem;">
                        <div class="stat-item" style="padding: 0.4rem; display: flex; flex-direction: column; justify-content: center;">
                            <div class="stat-label" style="font-size: 0.45rem;">${t('of.compras', 'Compras')}</div>
                            <div class="stat-value" style="font-size: 0.8rem; line-height: 1.1;">${formatUsd(flow.buyValueUsd)}</div>
                            <div style="font-size: 0.55rem; color: #64748b;">${formatVol(flow.buyVolume)} ${_coinSym()}</div>
                        </div>
                        <div class="stat-item" style="padding: 0.4rem; display: flex; flex-direction: column; justify-content: center;">
                            <div class="stat-label" style="font-size: 0.45rem;">${t('of.ventas', 'Ventas')}</div>
                            <div class="stat-value" style="font-size: 0.8rem; line-height: 1.1;">${formatUsd(flow.sellValueUsd)}</div>
                            <div style="font-size: 0.55rem; color: #64748b;">${formatVol(flow.sellVolume)} ${_coinSym()}</div>
                        </div>
                    </div>

                    <div class="interpretation-text ${interpretationClass}" style="font-size: 0.7rem; padding: 0.35rem; margin-top: 0.1rem;">
                        ${interpretationText}
                    </div>
                `;
            }
        }
    } catch (e) { console.error('Error renderizando Market Pressure:', e); }

    // --- EVENTS & NEWS ---
    try {
        if (data.events || data.newsFeed) {
            const escrowTimer = document.getElementById('escrow-timer');
            const newsContainer = document.getElementById('news-container');
            const eventsUpdated = document.getElementById('events-last-updated');

            if (escrowTimer && newsContainer) {
                // V2.4: el layout del feed vive en CSS (#news-container, página Noticias
                // con grid fluido). Antes se forzaba flex-column inline aquí porque el
                // feed era una card compacta del tab Mercado — ese inline pisaba el CSS.

                let newsHTML = `<div style="font-size: 0.65rem; color: #94a3b8; text-align: center; padding: 0.5rem 0;">${t('news.vacio', 'No hay noticias disponibles.')}</div>`;
                
                if (Array.isArray(data.newsFeed) && data.newsFeed.length > 0) {
                    // Guardar noticias globalmente para el modal
                    window.currentNews = data.newsFeed;

                    // Función compartida para determinar sentimiento si el backend no lo trae
                    window.getNewsSentiment = (news) => {
                        if (news.sentiment && news.sentiment !== "NEUTRO") return news.sentiment;
                        
                        const text = (news.title + " " + (news.description || "")).toLowerCase();
                        const pos = ["bullish", "growth", "partnership", "victory", "win", "adoption", "launch", "ath", "pump", "success", "listing", "alcista", "sube"].some(k => text.includes(k));
                        const neg = ["bearish", "crash", "lawsuit", "sec", "drop", "hack", "dump", "investigation", "fines", "bajista", "cae", "clausura", "cierre", "misled"].some(k => text.includes(k));
                        
                        if (pos) return "POSITIVO";
                        if (neg) return "NEGATIVO";
                        return "NEUTRO";
                    };

                    newsHTML = data.newsFeed.map((news, idx) => {
                        const en = _isEn();
                        let timeStr = t('news.hacePoco', 'Hace poco');
                        if (news.published_at) {
                            const diffMs = new Date() - new Date(news.published_at);
                            const diffHrs = Math.floor(diffMs / (1000 * 60 * 60));
                            const diffMins = Math.floor(diffMs / (1000 * 60));
                            const diffDays = Math.floor(diffHrs / 24);

                            if (diffDays > 0) timeStr = en ? `${diffDays}d ago` : `Hace ${diffDays}d`;
                            else if (diffHrs > 0) timeStr = en ? `${diffHrs}h ago` : `Hace ${diffHrs}h`;
                            else if (diffMins > 0) timeStr = en ? `${diffMins}m ago` : `Hace ${diffMins}m`;
                            else if (diffMins < 0) timeStr = t('news.hacePoco', 'Hace poco');
                        }

                        let sentiment = window.getNewsSentiment(news);
                        // Los valores internos siguen en ES (POSITIVO/NEGATIVO/NEUTRO);
                        // solo se traduce lo que se MUESTRA.
                        const sentDisplay = { POSITIVO: t('sent.pos', 'POSITIVO'), NEGATIVO: t('sent.neg', 'NEGATIVO'), NEUTRO: t('sent.neu', 'NEUTRO') }[sentiment] || sentiment;
                        let sentColor = "#94a3b8";
                        let sentIcon = "●";

                        if (sentiment === "POSITIVO") {
                            sentColor = "#22c55e"; sentIcon = "▲";
                        } else if (sentiment === "NEGATIVO") {
                            sentColor = "#ef4444"; sentIcon = "▼";
                        }

                        // V2.6 (seguridad): el texto viene de una API externa → se quitan
                        // los tags Y se escapa. La regex sola no protegía de un XSS.
                        const cleanDesc = _esc((news.description || "").replace(/<[^>]*>?/gm, ''));
                        const safeTitle = _esc(news.title || '');

                        // V2.0: distinguir noticias de XRP directo vs contexto macro (BTC/regulación)
                        const isMacro = news.xrpRelated === false;

                        return `
                        <div onclick="openNewsModal(${idx})" class="news-card" style="cursor: pointer; background: rgba(255,255,255,0.03); padding: 0.7rem 0.9rem; border-radius: 10px; border: 1px solid rgba(255,255,255,0.06); display: flex; flex-direction: column; gap: 0.4rem; transition: all 0.2s ease; margin-bottom: 0.5rem; width: 100%; box-sizing: border-box;">
                            <div style="display: flex; justify-content: space-between; align-items: flex-start; gap: 0.8rem;">
                                <div style="flex: 1;">
                                    <div style="font-size: 0.8rem; font-weight: 700; color: #f8fafc; line-height: 1.4; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; margin-bottom: 0.2rem;">
                                        ${isMacro ? `<span class="badge-macro" title="${t('news.macroTitle', 'No es una noticia de XRP: se incluye por su impacto en todo el mercado')}">${t('news.macro', 'CONTEXTO MACRO')}</span> ` : ''}${safeTitle || t('news.sinTitulo', 'Análisis de Impacto')}
                                    </div>
                                    ${cleanDesc ? `<div style="font-size: 0.65rem; color: #94a3b8; line-height: 1.5; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;">${cleanDesc}</div>` : ''}
                                </div>
                                <div style="background: ${sentColor}15; border: 1px solid ${sentColor}40; padding: 0.2rem 0.5rem; border-radius: 4px; font-size: 0.6rem; font-weight: 800; color: ${sentColor}; white-space: nowrap; display: flex; align-items: center; gap: 0.3rem;">
                                    ${sentIcon} ${sentDisplay}
                                </div>
                            </div>
                            <div style="display: flex; justify-content: space-between; align-items: center; border-top: 1px solid rgba(255,255,255,0.04); padding-top: 0.5rem; margin-top: 0.2rem;">
                                <div style="font-size: 0.6rem; color: #64748b; font-weight: 500;">
                                    ${t('news.tiempo', 'TIEMPO:')} ${timeStr}
                                </div>
                                <div style="color: #0ea5e9; font-size: 0.65rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em;">${t('news.analizar', 'Analizar ↗')}</div>
                            </div>
                        </div>
                        `;
                    }).join('');
                }

                // Total real en escrow, leído on-chain del XRPL (roadmap #3, v2.2)
                let escrowOnChainHTML = '';
                if (data.escrowOnChain && typeof data.escrowOnChain.totalRemainingB === 'number') {
                    const oc = data.escrowOnChain;
                    const mins = oc.lastUpdated ? Math.round((Date.now() - new Date(oc.lastUpdated).getTime()) / 60000) : null;
                    escrowOnChainHTML = `
                    <div style="font-size: 0.6rem; color: #22c55e; margin-top: 0.25rem; display:flex; align-items:center; gap:0.3rem;">
                        <span style="font-weight:700;">✓ On-chain XRPL</span>
                        <span style="color:#94a3b8;">${_isEn()
                            ? `${oc.totalRemainingB.toFixed(3)}B XRP in ${oc.activeEscrows} escrows (${oc.accountsScanned} accounts) · ${mins != null ? mins + ' min ago' : '--'}`
                            : `${oc.totalRemainingB.toFixed(3)}B XRP en ${oc.activeEscrows} escrows (${oc.accountsScanned} cuentas) · hace ${mins != null ? mins + ' min' : '--'}`}</span>
                    </div>`;
                }

                // Datos del ciclo anterior
                const prev = data.events?.previousCycle;
                let prevCycleHTML = '';
                if (prev) {
                    const returnedPct = Math.round((prev.returned / prev.released) * 100);
                    prevCycleHTML = `
                    <div style="background: rgba(255,255,255,0.03); padding: 0.5rem 0.8rem; border-radius: 8px; border: 1px solid rgba(255,255,255,0.05); margin-top: 0.2rem; flex:1; display:flex; flex-direction:column; justify-content:center;">
                        <div style="font-size: 0.6rem; color: #94a3b8; text-transform: uppercase; letter-spacing: 0.05em; font-weight: 600; margin-bottom: 0.3rem;">${t('esc.cicloAnterior', 'Ciclo Anterior')} — ${_pick(prev.month, prev.monthEn)}${prev.estimated ? ` <span class="badge-estimated-inline" title="${t('esc.tipicoTitle', 'Cifras típicas (1000/800): el desglose liberado/devuelto exacto del mes requiere histórico (roadmap #6)')}">${t('esc.tipico', '≈ típico')}</span>` : ''}</div>
                        <div style="display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 0.4rem; margin-bottom: 0.35rem;">
                            <div style="text-align: center;">
                                <div style="font-size: 0.55rem; color: #94a3b8; text-transform: uppercase;">${t('esc.liberados', 'Liberados')}</div>
                                <div style="font-size: 0.9rem; font-weight: 700; color: #f59e0b;">${prev.released}M</div>
                            </div>
                            <div style="text-align: center;">
                                <div style="font-size: 0.55rem; color: #94a3b8; text-transform: uppercase;">${t('esc.devueltos', 'Devueltos')}</div>
                                <div style="font-size: 0.9rem; font-weight: 700; color: #22c55e;">${prev.returned}M</div>
                            </div>
                            <div style="text-align: center;">
                                <div style="font-size: 0.55rem; color: #94a3b8; text-transform: uppercase;">${t('esc.neto', 'Neto Circ.')}</div>
                                <div style="font-size: 0.9rem; font-weight: 700; color: #ef4444;">${prev.net}M</div>
                            </div>
                        </div>
                        <div style="display: flex; align-items: center; gap: 0.4rem;">
                            <div style="flex: 1; background: rgba(255,255,255,0.08); border-radius: 999px; height: 6px; overflow: hidden;">
                                <div style="width: ${returnedPct}%; background: linear-gradient(90deg, #22c55e, #10b981); height: 100%; border-radius: 999px; transition: width 1s ease;"></div>
                            </div>
                            <div style="font-size: 0.55rem; color: #94a3b8; font-weight: 600; white-space: nowrap;">${returnedPct}% ${t('esc.devuelto', 'devuelto')}</div>
                        </div>
                    </div>
                    `;
                }

                // Lectura práctica del escrow: dilución real vs ruido mediático
                let escrowReadingHTML = '';
                if (prev && prev.released > 0) {
                    const retPct = Math.round((prev.returned / prev.released) * 100);
                    const circ = data.supplyDistribution?.circulatingSupply || 0;
                    const netPctCirc = circ > 0 ? ((prev.net * 1e6) / circ) * 100 : null;
                    const pctTxt = netPctCirc !== null ? ` (≈${netPctCirc.toFixed(2)}% del circulante)` : '';
                    if (retPct >= 60) {
                        escrowReadingHTML = _isEn()
                            ? readingHTML('info', 'Low dilutive impact',
                                `Last month only ${prev.net}M XRP${pctTxt.replace('del circulante', 'of circulating')} stayed on the market; ${retPct}% went back into escrow. This event tends to generate more headlines than real sell pressure.`)
                            : readingHTML('info', 'Impacto dilutivo bajo',
                                `El mes pasado solo ${prev.net}M XRP${pctTxt} quedaron en el mercado; el ${retPct}% volvió al escrow. Este evento suele generar más titulares que presión de venta real.`);
                    } else {
                        escrowReadingHTML = _isEn()
                            ? readingHTML('warn', 'Larger release than usual',
                                `Last month ${prev.net}M XRP${pctTxt.replace('del circulante', 'of circulating')} entered circulation — Ripple returned only ${retPct}%. More supply available than normal: watch whether it repeats this month.`)
                            : readingHTML('warn', 'Liberación mayor a la habitual',
                                `El mes pasado quedaron en circulación ${prev.net}M XRP${pctTxt} — Ripple devolvió solo el ${retPct}%. Más oferta disponible de lo normal: vigila si se repite este mes.`);
                    }
                }

                escrowTimer.innerHTML = `
                    <div style="background: linear-gradient(135deg, rgba(14, 165, 233, 0.1), rgba(139, 92, 246, 0.1)); padding: 0.5rem 0.8rem; border-radius: 8px; border: 1px solid rgba(14, 165, 233, 0.2); position: relative; overflow: hidden; margin-bottom: 0.2rem; flex:0.8; display:flex; flex-direction:column; justify-content:center;">
                        <div style="position: absolute; top: 0; left: 0; width: 4px; height: 100%; background: #0ea5e9;"></div>
                        <div style="font-size: 0.65rem; color: #94a3b8; margin-bottom: 0.1rem; text-transform: uppercase; letter-spacing: 0.05em; font-weight: 600;">${t('esc.hito', 'Próximo Hito de Red')}</div>
                        <div style="font-size: 1.2rem; font-weight: 800; color: #fff; line-height: 1;">
                            ${_isEn()
                                ? `<span style="color: #0ea5e9;">${data.events?.daysUntilEscrow || 0}</span> days left`
                                : `Faltan <span style="color: #0ea5e9;">${data.events?.daysUntilEscrow || 0}</span> días`}
                        </div>
                        <div style="font-size: 0.65rem; color: #e2e8f0; margin-top: 0.1rem; font-weight: 500;">
                            ${_pick(data.events?.escorowNote, data.events?.escorowNoteEn) || t('esc.calc', 'Calculando Escrow API...')}
                        </div>
                        ${escrowOnChainHTML}
                    </div>
                    ${prevCycleHTML}
                    ${escrowReadingHTML}
                `;

                newsContainer.innerHTML = newsHTML;
                
                if (eventsUpdated) {
                    eventsUpdated.innerHTML = ""; // Eliminamos línea de actualización
                }
            }
        }
    } catch (e) { console.error('Error renderizando Events & News:', e); }

    // --- PROJECTIONS + SENTIMENT (INTEGRADO) ---
    try {
        if (data.projections && data.projections.bajista) {
            const projContent = document.querySelector('#projections .card-content');
            if (projContent) {
                const formatCur = (val) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 4 }).format(Number(val) || 0);
                let sentimentVal = (data.sentiment && data.sentiment.value !== undefined) ? data.sentiment.value : 50;
                
                let bgBajista = sentimentVal <= 45 ? 'rgba(239, 68, 68, 0.15)' : 'rgba(255,255,255,0.03)';
                let borderBajista = sentimentVal <= 45 ? '1px solid rgba(239, 68, 68, 0.5)' : '1px solid rgba(255,255,255,0.05)';
                let glowBajista = sentimentVal <= 45 ? '0 0 15px rgba(239, 68, 68, 0.1)' : 'inset 0 2px 10px rgba(0,0,0,0.1)';

                let bgNeutral = (sentimentVal > 45 && sentimentVal <= 54) ? 'rgba(234, 179, 8, 0.15)' : 'rgba(255,255,255,0.03)';
                let borderNeutral = (sentimentVal > 45 && sentimentVal <= 54) ? '1px solid rgba(234, 179, 8, 0.5)' : '1px solid rgba(255,255,255,0.05)';
                let glowNeutral = (sentimentVal > 45 && sentimentVal <= 54) ? '0 0 15px rgba(234, 179, 8, 0.1)' : 'inset 0 2px 10px rgba(0,0,0,0.1)';

                let bgAlcista = sentimentVal >= 55 ? 'rgba(34, 197, 94, 0.15)' : 'rgba(255,255,255,0.03)';
                let borderAlcista = sentimentVal >= 55 ? '1px solid rgba(34, 197, 94, 0.5)' : '1px solid rgba(255,255,255,0.05)';
                let glowAlcista = sentimentVal >= 55 ? '0 0 15px rgba(34, 197, 94, 0.1)' : 'inset 0 2px 10px rgba(0,0,0,0.1)';

                // Colores del sentimiento
                let barColor = '#22c55e';
                if (sentimentVal <= 45) barColor = '#ef4444';
                else if (sentimentVal <= 54) barColor = '#eab308';

                // Lectura práctica: metodología de escenarios + señal contraria del sentimiento
                let fgTone = 'info';
                let fgReading = _isEn()
                    ? 'Scenarios come from 7-day support/resistance (±15/20%): they are a reference volatility range, NOT a prediction. Sentiment is in the neutral zone, no contrarian signal.'
                    : 'Los escenarios salen del soporte/resistencia de 7 días (±15/20%): son un rango de volatilidad de referencia, NO una predicción. El sentimiento está en zona neutral, sin señal contraria.';
                if (sentimentVal <= 25) {
                    fgTone = 'pos';
                    fgReading = _isEn()
                        ? 'Scenarios are reference volatility ranges, not predictions. Extreme fear in the market: historically these zones have coincided with bottoms (a contrarian signal patient buyers watch).'
                        : 'Los escenarios son rangos de volatilidad de referencia, no predicciones. Miedo extremo en el mercado: históricamente estas zonas han coincidido con suelos (señal contraria que vigilan los compradores pacientes).';
                } else if (sentimentVal >= 75) {
                    fgTone = 'warn';
                    fgReading = _isEn()
                        ? 'Scenarios are reference volatility ranges, not predictions. Extreme greed: historically precedes corrections — be prudent with new entries at these levels.'
                        : 'Los escenarios son rangos de volatilidad de referencia, no predicciones. Codicia extrema: históricamente precede correcciones — prudencia con entradas nuevas a estos niveles.';
                }

                // El F&G de Alternative.me clasifica en inglés ("Extreme Fear"...):
                // en ES se muestra traducido; en EN tal cual llega de la API.
                const clsMap = { 'Extreme Fear': 'Miedo extremo', 'Fear': 'Miedo', 'Neutral': 'Neutral', 'Greed': 'Codicia', 'Extreme Greed': 'Codicia extrema' };
                const clsRaw = data.sentiment?.classification || 'Neutral';
                const clsDisplay = _isEn() ? clsRaw : (clsMap[clsRaw] || clsRaw);

                projContent.style.display = 'flex';
                projContent.style.flexDirection = 'column';
                projContent.style.justifyContent = 'space-between';
                projContent.style.gap = '0.3rem';
                projContent.style.height = '100%';

                projContent.innerHTML = `
                    <div style="display: grid; gap: 0.4rem; grid-template-columns: 1fr 1fr 1fr; flex:1.2;">
                        <div style="background: ${bgBajista}; padding: 0.4rem 0.6rem; border-radius: 8px; border: ${borderBajista}; box-shadow: ${glowBajista}; display: flex; flex-direction: column; justify-content: center; text-align: center; transition: all 0.3s ease;">
                            <div style="font-size: 0.6rem; color: #ef4444; margin-bottom: 0.1rem; text-transform: uppercase; letter-spacing: 0.05em; font-weight: 700;">${t('proj.bajista', 'Bajista')}</div>
                            <div style="font-size: 1rem; font-weight: 700; color: #fff;">${formatCur(data.projections.bajista?.price)}</div>
                            <div style="font-size: 0.5rem; color: #94a3b8; margin-top: 0.15rem;">${_pick(data.projections.bajista?.description, data.projections.bajista?.descriptionEn)}</div>
                        </div>
                        <div style="background: ${bgNeutral}; padding: 0.4rem 0.6rem; border-radius: 8px; border: ${borderNeutral}; box-shadow: ${glowNeutral}; display: flex; flex-direction: column; justify-content: center; text-align: center; transition: all 0.3s ease;">
                            <div style="font-size: 0.6rem; color: #eab308; margin-bottom: 0.1rem; text-transform: uppercase; letter-spacing: 0.05em; font-weight: 700;">${t('proj.neutral', 'Neutral')}</div>
                            <div style="font-size: 1rem; font-weight: 700; color: #fff;">~${formatCur(data.projections.neutral?.price)}</div>
                            <div style="font-size: 0.5rem; color: #94a3b8; margin-top: 0.15rem;">${_pick(data.projections.neutral?.description, data.projections.neutral?.descriptionEn)}</div>
                        </div>
                        <div style="background: ${bgAlcista}; padding: 0.4rem 0.6rem; border-radius: 8px; border: ${borderAlcista}; box-shadow: ${glowAlcista}; display: flex; flex-direction: column; justify-content: center; text-align: center; transition: all 0.3s ease;">
                            <div style="font-size: 0.6rem; color: #22c55e; margin-bottom: 0.1rem; text-transform: uppercase; letter-spacing: 0.05em; font-weight: 700;">${t('proj.alcista', 'Alcista')}</div>
                            <div style="font-size: 1rem; font-weight: 700; color: #fff;">${formatCur(data.projections.alcista?.price)}</div>
                            <div style="font-size: 0.5rem; color: #94a3b8; margin-top: 0.15rem;">${_pick(data.projections.alcista?.description, data.projections.alcista?.descriptionEn)}</div>
                        </div>
                    </div>
                    <div style="background:rgba(255,255,255,0.03); padding:0.5rem 0.8rem; border-radius:8px; border:1px solid rgba(255,255,255,0.05); display:flex; align-items:center; gap:0.8rem; flex:1;">
                        <div style="display:flex; flex-direction:column; align-items:center; min-width:50px;">
                            <div style="font-size:1.4rem; font-weight:800; color:${barColor}; line-height:1; text-shadow:0 0 15px ${barColor}40;">${sentimentVal}</div>
                            <div style="font-size:0.5rem; color:#f8fafc; text-transform:uppercase; letter-spacing:0.08em; font-weight:600; margin-top:0.1rem;">${clsDisplay}</div>
                        </div>
                        <div style="flex:1; display:flex; flex-direction:column; gap:0.2rem;">
                            <div style="width:100%; background:rgba(255,255,255,0.1); border-radius:999px; height:6px; overflow:hidden; border:1px solid rgba(255,255,255,0.05);">
                                <div style="width:${sentimentVal}%; background:${barColor}; height:100%; border-radius:999px; transition:width 1.5s cubic-bezier(0.4,0,0.2,1); box-shadow:0 0 8px ${barColor};"></div>
                            </div>
                            <div style="display:flex; justify-content:space-between; font-size:0.45rem; color:#94a3b8; font-weight:600; text-transform:uppercase;">
                                <span>${t('proj.miedo', 'Miedo')}</span><span>${t('proj.codicia', 'Codicia')}</span>
                            </div>
                        </div>
                    </div>
                    ${readingHTML(fgTone, t('proj.comoLeer', 'Cómo leer esta tarjeta'), fgReading)}
                `;
            }
        }
    } catch (e) { console.error('Error renderizando Projections:', e); }

    // --- GLOBAL INDICATOR ---
    try {
        const globalIndicator = document.getElementById('global-update-time');
        if (globalIndicator) {
            globalIndicator.innerHTML = `
                <span style="display: inline-block; width: 8px; height: 8px; background-color: #10b981; border-radius: 50%; box-shadow: 0 0 8px #10b981;"></span>
                ${t('glob.sync', 'Sincronización Global:')} ${new Date().toLocaleTimeString()} (Auto-refresh ON)
            `;
        }
    } catch (e) { console.error('Error renderizando Global Indicator:', e); }

    // Inyectar Whale Tracker si existe
    if (data.whaleTracker) {
        renderWhaleTracker(data.whaleTracker);
    } else {
        console.warn('whaleTracker no definido');
    }

    // Inyectar Supply Distribution si existe
    if (data.supplyDistribution) {
        // Circulante global para lecturas de otras tarjetas (burn, escrow)
        window._circSupply = data.supplyDistribution.circulatingSupply || 0;
        renderSupplyDistribution(data.supplyDistribution);
    }

    // Inyectar Burn Impact si existe
    if (data.burnImpact) {
        renderBurnImpact(data.burnImpact);
    }

    // Inyectar Métricas Avanzadas de Inversión si existen
    if (data.advancedMetrics) {
        renderAdvancedMetrics(data.advancedMetrics);
    }

    // ===== V2.0 =====
    try { renderHeaderPrice(data.marketData); } catch (e) { console.error('Error header price:', e); }
    try { renderResumen(data); } catch (e) { console.error('Error renderizando Resumen:', e); }
    try { renderDerivatives(data.derivatives); } catch (e) { console.error('Error renderizando Derivados:', e); }
    try { renderEcosystem(data.ecosystem, data.marketData, data.rlusdSplit); } catch (e) { console.error('Error renderizando Ecosistema:', e); }
    try { renderEtfFlows(data.etfFlows); } catch (e) { console.error('Error renderizando ETF Flows:', e); }
    try { renderExchangeVolume(data.exchangeVolume); } catch (e) { console.error('Error renderizando volumen por exchange:', e); }
    try { renderAmmDex(data.ammDex); } catch (e) { console.error('Error renderizando AMM/DEX:', e); }
    try { renderScoreSparkline(historyCache); } catch (e) { console.error('Error renderizando sparkline de score:', e); }
    try { renderWhaleFlowSparkline(historyCache); } catch (e) { console.error('Error renderizando sparkline de flujo whale:', e); }
    // V2.5: las alertas siempre sobre XRP (rawData), sea cual sea la moneda en pantalla
    try { checkAlerts(rawData); } catch (e) { console.error('Error evaluando alertas locales:', e); }
}

// Auto-Refresh Frontend cada 310000ms (~5.1 minutos para asegurar desfase seguro con backend)
setInterval(loadDashboardData, 310000);

// ============================================================
// BUGFIX v2.4 — Gráfica de precio: ventana activa vs datos reales
//
// Problema 1: el ciclo de refresco del backend reescribe data.chartData a
// 365 días cada ~5 min (fetchChartData), y el re-render periódico del
// frontend pintaba esa serie completa con el botón "1M"/"7D" activo — un
// año entero etiquetado como un mes. Problema 2: si CoinGecko rechazaba
// /api/chart/:days (rate limit), el click cambiaba el botón pero la
// gráfica se quedaba con la ventana anterior, sin ningún aviso. Problema 3:
// clics rápidos = respuestas en desorden (la lenta y vieja pintaba última).
//
// Solución: (a) recortar SIEMPRE en cliente la serie a la ventana activa;
// (b) cachear la última carga buena por ventana (TTL 5 min) — da cambio de
// ventana instantáneo y conserva la resolución fina de 1D/7D que el recorte
// de datos diarios no puede reconstruir; (c) token anti-carreras en el click
// y, si la API falla, revertir el botón y avisarlo en la lectura práctica.
// ============================================================
const _CHART_CACHE_MS = 5 * 60000;
window._chartCache = window._chartCache || {}; // { ['<coinId>:<days>']: { data, ts } } (V2.5: clave por moneda)
let _chartReqSeq = 0;
const _chartCacheKey = (days) => `${window._activeCoinId || 'ripple'}:${days}`;

// Recorta la serie [ts, precio] a los últimos N días
function _sliceChartWindow(chartData, daysString) {
    const days = parseFloat(daysString);
    if (!Array.isArray(chartData) || chartData.length < 2 || !isFinite(days)) return chartData;
    const cutoff = Date.now() - days * 86400000;
    return chartData.filter(p => p[0] >= cutoff);
}

// Render "seguro por ventana": elige la mejor serie disponible para el botón
// activo sin mentir nunca sobre la temporalidad mostrada.
function renderPriceChartForWindow(rawChartData, daysString) {
    const cached = window._chartCache[_chartCacheKey(daysString)];
    const cacheFresh = cached && (Date.now() - cached.ts) < _CHART_CACHE_MS;

    // 1) Caché fresca de esa ventana (resolución exacta pedida a la API)
    if (cacheFresh) { renderPriceChart(cached.data, daysString); return; }

    // 2) Recorte del chartData global si deja resolución razonable
    const sliced = _sliceChartWindow(rawChartData, daysString);
    if (Array.isArray(sliced) && sliced.length >= 24) { renderPriceChart(sliced, daysString); return; }

    // 3) Caché vieja antes que un recorte de 2-7 puntos (mejor resolución)
    if (cached && Array.isArray(cached.data) && cached.data.length > 0) { renderPriceChart(cached.data, daysString); return; }

    // 4) Recorte pobre pero con la ventana CORRECTA (nunca pintar 365d como "1M")
    if (Array.isArray(sliced) && sliced.length >= 2) { renderPriceChart(sliced, daysString); return; }
    if (Array.isArray(rawChartData) && rawChartData.length > 0) renderPriceChart(rawChartData, daysString);
}

// Lectura práctica de la gráfica de precio según la ventana seleccionada
function renderPriceReading(chartData, daysString) {
    const el = document.getElementById('price-chart-reading');
    if (!el || !Array.isArray(chartData) || chartData.length < 2) return;

    const labelMap = _isEn()
        ? { '1': '24 hours', '7': '7 days', '30': '1 month', '365': '1 year' }
        : { '1': '24 horas', '7': '7 días', '30': '1 mes', '365': '1 año' };
    const periodo = labelMap[daysString] || (_isEn() ? 'the period' : 'el periodo');

    const prices = chartData.map(p => p[1]);
    const first = prices[0];
    const last = prices[prices.length - 1];
    const min = Math.min(...prices);
    const max = Math.max(...prices);
    const changePct = first > 0 ? ((last - first) / first) * 100 : 0;
    // Posición del precio dentro del rango del periodo (0% = mínimo, 100% = máximo)
    const rangePos = (max - min) > 0 ? ((last - min) / (max - min)) * 100 : 50;

    const en = _isEn();
    let zona, implicacion;
    if (rangePos >= 80) {
        zona = en ? 'in the HIGH part of the range' : 'en la parte ALTA del rango';
        implicacion = en
            ? 'it is hugging the period resistance: entering here has historically had a worse risk/reward ratio.'
            : 'está pegado a la resistencia del periodo: entrar aquí tiene históricamente peor ratio riesgo/beneficio.';
    } else if (rangePos <= 20) {
        zona = en ? 'in the LOW part of the range' : 'en la parte BAJA del rango';
        implicacion = en
            ? 'it is near the period support: a zone usually watched for bounces, though supports can also break.'
            : 'está cerca del soporte del periodo: zona que suele vigilarse para rebotes, aunque un soporte también puede romperse.';
    } else {
        zona = en ? 'in the MIDDLE of the range' : 'en la zona MEDIA del rango';
        implicacion = en
            ? 'it is at neither extreme: no clear technical signal from price position.'
            : 'no está en ningún extremo: sin señal técnica clara por posición de precio.';
    }

    const tone = changePct > 2 ? 'pos' : (changePct < -2 ? 'neg' : 'info');
    const dir = changePct >= 0 ? (en ? 'rose' : 'subió') : (en ? 'fell' : 'cayó');

    setReading('price-chart-reading', tone,
        `${changePct >= 0 ? '+' : ''}${changePct.toFixed(2)}% ${en ? 'in' : 'en'} ${periodo}`,
        (en
            ? `${_coinSym()} ${dir} from ${_fmtPrice(first)} to ${_fmtPrice(last)}. Period range: ${_fmtPrice(min)} – ${_fmtPrice(max)}. `
            : `${_coinSym()} ${dir} de ${_fmtPrice(first)} a ${_fmtPrice(last)}. Rango del periodo: ${_fmtPrice(min)} – ${_fmtPrice(max)}. `) +
        (en
            ? `The price is ${zona} (${rangePos.toFixed(0)}%): ${implicacion}`
            : `El precio está ${zona} (${rangePos.toFixed(0)}%): ${implicacion}`)
    );
}

// Función reutilizable para renderizar el gráfico
function renderPriceChart(chartData, daysString) {
    const canvas = document.getElementById('priceChart');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    
    // Diccionario para etiquetas de la UI según los días seleccionados
    const labelMap = _isEn()
        ? { '1': '1 Day', '7': '7 Days', '30': '1 Month', '365': '1 Year' }
        : { '1': '1 Día', '7': '7 Días', '30': '1 Mes', '365': '1 Año' };

    // Mapear datos a etiquetas y valores (fechas en el locale del idioma activo)
    const loc = _dLoc();
    const labels = chartData.map(item => {
        const d = new Date(item[0]);
        // Ajustar formato según timeframe
        if (daysString === '1') {
            return d.toLocaleTimeString(loc, { hour: '2-digit', minute: '2-digit' });
        } else if (daysString === '365') {
            return d.toLocaleDateString(loc, { month: 'short', year: 'numeric' });
        }
        return d.toLocaleDateString(loc, { month: 'short', day: 'numeric', hour: '2-digit' });
    });
    const prices = chartData.map(item => item[1]);
    
    // Destruir instancia previa para evitar superposición
    if (window.myPriceChart) {
        window.myPriceChart.destroy();
    }
    
    // Configurar gradiente
    const gradient = ctx.createLinearGradient(0, 0, 0, 400);
    gradient.addColorStop(0, 'rgba(14, 165, 233, 0.4)');
    gradient.addColorStop(1, 'rgba(14, 165, 233, 0.0)');
    
    window.myPriceChart = new Chart(ctx, {
        type: 'line',
        data: {
            labels: labels,
            datasets: [{
                label: _isEn() ? `${_coinSym()} Price (USD) - ${labelMap[daysString] || '7 Days'}` : `Precio ${_coinSym()} (USD) - ${labelMap[daysString] || '7 Días'}`,
                data: prices,
                borderColor: '#0ea5e9',
                backgroundColor: gradient,
                borderWidth: 2,
                pointRadius: 0,
                pointHoverRadius: 6,
                pointHoverBackgroundColor: '#fff',
                fill: true,
                tension: 0.4
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            interaction: {
                mode: 'index',
                intersect: false,
            },
            plugins: {
                legend: {
                    labels: {
                        color: '#e2e8f0',
                        font: { family: "'Inter', sans-serif", size: 12 }
                    }
                },
                tooltip: {
                    backgroundColor: 'rgba(15, 23, 42, 0.9)',
                    titleFont: { family: "'Inter', sans-serif", size: 13 },
                    bodyFont: { family: "'Inter', sans-serif", size: 14 },
                    callbacks: {
                        label: function(context) {
                            let label = context.dataset.label || '';
                            if (label) { label += ': '; }
                            if (context.parsed.y !== null) {
                                label += new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 4 }).format(context.parsed.y);
                            }
                            return label;
                        }
                    }
                }
            },
            scales: {
                x: {
                    grid: { display: false, drawBorder: false },
                    ticks: { color: '#64748b', maxTicksLimit: 7, font: { family: "'Inter', sans-serif" } }
                },
                y: {
                    grid: { color: 'rgba(255, 255, 255, 0.05)', drawBorder: false },
                    ticks: {
                        color: '#64748b',
                        font: { family: "'Inter', sans-serif" },
                        callback: function(value) { return '$' + value; }
                    }
                }
            }
        }
    });

    // Lectura práctica bajo la gráfica (qué pasó y qué implica)
    renderPriceReading(chartData, daysString);
}

// Lógica de interactividad para los botones de temporalidad e interfaz
document.addEventListener('DOMContentLoaded', () => {
    // Botón de refresco manual
    const refreshBtn = document.getElementById('refresh-data-btn');
    if (refreshBtn) {
        refreshBtn.addEventListener('click', async () => {
            if (refreshBtn.classList.contains('loading')) return;
            
            refreshBtn.classList.add('loading');
            refreshBtn.disabled = true;
            
            try {
                const response = await fetch('/api/refresh', { method: 'POST' });
                const result = await response.json();
                
                if (response.ok) {
                    // Cargar de nuevo la información en el frontend
                    await loadDashboardData();
                } else {
                    alert(result.error || t('err.refrescar', 'Error al refrescar la información.'));
                }
            } catch (error) {
                console.error('Error al realizar refresh manual:', error);
                alert(t('err.servidor', 'No se pudo conectar con el servidor.'));
            } finally {
                refreshBtn.classList.remove('loading');
                refreshBtn.disabled = false;
            }
        });
    }

    // --- Alertas locales (roadmap #8, v2.2) ---
    const alertsBtn = document.getElementById('alerts-config-btn');
    const alertsModal = document.getElementById('alerts-modal');
    const closeAlertsBtn = document.getElementById('close-alerts-modal');
    if (alertsBtn && alertsModal) {
        alertsBtn.addEventListener('click', () => {
            const cfg = loadAlertsConfig();
            document.getElementById('alert-rsi').checked = !!cfg.rsi;
            document.getElementById('alert-cross').checked = !!cfg.cross;
            document.getElementById('alert-levels').checked = !!cfg.levels;
            document.getElementById('alert-funding').checked = !!cfg.funding;
            document.getElementById('alert-whale').checked = !!cfg.whale;
            document.getElementById('alert-whale-threshold').value = cfg.whaleThreshold || 500000;
            const statusEl = document.getElementById('alerts-permission-status');
            if (statusEl) {
                const perm = ('Notification' in window) ? Notification.permission : 'unsupported';
                const map = _isEn()
                    ? { granted: ['✓ Notifications allowed', '#22c55e'], denied: ['✗ Notifications blocked in the browser — enable them in the site settings', '#ef4444'], default: ['No permission yet — it will be requested on save', '#f59e0b'], unsupported: ["Your browser doesn't support notifications", '#ef4444'] }
                    : { granted: ['✓ Notificaciones permitidas', '#22c55e'], denied: ['✗ Notificaciones bloqueadas en el navegador — actívalas en la configuración del sitio', '#ef4444'], default: ['Sin permiso todavía — se pedirá al guardar', '#f59e0b'], unsupported: ['Tu navegador no soporta notificaciones', '#ef4444'] };
                const [txt, color] = map[perm] || map.default;
                statusEl.innerHTML = `<span style="color:${color}; font-size:0.8rem;">${txt}</span>`;
            }
            alertsModal.style.display = 'flex';
        });
    }
    if (closeAlertsBtn) closeAlertsBtn.addEventListener('click', () => { alertsModal.style.display = 'none'; });
    if (alertsModal) alertsModal.addEventListener('click', (e) => { if (e.target === alertsModal) alertsModal.style.display = 'none'; });

    const alertsSaveBtn = document.getElementById('alerts-save-btn');
    if (alertsSaveBtn) {
        alertsSaveBtn.addEventListener('click', async () => {
            const cfg = {
                rsi: document.getElementById('alert-rsi').checked,
                cross: document.getElementById('alert-cross').checked,
                levels: document.getElementById('alert-levels').checked,
                funding: document.getElementById('alert-funding').checked,
                whale: document.getElementById('alert-whale').checked,
                whaleThreshold: parseFloat(document.getElementById('alert-whale-threshold').value) || 500000
            };
            saveAlertsConfig(cfg);
            const anyEnabled = cfg.rsi || cfg.cross || cfg.levels || cfg.funding || cfg.whale;
            const noteEl = document.getElementById('alerts-test-note');
            if (anyEnabled && 'Notification' in window) {
                const perm = await Notification.requestPermission();
                if (perm === 'granted') {
                    new Notification(t('al.testTitulo', 'USCashout Markets — Alertas activadas'), { body: t('al.testCuerpo', 'Te avisaremos aquí cuando se cumplan las condiciones que elegiste. Mantén esta pestaña abierta.') });
                    if (noteEl) noteEl.textContent = t('al.guardadoTest', 'Guardado. Notificación de prueba enviada.');
                } else if (noteEl) {
                    noteEl.textContent = t('al.guardadoBloqueado', 'Guardado, pero las notificaciones están bloqueadas — actívalas en la configuración del navegador para este sitio.');
                }
            } else if (noteEl) {
                noteEl.textContent = t('al.guardado', 'Guardado.');
            }
            setTimeout(() => { alertsModal.style.display = 'none'; }, 1200);
        });
    }

    // Umbral whale configurable (roadmap #9)
    const threshSaveBtn = document.getElementById('whale-threshold-save');
    if (threshSaveBtn) {
        threshSaveBtn.addEventListener('click', async () => {
            const input = document.getElementById('whale-threshold-input');
            const noteEl = document.getElementById('whale-threshold-note');
            const value = parseFloat(input.value);
            if (!isFinite(value) || value <= 0) {
                if (noteEl) noteEl.textContent = t('wh.umbralInvalido', 'Introduce un número positivo de XRP.');
                return;
            }
            threshSaveBtn.disabled = true;
            if (noteEl) noteEl.textContent = t('wh.guardando', 'Guardando...');
            try {
                const resp = await fetch('/api/whale-threshold', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ threshold: value })
                });
                const result = await resp.json();
                if (resp.ok) {
                    try { localStorage.setItem('xrpWhaleThreshold', String(value)); } catch (e) { /* no-op */ }
                    if (noteEl) noteEl.textContent = _isEn() ? `Saved (${_fmtNum(value)} XRP). Recalculating whales...` : `Guardado (${_fmtNum(value)} XRP). Recalculando ballenas...`;
                    await loadDashboardData();
                    if (noteEl) noteEl.textContent = _isEn() ? `Active threshold: ${_fmtNum(value)} XRP.` : `Umbral activo: ${_fmtNum(value)} XRP.`;
                } else if (noteEl) {
                    noteEl.textContent = result.error || t('wh.umbralError', 'No se pudo guardar el umbral.');
                }
            } catch (e) {
                console.error('Error guardando umbral whale:', e);
                if (noteEl) noteEl.textContent = t('err.servidor', 'No se pudo conectar con el servidor.');
            } finally {
                threshSaveBtn.disabled = false;
            }
        });
    }

    const buttons = document.querySelectorAll('.timeline-btn');

    // Aviso bilingüe cuando CoinGecko rechaza el cambio de ventana
    const _chartFailNotice = () => {
        setReading('price-chart-reading', 'warn',
            _isEn() ? 'Could not load that timeframe' : 'No se pudo cargar esa temporalidad',
            _isEn()
                ? 'CoinGecko rejected the request (usually a temporary rate limit — the refresh cycle shares the same API). Keeping the previous view; try again in a few seconds.'
                : 'CoinGecko rechazó la petición (normalmente un rate limit temporal — el ciclo de refresco comparte la misma API). Se mantiene la vista anterior; inténtalo de nuevo en unos segundos.');
    };

    buttons.forEach(btn => {
        btn.addEventListener('click', async (e) => {
            const prevActive = document.querySelector('.timeline-btn.active');
            buttons.forEach(b => b.classList.remove('active'));
            e.target.classList.add('active');

            const days = e.target.getAttribute('data-days');

            // Caché fresca de esa ventana (por moneda): render instantáneo, sin gastar API
            // (también reduce los 429 de CoinGecko al alternar entre botones).
            const cached = window._chartCache[_chartCacheKey(days)];
            if (cached && (Date.now() - cached.ts) < _CHART_CACHE_MS) {
                renderPriceChart(cached.data, days);
                return;
            }

            // Token anti-carreras: si el usuario hace clic en otra ventana antes
            // de que esta respuesta llegue, la respuesta vieja se descarta.
            const reqId = ++_chartReqSeq;

            try {
                if (window.myPriceChart) {
                    window.myPriceChart.ctx.canvas.style.opacity = '0.5';
                }

                // V2.5: la gráfica pide la moneda activa (sin parámetro = XRP, compat)
                const coinParam = _isXrpActive() ? '' : `?coin=${encodeURIComponent(window._activeCoinId)}`;
                const response = await fetch(`/api/chart/${days}${coinParam}`);
                const chartData = await response.json().catch(() => null);

                if (reqId !== _chartReqSeq) return; // llegó tarde: otra ventana manda

                if (window.myPriceChart) {
                    window.myPriceChart.ctx.canvas.style.opacity = '1';
                }

                if (response.ok && Array.isArray(chartData) && chartData.length > 0) {
                    window._chartCache[_chartCacheKey(days)] = { data: chartData, ts: Date.now() };
                    renderPriceChart(chartData, days);
                } else {
                    // BUGFIX: antes el fallo era silencioso — el botón cambiaba pero
                    // la gráfica no, sin avisar. Ahora: revertir botón + aviso.
                    e.target.classList.remove('active');
                    if (prevActive) prevActive.classList.add('active');
                    _chartFailNotice();
                }
            } catch (error) {
                console.error('Error fetching new dynamic chart data:', error);
                if (reqId !== _chartReqSeq) return;
                if (window.myPriceChart) {
                    window.myPriceChart.ctx.canvas.style.opacity = '1';
                }
                e.target.classList.remove('active');
                if (prevActive) prevActive.classList.add('active');
                _chartFailNotice();
            }
        });
    });
});

// --- NEWS MODAL LOGIC ---
function openNewsModal(index) {
    if (!window.currentNews || !window.currentNews[index]) return;
    const news = window.currentNews[index];
    
    const modal = document.getElementById('news-modal');
    const title = document.getElementById('modal-title');
    const summary = document.getElementById('modal-summary-es');
    const impact = document.getElementById('modal-impact-analysis');
    const sentimentTag = document.getElementById('modal-sentiment-tag');
    const sourceLink = document.getElementById('modal-source-link');
    const closeBtn = document.getElementById('close-modal');

    if (modal && title && summary && impact && sentimentTag && sourceLink && closeBtn) {
        title.textContent = news.title || t('modal.noticia', 'Detalles de la Noticia');

        // Mejorado: Fallback de análisis si el backend aún no ha procesado la noticia
        let finalSummary = news.summary_es;
        let finalImpact = news.impact_analysis;
        let sent = window.getNewsSentiment(news);

        // V2.4 i18n: el resumen/impacto enriquecido con IA solo existe en español.
        // En inglés se muestra la descripción original de la noticia (normalmente EN)
        // y un análisis por reglas según el sentimiento — nunca español en modo EN.
        const useEnFallback = _isEn();
        if (useEnFallback) {
            finalSummary = (news.description || '').replace(/<[^>]*>?/gm, '') || news.title || '';
            finalImpact = null; // fuerza el fallback por sentimiento de abajo
        }

        if (!finalSummary || !finalImpact) {
            const en = _isEn();
            if (sent === 'POSITIVO') {
                finalSummary = finalSummary || (en ? `Bullish report: ${news.title}.` : `Reporte Alcista: ${news.title}.`);
                finalImpact = en
                    ? 'Positive impact expected. Reinforces the bullish trend and could push the price toward new resistance levels.'
                    : "Impacto positivo esperado. Refuerza la tendencia alcista y podría impulsar el precio hacia nuevas resistencias.";
            } else if (sent === 'NEGATIVO') {
                finalSummary = finalSummary || (en ? `Market alert: ${news.title}.` : `Alerta de Mercado: ${news.title}.`);
                finalImpact = en
                    ? 'Negative impact likely. Watching price supports is recommended to avoid volatility-driven losses.'
                    : "Impacto negativo probable. Se recomienda vigilar los soportes de precio para evitar pérdidas por volatilidad.";
            } else {
                finalSummary = finalSummary || (en ? `Information: ${news.title}.` : `Información: ${news.title}.`);
                finalImpact = en
                    ? 'No direct impact expected. Classified as context information for the XRP ecosystem.'
                    : "Sin impacto directo previsto. Se clasifica como información de contexto para el ecosistema XRP.";
            }
        }

        summary.textContent = finalSummary;
        impact.textContent = finalImpact;

        // Estilo del sentimiento (valor interno ES; display traducido)
        sentimentTag.textContent = { POSITIVO: t('sent.pos', 'POSITIVO'), NEGATIVO: t('sent.neg', 'NEGATIVO'), NEUTRO: t('sent.neu', 'NEUTRO') }[sent] || sent;
        
        // Reset styles first
        sentimentTag.style.background = 'rgba(148, 163, 184, 0.2)';
        sentimentTag.style.color = '#94a3b8';
        sentimentTag.style.border = '1px solid rgba(148, 163, 184, 0.4)';

        if (sent === 'POSITIVO') {
            sentimentTag.style.background = 'rgba(34, 197, 94, 0.2)';
            sentimentTag.style.color = '#22c55e';
            sentimentTag.style.border = '1px solid rgba(34, 197, 94, 0.4)';
        } else if (sent === 'NEGATIVO') {
            sentimentTag.style.background = 'rgba(239, 68, 68, 0.2)';
            sentimentTag.style.color = '#ef4444';
            sentimentTag.style.border = '1px solid rgba(239, 68, 68, 0.4)';
        }

        // V2.6 (seguridad): la URL viene de una API externa. _safeUrl() solo deja pasar
        // http/https — un `javascript:...` en el enlace ejecutaría código al hacer clic.
        sourceLink.href = _safeUrl(news.url);
        sourceLink.rel = 'noopener noreferrer'; // el sitio destino no puede tocar esta pestaña
        modal.style.display = 'flex';

        // Función para cerrar modal
        const closeModal = () => {
            modal.style.display = 'none';
            // Limpiar eventos para evitar duplicados
            closeBtn.onclick = null;
            window.onclick = null;
        };

        closeBtn.onclick = closeModal;
        window.onclick = (e) => {
            if (e.target === modal) closeModal();
        };
    }
}

// Asegurar que openNewsModal sea global para el atributo onclick del HTML
window.openNewsModal = openNewsModal;

// --- TAB SWITCHING LOGIC ---
// V2.4: nav agrupada en fila propia. Se recuerda el último tab visitado
// (localStorage — dato NO crítico, mismo criterio que el idioma) y se trae el
// botón activo a la vista cuando la nav scrollea en horizontal (pantallas
// estrechas). El tab por defecto sigue siendo Resumen.
document.addEventListener('DOMContentLoaded', () => {
    const navButtons = document.querySelectorAll('.nav-btn');
    const tabContents = document.querySelectorAll('.tab-content');

    const activateTab = (btn, persist) => {
        const tabId = btn.getAttribute('data-tab');
        const target = document.getElementById(`${tabId}-tab`);
        if (!target) return; // botón sin tab correspondiente: no romper la vista actual

        navButtons.forEach(b => b.classList.remove('active'));
        tabContents.forEach(t => t.classList.remove('active'));

        btn.classList.add('active');
        target.classList.add('active');
        btn.scrollIntoView({ block: 'nearest', inline: 'nearest' });

        // Mi Portafolio: refresca al entrar (su propio fetch, independiente de la moneda activa).
        if (tabId === 'portfolio') { try { renderPortfolio(); } catch (e) { /* no-op */ } }

        if (persist) {
            try { localStorage.setItem('xrpActiveTab', tabId); } catch (e) { /* no-op */ }
        }
    };

    navButtons.forEach(btn => {
        btn.addEventListener('click', () => activateTab(btn, true));
    });

    // Restaurar el último tab visitado (si sigue existiendo tras un rediseño)
    let savedTab = null;
    try { savedTab = localStorage.getItem('xrpActiveTab'); } catch (e) { /* no-op */ }
    if (savedTab && savedTab !== 'resumen') {
        const savedBtn = document.querySelector(`.nav-btn[data-tab="${savedTab}"]`);
        if (savedBtn) activateTab(savedBtn, false);
    }
});


function renderWhaleTracker(whaleData) {
    if (!whaleData) return;

    // KPIs — BUGFIX: el volumen y el flujo neto vienen en XRP, antes se mostraban con "$" (USD)
    // V2.0: formato compacto (12.5M XRP) — las cifras completas quedan en el tooltip.
    const fmtXrpAmt = (v) => fmtCompact(v || 0) + ' XRP';
    const fmtNum = (v) => new Intl.NumberFormat('en-US').format(v || 0);

    // V2.2 (roadmap #9): reflejar el umbral efectivo del servidor en el input, salvo
    // que el usuario lo esté editando ahora mismo (no le pisamos la escritura).
    const threshInput = document.getElementById('whale-threshold-input');
    if (threshInput && document.activeElement !== threshInput) {
        // Bugfix: leer primero el umbral top-level (se actualiza al instante al guardar,
        // vía withDataFile) — el de "summary" solo se refresca cuando termina el ciclo
        // completo de fetchWhaleData() (unos segundos después), y mostraba brevemente
        // el valor viejo tras guardar uno nuevo.
        threshInput.value = whaleData.threshold ?? whaleData.summary?.threshold ?? 50000;
    }

    document.getElementById('whale-kpi-count').textContent = fmtNum(whaleData.summary?.largeTransfers24h || 0);
    const volEl = document.getElementById('whale-kpi-volume');
    volEl.textContent = fmtXrpAmt(whaleData.summary?.totalVolume24h || 0);
    volEl.title = new Intl.NumberFormat('en-US').format(whaleData.summary?.totalVolume24h || 0) + ' XRP';

    const flowEl = document.getElementById('whale-kpi-flow');
    // V2.1: misma fuente que la línea de tiempo (ventana 24h estricta y consistente)
    const flowValue = (whaleData.flowTimeline && whaleData.flowTimeline.totals24h)
        ? whaleData.flowTimeline.totals24h.netXrp
        : (whaleData.summary?.exchangeFlowNet || 0);
    const flowSub = document.getElementById('whale-kpi-flow-sub');
    // SEMÁNTICA: flujo positivo = XRP ENTRANDO a exchanges (oferta de venta → bajista, rojo).
    // Flujo negativo = XRP saliendo hacia wallets frías (acumulación → alcista, verde).
    // Flujo ~0 = neutro (antes un 0 exacto se pintaba verde con texto de acumulación).
    if (Math.abs(flowValue) < 1) {
        flowEl.textContent = '0 XRP';
        flowEl.className = 'kpi-value';
        if (flowSub) flowSub.textContent = t('wh.flujoNeutro', 'Sin flujo neto en 24h: entradas y salidas se compensan');
    } else {
        flowEl.textContent = (flowValue > 0 ? '+' : '−') + fmtXrpAmt(Math.abs(flowValue));
        flowEl.className = `kpi-value ${flowValue > 0 ? 'text-red' : 'text-green'}`;
        if (flowSub) {
            flowSub.textContent = flowValue > 0
                ? t('wh.flujoEntrando', 'Entrando a exchanges: aumenta la oferta lista para venderse')
                : t('wh.flujoSaliendo', 'Saliendo de exchanges: acumulación en wallets frías');
        }
    }

    // Feed (Grandes Transferencias)
    const feedList = document.getElementById('whale-feed-list');
    const transfers = whaleData.largeTransfers || [];
    const hasMockData = transfers.some(tx => String(tx.hash || '').startsWith('MOCK'));

    if (transfers.length === 0) {
        feedList.innerHTML = `<div style="padding: 2rem; text-align: center; color: #64748b;">${t('wh.sinTransfers', 'No se detectaron transferencias whale con el umbral actual.')}</div>`;
    } else {
        // TRANSPARENCIA: si la API no devolvió transferencias reales, se muestran ejemplos sembrados — avisarlo
        const demoNotice = hasMockData
            ? `<div class="demo-notice">${t('wh.demoNotice', '⚠️ DATOS DE DEMOSTRACIÓN — la API de XRPScan no devolvió transferencias reales; se muestran ejemplos para ilustrar el formato.')}</div>`
            : '';
        // V2.1: cada transferencia dice SU dirección (→ exchange / ← exchange / ↔ ballenas)
        // para que el feed cuente la misma historia que la línea de tiempo.
        const trackedForDir = whaleData.trackedWallets || [];
        const isExAddr = (addr) => trackedForDir.some(w => w.address === addr && w.type === 'exchange');
        const relTime = (ts) => {
            const mins = Math.floor((Date.now() - new Date(ts).getTime()) / 60000);
            if (!isFinite(mins) || mins < 0) return '';
            if (mins < 60) return _isEn() ? `${mins}m ago` : `hace ${mins}m`;
            if (mins < 1440) return _isEn() ? `${Math.floor(mins / 60)}h ago` : `hace ${Math.floor(mins / 60)}h`;
            return _isEn() ? `${Math.floor(mins / 1440)}d ago` : `hace ${Math.floor(mins / 1440)}d`;
        };
        // V2.6 (seguridad): los datos de la wallet YA NO viajan dentro del atributo
        // onclick. Los labels vienen de XRPScan (API externa) y una comilla simple en
        // un label rompía el string del onclick → inyección de JS. Ahora el HTML solo
        // lleva un ÍNDICE y la función lee el objeto del array en memoria.
        window._whaleFeed = transfers;
        feedList.innerHTML = demoNotice + transfers.map((tx, i) => {
            const toEx = isExAddr(tx.to), fromEx = isExAddr(tx.from);
            let dirChip = `<span class="flow-dir-chip dir-w2w">${t('dir.w2w', '↔ entre ballenas')}</span>`;
            if (toEx && !fromEx) dirChip = `<span class="flow-dir-chip dir-in">${t('dir.in', '→ a exchange')}</span>`;
            else if (fromEx && !toEx) dirChip = `<span class="flow-dir-chip dir-out">${t('dir.out', '← desde exchange')}</span>`;
            const addrShort = _esc(String(tx.from).substring(0, 8)) + '...' + _esc(String(tx.from).substring(String(tx.from).length - 4));
            return `
            <div class="whale-list-item" onclick="openWalletFromFeed(${i})">
                <div class="whale-item-info">
                    <span class="whale-item-address">${addrShort}${String(tx.hash || '').startsWith('MOCK') ? ' <span class="badge-demo">DEMO</span>' : ''} ${dirChip}</span>
                    <span class="whale-item-meta">${relTime(tx.timestamp)} · ${new Date(tx.timestamp).toLocaleTimeString()} • ${_esc(tx.type)}</span>
                </div>
                <div class="whale-item-amount">${fmtNum(tx.amount)} XRP</div>
            </div>
        `}).join('');
    }

    // Wallets Monitoreadas (Usando trackedWallets)
    const monitoredList = document.getElementById('monitored-wallets-list');
    const tracked = whaleData.trackedWallets || [];
    
    if (tracked.length === 0) {
        monitoredList.innerHTML = `<div style="padding: 2rem; text-align: center; color: #64748b;">${t('wh.sinWallets', 'No hay wallets monitoreadas configuradas.')}</div>`;
    } else {
        // V2.0: el sufijo "(MOCK)" del label pasa a ser un badge DEMO explícito,
        // y las cuentas verificadas de XRPScan llevan su propio badge ✓.
        // V2.6 (seguridad): mismo patrón que el feed — índice en el onclick y escapado
        // del label/type/address, que llegan de XRPScan.
        window._whaleTracked = tracked;
        monitoredList.innerHTML = tracked.map((w, i) => {
            const isMock = String(w.label || '').includes('(MOCK)');
            const cleanLabel = _esc(String(w.label || '').replace(' (MOCK)', ''));
            const safeType = _esc(w.type);
            return `
            <div class="whale-list-item" onclick="openWalletFromTracked(${i})">
                <div class="whale-item-info">
                    <span class="whale-item-address" style="font-weight:700; color:#fff;">${cleanLabel}${isMock ? ' <span class="badge-demo">DEMO</span>' : ''}${w.verified ? ` <span class="badge-verified" title="${t('wh.verificada', 'Cuenta verificada en XRPScan')}">✓</span>` : ''}</span>
                    <span class="whale-item-meta">${_esc(String(w.address).substring(0, 12))}... • Balance: ${fmtCompact(w.balance || 0)} XRP</span>
                </div>
                <span class="badge badge-${safeType}">${safeType}</span>
            </div>
        `}).join('');
    }

    // V2.1: línea de tiempo del flujo (sustituye al gráfico de 3 barras)
    renderWhaleFlowTimeline(whaleData);
}

// --- WALLET DETAIL LOGIC ---
let currentWalletHistory = [];
let walletHistoryChart = null;

async function openWalletDetail(address, label, type) {
    const modal = document.getElementById('wallet-modal');
    const addrEl = document.getElementById('wallet-modal-address');
    const badgesEl = document.getElementById('wallet-modal-badges');
    const bodyEl = document.getElementById('wallet-history-body');

    addrEl.textContent = address;
    badgesEl.innerHTML = `<span class="badge badge-${type}">${label || type}</span>`;
    bodyEl.innerHTML = `<tr><td colspan="4" style="text-align:center; padding:2rem;">${t('wm.cargando', 'Cargando historial...')}</td></tr>`;
    
    modal.style.display = 'flex';

    try {
        const response = await fetch(`/api/wallet-history/${address}`);
        const history = await response.json();
        currentWalletHistory = history;
        
        renderWalletHistory(history);
        updateWalletStats(history);
        renderWalletChart(history);
        renderWalletReading(history);
    } catch (e) {
        bodyEl.innerHTML = `<tr><td colspan="4" style="text-align:center; padding:2rem; color:#ef4444;">${t('wm.errorCarga', 'No se pudo cargar el historial de esta cuenta.')}</td></tr>`;
    }

    // Botón cerrar
    document.getElementById('close-wallet-modal').onclick = () => {
        modal.style.display = 'none';
    };
}

function renderWalletHistory(history, filter = 'all') {
    const bodyEl = document.getElementById('wallet-history-body');
    
    let filtered = history;
    const now = new Date();

    if (filter === 'IN') filtered = history.filter(tx => tx.direction === 'IN');
    else if (filter === 'OUT') filtered = history.filter(tx => tx.direction === 'OUT');
    else if (filter === 'large') filtered = history.filter(tx => tx.amount >= 1000000);
    else if (filter === '24h') {
        const oneDayAgo = new Date(now.getTime() - (24 * 60 * 60 * 1000));
        filtered = history.filter(tx => new Date(tx.timestamp) >= oneDayAgo);
    }
    else if (filter === '7d') {
        const sevenDaysAgo = new Date(now.getTime() - (7 * 24 * 60 * 60 * 1000));
        filtered = history.filter(tx => new Date(tx.timestamp) >= sevenDaysAgo);
    }

    if (filtered.length === 0) {
        bodyEl.innerHTML = `<tr><td colspan="4" style="text-align:center; padding:1rem;">${t('wm.sinOps', 'Sin operaciones registradas.')}</td></tr>`;
        return;
    }

    const fmtNum = (v) => new Intl.NumberFormat('en-US').format(v || 0);

    bodyEl.innerHTML = filtered.map(tx => {
        const subtype = tx.subtype || tx.type;
        let subtypeColor = '#94a3b8'; // Default grey for unknown types
        if (subtype === 'Compra') subtypeColor = '#22c55e'; // Green
        else if (subtype === 'Venta') subtypeColor = '#ef4444'; // Red
        else if (subtype === 'Movimiento Interno') subtypeColor = '#a78bfa'; // Purple/Lavender
        // Valor interno en ES (viene del server); solo se traduce el display
        const subtypeDisplay = _isEn()
            ? ({ 'Compra': 'Buy', 'Venta': 'Sell', 'Movimiento Interno': 'Internal Move' }[subtype] || subtype)
            : subtype;

        return `
        <tr>
            <td style="font-size:0.7rem; color:#94a3b8;">${new Date(tx.timestamp).toLocaleString()}</td>
            <td style="font-weight:600; color:${subtypeColor};">${subtypeDisplay}</td>
            <td style="font-weight:700;">${fmtNum(tx.amount)} XRP</td>
            <td class="${tx.direction === 'IN' ? 'text-green' : 'text-red'}">${tx.direction}</td>
        </tr>
    `}).join('');
}

// Lectura práctica del comportamiento de la wallet (¿acumula o distribuye?)
function renderWalletReading(history) {
    const el = document.getElementById('wallet-reading');
    if (!el) return;
    if (!Array.isArray(history) || history.length === 0) { el.innerHTML = ''; return; }

    const inSum = history.filter(t => t.direction === 'IN').reduce((a, t) => a + (t.amount || 0), 0);
    const outSum = history.filter(t => t.direction === 'OUT').reduce((a, t) => a + (t.amount || 0), 0);
    const net = inSum - outSum;
    const compras = history.filter(t => t.subtype === 'Compra').length;
    const ventas = history.filter(t => t.subtype === 'Venta').length;
    const isMock = history.some(t => String(t.hash || '').startsWith('MOCK'));

    const en = _isEn();
    const base = en
        ? `Across the last ${history.length} operations, ${_fmtNum(inSum)} XRP came in and ${_fmtNum(outSum)} XRP went out (net ${net >= 0 ? '+' : '−'}${_fmtNum(Math.abs(net))}). ` +
          `Withdrawals from exchange (buy): ${compras} · Sends to exchange (sell): ${ventas}.`
        : `En las últimas ${history.length} operaciones entraron ${_fmtNum(inSum)} XRP y salieron ${_fmtNum(outSum)} XRP (neto ${net >= 0 ? '+' : '−'}${_fmtNum(Math.abs(net))}). ` +
          `Retiros desde exchange (compra): ${compras} · Envíos a exchange (venta): ${ventas}.`;
    const demoWarn = isMock
        ? (en ? ' ⚠️ DEMO history: the API returned no real data for this account.' : ' ⚠️ Historial de DEMOSTRACIÓN: la API no devolvió datos reales para esta cuenta.')
        : '';

    if (net > 0 && outSum >= 0) {
        setReading('wallet-reading', 'pos', en ? 'Profile: accumulation' : 'Perfil: acumulación',
            en ? `${base} Net balance flows in more than out: this account is accumulating, pulling supply off the market.${demoWarn}`
               : `${base} El saldo neto entra más de lo que sale: esta cuenta está acumulando, lo que retira oferta del mercado.${demoWarn}`);
    } else if (net < 0) {
        setReading('wallet-reading', 'neg', en ? 'Profile: distribution' : 'Perfil: distribución',
            en ? `${base} More flows out than in: the account is distributing. If the destination is exchanges, it can foreshadow selling.${demoWarn}`
               : `${base} Sale más de lo que entra: la cuenta está distribuyendo. Si el destino son exchanges, puede anticipar ventas.${demoWarn}`);
    } else {
        setReading('wallet-reading', 'info', en ? 'Profile: neutral' : 'Perfil: neutro',
            en ? `${base} Balanced flows: no relevant position change in the period shown.${demoWarn}`
               : `${base} Flujos equilibrados: sin cambio de posición relevante en el periodo mostrado.${demoWarn}`);
    }
}

function updateWalletStats(history) {
    const total = history.length;
    const inCount = history.filter(tx => tx.direction === 'IN').length;
    const outCount = history.filter(tx => tx.direction === 'OUT').length;
    const volume = history.reduce((acc, tx) => acc + tx.amount, 0);

    document.getElementById('wallet-stat-total').textContent = total;
    document.getElementById('wallet-stat-in').textContent = inCount;
    document.getElementById('wallet-stat-out').textContent = outCount;
    document.getElementById('wallet-stat-volume').textContent = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(volume) + ' XRP';
}

function renderWalletChart(history) {
    const canvas = document.getElementById('walletHistoryChart');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');

    // Agrupar por fecha para el gráfico (simplificado: tomamos las últimas 50 txs y las mostramos en secuencia)
    const labels = history.slice().reverse().map(tx => new Date(tx.timestamp).toLocaleDateString());
    const data = history.slice().reverse().map(tx => tx.direction === 'IN' ? tx.amount : -tx.amount);

    if (walletHistoryChart) {
        walletHistoryChart.destroy();
    }

    walletHistoryChart = new Chart(ctx, {
        type: 'bar',
        data: {
            labels: labels,
            datasets: [{
                label: t('wm.flujo', 'Flujo (XRP)'),
                data: data,
                backgroundColor: data.map(v => v >= 0 ? 'rgba(34, 197, 94, 0.5)' : 'rgba(239, 68, 68, 0.5)'),
                borderColor: data.map(v => v >= 0 ? '#22c55e' : '#ef4444'),
                borderWidth: 1
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: { legend: { display: false } },
            scales: {
                y: { grid: { color: 'rgba(255,255,255,0.05)' }, ticks: { color: '#64748b' } },
                x: { grid: { display: false }, ticks: { display: false } }
            }
        }
    });
}

// Filtros de historial
document.addEventListener('DOMContentLoaded', () => {
    const filterButtons = document.querySelectorAll('.history-filter-btn');
    filterButtons.forEach(btn => {
        btn.addEventListener('click', () => {
            filterButtons.forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            renderWalletHistory(currentWalletHistory, btn.getAttribute('data-filter'));
        });
    });
});

window.openWalletDetail = openWalletDetail;

// V2.6 (seguridad): aperturas por ÍNDICE — el HTML de las listas de ballenas ya no
// incrusta address/label (datos de XRPScan) dentro del atributo onclick. Estas
// funciones leen el objeto real del array en memoria, así que un label con comillas
// no puede romper el HTML ni inyectar JavaScript.
window.openWalletFromFeed = (i) => {
    const tx = (window._whaleFeed || [])[i];
    if (tx) openWalletDetail(tx.from, tx.walletLabel || 'Whale Account', 'whale');
};
window.openWalletFromTracked = (i) => {
    const w = (window._whaleTracked || [])[i];
    if (w) openWalletDetail(w.address, String(w.label || '').replace(' (MOCK)', ''), w.type);
};

// ============================================================
// V2.1: LÍNEA DE TIEMPO DEL FLUJO WHALE (rediseño completo)
// Sustituye a las 3 barras estáticas sin dimensión temporal.
// Formato estándar de "exchange netflow": barras ROJAS hacia
// arriba = XRP entrando a exchanges (oferta de venta), barras
// VERDES hacia abajo = XRP saliendo (acumulación), y una línea
// con el NETO ACUMULADO de la ventana. Toggle 24h (por hora) /
// 7 días (por día). Así se ve QUÉ pasó y CUÁNDO, de un vistazo.
// ============================================================
let whaleTimelineChartInstance = null;
window._whaleFlowState = window._whaleFlowState || { win: '24h', data: null };

// Fallback: si el server aún no generó flowTimeline (data.json antiguo),
// construir buckets desde las transferencias almacenadas (solo hashes reales).
function _buildTimelineFallback(whaleData) {
    const tracked = whaleData.trackedWallets || [];
    const isEx = (addr) => tracked.some(w => w.address === addr && w.type === 'exchange');
    const events = (whaleData.largeTransfers || [])
        .filter(tx => tx.hash && !String(tx.hash).startsWith('MOCK'))
        .map(tx => {
            const toEx = isEx(tx.to), fromEx = isEx(tx.from);
            return {
                ts: new Date(tx.timestamp).getTime(),
                dir: (toEx && !fromEx) ? 'in' : ((fromEx && !toEx) ? 'out' : 'w2w'),
                amount: tx.amount
            };
        })
        .filter(e => isFinite(e.ts) && e.amount > 0 && e.amount <= 2e9);

    const bucketize = (sizeMs, count) => {
        const startOfCurrent = Math.floor(Date.now() / sizeMs) * sizeMs;
        const buckets = [];
        for (let i = count - 1; i >= 0; i--) buckets.push({ start: startOfCurrent - i * sizeMs, inXrp: 0, outXrp: 0, w2wXrp: 0, txCount: 0 });
        const first = buckets[0].start;
        events.forEach(e => {
            if (e.ts < first) return;
            const b = buckets[Math.min(Math.floor((e.ts - first) / sizeMs), count - 1)];
            if (!b) return;
            if (e.dir === 'in') b.inXrp += e.amount; else if (e.dir === 'out') b.outXrp += e.amount; else b.w2wXrp += e.amount;
            b.txCount++;
        });
        return buckets;
    };
    const totals = (sinceTs) => {
        const t = { inXrp: 0, outXrp: 0, w2wXrp: 0, txCount: 0 };
        events.forEach(e => {
            if (e.ts < sinceTs) return;
            if (e.dir === 'in') t.inXrp += e.amount; else if (e.dir === 'out') t.outXrp += e.amount; else t.w2wXrp += e.amount;
            t.txCount++;
        });
        t.netXrp = t.inXrp - t.outXrp;
        return t;
    };
    return {
        hourly: bucketize(3600e3, 24),
        daily: bucketize(24 * 3600e3, 7),
        totals24h: totals(Date.now() - 24 * 3600e3),
        totals7d: totals(Date.now() - 7 * 24 * 3600e3),
        oldestEventTs: events.length ? Math.min(...events.map(e => e.ts)) : null,
        demo: events.length === 0 && (whaleData.largeTransfers || []).some(tx => String(tx.hash || '').startsWith('MOCK'))
    };
}

function renderWhaleFlowTimeline(whaleData) {
    const state = window._whaleFlowState;
    state.data = whaleData;

    const canvas = document.getElementById('whaleTimelineChart');
    const verdictEl = document.getElementById('whale-flow-verdict');
    const kpisEl = document.getElementById('whale-flow-kpis');
    const insightEl = document.getElementById('whale-flow-insight');
    const coverageEl = document.getElementById('whale-flow-coverage');
    if (!canvas) return;

    const tl = whaleData.flowTimeline || _buildTimelineFallback(whaleData);
    const is24 = state.win === '24h';
    const buckets = (is24 ? tl.hourly : tl.daily) || [];
    const totals = (is24 ? tl.totals24h : tl.totals7d) || { inXrp: 0, outXrp: 0, netXrp: 0, w2wXrp: 0, txCount: 0 };
    const en = _isEn();
    const winTxt = is24 ? (en ? 'the last 24 hours' : 'las últimas 24 horas') : (en ? 'the last 7 days' : 'los últimos 7 días');

    // ---- VEREDICTO (lo primero que se lee) ----
    if (verdictEl) {
        const net = totals.netXrp || 0;
        const gross = (totals.inXrp || 0) + (totals.outXrp || 0);
        let color = '#0ea5e9', icon = '⚖️';
        let txt = en ? `Balance over ${winTxt}: exchange inflows and outflows offset each other.` : `Equilibrio en ${winTxt}: entradas y salidas de exchanges se compensan.`;
        if (totals.txCount === 0) {
            color = '#94a3b8'; icon = '·';
            txt = en
                ? `No large transfers (≥50K XRP) detected over ${winTxt} in the watched wallets.`
                : `Sin transferencias grandes (≥50K XRP) detectadas en ${winTxt} en las wallets vigiladas.`;
        } else if (gross === 0 && (totals.w2wXrp || 0) > 0) {
            color = '#a78bfa'; icon = '↔';
            txt = en
                ? `No flow to/from exchanges over ${winTxt}: only whale-to-whale moves (${fmtCompact(totals.w2wXrp)} XRP) — neither fresh supply to sell nor accumulation.`
                : `Sin flujo hacia/desde exchanges en ${winTxt}: solo movimientos entre ballenas (${fmtCompact(totals.w2wXrp)} XRP) — ni oferta nueva para vender ni acumulación.`;
        } else if (net < 0 && Math.abs(net) > gross * 0.15) {
            color = '#22c55e'; icon = '⬇';
            txt = en
                ? `ACCUMULATION: over ${winTxt}, ${fmtCompact(Math.abs(net))} net XRP left exchanges for cold wallets — supply being pulled off the market.`
                : `ACUMULACIÓN: en ${winTxt} salieron ${fmtCompact(Math.abs(net))} XRP netos de exchanges hacia wallets frías — se retira oferta del mercado.`;
        } else if (net > 0 && net > gross * 0.15) {
            color = '#ef4444'; icon = '⬆';
            txt = en
                ? `POTENTIAL SELL PRESSURE: over ${winTxt}, ${fmtCompact(net)} net XRP flowed into exchanges — supply positioned to sell.`
                : `PRESIÓN DE VENTA POTENCIAL: en ${winTxt} entraron ${fmtCompact(net)} XRP netos a exchanges — oferta posicionada para venderse.`;
        }
        verdictEl.innerHTML = `<div class="flow-verdict" style="border-color:${color}66; background:${color}12;"><span class="flow-verdict-icon" style="color:${color};">${icon}</span><span>${txt}</span></div>`;
    }

    // ---- MINI KPIs ----
    if (kpisEl) {
        const net = totals.netXrp || 0;
        const netColor = Math.abs(net) < 1 ? '#94a3b8' : (net > 0 ? '#ef4444' : '#22c55e');
        kpisEl.innerHTML = `
            <div class="flow-kpi"><span class="flow-kpi-label" style="color:#ef4444;">${t('wh.kEntro', '→ Entró a exchanges')}</span><span class="flow-kpi-val">${fmtCompact(totals.inXrp)} XRP</span></div>
            <div class="flow-kpi"><span class="flow-kpi-label" style="color:#22c55e;">${t('wh.kSalio', '← Salió de exchanges')}</span><span class="flow-kpi-val">${fmtCompact(totals.outXrp)} XRP</span></div>
            <div class="flow-kpi flow-kpi-net"><span class="flow-kpi-label">${t('wh.kNeto', 'Neto')}</span><span class="flow-kpi-val" style="color:${netColor};">${net > 0 ? '+' : (net < 0 ? '−' : '')}${fmtCompact(Math.abs(net))} XRP</span></div>
            <div class="flow-kpi"><span class="flow-kpi-label" style="color:#a78bfa;">${t('wh.kW2w', '↔ Entre ballenas')}</span><span class="flow-kpi-val">${fmtCompact(totals.w2wXrp)} XRP</span></div>
            <div class="flow-kpi"><span class="flow-kpi-label">${t('wh.kTransfers', 'Transferencias')}</span><span class="flow-kpi-val">${totals.txCount}</span></div>
        `;
    }

    // ---- CHART: barras divergentes + neto acumulado ----
    const labels = buckets.map(b => {
        const d = new Date(b.start);
        return is24
            ? d.getHours().toString().padStart(2, '0') + 'h'
            : d.toLocaleDateString(_dLoc(), { weekday: 'short', day: 'numeric' });
    });
    const inData = buckets.map(b => b.inXrp || 0);
    const outData = buckets.map(b => -(b.outXrp || 0)); // hacia abajo
    const w2wData = buckets.map(b => b.w2wXrp || 0);   // actividad neutra (columna propia)
    let acc = 0;
    const cumData = buckets.map(b => { acc += (b.inXrp || 0) - (b.outXrp || 0); return acc; });
    const maxAbs = Math.max(...inData, ...outData.map(Math.abs), ...w2wData, ...cumData.map(Math.abs), 0);

    if (whaleTimelineChartInstance) whaleTimelineChartInstance.destroy();
    whaleTimelineChartInstance = new Chart(canvas.getContext('2d'), {
        data: {
            labels: labels,
            datasets: [
                {
                    type: 'bar', label: t('wh.dsEntra', 'Entra a exchanges (venta potencial)'), data: inData,
                    backgroundColor: 'rgba(239, 68, 68, 0.65)', borderColor: '#ef4444', borderWidth: 1, borderRadius: 3, stack: 'flow'
                },
                {
                    type: 'bar', label: t('wh.dsSale', 'Sale de exchanges (acumulación)'), data: outData,
                    backgroundColor: 'rgba(34, 197, 94, 0.65)', borderColor: '#22c55e', borderWidth: 1, borderRadius: 3, stack: 'flow'
                },
                {
                    type: 'bar', label: t('wh.dsW2w', 'Entre ballenas (neutro)'), data: w2wData,
                    backgroundColor: 'rgba(139, 92, 246, 0.35)', borderColor: 'rgba(139, 92, 246, 0.8)', borderWidth: 1, borderRadius: 3, stack: 'w2w'
                },
                {
                    type: 'line', label: t('wh.dsNeto', 'Neto acumulado'), data: cumData,
                    borderColor: '#38bdf8', backgroundColor: 'transparent', borderWidth: 2,
                    pointRadius: 0, pointHoverRadius: 4, tension: 0.3, borderDash: [5, 3]
                }
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            interaction: { mode: 'index', intersect: false },
            plugins: {
                legend: {
                    labels: { color: '#94a3b8', font: { size: 10 }, boxWidth: 12, usePointStyle: true }
                },
                tooltip: {
                    callbacks: {
                        label: (ctx) => {
                            const v = ctx.parsed.y;
                            if (ctx.dataset.type === 'line') return `${t('wh.dsNeto', 'Neto acumulado')}: ${(v >= 0 ? '+' : '−')}${fmtCompact(Math.abs(v))} XRP`;
                            return `${ctx.dataset.label}: ${fmtCompact(Math.abs(v))} XRP`;
                        }
                    }
                }
            },
            scales: {
                x: {
                    stacked: true,
                    grid: { display: false },
                    ticks: { color: '#64748b', font: { size: 9 }, maxRotation: 0 }
                },
                y: {
                    stacked: true,
                    // Con datos ~0 el autoescalado generaba ticks basura ("1,1,0,0"):
                    // asegurar un rango mínimo legible y aire alrededor de los picos.
                    suggestedMin: maxAbs > 0 ? undefined : -1000,
                    suggestedMax: maxAbs > 0 ? undefined : 1000,
                    grace: '12%',
                    grid: {
                        // La línea del cero es la frontera venta/acumulación: resaltarla
                        color: (ctx) => ctx.tick && ctx.tick.value === 0 ? 'rgba(148,163,184,0.5)' : 'rgba(255,255,255,0.05)',
                        lineWidth: (ctx) => ctx.tick && ctx.tick.value === 0 ? 1.5 : 1
                    },
                    ticks: { color: '#64748b', font: { size: 10 }, maxTicksLimit: 7, callback: (v) => fmtCompact(v, 1) }
                }
            }
        }
    });

    // ---- LECTURA PRÁCTICA ----
    if (insightEl) {
        if (totals.txCount === 0) {
            if (tl.demo) {
                insightEl.innerHTML = en
                    ? readingHTML('warn', 'No real data yet',
                        'The API returned no real large transfers in the watched wallets; the feed below shows DEMO examples. The timeline will fill in on its own as real moves appear.')
                    : readingHTML('warn', 'Sin datos reales todavía',
                        'La API no devolvió transferencias grandes reales en las wallets vigiladas; el feed de abajo muestra ejemplos DEMO. La línea de tiempo se llenará sola cuando aparezcan movimientos reales.');
            } else {
                insightEl.innerHTML = en
                    ? readingHTML('info', `No large moves over ${winTxt}`,
                        'No transfer ≥50,000 XRP in the watched wallets: the whales are quiet. Calm is information too — no fresh supply positioning to sell.')
                    : readingHTML('info', `Sin movimientos grandes en ${winTxt}`,
                        'Ninguna transferencia ≥50.000 XRP en las wallets vigiladas: las ballenas están quietas. La calma también es información — sin oferta nueva posicionándose para vender.');
            }
        } else {
            // Bucket más relevante de la ventana (si no hay flujo a exchanges,
            // el pico se busca en la actividad entre ballenas para no decir "0 XRP")
            let maxIdx = 0, maxVal = 0, peakKind = 'exchange';
            buckets.forEach((b, i) => {
                const m = Math.max(b.inXrp || 0, b.outXrp || 0);
                if (m > maxVal) { maxVal = m; maxIdx = i; }
            });
            if (maxVal === 0) {
                peakKind = 'w2w';
                buckets.forEach((b, i) => {
                    if ((b.w2wXrp || 0) > maxVal) { maxVal = b.w2wXrp; maxIdx = i; }
                });
            }
            const peak = buckets[maxIdx] || {};
            let peakTxt = '';
            if (maxVal > 0) {
                if (peakKind === 'w2w') {
                    peakTxt = en
                        ? `The largest move was whale-to-whale (${fmtCompact(maxVal)} XRP, ${labels[maxIdx]}), never touching exchanges. `
                        : `El movimiento más grande fue entre ballenas (${fmtCompact(maxVal)} XRP, ${labels[maxIdx]}), sin tocar exchanges. `;
                } else {
                    const inPeak = (peak.inXrp || 0) >= (peak.outXrp || 0);
                    peakTxt = en
                        ? `The largest move was an ${inPeak ? 'inflow to exchanges' : 'outflow from exchanges'} of ${fmtCompact(maxVal)} XRP (${labels[maxIdx]}). `
                        : `El movimiento más grande fue una ${inPeak ? 'entrada a exchanges' : 'salida de exchanges'} de ${fmtCompact(maxVal)} XRP (${labels[maxIdx]}). `;
                }
            }
            const net = totals.netXrp || 0;
            const grossFlow = (totals.inXrp || 0) + (totals.outXrp || 0);
            const tone = Math.abs(net) < 1 ? 'info' : (net > 0 ? 'neg' : 'pos');
            const title = en
                ? (grossFlow === 0 ? 'Directionless activity (whale-to-whale only)' : (Math.abs(net) < 1 ? 'Balanced flow' : (net > 0 ? 'Exchange inflows dominate' : 'Accumulation dominates')))
                : (grossFlow === 0 ? 'Actividad sin dirección (solo entre ballenas)' : (Math.abs(net) < 1 ? 'Flujo equilibrado' : (net > 0 ? 'Domina la entrada a exchanges' : 'Domina la acumulación')));
            insightEl.innerHTML = readingHTML(tone, title,
                (en
                    ? `Over ${winTxt}: ${fmtCompact(totals.inXrp)} XRP flowed into exchanges and ${fmtCompact(totals.outXrp)} XRP flowed out (net ${net >= 0 ? '+' : '−'}${fmtCompact(Math.abs(net))}). `
                    : `En ${winTxt}: entraron ${fmtCompact(totals.inXrp)} XRP a exchanges y salieron ${fmtCompact(totals.outXrp)} XRP (neto ${net >= 0 ? '+' : '−'}${fmtCompact(Math.abs(net))}). `) +
                peakTxt +
                (en
                    ? `Reading rule: sustained inflows = supply ready to sell (bearish); sustained outflows = cold accumulation (medium-term bullish). A single big bar can be an exchange's internal move — the pattern matters more than the spike.`
                    : `Regla de lectura: entradas sostenidas = oferta lista para venderse (bajista); salidas sostenidas = acumulación en frío (alcista a medio plazo). Una sola barra grande puede ser un movimiento interno de un exchange — el patrón importa más que el pico.`));
        }
    }

    // ---- COBERTURA (honestidad del histórico) ----
    if (coverageEl) {
        if (tl.oldestEventTs) {
            const ageH = (Date.now() - tl.oldestEventTs) / 3600e3;
            const windowH = is24 ? 24 : 168;
            if (ageH < windowH - 1) {
                const ageTxt = ageH < 24 ? Math.max(1, Math.round(ageH)) + 'h' : (ageH / 24).toFixed(1) + (en ? ' days' : ' días');
                coverageEl.innerHTML = en
                    ? `⏳ History under construction: data goes back ${ageTxt} (the XRPScan API only returns recent transactions; the dashboard accumulates history while it runs).`
                    : `⏳ Histórico en construcción: hay datos desde hace ${ageTxt} (la API de XRPScan solo da las transacciones recientes; el dashboard va acumulando el histórico mientras corre).`;
            } else {
                coverageEl.innerHTML = '';
            }
        } else {
            coverageEl.innerHTML = '';
        }
    }
}

// Toggle 24h / 7d de la línea de tiempo whale
document.addEventListener('DOMContentLoaded', () => {
    document.querySelectorAll('.flow-window-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.flow-window-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            window._whaleFlowState.win = btn.getAttribute('data-window');
            if (window._whaleFlowState.data) renderWhaleFlowTimeline(window._whaleFlowState.data);
        });
    });
});

// --- SUPPLY DISTRIBUTION RENDERING ---
function renderSupplyDistribution(dist) {
    if (!dist) return;

    const fmtPct = (v) => (v || 0).toFixed(2) + '%';
    const fmtXrp = (v) => new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(v || 0) + ' XRP';

    const distKpis = document.getElementById('supply-dist-kpis');
    if (distKpis) {
        distKpis.innerHTML = `
            <div class="supply-kpi">
                <span class="kpi-label">Circulating Supply</span>
                <span class="kpi-value">${fmtXrp(dist.circulatingSupply)}</span>
                <span class="kpi-sub">${fmtPct(dist.circulatingPercent)} ${t('sup.delMax', 'del Max')}</span>
            </div>
            <div class="supply-kpi">
                <span class="kpi-label">Escrowed Supply</span>
                <span class="kpi-value">${fmtXrp(dist.escrowSupply)}</span>
                <span class="kpi-sub">${fmtPct(dist.escrowPercent)} ${t('sup.delMax', 'del Max')}</span>
            </div>
            <div class="supply-kpi">
                <span class="kpi-label">Total Burned</span>
                <span class="kpi-value" style="color: #ef4444;">${fmtXrp(dist.totalBurned)}</span>
                <span class="kpi-sub">${t('sup.deflacion', 'Deflación acumulada')}</span>
            </div>
        `;
    }

    const barStack = document.getElementById('supply-bar-stack');
    if (barStack) {
        barStack.innerHTML = `
            <div class="bar-segment bar-circ" style="width: ${dist.circulatingPercent}%" title="${t('sup.circulante', 'Circulante')}: ${fmtPct(dist.circulatingPercent)}"></div>
            <div class="bar-segment bar-escrow" style="width: ${dist.escrowPercent}%" title="Escrow: ${fmtPct(dist.escrowPercent)}"></div>
            <div class="bar-segment bar-burned" style="width: 0.5%" title="${t('sup.quemadoAmpliado', 'Quemado (ampliado para ser visible)')}"></div>
        `;
    }

    // Leyenda de la barra (antes los colores no estaban identificados)
    const legendEl = document.getElementById('supply-legend');
    if (legendEl) {
        legendEl.innerHTML = `
            <span class="legend-item"><span class="dot" style="background:#0ea5e9;"></span> ${t('sup.circulante', 'Circulante')} ${fmtPct(dist.circulatingPercent)}</span>
            <span class="legend-item"><span class="dot" style="background:#64748b;"></span> Escrow (Ripple) ${fmtPct(dist.escrowPercent)}</span>
            <span class="legend-item"><span class="dot" style="background:#ef4444;"></span> ${t('sup.quemado', 'Quemado')} ${((dist.totalBurned / dist.maxSupply) * 100).toFixed(3)}%</span>
        `;
    }

    const distDetails = document.getElementById('supply-dist-details');
    if (distDetails) {
        distDetails.innerHTML = `
            <div class="detail-card">
                <div class="detail-header">
                    <span class="dot" style="background:#0ea5e9;"></span>
                    <span>Exchanges</span>
                    <span class="badge badge-estimated">Estimated</span>
                </div>
                <div class="detail-val">${fmtXrp(dist.exchangeSupply)}</div>
                <div class="detail-pct">${fmtPct(dist.exchangePercent)} ${t('sup.delSupply', 'del Supply')}</div>
            </div>
            <div class="detail-card">
                <div class="detail-header">
                    <span class="dot" style="background:#8b5cf6;"></span>
                    <span>Whales / Top Holders</span>
                    <span class="badge badge-estimated">Estimated</span>
                </div>
                <div class="detail-val">${fmtXrp(dist.whaleSupply)}</div>
                <div class="detail-pct">${fmtPct(dist.whalePercent)} ${t('sup.delSupply', 'del Supply')}</div>
            </div>
            <div class="detail-card">
                <div class="detail-header">
                    <span class="dot" style="background:#10b981;"></span>
                    <span>Free Float</span>
                    <span class="badge badge-estimated">Estimated</span>
                </div>
                <div class="detail-val">${fmtXrp(dist.freeFloatEstimate)}</div>
                <div class="detail-pct">${fmtPct(dist.freeFloatPercent)} ${t('sup.delSupply', 'del Supply')}</div>
            </div>
        `;
    }

    const insightsEl = document.getElementById('distribution-insights');
    if (insightsEl) {
        const en = _isEn();
        const escrowStatus = dist.escrowPercent > 30
            ? (en ? 'High Institutional Concentration' : 'Alta Concentración Institucional')
            : (en ? 'Balanced Distribution' : 'Distribución Equilibrada');
        const liquidityStatus = dist.freeFloatPercent > 10
            ? (en ? 'Healthy Liquidity' : 'Liquidez Saludable')
            : (en ? 'Restricted Liquidity' : 'Liquidez Restringida');
        // Lectura práctica: dilución mensual máxima que puede introducir el escrow
        const maxMonthlyDilution = dist.circulatingSupply > 0 ? (1e9 / dist.circulatingSupply) * 100 : 0;

        insightsEl.innerHTML = `
            <div class="insight-box">
                <div class="insight-item">
                    <span class="insight-icon">🔒</span>
                    <div class="insight-text">
                        <strong>${en ? 'Escrow Status:' : 'Estatus de Escrow:'}</strong>
                        <span class="${dist.escrowPercent > 30 ? 'text-warning' : 'text-green'}">${escrowStatus}</span>
                        <p>${en
                            ? `Ripple controls ~${dist.escrowPercent.toFixed(1)}% of total supply. It can release up to 1B XRP monthly (≈${maxMonthlyDilution.toFixed(1)}% of circulating), though historically it returns 70-80% to escrow. Reading: REAL monthly dilution is usually below 0.5%.`
                            : `Ripple controla el ~${dist.escrowPercent.toFixed(1)}% del suministro total. Cada mes puede liberar hasta 1B XRP (≈${maxMonthlyDilution.toFixed(1)}% del circulante), aunque históricamente devuelve el 70-80% al escrow. Lectura: la dilución mensual REAL suele ser inferior al 0.5%.`}</p>
                    </div>
                </div>
                <div class="insight-item">
                    <span class="insight-icon">💧</span>
                    <div class="insight-text">
                        <strong>${en ? 'Market Liquidity:' : 'Liquidez de Mercado:'}</strong>
                        <span class="${dist.freeFloatPercent > 10 ? 'text-green' : 'text-warning'}">${liquidityStatus}</span>
                        <p>${en
                            ? `Estimated "Free Float" is ~${dist.freeFloatPercent.toFixed(1)}% of max supply: the XRP actually available for retail trading. The smaller it is, the easier it is for large orders to move the price violently (in both directions).`
                            : `El "Free Float" estimado es del ~${dist.freeFloatPercent.toFixed(1)}% del máximo: es el XRP realmente disponible para trading minorista. Cuanto menor es, más fácil es que órdenes grandes muevan el precio con violencia (en ambas direcciones).`}</p>
                    </div>
                </div>
                <div class="insight-item">
                    <span class="insight-icon">🐋</span>
                    <div class="insight-text">
                        <strong>${en ? 'Concentration in large holders:' : 'Concentración en grandes holders:'}</strong>
                        <span class="text-warning">${en ? 'Structural risk to watch' : 'Riesgo estructural a vigilar'}</span>
                        <p>${en
                            ? `Large holders are estimated to concentrate ~${dist.whalePercent.toFixed(1)}% of supply (approximate value, not exact on-chain). Reading: decisions by a few accounts can trigger sharp moves — which is why the Whale Tracker watches their flows to exchanges.`
                            : `Se estima que los grandes holders concentran ~${dist.whalePercent.toFixed(1)}% del suministro (valor aproximado, no on-chain exacto). Lectura: decisiones de pocas cuentas pueden generar movimientos bruscos — por eso el Whale Tracker vigila sus flujos hacia exchanges.`}</p>
                    </div>
                </div>
            </div>
        `;
    }
}

// --- BURN IMPACT RENDERING ---
function renderBurnImpact(burn) {
    if (!burn) return;

    const fmtNum = (v) => new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(v || 0);
    const fmtDec = (v, d = 4) => new Intl.NumberFormat('en-US', { minimumFractionDigits: d, maximumFractionDigits: d }).format(v || 0);

    // Etiqueta honesta del ritmo diario: "real" solo si hay cobertura suficiente de datos.
    // V2.0: la cobertura 0h ya no puede etiquetarse como dato real ("Extrapolado de 0h").
    const cov = burn.realCoverageHours || 0;
    const en = _isEn();
    let burnRateLabel = en ? 'Estimated average (no real data yet)' : 'Promedio estimado (sin datos reales aún)';
    if (!burn.dailyBurnEstimated) {
        if (cov >= 18) burnRateLabel = en ? 'Real: measured over the last 24h' : 'Real: medido en las últimas 24h';
        else if (cov >= 1) burnRateLabel = en ? `Extrapolated from ${cov}h of real data` : `Extrapolado de ${cov}h de datos reales`;
        else burnRateLabel = en ? 'Measured live (partial coverage, <1h)' : 'Medido en vivo (cobertura aún parcial, <1h)';
    }

    const burnKpis = document.getElementById('burn-kpis');
    if (burnKpis) {
        burnKpis.innerHTML = `
            <div class="supply-kpi">
                <span class="kpi-label">Daily Burn Rate</span>
                <span class="kpi-value" style="color: #f87171;">${fmtNum(burn.dailyBurn)} ${t('burn.xrpDia', 'XRP/día')}</span>
                <span class="kpi-sub">${burnRateLabel}</span>
            </div>
            <div class="supply-kpi">
                <span class="kpi-label">Burn Trend</span>
                <span class="kpi-value" style="font-size: 0.9rem; color: #e2e8f0;">${_pick(burn.burnRateTrend, burn.burnRateTrendEn)}</span>
                <span class="kpi-sub">${t('burn.estadoRed', 'Estado de la Red')}</span>
            </div>
        `;
    }

    // --- LIVE BURN MONITOR (tiempo real) ---
    startLiveBurnTicker(burn);

    const projGrid = document.getElementById('burn-projections');
    if (projGrid) {
        projGrid.innerHTML = burn.supplyImpactProjections.map(p => `
            <div class="proj-card">
                <span class="proj-period">${_pick(p.period, p.periodEn)}</span>
                <span class="proj-val">-${fmtNum(p.burned)} XRP</span>
            </div>
        `).join('');
    }

    const scenariosRow = document.getElementById('burn-scenarios');
    if (scenariosRow) {
        // V2.0 CONSISTENCIA: "Actual" siempre muestra el MISMO número que el KPI Daily Burn
        // (antes podían diferir si el nodo venía de ciclos mezclados: 8.624 vs 2.450 a la vez).
        scenariosRow.innerHTML = `
            <div class="scenario-box">
                <span class="scen-label">${t('burn.bajo', 'Bajo')}</span>
                <span class="scen-val">${fmtNum(burn.scenarioComparisons.low)}</span>
            </div>
            <div class="scenario-box active">
                <span class="scen-label">${t('burn.actual', 'Actual')}</span>
                <span class="scen-val">${fmtNum(Math.round(burn.dailyBurn || burn.scenarioComparisons.medium))}</span>
            </div>
            <div class="scenario-box">
                <span class="scen-label">${t('burn.alto', 'Alto')}</span>
                <span class="scen-val">${fmtNum(burn.scenarioComparisons.high)}</span>
            </div>
        `;
    }

    renderBurnCompletion(burn);
}

// --- BURN COMPLETION RENDERING ---
function renderBurnCompletion(burn) {
    if (!burn || !burn.burnCompletionProjection) return;
    const proj = burn.burnCompletionProjection;

    const baseSelector = document.getElementById('base-selector');
    const displayVal = document.getElementById('projected-duration-val');
    const comparisonGrid = document.getElementById('completion-comparison');

    if (!baseSelector || !displayVal || !comparisonGrid) return;

    const fmtXrp = (v) => new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(v || 0) + ' XRP';

    const updateDisplay = () => {
        const en = _isEn();
        const baseLabels = en
            ? { max: 'the max supply (100B)', total: 'the total remaining supply', circulating: 'the circulating supply' }
            : { max: 'el suministro máximo (100B)', total: 'el suministro total restante', circulating: 'el circulante' };
        const base = baseSelector.value;
        let dataNode;
        if (base === 'max') dataNode = proj.basedOnMaxSupply;
        else if (base === 'total') dataNode = proj.basedOnTotalSupply;
        else dataNode = proj.basedOnCirculatingSupply;

        if (dataNode.notComputable) {
            displayVal.textContent = en ? 'Not computable' : 'No computable';
            setReading('burn-completion-reading', 'warn',
                en ? 'No burn rate available' : 'Sin ritmo de quema disponible',
                en ? 'There is no valid burn rate to project. Wait for the monitor to capture real XRPL data.'
                   : 'No hay un ritmo de quema válido para proyectar. Espera a que el monitor capture datos reales del XRPL.');
            return;
        }
        const dur = _pick(dataNode.formattedDuration, dataNode.formattedDurationEn);
        displayVal.textContent = dur;

        // Lectura práctica: poner la cifra astronómica en contexto
        setReading('burn-completion-reading', 'info', en ? 'Practical takeaway' : 'Conclusión práctica',
            en
                ? `At the current rate (~${_fmtNum(dataNode.dailyBurn)} XRP/day), burning ${baseLabels[base] || 'this base'} would take ${dur}. ` +
                  `"Scarcity through burn" is NOT an investment argument at human scale: XRP's value depends on adoption and utility, not the burn.`
                : `Al ritmo actual (~${_fmtNum(dataNode.dailyBurn)} XRP/día), quemar ${baseLabels[base] || 'esta base'} tomaría ${dur}. ` +
                  `La "escasez por quema" NO es un argumento de inversión a escala humana: el valor de XRP depende de su adopción y utilidad, no del burn.`);
    };

    // Renderizar mini cards de comparación
    comparisonGrid.innerHTML = `
        <div class="comp-mini-card">
            <span class="comp-label">Max Supply</span>
            <span class="comp-val">${_pick(proj.basedOnMaxSupply.formattedDuration, proj.basedOnMaxSupply.formattedDurationEn)}</span>
            <span class="comp-sub">${fmtXrp(proj.basedOnMaxSupply.supplyBase)}</span>
        </div>
        <div class="comp-mini-card">
            <span class="comp-label">Total Supply</span>
            <span class="comp-val">${_pick(proj.basedOnTotalSupply.formattedDuration, proj.basedOnTotalSupply.formattedDurationEn)}</span>
            <span class="comp-sub">${fmtXrp(proj.basedOnTotalSupply.supplyBase)}</span>
        </div>
        <div class="comp-mini-card">
            <span class="comp-label">Circulating</span>
            <span class="comp-val">${_pick(proj.basedOnCirculatingSupply.formattedDuration, proj.basedOnCirculatingSupply.formattedDurationEn)}</span>
            <span class="comp-sub">${fmtXrp(proj.basedOnCirculatingSupply.supplyBase)}</span>
        </div>
    `;

    // Event listener para el selector
    baseSelector.onchange = updateDisplay;
    updateDisplay(); // Ejecutar inicial
}

// NOTA: se eliminó renderBurnChart() — apuntaba a un canvas inexistente ('burnTrendChart')
// y usaba datos mensuales inventados. La gráfica horaria real (burnHourlyChart) la sustituye.

// ====== LIVE BURN TICKER (tiempo real) ======
// Estado global del ticker: se mantiene entre refreshes
window._liveBurnState = window._liveBurnState || {
    tickerInterval: null,
    refreshInterval: null,
    sessionStart: null,
    sessionBurned: 0,
    totalBurned: 0,
    ratePerSec: 0,
    lastUpdated: null
};

function startLiveBurnTicker(burn) {
    const state = window._liveBurnState;
    const rt = burn.realtime || null;

    state.totalBurned = Number(burn.totalBurned) || 0;
    const dailyBurn = Number(burn.dailyBurn) || 0;

    // Si hay datos reales del watcher, usamos su ratePerSec (más fiel a lo que pasa AHORA)
    if (rt && Number(rt.ratePerSec) > 0) {
        state.ratePerSec = Number(rt.ratePerSec);
    } else {
        state.ratePerSec = dailyBurn / 86400;
    }

    state.lastUpdated = (rt && rt.lastEventAt)
        ? new Date(rt.lastEventAt)
        : (burn.lastUpdated ? new Date(burn.lastUpdated) : new Date());

    // Renderizar chart horario real (si tenemos buckets) y badge de fuente
    renderRealtimeHourlyChart(rt);
    renderRealtimeSourceBadge(rt, burn);

    if (!state.sessionStart) {
        state.sessionStart = Date.now();
        state.sessionBurned = 0;
    }

    const fmt0 = (v) => new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(v || 0);
    const fmt4 = (v) => new Intl.NumberFormat('en-US', { minimumFractionDigits: 4, maximumFractionDigits: 4 }).format(v || 0);
    const fmt2 = (v) => new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(v || 0);

    const rateEl = document.getElementById('live-rate-per-sec');
    const hourEl = document.getElementById('live-hour-burn');
    const minEl  = document.getElementById('live-min-burn');

    if (rateEl) rateEl.textContent = fmt4(state.ratePerSec);
    if (hourEl) hourEl.textContent = fmt0(dailyBurn / 24) + ' XRP';
    if (minEl)  minEl.textContent  = fmt2(dailyBurn / 1440);

    if (state.tickerInterval) clearInterval(state.tickerInterval);

    const tickMs = 250;
    state.tickerInterval = setInterval(() => {
        const inc = state.ratePerSec * (tickMs / 1000);
        state.totalBurned += inc;
        state.sessionBurned += inc;

        const totalEl   = document.getElementById('live-total-burned');
        const sessionEl = document.getElementById('live-session-burned');
        const timeEl    = document.getElementById('live-session-time');
        const updEl     = document.getElementById('burn-last-updated');

        if (totalEl)   totalEl.textContent   = fmt0(state.totalBurned) + ' XRP';
        if (sessionEl) sessionEl.textContent = '+' + fmt2(state.sessionBurned) + ' XRP';

        if (timeEl) {
            const secs = Math.floor((Date.now() - state.sessionStart) / 1000);
            timeEl.textContent = _isEn() ? formatSessionDuration(secs) + ' on screen' : formatSessionDuration(secs) + ' en pantalla';
        }

        if (updEl && state.lastUpdated) {
            const ago = Math.floor((Date.now() - state.lastUpdated.getTime()) / 1000);
            updEl.textContent = _isEn() ? 'backend data ' + formatSessionDuration(ago) + ' ago' : 'datos del backend hace ' + formatSessionDuration(ago);
        }
    }, tickMs);
}

function formatSessionDuration(totalSecs) {
    if (totalSecs < 60) return totalSecs + 's';
    const m = Math.floor(totalSecs / 60);
    const s = totalSecs % 60;
    if (m < 60) return m + 'm ' + s + 's';
    const h = Math.floor(m / 60);
    const mm = m % 60;
    return h + 'h ' + mm + 'm';
}

// ====== AUTO-REFRESH RÁPIDO EN BURN IMPACT TAB ======
function setupBurnTabAutoRefresh() {
    const state = window._liveBurnState;

    const isBurnTabActive = () => {
        const tab = document.getElementById('burn-impact-tab');
        return tab && tab.classList.contains('active');
    };

    if (state.refreshInterval) clearInterval(state.refreshInterval);
    state.refreshInterval = setInterval(() => {
        if (isBurnTabActive() && document.visibilityState === 'visible') {
            loadDashboardData();
        }
    }, 30000);
}

document.addEventListener('DOMContentLoaded', setupBurnTabAutoRefresh);


// ====== HOURLY BURN CHART (real, basado en buckets del XRPL) ======
let realtimeHourlyChartInstance = null;
function renderRealtimeHourlyChart(rt) {
    const canvas = document.getElementById('burnHourlyChart');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');

    // Construir últimos 24h (incluso si faltan buckets, los rellenamos con 0)
    const buckets = (rt && Array.isArray(rt.hourly)) ? rt.hourly.slice() : [];
    const now = new Date();
    const series = [];
    for (let i = 23; i >= 0; i--) {
        const t = new Date(now.getTime() - i * 3600 * 1000);
        t.setMinutes(0, 0, 0);
        const key = t.toISOString();
        const b = buckets.find(x => x.hourStart === key);
        series.push({
            label: t.getHours().toString().padStart(2, '0') + 'h',
            value: b ? b.burned : 0,
            seeded: b ? !!b.seeded : false
        });
    }

    // HONESTIDAD DE DATOS: barras grises = estimación inicial sembrada; rojas = quema real del XRPL
    const seededCount = series.filter(s => s.seeded && s.value > 0).length;
    const subEl = document.getElementById('burn-chart-sub');
    if (subEl) {
        subEl.textContent = seededCount > 0
            ? (_isEn()
                ? `Red: real XRPL data · Grey: initial estimate (${seededCount}h awaiting real data)`
                : `Rojo: data real del XRPL · Gris: estimación inicial (${seededCount}h pendientes de datos reales)`)
            : t('burn.dataReal', 'Data real del XRPL');
    }

    if (realtimeHourlyChartInstance) realtimeHourlyChartInstance.destroy();

    realtimeHourlyChartInstance = new Chart(ctx, {
        type: 'bar',
        data: {
            labels: series.map(s => s.label),
            datasets: [{
                label: t('burn.dsHora', 'XRP quemados por hora'),
                data: series.map(s => s.value),
                backgroundColor: series.map(s => s.seeded ? 'rgba(148, 163, 184, 0.35)' : 'rgba(239, 68, 68, 0.55)'),
                borderColor: series.map(s => s.seeded ? 'rgba(148, 163, 184, 0.6)' : '#ef4444'),
                borderWidth: 1,
                borderRadius: 3
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: { display: false },
                tooltip: {
                    callbacks: {
                        label: (ctx) => ctx.parsed.y.toLocaleString('en-US', { maximumFractionDigits: 2 }) + ' XRP' + (series[ctx.dataIndex] && series[ctx.dataIndex].seeded ? (_isEn() ? ' (estimated)' : ' (estimado)') : '')
                    }
                }
            },
            scales: {
                y: {
                    beginAtZero: true,
                    grid: { color: 'rgba(255,255,255,0.05)' },
                    ticks: {
                        color: '#64748b',
                        font: { size: 10 },
                        callback: v => Number(v).toLocaleString('en-US', { maximumFractionDigits: 0 })
                    }
                },
                x: {
                    grid: { display: false },
                    ticks: { color: '#64748b', font: { size: 9 }, maxRotation: 0 }
                }
            }
        }
    });

    // KPIs auxiliares (última hora real, 24h real)
    const lastHourEl = document.getElementById('live-hour-burn');
    const minBurnEl  = document.getElementById('live-min-burn');
    const last24El   = document.getElementById('live-24h-burn');

    if (rt && typeof rt.lastHourBurned === 'number') {
        if (lastHourEl) lastHourEl.textContent = Math.round(rt.lastHourBurned).toLocaleString('en-US') + ' XRP';
        if (minBurnEl)  minBurnEl.textContent  = (rt.lastHourBurned / 60).toFixed(2);
    }
    if (rt && typeof rt.last24hBurned === 'number' && last24El) {
        last24El.textContent = Math.round(rt.last24hBurned).toLocaleString('en-US') + ' XRP';
    }

    // Lectura práctica de la quema: ponerla en perspectiva del supply
    const real24 = rt && rt.last24hBurned > 0 ? rt.last24hBurned : 0;
    const dailyRef = real24 > 0 ? real24 : (rt && rt.dailyAvgBurn > 0 ? rt.dailyAvgBurn : 0);
    if (dailyRef > 0) {
        const annual = dailyRef * 365;
        const circ = window._circSupply || 0;
        const pctCirc = circ > 0 ? (annual / circ) * 100 : null;
        if (_isEn()) {
            const pctTxt = pctCirc !== null ? ` (≈${pctCirc.toFixed(4)}% of circulating per year)` : '';
            setReading('burn-chart-reading', 'info', 'What this burn rate means',
                `${real24 > 0 ? _fmtNum(real24) + ' real XRP were burned in the last 24h.' : 'Observed average rate: ' + _fmtNum(dailyRef) + ' XRP/day.'} ` +
                `Projected over a year: ~${_fmtNum(annual)} XRP${pctTxt}. Honest reading: the XRPL burn is an anti-spam measure, not a deflationary mechanism capable of moving the price — distrust narratives claiming otherwise.`);
        } else {
            const pctTxt = pctCirc !== null ? ` (≈${pctCirc.toFixed(4)}% del circulante al año)` : '';
            setReading('burn-chart-reading', 'info', 'Qué significa este ritmo de quema',
                `${real24 > 0 ? 'En las últimas 24h se quemaron ' + _fmtNum(real24) + ' XRP reales.' : 'Ritmo promedio observado: ' + _fmtNum(dailyRef) + ' XRP/día.'} ` +
                `Proyectado a un año: ~${_fmtNum(annual)} XRP${pctTxt}. Lectura honesta: la quema del XRPL es una medida anti-spam, no un mecanismo deflacionario capaz de mover el precio — desconfía de narrativas que afirmen lo contrario.`);
        }
    } else {
        setReading('burn-chart-reading', 'warn',
            _isEn() ? 'Waiting for real XRPL data' : 'Esperando datos reales del XRPL',
            _isEn()
                ? 'Grey bars are an initial visual estimate. Real burn will start registering as validated ledgers arrive (every ~4 seconds); within minutes you will see red bars with real data.'
                : 'Las barras grises son una estimación visual inicial. La quema real empezará a registrarse conforme lleguen ledgers validados (cada ~4 segundos); en pocos minutos verás barras rojas con datos reales.');
    }
}

function renderRealtimeSourceBadge(rt, burn) {
    const el = document.getElementById('burn-source-badge');
    if (!el) return;

    const mode = rt ? rt.mode : null;
    let label = t('burn.srcEstimado', 'Estimado');
    let cls = 'src-estimated';
    if (mode === 'websocket') { label = 'XRPL Live · WS'; cls = 'src-live'; }
    else if (mode === 'rest') { label = 'XRPL · REST poll'; cls = 'src-rest'; }
    else if (mode === 'starting') { label = t('burn.srcConectando', 'Conectando a XRPL...'); cls = 'src-starting'; }
    else if (mode === 'failed') { label = t('burn.srcFallo', 'XRPL no accesible'); cls = 'src-failed'; }

    el.className = 'burn-source-badge ' + cls;
    el.textContent = label;
}

// ============================================================
// MÉTRICAS AVANZADAS DE INVERSIÓN (Pestaña "Análisis")
// ============================================================
function renderAdvancedMetrics(am) {
    if (!am) return;

    const fmt = (v, d = 2) => (v === null || v === undefined) ? '--' : new Intl.NumberFormat('en-US', { minimumFractionDigits: d, maximumFractionDigits: d }).format(v);
    const fmtUsd = (v) => (v === null || v === undefined) ? '--' : _fmtPrice(v); // V2.5: adaptativo (SMAs de BTC en miles)
    const pctBadge = (v, invert = false) => {
        if (v === null || v === undefined) return '<span class="am-badge am-neutral">--</span>';
        const good = invert ? v < 0 : v >= 0;
        return `<span class="am-badge ${good ? 'am-pos' : 'am-neg'}">${v >= 0 ? '+' : ''}${fmt(v)}%</span>`;
    };

    // --- Score Compuesto ---
    const scoreEl = document.getElementById('analysis-score');
    if (scoreEl && am.compositeScore) {
        const s = am.compositeScore;
        let color = '#eab308';
        if (s.value >= 65) color = '#22c55e';
        else if (s.value <= 40) color = '#ef4444';

        const factorsHtml = (s.factors || []).map(f => `
            <div class="am-factor">
                <span class="am-factor-name">${_pick(f.factor, f.factorEn)}</span>
                <span class="am-factor-detail">${_pick(f.detail, f.detailEn)}</span>
                <span class="am-badge ${f.impact > 0 ? 'am-pos' : (f.impact < 0 ? 'am-neg' : 'am-neutral')}">${f.impact > 0 ? '+' : ''}${f.impact}</span>
            </div>
        `).join('');

        // Lectura práctica del score: qué suma, qué resta y cómo usarlo
        const en = _isEn();
        const topPos = (s.factors || []).filter(f => f.impact > 0).sort((a, b) => b.impact - a.impact)[0];
        const topNeg = (s.factors || []).filter(f => f.impact < 0).sort((a, b) => a.impact - b.impact)[0];
        const scoreTone = s.value >= 65 ? 'pos' : (s.value <= 40 ? 'neg' : 'info');
        const partes = [];
        if (topPos) partes.push(en
            ? `Biggest positive: ${_pick(topPos.factor, topPos.factorEn)} (${_pick(topPos.detail, topPos.detailEn).toLowerCase()})`
            : `Lo que más suma: ${topPos.factor} (${topPos.detail.toLowerCase()})`);
        if (topNeg) partes.push(en
            ? `biggest drag: ${_pick(topNeg.factor, topNeg.factorEn)} (${_pick(topNeg.detail, topNeg.detailEn).toLowerCase()})`
            : `lo que más resta: ${topNeg.factor} (${topNeg.detail.toLowerCase()})`);
        const scoreReading = readingHTML(scoreTone,
            en ? `How to read the ${s.value}/100 score` : `Cómo leer el score de ${s.value}/100`,
            `${partes.length ? partes.join('; ') + '. ' : ''}` + (en
                ? 'Use it as a technical-context thermometer, not a buy/sell order: a high score can coincide with overbought conditions, and a low one with capitulations that keep extending.'
                : 'Úsalo como termómetro de contexto técnico, no como orden de compra/venta: un score alto puede coincidir con sobrecompra y uno bajo con capitulaciones que aún se extienden.'));

        scoreEl.innerHTML = `
            <div class="am-score-wrap">
                <div class="am-score-gauge">
                    <div class="am-score-value" style="color:${color}; text-shadow:0 0 20px ${color}50;">${s.value}</div>
                    <div class="am-score-label" style="color:${color};">${_pick(s.label, s.labelEn)}</div>
                    <div class="am-score-bar"><div style="width:${s.value}%; background:${color};"></div></div>
                    <div class="am-score-scale"><span>0 · ${t('an.escalaBajista', 'Bajista')}</span><span>50</span><span>100 · ${t('an.escalaAlcista', 'Alcista')}</span></div>
                </div>
                <div class="am-factors">${factorsHtml}</div>
            </div>
            ${scoreReading}
        `;
    }

    // --- Insights ---
    const insightsEl = document.getElementById('analysis-insights');
    if (insightsEl) {
        const list = am.insights || [];
        insightsEl.innerHTML = list.length === 0
            ? `<p class="analysis-loading">${t('an.sinInsights', 'Sin señales destacadas en este momento. Mercado sin extremos técnicos.')}</p>`
            : list.map(i => `
                <div class="am-insight am-insight-${i.level || 'neutro'}">
                    <span class="am-insight-icon">${i.icon || '•'}</span>
                    <span>${_pick(i.text, i.textEn)}</span>
                </div>
            `).join('');
    }

    // --- Tendencia & Momentum ---
    const trendEl = document.getElementById('analysis-trend');
    if (trendEl && am.trend && am.momentum) {
        const t = am.trend, m = am.momentum;
        const en = _isEn();
        const crossLabels = en ? {
            'GOLDEN_CROSS': ['🟢 Golden Cross', '#22c55e'],
            'DEATH_CROSS': ['🔴 Death Cross', '#ef4444'],
            'TENDENCIA_ALCISTA': ['Bullish (SMA50 > SMA200)', '#22c55e'],
            'TENDENCIA_BAJISTA': ['Bearish (SMA50 < SMA200)', '#ef4444'],
            'NINGUNO': ['Insufficient data', '#94a3b8']
        } : {
            'GOLDEN_CROSS': ['🟢 Golden Cross', '#22c55e'],
            'DEATH_CROSS': ['🔴 Death Cross', '#ef4444'],
            'TENDENCIA_ALCISTA': ['Alcista (SMA50 > SMA200)', '#22c55e'],
            'TENDENCIA_BAJISTA': ['Bajista (SMA50 < SMA200)', '#ef4444'],
            'NINGUNO': ['Sin datos suficientes', '#94a3b8']
        };
        const [crossText, crossColor] = crossLabels[t.crossSignal] || crossLabels['NINGUNO'];
        let rsiZone = 'Neutral', rsiColor = '#eab308';
        if (m.rsi14 !== null) {
            if (m.rsi14 > 70) { rsiZone = en ? 'Overbought' : 'Sobrecompra'; rsiColor = '#ef4444'; }
            else if (m.rsi14 < 30) { rsiZone = en ? 'Oversold' : 'Sobreventa'; rsiColor = '#22c55e'; }
        }

        trendEl.innerHTML = `
            <div class="am-row"><span>${en ? 'RSI 14 (daily)' : 'RSI 14 (diario)'}</span><span><strong style="color:${rsiColor};">${fmt(m.rsi14)}</strong> · ${rsiZone}</span></div>
            <div class="am-row"><span>MACD (hist.)</span><span class="am-badge ${m.macdHistogram > 0 ? 'am-pos' : 'am-neg'}">${m.macdHistogram > 0 ? 'Momentum +' : 'Momentum −'} (${fmt(m.macdHistogram, 5)})</span></div>
            <div class="am-row"><span>SMA 20</span><span>${fmtUsd(t.sma20)}</span></div>
            <div class="am-row"><span>SMA 50</span><span>${fmtUsd(t.sma50)} ${pctBadge(t.priceVsSma50Pct)}</span></div>
            <div class="am-row"><span>SMA 200</span><span>${fmtUsd(t.sma200)} ${pctBadge(t.priceVsSma200Pct)}</span></div>
            <div class="am-row"><span>${en ? 'MA cross' : 'Cruce de medias'}</span><span style="color:${crossColor}; font-weight:700;">${crossText}</span></div>
            ${m.bollinger ? `<div class="am-row"><span>Bollinger %B</span><span>${fmt(m.bollinger.percentB, 2)} <span class="am-sub">${en ? '(0 = lower band · 1 = upper band)' : '(0 = banda inf · 1 = banda sup)'}</span></span></div>` : ''}
        `;
    }

    // --- Riesgo ---
    const riskEl = document.getElementById('analysis-risk');
    if (riskEl && am.risk) {
        const r = am.risk;
        const en = _isEn();
        const volLevel = r.volatility30dAnnualizedPct > 90
            ? [en ? 'Very High' : 'Muy Alta', '#ef4444']
            : (r.volatility30dAnnualizedPct > 60 ? [en ? 'High' : 'Alta', '#f59e0b'] : [en ? 'Moderate' : 'Moderada', '#22c55e']);
        riskEl.innerHTML = `
            <div class="am-row"><span>${en ? 'Annualized volatility (30d)' : 'Volatilidad anualizada (30d)'}</span><span><strong style="color:${volLevel[1]};">${fmt(r.volatility30dAnnualizedPct)}%</strong> · ${volLevel[0]}</span></div>
            <div class="am-row"><span>${en ? 'Annualized volatility (90d)' : 'Volatilidad anualizada (90d)'}</span><span>${fmt(r.volatility90dAnnualizedPct)}%</span></div>
            <div class="am-row"><span>${en ? 'Max Drawdown (1 year)' : 'Max Drawdown (1 año)'}</span><span class="am-badge am-neg">${fmt(r.maxDrawdown1yPct)}%</span></div>
            <div class="am-row"><span>Sharpe Ratio (90d)</span><span class="am-badge ${r.sharpeRatio90d >= 0 ? 'am-pos' : 'am-neg'}">${fmt(r.sharpeRatio90d)}</span></div>
            <div class="am-row"><span>${en ? 'VaR 95% (daily)' : 'VaR 95% (diario)'}</span><span>${fmt(r.var95DailyPct)}% <span class="am-sub">${en ? 'max expected loss on a "normal bad" day' : 'pérdida máx. esperada en un día "normal malo"'}</span></span></div>
            ${am.underwaterApprox ? `<div class="am-row"><span>${en ? 'Underwater holders (approx.)' : 'Holders "bajo el agua" (aprox.)'} <span class="badge-estimated-inline" title="${_pick(am.underwaterApprox.methodology, am.underwaterApprox.methodologyEn)}">${t('badge.estimado', '≈ estimado')}</span></span><span class="am-badge ${am.underwaterApprox.pctDaysAboveCurrentPrice > 50 ? 'am-neg' : 'am-pos'}">${fmt(am.underwaterApprox.pctDaysAboveCurrentPrice)}%</span></div>` : ''}
        `;
        if (am.underwaterApprox) {
            const uw = am.underwaterApprox;
            const tone = uw.pctDaysAboveCurrentPrice > 50 ? 'warn' : 'info';
            riskEl.innerHTML += en
                ? readingHTML(tone, `${uw.pctDaysAboveCurrentPrice}% of the last ${uw.daysSampled} days closed above the current price`,
                    `Methodological approximation (not real on-chain realized price): the more closing days above today's price, the more likely a large share of recent buyers sits on unrealized losses. ${uw.pctDaysAboveCurrentPrice > 50 ? 'This can create sell pressure as they recover their break-even point (psychological resistance).' : 'Most recent buyers are in profit, per this approximation.'}`)
                : readingHTML(tone, `${uw.pctDaysAboveCurrentPrice}% de los últimos ${uw.daysSampled} días cerraron por encima del precio actual`,
                    `Aproximación metodológica (no es precio realizado on-chain real): cuantos más días de cierre por encima del precio de hoy, más probable que una porción grande de compradores recientes esté en pérdidas no realizadas. ${uw.pctDaysAboveCurrentPrice > 50 ? 'Esto puede generar presión de venta al recuperar el "punto de equilibrio" (resistencia psicológica).' : 'La mayoría de compradores recientes está en ganancias, según esta aproximación.'}`);
        }
    }

    // --- Rendimiento & 52 semanas ---
    const perfEl = document.getElementById('analysis-perf');
    if (perfEl && am.performance && am.range52w) {
        const p = am.performance, r = am.range52w;
        perfEl.innerHTML = `
            <div class="am-perf-grid">
                <div class="am-perf-cell"><span class="am-sub">${t('an.d7', '7 días')}</span>${pctBadge(p.d7)}</div>
                <div class="am-perf-cell"><span class="am-sub">${t('an.d30', '30 días')}</span>${pctBadge(p.d30)}</div>
                <div class="am-perf-cell"><span class="am-sub">${t('an.d90', '90 días')}</span>${pctBadge(p.d90)}</div>
                <div class="am-perf-cell"><span class="am-sub">${t('an.d365', '1 año')}</span>${pctBadge(p.d365)}</div>
            </div>
            <div class="am-row"><span>${t('an.max52', 'Máximo 52 semanas')}</span><span>${fmtUsd(r.high)} <span class="am-badge am-neg">${fmt(r.fromHighPct)}%</span></span></div>
            <div class="am-row"><span>${t('an.min52', 'Mínimo 52 semanas')}</span><span>${fmtUsd(r.low)} <span class="am-badge am-pos">+${fmt(r.fromLowPct)}%</span></span></div>
        `;
    }

    // --- Correlación & Liquidez ---
    const corrEl = document.getElementById('analysis-corr');
    if (corrEl && am.correlation) {
        const c = am.correlation;
        const l = am.liquidity || {};
        const en = _isEn();
        const corrText = (v, ref) => {
            if (v === null || v === undefined) return '--';
            if (v > 0.7) return en ? `Strong: XRP follows ${ref}` : `Fuerte: XRP sigue a ${ref}`;
            if (v > 0.4) return en ? 'Moderate' : 'Moderada';
            if (v > 0.1) return en ? 'Weak: own narrative' : 'Débil: narrativa propia';
            return en ? 'Uncorrelated' : 'Descorrelacionado';
        };
        corrEl.innerHTML = `
            <div class="am-row"><span>${en ? 'XRP-BTC correlation (30d)' : 'Correlación XRP-BTC (30d)'}</span><span><strong>${c.btc30d !== null ? (c.btc30d * 100).toFixed(0) + '%' : '--'}</strong> · ${corrText(c.btc30d, 'BTC')}</span></div>
            <div class="am-row"><span>${en ? 'XRP-BTC correlation (90d)' : 'Correlación XRP-BTC (90d)'}</span><span>${c.btc90d !== null ? (c.btc90d * 100).toFixed(0) + '%' : '--'}</span></div>
            <div class="am-row"><span>${en ? 'BTC performance (30d)' : 'BTC rendimiento (30d)'}</span><span>${pctBadge(c.btcPerf30dPct)}</span></div>
            <div class="am-row"><span>${en ? 'XRP-ETH correlation (30d)' : 'Correlación XRP-ETH (30d)'} <span class="am-sub">${en ? 'altcoin proxy' : 'proxy altcoins'}</span></span><span><strong>${c.eth30d !== null && c.eth30d !== undefined ? (c.eth30d * 100).toFixed(0) + '%' : '--'}</strong> · ${corrText(c.eth30d, 'ETH')}</span></div>
            <div class="am-row"><span>${en ? 'XRP-ETH correlation (90d)' : 'Correlación XRP-ETH (90d)'}</span><span>${c.eth90d !== null && c.eth90d !== undefined ? (c.eth90d * 100).toFixed(0) + '%' : '--'}</span></div>
            <div class="am-row"><span>${en ? 'ETH performance (30d)' : 'ETH rendimiento (30d)'}</span><span>${pctBadge(c.ethPerf30dPct)}</span></div>
            <div class="am-row"><span>${en ? 'XRP-SPY correlation (30d)' : 'Correlación XRP-SPY (30d)'} <span class="am-sub" title="${c.spyNote || ''}">${en ? 'S&amp;P 500 · trading sessions' : 'S&amp;P 500 · sesiones bursátiles'}</span></span><span><strong>${c.spy30d !== null && c.spy30d !== undefined ? (c.spy30d * 100).toFixed(0) + '%' : '--'}</strong> · ${corrText(c.spy30d, en ? 'stocks' : 'la bolsa')}</span></div>
            <div class="am-row"><span>${en ? 'XRP-SPY correlation (90d)' : 'Correlación XRP-SPY (90d)'}</span><span>${c.spy90d !== null && c.spy90d !== undefined ? (c.spy90d * 100).toFixed(0) + '%' : '--'}</span></div>
            <div class="am-row"><span>${en ? 'SPY performance (30d)' : 'SPY rendimiento (30d)'}</span><span>${pctBadge(c.spyPerf30dPct)}</span></div>
            <div class="am-row"><span>${en ? 'Volume / Market Cap' : 'Volumen / Market Cap'}</span><span><strong>${fmt(l.volumeMarketCapRatioPct)}%</strong> <span class="am-sub">${en ? 'liquidity health (>5% = active)' : 'salud de liquidez (>5% = activa)'}</span></span></div>
            <div class="am-row"><span>${en ? 'Last updated' : 'Última actualización'}</span><span class="am-sub">${am.lastUpdated ? new Date(am.lastUpdated).toLocaleTimeString() : '--'}</span></div>
        `;
        if (c.btc30d != null && c.eth30d != null) {
            const avg = (c.btc30d + c.eth30d) / 2;
            const tone = avg > 0.6 ? 'info' : (avg < 0.2 ? 'pos' : 'info');
            // V2.3: incorporar SPY a la lectura conjunta — distingue "arrastrado por
            // cripto", "arrastrado por el macro tradicional (riesgo global)" o "narrativa propia".
            let spyTxt = '';
            if (c.spy30d != null) {
                spyTxt = c.spy30d > 0.5
                    ? (en
                        ? ` Also, S&P 500 correlation is high (${(c.spy30d * 100).toFixed(0)}%): XRP is behaving like a global risk asset — watch interest rates and stocks too, not just crypto.`
                        : ` Además, la correlación con el S&P 500 es alta (${(c.spy30d * 100).toFixed(0)}%): XRP se está comportando como activo de riesgo global — vigila también tasas de interés y bolsa, no solo cripto.`)
                    : (en
                        ? ` S&P 500 correlation is low (${(c.spy30d * 100).toFixed(0)}%): traditional markets aren't dictating XRP's price right now.`
                        : ` La correlación con el S&P 500 es baja (${(c.spy30d * 100).toFixed(0)}%): el mercado tradicional no está dictando el precio de XRP ahora mismo.`);
            }
            corrEl.innerHTML += readingHTML(tone,
                en ? (avg > 0.6 ? 'XRP moves with the market' : 'XRP with some narrative of its own') : (avg > 0.6 ? 'XRP se mueve con el mercado' : 'XRP con cierta narrativa propia'),
                (avg > 0.6
                    ? (en
                        ? `High correlation with BTC (${(c.btc30d * 100).toFixed(0)}%) and ETH (${(c.eth30d * 100).toFixed(0)}%): the broad crypto macro outweighs Ripple-specific news in the short term.`
                        : `Correlación alta con BTC (${(c.btc30d * 100).toFixed(0)}%) y ETH (${(c.eth30d * 100).toFixed(0)}%): el macro cripto general pesa más que las noticias específicas de Ripple en el corto plazo.`)
                    : (en
                        ? `Moderate/low correlation with BTC (${(c.btc30d * 100).toFixed(0)}%) and ETH (${(c.eth30d * 100).toFixed(0)}%): XRP is trading on its own catalysts (legal, adoption, escrow) rather than being dragged by the market.`
                        : `Correlación moderada/baja con BTC (${(c.btc30d * 100).toFixed(0)}%) y ETH (${(c.eth30d * 100).toFixed(0)}%): XRP está cotizando con catalizadores propios (legales, adopción, escrow) más que arrastrado por el mercado.`)) + spyTxt);
        }
    }
}

// ============================================================
// ===================== V2.0 ================================
// ============================================================

// Números compactos legibles: 66.49B en lugar de 66,487,000,000
function fmtCompact(v, decimals = 2) {
    const n = Number(v) || 0;
    const abs = Math.abs(n);
    const sign = n < 0 ? '-' : '';
    if (abs >= 1e9) return sign + (abs / 1e9).toFixed(decimals) + 'B';
    if (abs >= 1e6) return sign + (abs / 1e6).toFixed(decimals) + 'M';
    if (abs >= 1e3) return sign + (abs / 1e3).toFixed(1) + 'K';
    return sign + abs.toFixed(0);
}

// --- Precio siempre visible en el header ---
function renderHeaderPrice(md) {
    if (!md || md.price === undefined) return;
    const priceEl = document.getElementById('header-price');
    const chEl = document.getElementById('header-price-change');
    if (!priceEl || !chEl) return;
    const ch = md.priceChange24h || 0;
    priceEl.textContent = _fmtPrice(md.price);
    chEl.textContent = (ch >= 0 ? '▲ +' : '▼ ') + ch.toFixed(2) + '%';
    chEl.className = 'header-price-change ' + (ch >= 0 ? 'text-green' : 'text-red');
}

// --- TAB RESUMEN: la vista de 10 segundos ---
let heroSparklineInstance = null;

function renderResumen(data) {
    const md = data.marketData || {};
    const brief = data.dailyBrief || null;
    const tones = { pos: '#22c55e', neg: '#ef4444', warn: '#f59e0b', info: '#0ea5e9' };

    // ---- HERO ----
    // V2.5: etiqueta del hero y titular del brief con la moneda activa
    const heroLabelEl = document.getElementById('hero-coin-label');
    if (heroLabelEl) {
        heroLabelEl.textContent = _isXrpActive()
            ? t('hero.xrpAhora', 'XRP ahora')
            : `${_coinSym()} ${_isEn() ? 'now' : 'ahora'}`;
    }
    const cristianoEl = document.querySelector('[data-i18n="resumen.encristiano"]');
    if (cristianoEl) {
        cristianoEl.textContent = _isXrpActive()
            ? t('resumen.encristiano', 'El mercado de XRP, en cristiano')
            : (_isEn() ? `The ${_coinSym()} market, in plain English` : `El mercado de ${_coinSym()}, en cristiano`);
    }
    const priceEl = document.getElementById('hero-price');
    const changeEl = document.getElementById('hero-change');
    const subEl = document.getElementById('hero-sub');
    if (priceEl && md.price !== undefined) {
        const ch = md.priceChange24h || 0;
        priceEl.textContent = _fmtPrice(md.price);
        changeEl.textContent = (ch >= 0 ? '▲ +' : '▼ ') + ch.toFixed(2) + '% (24h)';
        changeEl.className = 'variation-badge ' + (ch >= 0 ? 'badge-up' : 'badge-down');
        subEl.textContent = _isEn()
            ? `Mkt cap ${fmtCompact(md.marketCap)} USD · 24h volume ${fmtCompact(md.volume24h)} USD`
            : `Cap. ${fmtCompact(md.marketCap)} USD · Volumen 24h ${fmtCompact(md.volume24h)} USD`;
    }

    // Sparkline 30 días (usa chartData si cubre suficiente historial)
    try {
        const canvas = document.getElementById('heroSparkline');
        if (canvas && Array.isArray(data.chartData) && data.chartData.length > 10) {
            const cutoff = Date.now() - 30 * 86400000;
            const pts = data.chartData.filter(p => p[0] >= cutoff);
            if (pts.length >= 5) {
                const prices = pts.map(p => p[1]);
                const up = prices[prices.length - 1] >= prices[0];
                if (heroSparklineInstance) heroSparklineInstance.destroy();
                heroSparklineInstance = new Chart(canvas.getContext('2d'), {
                    type: 'line',
                    data: {
                        labels: pts.map(p => new Date(p[0]).toLocaleDateString(_dLoc(), { day: 'numeric', month: 'short' })),
                        datasets: [{
                            data: prices,
                            borderColor: up ? '#22c55e' : '#ef4444',
                            backgroundColor: 'transparent',
                            borderWidth: 2,
                            pointRadius: 0,
                            tension: 0.35
                        }]
                    },
                    options: {
                        responsive: true, maintainAspectRatio: false,
                        plugins: { legend: { display: false }, tooltip: { callbacks: { label: (c) => _fmtUsd(c.parsed.y, 4) } } },
                        scales: { x: { display: false }, y: { display: false } }
                    }
                });
            }
        }
    } catch (e) { console.error('Error sparkline:', e); }

    // Chips: score, F&G, escrow, posición en rango 52s
    const chipsEl = document.getElementById('hero-chips');
    if (chipsEl) {
        const chips = [];
        const score = data.advancedMetrics?.compositeScore;
        if (score) {
            const c = score.value >= 65 ? '#22c55e' : (score.value <= 40 ? '#ef4444' : '#eab308');
            chips.push(`<div class="hero-chip" style="border-color:${c}55;"><span class="chip-label">${t('chip.score', 'Score técnico')}</span><span class="chip-val" style="color:${c};">${score.value}/100</span><span class="chip-sub">${_pick(score.label, score.labelEn).toLowerCase()}</span></div>`);
        }
        if (data.sentiment?.value !== undefined) {
            const v = data.sentiment.value;
            const c = v <= 25 ? '#ef4444' : (v >= 75 ? '#22c55e' : '#eab308');
            // La clasificación de Alternative.me llega en inglés: traducir solo en ES
            const fgMap = { 'Extreme Fear': 'Miedo extremo', 'Fear': 'Miedo', 'Neutral': 'Neutral', 'Greed': 'Codicia', 'Extreme Greed': 'Codicia extrema' };
            const fgCls = data.sentiment.classification || '';
            chips.push(`<div class="hero-chip" style="border-color:${c}55;"><span class="chip-label">${t('chip.fg', 'Miedo / Codicia')}</span><span class="chip-val" style="color:${c};">${v}</span><span class="chip-sub">${_isEn() ? fgCls : (fgMap[fgCls] || fgCls)}</span></div>`);
        }
        if (data.events?.daysUntilEscrow !== undefined) {
            chips.push(`<div class="hero-chip"><span class="chip-label">${t('chip.escrow', 'Próximo escrow')}</span><span class="chip-val" style="color:#0ea5e9;">${data.events.daysUntilEscrow} ${t('chip.dias', 'días')}</span><span class="chip-sub">${t('chip.escrowSub', '1B XRP programado')}</span></div>`);
        }
        const r52 = data.advancedMetrics?.range52w;
        if (r52 && md.price) {
            const pos = ((md.price - r52.low) / Math.max(r52.high - r52.low, 1e-9)) * 100;
            chips.push(`<div class="hero-chip"><span class="chip-label">${t('chip.rango', 'Rango 52 semanas')}</span><span class="chip-val">${pos.toFixed(0)}%</span><span class="chip-sub">${_fmtUsd(r52.low, 2)} – ${_fmtUsd(r52.high, 2)}</span></div>`);
        }
        chipsEl.innerHTML = chips.join('');
    }

    // ---- VEREDICTO + SEÑALES ----
    const headEl = document.getElementById('brief-headline');
    const sigEl = document.getElementById('brief-signals');
    if (headEl && sigEl) {
        if (brief && Array.isArray(brief.señales) && brief.señales.length > 0) {
            const c = tones[brief.tone] || tones.info;
            // V2.4: señales bilingües — el server emite text/textEn y area/areaEn.
            // Para briefs viejos en data.json (sin textEn) se cae a la plantilla EN
            // por tono en el titular y al español en las señales.
            const headlineTxt = _pick(brief.headline, brief.headlineEn || t('brief.' + (brief.tone || 'info'), brief.headline));
            headEl.innerHTML = `<div class="brief-headline" style="border-color:${c}66; background:${c}12;"><span style="color:${c};">●</span> ${headlineTxt}</div>`;
            sigEl.innerHTML = brief.señales.map(s => `
                <div class="brief-signal">
                    <span class="signal-dot" style="background:${tones[s.tone] || tones.info};"></span>
                    <div class="signal-body">
                        <span class="signal-area">${_pick(s.area, s.areaEn)}</span>
                        <span class="signal-text">${_pick(s.text, s.textEn)}</span>
                    </div>
                </div>
            `).join('');
        } else {
            headEl.innerHTML = '';
            sigEl.innerHTML = `<p class="analysis-loading">${t('resumen.esperando', 'El resumen se genera al completarse el primer ciclo de datos (~1 minuto tras arrancar). Si acabas de abrir el dashboard, espera un momento y pulsa Refrescar.')}</p>`;
        }
    }

    // ---- NIVELES A VIGILAR ----
    const lvlEl = document.getElementById('brief-levels');
    if (lvlEl) {
        const nv = brief?.niveles;
        if (nv && (nv.soporte || nv.resistencia)) {
            const price = md.price || 0;
            const distSop = nv.soporte ? (((price - nv.soporte) / price) * 100) : null;
            const distRes = nv.resistencia ? (((nv.resistencia - price) / price) * 100) : null;
            // El precio puede estar POR DEBAJO del soporte o POR ENCIMA de la resistencia:
            // en esos casos decir "roto/superada" en lugar de un porcentaje con signo raro.
            const sopTxt = distSop === null ? '' : (distSop >= 0
                ? '−' + distSop.toFixed(1) + '% ' + t('nivel.abajo', 'abajo')
                : (_isEn() ? 'broken: price ' + Math.abs(distSop).toFixed(1) + '% below' : 'roto: precio ' + Math.abs(distSop).toFixed(1) + '% debajo'));
            const resTxt = distRes === null ? '' : (distRes >= 0
                ? '+' + distRes.toFixed(1) + '% ' + t('nivel.arriba', 'arriba')
                : (_isEn() ? 'cleared by ' + Math.abs(distRes).toFixed(1) + '%' : 'superada por ' + Math.abs(distRes).toFixed(1) + '%'));
            lvlEl.innerHTML = `
                <div class="level-row"><span class="level-name" style="color:#22c55e;">${t('nivel.soporte', 'Soporte (7d)')}</span><span class="level-val">${nv.soporte ? _fmtPrice(nv.soporte) : '--'}</span><span class="level-dist">${sopTxt}</span></div>
                <div class="level-row"><span class="level-name" style="color:#ef4444;">${t('nivel.resistencia', 'Resistencia (7d)')}</span><span class="level-val">${nv.resistencia ? _fmtPrice(nv.resistencia) : '--'}</span><span class="level-dist">${resTxt}</span></div>
                ${nv.psicologico ? `<div class="level-row"><span class="level-name" style="color:#eab308;">${t('nivel.psicologico', 'Psicológico')}</span><span class="level-val">${_fmtUsd(nv.psicologico, 2)}</span><span class="level-dist">${t('nivel.redonda', 'cifra redonda vigilada')}</span></div>` : ''}
                <p class="level-note">${_pick(nv.nota, nv.notaEn) || ''}</p>
            `;
        } else {
            lvlEl.innerHTML = `<p class="analysis-loading">${t('resumen.espNiveles', 'Esperando cálculo de niveles...')}</p>`;
        }
    }

    // ---- MINI DERIVADOS ----
    const derEl = document.getElementById('brief-derivatives');
    if (derEl) {
        const dv = data.derivatives;
        if (dv && dv.fundingRate8hPct !== undefined) {
            const f = dv.fundingRate8hPct;
            const fC = f > 0.01 ? '#f59e0b' : (f < -0.01 ? '#22c55e' : '#94a3b8');
            const fTxt = f > 0.01 ? t('drv.largosPagan', 'largos pagan') : (f < -0.01 ? t('drv.cortosPagan', 'cortos pagan') : t('drv.neutro', 'neutro'));
            derEl.innerHTML = `
                <div class="level-row"><span class="level-name">Funding (8h eq.)</span><span class="level-val" style="color:${fC};">${f.toFixed(4)}%</span><span class="level-dist">${fTxt}</span></div>
                <div class="level-row"><span class="level-name">Open Interest</span><span class="level-val">${fmtCompact(dv.openInterestXrp)} ${_coinSym()}</span><span class="level-dist">≈ $${fmtCompact(dv.openInterestUsd)}</span></div>
                <p class="level-note">${_isEn() ? `Funding shows which way leverage is loaded. Sample: ${dv.venue || 'Kraken Futures'}.` : `El funding indica hacia dónde está cargado el apalancamiento. Muestra: ${dv.venue || 'Kraken Futures'}.`}</p>
            `;
        } else {
            derEl.innerHTML = `<p class="analysis-loading">${t('drv.sinDatosMini', 'Sin datos de derivados aún.')}</p>`;
        }
    }

    // ---- MINI ECOSISTEMA ----
    const ecoEl = document.getElementById('brief-ecosystem');
    if (ecoEl) {
        const eco = data.ecosystem;
        if (eco && (eco.rlusdMarketCapUsd || eco.btcDominancePct)) {
            ecoEl.innerHTML = `
                ${eco.rlusdMarketCapUsd ? `<div class="level-row"><span class="level-name">${t('eco.rlusdEmitido', 'RLUSD emitido')}</span><span class="level-val">$${fmtCompact(eco.rlusdMarketCapUsd)}</span><span class="level-dist">${t('eco.stableRipple', 'stablecoin de Ripple')}</span></div>` : ''}
                ${eco.xrpDominancePct != null ? `<div class="level-row"><span class="level-name">${t('eco.domXrp', 'Dominancia XRP')}</span><span class="level-val">${eco.xrpDominancePct.toFixed(2)}%</span><span class="level-dist">${t('eco.delMercado', 'del mercado cripto')}</span></div>` : ''}
                ${eco.btcDominancePct != null ? `<div class="level-row"><span class="level-name">${t('eco.domBtc', 'Dominancia BTC')}</span><span class="level-val">${eco.btcDominancePct.toFixed(1)}%</span><span class="level-dist">${t('eco.ctxMacro', 'contexto macro')}</span></div>` : ''}
                <p class="level-note">${t('eco.notaMini', 'RLUSD creciendo = más liquidación institucional vía XRPL (proxy de adopción).')}</p>
            `;
        } else {
            ecoEl.innerHTML = `<p class="analysis-loading">${t('eco.sinDatosMini', 'Sin datos de ecosistema aún.')}</p>`;
        }
    }

    // ---- FRESCURA DE FUENTES ----
    const qEl = document.getElementById('brief-quality');
    if (qEl && brief && Array.isArray(brief.dataQuality)) {
        const isEn = _isEn();
        qEl.innerHTML = `<span class="quality-title">${t('quality.title', 'Frescura de datos:')}</span> ` + brief.dataQuality.map(q => {
            const ok = !q.stale;
            const srcName = _pick(q.source, q.sourceEn);
            const age = q.ageMinutes === null ? t('quality.sinDatos', 'sin datos')
                : (q.ageMinutes < 1 ? t('quality.ahora', 'ahora')
                : (isEn ? `${q.ageMinutes} min ${t('quality.hace', 'ago')}` : `hace ${q.ageMinutes} min`));
            return `<span class="quality-pill ${ok ? 'quality-ok' : 'quality-stale'}" title="${srcName}: ${isEn ? 'updated' : 'actualizado'} ${age}"><span class="dot" style="background:${ok ? '#22c55e' : '#f59e0b'};"></span>${srcName.split(' (')[0]} · ${age}</span>`;
        }).join('');
    }
}

// --- TARJETA DERIVADOS (tab Mercado) ---
function renderDerivatives(dv) {
    const el = document.querySelector('#derivatives-card .card-content');
    if (!el) return;
    if (!dv || dv.fundingRate8hPct === undefined) {
        el.innerHTML = `<p class="analysis-loading">${t('drv.sinDatos', 'Sin datos de derivados todavía (se obtienen de Kraken Futures en cada ciclo).')}</p>`;
        return;
    }

    const f8 = dv.fundingRate8hPct;
    const fAnnual = dv.fundingRateAnnualPct;
    const fC = f8 > 0.01 ? '#f59e0b' : (f8 < -0.01 ? '#22c55e' : '#94a3b8');
    const en = _isEn();

    let tone = 'info';
    let title = en ? 'Neutral funding' : 'Funding neutro';
    let text = en
        ? `Funding sits at ${f8.toFixed(4)}% per 8h: the futures market isn't loaded in either direction. No leverage signal.`
        : `El funding está en ${f8.toFixed(4)}% por 8h: el mercado de futuros no está cargado hacia ningún lado. Sin señal de apalancamiento.`;
    if (f8 > 0.01) {
        tone = 'warn';
        title = en ? 'Leveraged longs pay to hold' : 'Largos apalancados pagan por mantener posición';
        text = en
            ? `Funding +${f8.toFixed(4)}%/8h (≈${fAnnual.toFixed(1)}% annualized): leveraged optimism. If price falls, those long positions can liquidate in cascade and accelerate the drop.`
            : `Funding +${f8.toFixed(4)}%/8h (≈${fAnnual.toFixed(1)}% anualizado): hay optimismo apalancado. Si el precio cae, esas posiciones largas pueden liquidarse en cascada y acelerar la caída.`;
    } else if (f8 < -0.01) {
        tone = 'pos';
        title = en ? 'Shorts pay to hold' : 'Cortos pagan por mantener posición';
        text = en
            ? `Funding ${f8.toFixed(4)}%/8h (≈${fAnnual.toFixed(1)}% annualized): pessimism is saturated in futures. Historically these extremes sometimes precede short-squeeze bounces.`
            : `Funding ${f8.toFixed(4)}%/8h (≈${fAnnual.toFixed(1)}% anualizado): el pesimismo está saturado en futuros. Históricamente estos extremos a veces preceden rebotes por short squeeze.`;
    }

    const honestNote = en
        ? 'Honest note: this is a sample of venues, not the global derivatives market.'
        : (dv.note || 'Nota honesta: es solo Kraken Futures — una muestra, no el mercado global de derivados.');

    el.innerHTML = `
        <div class="deriv-grid">
            <div class="deriv-item">
                <span class="deriv-label">Funding rate (8h eq.)</span>
                <span class="deriv-val" style="color:${fC};">${f8 >= 0 ? '+' : ''}${f8.toFixed(4)}%</span>
                <span class="deriv-sub">${t('drv.proximo', 'próximo:')} ${dv.fundingPredictionHourlyPct !== undefined ? (dv.fundingPredictionHourlyPct * 8).toFixed(4) + '%/8h' : '--'}</span>
            </div>
            <div class="deriv-item">
                <span class="deriv-label">Open Interest</span>
                <span class="deriv-val">${fmtCompact(dv.openInterestXrp)} ${_coinSym()}</span>
                <span class="deriv-sub">≈ $${fmtCompact(dv.openInterestUsd)} ${t('drv.abiertos', 'abiertos')}</span>
            </div>
            <div class="deriv-item">
                <span class="deriv-label">${t('drv.volFuturos', 'Volumen futuros (24h)')}</span>
                <span class="deriv-val">${dv.volume24hXrp != null ? fmtCompact(dv.volume24hXrp) + ' ' + _coinSym() : '--'}</span>
                <span class="deriv-sub">${dv.change24hPct != null ? `${dv.change24hPct >= 0 ? '+' : ''}${dv.change24hPct.toFixed(2)}% ${t('drv.precio24h', 'precio 24h')}` : ''}</span>
            </div>
        </div>
        ${readingHTML(tone, title, text + ' ' + honestNote)}
        ${Array.isArray(dv.venues) && dv.venues.length > 1 ? `
        <div style="margin-top:0.5rem; font-size:0.7rem; color:#94a3b8;">
            ${dv.venues.map(v => `<div>${v.name}: funding ${v.fundingRate8hPct >= 0 ? '+' : ''}${v.fundingRate8hPct.toFixed(4)}%/8h · OI ${fmtCompact(v.openInterestXrp)} ${_coinSym()}</div>`).join('')}
        </div>` : ''}
    `;
}

// --- TARJETA ECOSISTEMA (tab Mercado) ---
function renderEcosystem(eco, md, rlusdSplit) {
    const el = document.querySelector('#ecosystem-card .card-content');
    if (!el) return;
    if (!eco || (!eco.rlusdMarketCapUsd && eco.btcDominancePct == null)) {
        el.innerHTML = `<p class="analysis-loading">${t('eco.sinDatos', 'Sin datos de ecosistema todavía (CoinGecko, cada ciclo).')}</p>`;
        return;
    }
    const en = _isEn();

    const xrpDom = eco.xrpDominancePct;
    const btcDom = eco.btcDominancePct;
    const mcapCh = eco.marketCapChange24hPct;

    // roadmap #12: split RLUSD XRPL vs Ethereum (on-chain XRPL + resta contra market cap total)
    let splitItemHTML = '';
    let splitReadingHTML = '';
    if (rlusdSplit && rlusdSplit.xrplSupplyUsd != null) {
        const pctTxt = rlusdSplit.xrplPct != null ? ` (${rlusdSplit.xrplPct}%)` : (en ? ' (≈estimated, total market cap missing)' : ' (≈estimado, falta market cap total)');
        splitItemHTML = `
            <div class="deriv-item">
                <span class="deriv-label">${t('eco.rlusdEnXrpl', 'RLUSD en XRPL')}</span>
                <span class="deriv-val" style="color:#0ea5e9;">$${fmtCompact(rlusdSplit.xrplSupplyUsd)}${pctTxt}</span>
                <span class="deriv-sub">${rlusdSplit.ethereumImpliedUsd != null ? '≈Ethereum: $' + fmtCompact(rlusdSplit.ethereumImpliedUsd) + ' (' + rlusdSplit.ethereumImpliedPct + '%)' : 'on-chain (gateway_balances)'}</span>
            </div>`;
        if (rlusdSplit.xrplPct != null) {
            splitReadingHTML = readingHTML('info', 'RLUSD: XRPL vs Ethereum',
                en
                    ? `${rlusdSplit.xrplPct}% of issued RLUSD lives on the XRP Ledger (real on-chain data via gateway_balances); the rest (≈${rlusdSplit.ethereumImpliedPct}%) is inferred by subtracting against CoinGecko's total market cap — not direct Ethereum data, an estimate by difference.`
                    : `El ${rlusdSplit.xrplPct}% del RLUSD emitido vive en el XRP Ledger (dato on-chain real vía gateway_balances); el resto (≈${rlusdSplit.ethereumImpliedPct}%) se infiere restando contra el market cap total de CoinGecko — no es un dato directo de Ethereum, es una estimación por diferencia.`);
        }
    }

    el.innerHTML = `
        <div class="deriv-grid">
            <div class="deriv-item">
                <span class="deriv-label">${t('eco.rlusdEmitido', 'RLUSD emitido')}</span>
                <span class="deriv-val" style="color:#0ea5e9;">${eco.rlusdMarketCapUsd ? '$' + fmtCompact(eco.rlusdMarketCapUsd) : '--'}</span>
                <span class="deriv-sub">${t('eco.vol24', 'vol. 24h:')} ${eco.rlusdVolume24hUsd ? '$' + fmtCompact(eco.rlusdVolume24hUsd) : '--'}</span>
            </div>
            <div class="deriv-item">
                <span class="deriv-label">${t('eco.domXrp', 'Dominancia XRP')}</span>
                <span class="deriv-val">${xrpDom != null ? xrpDom.toFixed(2) + '%' : '--'}</span>
                <span class="deriv-sub">${t('eco.delMercadoTotal', 'del mercado cripto total')}</span>
            </div>
            <div class="deriv-item">
                <span class="deriv-label">${t('eco.domBtc', 'Dominancia BTC')}</span>
                <span class="deriv-val">${btcDom != null ? btcDom.toFixed(1) + '%' : '--'}</span>
                <span class="deriv-sub">${t('eco.mercadoTotal', 'mercado total')} ${mcapCh != null ? (mcapCh >= 0 ? '+' : '') + mcapCh.toFixed(2) + '% (24h)' : ''}</span>
            </div>
            ${splitItemHTML}
        </div>
        ${readingHTML('info', t('eco.porQue', 'Por qué importa RLUSD'),
            en
                ? "Every RLUSD operation on the XRP Ledger settles using XRP's infrastructure: its growth is the best public thermometer of Ripple's institutional adoption. High BTC dominance means money is still sheltered in Bitcoin; a rotation into altcoins usually shows up in XRP's dominance."
                : 'Cada operación con RLUSD en el XRP Ledger se liquida usando la infraestructura de XRP: su crecimiento es el mejor termómetro público de adopción institucional de Ripple. La dominancia BTC alta indica que el dinero sigue refugiado en Bitcoin; una rotación hacia altcoins suele reflejarse en la dominancia de XRP.')}
        ${splitReadingHTML}
    `;
}

// --- TARJETA ETFs SPOT DE XRP (tab Mercado, roadmap #1, v2.2) ---
// Sin API gratuita conocida para flujos de ETF: el nodo etfFlows se actualiza a mano
// (ver docs/GUIA-TABS.md "Cómo actualizar ETFs"). Por eso nunca lleva badge de
// "frescura automática" — solo la fecha del dato (asOf) y la fuente citada.
function renderEtfFlows(ef) {
    const el = document.querySelector('#etf-flows-card .card-content');
    if (!el) return;
    if (!ef || ef.aumUsd == null) {
        el.innerHTML = `<p class="analysis-loading">${t('etf.sinDatos', 'Sin datos de ETFs todavía — este nodo se actualiza a mano (sin API gratuita conocida). Ver docs/GUIA-TABS.md.')}</p>`;
        return;
    }

    const en = _isEn();
    const streak = ef.weeklyStreakWeeks || 0;
    let tone = 'info';
    let title = en ? 'Mixed ETF flows' : 'Flujos de ETF mixtos';
    let text = en
        ? `Weekly flow into XRP spot ETFs was ${ef.weeklyNetFlowUsd >= 0 ? '+' : ''}$${fmtCompact(Math.abs(ef.weeklyNetFlowUsd))}. No clear streak of inflows or outflows.`
        : `El flujo semanal de los ETFs spot de XRP fue de ${ef.weeklyNetFlowUsd >= 0 ? '+' : ''}$${fmtCompact(Math.abs(ef.weeklyNetFlowUsd))}. Sin racha clara de entradas o salidas.`;
    if (streak >= 3 && ef.weeklyNetFlowUsd >= 0) {
        tone = 'pos';
        title = en ? `${streak} straight weeks of inflows` : `${streak}ª semana consecutiva de entradas`;
        text = en
            ? `Stable institutional demand: ${streak} consecutive weeks of net inflows (last week: +$${fmtCompact(ef.weeklyNetFlowUsd)}). ETFs are steadily absorbing open-market supply — watch for the streak breaking.`
            : `Demanda institucional estable: ${streak} semanas seguidas de entradas netas (última semana: +$${fmtCompact(ef.weeklyNetFlowUsd)}). Los ETFs absorben oferta del mercado abierto de forma sostenida — a vigilar si se corta la racha.`;
    } else if (ef.weeklyNetFlowUsd < 0) {
        tone = 'warn';
        title = en ? 'Net outflows last week' : 'Salidas netas la última semana';
        text = en
            ? `XRP spot ETFs recorded net outflows of $${fmtCompact(Math.abs(ef.weeklyNetFlowUsd))} last week — institutional demand cooling, though a single week doesn't define the trend.`
            : `Los ETFs spot de XRP registraron salidas netas de $${fmtCompact(Math.abs(ef.weeklyNetFlowUsd))} la última semana — demanda institucional se enfría, aunque una sola semana no define la tendencia.`;
    }

    el.innerHTML = `
        <div class="deriv-grid">
            <div class="deriv-item">
                <span class="deriv-label">${en ? 'Total AUM' : 'AUM total'} (${ef.etfCount || '--'} ETFs)</span>
                <span class="deriv-val" style="color:#0ea5e9;">$${fmtCompact(ef.aumUsd)}</span>
                <span class="deriv-sub">${ef.xrpInCustody ? fmtCompact(ef.xrpInCustody) + (en ? ' XRP in custody' : ' XRP en custodia') : ''}</span>
            </div>
            <div class="deriv-item">
                <span class="deriv-label">${t('etf.flujoSemana', 'Flujo última semana')}</span>
                <span class="deriv-val" style="color:${ef.weeklyNetFlowUsd >= 0 ? '#22c55e' : '#ef4444'};">${ef.weeklyNetFlowUsd >= 0 ? '+' : ''}$${fmtCompact(ef.weeklyNetFlowUsd)}</span>
                <span class="deriv-sub">${streak > 0 ? streak + (en ? ' straight weeks of inflows' : ' semanas seguidas de entradas') : ''}</span>
            </div>
            <div class="deriv-item">
                <span class="deriv-label">${t('etf.acumulado', 'Acumulado (desde lanzamiento)')}</span>
                <span class="deriv-val">$${fmtCompact(ef.cumulativeNetFlowUsd)}</span>
                <span class="deriv-sub">${t('etf.datoAl', 'dato al')} ${ef.asOf || '--'}</span>
            </div>
        </div>
        ${readingHTML(tone, title, text)}
        <p style="font-size:0.65rem;color:#64748b;margin-top:0.4rem;">
            ${en
                ? `<strong>Manual update</strong> — no known free API for XRP ETF flows (roadmap phase 2: best-effort scraper).
            Source: ${ef.source || 'unspecified'}. Data as of ${ef.asOf || '--'}, loaded ${ef.lastUpdated ? new Date(ef.lastUpdated).toLocaleDateString('en-US') : '--'}.`
                : `<strong>Actualización manual</strong> — sin API gratuita conocida para flujos de ETF de XRP (fase 2 del roadmap: scraper best-effort).
            Fuente: ${ef.source || 'no especificada'}. Dato al ${ef.asOf || '--'}, cargado ${ef.lastUpdated ? new Date(ef.lastUpdated).toLocaleDateString('es-ES') : '--'}.`}
        </p>
    `;
}

// --- TARJETA VOLUMEN POR EXCHANGE (tab Mercado, roadmap #14, v2.2) ---
const KOREAN_EXCHANGES = ['upbit', 'bithumb', 'coinone', 'korbit'];
function renderExchangeVolume(ev) {
    const el = document.querySelector('#exchange-volume-card .card-content');
    if (!el) return;
    if (!ev || !Array.isArray(ev.top) || ev.top.length === 0) {
        el.innerHTML = `<p class="analysis-loading">${t('vol.sinDatos', 'Sin datos de volumen por exchange todavía (CoinGecko, cada ciclo).')}</p>`;
        return;
    }

    const top5 = ev.top.slice(0, 5);
    const maxVol = top5[0].volumeUsd;
    const rows = top5.map(x => `
        <div style="display:flex; align-items:center; gap:0.6rem; margin-bottom:0.5rem;">
            <span style="width:110px; font-size:0.75rem; color:#e2e8f0; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${x.name}</span>
            <div style="flex:1; background:rgba(255,255,255,0.06); border-radius:4px; height:10px; overflow:hidden;">
                <div style="width:${maxVol > 0 ? (x.volumeUsd / maxVol) * 100 : 0}%; background:#0ea5e9; height:100%;"></div>
            </div>
            <span style="width:90px; text-align:right; font-size:0.75rem; color:#94a3b8;">$${fmtCompact(x.volumeUsd)} (${x.pct}%)</span>
        </div>
    `).join('');

    const en = _isEn();
    const koreanShare = top5.filter(x => KOREAN_EXCHANGES.some(k => x.name.toLowerCase().includes(k))).reduce((s, x) => s + x.pct, 0);
    let reading = en
        ? readingHTML('info', `${top5[0].name} leads volume (${top5[0].pct}%)`,
            `Shows where ${_coinSym()} really trades, beyond Binance spot. ${ev.exchangeCount} exchanges detected by CoinGecko.`)
        : readingHTML('info', `${top5[0].name} lidera el volumen (${top5[0].pct}%)`,
            `Muestra dónde se negocia ${_coinSym()} de verdad, más allá de Binance spot. ${ev.exchangeCount} exchanges detectados por CoinGecko.`);
    if (koreanShare > 15) {
        reading = en
            ? readingHTML('warn', 'Relevant South Korean presence',
                `South Korean exchanges add up to ~${koreanShare.toFixed(1)}% of visible volume. Korea often leads XRP rallies (the "kimchi premium") — a volume jump there can front-run moves before Binance/the West.`)
            : readingHTML('warn', 'Presencia surcoreana relevante',
                `Los exchanges surcoreanos suman ~${koreanShare.toFixed(1)}% del volumen visible. Corea suele liderar rallies de XRP (el "kimchi premium") — un salto de volumen ahí puede anticipar movimiento antes que en Binance/Occidente.`);
    }

    el.innerHTML = `
        <div style="margin-bottom:0.6rem;">${rows}</div>
        ${reading}
        <p style="font-size:0.65rem;color:#64748b;margin-top:0.4rem;">${en
            ? `Source: ${ev.source || 'CoinGecko'}. Total detected volume: $${fmtCompact(ev.totalVolumeUsd)}. Loaded ${ev.lastUpdated ? new Date(ev.lastUpdated).toLocaleTimeString('en-US') : '--'}.`
            : `Fuente: ${ev.source || 'CoinGecko'}. Volumen total detectado: $${fmtCompact(ev.totalVolumeUsd)}. Cargado ${ev.lastUpdated ? new Date(ev.lastUpdated).toLocaleTimeString('es-ES') : '--'}.`}</p>
    `;
}

// --- ACTIVIDAD AMM/DEX ON-CHAIN (roadmap #13, v2.2) ---
// Muestra de pools AMM nativos del XRPL (XLS-30), vía XRPScan. Ver nota de
// metodología en server.js (fetchAmmDexData): TVL por pool es exacto para la
// muestra (2× lado XRP), pero el TOTAL es de la muestra, no de toda la red.
function renderAmmDex(am) {
    const el = document.querySelector('#amm-dex-card .card-content');
    if (!el) return;
    if (!am || !Array.isArray(am.topPools) || am.topPools.length === 0) {
        el.innerHTML = `<p class="analysis-loading">${t('amm.sinDatos', 'Sin datos de AMM/DEX todavía (XRPScan, cada ciclo).')}</p>`;
        return;
    }

    const top6 = am.topPools.slice(0, 6);
    const maxTvl = top6[0].tvlUsd || top6[0].reserveXrp;
    const rows = top6.map(p => {
        const val = p.tvlUsd != null ? p.tvlUsd : p.reserveXrp;
        const label = p.tvlUsd != null ? '$' + fmtCompact(p.tvlUsd) : fmtCompact(p.reserveXrp) + ' XRP';
        return `
        <div style="display:flex; align-items:center; gap:0.6rem; margin-bottom:0.5rem;">
            <span style="width:100px; font-size:0.75rem; color:#e2e8f0; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${p.token}${p.verified ? ' ✓' : ''}</span>
            <div style="flex:1; background:rgba(255,255,255,0.06); border-radius:4px; height:10px; overflow:hidden;">
                <div style="width:${maxTvl > 0 ? (val / maxTvl) * 100 : 0}%; background:#a855f7; height:100%;"></div>
            </div>
            <span style="width:90px; text-align:right; font-size:0.75rem; color:#94a3b8;">${label}</span>
        </div>`;
    }).join('');

    const en = _isEn();
    const tvlTxt = am.totalTvlUsdSample != null ? '$' + fmtCompact(am.totalTvlUsdSample) : fmtCompact(am.totalReserveXrpSample) + (en ? ' XRP (no price for USD)' : ' XRP (sin precio para USD)');
    const reading = en
        ? readingHTML('info', `TVL in a sample of ${am.xrpPairedPoolsSampled} XRP pools: ≈${tvlTxt}`,
            `XRP Ledger AMM pools are a native protocol feature (XLS-30), not an external DEX: anyone can provide liquidity and earn the swap fee. More TVL in XRP/token pools means more depth to swap those tokens without moving the price much. This is a SAMPLE of ${am.poolsSampled} pools (XRPScan exposes neither the network total nor an aggregate TVL) — it does not represent the XRPL's full AMM ecosystem.`)
        : readingHTML('info', `TVL en muestra de ${am.xrpPairedPoolsSampled} pools XRP: ≈${tvlTxt}`,
            `Los pools AMM del XRP Ledger son una función nativa del protocolo (XLS-30), no un DEX externo: cualquiera puede aportar liquidez y cobrar la comisión de swap. Más TVL en pools XRP/token implica más profundidad para intercambiar esos tokens sin mover mucho el precio. Esto es una MUESTRA de ${am.poolsSampled} pools (XRPScan no expone el total de la red ni un TVL agregado) — no representa el ecosistema AMM completo del XRPL.`);

    el.innerHTML = `
        <div style="margin-bottom:0.6rem;">${rows}</div>
        ${reading}
        <p style="font-size:0.65rem;color:#64748b;margin-top:0.4rem;">${en ? '' : (am.note || '')} ${en
            ? `Loaded ${am.lastUpdated ? new Date(am.lastUpdated).toLocaleTimeString('en-US') : '--'}.`
            : `Cargado ${am.lastUpdated ? new Date(am.lastUpdated).toLocaleTimeString('es-ES') : '--'}.`}</p>
    `;
}

// --- SPARKLINES DE HISTORY.JSON (roadmap #7, v2.2) ---
// Nota honesta compartida: history.json guarda 1 snapshot/día desde que el servidor
// empezó a correr con esta versión — el histórico se acumula con el tiempo, igual
// que el log de flowEvents del Whale Tracker (mismo patrón, ya usado en v2.1).
function _historyCoverageNote(n) {
    if (_isEn()) {
        if (n <= 1) return `History under construction: only ${n} day recorded since this dashboard started saving daily snapshots. Come back in a few days to see the real evolution.`;
        return `History under construction: ${n} days accumulated so far (1 snapshot/day is saved).`;
    }
    if (n <= 1) return `Histórico en construcción: solo hay ${n} día registrado desde que este dashboard empezó a guardar snapshots diarios. Vuelve en unos días para ver la evolución real.`;
    return `Histórico en construcción: ${n} días acumulados hasta ahora (se guarda 1 snapshot/día).`;
}

let scoreSparklineInstance = null;
function renderScoreSparkline(history) {
    const canvas = document.getElementById('scoreSparkline');
    const noteEl = document.getElementById('score-sparkline-note');
    if (!canvas) return;
    const pts = (history || []).filter(h => h.score != null).slice(-30);
    if (noteEl) noteEl.textContent = _historyCoverageNote(pts.length);
    if (pts.length === 0) return;

    const values = pts.map(h => h.score);
    const up = values[values.length - 1] >= values[0];
    if (scoreSparklineInstance) scoreSparklineInstance.destroy();
    scoreSparklineInstance = new Chart(canvas.getContext('2d'), {
        type: 'line',
        data: {
            labels: pts.map(h => new Date(h.date).toLocaleDateString(_dLoc(), { day: 'numeric', month: 'short' })),
            datasets: [{
                data: values,
                borderColor: up ? '#22c55e' : '#ef4444',
                backgroundColor: 'transparent',
                borderWidth: 2,
                pointRadius: pts.length === 1 ? 3 : 0,
                tension: 0.3
            }]
        },
        options: {
            responsive: true, maintainAspectRatio: false,
            plugins: { legend: { display: false }, tooltip: { callbacks: { label: (c) => `Score: ${c.parsed.y}/100` } } },
            scales: { x: { display: false }, y: { display: false, min: 0, max: 100 } }
        }
    });
}

let whaleFlowSparklineInstance = null;
function renderWhaleFlowSparkline(history) {
    const canvas = document.getElementById('whaleFlowSparkline');
    const noteEl = document.getElementById('whale-flow-sparkline-note');
    if (!canvas) return;
    const pts = (history || []).filter(h => h.whaleExchangeFlowNet != null).slice(-30);
    if (noteEl) noteEl.textContent = _historyCoverageNote(pts.length) + (_isEn()
        ? ' Positive = flowing into exchanges (supply), negative = leaving to cold wallets (accumulation).'
        : ' Positivo = entrando a exchanges (oferta), negativo = saliendo a wallets frías (acumulación).');
    if (pts.length === 0) return;

    const values = pts.map(h => h.whaleExchangeFlowNet);
    if (whaleFlowSparklineInstance) whaleFlowSparklineInstance.destroy();
    whaleFlowSparklineInstance = new Chart(canvas.getContext('2d'), {
        type: 'bar',
        data: {
            labels: pts.map(h => new Date(h.date).toLocaleDateString(_dLoc(), { day: 'numeric', month: 'short' })),
            datasets: [{
                data: values,
                backgroundColor: values.map(v => v >= 0 ? 'rgba(239,68,68,0.75)' : 'rgba(34,197,94,0.75)'),
                borderRadius: 2,
                maxBarThickness: 36
            }]
        },
        options: {
            responsive: true, maintainAspectRatio: false,
            plugins: { legend: { display: false }, tooltip: { callbacks: { label: (c) => `${fmtCompact(c.parsed.y)} XRP` } } },
            scales: { x: { display: false }, y: { display: false } }
        }
    });
}

// ============================================================
// ALERTAS LOCALES (roadmap #8, v2.2)
// Browser Notification API — solo funciona mientras la pestaña sigue abierta
// y el ciclo de refresco del frontend (~5 min) sigue corriendo. La config vive
// en localStorage (nunca sale del navegador, igual que "My Crypto").
// El "estado previo" también se guarda en localStorage para detectar TRANSICIONES
// (cruces, cambios de signo) y no repetir la misma notificación cada ciclo.
// ============================================================
const ALERTS_CONFIG_KEY = 'xrpAlertsConfig';
const ALERTS_STATE_KEY = 'xrpAlertsState';

function loadAlertsConfig() {
    try {
        const raw = localStorage.getItem(ALERTS_CONFIG_KEY);
        return raw ? JSON.parse(raw) : { rsi: false, cross: false, levels: false, funding: false, whale: false, whaleThreshold: 500000 };
    } catch (e) { return { rsi: false, cross: false, levels: false, funding: false, whale: false, whaleThreshold: 500000 }; }
}
function saveAlertsConfig(cfg) {
    try { localStorage.setItem(ALERTS_CONFIG_KEY, JSON.stringify(cfg)); } catch (e) { console.error('No se pudo guardar la config de alertas:', e); }
}
function loadAlertsState() {
    try {
        const raw = localStorage.getItem(ALERTS_STATE_KEY);
        return raw ? JSON.parse(raw) : {};
    } catch (e) { return {}; }
}
function saveAlertsState(state) {
    try { localStorage.setItem(ALERTS_STATE_KEY, JSON.stringify(state)); } catch (e) { /* no-op */ }
}

function notifyAlert(title, body) {
    if (!('Notification' in window) || Notification.permission !== 'granted') return;
    try { new Notification(title, { body }); } catch (e) { console.error('Error creando notificación:', e); }
}

// Evalúa las condiciones activas contra el estado anterior y dispara notificaciones
// SOLO en transiciones (evita spam del mismo aviso cada ~5 minutos).
function checkAlerts(data) {
    const cfg = loadAlertsConfig();
    const anyEnabled = cfg.rsi || cfg.cross || cfg.levels || cfg.funding || cfg.whale;
    if (!anyEnabled || !('Notification' in window) || Notification.permission !== 'granted') return;

    const state = loadAlertsState();
    const am = data.advancedMetrics || {};

    // 1) RSI 30/70
    if (cfg.rsi) {
        const rsi = am.momentum?.rsi14;
        if (rsi != null) {
            const zone = rsi >= 70 ? 'overbought' : (rsi <= 30 ? 'oversold' : 'neutral');
            if (zone !== 'neutral' && zone !== state.rsiZone) {
                if (_isEn()) {
                    notifyAlert('XRP · RSI ' + (zone === 'overbought' ? 'overbought' : 'oversold'),
                        `RSI 14 at ${rsi.toFixed(1)}: ${zone === 'overbought' ? 'overbought zone, correction risk.' : 'oversold zone, possible technical bounce.'}`);
                } else {
                    notifyAlert('XRP · RSI en ' + (zone === 'overbought' ? 'sobrecompra' : 'sobreventa'),
                        `RSI 14 en ${rsi.toFixed(1)}: ${zone === 'overbought' ? 'zona de sobrecompra, riesgo de corrección.' : 'zona de sobreventa, posible rebote técnico.'}`);
                }
            }
            state.rsiZone = zone;
        }
    }

    // 2) Golden/Death Cross
    if (cfg.cross) {
        const cross = am.trend?.crossSignal;
        if ((cross === 'GOLDEN_CROSS' || cross === 'DEATH_CROSS') && cross !== state.lastCross) {
            notifyAlert('XRP · ' + (cross === 'GOLDEN_CROSS' ? 'Golden Cross' : 'Death Cross'),
                _isEn()
                    ? (cross === 'GOLDEN_CROSS' ? 'The SMA50 crossed above the SMA200: medium-term bullish signal.' : 'The SMA50 crossed below the SMA200: medium-term weakness signal.')
                    : (cross === 'GOLDEN_CROSS' ? 'La SMA50 cruzó por encima de la SMA200: señal alcista de medio plazo.' : 'La SMA50 cruzó por debajo de la SMA200: señal de debilidad de medio plazo.'));
        }
        if (cross) state.lastCross = cross;
    }

    // 3) Niveles: soporte / resistencia / psicológico
    if (cfg.levels) {
        const niveles = data.dailyBrief?.niveles;
        const price = data.marketData?.price;
        if (niveles && price != null) {
            let hit = null;
            if (niveles.resistencia && price >= niveles.resistencia) hit = 'resistencia';
            else if (niveles.soporte && price <= niveles.soporte) hit = 'soporte';
            else if (niveles.psicologico && Math.abs(price - niveles.psicologico) / niveles.psicologico < 0.002) hit = 'psicologico';
            if (hit && hit !== state.lastLevelHit) {
                const label = _isEn()
                    ? (hit === 'resistencia' ? 'resistance' : (hit === 'soporte' ? 'support' : 'psychological level'))
                    : (hit === 'resistencia' ? 'resistencia' : (hit === 'soporte' ? 'soporte' : 'nivel psicológico'));
                notifyAlert(_isEn() ? 'XRP · price touched ' + label : 'XRP · precio tocó ' + label,
                    _isEn()
                        ? `Price at ${_fmtUsd(price, 4)}, near ${label} (${_fmtUsd(niveles[hit === 'psicologico' ? 'psicologico' : hit], 4)}).`
                        : `Precio en ${_fmtUsd(price, 4)}, cerca de ${label} (${_fmtUsd(niveles[hit === 'psicologico' ? 'psicologico' : hit], 4)}).`);
            }
            state.lastLevelHit = hit;
        }
    }

    // 4) Funding cambia de signo
    if (cfg.funding) {
        const f = data.derivatives?.fundingRate8hPct;
        if (f != null) {
            const sign = f > 0.001 ? 'pos' : (f < -0.001 ? 'neg' : 'neutral');
            if (sign !== 'neutral' && sign !== state.fundingSign && state.fundingSign && state.fundingSign !== 'neutral') {
                notifyAlert(_isEn() ? 'XRP · funding flipped sign' : 'XRP · funding cambió de signo',
                    _isEn()
                        ? (sign === 'pos' ? `Funding turned positive (+${f.toFixed(4)}%/8h): longs are paying again.` : `Funding turned negative (${f.toFixed(4)}%/8h): shorts start paying.`)
                        : (sign === 'pos' ? `Funding pasó a positivo (+${f.toFixed(4)}%/8h): los largos vuelven a pagar.` : `Funding pasó a negativo (${f.toFixed(4)}%/8h): los cortos empiezan a pagar.`));
            }
            state.fundingSign = sign;
        }
    }

    // 5) Flujo neto a exchanges supera umbral
    if (cfg.whale) {
        const flow = data.whaleTracker?.summary?.exchangeFlowNet;
        const threshold = cfg.whaleThreshold || 500000;
        if (flow != null) {
            const over = Math.abs(flow) >= threshold;
            if (over && !state.whaleOverThreshold) {
                notifyAlert(_isEn() ? 'XRP · whale flow above threshold' : 'XRP · flujo whale supera el umbral',
                    _isEn()
                        ? (flow > 0 ? `${_fmtNum(flow)} net XRP flowed into exchanges in 24h (threshold: ${_fmtNum(threshold)}) — possible sell pressure.` : `${_fmtNum(Math.abs(flow))} net XRP left to cold wallets in 24h — accumulation.`)
                        : (flow > 0 ? `Entraron ${_fmtNum(flow)} XRP netos a exchanges en 24h (umbral: ${_fmtNum(threshold)}) — posible presión de venta.` : `Salieron ${_fmtNum(Math.abs(flow))} XRP netos hacia wallets frías en 24h — acumulación.`));
            }
            state.whaleOverThreshold = over;
        }
    }

    saveAlertsState(state);
}

// ============================================================
// ===================== V2.3 ================================
// AUTENTICACIÓN + AJUSTES POR USUARIO + IDIOMA
// ============================================================

window._userSettings = window._userSettings || {};
let _authMode = 'login'; // 'login' | 'register'

function showAuthOverlay() {
    const ov = document.getElementById('auth-overlay');
    if (ov) ov.style.display = 'flex';
    const chip = document.getElementById('user-chip');
    if (chip) chip.style.display = 'none';
    // ¿Existen usuarios ya? Si no, arrancar directamente en modo registro.
    fetch('/api/auth/me').then(r => r.json().then(j => {
        if (r.status === 401 && j && j.usersExist === false) setAuthMode('register');
    })).catch(() => { /* no-op */ });
}

function hideAuthOverlay() {
    const ov = document.getElementById('auth-overlay');
    if (ov) ov.style.display = 'none';
}

function setAuthMode(mode) {
    _authMode = mode;
    const title = document.getElementById('auth-title');
    const submit = document.getElementById('auth-submit');
    const toggle = document.getElementById('auth-mode-toggle');
    const firstNote = document.getElementById('auth-first-note');
    const pass = document.getElementById('auth-password');
    const isReg = mode === 'register';
    if (title) title.textContent = isReg ? t('auth.crear', 'Crear cuenta') : t('auth.titulo', 'Iniciar sesión');
    if (submit) submit.textContent = isReg ? t('auth.crear', 'Crear cuenta') : t('auth.entrar', 'Entrar');
    if (toggle) toggle.textContent = isReg ? t('auth.toggleLogin', '¿Ya tienes cuenta? Inicia sesión') : t('auth.toggleRegistro', '¿No tienes cuenta? Regístrate');
    if (firstNote) firstNote.style.display = isReg ? 'block' : 'none';
    if (pass) pass.setAttribute('autocomplete', isReg ? 'new-password' : 'current-password');
}

function showAuthError(msg) {
    const el = document.getElementById('auth-error');
    if (el) { el.textContent = msg; el.style.display = 'block'; }
}

// Carga la sesión activa: chip de usuario + ajustes guardados en BD (idioma, My Crypto)
async function loadUserSession() {
    try {
        const meResp = await fetch('/api/auth/me');
        if (!meResp.ok) return false;
        const me = await meResp.json();
        const chip = document.getElementById('user-chip');
        const name = document.getElementById('user-chip-name');
        if (name) name.textContent = me.username;
        if (chip) chip.style.display = 'flex';

        const sResp = await fetch('/api/settings');
        if (sResp.ok) {
            window._userSettings = await sResp.json();
            // Idioma guardado en la cuenta manda sobre el localStorage del navegador
            if (window._userSettings.lang && window._userSettings.lang !== window.getLang()) {
                window.setLang(window._userSettings.lang);
            }
            // V2.5: moneda activa guardada en la cuenta (manda sobre localStorage)
            if (window._userSettings.activeCoin && window._userSettings.activeCoin !== window._activeCoinId) {
                setActiveCoin(window._userSettings.activeCoin, { persist: false });
            }
            // Migración única: si el navegador tenía cantidad guardada y la cuenta no
            const localAmt = localStorage.getItem('myXrpAmount');
            if (localAmt && (window._userSettings.myXrpAmount == null || window._userSettings.myXrpAmount === '')) {
                saveUserSetting('myXrpAmount', localAmt);
                window._userSettings.myXrpAmount = localAmt;
            }
        }
        return true;
    } catch (e) {
        console.error('Error cargando la sesión:', e);
        return false;
    }
}

async function saveUserSetting(key, value) {
    try {
        await fetch('/api/settings', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ key, value })
        });
        window._userSettings[key] = value;
    } catch (e) { console.error('No se pudo guardar el ajuste en BD:', e); }
}

// Bugfix (v2.8.1): debounce POR CLAVE, no un único timer global. Antes, un solo timer
// hacía que meter la cantidad de una moneda y enseguida la de otra CANCELARA el guardado
// de la primera (se perdían tenencias — p. ej. HBAR no se guardaba si luego tocabas XLM).
// Cada clave tiene su propio temporizador, así que ninguna cancela a las demás.
const _settingDebounce = {};
function saveUserSettingDebounced(key, value) {
    if (_settingDebounce[key]) clearTimeout(_settingDebounce[key]);
    _settingDebounce[key] = setTimeout(() => { delete _settingDebounce[key]; saveUserSetting(key, value); }, 800);
}

document.addEventListener('DOMContentLoaded', () => {
    // Formulario de login/registro
    const form = document.getElementById('auth-form');
    if (form) {
        form.addEventListener('submit', async (e) => {
            e.preventDefault();
            const errEl = document.getElementById('auth-error');
            if (errEl) errEl.style.display = 'none';
            const username = document.getElementById('auth-username').value.trim();
            const password = document.getElementById('auth-password').value;
            try {
                const resp = await fetch(`/api/auth/${_authMode === 'register' ? 'register' : 'login'}`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ username, password })
                });
                const j = await resp.json();
                if (!resp.ok) {
                    showAuthError(j.error || t('auth.error', 'Error de autenticación.'));
                    return;
                }
                hideAuthOverlay();
                await loadUserSession();
                await loadDashboardData();
            } catch (err) {
                showAuthError(t('err.servidor', 'No se pudo conectar con el servidor.'));
            }
        });
    }

    const modeToggle = document.getElementById('auth-mode-toggle');
    if (modeToggle) modeToggle.addEventListener('click', () => setAuthMode(_authMode === 'login' ? 'register' : 'login'));

    const logoutBtn = document.getElementById('logout-btn');
    if (logoutBtn) {
        logoutBtn.addEventListener('click', async () => {
            try { await fetch('/api/auth/logout', { method: 'POST' }); } catch (e) { /* no-op */ }
            window._userSettings = {};
            showAuthOverlay();
        });
    }

    // --- Modal de cambio de contraseña ---
    const accountBtn = document.getElementById('account-btn');
    const accountModal = document.getElementById('account-modal');
    const closeAccountModal = document.getElementById('close-account-modal');
    const accountForm = document.getElementById('account-form');
    const accountMsg = document.getElementById('account-msg');

    const openAccountModal = () => {
        if (!accountModal) return;
        if (accountForm) accountForm.reset();
        if (accountMsg) accountMsg.style.display = 'none';
        accountModal.style.display = 'flex';
    };
    if (accountBtn) accountBtn.addEventListener('click', openAccountModal);
    if (closeAccountModal) closeAccountModal.addEventListener('click', () => accountModal.style.display = 'none');
    if (accountModal) accountModal.addEventListener('click', (e) => { if (e.target === accountModal) accountModal.style.display = 'none'; });

    if (accountForm) {
        accountForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            const showMsg = (msg, ok) => {
                accountMsg.textContent = msg;
                accountMsg.style.display = 'block';
                accountMsg.style.background = ok ? 'rgba(34,197,94,0.12)' : 'rgba(239,68,68,0.12)';
                accountMsg.style.borderColor = ok ? 'rgba(34,197,94,0.45)' : 'rgba(239,68,68,0.45)';
                accountMsg.style.color = ok ? '#86efac' : '#fca5a5';
            };
            const current = document.getElementById('acc-current').value;
            const nw = document.getElementById('acc-new').value;
            const nw2 = document.getElementById('acc-new2').value;
            if (nw !== nw2) { showMsg(t('acc.noCoincide', 'Las contraseñas nuevas no coinciden.'), false); return; }
            try {
                const resp = await fetch('/api/auth/change-password', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ currentPassword: current, newPassword: nw })
                });
                const j = await resp.json();
                if (!resp.ok) { showMsg(j.error || t('acc.error', 'Error al cambiar la contraseña.'), false); return; }
                showMsg(t('acc.ok', '✓ Contraseña cambiada correctamente.'), true);
                accountForm.reset();
                setTimeout(() => { if (accountModal) accountModal.style.display = 'none'; }, 1500);
            } catch (err) {
                showMsg(t('err.servidor', 'No se pudo conectar con el servidor.'), false);
            }
        });
    }

    // Sesión existente al abrir la página (la cookie persiste 30 días)
    loadUserSession();

    // Cambio de idioma: persistir en la cuenta y re-renderizar todo con el idioma nuevo
    window.addEventListener('langchange', (e) => {
        if (document.getElementById('user-chip')?.style.display !== 'none') {
            saveUserSetting('lang', e.detail.lang);
        }
        loadDashboardData();
    });
});

// ============================================================
// V2.9: SALIDA HACIA LA VERSIÓN MÓVIL (bloque autónomo, no toca nada de arriba)
// ============================================================
// Simétrico a la barra de la versión móvil. Caso real: desde el móvil pulsas "Ver
// versión completa" (o entras por /desktop), eso fija la cookie viewMode=desktop
// durante 180 días y la detección por User-Agent deja de aplicarse — el teléfono
// se queda con el dashboard de 9 pestañas para siempre y sin ninguna forma visible
// de volver. Esta barra aparece SOLO en ese estado concreto: cookie de escritorio
// puesta Y pantalla estrecha. En un monitor no se ve nunca.
(function mobileEscapeBar() {
    try {
        const forcedDesktop = document.cookie.split(';').some(c => c.trim() === 'viewMode=desktop');
        if (!forcedDesktop) return;
        if (window.innerWidth >= 820) return; // pantalla grande: no hay nada que ofrecer

        const bar = document.createElement('a');
        bar.href = '/m';
        bar.id = 'mobile-escape-bar';
        // Estilos en línea a propósito: es un elemento aislado de 3 líneas y así el
        // bloque entero vive en un solo sitio (la CSP permite style-src 'unsafe-inline').
        bar.style.cssText = 'display:block;padding:10px 16px;text-align:center;font-size:0.85rem;' +
            'font-weight:600;color:#04121f;text-decoration:none;background:linear-gradient(135deg,#38bdf8,#0ea5e9);';
        bar.textContent = (window.getLang && window.getLang() === 'en')
            ? 'Small screen detected · Switch to the mobile version →'
            : 'Pantalla pequeña · Cambiar a la versión móvil →';
        document.body.insertBefore(bar, document.body.firstChild);
    } catch (e) { /* si falla, el dashboard sigue funcionando igual */ }
})();
