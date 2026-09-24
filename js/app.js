import { signIn, signUp, signOut, getCurrentUser, onAuthStateChange } from './auth.js';
import { getSettings, saveSettings } from './settings.js';
import { listTrips, getTripPings, getTrip, deleteTrip } from './trips.js';
import { Recorder } from './recorder.js';
import { MapView } from './mapView.js';
import { tripSummary, colorForCell, COLORS } from './quality.js';
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

// ---------- Prévision : fenêtres de travail ----------
//
// Le réseau en train alterne toutes les une à trois minutes : découper la
// prévision en zones de couleur produisait des dizaines de zones de moins de
// cinq minutes, inexploitables. On raisonne plutôt en deux états — un ping
// est utilisable s'il réussit sous le seuil de latence — puis on absorbe le
// bruit : une coupure trop courte devient une micro-coupure comptée dans la
// fenêtre qui l'entoure, une reprise trop courte est ignorée au milieu d'un
// trou. Chaque fenêtre reçoit enfin un verdict adapté au télétravail.

const WINDOW_LEVELS = {
  visio: { label: 'Visio possible', color: COLORS.green },
  fluide: { label: 'Navigation fluide', color: COLORS.yellow },
  hachee: { label: 'Connexion hachée', color: COLORS.orange },
  off: { label: 'Pas de connexion exploitable', color: COLORS.red },
};

function defaultTimeString() {
  const now = new Date();
  return `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
}

function formatHM(date) {
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

function isUsable(ping) {
  return ping.success && ping.elapsedMs <= settings.thresholds.orangeMinLatencyMs;
}

// Durée couverte par chaque ping : l'écart jusqu'au suivant (le dernier
// reprend l'écart précédent). Les écarts sont en valeur absolue pour que le
// sens retour, qui inverse l'ordre des pings, reste positif.
function pingSpans(ordered) {
  const gap = (i, j) => Math.abs(new Date(ordered[j].sentAt) - new Date(ordered[i].sentAt));
  return ordered.map((_, i) => {
    if (i + 1 < ordered.length) return gap(i, i + 1);
    return i > 0 ? gap(i - 1, i) : 0;
  });
}

function computeWorkWindows(pings, direction) {
  const ordered = direction === 'retour' ? [...pings].reverse() : pings;
  const spans = pingSpans(ordered);

  const runs = [];
  ordered.forEach((ping, i) => {
    const ok = isUsable(ping);
    const last = runs[runs.length - 1];
    if (last && last.ok === ok) {
      last.endIndex = i;
      last.durationMs += spans[i];
    } else {
      runs.push({ ok, startIndex: i, endIndex: i, durationMs: spans[i] });
    }
  });

  // On absorbe d'abord la période trop courte la plus brève, puis on
  // recommence : une coupure isolée fusionne ses deux voisines, une période en
  // bord de trajet rejoint son unique voisine.
  // Valeurs de repli si le réglage manque : juste après une mise en ligne, le
  // navigateur peut encore servir un ancien config.js (cache de 10 min de
  // GitHub Pages) qui ne les définit pas — sans repli, tout fusionnerait en
  // une seule fenêtre.
  const minutes = (value, fallback) => (Number.isFinite(value) ? value : fallback) * 60000;
  const minCutMs = minutes(settings.minCutMin, 2);
  const minWindowMs = minutes(settings.minWindowMin, 4);
  while (runs.length > 1) {
    let k = -1;
    runs.forEach((run, i) => {
      if (run.durationMs >= (run.ok ? minWindowMs : minCutMs)) return;
      if (k === -1 || run.durationMs < runs[k].durationMs) k = i;
    });
    if (k === -1) break;

    const from = Math.max(0, k - 1);
    const to = Math.min(runs.length - 1, k + 1);
    const neighbour = k === 0 ? runs[1] : runs[k - 1];
    const merged = runs.slice(from, to + 1);
    runs.splice(from, merged.length, {
      ok: neighbour.ok,
      startIndex: merged[0].startIndex,
      endIndex: merged[merged.length - 1].endIndex,
      durationMs: merged.reduce((sum, r) => sum + r.durationMs, 0),
    });
  }

  return { ordered, spans, windows: runs.map((run) => describeWindow(ordered, spans, run)) };
}

function describeWindow(ordered, spans, run) {
  const latencies = [];
  let microCuts = 0;
  let streakMs = 0;
  let bestStreakMs = 0;
  let previousUsable = true;
  for (let i = run.startIndex; i <= run.endIndex; i++) {
    const usable = isUsable(ordered[i]);
    if (usable) {
      latencies.push(ordered[i].elapsedMs);
      streakMs += spans[i];
      bestStreakMs = Math.max(bestStreakMs, streakMs);
    } else {
      if (previousUsable) microCuts++;
      streakMs = 0;
    }
    previousUsable = usable;
  }

  const usableRatio = latencies.length / (run.endIndex - run.startIndex + 1);
  latencies.sort((a, b) => a - b);
  const medianMs = latencies.length ? latencies[Math.floor(latencies.length / 2)] : null;

  let level = 'off';
  if (run.ok) {
    if (usableRatio >= 0.95 && medianMs <= settings.thresholds.yellowMinLatencyMs) level = 'visio';
    else if (usableRatio >= 0.85) level = 'fluide';
    else level = 'hachee';
  }
  return { ...run, usableRatio, medianMs, microCuts, bestStreakMs, level };
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

// Prévision complète (liste + carte), partagée entre l'onglet Prévision d'un
// trajet et l'écran invité.
function drawForecast({ pings, direction, departureValue, listEl, mapView }) {
  const { ordered, spans, windows } = computeWorkWindows(pings, direction);

  const [h, m] = departureValue.split(':').map(Number);
  const departure = new Date();
  departure.setHours(h || 0, m || 0, 0, 0);

  // Heure prévue de chaque ping : départ + temps écoulé dans l'ordre de
  // lecture choisi (aller ou retour).
  const predicted = [departure];
  for (let i = 1; i < ordered.length; i++) {
    predicted.push(new Date(predicted[i - 1].getTime() + spans[i - 1]));
  }

  listEl.innerHTML = '';
  windows.forEach((win) => listEl.appendChild(buildWindowEl(win, ordered, predicted)));
  mapView.renderGrouped(ordered, windows, (win) => WINDOW_LEVELS[win.level].color);
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

function formatDurationMs(ms) {
  return formatDuration(Math.max(1, Math.round(ms / 60000)));
}

function windowDetails(win) {
  const percent = `${Math.round(win.usableRatio * 100)} % utilisable`;
  if (win.level === 'off') return win.usableRatio > 0 ? percent : '';
  const cuts = win.microCuts === 0
    ? 'aucune micro-coupure'
    : `${win.microCuts} micro-coupure${win.microCuts > 1 ? 's' : ''}`;
  return `${percent} · ${cuts} · ${formatDurationMs(win.bestStreakMs)} sans coupure au plus`;
}

// Ligne de fenêtre repliable : un clic déplie le détail des pings bruts
// qu'elle couvre (heure prévue, position, temps de réponse).
function buildWindowEl(win, ordered, predicted) {
  const level = WINDOW_LEVELS[win.level];
  const start = predicted[win.startIndex];
  const end = new Date(start.getTime() + win.durationMs);
  const details = windowDetails(win);

  const wrapper = document.createElement('div');
  wrapper.className = 'forecast-group';

  const row = document.createElement('div');
  row.className = `forecast-row forecast-row--clickable${win.level === 'off' ? ' forecast-row--off' : ''}`;
  row.innerHTML = `
    <span class="forecast-row__time">${formatHM(start)} – ${formatHM(end)}</span>
    <span class="forecast-row__body">
      <span class="forecast-row__label"><span class="dot" style="background:${level.color}"></span> ${level.label}</span>
      ${details ? `<span class="forecast-row__meta">${details}</span>` : ''}
    </span>
    <span class="forecast-row__duration">${formatDurationMs(win.durationMs)}</span>
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
      for (let i = win.startIndex; i <= win.endIndex; i++) {
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
  document.getElementById('setMinCut').value = settings.minCutMin;
  document.getElementById('setMinWindow').value = settings.minWindowMin;
}

document.getElementById('btnSaveSettings').addEventListener('click', () => {
  settings = {
    pingIntervalMs: Number(document.getElementById('setInterval').value) * 1000,
    pingTimeoutMs: Number(document.getElementById('setTimeout').value) * 1000,
    rollingWindowSize: Number(document.getElementById('setWindow').value),
    minCutMin: Number(document.getElementById('setMinCut').value),
    minWindowMin: Number(document.getElementById('setMinWindow').value),
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
