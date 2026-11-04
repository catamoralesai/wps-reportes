/**
 * Envío de reportes desde waterproofsas@gmail.com.
 * Este script vive en esa cuenta (no en la de la hoja) para que los correos
 * salgan de esa dirección sin guardar su contraseña en ningún lado.
 * El servidor de la hoja le pasa cada reporte usando un secreto compartido.
 *
 * Instalación (una sola vez, con la sesión de waterproofsas@gmail.com):
 *  1. Ejecutar `instalar` y aprobar los permisos.
 *  2. Implementar > Nueva implementación > Aplicación web
 *     (Ejecutar como: Yo · Quién tiene acceso: Cualquier usuario).
 *  3. Poner la URL y el secreto en la pestaña Config de la hoja
 *     (claves `correo_url` y `correo_secreto`).
 *
 * Para cortar el acceso: borrar este proyecto o revocarlo en la cuenta de Google.
 */

const REMITENTE = 'Water Proof System SAS';

function instalar() {
  const props = PropertiesService.getScriptProperties();
  if (!props.getProperty('SECRETO')) props.setProperty('SECRETO', Utilities.getUuid() + Utilities.getUuid());
  Logger.log('Cuenta: ' + Session.getEffectiveUser().getEmail());
  Logger.log('Secreto: ' + props.getProperty('SECRETO'));
  Logger.log('Correos disponibles hoy: ' + MailApp.getRemainingDailyQuota());
  GmailApp.getDrafts(); // pide el permiso de Gmail desde la instalación
}

function doPost(e) {
  try {
    const req = JSON.parse(e.postData.contents);
    const secreto = PropertiesService.getScriptProperties().getProperty('SECRETO');
    if (!secreto || req.secreto !== secreto) throw new Error('No autorizado');

    if (req.accion === 'probar') {
      return respuesta({ ok: true, cuenta: Session.getEffectiveUser().getEmail(), cupo: MailApp.getRemainingDailyQuota() });
    }

    // Si la respuesta se pierde y el servidor reintenta, no se envía dos veces.
    const cache = CacheService.getScriptCache();
    const key = 'env:' + req.id;
    if (req.id && cache.get(key)) return respuesta({ ok: true, repetido: true });

    const adjunto = Utilities.newBlob(Utilities.base64Decode(req.pdf), 'application/pdf', req.pdfNombre);
    GmailApp.sendEmail(req.para, req.asunto, req.cuerpo, { name: REMITENTE, attachments: [adjunto] });
    if (req.id) cache.put(key, '1', 21600);
    return respuesta({ ok: true });
  } catch (err) {
    return respuesta({ ok: false, error: String(err && err.message || err) });
  }
}

function respuesta(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
