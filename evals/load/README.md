# Load and failure tests

Prod's stack (`deploy/compose.yaml`) on a dev machine, capped to the Hetzner CX23 that runs
starbridge.run (2 vCPU, 4 GB), with clients that behave like the agent, the phone and the web
page. Results are in `SPEC.md`, "The hosted instance". Nothing here talks to
starbridge.run.

Needs Docker with Compose 2.24 or later, Bun, `jq` and `openssl`. Scratch files go to
`$LOAD_DIR` (default `.scratch/load` in the repository, which git ignores).

## Run

```bash
evals/load/stack.sh up                         # build and start; Caddy on 127.0.0.1:18000
bun evals/load/fake.ts --host 172.17.0.1       # fake GitHub and push services, left running
bun evals/load/setup.ts --users 3000           # accounts, each with a phone, a machine and a page
bun evals/load/load.ts --ramp 300,1000,2000,3000 --stage 180 --procs 6
evals/load/stack.sh down                       # stop and delete the volumes
```

`--host` is the host's address on Docker's default bridge
(`docker network inspect bridge -f '{{(index .IPAM.Config 0).Gateway}}'`). Containers share the
cores in `LOAD_CPUS` (default `8,9`); pick two the load script does not need.

- `stack.sh` lays `compose.yaml` over prod's, with fake secrets, prod's Caddyfile on plain HTTP,
  and the memory and CPU caps.
- `fake.ts` stands in for GitHub's OAuth, FCM and Web Push; each push takes 80 ms, as FCM does.
- `setup.ts` makes users through the real sign-in and pairing flows (`accounts.ts`), straight to
  the server so the per-address limits do not slow it down.
- `load.ts` runs the users through Caddy and prints a line every 10 s and a summary per stage:
  requests per second, p50 and p99 of every request that is not a long-poll, how long an answer
  takes to reach its machine, and each container's memory and CPU. It stops at the first stage
  whose p99 passes 1 s, or when the server dies. At the end it stops posting and counts answers
  that never reached their machine, answers that reached it twice, and decisions no page saw.

What each user does, from the clients' code:

| Who | What | How often |
|---|---|---|
| machine | `GET /answers?wait=60` long-poll | always one open |
| machine | `GET /directory` | every 10 min |
| machine | decision, sealed to phone and page (1.5 KB each) | `--decisions` an hour (6) |
| machine | run with 6 updates 20 s apart | `--runs` an hour (4) |
| machine | quota snapshot (2 KB each), 9 in 10 quiet | every 5 min |
| phone or page | answer (600 B) | `--answer` s after the decision (60) |
| page (`--pages` of users, all) | inbox, open prompts and settled polls | every `--poll` s (20; 5 until a push arrives) |
| page | runs poll | every 10 s |
| page | quota poll | every 60 s |
| page | `GET /joins?wait=25` long-poll | always one open |
| page | loads `/` | every 5 min |

## Launch spike

`spike.ts` adds what a front-page post brings on top of `load.ts`'s users: visitors arriving at
`--rates` per second, one stage each, who load the landing page as a browser does (the page,
its scripts, styles, fonts and pictures, `/v1/me`, Umami's script and one event). A share
(`--docs`) then opens `/docs` and the FAQ, a share
starts the GitHub sign-in (`--signin`) and a share sets Starbridge up through Caddy
(`--signup`), then tries it: a first question with a picture, more every `--every` s, each
answered after about 20 s. Each visitor sends its own address in `X-Sim-IP`, which the test
Caddyfile hands on as the client's, so the per-address limits see one address per visitor;
`--nat` of them share `--nat-ips` addresses. A stage fails when the page's p99 passes `--slow`
ms or over 1% of requests fail.

```bash
evals/load/stack.sh load --ramp 1000 --until /load/stop --procs 4 &   # the earlier users
evals/load/stack.sh spike --rates 2,5,10,20,40 --stage 120
```

`LOAD_CLIENT_CPUS` pins either client container to other cores than the stack's.

## Failure tests

Each runs `load.ts` with `--until FILE`: it keeps its users going until FILE exists, then drains
and reports what was lost or duplicated, plus a probe that loads `/` and `/healthz` every 100 ms.

```bash
bun evals/load/load.ts --ramp 1000 --until $LOAD_DIR/stop --procs 6   # in one terminal
docker kill starbridge-load-server-1                                    # kill the server,
docker start starbridge-load-server-1                                   # then start it again
evals/load/stack.sh deploy                                              # or roll out, as prod does
touch $LOAD_DIR/stop                                                    # then end the run
```

`unless-stopped` does not bring back a container that `docker kill` stopped, as it does one that
crashed or was OOM-killed, so the test starts it by hand.

Full disk: `stack.sh small-disk 256` moves the server's data onto a 256 MB tmpfs (it needs
`sudo`); fill it during a run, free it, then go back with `stack.sh big-disk`.

```bash
docker exec starbridge-load-server-1 sh -c 'cat /dev/zero > /data/fill'
docker exec starbridge-load-server-1 rm /data/fill
```

### Lost or late

At the end, `load.ts` writes the ids of answers the server took but no machine got, and of
decisions no page saw, to `$LOAD_DIR/lost.txt`. The ones the server holds were late, not lost:

```bash
docker exec -e IDS="$(paste -sd, $LOAD_DIR/lost.txt)" starbridge-load-server-1 bun -e '
const db = new (require("bun:sqlite").Database)("/data/starbridge.db", { readonly: true });
const q = db.query("SELECT COUNT(*) n FROM items WHERE id = ?");
const ids = process.env.IDS.split(",");
console.log(ids.reduce((n, id) => n + q.get(id).n, 0), "of", ids.length, "stored")'
```

`nat.ts` has 20 users set up from one address within a minute, as an office would, and prints
the per-address limits they hit.

```bash
bun evals/load/nat.ts --users 20 --spread 60
```

`--idle K` holds K answer long-polls per machine and nothing else, to read the memory each open
connection costs from the per-window memory lines.

## Reading the numbers on a shared machine

Each line's `cpu%` has a `wait` per container: the share of the window it spent waiting for a
core. The containers are pinned to `LOAD_CPUS` but other processes are not kept off those
cores, so a window with much waiting measures the machine, not the stack.

## Restore drill

`deploy/README.md`, "Restore", on this stack: stop the server, copy a backup over
`starbridge.db` in the `starbridge-load_data` volume, delete `-wal` and `-shm`, `chown 1000:1000`,
start it; then `pg_restore` Umami's dump into `umami-db`. Copy the database aside first and put
it back after; delete the backup copies and the `starbridge-load_umami-db` volume when done.
