# Manga

A reading list and reader, through Suwayomi (which this package can download
and run), with a nudge when a chapter you are waiting for lands. Friends' copies
share the host's Suwayomi and its Local collection.

| Where | What |
| --- | --- |
| `server/index.ts` | Registers the routes and runs the release sweep. |
| `server/routes/` | The API, one file per group: library, source, extensions, browse, reading, archive, host. What several share is `routes/shared.ts`. |
| `server/library.ts` | The store, `data/manga.json`. |
| `server/suwayomi.ts`, `process.ts`, `setup.ts` | Talking to Suwayomi, starting it, and setting it up. |
| `server/releases.ts` | The sweep that notices new chapters. |
| `server/archive.ts`, `page-cache.ts` | Keeping chapters for good, and the last ten read. |
| `web/view.tsx` | The screen: Browse, Library, History, Downloads, More. |
| `web/Reader.tsx` | The reader. `chapter-nav.ts` decides what "next" is. |
| `web/offline-store.ts`, `reading-log.ts` | Downloads to the device, and the reading log written there first. |
| `web/manga-api.ts` | Its client. `web/manga.css` has its styles. |

`npm run manga-check -w @everything/server` proves the rules. CLAUDE.md,
"Manga is laid out like a reader", has the reasons.
