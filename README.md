# OSINT-Website
## Working on the code (TypeScript)

The browser code is written in TypeScript in `src/` and compiled to the
`flights.js`, `transit.js`, `ships.js`, `rail.js` and `script.js` files that `index.html` loads.

| File | What it is |
|---|---|
| `src/flights.ts` | Live flights, airports, routes and timetables |
| `src/transit.ts` | Transit line maps and live transit vehicles (Transitous; real GPS positions from TransLink, MBTA and feeds found via Transitland / Mobility Database when their keys are in `.env`) |
| `src/ships.ts` | Live ship positions (AIS: worldwide from aisstream.io and Pelyr with `AISSTREAM_API_KEY` / `PELYR_API_KEY` in `.env` (`VESSELAPI_KEY` as a backup), otherwise Finland / northern Baltic from Digitraffic) |
| `src/rail.ts` | Live train positions: passenger + freight in Finland (Digitraffic), Amtrak / VIA Rail / Brightline (Amtraker), Norway (Entur); Sweden (passenger + freight) with `TRAFIKVERKET_API_KEY` in `.env` |
| `src/script.ts` | Map setup, search, saved locations |
| `src/types.d.ts` | Shared types (aircraft, airports, routes, ...) |
| `src/globals.d.ts` | Things loaded by `<script>` tags (MapLibre, `config.js`) |
| `flights.js`, `transit.js`, `ships.js`, `rail.js`, `script.js` | **Generated. Don't edit these**, edit the `.ts` files |

One-time setup (needs [Node.js](https://nodejs.org)):

```
npm install
```

Then, while working:

```
npm run watch     # rebuilds the .js files every time you save a .ts file
npm run build     # build once
npm run check     # only report type errors, write nothing
```

Run `python server.py` as before and refresh the page after a build.

## Running it

```
python server.py
```

then open <http://localhost:8080>. The map works without any key. Keys in `.env`
(copy `.env.example`, git-ignored, never sent to the browser) only make some
layers better. When it starts, the terminal says which keys it found and which
layers fall back to the free sources.

| Layer (sidebar) | Works without a key? | Keys that improve it |
|---|---|---|
| Flights | Yes | `OPENSKY_CLIENT_ID` + `OPENSKY_CLIENT_SECRET`, `AIRLABS_API_KEY` |
| Transit | Yes (estimated positions) | `TRANSLINK_API_KEY`, `TRANSITLAND_API_KEY`, `MOBILITY_DATABASE_REFRESH_TOKEN` |
| Ships | Yes, but only Finland / the Baltic | `AISSTREAM_API_KEY`, `PELYR_API_KEY`, `VESSELAPI_KEY` |
| Rail | Yes (Finland, Norway, USA/Canada) | `TRAFIKVERKET_API_KEY` (Sweden) |

If you open `index.html` as a plain file instead of through `server.py`, the
layers that can ask their sources directly still work, but anything that needs
a key (or `server.py`'s caching) does not.


## Flights: where it works

Live aircraft, worldwide, wherever volunteers run ADS-B receivers (very good in
Europe, North America, Japan and Australia; thin over oceans, Africa, Russia
and parts of Asia). Military and some private aircraft can be hidden by their
owners, so they won't always appear.

| What | Source | Key needed? |
|---|---|---|
| Aircraft on screen | adsb.fi, airplanes.live, adsb.lol (tried in this order, through `server.py`) | No |
| Whole-world view (zoomed far out) | OpenSky Network | No (anonymous: refreshes every 15 min). With `OPENSKY_CLIENT_ID` / `OPENSKY_CLIENT_SECRET`: every 90 s |
| Route (from / to) of a clicked aircraft | adsbdb, then AirLabs when a key is set | No / optional `AIRLABS_API_KEY` |
| Aircraft photos | Planespotters.net (photographer credited in the popup) | No |
| Airports and their timetables | `airports.csv` (OurAirports) | No |

Notes:

- Flights are asked for by map area, so zoom in to see them all; zoomed far out
  you get OpenSky's slower snapshot instead.
- The search box and the watchlist find one aircraft anywhere in the world by
  ICAO hex, callsign or registration. The watchlist is saved in your browser.
- Personal, non-commercial use only. Credit adsb.fi.

### How the APIs are connected

The browser asks `server.py` (`/api/aircraft`, `/api/opensky`, `/api/route`,
`/api/photo`, `/api/airports`, ...), which relays to the feeds above. This avoids
browser CORS blocking and keeps to the feeds' rate limits (about one request a
second). Your OpenSky and AirLabs keys live only in `.env`. If `server.py` is
not running, the browser asks the ADS-B feeds directly.


## Transit: where it works

Line maps, stations and vehicles for public transport (trains, metro, trams,
buses, ferries, cable cars), wherever operators publish open timetables, which
is most of Europe, North America, Australia, New Zealand and parts of Asia. Zoom
in to see lines (zoom 9 and up; zoom 8 shows railways only).

| What | Source | Key needed? |
|---|---|---|
| Lines, stations, departures and arrivals | Transitous (transitous.org), built from open timetables | No |
| Vehicle positions | **Estimated** from the timetable (plus real-time delays where the operator publishes them) | No |
| **Real GPS** vehicle positions | TransLink (Vancouver), MBTA (Boston) and the free cities below, plus feeds found through Transitland and the Mobility Database | `TRANSLINK_API_KEY`, `TRANSITLAND_API_KEY`, `MOBILITY_DATABASE_REFRESH_TOKEN` |
| **Real GPS**, free, built in | Helsinki (HSL), Norway (Entur, all buses / trams / metro / ferries), the Netherlands (OVapi), Toronto (TTC), Calgary, Edmonton, Denver (RTD), Austin (CapMetro), Philadelphia (SEPTA), Rome and Vilnius | No (the list is `GPS_FREE_FEEDS` in `server.py`; add a city by adding a line) |

Notes:

- Icons with a **white outline** use real-time data; icons with a **grey
  outline** are timetable only. Without a key you only get estimates, so a
  vehicle can be a little off where it really is.
- Transit and **Rail Tracking** are separate: Transit covers every kind of
  public transport but mostly estimates; Rail Tracking shows real GPS positions
  of trains in a few countries (see below).

### How the APIs are connected

Transitous is asked through `server.py` (`/api/transit`, cached), or directly by
the browser if the server isn't running. Real GPS feeds are read by `server.py`
(`/api/transit/vehicles`): it looks up the feeds covering the area on screen in
Transitland and the Mobility Database (needs their keys), remembers them in a
dotfile cache, and polls them while a page is looking. Add the keys to `.env`
and restart `server.py`; the terminal then prints which of them it found.


## Ships: where it works

Live AIS positions of vessels, coloured by kind (cargo, tanker, passenger, high-speed
craft, fishing, tug / service, pleasure craft, military / authority). Click a
ship for its destination, ETA, flag, size, a photo when a free one exists, and
the path it has taken.

| Where | Source | Key needed? |
|---|---|---|
| Finland and the northern Baltic Sea | Digitraffic (Fintraffic) AIS, CC BY 4.0 | No |
| Worldwide, wherever AIS receivers hear ships | aisstream.io | Yes: `AISSTREAM_API_KEY` |
| Worldwide, fills the area on screen at once | Pelyr (free key is non-commercial; credited in the popup) | Yes: `PELYR_API_KEY` |
| Backup if the two above stop delivering | VesselAPI (free plan: 150 requests a month) | Yes: `VESSELAPI_KEY` |

Notes:

- **Without a key you only see ships around Finland**; the rest of the map
  stays empty.
- Ships are shown if heard in the last half hour. Ships under way glide along
  their course between updates (up to 3 minutes past their last report).
- aisstream is a live stream, so after you start the server the picture fills in
  over several minutes; the server saves what it knows to `.ships_cache.json`
  every two minutes and reloads it next time.

### How the APIs are connected

With a key, `server.py` keeps a connection open to aisstream.io, remembers every
ship it hears, and the page asks it for the ships in the area on screen
(`/api/ships`, every 10 s). Pelyr and VesselAPI are asked over HTTPS only while a
page is looking. With no key, or if `server.py` isn't running, the browser
asks Digitraffic directly. The keys stay in `.env`. The terminal prints which
ship keys it found at startup.


## Rail tracking: where it works

Rail Tracking (the **Rail Tracking** switch in the sidebar) only shows trains in
the places below. Everywhere else the map is simply empty: there is no worldwide
open feed of train positions.

| Place | Trains | Source | Key needed? |
|---|---|---|---|
| Finland | Passenger, commuter, **freight**, locomotives | Digitraffic (Fintraffic), CC BY 4.0 | No |
| Norway | Passenger and commuter (Vy, SJ Norge, Go-Ahead, Flytoget) | Entur, NLOD | No |
| USA and Canada | Passenger only: Amtrak, VIA Rail, Brightline | Amtraker | No |
| Sweden | Passenger and **freight** (which is which is guessed from the train number) | Trafikverket Open API | Yes: `TRAFIKVERKET_API_KEY` |

Notes:

- **Freight** positions are only published openly in Finland and Sweden. Freight
  in North America, the rest of Europe, Australia and Asia is not public (paid,
  business-only services only).
- Japan and Taiwan publish only the station a train is at, not GPS, so they are
  not included. Other cities' commuter trains can appear in the **Transit**
  layer when their feeds are found through Transitland / Mobility Database.
- A feed that is down, or whose key is missing, is skipped; the rest keep
  working. Hover the Rail Tracking switch to see which sources are failing.

### How the APIs are connected

Three of the sources are asked **directly by the browser** and need nothing set up:
Finland, Norway and Amtrak. They are fetched by `src/rail.ts` every 10 to 45 seconds.

The keyed source (Sweden) goes through `server.py`, so the key stays on
your computer and are never sent to the browser:

1. Get a free key from <https://data.trafikverket.se> (the Open API).
2. Copy `.env.example` to `.env` (once) and fill in the key, no quotes or spaces:

   ```
   TRAFIKVERKET_API_KEY=yourkeyhere
   ```

3. Start (or restart) the server from a terminal in this folder:

   ```
   python server.py
   ```

4. The terminal then says whether it found the key, for example:

   ```
   Rail: Finland, Norway and Amtrak / VIA / Brightline need no key (the page asks them itself)
   Rail: Trafikverket key found (Sweden, passenger + freight)
   ```

5. Open <http://localhost:8080>, switch on **Rail Tracking**. The page asks
   `server.py` at `/api/rail`, which calls Trafikverket (at most once every
   20 seconds, shared by every open tab) and hands back the trains.

A wrong key shows up as an error line on the switch's tooltip (for example
`HTTP Error 401`), not in the terminal. If you open `index.html` as a plain file
instead of through `server.py`, only Finland, Norway and Amtrak work.
