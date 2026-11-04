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
  if (p === 'semana') { const s = sod - ((l.dow + 6) % 7) * DIA; return [s, s + 7 * DIA]; }
  if (p === 'mes') return [Date.UTC(l.y, l.m - 1, 1) - TZ * H, Date.UTC(l.y, l.m, 1) - TZ * H];
  if (p === 'personalizado') {
    const f = x => { const m = String(x || '').match(/^(\d{4})-(\d{2})-(\d{2})$/); return m ? Date.UTC(+m[1], +m[2] - 1, +m[3]) - TZ * H : null; };
    const a = f(desde), b = f(hasta); return [a ?? -Infinity, b != null ? b + DIA : Infinity];
  }
  return null;   // todas
}

const minutos = s => (s.abiertoEn && s.completadoEn && s.completadoEn >= s.abiertoEn) ? Math.round((s.completadoEn - s.abiertoEn) / 60000) : null;
const fmtMin = m => m == null ? '—' : m < 1 ? '<1 min' : m < 60 ? m + ' min' : Math.floor(m / 60) + ' h ' + (m % 60) + ' min';
const mediana = a => { if (!a.length) return null; const s = a.slice().sort((x, y) => x - y), i = s.length >> 1; return s.length % 2 ? s[i] : Math.round((s[i - 1] + s[i]) / 2); };

function stats(l) {
  const dur = l.map(minutos).filter(x => x != null);
  return { servicios: l.length, completados: l.filter(s => s.estatus === 'Completado').length, enCurso: l.filter(s => s.estatus === 'En curso').length,
    sinAbrir: l.filter(s => s.estatus === 'Enviado').length,
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

module.exports = { MOTIVOS, ELEC, CATEGORIAS, visitaTs, rango, minutos, fmtMin, stats, kpi, turno, categoria, local };
