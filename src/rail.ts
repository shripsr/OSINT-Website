/* ==============================================
   OSINT MAP - RAIL TRACKING (live train positions)
   SOURCE: src/rail.ts  ->  compiled to rail.js by "npm run build"
           (edit the .ts file, never the .js; rail.js must load
           AFTER ships.js and BEFORE script.js)
   DATA: two open feeds, both free, no API key, asked directly by the browser:

   1. Digitraffic Rail (rata.digitraffic.fi), Fintraffic, Finland's traffic
      agency. Licence CC BY 4.0. GPS position of every train running in
      Finland: intercity and commuter trains, and FREIGHT trains (and
      locomotives / shunting). This is the only open source of freight train
      positions there is; elsewhere freight is not public.

   2. Amtraker (amtraker.com): Amtrak, VIA Rail and Brightline passenger
      trains in the USA and Canada. (Passenger only.)

   3. Entur (entur.org), Norway: Vy, SJ Norge, Go-Ahead and Flytoget trains.
      Free, no key, NLOD licence.

   4. Keyed sources, asked through server.py's "/api/rail" so the keys stay
      private: Trafikverket (Sweden, passenger AND freight, TRAFIKVERKET_API_KEY)
      Without a key it is simply not shown.

   One sidebar switch ("Rail Tracking") shows every train running right now:
   a train-shaped marker pointing where it is heading, coloured by kind
   (passenger, commuter, freight, other). Click one for its details.
   ============================================== */


// ==============================================
// S1. CONFIGURATION
// ==============================================

const RAIL_FI_API = "https://rata.digitraffic.fi/api/v1";
const RAIL_AMTRAK_API = "https://api-v3.amtraker.com/v3/trains";

// Digitraffic asks every app to name itself in this header
const RAIL_APP_NAME = "osint-map";

const RAIL_ENTUR_API = "https://api.entur.io/realtime/v2/vehicles/graphql";
const RAIL_NO_POLL_MS = 15000;
const RAIL_RELAY_PATH = "/api/rail";
const RAIL_RELAY_POLL_MS = 20000;

const RAIL_FI_POLL_MS = 10000;          // Finland: GPS fixes arrive every few seconds
const RAIL_AMTRAK_POLL_MS = 45000;      // Amtrak: the feed changes about once a minute
const RAIL_FI_KINDS_POLL_MS = 5 * 60000;    // which train is freight, which is commuter, ...
const RAIL_MAX_AGE_MS = 10 * 60000;     // a train not heard from for this long is not shown
const RAIL_MOVING_KMH = 3;              // slower than this = standing still
const RAIL_HEADING_MIN_M = 25;          // work out the heading from fixes at least this far apart

const RAIL_PREF_KEY = "osint_map_rail_enabled";

const RAIL_SOURCE = "rail-source";
const RAIL_LAYER = "rail-layer";
const RAIL_LABEL_LAYER = "rail-label-layer";
const RAIL_LABEL_MIN_ZOOM = 9;

type RailKind = "passenger" | "commuter" | "freight" | "other";

const RAIL_KINDS: Record<RailKind, { label: string; color: string }> = {
    passenger: { label: "Passenger (intercity)", color: "#4f8cff" },
    commuter: { label: "Commuter", color: "#35c9e8" },
    freight: { label: "Freight", color: "#ffb347" },
    other: { label: "Locomotive / shunting / other", color: "#9aa8b8" }
};

// Digitraffic's train categories
const RAIL_FI_CATEGORIES: Record<string, RailKind> = {
    "Long-distance": "passenger",
    "Commuter": "commuter",
    "Cargo": "freight"
};

const RAIL_COMPASS: Record<string, number> = {
    N: 0, NE: 45, E: 90, SE: 135, S: 180, SW: 225, W: 270, NW: 315
};


// ==============================================
// S2. TYPES
// ==============================================

/** GET /train-locations/latest: one entry per train running in Finland */
interface RailFiLocation {
    trainNumber?: number;
    departureDate?: string;
    location?: { coordinates?: number[] };      // [lon, lat]
    speed?: number;                             // km/h
    timestamp?: string;
}

/** GET /live-trains: only the fields we use */
interface RailFiTrain {
    trainNumber?: number;
    departureDate?: string;
    trainCategory?: string;
    trainType?: string;
    commuterLineID?: string;
    operatorShortCode?: string;
    timeTableRows?: {
        stationShortCode?: string;
        type?: string;
        scheduledTime?: string;
        actualTime?: string;
        differenceInMinutes?: number;
    }[];
}

interface RailAmtrakTrain {
    routeName?: string;
    trainNum?: string;
    lat?: number;
    lon?: number;
    heading?: string;           // "NW"
    velocity?: number;          // mph
    origName?: string;
    destName?: string;
    eventName?: string;         // the station it last / next reported at
    trainState?: string;        // "Active", "Predeparture", "Completed"
    trainTimely?: string;       // e.g. "Delayed 12 min", "" when on time
    provider?: string;
    updatedAt?: string;
}

interface RailRecord {
    id: string;                 // "fi|2026-11-17|265" or "am|1-16"
    source: "fi" | "am" | "no" | "se";
    kind: RailKind;
    number: string;             // train number
    name: string;               // the line / route, "" when none
    lat: number;
    lon: number;
    t: number;                  // when this position was true (ms)
    kmh: number | null;
    heading: number | null;     // degrees
    from: string;
    to: string;
    operator: string;
    note: string;               // e.g. delay
    date: string;               // Digitraffic: departure date
}


// ==============================================
// S3. STATE
// ==============================================

let railEnabled = false;

let railGeneration = 0;         // bumps to drop answers that arrive too late

const railRecords = new Map<string, RailRecord>();

const railFiKinds = new Map<string, { kind: RailKind; type: string; line: string; operator: string }>();
const railStations = new Map<string, string>();         // Digitraffic short code -> name
let railStationsRequested = false;
let railKindsCheckedAt = 0;

let railFiTimer: number | undefined;
let railAmtrakTimer: number | undefined;

let railFiError = "";
let railAmtrakError = "";
let railNoTimer: number | undefined;
let railRelayTimer: number | undefined;
let railNoError = "";
let railNoLoaded = false;
let railRelayLoaded = false;
let railRelayNote = "";         // which keyed sources are missing / failing

let railFiLoaded = false;
let railAmtrakLoaded = false;

let lastRailGeoJSON: GeoFeatureCollection = { type: "FeatureCollection", features: [] };

let railHoverPopup: MapPopup;
let railPopup: MapPopup;
let railSelectedId: string | null = null;
let railPopupHtml = "";


// ==============================================
// S4. SMALL HELPERS
// ==============================================

function setRailStatus(text: string, detail = ""): void {

    const count = document.getElementById("railCount");

    if (count) count.textContent = text;

    const toggle = document.getElementById("railToggle");

    if (toggle) toggle.title = detail;
}

function railBearing(lon1: number, lat1: number, lon2: number, lat2: number): number {

    const rad = Math.PI / 180;

    const y = Math.sin((lon2 - lon1) * rad) * Math.cos(lat2 * rad);
    const x = Math.cos(lat1 * rad) * Math.sin(lat2 * rad) -
        Math.sin(lat1 * rad) * Math.cos(lat2 * rad) * Math.cos((lon2 - lon1) * rad);

    return (Math.atan2(y, x) / rad + 360) % 360;
}

function railDistanceM(lon1: number, lat1: number, lon2: number, lat2: number): number {

    const dy = (lat2 - lat1) * 111320;
    const dx = (lon2 - lon1) * 111320 * Math.cos(lat1 * Math.PI / 180);

    return Math.sqrt(dx * dx + dy * dy);
}

function railIsMoving(train: RailRecord): boolean {
    // (Norway and Sweden often send no speed: then the train counts as moving)
    return train.kmh === null || train.kmh >= RAIL_MOVING_KMH;
}

function railSpeedText(train: RailRecord): string {

    if (train.kmh === null) return "speed unknown";

    return `${Math.round(train.kmh)} km/h`;
}

function railAge(ms: number): string {

    const minutes = Math.floor(ms / 60000);

    return minutes < 1 ? "less than a minute ago" : `${minutes} min ago`;
}

async function railFetch<T>(url: string, fi: boolean): Promise<T> {

    const response = await fetch(url, fi ? { headers: { "Digitraffic-User": RAIL_APP_NAME } } : undefined);

    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    return response.json() as Promise<T>;
}


// ==============================================
// S5. FINLAND (Digitraffic)
// ==============================================

// The positions say nothing about what a train is: that is in the list of
// running trains (bigger, so asked for less often)
async function loadRailFiKinds(): Promise<void> {

    railKindsCheckedAt = Date.now();

    const trains = await railFetch<RailFiTrain[]>(`${RAIL_FI_API}/live-trains?version=0`, true);

    railFiKinds.clear();

    trains.forEach(function(train) {

        const rows = train.timeTableRows || [];

        const last = rows.length ? rows[rows.length - 1] : null;

        railFiKinds.set(`${train.departureDate}|${train.trainNumber}`, {
            kind: RAIL_FI_CATEGORIES[train.trainCategory || ""] || "other",
            type: train.trainType || "",
            line: train.commuterLineID || "",
            operator: (train.operatorShortCode || "").toUpperCase()
        });

        // Where it is going (the station codes become names once those are loaded)
        if (last && last.stationShortCode && rows[0].stationShortCode) {
            railFiRoutes.set(
                `${train.departureDate}|${train.trainNumber}`,
                [rows[0].stationShortCode, last.stationShortCode]
            );
        }
    });
}

const railFiRoutes = new Map<string, [string, string]>();

async function loadRailStations(): Promise<void> {

    if (railStationsRequested) return;

    railStationsRequested = true;

    try {

        const stations = await railFetch<{ stationName?: string; stationShortCode?: string }[]>(
            `${RAIL_FI_API}/metadata/stations`, true
        );

        stations.forEach(function(station) {
            if (station.stationShortCode && station.stationName) {
                railStations.set(station.stationShortCode, station.stationName);
            }
        });

    } catch (error) {
        railStationsRequested = false;     // try again next time
    }
}

function railStationName(code: string): string {
    return railStations.get(code) || code;
}

async function refreshRailFi(): Promise<void> {

    const generation = railGeneration;

    try {

        // The kinds first, so a new train never shows up uncoloured
        if (!railFiKinds.size || Date.now() - railKindsCheckedAt > RAIL_FI_KINDS_POLL_MS) {
            await loadRailFiKinds();
        }

        const locations = await railFetch<RailFiLocation[]>(`${RAIL_FI_API}/train-locations/latest/`, true);

        if (generation !== railGeneration) return;

        const now = Date.now();
        const seen = new Set<string>();

        locations.forEach(function(entry) {

            const coords = entry.location && entry.location.coordinates;

            if (!coords || coords.length < 2 || entry.trainNumber === undefined || !entry.departureDate) return;

            const lon = Number(coords[0]);
            const lat = Number(coords[1]);

            if (!isFinite(lon) || !isFinite(lat)) return;

            const key = `${entry.departureDate}|${entry.trainNumber}`;
            const id = `fi|${key}`;

            seen.add(id);

            const info = railFiKinds.get(key);
            const route = railFiRoutes.get(key);
            const before = railRecords.get(id);

            // Digitraffic gives no heading: use the direction it has moved in
            let heading = before ? before.heading : null;

            if (before && railDistanceM(before.lon, before.lat, lon, lat) >= RAIL_HEADING_MIN_M) {
                heading = railBearing(before.lon, before.lat, lon, lat);
            }

            const kind = info ? info.kind : "other";

            railRecords.set(id, {
                id: id,
                source: "fi",
                kind: kind,
                number: info && info.line && kind === "commuter"
                    ? info.line
                    : `${info ? info.type : ""} ${entry.trainNumber}`.trim(),
                name: "",
                lat: lat,
                lon: lon,
                t: entry.timestamp ? Date.parse(entry.timestamp) || now : now,
                kmh: typeof entry.speed === "number" ? entry.speed : null,
                heading: heading,
                from: route ? railStationName(route[0]) : "",
                to: route ? railStationName(route[1]) : "",
                operator: info ? info.operator : "",
                note: "",
                date: entry.departureDate
            });
        });

        // Finland's feed lists only running trains: the rest have finished
        railRecords.forEach(function(train, id) {
            if (train.source === "fi" && !seen.has(id)) railRecords.delete(id);
        });

        railFiError = "";
        railFiLoaded = true;

    } catch (error) {

        if (generation !== railGeneration) return;

        railFiError = error instanceof Error ? error.message : "failed";
        console.warn("Finnish train positions could not be loaded:", error);
    }

    if (generation !== railGeneration) return;

    tickRail();

    railFiTimer = setTimeout(refreshRailFi, RAIL_FI_POLL_MS);
}


// ==============================================
// S6. USA / CANADA (Amtraker)
// ==============================================

async function refreshRailAmtrak(): Promise<void> {

    const generation = railGeneration;

    try {

        const data = await railFetch<Record<string, RailAmtrakTrain[]>>(RAIL_AMTRAK_API, false);

        if (generation !== railGeneration) return;

        const now = Date.now();
        const seen = new Set<string>();

        Object.keys(data).forEach(function(num) {

            (data[num] || []).forEach(function(train, index) {

                if (train.trainState !== "Active") return;

                if (typeof train.lat !== "number" || typeof train.lon !== "number") return;

                const id = `am|${train.provider || ""}|${num}|${index}`;

                seen.add(id);

                const heading = train.heading && train.heading in RAIL_COMPASS
                    ? RAIL_COMPASS[train.heading]
                    : null;

                const mph = typeof train.velocity === "number" ? train.velocity : null;

                railRecords.set(id, {
                    id: id,
                    source: "am",
                    kind: "passenger",
                    number: train.trainNum || num,
                    name: train.routeName || "",
                    lat: train.lat,
                    lon: train.lon,
                    t: train.updatedAt ? Date.parse(train.updatedAt) || now : now,
                    kmh: mph === null ? null : mph * 1.609344,
                    heading: heading,
                    from: train.origName || "",
                    to: train.destName || "",
                    operator: train.provider || "",
                    note: [
                        train.trainTimely ? train.trainTimely : "",
                        train.eventName ? `at / near ${train.eventName}` : ""
                    ].filter(Boolean).join(" · "),
                    date: ""
                });
            });
        });

        railRecords.forEach(function(train, id) {
            if (train.source === "am" && !seen.has(id)) railRecords.delete(id);
        });

        railAmtrakError = "";
        railAmtrakLoaded = true;

    } catch (error) {

        if (generation !== railGeneration) return;

        railAmtrakError = error instanceof Error ? error.message : "failed";
        console.warn("Amtrak train positions could not be loaded:", error);
    }

    if (generation !== railGeneration) return;

    tickRail();

    railAmtrakTimer = setTimeout(refreshRailAmtrak, RAIL_AMTRAK_POLL_MS);
}


// ==============================================
// S6B. NORWAY (Entur) AND THE KEYED SOURCES (server.py)
// ==============================================

// Drop the trains of one source that were not in its latest answer
function railDropMissing(sources: RailRecord["source"][], seen: Set<string>): void {

    railRecords.forEach(function(train, id) {
        if (sources.includes(train.source) && !seen.has(id)) railRecords.delete(id);
    });
}

async function refreshRailNorway(): Promise<void> {

    const generation = railGeneration;

    try {

        const response = await fetch(RAIL_ENTUR_API, {
            method: "POST",
            headers: { "Content-Type": "application/json", "ET-Client-Name": RAIL_APP_NAME },
            body: JSON.stringify({
                query: "{ vehicles(mode:RAIL){ vehicleId lastUpdated location{latitude longitude} " +
                    "bearing line{lineName publicCode} destinationName delay " +
                    "codespace{codespaceId} } }"
            })
        });

        if (!response.ok) throw new Error(`HTTP ${response.status}`);

        const body = await response.json();

        if (generation !== railGeneration) return;

        const now = Date.now();
        const seen = new Set<string>();

        const rows: any[] = (body && body.data && body.data.vehicles) || [];

        rows.forEach(function(row) {

            const lat = row.location ? Number(row.location.latitude) : NaN;
            const lon = row.location ? Number(row.location.longitude) : NaN;

            if (!isFinite(lat) || !isFinite(lon) || !row.vehicleId) return;

            const id = `no|${row.vehicleId}`;

            seen.add(id);

            const code: string = (row.line && row.line.publicCode) || "";

            const delayMin = typeof row.delay === "number" ? Math.round(row.delay / 60) : 0;

            railRecords.set(id, {
                id: id,
                source: "no",
                // R11, L1 ...: the local trains round Oslo and the other cities
                kind: /^[RL]\d/.test(code) ? "commuter" : "passenger",
                number: code || String(row.vehicleId),
                name: (row.line && row.line.lineName) || "",
                lat: lat,
                lon: lon,
                t: row.lastUpdated ? Date.parse(row.lastUpdated) || now : now,
                kmh: null,
                heading: typeof row.bearing === "number" ? row.bearing : null,
                from: "",
                to: row.destinationName || "",
                operator: (row.codespace && row.codespace.codespaceId) || "",
                note: delayMin > 0 ? `Delayed ${delayMin} min` : "",
                date: ""
            });
        });

        railDropMissing(["no"], seen);

        railNoError = "";
        railNoLoaded = true;

    } catch (error) {

        if (generation !== railGeneration) return;

        railNoError = error instanceof Error ? error.message : "failed";
        console.warn("Norwegian train positions could not be loaded:", error);
    }

    if (generation !== railGeneration) return;

    tickRail();

    railNoTimer = setTimeout(refreshRailNorway, RAIL_NO_POLL_MS);
}

interface RailRelayRow {
    id: string;
    src: string;
    kind: string;
    number: string;
    name: string;
    lat: number;
    lon: number;
    t: number;
    kmh: number | null;
    heading: number | null;
    from: string;
    to: string;
    operator: string;
    note: string;
}

// Sweden, through server.py (which holds their keys)
async function refreshRailRelay(): Promise<void> {

    const generation = railGeneration;

    let again = true;

    try {

        const response = await fetch(RAIL_RELAY_PATH);

        // Not served by server.py: nothing to ask, and no reason to ask again
        if (response.status === 404 || response.status === 501) {
            again = false;
            throw new Error("not served by server.py");
        }

        if (!response.ok) throw new Error(`HTTP ${response.status}`);

        const body = await response.json() as {
            trains?: RailRelayRow[];
            sources?: Record<string, string>;
        };

        if (generation !== railGeneration) return;

        const seen = new Set<string>();

        (body.trains || []).forEach(function(row) {

            seen.add(row.id);

            railRecords.set(row.id, {
                id: row.id,
                source: "se",
                kind: row.kind in RAIL_KINDS ? row.kind as RailKind : "other",
                number: String(row.number),
                name: row.name || "",
                lat: row.lat,
                lon: row.lon,
                t: row.t,
                kmh: typeof row.kmh === "number" ? row.kmh : null,
                heading: typeof row.heading === "number" ? row.heading : null,
                from: row.from || "",
                to: row.to || "",
                operator: row.operator || "",
                note: row.note || "",
                date: ""
            });
        });

        railDropMissing(["se"], seen);

        const names: Record<string, string> = {
            se: "Sweden (TRAFIKVERKET_API_KEY)"
        };

        const notes: string[] = [];

        const sources = body.sources || {};

        Object.keys(sources).forEach(function(key) {

            if (sources[key] === "nokey") notes.push(`${names[key] || key}: no key in .env`);
            else if (sources[key] !== "ok") notes.push(`${names[key] || key}: ${sources[key]}`);
        });

        railRelayNote = notes.join("\n");
        railRelayLoaded = (body.trains || []).length > 0;

    } catch (error) {

        if (generation !== railGeneration) return;

        railRelayNote = "";
        console.info("Keyed rail sources are not available:", error);
    }

    if (generation !== railGeneration) return;

    tickRail();

    if (again) railRelayTimer = setTimeout(refreshRailRelay, RAIL_RELAY_POLL_MS);
}


// ==============================================
// S7. MAP LAYERS
// ==============================================

function railGeoSource(): GeoJSONMapSource | undefined {
    return map.getSource(RAIL_SOURCE) as GeoJSONMapSource | undefined;
}

// Runs on every style load, because changing the base map wipes all layers.
function setupRailLayers(): void {

    // Trains go underneath the aircraft and airport pins
    const layers = map.getStyle().layers || [];

    const firstFlightLayer = layers.find(layer => layer.id.startsWith("flights-"));

    const before = firstFlightLayer ? firstFlightLayer.id : undefined;

    if (!map.getSource(RAIL_SOURCE)) {
        map.addSource(RAIL_SOURCE, { type: "geojson", data: lastRailGeoJSON });
    }

    if (!map.getLayer(RAIL_LAYER)) {
        map.addLayer({
            id: RAIL_LAYER,
            type: "symbol",
            source: RAIL_SOURCE,
            layout: {
                "icon-image": ["get", "icon"],
                "icon-size": ["interpolate", ["linear"], ["zoom"], 3, 0.45, 8, 0.65, 12, 0.9, 15, 1.1],
                "icon-rotate": ["get", "rot"],
                "icon-rotation-alignment": "map",
                "icon-allow-overlap": true,
                "icon-ignore-placement": true,
                "symbol-sort-key": ["get", "rank"]
            },
            paint: {
                "icon-opacity": ["case", ["get", "moving"], 1, 0.65]
            }
        }, before);
    }

    // Train numbers / lines next to the markers (needs a font the base map
    // already uses; the satellite style has none: no labels there)
    if (!map.getLayer(RAIL_LABEL_LAYER) && map.getStyle().glyphs) {

        let font: string[] | null = null;

        for (const layer of layers) {

            const candidate = layer.type === "symbol" && layer.layout
                ? layer.layout["text-font"]
                : null;

            if (Array.isArray(candidate) && candidate.every(item => typeof item === "string")) {
                font = candidate as string[];
                break;
            }
        }

        if (font) {
            map.addLayer({
                id: RAIL_LABEL_LAYER,
                type: "symbol",
                source: RAIL_SOURCE,
                minzoom: RAIL_LABEL_MIN_ZOOM,
                filter: ["!=", ["get", "label"], ""],
                layout: {
                    "text-field": ["get", "label"],
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

// Safety net, same as the other layers: rebuild anything a style change removed.
function ensureRailLayers(): void {

    if (!map || !map.isStyleLoaded()) return;

    if (map.getSource(RAIL_SOURCE) && map.getLayer(RAIL_LAYER)) return;

    try {
        setupRailLayers();
    } catch (error) {
        console.warn("Rail layers could not be rebuilt yet:", error);
    }
}

function drawRail(features: GeoFeature[]): void {

    lastRailGeoJSON = { type: "FeatureCollection", features: features };

    const source = map && railGeoSource();

    if (source) source.setData(lastRailGeoJSON);
}


// ==============================================
// S7B. TRAIN ICONS
//
// Drawn nose-up on a 48 x 48 grid (shown 24 px) and turned by the layer.
// A long rounded car with a windscreen when we know the heading, a round
// dot when we don't. Made on demand, like the ship icons.
// ==============================================

const RAIL_ICON_GRID = 48;
const RAIL_ICON_SCALE = 2;
const RAIL_ICON_PREFIX = "rail-icon";

type RailIconShape = "train" | "dot";

const railIconImages = new Map<string, ImageData>();

function railIconId(shape: RailIconShape, color: string): string {
    return `${RAIL_ICON_PREFIX}|${shape}|${color.replace("#", "")}`;
}

function createRailIcon(shape: RailIconShape, color: string): ImageData {

    const size = RAIL_ICON_GRID * RAIL_ICON_SCALE;

    const canvas = document.createElement("canvas");

    canvas.width = size;
    canvas.height = size;

    const ctx = canvas.getContext("2d");

    if (!ctx) throw new Error("Canvas 2D drawing is not available");

    ctx.scale(RAIL_ICON_SCALE, RAIL_ICON_SCALE);

    ctx.lineJoin = "round";

    const rim = "#0b1520";

    ctx.beginPath();

    if (shape === "train") {

        // A long car with a rounded nose at the top
        ctx.moveTo(24, 3);
        ctx.bezierCurveTo(30, 3, 32, 8, 32, 13);
        ctx.lineTo(32, 42);
        ctx.quadraticCurveTo(32, 45, 29, 45);
        ctx.lineTo(19, 45);
        ctx.quadraticCurveTo(16, 45, 16, 42);
        ctx.lineTo(16, 13);
        ctx.bezierCurveTo(16, 8, 18, 3, 24, 3);
        ctx.closePath();

    } else {

        ctx.arc(24, 24, 9, 0, Math.PI * 2);
    }

    ctx.strokeStyle = rim;
    ctx.lineWidth = 5;
    ctx.stroke();

    ctx.fillStyle = color;
    ctx.fill();

    if (shape === "train") {

        // Windscreen at the front, and a roof stripe
        ctx.fillStyle = rim;
        ctx.globalAlpha = 0.6;
        ctx.fillRect(19, 9, 10, 6);
        ctx.fillRect(23, 20, 2, 20);
    }

    return ctx.getImageData(0, 0, size, size);
}

function onRailImageMissing(e: { id: string }): void {

    const [prefix, shape, hex] = String(e.id).split("|");

    if (prefix !== RAIL_ICON_PREFIX) return;

    if (shape !== "train" && shape !== "dot") return;

    if (!/^[0-9a-f]{6}$/.test(hex || "")) return;

    let image = railIconImages.get(e.id);

    if (!image) {
        image = createRailIcon(shape, "#" + hex);
        railIconImages.set(e.id, image);
    }

    if (!map.hasImage(e.id)) {
        map.addImage(e.id, image, { pixelRatio: 2 * RAIL_ICON_SCALE });
    }
}


// ==============================================
// S8. DRAWING THE TRAINS
// ==============================================

// Runs after every update and every map move
function tickRail(): void {

    if (!railEnabled || !map) return;

    const now = Date.now();

    const features: GeoFeature[] = [];

    const counts: Record<RailKind, number> = { passenger: 0, commuter: 0, freight: 0, other: 0 };

    let selectedAt: [number, number] | null = null;

    railRecords.forEach(function(train, id) {

        // (Amtrak positions can be old when a train is in a dead zone: only drop very old ones)
        if (now - train.t > RAIL_MAX_AGE_MS * 3) {
            railRecords.delete(id);
            return;
        }

        counts[train.kind]++;

        if (id === railSelectedId) selectedAt = [train.lon, train.lat];

        const moving = railIsMoving(train);

        features.push({
            type: "Feature",
            geometry: { type: "Point", coordinates: [train.lon, train.lat] },
            properties: {
                id: id,
                label: train.kind === "freight" || !train.name ? train.number : train.name,
                icon: railIconId(
                    train.heading === null ? "dot" : "train",
                    RAIL_KINDS[train.kind].color
                ),
                rot: train.heading || 0,
                moving: moving,
                rank: moving ? 1 : 0
            }
        });
    });

    drawRail(features);

    setRailHud(counts);

    const total = railRecords.size;

    setRailStatus(
        railFiLoaded || railAmtrakLoaded || railNoLoaded || railRelayLoaded ? total.toLocaleString("en-US") : "LOADING",
        `${total.toLocaleString("en-US")} trains running: ${counts.passenger} passenger, ` +
        `${counts.commuter} commuter, ${counts.freight} freight, ${counts.other} other.\n` +
        "Coverage: Finland (Digitraffic), Norway (Entur), USA / Canada (Amtrak, VIA Rail, Brightline), " +
        "plus Sweden when its key is in .env.\n" +
        "Freight positions: Finland, and Sweden (with a key)." +
        (railFiError ? `\nFinland feed: ${railFiError}` : "") +
        (railNoError ? `\nNorway feed: ${railNoError}` : "") +
        (railAmtrakError ? `\nAmtrak feed: ${railAmtrakError}` : "") +
        (railRelayNote ? "\n" + railRelayNote : "")
    );

    // The open popup rides along with its train
    const selected = railSelectedId !== null ? railRecords.get(railSelectedId) : undefined;

    if (selected && selectedAt) {

        const html = railPopupContent(selected, now);

        railPopup.setLngLat(selectedAt);

        if (html !== railPopupHtml) {
            railPopupHtml = html;
            railPopup.setHTML(html);
        }

    } else if (railSelectedId !== null) {

        railPopup.remove();         // its "close" handler clears the selection
    }
}

function setRailEnabled(on: boolean): void {

    railEnabled = on;

    railGeneration++;       // drop whatever is still loading

    const toggle = document.getElementById("railToggle");

    if (toggle) toggle.classList.toggle("layer-on", on);

    const hud = document.getElementById("railHud");

    if (hud) hud.classList.toggle("visible", on);

    try {
        localStorage.setItem(RAIL_PREF_KEY, on ? "1" : "0");
    } catch (error) {
        // Storage unavailable: preference just won't persist
    }

    clearTimeout(railFiTimer);
    clearTimeout(railAmtrakTimer);
    clearTimeout(railNoTimer);
    clearTimeout(railRelayTimer);

    if (on) {

        railFiError = "";
        railAmtrakError = "";
        railNoError = "";
        railRelayNote = "";

        setRailStatus("LOADING");

        loadRailStations();         // (names for the "from / to" lines, arrives in the background)

        refreshRailFi();
        refreshRailAmtrak();
        refreshRailNorway();
        refreshRailRelay();

    } else {

        railRecords.clear();

        railFiLoaded = false;
        railAmtrakLoaded = false;
        railNoLoaded = false;
        railRelayLoaded = false;
        railKindsCheckedAt = 0;

        drawRail([]);

        railHoverPopup.remove();
        railPopup.remove();

        setRailStatus("OFF");
    }
}


// ==============================================
// S8B. LEGEND
// ==============================================

function buildRailLegend(): void {

    const legend = document.getElementById("railLegend");

    if (!legend || legend.childElementCount) return;

    (Object.keys(RAIL_KINDS) as RailKind[]).forEach(function(key) {

        const item = document.createElement("span");

        const dot = document.createElement("i");

        dot.style.background = RAIL_KINDS[key].color;

        item.appendChild(dot);
        item.appendChild(document.createTextNode(RAIL_KINDS[key].label));

        legend.appendChild(item);
    });

    const note = document.createElement("div");

    note.className = "ship-legend-note";
    note.textContent = "Marker points where the train is heading. Round dot: heading not " +
        "known yet. Faded: standing still. Freight positions are only published in Finland and Sweden.";

    legend.appendChild(note);
}

function setRailHud(counts: Record<RailKind, number>): void {

    const count = document.getElementById("railHudCount");

    if (count) count.textContent = railRecords.size.toLocaleString("en-US");

    const status = document.getElementById("railHudStatus");

    if (status) {
        status.textContent =
            `${counts.passenger + counts.commuter} passenger · ${counts.freight} freight · ` +
            "Finland · Norway · USA/Canada" + (railRelayLoaded ? " · keyed" : "");
    }
}


// ==============================================
// S9. HOVER + CLICK
// ==============================================

function railFeatureAt(point: MapPoint): MapFeature | null {

    if (!railEnabled || !map || !map.getLayer(RAIL_LAYER)) return null;

    const pad = 5;

    const features = map.queryRenderedFeatures(
        [
            [point.x - pad, point.y - pad],
            [point.x + pad, point.y + pad]
        ],
        { layers: [RAIL_LAYER] }
    );

    return features.length ? features[0] : null;
}

// Used by script.js and transit.js so a click on a train doesn't also drop a
// pin or pick the transit vehicle underneath.
function isRailAtPoint(point: MapPoint): boolean {
    return Boolean(railFeatureAt(point));
}

function railTitle(train: RailRecord): string {

    if (train.source === "no") {
        return train.name ? `${train.number} ${train.name}` : `Train ${train.number}`;
    }

    if (train.source !== "fi") {
        return train.name ? `${train.name} ${train.number}` : `Train ${train.number}`;
    }

    return train.number;
}

const RAIL_CREDITS: Record<RailRecord["source"], string> = {
    fi: "Data: Fintraffic / digitraffic.fi, CC BY 4.0",
    am: "Data: Amtraker (amtraker.com)",
    no: "Data: Entur (entur.org), NLOD",
    se: "Data: Trafikverket Open API"
};

function railPopupContent(train: RailRecord, now: number): string {

    const lines: string[] = [];

    lines.push(
        `<strong>${escapeHTML(railTitle(train))}</strong>` +
        ` <span class="transit-popup-mode">${escapeHTML(RAIL_KINDS[train.kind].label.toUpperCase())}</span>`
    );

    if (train.from && train.to) {
        lines.push(`${escapeHTML(train.from)} &rarr; ${escapeHTML(train.to)}`);
    }

    lines.push(
        [
            railSpeedText(train),
            railIsMoving(train) && train.heading !== null ? `heading ${Math.round(train.heading)}&deg;` : "",
            railIsMoving(train) ? "" : "standing still"
        ].filter(Boolean).join(" · ")
    );

    if (train.operator) lines.push(`Operator: ${escapeHTML(train.operator)}`);

    if (train.note) lines.push(escapeHTML(train.note));

    lines.push(`<small>Position reported ${railAge(now - train.t)}</small>`);

    lines.push(
        `<small>${RAIL_CREDITS[train.source]}</small>`
    );

    return lines.join("<br>");
}

function showRail(train: RailRecord): void {

    railSelectedId = train.id;

    railHoverPopup.remove();

    railPopupHtml = railPopupContent(train, Date.now());

    railPopup.setLngLat([train.lon, train.lat]).setHTML(railPopupHtml);

    // (adding an open popup again would close it first, and closing clears the selection)
    if (!railPopup.isOpen()) railPopup.addTo(map);

    tickRail();
}

function onRailHover(e: MapMouseEvent): void {

    if (!railEnabled) return;

    // Aircraft, airports and ships have their own tooltips, and go first
    const feature = isFlightAtPoint(e.point) ||
        (typeof isShipAtPoint === "function" && isShipAtPoint(e.point))
        ? null
        : railFeatureAt(e.point);

    const train = feature ? railRecords.get(String(feature.properties.id)) : undefined;

    if (!train || train.id === railSelectedId) {
        railHoverPopup.remove();
        return;
    }

    map.getCanvas().style.cursor = "pointer";

    railHoverPopup
        .setLngLat(e.lngLat)
        .setText(
            railTitle(train) + "  |  " +
            RAIL_KINDS[train.kind].label + "  |  " +
            (railIsMoving(train) ? railSpeedText(train) : "standing still")
        )
        .addTo(map);
}

function onRailClick(e: MapMouseEvent): void {

    if (isFlightAtPoint(e.point)) return;

    if (typeof isShipAtPoint === "function" && isShipAtPoint(e.point)) return;

    const feature = railFeatureAt(e.point);

    const train = feature ? railRecords.get(String(feature.properties.id)) : undefined;

    if (train) showRail(train);
}


// ==============================================
// S10. START
// ==============================================

function initializeRail(): void {

    railHoverPopup = new maplibregl.Popup({
        closeButton: false,
        closeOnClick: false,
        offset: 12,
        className: "flight-popup"
    });

    railPopup = new maplibregl.Popup({
        closeButton: true,
        closeOnClick: false,
        offset: 12,
        maxWidth: "280px",
        className: "transit-popup"
    });

    railPopup.on("close", function() {
        railSelectedId = null;
        railPopupHtml = "";
    });

    // Changing the base map removes all layers, so rebuild them each time.
    map.on("styleimagemissing", onRailImageMissing);

    map.on("style.load", setupRailLayers);
    map.on("styledata", ensureRailLayers);
    map.on("idle", ensureRailLayers);

    map.on("mousemove", onRailHover);
    map.on("click", onRailClick);

    const toggle = document.getElementById("railToggle");

    if (toggle) {
        toggle.addEventListener("click", () => setRailEnabled(!railEnabled));
    }

    buildRailLegend();

    // Restore last session's choice once the map is ready
    map.once("load", function() {

        let enabled = false;

        try {
            enabled = localStorage.getItem(RAIL_PREF_KEY) === "1";
        } catch (error) {
            // Storage unavailable: stays off
        }

        if (enabled) setRailEnabled(true);
    });
}
