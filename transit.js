"use strict";
/* ==============================================
   OSINT MAP - PUBLIC TRANSIT (line maps + live vehicles)
   SOURCE: src/transit.ts  ->  compiled to transit.js by "npm run build"
           (edit the .ts file, never the .js; transit.js must load
           AFTER flights.js and BEFORE script.js)
   DATA: Transitous (transitous.org), a free community-run service built
         from the world's open timetables. No API key.

   One sidebar switch ("Transit") turns on three layers together:

   TRANSIT LINES  the route network of the area on screen, drawn in each
                  line's official colour. Click a line to highlight the
                  whole route, end to end, with its stops.

   STATIONS       a marker on every station and stop except bus stops
                  (railway, metro, tram, ferry, cable car); click one for
                  its next departures and arrivals.

   LIVE TRANSIT   one icon per vehicle in service (train, metro, tram,
                  bus, ferry or cable car, in the line's colour). Transitous does not hand
                  out GPS fixes: it gives every trip's timetable between
                  two stops, corrected with the operator's real-time
                  delays where the operator publishes them. The icon is
                  placed along the track from those times, so it is an
                  ESTIMATE. Icons with a white outline use real-time
                  data; icons with a grey outline are timetable only.
   ============================================== */
// ==============================================
// T1. CONFIGURATION
// ==============================================
const TRANSIT_API = "https://api.transitous.org";
// server.py relays (and caches) the requests; without it the browser asks
// Transitous directly, which also works.
const TRANSIT_PROXY_PATH = "/api/transit";
const TRANSIT_ENDPOINTS = {
    trips: "/api/v6/map/trips",
    routes: "/api/experimental/map/routes",
    details: "/api/experimental/map/route-details", // one whole route
    stops: "/api/v6/map/stops", // stations in an area
    stoptimes: "/api/v6/stoptimes" // a station's departures / arrivals
};
// Lines. Transitous refuses areas with too many routes in them, and decides
// by the zoom we send which kinds of line to return:
//   zoom 8  = railways only (intercity, regional, suburban)
//   zoom 9+ = metro, tram and bus as well
const TRANSIT_LINES_MIN_ZOOM = 9; // below this: "zoom in"
const TRANSIT_LINES_FULL_ZOOM = 11; // from here on, ask for every kind of line
const TRANSIT_LINES_RAIL_TIER = 8; // the zoom to send for "railways only"
const TRANSIT_LINES_GRID = 0.05; // requested areas snap to this (degrees), so they cache well
const TRANSIT_LINES_PAD = 0.25; // load this much beyond the screen edge
// Live vehicles
const TRANSIT_LIVE_MIN_ZOOM = 8;
const TRANSIT_LIVE_POLL_MS = 30000; // time between updates
const TRANSIT_LIVE_WINDOW_MS = 60000; // each update covers this far ahead
const TRANSIT_LIVE_TICK_MS = 1000; // smooth movement update rate
const TRANSIT_LIVE_KEEP_MS = 60000; // keep a vehicle this long after its last known stop
const TRANSIT_LIVE_PAD = 0.1;
const TRANSIT_MOVE_DELAY_MS = 900; // wait for the map to settle before loading
const TRANSIT_PREF_KEY = "osint_map_transit_enabled";
// Older versions had one switch per layer; read once so the choice carries over
const TRANSIT_OLD_PREF_KEYS = [
    "osint_map_transit_lines_enabled",
    "osint_map_transit_live_enabled",
    "osint_map_transit_stations_enabled"
];
const TRANSIT_LINES_SOURCE = "transit-lines-source";
const TRANSIT_LINES_BUS_LAYER = "transit-lines-bus-layer";
const TRANSIT_LINES_RAIL_LAYER = "transit-lines-rail-layer";
const TRANSIT_ROUTE_SOURCE = "transit-route-source";
const TRANSIT_ROUTE_CASING_LAYER = "transit-route-casing-layer";
const TRANSIT_ROUTE_LAYER = "transit-route-layer";
const TRANSIT_ROUTE_STOPS_LAYER = "transit-route-stops-layer";
const TRANSIT_STATIONS_SOURCE = "transit-stations-source";
const TRANSIT_STATIONS_LAYER = "transit-stations-layer";
const TRANSIT_LIVE_SOURCE = "transit-live-source";
const TRANSIT_LIVE_LAYER = "transit-live-layer";
const TRANSIT_LIVE_LABEL_LAYER = "transit-live-label-layer";
const TRANSIT_MODES = {
    HIGHSPEED_RAIL: { label: "High-speed rail", color: "#ff5c7a", rank: 7, icon: "train" },
    LONG_DISTANCE: { label: "Intercity rail", color: "#ff8a65", rank: 7, icon: "train" },
    NIGHT_RAIL: { label: "Night train", color: "#b39ddb", rank: 7, icon: "train" },
    REGIONAL_RAIL: { label: "Regional rail", color: "#f2a33a", rank: 6, icon: "train" },
    REGIONAL_FAST_RAIL: { label: "Regional rail", color: "#f2a33a", rank: 6, icon: "train" },
    SUBURBAN: { label: "Suburban rail", color: "#4caf50", rank: 5, icon: "train" },
    SUBWAY: { label: "Metro", color: "#4f8cff", rank: 5, icon: "metro" },
    METRO: { label: "Metro", color: "#4f8cff", rank: 5, icon: "metro" },
    TRAM: { label: "Tram", color: "#c77dff", rank: 4, icon: "tram" },
    FUNICULAR: { label: "Funicular", color: "#c77dff", rank: 4, icon: "tram" },
    AERIAL_LIFT: { label: "Cable car", color: "#c77dff", rank: 4, icon: "lift" },
    FERRY: { label: "Ferry", color: "#35c9e8", rank: 3, icon: "ferry" },
    COACH: { label: "Coach", color: "#9aa8b8", rank: 1, icon: "bus" },
    BUS: { label: "Bus", color: "#8fa3b8", rank: 0, icon: "bus" }
};
const TRANSIT_MODE_OTHER = { label: "Transit", color: "#8fa3b8", rank: 0, icon: "bus" };
// Airline flights are in the timetables too, but the flight layer shows
// real aircraft positions, so they are left out here.
const TRANSIT_SKIP_MODES = new Set(["AIRPLANE"]);
/** A request Transitous refused because the area holds too much */
class TransitTooMuch extends Error {
}
// ==============================================
// T3. STATE
// ==============================================
let transitEnabled = false; // the sidebar switch: all three layers below
let transitLinesEnabled = false;
let transitLiveEnabled = false;
let transitLinesGeneration = 0; // bumps to drop answers that arrive too late
let transitLiveGeneration = 0;
let transitProxyOk = null; // null = unknown, true/false once tested
let lastTransitLinesGeoJSON = { type: "FeatureCollection", features: [] };
let lastTransitLiveGeoJSON = { type: "FeatureCollection", features: [] };
// The area the lines on the map were loaded for
let transitLinesCover = null;
let transitLinesBusy = false;
let transitLinesQueued = false;
let transitVehicles = new Map();
let transitLiveBusy = false;
let transitLiveQueued = false; // the map moved while an update was loading
let transitLiveFailures = 0;
let transitMoveTimer;
let transitPollTimer;
let transitTickTimer;
let lastTransitRouteGeoJSON = { type: "FeatureCollection", features: [] };
let transitRouteSelected = false; // a whole route is highlighted
let transitRouteBounds = null;
let transitRouteGeneration = 0;
let transitRouteClickKey = ""; // the stretch clicked last (clicking it again switches line)
let transitRouteClickIndex = 0;
let transitHoverPopup;
let transitVehiclePopup;
let transitRoutePopup;
let transitSelectedId = null;
// ==============================================
// T4. SMALL HELPERS
// ==============================================
function transitGeoSource(id) {
    return map.getSource(id);
}
function transitModeInfo(mode) {
    return TRANSIT_MODES[mode] || TRANSIT_MODE_OTHER;
}
const TRANSIT_LAYER_TITLES = {
    lines: "Lines",
    stations: "Stations",
    live: "Vehicles"
};
const transitLayerStatus = {
    lines: { text: "OFF", detail: "" },
    stations: { text: "OFF", detail: "" },
    live: { text: "OFF", detail: "" }
};
function renderTransitStatus() {
    const names = Object.keys(transitLayerStatus);
    const texts = names.map(name => transitLayerStatus[name].text);
    const vehicles = transitLayerStatus.live.text;
    const summary = !transitEnabled ? "OFF"
        : texts.includes("LOADING") ? "LOADING"
            : /^[\d,]+$/.test(vehicles) ? vehicles // vehicles in view
                : texts.every(text => text === "ZOOM IN") ? "ZOOM IN"
                    : texts.includes("ERROR") ? "ERROR"
                        : "ON";
    const count = document.getElementById("transitCount");
    if (count)
        count.textContent = summary;
    const toggle = document.getElementById("transitToggle");
    if (toggle) {
        toggle.title = transitEnabled
            ? names
                .filter(name => transitLayerStatus[name].detail)
                .map(name => `${TRANSIT_LAYER_TITLES[name]}: ${transitLayerStatus[name].detail}`)
                .join("\n")
            : "";
    }
}
function setTransitStatus(layer, text, detail = "") {
    transitLayerStatus[layer] = { text: text, detail: detail };
    renderTransitStatus();
}
const setTransitLinesStatus = (text, detail) => setTransitStatus("lines", text, detail);
const setTransitLiveStatus = (text, detail) => setTransitStatus("live", text, detail);
// Operators' colours are "RRGGBB". Many feeds leave the default black or
// white, which says nothing (and vanishes on a dark or light map).
function transitColor(raw, mode) {
    const hex = String(raw || "").replace("#", "").toLowerCase();
    if (!/^[0-9a-f]{6}$/.test(hex) || hex === "000000" || hex === "ffffff") {
        return transitModeInfo(mode).color;
    }
    return "#" + hex;
}
// Google "encoded polyline" text -> [lon, lat] points
function decodeTransitPolyline(text, precision) {
    const factor = Math.pow(10, precision);
    const points = [];
    let index = 0;
    let lat = 0;
    let lon = 0;
    while (index < text.length) {
        for (let axis = 0; axis < 2; axis++) {
            let shift = 0;
            let result = 0;
            let byte;
            do {
                byte = text.charCodeAt(index++) - 63;
                result |= (byte & 0x1f) << shift;
                shift += 5;
            } while (byte >= 0x20 && index < text.length);
            const delta = (result & 1) ? ~(result >> 1) : (result >> 1);
            if (axis === 0)
                lat += delta;
            else
                lon += delta;
        }
        points.push([lon / factor, lat / factor]);
    }
    return points;
}
// The part of the world on screen, grown by `pad` (a share of its size).
// Null when the view wraps around the globe (far too wide to load anyway).
function transitViewBox(pad) {
    const bounds = map.getBounds();
    const height = bounds.getNorth() - bounds.getSouth();
    const width = bounds.getEast() - bounds.getWest();
    if (!(width > 0) || width >= 180 || !(height > 0))
        return null;
    let west = bounds.getWest() - width * pad;
    let east = bounds.getEast() + width * pad;
    // The map can be scrolled past the date line: bring it back to -180..180
    const shift = Math.floor((bounds.getCenter().lng + 180) / 360) * 360;
    west = Math.max(-180, west - shift);
    east = Math.min(180, east - shift);
    return {
        south: Math.max(-85, bounds.getSouth() - height * pad),
        north: Math.min(85, bounds.getNorth() + height * pad),
        west: west,
        east: east
    };
}
function transitBoxContains(outer, inner) {
    return inner.south >= outer.south && inner.north <= outer.north &&
        inner.west >= outer.west && inner.east <= outer.east;
}
// Transitous wants the corners as "lat,lon": min = lower right, max = upper left
function transitBoxParams(box) {
    return {
        min: `${box.south.toFixed(4)},${box.east.toFixed(4)}`,
        max: `${box.north.toFixed(4)},${box.west.toFixed(4)}`
    };
}
function transitTimeParam(ms) {
    return new Date(ms).toISOString().slice(0, 19) + "Z";
}
// "in 4 min" (a clock time would be in this computer's time zone, not the stop's)
function formatTransitEta(ms, now) {
    const minutes = Math.round((ms - now) / 60000);
    return minutes <= 0 ? "arriving" : `in ${minutes} min`;
}
// ==============================================
// T5. REQUESTS
// ==============================================
async function transitFetch(kind, params) {
    const query = new URLSearchParams(params).toString();
    const readAnswer = async function (response) {
        // "too many routes" / "too many polylines"
        if (response.status === 422 || response.status === 400) {
            throw new TransitTooMuch("Area too large");
        }
        if (!response.ok)
            throw new Error(`Transit service answered ${response.status}`);
        return await response.json();
    };
    // Local relay first (not available when the page is opened as a file,
    // or served by something other than server.py)
    if (transitProxyOk !== false && location.protocol.startsWith("http")) {
        try {
            const response = await fetch(`${TRANSIT_PROXY_PATH}?kind=${kind}&${query}`);
            const isJson = (response.headers.get("Content-Type") || "").includes("json");
            // No relay here (404 / an HTML page), or the relay could not
            // reach Transitous (502): ask directly instead
            // (400: a server.py started before this kind of request existed)
            if (isJson && response.status !== 502 && response.status !== 400) {
                transitProxyOk = true;
                return await readAnswer(response);
            }
            if (!isJson)
                transitProxyOk = false;
        }
        catch (error) {
            if (error instanceof TransitTooMuch)
                throw error;
            if (transitProxyOk === null)
                transitProxyOk = false;
        }
    }
    return await readAnswer(await fetch(`${TRANSIT_API}${TRANSIT_ENDPOINTS[kind]}?${query}`, {
        headers: { "Accept": "application/json" }
    }));
}
// ==============================================
// T6. MAP LAYERS
// ==============================================
// Runs on every style load, because changing the base map wipes all layers.
function setupTransitLayers() {
    // Transit goes underneath the aircraft and airport pins
    const layers = map.getStyle().layers || [];
    const firstFlightLayer = layers.find(layer => layer.id.startsWith("flights-"));
    const before = firstFlightLayer ? firstFlightLayer.id : undefined;
    if (!map.getSource(TRANSIT_LINES_SOURCE)) {
        map.addSource(TRANSIT_LINES_SOURCE, {
            type: "geojson",
            data: lastTransitLinesGeoJSON
        });
    }
    if (!map.getSource(TRANSIT_ROUTE_SOURCE)) {
        map.addSource(TRANSIT_ROUTE_SOURCE, {
            type: "geojson",
            data: lastTransitRouteGeoJSON
        });
    }
    if (!map.getSource(TRANSIT_LIVE_SOURCE)) {
        map.addSource(TRANSIT_LIVE_SOURCE, {
            type: "geojson",
            data: lastTransitLiveGeoJSON
        });
    }
    // Bus and coach lines: thin and faint, and only once zoomed in,
    // otherwise they bury the rail network
    if (!map.getLayer(TRANSIT_LINES_BUS_LAYER)) {
        map.addLayer({
            id: TRANSIT_LINES_BUS_LAYER,
            type: "line",
            source: TRANSIT_LINES_SOURCE,
            minzoom: 11,
            filter: ["<=", ["get", "rank"], 1],
            layout: { "line-cap": "round", "line-join": "round" },
            paint: {
                "line-color": ["get", "color"],
                "line-opacity": 0.55,
                "line-width": ["interpolate", ["linear"], ["zoom"], 11, 0.8, 16, 2.5]
            }
        }, before);
    }
    // Rail, metro, tram and ferry lines
    if (!map.getLayer(TRANSIT_LINES_RAIL_LAYER)) {
        map.addLayer({
            id: TRANSIT_LINES_RAIL_LAYER,
            type: "line",
            source: TRANSIT_LINES_SOURCE,
            filter: [">", ["get", "rank"], 1],
            layout: {
                "line-cap": "round",
                "line-join": "round",
                "line-sort-key": ["get", "rank"]
            },
            paint: {
                "line-color": ["get", "color"],
                "line-opacity": 0.9,
                "line-width": ["interpolate", ["linear"], ["zoom"], 8, 1.2, 12, 2.4, 16, 4.5]
            }
        }, before);
    }
    // The clicked route: a white edge, the line's colour, and its stops
    if (!map.getLayer(TRANSIT_ROUTE_CASING_LAYER)) {
        map.addLayer({
            id: TRANSIT_ROUTE_CASING_LAYER,
            type: "line",
            source: TRANSIT_ROUTE_SOURCE,
            filter: ["==", ["geometry-type"], "LineString"],
            layout: { "line-cap": "round", "line-join": "round" },
            paint: {
                "line-color": "#ffffff",
                "line-width": ["interpolate", ["linear"], ["zoom"], 5, 4, 12, 8, 16, 11]
            }
        }, before);
    }
    if (!map.getLayer(TRANSIT_ROUTE_LAYER)) {
        map.addLayer({
            id: TRANSIT_ROUTE_LAYER,
            type: "line",
            source: TRANSIT_ROUTE_SOURCE,
            filter: ["==", ["geometry-type"], "LineString"],
            layout: { "line-cap": "round", "line-join": "round" },
            paint: {
                "line-color": ["get", "color"],
                "line-width": ["interpolate", ["linear"], ["zoom"], 5, 2, 12, 5, 16, 7.5]
            }
        }, before);
    }
    if (!map.getLayer(TRANSIT_ROUTE_STOPS_LAYER)) {
        map.addLayer({
            id: TRANSIT_ROUTE_STOPS_LAYER,
            type: "circle",
            source: TRANSIT_ROUTE_SOURCE,
            minzoom: 9,
            filter: ["==", ["geometry-type"], "Point"],
            paint: {
                "circle-color": "#ffffff",
                "circle-radius": ["interpolate", ["linear"], ["zoom"], 9, 2, 12, 3.5, 16, 6],
                "circle-stroke-color": ["get", "color"],
                "circle-stroke-width": ["interpolate", ["linear"], ["zoom"], 9, 1, 13, 2]
            }
        }, before);
    }
    // Station markers (T8B), under the vehicles
    addTransitStationLayer(before);
    // One pictogram per vehicle. The images are drawn when the map first
    // asks for them (see onTransitImageMissing).
    if (!map.getLayer(TRANSIT_LIVE_LAYER)) {
        map.addLayer({
            id: TRANSIT_LIVE_LAYER,
            type: "symbol",
            source: TRANSIT_LIVE_SOURCE,
            layout: {
                "icon-image": ["get", "icon"],
                "icon-size": ["interpolate", ["linear"], ["zoom"], 8, 0.6, 12, 0.8, 15, 1],
                "icon-allow-overlap": true,
                "icon-ignore-placement": true,
                "symbol-sort-key": ["get", "rank"]
            },
            paint: {
                "icon-opacity": ["case", ["get", "realTime"], 1, 0.85]
            }
        }, before);
    }
    // Line numbers next to the vehicles. Text needs a font from the base
    // map's own font server, so borrow one the style already uses (the
    // satellite style has no fonts at all: no labels there).
    if (!map.getLayer(TRANSIT_LIVE_LABEL_LAYER) && map.getStyle().glyphs) {
        let font = null;
        for (const layer of layers) {
            const candidate = layer.type === "symbol" && layer.layout
                ? layer.layout["text-font"]
                : null;
            if (Array.isArray(candidate) && candidate.every(item => typeof item === "string")) {
                font = candidate;
                break;
            }
        }
        if (font) {
            map.addLayer({
                id: TRANSIT_LIVE_LABEL_LAYER,
                type: "symbol",
                source: TRANSIT_LIVE_SOURCE,
                minzoom: 13,
                layout: {
                    "text-field": ["get", "name"],
                    "text-font": font,
                    "text-size": 10,
                    "text-offset": [0, 1.3],
                    "text-anchor": "top",
                    "text-optional": true
                },
                paint: {
                    "text-color": "#e8f1f8",
                    "text-halo-color": "#0b1520",
                    "text-halo-width": 1.4
                }
            }, before);
        }
    }
}
// Safety net, same as the flight layers: rebuild anything a style change removed.
// (applyTransitRouteDim keeps the network faded if a route is selected.)
function ensureTransitLayers() {
    if (!map || !map.isStyleLoaded())
        return;
    if (map.getSource(TRANSIT_LINES_SOURCE) &&
        map.getSource(TRANSIT_LIVE_SOURCE) &&
        map.getSource(TRANSIT_ROUTE_SOURCE) &&
        map.getLayer(TRANSIT_STATIONS_LAYER) &&
        map.getLayer(TRANSIT_ROUTE_CASING_LAYER) &&
        map.getLayer(TRANSIT_ROUTE_LAYER) &&
        map.getLayer(TRANSIT_ROUTE_STOPS_LAYER) &&
        map.getLayer(TRANSIT_LINES_BUS_LAYER) &&
        map.getLayer(TRANSIT_LINES_RAIL_LAYER) &&
        map.getLayer(TRANSIT_LIVE_LAYER))
        return;
    try {
        setupTransitLayers();
        applyTransitRouteDim();
    }
    catch (error) {
        console.warn("Transit layers could not be rebuilt yet:", error);
    }
}
function drawTransitLines(features) {
    lastTransitLinesGeoJSON = { type: "FeatureCollection", features: features };
    const source = map && transitGeoSource(TRANSIT_LINES_SOURCE);
    if (source)
        source.setData(lastTransitLinesGeoJSON);
}
function drawTransitVehicles(features) {
    lastTransitLiveGeoJSON = { type: "FeatureCollection", features: features };
    const source = map && transitGeoSource(TRANSIT_LIVE_SOURCE);
    if (source)
        source.setData(lastTransitLiveGeoJSON);
}
// ==============================================
// T6B. VEHICLE ICONS
//
// Small front-view pictograms on a 48 x 48 grid (shown 24 px wide at full
// size), filled with the line's colour. Lines come in any colour, so the
// images are made on demand: the layer asks for an image by name, and
// MapLibre's "styleimagemissing" event lets us draw it then.
// ==============================================
const TRANSIT_ICON_GRID = 48;
const TRANSIT_ICON_SCALE = 2; // drawn at twice the size, for sharp edges
const TRANSIT_ICON_PREFIX = "transit-icon";
const TRANSIT_ICON_NAMES = ["train", "metro", "tram", "bus", "ferry", "lift"];
const transitIconImages = new Map(); // image name -> drawn icon
// e.g. "transit-icon|metro|da421e|1"  (kind, colour, 1 = real-time outline)
function transitIconId(icon, color, realTime) {
    return `${TRANSIT_ICON_PREFIX}|${icon}|${color.replace("#", "")}|${realTime ? 1 : 0}`;
}
function traceTransitBox(ctx, x, y, w, h, radius) {
    const [tl, tr, br, bl] = typeof radius === "number"
        ? [radius, radius, radius, radius]
        : radius;
    ctx.beginPath();
    ctx.moveTo(x + tl, y);
    ctx.arcTo(x + w, y, x + w, y + h, tr);
    ctx.arcTo(x + w, y + h, x, y + h, br);
    ctx.arcTo(x, y + h, x, y, bl);
    ctx.arcTo(x, y, x + w, y, tl);
    ctx.closePath();
}
function traceTransitLine(ctx, points) {
    ctx.beginPath();
    points.forEach((p, i) => (i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1])));
}
function traceTransitDot(ctx, x, y, r) {
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
}
const TRANSIT_ICON_PARTS = {
    // Streamlined nose, sloped windscreen, standing on rails
    train: [
        { line: 3.5, trace: ctx => traceTransitLine(ctx, [[17, 36], [12, 44]]) },
        { line: 3.5, trace: ctx => traceTransitLine(ctx, [[31, 36], [36, 44]]) },
        { trace: function (ctx) {
                ctx.beginPath();
                ctx.moveTo(18, 4);
                ctx.lineTo(30, 4);
                ctx.bezierCurveTo(36, 6, 39, 17, 39, 29);
                ctx.lineTo(39, 33);
                ctx.quadraticCurveTo(39, 37, 35, 37);
                ctx.lineTo(13, 37);
                ctx.quadraticCurveTo(9, 37, 9, 33);
                ctx.lineTo(9, 29);
                ctx.bezierCurveTo(9, 17, 12, 6, 18, 4);
                ctx.closePath();
            } },
        { detail: true, trace: function (ctx) {
                ctx.beginPath();
                ctx.moveTo(18, 10);
                ctx.lineTo(30, 10);
                ctx.lineTo(34, 22);
                ctx.lineTo(14, 22);
                ctx.closePath();
            } },
        { detail: true, trace: ctx => traceTransitDot(ctx, 15, 30, 2.2) },
        { detail: true, trace: ctx => traceTransitDot(ctx, 33, 30, 2.2) }
    ],
    // Boxy car with a domed roof, over a single track bar
    metro: [
        { trace: ctx => traceTransitBox(ctx, 12, 40, 24, 3.5, 1.5) },
        { trace: ctx => traceTransitBox(ctx, 10, 5, 28, 31, [11, 11, 4, 4]) },
        { detail: true, trace: ctx => traceTransitBox(ctx, 14, 11, 20, 11, [6, 6, 2, 2]) },
        { detail: true, trace: ctx => traceTransitDot(ctx, 16.5, 29, 2.2) },
        { detail: true, trace: ctx => traceTransitDot(ctx, 31.5, 29, 2.2) }
    ],
    // Narrow car with a pantograph on the roof and one headlight
    tram: [
        { line: 2.5, trace: ctx => traceTransitLine(ctx, [[15, 4], [33, 4]]) },
        { line: 2.5, trace: ctx => traceTransitLine(ctx, [[19, 4], [24, 12], [29, 4]]) },
        { trace: ctx => traceTransitBox(ctx, 12, 12, 24, 27, [7, 7, 4, 4]) },
        { trace: ctx => traceTransitBox(ctx, 14, 40, 6, 4, 1.5) },
        { trace: ctx => traceTransitBox(ctx, 28, 40, 6, 4, 1.5) },
        { detail: true, trace: ctx => traceTransitBox(ctx, 15, 16, 18, 11, 3) },
        { detail: true, trace: ctx => traceTransitDot(ctx, 24, 33, 2.3) }
    ],
    // Wide body, big windscreen, wing mirrors and two wheels
    bus: [
        { trace: ctx => traceTransitBox(ctx, 12, 34, 7, 8, 2) },
        { trace: ctx => traceTransitBox(ctx, 29, 34, 7, 8, 2) },
        { trace: ctx => traceTransitBox(ctx, 4, 15, 4, 7, 1.5) },
        { trace: ctx => traceTransitBox(ctx, 40, 15, 4, 7, 1.5) },
        { trace: ctx => traceTransitBox(ctx, 8, 7, 32, 30, 6) },
        { detail: true, trace: ctx => traceTransitBox(ctx, 12, 11, 24, 13, 2.5) },
        { detail: true, trace: ctx => traceTransitDot(ctx, 14.5, 31, 2.2) },
        { detail: true, trace: ctx => traceTransitDot(ctx, 33.5, 31, 2.2) }
    ],
    // Hull, cabin with portholes, and a funnel
    ferry: [
        { trace: ctx => traceTransitBox(ctx, 26, 8, 7, 10, 1.5) },
        { trace: ctx => traceTransitBox(ctx, 12, 16, 24, 13, 3) },
        { trace: function (ctx) {
                ctx.beginPath();
                ctx.moveTo(5, 28);
                ctx.lineTo(43, 28);
                ctx.lineTo(37, 40);
                ctx.lineTo(11, 40);
                ctx.closePath();
            } },
        { detail: true, trace: ctx => traceTransitDot(ctx, 18, 22.5, 2) },
        { detail: true, trace: ctx => traceTransitDot(ctx, 24, 22.5, 2) },
        { detail: true, trace: ctx => traceTransitDot(ctx, 30, 22.5, 2) }
    ],
    // Cabin hanging from a cable
    lift: [
        { line: 2.5, trace: ctx => traceTransitLine(ctx, [[5, 9], [43, 5]]) },
        { line: 2.5, trace: ctx => traceTransitLine(ctx, [[24, 7], [24, 18]]) },
        { trace: ctx => traceTransitBox(ctx, 11, 17, 26, 24, 7) },
        { detail: true, trace: ctx => traceTransitBox(ctx, 15, 22, 18, 10, 2.5) }
    ]
};
function createTransitIcon(icon, color, realTime) {
    const size = TRANSIT_ICON_GRID * TRANSIT_ICON_SCALE;
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext("2d");
    if (!ctx)
        throw new Error("Canvas 2D drawing is not available");
    ctx.scale(TRANSIT_ICON_SCALE, TRANSIT_ICON_SCALE);
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    // Windows and lights: dark on a light vehicle, white on a dark one
    const red = parseInt(color.slice(1, 3), 16);
    const green = parseInt(color.slice(3, 5), 16);
    const blue = parseInt(color.slice(5, 7), 16);
    const light = (0.299 * red + 0.587 * green + 0.114 * blue) > 150;
    const outline = realTime ? "#ffffff" : "#93a1b0";
    const rim = "#0b1520"; // thin dark edge around the outline, so it shows on light maps too
    const detail = light ? "#0b1520" : "#ffffff";
    const edge = 2; // outline thickness, in grid units
    const parts = TRANSIT_ICON_PARTS[icon];
    // 1. the whole silhouette, fattened: first in the rim colour, then
    //    a little less fat in the outline colour
    [[rim, edge + 1], [outline, edge]].forEach(function ([paint, grow]) {
        ctx.strokeStyle = paint;
        ctx.fillStyle = paint;
        parts.forEach(function (part) {
            if (part.detail)
                return;
            part.trace(ctx);
            ctx.lineWidth = (part.line || 0) + grow * 2;
            ctx.stroke();
            if (!part.line)
                ctx.fill();
        });
    });
    // 2. the vehicle itself, in the line's colour
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    parts.forEach(function (part) {
        if (part.detail)
            return;
        part.trace(ctx);
        if (part.line) {
            ctx.lineWidth = part.line;
            ctx.stroke();
        }
        else {
            ctx.fill();
        }
    });
    // 3. windows and lights
    ctx.fillStyle = detail;
    parts.forEach(function (part) {
        if (!part.detail)
            return;
        part.trace(ctx);
        ctx.fill();
    });
    return ctx.getImageData(0, 0, size, size);
}
// The vehicle layer wants an image the map doesn't have yet: draw it.
// (A base map change throws all images away; they come back the same way.)
function onTransitImageMissing(e) {
    const [prefix, icon, hex, flag] = String(e.id).split("|");
    const isStation = prefix === TRANSIT_STATION_ICON_PREFIX;
    if (prefix !== TRANSIT_ICON_PREFIX && !isStation)
        return;
    if (!TRANSIT_ICON_NAMES.includes(icon))
        return;
    if (!/^[0-9a-f]{6}$/.test(hex || ""))
        return;
    let image = transitIconImages.get(e.id);
    if (!image) {
        image = isStation
            ? createTransitStationIcon(icon, "#" + hex)
            : createTransitIcon(icon, "#" + hex, flag === "1");
        if (transitIconImages.size > 600)
            transitIconImages.clear();
        transitIconImages.set(e.id, image);
    }
    if (!map.hasImage(e.id)) {
        map.addImage(e.id, image, {
            pixelRatio: 2 * TRANSIT_ICON_SCALE // 48-unit grid shows as 24 px
        });
    }
}
// ==============================================
// T7. TRANSIT LINES
// ==============================================
// Cut a line down to the pieces inside the box (routes of long-distance
// trains arrive whole, hundreds of km beyond the screen)
function clipTransitLine(points, box) {
    const inside = (p) => p[0] >= box.west && p[0] <= box.east && p[1] >= box.south && p[1] <= box.north;
    const pieces = [];
    let piece = [];
    let previousInside = false;
    for (let i = 0; i < points.length; i++) {
        const isInside = inside(points[i]);
        if (isInside) {
            // Start a piece with the point just outside, so lines run to the edge
            if (!previousInside && i > 0)
                piece.push(points[i - 1]);
            piece.push(points[i]);
        }
        else if (previousInside) {
            piece.push(points[i]);
            pieces.push(piece);
            piece = [];
        }
        previousInside = isInside;
    }
    if (piece.length > 1)
        pieces.push(piece);
    return pieces;
}
function buildTransitLineFeatures(payload, box) {
    const features = [];
    const routes = Array.isArray(payload.routes) ? payload.routes : [];
    (Array.isArray(payload.polylines) ? payload.polylines : []).forEach(function (line) {
        if (!line || !line.polyline || !line.polyline.points)
            return;
        // Several routes can share one stretch of track: label it with all
        // of them, and style it as the most important kind
        let mode = "";
        const names = [];
        const refs = new Map();
        (line.routeIndexes || []).forEach(function (index) {
            const route = routes[index];
            if (!route || TRANSIT_SKIP_MODES.has(route.mode))
                return;
            if (!mode || transitModeInfo(route.mode).rank > transitModeInfo(mode).rank) {
                mode = route.mode;
            }
            (route.transitRoutes || []).forEach(function (info) {
                const name = (info.shortName || info.longName || "").trim();
                if (name && !names.includes(name) && names.length < 6)
                    names.push(name);
            });
            // For clicking: per line, its run with the most stops
            const main = (route.transitRoutes || [])[0];
            if (main && typeof route.routeIdx === "number") {
                const name = (main.shortName || main.longName || "").trim();
                const key = `${main.id || ""}|${name}`;
                const stops = route.numStops || 0;
                const known = refs.get(key);
                if (!known || stops > known.stops) {
                    refs.set(key, { name: name, idx: route.routeIdx, mode: route.mode, stops: stops });
                }
            }
        });
        if (!mode)
            return;
        const info = transitModeInfo(mode);
        const properties = {
            color: transitColor((line.colors || [])[0], mode),
            rank: info.rank,
            mode: info.label,
            name: names.join(" · "),
            lines: JSON.stringify(Array.from(refs.values())
                .sort((a, b) => transitModeInfo(b.mode).rank - transitModeInfo(a.mode).rank)
                .slice(0, 8)
                .map(ref => ({ name: ref.name, idx: ref.idx, mode: ref.mode })))
        };
        clipTransitLine(decodeTransitPolyline(line.polyline.points, line.polyline.precision), box)
            .forEach(function (piece) {
            features.push({
                type: "Feature",
                geometry: { type: "LineString", coordinates: piece },
                properties: properties
            });
        });
    });
    return features;
}
async function refreshTransitLines() {
    if (!transitLinesEnabled || !map)
        return;
    const zoom = map.getZoom();
    const view = transitViewBox(0);
    if (zoom < TRANSIT_LINES_MIN_ZOOM || !view) {
        transitLinesGeneration++; // drop whatever is still loading
        transitLinesCover = null;
        drawTransitLines([]);
        setTransitLinesStatus("ZOOM IN", "Zoom in to load the transit lines of an area.");
        return;
    }
    // Already showing this area? Reload only if zooming in can add lines
    // that were left out before.
    if (transitLinesCover && transitBoxContains(transitLinesCover.box, view)) {
        const wantsMore = !transitLinesCover.complete &&
            zoom >= TRANSIT_LINES_FULL_ZOOM &&
            Math.floor(zoom) > transitLinesCover.zoom;
        if (!wantsMore)
            return;
    }
    if (transitLinesBusy) {
        transitLinesQueued = true;
        return;
    }
    transitLinesBusy = true;
    const generation = ++transitLinesGeneration;
    setTransitLinesStatus("LOADING", "Loading transit lines...");
    // Snap the area outwards to a grid so that small pans reuse the relay's cache
    const padded = transitViewBox(TRANSIT_LINES_PAD) || view;
    const grid = TRANSIT_LINES_GRID;
    const box = {
        south: Math.floor(padded.south / grid) * grid,
        west: Math.floor(padded.west / grid) * grid,
        north: Math.ceil(padded.north / grid) * grid,
        east: Math.ceil(padded.east / grid) * grid
    };
    // Everything when zoomed in; if the area is too busy for that (or the
    // view is wide), the railways only.
    const tiers = zoom >= TRANSIT_LINES_FULL_ZOOM
        ? [Math.floor(zoom), TRANSIT_LINES_RAIL_TIER]
        : [TRANSIT_LINES_RAIL_TIER];
    try {
        let payload = null;
        let usedTier = tiers[0];
        for (const tier of tiers) {
            try {
                payload = await transitFetch("routes", {
                    zoom: String(tier),
                    ...transitBoxParams(box)
                });
                usedTier = tier;
                break;
            }
            catch (error) {
                if (!(error instanceof TransitTooMuch))
                    throw error;
            }
        }
        if (generation !== transitLinesGeneration)
            return;
        if (!payload) {
            transitLinesCover = null;
            drawTransitLines([]);
            setTransitLinesStatus("ZOOM IN", "Too many lines in this area. Zoom in.");
            return;
        }
        const features = buildTransitLineFeatures(payload, box);
        const railOnly = usedTier === TRANSIT_LINES_RAIL_TIER;
        transitLinesCover = {
            box: box,
            zoom: railOnly ? TRANSIT_LINES_RAIL_TIER : Math.floor(zoom),
            complete: !railOnly && !payload.zoomFiltered
        };
        drawTransitLines(features);
        setTransitLinesStatus(railOnly ? "RAIL" : "ON", railOnly
            ? "Showing railways only. Zoom in for metro, tram and bus lines."
            : "Showing all transit lines in this area.");
    }
    catch (error) {
        if (generation !== transitLinesGeneration)
            return;
        console.warn("Transit lines failed:", error);
        setTransitLinesStatus("ERROR", "Transit lines could not be loaded. Move the map to try again.");
    }
    finally {
        transitLinesBusy = false;
        if (transitLinesQueued) {
            transitLinesQueued = false;
            refreshTransitLines();
        }
    }
}
function setTransitLinesEnabled(on) {
    transitLinesEnabled = on;
    transitLinesGeneration++;
    if (on) {
        refreshTransitLines();
    }
    else {
        transitLinesCover = null;
        drawTransitLines([]);
        clearTransitRoute();
        transitHoverPopup.remove();
        setTransitLinesStatus("OFF");
    }
}
// ==============================================
// T7B. SELECTED ROUTE (click a line to highlight all of it)
//
// The lines on the map are cut off at the edge of the loaded area. Clicking
// one asks Transitous for that route alone, end to end with all its stops,
// and draws it on top; the other lines fade while it is selected.
//
// A "line" in the timetable is many slightly different runs (short
// workings, each direction, ...). The one shown is the run with the most
// stops among those passing the clicked spot.
// ==============================================
function transitLineRefsOf(feature) {
    try {
        const refs = JSON.parse(String(feature.properties.lines || "[]"));
        return Array.isArray(refs) ? refs : [];
    }
    catch (error) {
        return [];
    }
}
// Fade the network while one route is picked out (and back again)
function applyTransitRouteDim() {
    if (!map)
        return;
    const dim = Boolean(transitRouteSelected);
    if (map.getLayer(TRANSIT_LINES_BUS_LAYER)) {
        map.setPaintProperty(TRANSIT_LINES_BUS_LAYER, "line-opacity", dim ? 0.15 : 0.55);
    }
    if (map.getLayer(TRANSIT_LINES_RAIL_LAYER)) {
        map.setPaintProperty(TRANSIT_LINES_RAIL_LAYER, "line-opacity", dim ? 0.3 : 0.9);
    }
}
function drawTransitRoute(features) {
    lastTransitRouteGeoJSON = { type: "FeatureCollection", features: features };
    const source = map && transitGeoSource(TRANSIT_ROUTE_SOURCE);
    if (source)
        source.setData(lastTransitRouteGeoJSON);
}
function clearTransitRoute() {
    transitRouteGeneration++; // drop a route that is still loading
    transitRouteSelected = false;
    transitRouteBounds = null;
    transitRouteClickKey = "";
    drawTransitRoute([]);
    applyTransitRouteDim();
    if (transitRoutePopup && transitRoutePopup.isOpen())
        transitRoutePopup.remove();
}
function transitRouteDistanceKm(a, b) {
    const rad = Math.PI / 180;
    const dLat = (b[1] - a[1]) * rad;
    const dLon = (b[0] - a[0]) * rad;
    const h = Math.sin(dLat / 2) ** 2 +
        Math.cos(a[1] * rad) * Math.cos(b[1] * rad) * Math.sin(dLon / 2) ** 2;
    return 12742 * Math.asin(Math.min(1, Math.sqrt(h)));
}
function showTransitRoutePopup(at, html) {
    transitRoutePopup.setLngLat(at).setHTML(html);
    // (adding an open popup again would close it first, and closing
    // clears the selection)
    if (!transitRoutePopup.isOpen())
        transitRoutePopup.addTo(map);
}
async function selectTransitRoute(refs, index, at) {
    const ref = refs[index];
    const info = transitModeInfo(ref.mode);
    const generation = ++transitRouteGeneration;
    const title = `<strong>${escapeHTML(ref.name || info.label)}</strong>` +
        ` <span class="transit-popup-mode">${escapeHTML(info.label.toUpperCase())}</span>`;
    showTransitRoutePopup(at, `${title}<br>Loading route...`);
    try {
        const payload = await transitFetch("details", {
            routeIdx: String(ref.idx)
        });
        if (generation !== transitRouteGeneration)
            return;
        const route = (payload.routes || [])[0];
        const names = route
            ? (route.transitRoutes || []).map(item => (item.shortName || item.longName || "").trim())
            : [];
        // Transitous renumbers its routes when its timetables are rebuilt.
        // If the number now belongs to another line, the lines on the map
        // are out of date: reload them on the next move.
        if (!route || (ref.name && !names.includes(ref.name))) {
            transitLinesCover = null;
            throw new Error("Route number is out of date");
        }
        const color = transitColor(((payload.polylines || [])[0]?.colors || [])[0] || (route.transitRoutes || [])[0]?.color, route.mode);
        const features = [];
        let km = 0;
        let west = 180, east = -180, south = 90, north = -90;
        (payload.polylines || []).forEach(function (line) {
            if (!line || !line.polyline || !line.polyline.points)
                return;
            const path = decodeTransitPolyline(line.polyline.points, line.polyline.precision);
            if (path.length < 2)
                return;
            path.forEach(function (point, i) {
                if (i > 0)
                    km += transitRouteDistanceKm(path[i - 1], point);
                west = Math.min(west, point[0]);
                east = Math.max(east, point[0]);
                south = Math.min(south, point[1]);
                north = Math.max(north, point[1]);
            });
            features.push({
                type: "Feature",
                geometry: { type: "LineString", coordinates: path },
                properties: { color: color }
            });
        });
        if (!features.length)
            throw new Error("Route has no shape");
        // Stops, in travelling order
        const stops = payload.stops || [];
        const order = [];
        (route.segments || []).forEach(function (segment, i) {
            if (i === 0)
                order.push(segment.from);
            order.push(segment.to);
        });
        const visited = order.map(i => stops[i]).filter(stop => stop && Number.isFinite(stop.lat));
        visited.forEach(function (stop) {
            features.push({
                type: "Feature",
                geometry: { type: "Point", coordinates: [stop.lon, stop.lat] },
                properties: { color: color, name: stop.name || "" }
            });
        });
        transitRouteSelected = true;
        transitRouteBounds = [[west, south], [east, north]];
        drawTransitRoute(features);
        applyTransitRouteDim();
        const others = refs.filter((_, i) => i !== index).map(other => other.name).filter(Boolean);
        const first = visited[0];
        const last = visited[visited.length - 1];
        showTransitRoutePopup(at, title +
            (first && last
                ? `<br>${escapeHTML(first.name || "?")} &rarr; ${escapeHTML(last.name || "?")}`
                : "") +
            `<br>${visited.length} stops · ${km >= 100 ? Math.round(km) : km.toFixed(1)} km` +
            (others.length
                ? `<br><small>Also here: ${escapeHTML(others.join(", "))}. ` +
                    "Click the line again to switch.</small>"
                : "") +
            `<br><button type="button" class="transit-popup-button">SHOW WHOLE ROUTE</button>`);
        const button = transitRoutePopup.getElement()?.querySelector("button.transit-popup-button");
        if (button) {
            button.addEventListener("click", function () {
                if (transitRouteBounds) {
                    map.fitBounds(transitRouteBounds, { padding: 70, maxZoom: 15, duration: 1200 });
                }
            });
        }
    }
    catch (error) {
        if (generation !== transitRouteGeneration)
            return;
        console.warn("Transit route failed:", error);
        transitRouteSelected = false;
        drawTransitRoute([]);
        applyTransitRouteDim();
        showTransitRoutePopup(at, `${title}<br>This route could not be loaded.`);
    }
}
// ==============================================
// T8. LIVE VEHICLES
// ==============================================
function readTransitVehicles(segments, precision) {
    const vehicles = new Map();
    segments.forEach(function (segment) {
        if (!segment || TRANSIT_SKIP_MODES.has(segment.mode) || !segment.polyline)
            return;
        const trip = (segment.trips || [])[0];
        const dep = Date.parse(segment.departure);
        const arr = Date.parse(segment.arrival);
        if (!trip || !trip.tripId || !Number.isFinite(dep) || !Number.isFinite(arr))
            return;
        let vehicle = vehicles.get(trip.tripId);
        if (!vehicle) {
            vehicle = {
                id: trip.tripId,
                name: (trip.displayName || "").trim(),
                mode: segment.mode,
                color: transitColor(segment.routeColor, segment.mode),
                realTime: false,
                legs: []
            };
            vehicles.set(trip.tripId, vehicle);
        }
        if (segment.realTime)
            vehicle.realTime = true;
        const schedArr = Date.parse(segment.scheduledArrival || "");
        vehicle.legs.push({
            dep: dep,
            arr: arr,
            schedArr: Number.isFinite(schedArr) ? schedArr : arr,
            from: (segment.from && segment.from.name) || "",
            to: (segment.to && segment.to.name) || "",
            encoded: segment.polyline,
            precision: precision,
            path: null,
            cum: null
        });
    });
    vehicles.forEach(vehicle => vehicle.legs.sort((a, b) => a.dep - b.dep));
    return vehicles;
}
// The stretch a vehicle is on right now: the latest one it has set off on,
// or its first one if it is still waiting to leave.
function transitCurrentLeg(vehicle, now) {
    let current = vehicle.legs[0];
    for (const leg of vehicle.legs) {
        if (leg.dep <= now)
            current = leg;
    }
    return current;
}
// Where along its track the vehicle should be, going by the clock
function transitVehiclePosition(vehicle, now) {
    const leg = transitCurrentLeg(vehicle, now);
    if (!leg.path) {
        leg.path = decodeTransitPolyline(leg.encoded, leg.precision);
        // Distance along the line (flat-earth is plenty between two stops)
        const cosLat = leg.path.length ? Math.cos(leg.path[0][1] * Math.PI / 180) : 1;
        let total = 0;
        leg.cum = leg.path.map(function (point, i, path) {
            if (i > 0) {
                total += Math.hypot((point[0] - path[i - 1][0]) * cosLat, point[1] - path[i - 1][1]);
            }
            return total;
        });
    }
    const path = leg.path;
    const cum = leg.cum;
    if (!path.length || !cum)
        return null;
    const span = leg.arr - leg.dep;
    const done = span > 0 ? Math.min(1, Math.max(0, (now - leg.dep) / span)) : 1;
    const target = cum[cum.length - 1] * done;
    for (let i = 1; i < path.length; i++) {
        if (cum[i] >= target) {
            const step = cum[i] - cum[i - 1];
            const part = step > 0 ? (target - cum[i - 1]) / step : 0;
            return [
                path[i - 1][0] + (path[i][0] - path[i - 1][0]) * part,
                path[i - 1][1] + (path[i][1] - path[i - 1][1]) * part
            ];
        }
    }
    return path[path.length - 1];
}
function transitVehicleHtml(vehicle, now) {
    const leg = transitCurrentLeg(vehicle, now);
    const lateMin = Math.round((leg.arr - leg.schedArr) / 60000);
    const timing = !vehicle.realTime
        ? "timetable only"
        : lateMin > 0 ? `${lateMin} min late`
            : lateMin < 0 ? `${-lateMin} min early`
                : "on time";
    const waiting = now < leg.dep;
    return `<strong>${escapeHTML(vehicle.name || transitModeInfo(vehicle.mode).label)}</strong>` +
        ` <span class="transit-popup-mode">${escapeHTML(transitModeInfo(vehicle.mode).label.toUpperCase())}</span>` +
        `<br>${waiting ? "At" : "From"} ${escapeHTML(leg.from || "?")}` +
        `<br>Next stop ${escapeHTML(leg.to || "?")} · ${escapeHTML(formatTransitEta(leg.arr, now))}` +
        `<br><span class="${vehicle.realTime ? "transit-popup-live" : "transit-popup-sched"}">` +
        `${vehicle.realTime ? "LIVE" : "SCHEDULED"}</span> ${escapeHTML(timing)}` +
        `<br><small>Position estimated from stop times</small>`;
}
// Runs every second: move every vehicle to where it should be by now
function tickTransitVehicles() {
    if (!transitLiveEnabled || !map)
        return;
    const now = Date.now();
    const features = [];
    let selectedAt = null;
    transitVehicles.forEach(function (vehicle) {
        const position = transitVehiclePosition(vehicle, now);
        if (!position)
            return;
        if (vehicle.id === transitSelectedId)
            selectedAt = position;
        features.push({
            type: "Feature",
            geometry: { type: "Point", coordinates: position },
            properties: {
                id: vehicle.id,
                name: vehicle.name,
                color: vehicle.color,
                realTime: vehicle.realTime,
                icon: transitIconId(transitModeInfo(vehicle.mode).icon, vehicle.color, vehicle.realTime),
                rank: transitModeInfo(vehicle.mode).rank + (vehicle.realTime ? 0.5 : 0)
            }
        });
    });
    drawTransitVehicles(features);
    // The open popup rides along with its vehicle
    const selected = transitSelectedId ? transitVehicles.get(transitSelectedId) : undefined;
    if (selected && selectedAt) {
        transitVehiclePopup
            .setLngLat([selectedAt[0], selectedAt[1]])
            .setHTML(transitVehicleHtml(selected, now));
    }
    else if (transitSelectedId) {
        transitSelectedId = null;
        transitVehiclePopup.remove();
    }
}
async function refreshTransitVehicles() {
    if (!transitLiveEnabled || !map)
        return;
    clearTimeout(transitPollTimer);
    // No updates while the tab is hidden; visibilitychange restarts them
    if (document.hidden)
        return;
    const zoom = map.getZoom();
    const box = transitViewBox(TRANSIT_LIVE_PAD);
    if (zoom < TRANSIT_LIVE_MIN_ZOOM || !box) {
        transitLiveGeneration++;
        transitVehicles = new Map();
        tickTransitVehicles();
        setTransitLiveStatus("ZOOM IN", "Zoom in to see vehicles in service.");
        return;
    }
    if (transitLiveBusy) {
        transitLiveQueued = true;
        return;
    }
    transitLiveBusy = true;
    const generation = ++transitLiveGeneration;
    // Coarser track shapes are enough (and much smaller) when zoomed out
    const precision = zoom >= 11 ? 5 : 4;
    try {
        const now = Date.now();
        const segments = await transitFetch("trips", {
            zoom: String(Math.floor(zoom)),
            precision: String(precision),
            startTime: transitTimeParam(now),
            endTime: transitTimeParam(now + TRANSIT_LIVE_WINDOW_MS),
            ...transitBoxParams(box)
        });
        if (generation !== transitLiveGeneration)
            return;
        const next = readTransitVehicles(Array.isArray(segments) ? segments : [], precision);
        // A vehicle standing at a stop is between two timetable entries and
        // can be missing from an update: keep it for a little while.
        transitVehicles.forEach(function (vehicle, id) {
            const last = vehicle.legs[vehicle.legs.length - 1];
            if (!next.has(id) && last.arr > Date.now() - TRANSIT_LIVE_KEEP_MS)
                next.set(id, vehicle);
        });
        transitVehicles = next;
        transitLiveFailures = 0;
        let live = 0;
        next.forEach(vehicle => { if (vehicle.realTime)
            live++; });
        setTransitLiveStatus(next.size.toLocaleString("en-US"), `${next.size} vehicles in view, ${live} with real-time data. ` +
            "Positions are estimated from stop times.");
        tickTransitVehicles();
    }
    catch (error) {
        if (generation !== transitLiveGeneration)
            return;
        if (error instanceof TransitTooMuch) {
            transitVehicles = new Map();
            tickTransitVehicles();
            setTransitLiveStatus("ZOOM IN", "Too many vehicles in this area. Zoom in.");
        }
        else {
            console.warn("Live transit failed:", error);
            transitLiveFailures++;
            setTransitLiveStatus("ERROR", "Live transit could not be loaded. Retrying...");
        }
    }
    finally {
        transitLiveBusy = false;
        // Back off when the service is struggling (30 s, 60 s, ... 5 min)
        if (transitLiveEnabled && generation === transitLiveGeneration) {
            clearTimeout(transitPollTimer);
            transitPollTimer = setTimeout(refreshTransitVehicles, transitLiveQueued && !transitLiveFailures
                ? 0
                : Math.min(TRANSIT_LIVE_POLL_MS * (1 + transitLiveFailures), 300000));
        }
        transitLiveQueued = false;
    }
}
function setTransitLiveEnabled(on) {
    transitLiveEnabled = on;
    transitLiveGeneration++;
    transitLiveBusy = false;
    transitLiveQueued = false;
    transitLiveFailures = 0;
    clearTimeout(transitPollTimer);
    clearInterval(transitTickTimer);
    if (on) {
        setTransitLiveStatus("LOADING", "Loading vehicles...");
        transitTickTimer = setInterval(tickTransitVehicles, TRANSIT_LIVE_TICK_MS);
        refreshTransitVehicles();
    }
    else {
        transitVehicles = new Map();
        transitSelectedId = null;
        transitVehiclePopup.remove();
        transitHoverPopup.remove();
        drawTransitVehicles([]);
        setTransitLiveStatus("OFF");
    }
}
// ==============================================
// T8B. STATIONS (markers + departures / arrivals board)
//
// Marks the stations of the area on screen (all but bus stops); clicking
// one opens a board of the next departures and arrivals,
// like the airport panel. Times come from the timetable, corrected with the
// operator's real-time predictions where published (rows say which).
// ==============================================
// Which stops get a marker: every kind of station except bus and coach
// stops (there are far too many of those)
const TRANSIT_STATION_MODES = "SUBWAY,SUBURBAN,REGIONAL_RAIL,LONG_DISTANCE,HIGHSPEED_RAIL,NIGHT_RAIL," +
    "TRAM,FERRY,FUNICULAR,AERIAL_LIFT";
// What the board lists: the same kinds (no buses: at a big station they
// would bury everything else)
const TRANSIT_BOARD_MODES = TRANSIT_STATION_MODES;
const TRANSIT_STATIONS_MIN_ZOOM = 10;
const TRANSIT_BOARD_ROWS = 30;
const TRANSIT_BOARD_REFRESH_MS = 30000;
const TRANSIT_STATION_ICON_PREFIX = "transit-station";
let transitStationsEnabled = false;
let transitStationsGeneration = 0;
let transitStationsCover = null;
let transitStationsBusy = false;
let transitStationsQueued = false;
let lastTransitStationsGeoJSON = { type: "FeatureCollection", features: [] };
const transitStations = new Map(); // stop id -> station on the map
let transitStationSelected = null;
let transitStationTab = "departures";
let transitBoardGeneration = 0;
let transitBoardTimer;
const setTransitStationsStatus = (text, detail) => setTransitStatus("stations", text, detail);
// ---------- markers ----------
// The most important kind of service at a station decides its marker
function transitStationMode(modes) {
    let best = "";
    modes.forEach(function (mode) {
        if (!TRANSIT_STATION_MODES.split(",").includes(mode))
            return;
        if (!best || transitModeInfo(mode).rank > transitModeInfo(best).rank)
            best = mode;
    });
    return best || "REGIONAL_RAIL";
}
// A square sign in the mode's colour, with the vehicle pictogram inside
function createTransitStationIcon(icon, color) {
    const size = TRANSIT_ICON_GRID * TRANSIT_ICON_SCALE;
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext("2d");
    if (!ctx)
        throw new Error("Canvas 2D drawing is not available");
    ctx.scale(TRANSIT_ICON_SCALE, TRANSIT_ICON_SCALE);
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    const red = parseInt(color.slice(1, 3), 16);
    const green = parseInt(color.slice(3, 5), 16);
    const blue = parseInt(color.slice(5, 7), 16);
    const glyph = (0.299 * red + 0.587 * green + 0.114 * blue) > 150 ? "#0b1520" : "#ffffff";
    // The sign: dark rim, white edge, coloured face
    ctx.fillStyle = "#0b1520";
    traceTransitBox(ctx, 2, 2, 44, 44, 11);
    ctx.fill();
    ctx.fillStyle = "#ffffff";
    traceTransitBox(ctx, 3.5, 3.5, 41, 41, 10);
    ctx.fill();
    ctx.fillStyle = color;
    traceTransitBox(ctx, 6, 6, 36, 36, 8);
    ctx.fill();
    // The pictogram, shrunk to fit
    ctx.translate(24, 24.5);
    ctx.scale(0.58, 0.58);
    ctx.translate(-24, -24);
    const parts = TRANSIT_ICON_PARTS[icon];
    ctx.strokeStyle = glyph;
    ctx.fillStyle = glyph;
    parts.forEach(function (part) {
        if (part.detail)
            return;
        part.trace(ctx);
        if (part.line) {
            ctx.lineWidth = part.line;
            ctx.stroke();
        }
        else {
            ctx.fill();
        }
    });
    ctx.fillStyle = color;
    parts.forEach(function (part) {
        if (!part.detail)
            return;
        part.trace(ctx);
        ctx.fill();
    });
    return ctx.getImageData(0, 0, size, size);
}
// A font the base map already uses (text needs one from its font server).
// Null on the satellite style, which has no fonts.
function transitStyleFont() {
    const style = map.getStyle();
    if (!style.glyphs)
        return null;
    for (const layer of style.layers || []) {
        const candidate = layer.type === "symbol" && layer.layout
            ? layer.layout["text-font"]
            : null;
        if (Array.isArray(candidate) && candidate.every(item => typeof item === "string")) {
            return candidate;
        }
    }
    return null;
}
function addTransitStationLayer(before) {
    if (!map.getSource(TRANSIT_STATIONS_SOURCE)) {
        map.addSource(TRANSIT_STATIONS_SOURCE, {
            type: "geojson",
            data: lastTransitStationsGeoJSON
        });
    }
    if (map.getLayer(TRANSIT_STATIONS_LAYER))
        return;
    const font = transitStyleFont();
    // Markers may not overlap, and the busiest stations are placed first:
    // zoomed out you see the main stations, zooming in reveals the rest.
    map.addLayer({
        id: TRANSIT_STATIONS_LAYER,
        type: "symbol",
        source: TRANSIT_STATIONS_SOURCE,
        layout: {
            "icon-image": ["get", "icon"],
            "icon-size": ["interpolate", ["linear"], ["zoom"], 10, 0.55, 14, 0.8, 16, 0.95],
            "icon-padding": 1,
            "symbol-sort-key": ["-", 0, ["get", "importance"]],
            ...(font ? {
                "text-field": ["get", "name"],
                "text-font": font,
                "text-size": ["step", ["zoom"], 0, 12.5, 10.5],
                "text-offset": [0, 1.2],
                "text-anchor": "top",
                "text-max-width": 9,
                "text-optional": true
            } : {})
        },
        paint: {
            "text-color": "#ffffff",
            "text-halo-color": "#0b1520",
            "text-halo-width": 1.6
        }
    }, before);
}
function drawTransitStations(features) {
    lastTransitStationsGeoJSON = { type: "FeatureCollection", features: features };
    const source = map && transitGeoSource(TRANSIT_STATIONS_SOURCE);
    if (source)
        source.setData(lastTransitStationsGeoJSON);
}
async function refreshTransitStations() {
    if (!transitStationsEnabled || !map)
        return;
    const view = transitViewBox(0);
    if (map.getZoom() < TRANSIT_STATIONS_MIN_ZOOM || !view) {
        transitStationsGeneration++;
        transitStationsCover = null;
        drawTransitStations([]);
        setTransitStationsStatus("ZOOM IN", "Zoom in to see the stations of an area.");
        return;
    }
    if (transitStationsCover && transitBoxContains(transitStationsCover, view))
        return;
    if (transitStationsBusy) {
        transitStationsQueued = true;
        return;
    }
    transitStationsBusy = true;
    const generation = ++transitStationsGeneration;
    setTransitStationsStatus("LOADING", "Loading stations...");
    const padded = transitViewBox(TRANSIT_LINES_PAD) || view;
    const grid = TRANSIT_LINES_GRID;
    const box = {
        south: Math.floor(padded.south / grid) * grid,
        west: Math.floor(padded.west / grid) * grid,
        north: Math.ceil(padded.north / grid) * grid,
        east: Math.ceil(padded.east / grid) * grid
    };
    try {
        const stops = await transitFetch("stops", {
            ...transitBoxParams(box),
            grouped: "true",
            modes: TRANSIT_STATION_MODES
        });
        if (generation !== transitStationsGeneration)
            return;
        transitStations.clear();
        const features = [];
        (Array.isArray(stops) ? stops : []).forEach(function (stop) {
            if (!stop || !stop.stopId || !Number.isFinite(stop.lat) || !Number.isFinite(stop.lon))
                return;
            const station = {
                id: stop.stopId,
                name: (stop.name || "").trim() || "Station",
                lat: stop.lat,
                lon: stop.lon,
                modes: Array.isArray(stop.modes) ? stop.modes : []
            };
            transitStations.set(station.id, station);
            const info = transitModeInfo(transitStationMode(station.modes));
            features.push({
                type: "Feature",
                geometry: { type: "Point", coordinates: [station.lon, station.lat] },
                properties: {
                    id: station.id,
                    name: station.name,
                    importance: stop.importance || 0,
                    icon: `${TRANSIT_STATION_ICON_PREFIX}|${info.icon}|${info.color.replace("#", "")}|0`
                }
            });
        });
        // The open station stays known even after panning away from it
        if (transitStationSelected)
            transitStations.set(transitStationSelected.id, transitStationSelected);
        transitStationsCover = box;
        drawTransitStations(features);
        setTransitStationsStatus(features.length.toLocaleString("en-US"), `${features.length} stations in this area (bus stops left out). Click one for its departures.`);
    }
    catch (error) {
        if (generation !== transitStationsGeneration)
            return;
        console.warn("Transit stations failed:", error);
        setTransitStationsStatus("ERROR", "Stations could not be loaded. Move the map to try again.");
    }
    finally {
        transitStationsBusy = false;
        if (transitStationsQueued) {
            transitStationsQueued = false;
            refreshTransitStations();
        }
    }
}
function setTransitStationsEnabled(on) {
    transitStationsEnabled = on;
    transitStationsGeneration++;
    if (on) {
        refreshTransitStations();
    }
    else {
        transitStationsCover = null;
        transitStations.clear();
        drawTransitStations([]);
        closeStationPanel();
        transitHoverPopup.remove();
        setTransitStationsStatus("OFF");
    }
}
// ---------- the board ----------
// Clock time AT THE STATION (not this computer's time zone)
function formatTransitStationTime(ms, tz) {
    const options = { hour: "2-digit", minute: "2-digit", hour12: false };
    try {
        return new Date(ms).toLocaleTimeString("en-GB", { ...options, timeZone: tz });
    }
    catch (error) {
        return new Date(ms).toLocaleTimeString("en-GB", options); // unknown zone name
    }
}
function setStationMessage(message) {
    const empty = document.getElementById("stationEmpty");
    if (empty)
        empty.textContent = message;
}
function buildStationRow(entry, tab, now) {
    const place = entry.place || {};
    const arriving = tab === "arrivals";
    const time = Date.parse((arriving ? place.arrival : place.departure) || "");
    // A train that starts here has no arrival; one that ends here, no departure
    if (!Number.isFinite(time))
        return null;
    const scheduled = Date.parse((arriving ? place.scheduledArrival : place.scheduledDeparture) || "");
    const info = transitModeInfo(entry.mode);
    const cancelled = Boolean(entry.cancelled || entry.tripCancelled || place.cancelled);
    const vehicle = entry.tripId && transitLiveEnabled ? transitVehicles.get(entry.tripId) : undefined;
    const element = document.createElement(vehicle ? "button" : "div");
    element.className = "airport-row schedule station-row" +
        (vehicle ? " live" : "") + (cancelled ? " cancelled" : "");
    element.style.borderLeftColor = transitColor(entry.routeColor, entry.mode);
    const line = (entry.displayName || entry.routeShortName || info.label).trim();
    const other = arriving
        ? ((entry.tripFrom && entry.tripFrom.name) || "?")
        : (entry.headsign || (entry.tripTo && entry.tripTo.name) || "?");
    const main = document.createElement("div");
    main.className = "airport-row-main";
    main.textContent = `${formatTransitStationTime(time, place.tz)}   ${line}  ${arriving ? "from" : "to"}  ${other}`;
    const bits = [];
    if (cancelled) {
        bits.push({ text: "CANCELLED", cls: "bad" });
    }
    else {
        const minutes = Math.round((time - now) / 60000);
        bits.push({ text: minutes <= 0 ? "now" : minutes >= 60
                ? `in ${Math.floor(minutes / 60)} h ${minutes % 60} min`
                : `in ${minutes} min` });
        if (!entry.realTime || !Number.isFinite(scheduled)) {
            bits.push({ text: "scheduled" });
        }
        else {
            const late = Math.round((time - scheduled) / 60000);
            bits.push(late > 0 ? { text: `${late} min late`, cls: "delay" }
                : late < 0 ? { text: `${-late} min early` }
                    : { text: "on time" });
        }
    }
    bits.push({ text: info.label });
    if (place.track) {
        const moved = Boolean(place.scheduledTrack) && place.scheduledTrack !== place.track;
        bits.push({ text: `Platform ${place.track}`, cls: moved ? "bad" : undefined });
    }
    if (vehicle)
        bits.push({ text: "ON MAP", cls: "live-tag" });
    const detail = document.createElement("div");
    detail.className = "airport-row-detail";
    bits.forEach(function (bit, i) {
        if (i)
            detail.appendChild(document.createTextNode("  ·  "));
        const span = document.createElement("span");
        span.textContent = bit.text;
        if (bit.cls)
            span.className = bit.cls;
        detail.appendChild(span);
    });
    element.appendChild(main);
    element.appendChild(detail);
    // A row whose vehicle is on the map jumps to it
    if (vehicle) {
        element.addEventListener("click", function () {
            const position = transitVehiclePosition(vehicle, Date.now());
            if (!position)
                return;
            map.easeTo({ center: [position[0], position[1]], zoom: Math.max(map.getZoom(), 13) });
            showTransitVehicle(vehicle, [position[0], position[1]]);
        });
    }
    return element;
}
async function loadStationBoard() {
    const station = transitStationSelected;
    if (!station)
        return;
    const tab = transitStationTab;
    const generation = ++transitBoardGeneration;
    const list = document.getElementById("stationList");
    if (list && !list.childElementCount)
        setStationMessage("Loading...");
    try {
        const answer = await transitFetch("stoptimes", {
            stopId: station.id,
            n: String(TRANSIT_BOARD_ROWS),
            arriveBy: tab === "arrivals" ? "true" : "false",
            direction: "LATER",
            mode: TRANSIT_BOARD_MODES
        });
        if (generation !== transitBoardGeneration || !list)
            return;
        const now = Date.now();
        const rows = (Array.isArray(answer.stopTimes) ? answer.stopTimes : [])
            .map(entry => ({
            entry: entry,
            time: Date.parse(((tab === "arrivals" ? entry.place?.arrival : entry.place?.departure)) || "")
        }))
            .filter(row => Number.isFinite(row.time))
            .sort((a, b) => a.time - b.time); // soonest first
        list.textContent = "";
        rows.forEach(function (row) {
            const element = buildStationRow(row.entry, tab, now);
            if (element)
                list.appendChild(element);
        });
        setStationMessage(list.childElementCount ? "" : `No ${tab} found for the coming hours.`);
    }
    catch (error) {
        if (generation !== transitBoardGeneration)
            return;
        console.warn("Station board failed:", error);
        if (list)
            list.textContent = "";
        setStationMessage("The board could not be loaded. It will try again shortly.");
    }
}
function setStationTab(tab) {
    transitStationTab = tab;
    const departures = document.getElementById("stationTabDepartures");
    const arrivals = document.getElementById("stationTabArrivals");
    if (departures)
        departures.classList.toggle("active", tab === "departures");
    if (arrivals)
        arrivals.classList.toggle("active", tab === "arrivals");
    const list = document.getElementById("stationList");
    if (list)
        list.textContent = "";
    loadStationBoard();
}
function closeStationPanel() {
    transitStationSelected = null;
    transitBoardGeneration++;
    clearInterval(transitBoardTimer);
    const panel = document.getElementById("stationPanel");
    if (panel)
        panel.classList.remove("visible");
}
function selectTransitStation(id) {
    const station = transitStations.get(id);
    const panel = document.getElementById("stationPanel");
    if (!station || !panel)
        return;
    // The panels share the left side of the map
    if (typeof deselectFlight === "function")
        deselectFlight();
    if (typeof closeAirportPanel === "function")
        closeAirportPanel();
    if (typeof closeWatchlistPanel === "function")
        closeWatchlistPanel();
    if (typeof clearSelection === "function")
        clearSelection();
    transitStationSelected = station;
    const name = document.getElementById("stationName");
    const sub = document.getElementById("stationSub");
    if (name)
        name.textContent = station.name;
    if (sub) {
        const kinds = [];
        station.modes.forEach(function (mode) {
            // Only the kinds the board lists (no buses)
            if (!TRANSIT_BOARD_MODES.split(",").includes(mode))
                return;
            const label = transitModeInfo(mode).label;
            if (!kinds.includes(label))
                kinds.push(label);
        });
        sub.textContent = kinds.join("  ·  ");
    }
    panel.classList.add("visible");
    clearInterval(transitBoardTimer);
    transitBoardTimer = setInterval(function () {
        if (!document.hidden)
            loadStationBoard();
    }, TRANSIT_BOARD_REFRESH_MS);
    setStationTab("departures");
}
function initializeTransitStations() {
    const bind = function (id, action) {
        const element = document.getElementById(id);
        if (element)
            element.addEventListener("click", action);
    };
    bind("closeStationPanel", closeStationPanel);
    bind("stationTabDepartures", () => setStationTab("departures"));
    bind("stationTabArrivals", () => setStationTab("arrivals"));
}
// ==============================================
// T9. MAP INTERACTION
// ==============================================
function transitFeatureAt(point, layerIds, pad) {
    if (!map)
        return null;
    const present = layerIds.filter(id => map.getLayer(id));
    if (!present.length)
        return null;
    const features = map.queryRenderedFeatures([
        [point.x - pad, point.y - pad],
        [point.x + pad, point.y + pad]
    ], { layers: present });
    return features.length ? features[0] : null;
}
function transitVehicleAt(point) {
    return transitLiveEnabled ? transitFeatureAt(point, [TRANSIT_LIVE_LAYER], 6) : null;
}
function transitStationAt(point) {
    return transitStationsEnabled ? transitFeatureAt(point, [TRANSIT_STATIONS_LAYER], 3) : null;
}
// Open a vehicle's popup (it then follows the vehicle, see tickTransitVehicles)
function showTransitVehicle(vehicle, at) {
    transitSelectedId = vehicle.id;
    transitHoverPopup.remove();
    transitVehiclePopup
        .setLngLat(at)
        .setHTML(transitVehicleHtml(vehicle, Date.now()));
    // (adding an open popup again would close it first, and closing
    // clears the selection)
    if (!transitVehiclePopup.isOpen())
        transitVehiclePopup.addTo(map);
    tickTransitVehicles(); // snap the popup onto the vehicle
}
function transitLineAt(point) {
    return transitLinesEnabled
        ? transitFeatureAt(point, [TRANSIT_LINES_RAIL_LAYER, TRANSIT_LINES_BUS_LAYER], 4)
        : null;
}
// Used by script.js so a click on a vehicle, station or line doesn't also drop a pin.
function isTransitAtPoint(point) {
    return Boolean(transitVehicleAt(point)) || Boolean(transitStationAt(point)) ||
        Boolean(transitLineAt(point));
}
function onTransitHover(e) {
    if (!transitLinesEnabled && !transitLiveEnabled && !transitStationsEnabled)
        return;
    // Aircraft and airports have their own tooltip, and go first
    if (typeof isFlightAtPoint === "function" && isFlightAtPoint(e.point)) {
        transitHoverPopup.remove();
        return;
    }
    const vehicle = transitVehicleAt(e.point);
    if (vehicle) {
        map.getCanvas().style.cursor = "pointer";
        const stored = transitVehicles.get(vehicle.properties.id);
        // The clicked vehicle already has its popup open
        if (vehicle.properties.id === transitSelectedId) {
            transitHoverPopup.remove();
            return;
        }
        transitHoverPopup
            .setLngLat(e.lngLat)
            .setText((vehicle.properties.name || "Vehicle") + "  |  " +
            transitModeInfo(stored ? stored.mode : "").label +
            (vehicle.properties.realTime ? "  |  LIVE" : ""))
            .addTo(map);
        return;
    }
    const station = transitStationAt(e.point);
    if (station) {
        map.getCanvas().style.cursor = "pointer";
        transitHoverPopup
            .setLngLat(e.lngLat)
            .setText(station.properties.name)
            .addTo(map);
        return;
    }
    // A stop of the highlighted route
    const stop = transitRouteSelected
        ? transitFeatureAt(e.point, [TRANSIT_ROUTE_STOPS_LAYER], 4)
        : null;
    if (stop && stop.properties.name) {
        transitHoverPopup
            .setLngLat(e.lngLat)
            .setText(stop.properties.name)
            .addTo(map);
        return;
    }
    const line = transitLineAt(e.point);
    if (line) {
        map.getCanvas().style.cursor = "pointer";
        transitHoverPopup
            .setLngLat(e.lngLat)
            .setText(line.properties.name
            ? `${line.properties.mode}  |  ${line.properties.name}`
            : line.properties.mode)
            .addTo(map);
        return;
    }
    transitHoverPopup.remove();
}
function onTransitClick(e) {
    if (typeof isFlightAtPoint === "function" && isFlightAtPoint(e.point))
        return;
    const feature = transitVehicleAt(e.point);
    const vehicle = feature ? transitVehicles.get(feature.properties.id) : undefined;
    if (!vehicle) {
        // A station marker opens its departures board
        const station = transitStationAt(e.point);
        if (station) {
            transitHoverPopup.remove();
            selectTransitStation(station.properties.id);
            return;
        }
        // Not a vehicle: a line? Highlight its whole route. Where several
        // lines share the track, clicking the same spot again takes the next.
        const line = transitLineAt(e.point);
        const refs = line ? transitLineRefsOf(line) : [];
        if (!line || !refs.length)
            return;
        const key = String(line.properties.lines);
        transitRouteClickIndex = key === transitRouteClickKey
            ? (transitRouteClickIndex + 1) % refs.length
            : 0;
        transitRouteClickKey = key;
        transitHoverPopup.remove();
        selectTransitRoute(refs, transitRouteClickIndex, [e.lngLat.lng, e.lngLat.lat]);
        return;
    }
    showTransitVehicle(vehicle, [e.lngLat.lng, e.lngLat.lat]);
}
// ==============================================
// T10. START
// ==============================================
function initializeTransit() {
    transitHoverPopup = new maplibregl.Popup({
        closeButton: false,
        closeOnClick: false,
        offset: 12,
        className: "flight-popup"
    });
    transitVehiclePopup = new maplibregl.Popup({
        closeButton: true,
        closeOnClick: false,
        offset: 12,
        className: "transit-popup"
    });
    transitVehiclePopup.on("close", function () {
        transitSelectedId = null;
    });
    transitRoutePopup = new maplibregl.Popup({
        closeButton: true,
        closeOnClick: false,
        offset: 12,
        maxWidth: "280px",
        className: "transit-popup"
    });
    // Closing the route's popup removes the highlight
    transitRoutePopup.on("close", clearTransitRoute);
    // Changing the base map removes all layers, so rebuild them each time.
    map.on("styleimagemissing", onTransitImageMissing);
    map.on("style.load", setupTransitLayers);
    map.on("styledata", ensureTransitLayers);
    map.on("idle", ensureTransitLayers);
    map.on("moveend", function () {
        clearTimeout(transitMoveTimer);
        transitMoveTimer = setTimeout(function () {
            refreshTransitLines();
            refreshTransitStations();
            refreshTransitVehicles();
        }, TRANSIT_MOVE_DELAY_MS);
    });
    map.on("mousemove", onTransitHover);
    map.on("click", onTransitClick);
    const toggle = document.getElementById("transitToggle");
    if (toggle) {
        toggle.addEventListener("click", () => setTransitEnabled(!transitEnabled));
    }
    initializeTransitStations();
    // Catch up when the tab comes back to the front
    document.addEventListener("visibilitychange", function () {
        if (!document.hidden)
            refreshTransitVehicles();
    });
    // Restore last session's choices once the map is ready
    map.once("load", function () {
        let enabled = false;
        try {
            const saved = localStorage.getItem(TRANSIT_PREF_KEY);
            enabled = saved === null
                ? TRANSIT_OLD_PREF_KEYS.some(key => localStorage.getItem(key) === "1")
                : saved === "1";
        }
        catch (error) {
            // Storage unavailable: stays off
        }
        if (enabled)
            setTransitEnabled(true);
    });
}
// The sidebar switch: lines, stations and live vehicles go on and off together
function setTransitEnabled(on) {
    transitEnabled = on;
    const toggle = document.getElementById("transitToggle");
    if (toggle)
        toggle.classList.toggle("layer-on", on);
    try {
        localStorage.setItem(TRANSIT_PREF_KEY, on ? "1" : "0");
    }
    catch (error) {
        // Storage unavailable: preference just won't persist
    }
    setTransitLinesEnabled(on);
    setTransitStationsEnabled(on);
    setTransitLiveEnabled(on);
    renderTransitStatus();
}
