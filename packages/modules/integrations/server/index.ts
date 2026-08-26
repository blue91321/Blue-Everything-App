/**
 * App integrations, as one removable piece.
 *
 * Everything under this folder belongs to this feature and nothing outside it
 * imports it. Deleting the folder leaves the server booting normally with
 * `/api/integrations/*` returning 404, which is what `registerFeature` reports
 * as "not installed".
 *
 * What does *not* go away is the schema: migration 0019 creates
 * `integration_accounts`, `media_items`, `media_collections`,
 * `media_collection_items`, `media_plays` and `friends` regardless. Migrations
 * are a linear journal and skipping one breaks every later hash, so the tables
 * stay — empty and inert. Same boundary the vault has.
 *
 * The env vars in `config.ts` stay too, and that is deliberate rather than an
 * oversight: `config.ts` is the one file allowed to read `process.env`, and
 * moving a provider's client id into this folder to make the deletion tidier
 * would break that rule for a handful of strings that cost nothing when unset.
 */
export { integrationRoutes as routes } from './routes.js';
