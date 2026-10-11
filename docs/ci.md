# CI runners

Most CI jobs run on GitHub's runners. Some run on three self-hosted Linux boxes, which start them
sooner. Windows, macOS, the desktop app's e2e and anything that needs KVM stay on GitHub's runners,
and Android builds on main and in releases run on their own runner, `ANDROID_RUNNER`.

## Pools and labels

Each box is a Debian 13 LXC container with Docker. Its runners take one job each and start the
next one from a clean slate.

| Box (SSH host) | Runners | Labels besides `self-hosted, linux, x64, starbridge, docker` |
|---|---|---|
| `sb-dell2` | 3 | `trusted, heavy` |
| `sb-dell3` | 2 | `pr, heavy` |
| `sb-hp` | 2 | `pr, light` |

- `trusted` runs pushes to main, deploys, uptime checks and releases, and nothing else.
- `pr` runs pull requests from this repository's own branches, except Dependabot's. Forks'
  pull requests, Dependabot's and dispatched CI runs stay on GitHub's runners.
- No pull request job reaches a `trusted` runner or `ANDROID_RUNNER`. Docker's daemon and cache
  outlive a job, so the two pools never share a box.

A workflow picks a pool from a repository variable holding a JSON array of labels, and falls back
to GitHub's runner when the variable is unset:

```yaml
runs-on: ${{ vars.TRUSTED_RUNNER && fromJSON(vars.TRUSTED_RUNNER) || 'ubuntu-latest' }}
```

| Variable | Value | Used by |
|---|---|---|
| `TRUSTED_RUNNER` | `["self-hosted","starbridge","trusted","heavy"]` | main's test job, deploy, uptime, release |
| `PR_LIGHT_RUNNER` | `["self-hosted","starbridge","pr","light"]` | a pull request's test, typecheck and lint job |
| `PR_HEAVY_RUNNER` | `["self-hosted","starbridge","pr","heavy"]` | a pull request's e2e parts |
| `PR_DOCKER_RUNNER` | `["self-hosted","starbridge","pr","docker","heavy"]` | a pull request's image builds |
| `ANDROID_RUNNER` | `starbridge-android` | Android builds on main and in releases |

A pull request job also checks that its pull request comes from this repository and not from
Dependabot before it reads a `PR_` variable (`ci.yml`). To move every job of a pool to GitHub's
runners, delete its variable: `gh variable delete PR_HEAVY_RUNNER`.

A job on these boxes must not rely on what an earlier job left, and must be safe with another job
beside it on the same box: no fixed host port, and a unique name for any container, Compose
project or image tag.

## How a runner works

- The setup files are in [`.github/runners`](../.github/runners). Each box runs one systemd unit
  per runner, `gh-runner@<n>`, as the user `runner`, who is in the `docker` group and has no sudo.
- A runner registers with a just-in-time config: a single-use registration whose labels GitHub
  fixes when it is made. The runner takes one job, then GitHub removes it.
- The boxes hold no GitHub credential. `feed.sh` runs every 15 s from a user timer on the machine
  where `gh` is logged in as the repository's owner. It makes a registration for every runner
  slot that has none, hands it over SSH, and deletes offline registrations no slot holds.
- Before each job, `slot.sh` deletes everything the last one left except the tool cache
  (`_work/_tool`: Node, Bun, pnpm's store and Firefox), and gives the job its own home and temp
  folder. It drops the tool cache too when the disk is 80% full.
- Every night `gh-runner-cleanup.timer` prunes Docker images, containers and build cache unused
  for three days, and all unused ones when the disk is 80% full.

## Add or remove a runner

Set up a new box, or change a box's number of runners (the script is safe to run again):

```bash
scp -r .github/runners sb-hp:gh-runner-setup
```

```bash
ssh sb-hp sudo bash gh-runner-setup/setup.sh 2
```

A new box also needs a line in `BOXES` in `feed.sh`, with its SSH host, name prefix and labels.
Then reinstall the feeder on the machine with the `gh` login:

```bash
.github/runners/feed.sh --install
```

To take a box out, delete its line in `BOXES`, reinstall the feeder, and stop its runners with
`ssh <box> 'sudo systemctl disable --now "gh-runner@*"'`. The feeder no longer reaches the box, so
remove its offline registrations in the repository's runner settings or with
`gh api -X DELETE repos/T0mSIlver/starbridge/actions/runners/<id>`.

## Debug a box

```bash
gh api repos/T0mSIlver/starbridge/actions/runners --jq '.runners[] | [.name, .status, .busy] | @tsv'
```

Each slot shows one runner, online. A slot gets its next registration within 15 s of a job's
end, and an offline runner of these boxes is deleted at the feeder's next round. On the box:

```bash
ssh sb-hp 'sudo /usr/local/lib/gh-runner/queue.sh status; systemctl status "gh-runner@*" --no-pager'
```

```bash
ssh sb-hp 'journalctl -u gh-runner@1 -n 50 --no-pager; df -h /; free -h'
```

- A slot with no queued registration: check the feeder with
  `journalctl --user -u starbridge-runner-feed -n 50` on the feeding machine.
- A runner's own logs are in `/home/runner/slots/<n>/_diag`, kept for three days.
- The disk is full: `ssh <box> sudo systemctl start gh-runner-cleanup`.
- A job hangs: `sudo systemctl restart gh-runner@<n>` kills it and wipes the slot; GitHub marks
  the job failed.
