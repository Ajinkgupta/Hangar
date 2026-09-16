#!/usr/bin/env bash
# Build Hangar in release mode, install it to /Applications, relaunch it, and
# drop a shareable DMG into ./release/.
#
#   npm run install:app          # build + install + relaunch (restarts the daemon)
#   KEEP_SESSIONS=1 npm run install:app   # keep running terminals (old daemon stays)
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH="$HOME/.cargo/bin:$PATH"

VERSION=$(node -p "require('./package.json').version")
TARGET=""
BUNDLE_DIR="target/release/bundle"
if rustup target list --installed | grep -q '^x86_64-apple-darwin$'; then
  TARGET="--target universal-apple-darwin"
  BUNDLE_DIR="target/universal-apple-darwin/release/bundle"
fi

echo "▸ building Hangar $VERSION ${TARGET:-(apple silicon only)}"
npm run tauri build -- $TARGET

APP="$BUNDLE_DIR/macos/Hangar.app"
DMG=$(ls "$BUNDLE_DIR"/dmg/Hangar_*.dmg | head -1)

echo "▸ stopping running Hangar"
osascript -e 'tell application "Hangar" to quit' >/dev/null 2>&1 || true
sleep 1
pkill -f "Hangar.app/Contents/MacOS/hangar$" >/dev/null 2>&1 || true
if [ "${KEEP_SESSIONS:-0}" != "1" ]; then
  echo "▸ restarting session daemon (set KEEP_SESSIONS=1 to keep terminals alive)"
  pkill -f "hangar --daemon" >/dev/null 2>&1 || true
  rm -f "$HOME/Library/Application Support/hangar/hangard.sock"
fi

echo "▸ installing to /Applications"
rm -rf /Applications/Hangar.app
cp -R "$APP" /Applications/Hangar.app
xattr -dr com.apple.quarantine /Applications/Hangar.app 2>/dev/null || true

mkdir -p release
cp "$DMG" "release/Hangar-$VERSION.dmg"

open -a /Applications/Hangar.app
echo
echo "✔ installed /Applications/Hangar.app and launched it"
echo "✔ shareable installer: $(pwd)/release/Hangar-$VERSION.dmg"
echo "  recipients: open the DMG, drag Hangar to Applications, then right-click → Open the first time"
echo "  (unsigned build; or run: xattr -dr com.apple.quarantine /Applications/Hangar.app)"
