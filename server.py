#!/usr/bin/env python3
"""
OSINT MAP - LOCAL SERVER (Python version, optional)

Serves this folder AND relays flight-feed requests, which avoids
browser CORS blocking. Needs Python 3.7+. No packages to install.

    python server.py            (or: python3 server.py)
    then open  http://localhost:8080

Flight data: adsb.fi, airplanes.live, adsb.lol (tried in order).
Personal, non-commercial use. Credit adsb.fi.
"""

import json
import os
import re
import threading
import time
import urllib.parse
import urllib.request
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

PORT = int(os.environ.get("PORT", "8080"))
ROOT = os.path.dirname(os.path.abspath(__file__))

UPSTREAMS = [
    lambda la, lo, d: f"https://opendata.adsb.fi/api/v2/lat/{la}/lon/{lo}/dist/{d}",
    lambda la, lo, d: f"https://api.airplanes.live/v2/point/{la}/{lo}/{d}",
    lambda la, lo, d: f"https://api.adsb.lol/v2/point/{la}/{lo}/{d}",
]

_lock = threading.Lock()
_next_slot = 0.0
_cache = {}


def wait_for_slot():
    """Keep upstream traffic under 1 request per second."""
    global _next_slot
    with _lock:
        now = time.time()
        at = max(now, _next_slot)
        _next_slot = at + 1.1
    time.sleep(max(0.0, at - now))


def get_flights(lat, lon, dist):
    key = (lat, lon, dist)
    hit = _cache.get(key)
    if hit and time.time() - hit[0] < 5:
        return hit[1]
    if len(_cache) > 200:
        _cache.clear()

    last_error = None
    for build in UPSTREAMS:
        try:
            wait_for_slot()
            request = urllib.request.Request(
                build(lat, lon, dist),
                headers={"Accept": "application/json",
                         "User-Agent": "osint-map-local/1.0"},
            )
            with urllib.request.urlopen(request, timeout=10) as response:
                body = response.read().decode("utf-8")
            json.loads(body)  # make sure it really is JSON
            _cache[key] = (time.time(), body)
            return body
        except Exception as error:  # noqa: BLE001
            last_error = error
            print(f"Feed failed ({error})")
    raise last_error or RuntimeError("No feed available")


# Aircraft photos (Planespotters.net public API). Their API asks callers to
# identify themselves, so edit the User-Agent below to name your project.
PHOTO_USER_AGENT = "osint-map-local/1.0 (personal non-commercial project)"

_photo_cache = {}


def get_photo(kind, value):
    key = (kind, value.lower())
    hit = _photo_cache.get(key)
    if hit and time.time() - hit[0] < 3600:
        return hit[1]
    if len(_photo_cache) > 500:
        _photo_cache.clear()

    request = urllib.request.Request(
        f"https://api.planespotters.net/pub/photos/{kind}/{urllib.parse.quote(value)}",
        headers={"Accept": "application/json", "User-Agent": PHOTO_USER_AGENT},
    )
    with urllib.request.urlopen(request, timeout=8) as response:
        body = response.read().decode("utf-8")
    json.loads(body)
    _photo_cache[key] = (time.time(), body)
    return body


class Handler(SimpleHTTPRequestHandler):

    def send_json(self, status, body):
        data = (body if isinstance(body, str) else json.dumps(body)).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        url = urllib.parse.urlparse(self.path)

        if url.path == "/api/photo":
            query = urllib.parse.parse_qs(url.query)
            hex_code = (query.get("hex") or [""])[0]
            reg = (query.get("reg") or [""])[0]
            if re.fullmatch(r"[0-9a-fA-F]{6}", hex_code):
                kind, value = "hex", hex_code
            elif re.fullmatch(r"[A-Za-z0-9-]{2,10}", reg):
                kind, value = "reg", reg
            else:
                return self.send_json(400, {"error": "Bad parameters"})
            try:
                return self.send_json(200, get_photo(kind, value))
            except Exception as error:  # noqa: BLE001
                return self.send_json(502, {"error": str(error)})

        if url.path != "/api/flights":
            return super().do_GET()

        query = urllib.parse.parse_qs(url.query)
        try:
            lat = float(query["lat"][0])
            lon = float(query["lon"][0])
            dist = float(query["dist"][0])
            assert abs(lat) <= 90 and abs(lon) <= 180 and 1 <= dist <= 250
        except Exception:  # noqa: BLE001
            return self.send_json(400, {"error": "Bad parameters"})

        try:
            body = get_flights(f"{lat:.3f}", f"{lon:.3f}", int(-(-dist // 1)))
            self.send_json(200, body)
        except Exception as error:  # noqa: BLE001
            self.send_json(502, {"error": str(error)})


if __name__ == "__main__":
    server = ThreadingHTTPServer(("127.0.0.1", PORT), partial(Handler, directory=ROOT))
    print(f"OSINT MAP running at http://localhost:{PORT}")
    server.serve_forever()
