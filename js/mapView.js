import { colorAt } from './quality.js';

const PING_POINT_RADIUS = 9;

// Fond vectoriel OpenFreeMap « Bright » (gratuit, sans clé), sans les
// lignes de ferry en pointillés. Le style est chargé et filtré une seule
// fois pour toutes les cartes.
const BASEMAP_STYLE_URL = 'https://tiles.openfreemap.org/styles/bright';
const HIDDEN_LAYER_IDS = new Set(['ferry']);
let basemapStylePromise = null;

function loadBasemapStyle() {
  if (!basemapStylePromise) {
    basemapStylePromise = fetch(BASEMAP_STYLE_URL)
      .then((response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.json();
      })
      .then((style) => {
        style.layers = style.layers.filter((layer) => !HIDDEN_LAYER_IDS.has(layer.id));
        return style;
      });
  }
  return basemapStylePromise;
}

function addRasterFallback(map) {
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; OpenStreetMap contributors',
    maxZoom: 19,
  }).addTo(map);
}

function addBasemap(map) {
  if (!L.maplibreGL || !window.maplibregl) {
    addRasterFallback(map);
    return;
  }
  loadBasemapStyle()
    .then((style) => {
      L.maplibreGL({
        style,
        attribution: '&copy; <a href="https://openfreemap.org">OpenFreeMap</a> &copy; OpenStreetMap',
        pane: 'tilePane', // reste sous les tracés et le point GPS
      }).addTo(map);
    })
    .catch(() => addRasterFallback(map));
}

export class MapView {
  constructor(elementId) {
    this.map = L.map(elementId).setView([46.6, 2.3], 6); // centre France par défaut
    addBasemap(this.map);

    this.segmentLayers = [];
    this.hasFitOnce = false;
    this.currentPositionMarker = null;
  }

  clear() {
    this.segmentLayers.forEach((layer) => this.map.removeLayer(layer));
    this.segmentLayers = [];
    this.hasFitOnce = false;
  }

  render(pings, settings) {
    this.clear();
    const withPos = pings.filter((p) => p.startLat != null && p.startLng != null);
    if (withPos.length === 0) return;

    // On dessine un segment par paire de pings consécutifs, coloré selon la
    // fenêtre glissante se terminant sur le second point du segment.
    for (let i = 1; i < pings.length; i++) {
      const a = pings[i - 1];
      const b = pings[i];
      const posA = pointOf(a);
      const posB = pointOf(b);
      if (!posA || !posB) continue;

      const color = colorAt(pings, i, settings);
      const line = L.polyline([posA, posB], { color, weight: 5, opacity: 0.85 }).addTo(this.map);
      this.segmentLayers.push(line);
    }

    // un point à l'emplacement de chaque ping, coloré selon sa propre fenêtre glissante
    pings.forEach((ping, i) => {
      const pos = pointOf(ping);
      if (!pos) return;
      const color = colorAt(pings, i, settings);
      const marker = L.circleMarker(pos, {
        radius: PING_POINT_RADIUS,
        color,
        weight: 1,
        fillColor: color,
        fillOpacity: 0.9,
      }).addTo(this.map);
      this.segmentLayers.push(marker);
    });

    const bounds = L.latLngBounds(withPos.map(pointOf));
    if (!this.hasFitOnce) {
      this.map.fitBounds(bounds, { maxZoom: 14 });
      this.hasFitOnce = true;
    }

    // render() redessine les pings par-dessus tout ce qui existait déjà —
    // sans ça, le marqueur de position (ajouté avant) se retrouve enterré
    // sous les nouveaux points à chaque ping.
    if (this.currentPositionMarker) this.currentPositionMarker.bringToFront();
  }

  // Affiche les zones regroupées de la prévision (pas les pings un par un) :
  // un segment épais par groupe, coloré par la fonction fournie par l'appelant
  // (mélange de couleurs pour une zone à deux catégories).
  renderGrouped(orderedPings, groups, colorForGroup) {
    this.clear();
    const positions = orderedPings.map(pointOf).filter(Boolean);
    if (positions.length === 0) return;

    groups.forEach((group) => {
      const points = [];
      for (let i = group.startIndex; i <= group.endIndex; i++) {
        const pos = pointOf(orderedPings[i]);
        if (pos) points.push(pos);
      }
      if (points.length < 2) {
        if (points.length === 1) {
          const marker = L.circleMarker(points[0], {
            radius: PING_POINT_RADIUS,
            color: colorForGroup(group),
            weight: 1,
            fillColor: colorForGroup(group),
            fillOpacity: 0.9,
          }).addTo(this.map);
          this.segmentLayers.push(marker);
        }
        return;
      }
      const line = L.polyline(points, { color: colorForGroup(group), weight: 8, opacity: 0.9 }).addTo(this.map);
      this.segmentLayers.push(line);
    });

    const bounds = L.latLngBounds(positions);
    if (!this.hasFitOnce) {
      this.map.fitBounds(bounds, { maxZoom: 14 });
      this.hasFitOnce = true;
    }

    if (this.currentPositionMarker) this.currentPositionMarker.bringToFront();
  }

  // Carte générale : un point coloré par zone géographique agrégée. Rendu
  // canvas plutôt que SVG, les zones pouvant se compter par milliers. Le
  // rayon suit le zoom (pour couvrir la case une fois zoomé) avec un minimum
  // lisible : vue de loin, une case de 200 m ne ferait qu'un pixel.
  renderCells(cells, cellDeg, colorForCell) {
    this.clear();
    if (cells.length === 0) return;
    if (!this.canvasRenderer) this.canvasRenderer = L.canvas({ padding: 0.5 });
    this.cellDeg = cellDeg;

    cells.forEach((cell) => {
      const color = colorForCell(cell);
      const marker = L.circleMarker([cell.lat, cell.lng], {
        renderer: this.canvasRenderer,
        radius: 4,
        stroke: false,
        fillColor: color,
        fillOpacity: 0.85,
      }).addTo(this.map);
      this.segmentLayers.push(marker);
    });

    if (!this.cellZoomHandler) {
      this.cellZoomHandler = () => this.resizeCells();
      this.map.on('zoomend', this.cellZoomHandler);
    }

    const bounds = L.latLngBounds(cells.map((c) => [c.lat, c.lng]));
    this.map.fitBounds(bounds, { maxZoom: 12 });
    this.hasFitOnce = true;
    this.resizeCells();
  }

  resizeCells() {
    if (!this.cellDeg) return;
    const center = this.map.getCenter();
    const a = this.map.latLngToContainerPoint(center);
    const b = this.map.latLngToContainerPoint([center.lat + this.cellDeg, center.lng]);
    const radius = Math.max(4, Math.abs(a.y - b.y) * 0.6);
    this.segmentLayers.forEach((layer) => {
      if (layer.setRadius) layer.setRadius(radius);
    });
  }

  // Pendant l'enregistrement, on recentre en continu sur le dernier point.
  panTo(ping) {
    const pos = pointOf(ping);
    if (pos) this.map.panTo(pos, { animate: true });
  }

  // Leaflet calcule sa taille à la création : si le conteneur était encore
  // caché (display:none) à ce moment-là, la carte ne s'affiche qu'à moitié.
  // À appeler juste après que l'écran devient visible.
  invalidate() {
    this.map.invalidateSize();
  }

  // Marqueur "vous êtes ici", distinct des points de ping — mis à jour en
  // place à chaque nouvelle position plutôt que recréé.
  setCurrentPosition(lat, lng) {
    const latlng = [lat, lng];
    if (this.currentPositionMarker) {
      this.currentPositionMarker.setLatLng(latlng);
    } else {
      this.currentPositionMarker = L.circleMarker(latlng, {
        radius: 9,
        color: '#ffffff',
        weight: 3,
        fillColor: '#4285f4',
        fillOpacity: 1,
      }).addTo(this.map);
    }
    this.currentPositionMarker.bringToFront();
  }

  clearCurrentPosition() {
    if (this.currentPositionMarker) {
      this.map.removeLayer(this.currentPositionMarker);
      this.currentPositionMarker = null;
    }
  }
}

function pointOf(ping) {
  // Priorité à la position de résolution (plus proche de l'endroit réel où
  // le résultat du ping s'est confirmé), avec repli sur la position de départ.
  if (ping.endLat != null && ping.endLng != null) return [ping.endLat, ping.endLng];
  if (ping.startLat != null && ping.startLng != null) return [ping.startLat, ping.startLng];
  return null;
}
