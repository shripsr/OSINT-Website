/* ==============================================
   OSINT MAP - ANALYSIS: PLAYBACK, PATTERNS, ALERTS, SHIP ACTIVITY
   SOURCE: src/analysis.ts  ->  compiled to js/analysis.js by "npm run build"
           (edit the .ts file, never the .js; analysis.js must load
           AFTER flights.js and ships.js and BEFORE script.js)
   DATA: nothing new is downloaded. Everything here is worked out from the
   positions the flight and ship layers already receive.

   - Recorder: keeps every aircraft position seen in the last 2 hours and
     every ship position in the last 12, in memory only (a reload starts
     again).
   - Track playback: a timeline bar that replays the recording, with trails.
   - Flight patterns: looks at each aircraft's recent track for orbits,
     holding, search grids, loitering and position jumps, plus emergency
     squawks, rapid descents and GPS loss. Flagged aircraft get a ring.
   - Alerts: watchlist events (took off, landed, emergency, signal lost,
     unusual pattern) as an on-screen notice, desktop notification and
     sound, with a log in the watchlist panel.
   - Ship activity: dark ships (AIS switched off while ships around them
     are still heard) and ship-to-ship meetings (possible STS transfers /
     transshipment).
   ============================================== */


// ==============================================
// A1. CONFIGURATION
// ==============================================

// Recorder
const REC_STRIDE = 6;                   // numbers per point: time, lon, lat, alt ft, heading, speed kt
// Recording length. Ships report rarely and move slowly, so they are kept
// longer (dark-ship detection needs hours of history).
const REC_KEEP_MS: Record<RecKind, number> = { air: 2 * 3600000, ship: 12 * 3600000 };
const REC_MAX_POINTS = 400000;          // memory cap (about 20 MB); oldest dropped first
const REC_SHIP_SAMPLE_MS = 30000;       // how often ship positions are copied in
const REC_PRUNE_MS = 60000;

// How far apart two recorded points may be and still be joined up, and how
// long an object stays on screen after its last point. Ships report less often.
const REC_GAP_MS: Record<RecKind, number> = { air: 5 * 60000, ship: 30 * 60000 };
const REC_HOLD_MS: Record<RecKind, number> = { air: 2 * 60000, ship: 15 * 60000 };

// Playback
const PB_SOURCE = "playback-source";
const PB_TAIL_SOURCE = "playback-tail-source";
const PB_AIR_LAYER = "playback-air-layer";
const PB_SHIP_LAYER = "playback-ship-layer";
const PB_TAIL_LAYER = "playback-tail-layer";
const PB_PATH_LAYER = "playback-path-layer";
const PB_SELECTED_LAYER = "playback-selected-layer";
const PB_SHIP_IMAGE = "playback-ship-arrow";
const PB_TAIL_MS = 10 * 60000;          // trail length behind each object
const PB_TICK_MS = 100;
const PB_SHIP_COLOR = "#4dd0e1";

// Flight patterns
const PAT_WINDOW_MS = 30 * 60000;       // how much recent track is examined
const PAT_RUN_MS = 10000;               // re-check at most this often
const PAT_KEEP_MS = 10 * 60000;         // a flag stays this long after its pattern stops
const PAT_RING_LAYER = "pattern-ring-layer";
const PAT_ROUTINE_KEY = "osint_map_patterns_routine";


// ==============================================
// A2. TYPES
// ==============================================

type RecKind = "air" | "ship";

/** Everything recorded about one aircraft or ship */
interface RecTrack {
    kind: RecKind;
    id: string;             // ICAO hex or MMSI
    label: string;          // callsign / registration / ship name
    icon: string;           // aircraft: "shape-colorKey" (the live layer's icon names)
    military: boolean;
    pts: number[];          // flat list, REC_STRIDE numbers per point, oldest first
}

/** A recorded object's state at one moment */
interface RecState {
    lon: number;
    lat: number;
    alt: number;            // NaN = unknown
    hdg: number;            // NaN = unknown
    spd: number;            // NaN = unknown
    index: number;          // last recorded point at or before this moment
}

type PatternKind = "emergency" | "descent" | "jump" | "orbit" | "survey" | "loiter" | "holding" | "gps";

interface PatternHit {
    kind: PatternKind;
    label: string;
    detail: string;
    severity: 1 | 2 | 3;    // 3 = most serious
    routine: boolean;       // everyday traffic (hidden unless asked for)
}

interface PatternFlag {
    hex: string;
    hits: PatternHit[];
    first: number;          // when first flagged (ms)
    last: number;           // when last seen doing it
}



// ==============================================
// A3. STATE
// ==============================================

const recTracks = new Map<string, RecTrack>();     // "a:hex" / "s:mmsi" -> track
let recPointCount = 0;
let recOldest = Infinity;
let recNewest = 0;
let recLastPrune = 0;

let pbActive = false;
let pbPlaying = false;
let pbTime = 0;
let pbSpeed = 30;
let pbTrails = true;
let pbDirty = false;
let pbDragging = false;
let pbTimer: number | undefined;
let pbLastTick = 0;
let pbLastDraw = 0;
let pbSelected: string | null = null;              // recTracks key
let pbPopup: MapPopup;

const patternFlags = new Map<string, PatternFlag>();   // hex -> flag
let patternLastRun = 0;
let patternShowRoutine = false;
let patternRingKey = "";



// ==============================================
// A4. SMALL HELPERS
// ==============================================

const analysisEl = (id: string) => document.getElementById(id);

function analysisSource(id: string): GeoJSONMapSource | undefined {
    return map.getSource(id) as GeoJSONMapSource | undefined;
}

function setAnalysisText(id: string, text: string): void {
    const el = analysisEl(id);
    if (el && el.textContent !== text) el.textContent = text;
}

function escapeAnalysisHtml(text: string): string {
    return text.replace(/[&<>"']/g, c => (
        { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" } as Record<string, string>
    )[c]);
}

/** Signed difference b - a in degrees, between -180 and 180 */
function turnAngle(a: number, b: number): number {
    let d = (b - a) % 360;
    if (d > 180) d -= 360;
    if (d < -180) d += 360;
    return d;
}

function formatClock(ms: number, seconds = true): string {
    const d = new Date(ms);
    const pad = (n: number) => String(n).padStart(2, "0");
    return pad(d.getHours()) + ":" + pad(d.getMinutes()) + (seconds ? ":" + pad(d.getSeconds()) : "");
}

function formatAgo(ms: number): string {
    const min = Math.round(ms / 60000);
    if (min < 1) return "NOW";
    if (min < 60) return `-${min} MIN`;
    return `-${Math.floor(min / 60)} H ${min % 60} MIN`;
}

function formatFeet(ft: number): string {
    if (!isFinite(ft)) return "ALT --";
    if (ft <= 0) return "GROUND";
    return ft >= 18000 ? "FL" + String(Math.round(ft / 100)).padStart(3, "0")
                       : Math.round(ft).toLocaleString() + " FT";
}


// ==============================================
// A5. RECORDER
// ==============================================

function recordPoint(track: RecTrack, t: number, lon: number, lat: number,
                     alt: number | null, hdg: number | null, spd: number | null): void {

    const p = track.pts;

    // Only new positions, in time order
    if (p.length && t <= p[p.length - REC_STRIDE]) return;

    if (!isFinite(lat) || !isFinite(lon) || !isFinite(t)) return;

    p.push(
        t, lon, lat,
        alt == null ? NaN : alt,
        hdg == null ? NaN : hdg,
        spd == null ? NaN : spd
    );

    recPointCount++;

    if (t < recOldest) recOldest = t;
    if (t > recNewest) recNewest = t;
}

function recTrackFor(key: string, kind: RecKind, id: string): RecTrack {

    let track = recTracks.get(key);

    if (!track) {
        track = { kind: kind, id: id, label: "", icon: "", military: false, pts: [] };
        recTracks.set(key, track);
    }

    return track;
}

// Drops points older than the recording length (or more, if over the cap)
function pruneRecording(now: number): void {

    // Over the memory cap: drop the oldest 15% of the recorded time span
    const capCutoff = recPointCount > REC_MAX_POINTS && isFinite(recOldest)
        ? now - (now - recOldest) * 0.85
        : -Infinity;

    recPointCount = 0;
    recOldest = Infinity;

    recTracks.forEach(function(track, key) {

        const p = track.pts;
        const cutoff = Math.max(now - REC_KEEP_MS[track.kind], capCutoff);
        let i = 0;

        while (i < p.length && p[i] < cutoff) i += REC_STRIDE;

        if (i) p.splice(0, i);

        if (!p.length) {
            recTracks.delete(key);
            return;
        }

        recPointCount += p.length / REC_STRIDE;

        if (p[0] < recOldest) recOldest = p[0];
    });

    if (!recPointCount) recNewest = 0;
}

// Copies the ship layer's latest positions in (ships.ts keeps no history)
function sampleShips(): void {

    if (!shipsEnabled) {
        if (darkShips.size || shipMeetings.size) runShipActivity(Date.now());
        return;
    }

    shipRecords.forEach(function(ship, mmsi) {

        const track = recTrackFor("s:" + mmsi, "ship", String(mmsi));

        const details = shipDetails.get(mmsi);

        track.label = details && details.name ? details.name : "MMSI " + mmsi;

        recordPoint(track, ship.t0, ship.lon, ship.lat, null,
            ship.heading != null ? ship.heading : ship.cog, ship.sog);
    });

    runShipActivity(Date.now());

    updateAnalysisCounts();
}

// Called by flights.ts after every feed update.
// regional = the ADS-B feeds (zoomed in); false = the OpenSky world snapshot.
function analysisOnFlights(store: Map<string, FlightRecord>, regional: boolean): void {

    const now = Date.now();

    store.forEach(function(rec) {

        const track = recTrackFor("a:" + rec.hex, "air", rec.hex);

        const shown = displayRecord(rec);

        track.label = rec.callsign || shown.reg || rec.hex.toUpperCase();
        track.icon = flightShapeFor(shown) + "-" + flightColorKey(rec);
        track.military = rec.military;

        recordPoint(track, rec.t0, rec.lon, rec.lat,
            rec.onGround ? 0 : rec.alt, rec.track, rec.gs);
    });

    if (now - recLastPrune > REC_PRUNE_MS) {
        pruneRecording(now);
        recLastPrune = now;
    }

    runPatterns(store, now);

    updateAnalysisCounts();
}

// State of a track at time t (interpolated between recorded points),
// or null if it wasn't being tracked then.
function recStateAt(track: RecTrack, t: number): RecState | null {

    const p = track.pts;
    const n = p.length / REC_STRIDE;

    if (!n || t < p[0]) return null;

    // Last point at or before t
    let lo = 0, hi = n - 1;

    while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (p[mid * REC_STRIDE] <= t) lo = mid;
        else hi = mid - 1;
    }

    const a = lo * REC_STRIDE;

    const hold = (): RecState | null => t - p[a] > REC_HOLD_MS[track.kind] ? null : {
        lon: p[a + 1], lat: p[a + 2], alt: p[a + 3], hdg: p[a + 4], spd: p[a + 5], index: lo
    };

    if (lo === n - 1) return hold();

    const b = a + REC_STRIDE;
    const gap = p[b] - p[a];

    if (gap > REC_GAP_MS[track.kind]) return hold();

    const f = gap > 0 ? (t - p[a]) / gap : 0;

    let dLon = p[b + 1] - p[a + 1];
    if (dLon > 180) dLon -= 360;
    if (dLon < -180) dLon += 360;

    const lat = p[a + 2] + (p[b + 2] - p[a + 2]) * f;
    const lon = wrapLon(p[a + 1] + dLon * f);

    let hdg: number;
    const h1 = p[a + 4], h2 = p[b + 4];

    if (isFinite(h1) && isFinite(h2)) hdg = (h1 + turnAngle(h1, h2) * f + 360) % 360;
    else if (isFinite(h1)) hdg = h1;
    else if (isFinite(h2)) hdg = h2;
    else hdg = flightBearing(p[a + 2], p[a + 1], p[b + 2], p[b + 1]);

    const mix = (x: number, y: number) =>
        isFinite(x) && isFinite(y) ? x + (y - x) * f : isFinite(x) ? x : y;

    return { lon: lon, lat: lat, alt: mix(p[a + 3], p[b + 3]), hdg: hdg, spd: mix(p[a + 5], p[b + 5]), index: lo };
}


// ==============================================
// A6. TRACK PLAYBACK
// ==============================================

// Live layers hidden while replaying, so only the recording is on screen
function pbLiveLayers(): string[] {
    return [
        FLIGHT_LAYER, FLIGHT_WATCH_LAYER, FLIGHT_SELECTED_LAYER,
        FLIGHT_TRAIL_LAYER, FLIGHT_TRAIL_CASING_LAYER,
        FLIGHT_ROUTE_LAYER, FLIGHT_ROUTE_POINTS_LAYER, PAT_RING_LAYER,
        SHIP_LAYER, SHIP_LABEL_LAYER, SHIP_TRAIL_LAYER, SHIP_TRAIL_CASING_LAYER, SHIP_ACT_LAYER
    ];
}

function pbApplyLiveVisibility(): void {

    if (!map || !map.isStyleLoaded()) return;

    const want = pbActive ? "none" : "visible";

    pbLiveLayers().forEach(function(id) {
        if (map.getLayer(id) && map.getLayoutProperty(id, "visibility") !== want) {
            map.setLayoutProperty(id, "visibility", want);
        }
    });
}

function createShipArrowIcon(): ImageData {

    const size = 32;
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = size;

    const ctx = canvasContext(canvas);

    ctx.beginPath();
    ctx.moveTo(16, 3);
    ctx.lineTo(25, 28);
    ctx.lineTo(16, 22);
    ctx.lineTo(7, 28);
    ctx.closePath();

    ctx.fillStyle = PB_SHIP_COLOR;
    ctx.strokeStyle = "#0c1118";
    ctx.lineWidth = 2.5;
    ctx.lineJoin = "round";
    ctx.stroke();
    ctx.fill();

    return ctx.getImageData(0, 0, size, size);
}

function setupPlaybackLayers(): void {

    if (!map.hasImage(PB_SHIP_IMAGE)) {
        map.addImage(PB_SHIP_IMAGE, createShipArrowIcon(), { pixelRatio: 2 });
    }

    // The aircraft icons are drawn by flights.ts; make sure they exist
    if (!map.hasImage("flight-icon-narrow-normal")) {
        try { setupFlightLayers(); } catch (error) { /* style not ready yet */ }
    }

    const empty: GeoFeatureCollection = { type: "FeatureCollection", features: [] };

    if (!map.getSource(PB_SOURCE)) map.addSource(PB_SOURCE, { type: "geojson", data: empty });
    if (!map.getSource(PB_TAIL_SOURCE)) map.addSource(PB_TAIL_SOURCE, { type: "geojson", data: empty });

    // The selected object's whole recorded path, dashed
    if (!map.getLayer(PB_PATH_LAYER)) {
        map.addLayer({
            id: PB_PATH_LAYER,
            type: "line",
            source: PB_TAIL_SOURCE,
            filter: ["==", ["get", "path"], true],
            layout: { "line-cap": "round", "line-join": "round" },
            paint: {
                "line-color": "#e9f1f8",
                "line-width": 1.5,
                "line-opacity": 0.6,
                "line-dasharray": [2, 2]
            }
        });
    }

    if (!map.getLayer(PB_TAIL_LAYER)) {
        map.addLayer({
            id: PB_TAIL_LAYER,
            type: "line",
            source: PB_TAIL_SOURCE,
            filter: ["!=", ["get", "path"], true],
            layout: { "line-cap": "round", "line-join": "round" },
            paint: {
                "line-color": ["get", "color"],
                "line-width": ["case", ["get", "selected"], 3, 1.6],
                "line-opacity": ["case", ["get", "selected"], 1, 0.65]
            }
        });
    }

    if (!map.getLayer(PB_SELECTED_LAYER)) {
        map.addLayer({
            id: PB_SELECTED_LAYER,
            type: "circle",
            source: PB_SOURCE,
            filter: ["==", ["get", "key"], pbSelected || ""],
            paint: {
                "circle-radius": 17,
                "circle-color": "#00bcd4",
                "circle-opacity": 0.14,
                "circle-stroke-color": "#00bcd4",
                "circle-stroke-width": 1.5,
                "circle-pitch-alignment": "viewport"
            }
        });
    }

    if (!map.getLayer(PB_SHIP_LAYER)) {
        map.addLayer({
            id: PB_SHIP_LAYER,
            type: "symbol",
            source: PB_SOURCE,
            filter: ["==", ["get", "kind"], "ship"],
            layout: {
                "icon-image": PB_SHIP_IMAGE,
                "icon-rotate": ["get", "hdg"],
                "icon-rotation-alignment": "map",
                "icon-allow-overlap": true,
                "icon-ignore-placement": true,
                "icon-size": ["interpolate", ["linear"], ["zoom"], 2, 0.6, 8, 0.9, 14, 1.2]
            }
        });
    }

    if (!map.getLayer(PB_AIR_LAYER)) {
        map.addLayer({
            id: PB_AIR_LAYER,
            type: "symbol",
            source: PB_SOURCE,
            filter: ["==", ["get", "kind"], "air"],
            layout: {
                "icon-image": ["concat", "flight-icon-", ["get", "icon"]],
                "icon-rotate": ["get", "hdg"],
                "icon-rotation-alignment": "map",
                "icon-allow-overlap": true,
                "icon-ignore-placement": true,
                "icon-size": ["interpolate", ["linear"], ["zoom"], 2, 1, 4, 1.25, 6, 1.5, 10, 1.75, 18, 2],
                "symbol-sort-key": ["get", "sort"]
            }
        });
    }
}

function removePlaybackLayers(): void {

    [PB_AIR_LAYER, PB_SHIP_LAYER, PB_SELECTED_LAYER, PB_TAIL_LAYER, PB_PATH_LAYER].forEach(function(id) {
        if (map.getLayer(id)) map.removeLayer(id);
    });

    [PB_SOURCE, PB_TAIL_SOURCE].forEach(function(id) {
        if (map.getSource(id)) map.removeSource(id);
    });
}

function ensurePlaybackLayers(): void {

    if (!pbActive || !map || !map.isStyleLoaded()) return;

    if (map.getLayer(PB_AIR_LAYER) && map.getLayer(PB_SHIP_LAYER) &&
        map.getLayer(PB_TAIL_LAYER) && map.getLayer(PB_PATH_LAYER) &&
        map.getLayer(PB_SELECTED_LAYER)) return;

    try {
        setupPlaybackLayers();
        pbDirty = true;
    } catch (error) {
        console.warn("Playback layers could not be built yet:", asFetchError(error).message);
    }
}

// Tail behind an object: recorded points from (t - PB_TAIL_MS) up to its
// current position, stopping at any gap too long to join up.
function pbTailCoords(track: RecTrack, state: RecState, from: number): number[][] {

    const p = track.pts;
    const coords: number[][] = [[state.lon, state.lat]];

    let prevLon = state.lon;

    for (let i = state.index; i >= 0; i--) {

        const a = i * REC_STRIDE;

        if (p[a] < from) break;

        const nextT = i === state.index ? pbTime : p[a + REC_STRIDE];

        if (nextT - p[a] > REC_GAP_MS[track.kind]) break;

        // Keep the line continuous across the 180th meridian
        let lon = p[a + 1];
        while (lon - prevLon > 180) lon -= 360;
        while (lon - prevLon < -180) lon += 360;

        coords.push([lon, p[a + 2]]);
        prevLon = lon;
    }

    return coords;
}

function pbDraw(): void {

    if (!pbActive || !map) return;

    ensurePlaybackLayers();

    const points: GeoFeature[] = [];
    const tails: GeoFeature[] = [];

    const tailFrom = pbTime - PB_TAIL_MS;

    let selectedState: RecState | null = null;
    let selectedTrack: RecTrack | null = null;

    recTracks.forEach(function(track, key) {

        const state = recStateAt(track, pbTime);

        if (!state) return;

        const selected = key === pbSelected;

        if (selected) {
            selectedState = state;
            selectedTrack = track;
        }

        points.push({
            type: "Feature",
            geometry: { type: "Point", coordinates: [state.lon, state.lat] },
            properties: {
                key: key,
                kind: track.kind,
                icon: track.icon || "narrow-normal",
                hdg: isFinite(state.hdg) ? state.hdg : 0,
                sort: selected ? 1e7 : isFinite(state.alt) ? state.alt : 0
            }
        });

        if (pbTrails || selected) {

            const coords = pbTailCoords(track, state, selected ? pbTime - 3 * PB_TAIL_MS : tailFrom);

            if (coords.length > 1) {
                tails.push({
                    type: "Feature",
                    geometry: { type: "LineString", coordinates: coords },
                    properties: {
                        selected: selected,
                        color: track.kind === "ship" ? PB_SHIP_COLOR : flightAltitudeColor(isFinite(state.alt) ? state.alt : null)
                    }
                });
            }
        }
    });

    // Whole recorded path of the selected object
    const track = selectedTrack as RecTrack | null;

    if (track && pbSelected) {

        const coords: number[][] = [];
        let prevLon = NaN;

        for (let i = 0; i < track.pts.length; i += REC_STRIDE) {
            let lon = track.pts[i + 1];
            if (isFinite(prevLon)) {
                while (lon - prevLon > 180) lon -= 360;
                while (lon - prevLon < -180) lon += 360;
            }
            coords.push([lon, track.pts[i + 2]]);
            prevLon = lon;
        }

        if (coords.length > 1) {
            tails.push({
                type: "Feature",
                geometry: { type: "LineString", coordinates: coords },
                properties: { path: true }
            });
        }
    }

    const pointSource = analysisSource(PB_SOURCE);
    const tailSource = analysisSource(PB_TAIL_SOURCE);

    if (pointSource) pointSource.setData({ type: "FeatureCollection", features: points });
    if (tailSource) tailSource.setData({ type: "FeatureCollection", features: tails });

    pbUpdatePopup(track, selectedState);

    pbUpdateBar(points.length);
}

function pbUpdatePopup(track: RecTrack | null, state: RecState | null): void {

    if (!pbPopup) return;

    if (!track || !state) {
        if (pbPopup.isOpen()) pbPopup.remove();
        return;
    }

    const rows: string[] = [
        `<strong>${escapeAnalysisHtml(track.label || track.id)}</strong>` +
        `<span class="transit-popup-mode">${track.kind === "air" ? (track.military ? "MILITARY AIRCRAFT" : "AIRCRAFT") : "SHIP"}</span>`
    ];

    if (track.kind === "air") {
        rows.push(`<span class="sat-label">ALT</span> ${formatFeet(state.alt)}`);
    }

    rows.push(`<span class="sat-label">SPEED</span> ${isFinite(state.spd) ? Math.round(state.spd) + " KT" : "--"}` +
              ` &nbsp;<span class="sat-label">HDG</span> ${isFinite(state.hdg) ? Math.round(state.hdg) + "&deg;" : "--"}`);

    rows.push(`<small>${formatClock(pbTime)} &middot; ${track.kind === "air" ? "ICAO " + track.id.toUpperCase() : "MMSI " + track.id}</small>`);

    const html = rows.join("<br>");

    pbPopup.setLngLat([state.lon, state.lat]);

    if (!pbPopup.isOpen()) {
        pbPopup.setHTML(html).addTo(map);
    } else if (pbPopup.getElement().dataset.html !== html) {
        pbPopup.setHTML(html);
    }

    pbPopup.getElement().dataset.html = html;
}

function pbUpdateBar(objects: number): void {

    const slider = analysisEl("pbSlider") as HTMLInputElement | null;

    const start = isFinite(recOldest) ? recOldest : Date.now();
    const end = Math.max(recNewest, start);

    if (slider) {

        const max = String(Math.max(1, Math.round((end - start) / 1000)));

        if (slider.max !== max) slider.max = max;

        if (!pbDragging) slider.value = String(Math.round((pbTime - start) / 1000));
    }

    setAnalysisText("pbStartLabel", formatClock(start, false));
    setAnalysisText("pbEndLabel", formatClock(end, false));
    setAnalysisText("pbClock", formatClock(pbTime));
    setAnalysisText("pbAgo", `${formatAgo(end - pbTime)} · ${objects} TRACKED`);

    const play = analysisEl("pbPlay");

    if (play) {
        const label = pbPlaying ? "❚❚" : "▶";
        if (play.textContent !== label) play.textContent = label;
    }
}

function pbTick(): void {

    const now = performance.now();
    const elapsed = Math.min(1000, now - pbLastTick);

    pbLastTick = now;

    if (pbPlaying && !pbDragging) {

        pbTime += elapsed * pbSpeed;

        if (pbTime >= recNewest) {
            pbTime = recNewest;
            pbPlaying = false;
        }

        pbDirty = true;
    }

    // Big recordings (world view) are redrawn less often
    const gap = recTracks.size > 4000 ? 500 : recTracks.size > 1500 ? 250 : PB_TICK_MS;

    if (pbDirty && now - pbLastDraw >= gap) {
        pbDirty = false;
        pbLastDraw = now;
        pbDraw();
    }
}

function openPlayback(): void {

    if (pbActive) return;

    if (!recPointCount) {
        flashFlightNotice("NOTHING RECORDED YET - TURN ON FLIGHT OR SHIP TRACKING AND LEAVE IT RUNNING");
        return;
    }

    pbActive = true;

    // Live selections would sit on top of the replay
    setFollowFlight(false);
    deselectFlight();

    pbTime = Math.max(recOldest, recNewest - 15 * 60000);
    pbPlaying = true;
    pbDirty = true;
    pbSelected = null;
    pbLastTick = performance.now();

    analysisEl("playbackBar")?.classList.add("visible");
    analysisEl("playbackToggle")?.classList.add("layer-on");
    document.body.classList.add("playback-on");

    pbApplyLiveVisibility();
    ensurePlaybackLayers();

    clearInterval(pbTimer);
    pbTimer = window.setInterval(pbTick, PB_TICK_MS);

    pbTick();
}

function closePlayback(): void {

    if (!pbActive) return;

    pbActive = false;
    pbPlaying = false;
    pbSelected = null;

    clearInterval(pbTimer);

    if (pbPopup) pbPopup.remove();

    analysisEl("playbackBar")?.classList.remove("visible");
    analysisEl("playbackToggle")?.classList.remove("layer-on");
    document.body.classList.remove("playback-on");

    if (map && map.isStyleLoaded()) removePlaybackLayers();

    pbApplyLiveVisibility();
}

function pbFeatureAt(point: MapPoint): MapFeature | null {

    if (!pbActive || !map || !map.getLayer(PB_AIR_LAYER)) return null;

    const pad = 10;

    const features = map.queryRenderedFeatures(
        [[point.x - pad, point.y - pad], [point.x + pad, point.y + pad]],
        { layers: [PB_AIR_LAYER, PB_SHIP_LAYER] }
    );

    return features.length ? features[0] : null;
}

// Used by script.ts so a click on a replayed object doesn't drop a pin.
// Clicking one selects it (popup + full path); clicking empty map deselects.
function isPlaybackAtPoint(point: MapPoint): boolean {

    if (!pbActive) return false;

    const feature = pbFeatureAt(point);

    pbSelected = feature && feature.properties ? String(feature.properties.key) : null;

    if (map.getLayer(PB_SELECTED_LAYER)) {
        map.setFilter(PB_SELECTED_LAYER, ["==", ["get", "key"], pbSelected || ""]);
    }

    pbDirty = true;
    pbLastDraw = 0;

    // While replaying, empty-map clicks only deselect (no location pins)
    return true;
}

function initializePlayback(): void {

    pbPopup = new maplibregl.Popup({
        closeButton: false,
        closeOnClick: false,
        offset: 16,
        className: "transit-popup"
    });

    analysisEl("playbackToggle")?.addEventListener("click", function() {
        if (pbActive) closePlayback();
        else openPlayback();
    });

    analysisEl("pbClose")?.addEventListener("click", closePlayback);

    analysisEl("pbPlay")?.addEventListener("click", function() {

        // At the end: start again from the beginning of the window
        if (!pbPlaying && pbTime >= recNewest - 1000) pbTime = recOldest;

        pbPlaying = !pbPlaying;
        pbDirty = true;
    });

    const speed = analysisEl("pbSpeed") as HTMLSelectElement | null;

    if (speed) {
        speed.value = String(pbSpeed);
        speed.addEventListener("change", function() {
            pbSpeed = Number(speed.value) || 30;
        });
    }

    const slider = analysisEl("pbSlider") as HTMLInputElement | null;

    if (slider) {

        slider.addEventListener("input", function() {
            pbDragging = true;
            pbTime = (isFinite(recOldest) ? recOldest : Date.now()) + Number(slider.value) * 1000;
            pbDirty = true;
        });

        slider.addEventListener("change", function() {
            pbDragging = false;
        });
    }

    const trails = analysisEl("pbTrails") as HTMLInputElement | null;

    if (trails) {
        trails.checked = pbTrails;
        trails.addEventListener("change", function() {
            pbTrails = trails.checked;
            pbDirty = true;
        });
    }

    // Space = play / pause, Escape = back to live (not while typing)
    document.addEventListener("keydown", function(event) {

        if (!pbActive) return;

        const target = event.target as HTMLElement | null;

        if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName) &&
            (target as HTMLInputElement).type !== "range") return;

        if (event.key === " ") {
            event.preventDefault();
            analysisEl("pbPlay")?.click();
        } else if (event.key === "Escape") {
            closePlayback();
        }
    });

    map.on("mousemove", function(e) {
        if (pbActive) map.getCanvas().style.cursor = pbFeatureAt(e.point) ? "pointer" : "";
    });

    // A base map change removes our layers and re-adds the live ones
    map.on("styledata", function() {
        if (pbActive) {
            ensurePlaybackLayers();
            pbApplyLiveVisibility();
        }
    });

    map.on("idle", function() {
        if (pbActive) pbApplyLiveVisibility();
    });

    setInterval(sampleShips, REC_SHIP_SAMPLE_MS);
}


// ==============================================
// A7. FLIGHT PATTERNS
// ==============================================

// Distance (km) from (lat, lon) to the nearest large or medium airport
function nearestAirportKm(lat: number, lon: number, maxKm: number): number {

    let best = Infinity;
    const latPad = maxKm / 111;

    flightAirportIndex.forEach(function(a) {

        if (Math.abs(a.lat - lat) > latPad) return;

        const km = flightDistanceKm(lat, lon, a.lat, a.lon);

        if (km < best) best = km;
    });

    return best;
}

// Looks at one aircraft's recent track and current state.
function analyseAircraft(track: RecTrack, rec: FlightRecord): PatternHit[] {

    const hits: PatternHit[] = [];

    const alt = rec.onGround ? 0 : rec.alt;

    // ----- right now -----

    if (rec.emergency) {
        const meaning: Record<string, string> = { "7500": "HIJACK", "7600": "RADIO FAILURE", "7700": "GENERAL EMERGENCY" };
        hits.push({
            kind: "emergency",
            label: "EMERGENCY",
            detail: rec.squawk ? `Squawk ${rec.squawk}${meaning[rec.squawk] ? " (" + meaning[rec.squawk] + ")" : ""}` : "Emergency status set",
            severity: 3,
            routine: false
        });
    }

    if (!rec.onGround && rec.vrate != null && rec.vrate <= -6000 && alt != null && alt >= 8000) {
        hits.push({
            kind: "descent",
            label: "RAPID DESCENT",
            detail: `${Math.round(rec.vrate).toLocaleString()} ft/min at ${formatFeet(alt)}`,
            severity: 3,
            routine: false
        });
    }

    if (rec.gps === "bad" && !rec.onGround) {
        hits.push({
            kind: "gps",
            label: "GPS DEGRADED",
            detail: `Poor position accuracy reported (NIC ${rec.nic ?? "?"}, NACp ${rec.nacp ?? "?"}): possible jamming`,
            severity: 1,
            routine: true
        });
    }

    if (rec.onGround) return hits;

    // ----- shape of the recent track -----

    const p = track.pts;
    const n = p.length / REC_STRIDE;

    if (n < 8) return hits;

    const tEnd = p[(n - 1) * REC_STRIDE];

    let first = n - 1;
    while (first > 0 && p[(first - 1) * REC_STRIDE] >= tEnd - PAT_WINDOW_MS) first--;

    const count = n - first;
    const span = tEnd - p[first * REC_STRIDE];

    if (count < 8 || span < 5 * 60000) return hits;

    // Positions every 90 s (OpenSky world view) are too far apart to see turns
    const coarse = span / (count - 1) > 45000;

    // Flat x / y in km around the first point
    const lat0 = p[first * REC_STRIDE + 2];
    const lon0 = p[first * REC_STRIDE + 1];
    const kx = 111.32 * Math.max(0.05, Math.cos(lat0 * Math.PI / 180));

    const xs: number[] = [], ys: number[] = [];

    for (let i = first; i < n; i++) {
        const a = i * REC_STRIDE;
        let dLon = p[a + 1] - lon0;
        if (dLon > 180) dLon -= 360;
        if (dLon < -180) dLon += 360;
        xs.push(dLon * kx);
        ys.push((p[a + 2] - lat0) * 110.57);
    }

    let pathKm = 0;
    let turn = 0;
    let lastBearing = NaN;
    let jumpKm = 0, jumpSpeed = 0;

    // Straight legs (for racetracks and search grids)
    const legs: { bearing: number; km: number }[] = [];
    let legX = 0, legY = 0, legKm = 0, legStart = NaN;

    const closeLeg = () => {
        if (legKm >= 3) legs.push({ bearing: (Math.atan2(legX, legY) * 180 / Math.PI + 360) % 360, km: legKm });
        legX = legY = legKm = 0;
        legStart = NaN;
    };

    for (let i = 1; i < xs.length; i++) {

        const dx = xs[i] - xs[i - 1];
        const dy = ys[i] - ys[i - 1];
        const km = Math.hypot(dx, dy);
        const dtH = (p[(first + i) * REC_STRIDE] - p[(first + i - 1) * REC_STRIDE]) / 3600000;

        // Teleport: far faster than any aircraft, over a short time
        if (dtH > 0 && dtH < 3 / 60 && km > 20 && km / dtH > 2000) {
            if (km > jumpKm) {
                jumpKm = km;
                jumpSpeed = km / dtH;
            }
            lastBearing = NaN;
            closeLeg();
            continue;
        }

        pathKm += km;

        if (km < 0.2) continue;

        const bearing = (Math.atan2(dx, dy) * 180 / Math.PI + 360) % 360;

        if (isFinite(lastBearing)) {
            const d = turnAngle(lastBearing, bearing);
            if (Math.abs(d) <= 120) turn += d;   // bigger = a gap in the data, not a turn
        }

        lastBearing = bearing;

        if (!isFinite(legStart)) legStart = bearing;

        if (Math.abs(turnAngle(legStart, bearing)) > 25) {
            closeLeg();
            legStart = bearing;
        }

        legX += dx;
        legY += dy;
        legKm += km;
    }

    closeLeg();

    if (jumpKm) {
        hits.push({
            kind: "jump",
            label: "POSITION JUMP",
            detail: `Jumped ${Math.round(jumpKm)} km (${Math.round(jumpSpeed).toLocaleString()} km/h implied): possible GPS spoofing or bad data`,
            severity: 3,
            routine: false
        });
    }

    if (coarse) return hits;

    let reversals = 0;

    for (let i = 1; i < legs.length; i++) {
        if (Math.abs(turnAngle(legs[i - 1].bearing, legs[i].bearing)) > 150) reversals++;
    }

    // Size of the area flown in
    let cx = 0, cy = 0;
    xs.forEach((x, i) => { cx += x; cy += ys[i]; });
    cx /= xs.length;
    cy /= ys.length;

    let radius = 0;
    xs.forEach((x, i) => { radius = Math.max(radius, Math.hypot(x - cx, ys[i] - cy)); });

    const netKm = Math.hypot(xs[xs.length - 1] - xs[0], ys[ys.length - 1] - ys[0]);
    const loops = Math.abs(turn) / 360;
    const minutes = Math.round(span / 60000);
    const direction = turn > 0 ? "clockwise" : "anticlockwise";

    const airportKm = nearestAirportKm(rec.lat, rec.lon, 70);
    const nearAirport = airportKm <= 70;

    if (loops >= 1 && radius <= 40 && nearAirport && reversals >= 2 && alt != null && alt >= 3000) {
        hits.push({
            kind: "holding",
            label: "HOLDING PATTERN",
            detail: `${loops.toFixed(1)} laps of a racetrack in ${minutes} min, ${Math.round(airportKm)} km from an airport`,
            severity: 1,
            routine: true
        });
    }

    else if (loops >= 1.5 && radius <= 40) {

        // Light aircraft doing circuits around their airfield
        const circuits = nearAirport && airportKm < 15 && alt != null && alt < 3000;

        hits.push({
            kind: "orbit",
            label: circuits ? "AIRFIELD CIRCUITS" : rec.military ? "MILITARY ORBIT" : "ORBITING",
            detail: `${loops.toFixed(1)} ${direction} loops in ${minutes} min, ${radius.toFixed(1)} km radius` +
                    (circuits ? ", close to an airfield" : ""),
            severity: circuits ? 1 : rec.military ? 3 : 2,
            routine: circuits
        });
    }

    else if (reversals >= 3 && loops < 1) {
        hits.push({
            kind: "survey",
            label: "SEARCH / SURVEY GRID",
            detail: `${reversals} back-and-forth legs in ${minutes} min over a ${Math.round(radius * 2)} km area`,
            severity: rec.military ? 3 : 2,
            routine: false
        });
    }

    else if (span >= 15 * 60000 && pathKm >= 40 && netKm < pathKm * 0.2) {
        hits.push({
            kind: "loiter",
            label: "LOITERING",
            detail: `Flew ${Math.round(pathKm)} km in ${minutes} min but only ended up ${Math.round(netKm)} km away`,
            severity: rec.military ? 2 : 1,
            routine: false
        });
    }

    return hits;
}

function runPatterns(store: Map<string, FlightRecord>, now: number): void {

    if (now - patternLastRun < PAT_RUN_MS) return;

    patternLastRun = now;

    store.forEach(function(rec) {

        const track = recTracks.get("a:" + rec.hex);

        if (!track) return;

        const hits = analyseAircraft(track, rec);

        if (!hits.length) return;

        hits.sort((a, b) => b.severity - a.severity);

        const flag = patternFlags.get(rec.hex);

        alertNewPatterns(rec, track, flag ? flag.hits : [], hits);

        if (flag) {
            flag.hits = hits;
            flag.last = now;
        } else {
            patternFlags.set(rec.hex, { hex: rec.hex, hits: hits, first: now, last: now });
        }
    });

    patternFlags.forEach(function(flag, hex) {
        if (now - flag.last > PAT_KEEP_MS) patternFlags.delete(hex);
    });

    updatePatternRings();

    const panel = analysisEl("patternPanel");

    if (panel && panel.classList.contains("visible")) renderPatterns();
}

// New hits on an aircraft become alerts: any non-routine pattern for a
// watched aircraft, and serious (red) ones for everyone if switched on
function alertNewPatterns(rec: FlightRecord, track: RecTrack, before: PatternHit[], after: PatternHit[]): void {

    const watched = watchlistHexes.has(rec.hex);

    after.forEach(function(hit) {

        if (before.some(h => h.kind === hit.kind)) return;

        // Emergencies on watched aircraft are already announced by watchObserve
        if (watched && hit.kind === "emergency") return;

        const wanted = watched ? !hit.routine : alertSettings.patterns && hit.severity === 3;

        if (!wanted) return;

        const entry = watched ? watchlistEntryFor(rec) : undefined;

        raiseAlert({
            kind: entry ? "watch" : "pattern",
            ref: entry ? entry.key : rec.hex,
            severity: hit.severity,
            title: `${track.label} ${hit.label}`,
            body: hit.detail,
            lat: rec.lat,
            lon: rec.lon
        });
    });
}

function visiblePatternFlags(): PatternFlag[] {

    const list: PatternFlag[] = [];

    patternFlags.forEach(function(flag) {
        if (patternShowRoutine || flag.hits.some(h => !h.routine)) list.push(flag);
    });

    const top = (f: PatternFlag) => Math.max(...f.hits.filter(h => patternShowRoutine || !h.routine).map(h => h.severity));

    return list.sort((a, b) => top(b) - top(a) || b.first - a.first);
}

function setupPatternLayer(): void {

    if (!map.getSource(FLIGHT_SOURCE) || map.getLayer(PAT_RING_LAYER)) return;

    // Under the aircraft icons, above the watchlist rings
    map.addLayer({
        id: PAT_RING_LAYER,
        type: "circle",
        source: FLIGHT_SOURCE,
        filter: ["in", ["get", "hex"], ["literal", []]],
        layout: { visibility: pbActive ? "none" : "visible" },
        paint: {
            "circle-radius": 20,
            "circle-color": "#ffb300",
            "circle-opacity": 0.08,
            "circle-stroke-color": "#ffb300",
            "circle-stroke-width": 2,
            "circle-stroke-opacity": 0.9,
            "circle-pitch-alignment": "viewport"
        }
    }, map.getLayer(FLIGHT_LAYER) ? FLIGHT_LAYER : undefined);

    patternRingKey = "";
}

function updatePatternRings(): void {

    if (!map || !map.isStyleLoaded()) return;

    setupPatternLayer();

    if (!map.getLayer(PAT_RING_LAYER)) return;

    const flags = visiblePatternFlags();
    const all = flags.map(f => f.hex);
    const high = flags.filter(f => f.hits.some(h => h.severity === 3)).map(f => f.hex);

    const key = all.join(",") + "|" + high.join(",");

    if (key === patternRingKey) return;

    patternRingKey = key;

    map.setFilter(PAT_RING_LAYER, ["in", ["get", "hex"], ["literal", all]]);

    map.setPaintProperty(PAT_RING_LAYER, "circle-stroke-color",
        ["case", ["in", ["get", "hex"], ["literal", high]], "#ff4d4d", "#ffb300"]);
    map.setPaintProperty(PAT_RING_LAYER, "circle-color",
        ["case", ["in", ["get", "hex"], ["literal", high]], "#ff4d4d", "#ffb300"]);
}

function renderPatterns(): void {

    const list = analysisEl("patternList");
    const empty = analysisEl("patternEmpty");

    if (!list || !empty) return;

    const flags = visiblePatternFlags();

    list.textContent = "";

    flags.forEach(function(flag) {

        const rec = flightStore.get(flag.hex);
        const track = recTracks.get("a:" + flag.hex);

        const hits = flag.hits.filter(h => patternShowRoutine || !h.routine);
        const severity = Math.max(...hits.map(h => h.severity));

        const row = document.createElement("button");
        row.type = "button";
        row.className = `airport-row pattern-row sev-${severity}` + (rec ? "" : " gone");
        row.dataset.hex = flag.hex;

        const main = document.createElement("div");
        main.className = "airport-row-main";
        main.textContent = `${track ? track.label : flag.hex.toUpperCase()} · ${hits.map(h => h.label).join(" + ")}`;
        row.appendChild(main);

        hits.forEach(function(hit) {
            const detail = document.createElement("div");
            detail.className = "airport-row-detail";
            detail.textContent = hit.detail;
            row.appendChild(detail);
        });

        const meta = document.createElement("div");
        meta.className = "airport-row-detail pattern-meta";
        meta.textContent = [
            rec ? formatFeet(rec.onGround ? 0 : rec.alt == null ? NaN : rec.alt) : "NO LONGER ON MAP",
            rec && rec.gs != null ? Math.round(rec.gs) + " KT" : "",
            rec && rec.military ? "MILITARY" : "",
            "FLAGGED " + formatClock(flag.first, false)
        ].filter(Boolean).join(" · ");
        row.appendChild(meta);

        list.appendChild(row);
    });

    empty.textContent = !flightsEnabled
        ? "Turn on Flight Tracking to look for unusual flight patterns."
        : flags.length ? ""
        : patternFlags.size ? "Only routine patterns right now. Tick the box above to see them."
        : "Nothing unusual in view right now. Patterns need a few minutes of track, so leave the map on an area for a while.";
}

function closePatternPanel(): void {
    analysisEl("patternPanel")?.classList.remove("visible");
}

function togglePatternPanel(): void {

    const panel = analysisEl("patternPanel");

    if (!panel) return;

    if (panel.classList.contains("visible")) {
        closePatternPanel();
        return;
    }

    openLeftPanel(panel);

    renderPatterns();
}

function initializePatterns(): void {

    try {
        patternShowRoutine = localStorage.getItem(PAT_ROUTINE_KEY) === "1";
    } catch (error) {
        patternShowRoutine = false;
    }

    analysisEl("patternToggle")?.addEventListener("click", togglePatternPanel);
    analysisEl("closePatternPanel")?.addEventListener("click", closePatternPanel);

    const routine = analysisEl("patternRoutine") as HTMLInputElement | null;

    if (routine) {
        routine.checked = patternShowRoutine;
        routine.addEventListener("change", function() {
            patternShowRoutine = routine.checked;
            try { localStorage.setItem(PAT_ROUTINE_KEY, patternShowRoutine ? "1" : "0"); } catch (error) { /* not saved */ }
            updatePatternRings();
            updateAnalysisCounts();
            renderPatterns();
        });
    }

    analysisEl("patternList")?.addEventListener("click", function(event) {

        const target = event.target as Element | null;
        const row = target && target.closest<HTMLElement>(".pattern-row");

        if (!row || !row.dataset.hex) return;

        const rec = flightStore.get(row.dataset.hex);

        if (!rec) {
            flashFlightNotice("THAT AIRCRAFT IS NO LONGER ON THE MAP");
            return;
        }

        if (pbActive) closePlayback();

        selectFlight(rec.hex);

        const pos = predictPosition(rec, Date.now());

        map.flyTo({ center: [pos.lon, pos.lat], zoom: Math.max(map.getZoom(), 9), essential: true });
    });

    map.on("styledata", updatePatternRings);
}


// ==============================================
// A8. ALERTS (log, desktop notifications, sound)
//
// Everything worth interrupting for goes through raiseAlert(): watchlist
// events, serious flight patterns and new ship detections (each optional).
// The log is shown in the watchlist panel and kept between visits.
// ==============================================

const ALERT_LOG_KEY = "osint_map_alert_log";
const ALERT_SETTINGS_KEY = "osint_map_alert_settings";
const ALERT_LOG_MAX = 40;

type AlertKind = "watch" | "pattern" | "ship";

interface AlertEntry {
    id: number;
    at: number;             // ms
    kind: AlertKind;
    title: string;          // e.g. "BAW123 TOOK OFF"
    body: string;
    severity: 1 | 2 | 3;
    ref?: string;           // watch key / aircraft hex / "dark:MMSI" / "meet:A-B"
    lat?: number;
    lon?: number;
}

interface AlertSettings {
    desktop: boolean;       // browser notifications (and keep checking while the tab is hidden)
    sound: boolean;
    patterns: boolean;      // alert on new serious (red) flight patterns
    ships: boolean;         // alert on new dark ships / ship meetings
}

let alertLog: AlertEntry[] = [];
let alertSettings: AlertSettings = { desktop: false, sound: true, patterns: false, ships: false };
let alertAudio: AudioContext | null = null;

function saveAlerts(): void {
    try {
        localStorage.setItem(ALERT_LOG_KEY, JSON.stringify(alertLog));
        localStorage.setItem(ALERT_SETTINGS_KEY, JSON.stringify(alertSettings));
    } catch (error) { /* storage unavailable: not kept */ }
}

function loadAlerts(): void {

    try {
        const log = JSON.parse(localStorage.getItem(ALERT_LOG_KEY) || "[]");
        if (Array.isArray(log)) {
            alertLog = log.filter(a => a && typeof a.title === "string" && typeof a.at === "number").slice(0, ALERT_LOG_MAX);
        }
        const settings = JSON.parse(localStorage.getItem(ALERT_SETTINGS_KEY) || "null");
        if (settings && typeof settings === "object") alertSettings = Object.assign(alertSettings, settings);
    } catch (error) { /* start fresh */ }

    // Permission may have been withdrawn in the browser since last time
    if (alertSettings.desktop && (typeof Notification === "undefined" || Notification.permission !== "granted")) {
        alertSettings.desktop = false;
    }
}

// Used by flights.ts: keep checking the watchlist while the tab is hidden
function alertsInBackground(): boolean {
    return alertSettings.desktop;
}

function alertBeep(severity: number): void {

    try {

        if (!alertAudio) alertAudio = new AudioContext();

        const audio = alertAudio;

        if (audio.state === "suspended") audio.resume();

        const start = audio.currentTime;
        const tones = severity === 3 ? [880, 660, 880, 660] : [740, 988];

        tones.forEach(function(freq, i) {

            const at = start + i * 0.17;
            const osc = audio.createOscillator();
            const gain = audio.createGain();

            osc.type = "sine";
            osc.frequency.value = freq;

            gain.gain.setValueAtTime(0.0001, at);
            gain.gain.exponentialRampToValueAtTime(0.18, at + 0.02);
            gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.15);

            osc.connect(gain);
            gain.connect(audio.destination);

            osc.start(at);
            osc.stop(at + 0.16);
        });

    } catch (error) { /* no audio */ }
}

function raiseAlert(alert: Omit<AlertEntry, "id" | "at">): void {

    const entry: AlertEntry = Object.assign({ id: Date.now() + Math.random(), at: Date.now() }, alert);

    alertLog.unshift(entry);
    alertLog = alertLog.slice(0, ALERT_LOG_MAX);

    saveAlerts();

    flashFlightNotice(`${entry.title} - ${entry.body}`.slice(0, 140), 9000);

    if (alertSettings.sound) alertBeep(entry.severity);

    if (alertSettings.desktop && typeof Notification !== "undefined" && Notification.permission === "granted") {

        try {
            const note = new Notification("OSINT MAP: " + entry.title, {
                body: entry.body,
                tag: entry.kind + ":" + (entry.ref || entry.id),
                icon: "assets/favicon.svg"
            });

            note.onclick = function() {
                window.focus();
                openAlert(entry);
                note.close();
            };
        } catch (error) { /* some browsers only allow notifications from a service worker */ }
    }

    renderAlertLog();
}

// Clicking an alert (in the log or a desktop notification)
function openAlert(entry: AlertEntry): void {

    if (pbActive) closePlayback();

    if (entry.kind === "watch" && entry.ref && watchlist.some(e => e.key === entry.ref)) {
        locateWatched(entry.ref);
        return;
    }

    if ((entry.kind === "pattern" || entry.kind === "watch") && entry.ref) {
        const rec = flightStore.get(entry.ref.toLowerCase());
        if (rec) {
            selectFlight(rec.hex);
            const pos = predictPosition(rec, Date.now());
            map.flyTo({ center: [pos.lon, pos.lat], zoom: Math.max(map.getZoom(), 9), essential: true });
            return;
        }
    }

    if (entry.kind === "ship" && entry.ref) {
        openShipActivity(entry.ref, entry.lat, entry.lon);
        return;
    }

    if (entry.lat != null && entry.lon != null) {
        map.flyTo({ center: [entry.lon, entry.lat], zoom: Math.max(map.getZoom(), 8), essential: true });
    }
}

function renderAlertLog(): void {

    const list = analysisEl("alertLog");
    const empty = analysisEl("alertLogEmpty");

    if (!list || !empty) return;

    list.textContent = "";

    const today = new Date().toDateString();

    alertLog.forEach(function(entry) {

        const row = document.createElement("button");
        row.type = "button";
        row.className = `airport-row pattern-row alert-row sev-${entry.severity}`;
        row.dataset.id = String(entry.id);

        const main = document.createElement("div");
        main.className = "airport-row-main";
        main.textContent = entry.title;

        const detail = document.createElement("div");
        detail.className = "airport-row-detail";
        detail.textContent = entry.body;

        const meta = document.createElement("div");
        meta.className = "airport-row-detail pattern-meta";

        const date = new Date(entry.at);
        const day = date.toDateString() === today ? "" : date.toLocaleDateString() + " ";
        const source = { watch: "WATCHLIST", pattern: "FLIGHT PATTERN", ship: "SHIP ACTIVITY" }[entry.kind];

        meta.textContent = day + formatClock(entry.at, false) + " · " + source;

        row.append(main, detail, meta);
        list.appendChild(row);
    });

    empty.textContent = alertLog.length ? "" : "No alerts yet.";

    const clear = analysisEl("alertClear");
    if (clear) clear.style.display = alertLog.length ? "" : "none";
}

function initializeAlerts(): void {

    loadAlerts();

    const bind = (id: string, key: keyof AlertSettings, onEnable?: (box: HTMLInputElement) => void) => {

        const box = analysisEl(id) as HTMLInputElement | null;

        if (!box) return;

        box.checked = alertSettings[key];

        box.addEventListener("change", function() {
            alertSettings[key] = box.checked;
            saveAlerts();
            if (box.checked && onEnable) onEnable(box);
        });
    };

    bind("alertDesktop", "desktop", function(box) {

        if (typeof Notification === "undefined") {
            box.checked = alertSettings.desktop = false;
            saveAlerts();
            flashFlightNotice("THIS BROWSER DOES NOT SUPPORT DESKTOP NOTIFICATIONS");
            return;
        }

        if (Notification.permission === "granted") return;

        Notification.requestPermission().then(function(permission) {
            if (permission !== "granted") {
                box.checked = alertSettings.desktop = false;
                saveAlerts();
                flashFlightNotice("NOTIFICATIONS ARE BLOCKED - ALLOW THEM FOR THIS SITE IN THE BROWSER'S SETTINGS");
            }
        });
    });

    // Ticking "sound" is a click, which lets the page play audio from now on
    bind("alertSound", "sound", () => alertBeep(1));

    bind("alertPatterns", "patterns");
    bind("alertShips", "ships");

    analysisEl("alertLog")?.addEventListener("click", function(event) {
        const row = (event.target as Element | null)?.closest<HTMLElement>(".alert-row");
        const entry = row ? alertLog.find(a => String(a.id) === row.dataset.id) : undefined;
        if (entry) openAlert(entry);
    });

    analysisEl("alertClear")?.addEventListener("click", function() {
        alertLog = [];
        saveAlerts();
        renderAlertLog();
    });

    renderAlertLog();
}


// ----- watchlist events -----
// flights.ts reports each watched aircraft it sees (on the map, or from
// the background worldwide check). Changes between two sightings become
// alerts: took off, landed, emergency squawk, signal lost.

interface WatchSighting {
    transmitting: boolean;
    onGround: boolean | null;
    emergency: boolean;
    alt: number | null;
    lat: number;
    lon: number;
    at: number;
}

const watchSightings = new Map<string, WatchSighting>();   // watch key -> last sighting

function watchPlaceText(lat: number, lon: number): string {
    const airport = findAirportNear(lat, lon, 25);
    return airport ? `at ${airportLabel(airport)}` : `near ${lat.toFixed(2)}, ${lon.toFixed(2)}`;
}

// rec = what was seen; null = a worldwide check found it not transmitting
function watchObserve(key: string, label: string, rec: FlightRecord | null): void {

    const prev = watchSightings.get(key);

    if (!rec) {

        if (prev && prev.transmitting) {

            const lowDown = prev.onGround || (prev.alt != null && prev.alt < 4000);

            raiseAlert({
                kind: "watch",
                ref: key,
                severity: lowDown ? 1 : 2,
                title: `${label} SIGNAL LOST`,
                body: lowDown
                    ? `Stopped transmitting ${prev.onGround ? "on the ground" : "low down"} ${watchPlaceText(prev.lat, prev.lon)} (probably landed / parked)`
                    : `Stopped transmitting at ${formatFeet(prev.alt == null ? NaN : prev.alt)} ${watchPlaceText(prev.lat, prev.lon)}`,
                lat: prev.lat,
                lon: prev.lon
            });

            prev.transmitting = false;
        }

        return;
    }

    const place = watchPlaceText(rec.lat, rec.lon);
    const altText = formatFeet(rec.onGround ? 0 : rec.alt == null ? NaN : rec.alt);

    if (prev && prev.onGround === true && !rec.onGround) {
        raiseAlert({
            kind: "watch", ref: key, severity: 2,
            title: `${label} TOOK OFF`,
            body: `Airborne ${place}, ${altText}${rec.callsign ? " as " + rec.callsign : ""}`,
            lat: rec.lat, lon: rec.lon
        });
    }

    else if (prev && prev.onGround === false && rec.onGround) {
        raiseAlert({
            kind: "watch", ref: key, severity: 2,
            title: `${label} LANDED`,
            body: `On the ground ${place}`,
            lat: rec.lat, lon: rec.lon
        });
    }

    if (rec.emergency && !(prev && prev.emergency)) {
        raiseAlert({
            kind: "watch", ref: key, severity: 3,
            title: `${label} EMERGENCY`,
            body: `Squawking ${rec.squawk || "emergency"} at ${altText} ${place}`,
            lat: rec.lat, lon: rec.lon
        });
    }

    watchSightings.set(key, {
        transmitting: true,
        onGround: rec.onGround,
        emergency: rec.emergency,
        alt: rec.onGround ? 0 : rec.alt,
        lat: rec.lat,
        lon: rec.lon,
        at: Date.now()
    });
}


// ==============================================
// A9. SHIP ACTIVITY: DARK SHIPS + SHIP-TO-SHIP MEETINGS
//
// Dark ship: stopped sending AIS for an hour or more, while other ships
// close to its last position are still being received (so it isn't just
// out of receiver range, or off screen). When it comes back, the gap and
// the distance it moved while silent are shown.
//
// Meeting: two ships stopped within 500 m of each other for 20+ minutes,
// away from crowds (ports and busy anchorages are skipped). Tankers meeting
// = possible ship-to-ship (STS) transfer; a fishing vessel meeting a cargo
// ship = possible transshipment.
//
// Only works for areas on screen with Ship Tracking on, as the ship feed
// only sends the area being looked at.
// ==============================================

const DARK_AFTER_MS = 60 * 60000;       // silent this long = dark
const DARK_NEIGHBOUR_KM = 30;           // other ships within this distance...
const DARK_NEIGHBOUR_FRESH_MS = 15 * 60000;   // ...heard this recently = area still covered
const DARK_NEIGHBOURS = 2;
const DARK_BACK_KEEP_MS = 2 * 3600000;  // list a ship that came back for this long
const MEET_KM = 0.5;
const MEET_MAX_KNOTS = 3;
const MEET_MIN_MS = 20 * 60000;         // together at least this long
const MEET_FORGET_MS = 30 * 60000;      // apart this long = meeting over
const MEET_CROWD = 6;                   // more ships than this within 1 km = port / anchorage
const SHIP_FRESH_MS = 15 * 60000;
const SHIP_ACT_SOURCE = "ship-activity-source";
const SHIP_ACT_LAYER = "ship-activity-layer";

interface DarkShip {
    mmsi: number;
    state: "dark" | "back";
    lastT: number;          // last report before going quiet
    lat: number;
    lon: number;
    sog: number;            // knots at the last report (NaN = unknown)
    neighbours: number;
    backT?: number;         // when it reported again
    backKm?: number;        // how far it had moved
    flaggedAt: number;
}

interface ShipMeeting {
    a: number;
    b: number;
    first: number;
    last: number;
    km: number;             // latest distance apart
    lat: number;
    lon: number;
    alerted: boolean;
}

const darkShips = new Map<number, DarkShip>();
const shipMeetings = new Map<string, ShipMeeting>();    // "mmsiA-mmsiB" (A < B)
let shipActivityPopup: MapPopup;

// Kinds of vessel left out: harbour craft, ferries and leisure boats meet
// other ships and switch AIS off all the time
function shipActivityIgnored(mmsi: number): boolean {
    const details = shipDetails.get(mmsi);
    if (!details || !details.type) return false;
    const category = shipCategory(details.type);
    return category === "service" || category === "pleasure" || category === "highspeed" || category === "passenger";
}

function shipKindText(mmsi: number): string {
    const details = shipDetails.get(mmsi);
    return details && details.type ? shipTypeLabel(details.type).toUpperCase() : "UNKNOWN TYPE";
}

function formatDuration(ms: number): string {
    const min = Math.max(0, Math.round(ms / 60000));
    return min < 60 ? `${min} min` : `${Math.floor(min / 60)} h ${String(min % 60).padStart(2, "0")} min`;
}

// Fresh ship reports bucketed by grid cell, for "who is nearby" questions
function shipGrid(cellDeg: number, now: number): Map<string, ShipRecord[]> {

    const grid = new Map<string, ShipRecord[]>();

    shipRecords.forEach(function(ship) {
        if (now - ship.t0 > SHIP_FRESH_MS) return;
        const key = Math.floor(ship.lat / cellDeg) + "," + Math.floor(ship.lon / cellDeg);
        const list = grid.get(key);
        if (list) list.push(ship); else grid.set(key, [ship]);
    });

    return grid;
}

function shipsNear(grid: Map<string, ShipRecord[]>, cellDeg: number, lat: number, lon: number,
                   km: number, skip: number): ShipRecord[] {

    const found: ShipRecord[] = [];
    const row = Math.floor(lat / cellDeg), col = Math.floor(lon / cellDeg);
    const rowReach = Math.ceil(km / (111 * cellDeg));
    const colReach = Math.ceil(km / (111 * cellDeg * Math.max(0.2, Math.cos(lat * Math.PI / 180))));

    for (let r = row - rowReach; r <= row + rowReach; r++) {
        for (let c = col - colReach; c <= col + colReach; c++) {
            const list = grid.get(r + "," + c);
            if (!list) continue;
            list.forEach(function(ship) {
                if (ship.mmsi !== skip && flightDistanceKm(lat, lon, ship.lat, ship.lon) <= km) found.push(ship);
            });
        }
    }

    return found;
}

function detectDarkShips(now: number): void {

    const grid = shipGrid(0.25, now);
    const view = map ? map.getBounds() : null;

    recTracks.forEach(function(track) {

        if (track.kind !== "ship") return;

        const mmsi = Number(track.id);
        const p = track.pts;
        const last = p.length - REC_STRIDE;
        const lastT = p[last];
        const flag = darkShips.get(mmsi);

        // Reported again: turn a dark flag into "came back"
        if (flag && flag.state === "dark" && lastT > flag.lastT) {
            flag.state = "back";
            flag.backT = lastT;
            flag.backKm = flightDistanceKm(flag.lat, flag.lon, p[last + 2], p[last + 1]);
            return;
        }

        if (flag || now - lastT < DARK_AFTER_MS) return;

        // The relay left ships out since then: silence proves nothing
        if (shipTruncatedAt >= lastT) return;

        if (shipActivityIgnored(mmsi)) return;

        const lat = p[last + 2], lon = p[last + 1];

        // Off screen = the feed isn't being asked about it, so silence there proves nothing
        if (view && !view.contains([lon, lat])) return;

        const neighbours = shipsNear(grid, 0.25, lat, lon, DARK_NEIGHBOUR_KM, mmsi)
            .filter(ship => now - ship.t0 < DARK_NEIGHBOUR_FRESH_MS).length;

        if (neighbours < DARK_NEIGHBOURS) return;

        const sog = p[last + 5];

        darkShips.set(mmsi, {
            mmsi: mmsi, state: "dark", lastT: lastT, lat: lat, lon: lon,
            sog: sog, neighbours: neighbours, flaggedAt: now
        });

        if (alertSettings.ships) {
            raiseAlert({
                kind: "ship", ref: "dark:" + mmsi, severity: 2,
                title: `${shipName(mmsi)} WENT DARK`,
                body: `No AIS for ${formatDuration(now - lastT)} while ${neighbours} ships nearby are still heard` +
                      (isFinite(sog) && sog >= 1 ? ` (was making ${sog.toFixed(1)} kn)` : ""),
                lat: lat, lon: lon
            });
        }
    });

    darkShips.forEach(function(flag, mmsi) {
        const gone = !recTracks.has("s:" + mmsi);
        const stale = flag.state === "back" && now - (flag.backT || 0) > DARK_BACK_KEEP_MS;
        if (gone || stale) darkShips.delete(mmsi);
    });
}

function meetingLabel(m: ShipMeeting): { label: string; severity: 2 | 3 } {

    const ca = shipCategory(shipDetails.get(m.a)?.type || 0);
    const cb = shipCategory(shipDetails.get(m.b)?.type || 0);
    const pair = (x: string, y: string) => (ca === x && cb === y) || (ca === y && cb === x);

    if (ca === "tanker" && cb === "tanker") return { label: "POSSIBLE STS TRANSFER", severity: 3 };

    if (pair("fishing", "cargo") || pair("fishing", "tanker") || pair("fishing", "other")) {
        return { label: "POSSIBLE TRANSSHIPMENT", severity: 3 };
    }

    return { label: "SHIPS ALONGSIDE", severity: 2 };
}

function detectShipMeetings(now: number): void {

    const cell = 0.01;      // about 1 km
    const grid = shipGrid(cell, now);

    const stopped = (ship: ShipRecord) =>
        (ship.sog == null || ship.sog <= MEET_MAX_KNOTS) &&
        ship.navStat !== 5 &&                       // moored: alongside a quay, not a ship
        !shipActivityIgnored(ship.mmsi);

    shipRecords.forEach(function(ship) {

        if (now - ship.t0 > SHIP_FRESH_MS || !stopped(ship)) return;

        shipsNear(grid, cell, ship.lat, ship.lon, MEET_KM, ship.mmsi).forEach(function(other) {

            if (other.mmsi < ship.mmsi || !stopped(other)) return;     // each pair once

            const lat = (ship.lat + other.lat) / 2;
            const lon = (ship.lon + other.lon) / 2;

            if (shipsNear(grid, cell, lat, lon, 1, -1).length > MEET_CROWD) return;

            const key = ship.mmsi + "-" + other.mmsi;
            const km = flightDistanceKm(ship.lat, ship.lon, other.lat, other.lon);
            const meeting = shipMeetings.get(key);

            if (meeting) {
                meeting.last = now;
                meeting.km = km;
                meeting.lat = lat;
                meeting.lon = lon;
            } else {
                shipMeetings.set(key, { a: ship.mmsi, b: other.mmsi, first: now, last: now, km: km, lat: lat, lon: lon, alerted: false });
            }
        });
    });

    shipMeetings.forEach(function(m, key) {

        if (now - m.last > MEET_FORGET_MS) {
            shipMeetings.delete(key);
            return;
        }

        if (!m.alerted && m.last - m.first >= MEET_MIN_MS) {

            m.alerted = true;

            if (alertSettings.ships) {
                const kind = meetingLabel(m);
                raiseAlert({
                    kind: "ship", ref: "meet:" + key, severity: kind.severity,
                    title: kind.label,
                    body: `${shipName(m.a)} and ${shipName(m.b)}, ${Math.round(m.km * 1000)} m apart for ${formatDuration(m.last - m.first)}`,
                    lat: m.lat, lon: m.lon
                });
            }
        }
    });
}

function activeMeetings(): ShipMeeting[] {
    const list: ShipMeeting[] = [];
    shipMeetings.forEach(m => { if (m.last - m.first >= MEET_MIN_MS) list.push(m); });
    return list.sort((x, y) => meetingLabel(y).severity - meetingLabel(x).severity || y.first - x.first);
}

function runShipActivity(now: number): void {

    if (!shipsEnabled) {
        darkShips.clear();
        shipMeetings.clear();
    } else {
        detectDarkShips(now);
        detectShipMeetings(now);
    }

    drawShipActivity();

    const panel = analysisEl("shipActivityPanel");
    if (panel && panel.classList.contains("visible")) renderShipActivity();
}

// ----- map markers -----

function shipActivityFeatures(): GeoFeature[] {

    const features: GeoFeature[] = [];

    darkShips.forEach(function(d) {
        features.push({
            type: "Feature",
            geometry: { type: "Point", coordinates: [d.lon, d.lat] },
            properties: { ref: "dark:" + d.mmsi, kind: d.state }
        });
    });

    activeMeetings().forEach(function(m) {
        features.push({
            type: "Feature",
            geometry: { type: "Point", coordinates: [m.lon, m.lat] },
            properties: { ref: "meet:" + m.a + "-" + m.b, kind: meetingLabel(m).severity === 3 ? "meet-high" : "meet" }
        });
    });

    return features;
}

function drawShipActivity(): void {

    if (!map || !map.isStyleLoaded()) return;

    const data: GeoFeatureCollection = { type: "FeatureCollection", features: shipActivityFeatures() };

    const source = map.getSource(SHIP_ACT_SOURCE) as GeoJSONMapSource | undefined;

    if (source) source.setData(data);
    else map.addSource(SHIP_ACT_SOURCE, { type: "geojson", data: data });

    if (!map.getLayer(SHIP_ACT_LAYER)) {

        const color: any = ["match", ["get", "kind"], "dark", "#ff4d4d", "meet-high", "#ff4d4d", "#ffb300"];

        map.addLayer({
            id: SHIP_ACT_LAYER,
            type: "circle",
            source: SHIP_ACT_SOURCE,
            layout: { visibility: pbActive ? "none" : "visible" },
            paint: {
                "circle-radius": ["match", ["get", "kind"], "dark", 15, "back", 11, 18],
                "circle-color": color,
                "circle-opacity": ["match", ["get", "kind"], "dark", 0.18, 0.08],
                "circle-stroke-color": color,
                "circle-stroke-width": 2,
                "circle-stroke-opacity": ["match", ["get", "kind"], "back", 0.6, 0.95],
                "circle-pitch-alignment": "viewport"
            }
        });
    }
}

function shipActivityPopupHtml(ref: string): string {

    const split = ref.indexOf(":");
    const kind = ref.slice(0, split), id = ref.slice(split + 1);

    if (kind === "dark") {

        const d = darkShips.get(Number(id));
        if (!d) return "";

        return `<strong>${escapeAnalysisHtml(shipName(d.mmsi))}</strong>` +
            `<span class="transit-popup-mode">${d.state === "dark" ? "DARK" : "BACK ON AIS"}</span><br>` +
            `<span class="sat-label">LAST HEARD</span> ${formatClock(d.lastT, false)} (${formatDuration(Date.now() - d.lastT)} ago)<br>` +
            (d.state === "back" && d.backT
                ? `<span class="sat-label">SILENT FOR</span> ${formatDuration(d.backT - d.lastT)}, moved ${d.backKm != null ? d.backKm.toFixed(1) : "?"} km<br>`
                : `<span class="sat-label">NEARBY</span> ${d.neighbours} ships still heard<br>`) +
            `<span class="sat-label">LAST SPEED</span> ${isFinite(d.sog) ? d.sog.toFixed(1) + " kn" : "--"}<br>` +
            `<small>${escapeAnalysisHtml(shipKindText(d.mmsi))} · MMSI ${d.mmsi}</small>`;
    }

    const m = shipMeetings.get(id);
    if (!m) return "";

    return `<strong>${meetingLabel(m).label}</strong><br>` +
        `${escapeAnalysisHtml(shipName(m.a))} <small>(${escapeAnalysisHtml(shipKindText(m.a))})</small><br>` +
        `${escapeAnalysisHtml(shipName(m.b))} <small>(${escapeAnalysisHtml(shipKindText(m.b))})</small><br>` +
        `<span class="sat-label">TOGETHER</span> ${formatDuration(m.last - m.first)} since ${formatClock(m.first, false)}<br>` +
        `<span class="sat-label">APART</span> ${Math.round(m.km * 1000)} m`;
}

// Fly to a flagged ship / meeting and show its details
function openShipActivity(ref: string, lat?: number, lon?: number): void {

    const split = ref.indexOf(":");
    const kind = ref.slice(0, split), id = ref.slice(split + 1);

    let at: [number, number] | null = lat != null && lon != null ? [lon, lat] : null;

    if (kind === "dark") {

        const d = darkShips.get(Number(id));
        if (d) at = [d.lon, d.lat];

        // Back on AIS and on the map: open the ship itself
        const live = shipRecords.get(Number(id));
        if (live && (!d || d.state === "back")) {
            map.flyTo({ center: [live.lon, live.lat], zoom: Math.max(map.getZoom(), 10), essential: true });
            showShip(live);
            return;
        }
    } else {
        const m = shipMeetings.get(id);
        if (m) at = [m.lon, m.lat];
    }

    if (!at) return;

    map.flyTo({ center: at, zoom: Math.max(map.getZoom(), 11), essential: true });

    const html = shipActivityPopupHtml(ref);

    if (html) shipActivityPopup.setLngLat(at).setHTML(html).addTo(map);
}

function shipActivityFeatureAt(point: MapPoint): MapFeature | null {

    if (!map || pbActive || !map.getLayer(SHIP_ACT_LAYER)) return null;

    const pad = 8;

    const features = map.queryRenderedFeatures(
        [[point.x - pad, point.y - pad], [point.x + pad, point.y + pad]],
        { layers: [SHIP_ACT_LAYER] }
    );

    return features.length ? features[0] : null;
}

// Used by script.ts: a click on a ship-activity marker shows its details
function isShipActivityAtPoint(point: MapPoint): boolean {

    const feature = shipActivityFeatureAt(point);

    if (!feature || !feature.properties) return false;

    const html = shipActivityPopupHtml(String(feature.properties.ref));

    if (html) shipActivityPopup.setLngLat(featureLngLat(feature)).setHTML(html).addTo(map);

    return true;
}

// ----- panel -----

function shipActivityRow(ref: string, severity: number, title: string, lines: string[], meta: string, faded: boolean): HTMLElement {

    const row = document.createElement("button");
    row.type = "button";
    row.className = `airport-row pattern-row ship-act-row sev-${severity}` + (faded ? " gone" : "");
    row.dataset.ref = ref;

    const main = document.createElement("div");
    main.className = "airport-row-main";
    main.textContent = title;
    row.appendChild(main);

    lines.forEach(function(text) {
        const line = document.createElement("div");
        line.className = "airport-row-detail";
        line.textContent = text;
        row.appendChild(line);
    });

    const metaEl = document.createElement("div");
    metaEl.className = "airport-row-detail pattern-meta";
    metaEl.textContent = meta;
    row.appendChild(metaEl);

    return row;
}

function renderShipActivity(): void {

    const darkList = analysisEl("darkShipList");
    const meetList = analysisEl("meetingList");

    if (!darkList || !meetList) return;

    const now = Date.now();

    darkList.textContent = "";
    meetList.textContent = "";

    const dark = [...darkShips.values()].sort((x, y) =>
        (x.state === y.state ? 0 : x.state === "dark" ? -1 : 1) || y.flaggedAt - x.flaggedAt);

    dark.forEach(function(d) {

        const moving = isFinite(d.sog) && d.sog >= 1;

        darkList.appendChild(d.state === "dark"
            ? shipActivityRow("dark:" + d.mmsi, moving ? 3 : 2, `${shipName(d.mmsi)} · DARK`,
                [`No AIS for ${formatDuration(now - d.lastT)}; ${d.neighbours} ships nearby still heard` +
                 (moving ? `. Was making ${d.sog.toFixed(1)} kn` : "")],
                `${shipKindText(d.mmsi)} · LAST HEARD ${formatClock(d.lastT, false)}`, false)
            : shipActivityRow("dark:" + d.mmsi, 1, `${shipName(d.mmsi)} · BACK ON AIS`,
                [`Was silent for ${formatDuration((d.backT || now) - d.lastT)} and moved ${d.backKm != null ? d.backKm.toFixed(1) : "?"} km meanwhile`],
                `${shipKindText(d.mmsi)} · REAPPEARED ${formatClock(d.backT || now, false)}`, true));
    });

    const meetings = activeMeetings();

    meetings.forEach(function(m) {

        const label = meetingLabel(m);

        meetList.appendChild(shipActivityRow("meet:" + m.a + "-" + m.b, label.severity, label.label,
            [`${shipName(m.a)} (${shipKindText(m.a)})`, `${shipName(m.b)} (${shipKindText(m.b)})`],
            `${Math.round(m.km * 1000)} M APART · ${formatDuration(m.last - m.first)} · SINCE ${formatClock(m.first, false)}`,
            now - m.last > 5 * 60000));
    });

    const off = shipsEnabled ? "" : "Turn on Ship Tracking to look for dark ships and meetings.";

    setAnalysisText("darkShipEmpty", off || (dark.length ? "" :
        "None in the areas you have viewed. A ship counts as dark after an hour without AIS while ships around it are still heard."));

    setAnalysisText("meetingEmpty", off || (meetings.length ? "" :
        "None right now. Two ships must stay stopped within 500 m of each other for 20 minutes."));
}

function closeShipActivityPanel(): void {
    analysisEl("shipActivityPanel")?.classList.remove("visible");
}

function initializeShipActivity(): void {

    shipActivityPopup = new maplibregl.Popup({
        closeButton: true,
        closeOnClick: true,
        offset: 14,
        className: "transit-popup"
    });

    analysisEl("shipActivityToggle")?.addEventListener("click", function() {

        const panel = analysisEl("shipActivityPanel");

        if (!panel) return;

        if (panel.classList.contains("visible")) closeShipActivityPanel();
        else openLeftPanel(panel);

        renderShipActivity();
    });

    analysisEl("closeShipActivityPanel")?.addEventListener("click", closeShipActivityPanel);

    analysisEl("shipActivityPanel")?.addEventListener("click", function(event) {
        const row = (event.target as Element | null)?.closest<HTMLElement>(".ship-act-row");
        if (row && row.dataset.ref) openShipActivity(row.dataset.ref);
    });

    map.on("mousemove", function(e) {
        if (shipActivityFeatureAt(e.point)) map.getCanvas().style.cursor = "pointer";
    });

    map.on("styledata", function() {
        if (map.isStyleLoaded() && !map.getLayer(SHIP_ACT_LAYER)) drawShipActivity();
    });
}


// ----- left-side panels -----

function closeAnalysisPanels(): void {
    closePatternPanel();
    closeShipActivityPanel();
}

// The panels share the left side of the map: close the others first
function openLeftPanel(panel: HTMLElement): void {

    deselectFlight();
    closeAirportPanel();
    closeWatchlistPanel();
    if (typeof closeStationPanel === "function") closeStationPanel();
    if (typeof clearSelection === "function") clearSelection();
    closeAnalysisPanels();

    panel.classList.add("visible");
}


// ==============================================
// A10. SIDEBAR COUNTS + START-UP
// ==============================================

function updateAnalysisCounts(): void {

    const minutes = recPointCount && isFinite(recOldest)
        ? Math.max(1, Math.round((recNewest - recOldest) / 60000))
        : 0;

    setAnalysisText("playbackCount", pbActive ? "ON" : !minutes ? "--" : minutes < 120 ? minutes + "m" : Math.round(minutes / 60) + "h");

    const flagged = visiblePatternFlags().length;

    setAnalysisText("patternCount", String(flagged));

    analysisEl("patternToggle")?.classList.toggle("alert", visiblePatternFlags().some(f => f.hits.some(h => h.severity === 3)));

    let dark = 0;
    darkShips.forEach(d => { if (d.state === "dark") dark++; });

    const meetings = activeMeetings();

    setAnalysisText("shipActivityCount", shipsEnabled ? String(dark + meetings.length) : "OFF");

    analysisEl("shipActivityToggle")?.classList.toggle("alert",
        dark > 0 || meetings.some(m => meetingLabel(m).severity === 3));
}

function initializeAnalysis(): void {

    initializePlayback();

    initializePatterns();

    initializeAlerts();

    initializeShipActivity();

    // The GPS jamming map was removed: free the space its samples used
    try {
        ["osint_map_gps_samples", "osint_map_gps_enabled", "osint_map_gps_window"].forEach(k => localStorage.removeItem(k));
    } catch (error) { /* nothing to free */ }

    updateAnalysisCounts();
}
