# Development

Use a local-disk checkout and Node 22.13.0+. Install from the committed lockfile; ordinary development needs no frontend build.

```powershell
npm ci
.\scripts\new-dev-cert.ps1 -DnsNames @('localhost')
npm test
node scripts/watch-demo.js --accounts
```

Generate certificates only on a fresh checkout. The script refuses to overwrite them and installs no trust root. Without test certificates, 13 tests skip: inspect the summary, not merely the exit status.

Keep production environment variables/configuration, databases, keys and certificates out of this checkout. Start/dev/demo npm scripts load `.env` if present. The explicit fixture-demo command does not load an environment file but still inherits process environment; use a clean shell without production Plex/Discord credentials.

Relevant Firefox fixtures:

```powershell
node scripts/watch-smoke.js --accounts
node scripts/watch-smoke.js --tracking --blocked
node scripts/watch-smoke.js
node scripts/plex-library-smoke.js
```

Use the standard Windows Firefox location or set `FIREFOX_BINARY`. Checks create disposable profiles. The full `scripts/firefox-smoke.js` check has an unresolved permission/rate-limit failure and is deferred; it binds localhost 6767/9443 when run. Fixtures do not prove real YouTube TV or Activity behavior.

Use small branches, explicit reviewed staging and `git diff --check`. Run `npm run build:player` only when updating the SDK bundle; retain generated notices. Personal notes and upstream reference checkouts belong outside the repository. Read testing.md for unfinished checks and design-guide.md before UI changes.
