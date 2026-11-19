#!/usr/bin/env bash
# Install homebridge-broadlink-rf into a Homebridge apt/Pi-image install.
# Run from the folder holding this script, the plugin tarball,
# broadlink-devices.json and platform-config.json (the BroadlinkRF platform
# block to put in config.json):   sudo ./install-on-pi.sh
set -euo pipefail

HB=/var/lib/homebridge
NODE_BIN=/opt/homebridge/bin
HERE="$(cd "$(dirname "$0")" && pwd)"
TARBALL="$(ls "$HERE"/homebridge-broadlink-rf-*.tgz | tail -n 1)"
PLATFORM_CONFIG="$HERE/platform-config.json"
[ -f "$PLATFORM_CONFIG" ] || { echo "missing $PLATFORM_CONFIG"; exit 1; }

[ "$(id -u)" -eq 0 ] || { echo "run with sudo"; exit 1; }

stamp="$(date +%Y%m%d-%H%M%S)"
cp "$HB/config.json" "$HB/backups/config.json.pre-broadlink-rf-$stamp"
echo "backed up config.json to backups/config.json.pre-broadlink-rf-$stamp"

# Keep the tarball inside Homebridge's folder so later npm runs can find it.
install -d -o homebridge -g homebridge "$HB/local-plugins"
install -o homebridge -g homebridge -m 644 "$TARBALL" "$HB/local-plugins/"
install -o homebridge -g homebridge -m 644 "$HERE/broadlink-devices.json" "$HB/broadlink-devices.json"
# The homebridge user can't read the invoking user's home, so stage it here.
install -o homebridge -g homebridge -m 644 "$PLATFORM_CONFIG" "$HB/local-plugins/platform-config.json"

sudo -u homebridge env PATH="$NODE_BIN:$PATH" \
  npm install --prefix "$HB" --save "$HB/local-plugins/$(basename "$TARBALL")"

sudo -u homebridge "$NODE_BIN/node" -e '
const fs = require("fs");
const file = "/var/lib/homebridge/config.json";
const config = JSON.parse(fs.readFileSync(file, "utf8"));
const platform = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
platform.platform = "BroadlinkRF";
platform.devicesFile = "/var/lib/homebridge/broadlink-devices.json";
config.platforms = (config.platforms || []).filter((p) => p.platform !== "BroadlinkRF");
config.platforms.push(platform);
fs.writeFileSync(file, JSON.stringify(config, null, 4));
console.log("set BroadlinkRF platform in config.json");
' "$HB/local-plugins/platform-config.json"

systemctl restart homebridge
echo "restarted homebridge; check the log for [Broadlink RF]"
