# NV store — admin backend

A small Node server that puts the catalogue behind a password so books and
services can be added, edited, and removed without touching HTML.

No npm install. It uses only Node's standard library.

## Setup

Install Node 18 or newer, then from the `nv-store` folder:

```bash
node server/set-password.js
```

Choose a password of at least 10 characters. Input is hidden as you type. The
password itself is never stored — `server/data/admin.json` holds a random salt
and an scrypt hash.

For scripted setup, `NV_ADMIN_PASSWORD=... node server/set-password.js` skips
the prompt.

```bash
node server/server.js
```

- Site: <http://localhost:8080>
- Admin: <http://localhost:8080/admin.html>

Use `PORT=3000 node server/server.js` to change the port.

## How the front end uses it

`index.html` renders its catalogue from data, not hard-coded markup. On load it
draws the copy baked into the page, then asks `/api/catalogue`. If the server
answers, that data replaces it.

This means the page still works with no backend at all — opened as a file, or
published as a static artifact. It simply shows the built-in catalogue and the
admin has nothing to talk to.

## Keeping the static copy in sync

The running site reads `/api/catalogue`, so admin edits show up there at once.
`index.html` also carries a copy of the catalogue for when there is no server —
opening the file directly, or a published static build. That copy does not
update itself:

```bash
node server/sync-page.js
```

Run it after editing, then rebuild or republish the static copy.

## API

| Method | Path              | Access | Purpose                  |
|--------|-------------------|--------|--------------------------|
| GET    | `/api/catalogue`  | public | All items                |
| GET    | `/api/session`    | public | Am I signed in?          |
| POST   | `/api/login`      | public | Start a session          |
| POST   | `/api/logout`     | public | End it                   |
| POST   | `/api/items`      | admin  | Create an item           |
| PUT    | `/api/items/:id`  | admin  | Replace an item          |
| DELETE | `/api/items/:id`  | admin  | Remove an item           |

## What protects the admin routes

- **Password**: scrypt with a per-install random salt; compared in constant
  time so the comparison cannot be used to guess the hash byte by byte.
- **Session**: a 32-byte random token in an `HttpOnly`, `SameSite=Strict`
  cookie, expiring after 8 hours. `HttpOnly` keeps it out of reach of any
  script on the page.
- **Rate limiting**: 8 failed logins per IP per 15 minutes.
- **Input validation**: every field is type-checked, length-capped, and
  rebuilt server-side, so the API cannot be used to store arbitrary shapes.
- **Path traversal**: static paths must resolve inside the project, and
  `server/data/` is never served over HTTP.
- **Writes**: the catalogue is written to a temp file and renamed, so an
  interrupted write cannot truncate it.

## Before putting this on the internet

This is a sound local setup, but it is not yet a public deployment:

1. **Serve over HTTPS.** The session cookie is only marked `Secure` when
   `NODE_ENV=production` — set it, and terminate TLS in front of the server.
   Over plain HTTP the cookie can be read in transit.
2. **Sessions live in memory.** Restarting the server signs everyone out, and
   this will not work across multiple processes.
3. **One shared password, no user accounts.** There is no audit trail of who
   changed what.
4. **No backups.** `server/data/catalogue.json` is the only copy.
