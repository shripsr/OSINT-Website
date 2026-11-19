#!/usr/bin/env python3
"""
OSINT MAP - LOCAL SERVER (Python version, optional)

Serves this folder AND relays flight-feed requests, which avoids
browser CORS blocking. Needs Python 3.7+. No packages to install.

    python server.py            (or: python3 server.py)
    then open  http://localhost:8080

Flight data: adsb.fi, airplanes.live, adsb.lol (tried in order).
Transit lines and vehicles: Transitous (transitous.org).
Personal, non-commercial use. Credit adsb.fi.
"""

import base64
import csv
import datetime
import gzip
import io
import json
import os
import re
import socket
import ssl
import struct
import tempfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import zipfile
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.dirname(os.path.abspath(__file__))
# Everything the server saves between runs lives in cache/ (git-ignored, never
# served to the browser); downloaded reference data (airports) in data/.
CACHE_DIR = os.path.join(ROOT, "cache")
DATA_DIR = os.path.join(ROOT, "data")
os.makedirs(CACHE_DIR, exist_ok=True)
os.makedirs(DATA_DIR, exist_ok=True)


def load_dotenv(path):
    """Read KEY=VALUE lines from a .env file into os.environ (no packages
    needed). Real environment variables win over the file."""
    try:
        with open(path, encoding="utf-8-sig") as handle:
            lines = handle.read().splitlines()
    except OSError:
        return   # no .env file: fine, everything is optional
    for line in lines:
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        if line.startswith("export "):
            line = line[7:]
        key, value = line.split("=", 1)
        key, value = key.strip(), value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]          # KEY="value" or KEY='value'
        elif " #" in value:
            value = value.split(" #", 1)[0].rstrip()   # KEY=value  # comment
        if key and key not in os.environ:
            os.environ[key] = value


# Keys and settings live in .env next to this file (git-ignored, never served)
load_dotenv(os.path.join(ROOT, ".env"))

PORT = int(os.environ.get("PORT", "8080"))

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


# Find one aircraft anywhere in the world by ICAO hex, callsign or
# registration (search box and watchlist). Same feeds, same 1 request/second.
LOCATE_UPSTREAMS = [
    {"hex": "https://opendata.adsb.fi/api/v2/hex/{}",
     "callsign": "https://opendata.adsb.fi/api/v2/callsign/{}",
     "reg": "https://opendata.adsb.fi/api/v2/registration/{}"},
    {"hex": "https://api.adsb.lol/v2/hex/{}",
     "callsign": "https://api.adsb.lol/v2/callsign/{}",
     "reg": "https://api.adsb.lol/v2/reg/{}"},
]

_locate_cache = {}


def get_located(kind, value):
    """JSON text with an "ac" list: the aircraft if a feed has a position
    for it, an empty list if every feed answered but none is receiving it."""
    key = (kind, value.lower())
    hit = _locate_cache.get(key)
    if hit and time.time() - hit[0] < 10:
        return hit[1]
    if len(_locate_cache) > 200:
        _locate_cache.clear()

    last_error = None
    answered = False
    for upstream in LOCATE_UPSTREAMS:
        try:
            wait_for_slot()
            request = urllib.request.Request(
                upstream[kind].format(urllib.parse.quote(value, safe="")),
                headers={"Accept": "application/json",
                         "User-Agent": "osint-map-local/1.0"},
            )
            with urllib.request.urlopen(request, timeout=10) as response:
                body = response.read().decode("utf-8")
            aircraft = json.loads(body).get("ac") or []
            answered = True
            if any(isinstance(a.get("lat"), (int, float)) for a in aircraft):
                _locate_cache[key] = (time.time(), body)
                return body
        except Exception as error:  # noqa: BLE001
            last_error = error
            print(f"Locate failed ({error})")

    if not answered:
        raise last_error or RuntimeError("No feed available")

    body = json.dumps({"ac": []})
    _locate_cache[key] = (time.time(), body)
    return body


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
# Public transit: line maps and live vehicles (Transitous, transitous.org)
#
# A free community-run service built from the world's open timetables; no
# key. The relay identifies this app to them, asks one thing at a time and
# remembers line maps (they are large and rarely change), so moving around
# an area you have already seen costs them nothing.
# ----------------------------------------------

TRANSIT_API_URL = os.environ.get("TRANSIT_API_URL", "https://api.transitous.org")
TRANSIT_PATHS = {
    "trips": "/api/v6/map/trips",                  # vehicles in service
    "routes": "/api/experimental/map/routes",      # line shapes
    "details": "/api/experimental/map/route-details",  # one whole route
    "stops": "/api/v6/map/stops",                  # stations in an area
    "stoptimes": "/api/v6/stoptimes",              # a station's departures / arrivals
}
TRANSIT_ROUTES_TTL = 6 * 3600
TRANSIT_ROUTES_KEEP = 24

_transit_locks = {kind: threading.Lock() for kind in TRANSIT_PATHS}
_transit_routes_cache = {}


def get_transit(kind, params):
    """Returns (status, body bytes, body is gzip-compressed)."""
    query = urllib.parse.urlencode(params)
    with _transit_locks[kind]:
        remember = kind in ("routes", "details", "stops")
        if remember:
            hit = _transit_routes_cache.get((kind, query))
            if hit and time.time() - hit[0] < TRANSIT_ROUTES_TTL:
                return hit[1]

        # The answers are big (tens of MB of JSON for a city): fetch them
        # compressed and hand them to the browser still compressed.
        request = urllib.request.Request(
            f"{TRANSIT_API_URL}{TRANSIT_PATHS[kind]}?{query}",
            headers={"Accept": "application/json", "Accept-Encoding": "gzip",
                     "User-Agent": PHOTO_USER_AGENT},
        )
        try:
            with urllib.request.urlopen(request, timeout=60) as response:
                result = (200, response.read(),
                          response.headers.get("Content-Encoding", "").lower() == "gzip")
        except urllib.error.HTTPError as error:
            # 422 = "too many routes" in the area; the page reacts to that
            if error.code not in (400, 422):
                raise
            result = (error.code, error.read(),
                      error.headers.get("Content-Encoding", "").lower() == "gzip")

        if remember:
            while len(_transit_routes_cache) >= TRANSIT_ROUTES_KEEP:
                oldest = min(_transit_routes_cache, key=lambda k: _transit_routes_cache[k][0])
                del _transit_routes_cache[oldest]
            _transit_routes_cache[(kind, query)] = (time.time(), result)
        return result


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
# API client on the account page, and put its details in .env:
#     OPENSKY_CLIENT_ID=...
#     OPENSKY_CLIENT_SECRET=...
# ----------------------------------------------

# extended=1 adds each aircraft's category (light / heavy / helicopter / ...),
# which the map uses to pick a plane shape before you click anything.
OPENSKY_API_URL = os.environ.get(
    "OPENSKY_API_URL", "https://opensky-network.org/api/states/all?extended=1")
OPENSKY_TOKEN_URL = os.environ.get(
    "OPENSKY_TOKEN_URL",
    "https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token")


def load_opensky_credentials():
    client_id = os.environ.get("OPENSKY_CLIENT_ID", "").strip()
    secret = os.environ.get("OPENSKY_CLIENT_SECRET", "").strip()
    return (client_id, secret) if client_id and secret else None


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
# Get a free key at https://airlabs.co and put it in .env:
#     AIRLABS_API_KEY=...
# Without it, AirLabs is simply skipped.
# ----------------------------------------------

AIRLABS_URL = os.environ.get("AIRLABS_URL", "https://airlabs.co/api/v9")

AIRLABS_API_KEY = os.environ.get("AIRLABS_API_KEY", "").strip()

_airlabs_lock = threading.Lock()
_airlabs = {"cache": {}, "blocked_until": 0.0}


class AirLabsOff(Exception):
    pass


def airlabs_get(endpoint, params, full=False):
    """One AirLabs request. Returns its "response" part (or, with full=True,
    the whole reply, which also says whether there are more pages)."""
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
    return data if full else data.get("response")


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


# ----------------------------------------------
# Airport timetables from AirLabs ("schedules"): flights due in the next hour
#
# There's no time filter: results start an hour or two ago, roughly in time
# order. The free plan returns only the first 100 rows (big hubs have
# 2,000+, and paging with offset returns nothing), so quiet and mid-size
# airports are covered well ahead, but a busy hub's 100 rows can all be in
# the past. Codeshares (the same plane sold under other airlines' numbers)
# are dropped. One request per airport and direction, cached 15 minutes.
# ----------------------------------------------

SCHEDULE_AHEAD = 3600     # show flights due up to an hour from now...
SCHEDULE_BEHIND = 3 * 3600  # ...and earlier ones (the free plan usually reaches 1-2 h back)
SCHEDULE_TTL = 900

_schedule_lock = threading.Lock()
_schedules = {}           # (airport code, kind) -> (time, json text)


def _hhmm(value):
    """'2026-11-13 14:35' -> '14:35' (AirLabs local airport time)."""
    value = _clean_text(value)
    return value[11:16] if len(value) >= 16 else ""


def get_airport_schedule(code, kind):
    code = code.upper()
    if not AIRLABS_API_KEY:
        return json.dumps({"found": False, "reason": "nokey"})

    cache_key = (code, kind)
    with _schedule_lock:
        hit = _schedules.get(cache_key)
        if hit and time.time() - hit[0] < SCHEDULE_TTL:
            return hit[1]
        if time.time() < _airlabs["blocked_until"]:
            return json.dumps({"found": False, "reason": "limit"})

        airport = airport_by_code(code)
        side = "dep" if kind == "departures" else "arr"
        other = "arr" if side == "dep" else "dep"
        if airport and airport["iata"]:
            params = {f"{side}_iata": airport["iata"]}
        else:
            params = {f"{side}_icao": airport["icao"] if airport else code}

        now = time.time()
        start, end = now - SCHEDULE_BEHIND, now + SCHEDULE_AHEAD
        ts_key = f"{side}_time_ts"

        def fetch(offset):
            """One page -> (rows, has_more, total, early time, late time)."""
            # (offset kept for paid keys; on the free plan any offset returns nothing)
            data = airlabs_get("schedules", dict(params, offset=offset) if offset else params,
                               full=True)
            batch = data.get("response") if isinstance(data, dict) else None
            batch = [r for r in batch if isinstance(r, dict)] if isinstance(batch, list) else []
            info = (data.get("request") or {}) if isinstance(data, dict) else {}
            times = sorted(t for t in (_clean_number(r.get(ts_key)) for r in batch) if t)
            # 10th / 90th percentile, so the odd out-of-order row doesn't mislead
            early = times[len(times) // 10] if times else None
            late = times[(len(times) * 9) // 10] if times else None
            return batch, bool(info.get("has_more")), int(info.get("total_items") or 0), early, late

        # One request. The free plan only ever returns the first 100 rows
        # (offset paging returns nothing), and those start an hour or two in
        # the past. A quiet airport is covered hours ahead; a busy hub may
        # not reach the coming hour at all, which "partial" tells the page.
        raw, more, _total, _early, late = fetch(0)
        partial = bool(more and late and late < end)

        rows, seen = [], set()
        for r in raw:
            if r.get("cs_flight_iata"):          # codeshare copy of another row
                continue
            ident = (r.get("flight_icao") or r.get("flight_iata"), r.get(f"{side}_time_ts"))
            if ident in seen:                    # pages can overlap
                continue
            seen.add(ident)
            scheduled = _clean_number(r.get(f"{side}_time_ts"))
            estimated = _clean_number(r.get(f"{side}_estimated_ts"))
            actual = _clean_number(r.get(f"{side}_actual_ts"))
            best = actual or estimated or scheduled
            if not best or not (now - SCHEDULE_BEHIND <= best <= now + SCHEDULE_AHEAD):
                continue
            other_code = _clean_text(r.get(f"{other}_iata")) or _clean_text(r.get(f"{other}_icao"))
            other_airport = (airport_by_code(r.get(f"{other}_icao"))
                             or airport_by_code(r.get(f"{other}_iata")))
            delay = _clean_number(r.get(f"{side}_delayed"))
            rows.append({
                "flight": _clean_text(r.get("flight_iata")) or _clean_text(r.get("flight_icao")),
                "callsign": _clean_text(r.get("flight_icao")),
                "other": other_code,
                "otherCity": other_airport["city"] if other_airport else "",
                "time": _hhmm(r.get(f"{side}_time")),
                "estTime": _hhmm(r.get(f"{side}_actual") or r.get(f"{side}_estimated")),
                "ts": scheduled,
                "bestTs": best,
                "status": _clean_text(r.get("status")),
                "terminal": _clean_text(r.get(f"{side}_terminal")),
                "gate": _clean_text(r.get(f"{side}_gate")),
                "delay": delay if delay and delay > 0 else None,
                "aircraft": _clean_text(r.get("aircraft_icao")),
            })

        rows.sort(key=lambda row: row["bestTs"])
        text = json.dumps({"found": True, "rows": rows, "partial": partial,
                           "fetchedAt": int(now * 1000)})
        if len(_schedules) > 200:
            _schedules.clear()
        _schedules[cache_key] = (time.time(), text)
        return text


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
# Uses data/airports.csv; downloads it once if it isn't there.
# --------------------------------------------------------------------------

AIRPORTS_URL = os.environ.get(
    "AIRPORTS_URL",
    "https://davidmegginson.github.io/ourairports-data/airports.csv")
AIRPORTS_FILE = os.path.join(DATA_DIR, "airports.csv")

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


# ----------------------------------------------
# Ships worldwide: aisstream.io (free, needs a key)
#
# aisstream sends live AIS messages over a WebSocket, and does not accept
# connections from a web page, so this relay holds the connection. It listens
# to the whole world, remembers each ship's latest position (for half an hour)
# and details (for half a day), and hands the page the ships inside the area
# it asks for.
#
# Ships under way report every few seconds, but moored ones only every three
# minutes and names / types every six, so a fresh start takes minutes to fill
# in. To have the map full the moment the ship layer is switched on:
#   - the stream runs for as long as this server does, not just while a page
#     is looking
#   - everything known is saved to .ships_cache.json every two minutes and
#     when the server stops, and read back when it starts
#
# Get a free key at https://aisstream.io and put it in .env:
#     AISSTREAM_API_KEY=...
# Without it the page shows Digitraffic's ships (Finland / Baltic) instead.
# ----------------------------------------------

AISSTREAM_URL = os.environ.get("AISSTREAM_URL", "wss://stream.aisstream.io/v0/stream")
AISSTREAM_API_KEY = os.environ.get("AISSTREAM_API_KEY", "").strip()

SHIP_MAX_AGE = 1800         # a position older than this is not shown (seconds)
SHIP_KEEP = 12 * 3600       # forget a ship (its name, type, ...) not heard from for this long
SHIP_SAVE_EVERY = 120
SHIP_CACHE_FILE = os.path.join(CACHE_DIR, ".ships_cache.json")   # dotfile: never served, git-ignored
SHIP_REPLY_LIMIT = 6000     # most ships sent to the page at once

SHIP_POSITION_KINDS = ("PositionReport", "StandardClassBPositionReport",
                       "ExtendedClassBPositionReport")
SHIP_MESSAGE_KINDS = SHIP_POSITION_KINDS + ("ShipStaticData", "StaticDataReport")

_ships_lock = threading.Lock()
_ships = {}                 # MMSI -> what we know about that ship
_ship_trails = {}           # MMSI -> where it has been: [[lon, lat, time in ms], ...]

SHIP_TRAIL_POINTS = 180     # most points kept per ship (the oldest are dropped)
SHIP_TRAIL_EVERY = 60       # seconds between two points
SHIP_TRAIL_MOVED = 0.0005   # degrees (about 50 m): closer than this is "has not moved"
SHIP_TRAIL_MAX_KNOTS = 70   # a jump faster than this is a bad position, not a voyage


def note_ship_trail(mmsi, ship):
    """Add the ship's new position to its trail (call with _ships_lock held).
    Only ships that actually move get one, so this stays small."""
    point = [ship["lon"], ship["lat"], ship["t"]]
    trail = _ship_trails.get(mmsi)
    if not trail:
        _ship_trails[mmsi] = [point]
        return
    last = trail[-1]
    seconds = (point[2] - last[2]) / 1000
    if seconds < SHIP_TRAIL_EVERY:
        return
    d_lat = abs(point[1] - last[1])
    d_lon = abs(point[0] - last[0])
    d_lon = min(d_lon, 360 - d_lon)
    if d_lat < SHIP_TRAIL_MOVED and d_lon < SHIP_TRAIL_MOVED:
        return
    # (rough: a degree is at most 60 nautical miles)
    if max(d_lat, d_lon * 0.3) * 60 / (seconds / 3600) > SHIP_TRAIL_MAX_KNOTS:
        return
    trail.append(point)
    if len(trail) > SHIP_TRAIL_POINTS:
        del trail[0]


def _ship_eta(value):
    """aisstream's {"Month": 11, "Day": 17, "Hour": 20, "Minute": 30} -> "11-17T20:30"."""
    if not isinstance(value, dict):
        return ""
    month, day, hour, minute = (_clean_number(value.get(k)) or 0
                                for k in ("Month", "Day", "Hour", "Minute"))
    if not (1 <= month <= 12 and 1 <= day <= 31):
        return ""                                    # 0 means "not set"
    return "%02d-%02dT%02d:%02d" % (month, day, hour, minute)
_ship_stream = {"thread": None, "listening_since": 0.0, "heard_at": 0.0,
                "error": "", "blocked_until": 0.0}


class WebSocketClient:
    """Just enough of the WebSocket protocol (RFC 6455) to read a feed."""

    def __init__(self, url, timeout):
        parts = urllib.parse.urlparse(url)
        secure = parts.scheme == "wss"
        host = parts.hostname
        port = parts.port or (443 if secure else 80)
        self.sock = socket.create_connection((host, port), timeout=timeout)
        try:
            if secure:
                self.sock = ssl.create_default_context().wrap_socket(
                    self.sock, server_hostname=host)
            self.reader = self.sock.makefile("rb")
            key = base64.b64encode(os.urandom(16)).decode("ascii")
            self.sock.sendall((
                f"GET {parts.path or '/'} HTTP/1.1\r\n"
                f"Host: {host}\r\n"
                "Upgrade: websocket\r\n"
                "Connection: Upgrade\r\n"
                f"Sec-WebSocket-Key: {key}\r\n"
                "Sec-WebSocket-Version: 13\r\n"
                "User-Agent: osint-map-local/1.0\r\n\r\n").encode("ascii"))
            status = self.reader.readline().decode("latin-1").strip()
            if " 101" not in status:
                raise ConnectionError(f"WebSocket refused: {status or 'no answer'}")
            while self.reader.readline() not in (b"\r\n", b"\n", b""):
                pass                                 # the rest of the headers
        except Exception:
            self.close()
            raise

    def _read(self, count):
        data = self.reader.read(count)
        if len(data) < count:
            raise ConnectionError("WebSocket closed")
        return data

    def send(self, payload, opcode=0x1):
        """One frame. Clients must mask what they send."""
        if isinstance(payload, str):
            payload = payload.encode("utf-8")
        size = len(payload)
        if size < 126:
            header = struct.pack("!BB", 0x80 | opcode, 0x80 | size)
        elif size < 65536:
            header = struct.pack("!BBH", 0x80 | opcode, 0x80 | 126, size)
        else:
            header = struct.pack("!BBQ", 0x80 | opcode, 0x80 | 127, size)
        mask = os.urandom(4)
        masked = bytes(b ^ mask[i % 4] for i, b in enumerate(payload))
        self.sock.sendall(header + mask + masked)

    def receive(self):
        """The next whole message, as bytes."""
        parts = []
        while True:
            first, second = self._read(2)
            opcode = first & 0x0F
            size = second & 0x7F
            if size == 126:
                size = struct.unpack("!H", self._read(2))[0]
            elif size == 127:
                size = struct.unpack("!Q", self._read(8))[0]
            if size > 4 * 1024 * 1024:
                raise ConnectionError("WebSocket message too large")
            mask = self._read(4) if second & 0x80 else None
            data = self._read(size)
            if mask:
                data = bytes(b ^ mask[i % 4] for i, b in enumerate(data))
            if opcode == 0x8:
                raise ConnectionError("WebSocket closed by the other side")
            if opcode == 0x9:                        # ping: answer it
                self.send(data, 0xA)
                continue
            if opcode == 0xA:                        # pong
                continue
            parts.append(data)
            if first & 0x80:                         # last piece of the message
                return b"".join(parts)

    def close(self):
        try:
            self.sock.close()
        except OSError:
            pass


def read_ship_message(message, now):
    """Fold one aisstream message into _ships (call with _ships_lock held)."""
    kind = message.get("MessageType")
    meta = message.get("MetaData")
    body = message.get("Message")
    body = body.get(kind) if isinstance(body, dict) else None
    if not isinstance(meta, dict) or not isinstance(body, dict):
        return
    mmsi = meta.get("MMSI")
    if not isinstance(mmsi, int) or isinstance(mmsi, bool):
        return

    ship = _ships.get(mmsi)
    if ship is None:
        ship = _ships[mmsi] = dict(SHIP_BLANK)
    ship["seen"] = now

    name = _clean_text(meta.get("ShipName"))
    if name:
        ship["name"] = name

    def size(dimension, fore, aft):
        if not isinstance(dimension, dict):
            return 0
        return (_clean_number(dimension.get(fore)) or 0) + (_clean_number(dimension.get(aft)) or 0)

    if kind in SHIP_POSITION_KINDS:
        lat = _clean_number(body.get("Latitude"))
        lon = _clean_number(body.get("Longitude"))
        if lat is None or lon is None:
            lat = _clean_number(meta.get("latitude"))
            lon = _clean_number(meta.get("longitude"))
        # (91 / 181 mean "no position")
        if lat is None or lon is None or abs(lat) > 90 or abs(lon) > 180:
            return
        ship.update(lat=round(lat, 5), lon=round(lon, 5), t=int(now * 1000), credit="",
                    sog=_clean_number(body.get("Sog")),
                    cog=_clean_number(body.get("Cog")),
                    heading=_clean_number(body.get("TrueHeading")))
        if "NavigationalStatus" in body:
            ship["nav"] = _clean_number(body.get("NavigationalStatus"))
        note_ship_trail(mmsi, ship)

    elif kind == "ShipStaticData":
        ship.update(type=_clean_number(body.get("Type")) or 0,
                    callSign=_clean_text(body.get("CallSign")),
                    imo=_clean_number(body.get("ImoNumber")) or 0,
                    destination=_clean_text(body.get("Destination")),
                    draught=_clean_number(body.get("MaximumStaticDraught")) or 0,
                    length=size(body.get("Dimension"), "A", "B"),
                    beam=size(body.get("Dimension"), "C", "D"))

        ship["eta"] = _ship_eta(body.get("Eta"))

    elif kind == "StaticDataReport":                 # small craft: sent in two halves
        part_a = body.get("ReportA")
        part_b = body.get("ReportB")
        if isinstance(part_a, dict) and part_a.get("Valid") and _clean_text(part_a.get("Name")):
            ship["name"] = _clean_text(part_a.get("Name"))
        if isinstance(part_b, dict) and part_b.get("Valid"):
            ship.update(type=_clean_number(part_b.get("ShipType")) or 0,
                        callSign=_clean_text(part_b.get("CallSign")),
                        length=size(part_b.get("Dimension"), "A", "B"),
                        beam=size(part_b.get("Dimension"), "C", "D"))


SHIP_BLANK = {"lat": None, "lon": None, "t": 0, "sog": None, "cog": None,
              "heading": None, "nav": None, "name": "", "type": 0, "callSign": "",
              "imo": 0, "destination": "", "draught": 0, "length": 0, "beam": 0,
              "credit": "",      # who must be credited for the position ("" = aisstream)
              "eta": "",         # when the crew expects to arrive: "MM-DDTHH:MM" (UTC)
              "seen": 0}


def save_ships():
    """Write everything known to disk, so a restart does not start from nothing."""
    with _ships_lock:
        if not _ships:
            return
        snapshot = {"savedAt": time.time(),
                    "listeningSince": _ship_stream["listening_since"],
                    "ships": dict(_ships)}
    try:
        temp = SHIP_CACHE_FILE + ".tmp"
        with open(temp, "w", encoding="utf-8") as handle:
            json.dump(snapshot, handle, separators=(",", ":"))
        os.replace(temp, SHIP_CACHE_FILE)
    except Exception as error:  # noqa: BLE001
        print(f"Ship cache could not be saved ({error})")


def load_ships():
    try:
        with open(SHIP_CACHE_FILE, encoding="utf-8") as handle:
            saved = json.load(handle)
        now = time.time()
        with _ships_lock:
            for mmsi, ship in saved["ships"].items():
                if isinstance(ship, dict) and now - (_clean_number(ship.get("seen")) or 0) < SHIP_KEEP:
                    _ships[int(mmsi)] = dict(
                        SHIP_BLANK, **{k: v for k, v in ship.items() if k in SHIP_BLANK})
            # Only a short gap since it was saved: the picture is still whole
            if now - saved["savedAt"] < 600:
                _ship_stream["listening_since"] = _clean_number(saved.get("listeningSince")) or 0.0
            fresh = sum(1 for s in _ships.values()
                        if s["lat"] is not None and now - s["t"] / 1000 < SHIP_MAX_AGE)
        print(f"Ships: {len(_ships)} remembered from last time, {fresh} with a recent position")
    except FileNotFoundError:
        pass
    except Exception as error:  # noqa: BLE001
        print(f"Ship cache could not be read ({error}), starting empty")


def start_ship_stream():
    """Start listening, unless that is already happening (or pointless)."""
    if not AISSTREAM_API_KEY:
        return
    with _ships_lock:
        if _ship_stream["thread"] is None and time.time() >= _ship_stream["blocked_until"]:
            _ship_stream["thread"] = threading.Thread(target=run_ship_stream, daemon=True)
            _ship_stream["thread"].start()


def run_ship_stream():
    """Background thread: stay connected for as long as the server runs."""
    failures = 0
    saved = time.time()
    while True:
        with _ships_lock:
            if time.time() < _ship_stream["blocked_until"]:
                _ship_stream["thread"] = None        # key refused: get_ships retries later
                return

        client = None
        heard = False
        try:
            client = WebSocketClient(AISSTREAM_URL, timeout=30)
            # (aisstream hangs up unless this arrives within 3 seconds)
            client.send(json.dumps({
                "APIKey": AISSTREAM_API_KEY,
                "BoundingBoxes": [[[-90, -180], [90, 180]]],
                "FilterMessageTypes": list(SHIP_MESSAGE_KINDS),
            }))
            print("Ship stream connected (aisstream.io)")
            pruned = time.time()

            while True:
                message = json.loads(client.receive())
                now = time.time()
                heard = True

                if not isinstance(message, dict):
                    continue
                if "error" in message:               # e.g. "Api Key Is Not Valid"
                    raise PermissionError(str(message["error"]))

                with _ships_lock:
                    if not _ship_stream["listening_since"]:
                        _ship_stream["listening_since"] = now
                    _ship_stream["error"] = ""
                    _ship_stream["heard_at"] = now
                    read_ship_message(message, now)
                    if now - pruned > 60:
                        pruned = now
                        for mmsi in [m for m, s in _ships.items()
                                     if now - s["seen"] > SHIP_KEEP]:
                            del _ships[mmsi]
                            _ship_trails.pop(mmsi, None)
                failures = 0

                if now - saved > SHIP_SAVE_EVERY:
                    saved = now
                    save_ships()

        except PermissionError as error:
            # A wrong key will not fix itself: stop asking for ten minutes
            print(f"aisstream refused the key ({error})")
            with _ships_lock:
                _ship_stream["error"] = str(error)
                _ship_stream["blocked_until"] = time.time() + 600
        except Exception as error:  # noqa: BLE001
            failures += 1
            # aisstream answers a wrong key by hanging up without a word
            refused = isinstance(error, ConnectionError) and not heard and failures >= 3
            with _ships_lock:
                _ship_stream["error"] = str(error)
                if refused:
                    _ship_stream["error"] = "aisstream.io hangs up straight away (wrong API key?)"
                    _ship_stream["blocked_until"] = time.time() + 600
            if refused:
                print("aisstream.io hangs up straight away: check AISSTREAM_API_KEY in .env. "
                      "Trying again in 10 minutes; ships come from Digitraffic until then.")
            else:
                print(f"Ship stream failed ({error}), reconnecting")
                time.sleep(min(60, 3 * failures))
        finally:
            if client:
                client.close()


# ----------------------------------------------
# More ships for the area on screen: Pelyr (pelyr.com, free key)
#
# Pelyr's HTTPS API answers "which ships are in this box?" at once, names and
# types included, so the area you are looking at fills in immediately instead
# of waiting for each ship's next report on the aisstream feed. It also hears
# ships aisstream does not (and the other way round); the two are merged, the
# newer position of a ship winning.
#
# The free plan allows 2 requests a minute and 1,000 ships per answer, so the
# relay asks only for the area a page is showing: when it changes, and once a
# minute while it stays the same. Nothing is asked while no page has the ship
# layer on.
#
# Licence (Pelyr Data Licence 2.0): free keys are for NON-COMMERCIAL use, the
# data may be shown on your own map but not passed on to others, and wherever
# it is shown it must be credited ("AIS data from Pelyr (pelyr.com), Pelyr
# Data Licence 2.0"). The page shows that credit; keep it there.
#
# Get a free key at https://dashboard.pelyr.com/stream and put it in .env:
#     PELYR_API_KEY=...
# ----------------------------------------------

PELYR_API_URL = os.environ.get("PELYR_API_URL", "https://api.pelyr.com")
PELYR_API_KEY = os.environ.get("PELYR_API_KEY", "").strip()

PELYR_MIN_INTERVAL = 31     # seconds between requests (the free plan allows 2 a minute)
PELYR_SAME_BOX = 60         # ask again for an unchanged area this often
PELYR_MAX = 1000            # ships per answer on the free plan
PELYR_CREDIT = "AIS data from Pelyr (pelyr.com), Pelyr Data Licence 2.0"

_pelyr = {"busy": False, "next": 0.0, "blocked_until": 0.0,
          "box": None, "box_at": 0.0, "credits": None, "error": "", "ok_at": 0.0}


def pelyr_get(path, params=None):
    query = "?" + urllib.parse.urlencode(params) if params else ""
    request = urllib.request.Request(
        f"{PELYR_API_URL}{path}{query}",
        # (the key goes in this header: Pelyr refuses keys in the address)
        headers={"Accept": "application/json", "User-Agent": "osint-map-local/1.0",
                 "Authorization": f"Bearer {PELYR_API_KEY}"})
    with urllib.request.urlopen(request, timeout=20) as response:
        return json.loads(response.read().decode("utf-8"))


def _pelyr_time(value):
    """'2026-11-16T03:28:13.445Z' -> seconds since 1970 (None if unreadable)."""
    try:
        text = _clean_text(value).replace("Z", "+00:00")
        return datetime.datetime.fromisoformat(text).timestamp() if text else None
    except ValueError:
        return None


def read_pelyr_vessels(vessels, now):
    """Fold Pelyr's answer into _ships. Returns how many positions were news."""
    credits = _pelyr["credits"] or {}
    added = 0
    with _ships_lock:
        for vessel in vessels if isinstance(vessels, list) else []:
            if not isinstance(vessel, dict):
                continue
            mmsi = vessel.get("mmsi")
            position = vessel.get("position")
            static = vessel.get("static")
            if not isinstance(mmsi, int) or isinstance(mmsi, bool) or not isinstance(position, dict):
                continue
            # Pelyr marks reports that cannot be right (teleporting ships, bad numbers)
            if position.get("plausibility") == "low":
                continue
            lat = _clean_number(position.get("lat"))
            lon = _clean_number(position.get("lon"))
            when = _pelyr_time(position.get("ts"))
            if lat is None or lon is None or when is None or abs(lat) > 90 or abs(lon) > 180:
                continue
            when = min(when, now)

            ship = _ships.get(mmsi)
            if ship is None:
                ship = _ships[mmsi] = dict(SHIP_BLANK)
            ship["seen"] = max(ship["seen"], when)

            if when * 1000 > ship["t"]:
                ship.update(lat=round(lat, 5), lon=round(lon, 5), t=int(when * 1000),
                            sog=_clean_number(position.get("sog")),
                            cog=_clean_number(position.get("cog")),
                            heading=_clean_number(position.get("heading")),
                            nav=_clean_number(position.get("nav_status")),
                            credit=credits.get(str(position.get("license"))) or PELYR_CREDIT)
                note_ship_trail(mmsi, ship)
                added += 1

            if isinstance(static, dict):
                # (only what Pelyr knows: never wipe a name aisstream gave us)
                for ours, theirs, clean in (
                        ("name", "name", _clean_text), ("callSign", "callsign", _clean_text),
                        ("destination", "dest", _clean_text), ("type", "type", _clean_number),
                        ("eta", "eta", _clean_text),
                        ("imo", "imo", _clean_number), ("draught", "draught", _clean_number),
                        ("length", "length", _clean_number), ("beam", "beam", _clean_number)):
                    value = clean(static.get(theirs))
                    if value:
                        ship[ours] = value
    return added


def run_pelyr(box):
    """Background thread: one request for one area."""
    south, west, north, east = box
    try:
        # Once: the wording each of Pelyr's sources wants to be credited with
        if _pelyr["credits"] is None:
            try:
                listed = pelyr_get("/v1/sources").get("sources")
                _pelyr["credits"] = {
                    str(item.get("id")): _clean_text(item.get("attribution"))
                    for item in (listed if isinstance(listed, list) else [])
                    if isinstance(item, dict)}
            except urllib.error.HTTPError as error:
                if error.code in (401, 403):
                    raise
                _pelyr["credits"] = {}              # the standard wording will do
        data = pelyr_get("/v1/vessels", {
            "bbox": f"{west:.4f},{south:.4f},{east:.4f},{north:.4f}", "max": PELYR_MAX})
        added = read_pelyr_vessels(data.get("vessels") if isinstance(data, dict) else None,
                                   time.time())
        _pelyr["error"] = ""
        _pelyr["ok_at"] = time.time()
        print(f"Pelyr: {data.get('count', 0)} ships in view"
              f"{' (more than the plan returns: zoom in)' if data.get('truncated') else ''}, "
              f"{added} newer than what we had")
    except urllib.error.HTTPError as error:
        if error.code in (401, 403):
            # A wrong key will not fix itself: stop asking for ten minutes
            _pelyr["error"] = "Pelyr refused the API key"
            _pelyr["blocked_until"] = time.time() + 600
            print(f"Pelyr refused the key (HTTP {error.code}): check PELYR_API_KEY in .env")
        elif error.code == 429:
            wait = int(error.headers.get("Retry-After") or 60)
            _pelyr["next"] = time.time() + wait
            print(f"Pelyr asked us to slow down for {wait} s")
        else:
            _pelyr["error"] = f"Pelyr HTTP {error.code}"
            print(f"Pelyr failed (HTTP {error.code})")
    except Exception as error:  # noqa: BLE001
        _pelyr["error"] = str(error)
        print(f"Pelyr failed ({error})")
    finally:
        _pelyr["busy"] = False


def request_pelyr(south, west, north, east):
    """Ask Pelyr for this area in the background, if it is time to.
    (Call with _ships_lock held: it keeps two pages from asking at once.)"""
    if not PELYR_API_KEY:
        return
    now = time.time()
    if _pelyr["busy"] or now < _pelyr["next"] or now < _pelyr["blocked_until"]:
        return

    # Pelyr's map stops at 85.05 degrees, and its boxes cannot cross the date
    # line: of a box that does, take the wider side
    south, north = max(south, -85.05), min(north, 85.05)
    if west > east:
        west, east = (west, 180.0) if 180 - west >= east + 180 else (-180.0, east)
    if not (west < east and south < north):
        return

    box = (round(south, 1), round(west, 1), round(north, 1), round(east, 1))
    if box == _pelyr["box"] and now - _pelyr["box_at"] < PELYR_SAME_BOX:
        return

    _pelyr.update(busy=True, next=now + PELYR_MIN_INTERVAL, box=box, box_at=now)
    threading.Thread(target=run_pelyr, args=((south, west, north, east),), daemon=True).start()


# ----------------------------------------------
# Backup when both of the above are down: VesselAPI (vesselapi.com)
#
# Its free plan is tiny: 150 requests a MONTH, 50 ships per request, and an
# area of at most 4 degrees (height + width). So it is never used while
# aisstream or Pelyr is delivering. Only when neither has for a few minutes
# does the relay ask VesselAPI for the middle of the area on screen, at most
# once every five minutes, and it stops for the month at 140 requests. The
# count is kept in .vesselapi_usage.json so restarts do not reset it.
#
# Get a free key at https://dashboard.vesselapi.com and put it in .env:
#     VESSELAPI_KEY=...
# ----------------------------------------------

VESSELAPI_URL = os.environ.get("VESSELAPI_URL", "https://api.vesselapi.com/v1")
VESSELAPI_KEY = os.environ.get("VESSELAPI_KEY", "").strip()

VESSELAPI_MONTHLY_LIMIT = int(os.environ.get("VESSELAPI_MONTHLY_LIMIT") or 140)
VESSELAPI_MIN_INTERVAL = 300    # seconds between requests
VESSELAPI_MAX_SPAN = 3.9        # degrees of height + width it accepts (4), with a margin
VESSELAPI_AFTER = 180           # the others must have been silent this long
VESSELAPI_USAGE_FILE = os.path.join(CACHE_DIR, ".vesselapi_usage.json")

_vesselapi = {"busy": False, "next": 0.0, "blocked_until": 0.0, "error": "",
              "ok_at": 0.0, "month": "", "used": 0, "loaded": False}
_server_started = time.time()


def vesselapi_budget_left():
    """Requests left this month (reads / rolls over the counter on disk)."""
    month = time.strftime("%Y-%m", time.gmtime())
    if not _vesselapi["loaded"]:
        _vesselapi["loaded"] = True
        try:
            with open(VESSELAPI_USAGE_FILE, encoding="utf-8") as handle:
                saved = json.load(handle)
            _vesselapi.update(month=str(saved.get("month")), used=int(saved.get("used") or 0))
        except (OSError, ValueError, AttributeError):
            pass                                     # no file yet: nothing used
    if _vesselapi["month"] != month:
        _vesselapi.update(month=month, used=0)
    return VESSELAPI_MONTHLY_LIMIT - _vesselapi["used"]


def run_vesselapi(box):
    """Background thread: one request for one small area."""
    south, west, north, east = box
    try:
        stamp = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(time.time() - SHIP_MAX_AGE))
        query = urllib.parse.urlencode({
            "filter.latBottom": f"{south:.4f}", "filter.latTop": f"{north:.4f}",
            "filter.lonLeft": f"{west:.4f}", "filter.lonRight": f"{east:.4f}",
            "time.from": stamp, "pagination.limit": 50})
        request = urllib.request.Request(
            f"{VESSELAPI_URL}/location/vessels/bounding-box?{query}",
            headers={"Accept": "application/json", "User-Agent": "osint-map-local/1.0",
                     "Authorization": f"Bearer {VESSELAPI_KEY}"})
        with urllib.request.urlopen(request, timeout=20) as response:
            data = json.loads(response.read().decode("utf-8"))

        vessels = data.get("vessels") if isinstance(data, dict) else None
        now = time.time()
        added = 0
        with _ships_lock:
            for vessel in vessels if isinstance(vessels, list) else []:
                if not isinstance(vessel, dict) or vessel.get("suspected_glitch"):
                    continue
                mmsi = vessel.get("mmsi")
                lat = _clean_number(vessel.get("latitude"))
                lon = _clean_number(vessel.get("longitude"))
                when = _pelyr_time(vessel.get("timestamp"))
                if (not isinstance(mmsi, int) or isinstance(mmsi, bool) or lat is None
                        or lon is None or when is None or abs(lat) > 90 or abs(lon) > 180):
                    continue
                when = min(when, now)
                ship = _ships.get(mmsi)
                if ship is None:
                    ship = _ships[mmsi] = dict(SHIP_BLANK)
                ship["seen"] = max(ship["seen"], when)
                if when * 1000 > ship["t"]:
                    ship.update(lat=round(lat, 5), lon=round(lon, 5), t=int(when * 1000),
                                sog=_clean_number(vessel.get("sog")),
                                cog=_clean_number(vessel.get("cog")),
                                heading=_clean_number(vessel.get("heading")),
                                nav=_clean_number(vessel.get("nav_status")),
                                credit="Position from VesselAPI (vesselapi.com)")
                    note_ship_trail(mmsi, ship)
                    added += 1
                if _clean_text(vessel.get("vessel_name")):
                    ship["name"] = _clean_text(vessel.get("vessel_name"))
                if _clean_number(vessel.get("imo")):
                    ship["imo"] = _clean_number(vessel.get("imo"))
        _vesselapi.update(error="", ok_at=now)
        print(f"VesselAPI (backup): {added} ships, "
              f"{VESSELAPI_MONTHLY_LIMIT - _vesselapi['used']} requests left this month")
    except urllib.error.HTTPError as error:
        if error.code in (401, 403):
            _vesselapi.update(error="VesselAPI refused the API key (or its quota is used up)",
                              blocked_until=time.time() + 3600)
            print(f"VesselAPI refused the request (HTTP {error.code}): "
                  "check VESSELAPI_KEY in .env, or the month's quota is used up")
        elif error.code == 429:
            _vesselapi["blocked_until"] = time.time() + 3600
            print("VesselAPI asked us to slow down: pausing it for an hour")
        else:
            _vesselapi["error"] = f"VesselAPI HTTP {error.code}"
            print(f"VesselAPI failed (HTTP {error.code})")
    except Exception as error:  # noqa: BLE001
        _vesselapi["error"] = str(error)
        print(f"VesselAPI failed ({error})")
    finally:
        _vesselapi["busy"] = False


def request_vesselapi(south, west, north, east):
    """Ask the backup about the middle of this area, if it is allowed to.
    (Call with _ships_lock held, and only when the main sources are down.)"""
    now = time.time()
    if (not VESSELAPI_KEY or _vesselapi["busy"] or now < _vesselapi["next"]
            or now < _vesselapi["blocked_until"]):
        return
    if vesselapi_budget_left() <= 0:
        if not _vesselapi["error"]:
            _vesselapi["error"] = "VesselAPI: this month's free requests are used up"
            print(_vesselapi["error"])
        return

    # The biggest box it accepts, around the middle of the view
    if west > east:                                  # view across the date line
        east += 360
    half_height = min((north - south) / 2, VESSELAPI_MAX_SPAN / 4)
    half_width = min((east - west) / 2, VESSELAPI_MAX_SPAN / 2 - half_height)
    lat = min(max((south + north) / 2, -89 + half_height), 89 - half_height)
    lon = (west + east) / 2
    if lon > 180:
        lon -= 360
    lon = min(max(lon, -180 + half_width), 180 - half_width)
    if half_height <= 0 or half_width <= 0:
        return

    # Count it before asking: a failed request may still have used one up
    _vesselapi.update(busy=True, next=now + VESSELAPI_MIN_INTERVAL,
                      used=_vesselapi["used"] + 1)
    try:
        with open(VESSELAPI_USAGE_FILE, "w", encoding="utf-8") as handle:
            json.dump({"month": _vesselapi["month"], "used": _vesselapi["used"]}, handle)
    except OSError as error:
        print(f"VesselAPI usage could not be saved ({error})")
    threading.Thread(
        target=run_vesselapi, daemon=True,
        args=((lat - half_height, lon - half_width, lat + half_height, lon + half_width),)).start()


def get_ships(south, west, north, east):
    """The ships inside the box, as compact rows (see ShipRelayRow in ships.ts)."""
    if not AISSTREAM_API_KEY and not PELYR_API_KEY and not VESSELAPI_KEY:
        return {"available": False, "reason": "nokey"}

    now = time.time()
    with _ships_lock:
        stream_ok = AISSTREAM_API_KEY and now >= _ship_stream["blocked_until"]
        pelyr_ok = PELYR_API_KEY and now >= _pelyr["blocked_until"]
        backup_ok = VESSELAPI_KEY and now >= _vesselapi["blocked_until"]
        if not stream_ok and not pelyr_ok and not backup_ok:
            return {"available": False, "reason": "key",
                    "error": _ship_stream["error"] or _pelyr["error"] or _vesselapi["error"]}
        request_pelyr(south, west, north, east)

        # The backup: only once neither main source has delivered for a while
        # (or since the server started, if they never have)
        # (Pelyr is only asked while a page is looking, so an old answer
        # means nothing unless its last request failed)
        delivered = max(_ship_stream["heard_at"], _server_started,
                        now if pelyr_ok and not _pelyr["error"] else _pelyr["ok_at"])
        backup_on = bool(backup_ok and now - delivered > VESSELAPI_AFTER)
        if backup_ok and not AISSTREAM_API_KEY and not PELYR_API_KEY:
            backup_on = True                         # it is the only source there is
        if backup_on:
            request_vesselapi(south, west, north, east)

    start_ship_stream()      # (normally running since the server started)

    with _ships_lock:

        def inside(ship):
            if ship["lat"] is None or now - ship["t"] / 1000 > SHIP_MAX_AGE:
                return False
            if not south <= ship["lat"] <= north:
                return False
            if west <= east:
                return west <= ship["lon"] <= east
            return ship["lon"] >= west or ship["lon"] <= east    # box across the date line

        found = [(mmsi, ship) for mmsi, ship in _ships.items() if inside(ship)]
        total = len(found)
        if total > SHIP_REPLY_LIMIT:
            # Too many for the page (a view of half the world): ships under way first
            found.sort(key=lambda item: not 0.5 <= (item[1]["sog"] or 0) < 102)
            found = found[:SHIP_REPLY_LIMIT]

        rows = [[mmsi, s["lat"], s["lon"], s["t"], s["sog"], s["cog"], s["heading"],
                 s["nav"], s["name"], s["type"], s["callSign"], s["imo"],
                 s["destination"], s["draught"], s["length"], s["beam"], s["credit"],
                 s["eta"]]
                for mmsi, s in found]
        since = _ship_stream["listening_since"]
        return {"available": True, "ships": rows,
                "sources": [name for name, on in (("aisstream.io", stream_ok),
                                                  ("Pelyr", pelyr_ok),
                                                  ("VesselAPI backup", backup_on)) if on],
                "inArea": total, "tracked": len(_ships),
                # (with Pelyr the area on screen is whole at once: no warming up)
                "listeningFor": 99999 if pelyr_ok else int(now - since) if since else 0,
                "error": _ship_stream["error"] or _pelyr["error"] or _vesselapi["error"]}


# ----------------------------------------------
# Real vehicle positions (GPS): operators' GTFS-Realtime feeds
#
# Transitous (above) places vehicles from the timetable. Many operators also
# publish where each vehicle really is, as a "GTFS-Realtime vehicle
# positions" feed, refreshed every 10-30 seconds. There is no worldwide
# source of those, so the relay keeps a list of feeds, each with the area it
# covers, and asks the ones under the area on screen (only while a page has
# the transit layer on there).
#
# Where the list comes from:
#   - TransLink (Metro Vancouver): built in. Free key from
#     https://developer.translink.ca , in .env:  TRANSLINK_API_KEY=...
#   - MBTA (Boston): built in, no key.
#   - Everywhere else: looked up, per area you visit, in two catalogues of
#     the world's transit feeds, and remembered for a week:
#       Transitland (transit.land), free key:   TRANSITLAND_API_KEY=...
#       Mobility Database (mobilitydatabase.org), free account; copy the
#       "refresh token" from your account page:
#                                   MOBILITY_DATABASE_REFRESH_TOKEN=...
#     Feeds that need their own key cannot be read directly; Transitland
#     passes on its own copy of many of those (about a minute old).
#
# A position feed only says "vehicle 4012 is on route 6641": the route's
# real name, colour and kind come from the operator's timetable download
# (GTFS zip), fetched once per feed and kept for a week.
# ----------------------------------------------

TRANSLINK_API_KEY = os.environ.get("TRANSLINK_API_KEY", "").strip()
TRANSITLAND_API_KEY = os.environ.get("TRANSITLAND_API_KEY", "").strip()
MOBILITY_DATABASE_REFRESH_TOKEN = os.environ.get("MOBILITY_DATABASE_REFRESH_TOKEN", "").strip()

TRANSITLAND_URL = os.environ.get("TRANSITLAND_URL", "https://transit.land/api/v2/rest")
MOBILITY_DATABASE_URL = os.environ.get("MOBILITY_DATABASE_URL", "https://api.mobilitydatabase.org")

GPS_FEED_INTERVAL = 15          # seconds between requests to one feed
GPS_RELAYED_INTERVAL = 60       # ... for feeds read through Transitland's copy
GPS_MAX_AGE = 300               # a position older than this is not shown
GPS_FEEDS_PER_VIEW = 15         # most feeds asked for one view
GPS_REPLY_LIMIT = 5000          # most vehicles sent to the page at once
GPS_FEED_MAX_BYTES = 25 * 1024 * 1024
GPS_STATIC_MAX_BYTES = 300 * 1024 * 1024   # (the Dutch timetable is 275 MB; only routes.txt is read from it)
GPS_ROUTES_TTL = 7 * 86400
GPS_DISCOVER_TTL = 7 * 86400
GPS_DISCOVER_MAX_SPAN = 6.0     # no catalogue lookups for views wider than this (degrees)
GPS_FEEDS_FILE = os.path.join(CACHE_DIR, ".transit_feeds_cache.json")    # dotfiles: never served

_gps_lock = threading.Lock()
_gps_feeds = {}             # key -> feed (see add_gps_feed)
_gps_state = {}             # key -> {"at", "busy", "vehicles", "error", "failures", "routes", ...}
_gps_cells = {}             # "lat,lon" of a 1-degree square -> when its feeds were looked up
_gps_discovering = set()
_mobility_token = {"value": "", "expires": 0.0}


def _public_url(url):
    """Catalogue entries are other people's data: only fetch real web addresses."""
    try:
        parts = urllib.parse.urlparse(url)
    except ValueError:
        return False
    host = (parts.hostname or "").lower()
    if parts.scheme not in ("http", "https") or "." not in host:
        return False
    return not (host == "localhost" or host.endswith(".local") or host.endswith(".internal")
                or re.match(r"^(127\.|10\.|192\.168\.|169\.254\.|0\.|172\.(1[6-9]|2\d|3[01])\.)", host))


def _url_identity(url):
    """Two catalogue entries for the same feed: same host and path."""
    parts = urllib.parse.urlparse(url)
    return f"{(parts.hostname or '').lower()}{parts.path.rstrip('/').lower()}"


def add_gps_feed(key, name, url, box, static_url="", kind="direct", credit="", interval=None):
    """box = (south, west, north, east). kind "transitland" = read Transitland's
    copy of the feed, url then being its feed id. Call with _gps_lock held."""
    identity = _url_identity(url) if kind == "direct" else f"transitland:{url}"
    for other_key, other in _gps_feeds.items():
        if other_key != key and other["identity"] == identity:
            return False                             # already listed from elsewhere
    _gps_feeds[key] = {
        "key": key, "name": name, "url": url, "box": tuple(box), "static_url": static_url,
        "kind": kind, "credit": credit, "identity": identity,
        "interval": interval or (GPS_RELAYED_INTERVAL if kind == "transitland" else GPS_FEED_INTERVAL)}
    return True


# ---------- reading a feed (protocol buffers, by hand: no packages) ----------

def _pb_varint(data, i):
    value = shift = 0
    while True:
        byte = data[i]
        i += 1
        value |= (byte & 0x7F) << shift
        if not byte & 0x80:
            return value, i
        shift += 7
        if shift > 70:
            raise ValueError("bad number in feed")


def _pb_fields(data):
    """(field number, value) for each field of one message. Nested messages
    and text come as bytes, numbers as int, 4/8-byte values as bytes."""
    i, end = 0, len(data)
    while i < end:
        key, i = _pb_varint(data, i)
        wire = key & 7
        if wire == 0:
            value, i = _pb_varint(data, i)
        elif wire == 1:
            value, i = data[i:i + 8], i + 8
        elif wire == 2:
            size, i = _pb_varint(data, i)
            value, i = data[i:i + size], i + size
        elif wire == 5:
            value, i = data[i:i + 4], i + 4
        else:
            raise ValueError("not a GTFS-Realtime feed")
        if i > end:
            raise ValueError("feed cut short")
        yield key >> 3, value


def _pb_text(value):
    return value.decode("utf-8", "replace").strip() if isinstance(value, bytes) else ""


def _pb_float(value):
    if isinstance(value, bytes) and len(value) == 4:
        number = struct.unpack("<f", value)[0]
        return number if number == number and abs(number) < 1e9 else None    # (NaN != NaN)
    return None


def parse_vehicle_positions(data):
    """GTFS-Realtime FeedMessage -> list of vehicles (dicts). Field numbers
    are those of gtfs-realtime.proto."""
    vehicles = []
    for field, entity in _pb_fields(data):
        if field != 2 or not isinstance(entity, bytes):          # FeedMessage.entity
            continue
        entity_id, found = "", None
        for field, value in _pb_fields(entity):
            if field == 1:
                entity_id = _pb_text(value)
            elif field == 4 and isinstance(value, bytes):        # FeedEntity.vehicle
                found = value
        if found is None:
            continue
        v = {"id": entity_id, "label": "", "route_id": "", "trip_id": "", "lat": None,
             "lon": None, "bearing": None, "speed": None, "t": 0, "status": None}
        for field, value in _pb_fields(found):                   # VehiclePosition
            if field == 1 and isinstance(value, bytes):          # .trip
                for f, x in _pb_fields(value):
                    if f == 1:
                        v["trip_id"] = _pb_text(x)
                    elif f == 5:
                        v["route_id"] = _pb_text(x)
            elif field == 2 and isinstance(value, bytes):        # .position
                for f, x in _pb_fields(value):
                    if f == 1:
                        v["lat"] = _pb_float(x)
                    elif f == 2:
                        v["lon"] = _pb_float(x)
                    elif f == 3:
                        v["bearing"] = _pb_float(x)
                    elif f == 5:
                        v["speed"] = _pb_float(x)                # metres per second
            elif field == 4 and isinstance(value, int):          # .current_status
                v["status"] = value
            elif field == 5 and isinstance(value, int):          # .timestamp
                v["t"] = value
            elif field == 8 and isinstance(value, bytes):        # .vehicle
                for f, x in _pb_fields(value):
                    if f == 1 and _pb_text(x):
                        v["id"] = _pb_text(x)
                    elif f == 2:
                        v["label"] = _pb_text(x)
        if v["lat"] is None or v["lon"] is None or abs(v["lat"]) > 90 or abs(v["lon"]) > 180:
            continue
        if abs(v["lat"]) < 0.01 and abs(v["lon"]) < 0.01:        # "no GPS fix" comes as 0, 0
            continue
        vehicles.append(v)
    return vehicles


# GTFS route_type -> the page's kinds of vehicle (TRANSIT_MODES in transit.ts)
def _gps_mode(route_type):
    try:
        kind = int(route_type)
    except (TypeError, ValueError):
        return "BUS"
    simple = {0: "TRAM", 1: "SUBWAY", 2: "REGIONAL_RAIL", 3: "BUS", 4: "FERRY", 5: "TRAM",
              6: "AERIAL_LIFT", 7: "FUNICULAR", 11: "BUS", 12: "SUBWAY"}
    if kind in simple:
        return simple[kind]
    for low, high, mode in ((100, 199, "REGIONAL_RAIL"), (200, 299, "COACH"), (400, 699, "SUBWAY"),
                            (700, 899, "BUS"), (900, 999, "TRAM"), (1000, 1299, "FERRY"),
                            (1300, 1399, "AERIAL_LIFT"), (1400, 1499, "FUNICULAR")):
        if low <= kind <= high:
            return mode
    return "BUS"


# ---------- route names (from the operator's timetable download) ----------

def _gps_routes_file(key):
    return os.path.join(CACHE_DIR, ".transit_routes_" + re.sub(r"[^A-Za-z0-9]+", "_", key) + ".json")


def load_gps_routes(feed):
    """Background thread: route id -> [short name, long name, mode, colour]."""
    key = feed["key"]
    routes = {}
    try:
        path = _gps_routes_file(key)
        try:
            if time.time() - os.path.getmtime(path) < GPS_ROUTES_TTL:
                with open(path, encoding="utf-8") as handle:
                    routes = json.load(handle)
        except (OSError, ValueError):
            routes = {}

        if not routes and feed["static_url"] and _public_url(feed["static_url"]):
            request = urllib.request.Request(
                feed["static_url"], headers={"User-Agent": PHOTO_USER_AGENT})
            with tempfile.TemporaryFile() as temp:
                with urllib.request.urlopen(request, timeout=60) as response:
                    size = 0
                    while True:
                        chunk = response.read(1 << 20)
                        if not chunk:
                            break
                        size += len(chunk)
                        if size > GPS_STATIC_MAX_BYTES:
                            raise RuntimeError("timetable download too large")
                        temp.write(chunk)
                with zipfile.ZipFile(temp) as archive:
                    name = next((n for n in archive.namelist()
                                 if n.lower().split("/")[-1] == "routes.txt"), None)
                    if not name:
                        raise RuntimeError("no routes.txt in the timetable download")
                    with archive.open(name) as raw:
                        text = io.TextIOWrapper(raw, encoding="utf-8-sig", newline="")
                        for row in csv.DictReader(text):
                            row = {(k or "").strip(): (v or "").strip() for k, v in row.items()}
                            if not row.get("route_id"):
                                continue
                            colour = row.get("route_color", "").lower()
                            routes[row["route_id"]] = [
                                row.get("route_short_name", ""), row.get("route_long_name", ""),
                                _gps_mode(row.get("route_type")),
                                colour if re.fullmatch(r"[0-9a-f]{6}", colour) else ""]
            with open(path, "w", encoding="utf-8") as handle:
                json.dump(routes, handle)
            print(f"Transit GPS: {len(routes)} route names loaded for {feed['name']}")
    except Exception as error:  # noqa: BLE001
        print(f"Transit GPS: no route names for {feed['name']} ({error})")
    finally:
        with _gps_lock:
            state = _gps_state.setdefault(key, {})
            state["routes"] = routes
            state["routes_busy"] = False


# ---------- asking a feed ----------

def run_gps_feed(feed):
    """Background thread: one request to one feed."""
    key = feed["key"]
    vehicles, problem = None, ""
    try:
        headers = {"User-Agent": PHOTO_USER_AGENT, "Accept-Encoding": "gzip"}
        if feed["kind"] == "transitland":
            url = (f"{TRANSITLAND_URL}/feeds/{urllib.parse.quote(feed['url'], safe='')}"
                   "/download_latest_rt/vehicle_positions.pb")
            headers["apikey"] = TRANSITLAND_API_KEY
        elif feed["kind"] == "translink":
            url = f"{feed['url']}?apikey={urllib.parse.quote(TRANSLINK_API_KEY)}"
        else:
            url = feed["url"]
            if not _public_url(url):
                raise RuntimeError("not a public web address")
        with urllib.request.urlopen(urllib.request.Request(url, headers=headers),
                                    timeout=15) as response:
            data = response.read(GPS_FEED_MAX_BYTES + 1)
            if len(data) > GPS_FEED_MAX_BYTES:
                raise RuntimeError("feed too large")
            if response.headers.get("Content-Encoding", "").lower() == "gzip" or data[:2] == b"\x1f\x8b":
                data = gzip.decompress(data)
        vehicles = parse_vehicle_positions(data)
    except urllib.error.HTTPError as error:
        problem = f"HTTP {error.code}"
    except Exception as error:  # noqa: BLE001
        problem = str(error) or type(error).__name__

    now = time.time()
    with _gps_lock:
        state = _gps_state.setdefault(key, {})
        state["busy"] = False
        if vehicles is None:
            state["failures"] = state.get("failures", 0) + 1
            state["error"] = problem
            # A feed that keeps failing is asked less and less often (up to 10 minutes)
            state["at"] = now + min(600, 30 * state["failures"]) - feed["interval"]
            if state["failures"] in (1, 5):
                print(f"Transit GPS: {feed['name']} failed ({problem})")
            return
        if not state.get("at"):
            print(f"Transit GPS: {feed['name']} is answering ({len(vehicles)} vehicles)")
        state.update(failures=0, error="", at=now, raw=vehicles, built=None)


def _gps_rows(feed, state, now):
    """The feed's vehicles as rows for the page (see TransitGpsRow in transit.ts)."""
    routes = state.get("routes") or {}
    built = state.get("built")
    if built is not None and built[0] is routes:
        return built[1]
    rows = []
    for v in state.get("raw") or []:
        if v["t"] and now - v["t"] > GPS_MAX_AGE:
            continue
        # (a few feeds send a bad fix far outside their own area)
        box = feed["box"]
        if not (box[0] - 0.5 <= v["lat"] <= box[2] + 0.5 and box[1] - 0.5 <= v["lon"] <= box[3] + 0.5):
            continue
        route = routes.get(v["route_id"])
        # (a raw route id is only shown when there is no timetable to translate it;
        # "OST:Line:1_199" is shown as "1_199")
        name = ((route[0] or route[1]) if route
                else ("" if feed["static_url"] else v["route_id"].rsplit(":", 1)[-1]))
        rows.append([
            f"{feed['key']}|{v['id'] or v['trip_id']}",
            round(v["lat"], 5), round(v["lon"], 5),
            round(v["bearing"], 1) if v["bearing"] is not None else None,
            round(v["speed"], 1) if v["speed"] is not None and 0 <= v["speed"] < 150 else None,
            v["t"] or int(state["at"]),
            name[:40], (route[1] if route else "")[:80],
            route[2] if route else "BUS", route[3] if route else "",
            v["label"][:30], feed["name"][:60], feed["credit"][:200]])
    state["built"] = (routes, rows)
    return rows


# ---------- finding the feeds of an area (the two catalogues) ----------

def _get_json(url, headers=None, data=None, timeout=20):
    request = urllib.request.Request(
        url, data=data,
        headers=dict({"Accept": "application/json", "User-Agent": PHOTO_USER_AGENT}, **(headers or {})))
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return json.loads(response.read(8 * 1024 * 1024).decode("utf-8"))


def _box_of_points(geometry):
    """(south, west, north, east) of a GeoJSON geometry, or None."""
    lats, lons = [], []

    def walk(part):
        if isinstance(part, list):
            if len(part) >= 2 and all(isinstance(n, (int, float)) for n in part[:2]):
                lons.append(part[0])
                lats.append(part[1])
            else:
                for item in part:
                    walk(item)

    walk(geometry.get("coordinates") if isinstance(geometry, dict) else None)
    return (min(lats), min(lons), max(lats), max(lons)) if lats else None


def discover_transitland(south, west, north, east):
    """Feeds with vehicle positions for the operators in this box."""
    found = []
    key = {"apikey": TRANSITLAND_API_KEY}
    operators = _get_json(
        f"{TRANSITLAND_URL}/operators?" + urllib.parse.urlencode(
            {"bbox": f"{west},{south},{east},{north}", "limit": 30}), key).get("operators") or []

    def feed_info(feed_id):
        feeds = _get_json(f"{TRANSITLAND_URL}/feeds/{urllib.parse.quote(feed_id, safe='')}",
                          key).get("feeds") or []
        return feeds[0] if feeds and isinstance(feeds[0], dict) else {}

    for operator in operators[:15]:
        if not isinstance(operator, dict):
            continue
        spec = lambda f: str(f.get("spec", "")).lower().replace("_", "-")   # noqa: E731
        feeds = [f for f in operator.get("feeds") or [] if isinstance(f, dict) and f.get("onestop_id")]
        realtime = [f["onestop_id"] for f in feeds if spec(f) == "gtfs-rt"]
        static = [f["onestop_id"] for f in feeds if spec(f) == "gtfs"]
        if not realtime:
            continue

        box = None
        for agency in operator.get("agencies") or []:
            part = _box_of_points(agency.get("geometry")) if isinstance(agency, dict) else None
            if part:
                box = part if not box else (min(box[0], part[0]), min(box[1], part[1]),
                                            max(box[2], part[2]), max(box[3], part[3]))
        box = box or (south, west, north, east)

        static_url = ""
        for feed_id in realtime[:2]:
            info = feed_info(feed_id)
            urls = info.get("urls") or {}
            positions = urls.get("realtime_vehicle_positions")
            if not positions:
                continue
            if not static_url and static:
                static_url = (feed_info(static[0]).get("urls") or {}).get("static_current") or ""
            needs_key = bool((info.get("authorization") or {}).get("type"))
            licence = info.get("license") or {}
            found.append({
                "key": f"tl:{feed_id}",
                "name": operator.get("name") or operator.get("short_name") or feed_id,
                # A feed that wants its own key: read Transitland's copy instead
                "url": feed_id if needs_key else positions,
                "kind": "transitland" if needs_key else "direct",
                "box": box, "static_url": static_url,
                "credit": _clean_text(licence.get("attribution_text"))})
    return found


def _mobility_headers():
    now = time.time()
    if now >= _mobility_token["expires"]:
        answer = _get_json(
            f"{MOBILITY_DATABASE_URL}/v1/tokens",
            {"Content-Type": "application/json"},
            json.dumps({"refresh_token": MOBILITY_DATABASE_REFRESH_TOKEN}).encode("utf-8"))
        _mobility_token.update(value=answer["access_token"], expires=now + 3000)   # (valid an hour)
    return {"Authorization": f"Bearer {_mobility_token['value']}"}


def discover_mobility_database(south, west, north, east):
    """Position feeds that need no key, for the timetables touching this box."""
    headers = _mobility_headers()
    timetables = _get_json(
        f"{MOBILITY_DATABASE_URL}/v1/gtfs_feeds?" + urllib.parse.urlencode({
            "dataset_latitudes": f"{south},{north}", "dataset_longitudes": f"{west},{east}",
            "bounding_filter_method": "partially_enclosed", "limit": 100}), headers)

    known, countries = {}, []
    for item in timetables if isinstance(timetables, list) else []:
        if not isinstance(item, dict) or not item.get("id"):
            continue
        latest = item.get("latest_dataset") or {}
        bounds = latest.get("bounding_box") or {}
        try:
            box = (float(bounds["minimum_latitude"]), float(bounds["minimum_longitude"]),
                   float(bounds["maximum_latitude"]), float(bounds["maximum_longitude"]))
        except (KeyError, TypeError, ValueError):
            box = (south, west, north, east)
        known[item["id"]] = (box, latest.get("hosted_url")
                             or (item.get("source_info") or {}).get("producer_url") or "")
        for place in item.get("locations") or []:
            code = place.get("country_code") if isinstance(place, dict) else None
            if code and code not in countries:
                countries.append(code)

    found = []
    for country in countries[:3]:
        for offset in (0, 500, 1000):
            page = _get_json(
                f"{MOBILITY_DATABASE_URL}/v1/gtfs_rt_feeds?" + urllib.parse.urlencode({
                    "entity_types": "vp", "country_code": country, "limit": 500, "offset": offset}),
                headers)
            page = page if isinstance(page, list) else []
            for item in page:
                if not isinstance(item, dict) or item.get("status") in ("deprecated", "inactive"):
                    continue
                source = item.get("source_info") or {}
                matches = [ref for ref in item.get("feed_references") or [] if ref in known]
                if not matches or not source.get("producer_url"):
                    continue
                if source.get("authentication_type") not in (None, 0):
                    continue                         # wants a key of its own
                box, static_url = known[matches[0]]
                found.append({
                    "key": f"mdb:{item.get('id')}", "name": item.get("provider") or str(item.get("id")),
                    "url": source["producer_url"], "kind": "direct", "box": box,
                    "static_url": static_url, "credit": ""})
            if len(page) < 500:
                break
    return found


def save_gps_feeds():
    """(Call with _gps_lock held.) Only looked-up feeds: the built-in ones are code."""
    try:
        with open(GPS_FEEDS_FILE, "w", encoding="utf-8") as handle:
            json.dump({"cells": _gps_cells,
                       "feeds": [{k: f[k] for k in ("key", "name", "url", "box", "static_url",
                                                    "kind", "credit")}
                                 for f in _gps_feeds.values() if ":" in f["key"]]}, handle)
    except OSError as error:
        print(f"Transit GPS: the feed list could not be saved ({error})")


# Cities whose operators publish real GPS positions with no key at all (GTFS-Realtime
# "vehicle positions"). (key, name, positions feed, (south, west, north, east),
# timetable download for the route names, credit)
GPS_FREE_FEEDS = (
    ("hsl", "HSL Helsinki", "https://realtime.hsl.fi/realtime/vehicle-positions/v2/hsl",
     (59.9, 23.5, 61.6, 25.7), "https://infopalvelut.storage.hsldev.com/gtfs/hsl.zip",
     "Data: HSL / Helsinki Region Transport, CC BY 4.0"),
    # (no timetable download: the national one is over half a gigabyte)
    ("entur", "Norway (Entur)", "https://api.entur.io/realtime/v1/gtfs-rt/vehicle-positions",
     (57.5, 4.0, 71.5, 31.5), "",
     "Data: Entur (entur.org), NLOD"),
    ("ovapi", "Netherlands (OVapi)", "https://gtfs.ovapi.nl/nl/vehiclePositions.pb",
     (50.7, 3.2, 53.6, 7.3), "https://gtfs.ovapi.nl/nl/gtfs-nl.zip",
     "Data: OVapi / NDOV (ndovloket.nl)"),
    ("ttc", "TTC Toronto", "https://bustime.ttc.ca/gtfsrt/vehicles",
     (43.4, -79.9, 44.0, -78.9),
     "https://ckan0.cf.opendata.inter.prod-toronto.ca/dataset/7795b45e-e65a-4465-81fc-c36b9dfff169/"
     "resource/cfb6b2b8-6191-41e3-bda1-b175c51148cb/download/completegtfs.zip",
     "Contains information licensed under the Open Government Licence - Toronto"),
    ("calgary", "Calgary Transit",
     "https://data.calgary.ca/download/am7c-qe3u/application%2Foctet-stream",
     (50.8, -114.4, 51.3, -113.8), "https://data.calgary.ca/download/npk7-z3bj/application%2Fzip",
     "Contains information licensed under the Open Government Licence - City of Calgary"),
    ("edmonton", "Edmonton Transit",
     "https://gtfs.edmonton.ca/TMGTFSRealTimeWebService/Vehicle/VehiclePositions.pb",
     (53.3, -113.8, 53.7, -113.2), "https://gtfs.edmonton.ca/TMGTFSRealTimeWebService/GTFS/gtfs.zip",
     "Contains information licensed under the Open Government Licence - City of Edmonton"),
    ("rtd", "RTD Denver", "https://open-data.rtd-denver.com/files/gtfs-rt/rtd/VehiclePosition.pb",
     (39.4, -105.6, 40.3, -104.6), "https://www.rtd-denver.com/files/gtfs/google_transit.zip",
     "Data: Regional Transportation District (RTD) open data"),
    ("austin", "CapMetro Austin",
     "https://data.texas.gov/download/eiei-9rpf/application%2Foctet-stream",
     (30.0, -98.0, 30.8, -97.5), "https://data.texas.gov/download/r4v4-vz24/application%2Fzip",
     "Data: Capital Metro via the Texas Open Data Portal"),
    # (its download holds two zips inside one, so there are no route names; the bus lines are numbered anyway)
    ("septa", "SEPTA Philadelphia",
     "https://www3.septa.org/gtfsrt/septa-pa-us/Vehicle/rtVehiclePosition.pb",
     (39.8, -75.7, 40.4, -74.9), "",
     "Data: SEPTA"),
    ("rome", "Rome (Roma Mobilita)",
     "https://romamobilita.it/sites/default/files/rome_rtgtfs_vehicle_positions_feed.pb",
     (41.6, 12.1, 42.2, 12.8), "https://romamobilita.it/sites/default/files/rome_static_gtfs.zip",
     "Data: Roma Servizi per la Mobilita, CC BY"),
    ("vilnius", "Vilnius (stops.lt)", "https://www.stops.lt/vilnius/vehicle_positions.pb",
     (54.5, 25.0, 54.9, 25.5), "https://www.stops.lt/vilnius/vilnius/gtfs.zip",
     "Data: Vilnius city public transport (stops.lt)"),
)


def load_gps_feeds():
    with _gps_lock:
        if TRANSLINK_API_KEY:
            add_gps_feed("translink", "TransLink", "https://gtfsapi.translink.ca/v3/gtfsposition",
                         (48.95, -123.5, 49.5, -122.15), kind="translink",
                         static_url="https://gtfs-static.translink.ca/gtfs/google_transit.zip",
                         credit="Route and arrival data used in this product or service is "
                                "provided by permission of TransLink. TransLink assumes no "
                                "responsibility for the accuracy or currency of the Data used "
                                "in this product or service.")
        add_gps_feed("mbta", "MBTA", "https://cdn.mbta.com/realtime/VehiclePositions.pb",
                     (41.2, -72.0, 43.0, -69.9),
                     static_url="https://cdn.mbta.com/MBTA_GTFS.zip")
        for key, name, url, box, static_url, credit in GPS_FREE_FEEDS:
            add_gps_feed(key, name, url, box, static_url=static_url, credit=credit)
        try:
            with open(GPS_FEEDS_FILE, encoding="utf-8") as handle:
                saved = json.load(handle)
            now = time.time()
            _gps_cells.update({cell: at for cell, at in saved.get("cells", {}).items()
                               if now - at < GPS_DISCOVER_TTL})
            for feed in saved.get("feeds", []):
                # (a relayed feed is no use once the Transitland key is gone)
                if feed.get("kind") == "transitland" and not TRANSITLAND_API_KEY:
                    continue
                add_gps_feed(feed["key"], feed["name"], feed["url"], feed["box"],
                             feed.get("static_url", ""), feed.get("kind", "direct"),
                             feed.get("credit", ""))
        except FileNotFoundError:
            pass
        except Exception as error:  # noqa: BLE001
            print(f"Transit GPS: the saved feed list could not be read ({error})")


def run_gps_discovery(cell, south, west, north, east):
    """Background thread: ask the catalogues which feeds cover this square."""
    found = []
    for label, wanted, lookup in (
            ("Transitland", TRANSITLAND_API_KEY, discover_transitland),
            ("Mobility Database", MOBILITY_DATABASE_REFRESH_TOKEN, discover_mobility_database)):
        if not wanted:
            continue
        try:
            part = lookup(south, west, north, east)
            found += part
            print(f"Transit GPS: {label} lists {len(part)} position feed(s) around "
                  f"{(south + north) / 2:.1f}, {(west + east) / 2:.1f}")
        except urllib.error.HTTPError as error:
            print(f"Transit GPS: {label} lookup failed (HTTP {error.code}"
                  f"{': check the key in .env' if error.code in (401, 403) else ''})")
        except Exception as error:  # noqa: BLE001
            print(f"Transit GPS: {label} lookup failed ({error})")
    with _gps_lock:
        for feed in found:
            try:
                add_gps_feed(feed["key"], str(feed["name"]), str(feed["url"]),
                             [float(n) for n in feed["box"]], str(feed.get("static_url") or ""),
                             feed["kind"], feed.get("credit") or "")
            except (KeyError, TypeError, ValueError):
                continue
        _gps_cells[cell] = time.time()
        _gps_discovering.discard(cell)
        save_gps_feeds()


def get_gps_vehicles(south, west, north, east):
    """Real vehicle positions inside the box, from every feed that covers it."""
    now = time.time()
    lookups = bool(TRANSITLAND_API_KEY or MOBILITY_DATABASE_REFRESH_TOKEN)
    start = []
    with _gps_lock:
        # 1. Which feeds are there for this area? (asked once per 1-degree square)
        if lookups and north - south <= GPS_DISCOVER_MAX_SPAN and 0 < east - west <= GPS_DISCOVER_MAX_SPAN:
            lat, lon = int((south + north) // 2), int((west + east) // 2)
            cell = f"{lat},{lon}"
            if (cell not in _gps_discovering and len(_gps_discovering) < 2
                    and now - _gps_cells.get(cell, 0) > GPS_DISCOVER_TTL):
                _gps_discovering.add(cell)
                start.append(threading.Thread(
                    target=run_gps_discovery, daemon=True,
                    args=(cell, lat - 0.5, lon - 0.5, lat + 1.5, lon + 1.5)))

        # 2. Ask the ones under the view that are due
        def touches(box):
            return box[0] <= north and box[2] >= south and box[1] <= east and box[3] >= west

        def size(feed):                              # local feeds before national ones
            return (feed["box"][2] - feed["box"][0]) * (feed["box"][3] - feed["box"][1])

        if west > east:                              # view across the date line: not handled
            covering = []
        else:
            covering = sorted((f for f in _gps_feeds.values() if touches(f["box"])),
                              key=size)[:GPS_FEEDS_PER_VIEW]

        rows, summary = [], []
        for feed in covering:
            state = _gps_state.setdefault(feed["key"], {})
            if "routes" not in state and not state.get("routes_busy"):
                state["routes_busy"] = True
                start.append(threading.Thread(target=load_gps_routes, args=(feed,), daemon=True))
            if not state.get("busy") and now - state.get("at", 0) >= feed["interval"]:
                state["busy"] = True
                start.append(threading.Thread(target=run_gps_feed, args=(feed,), daemon=True))
            # (a feed nobody has asked for a while holds old positions: not shown)
            fresh = now - state.get("at", 0) < GPS_MAX_AGE and not state.get("failures")
            inside = [row for row in (_gps_rows(feed, state, now) if fresh else [])
                      if south <= row[1] <= north and west <= row[2] <= east]
            rows += inside
            # (its whole area and all its lines, not just what is on screen: the
            # page leaves the timetable's guesses for those lines out)
            summary.append({"name": feed["name"], "vehicles": len(inside),
                            "error": state.get("error", ""), "box": list(feed["box"]),
                            "lines": sorted({row[6] for row in
                                             (_gps_rows(feed, state, now) if fresh else [])
                                             if row[6]})[:800]})

        discovering = bool(_gps_discovering)

    for thread in start:
        thread.start()

    return {"available": bool(covering or lookups or discovering),
            "vehicles": rows[:GPS_REPLY_LIMIT], "feeds": summary, "discovering": discovering}


# ---------- trains (the sources that need a key; the rest the page asks itself) ----------
#
#   Sweden:    Trafikverket Open API, free key: https://data.trafikverket.se
#              -> TRAFIKVERKET_API_KEY. All trains with GPS, passenger and freight.
#
# The page asks "/api/rail"; the keys never leave this file.

RAIL_CACHE_SECONDS = 20
_rail_lock = threading.Lock()
_rail_cache = {"time": 0.0, "reply": None}

TRAFIKVERKET_URL = "https://api.trafikinfo.trafikverket.se/v2/data.json"

def _rail_time(text):
    try:
        return int(datetime.datetime.fromisoformat(str(text).replace("Z", "+00:00")).timestamp() * 1000)
    except ValueError:
        return int(time.time() * 1000)


def rail_sweden(key):
    query = (
        '<REQUEST><LOGIN authenticationkey="%s"/>'
        '<QUERY objecttype="TrainPosition" namespace="järnväg.trafikinfo" '
        'schemaversion="1.0" limit="3000">'
        '<FILTER><GT name="TimeStamp" value="$dateadd(-0.00:10:00)"/></FILTER>'
        '<INCLUDE>Train</INCLUDE><INCLUDE>Position</INCLUDE><INCLUDE>Bearing</INCLUDE>'
        '<INCLUDE>Speed</INCLUDE><INCLUDE>TimeStamp</INCLUDE><INCLUDE>Status</INCLUDE>'
        '<INCLUDE>Deleted</INCLUDE>'
        '</QUERY></REQUEST>' % key).encode("utf-8")
    request = urllib.request.Request(TRAFIKVERKET_URL, data=query, headers={
        "Content-Type": "text/xml", "Accept": "application/json", "User-Agent": PHOTO_USER_AGENT})
    with urllib.request.urlopen(request, timeout=25) as response:
        payload = json.loads(response.read(16 * 1024 * 1024).decode("utf-8"))
    rows = []
    for item in ((payload.get("RESPONSE", {}).get("RESULT") or [{}])[0].get("TrainPosition") or []):
        if item.get("Deleted"):
            continue
        match = re.search(r"POINT\s*\(\s*([-\d.]+)\s+([-\d.]+)", (item.get("Position") or {}).get("WGS84", ""))
        if not match:
            continue
        train = item.get("Train") or {}
        number = str(train.get("AdvertisedTrainNumber") or train.get("OperationalTrainNumber") or "")
        # Swedish numbering: passenger trains are below 10000, freight above (a guess)
        kind = "other"
        if number.isdigit():
            kind = "passenger" if int(number) < 10000 else "freight"
        rows.append({
            "id": f"se|{train.get('OperationalTrainNumber') or number}|{str(train.get('OperationalTrainDepartureDate', ''))[:10]}",
            "kind": kind, "number": number, "name": "",
            "lat": float(match.group(2)), "lon": float(match.group(1)),
            "t": _rail_time(item.get("TimeStamp")),
            "kmh": _clean_number(item.get("Speed")), "heading": _clean_number(item.get("Bearing")),
            "from": "", "to": "", "operator": "",
            "note": "Kind guessed from the train number" if kind != "other" else "", "src": "se"})
    return rows


def get_rail():
    """Trains from the keyed sources, cached for a few seconds."""
    with _rail_lock:
        if _rail_cache["reply"] and time.time() - _rail_cache["time"] < RAIL_CACHE_SECONDS:
            return _rail_cache["reply"]
    reply = {"trains": [], "sources": {}}
    jobs = (
        ("se", os.environ.get("TRAFIKVERKET_API_KEY", "").strip(), rail_sweden),
    )
    for name, key, reader in jobs:
        if not key:
            reply["sources"][name] = "nokey"
            continue
        try:
            result = reader(key)
            if isinstance(result, tuple):
                result, errors = result
                reply["sources"][name] = "; ".join(errors) if errors and not result else "ok"
            else:
                reply["sources"][name] = "ok"
            reply["trains"].extend(result)
        except Exception as error:  # noqa: BLE001
            print(f"Rail source {name} failed ({error})")
            reply["sources"][name] = str(error)[:120]
    with _rail_lock:
        _rail_cache.update(time=time.time(), reply=reply)
    return reply


# ----------------------------------------------------------------------
# SUBMARINE CABLES (TeleGeography, submarinecablemap.com, CC BY-SA 4.0)
# Their API sends no CORS headers, so the page asks "/api/cables" and
# "/api/cables/<id>" here. Cable routes barely change: cached for hours.
# ----------------------------------------------------------------------

CABLE_API = "https://www.submarinecablemap.com/api/v3"
CABLE_CACHE_SECONDS = 7 * 24 * 3600     # cable routes change rarely: refresh weekly
CABLE_CACHE_FILE = os.path.join(CACHE_DIR, ".cable_cache.json")
_cable_lock = threading.Lock()
_cable_cache = {}   # path -> [time fetched, text]; also kept on disk across restarts
_cable_loaded = False


def _cable_load_disk():
    global _cable_loaded
    if _cable_loaded:
        return
    _cable_loaded = True
    try:
        with open(CABLE_CACHE_FILE, "r", encoding="utf-8") as handle:
            _cable_cache.update(json.load(handle))
    except Exception:  # noqa: BLE001
        pass


def get_cable_data(path):
    """One TeleGeography JSON file, as (time fetched, text). Cached on disk;
    if a refresh fails the older copy is still served. `path` is already checked."""
    with _cable_lock:
        _cable_load_disk()
        hit = _cable_cache.get(path)
    if hit and time.time() - hit[0] < CABLE_CACHE_SECONDS:
        return hit[0], hit[1]
    try:
        request = urllib.request.Request(
            f"{CABLE_API}/{path}", headers={"User-Agent": "osint-map", "Accept": "application/json"})
        with urllib.request.urlopen(request, timeout=30) as response:
            text = response.read().decode("utf-8")
        json.loads(text)    # refuse to cache an HTML error page
    except Exception:  # noqa: BLE001
        if hit:
            return hit[0], hit[1]
        raise
    fetched = time.time()
    with _cable_lock:
        _cable_cache[path] = [fetched, text]
        try:
            with open(CABLE_CACHE_FILE, "w", encoding="utf-8") as handle:
                json.dump(_cable_cache, handle)
        except OSError:
            pass
    return fetched, text


def get_cable_json(path):
    """A single cable / landing point, with "fetched" (unix seconds) added."""
    fetched, text = get_cable_data(path)
    data = json.loads(text)
    data["fetched"] = fetched
    return data


def get_cables():
    """Every cable route + every landing point, in one answer."""
    t1, cables = get_cable_data("cable/cable-geo.json")
    t2, landings = get_cable_data("landing-point/landing-point-geo.json")
    return ('{"fetched":' + str(min(t1, t2)) + ',"cables":' + cables +
            ',"landings":' + landings + "}")


# ----------------------------------------------------------------------
# SATELLITES (CelesTrak, celestrak.org: orbital elements + the SATCAT register)
# The page works out where every satellite is itself (SGP4, in the browser),
# so all it needs from here is the elements and who owns / launched what.
# CelesTrak allows ONE download per feed every 2 hours and blocks people who
# ask more often, so: one merged copy, kept on disk, refreshed every 3 hours,
# and the old copy is served if a refresh fails (waiting 15 min before retry).
# ----------------------------------------------------------------------

SAT_GROUP = os.environ.get("SATELLITE_GROUP", "active")
# If the main feed can't be had (CelesTrak refuses a second download within 2
# hours, or is down) and nothing is cached, show this smaller feed instead and
# try the main one again every SAT_RETRY_SECONDS.
SAT_FALLBACK_GROUP = os.environ.get("SATELLITE_FALLBACK_GROUP", "visual")
SAT_CACHE_SECONDS = 3 * 3600
SAT_RETRY_SECONDS = 15 * 60
SAT_CACHE_FILE = os.path.join(CACHE_DIR, ".satellite_cache.json")
_sat_lock = threading.Lock()
_sat = {"time": 0.0, "plain": None, "gzip": None, "group": "", "failed": 0.0, "error": ""}
_sat_loaded = False


def _sat_fetch_json(url):
    request = urllib.request.Request(url, headers={"User-Agent": "osint-map"})
    with urllib.request.urlopen(request, timeout=120) as response:
        text = response.read().decode("utf-8")
    try:
        return json.loads(text)
    except ValueError:
        # CelesTrak answers a too-early request with a plain-text note
        raise RuntimeError(" ".join(text.split())[:200] or "not JSON")


def _sat_download(group):
    """Fetch one CelesTrak group (elements + register), merged, as JSON bytes."""
    elements = _sat_fetch_json(
        f"https://celestrak.org/NORAD/elements/gp.php?GROUP={group}&FORMAT=json")
    register = _sat_fetch_json(
        f"https://celestrak.org/satcat/records.php?GROUP={group}&FORMAT=json")
    info = {}
    for row in register:
        info[str(row["NORAD_CAT_ID"])] = {
            k: v for k, v in (
                ("ty", row.get("OBJECT_TYPE")), ("ow", row.get("OWNER")),
                ("ld", row.get("LAUNCH_DATE")), ("ls", row.get("LAUNCH_SITE")),
                ("os", row.get("OPS_STATUS_CODE")), ("rcs", row.get("RCS")),
                ("apo", row.get("APOGEE")), ("per", row.get("PERIGEE")),
                ("dd", row.get("DECAY_DATE"))) if v not in (None, "")}
    fetched = time.time()
    plain = json.dumps({"fetched": fetched, "group": group, "full": group == SAT_GROUP,
                        "gp": elements, "cat": info},
                       separators=(",", ":")).encode("utf-8")
    return fetched, plain


def _sat_store(fetched, group, plain, to_disk=True):
    _sat.update(time=fetched, group=group, plain=plain, gzip=gzip.compress(plain, 6))
    if to_disk:
        try:
            with open(SAT_CACHE_FILE, "wb") as handle:
                handle.write(plain)
        except OSError:
            pass


def _sat_load_disk():
    global _sat_loaded
    if _sat_loaded:
        return
    _sat_loaded = True
    try:
        with open(SAT_CACHE_FILE, "rb") as handle:
            plain = handle.read()
        head = json.loads(plain)
        _sat_store(head["fetched"], head.get("group", ""), plain, to_disk=False)
    except Exception:  # noqa: BLE001
        pass


def get_satellites(want_gzip):
    """(body bytes, is gzip). Raises if there is nothing at all to show."""
    with _sat_lock:
        _sat_load_disk()
        now = time.time()
        have = bool(_sat["plain"])
        full = have and _sat["group"] == SAT_GROUP
        # a full copy is good for 3 hours; a reduced one only until we can try again
        fresh = have and now - _sat["time"] < (SAT_CACHE_SECONDS if full else SAT_RETRY_SECONDS)
        backing_off = now - _sat["failed"] < SAT_RETRY_SECONDS
        if not fresh and not backing_off:
            try:
                fetched, plain = _sat_download(SAT_GROUP)
                _sat_store(fetched, SAT_GROUP, plain)
                _sat["error"] = ""
            except Exception as error:  # noqa: BLE001
                _sat["failed"] = time.time()
                _sat["error"] = str(error)
                print(f"Satellite refresh of '{SAT_GROUP}' failed ({error})")
                # nothing usable cached (or only a reduced copy that is old): fall back
                stale_ok = have and (full or now - _sat["time"] < SAT_CACHE_SECONDS)
                if not stale_ok and SAT_FALLBACK_GROUP and SAT_FALLBACK_GROUP != SAT_GROUP:
                    try:
                        fetched, plain = _sat_download(SAT_FALLBACK_GROUP)
                        _sat_store(fetched, SAT_FALLBACK_GROUP, plain)
                        print(f"Showing the '{SAT_FALLBACK_GROUP}' satellites instead")
                    except Exception as fallback_error:  # noqa: BLE001
                        print(f"Satellite fallback failed too ({fallback_error})")
        if not _sat["plain"]:
            raise RuntimeError(_sat["error"] or "satellite data not available yet")
        return (_sat["gzip"], True) if want_gzip else (_sat["plain"], False)


def get_ship_trail(mmsi):
    """Where the relay has seen this ship go since it started listening."""
    with _ships_lock:
        return {"mmsi": mmsi, "points": list(_ship_trails.get(mmsi) or [])}


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
        parts = urllib.parse.unquote(
            urllib.parse.urlparse(self.path).path).lower().split("/")
        # dotfiles (.env ...), credential files and the whole cache/ folder
        return any(part.startswith(".") or part == "cache" or "credentials" in part
                   for part in parts)

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

        if url.path == "/api/schedule":
            query = urllib.parse.parse_qs(url.query)
            code = (query.get("airport") or [""])[0]
            kind = (query.get("kind") or [""])[0]
            if not re.fullmatch(r"[A-Za-z0-9]{3,4}", code) or kind not in ("arrivals", "departures"):
                return self.send_json(400, {"error": "Bad parameters"})
            try:
                return self.send_json(200, get_airport_schedule(code, kind))
            except AirLabsOff as error:
                print(f"{error} - skipping AirLabs for an hour")
                return self.send_json(200, {"found": False, "reason": "limit"})
            except Exception as error:  # noqa: BLE001
                print(f"AirLabs schedule failed ({error})")
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

        if url.path == "/api/locate":
            query = urllib.parse.parse_qs(url.query)
            kind = (query.get("kind") or [""])[0]
            value = (query.get("value") or [""])[0]
            if kind == "hex":
                valid = re.fullmatch(r"[0-9a-fA-F]{6}", value)
            elif kind in ("callsign", "reg"):
                valid = re.fullmatch(r"[A-Za-z0-9-]{3,10}", value)
            else:
                valid = None
            if not valid:
                return self.send_json(400, {"error": "Bad parameters"})
            try:
                return self.send_json(200, get_located(kind, value))
            except Exception as error:  # noqa: BLE001
                return self.send_json(502, {"error": str(error)})

        if url.path == "/api/ships/trail":
            mmsi = (urllib.parse.parse_qs(url.query).get("mmsi") or [""])[0]
            if not re.fullmatch(r"\d{9}", mmsi):
                return self.send_json(400, {"error": "Bad parameters"})
            return self.send_json(200, get_ship_trail(int(mmsi)))

        if url.path == "/api/ships":
            query = urllib.parse.parse_qs(url.query)
            try:
                south, west, north, east = (
                    float((query.get(name) or [""])[0])
                    for name in ("south", "west", "north", "east"))
                assert -90 <= south <= north <= 90
                assert -180 <= west <= 180 and -180 <= east <= 180
            except Exception:  # noqa: BLE001
                return self.send_json(400, {"error": "Bad parameters"})
            try:
                return self.send_json(200, get_ships(south, west, north, east))
            except Exception as error:  # noqa: BLE001
                print(f"Ship relay failed ({error})")
                return self.send_json(502, {"error": str(error)})

        if url.path == "/api/satellites":
            try:
                body, zipped = get_satellites("gzip" in (self.headers.get("Accept-Encoding") or ""))
            except Exception as error:  # noqa: BLE001
                return self.send_json(503, {"error": str(error)})
            self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            if zipped:
                self.send_header("Content-Encoding", "gzip")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return

        if url.path == "/api/cables":
            try:
                return self.send_json(200, get_cables())
            except Exception as error:  # noqa: BLE001
                print(f"Cable relay failed ({error})")
                return self.send_json(502, {"error": str(error)})

        if url.path.startswith("/api/cables/"):
            cable_id = url.path[len("/api/cables/"):]
            folder = "cable"
            if cable_id.startswith("landing/"):     # /api/cables/landing/<id>
                folder, cable_id = "landing-point", cable_id[len("landing/"):]
            if not re.fullmatch(r"[a-z0-9_-]{1,120}", cable_id):
                return self.send_json(400, {"error": "Bad cable id"})
            try:
                return self.send_json(200, get_cable_json(f"{folder}/{cable_id}.json"))
            except Exception as error:  # noqa: BLE001
                print(f"Cable detail failed ({error})")
                return self.send_json(502, {"error": str(error)})

        if url.path == "/api/rail":
            try:
                return self.send_json(200, get_rail())
            except Exception as error:  # noqa: BLE001
                print(f"Rail relay failed ({error})")
                return self.send_json(502, {"error": str(error)})

        if url.path == "/api/transit/vehicles":
            query = urllib.parse.parse_qs(url.query)
            try:
                south, west, north, east = (
                    float((query.get(name) or [""])[0])
                    for name in ("south", "west", "north", "east"))
                assert -90 <= south <= north <= 90
                assert -180 <= west <= 180 and -180 <= east <= 180
            except Exception:  # noqa: BLE001
                return self.send_json(400, {"error": "Bad parameters"})
            try:
                return self.send_json(200, get_gps_vehicles(south, west, north, east))
            except Exception as error:  # noqa: BLE001
                print(f"Transit GPS relay failed ({error})")
                return self.send_json(502, {"error": str(error)})

        if url.path == "/api/transit":
            query = urllib.parse.parse_qs(url.query)

            def one(name):
                return (query.get(name) or [""])[0]

            kind = one("kind")
            corner = r"-?\d{1,2}(\.\d{1,6})?,-?\d{1,3}(\.\d{1,6})?"
            stamp = r"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ"
            if kind == "details":
                params = {"routeIdx": one("routeIdx")}
                valid = re.fullmatch(r"\d{1,9}", params["routeIdx"])
            elif kind == "stops":
                params = {"min": one("min"), "max": one("max"),
                          "grouped": one("grouped") or "true", "modes": one("modes")}
                valid = (re.fullmatch(corner, params["min"])
                         and re.fullmatch(corner, params["max"])
                         and params["grouped"] in ("true", "false")
                         and re.fullmatch(r"[A-Z_,]{1,200}", params["modes"]))
            elif kind == "stoptimes":
                params = {"stopId": one("stopId"), "n": one("n") or "30",
                          "arriveBy": one("arriveBy") or "false",
                          "direction": one("direction") or "LATER", "mode": one("mode")}
                valid = (re.fullmatch(r"[^\x00-\x1f]{1,200}", params["stopId"])
                         and re.fullmatch(r"\d{1,2}", params["n"])
                         and params["arriveBy"] in ("true", "false")
                         and params["direction"] in ("EARLIER", "LATER")
                         and re.fullmatch(r"[A-Z_,]{1,200}", params["mode"]))
            else:
                params = {"zoom": one("zoom"), "min": one("min"), "max": one("max")}
                valid = (kind in TRANSIT_PATHS
                         and re.fullmatch(r"\d{1,2}", params["zoom"])
                         and re.fullmatch(corner, params["min"])
                         and re.fullmatch(corner, params["max"]))
            if valid and kind == "trips":
                params.update(startTime=one("startTime"), endTime=one("endTime"),
                              precision=one("precision") or "5")
                valid = (re.fullmatch(stamp, params["startTime"])
                         and re.fullmatch(stamp, params["endTime"])
                         and re.fullmatch(r"[0-6]", params["precision"]))
            if not valid:
                return self.send_json(400, {"error": "Bad parameters"})
            try:
                status, body, gzipped = get_transit(kind, params)
            except Exception as error:  # noqa: BLE001
                print(f"Transitous failed ({error})")
                return self.send_json(502, {"error": str(error)})
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            if gzipped:
                self.send_header("Content-Encoding", "gzip")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return

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
          "Routes: adsbdb only. Add AIRLABS_API_KEY to .env for better routes.")
    print("Ships: aisstream key found (worldwide, listening from now on)"
          if AISSTREAM_API_KEY else
          "Ships: no aisstream key (AISSTREAM_API_KEY in .env gives a live worldwide feed).")
    print("Ships: Pelyr key found (fills in the area on screen)"
          if PELYR_API_KEY else
          "Ships: no Pelyr key. Add PELYR_API_KEY to .env to fill in the area on screen faster.")
    print("Ships: VesselAPI key found (backup, used only if the others stop delivering)"
          if VESSELAPI_KEY else
          "Ships: no VesselAPI key (optional backup: VESSELAPI_KEY in .env).")
    load_gps_feeds()
    print("Transit GPS: "
          + ("TransLink key found" if TRANSLINK_API_KEY
             else "no TransLink key (TRANSLINK_API_KEY in .env for Vancouver's buses)")
          + "; feeds elsewhere looked up in: "
          + (", ".join(name for name, on in (("Transitland", TRANSITLAND_API_KEY),
                                             ("Mobility Database", MOBILITY_DATABASE_REFRESH_TOKEN))
                       if on)
             or "nothing (TRANSITLAND_API_KEY / MOBILITY_DATABASE_REFRESH_TOKEN in .env)"))
    print("Rail: Finland, Norway and Amtrak / VIA / Brightline need no key (the page asks them itself)")
    print("Rail: Trafikverket key found (Sweden, passenger + freight)"
          if os.environ.get("TRAFIKVERKET_API_KEY", "").strip() else
          "Rail: no Trafikverket key (TRAFIKVERKET_API_KEY in .env for Sweden).")
    if AISSTREAM_API_KEY or PELYR_API_KEY or VESSELAPI_KEY:
        load_ships()
        start_ship_stream()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("Stopping")
    finally:
        save_ships()
