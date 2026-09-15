// ============================================================
// lib/auth.js — autenticación multiusuario "sencilla pero segura" (v2.8)
//
// Decisiones de seguridad (y su porqué):
// - Contraseñas: scrypt (node:crypto) con salt aleatorio de 16 bytes por usuario.
//   Nunca se guarda la contraseña, solo salt+hash. Comparación con timingSafeEqual.
// - Sesiones: token aleatorio de 32 bytes (crypto.randomBytes) en cookie HttpOnly
//   SameSite=Strict. En la BD se guarda SOLO el SHA-256 del token: si alguien
//   roba la BD no obtiene tokens usables. Expiración 30 días.
// - Rate-limit en memoria por IP para login/registro (frena fuerza bruta local).
// - Cookie "Secure": se activa AUTOMÁTICAMENTE en producción (ver SECURE_COOKIE).
//
// v2.8: la persistencia (lib/db.js) pasó de SQLite síncrono a MongoDB async. Por
// eso todo lo que toca la BD aquí es ahora async/await. El resto (scrypt, cookies,
// rate-limit) sigue igual y síncrono.
// ============================================================

const crypto = require('crypto');
const db = require('./db');

const SESSION_TTL_MS = 30 * 24 * 3600 * 1000; // 30 días
const SCRYPT_KEYLEN = 64;
const USERNAME_RE = /^[a-zA-Z0-9_.-]{3,30}$/;
const MIN_PASSWORD_LEN = 8;

const SECURE_COOKIE = process.env.NODE_ENV === 'production' || process.env.PUBLIC_HTTPS === '1';

// ---------- Contraseñas ----------
function hashPassword(password) {
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = crypto.scryptSync(String(password), salt, SCRYPT_KEYLEN).toString('hex');
    return { salt, hash };
}

function verifyPassword(password, salt, expectedHashHex) {
    try {
        const actual = crypto.scryptSync(String(password), salt, SCRYPT_KEYLEN);
        const expected = Buffer.from(expectedHashHex, 'hex');
        return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
    } catch (e) {
        return false;
    }
}

// ---------- Sesiones ----------
function sha256(s) { return crypto.createHash('sha256').update(s).digest('hex'); }

async function createSessionForUser(userId) {
    const token = crypto.randomBytes(32).toString('hex');
    await db.createSession(sha256(token), userId, Date.now() + SESSION_TTL_MS);
    return token;
}

function parseCookies(req) {
    const out = {};
    const header = req.headers.cookie;
    if (!header) return out;
    for (const part of header.split(';')) {
        const eq = part.indexOf('=');
        if (eq === -1) continue;
        out[part.slice(0, eq).trim()] = decodeURIComponent(part.slice(eq + 1).trim());
    }
    return out;
}

function sessionCookie(token, maxAgeS) {
    return `sid=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAgeS}${SECURE_COOKIE ? '; Secure' : ''}`;
}

async function getUserFromRequest(req) {
    const token = parseCookies(req).sid;
    if (!token || token.length !== 64) return null;
    const session = await db.getSession(sha256(token));
    if (!session) return null;
    return db.getUserById(session.user_id);
}

// Middleware async: protege un endpoint. 401 JSON si no hay sesión válida; 500 si
// la BD falla (no dejamos pasar la request como si estuviera autenticada).
function requireAuth(req, res, next) {
    getUserFromRequest(req)
        .then((user) => {
            if (!user) return res.status(401).json({ error: 'No autenticado', code: 'AUTH_REQUIRED' });
            req.user = user;
            next();
        })
        .catch((e) => {
            console.error('requireAuth: error consultando la sesión:', e.message);
            res.status(500).json({ error: 'Error de autenticación.' });
        });
}

// ---------- Rate limit (en memoria, por IP) ----------
const attempts = new Map(); // ip -> { count, firstAt }
const MAX_ATTEMPTS = 8;
const WINDOW_MS = 10 * 60 * 1000;

function rateLimited(ip) {
    const now = Date.now();
    const entry = attempts.get(ip);
    if (!entry || now - entry.firstAt > WINDOW_MS) {
        attempts.set(ip, { count: 1, firstAt: now });
        return false;
    }
    entry.count++;
    return entry.count > MAX_ATTEMPTS;
}

function clearRateLimit(ip) { attempts.delete(ip); }

// Envuelve un handler async para que un throw acabe en 500 y no en promesa colgada.
function aw(handler) {
    return (req, res) => Promise.resolve(handler(req, res)).catch((e) => {
        console.error('Auth handler error:', e && e.message);
        if (!res.headersSent) res.status(500).json({ error: 'Error interno de autenticación.' });
    });
}

// ---------- Registro de rutas ----------
function registerAuthRoutes(app) {
    // Estado de sesión (el frontend decide si muestra login o dashboard)
    app.get('/api/auth/me', aw(async (req, res) => {
        const user = await getUserFromRequest(req);
        if (!user) return res.status(401).json({ error: 'No autenticado', usersExist: (await db.countUsers()) > 0 });
        res.json({ id: user.id, username: user.username, role: user.role });
    }));

    // Registro (multiusuario). El PRIMER usuario creado recibe rol "owner".
    app.post('/api/auth/register', aw(async (req, res) => {
        const ip = req.ip || req.socket.remoteAddress || 'unknown';
        if (rateLimited(ip)) return res.status(429).json({ error: 'Demasiados intentos. Espera 10 minutos.' });

        const username = String((req.body && req.body.username) || '').trim();
        const password = String((req.body && req.body.password) || '');
        if (!USERNAME_RE.test(username)) {
            return res.status(400).json({ error: 'Usuario inválido: 3-30 caracteres, solo letras, números y . _ -' });
        }
        if (password.length < MIN_PASSWORD_LEN) {
            return res.status(400).json({ error: `La contraseña debe tener al menos ${MIN_PASSWORD_LEN} caracteres.` });
        }
        if (await db.getUserByUsername(username)) {
            return res.status(409).json({ error: 'Ese usuario ya existe.' });
        }
        const role = (await db.countUsers()) === 0 ? 'owner' : 'user';
        const { salt, hash } = hashPassword(password);
        let user;
        try {
            user = await db.createUser(username, salt, hash, role);
        } catch (e) {
            // Carrera: dos registros del mismo usuario a la vez → el índice único lo caza.
            if (e && e.code === 'DUPLICATE') return res.status(409).json({ error: 'Ese usuario ya existe.' });
            throw e;
        }
        const token = await createSessionForUser(user.id);
        clearRateLimit(ip);
        res.setHeader('Set-Cookie', sessionCookie(token, SESSION_TTL_MS / 1000));
        console.log(`Auth: usuario "${username}" registrado (rol ${role}).`);
        res.json({ id: user.id, username: user.username, role });
    }));

    // Login
    app.post('/api/auth/login', aw(async (req, res) => {
        const ip = req.ip || req.socket.remoteAddress || 'unknown';
        if (rateLimited(ip)) return res.status(429).json({ error: 'Demasiados intentos. Espera 10 minutos.' });

        const username = String((req.body && req.body.username) || '').trim();
        const password = String((req.body && req.body.password) || '');
        const user = await db.getUserByUsername(username);
        // Mismo mensaje exista o no el usuario (no filtrar qué usuarios existen)
        if (!user || !verifyPassword(password, user.pass_salt, user.pass_hash)) {
            return res.status(401).json({ error: 'Usuario o contraseña incorrectos.' });
        }
        const token = await createSessionForUser(user.id);
        clearRateLimit(ip);
        res.setHeader('Set-Cookie', sessionCookie(token, SESSION_TTL_MS / 1000));
        console.log(`Auth: login de "${username}".`);
        res.json({ id: user.id, username: user.username, role: user.role });
    }));

    // Logout: borra la sesión en BD y expira la cookie
    app.post('/api/auth/logout', aw(async (req, res) => {
        const token = parseCookies(req).sid;
        if (token) await db.deleteSession(sha256(token));
        res.setHeader('Set-Cookie', sessionCookie('', 0));
        res.json({ success: true });
    }));

    // Cambiar contraseña (requiere sesión + la contraseña ACTUAL). Al cambiarla se
    // invalidan TODAS las sesiones del usuario y se re-emite una nueva cookie para
    // este navegador, para que quien la cambió no quede fuera.
    app.post('/api/auth/change-password', aw(async (req, res) => {
        const user = await getUserFromRequest(req);
        if (!user) return res.status(401).json({ error: 'No autenticado', code: 'AUTH_REQUIRED' });

        const ip = req.ip || req.socket.remoteAddress || 'unknown';
        if (rateLimited(ip)) return res.status(429).json({ error: 'Demasiados intentos. Espera 10 minutos.' });

        const currentPassword = String((req.body && req.body.currentPassword) || '');
        const newPassword = String((req.body && req.body.newPassword) || '');
        if (newPassword.length < MIN_PASSWORD_LEN) {
            return res.status(400).json({ error: `La nueva contraseña debe tener al menos ${MIN_PASSWORD_LEN} caracteres.` });
        }
        if (newPassword === currentPassword) {
            return res.status(400).json({ error: 'La nueva contraseña debe ser distinta de la actual.' });
        }
        const full = await db.getUserWithSecretById(user.id);
        if (!full || !verifyPassword(currentPassword, full.pass_salt, full.pass_hash)) {
            return res.status(401).json({ error: 'La contraseña actual es incorrecta.' });
        }
        const { salt, hash } = hashPassword(newPassword);
        await db.updateUserPassword(user.id, salt, hash);
        await db.deleteSessionsForUser(user.id);       // invalida todo lo anterior
        const token = await createSessionForUser(user.id); // re-emitir para este navegador
        clearRateLimit(ip);
        res.setHeader('Set-Cookie', sessionCookie(token, SESSION_TTL_MS / 1000));
        console.log(`Auth: "${user.username}" cambió su contraseña (sesiones previas invalidadas).`);
        res.json({ success: true });
    }));

    // Limpieza periódica de sesiones caducadas (cada 6 h)
    setInterval(() => {
        db.purgeExpiredSessions().catch(() => { /* no crítico */ });
    }, 6 * 3600 * 1000);
}

// parseCookies se exporta (v2.9) para que server.js lea la cookie de "viewMode"
// (escritorio/móvil) sin duplicar el parseo de cabeceras Cookie en dos sitios.
module.exports = { registerAuthRoutes, requireAuth, getUserFromRequest, parseCookies };
