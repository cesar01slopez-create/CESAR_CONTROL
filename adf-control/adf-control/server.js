const express = require('express'), cors = require('cors'), multer = require('multer'), bcrypt = require('bcryptjs'),
  jwt = require('jsonwebtoken'), XLSX = require('xlsx'), PDFDocument = require('pdfkit'), fs = require('fs'),
  path = require('path'), crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const DIR = process.env.DATA_DIR || __dirname;          // En Render/Railway apunta a un disco persistente
const FILE = path.join(DIR, 'db.json'), ODS = path.join(DIR, 'ods');
const LOGO = path.join(__dirname, 'public', 'logo-att.png');
const SECRET = process.env.JWT_SECRET || crypto.randomBytes(32).toString('hex');
fs.mkdirSync(ODS, { recursive: true });

// Almacenamiento: si defines DATABASE_URL (Neon, Supabase, etc.) todo se guarda en esa base de datos gratuita y no se pierde al reiniciar.
// Si no, se guarda en archivos dentro de DATA_DIR.
const USE_PG = !!process.env.DATABASE_URL;
let pool = null;
if (USE_PG) {
  const u = new URL(process.env.DATABASE_URL.trim().replace(/^["']|["']$/g, ''));
  ['sslmode', 'channel_binding'].forEach(k => u.searchParams.delete(k));
  pool = new (require('pg').Pool)({ connectionString: u.toString(), ssl: { rejectUnauthorized: false }, max: 4 });
}
let db = { usuarios: [], servicios: [] }, pend = false, guardando = false;
async function volcar() {
  guardando = true;
  while (pend) {
    pend = false;
    try { await pool.query('INSERT INTO estado (id, datos) VALUES (1, $1::jsonb) ON CONFLICT (id) DO UPDATE SET datos = EXCLUDED.datos', [JSON.stringify(db)]); }
    catch (e) { console.error('No se pudo guardar en la base de datos:', e.message); }
  }
  guardando = false;
}
const save = () => { if (!USE_PG) return fs.writeFileSync(FILE, JSON.stringify(db)); pend = true; if (!guardando) volcar(); };
async function cargar() {
  if (!USE_PG) { try { db = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch (e) {} return; }
  await pool.query('CREATE TABLE IF NOT EXISTS estado (id INT PRIMARY KEY, datos JSONB NOT NULL)');
  await pool.query('CREATE TABLE IF NOT EXISTS pdfs (nombre TEXT PRIMARY KEY, datos BYTEA NOT NULL, creado TIMESTAMPTZ DEFAULT now())');
  const r = await pool.query('SELECT datos FROM estado WHERE id = 1');
  if (r.rows[0]) db = r.rows[0].datos;
}
const t = v => String(v ?? '').trim(), nm = v => t(v).toUpperCase();

// Cuenta del coordinador.
// Si defines ADMIN_PASS, esa contraseña manda en cada arranque (sirve para recuperar el acceso).
// Si no, la cuenta nace con la contraseña inicial y el sistema obliga a cambiarla al entrar.
const ADMIN_USER = t(process.env.ADMIN_USER || 'cesar.admin').replace(/^["']|["']$/g, '').toLowerCase();
const ENV_PASS = t(process.env.ADMIN_PASS).replace(/^["']|["']$/g, '');
function sembrar() {
  db.usuarios = db.usuarios || []; db.servicios = db.servicios || [];
if (ENV_PASS) {
  const hash = bcrypt.hashSync(ENV_PASS, 10), c = db.usuarios.find(u => u.usuario === ADMIN_USER);
  if (c) { c.hash = hash; c.rol = 'coord'; delete c.debeCambiar; } else db.usuarios.push({ usuario: ADMIN_USER, nombre: 'Cesar Sanchez', rol: 'coord', hash });
  save(); console.log('Coordinador listo. Usuario:', ADMIN_USER);
} else {
  if (!db.usuarios.some(u => u.rol === 'coord')) db.usuarios.push({ usuario: ADMIN_USER, nombre: 'Cesar Sanchez', rol: 'coord', hash: bcrypt.hashSync('admin123', 10) });
  db.usuarios.forEach(u => { if (u.rol === 'coord' && bcrypt.compareSync('admin123', u.hash)) u.debeCambiar = true; });
  save(); console.log('Coordinador:', ADMIN_USER, '(si aún usa la contraseña inicial, se le pedirá cambiarla al entrar)');
}
}

const ok = (res, x = {}) => res.json({ exito: true, success: true, ...x });
const bad = (res, c, e) => res.status(c).json({ exito: false, success: false, error: e });
const auth = (req, res, next) => { try { req.u = jwt.verify((req.headers.authorization || '').slice(7), SECRET); next(); } catch (e) { bad(res, 401, 'Sesión no válida'); } };
const coord = (req, res, next) => req.u.rol === 'coord' ? next() : bad(res, 403, 'Solo el coordinador puede hacer esto');
const up = multer({ storage: multer.memoryStorage(), limits: { fileSize: 12 * 1024 * 1024 } });

const app = express();
app.set('trust proxy', 1);
app.use((req, res, next) => { res.set({ 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer' }); next(); });
app.use(cors()); app.use(express.json({ limit: '2mb' }));
app.get('/ods/:nombre', async (req, res) => {
  const n = req.params.nombre;
  if (!/^[\w.-]+\.pdf$/.test(n)) return res.status(404).end();
  const f = path.join(ODS, n);
  if (fs.existsSync(f)) return res.type('application/pdf').sendFile(f);
  if (USE_PG) { try { const r = await pool.query('SELECT datos FROM pdfs WHERE nombre = $1', [n]); if (r.rows[0]) return res.type('application/pdf').send(r.rows[0].datos); } catch (e) {} }
  res.status(404).type('text').send('Documento no encontrado');
});
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/version', (req, res) => res.json({ version: '3.5' }));   // para comprobar que corre el servidor nuevo

// ---------- Sesión ----------
const fallos = {};   // límite de intentos: 8 fallos por IP cada 15 minutos
app.post('/api/login', (req, res) => {
  const ip = req.ip, f = fallos[ip], vigente = f && Date.now() - f.t < 15 * 60e3;
  if (vigente && f.n >= 8) return bad(res, 429, 'Demasiados intentos. Espera 15 minutos e inténtalo de nuevo.');
  const u = db.usuarios.find(x => x.usuario === t(req.body.usuario).toLowerCase());
  if (!u || !bcrypt.compareSync(String(req.body.password || ''), u.hash)) {
    fallos[ip] = { n: vigente ? f.n + 1 : 1, t: Date.now() };
    console.log('Login fallido para "' + t(req.body.usuario) + '". Usuarios existentes:', db.usuarios.map(x => x.usuario).join(', '));
    return bad(res, 401, 'Usuario o contraseña incorrectos');
  }
  delete fallos[ip];
  const usuario = { usuario: u.usuario, nombre: u.nombre, rol: u.rol };
  ok(res, { token: jwt.sign(usuario, SECRET, { expiresIn: '12h' }), usuario: { ...usuario, debeCambiar: !!u.debeCambiar } });
});
app.get('/api/yo', auth, (req, res) => {
  const u = db.usuarios.find(x => x.usuario === req.u.usuario);
  if (!u) return bad(res, 401, 'Sesión no válida');
  ok(res, { usuario: { usuario: u.usuario, nombre: u.nombre, rol: u.rol, debeCambiar: !!u.debeCambiar } });
});
app.put('/api/yo/password', auth, (req, res) => {
  const u = db.usuarios.find(x => x.usuario === req.u.usuario), nueva = String(req.body.nueva || '');
  if (!u || !bcrypt.compareSync(String(req.body.actual || ''), u.hash)) return bad(res, 400, 'La contraseña actual no es correcta');
  if (nueva.length < 8 || nueva === 'admin123') return bad(res, 400, 'La nueva contraseña debe tener al menos 8 caracteres y no ser la inicial');
  u.hash = bcrypt.hashSync(nueva, 10); delete u.debeCambiar; save(); ok(res);
});

// ---------- Usuarios: coordinadores e instaladores ----------
app.get('/api/instaladores', auth, coord, (req, res) => ok(res, { instaladores: db.usuarios.filter(u => u.rol === 'tec').map(({ hash, ...u }) => u) }));
app.get('/api/usuarios', auth, coord, (req, res) => ok(res, { usuarios: db.usuarios.map(({ hash, ...u }) => u) }));
const crearUsuario = (req, res) => {
  const usuario = t(req.body.usuario).toLowerCase(), nombre = t(req.body.nombre), pass = String(req.body.password || ''), rol = req.body.rol === 'coord' ? 'coord' : 'tec';
  if (!usuario || !nombre || pass.length < 6) return bad(res, 400, 'Falta usuario, nombre o contraseña (mínimo 6 caracteres)');
  if (db.usuarios.some(u => u.usuario === usuario)) return bad(res, 409, 'Ese usuario ya existe');
  db.usuarios.push({ usuario, nombre, rol, hash: bcrypt.hashSync(pass, 10) }); save(); ok(res);
};
app.post('/api/instaladores', auth, coord, crearUsuario);
app.post('/api/usuarios', auth, coord, crearUsuario);
const cambiaPass = (req, res) => {
  const u = db.usuarios.find(x => x.usuario === req.params.usuario);
  if (!u || String(req.body.password || '').length < 6) return bad(res, 400, 'Usuario no encontrado o contraseña muy corta');
  u.hash = bcrypt.hashSync(req.body.password, 10); delete u.debeCambiar; save(); ok(res);
};
app.put('/api/instaladores/:usuario', auth, coord, cambiaPass);
app.put('/api/usuarios/:usuario', auth, coord, cambiaPass);
const borraUsuario = (req, res) => {
  const u = db.usuarios.find(x => x.usuario === req.params.usuario);
  if (!u) return bad(res, 404, 'Usuario no encontrado');
  if (u.usuario === req.u.usuario) return bad(res, 400, 'No puedes eliminar tu propia cuenta');
  if (u.rol === 'coord' && db.usuarios.filter(x => x.rol === 'coord').length < 2) return bad(res, 400, 'Debe quedar al menos un coordinador');
  db.usuarios = db.usuarios.filter(x => x !== u); save(); ok(res);
};
app.delete('/api/instaladores/:usuario', auth, coord, borraUsuario);
app.delete('/api/usuarios/:usuario', auth, coord, borraUsuario);

// ---------- Servicios ----------
const vista = s => ({ ...s, unidad: s.cliente, operador: s.tecnico });
app.get('/api/servicios', auth, (req, res) => {
  const l = req.u.rol === 'coord' ? db.servicios : db.servicios.filter(s => nm(s.tecnico) === nm(req.u.nombre));
  ok(res, { servicios: l.slice().reverse().map(vista) });
});
app.post('/api/servicios', auth, coord, (req, res) => {
  const b = req.body, folio = t(b.folioAcuerdo);
  if (!folio || !t(b.tecnicoAsignado)) return bad(res, 400, 'Falta el folio o el técnico');
  if (db.servicios.some(s => nm(s.folio) === nm(folio))) return bad(res, 409, 'Ya existe ese folio');
  db.servicios.push({ folio, tecnico: t(b.tecnicoAsignado), cliente: t(b.cliente), razon: t(b.razonSocial), lugar: t(b.lugarAtencion),
    recibe: t(b.recibe), contacto: t(b.contacto), ciudad: t(b.ciudad), edo: t(b.estado), motivo: t(b.motivo) || 'Instalación',
    fecha: t(b.fecha) || new Date().toLocaleDateString('es-MX'), hora: t(b.hora), camara: t(b.camara) || 'No', accesorios: t(b.accesorios),
    proveedor: t(b.proveedor) || 'ADMINISTRACION DE FLOTAS', instalador: t(b.instalador) || 'CS142W', estatus: 'Enviado', urlDoc: '' });
  save(); ok(res);
});
app.delete('/api/servicios/:folio', auth, coord, (req, res) => {
  const sv = db.servicios.find(s => nm(s.folio) === nm(req.params.folio));
  if (USE_PG && sv && sv.urlDoc) pool.query('DELETE FROM pdfs WHERE nombre = $1', [sv.urlDoc.replace('/ods/', '')]).catch(() => {});
  db.servicios = db.servicios.filter(s => nm(s.folio) !== nm(req.params.folio)); save(); ok(res);
});
// Alta masiva con tu Plantilla_servicios_ATT.xlsx
app.post('/api/servicios/importar', auth, coord, up.single('archivo'), (req, res) => {
  try {
    const wb = XLSX.read(req.file.buffer, { type: 'buffer' });
    const rows = XLSX.utils.sheet_to_json(wb.Sheets['Servicios'] || wb.Sheets[wb.SheetNames[0]], { header: 1, raw: false, defval: '' }).slice(1);
    let n = 0, dup = 0; const malas = [];
    rows.forEach((r, i) => {
      const [folio, tecnico, fecha, hora, motivo, camara, accesorios, cliente, razon, lugar, recibe, contacto, ciudad, edo, proveedor, instalador] = r.map(t);
      if (!folio || nm(folio) === 'EJEMPLO') return;
      if (![tecnico, fecha, hora, motivo, cliente, razon, lugar, recibe, contacto, ciudad, edo].every(Boolean)) return malas.push(i + 2);
      if (db.servicios.some(s => nm(s.folio) === nm(folio))) return dup++;
      db.servicios.push({ folio, tecnico, fecha, hora, motivo, camara: /^s/i.test(camara) ? 'Sí' : 'No', accesorios, cliente, razon, lugar, recibe, contacto,
        ciudad, edo, proveedor: proveedor || 'ADMINISTRACION DE FLOTAS', instalador: instalador || 'CS142W', estatus: 'Enviado', urlDoc: '' });
      n++;
    });
    save(); ok(res, { cargados: n, repetidos: dup, filasIncompletas: malas });
  } catch (e) { bad(res, 400, 'No se pudo leer el Excel'); }
});

// ---------- ODS en PDF ----------
const MOT = ['Instalación', 'Desinstalación', 'Reinstalación', 'Revisión', 'Reemplazo', 'Intercambio', 'Remover', 'Visita en falso'];
const CY = '#00A9E0';
function band(d, txt) {
  if (d.y > 690) d.addPage(); d.y += 6; const y = d.y;
  d.rect(40, y, 532, 18).fill(CY); d.fillColor('#fff').font('Helvetica-Bold').fontSize(10).text(txt, 40, y + 5, { width: 532, align: 'center' });
  d.fillColor('#111'); d.x = 40; d.y = y + 26;
}
function row(d, a) {
  if (d.y > 720) d.addPage(); const y = d.y, w = 532 / a.length; let e = y + 24;
  a.forEach(([l, v], i) => {
    const x = 40 + i * w;
    d.font('Helvetica').fontSize(7.5).fillColor('#666').text(l, x, y, { width: w - 8, lineBreak: false });
    d.fontSize(10).fillColor('#111').text(t(v) || ' ', x, y + 10, { width: w - 10 }); e = Math.max(e, d.y);
  });
  a.forEach((_, i) => { const x = 40 + i * (532 / a.length); d.moveTo(x, e + 1).lineTo(x + w - 8, e + 1).lineWidth(.4).strokeColor('#111').stroke(); });
  d.x = 40; d.y = e + 9;
}
const ELEC = ['Intermitentes/direccionales', 'Luces delanteras', 'Stop', 'Limpia parabrisas', 'Limpiador trasero',
  'Enciende algún testigo en el tablero', 'Encendedor', 'Radio', 'Elevadores eléctricos', 'Seguros eléctricos',
  '¿Cuenta con alarma? ¿funciona?', 'Espejos laterales eléctricos', 'Luces interiores', 'Cámara de reversa', 'Aire acondicionado', 'Claxon'];
function tablaElec(d, s) {
  if (!s.elec) return;
  if (d.y > 430) d.addPage();
  band(d, 'PARTES ELÉCTRICAS FUNCIONANDO');
  const x0 = 40, y0 = d.y, w1 = 215, w2 = 36, rh = 15, wt = w1 + 3 * w2;
  d.rect(x0, y0, wt, rh).fill('#4DB6E8'); d.fillColor('#fff').font('Helvetica-Bold').fontSize(8).text('Descripción', x0 + 4, y0 + 4, { width: w1, lineBreak: false });
  ['Sí', 'No', 'N/A'].forEach((h, i) => d.text(h, x0 + w1 + i * w2, y0 + 4, { width: w2, align: 'center', lineBreak: false }));
  ELEC.forEach((it, i) => {
    const y = y0 + rh * (i + 1);
    d.rect(x0, y, wt, rh).lineWidth(.5).strokeColor('#111').stroke();
    [w1, w1 + w2, w1 + 2 * w2].forEach(dx => d.moveTo(x0 + dx, y).lineTo(x0 + dx, y + rh).stroke());
    d.font('Helvetica').fontSize(8).fillColor('#111').text(it, x0 + 4, y + 4, { width: w1 - 6, lineBreak: false });
    const c = { 'Sí': 0, 'No': 1, 'N/A': 2 }[s.elec[it]];
    if (c !== undefined) d.font('Helvetica-Bold').fontSize(9).text('X', x0 + w1 + c * w2, y + 3.5, { width: w2, align: 'center', lineBreak: false });
  });
  const bx = x0 + wt + 16, bw = 532 - wt - 16, bh = rh * ELEC.length;
  d.font('Helvetica').fontSize(9).fillColor('#111').text('Observaciones', bx, y0 + 2, { width: bw, lineBreak: false });
  d.rect(bx, y0 + 16, bw, bh - 2).lineWidth(.5).strokeColor('#111').stroke();
  d.fontSize(9).text(t(s.obsElec), bx + 5, y0 + 21, { width: bw - 10, height: bh - 12 });
  d.x = 40; d.y = y0 + rh * (ELEC.length + 1) + 12;
}
function dataImg(u) { return u && u.startsWith('data:image') ? Buffer.from(u.split(',')[1], 'base64') : null; }

function renderODS(d, s, files, b) {
  if (fs.existsSync(LOGO)) d.image(LOGO, 40, 28, { height: 36 }); else d.font('Helvetica-Bold').fontSize(9).fillColor(CY).text('AT&T', 40, 40); d.fillColor('#111').font('Helvetica').fontSize(15).text('Orden de servicio de la flotilla', 40, 38, { width: 532, align: 'center' });
  d.y = 70; d.x = 40;
  row(d, [['Proveedor', s.proveedor], ['Folio acuerdo', s.folio]]); row(d, [['Instalador', s.instalador], ['Fecha de visita', `${s.fecha} ${s.hora || ''}`]]);
  band(d, 'MOTIVO DE LA VISITA');
  const y0 = d.y;
  MOT.forEach((m, i) => {
    const x = 40 + (i % 4) * 133, y = y0 + Math.floor(i / 4) * 20;
    d.rect(x, y, 11, 11).lineWidth(.8).strokeColor('#111').stroke();
    if (s.motivo === m) d.font('Helvetica-Bold').fontSize(10).fillColor('#111').text('X', x + 2.5, y + 1.5, { lineBreak: false });
    d.font('Helvetica').fontSize(9.5).fillColor('#111').text(m, x + 16, y + 1.5, { lineBreak: false });
  });
  d.x = 40; d.y = y0 + 46;
  row(d, [['Instalación accesorios', [s.camara === 'Sí' ? 'Cámara' : '', s.accesorios].filter(Boolean).join(', ')]]);
  band(d, 'DATOS GENERALES');
  [['Nombre del cliente', s.cliente], ['Razón social', s.razon], ['Lugar de atención', s.lugar], ['Nombre de quien recibe al técnico', s.recibe], ['Números de contacto', s.contacto], ['Ciudad', s.ciudad], ['Estado', s.edo]]
    .forEach(r => row(d, [r]));
  band(d, 'EQUIPO INSTALADO');
  row(d, [['Serie GO9', s.serie], ['IMEI cámara', s.imei]]); row(d, [['Arnés', s.arnes], ['Número de SIM', s.sim]]);
  row(d, [['Marca', s.marca], ['Modelo', s.modelo], ['Placas', s.placas]]); row(d, [['VIN', s.vin]]); row(d, [['Comentario del técnico / Observaciones', s.comentario]]);
  tablaElec(d, s);

  const fotos = [['Foto del adherible GO9', files.foto_adherible], ['Foto IMEI y SIM de cámara', files.foto_imei_camara], ['Foto del VIN', files.foto_vin]]
    .map(([l, a]) => [l, a && a[0]]).concat(Object.keys(files).filter(k => !['foto_adherible', 'foto_imei_camara', 'foto_vin'].includes(k))
      .flatMap(k => files[k].map((f, i) => [k === 'foto_tablero' ? 'Instalación ' + (i + 1) : k.replace(/^foto_/, '').replace(/_/g, ' '), f]))).filter(x => x[1]);
  if (fotos.length) {
    d.addPage(); band(d, 'EVIDENCIA FOTOGRÁFICA'); let col = 0, y = d.y;
    fotos.forEach(([l, f]) => {
      if (col === 0) { if (d.y > 540) d.addPage(); y = d.y; }
      const x = 40 + col * 272;
      try { d.image(f.buffer, x, y, { fit: [256, 175] }); } catch (e) { d.font('Helvetica').fontSize(8).fillColor('#a00').text('(formato de imagen no compatible, usa JPG o PNG)', x, y, { width: 256 }); }
      d.font('Helvetica').fontSize(8).fillColor('#555').text(l, x, y + 180, { width: 256 });
      if (++col === 2) { col = 0; d.y = y + 200; }
    });
    if (col) d.y = y + 200; d.x = 40;
  }
  if (d.y > 560) d.addPage(); band(d, 'FIRMAS'); const fy = d.y + 4;
  [[dataImg(b.firmaCliente), 'Nombre y firma de conformidad del cliente', b.nombreCliente || s.recibe], [dataImg(b.firmaTecnico), 'Nombre y firma del técnico', s.tecnico]].forEach(([img, l, n], i) => {
    const x = 40 + i * 280;
    if (img) try { d.image(img, x, fy, { fit: [240, 70] }); } catch (e) {}
    d.moveTo(x, fy + 76).lineTo(x + 240, fy + 76).lineWidth(.5).strokeColor('#111').stroke();
    d.font('Helvetica').fontSize(10).fillColor('#111').text(t(n), x, fy + 80, { width: 240 }); d.fontSize(7.5).fillColor('#666').text(l, x, fy + 94, { width: 240 });
  });
  d.x = 40; d.y = fy + 125;
  d.font('Helvetica').fontSize(7.5).fillColor('#555').text('Nota: Recuerda que antes de concluir tu visita, es necesario comunicarte a Call Center para que nuestro cliente responda la encuesta de satisfacción. Posteriormente debes compartir el estatus de tu visita al ejecutivo. CC: 55-7100-2854. Soporte Técnico CLIENTE comunicarse al 01 800 211 4012', 40, d.y, { width: 532 });
}

const campos = up.any();
const agrupa = l => (l || []).reduce((o, f) => ((o[f.fieldname] = o[f.fieldname] || []).push(f), o), {});
app.post('/api/generar-ods', auth, campos, async (req, res) => {
  try {
    const b = req.body, s = db.servicios.find(x => nm(x.folio) === nm(b.folioAcuerdo));
    if (!s) return bad(res, 404, 'Folio no encontrado');
    if (req.u.rol !== 'coord' && nm(s.tecnico) !== nm(req.u.nombre)) return bad(res, 403, 'Ese servicio no está asignado a ti');
    Object.assign(s, { serie: t(b.serialGo9), imei: t(b.imeiCamara), sim: t(b.numeroSim), arnes: t(b.arnes), marca: t(b.marcaVehiculo), modelo: t(b.modeloVehiculo),
      vin: t(b.vinVehiculo).toUpperCase(), placas: t(b.placasVehiculo).toUpperCase(), comentario: t(b.comentarioTecnico),
      elec: (() => { const e = {}; ELEC.forEach((it, i) => { const v = t(b['elec_' + i]); if (['Sí', 'No', 'N/A'].includes(v)) e[it] = v; }); return e; })(), obsElec: t(b.obsElec) });
    const name = `ODS_${s.folio.replace(/[^\w-]/g, '')}_${crypto.randomBytes(4).toString('hex')}.pdf`;
    const doc = new PDFDocument({ size: 'LETTER', margin: 40, bufferPages: true }), out = fs.createWriteStream(path.join(ODS, name));
    doc.pipe(out); renderODS(doc, s, agrupa(req.files), b);
    const rg = doc.bufferedPageRange(), gen = new Date().toLocaleString('es-MX', { timeZone: 'America/Mexico_City' });
    for (let i = 0; i < rg.count; i++) {
      doc.switchToPage(i); const mb = doc.page.margins.bottom; doc.page.margins.bottom = 0;
      doc.font('Helvetica').fontSize(8).fillColor('#888').text(`${s.folio}  ·  Página ${i + 1} de ${rg.count}  ·  Generado el ${gen}`, 40, 760, { width: 532, align: 'center', lineBreak: false });
      doc.page.margins.bottom = mb;
    }
    doc.end();
    await new Promise((r, j) => { out.on('finish', r); out.on('error', j); });
    if (USE_PG) {
      await pool.query('INSERT INTO pdfs (nombre, datos) VALUES ($1, $2) ON CONFLICT (nombre) DO NOTHING', [name, fs.readFileSync(path.join(ODS, name))]);
      fs.unlink(path.join(ODS, name), () => {});
    }
    s.estatus = 'Completado'; s.urlDoc = '/ods/' + name; save();
    ok(res, { descargaUrl: s.urlDoc });
  } catch (e) { console.error(e); bad(res, 500, 'No se pudo generar el PDF: ' + e.message); }
});

cargar().then(() => {
  sembrar();
  app.listen(PORT, () => console.log('FLOTAS en puerto ' + PORT + (USE_PG ? ' (datos en base de datos externa)' : ' (datos en archivo local)')));
}).catch(e => { console.error('No se pudo iniciar:', e.message); process.exit(1); });
