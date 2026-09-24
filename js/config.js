export const SUPABASE_URL = 'https://swuyppbkwyfhxyhqsuhu.supabase.co';
export const SUPABASE_ANON_KEY = 'sb_publishable_ldFxtvyfSkz0GIUXqXg5Vg_846FTaXX';

// Endpoint léger utilisé pour mesurer la latence/connectivité (pas de lecture de
// réponse nécessaire, on utilise mode: 'no-cors' côté appelant).
export const PING_TARGET_URL = 'https://www.gstatic.com/generate_204';

export const DEFAULT_SETTINGS = {
  pingIntervalMs: 15000,
  pingTimeoutMs: 45000,
  rollingWindowSize: 4,
  // Prévision en fenêtres de travail : une coupure plus courte que minCutMin
  // devient une micro-coupure, une reprise plus courte que minWindowMin est
  // ignorée au milieu d'un trou.
  minCutMin: 2,
  minWindowMin: 4,
  thresholds: {
    redMaxSuccessRate: 0.3,
    orangeMaxSuccessRate: 0.7,
    yellowMinLatencyMs: 300,
    orangeMinLatencyMs: 3000,
  },
};
