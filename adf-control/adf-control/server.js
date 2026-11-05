const express = require('express'), cors = require('cors'), multer = require('multer'), bcrypt = require('bcryptjs'),
  jwt = require('jsonwebtoken'), XLSX = require('xlsx'), PDFDocument = require('pdfkit'), fs = require('fs'),
  path = require('path'), crypto = require('crypto');
const L = require('./lib'), { leerFlota } = require('./geotab');

const PORT = process.env.PORT || 3000;
const APP_NAME = process.env.APP_NAME || 'Órdenes de Servicio';
const EMPRESA = process.env.EMPRESA || APP_NAME;
const BRAND = /^#[0-9a-fA-F]{6}$/.test(process.env.BRAND_COLOR || '') ? process.env.BRAND_COLOR : '#0f766e';
const TAGLINE = process.env.APP_TAGLINE || 'Órdenes de servicio y seguimiento de instalaciones';
const NOTA_PDF = process.env.PDF_NOTE || '';
const USE_ELEC = process.env.ELEC_TABLE !== '0';
const DIR = process.env.DATA_DIR || __dirname;
const ODS = path.join(DIR, 'ods'), FILE = path.join(DIR, 'db.json');
const LOGO = path.join(__dirname, 'public', 'logo.png');
const P = (process.env.DB_PREFIX || 'adf_').toLowerCase().replace(/[^a-z0-9_]/g, '');
fs.mkdirSync(ODS, { recursive: true });

// ---------- Almacenamiento: base de datos externa (DATABASE_URL) o archivo local ----------
const USE_PG = !!process.env.DATABASE_URL;
let pool = null;
if (USE_PG) {
  const u = new URL(process.env.DATABASE_URL.trim().replace(/^["']|["']$/g, ''));
  ['sslmode', 'channel_binding'].forEach(k => u.searchParams.delete(k));
  pool = new (require('pg').Pool)({ connectionString: u.toString(), ssl: { rejectUnauthorized: false }, max: 4 });
}
let db = { usuarios: [], servicios: [], validaciones: [], config: {} }, pend = false, guardando = false;
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
// Archivos (PDF, fotos pendientes de firma, firma del técnico, logo): en la base de datos o en la carpeta local
async function blobPut(n, buf) {
  if (USE_PG) await pool.query(`INSERT INTO ${P}pdfs (nombre, datos) VALUES ($1, $2) ON CONFLICT (nombre) DO UPDATE SET datos = EXCLUDED.datos`, [n, buf]);
  else fs.writeFileSync(path.join(ODS, n), buf);
}
async function blobGet(n) {
  if (USE_PG) { const r = await pool.query(`SELECT datos FROM ${P}pdfs WHERE nombre = $1`, [n]); return r.rows[0] ? r.rows[0].datos : null; }
  const f = path.join(ODS, n); return fs.existsSync(f) ? fs.readFileSync(f) : null;
}
async function blobDel(n) {
  if (!n) return;
  try { if (USE_PG) await pool.query(`DELETE FROM ${P}pdfs WHERE nombre = $1`, [n]); else fs.unlink(path.join(ODS, n), () => {}); } catch (e) {}
}
const t = v => String(v ?? '').trim(), nm = v => t(v).toUpperCase();
const limpia = v => t(v).replace(/^["']|["']$/g, '');

// ---------- Configuración (variables de Render + cambios hechos desde el panel) ----------
function conf() {
  const c = db.config || {};
  return {
    nombre: t(c.nombre) || APP_NAME, empresa: t(c.empresa) || EMPRESA,
    color: /^#[0-9a-fA-F]{6}$/.test(c.color || '') ? c.color : BRAND, lema: c.lema !== undefined ? t(c.lema) : TAGLINE,
    nota: c.nota !== undefined ? t(c.nota) : NOTA_PDF,
    formatos: L.normFormatos(c.formatos, { campos: c.campos, elec: c.elec !== undefined ? !!c.elec : USE_ELEC }), logo: !!c.logo };
}

// ---------- Cuenta inicial del coordinador ----------
const ADMIN_USER = limpia(process.env.ADMIN_USER || 'cesar.admin').toLowerCase(), ENV_PASS = limpia(process.env.ADMIN_PASS);
let SECRET = process.env.JWT_SECRET || '';
function sembrar() {
  db.usuarios = db.usuarios || []; db.servicios = db.servicios || []; db.validaciones = db.validaciones || []; db.config = db.config || {};
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
    req.u = { usuario: u.usuario, nombre: u.nombre, rol: u.rol, cliente: u.cliente || '', telefono: u.telefono || '' }; next();
  } catch (e) { bad(res, 401, 'Sesión no válida'); }
};
const rol = (...r) => (req, res, next) => r.includes(req.u.rol) ? next() : bad(res, 403, 'No tienes permiso para hacer esto');
const up = multer({ storage: multer.memoryStorage(), limits: { fileSize: 12 * 1024 * 1024 } });
const ROLES = ['coord', 'tec', 'soporte', 'cliente'];
const publico = ({ hash, ...u }) => u;
const hhmm = v => /^\d{1,2}:\d{2}$/.test(t(v)) ? t(v) : '';
// Servicios que puede ver cada usuario; y versión sin datos internos (tokens, archivos)
const visibles = u => u.rol === 'tec' ? db.servicios.filter(s => nm(s.tecnico) === nm(u.nombre))
  : u.rol === 'cliente' ? db.servicios.filter(s => u.cliente && nm(s.cliente) === nm(u.cliente)) : db.servicios;
const pub = ({ firmaToken, firmaExp, fotosMeta, firmaTecBlob, firmando, uid, firmaInfo, ...r }) => ({ ...r, firmadoRemoto: !!firmaInfo });
const dataImg = u => u && String(u).startsWith('data:image') ? Buffer.from(String(u).split(',')[1], 'base64') : null;

const app = express();
app.set('trust proxy', 1);
app.use((req, res, next) => { res.set({ 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'SAMEORIGIN', 'Referrer-Policy': 'no-referrer' }); next(); });
app.use(cors()); app.use(express.json({ limit: '2mb' }));

app.get('/ods/:nombre', async (req, res) => {
  const n = req.params.nombre;
  if (!/^[\w.-]+\.pdf$/.test(n)) return res.status(404).end();
  try { const b = await blobGet(n); if (b) return res.type('application/pdf').send(b); } catch (e) {}
  res.status(404).type('text').send('Documento no encontrado');
});
// Logo: el que sube el coordinador desde el panel, o public/logo.png
app.get('/logo', async (req, res) => {
  let b = null; try { b = await blobGet('logo_marca'); } catch (e) {}
  if (!b && fs.existsSync(LOGO)) b = fs.readFileSync(LOGO);
  if (!b) return res.status(404).end();
  res.set('Cache-Control', 'no-cache').type(b[0] === 0xFF ? 'image/jpeg' : 'image/png').send(b);
});
app.get('/firmar/:token', (req, res) => res.sendFile(path.join(__dirname, 'public', 'firmar.html')));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/version', (req, res) => res.json({ version: '5.0', app: conf().nombre }));
const geotabCfg = () => process.env.GEOTAB_DATABASE && process.env.GEOTAB_USER && process.env.GEOTAB_PASSWORD
  ? { server: process.env.GEOTAB_SERVER, database: limpia(process.env.GEOTAB_DATABASE), user: limpia(process.env.GEOTAB_USER), password: limpia(process.env.GEOTAB_PASSWORD) } : null;
app.get('/api/config', (req, res) => { const c = conf(); ok(res, { ...c, motivos: L.MOTIVOS, elecItems: L.ELEC, categorias: L.CATEGORIAS, geotab: !!geotabCfg() }); });
app.put('/api/config', auth, rol('coord'), (req, res) => {
  const b = req.body, c = db.config = db.config || {};
  if (b.nombre !== undefined) c.nombre = t(b.nombre).slice(0, 60);
  if (b.empresa !== undefined) c.empresa = t(b.empresa).slice(0, 80);
  if (b.lema !== undefined) c.lema = t(b.lema).slice(0, 120);
  if (b.nota !== undefined) c.nota = t(b.nota).slice(0, 600);
  if (b.color !== undefined) { if (!/^#[0-9a-fA-F]{6}$/.test(t(b.color))) return bad(res, 400, 'Color no válido'); c.color = t(b.color); }
  if (b.formatos !== undefined) c.formatos = L.normFormatos(b.formatos, {});
  save(); ok(res, { config: conf() });
});
app.post('/api/config/logo', auth, rol('coord'), up.single('logo'), async (req, res) => {
  const f = req.file;
  if (!f) return bad(res, 400, 'Elige una imagen');
  if (f.size > 1024 * 1024) return bad(res, 400, 'El logo debe pesar menos de 1 MB');
  const png = f.buffer[0] === 0x89 && f.buffer[1] === 0x50, jpg = f.buffer[0] === 0xFF && f.buffer[1] === 0xD8;
  if (!png && !jpg) return bad(res, 400, 'Usa una imagen PNG o JPG');
  try { await blobPut('logo_marca', f.buffer); db.config = db.config || {}; db.config.logo = true; save(); ok(res); }
  catch (e) { bad(res, 500, 'No se pudo guardar el logo'); }
});
app.delete('/api/config/logo', auth, rol('coord'), async (req, res) => { await blobDel('logo_marca'); db.config = db.config || {}; db.config.logo = false; save(); ok(res); });

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

// ---------- Usuarios (coordinadores, técnicos, soporte y clientes) ----------
app.get('/api/usuarios', auth, rol('coord'), (req, res) => ok(res, { usuarios: db.usuarios.map(publico) }));
app.post('/api/usuarios', auth, rol('coord'), (req, res) => {
  const usuario = t(req.body.usuario).toLowerCase().replace(/[^a-z0-9._-]/g, ''), nombre = t(req.body.nombre), pass = String(req.body.password || ''), r = t(req.body.rol);
  if (!usuario || !nombre || pass.length < 6 || !ROLES.includes(r)) return bad(res, 400, 'Falta usuario, nombre, rol o contraseña (mínimo 6 caracteres)');
  if (db.usuarios.some(u => u.usuario === usuario)) return bad(res, 409, 'Ese usuario ya existe');
  const n = { usuario, nombre, rol: r, activo: true, hash: bcrypt.hashSync(pass, 10) };
  if (t(req.body.telefono)) n.telefono = t(req.body.telefono).slice(0, 30);
  if (r === 'soporte') { const i = hhmm(req.body.turnoInicio), f = hhmm(req.body.turnoFin); if (!i || !f) return bad(res, 400, 'Indica el horario de turno del soporte (inicio y fin)'); n.turno = { inicio: i, fin: f }; }
  if (r === 'cliente') { if (!t(req.body.cliente)) return bad(res, 400, 'Escribe el nombre del cliente tal como aparece en sus órdenes'); n.cliente = t(req.body.cliente); }
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
  if (b.telefono !== undefined) { if (t(b.telefono)) u.telefono = t(b.telefono).slice(0, 30); else delete u.telefono; }
  if (b.cliente !== undefined && t(b.cliente)) u.cliente = t(b.cliente);
  if (b.turnoInicio !== undefined || b.turnoFin !== undefined) { const i = hhmm(b.turnoInicio), f = hhmm(b.turnoFin); if (i && f) u.turno = { inicio: i, fin: f }; }
  if (u.rol === 'soporte' && !u.turno) u.turno = { inicio: '07:00', fin: '15:00' };
  if (u.rol === 'cliente' && !u.cliente) return bad(res, 400, 'Escribe el nombre del cliente');
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
app.get('/api/servicios', auth, (req, res) => ok(res, { servicios: visibles(req.u).slice().reverse().map(s => ({ ...pub(s), duracion: L.minutos(s) })) }));
const fmtDe = s => { const f = conf().formatos; return f.find(x => x.id === s.formato) || f[0]; };
const nuevoServicio = o => ({ formato: conf().formatos[0].id, proveedor: conf().empresa, instalador: '', camara: 'No', accesorios: '', estatus: 'Enviado', urlDoc: '', creadoEn: Date.now(), ...o });
app.post('/api/servicios', auth, rol('coord'), (req, res) => {
  const b = req.body, folio = t(b.folioAcuerdo);
  if (!folio || !t(b.tecnicoAsignado)) return bad(res, 400, 'Falta el folio o el técnico');
  if (db.servicios.some(s => nm(s.folio) === nm(folio))) return bad(res, 409, 'Ya existe ese folio');
  db.servicios.push(nuevoServicio({ folio, tecnico: t(b.tecnicoAsignado), cliente: t(b.cliente), razon: t(b.razonSocial), lugar: t(b.lugarAtencion),
    recibe: t(b.recibe), contacto: t(b.contacto), ciudad: t(b.ciudad), edo: t(b.estado), motivo: t(b.motivo) || 'Instalación',
    fecha: t(b.fecha) || new Date(Date.now() - 6 * 3600e3).toISOString().slice(0, 10).split('-').reverse().join('/'), hora: t(b.hora),
    camara: t(b.camara) || 'No', accesorios: t(b.accesorios), ...(conf().formatos.some(f => f.id === b.formato) ? { formato: b.formato } : {}) }));
  save(); ok(res);
});
async function borraArchivos(s) {
  await blobDel(s.urlDoc ? s.urlDoc.replace('/ods/', '') : ''); await blobDel(s.firmaTecBlob);
  for (const m of (s.fotosMeta || [])) await blobDel(m.nombre);
}
app.delete('/api/servicios/:folio', auth, rol('coord'), async (req, res) => {
  const sv = db.servicios.find(s => nm(s.folio) === nm(req.params.folio));
  if (sv) await borraArchivos(sv);
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

// ---------- Agenda e historial por unidad ----------
app.get('/api/agenda', auth, (req, res) => {
  const q = req.query, l = L.agenda(visibles(req.u), t(q.periodo) || '7dias', t(q.desde), t(q.hasta), Date.now(), q.todos === '1');
  ok(res, { agenda: l.map(pub) });
});
app.get('/api/unidades', auth, (req, res) => ok(res, { unidades: L.unidades(visibles(req.u), t(req.query.q)).slice(0, 60) }));

// ---------- KPI ----------
app.get('/api/kpi', auth, rol('coord', 'soporte'), (req, res) => ok(res, L.kpi(db.servicios, t(req.query.periodo), t(req.query.desde), t(req.query.hasta))));

// ---------- Validaciones (solicitudes del técnico atendidas por soporte) ----------
app.get('/api/validaciones', auth, rol('coord', 'soporte', 'tec'), (req, res) => {
  const l = req.u.rol === 'tec' ? db.validaciones.filter(v => nm(v.tecnico) === nm(req.u.nombre)) : db.validaciones;
  ok(res, { validaciones: l.slice().reverse().map(v => ({ ...v, urlDoc: (db.servicios.find(s => nm(s.folio) === nm(v.folio)) || {}).urlDoc || '' })) });
});
app.post('/api/validaciones', auth, rol('tec', 'coord'), (req, res) => {
  const s = db.servicios.find(x => nm(x.folio) === nm(req.body.folio));
  if (!s) return bad(res, 404, 'Servicio no encontrado');
  if (req.u.rol === 'tec' && nm(s.tecnico) !== nm(req.u.nombre)) return bad(res, 403, 'Ese servicio no está asignado a ti');
  if (s.estatus !== 'Completado') return bad(res, 400, 'La orden debe estar firmada por el cliente para solicitar validación');
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
const MOT = L.MOTIVOS, ELEC = L.ELEC;
let CY = BRAND;
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

function renderODS(d, s, files, b, C, logo, F) {
  CY = C.color;
  let conLogo = false;
  if (F.logo && logo) { try { d.image(logo, 40, 26, { height: 38 }); conLogo = true; } catch (e) {} }
  d.fillColor('#111').font('Helvetica-Bold').fontSize(16).text(F.titulo, 40, 32, { width: 532, align: 'center' });
  if (C.empresa) d.font('Helvetica').fontSize(9).fillColor('#666').text(C.empresa, 40, 53, { width: 532, align: 'center' });
  d.moveTo(40, 69).lineTo(572, 69).lineWidth(1.2).strokeColor(CY).stroke();
  d.y = 78; d.x = 40;
  row(d, [['Empresa', s.proveedor], ['Folio', s.folio]]); row(d, [['Técnico', s.tecnico], ['Fecha de visita', `${s.fecha} ${s.hora || ''}`]]);
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
  const campos = F.campos.filter(c => c.on);
  for (let i = 0; i < campos.length; i += 2) row(d, campos.slice(i, i + 2).map(c => [c.label, s[c.k]]));
  row(d, [['Comentario del técnico', s.comentario]]);
  tablaElec(d, s);

  const fotos = [['Foto del dispositivo (serie)', files.foto_adherible], ['Foto del IMEI / SIM', files.foto_imei_camara], ['Foto de placas / unidad', files.foto_vin]]
    .map(([l, a]) => [l, a && a[0]]).concat(Object.keys(files).filter(k => !['foto_adherible', 'foto_imei_camara', 'foto_vin'].includes(k))
      .flatMap(k => files[k].map((f, i) => [k === 'foto_tablero' ? 'Instalación ' + (i + 1) : k.replace(/^foto_/, '').replace(/_/g, ' '), f]))).filter(x => x[1]);
  if (fotos.length && F.fotos) {
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
  d.x = 40; d.y = fy + 120;
  if (s.firmaInfo) d.font('Helvetica').fontSize(7.5).fillColor('#555').text('Firma del cliente capturada de forma remota mediante link seguro el ' + new Date(s.firmaInfo.ts).toLocaleString('es-MX', { timeZone: 'America/Mexico_City' }) + '.', 40, d.y, { width: 532 });
  if (C.nota) { d.moveDown(0.5); d.font('Helvetica').fontSize(7.5).fillColor('#555').text(C.nota, 40, d.y, { width: 532 }); }
}

async function renderPdf(s, files, b) {
  const C = conf(); let logo = null;
  try { logo = await blobGet('logo_marca'); } catch (e) {}
  if (!logo && fs.existsSync(LOGO)) logo = fs.readFileSync(LOGO);
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: 'LETTER', margin: 40, bufferPages: true }), chunks = [];
      doc.on('data', c => chunks.push(c)); doc.on('end', () => resolve(Buffer.concat(chunks))); doc.on('error', reject);
      renderODS(doc, s, files, b, C, logo, fmtDe(s));
      const rg = doc.bufferedPageRange(), gen = new Date().toLocaleString('es-MX', { timeZone: 'America/Mexico_City' });
      for (let i = 0; i < rg.count; i++) {
        doc.switchToPage(i); const mb = doc.page.margins.bottom; doc.page.margins.bottom = 0;
        doc.font('Helvetica').fontSize(8).fillColor('#888').text(`${s.folio}  ·  Página ${i + 1} de ${rg.count}  ·  Generado el ${gen}`, 40, 760, { width: 532, align: 'center', lineBreak: false });
        doc.page.margins.bottom = mb;
      }
      doc.end();
    } catch (e) { reject(e); }
  });
}
const agrupa = l => (l || []).reduce((o, f) => ((o[f.fieldname] = o[f.fieldname] || []).push(f), o), {});
const uidDe = s => s.uid || (s.uid = crypto.randomBytes(6).toString('hex'));
async function cierraConPdf(s, files, b) {
  const buf = await renderPdf(s, files, b);
  const nombre = `ODS_${s.folio.replace(/[^\w-]/g, '')}_${crypto.randomBytes(4).toString('hex')}.pdf`;
  await blobPut(nombre, buf);
  await blobDel(s.urlDoc ? s.urlDoc.replace('/ods/', '') : '');
  s.urlDoc = '/ods/' + nombre; s.estatus = 'Completado'; s.completadoEn = Date.now();
  if (!s.terminadoEn) s.terminadoEn = s.completadoEn;
}
const nuevoToken = s => { s.firmaToken = crypto.randomBytes(24).toString('hex'); s.firmaExp = Date.now() + 7 * 864e5; return '/firmar/' + s.firmaToken; };

app.post('/api/generar-ods', auth, rol('tec', 'coord'), up.any(), async (req, res) => {
  try {
    const b = req.body, s = db.servicios.find(x => nm(x.folio) === nm(b.folioAcuerdo));
    if (!s) return bad(res, 404, 'Folio no encontrado');
    if (req.u.rol === 'tec' && nm(s.tecnico) !== nm(req.u.nombre)) return bad(res, 403, 'Ese servicio no está asignado a ti');
    if (s.estatus === 'Completado' && req.u.rol === 'tec') return bad(res, 409, 'Esta orden ya fue firmada y cerrada');
    if (s.firmando) return bad(res, 409, 'Esta orden se está firmando en este momento');
    const C = conf(), F = fmtDe(s), falta = F.campos.filter(c => c.on && c.req && !t(b[c.k]));
    if (falta.length) return bad(res, 400, 'Falta: ' + falta.map(c => c.label).join(', '));
    if (!dataImg(b.firmaTecnico)) return bad(res, 400, 'Falta la firma del técnico');
    s.formato = F.id;
    F.campos.forEach(c => { if (c.on) s[c.k] = c.k === 'placas' ? t(b[c.k]).toUpperCase() : t(b[c.k]); });
    s.comentario = t(b.comentarioTecnico);
    if (F.elec) { const e = {}; ELEC.forEach((it, i) => { const v = t(b['elec_' + i]); if (['Sí', 'No', 'N/A'].includes(v)) e[it] = v; }); s.elec = e; s.obsElec = t(b.obsElec); }
    else { delete s.elec; delete s.obsElec; }
    s.terminadoEn = Date.now();
    const files = agrupa(req.files), firmaC = dataImg(b.firmaCliente);
    await borraArchivos({ fotosMeta: s.fotosMeta, firmaTecBlob: s.firmaTecBlob }); s.fotosMeta = []; s.firmaTecBlob = '';
    if (firmaC) {
      await cierraConPdf(s, files, b); s.firmaToken = null; delete s.firmaInfo;
      save(); return ok(res, { descargaUrl: s.urlDoc });
    }
    // El cliente no está: se guardan fotos y firma del técnico, y se genera un link para que firme desde su celular
    const uid = uidDe(s); let n = 0; s.fotosMeta = [];
    for (const campo of Object.keys(files)) for (const f of files[campo]) { const nombre = `fp_${uid}_${n++}.jpg`; await blobPut(nombre, f.buffer); s.fotosMeta.push({ campo, nombre }); }
    s.firmaTecBlob = `ft_${uid}.png`; await blobPut(s.firmaTecBlob, dataImg(b.firmaTecnico));
    s.nombreCliente = t(b.nombreCliente);
    s.estatus = 'Pendiente de firma'; const firmaUrl = nuevoToken(s);
    save(); ok(res, { pendienteFirma: true, firmaUrl, folio: s.folio, contacto: s.contacto });
  } catch (e) { console.error(e); bad(res, 500, 'No se pudo generar la orden: ' + e.message); }
});

// ---------- Link de firma remota del cliente ----------
app.post('/api/servicios/:folio/link-firma', auth, rol('tec', 'coord'), (req, res) => {
  const s = db.servicios.find(x => nm(x.folio) === nm(req.params.folio));
  if (!s || (req.u.rol === 'tec' && nm(s.tecnico) !== nm(req.u.nombre))) return bad(res, 404, 'Servicio no encontrado');
  if (s.estatus !== 'Pendiente de firma') return bad(res, 400, 'Esta orden no está esperando firma');
  const firmaUrl = (s.firmaToken && Date.now() < s.firmaExp) ? '/firmar/' + s.firmaToken : nuevoToken(s);
  save(); ok(res, { firmaUrl, folio: s.folio, contacto: s.contacto, cliente: s.cliente });
});
const hits = {};
const limite = (req, res, next) => {   // máximo 40 consultas por minuto por IP en las páginas públicas de firma
  const m = Math.floor(Date.now() / 60e3), h = hits[req.ip] && hits[req.ip].m === m ? hits[req.ip] : (hits[req.ip] = { m, n: 0 });
  if (++h.n > 40) return bad(res, 429, 'Demasiados intentos, espera un minuto'); next();
};
const porToken = tk => tk && tk.length >= 32 ? db.servicios.find(s => s.firmaToken === tk && s.estatus === 'Pendiente de firma') : null;
app.get('/api/firma/:token', limite, (req, res) => {
  const s = porToken(req.params.token), C = conf(), F = s ? fmtDe(s) : null;
  if (!s) return bad(res, 404, 'Este link ya no es válido o la orden ya fue firmada.');
  if (Date.now() > s.firmaExp) return bad(res, 410, 'Este link venció. Pide al técnico que te envíe uno nuevo.');
  ok(res, { nombre: C.nombre, empresa: C.empresa, color: C.color, tieneLogo: F.logo && (C.logo || fs.existsSync(LOGO)),
    orden: { folio: s.folio, cliente: s.cliente, lugar: s.lugar, ciudad: s.ciudad, fecha: s.fecha, hora: s.hora, motivo: s.motivo, tecnico: s.tecnico, recibe: s.recibe, comentario: s.comentario,
      campos: F.campos.filter(c => c.on && s[c.k]).map(c => ({ label: c.label, valor: s[c.k] })), formato: F.nombre, elec: s.elec || null, obsElec: s.obsElec || '', nombreCliente: s.nombreCliente || s.recibe || '' } });
});
app.post('/api/firma/:token', limite, async (req, res) => {
  const s = porToken(req.params.token);
  if (!s) return bad(res, 404, 'Este link ya no es válido o la orden ya fue firmada.');
  if (Date.now() > s.firmaExp) return bad(res, 410, 'Este link venció. Pide al técnico que te envíe uno nuevo.');
  const firma = dataImg(req.body.firma), nombre = t(req.body.nombre).slice(0, 80);
  if (!firma || firma.length < 500) return bad(res, 400, 'Dibuja tu firma en el recuadro');
  if (!nombre) return bad(res, 400, 'Escribe tu nombre');
  if (s.firmando) return bad(res, 409, 'La firma ya se está procesando');
  s.firmando = true;
  const respaldo = { firmaInfo: s.firmaInfo, urlDoc: s.urlDoc };
  try {
    const files = {};
    for (const m of (s.fotosMeta || [])) { const buf = await blobGet(m.nombre); if (buf) (files[m.campo] = files[m.campo] || []).push({ buffer: buf }); }
    const ft = s.firmaTecBlob ? await blobGet(s.firmaTecBlob) : null;
    s.firmaInfo = { ts: Date.now(), ip: req.ip };
    await cierraConPdf(s, files, { firmaCliente: req.body.firma, nombreCliente: nombre, firmaTecnico: ft ? 'data:image/png;base64,' + ft.toString('base64') : '' });
    s.nombreCliente = nombre; s.firmaToken = null; s.firmaExp = 0;
    await borraArchivos({ fotosMeta: s.fotosMeta, firmaTecBlob: s.firmaTecBlob }); s.fotosMeta = []; s.firmaTecBlob = '';
    s.firmando = false; save(); ok(res);
  } catch (e) {
    console.error(e); s.firmando = false; s.firmaInfo = respaldo.firmaInfo; s.urlDoc = respaldo.urlDoc; s.estatus = 'Pendiente de firma';
    bad(res, 500, 'No se pudo guardar la firma, inténtalo de nuevo');
  }
});

cargar().then(() => {
  sembrar();
  app.listen(PORT, () => console.log(conf().nombre + ' en puerto ' + PORT + (USE_PG ? ' (datos en base de datos externa)' : ' (datos en archivo local)') + (geotabCfg() ? ' · Geotab configurado' : '')));
}).catch(e => { console.error('No se pudo iniciar:', e.message); process.exit(1); });
