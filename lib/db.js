// ============================================================
// lib/db.js — capa de persistencia para usuarios/sesiones/ajustes (v2.8, MongoDB)
//
// Antes (v2.3–v2.7): SQLite nativo (dashboard.db) con fallback JSON. Desde v2.8
// TODO vive en MongoDB (el Mongo del Kali), como el resto de proyectos. La API
// pública es la MISMA que antes salvo que ahora es **async** (Mongo es async):
//   countUsers(), createUser(), getUserByUsername(), getUserById()
//   getUserWithSecretById(), updateUserPassword(), deleteSessionsForUser()
//   createSession(), getSession(), deleteSession(), purgeExpiredSessions()
//   getSetting(), setSetting(), getAllSettings()
//
// Ids de usuario: se mantienen ENTEROS autoincrementales (colección `counters`)
// para no cambiar la semántica que el resto del código ya asumía (session.user_id
// numérico, settings por user_id numérico, {id} numérico hacia el frontend).
//
// Colecciones: users, sessions, settings, counters, dashboard_state, dashboard_history.
// (Las dos últimas las usa lib/state.js para el estado de mercado.)
// ============================================================

const mongo = require('./mongo');

let users, sessions, settings, counters, portfolioHistory;

// init(): tras mongo.connect(). Cachea las colecciones y asegura índices.
async function init() {
    const db = mongo.getDb();
    users = db.collection('users');
    sessions = db.collection('sessions');
    settings = db.collection('settings');
    counters = db.collection('counters');
    portfolioHistory = db.collection('portfolio_history');

    await users.createIndex({ username: 1 }, { unique: true });
    await sessions.createIndex({ user_id: 1 });
    await sessions.createIndex({ expires_at: 1 });
    await settings.createIndex({ user_id: 1, key: 1 }, { unique: true });
    await portfolioHistory.createIndex({ user_id: 1, date: 1 }, { unique: true });
}

// --- Histórico de valor del portafolio (v2.8.2) — un snapshot por usuario y día ---
async function snapshotPortfolio(userId, date, totalValue) {
    await portfolioHistory.updateOne(
        { user_id: userId, date },
        { $set: { totalValue, capturedAt: new Date() } },
        { upsert: true },
    );
}

async function getPortfolioSnapshots(userId, sinceDate) {
    return portfolioHistory.find({ user_id: userId, date: { $gte: sinceDate } }).sort({ date: 1 }).toArray();
}

function getEngine() { return 'mongodb'; }

// Autoincremento atómico (emula el AUTOINCREMENT de SQLite / nextUserId del JSON).
async function nextSeq(name) {
    const r = await counters.findOneAndUpdate(
        { _id: name },
        { $inc: { seq: 1 } },
        { upsert: true, returnDocument: 'after' },
    );
    // Compat entre versiones del driver: unas devuelven el doc, otras {value}.
    const doc = (r && r.value) ? r.value : r;
    return doc.seq;
}

async function countUsers() {
    return users.countDocuments();
}

async function createUser(username, passSalt, passHash, role) {
    const id = await nextSeq('users');
    const createdAt = new Date().toISOString();
    try {
        await users.insertOne({ _id: id, username, pass_salt: passSalt, pass_hash: passHash, role, created_at: createdAt });
    } catch (e) {
        if (e && e.code === 11000) { // clave duplicada = username ya existe
            const err = new Error('UNIQUE constraint failed');
            err.code = 'DUPLICATE';
            throw err;
        }
        throw e;
    }
    return { id, username, role };
}

// Normaliza el doc de Mongo (_id) a la forma que el resto del código espera (.id).
function shapeUser(doc, withSecret) {
    if (!doc) return null;
    const base = { id: doc._id, username: doc.username, role: doc.role, created_at: doc.created_at };
    if (withSecret) { base.pass_salt = doc.pass_salt; base.pass_hash = doc.pass_hash; }
    return base;
}

async function getUserByUsername(username) {
    return shapeUser(await users.findOne({ username }), true);
}

async function getUserById(id) {
    return shapeUser(await users.findOne({ _id: id }), false);
}

// Variante que SÍ incluye salt+hash — solo para verificar la contraseña actual al cambiarla.
async function getUserWithSecretById(id) {
    return shapeUser(await users.findOne({ _id: id }), true);
}

async function updateUserPassword(id, passSalt, passHash) {
    await users.updateOne({ _id: id }, { $set: { pass_salt: passSalt, pass_hash: passHash } });
}

async function deleteSessionsForUser(userId) {
    await sessions.deleteMany({ user_id: userId });
}

async function createSession(tokenHash, userId, expiresAtMs) {
    const createdAt = new Date().toISOString();
    // El _id es el SHA-256 del token (único por definición).
    await sessions.insertOne({ _id: tokenHash, user_id: userId, expires_at: expiresAtMs, created_at: createdAt });
}

async function getSession(tokenHash) {
    const s = await sessions.findOne({ _id: tokenHash });
    if (!s || s.expires_at <= Date.now()) return null;
    // Devuelve la misma forma que antes (token_hash, user_id, expires_at).
    return { token_hash: s._id, user_id: s.user_id, expires_at: s.expires_at, created_at: s.created_at };
}

async function deleteSession(tokenHash) {
    await sessions.deleteOne({ _id: tokenHash });
}

async function purgeExpiredSessions() {
    await sessions.deleteMany({ expires_at: { $lte: Date.now() } });
}

async function getSetting(userId, key) {
    const r = await settings.findOne({ user_id: userId, key });
    return r ? r.value : null;
}

async function setSetting(userId, key, value) {
    const updatedAt = new Date().toISOString();
    await settings.updateOne(
        { user_id: userId, key },
        { $set: { value: String(value), updated_at: updatedAt } },
        { upsert: true },
    );
}

async function getAllSettings(userId) {
    const rows = await settings.find({ user_id: userId }).toArray();
    const out = {};
    for (const r of rows) out[r.key] = r.value;
    return out;
}

module.exports = {
    init, getEngine,
    countUsers, createUser, getUserByUsername, getUserById, getUserWithSecretById, updateUserPassword,
    createSession, getSession, deleteSession, deleteSessionsForUser, purgeExpiredSessions,
    getSetting, setSetting, getAllSettings,
    snapshotPortfolio, getPortfolioSnapshots,
};
