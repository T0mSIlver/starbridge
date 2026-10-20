#!/usr/bin/env bash
# android-system-image.sh: installs the emulator's system image before reactivecircus/android-emulator-runner
# does, and installs it again when the download comes out corrupt. The action installs it once and
# fails the job on a bad archive ("Error on ZipFile unknown archive", #2181); with the image already
# there, its own install finds it and skips. Keep IMAGE equal to the action's api-level, target and
# arch inputs in android.yml, release.yml and staging-app.yml.
set -euo pipefail

IMAGE='system-images;android-36;google_apis;x86_64'
TRIES=${TRIES:-3}
DIR="${ANDROID_HOME:?}/${IMAGE//;//}"

# installed: sdkmanager lists the image and its files are there. A failed unpack leaves a warning on
# stdout and may exit 0, so the files are what counts.
installed() {
  [ -s "$DIR/system.img" ] && [ -s "$DIR/package.xml" ] \
    && sdkmanager --list_installed 2>/dev/null | grep -qF "$IMAGE"
}

yes | sdkmanager --licenses > /dev/null || true
for try in $(seq "$TRIES"); do
  sdkmanager --install "$IMAGE" --channel=0 > /dev/null || true
  if installed; then
    echo "android-system-image.sh: $IMAGE installed on try $try"
    exit 0
  fi
  echo "android-system-image.sh: try $try of $TRIES left no usable $IMAGE; removing it" >&2
  rm -rf "$DIR" "${ANDROID_HOME}/.temp"
  sleep $((try * 10))
done
echo "android-system-image.sh: $IMAGE did not install in $TRIES tries" >&2
exit 1
