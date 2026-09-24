import { supabase } from './supabaseClient.js';

// Données accessibles sans compte, via les fonctions de guest_access.sql.
// Comme les tables, les fonctions renvoyant un ensemble sont plafonnées à
// 1000 lignes par requête côté PostgREST : on pagine.
const PAGE_SIZE = 1000;

async function rpcAll(fn, args) {
  let rows = [];
  let offset = 0;
  while (true) {
    const { data, error } = await supabase.rpc(fn, args).range(offset, offset + PAGE_SIZE - 1);
    if (error) throw error;
    rows = rows.concat(data);
    if (data.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
  }
  return rows;
}

export function getCoverageCells(cellDeg, slowMs) {
  return rpcAll('coverage_cells', { p_cell_deg: cellDeg, p_slow_ms: slowMs });
}

export function listPublicRoutes() {
  return rpcAll('public_routes', {});
}

// Pings au format utilisé par le reste de l'app. Les horodatages sont fictifs
// (temps relatif au départ) : seuls les écarts entre pings servent.
export async function getPublicRoutePings(tripId) {
  const rows = await rpcAll('public_route_pings', { p_trip_id: tripId });
  return rows.map((row) => ({
    sentAt: new Date(row.offset_ms).toISOString(),
    startLat: row.lat,
    startLng: row.lng,
    endLat: row.lat,
    endLng: row.lng,
    elapsedMs: row.elapsed_ms,
    success: row.success,
  }));
}
