/* ==============================================
   OSINT MAP - LIVE FLIGHT TRACKING
   FILE: flights.js  (must load BEFORE script.js)
   DATA: community ADS-B network via adsb.lol
         (free, no API key, queried by map area)
   ============================================== */


// ==============================================
// F1. CONFIGURATION
// ==============================================

// Public ADS-B feeds, tried in order. All return the ADS-B Exchange v2
// JSON format. adsb.fi and airplanes.live allow 1 request per second with
// no key. adsb.lol is last because its public API has a small daily cap.
const FLIGHT_FEEDS = [
    {
        name: "adsb.fi",
        url: (p) => `https://opendata.adsb.fi/api/v2/lat/${p.lat}/lon/${p.lon}/dist/${p.radius}`
    },
    {
        name: "airplanes.live",
        url: (p) => `https://api.airplanes.live/v2/point/${p.lat}/${p.lon}/${p.radius}`
    },
    {
        name: "adsb.lol",
        url: (p) => `https://api.adsb.lol/v2/point/${p.lat}/${p.lon}/${p.radius}`
    }
];

// Optional: if you run server.js, requests go through it first.
const FLIGHT_PROXY_PATH = "/api/flights";

// Aircraft photos come from Planespotters.net (free public API).
// Their terms: credit the photographer next to the photo and link the
// photo to its Planespotters page. Both are done in renderFlightPhoto().
const FLIGHT_PHOTO_PROXY_PATH = "/api/photo";
const FLIGHT_PHOTO_API = "https://api.planespotters.net/pub/photos";
const FLIGHT_PHOTO_HOSTS = ["planespotters.net", "plnspttrs.net"];

const FLIGHT_REQUEST_GAP_MS = 1100;     // keeps us under 1 request/second

const FLIGHT_MAX_RADIUS_NM = 250;   // API limit per request
const FLIGHT_TILE_NM = 353;         // square side fully covered by a 250 nm circle
const FLIGHT_MAX_TILES = 6;         // zoomed out further than this = "zoom in" notice

const FLIGHT_BASE_REFRESH_MS = 10000;   // time between feed updates
const FLIGHT_PER_TILE_MS = 1100;        // extra wait per additional request
const FLIGHT_TICK_MS = 1000;            // smooth movement update rate
const FLIGHT_HISTORY_MAX = 120;         // trail points kept per aircraft

const FLIGHT_PREF_KEY = "osint_map_flights_enabled";

const FLIGHT_SOURCE = "flights-source";
const FLIGHT_TRAIL_SOURCE = "flights-trail-source";
const FLIGHT_LAYER = "flights-layer";
const FLIGHT_SELECTED_LAYER = "flights-selected-layer";
const FLIGHT_TRAIL_LAYER = "flights-trail-layer";

// Icon colour by category / altitude band
const FLIGHT_COLORS = {
    ground: "#78899c",
    b1: "#f6c744",      // < 5,000 ft
    b2: "#9ad94b",      // < 15,000 ft
    b3: "#00d68f",      // < 25,000 ft
    b4: "#00bcd4",      // < 35,000 ft
    b5: "#8c7bff",      // 35,000 ft +
    military: "#ff9800",
    emergency: "#e05252"
};

const FLIGHT_LEGEND = [
    ["ground", "GND"],
    ["b1", "<5K"],
    ["b2", "<15K"],
    ["b3", "<25K"],
    ["b4", "<35K"],
    ["b5", "35K+"],
    ["military", "MIL"],
    ["emergency", "EMRG"]
];


// ==============================================
// F2. STATE
// ==============================================

let flightsEnabled = false;
let flightGeneration = 0;           // bumps on enable/disable to drop stale responses

let flightStore = new Map();        // hex -> aircraft record
const flightHistory = new Map();    // hex -> { points, lastT0, seen }

let lastFlightGeoJSON = { type: "FeatureCollection", features: [] };

let flightPollTimer = null;
let flightTickTimer = null;
let flightMoveTimer = null;

let flightFetchBusy = false;
let flightRefetchQueued = false;
let flightFailures = 0;
let flightBackoffUntil = 0;
let lastFlightPlanSize = 1;

let flightProxyOk = null;               // null = unknown, true/false once tested
const flightFeedCooldown = new Map();   // feed name -> retry-after timestamp
let flightNextSlot = 0;
let flightSourceName = "";

const flightPhotoCache = new Map();     // hex -> photo object, or null if none
let flightPhotoRequestId = 0;

let selectedFlightHex = null;
let followFlight = false;
let flightHoverPopup = null;


// ==============================================
// F3. SMALL HELPERS
// ==============================================

const flightEl = (id) => document.getElementById(id);

function setFlightText(id, value) {
    const el = flightEl(id);
    if (el) el.textContent = value;
}

function wrapLon(lon) {
    return ((lon + 180) % 360 + 360) % 360 - 180;
}

function clampNumber(value, min, max) {
    return Math.max(min, Math.min(max, value));
}

function formatFlightAltitude(rec) {
    if (rec.onGround) return "GROUND";
    if (rec.alt == null) return "--";
    const ft = Math.round(rec.alt);
    const m = Math.round(rec.alt * 0.3048);
    return `${ft.toLocaleString("en-US")} ft (${m.toLocaleString("en-US")} m)`;
}

function formatFlightSpeed(gs) {
    if (gs == null) return "--";
    return `${Math.round(gs)} kt (${Math.round(gs * 1.852)} km/h)`;
}

function formatFlightVRate(rate) {
    if (rate == null) return "--";
    const arrow = rate > 64 ? "\u25B2" : rate < -64 ? "\u25BC" : "\u25A0";
    return `${arrow} ${Math.abs(Math.round(rate)).toLocaleString("en-US")} ft/min`;
}

function formatFlightTime(date) {
    return date.toISOString().slice(11, 19) + "Z";
}


// ==============================================
// F4. AIRCRAFT DATA
// ==============================================

function parseAircraft(a, receivedAt) {

    if (!a || !a.hex) return null;
    if (typeof a.lat !== "number" || typeof a.lon !== "number") return null;

    const onGround = a.alt_baro === "ground";

    let alt = null;
    if (onGround) alt = 0;
    else if (typeof a.alt_baro === "number") alt = a.alt_baro;
    else if (typeof a.alt_geom === "number") alt = a.alt_geom;

    const seenPos = typeof a.seen_pos === "number" ? a.seen_pos : 0;

    const squawk = a.squawk ? String(a.squawk) : "";

    const emergency =
        (a.emergency && a.emergency !== "none") ||
        squawk === "7500" || squawk === "7600" || squawk === "7700";

    let track = null;
    if (typeof a.track === "number") track = a.track;
    else if (typeof a.true_heading === "number") track = a.true_heading;
    else if (typeof a.mag_heading === "number") track = a.mag_heading;

    return {
        hex: String(a.hex).toLowerCase(),
        callsign: a.flight ? String(a.flight).trim() : "",
        reg: a.r ? String(a.r) : "",
        type: a.t ? String(a.t) : "",
        typeDesc: a.desc ? String(a.desc) : "",
        operator: a.ownOp ? String(a.ownOp) : "",

        lat: a.lat,
        lon: a.lon,
        t0: receivedAt - seenPos * 1000,   // when this position was true

        alt: alt,
        onGround: onGround,
        gs: typeof a.gs === "number" ? a.gs : null,
        track: track,
        vrate: typeof a.baro_rate === "number" ? a.baro_rate
             : typeof a.geom_rate === "number" ? a.geom_rate : null,

        squawk: squawk,
        military: ((a.dbFlags || 0) & 1) === 1,
        emergency: Boolean(emergency)
    };
}

function flightColorKey(rec) {
    if (rec.emergency) return "emergency";
    if (rec.military) return "military";
    if (rec.onGround) return "ground";

    const alt = rec.alt || 0;
    if (alt < 5000) return "b1";
    if (alt < 15000) return "b2";
    if (alt < 25000) return "b3";
    if (alt < 35000) return "b4";
    return "b5";
}

// Dead reckoning: move the aircraft along its heading between feed updates.
function predictPosition(rec, now) {

    if (rec.onGround || !rec.gs || rec.track == null) {
        return { lat: rec.lat, lon: rec.lon };
    }

    const seconds = clampNumber((now - rec.t0) / 1000, 0, 60);
    const meters = rec.gs * 0.514444 * seconds;
    const rad = rec.track * Math.PI / 180;

    const cosLat = Math.max(0.01, Math.cos(rec.lat * Math.PI / 180));

    return {
        lat: clampNumber(rec.lat + (meters * Math.cos(rad)) / 111320, -90, 90),
        lon: wrapLon(rec.lon + (meters * Math.sin(rad)) / (111320 * cosLat))
    };
}

function buildFlightFeature(rec, now) {

    const pos = predictPosition(rec, now);

    return {
        type: "Feature",
        geometry: { type: "Point", coordinates: [pos.lon, pos.lat] },
        properties: {
            hex: rec.hex,
            callsign: rec.callsign,
            key: flightColorKey(rec),
            track: rec.track == null ? 0 : rec.track,
            sort: rec.emergency ? 1000000 : (rec.alt || 0)
        }
    };
}

function recordFlightHistory(records) {

    const now = Date.now();

    records.forEach(function(rec) {

        let h = flightHistory.get(rec.hex);

        if (!h) {
            h = { points: [], lastT0: 0, seen: now };
            flightHistory.set(rec.hex, h);
        }

        h.seen = now;

        if (rec.t0 > h.lastT0) {

            const last = h.points[h.points.length - 1];

            if (!last || last[0] !== rec.lon || last[1] !== rec.lat) {
                h.points.push([rec.lon, rec.lat]);

                if (h.points.length > FLIGHT_HISTORY_MAX) {
                    h.points.shift();
                }
            }

            h.lastT0 = rec.t0;
        }

    });

    flightHistory.forEach(function(h, hex) {
        if (now - h.seen > 300000 && hex !== selectedFlightHex) {
            flightHistory.delete(hex);
        }
    });
}


// ==============================================
// F5. MAP ICONS AND LAYERS
// ==============================================

function createPlaneIcon(color) {

    const size = 48;

    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;

    const ctx = canvas.getContext("2d");

    // Top-down airliner silhouette, nose pointing up (north)
    ctx.beginPath();
    ctx.moveTo(24, 3);
    ctx.lineTo(27, 14);
    ctx.lineTo(27, 20);
    ctx.lineTo(44, 30);
    ctx.lineTo(44, 34);
    ctx.lineTo(27, 29.5);
    ctx.lineTo(26.5, 38);
    ctx.lineTo(32, 42.5);
    ctx.lineTo(32, 45);
    ctx.lineTo(24, 43);
    ctx.lineTo(16, 45);
    ctx.lineTo(16, 42.5);
    ctx.lineTo(21.5, 38);
    ctx.lineTo(21, 29.5);
    ctx.lineTo(4, 34);
    ctx.lineTo(4, 30);
    ctx.lineTo(21, 20);
    ctx.lineTo(21, 14);
    ctx.closePath();

    ctx.lineJoin = "round";
    ctx.lineWidth = 2.5;
    ctx.strokeStyle = "#0c1118";
    ctx.stroke();

    ctx.fillStyle = color;
    ctx.fill();

    return ctx.getImageData(0, 0, size, size);
}

// Runs on every style load, because changing the base map wipes all layers.
function setupFlightLayers() {

    Object.keys(FLIGHT_COLORS).forEach(function(key) {

        const id = `flight-icon-${key}`;

        if (!map.hasImage(id)) {
            map.addImage(id, createPlaneIcon(FLIGHT_COLORS[key]), {
                pixelRatio: 2
            });
        }

    });

    if (!map.getSource(FLIGHT_SOURCE)) {
        map.addSource(FLIGHT_SOURCE, {
            type: "geojson",
            data: lastFlightGeoJSON
        });
    }

    if (!map.getSource(FLIGHT_TRAIL_SOURCE)) {
        map.addSource(FLIGHT_TRAIL_SOURCE, {
            type: "geojson",
            data: { type: "FeatureCollection", features: [] }
        });
    }

    if (!map.getLayer(FLIGHT_TRAIL_LAYER)) {
        map.addLayer({
            id: FLIGHT_TRAIL_LAYER,
            type: "line",
            source: FLIGHT_TRAIL_SOURCE,
            layout: {
                "line-cap": "round",
                "line-join": "round"
            },
            paint: {
                "line-color": "#00bcd4",
                "line-width": 2.5,
                "line-opacity": 0.85
            }
        });
    }

    if (!map.getLayer(FLIGHT_SELECTED_LAYER)) {
        map.addLayer({
            id: FLIGHT_SELECTED_LAYER,
            type: "circle",
            source: FLIGHT_SOURCE,
            filter: ["==", ["get", "hex"], selectedFlightHex || ""],
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

    if (!map.getLayer(FLIGHT_LAYER)) {
        map.addLayer({
            id: FLIGHT_LAYER,
            type: "symbol",
            source: FLIGHT_SOURCE,
            layout: {
                "icon-image": ["concat", "flight-icon-", ["get", "key"]],
                "icon-rotate": ["get", "track"],
                "icon-rotation-alignment": "map",
                "icon-allow-overlap": true,
                "icon-ignore-placement": true,
                "icon-size": [
                    "interpolate", ["linear"], ["zoom"],
                    2, 0.4,
                    6, 0.6,
                    10, 0.85,
                    14, 1.1
                ],
                "symbol-sort-key": ["get", "sort"]
            }
        });
    }

}


// Safety net: a style change can remove our layers without firing
// "style.load" (MapLibre may update styles in place). If anything is
// missing, rebuild it. Cheap enough to call often.
function ensureFlightLayers() {

    if (!map || !map.isStyleLoaded()) return;

    if (
        map.getSource(FLIGHT_SOURCE) &&
        map.getSource(FLIGHT_TRAIL_SOURCE) &&
        map.getLayer(FLIGHT_TRAIL_LAYER) &&
        map.getLayer(FLIGHT_SELECTED_LAYER) &&
        map.getLayer(FLIGHT_LAYER)
    ) return;

    try {
        setupFlightLayers();
    } catch (error) {
        console.warn("Flight layers could not be rebuilt yet:", error.message);
    }

}


// ==============================================
// F6. FEED REQUESTS
// ==============================================

// Work out which area(s) of the feed cover the current view.
// Returns a list of circles, or null if the view is too wide.
function computeFlightPlan() {

    const bounds = map.getBounds();

    const south = Math.max(-85, bounds.getSouth());
    const north = Math.min(85, bounds.getNorth());

    let west = bounds.getWest();
    let east = bounds.getEast();

    if (east < west) east += 360;

    if (east - west >= 360 || north <= south) return null;

    const midLat = (north + south) / 2;

    const heightNm = (north - south) * 60;
    const widthNm = (east - west) * 60 *
        Math.cos(midLat * Math.PI / 180);

    const halfDiagonal = Math.hypot(widthNm, heightNm) / 2;


    // One request covers the whole view

    if (halfDiagonal <= FLIGHT_MAX_RADIUS_NM - 5) {

        return [{
            lat: midLat,
            lon: wrapLon((west + east) / 2),
            radius: Math.max(10, Math.ceil(halfDiagonal) + 5)
        }];

    }


    // Several requests in a grid

    const stepLat = FLIGHT_TILE_NM / 60;

    const plan = [];

    for (let lat = south + stepLat / 2; lat - stepLat / 2 < north; lat += stepLat) {

        const cosLat = Math.max(
            0.1,
            Math.cos(Math.min(Math.abs(lat), 85) * Math.PI / 180)
        );

        const stepLon = stepLat / cosLat;

        for (let lon = west + stepLon / 2; lon - stepLon / 2 < east; lon += stepLon) {

            plan.push({
                lat: clampNumber(lat, -89.9, 89.9),
                lon: wrapLon(lon),
                radius: FLIGHT_MAX_RADIUS_NM
            });

            if (plan.length > FLIGHT_MAX_TILES) return null;

        }

    }

    return plan.length ? plan : null;
}


// Space requests out so we never exceed 1 request per second.
function waitForFlightSlot() {

    const now = Date.now();

    const at = Math.max(now, flightNextSlot);

    flightNextSlot = at + FLIGHT_REQUEST_GAP_MS;

    return new Promise(resolve => setTimeout(resolve, at - now));

}


async function fetchFlightTile(q) {

    const p = {
        lat: q.lat.toFixed(3),
        lon: q.lon.toFixed(3),
        radius: q.radius
    };

    const attempts = [];

    // Local proxy (server.js), only when the page is served over http(s)
    if (flightProxyOk !== false && /^https?:$/.test(location.protocol)) {
        attempts.push({
            name: "local proxy",
            url: `${FLIGHT_PROXY_PATH}?lat=${p.lat}&lon=${p.lon}&dist=${p.radius}`,
            proxy: true
        });
    }

    const now = Date.now();

    let feeds = FLIGHT_FEEDS.filter(
        f => (flightFeedCooldown.get(f.name) || 0) <= now
    );

    if (!feeds.length) feeds = FLIGHT_FEEDS;

    feeds.forEach(f => attempts.push({ name: f.name, url: f.url(p) }));


    const messages = [];
    let rateLimited = false;

    for (const attempt of attempts) {

        if (!attempt.proxy) await waitForFlightSlot();

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 15000);

        try {

            const response = await fetch(attempt.url, {
                signal: controller.signal
            });

            if (!response.ok) {
                const error = new Error(`${attempt.name}: HTTP ${response.status}`);
                error.status = response.status;
                throw error;
            }

            const json = await response.json();

            const list = Array.isArray(json.ac) ? json.ac
                       : Array.isArray(json.aircraft) ? json.aircraft
                       : [];

            if (attempt.proxy) flightProxyOk = true;

            flightSourceName = attempt.proxy ? "" : attempt.name;

            return { aircraft: list, receivedAt: Date.now() };

        }

        catch (error) {

            const blocked = error instanceof TypeError;

            const message =
                error.name === "AbortError" ? `${attempt.name}: timeout`
                : blocked ? `${attempt.name}: blocked or unreachable (CORS/network)`
                : error.message;

            console.warn("Flight feed failed:", message);

            messages.push(message);

            if (error.status === 429) rateLimited = true;

            if (attempt.proxy) {
                // 502 = proxy works but upstream failed. Anything else = no proxy here.
                if (error.status !== 502) flightProxyOk = false;
            }

            else {
                flightFeedCooldown.set(attempt.name, Date.now() + 60000);
            }

        }

        finally {

            clearTimeout(timer);

        }

    }

    const failure = new Error(messages.join(" | ") || "No feed available");

    failure.rateLimited = rateLimited;

    throw failure;
}


async function refreshFlights() {

    if (!flightsEnabled || !map) return;

    if (document.hidden) {
        scheduleFlightPoll();
        return;
    }

    if (flightFetchBusy) {
        flightRefetchQueued = true;
        return;
    }

    if (Date.now() < flightBackoffUntil) {
        scheduleFlightPoll();
        return;
    }


    const plan = computeFlightPlan();

    if (!plan) {

        flightStore = new Map();

        showFlightNotice("ZOOM IN TO LOAD LIVE FLIGHTS");

        setFlightStatus("VIEW TOO WIDE");

        tickFlights();

        scheduleFlightPoll();

        return;

    }

    showFlightNotice("");

    lastFlightPlanSize = plan.length;


    const generation = flightGeneration;

    flightFetchBusy = true;

    setFlightStatus("UPDATING...");


    const results = await Promise.allSettled(plan.map(fetchFlightTile));

    // Disabled (or toggled) while the request was running
    if (generation !== flightGeneration || !flightsEnabled) return;

    flightFetchBusy = false;


    const okResults = results.filter(r => r.status === "fulfilled");

    const rateLimited = results.some(
        r => r.status === "rejected" && r.reason && r.reason.rateLimited
    );


    if (!okResults.length) {

        flightFailures++;

        const wait = Math.min(120000, 15000 * Math.pow(2, flightFailures - 1));

        flightBackoffUntil = Date.now() +
            (rateLimited ? Math.max(wait, 30000) : wait);

        const firstError = results.find(r => r.status === "rejected");

        const reason = firstError && firstError.reason
            ? String(firstError.reason.message || "").slice(0, 110)
            : "";

        const needsProxy = flightProxyOk === false && reason.includes("blocked");

        setFlightStatus(
            rateLimited
                ? "RATE LIMITED - RETRYING"
                : needsProxy
                    ? "BROWSER BLOCKS DIRECT FEED ACCESS - RUN server.js (or server.py) AND OPEN http://localhost:8080"
                    : `FEED OFFLINE - ${reason}`
        );

    }

    else {

        flightFailures = 0;

        if (rateLimited) flightBackoffUntil = Date.now() + 30000;


        const next = new Map();

        okResults.forEach(function(result) {

            result.value.aircraft.forEach(function(raw) {

                const rec = parseAircraft(raw, result.value.receivedAt);

                if (!rec) return;

                const existing = next.get(rec.hex);

                if (!existing || rec.t0 > existing.t0) {
                    next.set(rec.hex, rec);
                }

            });

        });


        // If some requests failed, keep recent aircraft from the old data
        // so they don't flicker off the map.

        if (okResults.length < plan.length) {

            const now = Date.now();

            flightStore.forEach(function(rec, hex) {
                if (!next.has(hex) && now - rec.t0 < 45000) {
                    next.set(hex, rec);
                }
            });

        }


        flightStore = next;

        recordFlightHistory(next);

        setFlightStatus(
            okResults.length < plan.length
                ? `PARTIAL ${okResults.length}/${plan.length} - ${formatFlightTime(new Date())}${flightSourceName ? " | " + flightSourceName : ""}`
                : `UPDATED ${formatFlightTime(new Date())}${flightSourceName ? " | " + flightSourceName : ""}`
        );

        tickFlights();

    }


    scheduleFlightPoll();

    if (flightRefetchQueued) {
        flightRefetchQueued = false;
        scheduleFlightRefresh(300);
    }

}


function scheduleFlightPoll() {

    clearTimeout(flightPollTimer);

    if (!flightsEnabled) return;

    const normal =
        FLIGHT_BASE_REFRESH_MS + lastFlightPlanSize * FLIGHT_PER_TILE_MS;

    const delay = Math.max(normal, flightBackoffUntil - Date.now());

    flightPollTimer = setTimeout(refreshFlights, delay);

}


// Debounced refresh after the user pans or zooms
function scheduleFlightRefresh(delay = 800) {

    if (!flightsEnabled) return;

    clearTimeout(flightMoveTimer);

    flightMoveTimer = setTimeout(refreshFlights, delay);

}


// ==============================================
// F7. SMOOTH MOVEMENT TICK
// ==============================================

function tickFlights() {

    if (!map) return;

    if (document.hidden && flightsEnabled) return;

    const now = Date.now();

    const features = [];

    flightStore.forEach(rec => features.push(buildFlightFeature(rec, now)));

    lastFlightGeoJSON = { type: "FeatureCollection", features: features };

    ensureFlightLayers();

    const source = map.getSource(FLIGHT_SOURCE);

    if (source) source.setData(lastFlightGeoJSON);


    updateFlightHud();

    updateFlightTrail(now);

    updateFlightPanel(now);


    if (followFlight && selectedFlightHex) {

        const rec = flightStore.get(selectedFlightHex);

        if (rec) {

            const pos = predictPosition(rec, now);

            map.easeTo({
                center: [pos.lon, pos.lat],
                duration: FLIGHT_TICK_MS,
                easing: t => t,
                essential: true
            });

        }

    }

}


function updateFlightTrail(now) {

    const source = map.getSource(FLIGHT_TRAIL_SOURCE);

    if (!source) return;

    let features = [];

    const history = selectedFlightHex && flightHistory.get(selectedFlightHex);

    if (history && history.points.length) {

        const coords = history.points.slice();

        const rec = flightStore.get(selectedFlightHex);

        if (rec) {
            const pos = predictPosition(rec, now);
            coords.push([pos.lon, pos.lat]);
        }

        if (coords.length >= 2) {
            features = [{
                type: "Feature",
                properties: {},
                geometry: { type: "LineString", coordinates: coords }
            }];
        }

    }

    source.setData({ type: "FeatureCollection", features: features });

}


// ==============================================
// F8. HUD, NOTICE AND SIDEBAR STATUS
// ==============================================

function setFlightStatus(text) {
    setFlightText("flightHudStatus", text);
}

function showFlightNotice(message) {

    const el = flightEl("flightNotice");

    if (!el) return;

    el.textContent = message;

    el.classList.toggle("visible", Boolean(message));

}

function updateFlightHud() {

    const count = flightStore.size;

    setFlightText("flightHudCount", count.toLocaleString("en-US"));

    setFlightText(
        "flightCount",
        flightsEnabled ? count.toLocaleString("en-US") : "OFF"
    );

}

function buildFlightLegend() {

    const legend = flightEl("flightLegend");

    if (!legend || legend.childElementCount) return;

    FLIGHT_LEGEND.forEach(function(entry) {

        const item = document.createElement("span");

        const dot = document.createElement("i");
        dot.style.background = FLIGHT_COLORS[entry[0]];

        item.appendChild(dot);
        item.appendChild(document.createTextNode(entry[1]));

        legend.appendChild(item);

    });

}


// ==============================================
// F9. FLIGHT DETAILS PANEL
// ==============================================

function addFlightBadge(container, text, className) {

    const badge = document.createElement("span");

    badge.className = "flight-badge " + className;

    badge.textContent = text;

    container.appendChild(badge);

}

function updateFlightPanel(now) {

    const panel = flightEl("flightPanel");

    if (!panel || !selectedFlightHex) return;

    const rec = flightStore.get(selectedFlightHex);

    const badges = flightEl("fBadges");

    badges.textContent = "";


    // Aircraft has left coverage: keep the last values and say so

    if (!rec) {

        addFlightBadge(badges, "NO RECENT SIGNAL", "lost");

        return;

    }


    const pos = predictPosition(rec, now);


    setFlightText("fCallsign", rec.callsign || rec.reg || rec.hex.toUpperCase());

    setFlightText(
        "fSubtitle",
        rec.typeDesc || rec.type || "Unknown aircraft type"
    );

    setFlightText("fAlt", formatFlightAltitude(rec));
    setFlightText("fSpeed", formatFlightSpeed(rec.gs));
    setFlightText(
        "fHeading",
        rec.track == null ? "--" : `${Math.round(rec.track)}\u00B0`
    );
    setFlightText("fVRate", formatFlightVRate(rec.vrate));
    setFlightText("fReg", rec.reg || "--");
    setFlightText("fType", rec.type || "--");
    setFlightText("fSquawk", rec.squawk || "--");
    setFlightText("fHex", rec.hex.toUpperCase());
    setFlightText("fOperator", rec.operator || "--");
    setFlightText(
        "fPosition",
        `${pos.lat.toFixed(5)}, ${pos.lon.toFixed(5)}`
    );


    if (rec.emergency) addFlightBadge(badges, "EMERGENCY", "emergency");
    if (rec.military) addFlightBadge(badges, "MILITARY", "military");
    if (rec.onGround) addFlightBadge(badges, "ON GROUND", "ground");


    // External link (only for real 6-digit ICAO hex codes)

    const link = flightEl("flightExternalLink");

    if (link) {

        if (/^[0-9a-f]{6}$/.test(rec.hex)) {
            link.href =
                "https://globe.adsbexchange.com/?icao=" + rec.hex;
            link.style.display = "block";
        } else {
            link.style.display = "none";
        }

    }

}

// ==============================================
// F9b. AIRCRAFT PHOTOS (Planespotters.net)
// ==============================================

function isTrustedPhotoUrl(value) {

    try {

        const url = new URL(value);

        return url.protocol === "https:" && FLIGHT_PHOTO_HOSTS.some(
            host => url.hostname === host || url.hostname.endsWith("." + host)
        );

    }

    catch (error) {

        return false;

    }

}

// Returns an array of photos ([] = none exist) or null if the lookup failed.
async function fetchFlightPhotoData(kind, value) {

    const attempts = [];

    if (flightProxyOk !== false && /^https?:$/.test(location.protocol)) {
        attempts.push(
            `${FLIGHT_PHOTO_PROXY_PATH}?${kind}=${encodeURIComponent(value)}`
        );
    }

    attempts.push(`${FLIGHT_PHOTO_API}/${kind}/${encodeURIComponent(value)}`);

    for (const url of attempts) {

        try {

            const response = await fetch(url);

            if (!response.ok) continue;

            const json = await response.json();

            return Array.isArray(json.photos) ? json.photos : [];

        }

        catch (error) {

            // try the next source

        }

    }

    return null;
}

function setFlightPhotoState(state, message) {

    const link = flightEl("flightPhotoLink");
    const empty = flightEl("flightPhotoEmpty");
    const credit = flightEl("flightPhotoCredit");

    if (!link || !empty || !credit) return;

    link.style.display = state === "photo" ? "block" : "none";

    empty.style.display = state === "photo" ? "none" : "flex";
    empty.textContent = message || "";

    credit.style.display = state === "photo" ? "block" : "none";

}

function renderFlightPhoto(photo, rec) {

    const image = flightEl("flightPhoto");
    const link = flightEl("flightPhotoLink");
    const credit = flightEl("flightPhotoCredit");

    if (!image || !link || !credit) return;

    if (photo === undefined) {
        setFlightPhotoState("empty", "PHOTO LOOKUP UNAVAILABLE");
        return;
    }

    const thumb = photo && (photo.thumbnail_large || photo.thumbnail);

    if (
        !photo || !thumb ||
        !isTrustedPhotoUrl(thumb.src) ||
        !isTrustedPhotoUrl(photo.link)
    ) {
        setFlightPhotoState("empty", "\u2708\uFE0E  NO PHOTO AVAILABLE");
        return;
    }

    image.src = thumb.src;

    image.alt = "Photo of " + ((rec && (rec.reg || rec.callsign)) || "aircraft");

    // Required by the Planespotters terms: link to the photo page...
    link.href = photo.link;

    // ...and credit the photographer in text next to the image.
    credit.textContent = "";

    credit.appendChild(document.createTextNode(
        "\u00A9 " + (photo.photographer || "Unknown photographer") + " / "
    ));

    const site = document.createElement("a");
    site.href = photo.link;
    site.target = "_blank";
    site.rel = "noopener noreferrer";
    site.textContent = "Planespotters.net";

    credit.appendChild(site);

    setFlightPhotoState("photo");

}

async function loadFlightPhoto(rec) {

    const requestId = ++flightPhotoRequestId;

    let photo = flightPhotoCache.get(rec.hex);

    if (photo === undefined) {

        setFlightPhotoState("empty", "LOADING PHOTO...");

        let photos = null;

        if (/^[0-9a-f]{6}$/.test(rec.hex)) {
            photos = await fetchFlightPhotoData("hex", rec.hex);
        }

        if ((!photos || !photos.length) && /^[A-Za-z0-9-]{2,10}$/.test(rec.reg)) {
            const byReg = await fetchFlightPhotoData("reg", rec.reg);
            if (byReg) photos = byReg;
        }

        if (photos === null) {
            photo = undefined;                      // failed: don't cache
        } else {
            photo = photos[0] || null;
            flightPhotoCache.set(rec.hex, photo);
        }

    }

    // The user may have clicked another aircraft while we waited
    if (requestId !== flightPhotoRequestId || selectedFlightHex !== rec.hex) return;

    renderFlightPhoto(photo, rec);

}


function selectFlight(hex) {

    selectedFlightHex = hex;

    if (map.getLayer(FLIGHT_SELECTED_LAYER)) {
        map.setFilter(FLIGHT_SELECTED_LAYER, ["==", ["get", "hex"], hex]);
    }

    flightEl("flightPanel").classList.add("visible");

    const selected = flightStore.get(hex);

    if (selected) loadFlightPhoto(selected);

    updateFlightPanel(Date.now());

    updateFlightTrail(Date.now());

}

function deselectFlight() {

    selectedFlightHex = null;

    flightPhotoRequestId++;     // cancels any photo lookup still in flight

    setFollowFlight(false);

    if (map && map.getLayer(FLIGHT_SELECTED_LAYER)) {
        map.setFilter(FLIGHT_SELECTED_LAYER, ["==", ["get", "hex"], ""]);
    }

    const panel = flightEl("flightPanel");

    if (panel) panel.classList.remove("visible");

    if (map && map.getSource(FLIGHT_TRAIL_SOURCE)) {
        map.getSource(FLIGHT_TRAIL_SOURCE).setData({
            type: "FeatureCollection",
            features: []
        });
    }

}

function setFollowFlight(on) {

    followFlight = on;

    const button = flightEl("followFlight");

    if (!button) return;

    button.classList.toggle("toggled", on);

    button.textContent = on ? "FOLLOWING AIRCRAFT" : "FOLLOW AIRCRAFT";

}

function pinSelectedFlight() {

    const rec = flightStore.get(selectedFlightHex);

    if (!rec) return;

    const pos = predictPosition(rec, Date.now());

    const description = [
        `${rec.typeDesc || rec.type || "Unknown type"}` +
            (rec.reg ? ` | REG ${rec.reg}` : ""),
        `ALT ${formatFlightAltitude(rec)}`,
        `SPD ${formatFlightSpeed(rec.gs)}`,
        `HDG ${rec.track == null ? "--" : Math.round(rec.track) + "\u00B0"}`,
        `ICAO ${rec.hex.toUpperCase()}` +
            (rec.squawk ? ` | SQUAWK ${rec.squawk}` : ""),
        `Observed ${new Date().toISOString()}`
    ].join("\n");

    inspectLocation(
        pos.lat,
        pos.lon,
        `Flight ${rec.callsign || rec.reg || rec.hex.toUpperCase()}`,
        description
    );

}


// ==============================================
// F10. MAP INTERACTION
// ==============================================

function flightFeatureAt(point) {

    if (!map || !map.getLayer(FLIGHT_LAYER)) return null;

    const pad = 10;

    const features = map.queryRenderedFeatures(
        [
            [point.x - pad, point.y - pad],
            [point.x + pad, point.y + pad]
        ],
        { layers: [FLIGHT_LAYER] }
    );

    return features.length ? features[0] : null;

}

// Used by script.js so a click on an aircraft doesn't also drop a pin.
function isFlightAtPoint(point) {
    return Boolean(flightFeatureAt(point));
}

function onFlightHover(e) {

    const feature = flightsEnabled ? flightFeatureAt(e.point) : null;

    if (!feature) {

        map.getCanvas().style.cursor = "";

        flightHoverPopup.remove();

        return;

    }

    const rec = flightStore.get(feature.properties.hex);

    map.getCanvas().style.cursor = "pointer";

    const label = rec
        ? [
            rec.callsign || rec.reg || rec.hex.toUpperCase(),
            rec.type || "?",
            rec.onGround ? "GND" : rec.alt == null ? "--" : `${Math.round(rec.alt).toLocaleString("en-US")} ft`
          ].join("  |  ")
        : feature.properties.callsign || feature.properties.hex;

    flightHoverPopup
        .setLngLat(feature.geometry.coordinates)
        .setText(label)
        .addTo(map);

}

function onFlightClick(e) {

    if (!flightsEnabled) return;

    const feature = flightFeatureAt(e.point);

    if (feature) selectFlight(feature.properties.hex);

}

// Search box: jump to a loaded aircraft by callsign, registration or ICAO hex.
// Returns true if it handled the search.
function searchFlights(query) {

    if (!flightsEnabled) return false;

    const q = String(query).trim().toLowerCase();

    if (q.length < 3) return false;

    for (const rec of flightStore.values()) {

        if (
            rec.callsign.toLowerCase() === q ||
            rec.reg.toLowerCase() === q ||
            rec.hex === q
        ) {

            const pos = predictPosition(rec, Date.now());

            map.flyTo({
                center: [pos.lon, pos.lat],
                zoom: Math.max(map.getZoom(), 8),
                essential: true
            });

            selectFlight(rec.hex);

            return true;

        }

    }

    return false;

}


// ==============================================
// F11. ENABLE / DISABLE
// ==============================================

function setFlightsEnabled(on) {

    flightsEnabled = on;

    flightGeneration++;

    flightEl("flightToggle").classList.toggle("layer-on", on);

    flightEl("flightHud").classList.toggle("visible", on);

    try {
        localStorage.setItem(FLIGHT_PREF_KEY, on ? "1" : "0");
    } catch (error) {
        // Storage unavailable: preference just won't persist
    }

    clearTimeout(flightPollTimer);
    clearTimeout(flightMoveTimer);
    clearInterval(flightTickTimer);

    flightFetchBusy = false;
    flightRefetchQueued = false;


    if (on) {

        flightFailures = 0;
        flightBackoffUntil = 0;

        buildFlightLegend();

        flightTickTimer = setInterval(tickFlights, FLIGHT_TICK_MS);

        refreshFlights();

    }

    else {

        flightStore = new Map();
        flightHistory.clear();

        deselectFlight();

        showFlightNotice("");

        tickFlights();

        setFlightText("flightCount", "OFF");

    }

}


function initializeFlights() {

    flightHoverPopup = new maplibregl.Popup({
        closeButton: false,
        closeOnClick: false,
        offset: 16,
        className: "flight-popup"
    });


    // Changing the base map removes all layers, so rebuild them each time.
    map.on("style.load", setupFlightLayers);
    map.on("styledata", ensureFlightLayers);
    map.on("idle", ensureFlightLayers);

    map.on("moveend", function() {
        // While following, the camera moves every second; the regular
        // poll already queries whatever area is on screen.
        if (!followFlight) scheduleFlightRefresh();
    });

    // Dragging the map manually stops "follow"
    map.on("dragstart", () => setFollowFlight(false));

    map.on("mousemove", onFlightHover);
    map.on("click", onFlightClick);


    flightEl("flightToggle").addEventListener("click", function() {
        setFlightsEnabled(!flightsEnabled);
    });

    flightEl("closeFlightPanel").addEventListener("click", deselectFlight);

    flightEl("followFlight").addEventListener("click", function() {

        const rec = flightStore.get(selectedFlightHex);

        if (!rec) return;

        const turningOn = !followFlight;

        setFollowFlight(turningOn);

        if (turningOn) {

            const pos = predictPosition(rec, Date.now());

            map.flyTo({
                center: [pos.lon, pos.lat],
                zoom: Math.max(map.getZoom(), 8),
                essential: true
            });

        }

    });

    flightEl("pinFlight").addEventListener("click", pinSelectedFlight);


    // Pause the feed while the tab is in the background
    document.addEventListener("visibilitychange", function() {
        if (!document.hidden && flightsEnabled) refreshFlights();
    });


    // Restore last session's choice once the map is ready
    map.once("load", function() {

        let enabled = false;

        try {
            enabled = localStorage.getItem(FLIGHT_PREF_KEY) === "1";
        } catch (error) {
            enabled = false;
        }

        if (enabled) setFlightsEnabled(true);

    });

}
