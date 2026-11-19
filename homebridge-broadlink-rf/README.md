# homebridge-broadlink-rf

Exposes ceiling fans with RF/IR remotes to HomeKit as a **Fan** (stepped speed
slider) plus an optional **Light**, and sends the learned packets straight to a
Broadlink RM4 Pro. Replaces the `server/server.py` Flask API + Switcheroo setup:
no separate process, no HTTP hop.

Training still happens with the Python tools in this repo.

## 1. Export your trained devices

On the machine that has your `.device` files:

```bash
python3 cli/export_custom_devices local/custom_devices broadlink-devices.json
```

This turns each pickled `.device` file into hex packets in one JSON file:

```json
{ "office_fan": { "light_on": "b200…", "speed1": "b200…", ... } }
```

Re-run it whenever you train new commands, then restart Homebridge.

## 2. Install the plugin on the Homebridge host

Copy this folder and `broadlink-devices.json` to the Homebridge machine, then
install it into Homebridge's storage directory (`/var/lib/homebridge` on the
Raspberry Pi image, `~/.homebridge` elsewhere):

```bash
cd /var/lib/homebridge && npm install /path/to/homebridge-broadlink-rf
```

The plugin has no npm dependencies.

## 3. Configure

See [platform-config.example.json](platform-config.example.json) for a full
example. Each accessory names a learned `device` and the `controller` (RM4 Pro,
RM mini, ...) that transmits its codes; different accessories can use
different controllers.

| Key | Gives you |
|---|---|
| `speeds` + `off` | Fan tile with a stepped speed slider (slowest first) |
| `power` `{on, off}` | Fan tile that is just on/off (no speeds) |
| `oscillate` `{on, off}` or `{toggle}` | Separate "Oscillation" switch in the accessory |
| `light` `{on, off}` | Separate light tile |
| `buttons` `[{name, command}]` | Switches that send one command and turn back off |

Give each controller a DHCP reservation so its IP doesn't change.

The original single-controller shape (`"host"` + `"fans"`) still works.

`install-on-pi.sh` writes `platform-config.json` (next to the script) into
Homebridge's `config.json`, replacing any existing BroadlinkRF block.

## State

RF is one-way, so the plugin reports the last command it sent, saved to
`broadlink-rf-state.json` in Homebridge's storage directory. Using the physical
remote will make the Home app out of date until the next command from HomeKit.

## Migrating from Switcheroo

1. Add this plugin and confirm the fan and light work from the Home app.
2. Remove the Switcheroo accessory and its old switches from the Home app, and
   rebuild any scenes or automations that used them.
3. Stop `server/server.py`.
