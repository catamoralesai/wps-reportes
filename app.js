'use strict';
// Reportes de mantenimiento · Water Proof System SAS
// Todo se guarda en el teléfono (IndexedDB), así la app funciona sin internet.

const APP_VERSION = '0.1.0';
const ESTADOS = ['OK', 'Revisar', 'Falla', 'N/A'];
const FRECUENCIAS = { Mensual: 1, Bimestral: 2, Trimestral: 3, Semestral: 6, Anual: 12 };
const TIPOS = ['Centrífuga', 'Sumergible', 'Multietapa', 'Periférica', 'Turbina vertical'];
const ACTIVIDADES = ['Mantenimiento preventivo', 'Mantenimiento correctivo', 'Instalación', 'Diagnóstico', 'Visita técnica'];
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
    req.onsuccess = () => res(req.result);
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

// Guarda los equipos del cliente para precargarlos en la próxima visita.
async function saveClient(r) {
  const key = clientKey(r.cliente.nombre);
  if (!key) return;
  const tpl = (b) => ({ marca: b.marca, modelo: b.modelo, tipo: b.tipo, _prev: { voltaje: b.voltaje, amperaje: b.amperaje } });
  await idb.put('clientes', {
    key, ...r.cliente,
    ultimaVisita: r.fecha, ultimoNumero: r.numero, frecuencia: r.cierre.frecuencia,
    potable: r.potable.aplica ? r.potable.bombas.map(tpl) : null,
    eyectoras: r.eyectoras.aplica ? r.eyectoras.bombas.map(tpl) : null,
    rci: r.rci.aplica ? { principal: tpl(r.rci.principal), jockey: tpl(r.rci.jockey) } : null,
  });
}

function applyClient(c) {
  R.cliente.nombre = c.nombre;
  for (const k of ['nit', 'direccion', 'correo']) if (!R.cliente[k]) R.cliente[k] = c[k] || '';
  if (!R.cierre.frecuencia) R.cierre.frecuencia = c.frecuencia || '';
  const untouched = [...R.potable.bombas, ...R.eyectoras.bombas, R.rci.principal, R.rci.jockey].every(isBlank);
  if (!untouched) return false;
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
  await idb.put('reportes', R);
  const ind = document.getElementById('saveInd');
  if (ind) ind.textContent = 'Guardado ✓';
}
const flushSave = () => (saveTimer ? saveNow() : Promise.resolve());
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flushSave(); });

// ---------- Componentes del formulario ----------
function field(label, path, o = {}) {
  const v = getPath(R, path) ?? '';
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
      <img src="${f.data}" alt="Foto ${i + 1}">
      <input data-path="fotos.${i}.nota" value="${esc(f.nota)}" placeholder="Descripción (opcional)">
      <button type="button" class="link danger" data-act="delphoto" data-i="${i}">Quitar</button>
    </div>`).join('');
  return `${list ? `<div class="photos">${list}</div>` : ''}
    <div class="btn-row">
      <label class="btn primary">📷 Tomar foto<input type="file" accept="image/*" capture="environment" data-photo hidden></label>
      <label class="btn ghost">🖼️ Galería<input type="file" accept="image/*" multiple data-photo hidden></label>
    </div>`;
}

const sigBlock = (label, path) => `<div class="fld full" data-field="${path}"><span>${label}</span>
  <div class="sig"><canvas data-sig="${path}"></canvas><div class="sig-hint">Firme aquí con el dedo</div>
  <button type="button" class="link" data-act="clearsig" data-path="${path}">Borrar</button></div></div>`;

function setupSig(canvas, get, set) {
  const ratio = Math.min(window.devicePixelRatio || 1, 2);
  const rect = canvas.getBoundingClientRect();
  canvas.width = rect.width * ratio;
  canvas.height = rect.height * ratio;
  const ctx = canvas.getContext('2d');
  ctx.scale(ratio, ratio);
  Object.assign(ctx, { lineWidth: 2.4, lineCap: 'round', lineJoin: 'round', strokeStyle: '#0b1f44', fillStyle: '#0b1f44' });
  const box = canvas.parentElement;
  const existing = get();
  if (existing) {
    const img = new Image();
    img.onload = () => ctx.drawImage(img, 0, 0, rect.width, rect.height);
    img.src = existing;
    box.classList.add('signed');
  }
  let drawing = false, last = null;
  const pos = (e) => { const b = canvas.getBoundingClientRect(); return { x: e.clientX - b.left, y: e.clientY - b.top }; };
  canvas.addEventListener('pointerdown', (e) => {
    drawing = true; last = pos(e);
    canvas.setPointerCapture(e.pointerId);
    ctx.beginPath(); ctx.arc(last.x, last.y, 1.2, 0, Math.PI * 2); ctx.fill();
    box.classList.add('signed');
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!drawing) return;
    const p = pos(e);
    ctx.beginPath(); ctx.moveTo(last.x, last.y); ctx.lineTo(p.x, p.y); ctx.stroke();
    last = p;
  });
  const end = () => { if (drawing) { drawing = false; set(canvas.toDataURL('image/png')); } };
  canvas.addEventListener('pointerup', end);
  canvas.addEventListener('pointercancel', end);
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
    ${r.numero ? '' : '<div class="note">El número del reporte se asigna al finalizar. Todo se guarda solo en el teléfono, aunque no haya señal.</div>'}
    ${section('general', 'Datos generales', `<div class="grid2">
      ${field('Cliente', 'cliente.nombre', { list: 'dl-clientes', full: true, placeholder: 'Ej: Reserva de Mazurén' })}
      ${field('NIT', 'cliente.nit', { inputmode: 'numeric' })}
      ${field('Fecha', 'fecha', { type: 'date' })}
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
  <datalist id="dl-clientes">${CLIENTES.map((c) => `<option value="${esc(c.nombre)}">`).join('')}</datalist>`;

  app.querySelectorAll('canvas[data-sig]').forEach((c) => {
    const p = c.dataset.sig;
    setupSig(c, () => getPath(R, p), (v) => { setPath(R, p, v); markOk(p); scheduleSave(); });
  });
  window.scrollTo(0, keepScroll ? sy : 0);
}

function markOk(path) {
  const el = app.querySelector(`[data-field="${path}"]`) || app.querySelector(`[data-path="${path}"]`)?.closest('.fld');
  el?.classList.remove('err');
}

function validate() {
  const req = [['cliente.nombre', 'Cliente'], ['fecha', 'Fecha'], ['cierre.realiza', 'Quien realiza'], ['cierre.recibe', 'Quien recibe'], ['cierre.firmaRecibe', 'Firma de quien recibe']];
  const missing = req.filter(([p]) => !String(getPath(R, p) || '').trim());
  app.querySelectorAll('.fld.err').forEach((e) => e.classList.remove('err'));
  missing.forEach(([p]) => {
    const el = app.querySelector(`[data-field="${p}"]`) || app.querySelector(`[data-path="${p}"]`)?.closest('.fld');
    el?.classList.add('err');
  });
  return missing;
}

const pdfName = (r) => `Reporte_${r.numero}_${(r.cliente.nombre || 'cliente').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^\w]+/g, '_')}.pdf`;

async function finalize() {
  const missing = validate();
  if (missing.length) {
    toast(`Falta: ${missing.map((m) => m[1]).join(', ')}`, 4000);
    app.querySelector('.fld.err')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    return;
  }
  if (!R.numero) {
    const s = await getSettings();
    R.numero = Number(s.siguienteNumero);
    s.siguienteNumero = R.numero + 1;
    await saveSettings(s);
    R.estado = 'finalizado';
  }
  await saveNow();
  await saveClient(R);
  CLIENTES = await idb.all('clientes');
  renderForm(true);
  openSendSheet();
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

function downloadPdf() {
  try { downloadBlob(makePdf(), pdfName(R)); }
  catch (err) { console.error(err); toast('No se pudo generar el PDF'); }
}

async function sharePdf() {
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

async function addPhotos(files) {
  toast('Procesando fotos…');
  for (const f of files) {
    try { R.fotos.push({ id: uid(), nota: '', ...(await compressImage(f)) }); }
    catch (err) { console.error(err); toast('Una foto no se pudo leer'); }
  }
  await saveNow();
  renderForm(true);
}

function compressImage(file, max = 1400, q = 0.72) {
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
    <button class="btn primary big" data-act="new">+ Nuevo reporte</button>
    ${installPrompt ? '<button class="btn block" data-act="install" style="margin-bottom:14px">Instalar app en el teléfono</button>' : ''}
    ${proximos.length ? `<section class="card"><div class="card-h"><h2>Próximos mantenimientos</h2></div><ul class="list">
      ${proximos.map((c) => `<li><div class="row"><div><strong>${esc(c.nombre)}</strong><small>${c.frecuencia} · última visita ${fmtDate(c.ultimaVisita)}</small></div>
        <span class="badge ${c.proxima < hoy ? 'vencido' : 'pronto'}">${c.proxima < hoy ? 'Vencido' : fmtDate(c.proxima)}</span></div></li>`).join('')}
    </ul></section>` : ''}
    <section class="card"><div class="card-h"><h2>Reportes</h2></div>
      ${reps.length ? `<ul class="list">${reps.map((r) => `<li><button class="row" data-nav="#/r/${r.id}">
        <div><strong>${r.numero ? `Nº ${r.numero}` : 'Sin número'} · ${esc(r.cliente.nombre || 'Sin cliente')}</strong>
        <small>${fmtDate(r.fecha)} · ${esc(r.actividad)}</small></div>${badge(r.estado)}</button></li>`).join('')}</ul>`
        : '<p class="empty">Aún no hay reportes. Toca “Nuevo reporte” para empezar.</p>'}
    </section>
  </main>`;
}

// ---------- Vista: ajustes ----------
async function renderSettings() {
  const s = await getSettings();
  app.innerHTML = `
  <header class="topbar">
    <button class="icon-btn" data-nav="#" aria-label="Volver">←</button>
    <div class="tb-title">Ajustes<small>Versión ${APP_VERSION}</small></div>
  </header>
  <main>
    <section class="card"><div class="card-h"><h2>Operario</h2></div><div class="card-b">
      <div class="grid2">
        <label class="fld full"><span>Nombre del operario</span><input data-set="operario" value="${esc(s.operario)}"></label>
        <label class="fld full"><span>Siguiente número de reporte</span><input data-set="siguienteNumero" inputmode="numeric" value="${esc(s.siguienteNumero)}"></label>
      </div>
      <div class="fld full" style="margin-top:10px"><span>Firma del operario (se usa en todos los reportes)</span>
        <div class="sig"><canvas id="sigTec"></canvas><div class="sig-hint">Firme aquí con el dedo</div>
        <button type="button" class="link" data-act="clearsigtec">Borrar</button></div></div>
    </div></section>
    <section class="card"><div class="card-h"><h2>Respaldo</h2></div><div class="card-b">
      <p class="note warn">En esta versión de prueba los reportes viven solo en este teléfono. Haz un respaldo cada semana y envíatelo por correo o WhatsApp.</p>
      <div class="btn-row">
        <button class="btn primary" data-act="backup">Exportar respaldo</button>
        <label class="btn ghost">Restaurar<input type="file" accept="application/json,.json" data-restore hidden></label>
      </div>
    </div></section>
  </main>`;
  setupSig(document.getElementById('sigTec'), () => s.firmaTecnico, async (v) => { s.firmaTecnico = v; await saveSettings(s); toast('Firma guardada'); });
  app.querySelectorAll('[data-set]').forEach((el) => el.addEventListener('input', async () => {
    const k = el.dataset.set;
    s[k] = k === 'siguienteNumero' ? Number(el.value.replace(/\D/g, '')) || DEFAULT_SETTINGS.siguienteNumero : el.value;
    await saveSettings(s);
  }));
  document.getElementById('sigTec').closest('.sig').querySelector('[data-act="clearsigtec"]').onclick = async () => {
    s.firmaTecnico = ''; await saveSettings(s); renderSettings();
  };
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
    if (!confirm(`Restaurar ${data.reportes.length} reportes y ${data.clientes.length} clientes? Los reportes con el mismo ID se reemplazan.`)) return;
    for (const r of data.reportes) await idb.put('reportes', r);
    for (const c of data.clientes) await idb.put('clientes', c);
    const s = await getSettings();
    s.siguienteNumero = Math.max(Number(s.siguienteNumero), Number(data.settings?.siguienteNumero) || 0);
    await saveSettings(s);
    toast('Respaldo restaurado ✓');
    renderSettings();
  } catch (err) {
    toast(`No se pudo restaurar: ${err.message}`);
  }
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
});

app.addEventListener('change', async (e) => {
  const el = e.target;
  if (el.matches('[data-photo]') && el.files.length) return addPhotos([...el.files]);
  if (el.matches('[data-restore]') && el.files[0]) return restoreBackup(el.files[0]);
  if (R && el.dataset.path === 'cliente.nombre') {
    const c = CLIENTES.find((x) => x.key === clientKey(el.value));
    if (!c) return;
    const equipos = applyClient(c);
    await saveNow();
    renderForm(true);
    toast(equipos ? `Cargamos los equipos de la visita del ${fmtDate(c.ultimaVisita)}` : 'Datos del cliente cargados');
  }
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
    case 'delphoto':
      if (!confirm('¿Quitar esta foto?')) return;
      R.fotos.splice(i, 1);
      await saveNow(); renderForm(true);
      break;
    case 'clearsig':
      setPath(R, btn.dataset.path, '');
      await saveNow(); renderForm(true);
      break;
    case 'delreport':
      if (!confirm('¿Eliminar este borrador? No se puede deshacer.')) return;
      await idb.del('reportes', R.id);
      R = null;
      location.hash = '#';
      break;
    case 'finalize':
      if (R.numero) { await saveNow(); await saveClient(R); openSendSheet(); } else finalize();
      break;
    case 'download':
      await saveNow();
      downloadPdf();
      break;
    case 'backup':
      exportBackup();
      break;
  }
});

// ---------- Navegación ----------
async function route() {
  await flushSave();
  const h = location.hash;
  if (h.startsWith('#/r/')) {
    R = await idb.get('reportes', h.slice(4));
    if (!R) { location.hash = '#'; return; }
    CLIENTES = await idb.all('clientes');
    renderForm();
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
  if (!R && !location.hash.startsWith('#/ajustes')) renderHome();
});

(async function init() {
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(console.error);
  // Pide al navegador no borrar los datos guardados por falta de espacio.
  navigator.storage?.persist?.().catch(() => {});
  try {
    const blob = await (await fetch('icons/logo.png')).blob();
    LOGO = await new Promise((res) => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.readAsDataURL(blob); });
  } catch { /* el PDF sale sin logo */ }
  route();
})();
