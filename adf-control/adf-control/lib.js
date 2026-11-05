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
  { k: 'placas', label: 'Placas', on: true, req: true },
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
const claveUnidad = s => norm(s.placas) || norm(s.imei) || norm(s.serie) || norm(s.economico) || '';
function unidades(servicios, q = '') {
  const g = {};
  servicios.forEach(s => { const k = claveUnidad(s); if (k) (g[k] = g[k] || []).push(s); });
  const nq = norm(q), qq = String(q || '').trim().toLowerCase();
  return Object.entries(g).map(([clave, l]) => {
    l.sort((a, b) => (visitaTs(b) || 0) - (visitaTs(a) || 0));
    const pick = k => (l.find(x => x[k]) || {})[k] || '';
    return { clave, placas: pick('placas'), economico: pick('economico'), imei: pick('imei'), serie: pick('serie'), sim: pick('sim'), cliente: l[0].cliente || '',
      total: l.length, ultima: visitaTs(l[0]),
      servicios: l.map(s => ({ folio: s.folio, fecha: s.fecha, hora: s.hora, motivo: s.motivo, tecnico: s.tecnico, cliente: s.cliente, estatus: s.estatus, urlDoc: s.urlDoc || '' })) };
  }).filter(u => !nq || [u.placas, u.economico, u.imei, u.serie, u.sim].some(v => norm(v).includes(nq)) || u.cliente.toLowerCase().includes(qq))
    .sort((a, b) => (b.ultima || 0) - (a.ultima || 0));
}
function waLink(tel, texto) {
  const m = String(tel || '').match(/\+?\d[\d\s().-]{8,}\d/); if (!m) return '';
  let d = m[0].replace(/\D/g, ''); if (d.length === 10) d = '52' + d; if (d.length < 11) return '';
  return 'https://wa.me/' + d + '?text=' + encodeURIComponent(texto);
}

module.exports = { CAMPOS_DEF, mezclaCampos, normFormatos, agenda, unidades, claveUnidad, waLink, MOTIVOS, ELEC, CATEGORIAS, visitaTs, rango, minutos, fmtMin, stats, kpi, turno, categoria, local };
