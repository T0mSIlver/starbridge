# CI runners

Most CI jobs run on GitHub's runners. Some run on three self-hosted Linux boxes, which start them
sooner. Windows, macOS, Linux ARM64, the e2e and anything that needs KVM stay on GitHub's runners,
and main's unsigned Android build runs on its own runner, `ANDROID_RUNNER`. A job that reads a
signing or deploy key, builds a file a release signs, or builds the images prod runs, runs on
GitHub's runners only, so no box on the home network holds one of those keys or makes what ships
(#1825, #1839).

## Pools and labels

Each box is a Debian 13 LXC container with Docker. Each runner takes one job; before the next, its slot
wipes that job's folders, and only those (below).

| Box (SSH host) | Runners | Labels besides `self-hosted, linux, x64, starbridge, docker` |
|---|---|---|
| `sb-dell2` | 3 | `trusted, heavy` |
| `sb-dell3` | 2 | `pr, heavy` |
| `sb-hp` | 2 | `pr, light` |

- `trusted` runs pushes to main's tests, the release's version
  check and the nightly flaky-test count, and nothing else.
- `pr` runs pull requests from this repository's own branches, except Dependabot's. Forks'
  pull requests, Dependabot's and dispatched CI runs stay on GitHub's runners.
- No pull request job reaches a `trusted` runner or `ANDROID_RUNNER`. A job can use Docker, which
  makes it root on its box (below), and Docker's daemon and cache outlive it, so the two pools
  never share a box.

A workflow picks a pool from a repository variable holding a JSON array of labels, and falls back
to GitHub's runner when the variable is unset:

```yaml
runs-on: ${{ vars.TRUSTED_RUNNER && fromJSON(vars.TRUSTED_RUNNER) || 'ubuntu-latest' }}
```

| Variable | Value | Used by |
|---|---|---|
| `TRUSTED_RUNNER` | `["self-hosted","starbridge","trusted","heavy"]` | main's test job, release's version check, flakes |
| `PR_LIGHT_RUNNER` | `["self-hosted","starbridge","pr"]` | a pull request's test, typecheck and lint job |
| `PR_DOCKER_RUNNER` | `["self-hosted","starbridge","pr","docker","heavy"]` | a pull request's image builds |
| `ANDROID_RUNNER` | `starbridge-android` | main's unsigned Android build (`android.yml`) |

A pull request job also checks that its pull request comes from this repository and not from
Dependabot before it reads a `PR_` variable (`ci.yml`). To move every job of a pool to GitHub's
runners, delete its variable: `gh variable delete PR_LIGHT_RUNNER`.

A job on these boxes must not rely on what an earlier job left, and must be safe with another job
beside it on the same box: no fixed host port, and a unique name for any container, Compose
project or image tag.

Docker Hub limits anonymous pulls per address, and the boxes share one. A job that pulls from it
(`ci.yml`'s `images`, `deploy.yml`'s `build`, `ios.yml`'s Swift on Linux) logs in first, with the
repository variable `DOCKERHUB_USERNAME` and the secret `DOCKERHUB_TOKEN`, a read-only token of a
free account. Forks' and Dependabot's runs get no secret and pull anonymously.

A machine on the home network can resolve Gradle's dependencies through the home caching mirror
of Google's Maven, Maven Central and the Gradle Plugin Portal, which keeps Maven Central's rate
limit off the shared address. Gradle uses it when the machine's `~/.gradle/gradle.properties`
(or the runner's `GRADLE_USER_HOME`) sets `starbridge.mavenMirror=http://192.168.1.49:8080`; the
public repositories stay after it, so a machine without the property, GitHub's runners included,
resolves as before. The dev box and the Android runner (`ci-1`, in `/home/dev/.gradle`) set it.
Gradle stops on a mirror that does not answer rather than moving on, so while the mirror is
down, take the line out. The mirror is plain HTTP, so a build that signs with the release key
(`STARBRIDGE_KEYSTORE` set: `release.yml`, `internal.yml`) leaves it out and resolves over HTTPS,
and every build checks each dependency against `android/gradle/verification-metadata.xml`.

## Evidence

In CI the web end-to-end run keeps evidence (`EVIDENCE` in `web/e2e/run.ts`): every screenshot at 360, 768 and 1280 px in light and dark, a
Playwright trace per browser, and `manifest.json`, the steps it drove and its result. Each part
uploads it as `evidence-<part>-<tree>`, or `evidence-<part>-failed`.

On a pull request from this repository's branches, the `evidence` job (`web/e2e/evidence.ts`)
then compares the screenshots with those of main's run
at the pull request's base, or the nearest of its 30 first parents that ran the e2e. A screen
counts as changed when over 0.2% of its pixels differ, outside the times, dates and codes that
change from run to run. The job pushes up to 24 changed pairs to the `pr-shots` branch under
`verify/<pr>/<sha>/`, and writes or updates one comment on the pull request, marked
`<!-- starbridge-evidence -->`.

The comment lists the changed screens by name, with the number of sizes and colour schemes each
changed in, and shows the largest differences first. A change in the page shows in all of a
screen's sizes, a flicker in one or two.

A screenshot is made steady before it is shot, so that two runs of one tree match:

- the clock of a quota screen (`quotas-*`, `inbox-aside-*`) is held at the instant the fake
  CodexBar's windows were made for, so the pace marker and "On pace" do not follow how long the
  run took to get there;
- a first browser whose push subscription Firefox dropped turns it on again before a shot, so the
  Turn on notifications banner is not on the inbox's screens by chance;
- "today", "tomorrow" and "yesterday" are left out of the comparison with the times beside them;
- the desktop window is shot without motion and with the pointer in a corner, since under xvfb it
  can sit over the sign-in button and draw its hover colour.

Some screens still change on their own: `quotas-machines-*` lists its two machines, whose windows
are the same, in either order, and a quota's run-out line can wrap to a second line, since the
digits of its time differ in width, which moves the rows below it.

A pull request that touches `android/` or `demo/smoke/` gets the same for the Android app, in its
own comment marked `<!-- starbridge-evidence android -->` (`android.yml`). The release smoke
(`demo/smoke/android.ts`) runs with `EVIDENCE` set on a phone (`pixel_7`) and a tablet
(`pixel_tablet`), API 36, on GitHub's runners with KVM. It signs in, gets a question by FCM,
shows its notification and opens the card, and fails on a crash in logcat. `.github/android-system-image.sh` installs the system image first and installs it again (three tries) when the download is corrupt, which the action alone fails on (#2181). A pull request's APK has made-up Firebase values (a build with no `google-services.json`), which Google refuses, so the app never gets an FCM token; the emulator job sets `NO_FIREBASE` and the smoke puts a made-up token on the app's device in the server's database. The release smoke leaves it unset and needs the app to register itself. `ANSWER=<option>` makes the smoke also tap that option on the card and read the answer on the machine's side (the verify-android skill uses it; CI and the release leave it unset). It keeps each stop in
light and dark (`<profile>-<stop>-<scheme>.png`) with its UI dump, the notification shade in light
only, and the app drawer with our icon beside the stock apps', again in light under each icon shape
the system image offers as an overlay. The comparison leaves out the status bar, the times on screen and the launcher's Clock icon, whose face shows the time. The phone emulator boots with the camera cutout in some runs and without it in others, which moves every screen by the status bar's height, so the run turns on the emulator's own cutout overlay first. Before each shot it enters the status bar's demo mode again, waits for the "Google push is not available" snackbar to go, sets the app drawer up again if a change of scheme closed it, and takes the shot once two screenshots 700 ms apart match, so no inset or fade is caught half way. A tablet's drawer is a sheet over the home screen, whose clock widget moves, so only the sheet is compared. Each profile
uploads `android-evidence-<profile>-<tree>`; the changed pairs go under
`verify/<pr>/<sha>/android/` on `pr-shots`.

A pull request that touches the desktop app, the web page it shows, the server or the CLI gets the
same for the desktop app, in its own comment marked `<!-- starbridge-evidence desktop -->`
(`ci.yml`, the `desktop evidence` job). The desktop end-to-end run (`desktop/test/stack.ts`) keeps
the window at each stop (sign-in, keys, empty inbox, pairing, a question, Quotas, Settings) in light
and dark (`<stop>-<scheme>.png`), with the boxes of the
times and codes beside each. It uploads `desktop-evidence-app-<tree>`, or
`desktop-evidence-app-failed`; the changed pairs go under `verify/<pr>/<sha>/desktop/` on
`pr-shots`. The menu bar icon is not kept: the run has no menu bar to shoot.

To compare two runs by hand, run the e2e twice with `EVIDENCE` set, each in a folder named after
its part, then `bun web/e2e/evidence.ts <after> <before> <out>`: it writes `out/comment.md` and the
changed pairs.

## Owner review

A pull request that changes `.github/` or `deploy/` needs the owner's yes before it merges
(`spec/releases.md`, "Owner review"). `owner-review.yml` labels it `owner-review` and sets the
commit status `owner review`, required on main, to failure until the pull request also carries
`owner-ok`; a push removes `owner-ok`. The orchestrator adds `owner-ok` once the owner answered
yes on his card, only while the pull request still holds the commit the card named, and checks
the head again afterwards: the label names no commit, so a push that lands as it is added would
get the yes too.

```bash
gh api repos/T0mSIlver/starbridge/issues/<n>/labels -f 'labels[]=owner-ok'
```

A pull request with nothing in those folders gets the status as success on its next push or label
change. `.github/owner-gates.sh` (print-only; `--apply` changes them) sets the repository settings
behind it: the required status, and no admin bypass on any environment.

## Approval cards

The `starbridge.run` environment waits for the maintainer's review before a deploy runs, and an
rc's release waits up to 12 hours for the deploy (5 h 50 min on GitHub's runners, which end a job at 6 hours), and fails as soon as the deploy run ends without success. When `deploy.yml` is dispatched, its `card` job
posts a Starbridge card, "Approve the prod deploy of v1.2.3-rc.1?", with the run's link; the same job closes it once the deploy job starts or ends, or after 6 hours, the longest a GitHub runner lives. The card does
not approve anything: the review is on the run's page.

The job uses a machine of their own, "GitHub Actions", whose identity is the `CI_CARD_MACHINE`
secret of the `ci-card` environment, which only main can read. Without the secret the `card` job
prints the link and sends nothing. Pull requests never run it. The maintainer sets it up once, on
a machine with the CLI, with no value on a command line or in a shell history:

```bash
export STARBRIDGE_CONFIG_DIR=$(mktemp -d)
starbridge pair --name "GitHub Actions"
starbridge machine export > "$STARBRIDGE_CONFIG_DIR/line"
gh api -X PUT repos/T0mSIlver/starbridge/environments/ci-card \
  -F 'deployment_branch_policy[protected_branches]=false' \
  -F 'deployment_branch_policy[custom_branch_policies]=true' -F can_admins_bypass=false
gh api -X POST repos/T0mSIlver/starbridge/environments/ci-card/deployment-branch-policies \
  -f name=main -f type=branch
gh secret set CI_CARD_MACHINE --env ci-card < "$STARBRIDGE_CONFIG_DIR/line"
shred -u "$STARBRIDGE_CONFIG_DIR/line"
rm -rf "$STARBRIDGE_CONFIG_DIR"
```

`machine export` prints the machine's private keys, so only the maintainer runs it. To revoke the
machine, remove "GitHub Actions" under Devices and delete the secret.

## How a runner works

- The setup files are in [`.github/runners`](../.github/runners). Each box runs one systemd unit
  per runner, `gh-runner@<n>`, as the user `runner`, who is in the `docker` group and has no sudo.
  The `docker` group is root in all but name: a job can mount the box's whole filesystem into a
  container. So a pull request job can change its box for the jobs after it and read the other
  slots' next registrations. The PR pool's boxes run nothing else, which keeps that among pull
  requests.
- A runner registers with a just-in-time config: a single-use registration whose labels GitHub
  fixes when it is made. The runner takes one job, then GitHub removes it.
- The boxes hold no GitHub credential. `feed.sh` runs every 15 s from a user timer on the machine
  where `gh` is logged in as the repository's owner. It makes a registration for every runner
  slot that has none, hands it over SSH, and deletes offline registrations no slot holds.
- Before each job, `slot.sh` deletes the last job's folders: its `_work` except the tool cache
  (`_work/_tool`: Node, Bun and pnpm's store), and its home and temp folder. It drops the tool
  cache too when the disk is 80% full. Docker's containers, images and volumes, and anything a job
  wrote elsewhere on the box, stay.
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

The script checks each download: the runner and Node tarballs against a SHA-256 pinned in it, and
Docker's apt key against Docker's fingerprint. To bump a version, change its hash in the same
commit; Node's comes from the version's `SHASUMS256.txt`, signed by a key in
[nodejs/release-keys](https://github.com/nodejs/release-keys/blob/main/keys.list).

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
