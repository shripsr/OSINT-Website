// Things the page loads with <script> tags before our own code.

// MapLibre GL JS (loaded from a CDN in index.html)
declare const maplibregl: typeof import("maplibre-gl");

// config.js (git-ignored): keys the browser needs
declare const CONFIG: {
    CARTO_API_KEY: string;
};
