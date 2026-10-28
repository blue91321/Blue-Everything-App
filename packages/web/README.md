# @everything/web

The app: a React PWA, served by the server. React and ReactDOM are its only
runtime dependencies (plus Leaflet, inside the Trips screen's own chunk). There
is no router and no state library: the screen on show is a `useState` in
`App.tsx`, and data loading is `useAsync.ts`.

```bash
npm run build -w @everything/web      # into dist/, which the server serves
npm run dev -w @everything/web        # hot reload, proxying /api to :8787
```

| Where | What |
| --- | --- |
| `src/main.tsx`, `src/App.tsx` | Start-up, the drawer, navigation and onboarding. |
| `src/views/` | Core's screens: Dashboard, Tasks, Habits, Notes, Settings. Settings has one file per tab in `views/settings/`. |
| `src/api.ts` | Talking to the server, with offline reads and queued changes. Reply shapes are in `api-types.ts`. |
| `src/features/index.ts` | Finds every package's `web/meta.ts`, `view.tsx`, `panel.tsx` and `offline.tsx` with `import.meta.glob`. |
| `src/live.ts` | The live-update stream: every screen refetches when something changes anywhere. |
| `src/offline-sync.ts`, `offline-effects.ts` | Working without the server: kept reads and the outbox. |
| `src/styles.css` | Core's styles, in parts in `src/styles/`, in cascade order. Packages bring their own. |
| `src/theme.ts`, `Logo.tsx` | Theme, accent and the app's mark. |
| `scripts/make-icons.mjs` | The icons that must be files, and two build-time checks on the stylesheets. |

**This bundle does not import `@everything/shared`** (its zod would cost 14KB),
so reply types are declared in `api-types.ts`. A package's screens import from
core as `@app/…` and talk to their own endpoints through their own client
(`packages/modules/<id>/web/<id>-api.ts`).
