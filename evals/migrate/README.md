# Migration rehearsal

Runs a candidate server's migrations on a database shaped like prod's and as large as the hosted
caps let it grow, before prod runs them (#1543). No row comes from prod: each night the VPS
sends offsite only prod's schema (`deploy/host/offsite.sh`): `PRAGMA user_version` and the CREATE
statements, with no rows. sb-staging runs the rehearsal every night on main's newest images
(starbridge-planning, `infra/sb-staging/`).

```bash
evals/migrate/rehearse.sh --schema schema-20261013.sql --from <prod's commit> --to <candidate>
```

It fails when:

- prod's schema differs from what the migrations at prod's commit make from nothing: a hand edit,
  or a migration changed after it shipped;
- the candidate's server takes over 30 s (`--limit`) to answer `/healthz` on the filled database,
  the time Caddy holds requests while the server restarts (`spec/server.md`);
- the candidate's migrations leave a schema other than the one it makes from nothing.

Both servers are the images `deploy.yml` pushed to ghcr.io for those commits. The seed is made
once per schema at prod's commit and kept in `$REHEARSE_DIR` (default `.scratch/migrate`):

1. `schema.ts load` builds a database from the export, with the rows the migrations insert.
2. The server at prod's commit runs on it, with GitHub and the push services faked
   (`../load/fake.ts`), and `../load/setup.ts` makes `--users` users (3000) through the real
   sign-in and pairing flows.
3. `fill.ts` gives each `--decisions` decisions (20), half of them answered, a run and a quota
   snapshot, through the API.
4. `grow.ts` copies those items and their boxes until the file reaches `--mb` (2048), the 2 GB
   that the server-wide cap lets machines store (`spec/server.md`, "Server-wide cap").

The last line printed, also kept in `result.json`, is one JSON object: `ok`, both commits and
schema versions, `ms` to `/healthz`, and a `detail` line. Needs Docker; every container and the
`sb-rehearse` network are removed at the end.
