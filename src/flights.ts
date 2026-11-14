/* ==============================================
   OSINT MAP - LIVE FLIGHT TRACKING
   SOURCE: src/flights.ts  ->  compiled to flights.js by "npm run build"
           (edit the .ts file, never the .js; flights.js must load
           BEFORE script.js)
   DATA: community ADS-B network via adsb.lol
         (free, no API key, queried by map area)
   ============================================== */


// ==============================================
// F1. CONFIGURATION
// ==============================================

// Public ADS-B feeds, tried in order. All return the ADS-B Exchange v2
// JSON format. adsb.fi and airplanes.live allow 1 request per second with
// no key. adsb.lol is last because its public API has a small daily cap.
const FLIGHT_FEEDS: FlightFeed[] = [
    {
        name: "adsb.fi",
        url: (p) => `https://opendata.adsb.fi/api/v2/lat/${p.lat}/lon/${p.lon}/dist/${p.radius}`,
        find: (kind, value) =>
            `https://opendata.adsb.fi/api/v2/${kind === "reg" ? "registration" : kind}/${encodeURIComponent(value)}`
    },
    {
        name: "airplanes.live",
        url: (p) => `https://api.airplanes.live/v2/point/${p.lat}/${p.lon}/${p.radius}`
    },
    {
        name: "adsb.lol",
        url: (p) => `https://api.adsb.lol/v2/point/${p.lat}/${p.lon}/${p.radius}`,
        find: (kind, value) => `https://api.adsb.lol/v2/${kind}/${encodeURIComponent(value)}`
    }
];

// Search box and watchlist: find one aircraft anywhere in the world by
// ICAO hex, callsign or registration (relay first, then the feeds above).
const FLIGHT_LOCATE_PATH = "/api/locate";
const FLIGHT_LOCATE_MAX_AGE_MS = 300000;    // ignore positions older than this
const FLIGHT_LOCATE_KEEP_MS = 45000;        // keep a located aircraft until its area loads

// Watchlist (saved in this browser)
const FLIGHT_WATCH_KEY = "osint_map_flight_watchlist";
const FLIGHT_WATCH_MAX = 25;
const FLIGHT_WATCH_CHECK_MS = 10000;        // at most one worldwide check per this
const FLIGHT_WATCH_STALE_MS = 180000;       // re-check an off-map entry after this
const FLIGHT_WATCH_ALERT_GAP_MS = 600000;   // don't announce the same entry more often
const FLIGHT_WATCH_COLOR = "#00d68f";

// Optional: if you run server.js, requests go through it first.
const FLIGHT_PROXY_PATH = "/api/flights";

// Aircraft photos come from Planespotters.net (free public API).
// Their terms: credit the photographer next to the photo and link the
// photo to its Planespotters page. Both are done in renderFlightPhoto().
const FLIGHT_PHOTO_PROXY_PATH = "/api/photo";
const FLIGHT_PHOTO_API = "https://api.planespotters.net/pub/photos";
const FLIGHT_PHOTO_HOSTS = ["planespotters.net", "plnspttrs.net"];

// World view (zoomed far out): OpenSky Network, through the local relay.
// One request returns every aircraft on Earth, but OpenSky meters usage in
// credits, so the relay decides how often it is really allowed to ask.
const FLIGHT_WORLD_PATH = "/api/opensky";

// Registration / type / owner lookup for one aircraft at a time (adsbdb, via relay)
const FLIGHT_AIRCRAFT_PATH = "/api/aircraft";

// Origin / destination (adsbdb) and the full flight path so far (OpenSky), via the relay
const FLIGHT_ROUTE_PATH = "/api/route";
const FLIGHT_TRACK_PATH = "/api/track";

// Airport list (OurAirports) for the airport pins, via the relay
const FLIGHT_AIRPORTS_PATH = "/api/airports";

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
const FLIGHT_WATCH_LAYER = "flights-watch-layer";
const FLIGHT_TRAIL_LAYER = "flights-trail-layer";
const FLIGHT_TRAIL_CASING_LAYER = "flights-trail-casing-layer";
const FLIGHT_ROUTE_SOURCE = "flights-route-source";
const FLIGHT_ROUTE_LAYER = "flights-route-layer";
const FLIGHT_ROUTE_POINTS_LAYER = "flights-route-points-layer";
const AIRPORT_SOURCE = "flights-airports-source";
const AIRPORT_LARGE_LAYER = "flights-airports-large-layer";
const AIRPORT_MEDIUM_LAYER = "flights-airports-medium-layer";

// Aircraft icons use one colour each: yellow normally, or orange (military),
// red (emergency) and grey (on the ground). Altitude is shown along the
// flight PATH of the selected aircraft instead, like Flightradar24.
const FLIGHT_COLORS: Record<FlightColorKey, string> = {
    normal: "#e3cf1e",
    ground: "#78899c",
    military: "#ff9800",
    emergency: "#e05252"
};

// Altitude (ft) -> colour of the flight path
const FLIGHT_ALT_STOPS: [feet: number, color: string][] = [
    [0, "#f2c94c"],
    [5000, "#9ad94b"],
    [15000, "#00d68f"],
    [25000, "#00bcd4"],
    [35000, "#5b8cff"],
    [45000, "#b36bff"]
];

const FLIGHT_ALT_UNKNOWN = "#8aa4bd";

const FLIGHT_LEGEND: [key: FlightColorKey, label: string][] = [
    ["ground", "GND"],
    ["military", "MIL"],
    ["emergency", "EMRG"]
];


// ==============================================
// F2. STATE
// ==============================================

let flightsEnabled = false;
let flightGeneration = 0;           // bumps on enable/disable to drop stale responses

let flightStore = new Map<string, FlightRecord>();        // hex -> aircraft record
const flightHistory = new Map<string, FlightHistoryEntry>();    // hex -> { points, lastT0, seen }

let lastFlightGeoJSON: GeoFeatureCollection = { type: "FeatureCollection", features: [] };

let flightPollTimer: number | undefined;
let flightTickTimer: number | undefined;
let flightMoveTimer: number | undefined;

let flightFetchBusy = false;
let flightRefetchQueued = false;
let flightFailures = 0;
let flightBackoffUntil = 0;
let lastFlightPlanSize = 1;

let flightProxyOk: boolean | null = null;               // null = unknown, true/false once tested
const flightFeedCooldown = new Map<string, number>();   // feed name -> retry-after timestamp
let flightNextSlot = 0;
let flightSourceName = "";

let flightWorldMode = false;            // true while showing the OpenSky world snapshot
let flightWorldFetchedAt = 0;
let flightWorldIntervalMs = 90000;
let flightWorldTick = 0;

const flightInfoCache = new Map<string, AircraftInfo | null>();      // hex -> details, or null if unknown to adsbdb
const flightInfoPending = new Set<string>();

const flightPhotoCache = new Map<string, FlightPhoto | null>();     // hex -> photo object, or null if none
let flightPhotoRequestId = 0;

const flightRouteCache = new Map<string, FlightRoute | null>();     // callsign -> route, or null if unknown
const flightRoutePending = new Set<string>();
const flightTrackCache = new Map<string, FlightTrackEntry>();     // hex -> { state, points, lastT, fetchedAt, ttl }
const flightTrackPending = new Set<string>();
const flightShapeCache = new Map<string, FlightShape>();     // "TYPE|hint" -> shape name
let flightTrailCache: FlightTrailCache = { key: "", features: [], last: null };
let lastFlightRouteGeoJSON: GeoFeatureCollection = { type: "FeatureCollection", features: [] };

const flightAirportIndex = new Map<string, Airport>();   // ICAO code -> airport
let flightAirportsState: "idle" | "loading" | "ok" | "error" = "idle";       // idle | loading | ok | error
let flightAirportsRetryAt = 0;
let lastAirportGeoJSON: GeoFeatureCollection = { type: "FeatureCollection", features: [] };
let selectedAirport: Airport | null = null;
let airportTab: ScheduleKind = "arrivals";
let airportTick = 0;

let flightLocated: { rec: FlightRecord; at: number } | null = null;   // found by a worldwide lookup

let watchlist: WatchlistEntry[] = [];
const watchlistStatus = new Map<string, WatchlistStatus>();   // entry key -> last worldwide check
let watchlistLive = new Map<string, FlightRecord>();          // entry key -> aircraft on the map now
let watchlistHexes = new Set<string>();                       // hex of every watched aircraft on the map
let watchlistScannedStore: Map<string, FlightRecord> | null = null;
let watchlistDirty = true;
let watchlistCheckBusy = false;

let selectedFlightHex: string | null = null;
let followFlight = false;
let flightHoverPopup: MapPopup;


// ==============================================
// F3. SMALL HELPERS
// ==============================================

const flightEl = (id: string) => document.getElementById(id);

// Same, for elements the page cannot work without (throws on a wrong id)
function flightRequiredEl<T extends HTMLElement = HTMLElement>(id: string): T {

    const element = document.getElementById(id);

    if (!element) throw new Error(`Missing element #${id}`);

    return element as T;
}

// Our map sources are all GeoJSON, which is what has setData()
function flightGeoSource(id: string): GeoJSONMapSource | undefined {
    return map.getSource(id) as GeoJSONMapSource | undefined;
}

function canvasContext(canvas: HTMLCanvasElement): CanvasRenderingContext2D {

    const ctx = canvas.getContext("2d");

    if (!ctx) throw new Error("Canvas 2D drawing is not available");

    return ctx;
}

// catch (error) gives an unknown value: read it as one of our fetch errors
function asFetchError(error: unknown): FlightFetchError {
    return error instanceof Error ? error : new Error(String(error));
}

function setFlightText(id: string, value: string): void {
    const el = flightEl(id);
    if (el) el.textContent = value;
}

function wrapLon(lon: number): number {
    return ((lon + 180) % 360 + 360) % 360 - 180;
}

function clampNumber(value: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, value));
}

function formatFlightAltitude(rec: FlightRecord): string {
    if (rec.onGround) return "GROUND";
    if (rec.alt == null) return "--";
    const ft = Math.round(rec.alt);
    const m = Math.round(rec.alt * 0.3048);
    return `${ft.toLocaleString("en-US")} ft (${m.toLocaleString("en-US")} m)`;
}

function formatFlightSpeed(gs: number | null): string {
    if (gs == null) return "--";
    return `${Math.round(gs)} kt (${Math.round(gs * 1.852)} km/h)`;
}

function formatFlightVRate(rate: number | null): string {
    if (rate == null) return "--";
    const arrow = rate > 64 ? "\u25B2" : rate < -64 ? "\u25BC" : "\u25A0";
    return `${arrow} ${Math.abs(Math.round(rate)).toLocaleString("en-US")} ft/min`;
}

function formatFlightTime(date: Date): string {
    return date.toISOString().slice(11, 19) + "Z";
}


// ==============================================
// F3b. AIRCRAFT MODELS (icon shape chosen by aircraft type)
// ==============================================

const FLIGHT_SHAPE_NAMES: FlightShape[] = [
    "narrow", "wide", "jumbo", "regional", "bizjet",
    "turboprop", "light", "glider", "fighter", "heli"
];

// Checked in order against the ICAO type code (B738, A388, E190 ...).
// A type not listed here falls back to the aircraft's ADS-B category,
// and finally to "narrow" (the typical single-aisle airliner).
const FLIGHT_SHAPE_RULES: [shape: FlightShape, types: RegExp][] = [
    ["heli", /^(R22|R44|R66|EC\d\d|AS\d\d|A109|A119|A139|A169|A189|B06T?|B407|B412|B429|B430|B505|B212|B222|B230|H500|H47|H60|H64|S61|S64|S65|S70|S76|S92|MI(8|17|24|26)|KA(27|32)|NH90|MD52|MD60|BK17|EN28|EN48|GAZL|SA3\d\d?|CH47|AH64|UH1\w?)$/],
    ["jumbo", /^(B74\w|A38\d|A124|A225|C5M?)$/],
    ["wide", /^(A33\d|A34\d|A35\d|A35K|A3ST|A30[0-9B]|A310|B76\w|B77\w|B78\w|MD11|DC10|IL96|IL86|L101|C17|K35R|KC10)$/],
    ["narrow", /^(B7[1-3]\w|B75\w|B3[7-9]\w|A3(18|19|20|21)|A[12][0-9]N|BCS[13]|A220|MD[89]\w|DC9|C919|T154|T204|YK4\w)$/],
    ["regional", /^(CRJ\w|E13\w|E14\w|E17\w|E19\w|E29\w|E75[LS]|F100|F70|F28|RJ\w\w|B46\w|J328|SU95)$/],
    ["turboprop", /^(AT[3-7]\w|DH8\w|DHC\d|SF34|SB20|JS\d\d|E120|B190|B350|BE(20|9\w|10|30|99)|C208|C441|PC12|PC6|TBM\d|SW[34]|D328|F27|F50|F60|A400|C130|C30J|L410|AN(12|24|26|28|30|32)|P180|MU2|ATP)$/],
    ["glider", /^(GLID|ASK\d\d|ASW\d\d|DG\d\d\w?|LS\d)$/],
    ["fighter", /^(F\d{1,2}[A-Z]?|FA18|F18[HS]|EUFI|RFAL|TORN|GRIF|A10|T38|HAWK|M346|L39|L159|MG29|MIG\d\d|SU\d\d|AV8B|HAR)$/],
    ["bizjet", /^(GLF\d|GLEX|G\d{3}|CL\d\d|C25[ABCM]|C5[0-6]\w|C68[0-9A]|C700|C750|FA\d\w|F900|F2TH|LJ\d\d|H25\w|E50P|E55P|E545|E550|E35[LP]|PRM1|BE40|HDJT|ASTR|GALX|SF50|EA50|PC24)$/],
    ["light", /^(C1\d\d|C2(05|06|10|14)|C3\d\d|C4[0-4]\d|PA\d\d|P28\w|P32\w|P46T?|SR2\d|DA\d\d|BE(3\d|5\d|23|24|33|35|36|55|58|60|76|77)|M20\w|RV\d+|AA\d|COZY|S22T|G115|GA8|TB\d\d|CH\d\d|AC11|J3|PA\w+)$/]
];

// ADS-B emitter category sent by the regional feed (A1 = light ... A7 = helicopter)
function shapeFromAdsbCategory(category: unknown): FlightShape | "" {

    switch (String(category || "").toUpperCase()) {
        case "A1": return "light";
        case "A2": return "regional";
        case "A3":
        case "A4": return "narrow";
        case "A5": return "wide";
        case "A6": return "fighter";
        case "A7": return "heli";
        case "B1": return "glider";
        case "B2":
        case "B4":
        case "B6": return "light";
        default: return "";
    }

}

// OpenSky numeric category (world view): 2 light, 3 small, 4 large,
// 5 high vortex large, 6 heavy, 7 high performance, 8 rotorcraft,
// 9 glider, 10 balloon, 12 ultralight, 14 drone
function shapeFromOpenSkyCategory(n: unknown): FlightShape | "" {

    switch (n) {
        case 2: return "light";
        case 3: return "regional";
        case 4:
        case 5: return "narrow";
        case 6: return "wide";
        case 7: return "fighter";
        case 8: return "heli";
        case 9: return "glider";
        case 10:
        case 12:
        case 14: return "light";
        default: return "";
    }

}

function flightShapeFor(rec: FlightRecord): FlightShape {

    const type = String(rec.type || "").toUpperCase();

    const key = type + "|" + (rec.shapeHint || "");

    let shape = flightShapeCache.get(key);

    if (shape) return shape;

    if (type) {

        for (const rule of FLIGHT_SHAPE_RULES) {
            if (rule[1].test(type)) {
                shape = rule[0];
                break;
            }
        }

    }

    if (!shape) shape = rec.shapeHint || "narrow";

    flightShapeCache.set(key, shape);

    return shape;
}


// ==============================================
// F4. AIRCRAFT DATA
// ==============================================

function parseAircraft(a: AdsbAircraft | null | undefined, receivedAt: number): FlightRecord | null {

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
        country: "",
        shapeHint: shapeFromAdsbCategory(a.category),

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

// ----- aircraft details that the OpenSky world feed doesn't have -----
// The regional feed (zoomed in) knows each aircraft's registration, type
// and operator; OpenSky (zoomed out) doesn't. Remember them per aircraft so
// they survive the switch between the two feeds.

const FLIGHT_DETAILS_MAX = 20000;
const flightKnownDetails = new Map<string, FlightKnownDetails>();   // hex -> { reg, type, typeDesc, operator, military }

function rememberFlightDetails(rec: FlightRecord): void {

    if (!rec || !rec.hex) return;

    const old: Partial<FlightKnownDetails> = flightKnownDetails.get(rec.hex) || {};

    const details: FlightKnownDetails = {
        reg: rec.reg || old.reg || "",
        type: rec.type || old.type || "",
        typeDesc: rec.typeDesc || old.typeDesc || "",
        operator: rec.operator || old.operator || "",
        military: rec.military || old.military || false
    };

    if (!details.reg && !details.type && !details.typeDesc &&
        !details.operator && !details.military) return;

    // Re-insert so the Map stays ordered oldest -> newest, then trim the oldest
    flightKnownDetails.delete(rec.hex);
    flightKnownDetails.set(rec.hex, details);

    if (flightKnownDetails.size > FLIGHT_DETAILS_MAX) {
        const oldest = flightKnownDetails.keys().next().value;
        if (oldest !== undefined) flightKnownDetails.delete(oldest);
    }
}

// Fills blank fields of a record from what we remembered (keeps any new value)
function applyKnownDetails(rec: FlightRecord): FlightRecord {

    const known = rec && flightKnownDetails.get(rec.hex);

    if (!known) return rec;

    if (!rec.reg) rec.reg = known.reg;
    if (!rec.type) rec.type = known.type;
    if (!rec.typeDesc) rec.typeDesc = known.typeDesc;
    if (!rec.operator) rec.operator = known.operator;
    if (known.military) rec.military = true;

    return rec;
}

function flightColorKey(rec: FlightRecord): FlightColorKey {
    if (rec.emergency) return "emergency";
    if (rec.military) return "military";
    if (rec.onGround) return "ground";
    return "normal";
}

// Dead reckoning: move the aircraft along its heading between feed updates.
function predictPosition(rec: FlightRecord, now: number): LatLon {

    if (rec.onGround || !rec.gs || rec.track == null) {
        return { lat: rec.lat, lon: rec.lon };
    }

    const seconds = clampNumber((now - rec.t0) / 1000, 0, rec.predictCap || 60);
    const meters = rec.gs * 0.514444 * seconds;
    const rad = rec.track * Math.PI / 180;

    const cosLat = Math.max(0.01, Math.cos(rec.lat * Math.PI / 180));

    return {
        lat: clampNumber(rec.lat + (meters * Math.cos(rad)) / 111320, -90, 90),
        lon: wrapLon(rec.lon + (meters * Math.sin(rad)) / (111320 * cosLat))
    };
}

function buildFlightFeature(rec: FlightRecord, now: number): GeoFeature {

    const pos = predictPosition(rec, now);

    // Uses the type adsbdb told us about (after you click), if the feed had none
    const shape = flightShapeFor(displayRecord(rec));

    return {
        type: "Feature",
        geometry: { type: "Point", coordinates: [pos.lon, pos.lat] },
        properties: {
            hex: rec.hex,
            callsign: rec.callsign,
            icon: shape + "-" + flightColorKey(rec),
            track: rec.track == null ? 0 : rec.track,
            watched: watchlistHexes.has(rec.hex),
            sort: rec.emergency ? 1000000 : (rec.alt || 0)
        }
    };
}

function recordFlightHistory(records: Map<string, FlightRecord>): void {

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
                h.points.push([rec.lon, rec.lat, rec.onGround ? 0 : rec.alt, rec.t0]);

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

// Each aircraft is drawn nose up on a 48 x 48 grid from soft, rounded parts:
// a fuselage with a curved nose and tapered tail, swept wings and tailplane
// with rounded tips, and capsule-shaped engines. See FlightShapeSpec for what
// the numbers mean (x is measured out from the centre line, y runs down).
const FLIGHT_SHAPES: Record<Exclude<FlightShape, "heli">, FlightShapeSpec> = {
    narrow: {
        width: 3.1, nose: 3, noseLength: 9, tail: 45.5,
        wing: [17.5, 20.5, 29.5, 33.5, 29.5],
        stabiliser: [36.5, 8.5, 42, 44.8, 43],
        pods: [[8.6, 20.5, 26.5, 3]]
    },
    wide: {
        width: 3.7, nose: 2, noseLength: 9, tail: 46.5,
        wing: [16.5, 22.5, 30.5, 35, 31],
        stabiliser: [37.5, 10, 42.5, 45.8, 44],
        pods: [[9.8, 19.5, 26.5, 3.2]]
    },
    jumbo: {
        width: 4.1, nose: 1.5, noseLength: 8.5, tail: 47,
        wing: [15, 23.5, 29.5, 34.5, 31],
        stabiliser: [37.5, 11, 42.5, 46.2, 44.5],
        pods: [[9, 17, 23.5, 3], [16, 21.5, 28, 3]]
    },
    regional: {
        width: 2.7, nose: 5, noseLength: 8.5, tail: 44.5,
        wing: [20, 16.5, 29, 32.3, 30],
        stabiliser: [37.5, 8, 41, 43.4, 42.3],
        pods: [[4.6, 32, 38, 2.8]]
    },
    bizjet: {
        width: 2.3, nose: 7, noseLength: 9, tail: 43.5,
        wing: [20, 14.5, 30.5, 33.2, 30],
        stabiliser: [37, 7, 40.5, 42.6, 41.6],
        pods: [[4, 32, 37.5, 2.6]]
    },
    turboprop: {
        width: 2.9, nose: 5, noseLength: 7, tail: 43,
        wing: [20.5, 21.5, 22, 26.2, 27],
        stabiliser: [36.5, 9.5, 38.5, 41.6, 41],
        pods: [[8.6, 17, 25, 3]]
    },
    light: {
        width: 2.3, nose: 8, noseLength: 5, tail: 41.5,
        wing: [20.5, 17.5, 21.2, 25, 25.5],
        stabiliser: [35.5, 7.5, 37.2, 40.2, 39.6],
        pods: []
    },
    glider: {
        width: 1.7, nose: 9, noseLength: 5, tail: 41,
        wing: [20.5, 23.2, 21.4, 24.4, 24.8],
        stabiliser: [36.5, 6.5, 37.8, 40, 39.6],
        pods: []
    },
    fighter: {
        width: 2.5, nose: 2, noseLength: 13, tail: 46.5,
        wing: [17, 17.5, 36.5, 40, 39.5],
        stabiliser: [41, 7, 44.5, 46.6, 45.6],
        pods: []
    }
};

// Icons are drawn at 4x their on-screen size so they stay sharp when the
// map enlarges them and on high-resolution screens.
const FLIGHT_ICON_GRID = 48;       // the grid the shapes are designed on
const FLIGHT_ICON_SCALE = 2;       // canvas pixels per grid unit
const FLIGHT_ICON_PIXEL_RATIO = 2 * FLIGHT_ICON_SCALE;   // 48-unit grid shows as 24 px
const FLIGHT_ICON_OUTLINE = "#0c1118";

// A closed shape through the points, with every corner rounded off. Each
// corner uses the given radius, or less where the edges are too short for it.
function traceRoundedPolygon(ctx: CanvasRenderingContext2D, pts: number[][], radius: number): void {

    const n = pts.length;

    ctx.beginPath();

    for (let i = 0; i < n; i++) {

        const prev = pts[(i + n - 1) % n];
        const cur = pts[i];
        const next = pts[(i + 1) % n];

        const a = Math.hypot(cur[0] - prev[0], cur[1] - prev[1]);
        const b = Math.hypot(next[0] - cur[0], next[1] - cur[1]);

        const cos = ((prev[0] - cur[0]) * (next[0] - cur[0]) +
                     (prev[1] - cur[1]) * (next[1] - cur[1])) / (a * b || 1);

        const angle = Math.acos(clampNumber(cos, -1, 1));

        // The curve may use up to half of each edge it touches
        const r = Math.min(radius, Math.tan(angle / 2) * Math.min(a, b) / 2);

        if (i === 0) ctx.moveTo((prev[0] + cur[0]) / 2, (prev[1] + cur[1]) / 2);

        ctx.arcTo(cur[0], cur[1], next[0], next[1], Math.max(0, r));
    }

    ctx.closePath();
}

// Fuselage: curved nose, straight sides, then a taper to a rounded tail
function traceFlightFuselage(ctx: CanvasRenderingContext2D, spec: FlightShapeSpec): void {

    const cx = FLIGHT_ICON_GRID / 2;
    const w = spec.width;

    const shoulder = spec.nose + spec.noseLength;     // where the nose curve ends
    const taper = Math.min(spec.wing[4] + 1, spec.tail - 6);   // where the tail starts narrowing

    ctx.beginPath();
    ctx.moveTo(cx - w, shoulder);
    ctx.bezierCurveTo(cx - w, spec.nose + spec.noseLength * 0.35, cx - w * 0.6, spec.nose, cx, spec.nose);
    ctx.bezierCurveTo(cx + w * 0.6, spec.nose, cx + w, spec.nose + spec.noseLength * 0.35, cx + w, shoulder);
    ctx.lineTo(cx + w, taper);
    ctx.quadraticCurveTo(cx + w * 0.8, spec.tail, cx, spec.tail);
    ctx.quadraticCurveTo(cx - w * 0.8, spec.tail, cx - w, taper);
    ctx.closePath();
}

// Both wings (or both halves of the tailplane) as one shape across the body
function flightSurfacePolygon(surface: FlightSurface): number[][] {

    const cx = FLIGHT_ICON_GRID / 2;

    const [rootFront, tipX, tipFront, tipBack, rootBack] = surface;

    return [
        [cx, rootFront],
        [cx + tipX, tipFront], [cx + tipX, tipBack],
        [cx, rootBack],
        [cx - tipX, tipBack], [cx - tipX, tipFront]
    ];
}

// Every part of one aircraft, as functions that trace its outline
function flightShapeParts(ctx: CanvasRenderingContext2D, shape: Exclude<FlightShape, "heli">): (() => void)[] {

    const spec = FLIGHT_SHAPES[shape];
    const cx = FLIGHT_ICON_GRID / 2;

    const parts: (() => void)[] = [
        () => traceRoundedPolygon(ctx, flightSurfacePolygon(spec.wing), 2.2),
        () => traceRoundedPolygon(ctx, flightSurfacePolygon(spec.stabiliser), 1.6)
    ];

    // Engines: capsules on both sides
    spec.pods.forEach(function(pod) {

        [-1, 1].forEach(function(side) {

            const width = pod[3];

            parts.push(function() {
                ctx.beginPath();
                ctx.roundRect(cx + side * pod[0] - width / 2, pod[1], width, pod[2] - pod[1], width / 2);
            });

        });

    });

    parts.push(() => traceFlightFuselage(ctx, spec));

    return parts;
}

// Helicopter: round cabin, tail boom with a tail rotor, two crossing blades
function flightHelicopterParts(ctx: CanvasRenderingContext2D): (() => void)[] {

    return [
        function() {                                   // tail boom
            ctx.beginPath();
            ctx.roundRect(22.7, 25, 2.6, 17.5, 1.3);
        },
        function() {                                   // tail rotor
            ctx.beginPath();
            ctx.roundRect(19.5, 40.6, 9, 3, 1.5);
        },
        function() {                                   // cabin
            ctx.beginPath();
            ctx.ellipse(24, 21, 5.8, 9, 0, 0, Math.PI * 2);
        }
    ];
}

function createPlaneIcon(shape: FlightShape, color: string): ImageData {

    const size = FLIGHT_ICON_GRID * FLIGHT_ICON_SCALE;

    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;

    const ctx = canvasContext(canvas);

    ctx.scale(FLIGHT_ICON_SCALE, FLIGHT_ICON_SCALE);   // draw in grid units from here on

    const parts = shape === "heli"
        ? flightHelicopterParts(ctx)
        : flightShapeParts(ctx, shape);

    ctx.lineJoin = "round";
    ctx.lineCap = "round";

    // Outline every part first, then fill them all: the parts merge into
    // one silhouette with a single dark edge around it
    ctx.lineWidth = 2.4;
    ctx.strokeStyle = FLIGHT_ICON_OUTLINE;

    parts.forEach(function(trace) {
        trace();
        ctx.stroke();
    });

    ctx.fillStyle = color;

    parts.forEach(function(trace) {
        trace();
        ctx.fill();
    });

    if (shape === "heli") {

        // Main rotor on top: two crossing blades with rounded ends, and a hub
        const blades: [stroke: string, width: number][] = [[FLIGHT_ICON_OUTLINE, 4.8], [color, 2.4]];

        blades.forEach(function(style) {

            ctx.strokeStyle = style[0];
            ctx.lineWidth = style[1];

            ctx.beginPath();
            ctx.moveTo(8, 8);
            ctx.lineTo(40, 34);
            ctx.moveTo(8, 34);
            ctx.lineTo(40, 8);
            ctx.stroke();

        });

        ctx.beginPath();
        ctx.arc(24, 21, 1.6, 0, Math.PI * 2);
        ctx.fillStyle = FLIGHT_ICON_OUTLINE;
        ctx.fill();

    }

    return ctx.getImageData(0, 0, size, size);
}

// Control-tower icon for airports: amber tower, dark outline, dark glass cab.
// Drawn at 2x (pixelRatio 2), so it shows as 20 x 26 px.
const AIRPORT_PIN_IMAGE = "airport-tower";

function createAirportTowerIcon(): ImageData {

    const w = 40;
    const h = 52;

    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;

    const ctx = canvasContext(canvas);

    const AMBER = "#ffb300";
    const DARK = "#0c1118";

    // Tower parts, top to bottom (x, y points on the 40 x 52 canvas)
    const parts: number[][][] = [
        [[12, 9], [28, 9], [34, 14], [6, 14]],      // roof (overhangs the cab)
        [[8, 14], [32, 14], [29, 25], [11, 25]],    // glass cab, sloped inwards
        [[10, 25], [30, 25], [30, 28], [10, 28]],   // floor under the cab
        [[16, 28], [24, 28], [26, 46], [14, 46]],   // shaft, wider at the bottom
        [[9, 46], [31, 46], [31, 50], [9, 50]]      // base
    ];

    function trace(pts: number[][]): void {
        ctx.beginPath();
        ctx.moveTo(pts[0][0], pts[0][1]);
        for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
        ctx.closePath();
    }

    // Antenna with a beacon on top
    ctx.lineCap = "round";
    ctx.strokeStyle = DARK;
    ctx.lineWidth = 4.5;
    ctx.beginPath();
    ctx.moveTo(20, 9);
    ctx.lineTo(20, 4);
    ctx.stroke();
    ctx.strokeStyle = AMBER;
    ctx.lineWidth = 1.8;
    ctx.stroke();

    ctx.beginPath();
    ctx.arc(20, 3.5, 2.5, 0, Math.PI * 2);
    ctx.fillStyle = "#ff4d4d";
    ctx.fill();
    ctx.lineWidth = 1.2;
    ctx.strokeStyle = DARK;
    ctx.stroke();

    // Outline every part first, then fill, so the outlines merge into one shape
    ctx.lineJoin = "round";
    ctx.lineWidth = 3;
    ctx.strokeStyle = DARK;
    parts.forEach(function(pts) { trace(pts); ctx.stroke(); });

    ctx.fillStyle = AMBER;
    parts.forEach(function(pts) { trace(pts); ctx.fill(); });

    // Dark windows with two amber frame bars
    trace([[11, 16], [29, 16], [27.2, 23], [12.8, 23]]);
    ctx.fillStyle = "#16324a";
    ctx.fill();

    ctx.strokeStyle = AMBER;
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.moveTo(17, 16); ctx.lineTo(17.6, 23);
    ctx.moveTo(23, 16); ctx.lineTo(22.4, 23);
    ctx.stroke();

    return ctx.getImageData(0, 0, w, h);
}

const flightIconImages = new Map<string, ImageData>();

function flightIconImage(shape: FlightShape, colorKey: FlightColorKey): ImageData {

    const id = shape + "-" + colorKey;

    let image = flightIconImages.get(id);

    if (!image) {
        image = createPlaneIcon(shape, FLIGHT_COLORS[colorKey]);
        flightIconImages.set(id, image);
    }

    return image;
}

// Runs on every style load, because changing the base map wipes all layers.
function setupFlightLayers(): void {

    FLIGHT_SHAPE_NAMES.forEach(function(shape) {

        (Object.keys(FLIGHT_COLORS) as FlightColorKey[]).forEach(function(colorKey) {

            const id = `flight-icon-${shape}-${colorKey}`;

            if (!map.hasImage(id)) {
                map.addImage(id, flightIconImage(shape, colorKey), {
                    pixelRatio: FLIGHT_ICON_PIXEL_RATIO
                });
            }

        });

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

    if (!map.getSource(FLIGHT_ROUTE_SOURCE)) {
        map.addSource(FLIGHT_ROUTE_SOURCE, {
            type: "geojson",
            data: lastFlightRouteGeoJSON
        });
    }

    // Planned route (origin -> destination), dashed, drawn under everything
    if (!map.getLayer(FLIGHT_ROUTE_LAYER)) {
        map.addLayer({
            id: FLIGHT_ROUTE_LAYER,
            type: "line",
            source: FLIGHT_ROUTE_SOURCE,
            filter: ["==", ["geometry-type"], "LineString"],
            layout: { "line-cap": "butt", "line-join": "round" },
            paint: {
                "line-color": "#9fb3c8",
                "line-width": 1.6,
                "line-opacity": 0.75,
                "line-dasharray": [2, 2.5]
            }
        });
    }

    if (!map.getLayer(FLIGHT_ROUTE_POINTS_LAYER)) {
        map.addLayer({
            id: FLIGHT_ROUTE_POINTS_LAYER,
            type: "circle",
            source: FLIGHT_ROUTE_SOURCE,
            filter: ["==", ["geometry-type"], "Point"],
            paint: {
                "circle-radius": 5,
                "circle-color": "#e9f1f8",
                "circle-stroke-color": "#0c1118",
                "circle-stroke-width": 2
            }
        });
    }

    if (!map.getSource(AIRPORT_SOURCE)) {
        map.addSource(AIRPORT_SOURCE, {
            type: "geojson",
            data: lastAirportGeoJSON
        });
    }

    if (!map.hasImage(AIRPORT_PIN_IMAGE)) {
        map.addImage(AIRPORT_PIN_IMAGE, createAirportTowerIcon(), { pixelRatio: 2 });
    }

    // Airport pins: big airports from zoom 3, medium ones from zoom 6.
    // icon-anchor "bottom" puts the pin's tip on the airport's location.
    if (!map.getLayer(AIRPORT_MEDIUM_LAYER)) {
        map.addLayer({
            id: AIRPORT_MEDIUM_LAYER,
            type: "symbol",
            source: AIRPORT_SOURCE,
            minzoom: 6,
            filter: ["==", ["get", "kind"], "M"],
            layout: {
                "icon-image": AIRPORT_PIN_IMAGE,
                "icon-anchor": "bottom",
                "icon-size": ["interpolate", ["linear"], ["zoom"], 6, 0.6, 12, 1],
                "icon-allow-overlap": true,
                "icon-ignore-placement": true
            },
            paint: { "icon-opacity": 0.9 }
        });
    }

    if (!map.getLayer(AIRPORT_LARGE_LAYER)) {
        map.addLayer({
            id: AIRPORT_LARGE_LAYER,
            type: "symbol",
            source: AIRPORT_SOURCE,
            minzoom: 3,
            filter: ["==", ["get", "kind"], "L"],
            layout: {
                "icon-image": AIRPORT_PIN_IMAGE,
                "icon-anchor": "bottom",
                "icon-size": ["interpolate", ["linear"], ["zoom"], 3, 0.7, 12, 1.25],
                "icon-allow-overlap": true,
                "icon-ignore-placement": true
            }
        });
    }

    // The path flown so far, coloured by altitude (dark outline underneath)
    if (!map.getLayer(FLIGHT_TRAIL_CASING_LAYER)) {
        map.addLayer({
            id: FLIGHT_TRAIL_CASING_LAYER,
            type: "line",
            source: FLIGHT_TRAIL_SOURCE,
            layout: { "line-cap": "round", "line-join": "round" },
            paint: {
                "line-color": "#0c1118",
                "line-width": 6,
                "line-opacity": 0.55
            }
        });
    }

    if (!map.getLayer(FLIGHT_TRAIL_LAYER)) {
        map.addLayer({
            id: FLIGHT_TRAIL_LAYER,
            type: "line",
            source: FLIGHT_TRAIL_SOURCE,
            layout: { "line-cap": "round", "line-join": "round" },
            paint: {
                "line-color": ["get", "color"],
                "line-width": 3.2,
                "line-opacity": 1
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

    // Ring around every watchlist aircraft
    if (!map.getLayer(FLIGHT_WATCH_LAYER)) {
        map.addLayer({
            id: FLIGHT_WATCH_LAYER,
            type: "circle",
            source: FLIGHT_SOURCE,
            filter: ["==", ["get", "watched"], true],
            paint: {
                "circle-radius": 14,
                "circle-color": FLIGHT_WATCH_COLOR,
                "circle-opacity": 0.12,
                "circle-stroke-color": FLIGHT_WATCH_COLOR,
                "circle-stroke-width": 2,
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
                "icon-image": ["concat", "flight-icon-", ["get", "icon"]],
                "icon-rotate": ["get", "track"],
                "icon-rotation-alignment": "map",
                "icon-allow-overlap": true,
                "icon-ignore-placement": true,
                "icon-size": [
                    "interpolate", ["linear"], ["zoom"],
                    2, 1,
                    4,1.25,
                    6, 1.5,
                    10, 2,
                    14, 2.5,
                    18,3
                ],
                "symbol-sort-key": ["get", "sort"]
            }
        });
    }

}


// Safety net: a style change can remove our layers without firing
// "style.load" (MapLibre may update styles in place). If anything is
// missing, rebuild it. Cheap enough to call often.
function ensureFlightLayers(): void {

    if (!map || !map.isStyleLoaded()) return;

    if (
        map.getSource(FLIGHT_SOURCE) &&
        map.getSource(FLIGHT_TRAIL_SOURCE) &&
        map.getSource(FLIGHT_ROUTE_SOURCE) &&
        map.getSource(AIRPORT_SOURCE) &&
        map.getLayer(AIRPORT_LARGE_LAYER) &&
        map.getLayer(AIRPORT_MEDIUM_LAYER) &&
        map.getLayer(FLIGHT_ROUTE_LAYER) &&
        map.getLayer(FLIGHT_ROUTE_POINTS_LAYER) &&
        map.getLayer(FLIGHT_TRAIL_CASING_LAYER) &&
        map.getLayer(FLIGHT_TRAIL_LAYER) &&
        map.getLayer(FLIGHT_SELECTED_LAYER) &&
        map.getLayer(FLIGHT_WATCH_LAYER) &&
        map.getLayer(FLIGHT_LAYER)
    ) return;

    try {
        setupFlightLayers();
    } catch (error) {
        console.warn("Flight layers could not be rebuilt yet:", asFetchError(error).message);
    }

}


// ==============================================
// F6. FEED REQUESTS
// ==============================================

// Work out which area(s) of the feed cover the current view.
// Returns a list of circles, or null if the view is too wide.
function computeFlightPlan(): FlightPlanTile[] | null {

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
function waitForFlightSlot(): Promise<void> {

    const now = Date.now();

    const at = Math.max(now, flightNextSlot);

    flightNextSlot = at + FLIGHT_REQUEST_GAP_MS;

    return new Promise(resolve => setTimeout(resolve, at - now));

}


async function fetchFlightTile(q: FlightPlanTile): Promise<{ aircraft: AdsbAircraft[]; receivedAt: number }> {

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
                const error: FlightFetchError = new Error(`${attempt.name}: HTTP ${response.status}`);
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

        catch (caught) {

            const error = asFetchError(caught);

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

    const failure: FlightFetchError = new Error(messages.join(" | ") || "No feed available");

    failure.rateLimited = rateLimited;

    throw failure;
}


async function refreshFlights(): Promise<void> {

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

        await refreshWorldFlights();

        return;

    }

    if (flightWorldMode) {
        flightWorldMode = false;
        flightWorldFetchedAt = 0;
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

                // Keep reg / type / operator for when we zoom out to OpenSky,
                // and fill gaps this feed left from what an earlier one said
                rememberFlightDetails(rec);
                applyKnownDetails(rec);

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


        keepLocatedFlight(next);

        flightStore = next;

        recordFlightHistory(next);

        setFlightStatus(
            okResults.length < plan.length
                ? `PARTIAL ${okResults.length}/${plan.length} - ${formatFlightTime(new Date())}${flightSourceName ? " | " + flightSourceName : ""}`
                : `UPDATED ${formatFlightTime(new Date())}${flightSourceName ? " | " + flightSourceName : ""}`
        );

        tickFlights(true);

    }


    scheduleFlightPoll();

    if (flightRefetchQueued) {
        flightRefetchQueued = false;
        scheduleFlightRefresh(300);
    }

}


function scheduleFlightPoll(): void {

    clearTimeout(flightPollTimer);

    if (!flightsEnabled) return;

    const normal = flightWorldMode
        ? Math.max(5000, flightWorldIntervalMs - (Date.now() - flightWorldFetchedAt))
        : FLIGHT_BASE_REFRESH_MS + lastFlightPlanSize * FLIGHT_PER_TILE_MS;

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
// F6b. WORLD VIEW (OpenSky Network, via the relay)
// ==============================================

// OpenSky "state vector" array -> the same record shape the regional feed uses.
// Field order: 0 icao24, 1 callsign, 2 origin country, 3 time position,
// 4 last contact, 5 lon, 6 lat, 7 baro alt (m), 8 on ground, 9 speed (m/s),
// 10 track, 11 vertical rate (m/s), 13 geo alt (m), 14 squawk
function parseOpenSkyState(s: unknown, fetchedAt: number, snapshot: number, predictCap: number): FlightRecord | null {

    if (!Array.isArray(s) || !s[0]) return null;

    const lon = s[5];
    const lat = s[6];

    if (typeof lon !== "number" || typeof lat !== "number") return null;

    const onGround = s[8] === true;

    const altMeters = typeof s[7] === "number" ? s[7]
                    : typeof s[13] === "number" ? s[13] : null;

    const positionTime = typeof s[3] === "number" ? s[3]
                       : typeof s[4] === "number" ? s[4] : snapshot;

    const ageSeconds = Math.max(0, snapshot - positionTime);

    const squawk = s[14] ? String(s[14]) : "";

    return {
        hex: String(s[0]).toLowerCase(),
        callsign: s[1] ? String(s[1]).trim() : "",
        reg: "",
        type: "",
        typeDesc: "",
        operator: "",
        country: s[2] ? String(s[2]) : "",
        shapeHint: shapeFromOpenSkyCategory(s[17]),

        lat: lat,
        lon: lon,
        t0: fetchedAt - ageSeconds * 1000,
        predictCap: predictCap,

        alt: onGround ? 0 : altMeters == null ? null : altMeters * 3.28084,
        onGround: onGround,
        gs: typeof s[9] === "number" ? s[9] * 1.943844 : null,
        track: typeof s[10] === "number" ? s[10] : null,
        vrate: typeof s[11] === "number" ? s[11] * 196.85 : null,

        squawk: squawk,
        military: false,
        emergency: squawk === "7500" || squawk === "7600" || squawk === "7700"
    };
}

function parseWorldPayload(payload: WorldPayload | null): Map<string, FlightRecord> | null {

    const data = payload && payload.data;

    if (!data || !Array.isArray(data.states)) return null;

    const fetchedAt = typeof payload.fetchedAt === "number"
        ? payload.fetchedAt : Date.now();

    const snapshot = typeof data.time === "number"
        ? data.time : Math.floor(fetchedAt / 1000);

    // Keep gliding aircraft along their heading until the next snapshot
    const cap = Math.min((Number(payload.minInterval) || 90) + 30, 600);

    const next = new Map<string, FlightRecord>();

    data.states.forEach(function(state: unknown) {

        const rec = parseOpenSkyState(state, fetchedAt, snapshot, cap);

        // OpenSky has no registration / type: reuse what the regional feed told us
        if (rec) next.set(rec.hex, applyKnownDetails(rec));

    });

    return next;
}

async function fetchWorldFlights(): Promise<WorldPayload> {

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 45000);

    try {

        const response = await fetch(FLIGHT_WORLD_PATH, {
            signal: controller.signal
        });

        if (!response.ok) {

            let detail: { error?: string; retryAfter?: number } = {};

            try { detail = await response.json(); } catch (error) { /* not JSON */ }

            const failure: FlightFetchError = new Error(detail.error || `HTTP ${response.status}`);

            failure.status = response.status;
            failure.retryAfter = Number(detail.retryAfter) || 0;

            throw failure;
        }

        const json = await response.json();

        flightProxyOk = true;

        return json;

    }

    catch (error) {

        // 404 or a non-JSON page = this server has no relay
        if (asFetchError(error).status === 404 || error instanceof SyntaxError) {
            flightProxyOk = false;
        }

        throw error;

    }

    finally {

        clearTimeout(timer);

    }
}

function formatWorldInterval(ms: number): string {

    const seconds = Math.round(ms / 1000);

    return seconds >= 120 ? `${Math.round(seconds / 60)} MIN` : `${seconds} S`;
}

async function refreshWorldFlights(): Promise<void> {

    flightWorldMode = true;

    // Only the relay can reach OpenSky
    if (flightProxyOk === false || !/^https?:$/.test(location.protocol)) {

        flightStore = new Map();

        showFlightNotice("WORLD VIEW NEEDS server.js / server.py - ZOOM IN FOR REGIONAL FLIGHTS");

        setFlightStatus("VIEW TOO WIDE");

        tickFlights(true);

        scheduleFlightPoll();

        return;

    }

    // OpenSky credits are precious: don't ask again before the next snapshot is due
    if (flightStore.size && Date.now() - flightWorldFetchedAt < flightWorldIntervalMs - 2000) {

        showFlightNotice("");

        scheduleFlightPoll();

        return;

    }

    const generation = flightGeneration;

    flightFetchBusy = true;

    setFlightStatus("LOADING WORLD VIEW...");

    let payload: WorldPayload | null = null;
    let failure: FlightFetchError | null = null;

    try {
        payload = await fetchWorldFlights();
    } catch (error) {
        failure = asFetchError(error);
    }

    if (generation !== flightGeneration || !flightsEnabled) return;

    flightFetchBusy = false;


    const next = payload ? parseWorldPayload(payload) : null;

    if (!failure && !next) failure = new Error("Unexpected OpenSky response");


    if (failure) {

        flightFailures++;

        if (failure.retryAfter) {

            // Daily credits used up (or OpenSky asked us to wait)
            const waitSeconds = Math.min(failure.retryAfter, 3600);

            flightBackoffUntil = Date.now() + waitSeconds * 1000;

            setFlightStatus(
                `OPENSKY LIMIT REACHED - RETRY IN ${formatWorldInterval(waitSeconds * 1000)}`
            );

        }

        else {

            const wait = Math.min(120000, 15000 * Math.pow(2, flightFailures - 1));

            flightBackoffUntil = Date.now() + wait;

            setFlightStatus(`WORLD FEED ERROR - ${String(failure.message).slice(0, 100)}`);

        }

        console.warn("World flight feed failed:", failure.message);

        if (!flightStore.size) {
            showFlightNotice("WORLD VIEW UNAVAILABLE - ZOOM IN FOR REGIONAL FLIGHTS");
        }

        scheduleFlightPoll();

        return;

    }


    if (!next || !payload) return;   // already handled as a failure above

    flightFailures = 0;

    keepLocatedFlight(next);

    flightStore = next;

    flightWorldFetchedAt = Date.now();

    flightWorldIntervalMs = (Number(payload.minInterval) || 90) * 1000;

    // Trails are only kept for the selected aircraft in world view
    const selectedRec = selectedFlightHex ? next.get(selectedFlightHex) : undefined;

    if (selectedRec) {
        recordFlightHistory(new Map([[selectedRec.hex, selectedRec]]));
    }

    showFlightNotice("");

    setFlightStatus(
        `WORLD VIEW | OPENSKY (${String(payload.mode || "anonymous").toUpperCase()}) | ` +
        `${formatFlightTime(new Date(payload.fetchedAt || Date.now()))} | ` +
        `EVERY ${formatWorldInterval(flightWorldIntervalMs)}`
    );

    tickFlights(true);

    scheduleFlightPoll();

    if (flightRefetchQueued) {
        flightRefetchQueued = false;
        scheduleFlightRefresh(300);
    }

}


// ==============================================
// F7. SMOOTH MOVEMENT TICK
// ==============================================

function tickFlights(force?: boolean): void {

    if (!map) return;

    if (document.hidden && flightsEnabled) return;

    const now = Date.now();

    // The world snapshot holds thousands of aircraft that barely move on
    // screen, so redraw those every 5th tick instead of every tick.
    const redraw = force === true || !flightWorldMode || ++flightWorldTick % 5 === 0;

    // New feed data (or a changed watchlist): work out which watched aircraft are here
    if (watchlistDirty || flightStore !== watchlistScannedStore) scanWatchlist(now);

    if (redraw) {

        const features: GeoFeature[] = [];

        flightStore.forEach(rec => features.push(buildFlightFeature(rec, now)));

        lastFlightGeoJSON = { type: "FeatureCollection", features: features };

        ensureFlightLayers();

        const source = flightGeoSource(FLIGHT_SOURCE);

        if (source) source.setData(lastFlightGeoJSON);

    }


    updateFlightHud();

    updateFlightTrail(now);

    updateFlightPanel(now);

    if (selectedAirport && ++airportTick % 2 === 0) updateAirportPanel(now);


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


// ----- geometry helpers -----

function flightDistanceKm(lat1: number, lon1: number, lat2: number, lon2: number): number {

    const rad = Math.PI / 180;

    const dLat = (lat2 - lat1) * rad;
    const dLon = (lon2 - lon1) * rad;

    const h = Math.sin(dLat / 2) ** 2 +
        Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) ** 2;

    return 12742 * Math.asin(Math.min(1, Math.sqrt(h)));
}

// Points along the great circle between two places, longitudes unwrapped so
// a route over the antimeridian is drawn as one line, not across the map.
function flightGreatCircle(lat1: number, lon1: number, lat2: number, lon2: number, steps: number): number[][] {

    const rad = Math.PI / 180;

    const p1 = lat1 * rad, l1 = lon1 * rad;
    const p2 = lat2 * rad, l2 = lon2 * rad;

    const d = 2 * Math.asin(Math.sqrt(
        Math.sin((p2 - p1) / 2) ** 2 +
        Math.cos(p1) * Math.cos(p2) * Math.sin((l2 - l1) / 2) ** 2
    ));

    const coords = [];

    if (!d || !isFinite(d)) return [[lon1, lat1], [lon2, lat2]];

    let prevLon = lon1;

    for (let i = 0; i <= steps; i++) {

        const t = i / steps;

        const A = Math.sin((1 - t) * d) / Math.sin(d);
        const B = Math.sin(t * d) / Math.sin(d);

        const x = A * Math.cos(p1) * Math.cos(l1) + B * Math.cos(p2) * Math.cos(l2);
        const y = A * Math.cos(p1) * Math.sin(l1) + B * Math.cos(p2) * Math.sin(l2);
        const z = A * Math.sin(p1) + B * Math.sin(p2);

        const lat = Math.atan2(z, Math.sqrt(x * x + y * y)) / rad;

        let lon = Math.atan2(y, x) / rad;

        while (lon - prevLon > 180) lon -= 360;
        while (lon - prevLon < -180) lon += 360;

        prevLon = lon;

        coords.push([lon, lat]);

    }

    return coords;
}

// ----- altitude colour -----

function flightAltitudeColor(ft: number | null): string {

    if (ft == null || !isFinite(ft)) return FLIGHT_ALT_UNKNOWN;

    const stops = FLIGHT_ALT_STOPS;

    if (ft <= stops[0][0]) return stops[0][1];

    for (let i = 1; i < stops.length; i++) {

        if (ft <= stops[i][0]) {

            const lo = stops[i - 1], hi = stops[i];

            const t = (ft - lo[0]) / (hi[0] - lo[0]);

            const c1 = parseInt(lo[1].slice(1), 16);
            const c2 = parseInt(hi[1].slice(1), 16);

            const mix = (shift: number) => Math.round(
                ((c1 >> shift) & 255) * (1 - t) + ((c2 >> shift) & 255) * t
            );

            return "#" + ((1 << 24) | (mix(16) << 16) | (mix(8) << 8) | mix(0))
                .toString(16).slice(1);
        }

    }

    return stops[stops.length - 1][1];
}

// ----- full flight path from the relay (OpenSky) -----

async function fetchFlightTrackData(hex: string): Promise<FlightTrackResult> {

    try {

        const response = await fetch(
            `${FLIGHT_TRACK_PATH}?icao24=${hex}`,
            { cache: "no-store" }
        );

        if (response.status === 404) return { state: "unavailable" };

        if (response.status === 429) {

            let retry = 600;

            try {
                retry = Number((await response.json()).retryAfter) || 600;
            } catch (error) {
                // keep the default
            }

            return { state: "limit", retryMs: clampNumber(retry, 60, 3600) * 1000 };
        }

        if (!response.ok) return { state: "error" };

        const data = await response.json();

        if (!data || !data.found || !Array.isArray(data.path)) {
            return { state: "none" };
        }

        const points: TrailPoint[] = [];

        data.path.forEach(function(w: unknown) {

            if (!Array.isArray(w)) return;

            const lat = Number(w[1]), lon = Number(w[2]);

            if (!isFinite(lat) || !isFinite(lon) || w[0] == null) return;

            const ft = w[5] ? 0 : (w[3] == null ? null : Number(w[3]) * 3.28084);

            points.push([lon, lat, ft, Number(w[0]) * 1000]);

        });

        if (points.length < 2) return { state: "none" };

        return { state: "ok", points: points };

    } catch (error) {

        return { state: "error" };

    }

}

const FLIGHT_TRACK_TTL: Partial<Record<FlightTrackState, number>> = {
    ok: 1e12,
    none: 300000,
    error: 30000,
    unavailable: 3600000
};

async function loadFlightTrack(hex: string): Promise<void> {

    if (!/^[0-9a-f]{6}$/.test(hex) || !flightsEnabled) return;

    const entry = flightTrackCache.get(hex);

    if (entry && Date.now() < entry.fetchedAt + entry.ttl) return;

    if (flightTrackPending.has(hex)) return;

    flightTrackPending.add(hex);

    const generation = flightGeneration;

    const result = await fetchFlightTrackData(hex);

    flightTrackPending.delete(hex);

    if (generation !== flightGeneration) return;

    const points = result.points || [];

    flightTrackCache.set(hex, {
        state: result.state,
        points: points,
        lastT: points.length ? points[points.length - 1][3] : 0,
        fetchedAt: Date.now(),
        ttl: result.retryMs || FLIGHT_TRACK_TTL[result.state] || 60000
    });

    flightTrailCache.key = "";

    if (selectedFlightHex === hex) updateFlightTrail(Date.now());

}

function flightTrailNote(hex: string): string {

    const entry = flightTrackCache.get(hex);

    if (!entry) {
        return flightTrackPending.has(hex) ? "Loading flight path..." : "";
    }

    switch (entry.state) {
        case "ok": return "";
        case "none": return "Earlier path unavailable. Showing the path since you started watching.";
        case "limit": return "OpenSky path limit reached. Showing the live path only.";
        case "error": return "Could not load the earlier path. Showing the live path only.";
        default: return "Earlier path needs the Python relay (server.py). Showing the live path only.";
    }

}

// The path points for one aircraft: OpenSky track first, then whatever we
// recorded live after the track ended.
function flightTrailPoints(hex: string): TrailPoint[] {

    const entry = flightTrackCache.get(hex);

    const history = flightHistory.get(hex);

    const points: TrailPoint[] = [];

    let after = 0;

    if (entry && entry.state === "ok") {
        entry.points.forEach(p => points.push(p));
        after = entry.lastT;
    }

    if (history) {
        history.points.forEach(function(p) {
            if (p[3] > after) points.push(p);
        });
    }

    return points;
}

function updateFlightTrail(now: number): void {

    const source = flightGeoSource(FLIGHT_TRAIL_SOURCE);

    if (!source) return;

    const hex = selectedFlightHex;

    let features: GeoFeature[] = [];

    if (hex) {

        loadFlightTrack(hex);

        const entry = flightTrackCache.get(hex);
        const history = flightHistory.get(hex);

        const key = [
            hex,
            entry ? entry.fetchedAt : 0,
            history ? history.points.length : 0,
            history ? history.lastT0 : 0
        ].join("|");

        // The finished part of the path only changes when new data arrives
        if (flightTrailCache.key !== key) {

            const points = flightTrailPoints(hex);

            const segments: GeoFeature[] = [];

            let prev: FlightTrailCache["last"] = null;

            points.forEach(function(p) {

                let lon = p[0];

                if (prev) {
                    while (lon - prev[0] > 180) lon -= 360;
                    while (lon - prev[0] < -180) lon += 360;
                }

                const cur: NonNullable<FlightTrailCache["last"]> = [lon, p[1], p[2]];

                if (prev) {

                    const alt = prev[2] != null && cur[2] != null
                        ? (prev[2] + cur[2]) / 2
                        : (cur[2] != null ? cur[2] : prev[2]);

                    segments.push({
                        type: "Feature",
                        properties: { color: flightAltitudeColor(alt) },
                        geometry: {
                            type: "LineString",
                            coordinates: [[prev[0], prev[1]], [cur[0], cur[1]]]
                        }
                    });

                }

                prev = cur;

            });

            flightTrailCache = { key: key, features: segments, last: prev };

        }

        features = flightTrailCache.features.slice();

        const rec = flightStore.get(hex);

        const last = flightTrailCache.last;

        // From the last known point to where the aircraft is now
        if (rec && last) {

            const pos = predictPosition(rec, now);

            let lon = pos.lon;

            while (lon - last[0] > 180) lon -= 360;
            while (lon - last[0] < -180) lon += 360;

            features.push({
                type: "Feature",
                properties: {
                    color: flightAltitudeColor(rec.onGround ? 0 : rec.alt)
                },
                geometry: {
                    type: "LineString",
                    coordinates: [[last[0], last[1]], [lon, pos.lat]]
                }
            });

        }

    }

    source.setData({ type: "FeatureCollection", features: features });

    setFlightText("fTrailNote", hex ? flightTrailNote(hex) : "");

}


// ----- origin / destination (adsbdb, via the relay) -----

function flightRouteKey(rec: FlightRecord): string {

    const callsign = String(rec.callsign || "").trim().toUpperCase();

    return /^[A-Z0-9]{3,8}$/.test(callsign) ? callsign : "";
}

const flightRouteRetryAt = new Map<string, number>();

// Callsigns already looked up with precise=1 (AirLabs allowed)
const flightRoutePreciseDone = new Set<string>();

// precise = true only for the aircraft you clicked: the relay may then ask
// AirLabs (small free monthly quota). Background lookups, like the airport
// arrivals list, never spend AirLabs requests.
async function loadFlightRoute(rec: FlightRecord, precise?: boolean): Promise<void> {

    const callsign = flightRouteKey(rec);

    if (!callsign) return;

    if (flightRouteCache.has(callsign) &&
        (!precise || flightRoutePreciseDone.has(callsign))) return;

    if (flightRoutePending.has(callsign)) return;

    if (Date.now() < (flightRouteRetryAt.get(callsign) || 0)) return;

    flightRoutePending.add(callsign);

    const hex = rec.hex;

    const query = new URLSearchParams({ callsign: callsign });

    if (/^[0-9a-f]{6}$/.test(hex || "")) query.set("hex", hex);
    if (precise) query.set("precise", "1");

    try {

        const response = await fetch(
            `${FLIGHT_ROUTE_PATH}?${query}`,
            { cache: "no-store" }
        );

        if (response.status === 404 || response.status === 429 || !response.ok) {
            // Relay missing or rate limited: try again later, don't cache
            flightRouteRetryAt.set(callsign, Date.now() + 60000);
            return;
        }

        const data = await response.json();

        const route = data && data.found && data.route ? data.route : null;

        // "airlabs" (matched by aircraft, trusted) or "adsbdb" (by callsign, checked)
        if (route) route.source = data.source || "adsbdb";

        flightRouteCache.set(callsign, route);

        if (precise) flightRoutePreciseDone.add(callsign);

    } catch (error) {

        flightRouteRetryAt.set(callsign, Date.now() + 60000);

        return;

    } finally {

        flightRoutePending.delete(callsign);

    }

    const current = selectedFlightHex === hex && flightStore.get(hex);

    if (current && flightRouteKey(current) === callsign) {
        updateFlightPanel(Date.now());
    }

}

function formatFlightKm(km: number): string {
    return `${Math.round(km).toLocaleString("en-US")} km`;
}

function airportLabel(a: AnyAirport | null | undefined): string {
    return a ? (a.iata || a.icao || "--") : "--";
}

function airportName(a: AnyAirport | null | undefined): string {

    if (!a) return "";

    return [a.city || a.name, a.country].filter(Boolean).join(", ");
}

function clearFlightRouteMap(): void {

    lastFlightRouteGeoJSON = { type: "FeatureCollection", features: [] };

    flightRouteDrawn = "";

    const source = map && flightGeoSource(FLIGHT_ROUTE_SOURCE);

    if (source) source.setData(lastFlightRouteGeoJSON);

}

let flightRouteDrawn = "";

// adsbdb looks routes up by callsign only, and airlines reuse flight numbers
// for different routes, so the route on file can belong to another flight.
// Returns "" when the route fits this aircraft, or a short reason when not.
const ROUTE_TAKEOFF_MAX_KM = 120;   // takeoff point must be this close to the origin
const ROUTE_MIN_OFF_TRACK_KM = 250; // allowed distance off the direct line...
const ROUTE_OFF_TRACK_SHARE = 0.08; // ...or 8% of the route length if that's more
const ROUTE_MAX_HEADING_DIFF = 60;  // degrees between heading and destination

function routeMismatchReason(route: FlightRoute, rec: FlightRecord, pos: LatLon): string {

    const o = route.origin, d = route.destination;

    const total = flightDistanceKm(o.lat, o.lon, d.lat, d.lon);
    const fromOrigin = flightDistanceKm(o.lat, o.lon, pos.lat, pos.lon);
    const toDest = flightDistanceKm(pos.lat, pos.lon, d.lat, d.lon);

    // 1. Where did this aircraft take off? If the OpenSky path starts on the
    //    ground or low down, its first point is the real departure airport.
    const track = rec.hex && flightTrackCache.get(rec.hex);

    if (track && track.state === "ok" && track.points.length) {

        const first = track.points[0];   // [lon, lat, feet, time]

        if (first[2] != null && first[2] < 3000 &&
            flightDistanceKm(first[1], first[0], o.lat, o.lon) > ROUTE_TAKEOFF_MAX_KM) {
            return "took off somewhere else";
        }
    }

    // 2. The aircraft should be roughly between the two airports...
    if (fromOrigin > total + 150 || toDest > total + 150) {
        return "not between these airports";
    }

    // ...and close to the line joining them (cross-track distance)
    const R = 6371;
    const rad = Math.PI / 180;
    const angle = (flightBearing(o.lat, o.lon, pos.lat, pos.lon) -
        flightBearing(o.lat, o.lon, d.lat, d.lon)) * rad;
    const offTrack = Math.abs(Math.asin(Math.sin(fromOrigin / R) * Math.sin(angle))) * R;

    if (offTrack > Math.max(ROUTE_MIN_OFF_TRACK_KM, total * ROUTE_OFF_TRACK_SHARE)) {
        return `${formatFlightKm(offTrack)} off the route`;
    }

    // 3. Mid-flight, it should be pointing roughly at the destination
    if (!rec.onGround && rec.track != null && isFinite(rec.track) &&
        fromOrigin > 150 && toDest > 400) {

        const toward = flightBearing(pos.lat, pos.lon, d.lat, d.lon);

        if (angleDifference(rec.track, toward) > ROUTE_MAX_HEADING_DIFF) {
            return "not heading to the destination";
        }
    }

    return "";
}

// ----- departure airport read from the OpenSky path (last-resort source) -----
// If the path starts on the ground or low down, the nearest airport to its
// first point is where the aircraft took off. Free, and never out of date,
// but it can't tell us the destination.

const TAKEOFF_MAX_FEET = 3000;      // first point must be this low
const TAKEOFF_AIRPORT_MAX_KM = 25;  // and this close to an airport

const flightTakeoffCache = new Map<string, { fetchedAt: number; size: number; airport: Airport | null }>();   // hex -> { fetchedAt, size, airport }

function flightTakeoffAirport(hex: string): Airport | null {

    const track = hex && flightTrackCache.get(hex);

    if (!track || track.state !== "ok" || !track.points.length || !flightAirportIndex.size) {
        return null;
    }

    const hit = flightTakeoffCache.get(hex);

    if (hit && hit.fetchedAt === track.fetchedAt && hit.size === flightAirportIndex.size) {
        return hit.airport;
    }

    const first = track.points[0];      // [lon, lat, feet, time]

    let best = null;
    let bestKm = TAKEOFF_AIRPORT_MAX_KM;

    if (first[2] != null && first[2] < TAKEOFF_MAX_FEET) {

        flightAirportIndex.forEach(function(a) {

            if (Math.abs(a.lat - first[1]) > 0.5) return;   // quick skip

            const km = flightDistanceKm(first[1], first[0], a.lat, a.lon);

            if (km < bestKm) {
                best = a;
                bestKm = km;
            }
        });
    }

    flightTakeoffCache.set(hex, {
        fetchedAt: track.fetchedAt,
        size: flightAirportIndex.size,
        airport: best
    });

    return best;
}

// Puts features on the route layer, skipping the update if nothing changed
function drawFlightRouteFeatures(key: string, makeFeatures: () => GeoFeature[]): void {

    if (key === flightRouteDrawn) return;

    if (!key) {
        clearFlightRouteMap();
        return;
    }

    flightRouteDrawn = key;

    lastFlightRouteGeoJSON = { type: "FeatureCollection", features: makeFeatures() };

    const source = flightGeoSource(FLIGHT_ROUTE_SOURCE);

    if (source) source.setData(lastFlightRouteGeoJSON);
}

// Fills the route block in the panel and draws the planned line on the map.
// Sources, best first: AirLabs -> adsbdb -> departure airport from the path.
function renderFlightRoute(rec: FlightRecord, pos: LatLon): void {

    const block = flightEl("fRoute");

    if (!block) return;

    const callsign = flightRouteKey(rec);

    const hasEntry = callsign && flightRouteCache.has(callsign);

    const route = hasEntry ? flightRouteCache.get(callsign) : null;

    const valid = route && route.origin && route.destination &&
        isFinite(route.origin.lat) && isFinite(route.origin.lon) &&
        isFinite(route.destination.lat) && isFinite(route.destination.lon);

    const takeoff = flightTakeoffAirport(rec.hex);

    if (!callsign && !takeoff) {
        block.style.display = "none";
        clearFlightRouteMap();
        return;
    }

    block.style.display = "block";

    const bar = flightEl("fRouteBar");

    // AirLabs matches the aircraft itself, so trust it. adsbdb only knows
    // the callsign, so check its route against what the aircraft is doing.
    const reason = valid && route.source !== "airlabs"
        ? routeMismatchReason(route, rec, pos)
        : "";

    // ---- full route (AirLabs, or adsbdb that passed the check) ----
    if (valid && !reason) {

        const o = route.origin, d = route.destination;

        const flown = flightDistanceKm(o.lat, o.lon, pos.lat, pos.lon);
        const left = flightDistanceKm(pos.lat, pos.lon, d.lat, d.lon);

        setFlightText("fRouteFrom", airportLabel(o));
        setFlightText("fRouteFromName", airportName(o));
        setFlightText("fRouteTo", airportLabel(d));
        setFlightText("fRouteToName", airportName(d));

        if (bar) {
            const progress = rec.onGround && flown < 5
                ? 0
                : clampNumber(flown / Math.max(flown + left, 1), 0, 1);
            bar.style.width = `${(progress * 100).toFixed(1)}%`;
        }

        const parts = [];

        if (route.airline && route.airline.name) parts.push(route.airline.name);

        parts.push(`${formatFlightKm(flown)} flown`);
        parts.push(`${formatFlightKm(left)} to go`);
        parts.push(route.source === "airlabs" ? "AirLabs" : "adsbdb");

        setFlightText("fRouteInfo", parts.join(" · "));

        drawFlightRouteFeatures(
            callsign + "|" + airportLabel(o) + airportLabel(d),
            function() {
                const line = flightGreatCircle(o.lat, o.lon, d.lat, d.lon, 64);
                return [
                    { type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: line } },
                    { type: "Feature", properties: { kind: "origin" }, geometry: { type: "Point", coordinates: line[0] } },
                    { type: "Feature", properties: { kind: "destination" }, geometry: { type: "Point", coordinates: line[line.length - 1] } }
                ];
            }
        );

        return;
    }

    // ---- no trustworthy route: show at least where it took off ----
    if (bar) bar.style.width = "0%";

    setFlightText("fRouteTo", "--");
    setFlightText("fRouteToName", "");

    const notes = [];

    if (valid && reason) {
        notes.push(
            `Listed route ${airportLabel(route.origin)} → ${airportLabel(route.destination)} ` +
            `doesn't match this flight (${reason}; the callsign is probably reused)`
        );
    }

    if (takeoff) {

        setFlightText("fRouteFrom", airportLabel(takeoff));
        setFlightText("fRouteFromName", airportName(takeoff));

        notes.unshift(
            callsign && !hasEntry
                ? "Departure from flight path · looking up destination..."
                : "Departure from flight path · destination unknown"
        );

        drawFlightRouteFeatures("takeoff|" + takeoff.icao, function() {
            return [{
                type: "Feature",
                properties: { kind: "origin" },
                geometry: { type: "Point", coordinates: [takeoff.lon, takeoff.lat] }
            }];
        });

    } else {

        setFlightText("fRouteFrom", "--");
        setFlightText("fRouteFromName", "");

        if (!notes.length) {
            notes.push(hasEntry ? "Route not found for this callsign" : "Looking up route...");
        }

        clearFlightRouteMap();
    }

    setFlightText("fRouteInfo", notes.join(" · "));
}


// ==============================================
// F8. HUD, NOTICE AND SIDEBAR STATUS
// ==============================================

function setFlightStatus(text: string): void {
    setFlightText("flightHudStatus", text);
}

function showFlightNotice(message: string): void {

    const el = flightEl("flightNotice");

    if (!el) return;

    el.textContent = message;

    el.classList.toggle("visible", Boolean(message));

}

function updateFlightHud(): void {

    const count = flightStore.size;

    setFlightText("flightHudCount", count.toLocaleString("en-US"));

    setFlightText(
        "flightCount",
        flightsEnabled ? count.toLocaleString("en-US") : "OFF"
    );

}

function buildFlightLegend(): void {

    const legend = flightEl("flightLegend");

    if (!legend || legend.childElementCount) return;

    // Altitude scale for the path of the selected aircraft
    const scale = document.createElement("div");
    scale.className = "flight-alt-scale";

    const top = FLIGHT_ALT_STOPS[FLIGHT_ALT_STOPS.length - 1][0];

    const bar = document.createElement("div");
    bar.className = "flight-alt-bar";
    bar.style.background = "linear-gradient(90deg, " +
        FLIGHT_ALT_STOPS.map(s => `${s[1]} ${(s[0] / top * 100).toFixed(0)}%`).join(", ") + ")";

    const labels = document.createElement("div");
    labels.className = "flight-alt-labels";

    ["0", "15k", "25k", "35k", "45k ft"].forEach(function(text) {
        const span = document.createElement("span");
        span.textContent = text;
        labels.appendChild(span);
    });

    const title = document.createElement("div");
    title.className = "flight-alt-title";
    title.textContent = "PATH ALTITUDE (SELECT AN AIRCRAFT)";

    scale.appendChild(title);
    scale.appendChild(bar);
    scale.appendChild(labels);

    legend.appendChild(scale);

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

function addFlightBadge(container: HTMLElement, text: string, className?: string): void {

    const badge = document.createElement("span");

    badge.className = "flight-badge " + className;

    badge.textContent = text;

    container.appendChild(badge);

}

function updateFlightPanel(now: number): void {

    const panel = flightEl("flightPanel");

    if (!panel || !selectedFlightHex) return;

    const stored = flightStore.get(selectedFlightHex);

    const rec = stored ? displayRecord(stored) : null;

    const badges = flightRequiredEl("fBadges");

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
        rec.typeDesc || rec.type ||
            (rec.country ? "Limited details (world view)" : "Unknown aircraft type")
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
    setFlightText(
        "fOperatorLabel",
        !rec.operator && rec.country ? "REGISTERED IN" : "OPERATOR"
    );
    setFlightText("fOperator", rec.operator || rec.country || "--");
    setFlightText(
        "fPosition",
        `${pos.lat.toFixed(5)}, ${pos.lon.toFixed(5)}`
    );


    renderFlightRoute(rec, pos);

    const watchButton = flightEl("watchFlight");

    if (watchButton) {
        const watched = Boolean(watchlistEntryFor(rec));
        watchButton.textContent = watched ? "REMOVE FROM WATCHLIST" : "ADD TO WATCHLIST";
        watchButton.classList.toggle("watched", watched);
    }

    if (watchlistEntryFor(rec)) addFlightBadge(badges, "WATCHED", "watched");
    if (rec.emergency) addFlightBadge(badges, "EMERGENCY", "emergency");
    if (rec.military) addFlightBadge(badges, "MILITARY", "military");
    if (rec.onGround) addFlightBadge(badges, "ON GROUND", "ground");


    // External link (only for real 6-digit ICAO hex codes)

    const link = flightEl("flightExternalLink") as HTMLAnchorElement | null;

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
// F9a. AIRCRAFT DETAILS (adsbdb, via the relay)
//
// The world feed has no registration or type. When you select an aircraft
// (or search a registration) the relay looks it up once and caches it.
// ==============================================

const cleanInfoText = (value: unknown): string => (typeof value === "string" ? value.trim() : "");

// Returns details, null (adsbdb doesn't know it) or undefined (lookup unavailable).
async function fetchAircraftInfo(identifier: string): Promise<AircraftInfo | null | undefined> {

    if (flightProxyOk === false || !/^https?:$/.test(location.protocol)) {
        return undefined;
    }

    try {

        const response = await fetch(
            `${FLIGHT_AIRCRAFT_PATH}?id=${encodeURIComponent(identifier)}`
        );

        if (!response.ok) return undefined;

        const json = await response.json();

        if (!json.found || !json.aircraft) return null;

        const a = json.aircraft;

        return {
            hex: cleanInfoText(a.mode_s).toLowerCase(),
            registration: cleanInfoText(a.registration),
            icaoType: cleanInfoText(a.icao_type),
            type: cleanInfoText(a.type),
            manufacturer: cleanInfoText(a.manufacturer),
            owner: cleanInfoText(a.owner),
            country: cleanInfoText(a.country)
        };

    }

    catch (error) {

        return undefined;

    }

}

// The stored record plus anything adsbdb told us about that aircraft.
function displayRecord(rec: FlightRecord): FlightRecord {

    const info = flightInfoCache.get(rec.hex);

    if (!info) return rec;

    const merged = Object.assign({}, rec);

    if (!merged.reg) merged.reg = info.registration;
    if (!merged.type) merged.type = info.icaoType;

    if (!merged.typeDesc) {
        merged.typeDesc = [info.manufacturer, info.type].filter(Boolean).join(" ");
    }

    if (!merged.operator) merged.operator = info.owner;

    return merged;
}

async function enrichFlight(rec: FlightRecord): Promise<void> {

    if (rec.reg && rec.type) return;                  // regional feed already has it

    if (!/^[0-9a-f]{6}$/.test(rec.hex)) return;

    if (flightInfoCache.has(rec.hex) || flightInfoPending.has(rec.hex)) return;

    flightInfoPending.add(rec.hex);

    const info = await fetchAircraftInfo(rec.hex);

    flightInfoPending.delete(rec.hex);

    if (info === undefined) return;                   // try again next time

    flightInfoCache.set(rec.hex, info);

    if (selectedFlightHex !== rec.hex) return;

    updateFlightPanel(Date.now());

    // A photo search by hex may have found nothing; try the registration now
    const current = flightStore.get(rec.hex);

    if (info && info.registration && current && flightPhotoCache.get(rec.hex) === null) {
        flightPhotoCache.delete(rec.hex);
        loadFlightPhoto(displayRecord(current));
    }

}


// ==============================================
// F9b. AIRCRAFT PHOTOS (Planespotters.net)
// ==============================================

function isTrustedPhotoUrl(value: string | undefined): boolean {

    try {

        const url = new URL(value ?? "");   // "" throws, so it counts as untrusted

        return url.protocol === "https:" && FLIGHT_PHOTO_HOSTS.some(
            host => url.hostname === host || url.hostname.endsWith("." + host)
        );

    }

    catch (error) {

        return false;

    }

}

// Returns an array of photos ([] = none exist) or null if the lookup failed.
async function fetchFlightPhotoData(kind: "hex" | "reg", value: string): Promise<FlightPhoto[] | null> {

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

function setFlightPhotoState(state: "photo" | "empty", message?: string): void {

    const link = flightEl("flightPhotoLink");
    const empty = flightEl("flightPhotoEmpty");
    const credit = flightEl("flightPhotoCredit");

    if (!link || !empty || !credit) return;

    link.style.display = state === "photo" ? "block" : "none";

    empty.style.display = state === "photo" ? "none" : "flex";
    empty.textContent = message || "";

    credit.style.display = state === "photo" ? "block" : "none";

}

function renderFlightPhoto(photo: FlightPhoto | null | undefined, rec: FlightRecord | null): void {

    const image = flightEl("flightPhoto") as HTMLImageElement | null;
    const link = flightEl("flightPhotoLink") as HTMLAnchorElement | null;
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

async function loadFlightPhoto(rec: FlightRecord): Promise<void> {

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


function selectFlight(hex: string): void {

    closeAirportPanel();

    if (typeof closeStationPanel === "function") closeStationPanel();

    closeWatchlistPanel();

    selectedFlightHex = hex;

    if (map.getLayer(FLIGHT_SELECTED_LAYER)) {
        map.setFilter(FLIGHT_SELECTED_LAYER, ["==", ["get", "hex"], hex]);
    }

    flightRequiredEl("flightPanel").classList.add("visible");

    const selected = flightStore.get(hex);

    if (selected) {
        loadFlightPhoto(displayRecord(selected));
        enrichFlight(selected);
        loadFlightRoute(selected, true);
    }

    flightRouteDrawn = "";

    flightTrailCache = { key: "", features: [], last: null };

    loadFlightTrack(hex);

    updateFlightPanel(Date.now());

    updateFlightTrail(Date.now());

}

function deselectFlight(): void {

    selectedFlightHex = null;

    flightPhotoRequestId++;     // cancels any photo lookup still in flight

    setFollowFlight(false);

    if (map && map.getLayer(FLIGHT_SELECTED_LAYER)) {
        map.setFilter(FLIGHT_SELECTED_LAYER, ["==", ["get", "hex"], ""]);
    }

    const panel = flightEl("flightPanel");

    if (panel) panel.classList.remove("visible");

    const trailSource = map && flightGeoSource(FLIGHT_TRAIL_SOURCE);

    if (trailSource) {
        trailSource.setData({
            type: "FeatureCollection",
            features: []
        });
    }

    flightTrailCache = { key: "", features: [], last: null };

    setFlightText("fTrailNote", "");

    clearFlightRouteMap();

}

function setFollowFlight(on: boolean): void {

    followFlight = on;

    const button = flightEl("followFlight");

    if (!button) return;

    button.classList.toggle("toggled", on);

    button.textContent = on ? "FOLLOWING AIRCRAFT" : "FOLLOW AIRCRAFT";

}

function pinSelectedFlight(): void {

    const stored = selectedFlightHex ? flightStore.get(selectedFlightHex) : undefined;

    if (!stored) return;

    const rec = displayRecord(stored);

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

// Where a point feature (aircraft or airport pin) sits on the map
function featureLngLat(feature: MapFeature): [number, number] {

    const geometry = feature.geometry;

    return geometry.type === "Point"
        ? [geometry.coordinates[0], geometry.coordinates[1]]
        : [0, 0];
}

function flightFeatureAt(point: MapPoint): MapFeature | null {

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
function isFlightAtPoint(point: MapPoint): boolean {
    return Boolean(flightFeatureAt(point)) ||
        (flightsEnabled && Boolean(airportFeatureAt(point)));
}

function onFlightHover(e: MapMouseEvent): void {

    const feature = flightsEnabled ? flightFeatureAt(e.point) : null;

    if (!feature) {

        const airport = flightsEnabled ? airportFeatureAt(e.point) : null;

        if (airport) {

            map.getCanvas().style.cursor = "pointer";

            const p = airport.properties;

            flightHoverPopup
                .setLngLat(featureLngLat(airport))
                .setText(`${p.iata || p.icao}  |  ${p.name}`)
                .addTo(map);

            return;
        }

        map.getCanvas().style.cursor = "";

        flightHoverPopup.remove();

        return;

    }

    const stored = flightStore.get(feature.properties.hex);

    const rec = stored ? displayRecord(stored) : null;

    map.getCanvas().style.cursor = "pointer";

    const label = rec
        ? [
            rec.callsign || rec.reg || rec.hex.toUpperCase(),
            rec.type || "?",
            rec.onGround ? "GND" : rec.alt == null ? "--" : `${Math.round(rec.alt).toLocaleString("en-US")} ft`
          ].join("  |  ")
        : feature.properties.callsign || feature.properties.hex;

    flightHoverPopup
        .setLngLat(featureLngLat(feature))
        .setText(label)
        .addTo(map);

}

function onFlightClick(e: MapMouseEvent): void {

    if (!flightsEnabled) return;

    const feature = flightFeatureAt(e.point);

    if (feature) {
        selectFlight(feature.properties.hex);
        return;
    }

    const airport = airportFeatureAt(e.point);

    if (airport) selectAirport(airport.properties.icao);

}

function showFlightFound(rec: FlightRecord): void {

    const pos = predictPosition(rec, Date.now());

    map.flyTo({
        center: [pos.lon, pos.lat],
        zoom: Math.max(map.getZoom(), 8),
        essential: true
    });

    selectFlight(rec.hex);

}

// Registrations look like C-FABC, N123AB, G-EZBK, VH-OQA (a hyphen or a digit),
// which keeps ordinary place names from triggering a lookup.
function looksLikeRegistration(q: string): boolean {
    return /^[a-z0-9]{1,2}-?[a-z0-9]{2,6}$/i.test(q) && /[0-9-]/.test(q);
}

// ----- airports in the search box -----

function normaliseSearchText(text: unknown): string {
    return String(text || "")
        .normalize("NFD").replace(/[̀-ͯ]/g, "")   // Málaga -> Malaga
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, " ")
        .trim();
}

// Airports whose code, name or city contain every word of the query,
// best match first (exact code, then big airports, then shorter names).
function flightAirportMatches(query: string, max?: number): Airport[] {

    const q = normaliseSearchText(query);

    if (!flightsEnabled || q.length < 3 || !flightAirportIndex.size) return [];

    const words = q.split(" ");

    const found: { airport: Airport; score: number }[] = [];

    flightAirportIndex.forEach(function(a) {

        if (!a.searchText) {
            a.searchText = normaliseSearchText([a.iata, a.icao, a.name, a.city].join(" "));
        }

        const text = a.searchText;

        const code = q === a.iata.toLowerCase() || q === a.icao.toLowerCase();

        if (!code && !words.every(w => text.includes(w))) return;

        found.push({
            airport: a,
            score: (code ? 0 : 10) + (a.kind === "L" ? 0 : 5) + a.name.length / 100
        });
    });

    found.sort((x, y) => x.score - y.score);

    return found.slice(0, max || 3).map(f => f.airport);
}

// What pressing Enter should open: an exact airport code ("BOS", "EGLL"),
// or a name search that says "airport" ("heathrow airport"). Plain place
// names like "Boston" still go to the normal location search.
function findAirportByQuery(query: string): Airport | null {

    const q = normaliseSearchText(query);

    if (!flightsEnabled || q.length < 3) return null;

    for (const a of flightAirportIndex.values()) {
        if (q === a.iata.toLowerCase() || q === a.icao.toLowerCase()) return a;
    }

    if (!/\bairport\b/.test(q)) return null;

    const rest = q.replace(/\b(airport|international|intl)\b/g, " ").trim();

    return rest.length >= 3 ? flightAirportMatches(rest, 1)[0] || null : null;
}

// Opens the airport panel exactly as if its pin had been clicked
function openAirportFromSearch(airport: Airport | null | undefined): boolean {

    if (!airport || !flightsEnabled) return false;

    selectAirport(airport.icao);

    return true;
}

// The airport pin closest to a point (within a few km), or null
function findAirportNear(lat: number, lon: number, maxKm?: number): Airport | null {

    if (!flightsEnabled) return null;

    let best = null;
    let bestKm = maxKm || 6;

    flightAirportIndex.forEach(function(a) {

        if (Math.abs(a.lat - lat) > 0.3) return;

        const km = flightDistanceKm(lat, lon, a.lat, a.lon);

        if (km < bestKm) {
            best = a;
            bestKm = km;
        }
    });

    return best;
}

// For a location search that landed on an airport: open that pin's panel.
// address = the place's address from the search, shown in the panel.
function openAirportNear(lat: number, lon: number, address?: string): boolean {

    const airport = findAirportNear(lat, lon);

    if (airport && address) rememberAirportAddress(airport, address);

    return openAirportFromSearch(airport);
}

// ----- airport street address (OpenStreetMap Nominatim) -----

const airportAddressCache = new Map<string, string>();   // icao -> address text ("" = none found)
const airportAddressPending = new Set<string>();

// "Boston Logan International Airport, Harborside Drive, East Boston, ..."
// -> drop the leading airport name, the panel already shows it
function tidyAirportAddress(airport: Airport, displayName: unknown): string {

    const parts = String(displayName || "").split(",").map(p => p.trim()).filter(Boolean);

    if (parts.length > 1) {

        const first = normaliseSearchText(parts[0]);
        const name = normaliseSearchText(airport.name);

        if (first === name || /\b(airport|aeropuerto|aeroport|aeroporto|flughafen)\b/.test(first)) {
            parts.shift();
        }
    }

    return parts.join(", ");
}

function rememberAirportAddress(airport: Airport, displayName: unknown): void {

    const address = tidyAirportAddress(airport, displayName);

    if (!address) return;

    airportAddressCache.set(airport.icao, address);

    if (selectedAirport && selectedAirport.icao === airport.icao) {
        setFlightText("airportAddress", address);
    }
}

// Looks the address up once per airport: by name first (must land near the
// pin), otherwise whatever is at the pin itself.
async function loadAirportAddress(airport: Airport): Promise<void> {

    if (airportAddressCache.has(airport.icao) || airportAddressPending.has(airport.icao)) return;

    airportAddressPending.add(airport.icao);

    const base = "https://nominatim.openstreetmap.org";
    const options = { headers: { "Accept": "application/json" } };

    let address = "";

    try {

        const byName = await fetch(
            `${base}/search?format=jsonv2&limit=3&q=${encodeURIComponent(airport.name)}`,
            options
        );

        const results: NominatimPlace[] = byName.ok ? await byName.json() : [];

        const match = results.find(r =>
            flightDistanceKm(Number(r.lat), Number(r.lon), airport.lat, airport.lon) < 10);

        if (match) {

            address = tidyAirportAddress(airport, match.display_name);

        } else {

            const atPin = await fetch(
                `${base}/reverse?format=jsonv2&zoom=16&lat=${airport.lat}&lon=${airport.lon}`,
                options
            );

            const place = atPin.ok ? await atPin.json() : null;

            if (place && place.display_name) {
                address = tidyAirportAddress(airport, place.display_name);
            }
        }

        airportAddressCache.set(airport.icao, address);

    } catch (error) {
        // Lookup failed: leave it uncached so opening the airport again retries
    } finally {
        airportAddressPending.delete(airport.icao);
    }

    if (address && selectedAirport && selectedAirport.icao === airport.icao) {
        setFlightText("airportAddress", address);
    }
}

// ==============================================
// F10b. LOCATE ONE AIRCRAFT ANYWHERE
//
// The regional feed only covers what is on screen. To find a specific
// flight, the feeds are asked for it directly by hex, callsign or
// registration, and the map then flies to wherever it is.
// ==============================================

// Shows a message at the bottom of the map, then clears it again
function flashFlightNotice(message: string, ms = 6000): void {

    showFlightNotice(message);

    setTimeout(function() {

        const notice = flightEl("flightNotice");

        if (notice && notice.textContent === message) showFlightNotice("");

    }, ms);
}

// Which lookups are worth trying for what the user typed, in order.
// Empty when the text doesn't look like an aircraft at all (a place name).
function flightLookupPlan(query: string): [kind: FlightLookupKind, value: string][] {

    const q = String(query).trim().toUpperCase();

    const plan: [FlightLookupKind, string][] = [];

    // Callsigns: ACA123, BAW12AB, N123AB (letters and digits, no spaces)
    if (/^[A-Z0-9]{3,8}$/.test(q) && /[A-Z]/.test(q) && /\d/.test(q)) plan.push(["callsign", q]);

    if (looksLikeRegistration(q)) plan.push(["reg", q]);

    // ACA123 is also a valid hex code, but it is far more likely the airline
    // callsign: an airline-style text tries hex last, anything else first.
    if (/^[0-9A-F]{6}$/.test(q)) {
        if (/^[A-Z]{3}\d/.test(q)) plan.push(["hex", q.toLowerCase()]);
        else plan.unshift(["hex", q.toLowerCase()]);
    }

    return plan;
}

// Newest usable position in a feed's answer, as one of our records
function pickLookupRecord(list: AdsbAircraft[], receivedAt: number): FlightRecord | null {

    let best: FlightRecord | null = null;

    for (const raw of list) {

        const rec = parseAircraft(raw, receivedAt);

        if (!rec || receivedAt - rec.t0 > FLIGHT_LOCATE_MAX_AGE_MS) continue;

        if (!best || rec.t0 > best.t0) best = rec;

    }

    return best;
}

// Returns the aircraft, null (no feed is receiving it right now)
// or undefined (the lookup itself failed).
async function fetchFlightLookup(kind: FlightLookupKind, value: string): Promise<FlightRecord | null | undefined> {

    const attempts: { name: string; url: string; proxy?: boolean }[] = [];

    if (flightProxyOk !== false && /^https?:$/.test(location.protocol)) {
        attempts.push({
            name: "local proxy",
            url: `${FLIGHT_LOCATE_PATH}?kind=${kind}&value=${encodeURIComponent(value)}`,
            proxy: true
        });
    }

    const now = Date.now();

    const finders = FLIGHT_FEEDS.filter(f => f.find);

    let feeds = finders.filter(f => (flightFeedCooldown.get(f.name) || 0) <= now);

    if (!feeds.length) feeds = finders;

    feeds.forEach(function(f) {
        if (f.find) attempts.push({ name: f.name, url: f.find(kind, value) });
    });

    let answered = false;

    for (const attempt of attempts) {

        if (!attempt.proxy) await waitForFlightSlot();

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 15000);

        try {

            const response = await fetch(attempt.url, { signal: controller.signal });

            if (!response.ok) {
                const error: FlightFetchError = new Error(`${attempt.name}: HTTP ${response.status}`);
                error.status = response.status;
                throw error;
            }

            const json = await response.json();

            const list: AdsbAircraft[] = Array.isArray(json.ac) ? json.ac : [];

            answered = true;

            const rec = pickLookupRecord(list, Date.now());

            if (rec) {
                rememberFlightDetails(rec);
                return applyKnownDetails(rec);
            }

            // The relay has already asked every feed
            if (attempt.proxy) return null;

        }

        catch (caught) {

            const error = asFetchError(caught);

            console.warn("Flight lookup failed:", attempt.name, error.message);

            // (A relay without /api/locate just falls through to the feeds;
            // it keeps working for everything else.)
            if (!attempt.proxy && error.status === 429) {
                flightFeedCooldown.set(attempt.name, Date.now() + 60000);
            }

        }

        finally {

            clearTimeout(timer);

        }

    }

    return answered ? null : undefined;
}

// Same three answers as fetchFlightLookup, trying each way of reading the text
async function locateFlightAnywhere(query: string): Promise<FlightRecord | null | undefined> {

    const plan = flightLookupPlan(query);

    let failed = !plan.length;

    for (const step of plan) {

        const rec = await fetchFlightLookup(step[0], step[1]);

        if (rec) return rec;

        if (rec === undefined) failed = true;

    }

    return failed ? undefined : null;
}

// A located aircraft is usually outside the area the feed last covered.
// Keep it in the data until the map has moved there and loaded that area.
function keepLocatedFlight(next: Map<string, FlightRecord>): void {

    if (!flightLocated) return;

    if (Date.now() - flightLocated.at > FLIGHT_LOCATE_KEEP_MS) {
        flightLocated = null;
        return;
    }

    if (!next.has(flightLocated.rec.hex)) {
        next.set(flightLocated.rec.hex, flightLocated.rec);
    }
}

// Put an aircraft found by a worldwide lookup on the map and fly to it
function showLocatedFlight(rec: FlightRecord): void {

    flightLocated = { rec: rec, at: Date.now() };

    const current = flightStore.get(rec.hex);

    if (!current || current.t0 < rec.t0) flightStore.set(rec.hex, rec);

    watchlistDirty = true;

    tickFlights(true);

    showFlightFound(flightStore.get(rec.hex) || rec);
}


// ==============================================
// F10c. WATCHLIST
//
// Aircraft (by hex) or flights (by callsign / registration) the user wants
// to keep an eye on. Saved in the browser. Watched aircraft get a green
// ring on the map; the ones that are not on screen are looked up worldwide
// one at a time, so the list can say whether each one is flying.
// ==============================================

// Hex, callsign and registration all compared as A-Z 0-9 (C-FABC = CFABC)
function watchKey(text: unknown): string {
    return String(text || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function watchlistEntryFor(rec: FlightRecord): WatchlistEntry | undefined {

    if (!watchlist.length) return undefined;

    const hex = rec.hex.toUpperCase();
    const callsign = watchKey(rec.callsign);
    const reg = watchKey(rec.reg);

    return watchlist.find(
        e => e.key === hex || (callsign !== "" && e.key === callsign) || (reg !== "" && e.key === reg)
    );
}

function watchStatusFor(key: string): WatchlistStatus {

    let status = watchlistStatus.get(key);

    if (!status) {
        status = { known: false, rec: null, checkedAt: 0, alertedAt: 0 };
        watchlistStatus.set(key, status);
    }

    return status;
}

function loadWatchlist(): void {

    try {

        const saved: unknown = JSON.parse(localStorage.getItem(FLIGHT_WATCH_KEY) || "[]");

        if (!Array.isArray(saved)) return;

        const seen = new Set<string>();

        watchlist = [];

        saved.forEach(function(item: Partial<WatchlistEntry> | null) {

            if (!item || typeof item.key !== "string" || typeof item.query !== "string") return;

            const key = watchKey(item.key);

            if (key.length < 3 || seen.has(key) || watchlist.length >= FLIGHT_WATCH_MAX) return;

            seen.add(key);

            watchlist.push({
                key: key,
                query: item.query.slice(0, 12),
                label: (typeof item.label === "string" && item.label ? item.label : key).slice(0, 16),
                addedAt: Number(item.addedAt) || Date.now()
            });

        });

    } catch (error) {
        watchlist = [];     // storage unavailable or damaged: start empty
    }
}

function saveWatchlist(): void {

    try {
        localStorage.setItem(FLIGHT_WATCH_KEY, JSON.stringify(watchlist));
    } catch (error) {
        // Storage unavailable: the list just won't persist
    }
}

// quiet = don't announce it if it is already on the map (the user can see it)
function addWatch(key: string, query: string, label: string, quiet: boolean): boolean {

    if (watchlist.some(e => e.key === key)) return false;

    if (watchlist.length >= FLIGHT_WATCH_MAX) {
        flashFlightNotice(`WATCHLIST IS FULL (${FLIGHT_WATCH_MAX}) - REMOVE ONE FIRST`);
        return false;
    }

    watchlist.push({ key: key, query: query, label: label, addedAt: Date.now() });

    watchStatusFor(key).alertedAt = quiet ? Date.now() : 0;

    saveWatchlist();

    watchlistDirty = true;

    tickFlights(true);

    return true;
}

function removeWatch(key: string): void {

    watchlist = watchlist.filter(e => e.key !== key);

    watchlistStatus.delete(key);

    saveWatchlist();

    watchlistDirty = true;

    tickFlights(true);
}

// Which watched aircraft are in the feed data right now
function scanWatchlist(now: number): void {

    watchlistDirty = false;
    watchlistScannedStore = flightStore;

    const live = new Map<string, FlightRecord>();
    const hexes = new Set<string>();

    if (watchlist.length) {

        const byKey = new Map<string, WatchlistEntry>();

        watchlist.forEach(e => byKey.set(e.key, e));

        flightStore.forEach(function(rec) {

            const entry =
                byKey.get(rec.hex.toUpperCase()) ||
                (rec.callsign ? byKey.get(watchKey(rec.callsign)) : undefined) ||
                (rec.reg ? byKey.get(watchKey(rec.reg)) : undefined);

            if (!entry) return;

            hexes.add(rec.hex);

            if (!live.has(entry.key)) live.set(entry.key, rec);

        });

    }

    const arrived: string[] = [];

    live.forEach(function(rec, key) {

        const status = watchStatusFor(key);

        status.known = true;
        status.rec = rec;
        status.checkedAt = now;

        if (!watchlistLive.has(key) && now - status.alertedAt > FLIGHT_WATCH_ALERT_GAP_MS) {

            status.alertedAt = now;

            const entry = watchlist.find(e => e.key === key);

            if (entry) arrived.push(entry.label);

        }

    });

    watchlistLive = live;
    watchlistHexes = hexes;

    if (arrived.length) {
        flashFlightNotice(`WATCHLIST: ${arrived.join(", ")} ON THE MAP`);
    }

    renderWatchlist(now);
}

function watchAltitudeText(rec: FlightRecord): string {
    if (rec.onGround) return "ON GROUND";
    if (rec.alt == null) return "";
    return `${Math.round(rec.alt).toLocaleString("en-US")} FT`;
}

function watchlistRowState(entry: WatchlistEntry, now: number): { state: string; detail: string } {

    const live = watchlistLive.get(entry.key);

    if (live) {

        const callsign = live.callsign && watchKey(live.callsign) !== watchKey(entry.label)
            ? live.callsign : "";

        return {
            state: "live",
            detail: ["ON THE MAP", callsign, watchAltitudeText(live)].filter(Boolean).join(" · ")
        };
    }

    const status = watchlistStatus.get(entry.key);

    if (!status || !status.known) {
        return {
            state: "unknown",
            detail: flightsEnabled ? "CHECKING..." : "TURN ON FLIGHT TRACKING TO CHECK"
        };
    }

    if (status.rec && now - status.checkedAt < FLIGHT_WATCH_STALE_MS * 2) {
        return {
            state: "away",
            detail: [
                status.rec.onGround ? "TRANSMITTING" : "FLYING",
                status.rec.callsign && watchKey(status.rec.callsign) !== watchKey(entry.label)
                    ? status.rec.callsign : "",
                watchAltitudeText(status.rec),
                "CLICK TO LOCATE"
            ].filter(Boolean).join(" · ")
        };
    }

    return {
        state: "off",
        detail: `NOT BROADCASTING · CHECKED ${formatFlightTime(new Date(status.checkedAt)).slice(0, 5)}Z`
    };
}

function renderWatchlist(now: number): void {

    setFlightText("watchlistCount", String(watchlist.length));

    const toggle = flightEl("watchlistToggle");

    // Green in the sidebar while at least one watched aircraft is on the map
    if (toggle) toggle.classList.toggle("layer-on", watchlistLive.size > 0);

    const list = flightEl("watchlistList");

    if (!list) return;

    list.textContent = "";

    setFlightText(
        "watchlistEmpty",
        watchlist.length
            ? ""
            : "Nothing watched yet. Add a callsign, registration or ICAO hex above, " +
              "or click an aircraft and press ADD TO WATCHLIST."
    );

    watchlist.forEach(function(entry) {

        const info = watchlistRowState(entry, now);

        const row = document.createElement("div");
        row.className = "watch-row " + info.state;
        row.dataset.key = entry.key;

        const main = document.createElement("button");
        main.type = "button";
        main.className = "watch-row-main";
        main.title = "Find this aircraft and fly to it";

        const title = document.createElement("div");
        title.className = "airport-row-main";
        title.textContent = entry.label;

        const detail = document.createElement("div");
        detail.className = "airport-row-detail";
        detail.textContent = info.detail;

        main.appendChild(title);
        main.appendChild(detail);

        const remove = document.createElement("button");
        remove.type = "button";
        remove.className = "watch-row-remove";
        remove.title = "Remove from watchlist";
        remove.textContent = "×";

        row.appendChild(main);
        row.appendChild(remove);

        list.appendChild(row);

    });
}

// Watchlist row click: go to a watched aircraft, wherever it is
async function locateWatched(key: string): Promise<void> {

    const entry = watchlist.find(e => e.key === key);

    if (!entry) return;

    if (!flightsEnabled) setFlightsEnabled(true);

    const status = watchStatusFor(key);

    status.alertedAt = Date.now();      // the user is looking at it: no need to announce

    const live = watchlistLive.get(key);

    if (live && flightStore.has(live.hex)) {
        showFlightFound(live);
        return;
    }

    showFlightNotice(`LOCATING ${entry.label}...`);

    const rec = await locateFlightAnywhere(entry.query);

    if (rec !== undefined) {
        status.known = true;
        status.rec = rec;
        status.checkedAt = Date.now();
    }

    if (rec && flightsEnabled) {
        showFlightNotice("");
        showLocatedFlight(rec);
        return;
    }

    flashFlightNotice(
        rec === null
            ? `${entry.label} IS NOT BROADCASTING RIGHT NOW`
            : "COULD NOT REACH THE FLIGHT FEEDS - TRY AGAIN"
    );

    renderWatchlist(Date.now());
}

// Background: look up the watched entry that has gone longest without a
// check (and isn't on the map). One lookup at a time, to stay polite.
async function checkNextWatched(): Promise<void> {

    if (!flightsEnabled || document.hidden || watchlistCheckBusy || !watchlist.length) return;

    const now = Date.now();

    let entry: WatchlistEntry | undefined;
    let oldest = Infinity;

    for (const candidate of watchlist) {

        if (watchlistLive.has(candidate.key)) continue;

        const known = watchlistStatus.get(candidate.key);

        const at = known ? known.checkedAt : 0;

        if (now - at < FLIGHT_WATCH_STALE_MS || at >= oldest) continue;

        oldest = at;
        entry = candidate;

    }

    if (!entry) return;

    watchlistCheckBusy = true;

    let rec: FlightRecord | null | undefined;

    try {
        rec = await locateFlightAnywhere(entry.query);
    } finally {
        watchlistCheckBusy = false;
    }

    if (!watchlist.includes(entry)) return;     // removed while we waited

    const status = watchStatusFor(entry.key);

    const wasTransmitting = status.known && Boolean(status.rec);

    status.checkedAt = Date.now();

    if (rec !== undefined) {

        status.known = true;
        status.rec = rec;

        if (rec && !wasTransmitting &&
            status.checkedAt - status.alertedAt > FLIGHT_WATCH_ALERT_GAP_MS) {

            status.alertedAt = status.checkedAt;

            flashFlightNotice(
                `WATCHLIST: ${entry.label} IS ${rec.onGround ? "TRANSMITTING ON THE GROUND" : "FLYING"}` +
                " - OPEN THE WATCHLIST TO LOCATE IT",
                9000
            );

        }

    }

    renderWatchlist(Date.now());
}

// "ADD TO WATCHLIST" in the flight panel: watches that airframe (by hex)
function toggleWatchSelected(): void {

    const stored = selectedFlightHex ? flightStore.get(selectedFlightHex) : undefined;

    if (!stored) return;

    const rec = displayRecord(stored);

    const existing = watchlistEntryFor(rec);

    if (existing) {
        removeWatch(existing.key);
    } else {
        const hex = rec.hex.toUpperCase();
        addWatch(watchKey(hex), rec.hex, rec.reg || rec.callsign || hex, true);
    }

    updateFlightPanel(Date.now());
}

function addWatchFromInput(): void {

    const input = flightEl("watchlistInput") as HTMLInputElement | null;

    if (!input) return;

    const text = input.value.trim().toUpperCase();

    if (!text) return;

    if (!flightLookupPlan(text).length) {
        setFlightText(
            "watchlistHint",
            "ENTER A CALLSIGN (ACA123), REGISTRATION (C-FABC) OR ICAO HEX (C01234)"
        );
        return;
    }

    const key = watchKey(text);

    if (watchlist.some(e => e.key === key)) {
        setFlightText("watchlistHint", `${text} IS ALREADY WATCHED`);
        return;
    }

    if (addWatch(key, text, text, false)) {
        input.value = "";
        setFlightText("watchlistHint", "");
    }
}

function closeWatchlistPanel(): void {

    const panel = flightEl("watchlistPanel");

    if (panel) panel.classList.remove("visible");
}

function toggleWatchlistPanel(): void {

    const panel = flightEl("watchlistPanel");

    if (!panel) return;

    if (panel.classList.contains("visible")) {
        closeWatchlistPanel();
        return;
    }

    // The panels share the left side of the map
    deselectFlight();

    closeAirportPanel();

    if (typeof closeStationPanel === "function") closeStationPanel();

    if (typeof clearSelection === "function") clearSelection();

    panel.classList.add("visible");

    renderWatchlist(Date.now());
}

function initializeWatchlist(): void {

    loadWatchlist();

    const toggle = flightEl("watchlistToggle");

    if (toggle) toggle.addEventListener("click", toggleWatchlistPanel);

    const close = flightEl("closeWatchlistPanel");

    if (close) close.addEventListener("click", closeWatchlistPanel);

    const watchButton = flightEl("watchFlight");

    if (watchButton) watchButton.addEventListener("click", toggleWatchSelected);

    const add = flightEl("watchlistAdd");

    if (add) add.addEventListener("click", addWatchFromInput);

    const input = flightEl("watchlistInput");

    if (input) input.addEventListener("keydown", function(event) {
        if (event.key === "Enter") addWatchFromInput();
    });

    const list = flightEl("watchlistList");

    if (list) list.addEventListener("click", function(event) {

        const target = event.target as Element | null;

        if (!target || typeof target.closest !== "function") return;

        const row = target.closest<HTMLElement>(".watch-row");

        if (!row || !row.dataset.key) return;

        if (target.closest(".watch-row-remove")) removeWatch(row.dataset.key);
        else locateWatched(row.dataset.key);

    });

    setInterval(checkNextWatched, FLIGHT_WATCH_CHECK_MS);

    renderWatchlist(Date.now());
}


// Search box: jump to an aircraft by callsign, registration or ICAO hex
// (on the map already, or anywhere the feeds can see it), or open an
// airport. Resolves to true if it handled the search.
async function searchFlights(query: string): Promise<boolean> {

    if (!flightsEnabled) return false;

    const q = String(query).trim().toLowerCase();

    if (q.length < 3) return false;

    const shown = q.toUpperCase();


    // 1. Aircraft already on the map

    const wanted = watchKey(q);

    for (const stored of flightStore.values()) {

        const rec = displayRecord(stored);

        if (
            rec.hex === q ||
            (wanted !== "" && (watchKey(rec.callsign) === wanted || watchKey(rec.reg) === wanted))
        ) {

            showFlightFound(stored);

            return true;

        }

    }


    // 2. An airport code, or a name with the word "airport"

    if (openAirportFromSearch(findAirportByQuery(q))) return true;


    // 3. Anywhere else in the world: ask the feeds for it directly

    let located: FlightRecord | null | undefined;

    if (flightLookupPlan(q).length) {

        const searching = `LOCATING ${shown}...`;

        showFlightNotice(searching);

        located = await locateFlightAnywhere(q);

        const notice = flightEl("flightNotice");

        if (notice && notice.textContent === searching) showFlightNotice("");

        if (located && flightsEnabled) {
            showLocatedFlight(located);
            return true;
        }

    }


    // 4. Not transmitting. If it is a real registration, say so by name

    if (looksLikeRegistration(q)) {

        const info = await fetchAircraftInfo(shown);

        if (info && info.hex) {

            flightInfoCache.set(info.hex, info);

            const found = flightStore.get(info.hex);

            if (found) {
                showFlightFound(found);
                return true;
            }

            flashFlightNotice(`${info.registration || shown} IS NOT ON THE MAP RIGHT NOW`);

            return true;

        }

    }


    // 5. Clearly a flight (airline callsign or hex code) rather than a place

    const clearlyFlight =
        /^[a-z]{3}\d{1,4}[a-z]{0,2}$/.test(q) ||
        (/^[0-9a-f]{6}$/.test(q) && /[a-f]/.test(q) && /\d/.test(q));

    if (clearlyFlight && located !== undefined) {

        flashFlightNotice(`${shown} IS NOT BROADCASTING RIGHT NOW`);

        return true;

    }

    return false;

}


// ==============================================
// F11. ENABLE / DISABLE
// ==============================================

function setFlightsEnabled(on: boolean): void {

    flightsEnabled = on;

    flightGeneration++;

    flightRequiredEl("flightToggle").classList.toggle("layer-on", on);

    flightRequiredEl("flightHud").classList.toggle("visible", on);

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

        loadFlightAirports();

        flightTickTimer = setInterval(tickFlights, FLIGHT_TICK_MS);

        refreshFlights();

    }

    else {

        flightStore = new Map();
        flightHistory.clear();

        deselectFlight();

        closeAirportPanel();

        setAirportPins(false);

        showFlightNotice("");

        tickFlights(true);

        setFlightText("flightCount", "OFF");

    }

}


// ==============================================
// F10. AIRPORTS (pins + live arrivals / departures)
//
// This is NOT a timetable. It lists aircraft that are on the map right now
// and are clearly heading into, or just out of, the airport:
//  - if the callsign's route is known (adsbdb): origin / destination match
//  - otherwise: low, descending and pointing at the airport = inbound;
//    low, climbing and pointing away = departed; on the ground = at airport
// ==============================================

const AIRPORT_NEAR_KM = 80;         // search radius for the guesses
const AIRPORT_ROUTE_KM = 150;       // wider radius when the route is known
const AIRPORT_GROUND_KM = 4;        // "on the ground at the airport"
const AIRPORT_LOW_FT = 12000;
const AIRPORT_MAX_ROWS = 40;

function airportCode(airport: AnyAirport): string {
    return airport.iata || airport.icao;
}

function airportMatches(place: RouteAirport | null | undefined, airport: Airport): boolean {

    if (!place) return false;

    return Boolean(
        (place.icao && place.icao === airport.icao) ||
        (place.iata && airport.iata && place.iata === airport.iata)
    );
}

function flightBearing(lat1: number, lon1: number, lat2: number, lon2: number): number {

    const rad = Math.PI / 180;

    const y = Math.sin((lon2 - lon1) * rad) * Math.cos(lat2 * rad);

    const x = Math.cos(lat1 * rad) * Math.sin(lat2 * rad) -
        Math.sin(lat1 * rad) * Math.cos(lat2 * rad) * Math.cos((lon2 - lon1) * rad);

    return (Math.atan2(y, x) / rad + 360) % 360;
}

function angleDifference(a: number, b: number): number {

    const d = Math.abs(a - b) % 360;

    return d > 180 ? 360 - d : d;
}

function airportFeatureAt(point: MapPoint): MapFeature | null {

    if (!map) return null;

    const layerIds = [AIRPORT_LARGE_LAYER, AIRPORT_MEDIUM_LAYER]
        .filter(id => map.getLayer(id));

    if (!layerIds.length) return null;

    const pad = 8;

    const features = map.queryRenderedFeatures(
        [
            [point.x - pad, point.y - pad],
            [point.x + pad, point.y + pad]
        ],
        { layers: layerIds }
    );

    return features.length ? features[0] : null;
}

// Show or hide all pins (hidden while flight tracking is off)
function setAirportPins(visible: boolean): void {

    lastAirportGeoJSON = { type: "FeatureCollection", features: [] };

    if (visible) {

        flightAirportIndex.forEach(function(a) {
            lastAirportGeoJSON.features.push({
                type: "Feature",
                properties: {
                    icao: a.icao, iata: a.iata, name: a.name, kind: a.kind
                },
                geometry: { type: "Point", coordinates: [a.lon, a.lat] }
            });
        });

    }

    const source = map && flightGeoSource(AIRPORT_SOURCE);

    if (source) source.setData(lastAirportGeoJSON);
}

async function loadFlightAirports(): Promise<void> {

    if (flightAirportsState === "ok") {
        setAirportPins(true);
        return;
    }

    if (flightAirportsState === "loading") return;

    if (Date.now() < flightAirportsRetryAt) return;

    flightAirportsState = "loading";

    const generation = flightGeneration;

    try {

        const response = await fetch(FLIGHT_AIRPORTS_PATH, { cache: "no-store" });

        if (!response.ok) throw new Error(`HTTP ${response.status}`);

        const data = await response.json();

        if (!data || !Array.isArray(data.airports)) throw new Error("bad data");

        flightAirportIndex.clear();

        data.airports.forEach(function(r: unknown) {

            if (!Array.isArray(r) || !isFinite(r[3]) || !isFinite(r[4])) return;

            flightAirportIndex.set(r[0], {
                icao: r[0], iata: r[1], name: r[2],
                lat: r[3], lon: r[4], kind: r[5],
                country: r[6], city: r[7]
            });

        });

        flightAirportsState = "ok";

        if (flightsEnabled && generation === flightGeneration) setAirportPins(true);

    } catch (error) {

        flightAirportsState = "error";

        flightAirportsRetryAt = Date.now() + 60000;

        console.warn("Airport list unavailable:", asFetchError(error).message);

        if (flightsEnabled) {
            showFlightNotice("Airport pins need the Python relay (server.py) and an internet connection.");
            setTimeout(() => showFlightNotice(""), 8000);
        }

    }

}

function closeAirportPanel(): void {

    selectedAirport = null;

    const panel = flightEl("airportPanel");

    if (panel) panel.classList.remove("visible");
}

function selectAirport(icao: string): void {

    const airport = flightAirportIndex.get(icao);

    if (!airport) return;

    deselectFlight();

    closeWatchlistPanel();

    if (typeof closeStationPanel === "function") closeStationPanel();

    // The airport panel and the location panel share the left side:
    // opening an airport closes the location (and removes its unsaved marker)
    if (typeof clearSelection === "function") clearSelection();

    selectedAirport = airport;

    airportTab = "arrivals";

    const list = flightEl("airportList");

    if (list) list.textContent = "";

    ["airportSchedule", "airportEarlier"].forEach(function(id) {
        const element = flightEl(id);
        if (element) element.textContent = "";
    });

    airportScheduleDrawn = "";

    setFlightText("airportCode", airportCode(airport));
    setFlightText("airportName", airport.name);
    setFlightText(
        "airportSub",
        [airport.city, airport.country].filter(Boolean).join(", ") + "  ·  " + airport.icao
    );

    setFlightText("airportAddress", airportAddressCache.get(airport.icao) || "");

    loadAirportAddress(airport);   // fills it in if we don't have it yet

    flightRequiredEl("airportPanel").classList.add("visible");

    // The aircraft feed follows the view, so move in close to load the area
    map.flyTo({
        center: [airport.lon, airport.lat],
        zoom: Math.max(map.getZoom(), 8),
        essential: true
    });

    updateAirportPanel(Date.now());
}

// Which aircraft count as arriving / departing at this airport right now
function computeAirportTraffic(airport: Airport, now: number): { arrivals: AirportTrafficRow[]; departures: AirportTrafficRow[] } {

    const arrivals: AirportTrafficRow[] = [];
    const departures: AirportTrafficRow[] = [];
    const lookups: { rec: FlightRecord; dist: number }[] = [];

    flightStore.forEach(function(stored) {

        const rec = displayRecord(stored);

        const pos = predictPosition(rec, now);

        const dist = flightDistanceKm(airport.lat, airport.lon, pos.lat, pos.lon);

        if (dist > AIRPORT_ROUTE_KM) return;

        const key = flightRouteKey(rec);

        const cached = key && flightRouteCache.has(key) ? flightRouteCache.get(key) : undefined;

        const route = cached && cached.origin && cached.destination &&
            (cached.source === "airlabs" || !routeMismatchReason(cached, rec, pos))
            ? cached : null;

        const ground = Boolean(rec.onGround);

        const row = {
            hex: rec.hex,
            callsign: rec.callsign || rec.reg || rec.hex.toUpperCase(),
            type: rec.type || "",
            other: "",
            alt: ground ? 0 : rec.alt,
            gs: rec.gs,
            dist: dist,
            ground: ground,
            status: "",
            estimated: false
        };

        // Ask for the route of nearby low aircraft (a few at a time, cached)
        if (key && cached === undefined && dist < 120 &&
            (ground ? dist < 6 : rec.alt != null && rec.alt < 15000)) {
            lookups.push({ rec: rec, dist: dist });
        }

        if (route) {

            if (airportMatches(route.destination, airport)) {

                row.other = airportCode(route.origin);
                row.status = ground && dist < 6 ? "LANDED" : "INBOUND";

                arrivals.push(row);

            } else if (airportMatches(route.origin, airport)) {

                row.other = airportCode(route.destination);
                row.status = ground && dist < 6 ? "AT AIRPORT" : "DEPARTED";

                departures.push(row);

            }

            return;
        }

        // Route unknown: use how the aircraft is moving
        if (ground) {

            if (dist < AIRPORT_GROUND_KM) {
                row.status = "ON GROUND";
                departures.push(row);
            }

            return;
        }

        if (dist > AIRPORT_NEAR_KM || rec.alt == null || rec.alt > AIRPORT_LOW_FT ||
            rec.track == null || rec.vrate == null) return;

        row.estimated = true;

        const toAirport = flightBearing(pos.lat, pos.lon, airport.lat, airport.lon);
        const fromAirport = (toAirport + 180) % 360;

        if (rec.vrate < -300 && angleDifference(rec.track, toAirport) < 50) {

            row.status = "INBOUND";
            arrivals.push(row);

        } else if (rec.vrate > 300 && dist < 60 &&
                   angleDifference(rec.track, fromAirport) < 50) {

            row.status = "DEPARTED";
            departures.push(row);

        }

    });

    // Ground rows first in departures, otherwise nearest first
    arrivals.sort((a, b) => a.dist - b.dist);
    departures.sort((a, b) => (Number(b.ground) - Number(a.ground)) || (a.dist - b.dist));

    lookups.sort((a, b) => a.dist - b.dist);

    for (const item of lookups.slice(0, 8)) {

        if (flightRoutePending.size >= 3) break;

        loadFlightRoute(item.rec);

    }

    return {
        arrivals: arrivals.slice(0, AIRPORT_MAX_ROWS),
        departures: departures.slice(0, AIRPORT_MAX_ROWS)
    };
}

function airportRowText(row: AirportTrafficRow, arriving: boolean): { title: string; route: string; detail: string; status: string } {

    const first = [row.callsign];

    if (row.type) first.push(row.type);

    const route = row.other ? (arriving ? `from ${row.other}` : `to ${row.other}`) : "";

    const bits = [];

    if (!row.ground && row.alt != null) {
        bits.push(`${Math.round(row.alt).toLocaleString("en-US")} ft`);
    }

    bits.push(formatFlightKm(row.dist));

    if (arriving && !row.ground && row.gs != null && row.gs > 60) {
        bits.push(`ETA ${Math.max(1, Math.round(row.dist / (row.gs * 1.852) * 60))} min`);
    }

    return {
        title: first.join("  ·  "),
        route: route,
        detail: bits.join("  ·  "),
        status: row.status + (row.estimated ? " (EST.)" : "")
    };
}

// ----- scheduled flights for the next hour (AirLabs timetable, via the relay) -----

const FLIGHT_SCHEDULE_PATH = "/api/schedule";
const SCHEDULE_REFRESH_MS = 15 * 60000;   // matches the relay's cache
const SCHEDULE_RETRY_MS = 3 * 60000;

const airportScheduleCache = new Map<string, ScheduleEntry>();   // "KBOS|arrivals" -> { state, rows, partial, at }
let airportScheduleDrawn = "";

async function loadAirportSchedule(airport: Airport, kind: ScheduleKind): Promise<void> {

    const key = airport.icao + "|" + kind;

    const entry = airportScheduleCache.get(key);

    if (entry) {
        if (entry.state === "loading") return;
        const wait = entry.state === "ok" ? SCHEDULE_REFRESH_MS : SCHEDULE_RETRY_MS;
        if (entry.state === "nokey" || Date.now() - entry.at < wait) return;
    }

    airportScheduleCache.set(key, {
        state: "loading",
        rows: entry ? entry.rows : [],
        partial: entry ? entry.partial : false,
        at: Date.now()
    });

    let result: { state: ScheduleState; rows?: ScheduleRow[]; partial?: boolean };

    try {

        const response = await fetch(
            `${FLIGHT_SCHEDULE_PATH}?airport=${encodeURIComponent(airport.icao)}&kind=${kind}`,
            { cache: "no-store" }
        );

        if (response.status === 404) {
            result = { state: "unavailable" };
        } else if (!response.ok) {
            result = { state: "error" };
        } else {
            const data = await response.json();
            result = data && data.found
                ? { state: "ok", rows: data.rows || [], partial: Boolean(data.partial) }
                : { state: (data && data.reason) || "error" };   // "nokey" | "limit"
        }

    } catch (error) {
        result = { state: "error" };
    }

    const old: Partial<ScheduleEntry> = airportScheduleCache.get(key) || {};

    airportScheduleCache.set(key, {
        state: result.state,
        rows: result.rows || old.rows || [],
        partial: result.partial || false,
        at: Date.now()
    });

    airportScheduleDrawn = "";

    if (selectedAirport && selectedAirport.icao === airport.icao) {
        updateAirportPanel(Date.now());
    }
}

// Live aircraft by callsign, so timetable rows can link to planes on the map
function liveAircraftByCallsign(): Map<string, string> {

    const index = new Map();

    flightStore.forEach(function(rec) {
        const callsign = String(rec.callsign || "").trim().toUpperCase();
        if (callsign) index.set(callsign, rec.hex);
    });

    return index;
}

function scheduleRowParts(row: ScheduleRow, arriving: boolean, now: number): { title: string; bits: ScheduleRowBit[]; cancelled: boolean } {

    const status = (row.status || "").toLowerCase();

    const place = [row.other, row.otherCity].filter(Boolean).join(" ");

    const title = `${row.time || "--:--"}  ${row.flight || "?"}` +
        (place ? `   ${arriving ? "from" : "to"} ${place}` : "");

    const bits = [];

    if (row.estTime && row.estTime !== row.time) {
        bits.push({ text: `${status === "landed" || status === "active" ? "Actual" : "Est."} ${row.estTime}` });
    }

    if (row.delay) bits.push({ text: `+${row.delay} min`, cls: "delay" });

    if (row.bestTs && status === "scheduled") {
        const mins = Math.round((row.bestTs * 1000 - now) / 60000);
        if (mins > 0) bits.push({ text: `in ${mins} min` });
    }

    if (row.terminal) bits.push({ text: `Term ${row.terminal}` });
    if (row.gate) bits.push({ text: `Gate ${row.gate}` });
    if (row.aircraft) bits.push({ text: row.aircraft });

    const label = {
        scheduled: "SCHEDULED",
        active: arriving ? "IN THE AIR" : "DEPARTED",
        landed: "LANDED",
        cancelled: "CANCELLED",
        diverted: "DIVERTED"
    }[status] || status.toUpperCase();

    if (label) {
        bits.push({
            text: label,
            cls: status === "cancelled" || status === "diverted" ? "bad" : ""
        });
    }

    return { title: title, bits: bits, cancelled: status === "cancelled" };
}

// Has this flight already left / landed (or been cancelled)?
function scheduleRowIsPast(row: ScheduleRow, arriving: boolean, now: number): boolean {

    const status = (row.status || "").toLowerCase();

    if (status === "landed" || status === "cancelled" || status === "diverted") return true;

    // "active" = in the air: done for departures, still coming for arrivals
    if (status === "active") return !arriving;

    // No update and well past its time: treat as earlier
    return row.bestTs ? row.bestTs * 1000 < now - 15 * 60000 : false;
}

function buildScheduleRow(row: ScheduleRow, arriving: boolean, now: number, live: Map<string, string>, past: boolean): HTMLElement {

    const parts = scheduleRowParts(row, arriving, now);

    if (past && row.bestTs) {
        const mins = Math.round((now - row.bestTs * 1000) / 60000);
        if (mins > 0) {
            parts.bits.splice(parts.bits.length - 1, 0, {
                text: mins >= 60 ? `${Math.floor(mins / 60)} h ${mins % 60} min ago` : `${mins} min ago`
            });
        }
    }

    const hex = live.get((row.callsign || "").toUpperCase());

    const element = document.createElement(hex ? "button" : "div");

    element.className = "airport-row schedule" +
        (hex ? " live" : "") + (parts.cancelled ? " cancelled" : "");

    if (hex) element.dataset.hex = hex;

    const main = document.createElement("div");
    main.className = "airport-row-main";
    main.textContent = parts.title;

    const detail = document.createElement("div");
    detail.className = "airport-row-detail";

    const bits = hex ? parts.bits.concat([{ text: "LIVE", cls: "live-tag" }]) : parts.bits;

    bits.forEach(function(bit, i) {
        if (i) detail.appendChild(document.createTextNode("  ·  "));
        const span = document.createElement("span");
        span.textContent = bit.text;
        if (bit.cls) span.className = bit.cls;
        detail.appendChild(span);
    });

    element.appendChild(main);
    element.appendChild(detail);

    return element;
}

function setScheduleMessage(id: string, message: string): void {

    const element = flightEl(id);

    if (!element) return;

    element.style.display = message ? "block" : "none";
    element.textContent = message;
}

function renderAirportSchedule(now: number): void {

    const list = flightEl("airportSchedule");
    const earlierList = flightEl("airportEarlier");

    if (!list || !earlierList || !selectedAirport) return;

    const arriving = airportTab === "arrivals";
    const kind: ScheduleKind = arriving ? "arrivals" : "departures";

    loadAirportSchedule(selectedAirport, kind);   // no-op while cached

    const entry: ScheduleEntry = airportScheduleCache.get(selectedAirport.icao + "|" + kind) ||
        { state: "loading", rows: [], partial: false, at: 0 };

    // Split into still-to-come (soonest first) and earlier (most recent first)
    const upcoming: ScheduleRow[] = [];
    const earlier: ScheduleRow[] = [];

    entry.rows.forEach(function(row) {
        if (scheduleRowIsPast(row, arriving, now)) earlier.push(row);
        else if (!row.bestTs || row.bestTs * 1000 <= now + 60 * 60000) upcoming.push(row);
    });

    earlier.sort((a, b) => (b.bestTs || 0) - (a.bestTs || 0));

    const live = liveAircraftByCallsign();

    // Only rebuild when something visible changed (times shown per minute)
    const signature = [
        selectedAirport.icao, kind, entry.state, entry.at, Math.floor(now / 60000),
        entry.rows.map(r => (live.get((r.callsign || "").toUpperCase()) || "")).join(",")
    ].join("|");

    if (signature === airportScheduleDrawn) return;

    airportScheduleDrawn = signature;

    const ok = entry.state === "ok";
    const word = arriving ? "ARRIVALS" : "DEPARTURES";

    setFlightText("airportScheduleTitle",
        `SCHEDULED ${word} · NEXT HOUR` + (ok ? ` (${upcoming.length})` : ""));

    setFlightText("airportEarlierTitle",
        `EARLIER ${word}` + (ok ? ` (${earlier.length})` : ""));

    list.textContent = "";
    earlierList.textContent = "";

    upcoming.forEach(row => list.appendChild(buildScheduleRow(row, arriving, now, live, false)));
    earlier.forEach(row => earlierList.appendChild(buildScheduleRow(row, arriving, now, live, true)));

    // ---- messages ----
    const messages: Partial<Record<ScheduleState, string>> = {
        loading: "Loading the timetable...",
        nokey: "Add AIRLABS_API_KEY to .env (and restart server.py) to see scheduled flights.",
        limit: "AirLabs limit reached or key rejected. Trying again later.",
        unavailable: "Scheduled flights need the Python relay (server.py).",
        error: "Couldn't load the timetable. Trying again in a few minutes."
    };

    let upcomingMessage = "";

    if (!ok) {
        upcomingMessage = entry.rows.length ? "" : messages[entry.state] || "";
    } else if (entry.partial) {
        // Busy hub: the free plan's 100 rows ran out before the hour did
        upcomingMessage = upcoming.length
            ? "Busy airport: AirLabs' free plan only returns 100 flights, so later ones in this hour are missing."
            : "Busy airport: AirLabs' free plan only returns its first 100 flights, and here they're all earlier than now (see below). The live list above still works.";
    } else if (!upcoming.length) {
        upcomingMessage = `No scheduled ${kind} in the next hour.`;
    }

    setScheduleMessage("airportScheduleEmpty", upcomingMessage);

    setScheduleMessage(
        "airportEarlierEmpty",
        ok && !earlier.length ? `No earlier ${kind} in AirLabs' list.` : ""
    );
}

// Fly to a live aircraft and open its panel (used by both airport lists)
function followAircraftFromAirport(hex: string): void {

    const rec = flightStore.get(hex);

    if (!rec) return;

    const pos = predictPosition(rec, Date.now());

    map.flyTo({
        center: [pos.lon, pos.lat],
        zoom: Math.max(map.getZoom(), 9),
        essential: true
    });

    selectFlight(rec.hex);
}

function updateAirportPanel(now: number): void {

    if (!selectedAirport) return;

    renderAirportSchedule(now);

    const traffic = computeAirportTraffic(selectedAirport, now);

    const arriving = airportTab === "arrivals";

    const rows = arriving ? traffic.arrivals : traffic.departures;

    const tabArr = flightEl("airportTabArrivals");
    const tabDep = flightEl("airportTabDepartures");

    if (tabArr) {
        tabArr.textContent = `ARRIVALS (${traffic.arrivals.length})`;
        tabArr.classList.toggle("active", arriving);
    }

    if (tabDep) {
        tabDep.textContent = `DEPARTURES (${traffic.departures.length})`;
        tabDep.classList.toggle("active", !arriving);
    }

    const list = flightEl("airportList");

    if (!list) return;

    // Reuse row elements by aircraft so clicks aren't lost while updating
    const existing = new Map<string, HTMLElement>();

    Array.from(list.children).forEach(function(child) {
        const hex = child instanceof HTMLElement ? child.dataset.hex : undefined;
        if (hex) existing.set(hex, child as HTMLElement);
        else list.removeChild(child);
    });

    const keep = new Set(rows.map(r => r.hex));

    existing.forEach(function(element, hex) {
        if (!keep.has(hex)) list.removeChild(element);
    });

    rows.forEach(function(row, i) {

        let element = existing.get(row.hex);

        if (!element || element.parentNode !== list) {

            const created = document.createElement("button");
            created.className = "airport-row";
            created.dataset.hex = row.hex;

            ["airport-row-main", "airport-row-detail"].forEach(function(cls) {
                const div = document.createElement("div");
                div.className = cls;
                created.appendChild(div);
            });

            element = created;

        }

        const text = airportRowText(row, arriving);

        const main = element.children[0];
        const detail = element.children[1];

        main.textContent = text.title + (text.route ? "   " + text.route : "");
        detail.textContent = text.detail + "   " + text.status;

        element.classList.toggle("estimated", row.estimated);

        if (list.children[i] !== element) {
            list.insertBefore(element, list.children[i] || null);
        }

    });

    const empty = flightEl("airportEmpty");

    if (empty) {

        empty.style.display = rows.length ? "none" : "block";

        const loading = flightStore.size === 0 || flightFetchBusy;

        empty.textContent = loading && !rows.length
            ? "Loading aircraft near this airport..."
            : `No ${arriving ? "arrivals" : "departures"} detected right now.`;

    }

}

function initializeAirportPanel(): void {

    const close = flightEl("closeAirportPanel");

    if (close) close.addEventListener("click", closeAirportPanel);

    const tabs: [id: string, kind: ScheduleKind][] =
        [["airportTabArrivals", "arrivals"], ["airportTabDepartures", "departures"]];

    tabs
        .forEach(function(entry) {

            const button = flightEl(entry[0]);

            if (button) button.addEventListener("click", function() {
                airportTab = entry[1];
                updateAirportPanel(Date.now());
            });

        });

    // Live list and timetable: clicking a row with an aircraft follows it
    ["airportList", "airportSchedule", "airportEarlier"].forEach(function(id) {

        const element = flightEl(id);

        if (element) element.addEventListener("click", function(event) {

            const target = event.target as Element | null;

            // (a click can land on something that isn't an element)
            const row = target && typeof target.closest === "function"
                ? target.closest<HTMLElement>(".airport-row")
                : null;

            if (row && row.dataset.hex) followAircraftFromAirport(row.dataset.hex);

        });

    });

}


function initializeFlights(): void {

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


    flightRequiredEl("flightToggle").addEventListener("click", function() {
        setFlightsEnabled(!flightsEnabled);
    });

    flightRequiredEl("closeFlightPanel").addEventListener("click", deselectFlight);

    initializeAirportPanel();

    initializeWatchlist();

    flightRequiredEl("followFlight").addEventListener("click", function() {

        const rec = selectedFlightHex ? flightStore.get(selectedFlightHex) : undefined;

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

    flightRequiredEl("pinFlight").addEventListener("click", pinSelectedFlight);


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
