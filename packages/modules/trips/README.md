# Trips

Trips with a map, flights you can track, places and a checklist, each feeding
the to-do list, so "leave for the airport" is a reminder the nudge engine holds
and delivers like any other.

| Where | What |
| --- | --- |
| `server/index.ts` | Its API. |
| `server/store.ts` | `data/trips.json`, never written over a damaged file. |
| `server/live.ts` | Live flight status (AeroDataBox), and the one timeout that watches flights. |
| `server/flights.ts`, `airports.ts`, `places.ts` | Flight times, airports, and finding places. |
| `server/tasks.ts`, `rules.ts` | Turning a trip into tasks, and the rules for keeping them in step. |
| `web/view.tsx`, `TripMap.tsx` | The screen and its map (Leaflet). |
| `web/trips-api.ts` | Its client. `web/trips.css` has its styles. |

`npm run trips-check -w @everything/server` proves the rules.
