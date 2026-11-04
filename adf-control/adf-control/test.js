const assert = require('assert'), L = require('./lib'), { leerFlota } = require('./geotab');
// "ahora": 4-nov-2026 08:54 hora de México = 14:54 UTC (miércoles)
const NOW = Date.UTC(2026, 10, 4, 14, 54);
const ts = (f, h) => L.visitaTs({ fecha: f, hora: h });

// --- Fechas
assert.strictEqual(ts('15/10/2026', '10:00'), Date.UTC(2026, 9, 15, 16, 0));
assert.strictEqual(ts('2026-10-15', '10:00 p.m.'), Date.UTC(2026, 9, 16, 4, 0));
assert.strictEqual(ts('basura', '10:00'), null);

// --- Periodos
const [h0, h1] = L.rango('hoy', null, null, NOW);
assert.strictEqual(h0, Date.UTC(2026, 10, 4, 6, 0)); assert.strictEqual(h1 - h0, 864e5);
assert.strictEqual(L.rango('ayer', null, null, NOW)[1], h0);
assert.strictEqual(L.rango('semana', null, null, NOW)[0], Date.UTC(2026, 10, 2, 6, 0));        // lunes 2 nov
assert.deepStrictEqual(L.rango('mes', null, null, NOW), [Date.UTC(2026, 10, 1, 6), Date.UTC(2026, 11, 1, 6)]);
assert.strictEqual(L.rango('todas', null, null, NOW), null);
assert.deepStrictEqual(L.rango('personalizado', '2026-11-01', '2026-11-03', NOW), [Date.UTC(2026, 10, 1, 6), Date.UTC(2026, 10, 4, 6)]);

// --- KPI
const min = 60000, base = Date.UTC(2026, 10, 3, 16);
const S = [
  { folio: 'A', tecnico: 'ARMANDO', motivo: 'Instalación', fecha: '03/11/2026', hora: '10:00', estatus: 'Completado', abiertoEn: base, completadoEn: base + 14 * min },
  { folio: 'B', tecnico: 'ARMANDO', motivo: 'Revisión', fecha: '03/11/2026', hora: '12:00', estatus: 'En curso', abiertoEn: base },
  { folio: 'C', tecnico: 'CESAR', motivo: 'Instalación', fecha: '04/11/2026', hora: '09:00', estatus: 'Enviado' },
  { folio: 'D', tecnico: 'CESAR', motivo: 'Instalación', fecha: '15/10/2026', hora: '09:00', estatus: 'Completado', abiertoEn: base, completadoEn: base + 30 * min }];
let k = L.kpi(S, 'mes', null, null, NOW);
assert.strictEqual(k.total.servicios, 3); assert.strictEqual(k.total.completados, 1);
assert.strictEqual(k.total.enCurso, 1); assert.strictEqual(k.total.sinAbrir, 1); assert.strictEqual(k.total.prom, 14);
assert.strictEqual(k.porTecnico[0].nombre, 'ARMANDO');
k = L.kpi(S, 'todas', null, null, NOW);
assert.strictEqual(k.total.servicios, 4); assert.strictEqual(k.total.prom, 22); assert.strictEqual(k.total.mediana, 22);
assert.strictEqual(L.kpi(S, 'hoy', null, null, NOW).total.servicios, 1);
assert.strictEqual(L.fmtMin(14), '14 min'); assert.strictEqual(L.fmtMin(65), '1 h 5 min'); assert.strictEqual(L.fmtMin(null), '—');

// --- Soporte en turno (08:54 local)
const U = [{ usuario: 'ale', nombre: 'Alejandra Nava', rol: 'soporte', turno: { inicio: '07:00', fin: '15:00' } },
  { usuario: 'fran', nombre: 'Francisco Puente', rol: 'soporte', turno: { inicio: '10:00', fin: '18:00' } },
  { usuario: 'noc', nombre: 'Noche', rol: 'soporte', turno: { inicio: '22:00', fin: '07:00' } },
  { usuario: 'off', nombre: 'Baja', rol: 'soporte', activo: false, turno: { inicio: '07:00', fin: '15:00' } }];
const V = [{ estado: 'En atención', soporte: 'ale', tecnico: 'ARMANDO' }, { estado: 'En atención', soporte: 'ale', tecnico: 'CESAR' },
  { estado: 'En atención', soporte: 'ale', tecnico: 'CESAR' }, { estado: 'Pendiente' }, { estado: 'Validada', soporte: 'ale', tecnico: 'X' }];
let t = L.turno(U, V, NOW);
assert.strictEqual(t.length, 1); assert.strictEqual(t[0].nombre, 'Alejandra Nava'); assert.strictEqual(t[0].atendiendo, 3);
assert.deepStrictEqual(t[0].tecnicos, ['ARMANDO', 'CESAR']);
t = L.turno(U, V, Date.UTC(2026, 10, 5, 5, 0));   // 23:00 local: turno nocturno
assert.deepStrictEqual(t.map(x => x.nombre), ['Noche']);

// --- Categorías
assert.deepStrictEqual([null, 0, 6, 7, 15, 16, 50, 51, 100, 101].map(L.categoria),
  ['Desconocido', 'OK', 'OK', 'Advertencia', 'Advertencia', 'Crítico', 'Crítico', 'Crítico alto', 'Crítico alto', 'Crítico severo']);
assert.strictEqual(L.ELEC.length, 16);

// --- Geotab con servidor simulado
(async () => {
  const llamadas = [];
  const fake = async (url, o) => {
    const b = JSON.parse(o.body); llamadas.push([url, b.method]);
    const r = b.method === 'Authenticate' ? { credentials: { database: 'x', sessionId: 's', userName: 'u' }, path: 'my3.geotab.com' }
      : b.params.typeName === 'Device' ? [
        { id: 'b1', name: 'Unidad 1', serialNumber: 'G9AAA', activeTo: '2050-01-01T00:00:00.000Z' },
        { id: 'b2', name: 'Unidad 2', serialNumber: 'G9BBB', activeTo: '2050-01-01T00:00:00.000Z' },
        { id: 'b3', name: 'Unidad 3', serialNumber: 'G9CCC', activeTo: '2050-01-01T00:00:00.000Z' },
        { id: 'b4', name: 'De baja', serialNumber: 'G9DDD', activeTo: '2020-01-01T00:00:00.000Z' }]
        : [{ device: { id: 'b1' }, dateTime: new Date(NOW - 2 * 864e5).toISOString() }, { device: { id: 'b2' }, dateTime: new Date(NOW - 120 * 864e5).toISOString() }];
    return { ok: true, json: async () => ({ result: r }) };
  };
  const u = await leerFlota({ database: 'x', user: 'u', password: 'p' }, fake, NOW);
  assert.strictEqual(u.length, 3); assert.strictEqual(llamadas[0][0], 'https://my.geotab.com/apiv1'); assert.strictEqual(llamadas[1][0], 'https://my3.geotab.com/apiv1');
  assert.deepStrictEqual(u.map(x => x.categoria), ['Desconocido', 'Crítico severo', 'OK']);
  const malo = async () => ({ ok: true, json: async () => ({ error: { message: 'Incorrect login' } }) });
  await assert.rejects(leerFlota({ database: 'x', user: 'u', password: 'p' }, malo, NOW), /Incorrect login/);
  console.log('TODAS LAS PRUEBAS PASARON');
})().catch(e => { console.error(e); process.exit(1); });
