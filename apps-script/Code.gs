/**
 * Servidor de la app "Reportes WPS" (Water Proof System SAS).
 * Vive dentro de la hoja de cálculo: guarda reportes y clientes en pestañas,
 * y los PDF y fotos en una carpeta de Google Drive.
 *
 * Instalación (una sola vez):
 *  1. Ejecutar la función `setup` desde el editor y aprobar los permisos.
 *  2. Implementar > Nueva implementación > Aplicación web
 *     (Ejecutar como: Yo · Quién tiene acceso: Cualquier usuario).
 *  3. Copiar la URL de la aplicación web en `config.js` de la app.
 */

const COLS = {
  Reportes: ['id', 'numero', 'fecha', 'cliente', 'nit', 'direccion', 'actividad', 'estado', 'realiza', 'recibe',
    'frecuencia', 'recomendaciones', 'pdf', 'carpeta', 'subido_por', 'actualizado', 'pdf_id', 'carpeta_id', 'datos'],
  Clientes: ['id', 'nombre', 'nit', 'direccion', 'correo', 'frecuencia', 'ultima_visita', 'ultimo_numero', 'actualizado', 'equipos'],
  Usuarios: ['nombre', 'codigo', 'rol', 'activo'],
  Config: ['clave', 'valor'],
  Sugerencias: ['id', 'fecha', 'nombre', 'rol', 'sugerencia', 'pantalla', 'version', 'estado'],
};
const ROLES_OFICINA = ['admin', 'oficina'];

// ---------- Instalación ----------
function setup() {
  const ss = SpreadsheetApp.getActive();
  Object.keys(COLS).forEach((name) => {
    const cols = COLS[name];
    const sh = ss.getSheetByName(name) || ss.insertSheet(name);
    sh.getRange('A:Z').setNumberFormat('@'); // todo como texto: NIT, fechas y códigos no se transforman
    sh.getRange(1, 1, 1, cols.length).setValues([cols]).setFontWeight('bold').setBackground('#dde7f4');
    sh.setFrozenRows(1);
  });
  ['Hoja 1', 'Sheet1', 'Hoja1'].forEach((n) => {
    const sh = ss.getSheetByName(n);
    if (sh && sh.getLastRow() === 0 && ss.getSheets().length > 1) ss.deleteSheet(sh);
  });

  if (!getConfig('siguiente_numero')) setConfig('siguiente_numero', '1445');
  if (!getConfig('carpeta_drive')) {
    const folder = DriveApp.createFolder('Reportes WPS - PDF y fotos');
    setConfig('carpeta_drive', folder.getId());
  }
  if (readAll('Usuarios').length === 0) {
    const code = () => 'wps-' + Utilities.getUuid().replace(/-/g, '').slice(0, 8);
    sheet('Usuarios').getRange(2, 1, 3, 4).setValues([
      ['Catalina Morales', code(), 'admin', 'si'],
      ['Adriana Navarrete', code(), 'oficina', 'si'],
      ['Esteban Martínez', code(), 'operario', 'si'],
    ]);
  }
  return 'Listo';
}

// ---------- Entrada HTTP ----------
function doGet() {
  return json({ ok: true, app: 'wps-reportes' });
}

function doPost(e) {
  try {
    const req = JSON.parse(e.postData.contents);
    const user = auth(req.codigo);
    if (!user) throw new Error('Código de acceso no válido');
    const fn = ACCIONES[req.accion];
    if (!fn) throw new Error('Acción desconocida: ' + req.accion);
    // Si Google pierde la respuesta, la app reintenta con el mismo `solicitud`:
    // se devuelve el resultado guardado en vez de repetir la acción (p. ej. reservar números dos veces).
    const cache = CacheService.getScriptCache();
    const key = req.solicitud ? 'sol:' + req.solicitud : '';
    const previo = key && cache.get(key);
    if (previo) return ContentService.createTextOutput(previo).setMimeType(ContentService.MimeType.JSON);
    const text = JSON.stringify({ ok: true, data: fn(req, user) });
    if (key && text.length < 90000) cache.put(key, text, 900);
    return ContentService.createTextOutput(text).setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    return json({ ok: false, error: String(err && err.message || err) });
  }
}

const ACCIONES = {
  login: (req, user) => user,

  clientes: () => readAll('Clientes').map((c) => {
    let eq = {};
    try { eq = c.equipos ? JSON.parse(c.equipos) : {}; } catch (e) { /* celda editada a mano */ }
    return {
      key: c.id, nombre: c.nombre, nit: c.nit, direccion: c.direccion, correo: c.correo, frecuencia: c.frecuencia,
      ultimaVisita: c.ultima_visita, ultimoNumero: c.ultimo_numero ? Number(c.ultimo_numero) : null,
      actualizado: Number(c.actualizado) || 0, potable: eq.potable || null, eyectoras: eq.eyectoras || null, rci: eq.rci || null,
    };
  }),

  guardarCliente: (req) => {
    const c = req.cliente;
    if (!c || !c.key || !c.nombre) throw new Error('Cliente incompleto');
    withLock(() => upsert('Clientes', {
      id: c.key, nombre: c.nombre, nit: c.nit, direccion: c.direccion, correo: c.correo, frecuencia: c.frecuencia,
      ultima_visita: c.ultimaVisita, ultimo_numero: c.ultimoNumero, actualizado: c.actualizado || Date.now(),
      equipos: JSON.stringify({ potable: c.potable || null, eyectoras: c.eyectoras || null, rci: c.rci || null }),
    }));
    return true;
  },

  borrarCliente: (req, user) => {
    if (ROLES_OFICINA.indexOf(user.rol) < 0) throw new Error('Solo la oficina puede eliminar clientes');
    withLock(() => removeRow('Clientes', req.id));
    return true;
  },

  // `serie` cambia cuando la oficina reinicia el consecutivo: los teléfonos descartan sus números reservados.
  serie: () => getConfig('serie') || '1',

  reservarNumeros: (req) => withLock(() => {
    const n = Math.min(Math.max(Number(req.cantidad) || 1, 1), 20);
    const desde = Number(getConfig('siguiente_numero'));
    setConfig('siguiente_numero', String(desde + n));
    const numeros = [];
    for (let i = 0; i < n; i++) numeros.push(desde + i);
    return { serie: getConfig('serie') || '1', numeros: numeros };
  }),

  guardarReporte: (req, user) => withLock(() => {
    const r = req.reporte;
    if (!r || !r.id || !r.numero) throw new Error('Reporte incompleto');
    const prev = readAll('Reportes').filter((x) => x.id === r.id)[0] || {};
    const root = DriveApp.getFolderById(getConfig('carpeta_drive'));
    const nombre = r.numero + ' - ' + (r.cliente.nombre || 'Cliente');
    let folder;
    try { folder = prev.carpeta_id ? DriveApp.getFolderById(prev.carpeta_id) : null; } catch (e) { folder = null; }
    if (!folder) folder = root.createFolder(nombre);
    else if (folder.getName() !== nombre) folder.setName(nombre);

    let pdfId = prev.pdf_id, pdfUrl = prev.pdf;
    if (req.pdf) {
      if (pdfId) { try { DriveApp.getFileById(pdfId).setTrashed(true); } catch (e) { /* ya no existe */ } }
      const file = folder.createFile(Utilities.newBlob(Utilities.base64Decode(req.pdf), 'application/pdf', req.pdfNombre || nombre + '.pdf'));
      pdfId = file.getId();
      pdfUrl = file.getUrl();
    }

    const fotos = {};
    (req.fotos || []).forEach((f, i) => {
      const file = folder.createFile(Utilities.newBlob(Utilities.base64Decode(f.data), 'image/jpeg', f.nombre || 'foto-' + (i + 1) + '.jpg'));
      if (f.nota) file.setDescription(f.nota);
      fotos[f.id] = file.getId();
    });

    const rec = [r.potable.aplica && r.potable.recomendaciones, r.eyectoras.aplica && r.eyectoras.recomendaciones, r.rci.aplica && r.rci.recomendaciones]
      .filter(Boolean).join(' | ');
    upsert('Reportes', {
      id: r.id, numero: r.numero, fecha: r.fecha, cliente: r.cliente.nombre, nit: r.cliente.nit, direccion: r.cliente.direccion,
      actividad: r.actividad, estado: r.estado, realiza: r.cierre.realiza, recibe: r.cierre.recibe, frecuencia: r.cierre.frecuencia,
      recomendaciones: rec, pdf: pdfUrl, carpeta: folder.getUrl(), subido_por: user.nombre, actualizado: new Date().toISOString(),
      pdf_id: pdfId, carpeta_id: folder.getId(), datos: JSON.stringify(r),
    });
    return { pdf: pdfUrl, carpeta: folder.getUrl(), fotos: fotos };
  }),

  // Ideas de mejora escritas desde la app. Se ignoran repetidas (mismo id).
  sugerencia: (req, user) => withLock(() => {
    const texto = String(req.texto || '').trim().slice(0, 3000);
    if (!texto) throw new Error('La sugerencia está vacía');
    const sh = ensureSheet('Sugerencias');
    if (req.id && readAll('Sugerencias').some((x) => x.id === req.id)) return true;
    const fila = [req.id || Utilities.getUuid(), req.fecha || new Date().toISOString(), user.nombre, user.rol, texto,
      req.pantalla || '', req.version || '', 'Nueva'];
    sh.getRange(sh.getLastRow() + 1, 1, 1, fila.length).setValues([fila]);
    return true;
  }),

  reportes: () => readAll('Reportes')
    .map((r) => ({ id: r.id, numero: Number(r.numero), fecha: r.fecha, cliente: r.cliente, nit: r.nit, estado: r.estado,
      realiza: r.realiza, pdf: r.pdf, carpeta: r.carpeta }))
    .sort((a, b) => b.numero - a.numero)
    .slice(0, 300),
};

// ---------- Utilidades ----------
function json(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function sheet(name) {
  return SpreadsheetApp.getActive().getSheetByName(name);
}

// Crea la pestaña con sus encabezados si todavía no existe.
function ensureSheet(name) {
  const existing = sheet(name);
  if (existing) return existing;
  const sh = SpreadsheetApp.getActive().insertSheet(name);
  sh.getRange('A:Z').setNumberFormat('@');
  sh.getRange(1, 1, 1, COLS[name].length).setValues([COLS[name]]).setFontWeight('bold').setBackground('#dde7f4');
  sh.setFrozenRows(1);
  return sh;
}

function readAll(name) {
  const values = sheet(name).getDataRange().getValues();
  const head = values.shift();
  return values
    .filter((row) => row.some((v) => v !== ''))
    .map((row) => {
      const o = {};
      head.forEach((k, i) => { o[k] = row[i] === '' ? '' : String(row[i]); });
      return o;
    });
}

function upsert(name, obj) {
  const sh = sheet(name);
  const values = sh.getDataRange().getValues();
  const head = values[0];
  const row = head.map((k) => (obj[k] === undefined || obj[k] === null ? '' : String(obj[k])));
  for (let i = 1; i < values.length; i++) {
    if (String(values[i][0]) === String(obj.id)) {
      sh.getRange(i + 1, 1, 1, head.length).setValues([row]);
      return;
    }
  }
  sh.getRange(sh.getLastRow() + 1, 1, 1, head.length).setValues([row]);
}

function removeRow(name, id) {
  const sh = sheet(name);
  const values = sh.getDataRange().getValues();
  for (let i = values.length - 1; i >= 1; i--) if (String(values[i][0]) === String(id)) sh.deleteRow(i + 1);
}

function auth(codigo) {
  if (!codigo) return null;
  const u = readAll('Usuarios').filter((x) => x.codigo === String(codigo).trim() && x.activo.toLowerCase() !== 'no')[0];
  return u ? { nombre: u.nombre, rol: u.rol } : null;
}

function getConfig(clave) {
  const row = readAll('Config').filter((x) => x.clave === clave)[0];
  return row ? row.valor : '';
}

function setConfig(clave, valor) {
  const sh = sheet('Config');
  const values = sh.getDataRange().getValues();
  for (let i = 1; i < values.length; i++) {
    if (values[i][0] === clave) { sh.getRange(i + 1, 2).setValue(valor); return; }
  }
  sh.appendRow([clave, valor]);
}

function withLock(fn) {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try { return fn(); } finally { lock.releaseLock(); }
}
