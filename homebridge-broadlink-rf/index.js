'use strict';

const fs = require('fs');
const path = require('path');
const { BroadlinkRemote } = require('./lib/broadlink');

const PLUGIN_NAME = 'homebridge-broadlink-rf';
const PLATFORM_NAME = 'BroadlinkRF';
const DEBOUNCE_MS = 200;
const BUTTON_RESET_MS = 500;

module.exports = (api) => {
  api.registerPlatform(PLATFORM_NAME, BroadlinkRFPlatform);
};

class BroadlinkRFPlatform {
  constructor(log, config, api) {
    this.log = log;
    this.config = config || {};
    this.api = api;
    this.cached = new Map();
    this.statePath = path.join(api.user.storagePath(), 'broadlink-rf-state.json');
    this.state = this.loadJson(this.statePath, {});

    // One BroadlinkRemote per controller. A top-level "host" (the original
    // config shape) becomes a controller named "default".
    this.controllers = new Map();
    for (const c of this.config.controllers || []) {
      if (c.name && c.host) this.controllers.set(c.name, new BroadlinkRemote(c.host, log));
    }
    if (this.config.host && !this.controllers.has('default')) {
      this.controllers.set('default', new BroadlinkRemote(this.config.host, log));
    }

    if (!this.controllers.size || !this.config.devicesFile) {
      this.log.error('At least one controller and "devicesFile" are required; plugin disabled');
      return;
    }
    api.on('didFinishLaunching', () => this.setup());
  }

  configureAccessory(accessory) {
    this.cached.set(accessory.UUID, accessory);
  }

  loadJson(file, fallback) {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (err) {
      if (err.code !== 'ENOENT') this.log.warn(`Could not read ${file}: ${err.message}`);
      return fallback;
    }
  }

  saveState() {
    try {
      fs.writeFileSync(this.statePath, JSON.stringify(this.state, null, 2));
    } catch (err) {
      this.log.warn(`Could not save state: ${err.message}`);
    }
  }

  controllerFor(name) {
    if (name) return this.controllers.get(name);
    return this.controllers.size === 1 ? [...this.controllers.values()][0] : undefined;
  }

  setup() {
    const devices = this.loadJson(this.config.devicesFile, null);
    if (!devices) {
      this.log.error(`No devices loaded from ${this.config.devicesFile}; run cli/export_custom_devices first`);
      return;
    }

    const active = new Set();
    // "fans" is the original key; "accessories" is the general one.
    for (const cfg of [...(this.config.fans || []), ...(this.config.accessories || [])]) {
      const codes = devices[cfg.device];
      if (!codes) {
        this.log.error(`Device "${cfg.device}" not found in ${this.config.devicesFile}`);
        continue;
      }
      const remote = this.controllerFor(cfg.controller);
      if (!remote) {
        this.log.error(`${cfg.name}: controller "${cfg.controller ?? '(none)'}" not configured; ` +
          'set "controller" to one of: ' + [...this.controllers.keys()].join(', '));
        continue;
      }

      const uuid = this.api.hap.uuid.generate(`${PLATFORM_NAME}:${cfg.device}`);
      active.add(uuid);
      let accessory = this.cached.get(uuid);
      if (!accessory) {
        accessory = new this.api.platformAccessory(cfg.name, uuid);
        this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
        this.log.info(`Added ${cfg.name}`);
      }
      new RemoteAccessory(this, accessory, cfg, codes, remote);
    }

    const stale = [...this.cached.values()].filter((a) => !active.has(a.UUID));
    if (stale.length) {
      this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, stale);
      this.log.info(`Removed ${stale.map((a) => a.displayName).join(', ')}`);
    }

    // Connect up front so the first tap isn't slowed by discovery/auth.
    for (const [name, remote] of this.controllers) {
      remote.connect().catch((err) => this.log.warn(`Controller "${name}" not reachable yet: ${err.message}`));
    }
  }
}

// A device driven by learned RF/IR remote codes. Depending on config it gets:
//   speeds + off   Fan with a stepped speed slider
//   power          Fan that is just on/off (when there are no speeds)
//   oscillate      "Oscillation" switch: {on, off} commands or one {toggle}
//   light          separate Lightbulb tile
//   buttons        momentary switches for one-shot commands (temp up, mode, ...)
// The remote is one-way, so state is whatever we last sent, persisted to disk.
class RemoteAccessory {
  constructor(platform, accessory, config, codes, remote) {
    this.platform = platform;
    this.log = platform.log;
    this.name = config.name;
    this.codes = codes;
    this.remote = remote;
    this.speeds = config.speeds || [];
    this.power = config.power;
    this.offCommand = config.off || config.power?.off;
    this.oscillate = config.oscillate;
    this.timer = null;

    const { Service, Characteristic } = platform.api.hap;
    this.hap = { Service, Characteristic };

    const referenced = [
      ...this.speeds, this.offCommand, config.power?.on, config.light?.on, config.light?.off,
      config.oscillate?.on, config.oscillate?.off, config.oscillate?.toggle,
      ...(config.buttons || []).map((b) => b.command),
    ];
    const missing = referenced.filter((c) => c && !codes[c]);
    if (missing.length) this.log.warn(`${this.name}: unknown commands ${missing.join(', ')}`);

    const key = config.device;
    this.state = platform.state[key] ||= {};
    this.state.on ??= false;
    this.state.speed ??= this.speeds.length || 1;
    this.state.light ??= false;
    this.state.swing ??= false;

    accessory.getService(Service.AccessoryInformation)
      .setCharacteristic(Characteristic.Manufacturer, 'Broadlink RF')
      .setCharacteristic(Characteristic.Model, key);

    const hasFan = this.speeds.length > 0 || this.power;
    if (hasFan && !this.offCommand) this.log.error(`${this.name}: an "off" command is required`);
    this.fanService = hasFan ? this.setupFan(accessory) : null;
    if (!hasFan) {
      const old = accessory.getService(Service.Fan);
      if (old) accessory.removeService(old);
    }
    this.setupOscillate(accessory, config.oscillate);
    this.setupLight(accessory, config.light);
    this.setupButtons(accessory, config.buttons || []);
  }

  setupFan(accessory) {
    const { Service, Characteristic } = this.hap;
    let fan;
    if (this.power) {
      // With extra tiles (buttons) the Home app hides a control whose name
      // matches the accessory, leaving an unlabeled fan, and it keeps the name
      // it saw first, so renaming doesn't help. Use a separate "power" service
      // created with its own name, and drop the unnamed one from 0.2.0.
      const label = this.power.name || 'Power';
      const legacy = accessory.getService(Service.Fan);
      if (legacy && !legacy.subtype) accessory.removeService(legacy);
      fan = accessory.getServiceById(Service.Fan, 'power')
        || accessory.addService(Service.Fan, label, 'power');
      if (Characteristic.ConfiguredName) fan.setCharacteristic(Characteristic.ConfiguredName, label);
    } else {
      fan = accessory.getService(Service.Fan) || accessory.addService(Service.Fan, this.name);
    }
    // Primary, so tapping the accessory in a room toggles it.
    if (typeof fan.setPrimaryService === 'function') fan.setPrimaryService(true);

    // Reads return the pending target while a change is being debounced/sent, so
    // the Home app doesn't read back the old value and jump the control.
    fan.getCharacteristic(Characteristic.On)
      .onGet(() => this.current().on)
      .onSet((on) => {
        this.desired = { ...this.current(), on };
        this.schedule();
      });

    if (this.speeds.length) {
      // The Home app always treats RotationSpeed as 0-100 % and snaps the slider
      // to the values we report (33/67/100 for 3 speeds), so map to the nearest
      // speed: 67 must be speed2, not ceil(2.01) = speed3. Any value above 0 is
      // at least speed1.
      fan.getCharacteristic(Characteristic.RotationSpeed)
        .setProps({ minValue: 0, maxValue: 100, minStep: 1 })
        .onGet(() => this.speedPercent(this.current()))
        .onSet((pct) => {
          const n = this.speeds.length;
          const speed = pct <= 0 ? 0 : Math.max(1, Math.min(n, Math.round((pct * n) / 100)));
          this.log.debug(`${this.name}: slider ${pct} -> ${speed ? this.speeds[speed - 1] : this.offCommand}`);
          this.desired = speed === 0
            ? { ...this.current(), on: false }
            : { ...this.current(), on: true, speed };
          this.schedule();
        });
    } else if (fan.testCharacteristic(Characteristic.RotationSpeed)) {
      fan.removeCharacteristic(fan.getCharacteristic(Characteristic.RotationSpeed));
    }

    // Oscillation is its own switch (setupOscillate), not SwingMode inside the
    // fan control; remove the SwingMode that 0.2.0-0.2.2 added.
    if (fan.testCharacteristic(Characteristic.SwingMode)) {
      fan.removeCharacteristic(fan.getCharacteristic(Characteristic.SwingMode));
    }
    return fan;
  }

  // Oscillation as a separate on/off switch inside the same accessory.
  setupOscillate(accessory, oscillate) {
    const { Service, Characteristic } = this.hap;
    const existing = accessory.getServiceById(Service.Switch, 'oscillate');
    if (!oscillate) {
      if (existing) accessory.removeService(existing);
      return;
    }
    const label = oscillate.name || 'Oscillation';
    const sw = existing || accessory.addService(Service.Switch, label, 'oscillate');
    if (Characteristic.ConfiguredName) sw.setCharacteristic(Characteristic.ConfiguredName, label);
    sw.getCharacteristic(Characteristic.On)
      .onGet(() => this.state.swing)
      .onSet(async (swing) => {
        if (swing === this.state.swing && oscillate.toggle) return; // toggling would flip it
        const command = oscillate.toggle || (swing ? oscillate.on : oscillate.off);
        await this.send(command);
        this.state.swing = swing;
        this.platform.saveState();
      });
  }

  setupLight(accessory, light) {
    const { Service, Characteristic } = this.hap;
    const existing = accessory.getService(Service.Lightbulb);
    if (!light) {
      if (existing) accessory.removeService(existing);
      return;
    }
    const bulb = existing || accessory.addService(Service.Lightbulb, `${this.name} Light`);
    bulb.getCharacteristic(Characteristic.On)
      .onGet(() => this.state.light)
      .onSet(async (on) => {
        await this.send(on ? light.on : light.off);
        this.state.light = on;
        this.platform.saveState();
      });
  }

  // One-shot commands as switches that turn themselves back off, like a button.
  setupButtons(accessory, buttons) {
    const { Service, Characteristic } = this.hap;
    const wanted = new Set();
    for (const button of buttons) {
      const subtype = `button:${button.command}`;
      wanted.add(subtype);
      const label = button.name || button.command;
      const sw = accessory.getServiceById(Service.Switch, subtype)
        || accessory.addService(Service.Switch, `${this.name} ${label}`, subtype);
      if (Characteristic.ConfiguredName) sw.setCharacteristic(Characteristic.ConfiguredName, label);
      const on = sw.getCharacteristic(Characteristic.On);
      on.onGet(() => false).onSet(async (value) => {
        if (!value) return;
        try {
          await this.send(button.command);
        } finally {
          setTimeout(() => on.updateValue(false), BUTTON_RESET_MS);
        }
      });
    }
    for (const svc of [...accessory.services]) {
      if (svc.UUID === Service.Switch.UUID && svc.subtype?.startsWith('button:') && !wanted.has(svc.subtype)) {
        accessory.removeService(svc);
      }
    }
  }

  current() {
    return this.desired || this.state;
  }

  speedPercent(s) {
    return s.on ? Math.round((s.speed * 100) / this.speeds.length) : 0;
  }

  // Dragging the slider fires On and RotationSpeed together; collapse them into
  // one RF transmission.
  schedule() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.applyFan(), DEBOUNCE_MS);
  }

  async applyFan() {
    const target = this.desired;
    if (!target) return;
    const command = !target.on
      ? this.offCommand
      : this.speeds.length ? this.speeds[target.speed - 1] : this.power.on;
    try {
      await this.send(command);
      this.state.on = target.on;
      this.state.speed = target.speed;
      this.platform.saveState();
    } catch {
      // send() already logged it; fall through to resync HomeKit with real state
    }
    // A newer change may have arrived while we were sending; leave it pending.
    if (this.desired === target) this.desired = null;
    const shown = this.current();
    const { Characteristic } = this.hap;
    this.fanService.updateCharacteristic(Characteristic.On, shown.on);
    if (this.speeds.length) {
      this.fanService.updateCharacteristic(Characteristic.RotationSpeed, this.speedPercent(shown));
    }
  }

  async send(command) {
    const hex = this.codes[command];
    if (!hex) {
      this.log.error(`${this.name}: no learned packet for "${command}"`);
      throw new this.platform.api.hap.HapStatusError(
        this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE,
      );
    }
    try {
      await this.remote.send(hex);
      this.log.info(`${this.name}: sent ${command}`);
    } catch (err) {
      this.log.error(`${this.name}: failed to send ${command}: ${err.message}`);
      throw new this.platform.api.hap.HapStatusError(
        this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE,
      );
    }
  }
}
