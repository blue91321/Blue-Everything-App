/**
 * A trip on a map: its airports, the line each flight flies, and its places.
 *
 * Leaflet over OpenStreetMap's own tiles, chosen when the trips screen was
 * asked for: a real map you can pan and zoom is the one thing here that cannot
 * be hand-drawn the way the weather graph is. It is the only runtime
 * dependency in the app besides React, and it costs nothing until this screen
 * opens, since the screen is its own chunk.
 *
 * Three details:
 *
 *   - **No marker images.** Leaflet's default pin is a PNG found by a path its
 *     CSS guesses, which a bundler breaks. Circles are drawn as SVG, take the
 *     accent, and need no files.
 *   - **Names go in as text nodes, never as HTML.** A tooltip given a string is
 *     set as `innerHTML`, and a place's name came from a stranger's map edit or
 *     from you; either way it is not markup. The same reason the notes renderer
 *     builds elements.
 *   - **On a dark theme the tiles are inverted**, by a CSS filter in `trips.css`.
 *     OpenStreetMap draws only a light map, and a white rectangle in a dark app
 *     is the brightest thing on screen.
 */
import { useEffect, useRef } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { KIND_LABEL, type Flight, type Place } from './trips-api';

function label(text: string): HTMLElement {
  const el = document.createElement('span');
  el.textContent = text;
  return el;
}

function accent(): string {
  return getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#4a8cff';
}

export function TripMap({
  flights,
  places,
  focus,
}: {
  flights: Flight[];
  places: Place[];
  /** A place to centre on, when one is picked from the list. */
  focus?: { lat: number; lon: number; at: number } | null;
}) {
  const box = useRef<HTMLDivElement>(null);
  const map = useRef<L.Map | null>(null);
  const layer = useRef<L.LayerGroup | null>(null);

  // The map itself, once.
  useEffect(() => {
    if (!box.current) return;
    const m = L.map(box.current, { worldCopyJump: true, zoomControl: true, attributionControl: true });
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    }).addTo(m);
    m.setView([20, 0], 2);
    map.current = m;
    layer.current = L.layerGroup().addTo(m);
    /*
     * Measured once more after layout settles: the box can be zero-sized for
     * the frame it mounts in, and a map sized at zero draws one grey tile. A
     * timeout rather than requestAnimationFrame, which does not run in a pane
     * that is not drawing.
     */
    const t = setTimeout(() => m.invalidateSize(), 50);
    const onResize = () => m.invalidateSize();
    window.addEventListener('resize', onResize);
    return () => {
      clearTimeout(t);
      window.removeEventListener('resize', onResize);
      m.remove();
      map.current = null;
      layer.current = null;
    };
  }, []);

  /*
   * What is on it, redrawn only when what is on it changes. The props are new
   * arrays on every render (the screen redraws as its clock ticks), and
   * refitting the view each time would throw away wherever you had panned to.
   */
  const signature = JSON.stringify([
    flights.map((f) => [f.id, f.from.iata, f.to.iata]),
    places.map((p) => [p.id, p.lat, p.lon, p.kind, p.name]),
  ]);
  useEffect(() => {
    const m = map.current;
    const g = layer.current;
    if (!m || !g) return;
    g.clearLayers();
    const colour = accent();
    const points: L.LatLngExpression[] = [];
    const seen = new Set<string>();

    for (const f of flights) {
      L.polyline(f.route, { color: colour, weight: 2, opacity: 0.8, dashArray: '6 6' }).addTo(g);
      for (const a of [f.from, f.to]) {
        points.push([a.lat, a.lon]);
        if (seen.has(a.iata)) continue;
        seen.add(a.iata);
        L.circleMarker([a.lat, a.lon], { radius: 6, color: colour, weight: 2, fillColor: colour, fillOpacity: 0.9 })
          .bindTooltip(label(`${a.iata} · ${a.city || a.name}`))
          .addTo(g);
      }
    }
    for (const p of places) {
      points.push([p.lat, p.lon]);
      L.circleMarker([p.lat, p.lon], {
        radius: 7,
        color: colour,
        weight: 2,
        fillColor: p.kind === 'stay' ? colour : '#ffffff',
        fillOpacity: 1,
      })
        .bindTooltip(label(`${p.name} (${KIND_LABEL[p.kind]})`))
        .addTo(g);
    }

    if (points.length === 1) m.setView(points[0]!, 13);
    else if (points.length > 1) m.fitBounds(L.latLngBounds(points), { padding: [24, 24], maxZoom: 14 });
  }, [signature]);

  useEffect(() => {
    if (focus && map.current) map.current.setView([focus.lat, focus.lon], Math.max(map.current.getZoom(), 14));
  }, [focus]);

  return <div className="trips-map" ref={box} role="region" aria-label="Map of this trip" />;
}
