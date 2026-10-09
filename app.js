'use strict';
// Reportes de mantenimiento · Water Proof System SAS
// Todo se guarda primero en el teléfono (IndexedDB), así la app funciona sin internet;
// sync.js sube los datos a la hoja de Google cuando hay señal.

const APP_VERSION = '0.7.0';
const ESTADOS = ['OK', 'Revisar', 'Falla', 'N/A'];
const FRECUENCIAS = { Mensual: 1, Bimestral: 2, Trimestral: 3, Semestral: 6, Anual: 12 };
const TIPOS = ['Centrífuga', 'Sumergible', 'Multietapa', 'Periférica', 'Turbina vertical'];
const ACTIVIDADES = ['Mantenimiento preventivo', 'Mantenimiento correctivo', 'Instalación', 'Diagnóstico', 'Visita técnica'];
// Fotos: lado largo máximo y calidad JPEG (2000 px ≈ 4 MP, legible para placas de datos).
const FOTO_MAX = 2000, FOTO_CALIDAD = 0.8;
const DEFAULT_SETTINGS = { operario: '', siguienteNumero: 1445, firmaTecnico: '' };

const app = document.getElementById('app');
let R = null;          // reporte abierto
let CLIENTES = [];     // clientes guardados (para autocompletar)
let LOGO = '';         // logo en data URL para el PDF
let installPrompt = null;

// ---------- Base de datos local ----------
const idb = (() => {
  let dbp;
  const open = () => dbp || (dbp = new Promise((res, rej) => {
    const req = indexedDB.open('wps-reportes', 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      db.createObjectStore('reportes', { keyPath: 'id' });
      db.createObjectStore('clientes', { keyPath: 'key' });
      db.createObjectStore('kv');
    };
    req.onsuccess = () => {
      // Si otra pestaña necesita actualizar o borrar la base, soltarla en vez de bloquearla.
      req.result.onversionchange = () => { req.result.close(); dbp = null; };
      res(req.result);
    };
    req.onerror = () => rej(req.error);
  }));
  const run = async (store, mode, fn) => {
    const db = await open();
    return new Promise((res, rej) => {
      const t = db.transaction(store, mode);
      const req = fn(t.objectStore(store));
      t.oncomplete = () => res(req && req.result);
      t.onerror = () => rej(t.error);
    });
  };
  return {
    get: (s, k) => run(s, 'readonly', (st) => st.get(k)),
    all: (s) => run(s, 'readonly', (st) => st.getAll()),
    put: (s, v, k) => run(s, 'readwrite', (st) => (k === undefined ? st.put(v) : st.put(v, k))),
    del: (s, k) => run(s, 'readwrite', (st) => st.delete(k)),
  };
})();

const getSettings = async () => ({ ...DEFAULT_SETTINGS, ...((await idb.get('kv', 'settings')) || {}) });
const saveSettings = (s) => idb.put('kv', s, 'settings');

// ---------- Utilidades ----------
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const slug = (s) => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '');
const clientKey = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
const getPath = (o, p) => p.split('.').reduce((a, k) => (a == null ? a : a[k]), o);
const setPath = (o, p, v) => { const ks = p.split('.'); const last = ks.pop(); ks.reduce((a, k) => a[k], o)[last] = v; };

function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function fmtDate(iso) {
  if (!iso) return '';
  const [y, m, d] = iso.split('-');
  return `${d}/${m}/${y}`;
}
function addMonths(iso, n) {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(y, m - 1 + n, d);
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
}
function toast(msg, ms = 2600) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove('show'), ms);
}
function downloadBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}
const badge = (estado) => `<span class="badge ${estado}">${{ borrador: 'Borrador', finalizado: 'Finalizado', enviado: 'Enviado' }[estado] || estado}</span>`;

// ---------- Modelo del reporte ----------
const emptyPump = (sec) => ({ marca: '', modelo: '', tipo: '', voltaje: '', amperaje: '', tablero: '', [sec === 'potable' ? 'estado' : 'foso']: '' });
const emptyRci = () => ({ marca: '', modelo: '', tipo: '', voltaje: '', amperaje: '' });
const isBlank = (o) => Object.entries(o).every(([k, v]) => k.startsWith('_') || !v);

function newReport(s) {
  return {
    id: uid(), numero: null, estado: 'borrador', creado: Date.now(), actualizado: Date.now(),
    cliente: { nombre: '', nit: '', direccion: '', correo: '' },
    actividad: 'Mantenimiento preventivo', fecha: todayISO(),
    potable: { aplica: true, bombas: [emptyPump('potable')], presionArranque: '', presionParada: '', recomendaciones: '' },
    eyectoras: { aplica: true, bombas: [emptyPump('eyectoras')], recomendaciones: '' },
    rci: { aplica: true, principal: emptyRci(), jockey: emptyRci(), recomendaciones: '' },
    tanques: { hidro: { estado: '', obs: '' }, reserva: { estado: '', obs: '' } },
    fotos: [],
    cierre: { realiza: s.operario || '', frecuencia: '', recibe: '', cargo: '', firmaRecibe: '', firmaTecnico: s.firmaTecnico || '' },
  };
}

// ---------- Clientes ----------
// Un mismo NIT puede tener varias sedes (ej. bloques de un edificio), así que
// el cliente se identifica por `key` y el NIT solo sirve para buscar.
const nitBase = (nit) => String(nit || '').split('-')[0].replace(/\D/g, '');
const clientByName = (n) => CLIENTES.find((c) => clientKey(c.nombre) === clientKey(n));
function clientsByNit(nit) {
  const raw = String(nit || '').replace(/\D/g, '');
  const base = nitBase(nit);
  if (base.length < 6) return [];
  return CLIENTES.filter((c) => {
    const cb = nitBase(c.nit);
    return cb && (cb === base || cb === raw || String(c.nit).replace(/\D/g, '') === raw);
  });
}
const sortClients = (list) => list.sort((a, b) => a.nombre.localeCompare(b.nombre, 'es'));
const loadClients = async () => { CLIENTES = sortClients(await idb.all('clientes')); };

// Actualiza la ficha del cliente y guarda sus equipos para precargarlos en la próxima visita.
async function saveClient(r) {
  if (!r.cliente.nombre.trim()) return;
  await loadClients();
  const prev = CLIENTES.find((c) => c.key === r.cliente.id) || clientByName(r.cliente.nombre);
  const tpl = (b) => ({ marca: b.marca, modelo: b.modelo, tipo: b.tipo, _prev: { voltaje: b.voltaje, amperaje: b.amperaje } });
  const c = {
    ...(prev || { key: uid(), creado: Date.now() }),
    nombre: r.cliente.nombre.trim(), nit: r.cliente.nit.trim(), direccion: r.cliente.direccion.trim(), correo: r.cliente.correo.trim(),
    frecuencia: r.cierre.frecuencia || prev?.frecuencia || '',
    ultimaVisita: r.fecha, ultimoNumero: r.numero, actualizado: Date.now(), sync: 'pendiente',
    potable: r.potable.aplica ? r.potable.bombas.map(tpl) : null,
    eyectoras: r.eyectoras.aplica ? r.eyectoras.bombas.map(tpl) : null,
    rci: r.rci.aplica ? { principal: tpl(r.rci.principal), jockey: tpl(r.rci.jockey) } : null,
  };
  await idb.put('clientes', c);
  r.cliente.id = c.key;
  await loadClients();
}

// Llena los datos del cliente elegido. Devuelve true si también cargó los equipos de la última visita.
function applyClient(c) {
  Object.assign(R.cliente, { id: c.key, nombre: c.nombre, nit: c.nit || '', direccion: c.direccion || '', correo: c.correo || '' });
  if (!R.cierre.frecuencia) R.cierre.frecuencia = c.frecuencia || '';
  const untouched = [...R.potable.bombas, ...R.eyectoras.bombas, R.rci.principal, R.rci.jockey].every(isBlank);
  if (!c.ultimaVisita || !untouched) return false;
  const fromTpl = (empty, t) => ({ ...empty, marca: t.marca, modelo: t.modelo, tipo: t.tipo, _prev: t._prev });
  R.potable.aplica = !!c.potable;
  if (c.potable?.length) R.potable.bombas = c.potable.map((t) => fromTpl(emptyPump('potable'), t));
  R.eyectoras.aplica = !!c.eyectoras;
  if (c.eyectoras?.length) R.eyectoras.bombas = c.eyectoras.map((t) => fromTpl(emptyPump('eyectoras'), t));
  R.rci.aplica = !!c.rci;
  if (c.rci) {
    R.rci.principal = fromTpl(emptyRci(), c.rci.principal);
    R.rci.jockey = fromTpl(emptyRci(), c.rci.jockey);
  }
  return true;
}

// ---------- Guardado automático ----------
let saveTimer = null;
function scheduleSave() {
  const ind = document.getElementById('saveInd');
  if (ind) ind.textContent = 'Guardando…';
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNow, 400);
}
async function saveNow() {
  clearTimeout(saveTimer);
  saveTimer = null;
  if (!R) return;
  R.actualizado = Date.now();
  if (R.numero) R.sync = 'pendiente';
  await idb.put('reportes', R);
  const ind = document.getElementById('saveInd');
  if (ind) ind.textContent = 'Guardado ✓';
  if (R.numero) scheduleSync();
}
const flushSave = () => (saveTimer ? saveNow() : Promise.resolve());
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flushSave(); });

// ---------- Componentes del formulario ----------
const reqMark = (path) => (REQUERIDOS.some(([p]) => p === path) ? ' <b class="req">*</b>' : '');

function field(label, path, o = {}) {
  const v = getPath(R, path) ?? '';
  label += reqMark(path);
  const attrs = [
    `data-path="${path}"`,
    o.inputmode ? `inputmode="${o.inputmode}"` : '',
    o.list ? `list="${o.list}"` : '',
    o.placeholder ? `placeholder="${esc(o.placeholder)}"` : '',
  ].join(' ');
  const cls = `fld${o.full ? ' full' : ''}`;
  if (o.type === 'textarea') return `<label class="${cls}"><span>${label}</span><textarea ${attrs} rows="${o.rows || 3}">${esc(v)}</textarea></label>`;
  if (o.options) {
    const opts = ['', ...o.options].map((x) => `<option value="${esc(x)}" ${x === v ? 'selected' : ''}>${x ? esc(x) : 'Seleccionar…'}</option>`).join('');
    return `<label class="${cls}"><span>${label}</span><select ${attrs}>${opts}</select></label>`;
  }
  return `<label class="${cls}"><span>${label}</span><input type="${o.type || 'text'}" ${attrs} value="${esc(v)}" autocomplete="off"></label>`;
}

function seg(label, path) {
  const v = getPath(R, path) || '';
  const btns = ESTADOS.map((o) => `<button type="button" class="seg-btn s-${slug(o)} ${v === o ? 'on' : ''}" data-seg="${path}" data-val="${o}">${o}</button>`).join('');
  return `<div class="fld full"><span>${label}</span><div class="seg">${btns}</div></div>`;
}

function section(id, title, body, aplicaPath) {
  const on = aplicaPath ? getPath(R, aplicaPath) : true;
  const toggle = aplicaPath ? `<label class="switch"><input type="checkbox" data-path="${aplicaPath}" data-bool ${on ? 'checked' : ''}>Aplica</label>` : '';
  return `<section class="card" id="sec-${id}"><div class="card-h"><h2>${title}</h2>${toggle}</div><div class="card-b ${on ? '' : 'hidden'}">${body}</div></section>`;
}

function pumpCard(sec, i) {
  const base = `${sec}.bombas.${i}`;
  const prev = R[sec].bombas[i]._prev || {};
  const ant = (v) => (v ? `Anterior: ${v}` : '');
  return `<div class="pump">
    <div class="pump-h"><strong>Bomba #${i + 1}</strong>
      <div class="pump-act">
        <button type="button" class="link" data-act="dup" data-sec="${sec}" data-i="${i}">Copiar</button>
        <button type="button" class="link danger" data-act="delpump" data-sec="${sec}" data-i="${i}">Quitar</button>
      </div></div>
    <div class="grid2">
      ${field('Marca', base + '.marca')}
      ${field('Modelo', base + '.modelo')}
      ${field('Tipo', base + '.tipo', { list: 'dl-tipos', full: true })}
      ${field('Voltaje (V)', base + '.voltaje', { inputmode: 'decimal', placeholder: ant(prev.voltaje) })}
      ${field('Amperaje (A)', base + '.amperaje', { inputmode: 'decimal', placeholder: ant(prev.amperaje) })}
    </div>
    ${seg('Tablero', base + '.tablero')}
    ${seg(sec === 'potable' ? 'Estado' : 'Foso', base + (sec === 'potable' ? '.estado' : '.foso'))}
  </div>`;
}

const pumps = (sec) => R[sec].bombas.map((_, i) => pumpCard(sec, i)).join('') +
  `<button type="button" class="btn ghost block" data-act="addpump" data-sec="${sec}">+ Agregar bomba</button>`;

function rciBlock(key, label) {
  const base = `rci.${key}`;
  const prev = R.rci[key]._prev || {};
  const ant = (v) => (v ? `Anterior: ${v}` : '');
  return `<h3 class="sub-h">${label}</h3><div class="grid2">
    ${field('Marca', base + '.marca')}${field('Modelo', base + '.modelo')}
    ${field('Tipo', base + '.tipo', { list: 'dl-tipos', full: true })}
    ${field('Voltaje (V)', base + '.voltaje', { inputmode: 'decimal', placeholder: ant(prev.voltaje) })}
    ${field('Amperaje (A)', base + '.amperaje', { inputmode: 'decimal', placeholder: ant(prev.amperaje) })}
  </div>`;
}

function photosBlock() {
  const list = R.fotos.map((f, i) => `<div class="photo">
      ${f.data ? `<img src="${f.data}" alt="Foto ${i + 1}">`
        : `<a class="photo-drive" href="https://drive.google.com/file/d/${esc(f.driveId)}/view" target="_blank" rel="noopener">☁︎ Ver en Drive</a>`}
      <input data-path="fotos.${i}.nota" value="${esc(f.nota)}" placeholder="Descripción (opcional)">
      <button type="button" class="link danger" data-act="delphoto" data-i="${i}">Quitar</button>
    </div>`).join('');
  return `${list ? `<div class="photos">${list}</div>` : ''}
    <div class="btn-row">
      <button type="button" class="btn primary" data-act="camera">📷 Tomar foto</button>
      <label class="btn ghost file-btn">🖼️ Galería<input type="file" accept="image/*" multiple data-photo class="file-hidden"></label>
    </div>`;
}

// La firma se hace en una pantalla aparte: así hacer scroll sobre el formulario
// nunca cuenta como firma, y hay más espacio para firmar.
function sigBlock(label, path) {
  const v = getPath(R, path);
  return `<div class="fld full" data-field="${path}"><span>${label}${reqMark(path)}</span>
    ${v ? `<div class="sig-prev"><img src="${v}" alt="Firma"><button type="button" class="link" data-act="sign" data-path="${path}" data-label="${esc(label)}">Volver a firmar</button></div>`
      : `<button type="button" class="btn ghost block sig-btn" data-act="sign" data-path="${path}" data-label="${esc(label)}">✍️ Toque para firmar</button>`}</div>`;
}

const MIN_TRAZO = 60; // px de trazo para considerar que alguien firmó de verdad

function openSignature(titulo, onSave) {
  const box = document.createElement('div');
  box.className = 'sigpad';
  box.innerHTML = `<div class="sigpad-h"><strong>${esc(titulo)}</strong><span>Firme con el dedo dentro del recuadro</span></div>
    <div class="sigpad-area"><canvas></canvas><div class="sigpad-line"></div></div>
    <div class="sigpad-bar"><button class="btn ghost" data-s="cancel">Cancelar</button><button class="btn ghost" data-s="clear">Borrar</button><button class="btn primary" data-s="save">Guardar</button></div>`;
  document.body.appendChild(box);
  const canvas = box.querySelector('canvas');
  const ratio = Math.min(window.devicePixelRatio || 1, 2);
  const rect = canvas.getBoundingClientRect();
  canvas.width = rect.width * ratio;
  canvas.height = rect.height * ratio;
  const ctx = canvas.getContext('2d');
  ctx.scale(ratio, ratio);
  Object.assign(ctx, { lineWidth: 2.6, lineCap: 'round', lineJoin: 'round', strokeStyle: '#0b1f44' });
  let drawing = false, last = null, largo = 0;
  let caja = null; // rectángulo que ocupa lo firmado, para recortar la imagen
  const ampliar = (p) => { caja = caja ? { x0: Math.min(caja.x0, p.x), y0: Math.min(caja.y0, p.y), x1: Math.max(caja.x1, p.x), y1: Math.max(caja.y1, p.y) } : { x0: p.x, y0: p.y, x1: p.x, y1: p.y }; };
  const pos = (e) => { const b = canvas.getBoundingClientRect(); return { x: e.clientX - b.left, y: e.clientY - b.top }; };
  canvas.addEventListener('pointerdown', (e) => { drawing = true; last = pos(e); ampliar(last); canvas.setPointerCapture(e.pointerId); });
  canvas.addEventListener('pointermove', (e) => {
    if (!drawing) return;
    const p = pos(e);
    ctx.beginPath(); ctx.moveTo(last.x, last.y); ctx.lineTo(p.x, p.y); ctx.stroke();
    largo += Math.hypot(p.x - last.x, p.y - last.y);
    ampliar(p);
    last = p;
  });
  const end = () => { drawing = false; };
  canvas.addEventListener('pointerup', end);
  canvas.addEventListener('pointercancel', end);
  box.addEventListener('click', (e) => {
    const a = e.target.closest('[data-s]')?.dataset.s;
    if (a === 'cancel') box.remove();
    if (a === 'clear') { ctx.clearRect(0, 0, rect.width, rect.height); largo = 0; caja = null; }
    if (a === 'save') {
      if (largo < MIN_TRAZO) { toast('La firma está vacía o es muy corta. Firme dentro del recuadro.'); return; }
      // Recortar a lo firmado (con margen) para que la firma se vea grande en el PDF.
      const m = 12;
      const x0 = Math.max(0, caja.x0 - m), y0 = Math.max(0, caja.y0 - m);
      const w = Math.min(rect.width, caja.x1 + m) - x0, h = Math.min(rect.height, caja.y1 + m) - y0;
      const out = Object.assign(document.createElement('canvas'), { width: Math.round(w * ratio), height: Math.round(h * ratio) });
      out.getContext('2d').drawImage(canvas, x0 * ratio, y0 * ratio, w * ratio, h * ratio, 0, 0, out.width, out.height);
      onSave(out.toDataURL('image/png'));
      box.remove();
    }
  });
}

// ---------- Vista: formulario ----------
function renderForm(keepScroll) {
  const sy = window.scrollY;
  const r = R;
  app.innerHTML = `
  <header class="topbar">
    <button class="icon-btn" data-nav="#" aria-label="Volver">←</button>
    <div class="tb-title">${r.numero ? `Reporte Nº ${r.numero}` : 'Nuevo reporte'}<small>${badge(r.estado)}</small></div>
    <span class="save-ind" id="saveInd">Guardado ✓</span>
  </header>
  <form class="form" onsubmit="return false">
    ${r.numero ? '' : `<div class="note">El número del reporte se asigna al finalizar. ${ONLINE_MODE ? 'Se guarda en el teléfono aunque no haya señal y se sube a la nube al finalizar.' : 'Todo se guarda solo en el teléfono, aunque no haya señal.'}</div>`}
    ${section('general', 'Datos generales', `<div class="grid2">
      ${field('NIT', 'cliente.nit', { list: 'dl-nits', placeholder: 'Escriba el NIT' })}
      ${field('Fecha', 'fecha', { type: 'date' })}
      ${field('Cliente', 'cliente.nombre', { list: 'dl-clientes', full: true, placeholder: 'O busque por nombre' })}
      ${field('Dirección', 'cliente.direccion', { full: true })}
      ${field('Correo del cliente', 'cliente.correo', { type: 'email', inputmode: 'email', full: true })}
      ${field('Actividad realizada', 'actividad', { list: 'dl-actividades', full: true })}
    </div>`)}
    ${section('potable', 'Electrobombas agua potable', pumps('potable') + `<div class="grid2" style="margin-top:12px">
      ${field('Presión arranque (PSI)', 'potable.presionArranque', { inputmode: 'decimal' })}
      ${field('Presión parada (PSI)', 'potable.presionParada', { inputmode: 'decimal' })}
    </div>` + field('Recomendaciones', 'potable.recomendaciones', { type: 'textarea' }), 'potable.aplica')}
    ${section('eyectoras', 'Bombas eyectoras', pumps('eyectoras') + field('Recomendaciones', 'eyectoras.recomendaciones', { type: 'textarea' }), 'eyectoras.aplica')}
    ${section('rci', 'Sistema RCI', rciBlock('principal', 'Bomba principal') + rciBlock('jockey', 'Jockey') + field('Recomendaciones', 'rci.recomendaciones', { type: 'textarea' }), 'rci.aplica')}
    ${section('tanques', 'Tanques', seg('Tanque hidroneumático', 'tanques.hidro.estado') + field('Observación', 'tanques.hidro.obs') +
      seg('Tanque reserva', 'tanques.reserva.estado') + field('Observación', 'tanques.reserva.obs'))}
    ${section('fotos', 'Fotos', photosBlock())}
    ${section('cierre', 'Cierre y firmas', `<div class="grid2">
      ${field('Quien realiza la inspección', 'cierre.realiza', { full: true })}
      ${field('Frecuencia de mantenimiento', 'cierre.frecuencia', { options: Object.keys(FRECUENCIAS), full: true })}
      ${field('Quien recibe la inspección', 'cierre.recibe', { full: true })}
      ${field('Cargo de quien recibe', 'cierre.cargo', { full: true, placeholder: 'Ej: Administrador' })}
    </div>` + sigBlock('Firma de quien realiza', 'cierre.firmaTecnico') + sigBlock('Firma de quien recibe', 'cierre.firmaRecibe'))}
    ${r.estado === 'borrador' ? '<button type="button" class="btn danger block" data-act="delreport">Eliminar borrador</button>' : ''}
  </form>
  <div class="bottombar"><div class="bottombar-inner">
    ${r.numero
      ? `<button class="btn" data-act="download">Ver PDF</button><button class="btn primary" data-act="finalize">Enviar al cliente</button>`
      : `<button class="btn primary" data-act="finalize">Finalizar y generar PDF</button>`}
  </div></div>
  <datalist id="dl-tipos">${TIPOS.map((t) => `<option value="${t}">`).join('')}</datalist>
  <datalist id="dl-actividades">${ACTIVIDADES.map((t) => `<option value="${t}">`).join('')}</datalist>
  <datalist id="dl-clientes">${CLIENTES.map((c) => `<option value="${esc(c.nombre)}">${esc(c.nit || '')}</option>`).join('')}</datalist>
  <datalist id="dl-nits">${CLIENTES.filter((c) => c.nit).map((c) => `<option value="${esc(c.nit)}">${esc(c.nombre)}</option>`).join('')}</datalist>`;

  window.scrollTo(0, keepScroll ? sy : 0);
}

function markOk(path) {
  const el = app.querySelector(`[data-field="${path}"]`) || app.querySelector(`[data-path="${path}"]`)?.closest('.fld');
  el?.classList.remove('err');
}

const REQUERIDOS = [['cliente.nombre', 'Cliente'], ['fecha', 'Fecha'], ['cierre.realiza', 'Quien realiza'], ['cierre.recibe', 'Quien recibe'], ['cierre.firmaTecnico', 'Firma de quien realiza'], ['cierre.firmaRecibe', 'Firma de quien recibe']];
const faltantes = (r) => REQUERIDOS.filter(([p]) => !String(getPath(r, p) || '').trim());

function validate() {
  const missing = faltantes(R);
  app.querySelectorAll('.fld.err').forEach((e) => e.classList.remove('err'));
  missing.forEach(([p]) => {
    const el = app.querySelector(`[data-field="${p}"]`) || app.querySelector(`[data-path="${p}"]`)?.closest('.fld');
    el?.classList.add('err');
  });
  return missing;
}

const pdfName = (r) => `Reporte_${r.numero}_${(r.cliente.nombre || 'cliente').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^\w]+/g, '_')}.pdf`;

async function finalize(confirmado) {
  const missing = validate();
  if (missing.length) {
    toast(`Falta: ${missing.map((m) => m[1]).join(', ')}`, 4000);
    app.querySelector('.fld.err')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    return;
  }
  if (!R.numero && !confirmado) return confirmFinalize();
  if (!R.numero) {
    const n = await takeNumber();
    if (!n) {
      toast('No hay números de reporte disponibles en este teléfono. Conéctese a internet un momento e intente de nuevo.', 5000);
      return;
    }
    R.numero = n;
    R.estado = 'finalizado';
  }
  await saveClient(R);
  await saveNow();
  renderForm(true);
  openSendSheet();
}

// Finalizar asigna el número del reporte: se confirma para que no pase por error.
function confirmFinalize() {
  const n = R.potable.bombas.length * (R.potable.aplica ? 1 : 0) + R.eyectoras.bombas.length * (R.eyectoras.aplica ? 1 : 0);
  const bg = document.createElement('div');
  bg.className = 'sheet-bg';
  bg.innerHTML = `<div class="sheet">
    <h3>¿Finalizar el reporte?</h3>
    <p>${esc(R.cliente.nombre)} · ${fmtDate(R.fecha)}<br>${n} bomba${n === 1 ? '' : 's'} · ${R.fotos.length} foto${R.fotos.length === 1 ? '' : 's'} · recibe ${esc(R.cierre.recibe)}</p>
    <p>Se le asigna el número y deja de ser borrador. Después podrá corregirlo y volver a enviarlo.</p>
    <button class="btn primary" data-f="ok">Sí, finalizar</button>
    <button class="btn ghost" data-f="no">Seguir editando</button>
  </div>`;
  bg.addEventListener('click', (e) => {
    const a = e.target.closest('[data-f]')?.dataset.f;
    if (e.target === bg || a === 'no') bg.remove();
    if (a === 'ok') { bg.remove(); finalize(true); }
  });
  document.body.appendChild(bg);
}

function openSendSheet() {
  const correo = R.cliente.correo;
  const bg = document.createElement('div');
  bg.className = 'sheet-bg';
  bg.innerHTML = `<div class="sheet">
    <h3>Reporte Nº ${R.numero} listo</h3>
    <p>Envíalo al cliente por correo o WhatsApp. Se abrirá el menú de compartir del teléfono con el PDF adjunto.</p>
    ${correo ? `<div class="copy-row"><code>${esc(correo)}</code><button class="btn ghost" data-sheet="copy">Copiar</button></div>
      <p style="font-size:13px">El correo del cliente se copia solo. En Gmail, pégalo en “Para”.</p>` : '<p class="note warn">Este reporte no tiene correo del cliente.</p>'}
    <button class="btn primary" data-sheet="share">Enviar PDF</button>
    <button class="btn" data-sheet="download">Descargar PDF</button>
    <button class="btn ghost" data-sheet="close">Cerrar</button>
  </div>`;
  bg.addEventListener('click', async (e) => {
    const a = e.target.closest('[data-sheet]')?.dataset.sheet;
    if (e.target === bg || a === 'close') bg.remove();
    if (a === 'copy') { navigator.clipboard?.writeText(correo); toast('Correo copiado'); }
    if (a === 'download') downloadPdf();
    if (a === 'share') { await sharePdf(); bg.remove(); }
  });
  document.body.appendChild(bg);
}

const makePdf = () => buildReportPdf(R, LOGO);

// Reporte archivado: sus fotos ya solo están en Drive, así que se usa el PDF guardado allá.
function abrirPdfArchivado() {
  if (!fotosArchivadas(R)) return false;
  if (R.pdfUrl) { window.open(R.pdfUrl, '_blank'); toast('Reporte archivado: se abre el PDF guardado en Drive'); }
  else toast('Las fotos de este reporte ya solo están en Drive');
  return true;
}

function downloadPdf() {
  if (abrirPdfArchivado()) return;
  try { downloadBlob(makePdf(), pdfName(R)); }
  catch (err) { console.error(err); toast('No se pudo generar el PDF'); }
}

async function sharePdf() {
  if (abrirPdfArchivado()) return;
  let blob;
  try { blob = makePdf(); } catch (err) { console.error(err); toast('No se pudo generar el PDF'); return; }
  const file = new File([blob], pdfName(R), { type: 'application/pdf' });
  if (R.cliente.correo) navigator.clipboard?.writeText(R.cliente.correo).catch(() => {});
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({
        files: [file],
        title: `Reporte de mantenimiento Nº ${R.numero}`,
        text: `Buen día. Adjuntamos el reporte de mantenimiento Nº ${R.numero} de ${R.cliente.nombre}, realizado el ${fmtDate(R.fecha)}.\n\nWater Proof System SAS`,
      });
      R.estado = 'enviado';
      R.enviado = Date.now();
      await saveNow();
      renderForm(true);
      toast('Reporte enviado ✓');
    } catch (err) {
      if (err.name !== 'AbortError') { console.error(err); toast('No se pudo compartir; se descargará el PDF'); downloadBlob(blob, file.name); }
    }
  } else {
    downloadBlob(blob, file.name);
    toast('Este navegador no permite compartir; se descargó el PDF');
  }
}

// Cámara propia de la app: el atajo del navegador a veces abre los archivos en vez de la cámara.
async function openCamera() {
  if (!navigator.mediaDevices?.getUserMedia) { toast('Este navegador no da acceso a la cámara. Use “Galería”.', 4000); return; }
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1440 } } });
  } catch (err) {
    console.warn(err);
    toast(err.name === 'NotAllowedError' ? 'Sin permiso para la cámara. Actívelo en los ajustes de Chrome o use “Galería”.' : 'No se pudo abrir la cámara. Use “Galería”.', 5000);
    return;
  }
  let tomadas = 0;
  const box = document.createElement('div');
  box.className = 'cam';
  box.innerHTML = `<video autoplay playsinline muted></video><div class="cam-flash"></div>
    <div class="cam-bar"><button class="btn ghost" data-cam="close">Listo</button>
    <button class="cam-shot" data-cam="shot" aria-label="Tomar foto"></button><span class="cam-count"></span></div>`;
  const video = box.querySelector('video');
  video.srcObject = stream;
  const close = async () => {
    stream.getTracks().forEach((t) => t.stop());
    box.remove();
    if (tomadas) { await saveNow(); renderForm(true); toast(`${tomadas} foto${tomadas > 1 ? 's' : ''} agregada${tomadas > 1 ? 's' : ''}`); }
  };
  box.addEventListener('click', (e) => {
    const a = e.target.closest('[data-cam]')?.dataset.cam;
    if (a === 'close') close();
    if (a === 'shot' && video.videoWidth) {
      const s = Math.min(1, FOTO_MAX / Math.max(video.videoWidth, video.videoHeight));
      const w = Math.round(video.videoWidth * s), h = Math.round(video.videoHeight * s);
      const c = Object.assign(document.createElement('canvas'), { width: w, height: h });
      c.getContext('2d').drawImage(video, 0, 0, w, h);
      R.fotos.push({ id: uid(), nota: '', data: c.toDataURL('image/jpeg', FOTO_CALIDAD), w, h });
      tomadas++;
      box.querySelector('.cam-count').textContent = `${tomadas} foto${tomadas > 1 ? 's' : ''}`;
      const f = box.querySelector('.cam-flash');
      f.classList.remove('on'); void f.offsetWidth; f.classList.add('on');
      scheduleSave();
    }
  });
  document.body.appendChild(box);
}

async function addPhotos(files) {
  toast('Procesando fotos…');
  for (const f of files) {
    try { R.fotos.push({ id: uid(), nota: '', ...(await compressImage(f)) }); }
    catch (err) { console.error(err); toast('Una foto no se pudo leer'); }
  }
  await saveNow();
  renderForm(true);
}

function compressImage(file, max = FOTO_MAX, q = FOTO_CALIDAD) {
  return new Promise((res, rej) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const s = Math.min(1, max / Math.max(img.width, img.height));
      const w = Math.round(img.width * s), h = Math.round(img.height * s);
      const c = Object.assign(document.createElement('canvas'), { width: w, height: h });
      c.getContext('2d').drawImage(img, 0, 0, w, h);
      URL.revokeObjectURL(url);
      res({ data: c.toDataURL('image/jpeg', q), w, h });
    };
    img.onerror = rej;
    img.src = url;
  });
}

// ---------- Vista: inicio ----------
async function renderHome() {
  const [reps, clientes] = await Promise.all([idb.all('reportes'), idb.all('clientes')]);
  reps.sort((a, b) => b.actualizado - a.actualizado);
  const hoy = todayISO();
  const proximos = clientes
    .filter((c) => c.frecuencia && c.ultimaVisita)
    .map((c) => ({ ...c, proxima: addMonths(c.ultimaVisita, FRECUENCIAS[c.frecuencia]) }))
    .filter((c) => c.proxima <= addMonths(hoy, 1))
    .sort((a, b) => a.proxima.localeCompare(b.proxima));

  app.innerHTML = `
  <header class="topbar">
    <img src="icons/logo.png" class="tb-logo" alt="">
    <div class="tb-title">Reportes de mantenimiento<small>Water Proof System SAS</small></div>
    <button class="icon-btn" data-nav="#/ajustes" aria-label="Ajustes">⚙︎</button>
  </header>
  <main>
    <div id="syncSlot">${await syncChip()}</div>
    <button class="btn primary big" data-act="new">+ Nuevo reporte</button>
    <button class="btn block" data-nav="#/clientes" style="margin-bottom:14px">Clientes (${clientes.length})</button>
    ${installPrompt ? '<button class="btn block" data-act="install" style="margin-bottom:14px">Instalar app en el teléfono</button>' : ''}
    ${proximos.length ? `<section class="card"><div class="card-h"><h2>Próximos mantenimientos</h2></div><ul class="list">
      ${proximos.map((c) => `<li><div class="row"><div><strong>${esc(c.nombre)}</strong><small>${c.frecuencia} · última visita ${fmtDate(c.ultimaVisita)}</small></div>
        <span class="badge ${c.proxima < hoy ? 'vencido' : 'pronto'}">${c.proxima < hoy ? 'Vencido' : fmtDate(c.proxima)}</span></div></li>`).join('')}
    </ul></section>` : ''}
    <section class="card"><div class="card-h"><h2>${ONLINE_MODE ? 'Reportes en este teléfono' : 'Reportes'}</h2></div>
      ${reps.length ? `<ul class="list">${reps.map((r) => `<li><button class="row" data-nav="#/r/${r.id}">
        <div><strong>${r.numero ? `Nº ${r.numero}` : 'Sin número'} · ${esc(r.cliente.nombre || 'Sin cliente')}</strong>
        <small>${fmtDate(r.fecha)} · ${esc(r.actividad)}${r.estado === 'borrador' && faltantes(r).length ? `<br><span class="falta">Falta: ${faltantes(r).map((f) => f[1].toLowerCase()).join(', ')}</span>` : ''}${ONLINE_MODE && r.numero ? (r.sync === 'ok' ? ' · ☁︎ en la nube' : ' · ⏳ por subir') : ''}</small></div>${badge(r.estado)}</button></li>`).join('')}</ul>`
        : '<p class="empty">Aún no hay reportes. Toca “Nuevo reporte” para empezar.</p>'}
    </section>
    ${ONLINE_MODE && esOficina() ? '<section class="card"><div class="card-h"><h2>Todos los reportes (en línea)</h2></div><div id="remotos"><p class="empty">Cargando…</p></div></section>' : ''}
  </main>`;
  if (ONLINE_MODE && esOficina()) loadRemoteReports();
}

// Lista para la oficina: todos los reportes subidos por cualquier persona.
async function loadRemoteReports() {
  const box = document.getElementById('remotos');
  try {
    const list = await api('reportes');
    if (!document.body.contains(box)) return;
    box.innerHTML = list.length ? `<ul class="list">${list.map((r) => `<li><div class="row">
      <div><strong>Nº ${r.numero} · ${esc(r.cliente)}</strong><small>${fmtDate(r.fecha)} · ${esc(r.realiza)}</small></div>
      ${r.pdf ? `<a class="btn ghost" style="min-height:38px;padding:0 12px" href="${esc(r.pdf)}" target="_blank" rel="noopener">PDF</a>` : ''}</div></li>`).join('')}</ul>`
      : '<p class="empty">Aún no hay reportes en la nube.</p>';
  } catch (err) {
    if (document.body.contains(box)) box.innerHTML = `<p class="empty">${navigator.onLine ? 'No se pudo cargar: ' + esc(err.message) : 'Sin internet. Se mostrarán cuando haya señal.'}</p>`;
  }
}

// ---------- Vista: inicio de sesión ----------
function renderLogin(msg = '') {
  app.innerHTML = `
  <main class="login">
    <img src="icons/logo.png" alt="Water Proof System SAS">
    <h1>Reportes de mantenimiento</h1>
    <p>Water Proof System SAS</p>
    <form id="loginForm" class="card"><div class="card-b">
      <label class="fld"><span>Código de acceso</span><input id="codigo" autocomplete="off" autocapitalize="off" placeholder="wps-xxxxxxxx"></label>
      ${msg ? `<p class="login-err">${esc(msg)}</p>` : ''}
      <button class="btn primary block" style="margin-top:12px">Entrar</button>
    </div></form>
    <p class="login-help">Si no tiene código, pídaselo a la oficina.</p>
  </main>`;
  document.getElementById('loginForm').onsubmit = async (e) => {
    e.preventDefault();
    const code = document.getElementById('codigo').value;
    if (!code.trim()) return;
    if (!navigator.onLine) return renderLogin('Necesita internet para entrar la primera vez.');
    const btn = e.target.querySelector('button');
    btn.disabled = true; btn.textContent = 'Verificando…';
    try {
      await login(code);
      location.hash = '#';
      await route();
      toast(`Hola, ${SESION.nombre.split(' ')[0]}`);
      syncAll();
    } catch (err) {
      renderLogin(err.message);
    }
  };
}

// ---------- Vista: clientes ----------
async function renderClients() {
  await loadClients();
  app.innerHTML = `
  <header class="topbar">
    <button class="icon-btn" data-nav="#" aria-label="Volver">←</button>
    <div class="tb-title">Clientes<small>${CLIENTES.length} registrados</small></div>
    <button class="icon-btn" data-nav="#/clientes/nuevo" aria-label="Nuevo cliente">+</button>
  </header>
  <main>
    <label class="fld" style="margin-bottom:14px"><input type="search" id="qClientes" placeholder="Buscar por nombre, NIT o dirección" autocomplete="off"></label>
    <section class="card">
      ${CLIENTES.length ? `<ul class="list" id="listaClientes">${CLIENTES.map((c) => `<li data-q="${esc(clientKey([c.nombre, c.nit, nitBase(c.nit), c.direccion].join(' ')))}">
        <button class="row" data-nav="#/clientes/${encodeURIComponent(c.key)}"><div><strong>${esc(c.nombre)}</strong>
        <small>NIT ${esc(c.nit || '—')} · ${esc(c.direccion || 'Sin dirección')}</small></div>
        ${c.ultimaVisita ? `<small>${fmtDate(c.ultimaVisita)}</small>` : ''}</button></li>`).join('')}</ul>`
        : '<p class="empty">Aún no hay clientes. Toca + para agregar uno.</p>'}
    </section>
  </main>`;
  const q = document.getElementById('qClientes');
  q.addEventListener('input', () => {
    const t = clientKey(q.value);
    app.querySelectorAll('#listaClientes li').forEach((li) => li.classList.toggle('hidden', !!t && !li.dataset.q.includes(t)));
  });
}

async function renderClientEdit(key) {
  await loadClients();
  const nuevo = key === 'nuevo';
  const c = nuevo ? { key: uid(), nombre: '', nit: '', direccion: '', correo: '', frecuencia: '', creado: Date.now() } : CLIENTES.find((x) => x.key === key);
  if (!c) { location.hash = '#/clientes'; return; }
  const equipos = [c.potable && `${c.potable.length} bombas de agua potable`, c.eyectoras && `${c.eyectoras.length} eyectoras`, c.rci && 'sistema RCI'].filter(Boolean);
  const inp = (label, k, o = {}) => `<label class="fld${o.full ? ' full' : ''}"><span>${label}</span><input data-c="${k}" value="${esc(c[k] || '')}" ${o.attrs || ''} autocomplete="off"></label>`;
  app.innerHTML = `
  <header class="topbar">
    <button class="icon-btn" data-nav="#/clientes" aria-label="Volver">←</button>
    <div class="tb-title">${nuevo ? 'Nuevo cliente' : esc(c.nombre)}<small>${c.ultimaVisita ? `Última visita ${fmtDate(c.ultimaVisita)} · Nº ${c.ultimoNumero}` : 'Sin visitas registradas'}</small></div>
  </header>
  <main>
    <section class="card"><div class="card-b"><div class="grid2">
      ${inp('Nombre o razón social', 'nombre', { full: true })}
      ${inp('NIT', 'nit', { attrs: 'placeholder="900.000.000-0"' })}
      <label class="fld"><span>Frecuencia</span><select data-c="frecuencia">${['', ...Object.keys(FRECUENCIAS)].map((f) => `<option value="${f}" ${f === c.frecuencia ? 'selected' : ''}>${f || 'Sin definir'}</option>`).join('')}</select></label>
      ${inp('Dirección', 'direccion', { full: true })}
      ${inp('Correo para enviar reportes', 'correo', { full: true, attrs: 'type="email" inputmode="email"' })}
    </div>
    ${equipos.length ? `<p class="note" style="margin:14px 0 0">Equipos de la última visita: ${equipos.join(', ')}. Se precargan en el próximo reporte.</p>` : ''}
    </div></section>
    <div class="btn-row">
      <button class="btn primary" id="guardarCliente">Guardar</button>
      ${nuevo || !esOficina() ? '' : '<button class="btn danger" id="borrarCliente">Eliminar</button>'}
    </div>
  </main>`;
  document.getElementById('guardarCliente').onclick = async () => {
    app.querySelectorAll('[data-c]').forEach((el) => { c[el.dataset.c] = el.value.trim(); });
    if (!c.nombre) { toast('Falta el nombre del cliente'); return; }
    const dup = CLIENTES.find((x) => x.key !== c.key && clientKey(x.nombre) === clientKey(c.nombre));
    if (dup) { toast(`Ya existe un cliente llamado ${dup.nombre}`); return; }
    const mismoNit = c.nit && CLIENTES.filter((x) => x.key !== c.key && nitBase(x.nit) === nitBase(c.nit));
    c.actualizado = Date.now();
    c.sync = 'pendiente';
    await idb.put('clientes', c);
    scheduleSync(500);
    toast(mismoNit?.length ? `Guardado. Este NIT también es de: ${mismoNit.map((x) => x.nombre).join(', ')}` : 'Cliente guardado ✓', 3500);
    location.hash = '#/clientes';
  };
  const del = document.getElementById('borrarCliente');
  if (del) del.onclick = async () => {
    if (!confirm(`¿Eliminar a ${c.nombre}? Sus reportes no se borran.`)) return;
    await deleteClient(c.key);
    location.hash = '#/clientes';
  };
}

// ---------- Vista: ajustes ----------
async function renderSettings() {
  const s = await getSettings();
  const pool = s.pool || [];
  app.innerHTML = `
  <header class="topbar">
    <button class="icon-btn" data-nav="#" aria-label="Volver">←</button>
    <div class="tb-title">Ajustes<small>Versión ${APP_VERSION}</small></div>
  </header>
  <main>
    ${ONLINE_MODE ? `<section class="card"><div class="card-h"><h2>Cuenta</h2></div><div class="card-b">
      <p style="margin:0 0 6px"><strong>${esc(SESION.nombre)}</strong> · ${esc(SESION.rol)}</p>
      <p style="margin:0 0 12px;color:var(--muted);font-size:14px">${SESION.rol === 'operario'
        ? `Números reservados en este teléfono para trabajar sin señal: ${pool.length ? `${pool[0]}–${pool[pool.length - 1]} (${pool.length})` : 'ninguno (se reservan al tener señal)'}`
        : 'El número del reporte se asigna al finalizar (necesita señal).'}</p>
      <div id="syncSlot">${await syncChip()}</div>
      <button class="btn ghost block" data-act="logout">Cerrar sesión</button>
    </div></section>` : ''}
    <section class="card"><div class="card-h"><h2>Operario</h2></div><div class="card-b">
      <div class="grid2">
        <label class="fld full"><span>Nombre del operario</span><input data-set="operario" value="${esc(s.operario)}"></label>
        ${ONLINE_MODE ? '' : `<label class="fld full"><span>Siguiente número de reporte</span><input data-set="siguienteNumero" inputmode="numeric" value="${esc(s.siguienteNumero)}"></label>`}
      </div>
      <div class="fld full" style="margin-top:10px"><span>Firma del operario (se usa en todos los reportes)</span>
        ${s.firmaTecnico ? `<div class="sig-prev"><img src="${s.firmaTecnico}" alt="Firma"><button type="button" class="link" id="firmarTec">Volver a firmar</button></div>`
          : '<button type="button" class="btn ghost block sig-btn" id="firmarTec">✍️ Toque para firmar</button>'}</div>
    </div></section>
    <section class="card"><div class="card-h"><h2>Respaldo</h2></div><div class="card-b">
      <p class="note ${ONLINE_MODE ? '' : 'warn'}">${ONLINE_MODE ? 'Los reportes finalizados y los clientes se guardan en la hoja de Google. El respaldo es opcional.' : 'Los reportes viven solo en este teléfono. Haz un respaldo cada semana y envíatelo por correo o WhatsApp.'}</p>
      <div class="btn-row">
        <button class="btn primary" data-act="backup">Exportar respaldo</button>
        <label class="btn ghost file-btn">Cargar archivo<input type="file" accept="application/json,.json" data-restore class="file-hidden"></label>
      </div>
    </div></section>
  </main>`;
  document.getElementById('firmarTec').onclick = () => openSignature('Firma del operario', async (v) => {
    s.firmaTecnico = v; await saveSettings(s); toast('Firma guardada'); renderSettings();
  });
  app.querySelectorAll('[data-set]').forEach((el) => el.addEventListener('input', async () => {
    const k = el.dataset.set;
    s[k] = k === 'siguienteNumero' ? Number(el.value.replace(/\D/g, '')) || DEFAULT_SETTINGS.siguienteNumero : el.value;
    await saveSettings(s);
  }));
}

async function exportBackup() {
  const data = { app: 'wps-reportes', version: APP_VERSION, exportado: new Date().toISOString(),
    settings: await getSettings(), reportes: await idb.all('reportes'), clientes: await idb.all('clientes') };
  const name = `respaldo-reportes-${todayISO()}.json`;
  const file = new File([JSON.stringify(data)], name, { type: 'application/json' });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file], title: 'Respaldo reportes WPS' }); return; }
    catch (err) { if (err.name === 'AbortError') return; }
  }
  downloadBlob(file, name);
}

async function restoreBackup(file) {
  try {
    const data = JSON.parse(await file.text());
    if (data.app !== 'wps-reportes') throw new Error('archivo no válido');
    const reportes = data.reportes || [], clientes = data.clientes || [];
    if (!confirm(`¿Cargar ${reportes.length} reportes y ${clientes.length} clientes? Los que ya existan se reemplazan.`)) return;
    for (const r of reportes) await idb.put('reportes', r);
    for (const c of clientes) await idb.put('clientes', c);
    if (data.settings) {
      const s = await getSettings();
      s.siguienteNumero = Math.max(Number(s.siguienteNumero), Number(data.settings.siguienteNumero) || 0);
      await saveSettings(s);
    }
    toast('Datos cargados ✓');
    route();
  } catch (err) {
    toast(`No se pudo cargar: ${err.message}`);
  }
}

// Al escribir o elegir un NIT o un nombre, busca el cliente y llena sus datos.
async function handleClientField(path, value) {
  if (path === 'cliente.nombre') {
    const c = clientByName(value);
    if (c) return pickClient(c);
    const cur = CLIENTES.find((x) => x.key === R.cliente.id);
    if (cur && clientKey(cur.nombre) !== clientKey(value)) R.cliente.id = '';
    return;
  }
  const matches = clientsByNit(value);
  const cur = CLIENTES.find((x) => x.key === R.cliente.id);
  if (cur && !matches.includes(cur)) {
    // El NIT ya no es del cliente que se había llenado solo: se limpian sus datos.
    Object.assign(R.cliente, { id: '', nombre: '', direccion: '', correo: '' });
    syncInputs();
    scheduleSave();
  }
  if (matches.length === 1) return pickClient(matches[0]);
  if (matches.length > 1 && !matches.some((c) => c.key === R.cliente.id)) openClientPicker(matches);
}

async function pickClient(c) {
  if (c.key === R.cliente.id) return;
  const equipos = applyClient(c);
  await saveNow();
  if (equipos) renderForm(true);
  else syncInputs();
  toast(equipos ? `${c.nombre}: cargamos los equipos de la visita del ${fmtDate(c.ultimaVisita)}` : `Cliente: ${c.nombre}`);
}

// Refresca los campos visibles sin redibujar el formulario (no cierra el teclado).
function syncInputs() {
  app.querySelectorAll('[data-path]').forEach((el) => {
    if (el.type === 'checkbox' || el === document.activeElement) return;
    const v = getPath(R, el.dataset.path) ?? '';
    if (el.value !== v) el.value = v;
    if (v) markOk(el.dataset.path);
  });
}

function openClientPicker(list) {
  const bg = document.createElement('div');
  bg.className = 'sheet-bg';
  bg.innerHTML = `<div class="sheet">
    <h3>Este NIT tiene ${list.length} sedes</h3>
    <p>¿En cuál está haciendo el mantenimiento?</p>
    ${list.map((c) => `<button class="btn ghost pick" data-key="${c.key}"><span><strong>${esc(c.nombre)}</strong><small>${esc(c.direccion || '')}</small></span></button>`).join('')}
    <button class="btn ghost" data-close>Ninguna, es un cliente nuevo</button>
  </div>`;
  bg.addEventListener('click', (e) => {
    const b = e.target.closest('[data-key],[data-close]');
    if (e.target !== bg && !b) return;
    bg.remove();
    if (b?.dataset.key) pickClient(CLIENTES.find((c) => c.key === b.dataset.key));
  });
  document.body.appendChild(bg);
}

// ---------- Eventos ----------
app.addEventListener('input', (e) => {
  const el = e.target;
  const path = el.dataset?.path;
  if (!path || !R) return;
  if (el.hasAttribute('data-bool')) {
    setPath(R, path, el.checked);
    el.closest('.card').querySelector('.card-b').classList.toggle('hidden', !el.checked);
  } else {
    setPath(R, path, el.value);
  }
  if (el.value) markOk(path);
  scheduleSave();
  // Elegir una sugerencia de la lista no trae inputType: se busca el cliente de una vez.
  if ((path === 'cliente.nombre' || path === 'cliente.nit') && (!e.inputType || e.inputType === 'insertReplacementText')) {
    handleClientField(path, el.value);
  }
});

app.addEventListener('change', async (e) => {
  const el = e.target;
  if (el.matches('[data-photo]') && el.files.length) { const files = [...el.files]; el.value = ''; return addPhotos(files); }
  if (el.matches('[data-restore]') && el.files[0]) { const f = el.files[0]; el.value = ''; return restoreBackup(f); }
  if (R && (el.dataset.path === 'cliente.nombre' || el.dataset.path === 'cliente.nit')) handleClientField(el.dataset.path, el.value);
});

app.addEventListener('click', async (e) => {
  const nav = e.target.closest('[data-nav]');
  if (nav) { location.hash = nav.dataset.nav; return; }

  const sg = e.target.closest('[data-seg]');
  if (sg && R) {
    const path = sg.dataset.seg;
    const val = getPath(R, path) === sg.dataset.val ? '' : sg.dataset.val;
    setPath(R, path, val);
    sg.parentElement.querySelectorAll('.seg-btn').forEach((b) => b.classList.toggle('on', b.dataset.val === val));
    scheduleSave();
    return;
  }

  const btn = e.target.closest('[data-act]');
  if (!btn) return;
  const { act, sec } = btn.dataset;
  const i = Number(btn.dataset.i);
  switch (act) {
    case 'new': {
      const r = newReport(await getSettings());
      await idb.put('reportes', r);
      location.hash = `#/r/${r.id}`;
      break;
    }
    case 'install':
      installPrompt.prompt();
      installPrompt = null;
      break;
    case 'addpump':
      R[sec].bombas.push(emptyPump(sec));
      await saveNow(); renderForm(true);
      break;
    case 'dup': {
      const { amperaje, _prev, ...rest } = R[sec].bombas[i];
      R[sec].bombas.splice(i + 1, 0, { ...emptyPump(sec), ...rest, amperaje: '' });
      await saveNow(); renderForm(true);
      toast(`Bomba #${i + 2} creada con los mismos datos (falta amperaje)`);
      break;
    }
    case 'delpump':
      if (!isBlank(R[sec].bombas[i]) && !confirm(`¿Quitar la bomba #${i + 1}?`)) return;
      R[sec].bombas.splice(i, 1);
      await saveNow(); renderForm(true);
      break;
    case 'camera':
      openCamera();
      break;
    case 'delphoto':
      if (!confirm('¿Quitar esta foto?')) return;
      R.fotos.splice(i, 1);
      await saveNow(); renderForm(true);
      break;
    case 'sign': {
      const path = btn.dataset.path;
      openSignature(btn.dataset.label, async (v) => { setPath(R, path, v); await saveNow(); renderForm(true); });
      break;
    }
    case 'delreport':
      if (!confirm('¿Eliminar este borrador? No se puede deshacer.')) return;
      await idb.del('reportes', R.id);
      R = null;
      location.hash = '#';
      break;
    case 'finalize':
      if (R.numero) { await saveClient(R); await saveNow(); openSendSheet(); } else finalize();
      break;
    case 'download':
      await saveNow();
      downloadPdf();
      break;
    case 'backup':
      exportBackup();
      break;
    case 'sync':
      syncAll({ avisar: true });
      break;
    case 'logout': {
      const n = (await pendingReports()).length;
      if (!confirm(n ? `Hay ${n} reporte(s) sin subir. Si cierra sesión no se subirán hasta que vuelva a entrar. ¿Cerrar sesión?` : '¿Cerrar sesión en este teléfono?')) return;
      await logout();
      route();
      break;
    }
  }
});

// ---------- Navegación ----------
async function route() {
  await flushSave();
  const h = location.hash;
  if (ONLINE_MODE && !SESION) {
    R = null;
    renderLogin();
  } else if (h.startsWith('#/r/')) {
    R = await idb.get('reportes', h.slice(4));
    if (!R) { location.hash = '#'; return; }
    await loadClients();
    renderForm();
  } else if (h === '#/clientes') {
    R = null;
    renderClients();
  } else if (h.startsWith('#/clientes/')) {
    R = null;
    renderClientEdit(decodeURIComponent(h.slice(11)));
  } else if (h === '#/ajustes') {
    R = null;
    renderSettings();
  } else {
    R = null;
    renderHome();
  }
}

window.addEventListener('hashchange', route);
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  installPrompt = e;
  if ((!location.hash || location.hash === '#') && (!ONLINE_MODE || SESION)) renderHome();
});

// Si el diseño no se aplicó (p. ej. el teléfono tenía una copia vieja o dañada),
// se descarga de nuevo y se inserta directamente en la página.
async function ensureStyles() {
  const ok = () => getComputedStyle(document.body).backgroundColor === 'rgb(243, 246, 251)';
  if (ok()) return;
  try {
    const css = await (await fetch(`styles.css?r=${Date.now()}`, { cache: 'no-store' })).text();
    if (!ok() && css.includes(':root')) document.head.appendChild(Object.assign(document.createElement('style'), { textContent: css }));
  } catch (err) { console.warn('No se pudo recargar el diseño', err); }
}

(async function init() {
  if ('serviceWorker' in navigator) {
    // Cuando se publica una versión nueva, recargar una vez para no mezclar archivos viejos y nuevos.
    const habiaVersion = !!navigator.serviceWorker.controller;
    let recargando = false;
    navigator.serviceWorker.addEventListener('controllerchange', async () => {
      if (!habiaVersion || recargando) return;
      recargando = true;
      await flushSave();
      location.reload();
    });
    navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).catch(console.error);
  }
  ensureStyles();
  // Pide al navegador no borrar los datos guardados por falta de espacio.
  navigator.storage?.persist?.().catch(() => {});
  try {
    const blob = await (await fetch('icons/logo.png')).blob();
    LOGO = await new Promise((res) => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.readAsDataURL(blob); });
  } catch { /* el PDF sale sin logo */ }
  if (ONLINE_MODE) await loadSesion();
  await route();
  syncAll();
})();
