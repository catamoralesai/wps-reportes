'use strict';
// Genera el PDF del reporte con la misma estructura del formato en papel.
// Todo ocurre en el teléfono, así que funciona sin internet.

const PDF_EMPRESA = {
  nombre: 'WATER PROOF SYSTEM SAS',
  nit: 'NIT 900.533.514-6',
  lineas: [
    'REINGENIERÍA Y MANTENIMIENTO DE SISTEMAS DE SUMINISTRO DE AGUA,',
    'SISTEMAS EYECTORES Y RED CONTRA INCENDIOS.',
  ],
};

function buildReportPdf(r, logoDataUrl) {
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ unit: 'mm', format: 'a4', compress: true });
  doc.setLineHeightFactor(1.2);

  const W = 210, H = 297, M = 10, CW = W - 2 * M, BOTTOM = H - 14;
  const BLUE = [31, 78, 156], LABEL = [221, 231, 244], TITLE = [196, 213, 238], LINE = [110, 122, 145];
  const STATUS_COLOR = { OK: [26, 127, 75], Revisar: [163, 91, 0], Falla: [180, 35, 24] };
  let y = M;

  const txt = (v) => (v == null ? '' : String(v));
  const newPage = () => { doc.addPage(); y = M; };
  const ensure = (h) => { if (y + h > BOTTOM) newPage(); };

  // ----- Encabezado -----
  if (logoDataUrl) doc.addImage(logoDataUrl, 'PNG', M, y, 24, 24);
  doc.setTextColor(...BLUE);
  doc.setFont('helvetica', 'bold'); doc.setFontSize(14);
  doc.text(PDF_EMPRESA.nombre, W / 2, y + 7, { align: 'center' });
  doc.setFont('helvetica', 'normal'); doc.setFontSize(7.5); doc.setTextColor(70);
  doc.text(PDF_EMPRESA.lineas, W / 2, y + 12, { align: 'center' });
  doc.text(PDF_EMPRESA.nit, W / 2, y + 20, { align: 'center' });

  const bx = W - M - 38, bw = 38;
  doc.setFontSize(6.5); doc.setFont('helvetica', 'bold'); doc.setTextColor(70);
  doc.text('REPORTE DE MANTENIMIENTO', bx + bw / 2, y + 3, { align: 'center' });
  doc.setDrawColor(...LINE); doc.setLineWidth(0.4);
  doc.roundedRect(bx, y + 5, bw, 13, 2.5, 2.5);
  doc.setFontSize(15); doc.setTextColor(200, 30, 30);
  doc.text(`Nº ${txt(r.numero) || '—'}`, bx + bw / 2, y + 14, { align: 'center' });
  y += 28;

  // ----- Tablas -----
  doc.setLineWidth(0.2); doc.setDrawColor(...LINE);
  const PAD = 1.6;

  function row(cells, opts = {}) {
    const size = opts.size || 8.5;
    const fs = size * 0.3528;
    const lh = fs * 1.2;
    doc.setFontSize(size);
    const lines = cells.map((c) => {
      doc.setFont('helvetica', c.label || c.bold ? 'bold' : 'normal');
      return doc.splitTextToSize(txt(c.t), c.w * CW - 2 * PAD);
    });
    const h = Math.max(opts.min || 6, ...lines.map((l) => 2 * PAD + l.length * lh));
    ensure(h);
    let x = M;
    cells.forEach((c, i) => {
      const w = c.w * CW;
      if (c.label || c.fill) { doc.setFillColor(...(c.fill || LABEL)); doc.rect(x, y, w, h, 'F'); }
      doc.rect(x, y, w, h);
      doc.setFont('helvetica', c.label || c.bold ? 'bold' : 'normal');
      doc.setTextColor(...(c.color || (c.label ? [35, 45, 70] : [15, 15, 15])));
      const center = c.align === 'center';
      doc.text(lines[i], center ? x + w / 2 : x + PAD, y + PAD + fs * 0.85, { align: center ? 'center' : 'left' });
      x += w;
    });
    y += h;
  }

  function title(t) {
    ensure(6.6 * 3);
    y += 3;
    doc.setFillColor(...TITLE); doc.rect(M, y, CW, 6.6, 'F'); doc.rect(M, y, CW, 6.6);
    doc.setFont('helvetica', 'bold'); doc.setFontSize(9); doc.setTextColor(...BLUE);
    doc.text(t, W / 2, y + 4.5, { align: 'center' });
    y += 6.6;
  }

  const status = (v, w) => ({ t: v, w, align: 'center', bold: !!v, color: STATUS_COLOR[v] });
  const noAplica = () => row([{ t: 'No aplica en esta visita', w: 1, align: 'center', color: [110, 110, 110] }]);
  const recomendaciones = (t) => row([{ t: 'RECOMENDACIONES', w: 0.22, label: 1 }, { t, w: 0.78 }], { min: 12 });

  // Datos generales
  const c = r.cliente;
  row([{ t: 'CLIENTE', w: 0.13, label: 1 }, { t: c.nombre, w: 0.35 }, { t: 'ACTIVIDAD REALIZADA', w: 0.2, label: 1 }, { t: r.actividad, w: 0.32 }]);
  row([{ t: 'NIT', w: 0.13, label: 1 }, { t: c.nit, w: 0.35 }, { t: 'FECHA', w: 0.2, label: 1 }, { t: fmtDate(r.fecha), w: 0.32 }]);
  row([{ t: 'DIRECCIÓN', w: 0.13, label: 1 }, { t: c.direccion, w: 0.35 }, { t: 'CORREO', w: 0.2, label: 1 }, { t: c.correo, w: 0.32 }]);

  // Electrobombas agua potable
  title('ELECTROBOMBAS SUMINISTRO AGUA POTABLE');
  if (!r.potable.aplica) noAplica();
  else {
    const w = [0.12, 0.14, 0.13, 0.14, 0.11, 0.12, 0.12, 0.12];
    row(['', 'MARCA', 'MODELO', 'TIPO', 'VOLTAJE', 'AMPERAJE', 'TABLERO', 'ESTADO'].map((t, i) => ({ t, w: w[i], label: 1, align: 'center' })));
    r.potable.bombas.forEach((b, i) => row([
      { t: `BOMBA #${i + 1}`, w: w[0], label: 1 },
      { t: b.marca, w: w[1] }, { t: b.modelo, w: w[2] }, { t: b.tipo, w: w[3] },
      { t: b.voltaje, w: w[4], align: 'center' }, { t: b.amperaje, w: w[5], align: 'center' },
      status(b.tablero, w[6]), status(b.estado, w[7]),
    ]));
    const pa = r.potable.presionArranque, pp = r.potable.presionParada;
    row([{ t: 'PRESIÓN (ARRANQUE Y PARADA)', w: 0.32, label: 1 }, { t: pa || pp ? `${pa || '—'} - ${pp || '—'} PSI` : '', w: 0.68 }]);
    recomendaciones(r.potable.recomendaciones);
  }

  // Bombas eyectoras
  title('BOMBAS EYECTORAS');
  if (!r.eyectoras.aplica) noAplica();
  else {
    const w = [0.12, 0.14, 0.13, 0.14, 0.11, 0.12, 0.12, 0.12];
    row(['', 'MARCA', 'MODELO', 'TIPO', 'VOLTAJE', 'AMPERAJE', 'TABLERO', 'FOSO'].map((t, i) => ({ t, w: w[i], label: 1, align: 'center' })));
    r.eyectoras.bombas.forEach((b, i) => row([
      { t: `BOMBA #${i + 1}`, w: w[0], label: 1 },
      { t: b.marca, w: w[1] }, { t: b.modelo, w: w[2] }, { t: b.tipo, w: w[3] },
      { t: b.voltaje, w: w[4], align: 'center' }, { t: b.amperaje, w: w[5], align: 'center' },
      status(b.tablero, w[6]), status(b.foso, w[7]),
    ]));
    recomendaciones(r.eyectoras.recomendaciones);
  }

  // Sistema RCI
  title('SISTEMA RCI (RED CONTRA INCENDIOS)');
  if (!r.rci.aplica) noAplica();
  else {
    const w = [0.2, 0.16, 0.16, 0.16, 0.16, 0.16];
    row(['', 'MARCA', 'MODELO', 'TIPO', 'VOLTAJE', 'AMPERAJE'].map((t, i) => ({ t, w: w[i], label: 1, align: 'center' })));
    [['BOMBA PRINCIPAL', r.rci.principal], ['JOCKEY', r.rci.jockey]].forEach(([n, b]) => row([
      { t: n, w: w[0], label: 1 },
      { t: b.marca, w: w[1] }, { t: b.modelo, w: w[2] }, { t: b.tipo, w: w[3] },
      { t: b.voltaje, w: w[4], align: 'center' }, { t: b.amperaje, w: w[5], align: 'center' },
    ]));
    recomendaciones(r.rci.recomendaciones);
  }

  // Tanques
  title('TANQUES');
  row([{ t: 'TANQUE HIDRONEUMÁTICO', w: 0.3, label: 1 }, status(r.tanques.hidro.estado, 0.14), { t: r.tanques.hidro.obs, w: 0.56 }]);
  row([{ t: 'TANQUE RESERVA', w: 0.3, label: 1 }, status(r.tanques.reserva.estado, 0.14), { t: r.tanques.reserva.obs, w: 0.56 }]);

  // Cierre: título, datos y firmas siempre en la misma página
  ensure(3 + 6.6 + 3 * 6 + 46);
  title('CIERRE DE LA INSPECCIÓN');
  const k = r.cierre;
  row([{ t: 'NOMBRE QUIEN REALIZA LA INSPECCIÓN', w: 0.4, label: 1 }, { t: k.realiza, w: 0.6 }]);
  row([{ t: 'FRECUENCIA DE MANTENIMIENTO', w: 0.4, label: 1 }, { t: k.frecuencia, w: 0.6 }]);
  row([{ t: 'NOMBRE QUIEN RECIBE LA INSPECCIÓN', w: 0.4, label: 1 }, { t: [k.recibe, k.cargo].filter(Boolean).join(' · '), w: 0.6 }]);

  // Firmas
  const sigH = 26, gap = 8, sigW = (CW - gap) / 2;
  ensure(sigH + 16);
  y += 6;
  [[k.firmaTecnico, 'Firma de quien realiza', k.realiza], [k.firmaRecibe, 'Firma de quien recibe', k.recibe]].forEach(([img, lbl, name], i) => {
    const x = M + i * (sigW + gap);
    if (img) {
      const p = doc.getImageProperties(img);
      const s = Math.min(sigW / p.width, sigH / p.height);
      const iw = p.width * s, ih = p.height * s;
      doc.addImage(img, 'PNG', x + (sigW - iw) / 2, y + (sigH - ih), iw, ih);
    }
    doc.setDrawColor(...LINE); doc.line(x, y + sigH + 1, x + sigW, y + sigH + 1);
    doc.setFont('helvetica', 'bold'); doc.setFontSize(8.5); doc.setTextColor(30);
    doc.text(txt(name), x + sigW / 2, y + sigH + 5, { align: 'center' });
    doc.setFont('helvetica', 'normal'); doc.setFontSize(7.5); doc.setTextColor(100);
    doc.text(lbl, x + sigW / 2, y + sigH + 9, { align: 'center' });
  });
  y += sigH + 12;

  // Registro fotográfico
  const fotos = r.fotos.filter((f) => f.data);
  if (fotos.length) {
    ensure(90);
    title('REGISTRO FOTOGRÁFICO');
    y += 4;
    const colW = (CW - 6) / 2, maxH = 72;
    for (let i = 0; i < fotos.length; i += 2) {
      const pair = fotos.slice(i, i + 2);
      const dims = pair.map((f) => {
        const s = Math.min(colW / f.w, maxH / f.h);
        return { w: f.w * s, h: f.h * s };
      });
      const rowH = Math.max(...dims.map((d) => d.h)) + 10;
      ensure(rowH);
      pair.forEach((f, j) => {
        const x = M + j * (colW + 6);
        const d = dims[j];
        doc.addImage(f.data, 'JPEG', x + (colW - d.w) / 2, y, d.w, d.h);
        if (f.nota) {
          doc.setFont('helvetica', 'normal'); doc.setFontSize(8); doc.setTextColor(60);
          doc.text(doc.splitTextToSize(f.nota, colW).slice(0, 2), x + colW / 2, y + d.h + 4, { align: 'center' });
        }
      });
      y += rowH;
    }
  }

  // Pie de página
  const n = doc.getNumberOfPages();
  const generado = new Date().toLocaleString('es-CO', { dateStyle: 'medium', timeStyle: 'short' });
  for (let i = 1; i <= n; i++) {
    doc.setPage(i);
    doc.setFont('helvetica', 'normal'); doc.setFontSize(7); doc.setTextColor(130);
    doc.text(`Reporte Nº ${txt(r.numero)} · ${txt(c.nombre)} · Generado digitalmente el ${generado}`, M, H - 7);
    doc.text(`Página ${i} de ${n}`, W - M, H - 7, { align: 'right' });
  }

  return doc.output('blob');
}
