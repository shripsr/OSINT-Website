/* ==============================================
   OSINT MAP - SHIP TRACKING (live AIS positions)
   SOURCE: src/ships.ts  ->  compiled to ships.js by "npm run build"
           (edit the .ts file, never the .js; ships.js must load
           AFTER transit.js and BEFORE script.js)
   DATA: two sources, the first one that is available:

   1. aisstream.io and/or Pelyr (pelyr.com), WORLDWIDE. Each needs a free
      API key in .env (AISSTREAM_API_KEY, PELYR_API_KEY) and server.py,
      which talks to them, merges the two and hands over the ships in the
      area on screen ("/api/ships"). Pelyr's free key is for non-commercial
      use and its data must be credited where it is shown (footer + popup).
      VesselAPI (VESSELAPI_KEY) is a backup server.py turns to when both
      of those stop delivering.

   2. Digitraffic (digitraffic.fi), the open data service of Fintraffic,
      Finland's traffic agency. Free, no API key, licence CC BY 4.0, asked
      directly by the browser. Its AIS receivers are Finnish, so it shows
      the Baltic Sea around Finland and nothing elsewhere. Used when there
      is no key, or the page is not served by server.py.

   One sidebar switch ("Ship Tracking") shows every vessel heard in the
   last half hour: an arrow-shaped hull pointing where the ship is heading,
   coloured by kind (cargo, tanker, passenger, ...). Ships under way glide
   along their course between updates. Click one for its details.
   ============================================== */


// ==============================================
// S1. CONFIGURATION
// ==============================================

const SHIP_API = "https://meri.digitraffic.fi/api/ais/v1";

// Digitraffic asks every app to name itself in this header
const SHIP_APP_NAME = "osint-map";

// server.py's relay for aisstream.io (worldwide)
const SHIP_RELAY_PATH = "/api/ships";
const SHIP_RELAY_POLL_MS = 10000;       // time between updates from the relay
const SHIP_RELAY_PAD = 0.25;            // ask for this much beyond the screen edge
const SHIP_RELAY_WARMUP_S = 400;        // the relay's picture is still filling in until then
const SHIP_RELAY_FOLLOW_UP_MS = 3500;   // look again this soon after asking about a new area
const SHIP_MOVE_DELAY_MS = 700;        // wait for the map to settle before asking again

const SHIP_POLL_MS = 30000;             // time between position updates (Digitraffic)
const SHIP_TICK_MS = 2000;              // smooth movement update rate
const SHIP_MAX_AGE_MS = 30 * 60000;     // forget a ship not heard from for this long
const SHIP_PREDICT_MAX_MS = 3 * 60000;  // glide along the course at most this long past a fix
const SHIP_MOVING_KNOTS = 0.5;          // slower than this = stopped (GPS jitter at the quay)
const SHIP_OVERLAP_MS = 15000;          // each update re-asks this much, so nothing slips between two

// Names, types and destinations are sent far less often than positions
const SHIP_DETAILS_FIRST_MS = 24 * 3600000;     // how far back the first load reaches
const SHIP_DETAILS_POLL_MS = 10 * 60000;

const SHIP_VIEW_PAD = 0.15;             // draw this much beyond the screen edge
const SHIP_LABEL_MIN_ZOOM = 11;

const SHIP_PREF_KEY = "osint_map_ships_enabled";

const SHIP_SOURCE = "ships-source";
const SHIP_LAYER = "ships-layer";
const SHIP_LABEL_LAYER = "ships-label-layer";
const SHIP_TRAIL_SOURCE = "ships-trail-source";
const SHIP_TRAIL_CASING_LAYER = "ships-trail-casing-layer";
const SHIP_TRAIL_LAYER = "ships-trail-layer";

type ShipCategory =
    | "cargo" | "tanker" | "passenger" | "highspeed" | "fishing"
    | "service" | "pleasure" | "official" | "other";

const SHIP_CATEGORIES: Record<ShipCategory, { label: string; color: string }> = {
    cargo: { label: "Cargo", color: "#7bd88f" },
    tanker: { label: "Tanker", color: "#ff6b6b" },
    passenger: { label: "Passenger", color: "#4f8cff" },
    highspeed: { label: "High-speed craft", color: "#ffd166" },
    fishing: { label: "Fishing", color: "#ff9f68" },
    service: { label: "Tug / service", color: "#35c9e8" },
    pleasure: { label: "Pleasure craft", color: "#c77dff" },
    official: { label: "Military / authority", color: "#9aa8b8" },
    other: { label: "Vessel", color: "#d0d8e0" }
};

// AIS ship type codes that deserve a more exact name than their category
const SHIP_TYPE_NAMES: Record<number, string> = {
    30: "Fishing",
    31: "Towing",
    32: "Towing",
    33: "Dredger",
    34: "Diving support",
    35: "Military",
    36: "Sailing vessel",
    37: "Pleasure craft",
    50: "Pilot vessel",
    51: "Search and rescue",
    52: "Tug",
    53: "Port tender",
    54: "Anti-pollution",
    55: "Law enforcement",
    58: "Medical transport"
};

// AIS navigational status codes
const SHIP_NAV_STATUS: Record<number, string> = {
    0: "Under way",
    1: "At anchor",
    2: "Not under command",
    3: "Restricted manoeuvrability",
    4: "Constrained by draught",
    5: "Moored",
    6: "Aground",
    7: "Fishing",
    8: "Under sail",
    14: "DISTRESS (AIS-SART)"
};


// ==============================================
// S2. TYPES (what Digitraffic sends, and what we keep)
// ==============================================

/** GET /locations: one feature per vessel, its latest position report */
interface ShipLocationsPayload {
    dataUpdatedTime?: string;
    features?: {
        mmsi?: number;
        geometry?: { coordinates?: number[] };      // [lon, lat]
        properties?: {
            sog?: number;               // speed over ground, knots (102.3 = unknown)
            cog?: number;               // course over ground, degrees (360 = unknown)
            heading?: number;           // where the bow points, degrees (511 = unknown)
            navStat?: number;
            timestampExternal?: number; // when the report was received, ms
        };
    }[];
}

/** GET /vessels: what a ship says about itself */
interface ShipDetailsPayload {
    mmsi?: number;
    name?: string;
    callSign?: string;
    imo?: number;
    shipType?: number;
    destination?: string;
    draught?: number;                   // in tenths of a metre
    eta?: number;                       // month, day, hour and minute packed into 20 bits
    referencePointA?: number;           // metres from the GPS antenna to the bow,
    referencePointB?: number;           // stern,
    referencePointC?: number;           // port side
    referencePointD?: number;           // and starboard side
}

/**
 * One ship from server.py's relay (get_ships): [MMSI, lat, lon, time in ms,
 * speed, course, heading, nav status, name, type, call sign, IMO,
 * destination, draught in metres, length, beam, credit line of the source,
 * expected arrival as "MM-DDTHH:MM"]
 */
type ShipRelayRow = unknown[];

interface ShipRelayPayload {
    available?: boolean;
    reason?: string;            // why not: "nokey" | "key" (aisstream refused it)
    ships?: ShipRelayRow[];
    sources?: string[];         // the feeds behind the relay: "aisstream.io", "Pelyr"
    inArea?: number;            // ships in the area asked for (more than `ships` when cut short)
    listeningFor?: number;      // seconds since the relay started hearing ships
}

interface ShipDetails {
    name: string;
    callSign: string;
    imo: number;
    type: number;
    destination: string;
    draught: number;        // metres, 0 = unknown
    length: number;         // metres, 0 = unknown
    beam: number;
    eta: string;            // expected arrival, "MM-DDTHH:MM" in UTC ("" = not given)
}

/** One ship's latest position report */
interface ShipRecord {
    mmsi: number;
    lat: number;
    lon: number;
    t0: number;                 // when this position was true (ms)
    sog: number | null;         // knots
    cog: number | null;         // degrees
    heading: number | null;     // degrees
    navStat: number | null;
    credit: string;             // the notice the position's source asks for ("" = none per ship)
}


// ==============================================
// S3. STATE
// ==============================================

let shipsEnabled = false;

let shipGeneration = 0;         // bumps to drop answers that arrive too late

const shipRecords = new Map<number, ShipRecord>();      // by MMSI
const shipDetails = new Map<number, ShipDetails>();

let shipLastUpdate = 0;         // positions are loaded up to here (ms), 0 = nothing yet
let shipDetailsUpdate = 0;      // same for the details
let shipDetailsCheckedAt = 0;
let shipDetailsBusy = false;

let shipRelayOk: boolean | null = null;     // null = unknown, true/false once tested
let shipRelayNote = "";         // extra line for the switch's tooltip
let shipRelaySources = "";      // e.g. "aisstream.io + Pelyr"
let shipMoveTimer: number | undefined;

let shipBusy = false;
let shipQueued = false;        // asked again while an update was loading
let shipFailures = 0;

let shipPollTimer: number | undefined;
let shipTickTimer: number | undefined;

let lastShipGeoJSON: GeoFeatureCollection = { type: "FeatureCollection", features: [] };

let shipHoverPopup: MapPopup;
let shipPopup: MapPopup;
let shipSelectedMmsi: number | null = null;
let shipPopupHtml = "";         // what the open popup shows (rewritten only when it changes)


// ==============================================
// S4. SMALL HELPERS
// ==============================================

function setShipStatus(text: string, detail = ""): void {

    const count = document.getElementById("shipCount");

    if (count) count.textContent = text;

    const toggle = document.getElementById("shipToggle");

    if (toggle) toggle.title = detail;
}

function shipCategory(type: number): ShipCategory {

    if (type === 30) return "fishing";
    if (type === 35 || type === 55) return "official";
    if (type === 36 || type === 37) return "pleasure";
    if ((type >= 31 && type <= 34) || (type >= 50 && type <= 54) || type === 58) return "service";
    if (type >= 40 && type <= 49) return "highspeed";
    if (type >= 60 && type <= 69) return "passenger";
    if (type >= 70 && type <= 79) return "cargo";
    if (type >= 80 && type <= 89) return "tanker";

    return "other";
}

function shipTypeLabel(type: number): string {
    return SHIP_TYPE_NAMES[type] || SHIP_CATEGORIES[shipCategory(type)].label;
}

// AIS text is padded with spaces or "@", and left blank by many small boats
function cleanShipText(value: unknown): string {
    return typeof value === "string" ? value.replace(/@+/g, " ").replace(/\s+/g, " ").trim() : "";
}

function shipName(mmsi: number): string {

    const details = shipDetails.get(mmsi);

    return (details && details.name) || `MMSI ${mmsi}`;
}

function isShipMoving(ship: ShipRecord): boolean {
    return ship.sog !== null && ship.sog >= SHIP_MOVING_KNOTS;
}

// Where the bow points: the compass heading if the ship sends one,
// otherwise its course while it is moving. Null = unknown.
function shipDirection(ship: ShipRecord): number | null {

    if (ship.heading !== null) return ship.heading;

    return isShipMoving(ship) ? ship.cog : null;
}

// Where the ship should be by now: its last fix, moved along its course at
// its speed (ships turn slowly, so this holds well for a few minutes)
function shipPosition(ship: ShipRecord, now: number): [number, number] {

    if (!isShipMoving(ship) || ship.sog === null || ship.cog === null) return [ship.lon, ship.lat];

    const hours = Math.min(Math.max(0, now - ship.t0), SHIP_PREDICT_MAX_MS) / 3600000;

    const miles = ship.sog * hours;         // nautical miles; 60 of them = 1 degree of latitude

    const course = ship.cog * Math.PI / 180;

    const cosLat = Math.max(0.05, Math.cos(ship.lat * Math.PI / 180));

    return [
        ship.lon + miles * Math.sin(course) / (60 * cosLat),
        ship.lat + miles * Math.cos(course) / 60
    ];
}

// "5 min ago"
function formatShipAge(ms: number): string {

    const minutes = Math.floor(ms / 60000);

    return minutes < 1 ? "less than a minute ago" : `${minutes} min ago`;
}

// A test for "is this point on screen (plus `pad`, a share of the screen)?"
function shipViewTest(pad: number): (lon: number, lat: number) => boolean {

    const bounds = map.getBounds();

    const height = bounds.getNorth() - bounds.getSouth();
    const width = bounds.getEast() - bounds.getWest();

    const south = bounds.getSouth() - height * pad;
    const north = bounds.getNorth() + height * pad;
    const west = bounds.getWest() - width * pad;
    const span = width * (1 + 2 * pad);

    // The whole world is on screen
    if (!(span > 0) || span >= 360) return (lon, lat) => lat >= south && lat <= north;

    // (the map can be scrolled past the date line, so compare distances east of the left edge)
    return (lon, lat) =>
        lat >= south && lat <= north && ((((lon - west) % 360) + 360) % 360) <= span;
}


// ==============================================
// S5. REQUESTS
// ==============================================

async function shipFetch<T>(path: string, params: Record<string, string>): Promise<T> {

    const query = new URLSearchParams(params).toString();

    const response = await fetch(`${SHIP_API}${path}?${query}`, {
        headers: {
            "Accept": "application/json",
            "Digitraffic-User": SHIP_APP_NAME
        }
    });

    if (!response.ok) throw new Error(`Ship feed answered ${response.status}`);

    return await response.json() as T;
}


// The area on screen (and a bit more), as the relay wants it
function shipRelayBox(): Record<string, string> {

    const bounds = map.getBounds();

    const height = bounds.getNorth() - bounds.getSouth();
    const width = bounds.getEast() - bounds.getWest();

    // The map can be scrolled past the date line: bring it back to -180..180
    const wrap = (lon: number) => ((((lon + 180) % 360) + 360) % 360) - 180;

    const whole = !(width > 0) || width * (1 + 2 * SHIP_RELAY_PAD) >= 360;

    return {
        south: Math.max(-90, bounds.getSouth() - height * SHIP_RELAY_PAD).toFixed(3),
        north: Math.min(90, bounds.getNorth() + height * SHIP_RELAY_PAD).toFixed(3),
        west: (whole ? -180 : wrap(bounds.getWest() - width * SHIP_RELAY_PAD)).toFixed(3),
        east: (whole ? 180 : wrap(bounds.getEast() + width * SHIP_RELAY_PAD)).toFixed(3)
    };
}

// Ask server.py's relay (aisstream.io, worldwide). Null = there is no relay
// to use (no server.py, or no key in .env): the caller asks Digitraffic.
async function shipRelayFetch(): Promise<ShipRelayPayload | null> {

    if (shipRelayOk === false || !location.protocol.startsWith("http")) return null;

    let response: Response;

    try {
        response = await fetch(`${SHIP_RELAY_PATH}?${new URLSearchParams(shipRelayBox())}`);
    } catch (error) {
        if (shipRelayOk === null) shipRelayOk = false;      // never answered: not there
        if (!shipRelayOk) return null;
        throw error;
    }

    const isJson = (response.headers.get("Content-Type") || "").includes("json");

    // Served by something other than server.py (or an older server.py)
    if (!isJson || response.status === 404) {
        shipRelayOk = false;
        return null;
    }

    if (!response.ok) throw new Error(`Ship relay answered ${response.status}`);

    const payload = await response.json() as ShipRelayPayload;

    if (!payload.available) {

        shipRelayOk = false;

        shipRelayNote = payload.reason === "key"
            ? "aisstream.io is not accepting the API key in .env, so this is Digitraffic only."
            : "";

        return null;
    }

    shipRelayOk = true;

    return payload;
}


// ==============================================
// S6. READING THE FEEDS
// ==============================================

// AIS uses a "no value" number per field; anything out of range counts too
function shipNumber(value: unknown, min: number, max: number): number | null {
    return typeof value === "number" && value >= min && value <= max ? value : null;
}

function readShipLocations(payload: ShipLocationsPayload, now: number): void {

    (Array.isArray(payload.features) ? payload.features : []).forEach(function(feature) {

        const mmsi = feature && feature.mmsi;
        const point = feature && feature.geometry && feature.geometry.coordinates;
        const p = (feature && feature.properties) || {};

        // Ships' numbers start with 2-7; the rest are shore stations,
        // buoys, rescue aircraft and the like
        if (typeof mmsi !== "number" || mmsi < 200000000 || mmsi > 799999999) return;

        if (!Array.isArray(point)) return;

        const lon = shipNumber(point[0], -180, 180);
        const lat = shipNumber(point[1], -90, 90);

        if (lon === null || lat === null) return;

        // (never trust a time from the future: the ship would not move until it passed)
        const t0 = Math.min(shipNumber(p.timestampExternal, 1, Infinity) || now, now);

        const known = shipRecords.get(mmsi);

        if (known && known.t0 >= t0) return;

        shipRecords.set(mmsi, {
            mmsi: mmsi,
            lat: lat,
            lon: lon,
            t0: t0,
            sog: shipNumber(p.sog, 0, 102.2),
            cog: shipNumber(p.cog, 0, 359.9),
            heading: shipNumber(p.heading, 0, 359),
            navStat: shipNumber(p.navStat, 0, 14),
            credit: ""
        });

        noteShipTrail(mmsi, lon, lat, t0);
    });
}

function readShipDetails(rows: ShipDetailsPayload[]): void {

    (Array.isArray(rows) ? rows : []).forEach(function(row) {

        if (!row || typeof row.mmsi !== "number") return;

        const size = (a: unknown, b: unknown) => (shipNumber(a, 0, 511) || 0) + (shipNumber(b, 0, 511) || 0);

        shipDetails.set(row.mmsi, {
            name: cleanShipText(row.name),
            callSign: cleanShipText(row.callSign),
            imo: shipNumber(row.imo, 1000000, 9999999) || 0,
            type: shipNumber(row.shipType, 0, 99) || 0,
            destination: cleanShipText(row.destination),
            draught: (shipNumber(row.draught, 1, 254) || 0) / 10,
            length: size(row.referencePointA, row.referencePointB),
            beam: size(row.referencePointC, row.referencePointD),
            eta: unpackShipEta(row.eta)
        });
    });
}

function readShipRelay(payload: ShipRelayPayload): void {

    const rows = Array.isArray(payload.ships) ? payload.ships : [];

    rows.forEach(function(row) {

        if (!Array.isArray(row)) return;

        const mmsi = row[0];
        const lat = shipNumber(row[1], -90, 90);
        const lon = shipNumber(row[2], -180, 180);
        const t0 = shipNumber(row[3], 1, Infinity);

        if (typeof mmsi !== "number" || mmsi < 200000000 || mmsi > 799999999) return;

        if (lat === null || lon === null || t0 === null) return;

        shipRecords.set(mmsi, {
            mmsi: mmsi,
            lat: lat,
            lon: lon,
            t0: t0,
            sog: shipNumber(row[4], 0, 102.2),
            cog: shipNumber(row[5], 0, 359.9),
            heading: shipNumber(row[6], 0, 359),
            navStat: shipNumber(row[7], 0, 14),
            credit: cleanShipText(row[16])
        });

        noteShipTrail(mmsi, lon, lat, t0);

        shipDetails.set(mmsi, {
            name: cleanShipText(row[8]),
            type: shipNumber(row[9], 0, 99) || 0,
            callSign: cleanShipText(row[10]),
            imo: shipNumber(row[11], 1000000, 9999999) || 0,
            destination: cleanShipText(row[12]),
            draught: shipNumber(row[13], 0.1, 25.4) || 0,
            length: shipNumber(row[14], 1, 1022) || 0,
            beam: shipNumber(row[15], 1, 126) || 0,
            eta: cleanShipText(row[17])
        });
    });

    shipRelaySources = (Array.isArray(payload.sources) ? payload.sources : [])
        .map(cleanShipText).filter(Boolean).join(" + ");

    const inArea = shipNumber(payload.inArea, 0, Infinity) || 0;
    const warmingUp = (shipNumber(payload.listeningFor, 0, Infinity) || 0) < SHIP_RELAY_WARMUP_S;

    shipRelayNote = [
        inArea > rows.length
            ? `Showing ${rows.length.toLocaleString("en-US")} of ${inArea.toLocaleString("en-US")} ships here. Zoom in for all of them.`
            : "",
        warmingUp
            ? "Just started listening: moored ships and names take a few minutes to appear."
            : ""
    ].filter(Boolean).join("\n");
}

// Names and types (Digitraffic). Loaded beside the positions, so the ships appear at once
// (as "MMSI 230...", in the neutral colour) and get their details a moment later.
async function refreshShipDetails(): Promise<void> {

    if (shipDetailsBusy) return;

    shipDetailsBusy = true;

    const generation = shipGeneration;
    const asked = Date.now();

    try {

        const rows = await shipFetch<ShipDetailsPayload[]>("/vessels", {
            from: String(shipDetailsUpdate ? shipDetailsUpdate - 60000 : asked - SHIP_DETAILS_FIRST_MS)
        });

        if (generation !== shipGeneration) return;

        readShipDetails(rows);

        shipDetailsUpdate = asked;

        tickShips();

    } catch (error) {

        console.warn("Ship details failed:", error);

    } finally {

        shipDetailsBusy = false;
    }
}

async function refreshShips(): Promise<void> {

    if (!shipsEnabled || !map) return;

    clearTimeout(shipPollTimer);

    // No updates while the tab is hidden; visibilitychange restarts them
    if (document.hidden) return;

    if (shipBusy) {
        shipQueued = true;
        return;
    }

    shipBusy = true;

    const generation = shipGeneration;
    const asked = Date.now();

    if (!shipRecords.size) setShipStatus("LOADING", "Loading ship positions...");

    try {

        // Worldwide through server.py if it can, otherwise Digitraffic
        const relay = await shipRelayFetch();

        if (generation !== shipGeneration) return;

        if (relay) {

            readShipRelay(relay);

        } else {

            if (asked - shipDetailsCheckedAt >= SHIP_DETAILS_POLL_MS) {
                shipDetailsCheckedAt = asked;
                refreshShipDetails();
            }

            // After a long pause (hidden tab) everything known is stale: start over
            const fresh = shipLastUpdate && asked - shipLastUpdate < SHIP_MAX_AGE_MS;

            const payload = await shipFetch<ShipLocationsPayload>("/locations", {
                from: String(fresh ? shipLastUpdate - SHIP_OVERLAP_MS : asked - SHIP_MAX_AGE_MS)
            });

            if (generation !== shipGeneration) return;

            readShipLocations(payload, Date.now());
        }

        shipLastUpdate = asked;
        shipFailures = 0;

        tickShips();

    } catch (error) {

        if (generation !== shipGeneration) return;

        console.warn("Ship positions failed:", error);

        shipFailures++;

        // Keep showing what we have through a hiccup or two
        if (!shipRecords.size || shipFailures >= 3) {
            setShipStatus("ERROR", "Ship positions could not be loaded. Trying again shortly.");
        }

    } finally {

        shipBusy = false;

        if (shipsEnabled && generation === shipGeneration) {

            if (shipQueued) {
                shipQueued = false;
                refreshShips();
            } else {
                shipPollTimer = setTimeout(refreshShips, shipRelayOk ? SHIP_RELAY_POLL_MS : SHIP_POLL_MS);
            }

        } else if (shipsEnabled) {

            // Switched off and on again while this was loading
            shipQueued = false;
            refreshShips();
        }
    }
}


// ==============================================
// S7. MAP LAYERS
// ==============================================

function shipGeoSource(): GeoJSONMapSource | undefined {
    return map.getSource(SHIP_SOURCE) as GeoJSONMapSource | undefined;
}

// Runs on every style load, because changing the base map wipes all layers.
function setupShipLayers(): void {

    // Ships go underneath the aircraft and airport pins (and, being added
    // after them, on top of the transit layers)
    const layers = map.getStyle().layers || [];

    const firstFlightLayer = layers.find(layer => layer.id.startsWith("flights-"));

    const before = firstFlightLayer ? firstFlightLayer.id : undefined;

    if (!map.getSource(SHIP_SOURCE)) {
        map.addSource(SHIP_SOURCE, {
            type: "geojson",
            data: lastShipGeoJSON
        });
    }

    // The path of the clicked ship, under the ships (see S8B)
    if (!map.getSource(SHIP_TRAIL_SOURCE)) {
        map.addSource(SHIP_TRAIL_SOURCE, {
            type: "geojson",
            data: lastShipTrailGeoJSON
        });
    }

    if (!map.getLayer(SHIP_TRAIL_CASING_LAYER)) {
        map.addLayer({
            id: SHIP_TRAIL_CASING_LAYER,
            type: "line",
            source: SHIP_TRAIL_SOURCE,
            layout: { "line-cap": "round", "line-join": "round" },
            paint: { "line-color": "#0b1520", "line-width": 4.5, "line-opacity": 0.8 }
        }, before);
    }

    if (!map.getLayer(SHIP_TRAIL_LAYER)) {
        map.addLayer({
            id: SHIP_TRAIL_LAYER,
            type: "line",
            source: SHIP_TRAIL_SOURCE,
            layout: { "line-cap": "round", "line-join": "round" },
            paint: { "line-color": ["get", "color"], "line-width": 2 }
        }, before);
    }

    // One hull per ship, turned to its heading. The images are drawn when
    // the map first asks for them (see onShipImageMissing).
    if (!map.getLayer(SHIP_LAYER)) {
        map.addLayer({
            id: SHIP_LAYER,
            type: "symbol",
            source: SHIP_SOURCE,
            layout: {
                "icon-image": ["get", "icon"],
                "icon-size": ["interpolate", ["linear"], ["zoom"], 3, 0.4, 8, 0.6, 12, 0.85, 15, 1.1],
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

    // Names next to the ships. Text needs a font from the base map's own
    // font server, so borrow one the style already uses (the satellite
    // style has no fonts at all: no labels there).
    if (!map.getLayer(SHIP_LABEL_LAYER) && map.getStyle().glyphs) {

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
                id: SHIP_LABEL_LAYER,
                type: "symbol",
                source: SHIP_SOURCE,
                minzoom: SHIP_LABEL_MIN_ZOOM,
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
function ensureShipLayers(): void {

    if (!map || !map.isStyleLoaded()) return;

    if (map.getSource(SHIP_SOURCE) && map.getLayer(SHIP_LAYER) && map.getLayer(SHIP_TRAIL_LAYER)) return;

    try {
        setupShipLayers();
    } catch (error) {
        console.warn("Ship layers could not be rebuilt yet:", error);
    }
}

function drawShips(features: GeoFeature[]): void {

    lastShipGeoJSON = { type: "FeatureCollection", features: features };

    const source = map && shipGeoSource();

    if (source) source.setData(lastShipGeoJSON);
}


// ==============================================
// S7B. SHIP ICONS
//
// Drawn bow-up on a 48 x 48 grid (shown 24 px at full size) and turned by
// the layer. Two shapes per colour: a hull when we know which way the ship
// points, a round dot when we don't. Made on demand, like the transit icons.
// ==============================================

const SHIP_ICON_GRID = 48;
const SHIP_ICON_SCALE = 2;          // drawn at twice the size, for sharp edges
const SHIP_ICON_PREFIX = "ship-icon";

type ShipIconShape = "hull" | "dot";

const shipIconImages = new Map<string, ImageData>();    // image name -> drawn icon

// e.g. "ship-icon|hull|7bd88f"
function shipIconId(shape: ShipIconShape, color: string): string {
    return `${SHIP_ICON_PREFIX}|${shape}|${color.replace("#", "")}`;
}

function createShipIcon(shape: ShipIconShape, color: string): ImageData {

    const size = SHIP_ICON_GRID * SHIP_ICON_SCALE;

    const canvas = document.createElement("canvas");

    canvas.width = size;
    canvas.height = size;

    const ctx = canvas.getContext("2d");

    if (!ctx) throw new Error("Canvas 2D drawing is not available");

    ctx.scale(SHIP_ICON_SCALE, SHIP_ICON_SCALE);

    ctx.lineJoin = "round";

    const rim = "#0b1520";      // dark edge, so the icon shows on light maps too

    ctx.beginPath();

    if (shape === "hull") {

        // Pointed bow at the top, squared-off stern
        ctx.moveTo(24, 4);
        ctx.bezierCurveTo(30, 10, 33, 17, 33, 25);
        ctx.lineTo(33, 40);
        ctx.quadraticCurveTo(33, 43, 30, 43);
        ctx.lineTo(18, 43);
        ctx.quadraticCurveTo(15, 43, 15, 40);
        ctx.lineTo(15, 25);
        ctx.bezierCurveTo(15, 17, 18, 10, 24, 4);
        ctx.closePath();

    } else {

        ctx.arc(24, 24, 9, 0, Math.PI * 2);
    }

    ctx.strokeStyle = rim;
    ctx.lineWidth = 5;
    ctx.stroke();

    ctx.fillStyle = color;
    ctx.fill();

    // The bridge, towards the stern
    if (shape === "hull") {
        ctx.fillStyle = rim;
        ctx.globalAlpha = 0.55;
        ctx.fillRect(19, 31, 10, 6);
    }

    return ctx.getImageData(0, 0, size, size);
}

// The ship layer wants an image the map doesn't have yet: draw it.
// (A base map change throws all images away; they come back the same way.)
function onShipImageMissing(e: { id: string }): void {

    const [prefix, shape, hex] = String(e.id).split("|");

    if (prefix !== SHIP_ICON_PREFIX) return;

    if (shape !== "hull" && shape !== "dot") return;

    if (!/^[0-9a-f]{6}$/.test(hex || "")) return;

    let image = shipIconImages.get(e.id);

    if (!image) {
        image = createShipIcon(shape, "#" + hex);
        shipIconImages.set(e.id, image);
    }

    if (!map.hasImage(e.id)) {
        map.addImage(e.id, image, {
            pixelRatio: 2 * SHIP_ICON_SCALE         // 48-unit grid shows as 24 px
        });
    }
}


// ==============================================
// S8. DRAWING THE SHIPS
// ==============================================

// Runs every two seconds (and after each update or map move): put every
// ship on screen where it should be by now
function tickShips(): void {

    if (!shipsEnabled || !map || document.hidden) return;

    const now = Date.now();

    const near = shipViewTest(SHIP_VIEW_PAD);
    const onScreen = shipViewTest(0);

    const features: GeoFeature[] = [];

    let inView = 0;
    let selectedAt: [number, number] | null = null;

    shipRecords.forEach(function(ship, mmsi) {

        if (now - ship.t0 > SHIP_MAX_AGE_MS) {
            shipRecords.delete(mmsi);
            shipTrails.delete(mmsi);
            return;
        }

        const position = shipPosition(ship, now);

        if (mmsi === shipSelectedMmsi) selectedAt = position;

        if (!near(position[0], position[1])) return;

        if (onScreen(position[0], position[1])) inView++;

        const details = shipDetails.get(mmsi);

        const direction = shipDirection(ship);
        const moving = isShipMoving(ship);

        features.push({
            type: "Feature",
            geometry: { type: "Point", coordinates: position },
            properties: {
                mmsi: mmsi,
                label: (details && details.name) || "",
                icon: shipIconId(
                    direction === null ? "dot" : "hull",
                    SHIP_CATEGORIES[shipCategory(details ? details.type : 0)].color
                ),
                rot: direction || 0,
                moving: moving,
                rank: moving ? 1 : 0        // ships under way are drawn over the moored ones
            }
        });
    });

    drawShips(features);

    drawShipTrail(shipSelectedMmsi, selectedAt);

    setShipHud(inView);

    setShipStatus(
        shipRecords.size || shipLastUpdate ? inView.toLocaleString("en-US") : "LOADING",
        `${inView.toLocaleString("en-US")} ships in view, ${shipRecords.size.toLocaleString("en-US")} tracked.\n` +
        (shipRelayOk
            ? `Coverage: worldwide, where there are receivers (${shipRelaySources || "aisstream.io"}).`
            : "Coverage: Finland and the northern Baltic Sea (Digitraffic AIS).") +
        (shipRelayNote ? "\n" + shipRelayNote : "")
    );

    // The open popup rides along with its ship
    const selected = shipSelectedMmsi !== null ? shipRecords.get(shipSelectedMmsi) : undefined;

    if (selected && selectedAt) {

        const html = shipPopupContent(selected, now);

        shipPopup.setLngLat(selectedAt);

        // (rewriting it every time would make the link in it hard to click)
        if (html !== shipPopupHtml) {
            shipPopupHtml = html;
            shipPopup.setHTML(html);
        }

    } else if (shipSelectedMmsi !== null) {

        shipPopup.remove();     // its "close" handler clears the selection
    }
}

function setShipsEnabled(on: boolean): void {

    shipsEnabled = on;

    shipGeneration++;       // drop whatever is still loading

    const toggle = document.getElementById("shipToggle");

    if (toggle) toggle.classList.toggle("layer-on", on);

    const hud = document.getElementById("shipHud");

    if (hud) hud.classList.toggle("visible", on);

    try {
        localStorage.setItem(SHIP_PREF_KEY, on ? "1" : "0");
    } catch (error) {
        // Storage unavailable: preference just won't persist
    }

    clearTimeout(shipPollTimer);
    clearTimeout(shipMoveTimer);
    clearInterval(shipTickTimer);

    if (on) {

        // Look for the relay again each time (a key may have been added since)
        shipRelayOk = null;
        shipRelayNote = "";

        shipTickTimer = setInterval(tickShips, SHIP_TICK_MS);

        refreshShips();

        // (see the "moveend" handler: Pelyr's answer for this area comes a moment later)
        shipMoveTimer = setTimeout(refreshShips, SHIP_RELAY_FOLLOW_UP_MS);

    } else {

        shipRecords.clear();
        shipTrails.clear();

        shipLastUpdate = 0;
        shipDetailsCheckedAt = 0;       // (the details themselves are kept: they stay true)
        shipFailures = 0;

        drawShips([]);
        drawShipTrail(null, null);

        shipHoverPopup.remove();
        shipPopup.remove();

        setShipStatus("OFF");
    }
}


// ==============================================
// S8B. LEGEND, FLAG, ETA, TRAIL AND PHOTO
// ==============================================

// ---------- legend (the box at the bottom left while the layer is on) ----------

function buildShipLegend(): void {

    const legend = document.getElementById("shipLegend");

    if (!legend || legend.childElementCount) return;

    (Object.keys(SHIP_CATEGORIES) as ShipCategory[]).forEach(function(key) {

        const item = document.createElement("span");

        const dot = document.createElement("i");

        dot.style.background = SHIP_CATEGORIES[key].color;

        item.appendChild(dot);
        item.appendChild(document.createTextNode(
            key === "other" ? "Other / not known yet" : SHIP_CATEGORIES[key].label
        ));

        legend.appendChild(item);
    });

    const note = document.createElement("div");

    note.className = "ship-legend-note";
    note.textContent = "Hull shape: points where the ship is heading. Round dot: heading " +
        "unknown. Faded: stopped. Line: the path of the ship you clicked.";

    legend.appendChild(note);
}

function setShipHud(inView: number): void {

    const count = document.getElementById("shipHudCount");

    if (count) count.textContent = inView.toLocaleString("en-US");

    const status = document.getElementById("shipHudStatus");

    if (status) {
        status.textContent = `${shipRecords.size.toLocaleString("en-US")} tracked · ` +
            (shipRelayOk ? (shipRelaySources || "aisstream.io") : "Digitraffic (Finland / Baltic)");
    }
}


// ---------- flag ----------

// The first three digits of a ship's MMSI say where it is registered (the
// ITU's "Maritime Identification Digits"). That is the flag it flies, which
// is often not where its owner is.
const SHIP_FLAGS: Record<string, string> = {};

([
    ["Albania", 201], ["Andorra", 202], ["Austria", 203], ["Portugal (Azores)", 204], ["Belgium", 205],
    ["Belarus", 206], ["Bulgaria", 207], ["Vatican City", 208], ["Cyprus", 209, 210, 212],
    ["Germany", 211, 218], ["Georgia", 213], ["Moldova", 214], ["Malta", 215, 229, 248, 249, 256],
    ["Armenia", 216], ["Denmark", 219, 220], ["Spain", 224, 225], ["France", 226, 227, 228],
    ["Finland", 230], ["Faroe Islands", 231], ["United Kingdom", 232, 233, 234, 235], ["Gibraltar", 236],
    ["Greece", 237, 239, 240, 241], ["Croatia", 238], ["Morocco", 242], ["Hungary", 243],
    ["Netherlands", 244, 245, 246], ["Italy", 247], ["Ireland", 250], ["Iceland", 251],
    ["Liechtenstein", 252], ["Luxembourg", 253], ["Monaco", 254], ["Portugal (Madeira)", 255],
    ["Norway", 257, 258, 259], ["Poland", 261], ["Montenegro", 262], ["Portugal", 263], ["Romania", 264],
    ["Sweden", 265, 266], ["Slovakia", 267], ["San Marino", 268], ["Switzerland", 269], ["Czechia", 270],
    ["Türkiye", 271], ["Ukraine", 272], ["Russia", 273], ["North Macedonia", 274], ["Latvia", 275],
    ["Estonia", 276], ["Lithuania", 277], ["Slovenia", 278], ["Serbia", 279],

    ["Anguilla", 301], ["United States (Alaska)", 303], ["Antigua and Barbuda", 304, 305],
    ["Dutch Caribbean", 306], ["Aruba", 307], ["Bahamas", 308, 309, 311], ["Bermuda", 310], ["Belize", 312],
    ["Barbados", 314], ["Canada", 316], ["Cayman Islands", 319], ["Costa Rica", 321], ["Cuba", 323],
    ["Dominica", 325], ["Dominican Republic", 327], ["Guadeloupe", 329], ["Grenada", 330],
    ["Greenland", 331], ["Guatemala", 332], ["Honduras", 334], ["Haiti", 336],
    ["United States", 338, 366, 367, 368, 369], ["Jamaica", 339], ["Saint Kitts and Nevis", 341],
    ["Saint Lucia", 343], ["Mexico", 345], ["Martinique", 347], ["Montserrat", 348], ["Nicaragua", 350],
    ["Panama", 351, 352, 353, 354, 355, 356, 357, 370, 371, 372, 373, 374], ["Puerto Rico", 358],
    ["El Salvador", 359], ["Saint Pierre and Miquelon", 361], ["Trinidad and Tobago", 362],
    ["Turks and Caicos Islands", 364], ["Saint Vincent and the Grenadines", 375, 376, 377],
    ["British Virgin Islands", 378], ["US Virgin Islands", 379],

    ["Afghanistan", 401], ["Saudi Arabia", 403], ["Bangladesh", 405], ["Bahrain", 408], ["Bhutan", 410],
    ["China", 412, 413, 414], ["Taiwan", 416], ["Sri Lanka", 417], ["India", 419], ["Iran", 422],
    ["Azerbaijan", 423], ["Iraq", 425], ["Israel", 428], ["Japan", 431, 432], ["Turkmenistan", 434],
    ["Kazakhstan", 436], ["Uzbekistan", 437], ["Jordan", 438], ["South Korea", 440, 441],
    ["Palestine", 443], ["North Korea", 445], ["Kuwait", 447], ["Lebanon", 450], ["Kyrgyzstan", 451],
    ["Macao", 453], ["Maldives", 455], ["Mongolia", 457], ["Nepal", 459], ["Oman", 461], ["Pakistan", 463],
    ["Qatar", 466], ["Syria", 468], ["United Arab Emirates", 470, 471], ["Tajikistan", 472],
    ["Yemen", 473, 475], ["Hong Kong", 477], ["Bosnia and Herzegovina", 478],

    ["Australia", 503], ["Myanmar", 506], ["Brunei", 508], ["Micronesia", 510], ["Palau", 511],
    ["New Zealand", 512], ["Cambodia", 514, 515], ["Christmas Island", 516], ["Cook Islands", 518],
    ["Fiji", 520], ["Cocos Islands", 523], ["Indonesia", 525], ["Kiribati", 529], ["Laos", 531],
    ["Malaysia", 533], ["Northern Mariana Islands", 536], ["Marshall Islands", 538],
    ["New Caledonia", 540], ["Niue", 542], ["Nauru", 544], ["French Polynesia", 546],
    ["Philippines", 548], ["Timor-Leste", 550], ["Papua New Guinea", 553], ["Pitcairn Islands", 555],
    ["Solomon Islands", 557], ["American Samoa", 559], ["Samoa", 561],
    ["Singapore", 563, 564, 565, 566], ["Thailand", 567], ["Tonga", 570], ["Tuvalu", 572],
    ["Vietnam", 574], ["Vanuatu", 576, 577], ["Wallis and Futuna", 578],

    ["South Africa", 601], ["Angola", 603], ["Algeria", 605], ["Ascension Island", 608], ["Burundi", 609],
    ["Benin", 610], ["Botswana", 611], ["Central African Republic", 612], ["Cameroon", 613],
    ["Congo", 615], ["Comoros", 616, 620], ["Cabo Verde", 617], ["Côte d'Ivoire", 619], ["Djibouti", 621],
    ["Egypt", 622], ["Ethiopia", 624], ["Eritrea", 625], ["Gabon", 626], ["Ghana", 627], ["Gambia", 629],
    ["Guinea-Bissau", 630], ["Equatorial Guinea", 631], ["Guinea", 632], ["Burkina Faso", 633],
    ["Kenya", 634], ["Liberia", 636, 637], ["South Sudan", 638], ["Libya", 642], ["Lesotho", 644],
    ["Mauritius", 645], ["Madagascar", 647], ["Mali", 649], ["Mozambique", 650], ["Mauritania", 654],
    ["Malawi", 655], ["Niger", 656], ["Nigeria", 657], ["Namibia", 659], ["Réunion", 660], ["Rwanda", 661],
    ["Sudan", 662], ["Senegal", 663], ["Seychelles", 664], ["Saint Helena", 665], ["Somalia", 666],
    ["Sierra Leone", 667], ["São Tomé and Príncipe", 668], ["Eswatini", 669], ["Chad", 670], ["Togo", 671],
    ["Tunisia", 672], ["Tanzania", 674, 677], ["Uganda", 675], ["DR Congo", 676], ["Zambia", 678],
    ["Zimbabwe", 679],

    ["Argentina", 701], ["Brazil", 710], ["Bolivia", 720], ["Chile", 725], ["Colombia", 730],
    ["Ecuador", 735], ["Falkland Islands", 740], ["French Guiana", 745], ["Guyana", 750],
    ["Paraguay", 755], ["Peru", 760], ["Suriname", 765], ["Uruguay", 770], ["Venezuela", 775]

] as (string | number)[][]).forEach(function(entry) {
    entry.slice(1).forEach(code => { SHIP_FLAGS[String(code)] = String(entry[0]); });
});

function shipFlag(mmsi: number): string {
    return SHIP_FLAGS[String(mmsi).slice(0, 3)] || "";
}


// ---------- expected arrival ----------

const SHIP_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// Digitraffic sends AIS's own packing: month (4 bits), day (5), hour (5), minute (6)
function unpackShipEta(value: unknown): string {

    if (typeof value !== "number" || !(value > 0)) return "";

    const two = (n: number) => String(n).padStart(2, "0");

    return `${two((value >> 16) & 15)}-${two((value >> 11) & 31)}T${two((value >> 6) & 31)}:${two(value & 63)}`;
}

// "11-17T20:30" -> "17 Nov 20:30 UTC". The crew types it in, so it can be
// stale or left blank (month 0, hour 24 and minute 60 all mean "not set").
function formatShipEta(text: string): string {

    const match = /^(\d\d)-(\d\d)T(\d\d):(\d\d)/.exec(text || "");

    if (!match) return "";

    const [month, day, hour, minute] = match.slice(1).map(Number);

    if (month < 1 || month > 12 || day < 1 || day > 31) return "";

    const time = hour < 24 && minute < 60 ? ` ${match[3]}:${match[4]} UTC` : "";

    return `${day} ${SHIP_MONTHS[month - 1]}${time}`;
}


// ---------- trail ----------
//
// Every ship's positions are noted as they come in (only when it has moved,
// at most one a minute). With server.py's relay the trail goes back further:
// it has been noting them since it started listening, and hands them over
// when a ship is clicked.

const SHIP_TRAIL_POINTS = 180;          // most points kept per ship
const SHIP_TRAIL_EVERY_MS = 60000;
const SHIP_TRAIL_MOVED = 0.0005;        // degrees (about 50 m)
const SHIP_TRAIL_MAX_KNOTS = 70;        // a jump faster than this is a bad position

/** [longitude, latitude, time in ms] */
type ShipTrailPoint = number[];

const shipTrails = new Map<number, ShipTrailPoint[]>();

let lastShipTrailGeoJSON: GeoFeatureCollection = { type: "FeatureCollection", features: [] };
let shipTrailDrawnKey = "";

function noteShipTrail(mmsi: number, lon: number, lat: number, time: number): void {

    const trail = shipTrails.get(mmsi);

    if (!trail || !trail.length) {
        shipTrails.set(mmsi, [[lon, lat, time]]);
        return;
    }

    const last = trail[trail.length - 1];

    const ms = time - last[2];

    if (ms < SHIP_TRAIL_EVERY_MS) return;

    const dLat = Math.abs(lat - last[1]);
    const dLon = Math.min(Math.abs(lon - last[0]), 360 - Math.abs(lon - last[0]));

    if (dLat < SHIP_TRAIL_MOVED && dLon < SHIP_TRAIL_MOVED) return;

    // (rough: a degree is at most 60 nautical miles)
    if (Math.max(dLat, dLon * 0.3) * 60 / (ms / 3600000) > SHIP_TRAIL_MAX_KNOTS) return;

    trail.push([lon, lat, time]);

    if (trail.length > SHIP_TRAIL_POINTS) trail.shift();
}

// The relay's longer trail for the clicked ship
async function loadShipTrail(mmsi: number): Promise<void> {

    if (!shipRelayOk) return;

    try {

        const response = await fetch(`${SHIP_RELAY_PATH}/trail?mmsi=${mmsi}`);

        if (!response.ok) return;

        const payload = await response.json() as { points?: unknown };

        const points = (Array.isArray(payload.points) ? payload.points : []).filter(
            (point): point is ShipTrailPoint =>
                Array.isArray(point) && point.length >= 3 && point.every(value => typeof value === "number")
        );

        if (!points.length || !shipsEnabled) return;

        // Ours may have newer points than the relay's last one: keep those
        const lastTime = points[points.length - 1][2];

        const newer = (shipTrails.get(mmsi) || []).filter(point => point[2] > lastTime + SHIP_TRAIL_EVERY_MS);

        shipTrails.set(mmsi, points.concat(newer).slice(-SHIP_TRAIL_POINTS));

        tickShips();

    } catch (error) {
        // No longer trail then: the one noted here still shows
    }
}

// Draw the selected ship's trail, ending at the ship itself (null = none)
function drawShipTrail(mmsi: number | null, at: [number, number] | null): void {

    const trail = mmsi !== null ? shipTrails.get(mmsi) : undefined;

    const points = (trail || []).map(point => [point[0], point[1]]);

    if (at) points.push(at);

    const details = mmsi !== null ? shipDetails.get(mmsi) : undefined;

    const color = SHIP_CATEGORIES[shipCategory(details ? details.type : 0)].color;

    // (nothing new to draw: leave the map alone)
    const key = points.length < 2 ? "" : `${mmsi}|${points.length}|${points[points.length - 1].join(",")}|${color}`;

    if (key === shipTrailDrawnKey) return;

    shipTrailDrawnKey = key;

    lastShipTrailGeoJSON = {
        type: "FeatureCollection",
        features: points.length < 2 ? [] : [{
            type: "Feature",
            geometry: { type: "LineString", coordinates: points },
            properties: { color: color }
        }]
    };

    const source = map && map.getSource(SHIP_TRAIL_SOURCE) as GeoJSONMapSource | undefined;

    if (source) source.setData(lastShipTrailGeoJSON);
}


// ---------- photo ----------
//
// Wikidata knows many ships by their IMO number, and a good share of those
// have a freely licensed photo on Wikimedia Commons. Well-known ships
// (ferries, cruise ships, big tankers and container ships) usually have
// one; most small craft do not, and ships without an IMO number never do.
// No key; one lookup per ship, when it is clicked.

const SHIP_WIKIDATA_API = "https://www.wikidata.org/w/api.php";
const SHIP_PHOTO_WIDTH = 520;

/** By IMO number. null = looked up, there is none. */
const shipPhotos = new Map<number, { src: string; page: string } | null>();

const shipPhotoLoading = new Set<number>();

async function shipWikidata(params: Record<string, string>): Promise<any> {

    // (origin=* is how Wikimedia allows requests from other websites)
    const query = new URLSearchParams({ ...params, format: "json", origin: "*" });

    const response = await fetch(`${SHIP_WIKIDATA_API}?${query}`);

    if (!response.ok) throw new Error(`Wikidata answered ${response.status}`);

    return await response.json();
}

async function loadShipPhoto(imo: number): Promise<void> {

    if (shipPhotos.has(imo) || shipPhotoLoading.has(imo)) return;

    shipPhotoLoading.add(imo);

    try {

        // 1. the ship's entry: the one whose "IMO ship number" (P458) is this
        const found = await shipWikidata({
            action: "query",
            list: "search",
            srsearch: `haswbstatement:P458=${imo}`,
            srlimit: "1"
        });

        const entity = found?.query?.search?.[0]?.title;

        let file = "";

        // 2. its "image" (P18): the name of a file on Wikimedia Commons
        if (typeof entity === "string" && /^Q\d+$/.test(entity)) {

            const claims = await shipWikidata({ action: "wbgetclaims", entity: entity, property: "P18" });

            const value = claims?.claims?.P18?.[0]?.mainsnak?.datavalue?.value;

            if (typeof value === "string") file = value;
        }

        const name = encodeURIComponent(file.replace(/ /g, "_"));

        shipPhotos.set(imo, file ? {
            src: `https://commons.wikimedia.org/wiki/Special:FilePath/${name}?width=${SHIP_PHOTO_WIDTH}`,
            page: `https://commons.wikimedia.org/wiki/File:${name}`
        } : null);

        if (file) tickShips();      // the open popup picks it up

    } catch (error) {

        console.warn("Ship photo lookup failed:", error);

    } finally {

        shipPhotoLoading.delete(imo);
    }
}


// ==============================================
// S9. HOVER + CLICK
// ==============================================

function shipFeatureAt(point: MapPoint): MapFeature | null {

    if (!shipsEnabled || !map || !map.getLayer(SHIP_LAYER)) return null;

    const pad = 5;

    const features = map.queryRenderedFeatures(
        [
            [point.x - pad, point.y - pad],
            [point.x + pad, point.y + pad]
        ],
        { layers: [SHIP_LAYER] }
    );

    return features.length ? features[0] : null;
}

// Used by script.js and transit.js so a click on a ship doesn't also drop a
// pin or pick the ferry line underneath.
function isShipAtPoint(point: MapPoint): boolean {
    return Boolean(shipFeatureAt(point));
}

function shipSpeedText(ship: ShipRecord): string {
    return ship.sog === null ? "speed unknown" : `${ship.sog.toFixed(1)} kn`;
}

function shipPopupContent(ship: ShipRecord, now: number): string {

    const details = shipDetails.get(ship.mmsi);

    const lines: string[] = [];

    const photo = details && details.imo ? shipPhotos.get(details.imo) : null;

    lines.push(
        (photo
            ? `<a href="${escapeHTML(photo.page)}" target="_blank" rel="noopener noreferrer"` +
              ` title="Photo from Wikimedia Commons: click for author and licence">` +
              `<img class="ship-popup-photo" src="${escapeHTML(photo.src)}" alt=""></a>`
            : "") +
        `<strong>${escapeHTML(shipName(ship.mmsi))}</strong>` +
        ` <span class="transit-popup-mode">${escapeHTML(shipTypeLabel(details ? details.type : 0).toUpperCase())}</span>`
    );

    const eta = details ? formatShipEta(details.eta) : "";

    if (details && details.destination) {
        lines.push(`To ${escapeHTML(details.destination)}${eta ? ` · ETA ${eta}` : ""}`);
    } else if (eta) {
        lines.push(`ETA ${eta}`);
    }

    const flag = shipFlag(ship.mmsi);

    if (flag) lines.push(`Flag: ${escapeHTML(flag)}`);

    const status = ship.navStat !== null ? SHIP_NAV_STATUS[ship.navStat] : "";

    lines.push(
        [
            shipSpeedText(ship),
            isShipMoving(ship) && ship.cog !== null ? `course ${Math.round(ship.cog)}&deg;` : "",
            status
        ].filter(Boolean).join(" · ")
    );

    if (details && (details.length || details.draught)) {
        lines.push(
            [
                details.length && details.beam ? `${details.length} &times; ${details.beam} m` : "",
                details.draught ? `draught ${details.draught.toFixed(1)} m` : ""
            ].filter(Boolean).join(" · ")
        );
    }

    lines.push(
        [
            `MMSI ${ship.mmsi}`,
            details && details.imo ? `IMO ${details.imo}` : "",
            details && details.callSign ? escapeHTML(details.callSign) : ""
        ].filter(Boolean).join(" · ")
    );

    lines.push(
        `<small>Position reported ${formatShipAge(now - ship.t0)}` +
        `${isShipMoving(ship) ? ", moved along its course since" : ""}</small>`
    );

    // Some sources (Pelyr) must be credited wherever their data is shown
    if (ship.credit) lines.push(`<small>${escapeHTML(ship.credit)}</small>`);

    if (photo) lines.push("<small>Photo: Wikimedia Commons (click it for author and licence)</small>");

    return lines.join("<br>") +
        `<a class="transit-popup-button" target="_blank" rel="noopener noreferrer"` +
        ` href="https://www.marinetraffic.com/en/ais/details/ships/mmsi:${ship.mmsi}">OPEN IN MARINETRAFFIC</a>`;
}

// Open a ship's popup (it then follows the ship, see tickShips)
function showShip(ship: ShipRecord): void {

    shipSelectedMmsi = ship.mmsi;

    shipHoverPopup.remove();

    const now = Date.now();

    shipPopupHtml = shipPopupContent(ship, now);

    shipPopup.setLngLat(shipPosition(ship, now)).setHTML(shipPopupHtml);

    // (adding an open popup again would close it first, and closing
    // clears the selection)
    if (!shipPopup.isOpen()) shipPopup.addTo(map);

    // Its path so far, and a photo if there is a free one (both arrive a moment later)
    loadShipTrail(ship.mmsi);

    const details = shipDetails.get(ship.mmsi);

    if (details && details.imo) loadShipPhoto(details.imo);

    tickShips();
}

function onShipHover(e: MapMouseEvent): void {

    if (!shipsEnabled) return;

    // Aircraft and airports have their own tooltip, and go first
    const feature = isFlightAtPoint(e.point) ? null : shipFeatureAt(e.point);

    const ship = feature ? shipRecords.get(Number(feature.properties.mmsi)) : undefined;

    // (the clicked ship already has its popup open)
    if (!ship || ship.mmsi === shipSelectedMmsi) {
        shipHoverPopup.remove();
        return;
    }

    map.getCanvas().style.cursor = "pointer";

    const details = shipDetails.get(ship.mmsi);

    shipHoverPopup
        .setLngLat(e.lngLat)
        .setText(
            shipName(ship.mmsi) + "  |  " +
            shipTypeLabel(details ? details.type : 0) + "  |  " +
            (isShipMoving(ship) ? shipSpeedText(ship) : "stopped")
        )
        .addTo(map);
}

function onShipClick(e: MapMouseEvent): void {

    if (isFlightAtPoint(e.point)) return;

    const feature = shipFeatureAt(e.point);

    const ship = feature ? shipRecords.get(Number(feature.properties.mmsi)) : undefined;

    if (ship) showShip(ship);
}


// ==============================================
// S10. START
// ==============================================

function initializeShips(): void {

    shipHoverPopup = new maplibregl.Popup({
        closeButton: false,
        closeOnClick: false,
        offset: 12,
        className: "flight-popup"
    });

    shipPopup = new maplibregl.Popup({
        closeButton: true,
        closeOnClick: false,
        offset: 12,
        maxWidth: "280px",
        className: "transit-popup"
    });

    shipPopup.on("close", function() {
        shipSelectedMmsi = null;
        shipPopupHtml = "";

        drawShipTrail(null, null);
    });


    // Changing the base map removes all layers, so rebuild them each time.
    map.on("styleimagemissing", onShipImageMissing);

    map.on("style.load", setupShipLayers);
    map.on("styledata", ensureShipLayers);
    map.on("idle", ensureShipLayers);

    // Only the ships near the screen are drawn: catch up when it moves.
    // The relay only sends the ships of the area on screen, so ask it again.
    map.on("moveend", function() {

        tickShips();

        clearTimeout(shipMoveTimer);

        if (shipsEnabled && shipRelayOk) {
            shipMoveTimer = setTimeout(function() {

                refreshShips();

                // The relay asks Pelyr about the new area in the background:
                // look again shortly, for what that brought
                shipMoveTimer = setTimeout(refreshShips, SHIP_RELAY_FOLLOW_UP_MS);

            }, SHIP_MOVE_DELAY_MS);
        }
    });

    map.on("mousemove", onShipHover);
    map.on("click", onShipClick);


    const toggle = document.getElementById("shipToggle");

    if (toggle) {
        toggle.addEventListener("click", () => setShipsEnabled(!shipsEnabled));
    }

    buildShipLegend();


    // Catch up when the tab comes back to the front
    document.addEventListener("visibilitychange", function() {
        if (!document.hidden) refreshShips();
    });


    // Restore last session's choice once the map is ready
    map.once("load", function() {

        let enabled = false;

        try {
            enabled = localStorage.getItem(SHIP_PREF_KEY) === "1";
        } catch (error) {
            // Storage unavailable: stays off
        }

        if (enabled) setShipsEnabled(true);
    });
}
