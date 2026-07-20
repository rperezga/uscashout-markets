// ============================================================
// mongo-selftest.js — verificación de la capa MongoDB (v2.8) contra un Mongo REAL.
//
// Uso (Hermes, en el Kali, contra una base de datos DE PRUEBA — NUNCA producción):
//   MONGO_DB=uscashout_selftest MONGODB_URI="mongodb://usuario:pass@127.0.0.1:27017/?authSource=admin" \
//     node mongo-selftest.js
//
// Ejercita: usuarios (ids enteros, unicidad), sesiones (válida/caducada/borrada),
// ajustes (upsert + getAll), estado de mercado (withDataFile→flush→persistido y lectura
// como copia) e histórico. AL TERMINAR BORRA la base de datos de prueba (dropDatabase).
// Sale con código 0 si todo PASA, 1 si algo FALLA. Se niega a correr contra "uscashout".
// ============================================================

const mongo = require('./lib/mongo');
const db = require('./lib/db');
const state = require('./lib/state');

(async () => {
    const name = process.env.MONGO_DB || 'uscashout_selftest';
    if (name === 'uscashout') {
        console.error('ABORT: no ejecutes el self-test contra la BD de producción (uscashout): borra la BD al terminar.');
        process.exit(2);
    }
    let ok = 0, fail = 0;
    const check = (label, cond) => { if (cond) { ok++; console.log('  PASS', label); } else { fail++; console.error('  FAIL', label); } };

    await mongo.connect();
    console.log('Conectado a Mongo, db:', mongo.getDbName());
    const raw = mongo.getDb();
    // Partir de limpio
    for (const c of ['users', 'sessions', 'settings', 'counters', 'dashboard_state', 'dashboard_history']) {
        try { await raw.collection(c).deleteMany({}); } catch (e) {}
    }
    await db.init();
    await state.init({ marketData: {}, seededAt: 'seed' }, []);

    // 1) Usuarios: primer usuario, lookup con secreto, ids enteros, unicidad.
    const u = await db.createUser('selftest', 'saltAAA', 'hashBBB', 'owner');
    check('createUser → id entero', typeof u.id === 'number' && u.id >= 1);
    const byName = await db.getUserByUsername('selftest');
    check('getUserByUsername trae salt+hash', !!byName && byName.pass_salt === 'saltAAA' && byName.pass_hash === 'hashBBB');
    check('countUsers === 1', (await db.countUsers()) === 1);
    let dup = false;
    try { await db.createUser('selftest', 'x', 'y', 'user'); } catch (e) { dup = (e.code === 'DUPLICATE'); }
    check('username único rechaza duplicado', dup);

    // 2) Sesiones: válida, caducada (→null), borrada.
    await db.createSession('tok_ok', u.id, Date.now() + 60000);
    const sess = await db.getSession('tok_ok');
    check('getSession válida → user_id', !!sess && sess.user_id === u.id);
    await db.createSession('tok_exp', u.id, Date.now() - 1000);
    check('getSession caducada → null', (await db.getSession('tok_exp')) === null);
    await db.deleteSession('tok_ok');
    check('deleteSession', (await db.getSession('tok_ok')) === null);

    // 3) Ajustes: upsert + getAll.
    await db.setSetting(u.id, 'myXrpAmount', '8500');
    await db.setSetting(u.id, 'myAmount_stellar', '2000');
    await db.setSetting(u.id, 'myXrpAmount', '9000'); // upsert sobre la misma clave
    const all = await db.getAllSettings(u.id);
    check('settings upsert + getAllSettings', all.myXrpAmount === '9000' && all.myAmount_stellar === '2000');

    // 4) Estado de mercado: withDataFile → flush → persiste; readState devuelve copia.
    await state.withDataFile((d) => { d.marketData = { price: 1.23 }; d.marker = 'XYZ'; });
    await state.flush();
    const sdoc = await raw.collection('dashboard_state').findOne({ _id: 'dashboard' });
    check('estado persiste a Mongo', !!sdoc && !!sdoc.data && sdoc.data.marker === 'XYZ' && sdoc.data.marketData.price === 1.23);
    const copy = state.readState(); copy.marker = 'MUTATED';
    check('readState devuelve copia (no toca el estado vivo)', state.readState().marker === 'XYZ');

    // 5) Histórico: setHistory → flush → persiste.
    state.setHistory([{ date: '2026-07-20', price: 1.23 }]);
    await state.flush();
    const hdoc = await raw.collection('dashboard_history').findOne({ _id: 'history' });
    check('history persiste a Mongo', !!hdoc && Array.isArray(hdoc.data) && hdoc.data.length === 1);

    // Limpieza: vacía las colecciones de prueba (solo requiere readWrite, no dbAdmin).
    for (const c of ['users', 'sessions', 'settings', 'counters', 'dashboard_state', 'dashboard_history']) {
        try { await raw.collection(c).deleteMany({}); } catch (e) {}
    }
    console.log('Colecciones de prueba vaciadas.');
    await mongo.close();

    console.log(`\nRESULTADO: ${ok} PASS, ${fail} FAIL`);
    process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('SELF-TEST ERROR:', e && e.stack ? e.stack : e); process.exit(1); });
