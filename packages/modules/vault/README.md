# Password vault

Encrypted password storage, import from browsers and other password managers,
and a browser extension that fills logins. It starts switched off; turn it on
in Settings → Packages.

| Where | What |
| --- | --- |
| `server/crypto.ts` | Argon2id and AES-256-GCM, from Node's own crypto. No crypto dependencies. |
| `server/store.ts`, `session.ts` | The encrypted entries, and unlocking and auto-locking. |
| `server/import.ts` | Reading password exports. |
| `server/routes.ts` | Its API, `/api/vault/*`. |
| `web/Vault.tsx` | The screen. `web/vault-api.ts` is its client. |
| `extension/` | The browser extension (Manifest V3, loaded unpacked). |

`npm run vault-check` proves the cryptography, `npm run vault-api` the routes,
and `npm run import-check` the CSV reader (each with `-w @everything/server`).
