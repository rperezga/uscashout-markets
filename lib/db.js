// ============================================================
// lib/db.js — capa de persistencia para usuarios/sesiones/ajustes (v2.3)
//
// Motor preferido: SQLite NATIVO de Node (node:sqlite) → archivo dashboard.db,
// cero dependencias npm y cero instalación (filosofía del proyecto).
// node:sqlite existe desde Node 22.5 (en 22.x puede requerir el flag
// --experimental-sqlite; run.bat ya lo pasa — es inofensivo en versiones
// donde ya no hace falta).
//
// Fallback honesto: si node:sqlite no está disponible (Node < 22.5), se usa
// un archivo JSON (dashboard-db.json) con escritura atómica y la MISMA API,
// y se deja constancia en consola de qué motor quedó activo (getEngine()).
//
// La API es deliberadamente estrecha (solo lo que el dashboard necesita):
//   countUsers(), createUser(), getUserByUsername(), getUserById()
//   createSession(), getSession(), deleteSession(), purgeExpiredSessions()
//   getSetting(userId, key), setSetting(userId, key, value), getAllSettings(userId)
// Así el motor puede cambiarse (p. ej. a better-sqlite3 o Postgres) sin tocar
// el resto del código.
// ============================================================

const path = require('path');
const fs = require('fs');

const DB_FILE = path.join(__dirname, '..', 'dashboard.db');
const FALLBACK_FILE = path.join(__dirname, '..', 'dashboard-db.json');

let engine = 'json';
let sqlite = null;

// --- Intento 1: SQLite nativo de Node ---
try {
    const { DatabaseSync } = require('node:sqlite');
    sqlite = new DatabaseSync(DB_FILE);
    sqlite.exec(`
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT UNIQUE NOT NULL,
            pass_salt TEXT NOT NULL,
            pass_hash TEXT NOT NULL,
            role TEXT NOT NULL DEFAULT 'user',
            created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS sessions (
            token_hash TEXT PRIMARY KEY,
            user_id INTEGER NOT NULL,
            expires_at INTEGER NOT NULL,
            created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS settings (
            user_id INTEGER NOT NULL,
            key TEXT NOT NULL,
            value TEXT,
            updated_at TEXT NOT NULL,
            PRIMARY KEY (user_id, key)
        );
    `);
    engine = 'sqlite';
} catch (e) {
    engine = 'json';
}

// --- Fallback JSON (misma semántica, escritura atómica) ---
function readFallback() {
    try {
        if (!fs.existsSync(FALLBACK_FILE)) return { users: [], sessions: [], settings: [], nextUserId: 1 };
        const j = JSON.parse(fs.readFileSync(FALLBACK_FILE, 'utf8'));
        return { users: j.users || [], sessions: j.sessions || [], settings: j.settings || [], nextUserId: j.nextUserId || 1 };
    } catch (e) {
        console.error('dashboard-db.json ilegible, se trata como vacío:', e.message);
        return { users: [], sessions: [], settings: [], nextUserId: 1 };
    }
}

function writeFallback(db) {
    const tmp = FALLBACK_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(db, null, 2), 'utf8');
    fs.renameSync(tmp, FALLBACK_FILE);
}

// ============ API pública ============

function getEngine() { return engine; }

function countUsers() {
    if (engine === 'sqlite') {
        return sqlite.prepare('SELECT COUNT(*) AS n FROM users').get().n;
    }
    return readFallback().users.length;
}

function createUser(username, passSalt, passHash, role) {
    const createdAt = new Date().toISOString();
    if (engine === 'sqlite') {
        const r = sqlite.prepare('INSERT INTO users (username, pass_salt, pass_hash, role, created_at) VALUES (?, ?, ?, ?, ?)')
            .run(username, passSalt, passHash, role, createdAt);
        return { id: Number(r.lastInsertRowid), username, role };
    }
    const db = readFallback();
    if (db.users.some(u => u.username === username)) {
        const err = new Error('UNIQUE constraint failed');
        err.code = 'DUPLICATE';
        throw err;
    }
    const user = { id: db.nextUserId++, username, pass_salt: passSalt, pass_hash: passHash, role, created_at: createdAt };
    db.users.push(user);
    writeFallback(db);
    return { id: user.id, username, role };
}

function getUserByUsername(username) {
    if (engine === 'sqlite') {
        return sqlite.prepare('SELECT * FROM users WHERE username = ?').get(username) || null;
    }
    return readFallback().users.find(u => u.username === username) || null;
}

function getUserById(id) {
    if (engine === 'sqlite') {
        return sqlite.prepare('SELECT id, username, role, created_at FROM users WHERE id = ?').get(id) || null;
    }
    const u = readFallback().users.find(u => u.id === id);
    return u ? { id: u.id, username: u.username, role: u.role, created_at: u.created_at } : null;
}

// Variante que SÍ incluye salt+hash — solo para verificar la contraseña actual
// al cambiarla (getUserById los omite a propósito para no exponerlos de más).
function getUserWithSecretById(id) {
    if (engine === 'sqlite') {
        return sqlite.prepare('SELECT * FROM users WHERE id = ?').get(id) || null;
    }
    return readFallback().users.find(u => u.id === id) || null;
}

function updateUserPassword(id, passSalt, passHash) {
    if (engine === 'sqlite') {
        sqlite.prepare('UPDATE users SET pass_salt = ?, pass_hash = ? WHERE id = ?').run(passSalt, passHash, id);
        return;
    }
    const db = readFallback();
    const u = db.users.find(u => u.id === id);
    if (u) { u.pass_salt = passSalt; u.pass_hash = passHash; writeFallback(db); }
}

// Invalida TODAS las sesiones de un usuario (tras cambiar la contraseña).
function deleteSessionsForUser(userId) {
    if (engine === 'sqlite') {
        sqlite.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
        return;
    }
    const db = readFallback();
    const before = db.sessions.length;
    db.sessions = db.sessions.filter(s => s.user_id !== userId);
    if (db.sessions.length !== before) writeFallback(db);
}

function createSession(tokenHash, userId, expiresAtMs) {
    const createdAt = new Date().toISOString();
    if (engine === 'sqlite') {
        sqlite.prepare('INSERT INTO sessions (token_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)')
            .run(tokenHash, userId, expiresAtMs, createdAt);
        return;
    }
    const db = readFallback();
    db.sessions.push({ token_hash: tokenHash, user_id: userId, expires_at: expiresAtMs, created_at: createdAt });
    writeFallback(db);
}

function getSession(tokenHash) {
    if (engine === 'sqlite') {
        const s = sqlite.prepare('SELECT * FROM sessions WHERE token_hash = ?').get(tokenHash);
        return (s && s.expires_at > Date.now()) ? s : null;
    }
    const s = readFallback().sessions.find(x => x.token_hash === tokenHash);
    return (s && s.expires_at > Date.now()) ? s : null;
}

function deleteSession(tokenHash) {
    if (engine === 'sqlite') {
        sqlite.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash);
        return;
    }
    const db = readFallback();
    db.sessions = db.sessions.filter(x => x.token_hash !== tokenHash);
    writeFallback(db);
}

function purgeExpiredSessions() {
    const now = Date.now();
    if (engine === 'sqlite') {
        sqlite.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(now);
        return;
    }
    const db = readFallback();
    const before = db.sessions.length;
    db.sessions = db.sessions.filter(x => x.expires_at > now);
    if (db.sessions.length !== before) writeFallback(db);
}

function getSetting(userId, key) {
    if (engine === 'sqlite') {
        const r = sqlite.prepare('SELECT value FROM settings WHERE user_id = ? AND key = ?').get(userId, key);
        return r ? r.value : null;
    }
    const r = readFallback().settings.find(s => s.user_id === userId && s.key === key);
    return r ? r.value : null;
}

function setSetting(userId, key, value) {
    const updatedAt = new Date().toISOString();
    if (engine === 'sqlite') {
        sqlite.prepare(`
            INSERT INTO settings (user_id, key, value, updated_at) VALUES (?, ?, ?, ?)
            ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
        `).run(userId, key, String(value), updatedAt);
        return;
    }
    const db = readFallback();
    const existing = db.settings.find(s => s.user_id === userId && s.key === key);
    if (existing) { existing.value = String(value); existing.updated_at = updatedAt; }
    else db.settings.push({ user_id: userId, key, value: String(value), updated_at: updatedAt });
    writeFallback(db);
}

function getAllSettings(userId) {
    let rows;
    if (engine === 'sqlite') {
        rows = sqlite.prepare('SELECT key, value FROM settings WHERE user_id = ?').all(userId);
    } else {
        rows = readFallback().settings.filter(s => s.user_id === userId);
    }
    const out = {};
    for (const r of rows) out[r.key] = r.value;
    return out;
}

module.exports = {
    getEngine,
    countUsers, createUser, getUserByUsername, getUserById, getUserWithSecretById, updateUserPassword,
    createSession, getSession, deleteSession, deleteSessionsForUser, purgeExpiredSessions,
    getSetting, setSetting, getAllSettings
};
