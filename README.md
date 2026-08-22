# NV Store

A one-page site for NV — books and services — with a scroll-scrubbed film hero,
a browsable catalogue, a cart, a sample reader, and a password-protected admin
backend for editing the catalogue.

## Running it

Needs Node 18 or newer. Nothing to install — the server uses only Node's
standard library.

```bash
node server/set-password.js
```
```bash
node server/server.js
```

- Site: <http://localhost:8080>
- Admin: <http://localhost:8080/admin.html>

See [server/README.md](server/README.md) for the API, what protects the admin
routes, and what still needs doing before this faces the internet.

## Layout

| Path | What it is |
|------|------------|
| `index.html` | The whole site — markup, styles, and behaviour in one file |
| `admin.html` | Sign-in and the catalogue editor |
| `server/server.js` | HTTP server, auth, and the catalogue API |
| `server/set-password.js` | Sets the admin password (stores a salted hash) |
| `server/sync-page.js` | Bakes the live catalogue into `index.html` |
| `server/data/catalogue.json` | The catalogue itself |
| `assets/` | Hero video, poster, founder photographs |
| `nv-editions-standalone.html` | Single-file build with every asset inlined |

## The two catalogues

The running site fetches `/api/catalogue`, so admin edits appear immediately.
`index.html` also carries a copy for when there is no server — opened as a file,
or hosted statically. That copy does not update itself:

```bash
node server/sync-page.js
```

Run that after editing, and the standalone build will match too.

## Notes

- `server/data/admin.json` is deliberately not in this repository. It holds the
  password hash for one install. Create your own with `set-password.js`.
- The catalogue ships with placeholder book titles. Service names, scopes, and
  prices are drafts and should be confirmed before they are published as real
  offerings.
