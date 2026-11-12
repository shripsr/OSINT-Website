/* ==============================================
   OSINT MAP - LOCAL SERVER (optional)

   Serves this folder AND relays flight-feed requests, which avoids
   browser CORS problems and the "file://" null-origin problem.

   Requires Node 18 or newer. No packages to install.

     node server.js
     then open  http://localhost:8080

   Flight data: adsb.fi, airplanes.live, adsb.lol (tried in order).
   Personal, non-commercial use. Credit adsb.fi.
   ============================================== */

const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = Number(process.env.PORT) || 8080;
const ROOT = __dirname;

const UPSTREAMS = [
    (la, lo, d) => `https://opendata.adsb.fi/api/v2/lat/${la}/lon/${lo}/dist/${d}`,
    (la, lo, d) => `https://api.airplanes.live/v2/point/${la}/${lo}/${d}`,
    (la, lo, d) => `https://api.adsb.lol/v2/point/${la}/${lo}/${d}`
];

const MIME = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".svg": "image/svg+xml",
    ".ico": "image/x-icon"
};


// Keep upstream traffic under 1 request per second

let nextSlot = 0;

function waitForSlot() {
    const now = Date.now();
    const at = Math.max(now, nextSlot);
    nextSlot = at + 1100;
    return new Promise(resolve => setTimeout(resolve, at - now));
}


// Short cache so repeated requests for the same area are free

const cache = new Map();

async function getFlights(lat, lon, dist) {

    const key = `${lat}|${lon}|${dist}`;

    const hit = cache.get(key);

    if (hit && Date.now() - hit.time < 5000) return hit.body;

    if (cache.size > 200) cache.clear();

    let lastError = null;

    for (const build of UPSTREAMS) {

        try {

            await waitForSlot();

            const response = await fetch(build(lat, lon, dist), {
                headers: {
                    "Accept": "application/json",
                    "User-Agent": "osint-map-local/1.0"
                },
                signal: AbortSignal.timeout(10000)
            });

            if (!response.ok) throw new Error(`HTTP ${response.status}`);

            const body = await response.text();

            JSON.parse(body);   // make sure it really is JSON

            cache.set(key, { time: Date.now(), body: body });

            return body;

        }

        catch (error) {

            lastError = error;

            console.warn(`Feed failed (${error.message})`);

        }

    }

    throw lastError || new Error("No feed available");
}


// Aircraft photos (Planespotters.net public API). Their API asks callers to
// identify themselves, so edit the User-Agent below to name your project.

const PHOTO_USER_AGENT = "osint-map-local/1.0 (personal non-commercial project)";

const photoCache = new Map();

async function getPhoto(kind, value) {

    const key = `${kind}:${value.toLowerCase()}`;

    const hit = photoCache.get(key);

    if (hit && Date.now() - hit.time < 3600000) return hit.body;

    if (photoCache.size > 500) photoCache.clear();

    const response = await fetch(
        `https://api.planespotters.net/pub/photos/${kind}/${encodeURIComponent(value)}`,
        {
            headers: {
                "Accept": "application/json",
                "User-Agent": PHOTO_USER_AGENT
            },
            signal: AbortSignal.timeout(8000)
        }
    );

    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const body = await response.text();

    JSON.parse(body);

    photoCache.set(key, { time: Date.now(), body: body });

    return body;
}


function sendJSON(res, status, body) {
    res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
    res.end(typeof body === "string" ? body : JSON.stringify(body));
}


const server = http.createServer(async function(req, res) {

    const url = new URL(req.url, `http://${req.headers.host}`);


    // Flight feed relay

    if (url.pathname === "/api/flights") {

        const lat = Number(url.searchParams.get("lat"));
        const lon = Number(url.searchParams.get("lon"));
        const dist = Number(url.searchParams.get("dist"));

        const valid =
            Number.isFinite(lat) && Math.abs(lat) <= 90 &&
            Number.isFinite(lon) && Math.abs(lon) <= 180 &&
            Number.isFinite(dist) && dist >= 1 && dist <= 250;

        if (!valid) return sendJSON(res, 400, { error: "Bad parameters" });

        try {
            const body = await getFlights(lat.toFixed(3), lon.toFixed(3), Math.ceil(dist));
            return sendJSON(res, 200, body);
        }

        catch (error) {
            return sendJSON(res, 502, { error: error.message });
        }

    }


    // Aircraft photo relay

    if (url.pathname === "/api/photo") {

        const hex = url.searchParams.get("hex");
        const reg = url.searchParams.get("reg");

        let kind = null;
        let value = null;

        if (hex && /^[0-9a-fA-F]{6}$/.test(hex)) { kind = "hex"; value = hex; }
        else if (reg && /^[A-Za-z0-9-]{2,10}$/.test(reg)) { kind = "reg"; value = reg; }

        if (!kind) return sendJSON(res, 400, { error: "Bad parameters" });

        try {
            return sendJSON(res, 200, await getPhoto(kind, value));
        }

        catch (error) {
            return sendJSON(res, 502, { error: error.message });
        }

    }


    // Static files (restricted to this folder)

    let relative = decodeURIComponent(url.pathname);

    if (relative.endsWith("/")) relative += "index.html";

    const filePath = path.normalize(path.join(ROOT, relative));

    if (!filePath.startsWith(ROOT + path.sep)) {
        res.writeHead(403);
        return res.end("Forbidden");
    }

    fs.readFile(filePath, function(error, data) {

        if (error) {
            res.writeHead(404);
            return res.end("Not found");
        }

        res.writeHead(200, {
            "Content-Type": MIME[path.extname(filePath).toLowerCase()] || "application/octet-stream"
        });

        res.end(data);

    });

});


server.listen(PORT, "127.0.0.1", function() {
    console.log(`OSINT MAP running at http://localhost:${PORT}`);
});
