'use strict';

// Minimal Broadlink client: discover one device by IP, authenticate, and send
// learned IR/RF packets. Ported from broadlink/device.py and broadlink/remote.py
// (the rm4mini/rm4pro framing), which is all the RM4 Pro needs for sending.

const crypto = require('crypto');
const dgram = require('dgram');

const PORT = 80;
const INIT_KEY = Buffer.from('097628343fe99e23765c1513accf8b02', 'hex');
const IV = Buffer.from('562e17996d093d28ddb3ba695a2e6f58', 'hex');
const MAGIC = Buffer.from('5aa5aa555aa5aa55', 'hex');
const RETRY_MS = 1000;
const TIMEOUT_MS = 10000;

function checksum(buf) {
  let sum = 0xbeaf;
  for (const b of buf) sum += b;
  return sum & 0xffff;
}

// One UDP request with retries every second until a reply arrives or we time out.
function request(host, packet, timeoutMs = TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const sock = dgram.createSocket('udp4');
    let retry;
    let deadline;
    const finish = (err, msg) => {
      clearInterval(retry);
      clearTimeout(deadline);
      sock.close();
      if (err) reject(err); else resolve(msg);
    };
    sock.on('error', (err) => finish(err));
    sock.on('message', (msg) => finish(null, msg));
    sock.bind(0, () => {
      const send = () => sock.send(packet, PORT, host);
      send();
      retry = setInterval(send, RETRY_MS);
      deadline = setTimeout(
        () => finish(new Error(`no response from ${host} within ${timeoutMs / 1000}s`)),
        timeoutMs,
      );
    });
  });
}

function helloPacket() {
  const p = Buffer.alloc(0x30);
  const now = new Date();
  p.writeInt32LE(Math.trunc(-now.getTimezoneOffset() / 60), 0x08);
  p.writeUInt16LE(now.getFullYear(), 0x0c);
  p[0x0e] = now.getMinutes();
  p[0x0f] = now.getHours();
  p[0x10] = now.getFullYear() % 100;
  p[0x11] = now.getDay() === 0 ? 7 : now.getDay(); // ISO weekday
  p[0x12] = now.getDate();
  p[0x13] = now.getMonth() + 1;
  // 0x18-0x1d (our IP/port) stay zero; the device replies to the sender.
  p[0x26] = 6;
  p.writeUInt16LE(checksum(p), 0x20);
  return p;
}

class BroadlinkRemote {
  constructor(host, log = console) {
    this.host = host;
    this.log = log;
    this.devtype = null;
    this.macRaw = null; // as sent on the wire (reversed relative to display order)
    this.id = 0;
    this.key = INIT_KEY;
    this.count = crypto.randomInt(0x8000, 0x10000);
    this.ready = null;
    this.queue = Promise.resolve();
  }

  encrypt(data) {
    const c = crypto.createCipheriv('aes-128-cbc', this.key, IV);
    c.setAutoPadding(false);
    return Buffer.concat([c.update(data), c.final()]);
  }

  decrypt(data) {
    const d = crypto.createDecipheriv('aes-128-cbc', this.key, IV);
    d.setAutoPadding(false);
    return Buffer.concat([d.update(data), d.final()]);
  }

  async discover() {
    const resp = await request(this.host, helloPacket());
    if (resp.length < 0x40) throw new Error(`short hello response (${resp.length} bytes)`);
    this.devtype = resp.readUInt16LE(0x34);
    this.macRaw = Buffer.from(resp.subarray(0x3a, 0x40));
    const mac = Buffer.from(this.macRaw).reverse().toString('hex').match(/../g).join(':');
    this.log.info(`Found Broadlink device 0x${this.devtype.toString(16)} at ${this.host} (${mac})`);
  }

  async sendPacket(type, payload) {
    this.count = ((this.count + 1) | 0x8000) & 0xffff;
    const header = Buffer.alloc(0x38);
    MAGIC.copy(header, 0);
    header.writeUInt16LE(this.devtype, 0x24);
    header.writeUInt16LE(type, 0x26);
    header.writeUInt16LE(this.count, 0x28);
    this.macRaw.copy(header, 0x2a);
    header.writeUInt32LE(this.id, 0x30);
    header.writeUInt16LE(checksum(payload), 0x34);

    const padded = Buffer.concat([payload, Buffer.alloc((16 - (payload.length % 16)) % 16)]);
    const packet = Buffer.concat([header, this.encrypt(padded)]);
    packet.writeUInt16LE(checksum(packet), 0x20);

    const resp = await request(this.host, packet);
    if (resp.length < 0x30) throw new Error(`short response (${resp.length} bytes)`);
    const expected = resp.readUInt16LE(0x20);
    const actual = (checksum(resp) - resp[0x20] - resp[0x21]) & 0xffff;
    if (expected !== actual) throw new Error('response checksum mismatch');
    const error = resp.readInt16LE(0x22);
    if (error !== 0) throw new Error(`device returned error ${error}`);
    return resp;
  }

  async auth() {
    this.id = 0;
    this.key = INIT_KEY;
    const p = Buffer.alloc(0x50);
    p.fill(0x31, 0x04, 0x14);
    p[0x1e] = 0x01;
    p[0x2d] = 0x01;
    p.write('Test 1', 0x30, 'ascii');
    const resp = await this.sendPacket(0x65, p);
    const payload = this.decrypt(resp.subarray(0x38));
    this.id = payload.readUInt32LE(0);
    this.key = Buffer.from(payload.subarray(0x04, 0x14));
  }

  connect() {
    if (!this.ready) {
      this.ready = (async () => {
        await this.discover();
        await this.auth();
      })().catch((err) => {
        this.ready = null; // let the next command try again
        throw err;
      });
    }
    return this.ready;
  }

  // RM4-family framing: <uint16 len(data)+4><uint32 command 0x02><data>
  async transmit(data) {
    await this.connect();
    const frame = Buffer.alloc(6);
    frame.writeUInt16LE(data.length + 4, 0);
    frame.writeUInt32LE(0x02, 2);
    await this.sendPacket(0x6a, Buffer.concat([frame, data]));
  }

  // Send one learned packet (hex string). Calls run one at a time, and a failed
  // send re-authenticates once before giving up (the session may have expired).
  send(hex) {
    const data = Buffer.from(hex, 'hex');
    const run = async () => {
      try {
        await this.transmit(data);
      } catch (err) {
        this.log.warn(`Send failed (${err.message}); reconnecting and retrying once`);
        this.ready = null;
        await this.transmit(data);
      }
    };
    const result = this.queue.then(run, run);
    this.queue = result.catch(() => {});
    return result;
  }
}

module.exports = { BroadlinkRemote };
