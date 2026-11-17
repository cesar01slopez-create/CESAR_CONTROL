// Lógica pura (sin dependencias) del sistema: periodos, KPI, soporte en turno y categorías de salud.
// México ya no usa horario de verano: se trabaja con UTC-6 fijo.
const TZ = -6, H = 3600e3, DIA = 864e5;

const MOTIVOS = ['Instalación', 'Desinstalación', 'Reinstalación', 'Revisión', 'Reemplazo', 'Intercambio', 'Remover', 'Visita en falso'];
const ELEC = ['Intermitentes/direccionales', 'Luces delanteras', 'Stop', 'Limpia parabrisas', 'Limpiador trasero',
  'Enciende algún testigo en el tablero', 'Encendedor', 'Radio', 'Elevadores eléctricos', 'Seguros eléctricos',
  '¿Cuenta con alarma? ¿funciona?', 'Espejos laterales eléctricos', 'Luces interiores', 'Cámara de reversa', 'Aire acondicionado', 'Claxon'];

const local = ts => { const d = new Date(ts + TZ * H); return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate(), h: d.getUTCHours(), min: d.getUTCMinutes(), dow: d.getUTCDay() }; };
const startOfDay = ts => { const l = local(ts); return Date.UTC(l.y, l.m - 1, l.d) - TZ * H; };

// Fecha y hora de la visita (texto dd/mm/aaaa o aaaa-mm-dd, y HH:MM) -> milisegundos
function visitaTs(s) {
  const f = String(s.fecha || '').trim(); let y, m, d, mt;
  if ((mt = f.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})/))) { d = +mt[1]; m = +mt[2]; y = +mt[3]; if (y < 100) y += 2000; }
  else if ((mt = f.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/))) { y = +mt[1]; m = +mt[2]; d = +mt[3]; }
  else return null;
  const hr = String(s.hora || ''), h = hr.match(/(\d{1,2}):(\d{2})/);
  let hh = h ? +h[1] : 0; const mm = h ? +h[2] : 0;
  if (/p\.?\s?m/i.test(hr) && hh < 12) hh += 12; if (/a\.?\s?m/i.test(hr) && hh === 12) hh = 0;
  return Date.UTC(y, m - 1, d, hh, mm) - TZ * H;
}

function rango(p, desde, hasta, now = Date.now()) {
  const sod = startOfDay(now), l = local(now);
  if (p === 'hoy') return [sod, sod + DIA];
  if (p === 'ayer') return [sod - DIA, sod];
  if (p === 'manana') return [sod + DIA, sod + 2 * DIA];
  if (p === '7dias') return [sod, sod + 7 * DIA];
  if (p === 'semana') { const s = sod - ((l.dow + 6) % 7) * DIA; return [s, s + 7 * DIA]; }
  if (p === 'mes') return [Date.UTC(l.y, l.m - 1, 1) - TZ * H, Date.UTC(l.y, l.m, 1) - TZ * H];
  if (p === 'personalizado') {
    const f = x => { const m = String(x || '').match(/^(\d{4})-(\d{2})-(\d{2})$/); return m ? Date.UTC(+m[1], +m[2] - 1, +m[3]) - TZ * H : null; };
    const a = f(desde), b = f(hasta); return [a ?? -Infinity, b != null ? b + DIA : Infinity];
  }
  return null;   // todas
}

// Tiempo de servicio = de que el técnico abre la orden a que la termina (no cuenta la espera de la firma remota del cliente)
const fin = s => s.terminadoEn || s.completadoEn;
const minutos = s => (s.abiertoEn && fin(s) && fin(s) >= s.abiertoEn) ? Math.round((fin(s) - s.abiertoEn) / 60000) : null;
const fmtMin = m => m == null ? '—' : m < 1 ? '<1 min' : m < 60 ? m + ' min' : Math.floor(m / 60) + ' h ' + (m % 60) + ' min';
const mediana = a => { if (!a.length) return null; const s = a.slice().sort((x, y) => x - y), i = s.length >> 1; return s.length % 2 ? s[i] : Math.round((s[i - 1] + s[i]) / 2); };

function stats(l) {
  const dur = l.map(minutos).filter(x => x != null);
  return { servicios: l.length, completados: l.filter(s => s.estatus === 'Completado').length, enCurso: l.filter(s => s.estatus === 'En curso').length,
    sinAbrir: l.filter(s => s.estatus === 'Enviado').length, porFirmar: l.filter(s => s.estatus === 'Pendiente de firma').length,
    prom: dur.length ? Math.round(dur.reduce((a, b) => a + b, 0) / dur.length) : null, mediana: mediana(dur) };
}
function kpi(servicios, p, desde, hasta, now = Date.now()) {
  const r = rango(p, desde, hasta, now);
  const l = r ? servicios.filter(s => { const t = visitaTs(s); return t != null && t >= r[0] && t < r[1]; }) : servicios;
  const grupo = k => { const m = {}; l.forEach(s => (m[s[k] || '—'] = m[s[k] || '—'] || []).push(s));
    return Object.entries(m).map(([nombre, x]) => ({ nombre, ...stats(x) })).sort((a, b) => b.servicios - a.servicios || a.nombre.localeCompare(b.nombre)); };
  return { total: stats(l), porTecnico: grupo('tecnico'), porMotivo: grupo('motivo') };
}

// Soporte en turno: quién está de turno ahora y cuántas validaciones atiende
const aMin = hhmm => { const m = String(hhmm || '').match(/^(\d{1,2}):(\d{2})/); return m ? +m[1] * 60 + +m[2] : null; };
function turno(usuarios, validaciones, now = Date.now()) {
  const l = local(now), ahora = l.h * 60 + l.min;
  return usuarios.filter(u => u.rol === 'soporte' && u.activo !== false && u.turno).map(u => {
    const i = aMin(u.turno.inicio), f = aMin(u.turno.fin);
    if (i == null || f == null) return null;
    const dentro = i < f ? ahora >= i && ahora < f : ahora >= i || ahora < f;
    if (!dentro) return null;
    const mias = validaciones.filter(v => v.estado === 'En atención' && v.soporte === u.usuario);
    return { nombre: u.nombre, inicio: u.turno.inicio, fin: u.turno.fin, atendiendo: mias.length, tecnicos: [...new Set(mias.map(v => v.tecnico))] };
  }).filter(Boolean);
}

// Salud de equipos: días sin reportar
const CATEGORIAS = [['OK', 'Menos de 7 días'], ['Advertencia', '7 a 15 días'], ['Crítico', '16 a 50 días'], ['Crítico alto', '51 a 100 días'], ['Crítico severo', 'Más de 100 días'], ['Desconocido', 'Nunca ha reportado']];
function categoria(dias) {
  if (dias == null) return 'Desconocido';
  return dias < 7 ? 'OK' : dias <= 15 ? 'Advertencia' : dias <= 50 ? 'Crítico' : dias <= 100 ? 'Crítico alto' : 'Crítico severo';
}


// ---------- Campos del equipo configurables ----------
const CAMPOS_DEF = [
  { k: 'serie', label: 'Serie del dispositivo', on: true, req: true }, { k: 'imei', label: 'IMEI', on: true, req: true },
  { k: 'sim', label: 'Número de SIM asociado', on: true, req: false }, { k: 'economico', label: 'Número económico', on: true, req: false },
  { k: 'placas', label: 'Placas', on: true, req: true }, { k: 'vin', label: 'VIN (número de serie del vehículo)', on: true, req: false },
  ...[1, 2, 3, 4, 5, 6, 7, 8].map(n => ({ k: 'extra' + n, label: 'Campo extra ' + n, on: false, req: false }))];
function mezclaCampos(g) {
  const m = {}; (Array.isArray(g) ? g : []).forEach(c => { if (c && c.k) m[c.k] = c; });
  return CAMPOS_DEF.map(d => { const o = m[d.k] || {}, on = o.on === undefined ? d.on : !!o.on;
    return { k: d.k, label: String(o.label || d.label).trim().slice(0, 40) || d.label, on, req: on && (o.req === undefined ? d.req : !!o.req) }; });
}

// Formatos de orden: cada uno con título, campos propios, tabla eléctrica y logo opcionales
function normFormatos(arr, base = {}, rnd = () => Math.random().toString(16).slice(2, 8)) {
  let l = Array.isArray(arr) && arr.length ? arr : [{ id: 'std', nombre: 'Orden de servicio', campos: base.campos, elec: base.elec, logo: false }];
  const ids = new Set();
  return l.slice(0, 12).map((f, i) => {
    let id = String((f && f.id) || '').replace(/[^\w-]/g, '').slice(0, 20) || rnd(); while (ids.has(id)) id = rnd(); ids.add(id);
    const nombre = String((f && f.nombre) || '').trim().slice(0, 40) || 'Formato ' + (i + 1);
    return { id, nombre, titulo: String((f && f.titulo) || '').trim().slice(0, 60) || nombre, campos: mezclaCampos(f && f.campos),
      elec: !!(f && f.elec), logo: !!(f && f.logo), fotos: !(f && f.fotos === false) };
  });
}

// ---------- Agenda, historial por unidad y avisos ----------
function agenda(servicios, p, desde, hasta, now = Date.now(), conListos = false) {
  const r = rango(p, desde, hasta, now);
  return servicios.filter(s => conListos || s.estatus !== 'Completado').map(s => ({ s, t: visitaTs(s) }))
    .filter(x => x.t != null && (!r || (x.t >= r[0] && x.t < r[1]))).sort((a, b) => a.t - b.t).map(x => ({ ...x.s, ts: x.t }));
}
const norm = v => String(v ?? '').trim().toUpperCase().replace(/[\s-]+/g, '');   // "abc-123" = "ABC 123"
const claveUnidad = s => norm(s.placas) || norm(s.imei) || norm(s.serie) || norm(s.economico) || norm(s.vin) || '';
function unidades(servicios, q = '') {
  const g = {};
  servicios.forEach(s => { const k = claveUnidad(s); if (k) (g[k] = g[k] || []).push(s); });
  const nq = norm(q), qq = String(q || '').trim().toLowerCase();
  return Object.entries(g).map(([clave, l]) => {
    l.sort((a, b) => (visitaTs(b) || 0) - (visitaTs(a) || 0));
    const pick = k => (l.find(x => x[k]) || {})[k] || '';
    return { clave, placas: pick('placas'), economico: pick('economico'), imei: pick('imei'), serie: pick('serie'), sim: pick('sim'), vin: pick('vin'), vehiculo: [pick('vMarca'), pick('vModelo'), pick('vAnio')].filter(Boolean).join(' '), arnes: pick('arnes'), cliente: l[0].cliente || '',
      total: l.length, ultima: visitaTs(l[0]),
      servicios: l.map(s => ({ folio: s.folio, fecha: s.fecha, hora: s.hora, motivo: s.motivo, tecnico: s.tecnico, cliente: s.cliente, estatus: s.estatus, urlDoc: s.urlDoc || '' })) };
  }).filter(u => !nq || [u.placas, u.economico, u.imei, u.serie, u.sim, u.vin].some(v => norm(v).includes(nq)) || u.cliente.toLowerCase().includes(qq))
    .sort((a, b) => (b.ultima || 0) - (a.ultima || 0));
}
function waLink(tel, texto) {
  const m = String(tel || '').match(/\+?\d[\d\s().-]{8,}\d/); if (!m) return '';
  let d = m[0].replace(/\D/g, ''); if (d.length === 10) d = '52' + d; if (d.length < 11) return '';
  return 'https://wa.me/' + d + '?text=' + encodeURIComponent(texto);
}


// ---------- VIN: validación, decodificación y sugerencia de arnés ----------
const vinNormal = v => String(v || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const vinFormato = v => /^[A-HJ-NPR-Z0-9]{17}$/.test(v);
const VIN_T = { A: 1, B: 2, C: 3, D: 4, E: 5, F: 6, G: 7, H: 8, J: 1, K: 2, L: 3, M: 4, N: 5, P: 7, R: 9, S: 2, T: 3, U: 4, V: 5, W: 6, X: 7, Y: 8, Z: 9 };
function vinCheck(v) {   // dígito verificador (posición 9); obligatorio en norteamérica, no en otras regiones
  if (!vinFormato(v)) return false; const W = [8, 7, 6, 5, 4, 3, 2, 10, 0, 9, 8, 7, 6, 5, 4, 3, 2];
  const sum = [...v].reduce((a, c, i) => a + (/\d/.test(c) ? +c : VIN_T[c]) * W[i], 0), d = sum % 11 === 10 ? 'X' : String(sum % 11);
  return v[8] === d;
}
function vinAnio(v, hoy = new Date().getFullYear()) {
  const i = 'ABCDEFGHJKLMNPRSTVWXY123456789'.indexOf(String(v || '')[9]); if (i < 0) return null;
  return 2010 + i <= hoy + 1 ? 2010 + i : 1980 + i;
}
const VIN_PAIS = { '1': 'Estados Unidos', '4': 'Estados Unidos', '5': 'Estados Unidos', '2': 'Canadá', '3': 'México', J: 'Japón', K: 'Corea del Sur', L: 'China', S: 'Reino Unido', V: 'Francia / España', W: 'Alemania', Z: 'Italia', Y: 'Suecia / Finlandia', '9': 'Brasil', '8': 'Argentina / Chile', M: 'India / Tailandia / Indonesia', T: 'Suiza / Rep. Checa', R: 'Taiwán' };
const vinPais = v => VIN_PAIS[String(v || '')[0]] || '';
const sinAc = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
const CAT_VEH = { ligero: 'Auto, SUV o pickup', van: 'Van / camioneta de carga', pesado: 'Camión pesado / tractocamión', autobus: 'Autobús', moto: 'Motocicleta', remolque: 'Remolque', otro: 'Otro' };
function categoriaVeh(v) {
  const tipo = String(v.tipo || '').toUpperCase(), car = String(v.carroceria || '').toLowerCase(), cl = (String(v.gvwr || '').match(/Class\s*(\d)/i) || [])[1];
  if (tipo.includes('BUS')) return 'autobus'; if (tipo.includes('MOTORCYCLE')) return 'moto'; if (tipo.includes('TRAILER')) return 'remolque';
  if (/tractor/.test(car) || (cl && +cl >= 4)) return 'pesado';
  if (/van/.test(car)) return 'van';
  return 'ligero';
}
const titulo = s => s.length > 3 ? s.toLowerCase().replace(/(^|[\s-])([a-zñáéíóú])/g, (m, a, b) => a + b.toUpperCase()) : s;
function parseVpic(j) {   // respuesta de NHTSA vPIC (DecodeVinValues) → datos del vehículo
  const r = (j && Array.isArray(j.Results) && j.Results[0]) || {}, g = k => String(r[k] == null ? '' : r[k]).trim();
  const carrocerias = [['Pickup', 'Pickup'], ['Sport Utility', 'SUV'], ['Sedan', 'Sedán'], ['Hatchback', 'Hatchback'], ['Cargo Van', 'Van de carga'], ['Minivan', 'Minivan'], ['Van', 'Van'], ['Truck-Tractor', 'Tractocamión'], ['Chassis', 'Chasis cabina'], ['Bus', 'Autobús'], ['Wagon', 'Station wagon'], ['Coupe', 'Coupé'], ['Convertible', 'Convertible'], ['Crossover', 'Crossover']];
  const bc = g('BodyClass'), carroceria = (carrocerias.find(([k]) => bc.toLowerCase().includes(k.toLowerCase())) || [0, bc])[1];
  const v = { marca: titulo(g('Make')), modelo: g('Model'), anio: parseInt(g('ModelYear'), 10) || null, carroceria, carroceriaOriginal: bc, tipo: g('VehicleType'),
    combustible: g('FuelTypePrimary'), cilindros: g('EngineCylinders'), desplazamiento: g('DisplacementL'), pais: g('PlantCountry'), gvwr: g('GVWR'), version: g('Trim'), codigoError: g('ErrorCode') };
  v.cat = categoriaVeh(v); return v;
}
// Reglas: { marca, modelo, desde, hasta, cat, arnes, nota }. Vacío = cualquiera. Gana la más específica.
function reglasValidas(a) {
  return (Array.isArray(a) ? a : []).slice(0, 300).map(r => ({ marca: String((r && r.marca) || '').trim().slice(0, 40), modelo: String((r && r.modelo) || '').trim().slice(0, 40),
    desde: parseInt(r && r.desde, 10) || '', hasta: parseInt(r && r.hasta, 10) || '', cat: CAT_VEH[r && r.cat] ? r.cat : '', arnes: String((r && r.arnes) || '').trim().slice(0, 80), nota: String((r && r.nota) || '').trim().slice(0, 160) })).filter(r => r.arnes);
}
function sugiereArnes(veh, reglas, servicios) {
  const marca = sinAc(veh.marca), modelo = sinAc(veh.modelo), anio = +veh.anio || null, cat = veh.cat || categoriaVeh(veh), out = [], vistos = new Set();
  const add = x => { if (!vistos.has(x.arnes)) { vistos.add(x.arnes); out.push(x); } };
  const cand = [];
  reglasValidas(reglas).forEach((r, i) => {
    const rm = sinAc(r.marca), rmo = sinAc(r.modelo);
    if (rm && rm !== '*' && !marca.includes(rm)) return; if (rmo && !modelo.includes(rmo)) return;
    if (r.desde && (!anio || anio < r.desde)) return; if (r.hasta && (!anio || anio > r.hasta)) return; if (r.cat && r.cat !== cat) return;
    if (!rm && !rmo && !r.cat && !r.desde && !r.hasta) return;   // una regla totalmente vacía no sugiere nada
    cand.push({ sc: (rmo ? 4 : 0) + (rm && rm !== '*' ? 2 : 0) + (r.desde || r.hasta ? 2 : 0) + (r.cat ? 1 : 0), i, r });
  });
  cand.sort((a, b) => b.sc - a.sc || a.i - b.i).forEach(c => add({ arnes: c.r.arnes, fuente: 'regla', detalle: c.r.nota || 'Regla configurada por el coordinador' }));
  if (marca && modelo) {
    let h = (servicios || []).filter(s => s.estatus === 'Completado' && s.arnes && sinAc(s.vMarca) === marca && sinAc(s.vModelo) === modelo);
    const cerca = anio ? h.filter(s => s.vAnio && Math.abs(+s.vAnio - anio) <= 2) : []; if (cerca.length) h = cerca;
    const n = {}; h.forEach(s => { n[s.arnes] = (n[s.arnes] || 0) + 1; });
    Object.entries(n).sort((a, b) => b[1] - a[1]).forEach(([arnes, k]) => add({ arnes, fuente: 'historial', n: k, total: h.length, detalle: `Usado en ${k} de ${h.length} instalación${h.length === 1 ? '' : 'es'} de ${veh.marca} ${veh.modelo}` }));
  }
  return out.slice(0, 4);
}

// ---------- Guía general de arneses Geotab (GO9) ----------
// Basada en la documentación pública de Geotab (Harness Identification and Application / Harness Assessment Cheat Sheet).
// Es orientativa: Geotab no garantiza compatibilidad; la herramienta oficial es https://www.geotab.com/harness-lookup/
const ARNESES_GEOTAB = {
  directo: 'Sin arnés · GO9 directo al puerto OBD-II',
  bs16: 'HRN-BS16S4 · Arnés recto OBD-II 16 pines',
  gs16: 'HRN-GS16K2-LD · T-harness universal OBD-II (ligeros)',
  gs09: 'HRN-GS09K2-A · T-harness universal 9 pines Deutsch (pesados)',
  ds06: 'HRN-DS06T2-A · T-harness 6 pines Deutsch (pesados antiguos)',
  cg13: 'HRN-CG13S1-A · Adaptador pesado para puerto OBD-II 16 pines',
  rp1226: 'HRN-CS14S21 · Arnés puerto RP1226 (pesados 2019+)',
  isuzu: 'HRN-CM24Y1 · Isuzu serie N diésel 2017+ (con HRN-CI04A2)',
  sinpuerto: 'HRN-CW03K3 · Vehículo sin puerto de diagnóstico'
};
function guiaGeotab(v) {
  const cat = v.cat || categoriaVeh(v), anio = +v.anio || null, marca = sinAc(v.marca), out = [], add = (k, d) => out.push({ arnes: ARNESES_GEOTAB[k], fuente: 'geotab', detalle: d });
  if (!marca && !v.modelo && !v.cat) return [];
  if (['moto', 'remolque', 'otro'].includes(cat)) return [];
  if (anio && anio < 1996) { add('sinpuerto', 'Los vehículos anteriores a 1996 normalmente no tienen puerto de diagnóstico.'); return out; }
  if (marca.includes('isuzu') && /diesel/i.test(v.combustible || '') && anio >= 2017 && /^(n[pqr]r|n\b|n[- ]?series)/i.test(sinAc(v.modelo))) add('isuzu', 'Confirma que sea serie N con código RPO I4H antes de usarlo.');
  if (cat === 'ligero' || cat === 'van') {
    add('directo', 'Vehículos ligeros (12 V) desde 1997: el GO9 se conecta directo al puerto OBD-II de 16 pines.');
    add('bs16', 'Si quieres sacar el equipo del paso del conductor.');
    add('gs16', 'Si quieres dejar libre el puerto OBD-II.');
  } else {
    if (anio >= 2019) add('rp1226', 'Pesados 2019+: no uses el puerto OBD-II; usa el arnés específico (RP1226) cuando el vehículo lo tenga.');
    add('gs09', 'Conector Deutsch de 9 pines (el más común en pesados). Confirma el tipo de puerto antes de instalar.');
    add('ds06', 'Si el puerto de diagnóstico es de 6 pines (pesados antiguos).');
    add('cg13', 'Si solo hay puerto OBD-II de 16 pines en un pesado (24 V): úsalo con el arnés universal para no dañar el equipo.');
  }
  return out;
}
function avisosGeotab(v) {
  const a = ['Guía orientativa: Geotab no garantiza la compatibilidad. Si Geotab ofrece un arnés específico para el vehículo, úsalo siempre y confirma en su herramienta oficial.'];
  if (/^electric$/i.test(String(v.combustible || '').trim())) a.push('Vehículo eléctrico: Geotab suele pedir un arnés específico por modelo y año. Verifica en la herramienta oficial antes de instalar.');
  return a;
}

module.exports = { ARNESES_GEOTAB, guiaGeotab, avisosGeotab, vinNormal, vinFormato, vinCheck, vinAnio, vinPais, categoriaVeh, CAT_VEH, parseVpic, reglasValidas, sugiereArnes, sinAc, CAMPOS_DEF, mezclaCampos, normFormatos, agenda, unidades, claveUnidad, waLink, MOTIVOS, ELEC, CATEGORIAS, visitaTs, rango, minutos, fmtMin, stats, kpi, turno, categoria, local };
