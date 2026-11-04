// Lectura de la flota desde la API de Geotab (JSON-RPC). Sin dependencias: usa fetch de Node 18+.
// Variables de entorno: GEOTAB_DATABASE, GEOTAB_USER, GEOTAB_PASSWORD y, si hace falta, GEOTAB_SERVER (por defecto my.geotab.com).
const { categoria } = require('./lib');

async function rpc(host, method, params, f) {
  const r = await f(`https://${host}/apiv1`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ method, params }) });
  if (!r.ok) throw new Error('Geotab respondió HTTP ' + r.status);
  const d = await r.json();
  if (d.error) throw new Error((d.error.errors && d.error.errors[0] && d.error.errors[0].message) || d.error.message || 'Error de Geotab');
  return d.result;
}

async function leerFlota(cfg, f = fetch, now = Date.now()) {
  const host0 = cfg.server || 'my.geotab.com';
  const auth = await rpc(host0, 'Authenticate', { database: cfg.database, userName: cfg.user, password: cfg.password }, f);
  const host = auth.path && auth.path !== 'ThisServer' ? auth.path : host0, credentials = auth.credentials;
  const [devices, estados] = await Promise.all([
    rpc(host, 'Get', { typeName: 'Device', credentials }, f),
    rpc(host, 'Get', { typeName: 'DeviceStatusInfo', credentials }, f)]);
  const ultima = {}; estados.forEach(e => { if (e.device && e.device.id && e.dateTime) ultima[e.device.id] = Date.parse(e.dateTime); });
  return devices.filter(d => !d.activeTo || Date.parse(d.activeTo) > now).map(d => {
    const t = ultima[d.id], dias = t ? Math.max(0, Math.floor((now - t) / 864e5)) : null;
    return { id: d.id, nombre: d.name || '', serie: d.serialNumber || '', vin: d.vehicleIdentificationNumber || '', placas: d.licensePlate || '',
      ultima: t ? new Date(t).toISOString() : null, dias, categoria: categoria(dias) };
  }).sort((a, b) => (b.dias ?? 1e9) - (a.dias ?? 1e9));
}

module.exports = { leerFlota };
