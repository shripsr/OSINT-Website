# OSINT-Website
## Working on the code (TypeScript)

The browser code is written in TypeScript in `src/` and compiled to the
`flights.js`, `transit.js` and `script.js` files that `index.html` loads.

| File | What it is |
|---|---|
| `src/flights.ts` | Live flights, airports, routes and timetables |
| `src/transit.ts` | Transit line maps and live transit vehicles (Transitous) |
| `src/script.ts` | Map setup, search, saved locations |
| `src/types.d.ts` | Shared types (aircraft, airports, routes, ...) |
| `src/globals.d.ts` | Things loaded by `<script>` tags (MapLibre, `config.js`) |
| `flights.js`, `transit.js`, `script.js` | **Generated. Don't edit these**, edit the `.ts` files |

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

`server.py` is unchanged: run it as before and refresh the page after a build.
