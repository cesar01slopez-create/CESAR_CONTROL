const express = require('express'), cors = require('cors'), multer = require('multer'), bcrypt = require('bcryptjs'),
  jwt = require('jsonwebtoken'), XLSX = require('xlsx'), PDFDocument = require('pdfkit'), fs = require('fs'),
  path = require('path'), crypto = require('crypto');
const L = require('./lib'), { leerFlota } = require('./geotab');

const PORT = process.env.PORT || 3000;
const APP_NAME = process.env.APP_NAME || 'ADF Control';
const DIR = process.env.DATA_DIR || __dirname;
const ODS = path.join(DIR, 'ods'), FILE = path.join(DIR, 'db.json');
const LOGO = path.join(__dirname, 'public', 'logo-att.png');
const P = (process.env.DB_PREFIX || 'adf_').toLowerCase().replace(/[^a-z0-9_]/g, '');   // prefijo de tablas: permite compartir la misma base con otra app
fs.mkdirSync(ODS, { recursive: true });

// ---------- Almacenamiento: base de datos externa (DATABASE_URL) o archivo local ----------
const USE_PG = !!process.env.DATABASE_URL;
let pool = null;
if (USE_PG) {
  const u = new URL(process.env.DATABASE_URL.trim().replace(/^["']|["']$/g, ''));
  ['sslmode', 'channel_binding'].forEach(k => u.searchParams.delete(k));
  pool = new (require('pg').Pool)({ connectionString: u.toString(), ssl: { rejectUnauthorized: false }, max: 4 });
}
let db = { usuarios: [], servicios: [], validaciones: [] }, pend = false, guardando = false;
async function volcar() {
  guardando = true;
  while (pend) {
    pend = false;
    try { await pool.query(`INSERT INTO ${P}estado (id, datos) VALUES (1, $1::jsonb) ON CONFLICT (id) DO UPDATE SET datos = EXCLUDED.datos`, [JSON.stringify(db)]); }
    catch (e) { console.error('No se pudo guardar en la base de datos:', e.message); }
  }
  guardando = false;
}
const save = () => { if (!USE_PG) return fs.writeFileSync(FILE, JSON.stringify(db)); pend = true; if (!guardando) volcar(); };
async function cargar() {
  if (!USE_PG) { try { db = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch (e) {} return; }
  await pool.query(`CREATE TABLE IF NOT EXISTS ${P}estado (id INT PRIMARY KEY, datos JSONB NOT NULL)`);
  await pool.query(`CREATE TABLE IF NOT EXISTS ${P}pdfs (nombre TEXT PRIMARY KEY, datos BYTEA NOT NULL, creado TIMESTAMPTZ DEFAULT now())`);
  const r = await pool.query(`SELECT datos FROM ${P}estado WHERE id = 1`);
  if (r.rows[0]) db = r.rows[0].datos;
}
const t = v => String(v ?? '').trim(), nm = v => t(v).toUpperCase();
const limpia = v => t(v).replace(/^["']|["']$/g, '');

// ---------- Cuenta inicial del coordinador ----------
// ADMIN_PASS (si existe) manda en cada arranque: sirve para recuperar el acceso. Sin ella la cuenta nace con admin123 y obliga a cambiarla.
const ADMIN_USER = limpia(process.env.ADMIN_USER || 'cesar.admin').toLowerCase(), ENV_PASS = limpia(process.env.ADMIN_PASS);
let SECRET = process.env.JWT_SECRET || '';
function sembrar() {
  db.usuarios = db.usuarios || []; db.servicios = db.servicios || []; db.validaciones = db.validaciones || [];
  if (!SECRET) { db.secret = db.secret || crypto.randomBytes(32).toString('hex'); SECRET = db.secret; }
  if (ENV_PASS) {
    const hash = bcrypt.hashSync(ENV_PASS, 10), c = db.usuarios.find(u => u.usuario === ADMIN_USER);
    if (c) { c.hash = hash; c.rol = 'coord'; c.activo = true; delete c.debeCambiar; }
    else db.usuarios.push({ usuario: ADMIN_USER, nombre: process.env.ADMIN_NAME || 'Coordinador', rol: 'coord', activo: true, hash });
  } else {
    if (!db.usuarios.some(u => u.rol === 'coord')) db.usuarios.push({ usuario: ADMIN_USER, nombre: process.env.ADMIN_NAME || 'Coordinador', rol: 'coord', activo: true, hash: bcrypt.hashSync('admin123', 10) });
    db.usuarios.forEach(u => { if (u.rol === 'coord' && bcrypt.compareSync('admin123', u.hash)) u.debeCambiar = true; });
  }
  save();
}

// ---------- Utilidades de API ----------
const ok = (res, x = {}) => res.json({ exito: true, success: true, ...x });
const bad = (res, c, e) => res.status(c).json({ exito: false, success: false, error: e });
const auth = (req, res, next) => {
  try {
    const p = jwt.verify((req.headers.authorization || '').slice(7), SECRET), u = db.usuarios.find(x => x.usuario === p.usuario);
    if (!u || u.activo === false) return bad(res, 401, 'Sesión no válida');
    req.u = { usuario: u.usuario, nombre: u.nombre, rol: u.rol }; next();
  } catch (e) { bad(res, 401, 'Sesión no válida'); }
};
const rol = (...r) => (req, res, next) => r.includes(req.u.rol) ? next() : bad(res, 403, 'No tienes permiso para hacer esto');
const up = multer({ storage: multer.memoryStorage(), limits: { fileSize: 12 * 1024 * 1024 } });
const ROLES = ['coord', 'tec', 'soporte'];
const publico = ({ hash, ...u }) => u;
const hhmm = v => /^\d{1,2}:\d{2}$/.test(t(v)) ? t(v) : '';

const app = express();
app.set('trust proxy', 1);
app.use((req, res, next) => { res.set({ 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer' }); next(); });
app.use(cors()); app.use(express.json({ limit: '2mb' }));

app.get('/ods/:nombre', async (req, res) => {
  const n = req.params.nombre;
  if (!/^[\w.-]+\.pdf$/.test(n)) return res.status(404).end();
  const f = path.join(ODS, n);
  if (fs.existsSync(f)) return res.type('application/pdf').sendFile(f);
  if (USE_PG) { try { const r = await pool.query(`SELECT datos FROM ${P}pdfs WHERE nombre = $1`, [n]); if (r.rows[0]) return res.type('application/pdf').send(r.rows[0].datos); } catch (e) {} }
  res.status(404).type('text').send('Documento no encontrado');
});
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/version', (req, res) => res.json({ version: '4.0', app: APP_NAME }));
const geotabCfg = () => process.env.GEOTAB_DATABASE && process.env.GEOTAB_USER && process.env.GEOTAB_PASSWORD
  ? { server: process.env.GEOTAB_SERVER, database: limpia(process.env.GEOTAB_DATABASE), user: limpia(process.env.GEOTAB_USER), password: limpia(process.env.GEOTAB_PASSWORD) } : null;
app.get('/api/config', (req, res) => ok(res, { nombre: APP_NAME, motivos: L.MOTIVOS, elec: L.ELEC, categorias: L.CATEGORIAS, geotab: !!geotabCfg() }));

// ---------- Sesión ----------
const fallos = {};   // 8 fallos por IP cada 15 minutos
app.post('/api/login', (req, res) => {
  const ip = req.ip, f = fallos[ip], vigente = f && Date.now() - f.t < 15 * 60e3;
  if (vigente && f.n >= 8) return bad(res, 429, 'Demasiados intentos. Espera 15 minutos e inténtalo de nuevo.');
  const u = db.usuarios.find(x => x.usuario === t(req.body.usuario).toLowerCase());
  if (!u || u.activo === false || !bcrypt.compareSync(String(req.body.password || ''), u.hash)) {
    fallos[ip] = { n: vigente ? f.n + 1 : 1, t: Date.now() };
    console.log('Login fallido para "' + t(req.body.usuario) + '".');
    return bad(res, 401, 'Usuario o contraseña incorrectos');
  }
  delete fallos[ip];
  const usuario = { usuario: u.usuario, nombre: u.nombre, rol: u.rol };
  ok(res, { token: jwt.sign(usuario, SECRET, { expiresIn: '12h' }), usuario: { ...usuario, debeCambiar: !!u.debeCambiar } });
});
app.get('/api/yo', auth, (req, res) => { const u = db.usuarios.find(x => x.usuario === req.u.usuario); ok(res, { usuario: { ...req.u, debeCambiar: !!u.debeCambiar } }); });
app.put('/api/yo/password', auth, (req, res) => {
  const u = db.usuarios.find(x => x.usuario === req.u.usuario), nueva = String(req.body.nueva || '');
  if (!bcrypt.compareSync(String(req.body.actual || ''), u.hash)) return bad(res, 400, 'La contraseña actual no es correcta');
  if (nueva.length < 8 || nueva === 'admin123') return bad(res, 400, 'La nueva contraseña debe tener al menos 8 caracteres y no ser la inicial');
  u.hash = bcrypt.hashSync(nueva, 10); delete u.debeCambiar; save(); ok(res);
});

// ---------- Usuarios (coordinadores, técnicos y soporte) ----------
app.get('/api/usuarios', auth, rol('coord'), (req, res) => ok(res, { usuarios: db.usuarios.map(publico) }));
app.post('/api/usuarios', auth, rol('coord'), (req, res) => {
  const usuario = t(req.body.usuario).toLowerCase().replace(/[^a-z0-9._-]/g, ''), nombre = t(req.body.nombre), pass = String(req.body.password || ''), r = t(req.body.rol);
  if (!usuario || !nombre || pass.length < 6 || !ROLES.includes(r)) return bad(res, 400, 'Falta usuario, nombre, rol o contraseña (mínimo 6 caracteres)');
  if (db.usuarios.some(u => u.usuario === usuario)) return bad(res, 409, 'Ese usuario ya existe');
  const n = { usuario, nombre, rol: r, activo: true, hash: bcrypt.hashSync(pass, 10) };
  if (r === 'soporte') { const i = hhmm(req.body.turnoInicio), f = hhmm(req.body.turnoFin); if (!i || !f) return bad(res, 400, 'Indica el horario de turno del soporte (inicio y fin)'); n.turno = { inicio: i, fin: f }; }
  db.usuarios.push(n); save(); ok(res);
});
app.put('/api/usuarios/:usuario', auth, rol('coord'), (req, res) => {
  const u = db.usuarios.find(x => x.usuario === req.params.usuario), b = req.body;
  if (!u) return bad(res, 404, 'Usuario no encontrado');
  const propio = u.usuario === req.u.usuario, coordsActivos = db.usuarios.filter(x => x.rol === 'coord' && x.activo !== false).length;
  if (b.password !== undefined) { if (String(b.password).length < 6) return bad(res, 400, 'La contraseña debe tener al menos 6 caracteres'); u.hash = bcrypt.hashSync(String(b.password), 10); delete u.debeCambiar; }
  if (b.activo !== undefined) {
    if (propio && !b.activo) return bad(res, 400, 'No puedes desactivar tu propia cuenta');
    if (!b.activo && u.rol === 'coord' && coordsActivos < 2) return bad(res, 400, 'Debe quedar al menos un coordinador activo');
    u.activo = !!b.activo;
  }
  if (b.rol !== undefined) {
    if (!ROLES.includes(b.rol)) return bad(res, 400, 'Rol no válido');
    if (propio && b.rol !== 'coord') return bad(res, 400, 'No puedes quitarte el rol de coordinador');
    if (u.rol === 'coord' && b.rol !== 'coord' && coordsActivos < 2) return bad(res, 400, 'Debe quedar al menos un coordinador activo');
    u.rol = b.rol;
  }
  if (b.nombre !== undefined && t(b.nombre)) u.nombre = t(b.nombre);
  if (b.turnoInicio !== undefined || b.turnoFin !== undefined) { const i = hhmm(b.turnoInicio), f = hhmm(b.turnoFin); if (i && f) u.turno = { inicio: i, fin: f }; }
  if (u.rol === 'soporte' && !u.turno) u.turno = { inicio: '07:00', fin: '15:00' };
  save(); ok(res);
});
app.delete('/api/usuarios/:usuario', auth, rol('coord'), (req, res) => {
  const u = db.usuarios.find(x => x.usuario === req.params.usuario);
  if (!u) return bad(res, 404, 'Usuario no encontrado');
  if (u.usuario === req.u.usuario) return bad(res, 400, 'No puedes eliminar tu propia cuenta');
  if (u.rol === 'coord' && db.usuarios.filter(x => x.rol === 'coord' && x.activo !== false).length < 2) return bad(res, 400, 'Debe quedar al menos un coordinador activo');
  db.usuarios = db.usuarios.filter(x => x !== u); save(); ok(res);
});

// ---------- Servicios ----------
app.get('/api/servicios', auth, (req, res) => {
  const l = req.u.rol === 'tec' ? db.servicios.filter(s => nm(s.tecnico) === nm(req.u.nombre)) : db.servicios;
  ok(res, { servicios: l.slice().reverse().map(s => ({ ...s, duracion: L.minutos(s) })) });
});
const nuevoServicio = o => ({ proveedor: 'ADMINISTRACION DE FLOTAS', instalador: 'CS142W', camara: 'No', accesorios: '', estatus: 'Enviado', urlDoc: '', creadoEn: Date.now(), ...o });
app.post('/api/servicios', auth, rol('coord'), (req, res) => {
  const b = req.body, folio = t(b.folioAcuerdo);
  if (!folio || !t(b.tecnicoAsignado)) return bad(res, 400, 'Falta el folio o el técnico');
  if (db.servicios.some(s => nm(s.folio) === nm(folio))) return bad(res, 409, 'Ya existe ese folio');
  db.servicios.push(nuevoServicio({ folio, tecnico: t(b.tecnicoAsignado), cliente: t(b.cliente), razon: t(b.razonSocial), lugar: t(b.lugarAtencion),
    recibe: t(b.recibe), contacto: t(b.contacto), ciudad: t(b.ciudad), edo: t(b.estado), motivo: t(b.motivo) || 'Instalación',
    fecha: t(b.fecha) || new Date(Date.now() - 6 * 3600e3).toISOString().slice(0, 10).split('-').reverse().join('/'), hora: t(b.hora),
    camara: t(b.camara) || 'No', accesorios: t(b.accesorios) }));
  save(); ok(res);
});
app.delete('/api/servicios/:folio', auth, rol('coord'), (req, res) => {
  const sv = db.servicios.find(s => nm(s.folio) === nm(req.params.folio));
  if (USE_PG && sv && sv.urlDoc) pool.query(`DELETE FROM ${P}pdfs WHERE nombre = $1`, [sv.urlDoc.replace('/ods/', '')]).catch(() => {});
  db.servicios = db.servicios.filter(s => nm(s.folio) !== nm(req.params.folio));
  db.validaciones = db.validaciones.filter(v => nm(v.folio) !== nm(req.params.folio)); save(); ok(res);
});
// El técnico abre el servicio: de aquí se mide el tiempo de servicio
app.post('/api/servicios/:folio/abrir', auth, rol('tec'), (req, res) => {
  const s = db.servicios.find(x => nm(x.folio) === nm(req.params.folio));
  if (!s || nm(s.tecnico) !== nm(req.u.nombre)) return bad(res, 404, 'Servicio no encontrado');
  if (s.estatus === 'Enviado') { s.estatus = 'En curso'; s.abiertoEn = Date.now(); save(); }
  ok(res);
});
app.post('/api/servicios/importar', auth, rol('coord'), up.single('archivo'), (req, res) => {
  try {
    const wb = XLSX.read(req.file.buffer, { type: 'buffer' });
    const rows = XLSX.utils.sheet_to_json(wb.Sheets['Servicios'] || wb.Sheets[wb.SheetNames[0]], { header: 1, raw: false, defval: '' }).slice(1);
    let n = 0, dup = 0; const malas = [];
    rows.forEach((r, i) => {
      const [folio, tecnico, fecha, hora, motivo, camara, accesorios, cliente, razon, lugar, recibe, contacto, ciudad, edo, proveedor, instalador] = r.map(t);
      if (!folio || nm(folio) === 'EJEMPLO') return;
      if (![tecnico, fecha, hora, motivo, cliente, razon, lugar, recibe, contacto, ciudad, edo].every(Boolean)) return malas.push(i + 2);
      if (db.servicios.some(s => nm(s.folio) === nm(folio))) return dup++;
      db.servicios.push(nuevoServicio({ folio, tecnico, fecha, hora, motivo, camara: /^s/i.test(camara) ? 'Sí' : 'No', accesorios, cliente, razon, lugar, recibe, contacto, ciudad, edo,
        ...(proveedor ? { proveedor } : {}), ...(instalador ? { instalador } : {}) }));
      n++;
    });
    save(); ok(res, { cargados: n, repetidos: dup, filasIncompletas: malas });
  } catch (e) { bad(res, 400, 'No se pudo leer el Excel'); }
});

// ---------- KPI ----------
app.get('/api/kpi', auth, rol('coord', 'soporte'), (req, res) => ok(res, L.kpi(db.servicios, t(req.query.periodo), t(req.query.desde), t(req.query.hasta))));

// ---------- Validaciones (solicitudes del técnico atendidas por soporte) ----------
app.get('/api/validaciones', auth, (req, res) => {
  const l = req.u.rol === 'tec' ? db.validaciones.filter(v => nm(v.tecnico) === nm(req.u.nombre)) : db.validaciones;
  ok(res, { validaciones: l.slice().reverse().map(v => ({ ...v, urlDoc: (db.servicios.find(s => nm(s.folio) === nm(v.folio)) || {}).urlDoc || '' })) });
});
app.post('/api/validaciones', auth, rol('tec', 'coord'), (req, res) => {
  const s = db.servicios.find(x => nm(x.folio) === nm(req.body.folio));
  if (!s) return bad(res, 404, 'Servicio no encontrado');
  if (req.u.rol === 'tec' && nm(s.tecnico) !== nm(req.u.nombre)) return bad(res, 403, 'Ese servicio no está asignado a ti');
  if (s.estatus !== 'Completado') return bad(res, 400, 'Primero termina la ODS del servicio');
  if (db.validaciones.some(v => nm(v.folio) === nm(s.folio) && ['Pendiente', 'En atención'].includes(v.estado))) return bad(res, 409, 'Ya hay una solicitud abierta para este folio');
  db.validaciones.push({ id: crypto.randomBytes(5).toString('hex'), folio: s.folio, tecnico: s.tecnico, cliente: s.cliente, motivo: s.motivo, nota: t(req.body.nota).slice(0, 500), estado: 'Pendiente', creadoEn: Date.now() });
  save(); ok(res);
});
app.put('/api/validaciones/:id/atender', auth, rol('soporte', 'coord'), (req, res) => {
  const v = db.validaciones.find(x => x.id === req.params.id);
  if (!v) return bad(res, 404, 'Solicitud no encontrada');
  if (v.estado !== 'Pendiente') return bad(res, 409, 'Esta solicitud ya fue tomada por ' + (v.soporteNombre || 'alguien más'));
  Object.assign(v, { estado: 'En atención', soporte: req.u.usuario, soporteNombre: req.u.nombre, atendidoEn: Date.now() }); save(); ok(res);
});
app.put('/api/validaciones/:id/resolver', auth, rol('soporte', 'coord'), (req, res) => {
  const v = db.validaciones.find(x => x.id === req.params.id), r = t(req.body.resultado);
  if (!v) return bad(res, 404, 'Solicitud no encontrada');
  if (v.estado !== 'En atención') return bad(res, 409, 'La solicitud debe estar en atención para resolverla');
  if (req.u.rol === 'soporte' && v.soporte !== req.u.usuario) return bad(res, 403, 'La está atendiendo ' + v.soporteNombre);
  if (!['Validada', 'Con observaciones'].includes(r)) return bad(res, 400, 'Resultado no válido');
  Object.assign(v, { estado: r, comentario: t(req.body.comentario).slice(0, 500), resueltoEn: Date.now() }); save(); ok(res);
});
app.delete('/api/validaciones/:id', auth, rol('coord'), (req, res) => { db.validaciones = db.validaciones.filter(v => v.id !== req.params.id); save(); ok(res); });

// ---------- Soporte en turno ----------
app.get('/api/turno', auth, (req, res) => ok(res, { turno: L.turno(db.usuarios, db.validaciones) }));

// ---------- Salud de equipos (Geotab), se lee cada 60 minutos ----------
let cache = null, leyendo = null;
app.get('/api/salud', auth, rol('coord', 'soporte'), async (req, res) => {
  const cfg = geotabCfg();
  if (!cfg) return ok(res, { configurado: false });
  const forzar = req.query.forzar === '1' && (!cache || Date.now() - cache.t > 5 * 60e3);
  try {
    if (!cache || forzar || Date.now() - cache.t > 60 * 60e3) {
      leyendo = leyendo || leerFlota(cfg).finally(() => { leyendo = null; });
      cache = { t: Date.now(), unidades: await leyendo };
    }
    ok(res, { configurado: true, actualizado: cache.t, unidades: cache.unidades });
  } catch (e) { console.error('Geotab:', e.message); bad(res, 502, 'No se pudo leer Geotab: ' + e.message); }
});

// ---------- ODS en PDF ----------
const MOT = L.MOTIVOS, ELEC = L.ELEC, CY = '#00A9E0';
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
  if (fs.existsSync(LOGO)) d.image(LOGO, 40, 28, { height: 36 }); else d.font('Helvetica-Bold').fontSize(9).fillColor(CY).text('AT&T', 40, 40);
  d.fillColor('#111').font('Helvetica').fontSize(15).text('Orden de servicio de la flotilla', 40, 38, { width: 532, align: 'center' });
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
  row(d, [['Marca', s.marca], ['Modelo', s.modelo], ['Placas', s.placas]]); row(d, [['VIN', s.vin]]); row(d, [['Comentario del técnico', s.comentario]]);
  tablaElec(d, s);

  const fotos = [['Foto del adherible GO9', files.foto_adherible], ['Foto IMEI y SIM de cámara', files.foto_imei_camara], ['Foto del VIN', files.foto_vin]]
    .map(([l, a]) => [l, a && a[0]]).concat(Object.keys(files).filter(k => !['foto_adherible', 'foto_imei_camara', 'foto_vin'].includes(k))
      .flatMap(k => files[k].map((f, i) => [k === 'foto_tablero' ? 'Instalación ' + (i + 1) : k.replace(/^foto_/, '').replace(/_/g, ' '), f]))).filter(x => x[1]);
  if (fotos.length) {
    if (d.y > 420) d.addPage();
    band(d, 'EVIDENCIA FOTOGRÁFICA'); let col = 0, y = d.y;
    fotos.forEach(([l, f]) => {
      if (col === 0) { if (d.y > 540) { d.addPage(); } y = d.y; }
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

const agrupa = l => (l || []).reduce((o, f) => ((o[f.fieldname] = o[f.fieldname] || []).push(f), o), {});
app.post('/api/generar-ods', auth, rol('tec', 'coord'), up.any(), async (req, res) => {
  try {
    const b = req.body, s = db.servicios.find(x => nm(x.folio) === nm(b.folioAcuerdo));
    if (!s) return bad(res, 404, 'Folio no encontrado');
    if (req.u.rol === 'tec' && nm(s.tecnico) !== nm(req.u.nombre)) return bad(res, 403, 'Ese servicio no está asignado a ti');
    const elec = {}; ELEC.forEach((it, i) => { const v = t(b['elec_' + i]); if (['Sí', 'No', 'N/A'].includes(v)) elec[it] = v; });
    Object.assign(s, { serie: t(b.serialGo9), imei: t(b.imeiCamara), sim: t(b.numeroSim), arnes: t(b.arnes), marca: t(b.marcaVehiculo), modelo: t(b.modeloVehiculo),
      vin: t(b.vinVehiculo).toUpperCase(), placas: t(b.placasVehiculo).toUpperCase(), comentario: t(b.comentarioTecnico), elec, obsElec: t(b.obsElec) });
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
      await pool.query(`INSERT INTO ${P}pdfs (nombre, datos) VALUES ($1, $2) ON CONFLICT (nombre) DO NOTHING`, [name, fs.readFileSync(path.join(ODS, name))]);
      fs.unlink(path.join(ODS, name), () => {});
    }
    s.estatus = 'Completado'; s.urlDoc = '/ods/' + name; s.completadoEn = Date.now(); save();
    ok(res, { descargaUrl: s.urlDoc });
  } catch (e) { console.error(e); bad(res, 500, 'No se pudo generar el PDF: ' + e.message); }
});

cargar().then(() => {
  sembrar();
  app.listen(PORT, () => console.log(APP_NAME + ' en puerto ' + PORT + (USE_PG ? ' (datos en base de datos externa)' : ' (datos en archivo local)') + (geotabCfg() ? ' · Geotab configurado' : '')));
}).catch(e => { console.error('No se pudo iniciar:', e.message); process.exit(1); });
