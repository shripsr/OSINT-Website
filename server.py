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

import csv
import io
import json
import os
import re
import threading
import time
import urllib.error
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


# ----------------------------------------------
# World view: OpenSky Network
#
# One request returns every aircraft on Earth, but OpenSky meters usage in
# credits (a world request costs 4):
#   anonymous      400 credits/day  -> at most 1 snapshot per 15 minutes
#   free account  4000 credits/day  -> at most 1 snapshot per 90 seconds
# This relay enforces that spacing no matter how often the browser asks.
#
# For the faster rate, create a free account at opensky-network.org, make an
# API client on the account page, and either save the downloaded file in this
# folder as  opensky-credentials.json  (or credentials.json), or set the
# OPENSKY_CLIENT_ID and OPENSKY_CLIENT_SECRET environment variables.
# ----------------------------------------------

# extended=1 adds each aircraft's category (light / heavy / helicopter / ...),
# which the map uses to pick a plane shape before you click anything.
OPENSKY_API_URL = os.environ.get(
    "OPENSKY_API_URL", "https://opensky-network.org/api/states/all?extended=1")
OPENSKY_TOKEN_URL = os.environ.get(
    "OPENSKY_TOKEN_URL",
    "https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token")


def load_opensky_credentials():
    env_id = os.environ.get("OPENSKY_CLIENT_ID")
    env_secret = os.environ.get("OPENSKY_CLIENT_SECRET")
    if env_id and env_secret:
        return env_id, env_secret
    for name in ("opensky-credentials.json", "credentials.json"):
        try:
            with open(os.path.join(ROOT, name), encoding="utf-8") as handle:
                data = json.load(handle)
            client_id = data.get("clientId") or data.get("client_id")
            secret = data.get("clientSecret") or data.get("client_secret")
            if client_id and secret:
                return client_id, secret
        except Exception:  # noqa: BLE001
            continue  # missing or unreadable: try the next one
    return None


OPENSKY_CREDENTIALS = load_opensky_credentials()

# Do not lower this: it is what keeps you inside your daily credits.
OPENSKY_MIN_INTERVAL = float(
    os.environ.get("OPENSKY_MIN_INTERVAL") or (90 if OPENSKY_CREDENTIALS else 900))

_opensky_lock = threading.Lock()   # several browser tabs share one request
_opensky = {"token": None, "token_expires": 0.0,
            "cache": None, "blocked_until": 0.0}


class OpenSkyLimit(Exception):
    def __init__(self, message, retry_after):
        super().__init__(message)
        self.retry_after = retry_after


def get_opensky_token():
    if not OPENSKY_CREDENTIALS:
        return None
    if _opensky["token"] and time.time() < _opensky["token_expires"]:
        return _opensky["token"]
    form = urllib.parse.urlencode({
        "grant_type": "client_credentials",
        "client_id": OPENSKY_CREDENTIALS[0],
        "client_secret": OPENSKY_CREDENTIALS[1],
    }).encode("utf-8")
    request = urllib.request.Request(
        OPENSKY_TOKEN_URL, data=form, method="POST",
        headers={"Content-Type": "application/x-www-form-urlencoded"})
    try:
        with urllib.request.urlopen(request, timeout=10) as response:
            data = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as error:
        raise RuntimeError(
            f"OpenSky login failed (HTTP {error.code}) - check your credentials")
    _opensky["token"] = data["access_token"]
    _opensky["token_expires"] = time.time() + max(60, data.get("expires_in", 1800) - 60)
    return _opensky["token"]


def fetch_opensky():
    for attempt in range(2):
        token = get_opensky_token()
        headers = {"Accept": "application/json", "User-Agent": "osint-map-local/1.0"}
        if token:
            headers["Authorization"] = f"Bearer {token}"
        request = urllib.request.Request(OPENSKY_API_URL, headers=headers)
        try:
            with urllib.request.urlopen(request, timeout=40) as response:
                body = response.read().decode("utf-8")
        except urllib.error.HTTPError as error:
            if error.code == 401 and token and attempt == 0:
                _opensky["token"] = None   # token expired early: log in again once
                continue
            if error.code == 429:
                wait = int(error.headers.get("x-rate-limit-retry-after-seconds") or 3600)
                _opensky["blocked_until"] = time.time() + wait
                raise OpenSkyLimit("OpenSky daily credits used up", wait)
            raise RuntimeError(f"OpenSky HTTP {error.code}")
        parsed = json.loads(body)
        if not isinstance(parsed.get("states"), list):
            raise RuntimeError("Unexpected OpenSky response")
        _opensky["cache"] = (time.time(), body)
        return _opensky["cache"]
    raise RuntimeError("OpenSky rejected the login token")


def get_opensky():
    with _opensky_lock:
        now = time.time()
        cache = _opensky["cache"]
        if cache and now - cache[0] < OPENSKY_MIN_INTERVAL:
            return cache
        if now < _opensky["blocked_until"]:
            # Out of credits: serve the last snapshot if we have one
            if cache and now - cache[0] < 3600:
                return cache
            raise OpenSkyLimit("OpenSky daily credits used up",
                               int(_opensky["blocked_until"] - now) + 1)
        try:
            return fetch_opensky()
        except OpenSkyLimit:
            if cache and time.time() - cache[0] < 3600:
                return cache
            raise
        except Exception:  # noqa: BLE001
            # Prefer a slightly old snapshot over showing nothing
            if cache and time.time() - cache[0] < 3600:
                return cache
            raise


# ----------------------------------------------
# Aircraft details and routes: adsbdb.com (free, no key)
#
# Aircraft: registration, type, manufacturer and owner from an ICAO hex code
#   or a registration (tail number). Data there comes from PlaneBase.
# Routes:   origin and destination airports for a callsign (e.g. ACA123).
#   The flight route data is the work of David Taylor and Jim Mason and may
#   not be copied, published or incorporated into other databases without
#   their permission, so routes are only held in memory here (never written
#   to disk) and only the callsign you click is ever looked up.
#
# The map asks for ONE aircraft at a time (when you click it), never for
# every plane. adsbdb blocks callers that send 512+ requests in a short
# time, so results are cached, lookups are spaced out, and everything stops
# for 5 minutes if adsbdb pushes back.
# ----------------------------------------------

ADSBDB_API_URL = os.environ.get("ADSBDB_API_URL", "https://api.adsbdb.com/v0/aircraft")
ADSBDB_CALLSIGN_URL = os.environ.get(
    "ADSBDB_CALLSIGN_URL", "https://api.adsbdb.com/v0/callsign")

_aircraft_cache = {}      # key -> (time, json text, ttl seconds)
_aircraft_lock = threading.Lock()
_aircraft_state = {"next": 0.0, "blocked_until": 0.0}


class AircraftLimit(Exception):
    def __init__(self, message, retry_after):
        super().__init__(message)
        self.retry_after = retry_after


def _clean_text(value):
    return value.strip() if isinstance(value, str) else ""


def _clean_number(value):
    return value if isinstance(value, (int, float)) and not isinstance(value, bool) else None


def normalise_aircraft(raw):
    aircraft = ((raw.get("response") or {}) if isinstance(raw, dict) else {})
    aircraft = aircraft.get("aircraft") if isinstance(aircraft, dict) else None
    if not isinstance(aircraft, dict):
        return None
    return {"found": True, "aircraft": {
        "mode_s": _clean_text(aircraft.get("mode_s")),
        "registration": _clean_text(aircraft.get("registration")),
        "icao_type": _clean_text(aircraft.get("icao_type")),
        "type": _clean_text(aircraft.get("type")),
        "manufacturer": _clean_text(aircraft.get("manufacturer")),
        "owner": _clean_text(aircraft.get("registered_owner")),
        "country": _clean_text(aircraft.get("registered_owner_country_name")),
    }}


def _airport(value):
    if not isinstance(value, dict):
        return None
    return {
        "iata": _clean_text(value.get("iata_code")),
        "icao": _clean_text(value.get("icao_code")),
        "name": _clean_text(value.get("name")),
        "city": _clean_text(value.get("municipality")),
        "country": _clean_text(value.get("country_name")),
        "lat": _clean_number(value.get("latitude")),
        "lon": _clean_number(value.get("longitude")),
    }


def normalise_route(raw):
    route = ((raw.get("response") or {}) if isinstance(raw, dict) else {})
    route = route.get("flightroute") if isinstance(route, dict) else None
    if not isinstance(route, dict):
        return None
    origin = _airport(route.get("origin"))
    destination = _airport(route.get("destination"))
    if not origin or not destination:
        return None
    airline = route.get("airline")
    return {"found": True, "route": {
        "callsign": _clean_text(route.get("callsign")),
        "airline": ({"name": _clean_text(airline.get("name")),
                     "icao": _clean_text(airline.get("icao")),
                     "iata": _clean_text(airline.get("iata"))}
                    if isinstance(airline, dict) else None),
        "origin": origin,
        "destination": destination,
        "midpoint": _airport(route.get("midpoint")),
    }}


def adsbdb_lookup(cache_key, base_url, identifier, normalise, ttl_found, ttl_missing):
    """Cached, throttled, rate-limit-aware adsbdb lookup. Returns JSON text."""
    hit = _aircraft_cache.get(cache_key)
    if hit and time.time() - hit[0] < hit[2]:
        return hit[1]

    with _aircraft_lock:
        hit = _aircraft_cache.get(cache_key)     # another thread may have filled it
        if hit and time.time() - hit[0] < hit[2]:
            return hit[1]

        now = time.time()
        if now < _aircraft_state["blocked_until"]:
            raise AircraftLimit("adsbdb asked us to slow down",
                                int(_aircraft_state["blocked_until"] - now) + 1)

        # space lookups at least 0.3 s apart
        wait = max(0.0, _aircraft_state["next"] - now)
        _aircraft_state["next"] = max(now, _aircraft_state["next"]) + 0.3
        time.sleep(wait)

        request = urllib.request.Request(
            f"{base_url}/{urllib.parse.quote(identifier)}",
            headers={"Accept": "application/json", "User-Agent": PHOTO_USER_AGENT},
        )
        try:
            with urllib.request.urlopen(request, timeout=8) as response:
                raw = json.loads(response.read().decode("utf-8"))
            result = normalise(raw)
        except urllib.error.HTTPError as error:
            if error.code == 404:                  # "unknown aircraft" / "unknown callsign"
                result = None
            elif error.code in (403, 429):
                _aircraft_state["blocked_until"] = time.time() + 300
                raise AircraftLimit("adsbdb asked us to slow down", 300)
            else:
                raise RuntimeError(f"adsbdb HTTP {error.code}")

        if result is None:
            result, ttl = {"found": False}, ttl_missing
        else:
            ttl = ttl_found

        if len(_aircraft_cache) > 5000:
            _aircraft_cache.clear()
        text = json.dumps(result)
        _aircraft_cache[cache_key] = (time.time(), text, ttl)
        return text


def get_aircraft_info(identifier):
    return adsbdb_lookup(("aircraft", identifier.lower()), ADSBDB_API_URL, identifier,
                         normalise_aircraft, 86400, 3600)


def get_flight_route(callsign):
    # Routes change (airlines re-time flights), so keep them for hours, not days
    callsign = callsign.upper()          # callsigns are uppercase; also makes the cache key stable
    return adsbdb_lookup(("route", callsign), ADSBDB_CALLSIGN_URL, callsign,
                         normalise_route, 6 * 3600, 3600)


# ----------------------------------------------
# Routes from AirLabs (airlabs.co) - tried before adsbdb
#
# AirLabs has live schedule data and finds the flight by the aircraft's own
# hex code, so it doesn't get fooled by reused callsigns like adsbdb can.
# The free plan only allows about 1,000 requests a month, so:
#   - only the aircraft you click is looked up (never the background lists)
#   - each aircraft is cached for 30 minutes (15 if AirLabs had nothing)
#   - if the key is wrong or the quota is used up, AirLabs is skipped for an hour
#
# Get a free key at https://airlabs.co, then either set the AIRLABS_API_KEY
# environment variable or put it in  api-credentials.json  next to this file:
#     { "airlabsApiKey": "YOUR_KEY" }
# (that file is git-ignored and never served to the browser).
# ----------------------------------------------

AIRLABS_URL = os.environ.get("AIRLABS_URL", "https://airlabs.co/api/v9")


def load_airlabs_key():
    key = os.environ.get("AIRLABS_API_KEY")
    if key:
        return key.strip()
    try:
        with open(os.path.join(ROOT, "api-credentials.json"), encoding="utf-8") as handle:
            data = json.load(handle)
        return _clean_text(data.get("airlabsApiKey"))
    except Exception:  # noqa: BLE001
        return ""      # missing or unreadable: AirLabs stays off


AIRLABS_API_KEY = load_airlabs_key()

_airlabs_lock = threading.Lock()
_airlabs = {"cache": {}, "blocked_until": 0.0}


class AirLabsOff(Exception):
    pass


def airlabs_get(endpoint, params):
    """One AirLabs request. Returns its "response" part, or None."""
    query = urllib.parse.urlencode(dict(params, api_key=AIRLABS_API_KEY))
    request = urllib.request.Request(
        f"{AIRLABS_URL}/{endpoint}?{query}",
        headers={"Accept": "application/json", "User-Agent": "osint-map-local/1.0"})
    try:
        with urllib.request.urlopen(request, timeout=10) as response:
            data = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as error:
        if error.code in (401, 403, 429):
            _airlabs["blocked_until"] = time.time() + 3600
            raise AirLabsOff(f"AirLabs HTTP {error.code} (bad key or quota used up)")
        raise RuntimeError(f"AirLabs HTTP {error.code}")
    if not isinstance(data, dict):
        return None
    problem = data.get("error")
    if problem:
        # e.g. wrong key or monthly limit reached: stop asking for an hour
        message = problem.get("message") if isinstance(problem, dict) else str(problem)
        _airlabs["blocked_until"] = time.time() + 3600
        raise AirLabsOff(f"AirLabs said: {message}")
    return data.get("response")


# Airport codes -> details, from the full airports.csv (all sizes, so small
# regional airports AirLabs reports can still be placed on the map).
_airport_codes = None
_airport_codes_lock = threading.Lock()
_AIRPORT_RANK = {"large_airport": 3, "medium_airport": 2, "small_airport": 1}


def airport_by_code(code):
    global _airport_codes
    code = _clean_text(code).upper()
    if not code:
        return None
    with _airport_codes_lock:
        if _airport_codes is None:
            get_airports()          # makes sure airports.csv has been downloaded
            index = {}
            with open(AIRPORTS_FILE, "r", encoding="utf-8", newline="") as handle:
                for r in csv.DictReader(handle):
                    rank = _AIRPORT_RANK.get(r.get("type"))
                    if not rank:
                        continue
                    try:
                        lat = float(r["latitude_deg"])
                        lon = float(r["longitude_deg"])
                    except (KeyError, TypeError, ValueError):
                        continue
                    icao = (r.get("icao_code") or r.get("gps_code") or r.get("ident") or "").strip().upper()
                    iata = (r.get("iata_code") or "").strip().upper()
                    entry = {"iata": iata, "icao": icao,
                             "name": (r.get("name") or "").strip(),
                             "city": (r.get("municipality") or "").strip(),
                             "country": (r.get("iso_country") or "").strip(),
                             "lat": round(lat, 5), "lon": round(lon, 5), "_rank": rank}
                    for c in (icao, iata):
                        # if two airports share a code, keep the bigger one
                        if c and (c not in index or index[c]["_rank"] < rank):
                            index[c] = entry
            _airport_codes = index
    entry = _airport_codes.get(code)
    return {k: v for k, v in entry.items() if k != "_rank"} if entry else None


def get_airlabs_route(hex_code, callsign):
    """Route dict for this aircraft from AirLabs, or None."""
    key = (hex_code, callsign)
    with _airlabs_lock:
        hit = _airlabs["cache"].get(key)
        if hit and time.time() - hit[0] < hit[2]:
            return hit[1]
        if time.time() < _airlabs["blocked_until"]:
            return None

        # 1. the aircraft itself (live flights, by hex code)
        flight = None
        if hex_code:
            found = airlabs_get("flights", {"hex": hex_code.upper()})
            if isinstance(found, list) and found and isinstance(found[0], dict):
                flight = found[0]

        # 2. otherwise the scheduled flight with this callsign (e.g. DAL1234)
        if not flight and re.fullmatch(r"[A-Z]{3}[0-9]{1,4}[A-Z]{0,2}", callsign):
            found = airlabs_get("flight", {"flight_icao": callsign})
            if isinstance(found, dict) and found:
                flight = found

        route = None
        if flight:
            origin = airport_by_code(flight.get("dep_icao")) or airport_by_code(flight.get("dep_iata"))
            destination = airport_by_code(flight.get("arr_icao")) or airport_by_code(flight.get("arr_iata"))
            if origin and destination and origin["icao"] != destination["icao"]:
                route = {
                    "callsign": callsign,
                    "airline": {"name": _clean_text(flight.get("airline_name")),
                                "icao": _clean_text(flight.get("airline_icao")),
                                "iata": _clean_text(flight.get("airline_iata"))},
                    "origin": origin,
                    "destination": destination,
                    "midpoint": None,
                }

        if len(_airlabs["cache"]) > 2000:
            _airlabs["cache"].clear()
        _airlabs["cache"][key] = (time.time(), route, 1800 if route else 900)
        return route


def get_best_route(callsign, hex_code, precise):
    """AirLabs first (only for the aircraft you clicked), then adsbdb.
    The browser adds a last fallback: the departure airport from the path."""
    callsign = callsign.upper()
    if precise and AIRLABS_API_KEY:
        try:
            route = get_airlabs_route(hex_code, callsign)
            if route:
                return json.dumps({"found": True, "source": "airlabs", "route": route})
        except AirLabsOff as error:
            print(f"{error} - skipping AirLabs for an hour")
        except Exception as error:  # noqa: BLE001
            print(f"AirLabs route failed ({error})")
    data = json.loads(get_flight_route(callsign))
    data["source"] = "adsbdb"
    return json.dumps(data)


# ----------------------------------------------
# Full flight path: OpenSky "tracks" endpoint
#
# Returns the waypoints (time, lat, lon, altitude) of an aircraft's current
# flight, so the path on the map can start at take-off instead of when you
# first looked. OpenSky marks this endpoint EXPERIMENTAL: it can be out of
# order at any time, and the map falls back to the path it has seen itself.
#
# It has its own credit bucket, separate from the world snapshot, and a
# request costs about 4 credits (400/day anonymous, 4000/day with an account).
# This relay caps itself at 90 paths per rolling day anonymous (900 with an
# account), caches each aircraft for 10 minutes, and respects a 429.
# ----------------------------------------------

OPENSKY_TRACK_URL = os.environ.get(
    "OPENSKY_TRACK_URL", "https://opensky-network.org/api/tracks/all")

OPENSKY_TRACK_DAILY = int(
    os.environ.get("OPENSKY_TRACK_LIMIT") or (900 if OPENSKY_CREDENTIALS else 90))

_track_lock = threading.Lock()
_tracks = {"cache": {}, "used": [], "blocked_until": 0.0}


def get_opensky_track(icao24):
    with _track_lock:
        now = time.time()

        hit = _tracks["cache"].get(icao24)
        if hit and now - hit[0] < hit[2]:
            return hit[1]

        if now < _tracks["blocked_until"]:
            raise OpenSkyLimit("OpenSky path credits used up",
                               int(_tracks["blocked_until"] - now) + 1)

        _tracks["used"] = [t for t in _tracks["used"] if now - t < 86400]
        if len(_tracks["used"]) >= OPENSKY_TRACK_DAILY:
            raise OpenSkyLimit("Flight-path allowance for today used up",
                               int(_tracks["used"][0] + 86400 - now) + 1)

        # Count it before asking: a failed request may still have cost credits
        _tracks["used"].append(now)

        query = urllib.parse.urlencode({"icao24": icao24, "time": 0})
        data = None

        for attempt in range(2):
            token = get_opensky_token()
            headers = {"Accept": "application/json", "User-Agent": "osint-map-local/1.0"}
            if token:
                headers["Authorization"] = f"Bearer {token}"
            request = urllib.request.Request(f"{OPENSKY_TRACK_URL}?{query}", headers=headers)
            try:
                with urllib.request.urlopen(request, timeout=30) as response:
                    data = json.loads(response.read().decode("utf-8"))
                break
            except urllib.error.HTTPError as error:
                if error.code == 401 and token and attempt == 0:
                    _opensky["token"] = None
                    continue
                if error.code == 404:                      # no live track for this aircraft
                    text = json.dumps({"found": False})
                    _tracks["cache"][icao24] = (time.time(), text, 120)
                    return text
                if error.code == 429:
                    wait = int(error.headers.get("x-rate-limit-retry-after-seconds") or 3600)
                    _tracks["blocked_until"] = time.time() + wait
                    raise OpenSkyLimit("OpenSky path credits used up", wait)
                raise RuntimeError(f"OpenSky HTTP {error.code}")

        raw_path = data.get("path") if isinstance(data, dict) else None
        if not isinstance(raw_path, list):
            raise RuntimeError("Unexpected OpenSky track response")

        path = [w for w in raw_path
                if isinstance(w, list) and len(w) >= 6
                and _clean_number(w[1]) is not None and _clean_number(w[2]) is not None]
        if len(path) > 2500:                               # keep the page light
            stride = -(-len(path) // 2500)
            path = path[::stride] + ([path[-1]] if (len(path) - 1) % stride else [])

        text = json.dumps({
            "found": len(path) >= 2,
            "mode": "authenticated" if OPENSKY_CREDENTIALS else "anonymous",
            "startTime": data.get("startTime"),
            "endTime": data.get("endTime"),
            "path": path,
        })
        if len(_tracks["cache"]) > 300:
            _tracks["cache"].clear()
        _tracks["cache"][icao24] = (time.time(), text, 600)
        return text


# --------------------------------------------------------------------------
# Airport list (OurAirports, public domain) for the airport pins.
# Uses airports.csv next to this file; downloads it once if it isn't there.
# --------------------------------------------------------------------------

AIRPORTS_URL = os.environ.get(
    "AIRPORTS_URL",
    "https://davidmegginson.github.io/ourairports-data/airports.csv")
AIRPORTS_FILE = os.path.join(ROOT, "airports.csv")

_airports_lock = threading.Lock()
_airports = None            # parsed list once loaded
_airports_retry_at = 0.0


def parse_airports(text):
    """Big and medium airports with scheduled service, as compact rows:
    [icao, iata, name, lat, lon, "L"|"M", country, city]"""
    rows = []
    for r in csv.DictReader(io.StringIO(text)):
        kind = r.get("type")
        if kind not in ("large_airport", "medium_airport"):
            continue
        if kind == "medium_airport" and r.get("scheduled_service") != "yes":
            continue
        try:
            lat = float(r["latitude_deg"])
            lon = float(r["longitude_deg"])
        except (KeyError, TypeError, ValueError):
            continue
        icao = (r.get("gps_code") or r.get("ident") or "").strip().upper()
        if not icao:
            continue
        rows.append([
            icao,
            (r.get("iata_code") or "").strip().upper(),
            (r.get("name") or "").strip(),
            round(lat, 5), round(lon, 5),
            "L" if kind == "large_airport" else "M",
            (r.get("iso_country") or "").strip(),
            (r.get("municipality") or "").strip(),
        ])
    return rows


def get_airports():
    global _airports, _airports_retry_at
    with _airports_lock:
        if _airports is not None:
            return _airports
        if time.time() < _airports_retry_at:
            raise RuntimeError("Airport list unavailable (retrying shortly)")
        try:
            if not os.path.exists(AIRPORTS_FILE):
                request = urllib.request.Request(
                    AIRPORTS_URL, headers={"User-Agent": PHOTO_USER_AGENT})
                with urllib.request.urlopen(request, timeout=30) as response:
                    data = response.read()
                temp = AIRPORTS_FILE + ".tmp"
                with open(temp, "wb") as handle:
                    handle.write(data)
                os.replace(temp, AIRPORTS_FILE)
                print(f"Downloaded airport list to {AIRPORTS_FILE}")
            with open(AIRPORTS_FILE, "r", encoding="utf-8", newline="") as handle:
                rows = parse_airports(handle.read())
            if not rows:
                raise RuntimeError("airports.csv has no usable airports")
            _airports = rows
            print(f"Loaded {len(rows)} airports")
            return rows
        except Exception:
            _airports_retry_at = time.time() + 60
            raise


class Handler(SimpleHTTPRequestHandler):

    def end_headers(self):
        # Your own files change while you work on them, so never let the
        # browser reuse an old copy (Zen/Firefox cache them aggressively).
        self.send_header("Cache-Control", "no-store, max-age=0")
        super().end_headers()

    def send_json(self, status, body):
        data = (body if isinstance(body, str) else json.dumps(body)).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def blocked_static(self):
        """Never serve credential files or dotfiles to the browser."""
        name = os.path.basename(urllib.parse.unquote(
            urllib.parse.urlparse(self.path).path)).lower()
        return "credentials" in name or name.startswith(".")

    def do_HEAD(self):
        if self.blocked_static():
            return self.send_error(404)
        return super().do_HEAD()

    def do_GET(self):
        url = urllib.parse.urlparse(self.path)

        if url.path == "/api/aircraft":
            query = urllib.parse.parse_qs(url.query)
            identifier = (query.get("id") or [""])[0]
            if not re.fullmatch(r"[A-Za-z0-9-]{2,10}", identifier):
                return self.send_json(400, {"error": "Bad parameters"})
            try:
                return self.send_json(200, get_aircraft_info(identifier))
            except AircraftLimit as error:
                return self.send_json(429, {"error": str(error),
                                            "retryAfter": error.retry_after})
            except Exception as error:  # noqa: BLE001
                print(f"adsbdb failed ({error})")
                return self.send_json(502, {"error": str(error), "retryAfter": 0})

        if url.path == "/api/airports":
            try:
                return self.send_json(200, {"airports": get_airports()})
            except Exception as error:  # noqa: BLE001
                print(f"Airport list failed ({error})")
                return self.send_json(502, {"error": str(error), "retryAfter": 60})

        if url.path == "/api/route":
            query = urllib.parse.parse_qs(url.query)
            callsign = (query.get("callsign") or [""])[0]
            hex_code = (query.get("hex") or [""])[0].lower()
            precise = (query.get("precise") or [""])[0] == "1"
            if not re.fullmatch(r"[A-Za-z0-9]{3,8}", callsign):
                return self.send_json(400, {"error": "Bad parameters"})
            if hex_code and not re.fullmatch(r"[0-9a-f]{6}", hex_code):
                return self.send_json(400, {"error": "Bad parameters"})
            try:
                return self.send_json(200, get_best_route(callsign, hex_code, precise))
            except AircraftLimit as error:
                return self.send_json(429, {"error": str(error),
                                            "retryAfter": error.retry_after})
            except Exception as error:  # noqa: BLE001
                print(f"adsbdb route failed ({error})")
                return self.send_json(502, {"error": str(error), "retryAfter": 0})

        if url.path == "/api/track":
            query = urllib.parse.parse_qs(url.query)
            icao24 = (query.get("icao24") or [""])[0].lower()
            if not re.fullmatch(r"[0-9a-f]{6}", icao24):
                return self.send_json(400, {"error": "Bad parameters"})
            try:
                return self.send_json(200, get_opensky_track(icao24))
            except OpenSkyLimit as error:
                return self.send_json(429, {"error": str(error),
                                            "retryAfter": error.retry_after})
            except Exception as error:  # noqa: BLE001
                print(f"OpenSky track failed ({error})")
                return self.send_json(502, {"error": str(error), "retryAfter": 0})

        if url.path == "/api/opensky":
            try:
                fetched_at, body = get_opensky()
                mode = "authenticated" if OPENSKY_CREDENTIALS else "anonymous"
                return self.send_json(
                    200,
                    '{"fetchedAt":%d,"mode":"%s","minInterval":%d,"data":%s}'
                    % (int(fetched_at * 1000), mode, int(OPENSKY_MIN_INTERVAL), body))
            except OpenSkyLimit as error:
                print(f"OpenSky failed ({error})")
                return self.send_json(429, {"error": str(error),
                                            "retryAfter": error.retry_after})
            except Exception as error:  # noqa: BLE001
                print(f"OpenSky failed ({error})")
                return self.send_json(502, {"error": str(error), "retryAfter": 0})

        if self.blocked_static():
            return self.send_error(404)

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
    print("World view: OpenSky account found (snapshot every 90 s)"
          if OPENSKY_CREDENTIALS else
          "World view: OpenSky anonymous (snapshot every 15 min). "
          "Add credentials for 90 s.")
    print("Routes: AirLabs key found (used for the aircraft you click), then adsbdb"
          if AIRLABS_API_KEY else
          "Routes: adsbdb only. Add an AirLabs key to api-credentials.json for better routes.")
    server.serve_forever()
