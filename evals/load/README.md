# Load and failure tests

Prod's stack (`deploy/compose.yaml`) on a dev machine, capped to the Hetzner CX23 that runs
starbridge.run (2 vCPU, 4 GB), with clients that behave like the agent, the phone and the web
page. Results and their dates are in `SPEC.md`, "Research log". Nothing here talks to
starbridge.run.

Needs Docker with Compose 2.24 or later, Bun, `jq` and `openssl`. Scratch files go to
`$LOAD_DIR` (default `~/work/starbridge/.scratch/load`).

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
| page (`--pages` of users, all) | inbox, open prompts and settled polls | every 20 s |
| page | runs poll | every 10 s |
| page | quota poll | every 60 s |
| page | `GET /joins?wait=25` long-poll | always one open |
| page | loads `/` | every 5 min |

## Failure tests

Each runs `load.ts` with `--until FILE`: it keeps its users going until FILE exists, then drains
and reports what was lost or duplicated, plus a probe that loads `/` and `/healthz` every 100 ms.

```bash
bun evals/load/load.ts --ramp 3000 --until $LOAD_DIR/stop --procs 6   # in one terminal
docker kill starbridge-load-server-1                                    # kill the server
evals/load/stack.sh deploy                                              # or roll out, as prod does
touch $LOAD_DIR/stop                                                    # then end the run
```

Full disk: start the server on a 64 MB tmpfs, fill it, run load, then free it.

```bash
LOAD_EXTRA=evals/load/small-disk.yaml evals/load/stack.sh compose up -d server
docker exec starbridge-load-server-1 sh -c 'cat /dev/zero > /data/fill'
```

`nat.ts` has 20 users set up from one address within a minute, as an office would, and prints
the per-address limits they hit.

```bash
bun evals/load/nat.ts --users 20 --spread 60
```

`--idle K` holds K answer long-polls per machine and nothing else, to read the memory each open
connection costs from the per-window memory lines.
