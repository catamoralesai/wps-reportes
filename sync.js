'use strict';
// Sincronización con la hoja de Google "Reportes WPS" (Apps Script).
// La app siempre guarda primero en el teléfono; cuando hay internet sube los
// reportes finalizados (con PDF y fotos) y trae la lista de clientes.
// Usa funciones de app.js (idb, getSettings, loadClients…) solo al ejecutarse.

const API_URL = (window.WPS_CONFIG && window.WPS_CONFIG.apiUrl) || '';
const ONLINE_MODE = !!API_URL;
const POOL_MIN = 2, POOL_SIZE = 5;
let SESION = null;
const syncState = { corriendo: false, error: '', ultimo: 0 };

// Google a veces responde con una página de error en vez del resultado
// (falla intermitente de Apps Script), así que se reintenta hasta 3 veces.
async function api(accion, payload = {}, codigo = SESION && SESION.codigo) {
  const body = JSON.stringify({ accion, codigo, solicitud: uid(), ...payload });
  for (let intento = 1; ; intento++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 90000);
    let out;
    try {
      const res = await fetch(API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' }, // evita la verificación CORS previa
        body,
        signal: ctrl.signal,
      });
      out = JSON.parse(await res.text());
    } catch (err) {
      if (intento >= 3) throw new Error(err.name === 'AbortError' ? 'El servidor tardó demasiado' : 'El servidor de Google no respondió bien');
      await new Promise((r) => setTimeout(r, 1500 * intento));
      continue;
    } finally {
      clearTimeout(timer);
    }
    if (!out.ok) throw new Error(out.error || 'Error del servidor');
    return out.data;
  }
}

// ---------- Sesión ----------
async function loadSesion() {
  SESION = (await idb.get('kv', 'sesion')) || null;
}

async function login(codigo) {
  const user = await api('login', {}, codigo.trim());
  SESION = { codigo: codigo.trim(), nombre: user.nombre, rol: user.rol };
  await idb.put('kv', SESION, 'sesion');
  const s = await getSettings();
  if (!s.operario) { s.operario = user.nombre; await saveSettings(s); }
}

async function logout() {
  await idb.del('kv', 'sesion');
  SESION = null;
}

const esOficina = () => !ONLINE_MODE || (SESION && ['admin', 'oficina'].includes(SESION.rol));

// ---------- Numeración ----------
// Solo los operarios reservan un bloque pequeño de números cuando tienen señal,
// para poder finalizar sin internet. Oficina y admin toman el número al finalizar.
// La "serie" de la hoja permite reiniciar el consecutivo: si cambia, se descartan
// los números que el teléfono tenía reservados.
const esOperario = () => SESION && SESION.rol === 'operario';
const leerReserva = (out) => (Array.isArray(out) ? { serie: '1', numeros: out } : { serie: String(out.serie), numeros: out.numeros });

async function checkSerie() {
  const serie = String(await api('serie'));
  const s = await getSettings();
  if (s.poolSerie !== serie) { s.pool = []; s.poolSerie = serie; await saveSettings(s); }
}

async function refillPool() {
  if (!ONLINE_MODE || !SESION || !navigator.onLine) return;
  const s = await getSettings();
  if (!esOperario()) {
    if ((s.pool || []).length) { s.pool = []; await saveSettings(s); }
    return;
  }
  const pool = s.pool || [];
  if (pool.length >= POOL_MIN) return;
  const { serie, numeros } = leerReserva(await api('reservarNumeros', { cantidad: POOL_SIZE - pool.length }));
  const s2 = await getSettings();
  const base = s2.poolSerie === serie ? s2.pool || [] : [];
  s2.pool = [...base, ...numeros].filter((n, i, a) => a.indexOf(n) === i).sort((a, b) => a - b);
  s2.poolSerie = serie;
  await saveSettings(s2);
}

async function takeNumber() {
  if (!ONLINE_MODE) {
    const s = await getSettings();
    const n = Number(s.siguienteNumero);
    s.siguienteNumero = n + 1;
    await saveSettings(s);
    return n;
  }
  if (!esOperario() || !(await getSettings()).pool?.length) {
    // Con señal se pide el número directamente a la hoja.
    if (navigator.onLine) {
      try { return leerReserva(await api('reservarNumeros', { cantidad: 1 })).numeros[0]; } catch (err) { console.warn(err); }
    }
  }
  const s = await getSettings();
  if (!(s.pool || []).length) return null;
  const n = s.pool.shift();
  await saveSettings(s);
  refillPool().catch(() => {});
  return n;
}

// ---------- Reportes ----------
const toBase64 = (blob) => new Promise((res, rej) => {
  const fr = new FileReader();
  fr.onload = () => res(String(fr.result).split(',')[1]);
  fr.onerror = rej;
  fr.readAsDataURL(blob);
});

// Copia liviana para la hoja: sin fotos ni firmas (esas van en el PDF y en Drive).
function reportForServer(r) {
  const c = JSON.parse(JSON.stringify(r));
  c.cierre.firmaRecibe = c.cierre.firmaRecibe ? 'firmado' : '';
  c.cierre.firmaTecnico = c.cierre.firmaTecnico ? 'firmado' : '';
  c.fotos = c.fotos.map((f) => ({ id: f.id, nota: f.nota, driveId: f.driveId || '' }));
  delete c.sync;
  return c;
}

async function pushReport(r) {
  const pdf = await toBase64(buildReportPdf(r, LOGO));
  const fotos = r.fotos
    .map((f, i) => ({ f, i }))
    .filter(({ f }) => !f.driveId)
    .map(({ f, i }) => ({ id: f.id, nota: f.nota, nombre: `foto-${r.numero}-${i + 1}.jpg`, data: f.data.split(',')[1] }));
  const out = await api('guardarReporte', { reporte: reportForServer(r), pdf, pdfNombre: pdfName(r), fotos });

  // Releer la copia local: el operario pudo editar mientras se subía.
  const cur = (await idb.get('reportes', r.id)) || r;
  cur.fotos.forEach((f) => { if (out.fotos[f.id]) f.driveId = out.fotos[f.id]; });
  cur.pdfUrl = out.pdf;
  cur.carpetaUrl = out.carpeta;
  cur.sync = cur.actualizado === r.actualizado ? 'ok' : 'pendiente';
  await idb.put('reportes', cur);
  if (R && R.id === cur.id) Object.assign(R, { fotos: cur.fotos, pdfUrl: cur.pdfUrl, carpetaUrl: cur.carpetaUrl, sync: cur.sync });
}

const pendingReports = async () => (await idb.all('reportes')).filter((r) => r.numero && r.sync !== 'ok');

// ---------- Clientes ----------
async function pushClients() {
  const pend = (await idb.all('clientes')).filter((c) => c.sync !== 'ok');
  for (const c of pend) {
    const { sync, ...data } = c;
    await api('guardarCliente', { cliente: data });
    const cur = await idb.get('clientes', c.key);
    if (cur && cur.actualizado === c.actualizado) { cur.sync = 'ok'; await idb.put('clientes', cur); }
  }
  const borrados = (await idb.get('kv', 'clientesBorrados')) || [];
  for (const id of borrados) await api('borrarCliente', { id });
  if (borrados.length) await idb.put('kv', [], 'clientesBorrados');
}

async function pullClients() {
  const server = await api('clientes');
  const local = await idb.all('clientes');
  const pendientes = new Set(local.filter((c) => c.sync !== 'ok').map((c) => c.key));
  const enServidor = new Set(server.map((c) => c.key));
  for (const c of server) if (!pendientes.has(c.key)) await idb.put('clientes', { ...c, sync: 'ok' });
  for (const c of local) if (c.sync === 'ok' && !enServidor.has(c.key)) await idb.del('clientes', c.key);
}

async function deleteClient(key) {
  await idb.del('clientes', key);
  if (!ONLINE_MODE) return;
  const borrados = (await idb.get('kv', 'clientesBorrados')) || [];
  borrados.push(key);
  await idb.put('kv', borrados, 'clientesBorrados');
  scheduleSync();
}

// ---------- Ciclo de sincronización ----------
async function syncAll({ avisar = false } = {}) {
  if (!ONLINE_MODE || !SESION || syncState.corriendo) return;
  if (!navigator.onLine) { if (avisar) toast('Sin internet: se sube cuando vuelva la señal'); return; }
  syncState.corriendo = true;
  updateSyncUi();
  try {
    await pushClients();
    for (const r of await pendingReports()) await pushReport(r);
    await pullClients();
    await loadClients();
    try { await checkSerie(); } catch (err) { console.warn(err); }
    await refillPool();
    syncState.error = '';
    syncState.ultimo = Date.now();
    if (avisar) toast('Todo sincronizado ✓');
  } catch (err) {
    console.error(err);
    syncState.error = err.message || 'Error de conexión';
    if (/Código de acceso/.test(syncState.error)) { await logout(); route(); }
    else if (avisar) toast(`No se pudo sincronizar: ${syncState.error}`, 4000);
  } finally {
    syncState.corriendo = false;
    updateSyncUi();
  }
}

let syncTimer = null;
function scheduleSync(ms = 4000) {
  if (!ONLINE_MODE) return;
  clearTimeout(syncTimer);
  syncTimer = setTimeout(() => syncAll(), ms);
}

async function syncChip() {
  if (!ONLINE_MODE) return '';
  const n = (await pendingReports()).length;
  let cls = 'ok', txt = 'Todo en la nube ✓';
  if (syncState.corriendo) { cls = 'run'; txt = 'Sincronizando…'; }
  else if (syncState.error) { cls = 'bad'; txt = `No se pudo sincronizar: ${syncState.error}. Toque para reintentar`; }
  else if (n) { cls = 'warn'; txt = `${n} reporte${n > 1 ? 's' : ''} por subir${navigator.onLine ? '' : ' (sin señal)'}`; }
  return `<button class="sync-chip ${cls}" data-act="sync">${esc(txt)}</button>`;
}

async function updateSyncUi() {
  const el = document.getElementById('syncSlot');
  if (el) el.innerHTML = await syncChip();
}

window.addEventListener('online', () => syncAll());
setInterval(() => syncAll(), 3 * 60 * 1000);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') syncAll(); });
