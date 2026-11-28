// ==============================================
// 3D BUILDINGS
// ==============================================
//
// Extruded building footprints, so tilting the map (shift + drag, or the
// compass) shows a city in 3D. Footprints and heights come from
// OpenFreeMap (free OpenStreetMap vector tiles, no key needed), so they
// work on every base map, including satellite.
//
// Loads after the other layer modules, before script.js.


// ==============================================
// B1. CONFIG
// ==============================================

const BUILDING_SOURCE = "osint-buildings";
const BUILDING_LAYER = "osint-buildings-3d";
const BUILDING_TILES = "https://tiles.openfreemap.org/planet";
const BUILDING_KEY = "osint_map_buildings";

// The tiles only carry buildings from zoom 13; they get readable around 15
const BUILDING_MIN_ZOOM = 14;

// Tilt applied when the layer is switched on and the map is still flat
const BUILDING_AUTO_PITCH = 55;

let buildingsEnabled = false;


// ==============================================
// B2. LAYER
// ==============================================

// Low buildings dark, towers lighter, tuned so they read on each base map
function buildingColours(): [string, string, string] {

    if (currentMapStyle === "voyager") return ["#d6d0c4", "#c4bcae", "#a99f8f"];

    if (currentMapStyle === "satellite") return ["#9aa3ad", "#b6bec7", "#d5dbe1"];

    return ["#1f2833", "#2c3a49", "#3f5266"];
}

// Buildings must draw after every base-map shape (land, water, roads, rail,
// flat building outlines), or those get painted over the 3D blocks. So this
// returns the layer just after the LAST base-map shape layer: normally the
// first label, or our first live layer. Undefined means "on top".
//
// Base maps can slip a label in early (Voyager puts water labels under its
// roads), which is why this doesn't simply stop at the first label.
function buildingBeforeId(): string | undefined {

    const layers = (map.getStyle().layers || []).filter(l => l.id !== BUILDING_LAYER);

    let lastShape = -1;

    layers.forEach((layer, index) => {

        if (layer.type === "symbol") return;

        // Every live layer on this site draws from a GeoJSON source, while
        // base maps use vector/raster tiles (named differently per provider:
        // CARTO's is "protomaps"), so the source type tells them apart
        const source = (layer as { source?: unknown }).source;

        if (typeof source === "string" && map.getSource(source)?.type === "geojson") return;

        lastShape = index;
    });

    return layers[lastShape + 1]?.id;
}

// Changing the base map wipes every layer, so this re-adds it when needed
function ensureBuildingLayer(): void {

    if (!map || !buildingsEnabled || !map.isStyleLoaded()) return;

    if (map.getLayer(BUILDING_LAYER)) return;

    try {

        if (!map.getSource(BUILDING_SOURCE)) {
            map.addSource(BUILDING_SOURCE, {
                type: "vector",
                url: BUILDING_TILES,
                attribution: "Buildings © OpenFreeMap, © OpenStreetMap contributors"
            });
        }

        const [low, mid, high] = buildingColours();

        map.addLayer({
            id: BUILDING_LAYER,
            type: "fill-extrusion",
            source: BUILDING_SOURCE,
            "source-layer": "building",
            minzoom: BUILDING_MIN_ZOOM,
            filter: ["!=", ["get", "hide_3d"], true],
            paint: {
                "fill-extrusion-color": [
                    "interpolate", ["linear"],
                    ["coalesce", ["get", "render_height"], 0],
                    0, low,
                    40, mid,
                    150, high
                ],
                "fill-extrusion-height": ["coalesce", ["get", "render_height"], 6],
                "fill-extrusion-base": ["coalesce", ["get", "render_min_height"], 0],
                // Fade in over one zoom level instead of popping
                "fill-extrusion-opacity": [
                    "interpolate", ["linear"], ["zoom"],
                    BUILDING_MIN_ZOOM, 0,
                    BUILDING_MIN_ZOOM + 1, 1
                ],
                "fill-extrusion-vertical-gradient": true
            }
        }, buildingBeforeId());

    } catch (error) {
        console.error("3D buildings:", error);
        setBuildingStatus("ERROR", "Could not load building data");
    }
}

function removeBuildingLayer(): void {

    if (!map) return;

    if (map.getLayer(BUILDING_LAYER)) map.removeLayer(BUILDING_LAYER);

    if (map.getSource(BUILDING_SOURCE)) map.removeSource(BUILDING_SOURCE);
}


// ==============================================
// B3. TOGGLE + STATUS
// ==============================================

function setBuildingStatus(text: string, detail: string): void {

    const count = document.getElementById("buildingCount");

    if (count) count.textContent = text;

    const toggle = document.getElementById("buildingToggle");

    if (toggle) toggle.title = detail;
}

function updateBuildingStatus(): void {

    if (!buildingsEnabled) {
        setBuildingStatus("OFF", "Show buildings in 3D when the map is tilted");
        return;
    }

    if (map.getZoom() < BUILDING_MIN_ZOOM) {
        setBuildingStatus("ZOOM IN", "Buildings appear at city zoom. Shift + drag to tilt");
        return;
    }

    setBuildingStatus("ON", "Shift + drag to tilt and rotate");
}

function setBuildingsEnabled(enabled: boolean, animate = true): void {

    buildingsEnabled = enabled;

    try {
        localStorage.setItem(BUILDING_KEY, enabled ? "1" : "0");
    } catch (error) {
        // storage unavailable: the choice just won't persist
    }

    const toggle = document.getElementById("buildingToggle");

    if (toggle) toggle.classList.toggle("active", enabled);

    if (enabled) {

        ensureBuildingLayer();

        // Already zoomed into a city but looking straight down: tilt so the
        // buildings are visible straight away
        if (animate && map.getZoom() >= BUILDING_MIN_ZOOM && map.getPitch() < 20) {
            map.easeTo({ pitch: BUILDING_AUTO_PITCH, duration: 800 });
        }

    } else {

        removeBuildingLayer();
    }

    updateBuildingStatus();
}


// ==============================================
// B4. INIT
// ==============================================

function initializeBuildings(): void {

    if (!map) return;

    map.on("styledata", ensureBuildingLayer);
    map.on("idle", ensureBuildingLayer);
    map.on("zoomend", updateBuildingStatus);

    const toggle = document.getElementById("buildingToggle");

    if (toggle) {
        toggle.addEventListener("click", () => setBuildingsEnabled(!buildingsEnabled));
    }

    let saved = false;

    try {
        saved = localStorage.getItem(BUILDING_KEY) === "1";
    } catch (error) {
        // storage unavailable: start with buildings off
    }

    updateBuildingStatus();

    if (saved) {
        map.once("load", () => setBuildingsEnabled(true, false));
    }
}
