/**
 * The password vault, as one removable piece.
 *
 * Everything under this folder — the crypto, the store, the CSV reader, the
 * routes — belongs to this feature and nothing else imports it. Deleting the
 * folder leaves the server booting normally with `/api/vault/*` returning 404,
 * which is what `registerFeature` reports as "not installed".
 *
 * The browser extension in `packages/extension` is part of this feature too. It
 * needs no build step and nothing imports it, so it is removed by deleting it.
 *
 * What does *not* go away is the database schema: `vault` and `vault_entries`
 * are created by migration 0007 regardless. Migrations are a linear journal and
 * skipping one would break every later hash, so the tables stay — empty and
 * inert. That is the honest boundary of "removable" here.
 */
export { vaultRoutes as routes } from './routes.js';
