#!/bin/sh
# Build "Herdr Notify.app" into $1 (default ~/Applications): swiftc + Herdr's own icon + ad-hoc signature.
set -e
HERE="$(cd "$(dirname "$0")" && pwd)"
DEST="${1:-$HOME/Applications}/Herdr Notify.app"
ICON="/Applications/Herdr.app/Contents/Resources/Herdr.icns"
TMP="$(mktemp -d)"
mkdir -p "$TMP/Herdr Notify.app/Contents/MacOS" "$TMP/Herdr Notify.app/Contents/Resources"
swiftc -O -o "$TMP/Herdr Notify.app/Contents/MacOS/herdr-notify" "$HERE/main.swift"
cp "$HERE/Info.plist" "$TMP/Herdr Notify.app/Contents/Info.plist"
[ -f "$ICON" ] && cp "$ICON" "$TMP/Herdr Notify.app/Contents/Resources/AppIcon.icns"
codesign --force --sign - "$TMP/Herdr Notify.app" >/dev/null
mkdir -p "$(dirname "$DEST")"
rm -rf "$DEST"; mv "$TMP/Herdr Notify.app" "$DEST"; rmdir "$TMP" 2>/dev/null || true
/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f "$DEST" >/dev/null 2>&1 || true
echo "$DEST"
