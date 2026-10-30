// 최소 MCAP 리더 + protobuf 디코더 + H.264 → MP4 변환 (브라우저 전용, 의존성: fzstd, mp4-muxer)
import { decompress as zstd } from 'https://cdn.jsdelivr.net/npm/fzstd@0.1.1/+esm';
import { Muxer, ArrayBufferTarget } from 'https://cdn.jsdelivr.net/npm/mp4-muxer@5.2.2/+esm';

const td = new TextDecoder();

// ---------- MCAP records ----------
class Reader {
  constructor(u8) { this.u8 = u8; this.dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength); this.o = 0; }
  u8_() { return this.u8[this.o++]; }
  u16() { const v = this.dv.getUint16(this.o, true); this.o += 2; return v; }
  u32() { const v = this.dv.getUint32(this.o, true); this.o += 4; return v; }
  u64() { const lo = this.dv.getUint32(this.o, true), hi = this.dv.getUint32(this.o + 4, true); this.o += 8; return hi * 2 ** 32 + lo; }
  bytes(n) { const b = this.u8.subarray(this.o, this.o + n); this.o += n; return b; }
  str() { return td.decode(this.bytes(this.u32())); }
  map() { const end = this.o + 4 + this.u32(), m = {}; while (this.o < end) { const k = this.str(); m[k] = this.str(); } return m; }
}

// 데이터 영역의 레코드를 순서대로 훑음. 잘린 버퍼(Range 일부 다운로드)면 거기서 멈춤. h.done = true 로 조기 종료.
export function scan(u8, h) {
  if (td.decode(u8.subarray(1, 5)) !== 'MCAP') throw new Error('MCAP 파일이 아닙니다');
  walk(u8, 8, h);
}

function walk(u8, off, h) {
  const r = new Reader(u8);
  r.o = off;
  while (r.o + 9 <= u8.length && !h.done) {
    const op = r.u8_(), len = r.u64(), stop = r.o + len;
    if (stop > u8.length || op === 0x0F || op === 0x02) return; // 잘림 / DataEnd / Footer
    record(op, r, stop, h);
    r.o = stop;
  }
}

function record(op, r, stop, h) {
  switch (op) {
    case 0x03: { const id = r.u16(), name = r.str(), encoding = r.str(); h.schema?.({ id, name, encoding, data: r.bytes(r.u32()) }); break; }
    case 0x04: { const id = r.u16(), schemaId = r.u16(), topic = r.str(), encoding = r.str(); h.channel?.({ id, schemaId, topic, encoding, metadata: r.map() }); break; }
    case 0x05: { const channelId = r.u16(); r.u32(); const logTime = r.u64(); r.u64(); h.message?.({ channelId, logTime, data: r.u8.subarray(r.o, stop) }); break; }
    case 0x06: {
      r.u64(); r.u64(); r.u64(); r.u32();
      const comp = r.str();
      let data = r.bytes(r.u64());
      if (comp === 'zstd') data = zstd(data);
      else if (comp) throw new Error(`${comp} 압축 MCAP은 아직 지원하지 않아요`);
      walk(data, 0, h);
      break;
    }
    case 0x0C: { const name = r.str(); h.metadata?.(name, r.map()); break; }
  }
}

// ---------- protobuf ----------
const camel = s => s.replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase());

// FileDescriptorSet 자체를 읽기 위한 최소 descriptor
const BOOT = {
  set: { 1: { name: 'file', type: 11, typeName: 'file', repeated: true } },
  file: { 2: { name: 'package', type: 9 }, 4: { name: 'messageType', type: 11, typeName: 'msg', repeated: true } },
  msg: { 1: { name: 'name', type: 9 }, 2: { name: 'field', type: 11, typeName: 'field', repeated: true },
    3: { name: 'nestedType', type: 11, typeName: 'msg', repeated: true } },
  field: { 1: { name: 'name', type: 9 }, 3: { name: 'number', type: 5 }, 4: { name: 'label', type: 14 },
    5: { name: 'type', type: 14 }, 6: { name: 'typeName', type: 9 } },
};

// FileDescriptorSet → { 'pkg.Msg': { fieldNo: {name, type, typeName, repeated} } }
export function descriptorTypes(u8) {
  const types = {};
  const add = (m, prefix) => {
    const full = prefix ? `${prefix}.${m.name}` : m.name;
    types[full] = Object.fromEntries((m.field || []).map(f => [f.number,
      { name: camel(f.name), type: f.type, typeName: f.typeName?.replace(/^\./, ''), repeated: f.label === 3 }]));
    (m.nestedType || []).forEach(n => add(n, full));
  };
  for (const file of decode(BOOT, 'set', u8).file || []) (file.messageType || []).forEach(m => add(m, file.package));
  return types;
}

function varintFix(v, type) {
  if (typeof v === 'bigint') {
    if (type === 17 || type === 18) return Number((v >> 1n) ^ -(v & 1n));
    if (type === 3 || type === 5) return Number(BigInt.asIntN(64, v));
    return Number(v);
  }
  if (type === 17 || type === 18) return v % 2 ? -(v + 1) / 2 : v / 2;
  if (type === 8) return !!v;
  return v;
}

function makeVarint(u8, pos) {
  // 7바이트까지는 Number, 넘으면 BigInt (음수 int32/int64는 10바이트)
  return () => {
    let v = 0, m = 1, b, n = 0;
    const start = pos.o;
    do { b = u8[pos.o++]; v += (b & 0x7f) * m; m *= 128; n++; } while (b & 0x80);
    if (n <= 7) return v;
    let big = 0n;
    for (let i = n - 1; i >= 0; i--) big = (big << 7n) | BigInt(u8[start + i] & 0x7f);
    return big;
  };
}

function unpack(u8, type) {
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength), out = [];
  if (type === 2) for (let o = 0; o < u8.length; o += 4) out.push(dv.getFloat32(o, true));
  else if (type === 1) for (let o = 0; o < u8.length; o += 8) out.push(dv.getFloat64(o, true));
  else if (type === 7) for (let o = 0; o < u8.length; o += 4) out.push(dv.getUint32(o, true));
  else if (type === 15) for (let o = 0; o < u8.length; o += 4) out.push(dv.getInt32(o, true));
  else if (type === 6 || type === 16) for (let o = 0; o < u8.length; o += 8) out.push(dv.getUint32(o, true) + dv.getInt32(o + 4, true) * 2 ** 32);
  else { const pos = { o: 0 }, varint = makeVarint(u8, pos); while (pos.o < u8.length) out.push(varintFix(varint(), type)); }
  return out;
}

export function decode(types, name, u8) {
  const t = types[name] || {}, out = {}, pos = { o: 0 }, varint = makeVarint(u8, pos);
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  while (pos.o < u8.length) {
    const key = Number(varint()), no = Math.floor(key / 8), wt = key & 7, f = t[no];
    let v;
    if (wt === 0) v = varint();
    else if (wt === 1) { v = f?.type === 1 ? dv.getFloat64(pos.o, true) : dv.getUint32(pos.o, true) + dv.getInt32(pos.o + 4, true) * 2 ** 32; pos.o += 8; }
    else if (wt === 5) { v = f?.type === 2 ? dv.getFloat32(pos.o, true) : f?.type === 15 ? dv.getInt32(pos.o, true) : dv.getUint32(pos.o, true); pos.o += 4; }
    else if (wt === 2) { const n = Number(varint()); v = u8.subarray(pos.o, pos.o + n); pos.o += n; }
    else throw new Error(`protobuf wire type ${wt} 미지원`);
    if (!f) continue;
    if (wt === 2) {
      if (f.type === 9) v = td.decode(v);
      else if (f.type === 11) v = decode(types, f.typeName, v);
      else if (f.type !== 12) { const arr = (out[f.name] ??= []); for (const x of unpack(v, f.type)) arr.push(x); continue; }
    } else if (wt === 0) v = varintFix(v, f.type);
    if (f.repeated) (out[f.name] ??= []).push(v);
    else out[f.name] = v;
  }
  return out;
}

// ---------- session ----------
const tsToNs = ts => ts ? (Number(ts.seconds || 0) * 1e9 + (ts.nanos || 0)) : null;
const attrsObj = a => Array.isArray(a) ? Object.fromEntries(a.map(e => [e.key, e.value])) : (a || {});

// MCAP 전체 → 시각화용 구조
export function loadSession(u8) {
  const types = {}, schemas = {}, channels = {}, metadata = {};
  let t0 = Infinity, t1 = -Infinity;
  scan(u8, {
    schema: s => { schemas[s.id] = s; if (s.encoding === 'protobuf') Object.assign(types, descriptorTypes(s.data)); },
    channel: c => { channels[c.id] = { ...c, schema: schemas[c.schemaId]?.name, raw: [] }; },
    message: m => {
      channels[m.channelId]?.raw.push(m);
      if (m.logTime < t0) t0 = m.logTime;
      if (m.logTime > t1) t1 = m.logTime;
    },
    metadata: (name, m) => { metadata[name] = m; },
  });

  const chans = Object.values(channels).map(c => ({
    ...c, msgs: c.raw.map(m => ({ t: (m.logTime - t0) / 1e9, d: c.encoding === 'protobuf' ? decode(types, c.schema, m.data) : null })),
  }));
  const byTopic = Object.fromEntries(chans.map(c => [c.topic, c]));
  const layoutOf = topic => {
    const d = byTopic[topic + '_layout']?.msgs[0]?.d;
    return d && { names: d.names || [], unit: d.unit, rate: d.sampleRateHz, attrs: attrsObj(d.attrs) };
  };

  const series = [], hands = [], videos = [], images = [], poses = [];
  for (const c of chans) {
    const { schema, topic, msgs } = c;
    if (!msgs.length || /(_layout|\/topology|camera_info)$/.test(topic)) continue;
    const short = schema?.split('.').pop();
    if (short === 'Values') {
      const lay = layoutOf(topic), n = msgs[0].d.values?.length || 0;
      const names = lay?.names?.length === n ? lay.names : Array.from({ length: n }, (_, i) => `v${i}`);
      series.push(table(topic, names, msgs.map(m => m.t), msgs.map(m => m.d.values || []), lay));
    } else if (short === 'TrackerPose') {
      const names = ['x_m', 'y_m', 'z_m', 'qx', 'qy', 'qz', 'qw'];
      const rows = msgs.map(m => { const p = m.d.pose || {}; return [p.xM, p.yM, p.zM, p.qx, p.qy, p.qz, p.qw].map(v => v ?? 0); });
      const s = table(topic, names, msgs.map(m => m.t), rows);
      series.push(s); poses.push(s);
    } else if (short === 'SignalChunk') {
      const lay = layoutOf(topic), rate = lay?.rate || 1000;
      const ts = [], rows = [];
      for (const m of msgs) {
        const k = m.d.numSamples || 1, smp = m.d.samples || [], ch = smp.length / k;
        // 각 청크의 마지막 샘플이 수신 시각이라고 보고 앞으로 펼침
        for (let i = 0; i < k; i++) { ts.push(m.t + (i - k + 1) / rate); rows.push(smp.slice(i * ch, i * ch + ch)); }
      }
      const n = rows[0]?.length || 0;
      series.push(table(topic, lay?.names?.length === n ? lay.names : Array.from({ length: n }, (_, i) => `ch${i}`), ts, rows, lay));
    } else if (short === 'HandPose') {
      const base = topic.replace(/\/pose$/, '');
      const topo = byTopic[base + '/topology']?.msgs[0]?.d || {};
      hands.push({ topic, joints: topo.jointNames || [], parent: topo.parentIndex || [],
        t: Float64Array.from(msgs, m => m.t), pos: msgs.map(m => Float32Array.from(m.d.positionM || [])) });
    } else if (short === 'CompressedVideo') {
      const info = byTopic[topic.replace(/\/[^/]+$/, '/camera_info')]?.msgs[0]?.d;
      videos.push({ topic, width: info?.width || 1280, height: info?.height || 720, format: msgs[0].d.format,
        frames: msgs.map(m => ({ t: tsToNs(m.d.timestamp) != null ? (tsToNs(m.d.timestamp) - t0) / 1e9 : m.t, data: m.d.data })) });
    } else if (short === 'CompressedImage') {
      images.push({ topic, frames: msgs.map(m => ({ t: m.t, data: m.d.data, format: m.d.format || 'jpeg' })) });
    } else if (msgs[0].d) {
      // 그 밖의 메시지: 숫자 스칼라 필드만 그래프로
      const flat = msgs.map(m => flatNumbers(m.d));
      const names = Object.keys(flat[0]).filter(k => !k.startsWith('time.'));
      if (names.length) series.push(table(topic, names, msgs.map(m => m.t), flat.map(f => names.map(k => f[k]))));
    }
  }
  return { duration: (t1 - t0) / 1e9, start: t0, metadata, series, hands, videos, images, poses,
    messageCount: chans.reduce((a, c) => a + c.msgs.length, 0) };
}

function table(topic, names, ts, rows, layout) {
  return { topic, names, layout, t: Float64Array.from(ts),
    cols: names.map((_, j) => Float32Array.from(rows, r => r[j] ?? NaN)) };
}

function flatNumbers(obj, pre = '', out = {}) {
  for (const [k, v] of Object.entries(obj)) {
    const key = pre ? `${pre}.${k}` : k;
    if (typeof v === 'number') out[key] = v;
    else if (v && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Uint8Array)) flatNumbers(v, key, out);
  }
  return out;
}

// 정렬된 시간 배열에서 t 이하 마지막 인덱스
export function indexAt(ts, t) {
  let lo = 0, hi = ts.length - 1;
  if (hi < 0 || t < ts[0]) return 0;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (ts[mid] <= t) lo = mid; else hi = mid - 1; }
  return lo;
}

// ---------- H.264 Annex-B → MP4 ----------
function nalUnits(b) {
  const out = [];
  let i = 0, start = -1;
  while (i + 2 < b.length) {
    if (b[i] === 0 && b[i + 1] === 0 && b[i + 2] === 1) {
      if (start >= 0) out.push(b.subarray(start, b[i - 1] === 0 ? i - 1 : i));
      i += 3; start = i;
    } else i++;
  }
  if (start >= 0) out.push(b.subarray(start));
  return out;
}

export function videoToMp4(video) {
  if (video.format !== 'h264') throw new Error(`${video.format} 영상은 아직 지원하지 않아요 (h264만)`);
  const frames = video.frames.map(f => ({ t: f.t, nals: nalUnits(f.data) }));
  const first = frames.findIndex(f => f.nals.some(n => (n[0] & 31) === 5));
  if (first < 0) throw new Error('키프레임이 없어요');
  const sps = frames[first].nals.find(n => (n[0] & 31) === 7), pps = frames[first].nals.find(n => (n[0] & 31) === 8);
  if (!sps || !pps) throw new Error('SPS/PPS가 없어요');
  const hex = b => b.toString(16).padStart(2, '0');
  const avcC = new Uint8Array([1, sps[1], sps[2], sps[3], 0xff, 0xe1, sps.length >> 8, sps.length & 255, ...sps,
    1, pps.length >> 8, pps.length & 255, ...pps]);

  const target = new ArrayBufferTarget();
  const muxer = new Muxer({ target, video: { codec: 'avc', width: video.width, height: video.height },
    fastStart: 'in-memory', firstTimestampBehavior: 'offset' });
  const used = frames.slice(first), t0 = used[0].t;
  used.forEach((f, i) => {
    const nals = f.nals.filter(n => ![7, 8, 9].includes(n[0] & 31));
    const out = new Uint8Array(nals.reduce((a, n) => a + 4 + n.length, 0)), dv = new DataView(out.buffer);
    let o = 0;
    for (const n of nals) { dv.setUint32(o, n.length); out.set(n, o + 4); o += 4 + n.length; }
    const ts = Math.round((f.t - t0) * 1e6);
    const next = used[i + 1] ? Math.round((used[i + 1].t - t0) * 1e6) : ts + 33333;
    muxer.addVideoChunkRaw(out, f.nals.some(n => (n[0] & 31) === 5) ? 'key' : 'delta', ts, Math.max(1, next - ts),
      i === 0 ? { decoderConfig: { codec: `avc1.${hex(sps[1])}${hex(sps[2])}${hex(sps[3])}`,
        codedWidth: video.width, codedHeight: video.height, description: avcC } } : undefined);
  });
  muxer.finalize();
  return { url: URL.createObjectURL(new Blob([target.buffer], { type: 'video/mp4' })), offset: t0 };
}

// 파일 앞부분만으로 첫 영상 키프레임(또는 첫 이미지)을 찾아 썸네일용 URL 생성
export function firstFrame(u8) {
  const types = {}, schemas = {}, channels = {};
  let found = null;
  const h = {
    schema: s => { schemas[s.id] = s; if (s.encoding === 'protobuf') Object.assign(types, descriptorTypes(s.data)); },
    channel: c => { channels[c.id] = schemas[c.schemaId]?.name; },
    message: m => {
      const name = channels[m.channelId], short = name?.split('.').pop();
      if (short !== 'CompressedVideo' && short !== 'CompressedImage') return;
      const d = decode(types, name, m.data);
      if (short === 'CompressedImage') {
        found = { url: URL.createObjectURL(new Blob([d.data], { type: `image/${d.format || 'jpeg'}` })), kind: 'image' };
      } else if (d.format === 'h264' && nalUnits(d.data).some(n => (n[0] & 31) === 5)) {
        found = { ...videoToMp4({ format: 'h264', width: 1280, height: 720, frames: [{ t: 0, data: d.data }] }), kind: 'video' };
      }
      if (found) h.done = true;
    },
  };
  scan(u8, h);
  return found;
}
