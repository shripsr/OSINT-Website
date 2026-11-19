/* ==============================================
   OSINT MAP - SATELLITES (live positions, orbit paths and details)
   SOURCE: src/satellites.ts  ->  compiled to satellites.js by "npm run build"
           (edit the .ts file, never the .js; satellites.js must load
           AFTER cables.js and satellite.js, and BEFORE script.js)
   DATA: CelesTrak (celestrak.org): orbital elements of every active satellite
   plus the SATCAT register (owner, launch date and site, size). Asked through
   server.py ("/api/satellites"), which keeps one copy and refreshes it every
   3 hours (CelesTrak only allows one download per 2 hours).

   Positions are not downloaded: the page works them out itself every couple
   of seconds with the SGP4 model (satellite.js) from the orbital elements,
   exactly as NORAD does. Accuracy is about a kilometre for fresh elements.

   One sidebar switch ("Satellites") shows ~12,000 dots coloured by kind.
   Click the legend entries to hide / show a kind. Click a satellite for its
   details; its ground track (the line it draws over the Earth's surface) is
   drawn: solid for the next full orbit, dashed for the last half orbit.
   ============================================== */


// ==============================================
// S1. CONFIGURATION
// ==============================================

const SAT_API = "/api/satellites";
const SAT_PREF_KEY = "osint_map_satellites_enabled";
const SAT_SOURCE = "sat-source";
const SAT_SELECTED_SOURCE = "sat-selected-source";
const SAT_ORBIT_SOURCE = "sat-orbit-source";
const SAT_LAYER = "sat-layer";
const SAT_LABEL_LAYER = "sat-label-layer";
const SAT_SELECTED_LAYER = "sat-selected-layer";
const SAT_ORBIT_PAST_LAYER = "sat-orbit-past-layer";
const SAT_ORBIT_FUTURE_LAYER = "sat-orbit-future-layer";
const SAT_TICK_MS = 2000;               // how often every position is worked out again
const SAT_ORBIT_REFRESH_MS = 20000;     // how often the selected satellite's path is redrawn
const SAT_ORBIT_STEPS = 180;            // points per orbit
const SAT_ORBIT_PAST = 0.5;             // orbits behind the satellite that are drawn
const SAT_CLICK_PAD = 6;
const SAT_UPGRADE_MS = 16 * 60000;      // how often to retry the full catalogue when showing the small one
const SAT_STALE_DAYS = 14;              // older elements are flagged as "may be off"

type SatKind = "station" | "starlink" | "constellation" | "navigation" | "weather" | "other";

const SAT_KINDS: Record<SatKind, { label: string; color: string }> = {
    station: { label: "Space stations / crewed", color: "#ff5c5c" },
    starlink: { label: "Starlink", color: "#6ea8ff" },
    constellation: { label: "Other constellations", color: "#b48cff" },
    navigation: { label: "Navigation (GPS, Galileo, ...)", color: "#3ddc97" },
    weather: { label: "Weather / Earth observation", color: "#ffb347" },
    other: { label: "Other satellites", color: "#c9d4e0" }
};

// What kind a satellite is: guessed from its name (the register has no such field)
const SAT_KIND_PATTERNS: [SatKind, RegExp][] = [
    ["station", /ISS \(|ZARYA|CSS \(|TIANHE|WENTIAN|MENGTIAN|SHENZHOU|TIANZHOU|PROGRESS|SOYUZ-MS|CREW DRAGON|CARGO DRAGON|CYGNUS/],
    ["starlink", /^STARLINK/],
    ["constellation", /^(ONEWEB|IRIDIUM|GLOBALSTAR|ORBCOMM|FLOCK|LEMUR|SPIRE|KUIPER|QIANFAN|GUOWANG|SPACEMOBILE|BLUEBIRD|BLUEWALKER|SKYSAT|CAPELLA|ICEYE|JILIN|YAOGAN|PLEIADES|TELESAT|LIGHTSPEED)/],
    ["navigation", /^(GPS|NAVSTAR|GLONASS|GALILEO|GSAT0|BEIDOU|QZS|IRNSS|NAVIC)|COSMOS \d+ \(GLONASS/],
    ["weather", /^(NOAA|GOES|METOP|METEOSAT|FENGYUN|FY-|HIMAWARI|METEOR-M|SUOMI|JPSS|LANDSAT|SENTINEL|TERRA|AQUA|AURA|DMSP|GK-2|ELEKTRO|INSAT|SMOS|CRYOSAT|SWOT|NIMBUS)/]
];

const SAT_OWNERS: Record<string, string> = {
    US: "United States", PRC: "China", CIS: "Russia / ex-USSR", UK: "United Kingdom",
    FR: "France", JPN: "Japan", IND: "India", ESA: "European Space Agency",
    GER: "Germany", CA: "Canada", IT: "Italy", SPN: "Spain", AUS: "Australia",
    ISS: "International (ISS partners)", ITSO: "Intelsat", SES: "SES (Luxembourg)",
    EUME: "EUMETSAT", EUTE: "Eutelsat", GLOB: "Globalstar", IRID: "Iridium",
    ORB: "ORBCOMM", O3B: "O3b (SES)", NATO: "NATO", SKOR: "South Korea",
    NKOR: "North Korea", ISRA: "Israel", IRAN: "Iran", TURK: "Turkey",
    UAE: "United Arab Emirates", SAUD: "Saudi Arabia", AB: "Arab Satellite Org.",
    BRAZ: "Brazil", MEX: "Mexico", INDO: "Indonesia", THAI: "Thailand",
    SING: "Singapore", ROC: "Taiwan", NOR: "Norway", SWED: "Sweden", NETH: "Netherlands",
    LUXE: "Luxembourg", POL: "Poland", UKR: "Ukraine", NZ: "New Zealand", SAFR: "South Africa",
    EGYP: "Egypt", PAKI: "Pakistan", KAZ: "Kazakhstan", SEAL: "Sea Launch", TBD: "Not known"
};

const SAT_SITES: Record<string, string> = {
    AFETR: "Cape Canaveral / Kennedy, USA", AFWTR: "Vandenberg, USA", ERAS: "Eastern Range, USA",
    WLPIS: "Wallops Island, USA", KWAJ: "Kwajalein, Marshall Islands",
    RLLB: "Mahia (Rocket Lab), New Zealand", RLLC: "Wallops (Rocket Lab), USA",
    KSCUT: "Uchinoura, Japan", TANSC: "Tanegashima, Japan", FRGUI: "Kourou, French Guiana",
    TYMSC: "Baikonur, Kazakhstan", PKMTR: "Plesetsk, Russia", VOSTO: "Vostochny, Russia",
    YUNSC: "Yasny, Russia", JSC: "Jiuquan, China", TSC: "Taiyuan, China",
    XSC: "Xichang, China", WSC: "Wenchang, China", SRILR: "Sriharikota, India",
    NSC: "Naro, South Korea", SEMLS: "Semnan, Iran", SEAL: "Sea Launch (floating)",
    SNMLP: "San Marco platform, Kenya", PMRF: "Pacific Missile Range, USA", HGSTR: "Hainan, China"
};

const SAT_OPS: Record<string, string> = {
    "+": "Operational", "-": "Non-operational", "P": "Partially operational",
    "B": "Backup / standby", "S": "Spare", "X": "Extended mission", "D": "Decayed", "?": "Unknown"
};

const SAT_TYPES: Record<string, string> = {
    PAY: "Payload (satellite)", "R/B": "Rocket body", DEB: "Debris", UNK: "Unknown"
};


// ==============================================
// S2. TYPES
// ==============================================

// One entry of CelesTrak's GP list (only the fields used here)
interface SatElements {
    OBJECT_NAME: string;
    OBJECT_ID: string;
    EPOCH: string;
    MEAN_MOTION: number;
    ECCENTRICITY: number;
    INCLINATION: number;
    NORAD_CAT_ID: number;
    REV_AT_EPOCH?: number;
}

// What the SATCAT register says about it
interface SatInfo {
    ty?: string;        // payload / rocket body / debris
    ow?: string;        // owner code
    ld?: string;        // launch date
    ls?: string;        // launch site code
    os?: string;        // operational status code
    rcs?: number;       // radar cross section, m2
    apo?: number;       // apogee, km
    per?: number;       // perigee, km
    dd?: string;        // decay date
}

interface SatRecord {
    id: number;
    name: string;
    kind: SatKind;
    elements: SatElements;
    info: SatInfo;
    satrec: any;
    epochMs: number;
    periodMin: number;
    // where it is now (set by every tick)
    ok: boolean;
    lon: number;
    lat: number;
    altKm: number;
    kmPerS: number;
}

interface SatReply {
    fetched?: number;
    group?: string;             // which CelesTrak feed this is
    full?: boolean;             // false: the small fallback feed, not every active satellite
    gp: SatElements[];
    cat: Record<string, SatInfo>;
}


// ==============================================
// S3. STATE
// ==============================================

let satEnabled = false;
let satGeneration = 0;                  // bumps to drop answers that arrive too late
let satLoading: Promise<void> | null = null;
let satFetched = 0;
let satFull = true;
let satGroup = "";
let satUpgradeTimer: ReturnType<typeof setTimeout> | undefined;
let satTimer: ReturnType<typeof setInterval> | undefined;
let satOrbitAt = 0;
let satSelectedId = 0;
let satHoverPopup: import("maplibre-gl").Popup;
let satPopup: import("maplibre-gl").Popup;
const satRecords = new Map<number, SatRecord>();
const satHidden = new Set<SatKind>();
const SAT_EMPTY: GeoFeatureCollection = { type: "FeatureCollection", features: [] };
let lastSatGeoJSON: GeoFeatureCollection = SAT_EMPTY;


// ==============================================
// S4. SMALL HELPERS
// ==============================================

function setSatStatus(text: string, detail = ""): void {

    const count = document.getElementById("satCount");

    if (count) count.textContent = text;

    const toggle = document.getElementById("satToggle");

    if (toggle) toggle.title = detail;
}

function satKindOf(name: string): SatKind {

    for (const entry of SAT_KIND_PATTERNS) {
        if (entry[1].test(name)) return entry[0];
    }

    return "other";
}

function satOwner(code: string | undefined): string {

    if (!code) return "";

    return SAT_OWNERS[code] ? `${SAT_OWNERS[code]} (${code})` : code;
}

function satSite(code: string | undefined): string {

    if (!code) return "";

    return SAT_SITES[code] ? `${SAT_SITES[code]}` : code;
}

function satFmt(value: number, digits = 0): string {
    return value.toLocaleString("en-US", { maximumFractionDigits: digits, minimumFractionDigits: digits });
}

function satAgeText(ms: number): string {

    const hours = ms / 3600000;

    if (hours < 1) return "less than an hour ago";

    if (hours < 48) return `${Math.round(hours)} hours ago`;

    return `${Math.round(hours / 24)} days ago`;
}

function satYearsSince(date: string): string {

    const launched = Date.parse(date);

    if (isNaN(launched)) return "";

    const years = (Date.now() - launched) / (365.25 * 86400000);

    if (years < 1 / 12) return "less than a month ago";

    if (years < 1) return `${Math.round(years * 12)} months ago`;

    return `${years.toFixed(1)} years ago`;
}

// LEO, MEO, GEO ... from the orbit's shape
function satOrbitClass(rec: SatRecord): string {

    const perigee = rec.info.per;
    const apogee = rec.info.apo;
    const ecc = rec.elements.ECCENTRICITY;
    const period = rec.periodMin;

    if (period > 1400 && period < 1480 && ecc < 0.05) {
        return rec.elements.INCLINATION < 25 ? "Geostationary / geosynchronous (GEO)" : "Inclined geosynchronous";
    }

    if (ecc > 0.25) return "Highly elliptical (HEO)";

    if (apogee !== undefined && apogee < 2000) return "Low Earth orbit (LEO)";

    if (period < 128) return "Low Earth orbit (LEO)";

    if (period < 1400) return "Medium Earth orbit (MEO)";

    return "High orbit";
}

function satRcsText(rcs: number | undefined): string {

    if (rcs === undefined || rcs === null) return "";

    const size = rcs < 0.1 ? "small" : rcs <= 1 ? "medium" : "large";

    return `${size} (${satFmt(rcs, rcs < 10 ? 2 : 0)} m²)`;
}

async function satFetch(): Promise<SatReply> {

    const response = await fetch(SAT_API);

    if (!response.ok) {

        let detail = `HTTP ${response.status}`;

        try {
            const body = await response.json();
            if (body && body.error) detail = String(body.error);
        } catch (error) {
            // no readable reason: keep the status code
        }

        throw new Error(detail);
    }

    return response.json();
}


// ==============================================
// S5. LOADING + WORKING OUT POSITIONS
// ==============================================

function loadSatellites(): Promise<void> {

    if (satRecords.size) return Promise.resolve();

    if (satLoading) return satLoading;

    satLoading = satFetch()
        .then(function(reply) {

            satFetched = reply.fetched || 0;
            satFull = reply.full !== false;
            satGroup = reply.group || "";

            satRecords.clear();

            reply.gp.forEach(function(elements) {

                try {

                    const satrec = satellite.json2satrec(elements);

                    const info = reply.cat[String(elements.NORAD_CAT_ID)] || {};

                    satRecords.set(elements.NORAD_CAT_ID, {
                        id: elements.NORAD_CAT_ID,
                        name: elements.OBJECT_NAME,
                        kind: satKindOf(elements.OBJECT_NAME),
                        elements: elements,
                        info: info,
                        satrec: satrec,
                        epochMs: Date.parse(elements.EPOCH.endsWith("Z") ? elements.EPOCH : elements.EPOCH + "Z"),
                        periodMin: elements.MEAN_MOTION > 0 ? 1440 / elements.MEAN_MOTION : 0,
                        ok: false,
                        lon: 0,
                        lat: 0,
                        altKm: 0,
                        kmPerS: 0
                    });

                } catch (error) {
                    // one broken element set: leave that satellite out
                }
            });
        })
        .finally(function() {
            satLoading = null;
        });

    return satLoading;
}

// Where the satellite is at `date`, or null if the model gives up
function satPosition(rec: SatRecord, date: Date, gmst: number):
    { lon: number; lat: number; altKm: number; kmPerS: number } | null {

    const state = satellite.propagate(rec.satrec, date);

    if (!state || !state.position || typeof state.position === "boolean") return null;

    const geo = satellite.eciToGeodetic(state.position, gmst);

    const lat = satellite.degreesLat(geo.latitude);
    const lon = satellite.degreesLong(geo.longitude);

    if (!isFinite(lat) || !isFinite(lon) || !isFinite(geo.height)) return null;

    const v = state.velocity && typeof state.velocity !== "boolean" ? state.velocity : null;

    return {
        lon: lon,
        lat: lat,
        altKm: geo.height,
        kmPerS: v ? Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z) : 0
    };
}

// Splits a path where it crosses the 180 degree line, so it isn't drawn
// straight across the whole map
function satSplitPath(points: [number, number][]): [number, number][][] {

    const parts: [number, number][][] = [];

    let current: [number, number][] = [];

    points.forEach(function(point, index) {

        if (index > 0) {

            const previous = points[index - 1];

            if (Math.abs(point[0] - previous[0]) > 180) {

                // crossing: finish the line at the edge, start the next one on the other side
                const edge = previous[0] > 0 ? 180 : -180;

                const span = (point[0] + (previous[0] > 0 ? 360 : -360)) - previous[0];

                const share = span === 0 ? 0 : (edge - previous[0]) / span;

                const lat = previous[1] + (point[1] - previous[1]) * share;

                current.push([edge, lat]);

                parts.push(current);

                current = [[-edge, lat]];
            }
        }

        current.push(point);
    });

    if (current.length > 1) parts.push(current);

    return parts.filter(part => part.length > 1);
}

function satOrbitFeatures(rec: SatRecord): GeoFeature[] {

    const now = Date.now();

    const period = rec.periodMin * 60000;

    if (!period || period < 60000) return [];

    const color = SAT_KINDS[rec.kind].color;

    const make = function(from: number, to: number, part: string): GeoFeature[] {

        const step = (to - from) / SAT_ORBIT_STEPS;

        const points: [number, number][] = [];

        for (let i = 0; i <= SAT_ORBIT_STEPS; i++) {

            const date = new Date(from + step * i);

            const where = satPosition(rec, date, satellite.gstime(date));

            if (where) points.push([where.lon, where.lat]);
        }

        return satSplitPath(points).map(function(part_) {
            return {
                type: "Feature" as const,
                properties: { part: part, color: color },
                geometry: { type: "LineString" as const, coordinates: part_ }
            };
        });
    };

    return [
        ...make(now - period * SAT_ORBIT_PAST, now, "past"),
        ...make(now, now + period, "future")
    ];
}

function drawSatOrbit(rec: SatRecord | null): void {

    const source = map && map.getSource(SAT_ORBIT_SOURCE) as GeoJSONMapSource | undefined;

    if (!source) return;

    satOrbitAt = Date.now();

    source.setData(rec
        ? { type: "FeatureCollection", features: satOrbitFeatures(rec) }
        : SAT_EMPTY);
}

function drawSatSelected(rec: SatRecord | null): void {

    const source = map && map.getSource(SAT_SELECTED_SOURCE) as GeoJSONMapSource | undefined;

    if (!source) return;

    source.setData(rec && rec.ok
        ? {
            type: "FeatureCollection",
            features: [{
                type: "Feature",
                properties: { color: SAT_KINDS[rec.kind].color },
                geometry: { type: "Point", coordinates: [rec.lon, rec.lat] }
            }]
        }
        : SAT_EMPTY);
}


// ==============================================
// S5B. SATELLITE ICONS
//
// Drawn on a 20 x 20 grid (shown 20 px) at 2x resolution, tinted with the
// kind's colour. A satellite: a body with two solar panels and a dish, tilted.
// A station: a long truss with two pairs of big panels. Made on demand, like
// the train and ship icons.
// ==============================================

const SAT_ICON_PREFIX = "sat";
const SAT_ICON_GRID = 20;
const SAT_ICON_SCALE = 2;
const satIconImages = new Map<string, ImageData>();

function satIconId(kind: SatKind): string {
    return `${SAT_ICON_PREFIX}|${kind === "station" ? "station" : "sat"}|${SAT_KINDS[kind].color.replace("#", "")}`;
}

function createSatIcon(shape: "sat" | "station", color: string): ImageData {

    const size = SAT_ICON_GRID * SAT_ICON_SCALE;

    const canvas = document.createElement("canvas");

    canvas.width = size;
    canvas.height = size;

    const ctx = canvas.getContext("2d");

    if (!ctx) throw new Error("Canvas 2D drawing is not available");

    ctx.scale(SAT_ICON_SCALE, SAT_ICON_SCALE);

    ctx.translate(SAT_ICON_GRID / 2, SAT_ICON_GRID / 2);

    ctx.lineJoin = "round";
    ctx.lineCap = "round";

    const rim = "#0b1520";

    // one rectangle with a dark rim (so it shows on light and dark maps) and
    // a lighter grid, as on a solar panel
    const panel = function(x: number, y: number, w: number, h: number, cells: number): void {

        ctx.fillStyle = color;
        ctx.strokeStyle = rim;
        ctx.lineWidth = 1.6;
        ctx.globalAlpha = 0.85;
        ctx.strokeRect(x, y, w, h);
        ctx.fillRect(x, y, w, h);
        ctx.globalAlpha = 1;

        ctx.strokeStyle = "rgba(11,21,32,0.55)";
        ctx.lineWidth = 0.6;
        ctx.beginPath();

        for (let i = 1; i < cells; i++) {
            const gx = x + (w * i) / cells;
            ctx.moveTo(gx, y);
            ctx.lineTo(gx, y + h);
        }

        ctx.stroke();
    };

    if (shape === "station") {

        // truss
        ctx.strokeStyle = rim;
        ctx.lineWidth = 3.4;
        ctx.beginPath();
        ctx.moveTo(-9, 0);
        ctx.lineTo(9, 0);
        ctx.stroke();

        ctx.strokeStyle = color;
        ctx.lineWidth = 1.4;
        ctx.stroke();

        // two pairs of panels, one each side, above and below the truss
        panel(-9.5, -8.5, 6, 6, 3);
        panel(-9.5, 2.5, 6, 6, 3);
        panel(3.5, -8.5, 6, 6, 3);
        panel(3.5, 2.5, 6, 6, 3);

        // the pressurised modules in the middle
        ctx.fillStyle = "#ffffff";
        ctx.strokeStyle = rim;
        ctx.lineWidth = 1.6;
        ctx.beginPath();
        ctx.rect(-2, -2.2, 4, 4.4);
        ctx.stroke();
        ctx.fill();

    } else {

        // the whole satellite is tilted, which reads better than a flat cross
        ctx.rotate(-Math.PI / 4);

        // arms
        ctx.strokeStyle = rim;
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.moveTo(-6, 0);
        ctx.lineTo(6, 0);
        ctx.stroke();
        ctx.strokeStyle = color;
        ctx.lineWidth = 1.1;
        ctx.stroke();

        // solar panels
        panel(-9.6, -3.2, 5.2, 6.4, 2);
        panel(4.4, -3.2, 5.2, 6.4, 2);

        // body
        ctx.fillStyle = "#ffffff";
        ctx.strokeStyle = rim;
        ctx.lineWidth = 1.6;
        ctx.beginPath();
        ctx.rect(-2.6, -2.6, 5.2, 5.2);
        ctx.stroke();
        ctx.fill();

        // dish
        ctx.strokeStyle = rim;
        ctx.lineWidth = 2.6;
        ctx.beginPath();
        ctx.moveTo(0, -2.6);
        ctx.lineTo(0, -5.2);
        ctx.stroke();
        ctx.strokeStyle = color;
        ctx.lineWidth = 1;
        ctx.stroke();

        ctx.fillStyle = color;
        ctx.strokeStyle = rim;
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.arc(0, -5.6, 1.5, 0, Math.PI * 2);
        ctx.stroke();
        ctx.fill();
    }

    return ctx.getImageData(0, 0, size, size);
}

function onSatImageMissing(e: { id: string }): void {

    const [prefix, shape, hex] = String(e.id).split("|");

    if (prefix !== SAT_ICON_PREFIX) return;

    if (shape !== "sat" && shape !== "station") return;

    if (!/^[0-9a-f]{6}$/.test(hex || "")) return;

    let image = satIconImages.get(e.id);

    if (!image) {
        image = createSatIcon(shape, "#" + hex);
        satIconImages.set(e.id, image);
    }

    if (!map.hasImage(e.id)) {
        map.addImage(e.id, image, { pixelRatio: 2 * SAT_ICON_SCALE });
    }
}


// ==============================================
// S6. MAP LAYERS
// ==============================================

function satGeoSource(): GeoJSONMapSource | undefined {
    return map.getSource(SAT_SOURCE) as GeoJSONMapSource | undefined;
}

// Hides the kinds switched off in the legend
function satKindFilter(): import("maplibre-gl").FilterSpecification | null {

    if (!satHidden.size) return null;

    return ["!", ["in", ["get", "kind"], ["literal", Array.from(satHidden)]]];
}

function applySatFilter(): void {

    if (!map) return;

    const filter = satKindFilter();

    [SAT_LAYER, SAT_LABEL_LAYER].forEach(function(id) {

        if (!map.getLayer(id)) return;

        if (id === SAT_LABEL_LAYER) {
            const stations: import("maplibre-gl").FilterSpecification = ["==", ["get", "kind"], "station"];
            map.setFilter(id, filter ? ["all", stations, filter] as import("maplibre-gl").FilterSpecification : stations);
        } else {
            map.setFilter(id, filter);
        }
    });
}

// Runs on every style load, because changing the base map wipes all layers.
function setupSatLayers(): void {

    // Satellites go under the aircraft, ships and trains
    const layers = map.getStyle().layers || [];

    const firstAbove = layers.find(layer =>
        layer.id.startsWith("flights-") ||
        layer.id.startsWith("transit-") ||
        layer.id === "rail-layer" ||
        layer.id.startsWith("ships-"));

    const before = firstAbove ? firstAbove.id : undefined;

    if (!map.getSource(SAT_SOURCE)) {
        map.addSource(SAT_SOURCE, { type: "geojson", data: lastSatGeoJSON });
    }

    if (!map.getSource(SAT_ORBIT_SOURCE)) {
        map.addSource(SAT_ORBIT_SOURCE, { type: "geojson", data: SAT_EMPTY });
    }

    if (!map.getSource(SAT_SELECTED_SOURCE)) {
        map.addSource(SAT_SELECTED_SOURCE, { type: "geojson", data: SAT_EMPTY });
    }

    if (!map.getLayer(SAT_ORBIT_PAST_LAYER)) {
        map.addLayer({
            id: SAT_ORBIT_PAST_LAYER,
            type: "line",
            source: SAT_ORBIT_SOURCE,
            filter: ["==", ["get", "part"], "past"],
            layout: { "line-join": "round", "line-cap": "butt" },
            paint: {
                "line-color": ["get", "color"],
                "line-width": 1.6,
                "line-opacity": 0.55,
                "line-dasharray": [2, 2]
            }
        }, before);
    }

    if (!map.getLayer(SAT_ORBIT_FUTURE_LAYER)) {
        map.addLayer({
            id: SAT_ORBIT_FUTURE_LAYER,
            type: "line",
            source: SAT_ORBIT_SOURCE,
            filter: ["==", ["get", "part"], "future"],
            layout: { "line-join": "round", "line-cap": "round" },
            paint: {
                "line-color": ["get", "color"],
                "line-width": 2,
                "line-opacity": 0.95
            }
        }, before);
    }

    if (!map.getLayer(SAT_LAYER)) {
        map.addLayer({
            id: SAT_LAYER,
            type: "symbol",
            source: SAT_SOURCE,
            layout: {
                "icon-image": ["get", "icon"],
                "icon-size": [
                    "interpolate", ["linear"], ["zoom"],
                    1, ["case", ["==", ["get", "kind"], "station"], 2, 0.7],
                    5, ["case", ["==", ["get", "kind"], "station"], 2.5, 1.3],
                    9, ["case", ["==", ["get", "kind"], "station"], 3, 3],
                    13, ["case", ["==", ["get", "kind"], "station"], 3.5, 5]
                ],
                "icon-allow-overlap": true,
                "icon-ignore-placement": true,
                "symbol-sort-key": ["case", ["==", ["get", "kind"], "station"], 2, 1]
            }
        }, before);
    }

    // The selected satellite: a ring round its dot
    if (!map.getLayer(SAT_SELECTED_LAYER)) {
        map.addLayer({
            id: SAT_SELECTED_LAYER,
            type: "circle",
            source: SAT_SELECTED_SOURCE,
            paint: {
                "circle-radius": 13,
                "circle-color": "rgba(0,0,0,0)",
                "circle-stroke-color": "#ffffff",
                "circle-stroke-width": 2
            }
        }, before);
    }

    // Names of the stations (needs a font the base map already uses; the
    // satellite style has none: no labels there)
    if (!map.getLayer(SAT_LABEL_LAYER) && map.getStyle().glyphs) {

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
                id: SAT_LABEL_LAYER,
                type: "symbol",
                source: SAT_SOURCE,
                filter: ["==", ["get", "kind"], "station"],
                layout: {
                    "text-field": ["get", "name"],
                    "text-font": font,
                    "text-size": 11,
                    "text-offset": [0, 1.1],
                    "text-anchor": "top",
                    "text-optional": true
                },
                paint: {
                    "text-color": "#ffd0d0",
                    "text-halo-color": "#0b1520",
                    "text-halo-width": 1.4
                }
            }, before);
        }
    }

    applySatFilter();
}

// Safety net, same as the other layers: rebuild anything a style change removed.
function ensureSatLayers(): void {

    if (!map || !map.isStyleLoaded()) return;

    if (map.getSource(SAT_SOURCE) && map.getLayer(SAT_LAYER)) return;

    try {
        setupSatLayers();
    } catch (error) {
        console.warn("Satellite layers could not be rebuilt yet:", error);
    }
}


// ==============================================
// S7. DRAWING THE SATELLITES
// ==============================================

function tickSatellites(): void {

    if (!satEnabled || !satRecords.size || !map) return;

    if (document.hidden) return;

    const now = new Date();

    const gmst = satellite.gstime(now);

    const features: GeoFeature[] = [];

    const counts: Record<SatKind, number> = {
        station: 0, starlink: 0, constellation: 0, navigation: 0, weather: 0, other: 0
    };

    satRecords.forEach(function(rec) {

        const where = satPosition(rec, now, gmst);

        if (!where) {
            rec.ok = false;
            return;
        }

        rec.ok = true;
        rec.lon = where.lon;
        rec.lat = where.lat;
        rec.altKm = where.altKm;
        rec.kmPerS = where.kmPerS;

        counts[rec.kind]++;

        features.push({
            type: "Feature",
            properties: {
                id: rec.id,
                kind: rec.kind,
                color: SAT_KINDS[rec.kind].color,
                icon: satIconId(rec.kind),
                name: rec.name
            },
            geometry: { type: "Point", coordinates: [where.lon, where.lat] }
        });
    });

    lastSatGeoJSON = { type: "FeatureCollection", features: features };

    const source = satGeoSource();

    if (source) source.setData(lastSatGeoJSON);

    setSatHud(counts, features.length);

    // The selected one: follow it, refresh its details and (now and then) its path
    const selected = satSelectedId ? satRecords.get(satSelectedId) : undefined;

    if (selected) {

        drawSatSelected(selected);

        if (selected.ok && satPopup.isOpen()) {
            satPopup.setLngLat([selected.lon, selected.lat]).setHTML(satPopupContent(selected));
        }

        if (Date.now() - satOrbitAt > SAT_ORBIT_REFRESH_MS) drawSatOrbit(selected);
    }
}

function setSatellitesEnabled(on: boolean): void {

    satEnabled = on;

    const generation = ++satGeneration;     // drop whatever is still loading

    const toggle = document.getElementById("satToggle");

    if (toggle) toggle.classList.toggle("layer-on", on);

    const hud = document.getElementById("satHud");

    if (hud) hud.classList.toggle("visible", on);

    try {
        localStorage.setItem(SAT_PREF_KEY, on ? "1" : "0");
    } catch (error) {
        // Storage unavailable: preference just won't persist
    }

    clearInterval(satTimer);
    clearTimeout(satUpgradeTimer);

    if (!on) {

        lastSatGeoJSON = SAT_EMPTY;

        const source = map && satGeoSource();

        if (source) source.setData(SAT_EMPTY);

        satSelect(null);

        satHoverPopup.remove();
        satPopup.remove();

        setSatStatus("OFF");

        return;
    }

    setSatStatus("LOADING");

    setSatText("Loading orbital data...", "");

    ensureSatLayers();

    loadSatellites()
        .then(function() {

            if (generation !== satGeneration || !satEnabled) return;

            ensureSatLayers();

            tickSatellites();

            satTimer = setInterval(tickSatellites, SAT_TICK_MS);

            scheduleSatUpgrade(generation);
        })
        .catch(function(error: Error) {

            if (generation !== satGeneration) return;

            console.warn("Satellite data failed:", error);

            setSatStatus("ERROR", String(error.message || error));

            setSatText("Could not load satellite data: " + String(error.message || error) +
                " Switch the layer off and on to try again.", "");
        });
}

// When only the small fallback feed could be had, ask again now and then:
// as soon as the full catalogue is available it replaces the small one.
function scheduleSatUpgrade(generation: number): void {

    clearTimeout(satUpgradeTimer);

    if (satFull) return;

    satUpgradeTimer = setTimeout(function() {

        if (generation !== satGeneration || !satEnabled) return;

        satFetch()
            .then(function(reply) {

                if (generation !== satGeneration || !satEnabled) return;

                if (reply.full === false) {
                    scheduleSatUpgrade(generation);
                    return;
                }

                // the full catalogue is here: start over with it
                satRecords.clear();

                satSelect(null);

                setSatellitesEnabled(true);
            })
            .catch(function() {
                scheduleSatUpgrade(generation);
            });

    }, SAT_UPGRADE_MS);
}

function satSelect(rec: SatRecord | null): void {

    satSelectedId = rec ? rec.id : 0;

    drawSatSelected(rec);

    drawSatOrbit(rec);

    if (!rec) satPopup.remove();
}


// ==============================================
// S8. LEGEND (click an entry to hide / show that kind)
// ==============================================

function setSatText(status: string, updated: string): void {

    const statusEl = document.getElementById("satHudStatus");

    if (statusEl) statusEl.textContent = status;

    const updatedEl = document.getElementById("satHudUpdated");

    if (updatedEl) updatedEl.textContent = updated;
}

function buildSatLegend(): void {

    const legend = document.getElementById("satLegend");

    if (!legend || legend.childElementCount) return;

    (Object.keys(SAT_KINDS) as SatKind[]).forEach(function(key) {

        const item = document.createElement("span");

        item.className = "sat-legend-item";
        item.dataset.kind = key;
        item.setAttribute("role", "button");
        item.tabIndex = 0;
        item.title = "Click to hide / show";

        const dot = document.createElement("i");

        dot.style.background = SAT_KINDS[key].color;

        dot.className = key === "station" ? "sat-dot-station" : "sat-dot";

        const label = document.createElement("span");

        label.textContent = SAT_KINDS[key].label;

        const count = document.createElement("b");

        count.className = "sat-legend-count";

        item.appendChild(dot);
        item.appendChild(label);
        item.appendChild(count);

        const flip = function() {

            if (satHidden.has(key)) satHidden.delete(key);
            else satHidden.add(key);

            item.classList.toggle("sat-off", satHidden.has(key));

            applySatFilter();
        };

        item.addEventListener("click", flip);

        item.addEventListener("keydown", function(e) {
            if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                flip();
            }
        });

        legend.appendChild(item);
    });

    const note = document.createElement("div");

    note.className = "ship-legend-note";
    note.textContent = "Positions are calculated live from orbital elements (SGP4). " +
        "Click a satellite to draw its ground track: solid = next orbit, dashed = last half orbit. " +
        "Data: CelesTrak.";

    legend.appendChild(note);
}

function setSatHud(counts: Record<SatKind, number>, total: number): void {

    const count = document.getElementById("satHudCount");

    if (count) count.textContent = total.toLocaleString("en-US");

    setSatStatus(total.toLocaleString("en-US"), `${total} satellites tracked`);

    let updated = "";

    if (satFetched) {
        const when = new Date(satFetched * 1000);
        updated = "Orbital data downloaded: " +
            when.toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" });
    }

    setSatText(
        satFull
            ? `${total.toLocaleString("en-US")} satellites in orbit right now`
            : `Only the "${satGroup}" set (${total.toLocaleString("en-US")} satellites): the full ` +
              "catalogue is not available yet and will appear on its own.",
        updated
    );

    document.querySelectorAll<HTMLElement>("#satLegend .sat-legend-item").forEach(function(item) {

        const counter = item.querySelector(".sat-legend-count");

        const kind = item.dataset.kind as SatKind;

        if (counter && kind) counter.textContent = counts[kind].toLocaleString("en-US");
    });
}


// ==============================================
// S9. HOVER + CLICK + DETAILS
// ==============================================

function satFeatureAt(point: MapPoint): MapFeature | null {

    if (!satEnabled || !map || !map.getLayer(SAT_LAYER)) return null;

    const features = map.queryRenderedFeatures(
        [
            [point.x - SAT_CLICK_PAD, point.y - SAT_CLICK_PAD],
            [point.x + SAT_CLICK_PAD, point.y + SAT_CLICK_PAD]
        ],
        { layers: [SAT_LAYER] }
    );

    return features.length ? features[0] : null;
}

// Used by script.js and the cables layer so a click on a satellite doesn't
// also drop a pin or open a cable.
function isSatelliteAtPoint(point: MapPoint): boolean {
    return Boolean(satFeatureAt(point));
}

// Aircraft, ships, trains and transit vehicles are drawn above the satellites
function satCoveredByOther(point: MapPoint): boolean {

    return Boolean(
        isFlightAtPoint(point) ||
        (typeof isShipAtPoint === "function" && isShipAtPoint(point)) ||
        (typeof isRailAtPoint === "function" && isRailAtPoint(point)) ||
        (typeof isTransitAtPoint === "function" && isTransitAtPoint(point))
    );
}

function satRow(label: string, value: string): string {

    if (!value) return "";

    return `<span class="sat-label">${escapeHTML(label)}</span> ${escapeHTML(value)}`;
}

function satPopupContent(rec: SatRecord): string {

    const el = rec.elements;
    const info = rec.info;
    const lines: string[] = [];

    lines.push(
        `<strong>${escapeHTML(rec.name)}</strong>` +
        ` <span class="transit-popup-mode">${escapeHTML(SAT_KINDS[rec.kind].label.toUpperCase())}</span>`
    );

    const status = info.os ? (SAT_OPS[info.os] || info.os) : "";

    const type = info.ty ? (SAT_TYPES[info.ty] || info.ty) : "";

    lines.push([type, status].filter(Boolean).map(escapeHTML).join(" · "));

    lines.push(satRow("NORAD ID", `${el.NORAD_CAT_ID} · intl. designator ${el.OBJECT_ID}`));

    lines.push(satRow("Owner / country", satOwner(info.ow)));

    if (info.ld) {
        lines.push(satRow("Launched", `${info.ld} (${satYearsSince(info.ld)})`));
    }

    lines.push(satRow("Launch site", satSite(info.ls)));

    lines.push(`<span class="sat-heading">RIGHT NOW</span>`);

    if (rec.ok) {
        lines.push(satRow("Altitude", `${satFmt(rec.altKm)} km`));
        lines.push(satRow("Speed", `${satFmt(rec.kmPerS, 2)} km/s (${satFmt(rec.kmPerS * 3600)} km/h)`));
        lines.push(satRow("Over", `${rec.lat.toFixed(2)}°, ${rec.lon.toFixed(2)}°`));
    }

    lines.push(`<span class="sat-heading">ORBIT</span>`);

    lines.push(satRow("Type", satOrbitClass(rec)));

    lines.push(satRow("Period", rec.periodMin
        ? `${satFmt(rec.periodMin, 1)} min (${satFmt(el.MEAN_MOTION, 2)} orbits/day)`
        : ""));

    lines.push(satRow("Inclination", `${satFmt(el.INCLINATION, 2)}°`));

    if (info.apo !== undefined && info.per !== undefined) {
        lines.push(satRow("Apogee × perigee", `${satFmt(info.apo)} × ${satFmt(info.per)} km`));
    }

    lines.push(satRow("Eccentricity", el.ECCENTRICITY.toFixed(4)));

    lines.push(satRow("Size (radar)", satRcsText(info.rcs)));

    const age = Date.now() - rec.epochMs;

    lines.push(
        `<small>Orbital elements from ${escapeHTML(satAgeText(age))}` +
        (age > SAT_STALE_DAYS * 86400000 ? " (old: position may be off)" : "") +
        "</small>"
    );

    lines.push(
        `<a href="https://www.n2yo.com/satellite/?s=${el.NORAD_CAT_ID}" target="_blank" rel="noopener noreferrer">N2YO page ↗</a>` +
        ` · <a href="https://celestrak.org/satcat/records.php?CATNR=${el.NORAD_CAT_ID}" target="_blank" rel="noopener noreferrer">CelesTrak record ↗</a>`
    );

    lines.push(
        "<small>Dashed line: last half orbit · solid line: next orbit (ground track)</small>"
    );

    return lines.filter(Boolean).join("<br>");
}

function onSatHover(e: MapMouseEvent): void {

    if (!satEnabled) return;

    const feature = satCoveredByOther(e.point) ? null : satFeatureAt(e.point);

    const rec = feature ? satRecords.get(Number(feature.properties.id)) : undefined;

    if (!rec || rec.id === satSelectedId) {
        satHoverPopup.remove();
        return;
    }

    map.getCanvas().style.cursor = "pointer";

    satHoverPopup
        .setLngLat([rec.lon, rec.lat])
        .setText(`${rec.name}  |  ${SAT_KINDS[rec.kind].label}  |  ${satFmt(rec.altKm)} km`)
        .addTo(map);
}

function onSatClick(e: MapMouseEvent): void {

    if (!satEnabled || satCoveredByOther(e.point)) return;

    const feature = satFeatureAt(e.point);

    const rec = feature ? satRecords.get(Number(feature.properties.id)) : undefined;

    if (!rec) return;

    satHoverPopup.remove();

    satSelectedId = rec.id;

    drawSatSelected(rec);

    drawSatOrbit(rec);

    satPopup.setLngLat([rec.lon, rec.lat]).setHTML(satPopupContent(rec));

    // (adding an open popup again would close it first, and closing clears the selection)
    if (!satPopup.isOpen()) satPopup.addTo(map);
}


// ==============================================
// S10. START
// ==============================================

function initializeSatellites(): void {

    satHoverPopup = new maplibregl.Popup({
        closeButton: false,
        closeOnClick: false,
        offset: 10,
        className: "flight-popup"
    });

    satPopup = new maplibregl.Popup({
        closeButton: true,
        closeOnClick: false,
        offset: 10,
        maxWidth: "340px",
        className: "transit-popup"
    });

    satPopup.on("close", function() {

        if (!satSelectedId) return;

        satSelectedId = 0;

        drawSatSelected(null);

        drawSatOrbit(null);
    });

    // Changing the base map removes all layers, so rebuild them each time.
    map.on("styleimagemissing", onSatImageMissing);

    map.on("style.load", setupSatLayers);
    map.on("styledata", ensureSatLayers);
    map.on("idle", ensureSatLayers);

    map.on("mousemove", onSatHover);
    map.on("click", onSatClick);

    const toggle = document.getElementById("satToggle");

    if (toggle) {
        toggle.addEventListener("click", () => setSatellitesEnabled(!satEnabled));
    }

    buildSatLegend();

    // Restore last session's choice once the map is ready
    map.once("load", function() {

        let enabled = false;

        try {
            enabled = localStorage.getItem(SAT_PREF_KEY) === "1";
        } catch (error) {
            // Storage unavailable: stays off
        }

        if (enabled) setSatellitesEnabled(true);
    });
}
