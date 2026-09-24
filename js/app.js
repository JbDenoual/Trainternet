import { signIn, signUp, signOut, getCurrentUser, onAuthStateChange } from './auth.js';
import { getSettings, saveSettings } from './settings.js';
import { listTrips, getTripPings, getTrip, deleteTrip } from './trips.js';
import { Recorder } from './recorder.js';
import { MapView } from './mapView.js';
import { tripSummary, colorAt, colorForCell, COLORS, categoryRank } from './quality.js';
import { getCoverageCells, listPublicRoutes, getPublicRoutePings } from './public.js';

let settings = getSettings();
let recorder = null;
let recordMapView = null;
let forecastMapView = null;
let currentUser = null;
let currentTripId = null;
let currentTripPings = []; // dernier jeu de pings statique chargé, réutilisé pour la prévision
let forecastDirection = 'aller';

// Mode invité : pas de compte, accès en lecture seule à la carte générale et
// aux prévisions des itinéraires connus. Mémorisé pour rouvrir l'app
// directement sur la carte.
const GUEST_KEY = 'trainternet_guest';
let isGuest = readGuestFlag();
let coverageMapView = null;
let guestTripMapView = null;
let guestDirection = 'aller';
let guestRoutePings = [];
let guestRoutesLoaded = false;
let guestGpsWatchId = null;
const routePingsCache = new Map();

function readGuestFlag() {
  try {
    return localStorage.getItem(GUEST_KEY) === '1';
  } catch {
    return false;
  }
}

function setGuest(value) {
  isGuest = value;
  try {
    if (value) localStorage.setItem(GUEST_KEY, '1');
    else localStorage.removeItem(GUEST_KEY);
  } catch {
    // stockage indisponible (navigation privée) : le mode invité ne sera juste pas mémorisé
  }
}

const screens = ['screen-auth', 'screen-guest', 'screen-guest-trip', 'screen-home', 'screen-review', 'screen-settings'];

function showScreen(id) {
  screens.forEach((s) => document.getElementById(s).classList.toggle('active', s === id));
  const tabs = document.getElementById('mainTabs');
  tabs.style.display = id === 'screen-home' || id === 'screen-settings' ? 'flex' : 'none';
  document.getElementById('tabHome').classList.toggle('active', id === 'screen-home');
  document.getElementById('tabSettings').classList.toggle('active', id === 'screen-settings');
}

// ---------- Routage (permet d'utiliser le bouton retour du navigateur) ----------

function route() {
  if (location.hash !== '#guest-trip') stopGuestGps();

  if (!currentUser) {
    if (!isGuest) {
      showScreen('screen-auth');
      return;
    }
    document.getElementById('userBadge').textContent = 'Invité';
    if (location.hash === '#guest-trip') {
      showScreen('screen-guest-trip');
      loadGuestTrip();
    } else {
      showScreen('screen-guest');
      loadCoverageMap();
    }
    return;
  }

  const hash = location.hash || '#home';

  if (hash === '#settings') {
    loadSettingsIntoForm();
    showScreen('screen-settings');
  } else if (hash.startsWith('#review/')) {
    showScreen('screen-review');
    loadTripDetail(hash.slice('#review/'.length));
  } else {
    showScreen('screen-home');
    refreshTripList();
  }
}

function navigate(hash, { replace = false } = {}) {
  if (replace) {
    history.replaceState(null, '', hash);
  } else if (location.hash !== hash) {
    history.pushState(null, '', hash);
  }
  route();
}

window.addEventListener('popstate', () => {
  // Empêche de quitter accidentellement un enregistrement en cours avec le bouton retour.
  if (recorder && location.hash !== `#review/${recorder.tripId}`) {
    history.pushState(null, '', `#review/${recorder.tripId}`);
    document.getElementById('reviewSummary').textContent = "Arrête l'enregistrement avant de changer d'écran.";
    return;
  }
  route();
});

// ---------- Auth ----------

document.getElementById('btnSignIn').addEventListener('click', async () => {
  const email = document.getElementById('authEmail').value.trim();
  const password = document.getElementById('authPassword').value;
  const errBox = document.getElementById('authError');
  errBox.textContent = '';
  try {
    await signIn(email, password);
  } catch (err) {
    errBox.textContent = err.message;
  }
});

document.getElementById('btnSignUp').addEventListener('click', async () => {
  const email = document.getElementById('authEmail').value.trim();
  const password = document.getElementById('authPassword').value;
  const errBox = document.getElementById('authError');
  errBox.textContent = '';
  try {
    await signUp(email, password);
    errBox.textContent = 'Compte créé. Si la confirmation par email est activée, vérifie ta boîte mail avant de te connecter.';
    errBox.style.color = 'var(--text-secondary)';
  } catch (err) {
    errBox.textContent = err.message;
    errBox.style.color = '';
  }
});

document.getElementById('btnSignOut').addEventListener('click', async () => {
  await signOut();
});

// Point d'entrée commun quand personne n'est connecté : carte invité si le
// mode invité a été choisi, écran de connexion sinon.
function enterSignedOut() {
  document.getElementById('userBadge').textContent = '';
  if (isGuest) {
    const onGuestScreen = location.hash === '#guest' || location.hash === '#guest-trip';
    navigate(onGuestScreen ? location.hash : '#guest', { replace: true });
  } else {
    navigate('#auth', { replace: true });
  }
}

onAuthStateChange((user) => {
  currentUser = user;
  if (user) {
    setGuest(false);
    document.getElementById('userBadge').textContent = user.email;
    const fromSignedOutScreen = ['', '#auth', '#guest', '#guest-trip'].includes(location.hash);
    if (fromSignedOutScreen) {
      navigate('#home', { replace: true });
    } else {
      route();
    }
  } else {
    enterSignedOut();
  }
});

document.getElementById('btnContinueAsGuest').addEventListener('click', () => {
  setGuest(true);
  navigate('#guest', { replace: true });
});

// ---------- Navigation ----------

document.getElementById('tabHome').addEventListener('click', () => navigate('#home'));
document.getElementById('tabSettings').addEventListener('click', () => navigate('#settings'));

// ---------- Accueil / liste des trajets ----------

const TRASH_ICON = `<svg viewBox="0 0 24 24" class="icon" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2m3 0-1 14a2 2 0 01-2 2H7a2 2 0 01-2-2L4 6h16z"/></svg>`;
const PLAY_ICON = `<svg viewBox="0 0 24 24" class="icon" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>`;
const STOP_ICON = `<svg viewBox="0 0 24 24" class="icon" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>`;

async function refreshTripList() {
  const listEl = document.getElementById('tripList');
  listEl.innerHTML = '<div class="empty-state">Chargement…</div>';
  try {
    const trips = await listTrips();
    if (trips.length === 0) {
      listEl.innerHTML = '<div class="empty-state">Aucun trajet enregistré pour le moment.</div>';
      return;
    }
    listEl.innerHTML = '';
    trips.forEach((trip) => listEl.appendChild(buildTripRow(trip)));
  } catch (err) {
    listEl.innerHTML = `<div class="empty-state">Erreur de chargement : ${err.message}</div>`;
  }
}

function buildTripRow(trip) {
  const row = document.createElement('div');
  row.className = 'trip-row';
  const date = new Date(trip.started_at).toLocaleString('fr-FR');

  row.innerHTML = `
    <div class="trip-row__main">
      <div class="trip-row__name">${escapeHtml(trip.name || 'Trajet sans nom')}</div>
      <div class="trip-row__meta">${date}</div>
    </div>
    <div class="trip-row__action"></div>
  `;

  row.addEventListener('click', () => navigate(`#review/${trip.id}`));
  renderDeleteIcon(row, trip);

  return row;
}

function renderDeleteIcon(row, trip) {
  const action = row.querySelector('.trip-row__action');
  action.innerHTML = `<button type="button" class="btn-icon" aria-label="Supprimer ce trajet">${TRASH_ICON}</button>`;
  action.querySelector('button').addEventListener('click', (e) => {
    e.stopPropagation();
    renderDeleteConfirm(row, trip);
  });
}

function renderDeleteConfirm(row, trip) {
  const action = row.querySelector('.trip-row__action');
  action.innerHTML = `
    <div class="trip-row__confirm">
      <button type="button" class="btn btn-ghost" data-role="cancel">Annuler</button>
      <button type="button" class="btn btn-danger" data-role="confirm">Supprimer</button>
    </div>
  `;

  action.querySelector('[data-role="cancel"]').addEventListener('click', (e) => {
    e.stopPropagation();
    renderDeleteIcon(row, trip);
  });

  action.querySelector('[data-role="confirm"]').addEventListener('click', async (e) => {
    e.stopPropagation();
    action.innerHTML = '<span class="trip-row__meta">Suppression…</span>';
    try {
      await deleteTrip(trip.id);
      refreshTripList();
    } catch (err) {
      action.innerHTML = `<span class="error-text">${escapeHtml(err.message)}</span>`;
    }
  });
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// ---------- Liste des pings (carte + journal détaillé) ----------

function formatPingPosition(ping) {
  const lat = ping.endLat ?? ping.startLat;
  const lng = ping.endLng ?? ping.startLng;
  if (lat == null || lng == null) return 'Aucune position captée';
  return `${lat.toFixed(5)}, ${lng.toFixed(5)}`;
}

const LATENCY_CLASS_BY_COLOR = {
  [COLORS.green]: 'ping-row__latency--green',
  [COLORS.yellow]: 'ping-row__latency--yellow',
  [COLORS.orange]: 'ping-row__latency--orange',
  [COLORS.red]: 'ping-row__latency--red',
};

// Couleur propre à ce ping (échec/lent/bon), indépendante de ses voisins —
// contrairement à colorAt() (fenêtre glissante, pensée pour lisser la carte
// et le résumé), un échec doit toujours s'afficher en rouge dans la liste,
// jamais en orange à cause de pings voisins réussis.
function pingOwnColor(ping) {
  if (!ping.success) return COLORS.red;
  if (ping.elapsedMs > settings.thresholds.orangeMinLatencyMs) return COLORS.orange;
  return ping.elapsedMs > settings.thresholds.yellowMinLatencyMs ? COLORS.yellow : COLORS.green;
}

// `at` permet d'afficher une heure prévue (prévision) plutôt que l'heure
// réelle d'enregistrement du ping.
function buildPingRow(ping, color, at = new Date(ping.sentAt)) {
  const row = document.createElement('div');
  row.className = 'ping-row';
  const time = at.toLocaleTimeString('fr-FR');
  const latencyClass = LATENCY_CLASS_BY_COLOR[color] || 'ping-row__latency--red';
  const latencyText = ping.success ? `${ping.elapsedMs} ms` : 'Échec';

  row.innerHTML = `
    <span class="ping-row__time">${time}</span>
    <span class="ping-row__pos">${escapeHtml(formatPingPosition(ping))}</span>
    <span class="ping-row__latency ${latencyClass}">${latencyText}</span>
  `;
  return row;
}

function renderPingList(container, pings) {
  if (pings.length === 0) {
    container.innerHTML = '<div class="empty-state">Aucun ping pour le moment.</div>';
    return;
  }
  container.innerHTML = '';
  pings.forEach((ping) => container.appendChild(buildPingRow(ping, pingOwnColor(ping))));
}

// ---------- Détail d'un trajet (carte + contrôle de l'enregistrement) ----------

function describeGeoError(err) {
  if (!err) return null;
  switch (err.code) {
    case 1:
      return "accès à la position refusé — autorise la géolocalisation dans les réglages du navigateur";
    case 2:
      return 'position indisponible pour le moment';
    case 3:
      return 'délai dépassé pour obtenir la position';
    default:
      return err.message || 'géolocalisation indisponible';
  }
}

function updateGpsStatus(position, err, el = document.getElementById('gpsStatus')) {
  if (position) {
    el.textContent = `Position GPS : ${position.lat.toFixed(5)}, ${position.lng.toFixed(5)} (± ${Math.round(position.accuracy)} m)`;
    el.classList.remove('status-bar--warning');
    return;
  }
  const reason = describeGeoError(err);
  el.textContent = reason
    ? `Aucune position GPS captée — ${reason}`
    : 'Aucune position GPS captée pour le moment…';
  el.classList.add('status-bar--warning');
}

function updateLiveSummary(allPings, lastPing) {
  const okCount = allPings.filter((p) => p.success).length;
  const lastText = lastPing ? ` — dernier : ${lastPing.success ? lastPing.elapsedMs + ' ms' : 'échec'}` : '';
  document.getElementById('reviewSummary').textContent =
    `${allPings.length} pings — ${okCount}/${allPings.length} réussis${lastText}`;
}

function updateStaticSummary(pings) {
  const summary = tripSummary(pings, settings);
  document.getElementById('reviewSummary').textContent =
    `${pings.length} pings — 🟢 ${summary.percentages.green}% · 🟡 ${summary.percentages.yellow}% · 🟠 ${summary.percentages.orange}% · 🔴 ${summary.percentages.red}%`;
}

function buildRecordCallbacks(pingListEl) {
  return {
    onPing: (ping, allPings) => {
      recordMapView.render(allPings, settings);
      recordMapView.panTo(ping);
      updateLiveSummary(allPings, ping);
      renderPingList(pingListEl, allPings);
      pingListEl.scrollTop = pingListEl.scrollHeight;
    },
    onStatus: (status) => {
      if (status.type === 'error' || status.type === 'warning') {
        document.getElementById('reviewSummary').textContent = status.message;
      }
    },
    onPosition: (position, err) => {
      updateGpsStatus(position, err);
      if (position) recordMapView.setCurrentPosition(position.lat, position.lng);
    },
  };
}

// Bascule l'apparence de l'écran selon qu'un enregistrement est actif pour
// le trajet affiché : bouton, position GPS et suppression (désactivée tant
// que le trajet est en cours d'enregistrement).
function setLiveState(isLive) {
  const btn = document.getElementById('btnToggleRecording');
  if (isLive) {
    btn.innerHTML = `${STOP_ICON} Arrêter l'enregistrement`;
    btn.classList.remove('btn-primary');
    btn.classList.add('btn-danger');
  } else {
    btn.innerHTML = `${PLAY_ICON} Démarrer l'enregistrement`;
    btn.classList.remove('btn-danger');
    btn.classList.add('btn-primary');
  }
  document.getElementById('gpsStatus').style.display = isLive ? '' : 'none';
  document.getElementById('reviewDeleteSlot').style.display = isLive ? 'none' : '';
  if (!isLive) recordMapView.clearCurrentPosition();

  currentTripPings = isLive ? [] : currentTripPings;
  renderForecast();
}

async function loadTripDetail(tripId) {
  currentTripId = tripId;
  showDetailTab('record'); // rend le conteneur visible avant de (re)mesurer la carte
  if (!recordMapView) recordMapView = new MapView('mapRecord');
  recordMapView.clear();
  recordMapView.invalidate(); // l'écran était caché (display:none) jusqu'ici
  renderReviewDeleteIcon();
  document.getElementById('departureTime').value = defaultTimeString();

  const pingListEl = document.getElementById('pingListReview');
  const isLive = recorder && recorder.tripId === tripId;
  setLiveState(isLive);

  if (isLive) {
    recordMapView.render(recorder.pings, settings);
    renderPingList(pingListEl, recorder.pings);
    pingListEl.scrollTop = pingListEl.scrollHeight;
    updateLiveSummary(recorder.pings);
    return;
  }

  document.getElementById('reviewSummary').textContent = 'Chargement…';
  pingListEl.innerHTML = '<div class="empty-state">Chargement…</div>';
  try {
    const pings = await getTripPings(tripId);
    recordMapView.render(pings, settings);
    renderPingList(pingListEl, pings);
    updateStaticSummary(pings);
    currentTripPings = pings;
    renderForecast();
  } catch (err) {
    document.getElementById('reviewSummary').textContent = `Erreur : ${err.message}`;
    pingListEl.innerHTML = '';
  }
}

// ---------- Onglets du détail (Enregistrement / Prévision) ----------

function showDetailTab(tab) {
  document.querySelectorAll('.detail-tab').forEach((btn) => btn.classList.toggle('active', btn.dataset.tab === tab));
  document.getElementById('tabRecord').style.display = tab === 'record' ? '' : 'none';
  document.getElementById('tabForecast').style.display = tab === 'forecast' ? '' : 'none';
  // Le conteneur qui vient d'être révélé (display:none -> visible) doit se
  // remesurer, sinon Leaflet garde la taille (souvent nulle) qu'il avait à sa
  // création. Si la carte de prévision avait été construite/ajustée pendant
  // qu'elle était encore cachée, on force un nouveau cadrage maintenant
  // qu'elle est réellement visible.
  if (tab === 'record' && recordMapView) recordMapView.invalidate();
  if (tab === 'forecast' && forecastMapView) {
    forecastMapView.invalidate();
    forecastMapView.hasFitOnce = false;
    renderForecast();
  }
}

document.querySelectorAll('.detail-tab').forEach((btn) => {
  btn.addEventListener('click', () => showDetailTab(btn.dataset.tab));
});

// ---------- Prévision du signal sur le reste du trajet ----------

const CATEGORY_INFO = {
  [COLORS.green]: { label: 'Bon réseau', dotClass: 'dot--green' },
  [COLORS.yellow]: { label: 'Réseau lent', dotClass: 'dot--yellow' },
  [COLORS.orange]: { label: 'Réseau instable', dotClass: 'dot--orange' },
  [COLORS.red]: { label: 'Pas de réseau', dotClass: 'dot--red' },
};

function defaultTimeString() {
  const now = new Date();
  return `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
}

function formatHM(date) {
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

// Un ping isolé qui tranche avec ses voisins immédiats (ex: 3 bons, 1
// instable, 3 bons) est ignoré pour le regroupement : s'il diffère des 3
// pings précédents ET des 3 pings suivants, alors que ceux-ci sont tous
// identiques entre eux, on l'absorbe dans la catégorie environnante plutôt
// que de créer une zone à part pour un seul point de bruit.
const NOISE_CONTEXT_SIZE = 3;

function denoiseIsolatedPings(colors) {
  const result = [...colors];
  for (let i = NOISE_CONTEXT_SIZE; i < colors.length - NOISE_CONTEXT_SIZE; i++) {
    const before = colors.slice(i - NOISE_CONTEXT_SIZE, i);
    const after = colors.slice(i + 1, i + 1 + NOISE_CONTEXT_SIZE);
    const beforeUniform = before.every((c) => c === before[0]);
    const afterUniform = after.every((c) => c === after[0]);
    if (beforeUniform && afterUniform && before[0] === after[0] && colors[i] !== before[0]) {
      result[i] = before[0];
    }
  }
  return result;
}

// La fenêtre glissante regarde en arrière : juste après la fin d'une
// mauvaise passe, il faut plusieurs pings propres avant qu'elle ne "se
// nettoie" complètement — des pings réellement bons restent alors comptés
// dans la zone qui se termine. On corrige en rattachant les derniers pings
// d'une zone à la zone suivante (meilleure) s'ils sont, à titre individuel,
// déjà au niveau de celle-ci.
function trimTrailingRecovery(colors, ordered) {
  const result = [...colors];
  let i = 0;
  while (i < result.length) {
    let j = i;
    while (j + 1 < result.length && result[j + 1] === result[i]) j++;

    if (j + 1 < result.length) {
      const nextColor = result[j + 1];
      if (categoryRank(nextColor) < categoryRank(result[i])) {
        let k = j;
        while (k >= i && categoryRank(pingOwnColor(ordered[k])) <= categoryRank(nextColor)) {
          result[k] = nextColor;
          k--;
        }
      }
    }
    i = j + 1;
  }
  return result;
}

// Regroupe les pings consécutifs de même catégorie et calcule la durée de
// chaque zone à partir des écarts de temps réellement mesurés lors de
// l'enregistrement (pas de recalcul de vitesse : on reprend le rythme exact).
function computeRawSegments(pings, direction, settings) {
  const ordered = direction === 'retour' ? [...pings].reverse() : pings;
  let colors = denoiseIsolatedPings(ordered.map((_, i) => colorAt(ordered, i, settings)));
  colors = trimTrailingRecovery(colors, ordered);
  const gaps = [];
  for (let i = 0; i < ordered.length - 1; i++) {
    gaps.push(Math.abs(new Date(ordered[i + 1].sentAt) - new Date(ordered[i].sentAt)));
  }

  const segments = [];
  let i = 0;
  while (i < ordered.length) {
    const color = colors[i];
    let j = i;
    while (j + 1 < ordered.length && colors[j + 1] === color) j++;

    let durationMs = 0;
    for (let k = i; k < j; k++) durationMs += gaps[k];
    if (j < ordered.length - 1) durationMs += gaps[j];

    segments.push({ color, durationMs, startIndex: i, endIndex: j });
    i = j + 1;
  }
  return { ordered, segments };
}

// Fusionne les zones courtes qui alternent entre deux catégories voisines
// (ex: bon/lent, lent/instable) en une seule zone "X à Y" — l'objectif est
// de réduire les allers-retours de quelques minutes plutôt que de les lister
// un par un. On ne fusionne que si la nouvelle zone reste au plus 2 (rangs
// adjacents), et seulement quand l'un des deux côtés est encore "court".
function mergeAdjacentSegments(segments, thresholdMs) {
  if (segments.length === 0) return [];
  const first = segments[0];
  const groups = [{ ...first, minRank: categoryRank(first.color), maxRank: categoryRank(first.color) }];

  for (let i = 1; i < segments.length; i++) {
    const seg = segments[i];
    const segRank = categoryRank(seg.color);
    const group = groups[groups.length - 1];
    const newMin = Math.min(group.minRank, segRank);
    const newMax = Math.max(group.maxRank, segRank);
    const canMerge = newMax - newMin <= 1 && (seg.durationMs < thresholdMs || group.durationMs < thresholdMs);

    if (canMerge) {
      group.durationMs += seg.durationMs;
      group.endIndex = seg.endIndex;
      group.minRank = newMin;
      group.maxRank = newMax;
    } else {
      groups.push({ ...seg, minRank: segRank, maxRank: segRank });
    }
  }
  return groups;
}

// Deux groupes voisins peuvent porter le même intitulé (ex: deux zones
// "Réseau bon à lent" qui se suivent) si la première a été refermée à cause
// du seuil de durée avant que la seconde ne commence. Comme le libellé et la
// couleur seraient identiques, autant les fusionner en une seule entrée.
function mergeIdenticalAdjacentGroups(groups) {
  if (groups.length === 0) return [];
  const result = [{ ...groups[0] }];
  for (let i = 1; i < groups.length; i++) {
    const g = groups[i];
    const last = result[result.length - 1];
    if (g.minRank === last.minRank && g.maxRank === last.maxRank) {
      last.durationMs += g.durationMs;
      last.endIndex = g.endIndex;
    } else {
      result.push({ ...g });
    }
  }
  return result;
}

const CATEGORY_ADJ = { [COLORS.green]: 'bon', [COLORS.yellow]: 'lent', [COLORS.orange]: 'instable', [COLORS.red]: 'coupé' };
const RANK_COLOR = [COLORS.green, COLORS.yellow, COLORS.orange, COLORS.red];

function groupLabel(group) {
  if (group.minRank === group.maxRank) return CATEGORY_INFO[RANK_COLOR[group.minRank]].label;
  return `Réseau ${CATEGORY_ADJ[RANK_COLOR[group.minRank]]} à ${CATEGORY_ADJ[RANK_COLOR[group.maxRank]]}`;
}

function hexToRgb(hex) {
  const n = parseInt(hex.replace('#', ''), 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

function groupColor(group) {
  if (group.minRank === group.maxRank) return RANK_COLOR[group.minRank];
  const a = hexToRgb(RANK_COLOR[group.minRank]);
  const b = hexToRgb(RANK_COLOR[group.maxRank]);
  return `rgb(${Math.round((a.r + b.r) / 2)}, ${Math.round((a.g + b.g) / 2)}, ${Math.round((a.b + b.b) / 2)})`;
}

function paintDirectionToggle(allerId, retourId, direction) {
  document.getElementById(allerId).className = `btn ${direction === 'aller' ? 'btn-primary' : 'btn-secondary'}`;
  document.getElementById(retourId).className = `btn ${direction === 'retour' ? 'btn-primary' : 'btn-secondary'}`;
}

function setDirection(direction) {
  forecastDirection = direction;
  paintDirectionToggle('btnDirectionAller', 'btnDirectionRetour', direction);
  renderForecast();
}

document.getElementById('btnDirectionAller').addEventListener('click', () => setDirection('aller'));
document.getElementById('btnDirectionRetour').addEventListener('click', () => setDirection('retour'));
document.getElementById('departureTime').addEventListener('change', renderForecast);

// Prévision complète (liste + carte regroupée), partagée entre l'onglet
// Prévision d'un trajet et l'écran invité.
function drawForecast({ pings, direction, departureValue, listEl, mapView }) {
  const { ordered, segments } = computeRawSegments(pings, direction, settings);
  const thresholdMs = settings.rollingWindowSize * settings.pingIntervalMs * 2;
  const groups = mergeIdenticalAdjacentGroups(mergeAdjacentSegments(segments, thresholdMs));

  const [h, m] = departureValue.split(':').map(Number);
  const departure = new Date();
  departure.setHours(h || 0, m || 0, 0, 0);

  // Heure prévue de chaque ping : départ + temps écoulé depuis le premier
  // ping dans l'ordre de lecture choisi (aller ou retour).
  const predicted = [departure];
  for (let i = 1; i < ordered.length; i++) {
    const gap = Math.abs(new Date(ordered[i].sentAt) - new Date(ordered[i - 1].sentAt));
    predicted.push(new Date(predicted[i - 1].getTime() + gap));
  }

  listEl.innerHTML = '';
  let cursor = departure;
  groups.forEach((group) => {
    const start = cursor;
    cursor = new Date(cursor.getTime() + group.durationMs);
    const minutes = Math.max(1, Math.round(group.durationMs / 60000));
    listEl.appendChild(buildForecastGroupEl(group, ordered, predicted, start, cursor, minutes));
  });

  mapView.renderGrouped(ordered, groups, (g) => groupColor(g));
}

function renderForecast() {
  const listEl = document.getElementById('forecastList');

  if (currentTripPings.length < 2) {
    listEl.innerHTML = recorder
      ? '<div class="empty-state">Arrête l\'enregistrement pour générer une prévision.</div>'
      : '<div class="empty-state">Pas assez de données pour générer une prévision.</div>';
    if (forecastMapView) forecastMapView.clear();
    return;
  }

  if (!forecastMapView) forecastMapView = new MapView('mapForecast');
  drawForecast({
    pings: currentTripPings,
    direction: forecastDirection,
    departureValue: document.getElementById('departureTime').value,
    listEl,
    mapView: forecastMapView,
  });
}

// Ligne de groupe repliable : un clic déplie le détail des pings bruts
// couverts par ce groupe (heure prévue, position, temps de réponse).
function buildForecastGroupEl(group, ordered, predicted, start, end, minutes) {
  const color = groupColor(group);
  const wrapper = document.createElement('div');
  wrapper.className = 'forecast-group';

  const row = document.createElement('div');
  row.className = 'forecast-row forecast-row--clickable';
  row.innerHTML = `
    <span class="forecast-row__time">${formatHM(start)} – ${formatHM(end)}</span>
    <span class="forecast-row__label"><span class="dot" style="background:${color}"></span> ${groupLabel(group)}</span>
    <span class="forecast-row__duration">${minutes} min</span>
    <svg viewBox="0 0 24 24" class="icon forecast-row__chevron" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 9l6 6 6-6"/></svg>
  `;

  const detail = document.createElement('div');
  detail.className = 'forecast-group__detail';
  detail.style.display = 'none';

  row.addEventListener('click', () => {
    const isOpen = detail.style.display !== 'none';
    if (isOpen) {
      detail.style.display = 'none';
      row.classList.remove('forecast-row--open');
      return;
    }
    if (!detail.dataset.built) {
      for (let i = group.startIndex; i <= group.endIndex; i++) {
        const ping = ordered[i];
        detail.appendChild(buildPingRow(ping, pingOwnColor(ping), predicted[i]));
      }
      detail.dataset.built = '1';
    }
    detail.style.display = '';
    row.classList.add('forecast-row--open');
  });

  wrapper.appendChild(row);
  wrapper.appendChild(detail);
  return wrapper;
}

// ---------- Invité : carte générale ----------

const COVERAGE_CELL_DEG = 0.002; // ≈ 200 m, doit rester ≥ au plancher côté SQL

document.getElementById('btnGuestLogin').addEventListener('click', () => {
  setGuest(false);
  navigate('#auth', { replace: true });
});
document.getElementById('btnGuestStartTrip').addEventListener('click', () => navigate('#guest-trip'));
document.getElementById('btnGuestBack').addEventListener('click', () => navigate('#guest', { replace: true }));

async function loadCoverageMap() {
  if (!coverageMapView) coverageMapView = new MapView('mapCoverage');
  coverageMapView.invalidate();
  const summaryEl = document.getElementById('coverageSummary');
  summaryEl.textContent = 'Chargement de la couverture…';
  try {
    const cells = await getCoverageCells(COVERAGE_CELL_DEG, settings.thresholds.orangeMinLatencyMs);
    coverageMapView.renderCells(cells, COVERAGE_CELL_DEG, (cell) => colorForCell(cell, settings));
    const total = cells.reduce((sum, c) => sum + c.ping_count, 0);
    summaryEl.textContent = cells.length === 0
      ? 'Aucune donnée de couverture pour le moment.'
      : `${total.toLocaleString('fr-FR')} pings agrégés, tous trajets confondus`;
  } catch (err) {
    summaryEl.textContent = `Couverture indisponible : ${err.message}`;
  }
}

// ---------- Invité : prévision sur un itinéraire connu ----------

function formatDuration(minutes) {
  if (minutes < 60) return `${minutes} min`;
  return `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, '0')}`;
}

async function loadGuestTrip() {
  if (!guestTripMapView) guestTripMapView = new MapView('mapGuestTrip');
  guestTripMapView.invalidate();
  startGuestGps();

  const timeInput = document.getElementById('guestDepartureTime');
  if (!timeInput.value) timeInput.value = defaultTimeString();

  const select = document.getElementById('guestRoute');
  if (!guestRoutesLoaded) {
    select.innerHTML = '<option value="">Chargement…</option>';
    select.disabled = true;
    try {
      const routes = await listPublicRoutes();
      select.innerHTML = routes.length
        ? routes.map((r) => `<option value="${r.id}">${escapeHtml(r.name)} · ${formatDuration(r.duration_min)}</option>`).join('')
        : '<option value="">Aucun itinéraire disponible</option>';
      select.disabled = routes.length === 0;
      guestRoutesLoaded = true;
    } catch (err) {
      select.innerHTML = '<option value="">Itinéraires indisponibles</option>';
      document.getElementById('guestForecastList').innerHTML =
        `<div class="empty-state">Itinéraires indisponibles : ${escapeHtml(err.message)}</div>`;
      return;
    }
  }
  await selectGuestRoute(select.value);
}

async function selectGuestRoute(routeId) {
  const listEl = document.getElementById('guestForecastList');
  guestRoutePings = [];
  if (routeId) {
    listEl.innerHTML = '<div class="empty-state">Chargement…</div>';
    try {
      if (!routePingsCache.has(routeId)) routePingsCache.set(routeId, await getPublicRoutePings(routeId));
      guestRoutePings = routePingsCache.get(routeId);
    } catch (err) {
      listEl.innerHTML = `<div class="empty-state">Erreur : ${escapeHtml(err.message)}</div>`;
      return;
    }
  }
  renderGuestForecast();
}

function renderGuestForecast() {
  const listEl = document.getElementById('guestForecastList');
  if (guestRoutePings.length < 2) {
    listEl.innerHTML = '<div class="empty-state">Choisis un itinéraire pour voir la prévision.</div>';
    guestTripMapView.clear();
    return;
  }
  drawForecast({
    pings: guestRoutePings,
    direction: guestDirection,
    departureValue: document.getElementById('guestDepartureTime').value,
    listEl,
    mapView: guestTripMapView,
  });
}

function setGuestDirection(direction) {
  guestDirection = direction;
  paintDirectionToggle('btnGuestDirAller', 'btnGuestDirRetour', direction);
  renderGuestForecast();
}

document.getElementById('guestRoute').addEventListener('change', (e) => selectGuestRoute(e.target.value));
document.getElementById('btnGuestDirAller').addEventListener('click', () => setGuestDirection('aller'));
document.getElementById('btnGuestDirRetour').addEventListener('click', () => setGuestDirection('retour'));
document.getElementById('guestDepartureTime').addEventListener('change', renderGuestForecast);

// Position de l'invité sur la carte, sans rien enregistrer. Le suivi GPS ne
// tourne que tant que l'écran de prévision invité est affiché.
function startGuestGps() {
  if (guestGpsWatchId !== null) return;
  const statusEl = document.getElementById('guestGpsStatus');
  if (!('geolocation' in navigator)) {
    updateGpsStatus(null, { code: 0, message: 'géolocalisation indisponible sur cet appareil' }, statusEl);
    return;
  }
  updateGpsStatus(null, null, statusEl);
  guestGpsWatchId = navigator.geolocation.watchPosition(
    (pos) => {
      const position = { lat: pos.coords.latitude, lng: pos.coords.longitude, accuracy: pos.coords.accuracy };
      updateGpsStatus(position, null, statusEl);
      guestTripMapView.setCurrentPosition(position.lat, position.lng);
    },
    (err) => updateGpsStatus(null, err, statusEl),
    { enableHighAccuracy: true, maximumAge: 5000, timeout: 15000 }
  );
}

function stopGuestGps() {
  if (guestGpsWatchId === null) return;
  navigator.geolocation.clearWatch(guestGpsWatchId);
  guestGpsWatchId = null;
  if (guestTripMapView) guestTripMapView.clearCurrentPosition();
}

document.getElementById('btnStartTrip').addEventListener('click', async () => {
  if (!currentUser) return;
  const name = document.getElementById('tripNameInput').value.trim();

  recorder = new Recorder({ settings, ...buildRecordCallbacks(document.getElementById('pingListReview')) });
  await recorder.start(currentUser.id, name);

  navigate(`#review/${recorder.tripId}`);
});

document.getElementById('btnToggleRecording').addEventListener('click', async () => {
  const btn = document.getElementById('btnToggleRecording');

  if (recorder && recorder.tripId === currentTripId) {
    // Arrêter : on suspend le suivi mais on reste sur cette page, le trajet
    // reste consultable et reprenable plus tard.
    btn.disabled = true;
    document.getElementById('reviewSummary').textContent = 'Synchronisation…';
    await recorder.stop();
    recorder = null;
    btn.disabled = false;

    const pings = await getTripPings(currentTripId).catch(() => []);
    currentTripPings = pings;
    setLiveState(false);
    recordMapView.render(pings, settings);
    renderPingList(document.getElementById('pingListReview'), pings);
    updateStaticSummary(pings);
    return;
  }

  // Démarrer / reprendre ce trajet précis.
  btn.disabled = true;
  document.getElementById('reviewSummary').textContent = 'Chargement…';
  let trip;
  let existingPings;
  try {
    [trip, existingPings] = await Promise.all([getTrip(currentTripId), getTripPings(currentTripId)]);
  } catch (err) {
    document.getElementById('reviewSummary').textContent = `Erreur : ${err.message}`;
    btn.disabled = false;
    return;
  }

  recorder = new Recorder({
    settings: { ...settings, pingIntervalMs: trip.ping_interval_ms, pingTimeoutMs: trip.ping_timeout_ms },
    ...buildRecordCallbacks(document.getElementById('pingListReview')),
  });

  setLiveState(true);
  updateGpsStatus(null, null);
  recordMapView.render(existingPings, settings);
  renderPingList(document.getElementById('pingListReview'), existingPings);

  btn.disabled = false;
  await recorder.resumeExisting(currentTripId, existingPings);
});

document.getElementById('btnBackFromReview').addEventListener('click', () => {
  history.back();
});

function renderReviewDeleteIcon() {
  const slot = document.getElementById('reviewDeleteSlot');
  slot.innerHTML = `<button type="button" class="btn-icon" aria-label="Supprimer ce trajet">${TRASH_ICON}</button>`;
  slot.querySelector('button').addEventListener('click', renderReviewDeleteConfirm);
}

function renderReviewDeleteConfirm() {
  const slot = document.getElementById('reviewDeleteSlot');
  slot.innerHTML = `
    <div class="trip-row__confirm">
      <button type="button" class="btn btn-ghost" data-role="cancel">Annuler</button>
      <button type="button" class="btn btn-danger" data-role="confirm">Supprimer</button>
    </div>
  `;

  slot.querySelector('[data-role="cancel"]').addEventListener('click', renderReviewDeleteIcon);

  slot.querySelector('[data-role="confirm"]').addEventListener('click', async () => {
    slot.innerHTML = '<span class="trip-row__meta">Suppression…</span>';
    try {
      await deleteTrip(currentTripId);
      navigate('#home', { replace: true });
    } catch (err) {
      slot.innerHTML = `<span class="error-text">${escapeHtml(err.message)}</span>`;
    }
  });
}

// ---------- Réglages ----------

function loadSettingsIntoForm() {
  document.getElementById('setInterval').value = settings.pingIntervalMs / 1000;
  document.getElementById('setTimeout').value = settings.pingTimeoutMs / 1000;
  document.getElementById('setWindow').value = settings.rollingWindowSize;
  document.getElementById('setRed').value = Math.round(settings.thresholds.redMaxSuccessRate * 100);
  document.getElementById('setOrange').value = Math.round(settings.thresholds.orangeMaxSuccessRate * 100);
  document.getElementById('setYellow').value = settings.thresholds.yellowMinLatencyMs;
  document.getElementById('setOrangeLatency').value = settings.thresholds.orangeMinLatencyMs;
}

document.getElementById('btnSaveSettings').addEventListener('click', () => {
  settings = {
    pingIntervalMs: Number(document.getElementById('setInterval').value) * 1000,
    pingTimeoutMs: Number(document.getElementById('setTimeout').value) * 1000,
    rollingWindowSize: Number(document.getElementById('setWindow').value),
    thresholds: {
      redMaxSuccessRate: Number(document.getElementById('setRed').value) / 100,
      orangeMaxSuccessRate: Number(document.getElementById('setOrange').value) / 100,
      yellowMinLatencyMs: Number(document.getElementById('setYellow').value),
      orangeMinLatencyMs: Number(document.getElementById('setOrangeLatency').value),
    },
  };
  saveSettings(settings);
  navigate('#home', { replace: true });
});

// ---------- Démarrage de l'app ----------

(async function init() {
  loadSettingsIntoForm();
  currentUser = await getCurrentUser();
  if (currentUser) {
    document.getElementById('userBadge').textContent = currentUser.email;
    if (!location.hash) {
      navigate('#home', { replace: true });
    } else {
      route();
    }
  } else {
    enterSignedOut();
  }
})();
