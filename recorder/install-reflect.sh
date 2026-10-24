#!/usr/bin/env bash
# Build and install Reflect under its own name, without modifying a file
# upstream owns.
#
# The dev bundle ships as "Reflect Dev" with a green icon, to tell it apart
# from an installed release. There is no installed release here — this build
# *is* the app — so the distinction only ever cost a wrong name in the Dock.
#
# Editing `tauri.dev.conf.json` to fix that would reintroduce exactly the
# merge conflict this repository is arranged to avoid, so the override is
# generated beside it, used, and removed. Nothing tracked changes.
#
# The identifier stays `app.reflect.desktop.dev`, which is what TCC keys its
# grants on: screen recording, microphone, calendar and contacts all survive.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
base="$root/apps/desktop/src-tauri/tauri.dev.conf.json"
patched="$root/apps/desktop/src-tauri/tauri.local.conf.json"
trap 'rm -f "$patched"' EXIT

python3 - "$base" "$patched" <<'PY'
import json, sys
base, out = sys.argv[1], sys.argv[2]
config = json.load(open(base))
config["productName"] = "Reflect"
config["app"]["windows"][0]["title"] = "Reflect"
config["bundle"]["icon"] = [
    "icons/32x32.png", "icons/128x128.png", "icons/128x128@2x.png",
    "icons/icon.icns", "icons/icon.ico",
]
json.dump(config, open(out, "w"), indent=2)
PY

: "${APPLE_SIGNING_IDENTITY:?set it, or the build is ad-hoc signed and macOS forgets every permission}"
( cd "$root" && pnpm --filter @reflect/desktop tauri build --config src-tauri/tauri.local.conf.json )

built="$root/target/release/bundle/macos/Reflect.app"
osascript -e 'quit app "Reflect"' 2>/dev/null || true
sleep 2
rm -rf "/Applications/Reflect.app"
cp -R "$built" /Applications/
open -a "/Applications/Reflect.app"
echo "installed $(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "/Applications/Reflect.app/Contents/Info.plist")"
