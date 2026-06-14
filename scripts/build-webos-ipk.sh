#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_DIR="$ROOT_DIR/webos/nebula-sports"
DIST_DIR="$ROOT_DIR/dist/webos"
APP_ID="$(node -e "process.stdout.write(require('$APP_DIR/appinfo.json').id)")"
VERSION="$(node -e "process.stdout.write(require('$APP_DIR/appinfo.json').version)")"
OUT="$DIST_DIR/${APP_ID}_${VERSION}_all.ipk"
TMP="$(mktemp -d)"

cleanup() {
  rm -rf "$TMP"
}
trap cleanup EXIT

mkdir -p "$TMP/control" "$TMP/data/usr/palm/applications/$APP_ID" "$TMP/data/usr/palm/packages/$APP_ID" "$DIST_DIR"

printf '2.0\n' > "$TMP/debian-binary"

cat > "$TMP/control/control" <<EOF
Package: $APP_ID
Version: $VERSION
Section: misc
Priority: optional
Architecture: all
Installed-Size: 272266
Maintainer: N/A <nobody@example.com>
Description: This is a webOS application.
webOS-Package-Format-Version: 2
webOS-Packager-Version: x.y.x
EOF

cp "$APP_DIR/appinfo.json" "$APP_DIR/index.html" "$APP_DIR/icon.png" "$APP_DIR/largeIcon.png" "$TMP/data/usr/palm/applications/$APP_ID/"

cat > "$TMP/data/usr/palm/packages/$APP_ID/packageinfo.json" <<EOF
{"id":"$APP_ID","version":"$VERSION","app":"$APP_ID"}
EOF

find "$TMP/control" "$TMP/data" -type d -exec chmod 0777 {} +
find "$TMP/control" "$TMP/data" -type f -exec chmod 0664 {} +
chmod 0666 "$TMP/control/control" "$TMP/data/usr/palm/packages/$APP_ID/packageinfo.json"

(cd "$TMP/control" && tar -czf "$TMP/control.tar.gz" control)
(cd "$TMP/data" && tar -czf "$TMP/data.tar.gz" usr)

rm -f "$DIST_DIR/${APP_ID}_"*_all.ipk "$OUT"
(cd "$TMP" && ar rc "$OUT" debian-binary control.tar.gz data.tar.gz)
chmod 0644 "$OUT"

sha256sum "$OUT"
