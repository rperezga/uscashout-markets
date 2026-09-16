/* ============================================================
   mobile.js — lógica de la VERSIÓN MÓVIL (v2.9)

   Alcance deliberado: login + Mi Portafolio (+ Cuenta, que es donde tienen que vivir
   logout/idioma/contraseña cuando no hay cabecera de escritorio). El resto del
   dashboard (mercado, técnico, ballenas, derivados, quema) sigue siendo exclusivo
   de la versión de escritorio.

   NO duplica lógica de negocio: consume los MISMOS endpoints que el escritorio
   (/api/auth/*, /api/settings, /api/portfolio, /api/portfolio/history). Todo cálculo
   (valor, P&L ponderado, reconstrucción del histórico) sigue viviendo en el servidor.

   Convenciones heredadas del proyecto (ver CLAUDE.md):
   - Todo dato externo pasa por _esc() antes de entrar en innerHTML.
   - Cada bloque de render va en su try/catch: un fallo no tumba la pantalla entera.
   - Toda gráfica lleva su "lectura práctica" en lenguaje llano.
   - Bilingüe: t(clave, es) para estáticos, _pick(es, en) para texto interpolado.
   ============================================================ */
(function () {
    'use strict';

    // ---------- Helpers ----------

    // XSS: mismo helper que app.js. Aunque hoy los nombres de moneda vienen del
    // registro COINS (interno), la regla del proyecto es escapar SIEMPRE lo que
    // llega por API antes de innerHTML. Quitar tags con regex no basta.
    function _esc(s) {
        if (s === null || s === undefined) return '';
        return String(s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    function _isEn() { return (window.getLang && window.getLang()) === 'en'; }
    function _pick(es, en) { return _isEn() ? en : es; }
    function _t(key, es) { return window.t ? window.t(key, es) : es; }

    function _fmtUsd(v, dec) {
        if (v === null || v === undefined || !isFinite(v)) return '--';
        const d = (dec === undefined) ? 2 : dec;
        return '$' + new Intl.NumberFormat('en-US', { minimumFractionDigits: d, maximumFractionDigits: d }).format(v);
    }

    // Precio por moneda: XRP y similares necesitan más decimales que BTC.
    function _fmtPrice(v) {
        if (v === null || v === undefined || !isFinite(v)) return '--';
        const d = v >= 1000 ? 2 : (v >= 1 ? 4 : 6);
        return '$' + new Intl.NumberFormat('en-US', { minimumFractionDigits: d, maximumFractionDigits: d }).format(v);
    }

    function _fmtAmount(v) {
        if (v === null || v === undefined || !isFinite(v)) return '--';
        return new Intl.NumberFormat('en-US', { maximumFractionDigits: 8 }).format(v);
    }

    function _pct(v, dec) {
        if (v === null || v === undefined || !isFinite(v)) return '--';
        return (v >= 0 ? '+' : '−') + Math.abs(v).toFixed(dec === undefined ? 2 : dec) + '%';
    }

    const $ = (id) => document.getElementById(id);

    // ---------- Estado ----------
    let _authMode = 'login';        // 'login' | 'register'
    let _me = null;                 // { id, username, role }
    let _pfLoading = false;
    let _perfSeries = null;
    let _perfPnl = null;
    let _perfGran = 'day';          // 'day' | 'week' | 'month'
    let _perfChart = null;
    let _refreshTimer = null;

    // ============================================================
    // AUTENTICACIÓN
    // ============================================================

    function hideBoot() {
        const boot = $('m-boot');
        if (boot) boot.hidden = true;
    }

    // Barra de escape a la versión completa. Se muestra SOLO si existe la cookie
    // viewMode=mobile, o sea si alguien pidió expresamente el móvil entrando por /m
    // (en un teléfono normal la versión móvil llega por User-Agent y no hay cookie).
    // Es la salida de un atrapamiento real: abrir /m desde un portátil dejaba la
    // cookie puesta 180 días y el escritorio no volvía a aparecer.
    function setupViewBar() {
        try {
            const bar = $('m-viewbar');
            if (!bar) return;
            const forced = document.cookie.split(';').some(c => c.trim() === 'viewMode=mobile');
            if (!forced) return;
            bar.textContent = _pick('Estás viendo la versión móvil · Ver versión completa →',
                                    'You are viewing the mobile version · Open full version →');
            bar.hidden = false;
        } catch (e) { /* si falla, simplemente no se muestra la barra */ }
    }

    function showAuth() {
        hideBoot();
        $('m-auth').hidden = false;
        $('m-app').hidden = true;
        stopAutoRefresh();
        // Si aún no hay ningún usuario creado, arrancar directamente en registro
        // (mismo comportamiento que el escritorio).
        fetch('/api/auth/me')
            .then(r => r.json().then(j => {
                if (r.status === 401 && j && j.usersExist === false) setAuthMode('register');
            }))
            .catch(() => { /* sin red: el formulario ya avisa al enviar */ });
    }

    function showApp() {
        hideBoot();
        $('m-auth').hidden = true;
        $('m-app').hidden = false;
        setupViewBar();
        startAutoRefresh();
    }

    function setAuthMode(mode) {
        _authMode = mode;
        const isReg = mode === 'register';
        $('m-auth-title').textContent = isReg ? _t('auth.crear', 'Crear cuenta') : _t('auth.titulo', 'Iniciar sesión');
        $('m-auth-submit').textContent = isReg ? _t('auth.crear', 'Crear cuenta') : _t('auth.entrar', 'Entrar');
        $('m-auth-toggle').textContent = isReg
            ? _t('auth.toggleLogin', '¿Ya tienes cuenta? Inicia sesión')
            : _t('auth.toggleRegistro', '¿No tienes cuenta? Regístrate');
        $('m-auth-firstnote').hidden = !isReg;
        $('m-pass').setAttribute('autocomplete', isReg ? 'new-password' : 'current-password');
    }

    function authError(msg) {
        const el = $('m-auth-error');
        el.textContent = msg;
        el.hidden = false;
    }

    async function submitAuth(e) {
        e.preventDefault();
        $('m-auth-error').hidden = true;
        const btn = $('m-auth-submit');
        const username = $('m-user').value.trim();
        const password = $('m-pass').value;

        if (username.length < 3) { authError(_pick('El usuario debe tener al menos 3 caracteres.', 'Username must be at least 3 characters.')); return; }
        if (password.length < 8) { authError(_pick('La contraseña debe tener al menos 8 caracteres.', 'Password must be at least 8 characters.')); return; }

        btn.disabled = true;
        try {
            const resp = await fetch('/api/auth/' + (_authMode === 'register' ? 'register' : 'login'), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ username, password })
            });
            const j = await resp.json().catch(() => ({}));
            if (!resp.ok) { authError(j.error || _t('auth.error', 'Error de autenticación.')); return; }
            _me = j;
            $('m-pass').value = '';
            await loadSettings();
            showApp();
            paintAccount();
            loadPortfolio();
        } catch (err) {
            authError(_t('err.servidor', 'No se pudo conectar con el servidor.'));
        } finally {
            btn.disabled = false;
        }
    }

    // El servidor devuelve 503 {code:'STARTING'} hasta que Mongo está conectado.
    // En ese caso no tiene sentido enseñar el login (fallaría al enviarlo): se avisa
    // y se reintenta solo. Sin esto, abrir el móvil justo al arrancar el servidor
    // daba un login que rechazaba credenciales correctas.
    async function checkSession(attempt) {
        const n = attempt || 0;
        try {
            const resp = await fetch('/api/auth/me');

            if (resp.status === 503) {
                const msg = $('m-boot-msg');
                if (msg) msg.textContent = _pick('Arrancando el servidor…', 'Starting the server…');
                if (n < 20) {
                    await new Promise(r => setTimeout(r, 1500));
                    return checkSession(n + 1);
                }
                if (msg) msg.textContent = _pick('El servidor sigue arrancando. Recarga en un momento.', 'The server is still starting. Reload in a moment.');
                return false;
            }

            if (!resp.ok) { showAuth(); return false; }
            _me = await resp.json();
            await loadSettings();
            showApp();
            paintAccount();
            return true;
        } catch (e) {
            showAuth();
            return false;
        }
    }

    async function doLogout() {
        try { await fetch('/api/auth/logout', { method: 'POST' }); } catch (e) { /* da igual: la cookie caduca */ }
        _me = null;
        _perfSeries = null; _perfPnl = null;
        if (_perfChart) { try { _perfChart.destroy(); } catch (e) { /* no-op */ } _perfChart = null; }
        showAuth();
        setAuthMode('login');
    }

    async function changePassword(e) {
        e.preventDefault();
        const msg = $('m-pass-msg');
        msg.hidden = true;
        msg.classList.remove('ok');
        const currentPassword = $('m-pass-cur').value;
        const newPassword = $('m-pass-new').value;
        try {
            const resp = await fetch('/api/auth/change-password', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ currentPassword, newPassword })
            });
            const j = await resp.json().catch(() => ({}));
            if (!resp.ok) {
                msg.textContent = j.error || _pick('No se pudo cambiar la contraseña.', 'Could not change the password.');
                msg.hidden = false;
                return;
            }
            msg.textContent = _pick('Contraseña actualizada. Las demás sesiones se cerraron.', 'Password updated. All other sessions were signed out.');
            msg.classList.add('ok');
            msg.hidden = false;
            $('m-pass-cur').value = '';
            $('m-pass-new').value = '';
        } catch (err) {
            msg.textContent = _t('err.servidor', 'No se pudo conectar con el servidor.');
            msg.hidden = false;
        }
    }

    // ---------- Ajustes de cuenta (idioma) ----------

    async function loadSettings() {
        try {
            const resp = await fetch('/api/settings');
            if (!resp.ok) return;
            const s = await resp.json();
            // El idioma guardado en la CUENTA manda sobre el del navegador: así el
            // móvil y el escritorio se ven en el mismo idioma sin configurar nada.
            if (s.lang && window.getLang && s.lang !== window.getLang() && window.setLang) {
                window.setLang(s.lang);
            }
        } catch (e) { /* no crítico */ }
    }

    async function saveSetting(key, value) {
        try {
            await fetch('/api/settings', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ key, value })
            });
        } catch (e) { console.warn('No se pudo guardar el ajuste:', e); }
    }

    // ============================================================
    // NAVEGACIÓN ENTRE VISTAS
    // ============================================================
    // Para añadir una vista: <button data-view="X"> en el nav + <section id="view-X"
    // class="m-view"> en el HTML. Nada más que tocar aquí.
    function showView(name) {
        document.querySelectorAll('.m-view').forEach(v => v.classList.toggle('active', v.id === 'view-' + name));
        document.querySelectorAll('.m-nav-btn').forEach(b => b.classList.toggle('active', b.getAttribute('data-view') === name));
        window.scrollTo({ top: 0, behavior: 'instant' in window ? 'instant' : 'auto' });
        // Carga perezosa: el resumen de monedas solo se pide la primera vez que
        // entras al tab, no en cada arranque de la app.
        if (name === 'coins' && !_coinsCache) loadCoins();
    }

    function paintAccount() {
        try {
            if (!_me) return;
            $('m-acc-name').textContent = _me.username || '—';
            $('m-avatar').textContent = (_me.username || '?').charAt(0);
            $('m-acc-role').textContent = _me.role === 'owner'
                ? _pick('Propietario de este panel', 'Owner of this dashboard')
                : _pick('Cuenta de usuario', 'User account');
            syncLangSeg();
        } catch (e) { console.error('Error pintando la cuenta:', e); }
    }

    function syncLangSeg() {
        const cur = (window.getLang && window.getLang()) || 'es';
        document.querySelectorAll('#m-lang-seg .m-seg-btn').forEach(b => {
            b.classList.toggle('active', b.getAttribute('data-lang') === cur);
        });
    }

    // ============================================================
    // PORTAFOLIO
    // ============================================================

    async function loadPortfolio(opts) {
        if (_pfLoading) return;
        _pfLoading = true;
        const silent = opts && opts.silent;
        const btn = $('m-refresh');
        if (!silent && btn) btn.classList.add('spinning');
        try {
            const resp = await fetch('/api/portfolio');
            if (resp.status === 401) { showAuth(); return; }
            if (!resp.ok) throw new Error('portfolio ' + resp.status);
            const pf = await resp.json();
            renderPortfolio(pf);
            // El rendimiento es una segunda llamada (más cara: histórico por moneda).
            // Se pide después para que el valor total aparezca cuanto antes.
            if (pf.holdings && pf.holdings.length) loadPerformance();
        } catch (e) {
            console.error('Error cargando el portafolio:', e);
            renderError();
        } finally {
            _pfLoading = false;
            if (btn) btn.classList.remove('spinning');
        }
    }

    function renderError() {
        $('m-pf-body').innerHTML =
            '<div class="m-empty">' +
            '<div class="m-empty-ico">⚠️</div>' +
            '<p>' + _esc(_pick('No se pudo cargar tu portafolio ahora mismo.', 'Could not load your portfolio right now.')) + '</p>' +
            '<p>' + _esc(_pick('Comprueba la conexión y vuelve a intentarlo.', 'Check your connection and try again.')) + '</p>' +
            '</div>';
    }

    function renderEmpty() {
        $('m-pf-body').innerHTML =
            '<div class="m-empty">' +
            '<div class="m-empty-ico">💼</div>' +
            '<p><strong>' + _esc(_pick('Todavía no has registrado tenencias.', 'You have not added any holdings yet.')) + '</strong></p>' +
            '<p>' + _esc(_pick('Las cantidades se introducen en "My Crypto", dentro de la pestaña Mercado de la versión completa. Aquí verás el total consolidado en cuanto haya alguna.', 'Amounts are entered in "My Crypto", inside the Market tab of the full version. The consolidated total will show up here as soon as there is one.')) + '</p>' +
            '<a class="m-btn-ghost" style="margin-top:14px;" href="/desktop">' + _esc(_t('m.verEscritorio', 'Ver versión completa')) + '</a>' +
            '</div>';
    }

    // Lectura práctica: qué significa el número, no solo el número.
    function readingText(pf) {
        const top = pf.holdings[0];
        const pos = pf.totalChange24hValue >= 0;
        const conc = top && top.allocationPct >= 60;
        if (_isEn()) {
            const c = conc ? ' It is concentrated in ' + top.symbol + ' (' + top.allocationPct.toFixed(0) + '%), so that coin drives most of the move.' : '';
            return 'Your holdings are worth ' + _fmtUsd(pf.totalValue) + ' right now — ' + (pos ? 'up ' : 'down ') + _fmtUsd(Math.abs(pf.totalChange24hValue)) + ' in the last 24h.' + c;
        }
        const c = conc ? ' Está concentrado en ' + top.symbol + ' (' + top.allocationPct.toFixed(0) + '%), así que esa moneda manda casi todo el movimiento.' : '';
        return 'Lo que tienes vale ' + _fmtUsd(pf.totalValue) + ' ahora mismo — ' + (pos ? 'ha subido ' : 'ha bajado ') + _fmtUsd(Math.abs(pf.totalChange24hValue)) + ' en las últimas 24h.' + c;
    }

    function renderPortfolio(pf) {
        try {
            if (!pf || !pf.holdings || pf.holdings.length === 0) { renderEmpty(); return; }

            const pos = pf.totalChange24hValue >= 0;
            let html = '';

            // --- Hero: valor total + cambio 24h ---
            html += '<div class="m-hero">' +
                '<div class="m-hero-label">' + _esc(_t('m.valorTotal', 'Valor total')) + '</div>' +
                '<div class="m-hero-value">' + _esc(_fmtUsd(pf.totalValue)) + '</div>' +
                '<div class="m-hero-change ' + (pos ? 'pos' : 'neg') + '">' +
                (pos ? '▲' : '▼') + ' ' + _esc(_fmtUsd(Math.abs(pf.totalChange24hValue))) + ' · ' + _esc(_pct(pf.totalChange24hPct)) +
                '</div>' +
                '<p class="m-hero-sub">' + _esc(pf.count) + ' ' +
                _esc(pf.count === 1 ? _pick('moneda', 'coin') : _pick('monedas', 'coins')) + ' · ' +
                _esc(_pick('24 h', '24h')) + '</p>' +
                '</div>';

            // --- Lectura práctica ---
            html += '<div class="m-reading"><span class="m-reading-ico">💡</span><span>' + _esc(readingText(pf)) + '</span></div>';

            // --- Chips de P&L (se rellenan al cargar el histórico) ---
            html += '<div class="m-pnl" id="m-pnl-row">' + pnlChipsHtml(null) + '</div>';

            // --- Gráfica de rendimiento ---
            html += '<div class="m-card">' +
                '<div class="m-chart-head">' +
                '<h3>' + _esc(_t('m.rendimiento', 'Rendimiento')) + '</h3>' +
                '<div class="m-seg" id="m-gran-seg">' +
                '<button type="button" class="m-seg-btn' + (_perfGran === 'day' ? ' active' : '') + '" data-gran="day">' + _esc(_t('m.granDia', 'Día')) + '</button>' +
                '<button type="button" class="m-seg-btn' + (_perfGran === 'week' ? ' active' : '') + '" data-gran="week">' + _esc(_t('m.granSemana', 'Semana')) + '</button>' +
                '<button type="button" class="m-seg-btn' + (_perfGran === 'month' ? ' active' : '') + '" data-gran="month">' + _esc(_t('m.granMes', 'Mes')) + '</button>' +
                '</div></div>' +
                '<div class="m-chart-wrap"><canvas id="m-perf-canvas"></canvas></div>' +
                '<p class="m-note" id="m-perf-note">' + _esc(_pick('Cargando rendimiento…', 'Loading performance…')) + '</p>' +
                '</div>';

            // --- Lista de tenencias ---
            html += '<div class="m-card"><h3>' + _esc(_t('m.tusMonedas', 'Tus monedas')) + '</h3>';
            for (const h of pf.holdings) {
                const hPos = (h.change24hPct != null) && h.change24hPct >= 0;
                const changeCls = (h.change24hPct == null) ? 'muted' : (hPos ? 'pos' : 'neg');
                html += '<div class="m-holding">' +
                    '<div class="m-hold-sym">' + _esc(h.symbol) + '</div>' +
                    '<div>' +
                    '<div class="m-hold-name">' + _esc(h.name) + '</div>' +
                    '<div class="m-hold-meta">' + _esc(_fmtAmount(h.amount)) + ' ' + _esc(h.symbol) + ' · ' + _esc(_fmtPrice(h.price)) + '</div>' +
                    '</div>' +
                    '<div class="m-hold-right">' +
                    '<div class="m-hold-value">' + _esc(_fmtUsd(h.value)) + '</div>' +
                    '<div class="m-hold-change ' + changeCls + '">' + _esc(h.change24hPct == null ? '--' : _pct(h.change24hPct)) + '</div>' +
                    '</div>' +
                    '<div class="m-alloc"><div class="m-alloc-fill" style="width:' + Math.max(2, Math.min(100, h.allocationPct || 0)).toFixed(1) + '%"></div></div>' +
                    '</div>';
            }
            html += '</div>';

            // --- Nota de procedencia de los precios (honestidad de datos) ---
            if (pf.source === 'stored' || pf.missing > 0) {
                html += '<p class="m-note">' + _esc(_pick(
                    'Algunos precios vienen del último dato guardado (CoinGecko no respondió en este momento).',
                    'Some prices come from the last stored value (CoinGecko did not respond just now).')) + '</p>';
            }

            $('m-pf-body').innerHTML = html;

            // Toggle de granularidad (delegado tras pintar)
            const seg = $('m-gran-seg');
            if (seg) {
                seg.addEventListener('click', (ev) => {
                    const btn = ev.target.closest('.m-seg-btn');
                    if (!btn) return;
                    _perfGran = btn.getAttribute('data-gran');
                    seg.querySelectorAll('.m-seg-btn').forEach(b => b.classList.toggle('active', b === btn));
                    renderPerformance();
                });
            }

            // Si el histórico ya estaba cargado (p. ej. refresco), repintarlo ya.
            if (_perfSeries) renderPerformance();
        } catch (e) {
            console.error('Error renderizando el portafolio:', e);
            renderError();
        }
    }

    function pnlChipsHtml(pnl) {
        const chip = (label, p) => {
            if (!p) return '<div class="m-pnl-chip"><span class="m-pnl-lbl">' + _esc(label) + '</span><span class="m-pnl-val muted">—</span></div>';
            const pos = p.abs >= 0;
            const sign = pos ? '+' : '−';
            return '<div class="m-pnl-chip"><span class="m-pnl-lbl">' + _esc(label) + '</span>' +
                '<span class="m-pnl-val ' + (pos ? 'pos' : 'neg') + '">' + sign + _esc(_fmtUsd(Math.abs(p.abs))) + '<br>' + sign + Math.abs(p.pct).toFixed(2) + '%</span></div>';
        };
        const p = pnl || {};
        return chip('24h', p.d1) + chip('7d', p.d7) + chip('30d', p.d30) + chip(_t('m.desdeInicio', 'Desde inicio'), p.sinceStart);
    }

    // ---------- Rendimiento en el tiempo ----------

    async function loadPerformance() {
        try {
            const resp = await fetch('/api/portfolio/history?range=365');
            if (resp.status === 401) { showAuth(); return; }
            if (!resp.ok) throw new Error('history ' + resp.status);
            const data = await resp.json();
            _perfSeries = Array.isArray(data.series) ? data.series : [];
            _perfPnl = data.pnl || {};
            renderPerformance();
        } catch (e) {
            console.error('Error cargando el rendimiento:', e);
            const note = $('m-perf-note');
            if (note) note.textContent = _pick('No se pudo cargar el rendimiento ahora mismo.', 'Could not load performance right now.');
        }
    }

    // Agrega la serie diaria a día/semana/mes (el último valor de cada periodo manda).
    // Mismo criterio que la versión de escritorio para que los dos den el mismo número.
    function aggregate(series, gran) {
        if (gran === 'day') return series.slice(-30);   // 30 días en móvil (60 en escritorio: no caben)
        const keyOf = (date) => {
            if (gran === 'month') return date.slice(0, 7);
            const d = new Date(date + 'T00:00:00Z');
            const dow = (d.getUTCDay() + 6) % 7;         // lunes = 0
            d.setUTCDate(d.getUTCDate() - dow);
            return d.toISOString().slice(0, 10);
        };
        const byKey = new Map();
        for (const pt of series) byKey.set(keyOf(pt.date), pt);
        const out = [...byKey.values()];
        return gran === 'month' ? out.slice(-12) : out.slice(-16);
    }

    function renderPerformance() {
        try {
            const row = $('m-pnl-row');
            if (row) row.innerHTML = pnlChipsHtml(_perfPnl);

            const note = $('m-perf-note');
            if (!_perfSeries || _perfSeries.length === 0) {
                if (note) note.textContent = _pick('Aún no hay histórico suficiente para dibujar la evolución.', 'Not enough history yet to draw the trend.');
                return;
            }

            const agg = aggregate(_perfSeries, _perfGran);
            const canvas = $('m-perf-canvas');
            if (!canvas || !window.Chart) return;

            if (_perfChart) { try { _perfChart.destroy(); } catch (e) { /* no-op */ } _perfChart = null; }

            const values = agg.map(p => p.value);
            const up = values.length > 1 ? values[values.length - 1] >= values[0] : true;
            const line = up ? '#22c55e' : '#ef4444';
            const fill = up ? 'rgba(34,197,94,0.14)' : 'rgba(239,68,68,0.14)';
            const locale = _isEn() ? 'en-US' : 'es-ES';
            const labels = agg.map(p => {
                const d = new Date(p.date + 'T00:00:00Z');
                if (_perfGran === 'month') return d.toLocaleDateString(locale, { month: 'short', year: '2-digit', timeZone: 'UTC' });
                return d.toLocaleDateString(locale, { day: 'numeric', month: 'short', timeZone: 'UTC' });
            });

            _perfChart = new Chart(canvas.getContext('2d'), {
                type: 'line',
                data: {
                    labels,
                    datasets: [{
                        data: values,
                        borderColor: line,
                        backgroundColor: fill,
                        borderWidth: 2,
                        pointRadius: values.length === 1 ? 3 : 0,
                        pointHoverRadius: 4,
                        tension: 0.3,
                        fill: true
                    }]
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    interaction: { mode: 'index', intersect: false },
                    plugins: {
                        legend: { display: false },
                        tooltip: {
                            callbacks: { label: (ctx) => _fmtUsd(ctx.parsed.y) }
                        }
                    },
                    scales: {
                        x: {
                            grid: { display: false },
                            ticks: { color: '#64748b', font: { size: 10 }, maxTicksLimit: 5, maxRotation: 0 }
                        },
                        y: {
                            grid: { color: 'rgba(255,255,255,0.05)' },
                            ticks: {
                                color: '#64748b', font: { size: 10 }, maxTicksLimit: 4,
                                callback: (v) => '$' + new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(v)
                            }
                        }
                    }
                }
            });

            // Nota honesta: parte de la serie es reconstrucción (tenencias de hoy ×
            // precios históricos), no un registro real de lo que tenías entonces.
            if (note) {
                const real = _perfSeries.filter(p => p.real).length;
                note.textContent = _pick(
                    'La serie anterior a tus primeros registros es una reconstrucción: tus cantidades actuales valoradas a precios históricos. Días con registro real: ' + real + '.',
                    'The part before your first snapshots is a reconstruction: today\'s amounts valued at historical prices. Days with a real snapshot: ' + real + '.'
                );
            }
        } catch (e) {
            console.error('Error dibujando el rendimiento:', e);
        }
    }

    // ============================================================
    // MONEDAS (lista de todas + ficha de detalle)
    // ============================================================
    // Se alimenta de /api/coins/summary: una sola respuesta con lo esencial de las
    // 9 monedas. Al abrir una moneda fría se pide /api/coins/refresh, que trae datos
    // frescos SIN cambiar la moneda activa de la cuenta (el escritorio no se entera).

    let _coinsCache = null;
    let _coinsLoading = false;
    let _openCoinId = null;

    function scoreClass(v) {
        if (v == null) return 'muted';
        if (v >= 65) return 'pos';
        if (v <= 40) return 'neg';
        return 'mid';
    }

    async function loadCoins(opts) {
        if (_coinsLoading) return;
        _coinsLoading = true;
        const silent = opts && opts.silent;
        try {
            const resp = await fetch('/api/coins/summary');
            if (resp.status === 401) { showAuth(); return; }
            if (!resp.ok) throw new Error('coins ' + resp.status);
            const json = await resp.json();
            _coinsCache = Array.isArray(json.coins) ? json.coins : [];
            // Si hay una ficha abierta, repintarla con el dato nuevo; si no, la lista.
            if (_openCoinId) renderCoinDetail(_openCoinId); else renderCoinsList();
        } catch (e) {
            console.error('Error cargando el resumen de monedas:', e);
            if (!silent) {
                $('m-coins-list').innerHTML =
                    '<div class="m-empty"><div class="m-empty-ico">⚠️</div><p>' +
                    _esc(_pick('No se pudo cargar el resumen de monedas.', 'Could not load the coin summary.')) +
                    '</p></div>';
            }
        } finally {
            _coinsLoading = false;
        }
    }

    function renderCoinsList() {
        try {
            const list = $('m-coins-list');
            const detail = $('m-coin-detail');
            if (!list) return;
            detail.hidden = true;
            list.hidden = false;
            _openCoinId = null;

            if (!_coinsCache || _coinsCache.length === 0) {
                list.innerHTML = '<div class="m-empty"><div class="m-empty-ico">🪙</div><p>' +
                    _esc(_pick('Todavía no hay datos de monedas.', 'No coin data yet.')) + '</p></div>';
                return;
            }

            let html = '<div class="m-reading"><span class="m-reading-ico">🧭</span><span>' +
                _esc(_pick(
                    'Las ' + _coinsCache.length + ' monedas que sigue el panel. Toca una para ver su veredicto, su score y los niveles que vigila el mercado.',
                    'The ' + _coinsCache.length + ' coins this dashboard tracks. Tap one to see its verdict, score and the levels the market watches.')) +
                '</span></div>';

            for (const c of _coinsCache) {
                const chgCls = (c.change24hPct == null) ? 'muted' : (c.change24hPct >= 0 ? 'pos' : 'neg');
                const sc = c.score && c.score.value != null ? c.score.value : null;
                html += '<button class="m-coin-row" type="button" data-coin="' + _esc(c.id) + '">' +
                    '<span class="m-coin-badge">' + _esc(c.symbol) + '</span>' +
                    '<span>' +
                    '<span class="m-coin-name">' + _esc(c.name) + '</span><br>' +
                    '<span class="m-coin-sub">' +
                    (sc != null ? '<span class="m-score ' + scoreClass(sc) + '">' + sc + '/100</span> ' : '') +
                    (c.iso20022 ? '<span class="m-iso">ISO 20022</span>' : '') +
                    (c.hasData ? '' : _esc(_pick('sin datos aún', 'no data yet'))) +
                    '</span>' +
                    '</span>' +
                    '<span class="m-coin-right">' +
                    '<span class="m-coin-price">' + _esc(_fmtPrice(c.price)) + '</span><br>' +
                    '<span class="m-coin-chg ' + chgCls + '">' + _esc(c.change24hPct == null ? '--' : _pct(c.change24hPct)) + '</span>' +
                    '</span>' +
                    '</button>';
            }
            list.innerHTML = html;
        } catch (e) {
            console.error('Error renderizando la lista de monedas:', e);
        }
    }

    async function openCoin(id) {
        _openCoinId = id;
        renderCoinDetail(id);
        window.scrollTo({ top: 0 });

        // Si los datos están tibios, pedir refresco SIN tocar la moneda activa.
        const c = (_coinsCache || []).find(x => x.id === id);
        if (!c || c.legacy) return;
        if (c.ageMinutes != null && c.ageMinutes < 5 && c.hasData) return;
        try {
            const resp = await fetch('/api/coins/refresh', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ id })
            });
            if (!resp.ok) return;
            const j = await resp.json();
            if (j.refreshed) await loadCoins({ silent: true }); // repinta la ficha abierta
        } catch (e) { /* si falla, se queda con lo cacheado y la etiqueta de antigüedad */ }
    }

    function freshnessText(c) {
        if (!c.hasData) return _pick('Sin datos todavía para esta moneda.', 'No data yet for this coin.');
        if (c.ageMinutes == null) return '';
        if (c.ageMinutes < 1) return _pick('Actualizado hace menos de un minuto.', 'Updated less than a minute ago.');
        if (c.ageMinutes < 60) return _pick('Actualizado hace ' + c.ageMinutes + ' min.', 'Updated ' + c.ageMinutes + ' min ago.');
        const h = Math.round(c.ageMinutes / 60);
        return _pick('Actualizado hace ' + h + ' h.', 'Updated ' + h + 'h ago.');
    }

    function renderCoinDetail(id) {
        try {
            const c = (_coinsCache || []).find(x => x.id === id);
            const list = $('m-coins-list');
            const detail = $('m-coin-detail');
            if (!c || !detail) return;

            list.hidden = true;
            detail.hidden = false;

            const chgCls = (c.change24hPct == null) ? 'muted' : (c.change24hPct >= 0 ? 'pos' : 'neg');
            const sc = c.score && c.score.value != null ? c.score.value : null;
            const scLabel = c.score ? _pick(c.score.label, c.score.labelEn || c.score.label) : null;

            let html = '<div class="m-detail-head">' +
                '<button class="m-back" type="button" id="m-coin-back" aria-label="Volver">‹</button>' +
                '<span>' +
                '<span class="m-detail-title">' + _esc(c.name) + ' · ' + _esc(c.symbol) + '</span><br>' +
                '<span class="m-detail-sub">' + _esc(freshnessText(c)) + '</span>' +
                '</span>' +
                '</div>';

            // Precio + 24h + score
            html += '<div class="m-hero">' +
                '<div class="m-hero-label">' + _esc(_pick('Precio', 'Price')) + '</div>' +
                '<div class="m-hero-value">' + _esc(_fmtPrice(c.price)) + '</div>' +
                '<div class="m-hero-change ' + (chgCls === 'muted' ? 'pos' : chgCls) + '">' +
                (c.change24hPct == null ? '--' : ((c.change24hPct >= 0 ? '▲' : '▼') + ' ' + _esc(_pct(c.change24hPct)))) +
                '</div>' +
                (sc != null ? '<p class="m-hero-sub">' + _esc(_pick('Score', 'Score')) + ': <span class="m-score ' + scoreClass(sc) + '">' + sc + '/100</span> ' + _esc(scLabel || '') + '</p>' : '') +
                '</div>';

            // Veredicto del brief — lo más valioso de la ficha
            if (c.brief && c.brief.headline) {
                html += '<div class="m-verdict ' + _esc(c.brief.tone || 'info') + '">' +
                    '<div class="m-verdict-lbl">' + _esc(_pick('Veredicto', 'Verdict')) + '</div>' +
                    '<div class="m-verdict-txt">' + _esc(_pick(c.brief.headline, c.brief.headlineEn || c.brief.headline)) + '</div>' +
                    '</div>';
            }

            // Niveles
            const lv = c.levels || {};
            if (lv.support != null || lv.resistance != null || lv.psychological != null) {
                html += '<div class="m-card"><h3>' + _esc(_pick('Niveles a vigilar', 'Levels to watch')) + '</h3>' +
                    '<div class="m-kv">' +
                    '<div class="m-kv-item"><span class="m-kv-lbl">' + _esc(_pick('Soporte 7d', 'Support 7d')) + '</span><span class="m-kv-val pos">' + _esc(_fmtPrice(lv.support)) + '</span></div>' +
                    '<div class="m-kv-item"><span class="m-kv-lbl">' + _esc(_pick('Resistencia 7d', 'Resistance 7d')) + '</span><span class="m-kv-val neg">' + _esc(_fmtPrice(lv.resistance)) + '</span></div>' +
                    (lv.psychological != null ? '<div class="m-kv-item"><span class="m-kv-lbl">' + _esc(_pick('Psicológico', 'Psychological')) + '</span><span class="m-kv-val">' + _esc(_fmtPrice(lv.psychological)) + '</span></div>' : '') +
                    (c.rsi14 != null ? '<div class="m-kv-item"><span class="m-kv-lbl">RSI 14</span><span class="m-kv-val">' + c.rsi14.toFixed(0) + '</span></div>' : '') +
                    (c.trendVsSma200Pct != null ? '<div class="m-kv-item"><span class="m-kv-lbl">' + _esc(_pick('vs media 200d', 'vs 200d avg')) + '</span><span class="m-kv-val ' + (c.trendVsSma200Pct >= 0 ? 'pos' : 'neg') + '">' + _esc(_pct(c.trendVsSma200Pct, 1)) + '</span></div>' : '') +
                    (c.marketCap != null ? '<div class="m-kv-item"><span class="m-kv-lbl">' + _esc(_pick('Capitalización', 'Market cap')) + '</span><span class="m-kv-val">$' + _esc(_fmtCompact(c.marketCap)) + '</span></div>' : '') +
                    '</div>' +
                    '<p class="m-note">' + _esc(_pick(
                        'Soporte y resistencia salen de los últimos 7 días; el psicológico es la cifra redonda que el mercado vigila.',
                        'Support and resistance come from the last 7 days; the psychological level is the round number the market watches.')) + '</p>' +
                    '</div>';
            }

            // Señales que sustentan el veredicto
            if (c.brief && Array.isArray(c.brief.señales) && c.brief.señales.length) {
                html += '<div class="m-card"><h3>' + _esc(_pick('Por qué', 'Why')) + '</h3>';
                for (const s of c.brief.señales) {
                    html += '<div class="m-signal">' +
                        '<span class="m-signal-dot ' + _esc(s.tone || '') + '"></span>' +
                        '<span>' +
                        '<span class="m-signal-area">' + _esc(_pick(s.area, s.areaEn || s.area)) + '</span>' +
                        '<span class="m-signal-txt">' + _esc(_pick(s.text, s.textEn || s.text)) + '</span>' +
                        '</span>' +
                        '</div>';
                }
                html += '</div>';
            }

            if (!c.hasData) {
                html += '<div class="m-empty"><div class="m-empty-ico">⏳</div><p>' +
                    _esc(_pick('Esta moneda aún no tiene datos cargados. El panel las refresca por turnos; vuelve en unos minutos.',
                               'This coin has no data loaded yet. The dashboard refreshes them in rotation; check back in a few minutes.')) +
                    '</p></div>';
            }

            html += '<p class="m-note">' + _esc(_pick(
                'Señales educativas generadas por reglas sobre datos públicos — no es asesoramiento financiero.',
                'Educational signals generated by rules over public data — not financial advice.')) + '</p>';

            detail.innerHTML = html;
            const back = $('m-coin-back');
            if (back) back.addEventListener('click', renderCoinsList);
        } catch (e) {
            console.error('Error renderizando la ficha de la moneda:', e);
        }
    }

    // Formato compacto para capitalizaciones (1.2B, 340M…)
    function _fmtCompact(v) {
        if (v == null || !isFinite(v)) return '--';
        return new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 2 }).format(v);
    }

    // ---------- Auto-refresco ----------
    // Cada 5 min, alineado con el ciclo del servidor. Se pausa con la pestaña oculta:
    // en un móvil, refrescar en segundo plano solo gasta batería y datos.
    function startAutoRefresh() {
        stopAutoRefresh();
        _refreshTimer = setInterval(() => {
            if (document.visibilityState === 'visible') loadPortfolio({ silent: true });
        }, 5 * 60 * 1000);
    }
    function stopAutoRefresh() {
        if (_refreshTimer) { clearInterval(_refreshTimer); _refreshTimer = null; }
    }

    // ============================================================
    // ARRANQUE
    // ============================================================
    document.addEventListener('DOMContentLoaded', () => {
        // Login / registro
        $('m-auth-form').addEventListener('submit', submitAuth);
        $('m-auth-toggle').addEventListener('click', () => setAuthMode(_authMode === 'login' ? 'register' : 'login'));

        // Navegación inferior
        $('m-nav').addEventListener('click', (ev) => {
            const btn = ev.target.closest('.m-nav-btn');
            if (btn) showView(btn.getAttribute('data-view'));
        });

        // Refrescar: actúa sobre la vista que estés mirando
        $('m-refresh').addEventListener('click', () => {
            const coinsActive = document.getElementById('view-coins').classList.contains('active');
            if (coinsActive) loadCoins(); else loadPortfolio();
        });

        // Lista de monedas: delegación (las filas se pintan dinámicamente)
        $('m-coins-list').addEventListener('click', (ev) => {
            const row = ev.target.closest('.m-coin-row');
            if (row) openCoin(row.getAttribute('data-coin'));
        });

        // Cuenta
        $('m-logout').addEventListener('click', doLogout);
        $('m-pass-form').addEventListener('submit', changePassword);
        $('m-lang-seg').addEventListener('click', (ev) => {
            const btn = ev.target.closest('.m-seg-btn');
            if (!btn || !window.setLang) return;
            const lang = btn.getAttribute('data-lang');
            window.setLang(lang);
            saveSetting('lang', lang);   // se guarda en la CUENTA, igual que en escritorio
        });

        // Al cambiar de idioma (botón del login o segmentado de Cuenta) hay que
        // repintar los textos dinámicos: i18n.js solo traduce los data-i18n estáticos.
        window.addEventListener('langchange', () => {
            try {
                setAuthMode(_authMode);
                syncLangSeg();
                paintAccount();
                setupViewBar();
                if (!$('m-app').hidden) loadPortfolio({ silent: true });
                // Las monedas ya están en memoria: basta repintar con el idioma nuevo
                // (los textos del brief vienen bilingües del servidor).
                if (_coinsCache) { if (_openCoinId) renderCoinDetail(_openCoinId); else renderCoinsList(); }
            } catch (e) { console.error('Error aplicando el cambio de idioma:', e); }
        });

        // Sesión → portafolio
        checkSession().then(ok => { if (ok) loadPortfolio(); });
    });
})();
