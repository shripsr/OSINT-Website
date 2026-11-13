
/* ==============================================
   OSINT MAP
   VERSION 0.3.0
   SOURCE: src/script.ts  ->  compiled to script.js by "npm run build"
           (edit the .ts file, never the .js)
   MAP ENGINE: MAPLIBRE GL JS
   ============================================== */


// ==============================================
// 1. CONFIGURATION
// ==============================================

const CARTO_API_KEY = CONFIG.CARTO_API_KEY;

const CARTO_STYLE_URL = (style: string): string =>
    `https://basemaps.cartocdn.com/gl/${style}-gl-style/style.json?key=${encodeURIComponent(CARTO_API_KEY)}`;


// ==============================================
// 2. APPLICATION STATE
// ==============================================

// Created by initializeMap(). Code that can run before that checks `if (!map)`.
let map: MapInstance;

let selectedMarker: MapMarker | null = null;
let selectedMarkerId: string | null = null;

let savedMarkers: SavedMarker[] = [];
const markerRegistry = new Map<string, MapMarker>();

const MAP_STYLE_KEY = "osint_map_base_style";

// Last base map the user picked (dark / voyager / satellite)
type MapStyleName = "dark" | "voyager" | "satellite";

const MAP_STYLE_NAMES: MapStyleName[] = ["dark", "voyager", "satellite"];

function isMapStyleName(value: unknown): value is MapStyleName {
    return MAP_STYLE_NAMES.includes(value as MapStyleName);
}

function loadSavedMapStyle(): MapStyleName {
    try {
        const saved = localStorage.getItem(MAP_STYLE_KEY);
        return isMapStyleName(saved) ? saved : "dark";
    } catch (error) {
        return "dark";
    }
}

let currentMapStyle = loadSavedMapStyle();

let searchInProgress = false;
let lastSearchTime = 0;

const STORAGE_KEY = "osint_map_saved_locations";


// ==============================================
// 3. DOM ELEMENTS
// ==============================================

// Every id used here exists in index.html; a typo fails loudly instead of
// silently returning null.
function $<T extends HTMLElement = HTMLElement>(id: string): T {

    const element = document.getElementById(id);

    if (!element) throw new Error(`Missing element #${id}`);

    return element as T;
}

const searchInput = $<HTMLInputElement>("searchInput");
const searchButton = $<HTMLButtonElement>("searchButton");

const inspectionPanel = $("inspectionPanel");

const markerNameBox = $<HTMLTextAreaElement>("markerName");
const markerDescriptionBox = $<HTMLTextAreaElement>("markerDescription");
const mapStyleSelect = $<HTMLSelectElement>("mapStyleSelect");

const mapLoading = $("mapLoading");
const mapError = $("mapError");

const systemStatus = $("systemStatus");
const footerStatus = $("footerStatus");
const searchSuggestions = $("searchSuggestions");


// ==============================================
// 4. MAP STYLE DEFINITIONS
// ==============================================

function getMapStyle(styleName: MapStyleName): string | MapStyle {

    // CARTO VECTOR STYLES

    if (styleName === "dark") {
        return CARTO_STYLE_URL("dark-matter");
    }

    if (styleName === "voyager") {
        return CARTO_STYLE_URL("voyager");
    }

    // ESRI SATELLITE RASTER STYLE

    if (styleName === "satellite") {

        return {
            version: 8,

            sources: {
                satellite: {
                    type: "raster",

                    tiles: [
                        "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"
                    ],

                    tileSize: 256,

                    attribution: "Tiles © Esri"
                }
            },

            layers: [
                {
                    id: "satellite-layer",
                    type: "raster",
                    source: "satellite"
                }
            ]
        };

    }

    return CARTO_STYLE_URL("dark-matter");

}


// ==============================================
// 5. INITIALIZE MAP
// ==============================================

function initializeMap(): void {

    try {

        // Browsers restore the dropdown on refresh; keep it matching the map
        mapStyleSelect.value = currentMapStyle;

        map = new maplibregl.Map({

            container: "map",

            style: getMapStyle(currentMapStyle),

            center: [0, 20],

            zoom: 2,

            minZoom: 1,

            maxZoom: 19,

            // (attribution control: left out, so MapLibre adds its default one)

            renderWorldCopies: true,

            fadeDuration: 100,

            maxTileCacheSize: 512

        });


        // NAVIGATION CONTROLS

        map.addControl(
            new maplibregl.NavigationControl({
                visualizePitch: true
            }),
            "bottom-right"
        );


        // SCALE CONTROL

        map.addControl(
            new maplibregl.ScaleControl({
                maxWidth: 150,
                unit: "metric"
            }),
            "bottom-left"
        );


        // MAP LOAD EVENT

        map.on("load", function() {

            console.log("OSINT MAP: Map loaded.");

            systemStatus.innerText = "SYSTEM ONLINE";
            footerStatus.innerText = "MAP ACTIVE";

            mapLoading.classList.add("hidden");

            mapError.classList.remove("visible");

            restoreSavedMarkers();

            updateMarkerCount();

            updateMapInformation();

        });


        // MAP ERRORS

        map.on("error", function(e) {

            console.error("MapLibre error:", e.error || e);

        });


        // MAP MOVEMENT

        map.on("move", updateMapInformation);

        map.on("mousemove", updateMouseCoordinates);


        // MAP CLICK

        map.on("click", function(e) {

            // Clicking an aircraft opens flight details instead
            if (isFlightAtPoint(e.point)) return;

            inspectLocation(
                e.lngLat.lat,
                e.lngLat.lng
            );

        });


       // MAP STYLE CHANGE

        map.on("style.load", function() {

            console.log("Map style loaded:", currentMapStyle);
            
            // Re-apply the current projection after the style swaps
            if (currentProjection) {
                map.setProjection({ type: currentProjection });
            }

        });


        // LIVE FLIGHT TRACKING (see flights.js)

        initializeFlights();

    }

    catch (error) {

        console.error(error);

        showMapError("Unable to initialize MapLibre.");

    }

}

// ================= MAP PROJECTION =================

const flatMapButton = $("flatMapButton");
const globeButton = $("globeButton");

type MapProjectionName = "mercator" | "globe";

let currentProjection: MapProjectionName = "mercator";

function setMapProjection(projection: MapProjectionName): void {

    if (!map) return;

    currentProjection = projection;

    map.setProjection({
        type: projection
    });

    flatMapButton.classList.toggle(
        "active",
        projection === "mercator"
    );

    globeButton.classList.toggle(
        "active",
        projection === "globe"
    );
}

flatMapButton.addEventListener("click", () => {
    setMapProjection("mercator");
});

globeButton.addEventListener("click", () => {
    setMapProjection("globe");
});


// ==============================================
// 6. MAP STATUS
// ==============================================

function showMapError(message: string): void {

    mapLoading.classList.add("hidden");

    mapError.classList.add("visible");

    $("mapErrorMessage").innerText = message;

    systemStatus.innerText = "CONNECTION ERROR";

    footerStatus.innerText = "MAP OFFLINE";

}


// ==============================================
// 7. MAP INFORMATION
// ==============================================

function updateMapInformation(): void {

    if (!map) return;

    const center = map.getCenter();

    const zoom = map.getZoom().toFixed(1);

    $("sideLat").innerText = center.lat.toFixed(5);

    $("sideLon").innerText = center.lng.toFixed(5);

    $("sideZoom").innerText = zoom;

    $("mapZoom").innerText = `ZOOM: ${zoom}`;

}


function updateMouseCoordinates(e: MapMouseEvent): void {

    const lat = e.lngLat.lat.toFixed(5);

    const lon = e.lngLat.lng.toFixed(5);

    $("mouseCoordinates").innerText =
        `LAT: ${lat} | LON: ${lon}`;

}


// ==============================================
// 8. LOCATION INSPECTION
// ==============================================

// The location name box grows to fit its text (a full address wraps onto
// several lines instead of scrolling sideways).
function autoSizeMarkerName(): void {

    const box = markerNameBox;

    box.style.height = "auto";
    box.style.height = (box.scrollHeight + 2) + "px";
}

markerNameBox.addEventListener("input", autoSizeMarkerName);

// It's a name, not a note: Enter doesn't add a line break
markerNameBox.addEventListener("keydown", function(e) {
    if (e.key === "Enter") e.preventDefault();
});


// Address shown under the name (rest of a searched address); saved with the marker
let currentInspectAddress = "";

function inspectLocation(
    lat: number,
    lon: number,
    name = "",
    description = "",
    id: string | null = null,
    address = ""
): void {

    // The location panel and the airport panel share the left side:
    // opening a location closes the airport
    if (typeof closeAirportPanel === "function") closeAirportPanel();

    // Remove only the previous temporary marker.
    // Never remove a permanently saved marker.

    if (selectedMarker && !selectedMarkerId) {
        selectedMarker.remove();
    }

    selectedMarkerId = id;

    // Reuse an existing saved marker if selected.
    if (id && markerRegistry.has(id)) {
        selectedMarker = markerRegistry.get(id) ?? null;
    } else {
        selectedMarker = new maplibregl.Marker({
            color: "#00bcd4"
        })
        .setLngLat([lon, lat])
        .addTo(map);
    }

    markerNameBox.value = name;
    markerDescriptionBox.value = description;

    // A saved location keeps the address it was saved with
    if (!address && id) {
        const saved = savedMarkers.find(item => item.id === id);
        if (saved && saved.address) address = saved.address;
    }

    currentInspectAddress = address;

    $("inspectAddress").innerText = address;

    $("inspectCoords").innerText =
        `${lat.toFixed(6)}, ${lon.toFixed(6)}`;

    inspectionPanel.classList.add("visible");

    autoSizeMarkerName();   // after the panel is visible, so it can be measured

    $("deleteMarker").style.display =
        id ? "block" : "none";
}


// ==============================================
// 9. CLOSE INSPECTION PANEL
// ==============================================

$("closePanel").addEventListener("click", function() {

    inspectionPanel.classList.remove("visible");

});


// ==============================================
// 10. CLEAR SELECTION
// ==============================================

function clearSelection(): void {

    // Only remove temporary markers.
    if (selectedMarker && !selectedMarkerId) {
        selectedMarker.remove();
    }

    selectedMarker = null;
    selectedMarkerId = null;

    inspectionPanel.classList.remove("visible");
}


$("clearButton").addEventListener("click", clearSelection);


// ==============================================
// 11. LOCATION SEARCH
// ==============================================

async function searchLocation(): Promise<void> {

    const input = searchInput.value.trim();

    if (!input) return;

    if (searchInProgress) return;


    // CHECK GPS COORDINATES

    const coordinateMatch = input.match(
        /^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/
    );


    if (coordinateMatch) {

        const lat = Number(coordinateMatch[1]);

        const lon = Number(coordinateMatch[2]);


        if (Math.abs(lat) > 90 || Math.abs(lon) > 180) {

            alert("Invalid GPS coordinates.");

            return;

        }


        map.flyTo({

            center: [lon, lat],

            zoom: 12,

            essential: true

        });


        inspectLocation(lat, lon, "GPS Coordinates");

        return;

    }


    // FLIGHT LOOKUP (callsign, registration or ICAO hex of a tracked aircraft)

    if (await searchFlights(input)) {

        searchSuggestions.classList.remove("active");

        return;

    }


    // GEOCODING RATE LIMIT

    const now = Date.now();

    if (now - lastSearchTime < 1100) {

        alert("Please wait before performing another location search.");

        return;

    }

    lastSearchTime = now;

    searchInProgress = true;

    searchButton.disabled = true;

    searchButton.innerText = "SEARCHING";


    try {

        const url =
            "https://nominatim.openstreetmap.org/search?format=jsonv2&limit=5&q=" +
            encodeURIComponent(input);


        const response = await fetch(url, {
            headers: {
                "Accept": "application/json"
            }
        });


        if (!response.ok) {

            throw new Error("Location search service unavailable.");

        }


        const results = await response.json();


        if (!results.length) {

            alert("No matching locations found.");

            return;

        }


        const result = results[0];

        const lat = Number(result.lat);

        const lon = Number(result.lon);


        // The place found is an airport (e.g. "heathrow"): open its
        // arrivals / departures panel, as if the pin had been clicked

        const isAirport =
            (result.category || result.class) === "aeroway" &&
            result.type === "aerodrome";

        if (isAirport && typeof openAirportNear === "function" &&
            openAirportNear(lat, lon, result.display_name)) {

            return;

        }


        map.flyTo({

            center: [lon, lat],

            zoom: 12,

            essential: true

        });


        // "1 Harborside Drive, East Boston, ..." -> title + the rest underneath
        const addressParts = String(result.display_name || "")
            .split(",").map(part => part.trim()).filter(Boolean);

        inspectLocation(
            lat,
            lon,
            addressParts[0] || "",
            "",
            null,
            addressParts.slice(1).join(", ")
        );


    }

    catch (error) {

        console.error("Search error:", error);

        alert("Unable to search for this location.");

    }

    finally {

        searchInProgress = false;

        searchButton.disabled = false;

        searchButton.innerText = "SEARCH";

    }

}
// ==============================================
// 11B. AUTOCOMPLETE / SUGGESTIONS
// ==============================================

let suggestionTimeout: number | undefined;

searchInput.addEventListener("input", function(e) {
    const query = searchInput.value.trim();
    
    // Clear the timer on every keystroke
    clearTimeout(suggestionTimeout);
    
    // Hide dropdown if query is too short
    if (query.length < 3) {
        searchSuggestions.classList.remove("active");
        return;
    }

    // Do not suggest if it looks like raw GPS coordinates
    if (/^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/.test(query)) {
        searchSuggestions.classList.remove("active");
        return;
    }

    // Wait 600ms after user stops typing to protect API rate limits
    suggestionTimeout = setTimeout(async () => {

        // Airports from the flight layer's own list go first; picking one
        // opens its arrivals / departures panel
        const airports = typeof flightAirportMatches === "function"
            ? flightAirportMatches(query, 3)
            : [];

        const addAirportSuggestions = function() {
            airports.forEach(airport => {
                const item = document.createElement("div");
                item.className = "suggestion-item";
                item.innerText = "✈ " + (airport.iata || airport.icao) + " · " +
                    airport.name + (airport.city ? " (" + airport.city + ")" : "");

                item.addEventListener("click", () => {
                    searchInput.value = airport.name;
                    searchSuggestions.classList.remove("active");
                    openAirportFromSearch(airport);
                });

                searchSuggestions.appendChild(item);
            });
        };

        try {
            const url = "https://nominatim.openstreetmap.org/search?format=jsonv2&limit=5&q=" + encodeURIComponent(query);

            const response = await fetch(url, {
                headers: { "Accept": "application/json" }
            });

            const found: NominatimPlace[] = response.ok ? await response.json() : [];
            searchSuggestions.innerHTML = "";

            // A place result that is one of our airports would be a second
            // entry for the same thing: keep only the ✈ one, and remember
            // the place's address to show in the airport panel.
            const results = found.filter(result => {

                const isAirport =
                    (result.category || result.class) === "aeroway" &&
                    result.type === "aerodrome";

                const airport = isAirport && typeof findAirportNear === "function"
                    ? findAirportNear(Number(result.lat), Number(result.lon))
                    : null;

                if (!airport) return true;

                if (!airports.includes(airport)) airports.push(airport);

                rememberAirportAddress(airport, result.display_name);

                return false;
            });

            addAirportSuggestions();

            if (results.length > 0 || airports.length > 0) {
                // Populate dropdown with results
                results.forEach(result => {
                    const item = document.createElement("div");
                    item.className = "suggestion-item";
                    item.innerText = result.display_name;
                    
                    // Handle clicking a suggestion
                    item.addEventListener("click", () => {
                        searchInput.value = result.display_name;
                        searchSuggestions.classList.remove("active");
                        searchLocation(); // Trigger map flight
                    });
                    
                    searchSuggestions.appendChild(item);
                });
                
                searchSuggestions.classList.add("active");
            } else {
                searchSuggestions.classList.remove("active");
            }
        } catch (error) {
            console.error("Autocomplete error:", error);

            // Place lookup failed: still offer the airports we know
            searchSuggestions.innerHTML = "";
            addAirportSuggestions();
            searchSuggestions.classList.toggle("active", airports.length > 0);
        }
    }, 600); 
});

// Close dropdown if user clicks anywhere else on the page
document.addEventListener("click", function(e) {
    const target = e.target as Node | null;

    if (!searchInput.contains(target) && !searchSuggestions.contains(target)) {
        searchSuggestions.classList.remove("active");
    }
});

// Search button

searchButton.addEventListener("click", searchLocation);


// Enter key

searchInput.addEventListener("keydown", function(e) {

    if (e.key === "Enter") {

        searchLocation();

    }

});


// ==============================================
// 12. SAVE MARKERS
// ==============================================

function loadSavedData(): void {

    try {

        const data = localStorage.getItem(STORAGE_KEY);

        savedMarkers = data ? JSON.parse(data) : [];

        if (!Array.isArray(savedMarkers)) {
            savedMarkers = [];
        }

    }

    catch (error) {

        console.error("Storage error:", error);

        savedMarkers = [];

    }

}


function saveToStorage(): void {

    try {

        localStorage.setItem(
            STORAGE_KEY,
            JSON.stringify(savedMarkers)
        );

    }

    catch (error) {

        console.error("Unable to save markers:", error);

        alert("Unable to save. Browser storage may be full or unavailable.");

    }

}


// ==============================================
// 13. RESTORE SAVED MARKERS
// ==============================================

function restoreSavedMarkers(): void {

    // Remove existing rendered markers.
    markerRegistry.forEach(marker => marker.remove());

    markerRegistry.clear();

    // Recreate markers from saved data.
    savedMarkers.forEach(data => {
        createMapMarker(data);
    });
}


function createMapMarker(data: SavedMarker): MapMarker {

    // Remove an existing instance of this saved marker.
    if (markerRegistry.has(data.id)) {
        markerRegistry.get(data.id)?.remove();
        markerRegistry.delete(data.id);
    }

    const marker = new maplibregl.Marker({
        color: "#00bcd4"
    })
    .setLngLat([data.lon, data.lat])
    .setPopup(
        new maplibregl.Popup({
            offset: 25
        }).setHTML(
            `<strong>${escapeHTML(data.name)}</strong>
             <br>
             <small>${data.lat.toFixed(5)}, ${data.lon.toFixed(5)}</small>`
        )
    )
    .addTo(map);

    markerRegistry.set(data.id, marker);

    marker.getElement().addEventListener("click", function(e) {
        e.stopPropagation();

        inspectLocation(
            data.lat,
            data.lon,
            data.name,
            data.description,
            data.id
        );
    });

    return marker;
}


// Prevent saved text from becoming HTML

function escapeHTML(value: unknown): string {

    return String(value ?? "").replace(/[&<>"']/g, function(char) {

        const entities: Record<string, string> = {
            "&": "&amp;",
            "<": "&lt;",
            ">": "&gt;",
            '"': "&quot;",
            "'": "&#39;"
        };

        return entities[char];

    });

}


// ==============================================
// 14. SAVE LOCATION BUTTON
// ==============================================

$("saveMarker").addEventListener("click", function() {

    if (!selectedMarker) return;


    const position = selectedMarker.getLngLat();

    const name =
        markerNameBox.value.trim() || "Unnamed Location";

    const description =
        markerDescriptionBox.value.trim();


    // Existing marker: update its data

    if (selectedMarkerId) {

        const existing = savedMarkers.find(
            item => item.id === selectedMarkerId
        );

        if (!existing) return;

        existing.name = name;

        existing.description = description;

        existing.lat = position.lat;

        existing.lon = position.lng;

        saveToStorage();

        updateMarkerCount();

        clearSelection();

        restoreSavedMarkers();

        alert("Location updated.");

        return;

    }


    // New marker

    const data: SavedMarker = {

        id: crypto.randomUUID(),

        name: name,

        description: description,

        address: currentInspectAddress,

        lat: position.lat,

        lon: position.lng,

        created: new Date().toISOString()

    };


    savedMarkers.push(data);

    saveToStorage();

    updateMarkerCount();


    // Add permanent marker

    const marker = createMapMarker(data);

    selectedMarker.remove();

    selectedMarker = marker;

    selectedMarkerId = data.id;


    // Update delete button

    $("deleteMarker").style.display = "block";


    alert("Location saved successfully.");

});


// ==============================================
// 15. DELETE LOCATION
// ==============================================

$("deleteMarker").addEventListener("click", function() {

    if (!selectedMarkerId) return;

    const confirmed = confirm(
        "Are you sure you want to delete this saved location?"
    );

    if (!confirmed) return;


    savedMarkers = savedMarkers.filter(
        item => item.id !== selectedMarkerId
    );


    saveToStorage();

    updateMarkerCount();

    clearSelection();

    // Remove and recreate all saved markers

    if (map) {

        restoreSavedMarkers();

    }

});


// ==============================================
// 16. MARKER COUNT
// ==============================================

function updateMarkerCount(): void {

    $("markerCount").innerText = String(savedMarkers.length);

}


// ==============================================
// 17. MAP STYLE SWITCHING
// ==============================================

mapStyleSelect.addEventListener("change", function() {

    const newStyle = mapStyleSelect.value;

    if (!isMapStyleName(newStyle)) return;

    if (newStyle === currentMapStyle) return;


    currentMapStyle = newStyle;

    try {
        localStorage.setItem(MAP_STYLE_KEY, newStyle);
    } catch (error) {
        // storage unavailable: the choice just won't persist
    }


    mapLoading.classList.remove("hidden");

    $("systemStatus").innerText = "CHANGING MAP";

    $("footerStatus").innerText = "LOADING STYLE";


    map.setStyle(getMapStyle(newStyle), { diff: false });


    // Wait for new style to finish loading

    map.once("idle", function() {

        mapLoading.classList.add("hidden");

        $("systemStatus").innerText = "SYSTEM ONLINE";

        $("footerStatus").innerText = "MAP ACTIVE";

    });

});


// ==============================================
// 18. WORLD MAP NAVIGATION
// ==============================================

function returnToWorld(): void {

    map.flyTo({

        center: [0, 20],

        zoom: 2,

        essential: true

    });

    clearSelection();

}


// ==============================================
// 19. SAVED MARKER NAVIGATION
// ==============================================

function showSavedMarkers(): void {

    if (!savedMarkers.length) {

        alert("No saved locations.");

        return;

    }


    if (savedMarkers.length === 1) {

        const item = savedMarkers[0];

        map.flyTo({

            center: [item.lon, item.lat],

            zoom: 12

        });

        inspectLocation(
            item.lat,
            item.lon,
            item.name,
            item.description,
            item.id
        );

        return;

    }


    const bounds = new maplibregl.LngLatBounds();


    savedMarkers.forEach(function(item) {

        bounds.extend([item.lon, item.lat]);

    });


    map.fitBounds(bounds, {

        padding: 70,

        maxZoom: 12,

        duration: 1200

    });

}


// ==============================================
// 20. SIDEBAR NAVIGATION
// ==============================================

document.querySelectorAll<HTMLElement>(".menu-item[data-page]")
    .forEach(function(item) {

        item.addEventListener("click", function() {

            document.querySelectorAll(".menu-item")
                .forEach(el => el.classList.remove("active"));

            item.classList.add("active");


            const page = item.dataset.page;


            if (page === "world") {

                returnToWorld();

            }

            else if (
                page === "markers" ||
                page === "saved"
            ) {

                showSavedMarkers();

            }

        });

    });


// ==============================================
// 21. MANUAL COORDINATE ENTRY
// ==============================================

$("locateButton").addEventListener("click", function() {

    const input = prompt(
        "Enter coordinates:\n\nFormat: latitude, longitude\n\nExample: 49.2827, -123.1207"
    );

    if (!input) return;

    searchInput.value = input;

    searchLocation();

});


// ==============================================
// 22. START APPLICATION
// ==============================================

function startApplication(): void {

    loadSavedData();

    updateMarkerCount();

    initializeMap();

}


startApplication();

