# Weather

The forecast, on a screen and a Dashboard panel, from Open-Meteo, which needs
no account. Fetched when it is read and more than a day old (or an hour, or
only when you press the button), never on a timer.

| Where | What |
| --- | --- |
| `server/index.ts` | Its API. |
| `server/weather.ts` | Fetching, the staleness rules, and finding the hour that is now. |
| `web/view.tsx`, `panel.tsx` | The screen with its hourly graph, and the panel. |
| `web/weather-api.ts` | Its client. `web/weather.css` has its styles. |

`npm run weather-check -w @everything/server` proves the rules; add `-- --live`
to fetch for real.
