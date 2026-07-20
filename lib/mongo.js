// ============================================================
// lib/mongo.js — conexión única a MongoDB (v2.8)
//
// Toda la persistencia del dashboard (usuarios/sesiones/ajustes Y el estado de
// mercado) vive ahora en MongoDB — el mismo Mongo del Kali donde ya corren los
// otros proyectos. Un solo MongoClient reutilizado por todo el proceso.
//
// Config (parser .env propio en server.js, sin dotenv):
//   MONGODB_URI  → cadena de conexión (default mongodb://127.0.0.1:27017)
//   MONGO_DB     → base de datos (default "uscashout")
//
// El servidor NO arranca a servir hasta que connect() resuelve (ver server.js):
// sin BD no hay login ni estado, así que fallar temprano y claro es lo correcto.
// ============================================================

const { MongoClient } = require('mongodb');

// Se leen en tiempo de conexión (no al cargar el módulo) para que el parser .env
// propio de server.js ya haya poblado process.env cuando esto corre.
const uri = () => process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017';
const dbName = () => process.env.MONGO_DB || 'uscashout';

let client = null;
let db = null;

async function connect() {
    if (db) return db;
    client = new MongoClient(uri(), {
        // Timeouts cortos: si el Mongo no está, queremos un error claro al arrancar,
        // no un proceso colgado indefinidamente.
        serverSelectionTimeoutMS: 8000,
        connectTimeoutMS: 8000,
    });
    await client.connect();
    db = client.db(dbName());
    // Ping explícito: connect() puede resolver sin haber hablado con el server.
    await db.command({ ping: 1 });
    return db;
}

function getDb() {
    if (!db) throw new Error('MongoDB no conectado: llama a connect() en el arranque antes de usar getDb().');
    return db;
}

function getDbName() { return dbName(); }

async function close() {
    if (client) {
        try { await client.close(); } catch (e) { /* no-op */ }
        client = null;
        db = null;
    }
}

module.exports = { connect, getDb, getDbName, close };
