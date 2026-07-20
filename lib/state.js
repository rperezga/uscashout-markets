// ============================================================
// lib/state.js — estado de mercado (data.json/history.json) en MongoDB (v2.8)
//
// Antes: data.json y history.json eran ficheros en disco. Desde v2.8 el estado
// vive en Mongo (colecciones dashboard_state y dashboard_history, un doc cada una)
// y se MIRRORea en memoria para lecturas síncronas rápidas — así los ~30 sitios que
// leían el fichero de forma síncrona no tienen que volverse async.
//
// Contrato:
//   - init(seedData, seedHistory): carga de Mongo (o siembra) ANTES de servir.
//   - readState()/readStateRaw(): copia FRESCA e independiente (misma semántica que
//     JSON.parse(fs.readFileSync(DATA_FILE))): quien la muta no toca el estado vivo.
//   - withDataFile(mutator): cola serializada — muta el estado vivo y agenda un
//     guardado a Mongo (debounced ~1,5 s para coalescer las ráfagas de un ciclo).
//     MISMA firma y semántica de concurrencia que la versión de fichero.
//   - readHistory()/withHistory(mutator): idem para el histórico diario (un array).
//   - flush(): fuerza el guardado pendiente (para el cierre limpio).
// ============================================================

const mongo = require('./mongo');

const STATE_ID = 'dashboard';
const HISTORY_ID = 'history';
const PERSIST_DEBOUNCE_MS = 1500;

let stateCol = null, historyCol = null;
let dataState = null;     // espejo en memoria de data.json
let historyState = null;  // espejo en memoria de history.json (array)
let dirty = false, historyDirty = false;
let persistTimer = null;

async function init(seedData, seedHistory) {
    const db = mongo.getDb();
    stateCol = db.collection('dashboard_state');
    historyCol = db.collection('dashboard_history');

    const sdoc = await stateCol.findOne({ _id: STATE_ID });
    if (sdoc && sdoc.data && typeof sdoc.data === 'object') {
        dataState = sdoc.data;
    } else {
        dataState = seedData || {};
        await stateCol.updateOne({ _id: STATE_ID }, { $set: { data: dataState, updatedAt: new Date() } }, { upsert: true });
    }

    const hdoc = await historyCol.findOne({ _id: HISTORY_ID });
    historyState = (hdoc && Array.isArray(hdoc.data)) ? hdoc.data : (Array.isArray(seedHistory) ? seedHistory : []);
    if (!hdoc) {
        await historyCol.updateOne({ _id: HISTORY_ID }, { $set: { data: historyState, updatedAt: new Date() } }, { upsert: true });
    }
}

function ready() { return dataState !== null; }

// --- Lecturas: copia fresca e independiente ---
function readState() { return JSON.parse(JSON.stringify(dataState)); }
function readStateRaw() { return JSON.stringify(dataState); }
function readHistory() { return Array.isArray(historyState) ? historyState.slice() : []; }
function readHistoryRaw() { return JSON.stringify(historyState || []); }

// --- Escritura serializada del estado (misma cola que la versión de fichero) ---
let _lock = Promise.resolve();
function withDataFile(mutator) {
    _lock = _lock.then(() => {
        if (!dataState) return; // aún no inicializado: no perder la app, solo saltar
        mutator(dataState);
        schedulePersist();
    }).catch((e) => console.error('withDataFile error:', e.message));
    return _lock;
}

// Reemplaza el array de histórico completo (appendDailyHistorySnapshot lo recalcula).
function setHistory(arr) {
    historyState = Array.isArray(arr) ? arr : [];
    historyDirty = true;
    schedulePersist();
}

function schedulePersist() {
    dirty = true;
    if (persistTimer) return;
    persistTimer = setTimeout(() => { flush().catch(() => {}); }, PERSIST_DEBOUNCE_MS);
}

async function flush() {
    if (persistTimer) { clearTimeout(persistTimer); persistTimer = null; }
    if (dirty && stateCol) {
        dirty = false;
        try {
            await stateCol.updateOne({ _id: STATE_ID }, { $set: { data: dataState, updatedAt: new Date() } }, { upsert: true });
        } catch (e) { console.error('state persist error:', e.message); dirty = true; }
    }
    if (historyDirty && historyCol) {
        historyDirty = false;
        try {
            await historyCol.updateOne({ _id: HISTORY_ID }, { $set: { data: historyState, updatedAt: new Date() } }, { upsert: true });
        } catch (e) { console.error('history persist error:', e.message); historyDirty = true; }
    }
}

module.exports = {
    init, ready,
    readState, readStateRaw, withDataFile,
    readHistory, readHistoryRaw, setHistory,
    flush,
};
