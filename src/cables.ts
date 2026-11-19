/* ==============================================
   OSINT MAP - SUBMARINE CABLES (undersea internet cables of the world)
   SOURCE: src/cables.ts  ->  compiled to cables.js by "npm run build"
           (edit the .ts file, never the .js; cables.js must load
           AFTER rail.js and BEFORE script.js)
   DATA: TeleGeography's Submarine Cable Map (submarinecablemap.com),
   licence CC BY-SA 4.0. Asked through server.py ("/api/cables"), because
   their API does not allow the browser to ask directly.

   One sidebar switch ("Subsea Cables") draws every cable route and every
   landing station. Click a cable for its length, owners, builder and ready-
   for-service year (it is also highlighted); click a landing station to see
   which cables come ashore there.
   ============================================== */


// ==============================================
// S1. CONFIGURATION
// ==============================================

const CABLE_API = "/api/cables";
const CABLE_PREF_KEY = "osint_map_cables_enabled";
const CABLE_SOURCE = "cable-source";
const CABLE_LANDING_SOURCE = "cable-landing-source";
const CABLE_LAYER = "cable-layer";
const CABLE_SELECTED_LAYER = "cable-selected-layer";
const CABLE_LANDING_LAYER = "cable-landing-layer";
const CABLE_LABEL_LAYER = "cable-label-layer";
const CABLE_LABEL_MIN_ZOOM = 4;
const CABLE_CLICK_PAD = 5;
const CABLE_LIST_MAX = 12;      // landing points / cables listed in a popup


// ==============================================
// S2. TYPES
// ==============================================

interface CableDetail {
    id: string;
    name: string;
    length?: string | null;
    owners?: string | null;
    suppliers?: string | null;
    rfs?: string | null;
    rfs_year?: number | null;
    is_planned?: boolean;
    url?: string | null;
    notes?: string | null;
    fetched?: number;           // when server.py last got this from TeleGeography (unix seconds)
    landing_points?: { id: string; name: string; country?: string; is_tbd?: boolean | null }[];
}

interface CableLandingDetail {
    id: string;
    name: string;
    country?: string;
    fetched?: number;
    cables?: { id: string; name: string; rfs_year?: number | null; is_planned?: boolean }[];
}


// ==============================================
// S3. STATE
// ==============================================

let cablesEnabled = false;
let cableGeneration = 0;                // bumps to drop answers that arrive too late
let cableData: { fetched?: number; cables: GeoFeatureCollection; landings: GeoFeatureCollection } | null = null;
let cableLoading: Promise<void> | null = null;
let cableSelectedId = "";
let cableHoverPopup: import("maplibre-gl").Popup;
let cablePopup: import("maplibre-gl").Popup;
const cableDetailCache = new Map<string, CableDetail>();
const cableLandingCache = new Map<string, CableLandingDetail>();
const EMPTY_CABLE_COLLECTION: GeoFeatureCollection = { type: "FeatureCollection", features: [] };


// ==============================================
// S4. SMALL HELPERS
// ==============================================

function setCableStatus(text: string, detail = ""): void {

    const count = document.getElementById("cableCount");

    if (count) count.textContent = text;

    const toggle = document.getElementById("cableToggle");

    if (toggle) toggle.title = detail;
}

async function cableFetch<T>(path: string): Promise<T> {

    const response = await fetch(`${CABLE_API}${path}`);

    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    return response.json();
}

// Only ever link to a real web address, never "javascript:" and the like
function cableSafeUrl(url: string | null | undefined): string {

    if (!url) return "";

    try {
        const parsed = new URL(url);
        return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed.href : "";
    } catch (error) {
        return "";
    }
}

// "Cable data last fetched: 18 Nov 2026, 10:30 PM (2 days ago)"
function cableFetchedText(fetched: number | undefined): string {

    if (!fetched) return "";

    const when = new Date(fetched * 1000);

    const days = Math.floor((Date.now() - when.getTime()) / 86400000);

    const ago = days < 1 ? "today" : days === 1 ? "yesterday" : `${days} days ago`;

    return `${when.toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" })} (${ago})`;
}

function cableStatusText(cable: CableDetail): string {

    if (cable.is_planned) {
        return cable.rfs_year ? `PLANNED (RFS ${cable.rfs_year})` : "PLANNED";
    }

    return cable.rfs_year ? `IN SERVICE SINCE ${cable.rfs_year}` : "IN SERVICE";
}

function cableCountrySummary(cable: CableDetail): string {

    const countries = new Set<string>();

    (cable.landing_points || []).forEach(function(point) {
        if (point.country) countries.add(point.country);
    });

    return countries.size ? `${countries.size} countries` : "";
}


// ==============================================
// S5. LOADING THE DATA
// ==============================================

function cableSources(): { cables?: GeoJSONMapSource; landings?: GeoJSONMapSource } {

    if (!map) return {};

    return {
        cables: map.getSource(CABLE_SOURCE) as GeoJSONMapSource | undefined,
        landings: map.getSource(CABLE_LANDING_SOURCE) as GeoJSONMapSource | undefined
    };
}

function drawCables(): void {

    const sources = cableSources();

    const data = cablesEnabled ? cableData : null;

    if (sources.cables) sources.cables.setData(data ? data.cables : EMPTY_CABLE_COLLECTION);

    if (sources.landings) sources.landings.setData(data ? data.landings : EMPTY_CABLE_COLLECTION);
}

function loadCables(): Promise<void> {

    if (cableData) return Promise.resolve();

    if (cableLoading) return cableLoading;

    cableLoading = cableFetch<{ fetched?: number; cables: GeoFeatureCollection; landings: GeoFeatureCollection }>("")
        .then(function(data) {
            cableData = data;
        })
        .finally(function() {
            cableLoading = null;
        });

    return cableLoading;
}


// ==============================================
// S6. MAP LAYERS
// ==============================================

// Runs on every style load, because changing the base map wipes all layers.
function setupCableLayers(): void {

    // Cables go underneath the vehicles, ships and aircraft
    const layers = map.getStyle().layers || [];

    const firstAbove = layers.find(layer =>
        layer.id.startsWith("flights-") ||
        layer.id.startsWith("transit-") ||
        layer.id === "rail-layer" ||
        layer.id.startsWith("ship"));

    const before = firstAbove ? firstAbove.id : undefined;

    if (!map.getSource(CABLE_SOURCE)) {
        map.addSource(CABLE_SOURCE, {
            type: "geojson",
            data: cablesEnabled && cableData ? cableData.cables : EMPTY_CABLE_COLLECTION
        });
    }

    if (!map.getSource(CABLE_LANDING_SOURCE)) {
        map.addSource(CABLE_LANDING_SOURCE, {
            type: "geojson",
            data: cablesEnabled && cableData ? cableData.landings : EMPTY_CABLE_COLLECTION
        });
    }

    if (!map.getLayer(CABLE_LAYER)) {
        map.addLayer({
            id: CABLE_LAYER,
            type: "line",
            source: CABLE_SOURCE,
            layout: { "line-join": "round", "line-cap": "round" },
            paint: {
                "line-color": ["coalesce", ["get", "color"], "#35c9e8"],
                "line-width": ["interpolate", ["linear"], ["zoom"], 1, 0.7, 5, 1.5, 9, 2.6],
                "line-opacity": 0.8
            }
        }, before);
    }

    // The clicked cable, drawn again thicker with a bright halo
    if (!map.getLayer(CABLE_SELECTED_LAYER)) {
        map.addLayer({
            id: CABLE_SELECTED_LAYER,
            type: "line",
            source: CABLE_SOURCE,
            filter: ["==", ["get", "id"], cableSelectedId],
            layout: { "line-join": "round", "line-cap": "round" },
            paint: {
                "line-color": "#ffffff",
                "line-width": ["interpolate", ["linear"], ["zoom"], 1, 2.5, 5, 4, 9, 6],
                "line-opacity": 0.95
            }
        }, before);
    }

    if (!map.getLayer(CABLE_LANDING_LAYER)) {
        map.addLayer({
            id: CABLE_LANDING_LAYER,
            type: "circle",
            source: CABLE_LANDING_SOURCE,
            paint: {
                "circle-radius": ["interpolate", ["linear"], ["zoom"], 1, 1.8, 5, 3.2, 9, 5],
                "circle-color": ["case", ["==", ["get", "is_tbd"], true], "#8a99a8", "#ffd166"],
                "circle-stroke-color": "#0b1520",
                "circle-stroke-width": 1,
                "circle-opacity": 0.95
            }
        }, before);
    }

    // Landing station names when zoomed in (needs a font the base map already
    // uses; the satellite style has none: no labels there)
    if (!map.getLayer(CABLE_LABEL_LAYER) && map.getStyle().glyphs) {

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
                id: CABLE_LABEL_LAYER,
                type: "symbol",
                source: CABLE_LANDING_SOURCE,
                minzoom: CABLE_LABEL_MIN_ZOOM,
                layout: {
                    "text-field": ["get", "name"],
                    "text-font": font,
                    "text-size": 10,
                    "text-offset": [0, 0.9],
                    "text-anchor": "top",
                    "text-optional": true
                },
                paint: {
                    "text-color": "#ffe9b0",
                    "text-halo-color": "#0b1520",
                    "text-halo-width": 1.4
                }
            }, before);
        }
    }
}

// Safety net, same as the other layers: rebuild anything a style change removed.
function ensureCableLayers(): void {

    if (!map || !map.isStyleLoaded()) return;

    if (map.getSource(CABLE_SOURCE) && map.getLayer(CABLE_LAYER)) return;

    try {
        setupCableLayers();
    } catch (error) {
        console.warn("Cable layers could not be rebuilt yet:", error);
    }
}

function selectCable(id: string): void {

    cableSelectedId = id;

    if (map && map.getLayer(CABLE_SELECTED_LAYER)) {
        map.setFilter(CABLE_SELECTED_LAYER, ["==", ["get", "id"], id]);
    }
}


// ==============================================
// S7. ON / OFF
// ==============================================

function setCablesEnabled(on: boolean): void {

    cablesEnabled = on;

    const generation = ++cableGeneration;   // drop whatever is still loading

    const toggle = document.getElementById("cableToggle");

    if (toggle) toggle.classList.toggle("layer-on", on);

    const hud = document.getElementById("cableHud");

    if (hud) hud.classList.toggle("visible", on);

    try {
        localStorage.setItem(CABLE_PREF_KEY, on ? "1" : "0");
    } catch (error) {
        // Storage unavailable: preference just won't persist
    }

    if (!on) {

        drawCables();

        selectCable("");

        cableHoverPopup.remove();
        cablePopup.remove();

        setCableStatus("OFF");

        return;
    }

    setCableStatus("LOADING");

    ensureCableLayers();

    loadCables()
        .then(function() {

            if (generation !== cableGeneration || !cablesEnabled || !cableData) return;

            ensureCableLayers();

            drawCables();

            const cables = cableData.cables.features.length;
            const landings = cableData.landings.features.length;

            setCableStatus(cables.toLocaleString("en-US"), `${cables} cables, ${landings} landing stations`);

            const count = document.getElementById("cableHudCount");

            if (count) count.textContent = cables.toLocaleString("en-US");

            const status = document.getElementById("cableHudStatus");

            if (status) {
                status.textContent = `${cables} cable systems · ${landings} landing stations`;
            }

            const updated = document.getElementById("cableHudUpdated");

            if (updated) {
                const text = cableFetchedText(cableData.fetched);
                updated.textContent = text ? `Data last updated: ${text}` : "";
            }
        })
        .catch(function(error: Error) {

            if (generation !== cableGeneration) return;

            console.warn("Cable data failed:", error);

            setCableStatus("ERROR", String(error.message || error));

            const status = document.getElementById("cableHudStatus");

            if (status) status.textContent = "Could not load cable data (is server.py running?)";
        });
}


// ==============================================
// S8. LEGEND
// ==============================================

function buildCableLegend(): void {

    const legend = document.getElementById("cableLegend");

    if (!legend || legend.childElementCount) return;

    const items: [string, string][] = [
        ["#ffd166", "Landing station (cable comes ashore)"],
        ["#8a99a8", "Landing station, location not final"]
    ];

    items.forEach(function(entry) {

        const item = document.createElement("span");

        const dot = document.createElement("i");

        dot.style.background = entry[0];

        item.appendChild(dot);
        item.appendChild(document.createTextNode(entry[1]));

        legend.appendChild(item);
    });

    const note = document.createElement("div");

    note.className = "ship-legend-note";
    note.textContent = "Each cable system has its own colour. Click a cable for its owners, " +
        "length and builder, or a landing station to see which cables arrive there. " +
        "Routes are approximate. Data: TeleGeography (CC BY-SA 4.0).";

    legend.appendChild(note);
}


// ==============================================
// S9. HOVER + CLICK
// ==============================================

function cableFeatureAt(point: MapPoint, layer: string): MapFeature | null {

    if (!cablesEnabled || !map || !map.getLayer(layer)) return null;

    const features = map.queryRenderedFeatures(
        [
            [point.x - CABLE_CLICK_PAD, point.y - CABLE_CLICK_PAD],
            [point.x + CABLE_CLICK_PAD, point.y + CABLE_CLICK_PAD]
        ],
        { layers: [layer] }
    );

    return features.length ? features[0] : null;
}

// Used by script.js so a click on a cable doesn't also drop a pin.
function isCableAtPoint(point: MapPoint): boolean {
    return Boolean(
        cableFeatureAt(point, CABLE_LANDING_LAYER) ||
        cableFeatureAt(point, CABLE_LAYER)
    );
}

// Vehicles, ships and aircraft are drawn above the cables, so they win
function cableCoveredByOther(point: MapPoint): boolean {

    return Boolean(
        isFlightAtPoint(point) ||
        (typeof isShipAtPoint === "function" && isShipAtPoint(point)) ||
        (typeof isRailAtPoint === "function" && isRailAtPoint(point)) ||
        (typeof isTransitAtPoint === "function" && isTransitAtPoint(point))
    );
}

function cableLink(label: string, url: string): string {
    return `<a href="${escapeHTML(url)}" target="_blank" rel="noopener noreferrer">${escapeHTML(label)}</a>`;
}

function cableCredit(fetched: number | undefined): string {

    const updated = cableFetchedText(fetched);

    return `<small>Data: ${cableLink("TeleGeography", "https://www.submarinecablemap.com/")}, CC BY-SA 4.0` +
        (updated ? `<br>Last updated: ${escapeHTML(updated)}` : "") + "</small>";
}

function cablePopupContent(cable: CableDetail): string {

    const lines: string[] = [];

    lines.push(
        `<strong>${escapeHTML(cable.name)}</strong>` +
        ` <span class="transit-popup-mode">${escapeHTML(cableStatusText(cable))}</span>`
    );

    const facts = [
        cable.length ? `Length: ${escapeHTML(cable.length)}` : "",
        cableCountrySummary(cable)
    ].filter(Boolean);

    if (facts.length) lines.push(facts.join(" · "));

    if (cable.owners) lines.push(`Owners: ${escapeHTML(cable.owners)}`);

    if (cable.suppliers) lines.push(`Built by: ${escapeHTML(cable.suppliers)}`);

    const points = cable.landing_points || [];

    if (points.length) {

        const shown = points.slice(0, CABLE_LIST_MAX).map(point => escapeHTML(point.name));

        const more = points.length - shown.length;

        lines.push(
            `Lands at (${points.length}): ${shown.join("; ")}` +
            (more > 0 ? `; +${more} more` : "")
        );
    }

    if (cable.notes) lines.push(`<small>${escapeHTML(cable.notes)}</small>`);

    const url = cableSafeUrl(cable.url);

    if (url) lines.push(cableLink("Cable website ↗", url));

    lines.push(cableCredit(cable.fetched));

    return lines.join("<br>");
}

function cableLandingContent(landing: CableLandingDetail): string {

    const lines: string[] = [];

    lines.push(
        `<strong>${escapeHTML(landing.name)}</strong>` +
        ` <span class="transit-popup-mode">LANDING STATION</span>`
    );

    const cables = landing.cables || [];

    if (!cables.length) {
        lines.push("No cables listed.");
    } else {

        lines.push(`${cables.length} cable${cables.length === 1 ? "" : "s"} land here:`);

        cables.slice(0, CABLE_LIST_MAX).forEach(function(cable) {

            const year = cable.is_planned ? "planned" : (cable.rfs_year ? String(cable.rfs_year) : "");

            lines.push(`&bull; ${escapeHTML(cable.name)}${year ? ` (${year})` : ""}`);
        });

        if (cables.length > CABLE_LIST_MAX) lines.push(`&bull; +${cables.length - CABLE_LIST_MAX} more`);
    }

    lines.push(cableCredit(landing.fetched));

    return lines.join("<br>");
}

function onCableHover(e: MapMouseEvent): void {

    if (!cablesEnabled) return;

    const landing = cableCoveredByOther(e.point) ? null : cableFeatureAt(e.point, CABLE_LANDING_LAYER);

    const cable = landing || cableCoveredByOther(e.point) ? null : cableFeatureAt(e.point, CABLE_LAYER);

    const feature = landing || cable;

    if (!feature) {
        cableHoverPopup.remove();
        return;
    }

    map.getCanvas().style.cursor = "pointer";

    cableHoverPopup
        .setLngLat(e.lngLat)
        .setText(String(feature.properties.name || "Submarine cable"))
        .addTo(map);
}

async function onCableClick(e: MapMouseEvent): Promise<void> {

    if (!cablesEnabled || cableCoveredByOther(e.point)) return;

    const landing = cableFeatureAt(e.point, CABLE_LANDING_LAYER);

    const cable = landing ? null : cableFeatureAt(e.point, CABLE_LAYER);

    if (!landing && !cable) return;

    cableHoverPopup.remove();

    const generation = cableGeneration;

    const lngLat = e.lngLat;

    if (landing) {

        const id = String(landing.properties.id);

        const name = String(landing.properties.name || "Landing station");

        selectCable("");

        cablePopup.setLngLat(lngLat).setHTML(`<strong>${escapeHTML(name)}</strong><br>Loading...`);

        if (!cablePopup.isOpen()) cablePopup.addTo(map);

        try {

            let detail = cableLandingCache.get(id);

            if (!detail) {
                detail = await cableFetch<CableLandingDetail>(`/landing/${encodeURIComponent(id)}`);
                cableLandingCache.set(id, detail);
            }

            if (generation === cableGeneration && cablePopup.isOpen()) {
                cablePopup.setHTML(cableLandingContent(detail));
            }

        } catch (error) {
            cablePopup.setHTML(`<strong>${escapeHTML(name)}</strong><br>Could not load details.`);
        }

        return;
    }

    const id = String(cable!.properties.id);

    const name = String(cable!.properties.name || "Submarine cable");

    selectCable(id);

    cablePopup.setLngLat(lngLat).setHTML(`<strong>${escapeHTML(name)}</strong><br>Loading...`);

    if (!cablePopup.isOpen()) cablePopup.addTo(map);

    try {

        let detail = cableDetailCache.get(id);

        if (!detail) {
            detail = await cableFetch<CableDetail>(`/${encodeURIComponent(id)}`);
            cableDetailCache.set(id, detail);
        }

        if (generation === cableGeneration && cableSelectedId === id && cablePopup.isOpen()) {
            cablePopup.setHTML(cablePopupContent(detail));
        }

    } catch (error) {
        cablePopup.setHTML(`<strong>${escapeHTML(name)}</strong><br>Could not load details.`);
    }
}


// ==============================================
// S10. START
// ==============================================

function initializeCables(): void {

    cableHoverPopup = new maplibregl.Popup({
        closeButton: false,
        closeOnClick: false,
        offset: 10,
        className: "flight-popup"
    });

    cablePopup = new maplibregl.Popup({
        closeButton: true,
        closeOnClick: false,
        offset: 10,
        maxWidth: "320px",
        className: "transit-popup"
    });

    cablePopup.on("close", function() {
        selectCable("");
    });

    // Changing the base map removes all layers, so rebuild them each time.
    map.on("style.load", setupCableLayers);
    map.on("styledata", ensureCableLayers);
    map.on("idle", ensureCableLayers);

    map.on("mousemove", onCableHover);
    map.on("click", onCableClick);

    const toggle = document.getElementById("cableToggle");

    if (toggle) {
        toggle.addEventListener("click", () => setCablesEnabled(!cablesEnabled));
    }

    buildCableLegend();

    // Restore last session's choice once the map is ready
    map.once("load", function() {

        let enabled = false;

        try {
            enabled = localStorage.getItem(CABLE_PREF_KEY) === "1";
        } catch (error) {
            // Storage unavailable: stays off
        }

        if (enabled) setCablesEnabled(true);
    });
}
