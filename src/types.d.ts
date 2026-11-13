// Shared types for flights.ts and script.ts.
// (No imports/exports here, so everything is visible in both files.)

// ---------- map / GeoJSON shorthands ----------

type MapInstance = import("maplibre-gl").Map;
type MapMarker = import("maplibre-gl").Marker;
type MapPopup = import("maplibre-gl").Popup;
type MapMouseEvent = import("maplibre-gl").MapMouseEvent;
type MapFeature = import("maplibre-gl").MapGeoJSONFeature;
type GeoJSONMapSource = import("maplibre-gl").GeoJSONSource;
type MapStyle = import("maplibre-gl").StyleSpecification;

type GeoFeature = import("geojson").Feature;
type GeoFeatureCollection = import("geojson").FeatureCollection;

/** A pixel position on the map canvas */
interface MapPoint {
    x: number;
    y: number;
}

interface LatLon {
    lat: number;
    lon: number;
}

// ---------- aircraft ----------

type FlightShape =
    | "narrow" | "wide" | "jumbo" | "regional" | "bizjet"
    | "turboprop" | "light" | "glider" | "fighter" | "heli";

type FlightColorKey = "normal" | "ground" | "military" | "emergency";

/** One aircraft as the map uses it, whichever feed it came from */
interface FlightRecord {
    hex: string;            // ICAO 24-bit address, lowercase
    callsign: string;
    reg: string;            // registration ("" when the feed doesn't know)
    type: string;           // ICAO type code, e.g. B738
    typeDesc: string;
    operator: string;
    country: string;
    shapeHint: FlightShape | "";

    lat: number;
    lon: number;
    t0: number;             // when this position was true (ms)
    predictCap?: number;    // max seconds to glide along the heading

    alt: number | null;     // feet
    onGround: boolean;
    gs: number | null;      // knots
    track: number | null;   // degrees
    vrate: number | null;   // ft/min

    squawk: string;
    military: boolean;
    emergency: boolean;
}

/** An aircraft as the regional ADS-B feeds send it (ADS-B Exchange v2 JSON) */
interface AdsbAircraft {
    hex?: string;
    flight?: string;
    r?: string;
    t?: string;
    desc?: string;
    ownOp?: string;
    category?: string;
    lat?: number;
    lon?: number;
    seen_pos?: number;
    alt_baro?: number | "ground";
    alt_geom?: number;
    gs?: number;
    track?: number;
    true_heading?: number;
    mag_heading?: number;
    baro_rate?: number;
    geom_rate?: number;
    squawk?: string;
    emergency?: string;
    dbFlags?: number;
}

/** One OpenSky "state vector": a positional array, see parseOpenSkyState */
type OpenSkyState = unknown[];

/** The relay's reply for the world view: OpenSky's answer plus some metadata */
interface WorldPayload {
    fetchedAt?: number;         // ms
    mode?: string;              // "authenticated" | "anonymous"
    minInterval?: number;       // seconds between snapshots
    data?: {
        time?: number;          // unix seconds
        states?: OpenSkyState[] | null;
    };
}

/** Details remembered per aircraft so they survive the switch to OpenSky */
interface FlightKnownDetails {
    reg: string;
    type: string;
    typeDesc: string;
    operator: string;
    military: boolean;
}

/** What adsbdb knows about one airframe */
interface AircraftInfo {
    hex: string;
    registration: string;
    icaoType: string;
    type: string;
    manufacturer: string;
    owner: string;
    country: string;
}

interface FlightPhoto {
    thumbnail?: { src: string };
    thumbnail_large?: { src: string };
    link: string;
    photographer?: string;
}

/** One request in the grid that covers the current view */
interface FlightPlanTile {
    lat: number;
    lon: number;
    radius: number;
}

interface FlightFeed {
    name: string;
    url: (p: { lat: string; lon: string; radius: number }) => string;
}

/** An Error carrying extra details from a failed feed / relay request */
interface FlightFetchError extends Error {
    status?: number;
    rateLimited?: boolean;
    retryAfter?: number;
}

// ---------- flight path ----------

/** [longitude, latitude, altitude in feet (null = unknown), time in ms] */
type TrailPoint = [lon: number, lat: number, feet: number | null, time: number];

interface FlightHistoryEntry {
    points: TrailPoint[];
    lastT0: number;
    seen: number;
}

type FlightTrackState = "ok" | "none" | "error" | "unavailable" | "limit";

interface FlightTrackResult {
    state: FlightTrackState;
    points?: TrailPoint[];
    retryMs?: number;
}

interface FlightTrackEntry {
    state: FlightTrackState;
    points: TrailPoint[];
    lastT: number;
    fetchedAt: number;
    ttl: number;
}

interface FlightTrailCache {
    key: string;
    features: GeoFeature[];
    last: [lon: number, lat: number, feet: number | null] | null;
}

// ---------- airports and routes ----------

/** An airport pin (from the relay's airport list) */
interface Airport {
    icao: string;
    iata: string;
    name: string;
    lat: number;
    lon: number;
    kind: "L" | "M";        // large / medium
    country: string;
    city: string;
    searchText?: string;    // lowercase "iata icao name city", built on first search
}

/** An airport as a route lookup describes it */
interface RouteAirport {
    iata: string;
    icao: string;
    name: string;
    city: string;
    country: string;
    lat: number;
    lon: number;
}

/** Anything with airport codes and a name: a pin or a route end */
type AnyAirport = Airport | RouteAirport;

interface FlightRoute {
    callsign: string;
    airline: { name: string; icao: string; iata: string } | null;
    origin: RouteAirport;
    destination: RouteAirport;
    midpoint: RouteAirport | null;
    source?: "airlabs" | "adsbdb";   // added by the browser when cached
}

/** A live aircraft listed in the airport panel */
interface AirportTrafficRow {
    hex: string;
    callsign: string;
    type: string;
    other: string;          // code of the airport at the other end
    alt: number | null;
    gs: number | null;
    dist: number;           // km from the airport
    ground: boolean;
    status: string;
    estimated: boolean;
}

// ---------- airport timetable (AirLabs) ----------

type ScheduleKind = "arrivals" | "departures";

type ScheduleState = "loading" | "ok" | "nokey" | "limit" | "unavailable" | "error";

interface ScheduleRow {
    flight: string;
    callsign: string;
    other: string;
    otherCity: string;
    time: string;           // scheduled, airport local "HH:MM"
    estTime: string;        // estimated or actual, "" when unknown
    ts: number | null;      // scheduled, unix seconds
    bestTs: number | null;  // actual / estimated / scheduled, unix seconds
    status: string;
    terminal: string;
    gate: string;
    delay: number | null;   // minutes
    aircraft: string;
}

interface ScheduleEntry {
    state: ScheduleState;
    rows: ScheduleRow[];
    partial: boolean;
    at: number;
}

interface ScheduleRowBit {
    text: string;
    cls?: string;
}

// ---------- saved locations (script.ts) ----------

interface SavedMarker {
    id: string;
    name: string;
    description: string;
    address?: string;
    lat: number;
    lon: number;
    created: string;
}

/** One result from OpenStreetMap's Nominatim search */
interface NominatimPlace {
    lat: string;
    lon: string;
    display_name: string;
    category?: string;
    class?: string;
    type?: string;
}
