// MCAP 세션 화면: 영상 + 손 스켈레톤 + 촉각 히트맵 + 트래커 궤적 + 시계열, 하나의 타임라인으로 동기화
import { loadSession, videoToMp4, indexAt, nearest, projectToImage, CAMERA_POSES } from './mcap.js';

const PALETTE = ['#2f6fde', '#e0763a', '#2fa36b', '#c2459a', '#8a63d2', '#c9a227', '#1f9bb3', '#d0463f'];
const FINGER_COLORS = { thumb: '#e0763a', index: '#2f6fde', middle: '#2fa36b', ring: '#c2459a', pinky: '#8a63d2' };
const fingerColor = name => FINGER_COLORS[Object.keys(FINGER_COLORS).find(k => name.startsWith(k))] || css('--muted');
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const css = name => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

// container에 그리고, 정리 함수를 반환
export function renderMcap(container, u8) {
  const s = loadSession(u8);
  const disposers = [];
  const meta = s.metadata.session || {};
  const fmt = t => `${t.toFixed(2)} s`;

  container.insertAdjacentHTML('beforeend', `
    <div class="stats">
      ${meta.user_id ? `<div class="stat"><b>${esc(meta.user_id)}</b><span>사용자</span></div>` : ''}
      ${meta.task ? `<div class="stat"><b>${esc(meta.task)}</b><span>task</span></div>` : ''}
      <div class="stat"><b>${s.duration.toFixed(1)} s</b><span>길이</span></div>
      <div class="stat"><b>${s.messageCount.toLocaleString()}</b><span>메시지</span></div>
      <div class="stat"><b>${s.series.length + s.videos.length + s.hands.length}</b><span>스트림</span></div>
    </div>
    <div class="mc-top"></div>
    <div class="mc-timeline">
      <button class="mc-play">▶</button>
      <input type="range" class="mc-seek" min="0" max="${s.duration}" step="0.001" value="0">
      <span class="mc-time">${fmt(0)} / ${fmt(s.duration)}</span>
      <select class="mc-speed">${[0.25, 0.5, 1, 2, 4].map(r => `<option value="${r}" ${r === 1 ? 'selected' : ''}>${r}×</option>`).join('')}</select>
    </div>
    <div class="mc-panels"></div>
    <div class="mc-charts"></div>`);
  const panels = container.querySelector('.mc-panels');
  const q = sel => container.querySelector(sel);

  // ---- clock ----
  let t = 0, playing = false, last = 0, rate = 1, raf = 0;
  const views = [];
  const setTime = nt => {
    t = Math.max(0, Math.min(s.duration, nt));
    q('.mc-seek').value = t;
    q('.mc-time').textContent = `${fmt(t)} / ${fmt(s.duration)}`;
    views.forEach(v => v.draw(t, playing));
  };
  const tick = now => {
    if (playing) {
      // 영상이 재생 중이면 영상 시간을 기준으로 (버퍼링/탭 전환에도 어긋나지 않게)
      const master = views.map(v => v.clock?.()).find(x => x != null);
      setTime(master ?? t + (now - last) / 1000 * rate);
      if (t >= s.duration) pause();
    }
    last = now;
    raf = requestAnimationFrame(tick);
  };
  raf = requestAnimationFrame(tick);
  const play = () => { if (t >= s.duration) t = 0; playing = true; q('.mc-play').textContent = '❚❚'; views.forEach(v => v.play?.(t, rate)); };
  const pause = () => { playing = false; q('.mc-play').textContent = '▶'; views.forEach(v => v.pause?.(t)); };
  q('.mc-play').onclick = () => playing ? pause() : play();
  q('.mc-seek').oninput = e => { setTime(+e.target.value); views.forEach(v => v.seek?.(t)); };
  q('.mc-speed').onchange = e => { rate = +e.target.value; if (playing) views.forEach(v => v.play?.(t, rate)); };
  const seekTo = nt => { setTime(nt); views.forEach(v => v.seek?.(t)); };
  disposers.push(() => cancelAnimationFrame(raf));

  // top: 영상·3D처럼 위쪽에 나란히 놓는 패널
  const panel = (title, top) => {
    const el = document.createElement('div');
    el.className = 'mc-panel';
    el.innerHTML = `<div class="mc-title">${esc(title)}</div>`;
    (top ? q('.mc-top') : panels).append(el);
    return el;
  };

  // 영상 위에 손 겹치기 (카메라 위치를 아는 경우)
  function addOverlay(el, box, vid, v) {
    const cam = CAMERA_POSES[v.topic.match(/\/zed\/([^/]+)\//)?.[1]];
    if (!cam || !v.K || !s.rig.hands.length) return;
    const same = s.rig.created === cam.rigCreated;
    const cv = document.createElement('canvas');
    cv.className = 'mc-overlay';
    box.append(cv);
    const title = el.querySelector('.mc-title');
    title.insertAdjacentHTML('beforeend', ` <label class="mc-toggle"><input type="checkbox" ${same ? 'checked' : ''}> 손 겹치기</label>`);
    if (!same) el.insertAdjacentHTML('beforeend', '<div class="msg err">이 녹화는 카메라 위치를 구할 때와 rig 보정이 달라서 손이 어긋날 수 있어요.</div>');
    const on = title.querySelector('input');
    let lastT = 0;
    const redraw = () => {
      const { ctx, w, hgt } = fit(cv);
      if (!on.checked) return;
      // object-fit: contain 으로 실제 영상이 그려진 영역
      const sc = Math.min(w / v.width, hgt / v.height), ox = (w - v.width * sc) / 2, oy = (hgt - v.height * sc) / 2;
      const px = (x, y, z) => { const [u, q] = projectToImage(cam, v.K, x, y, z); return [ox + u * sc, oy + q * sc]; };
      for (const h of s.rig.hands) {
        const i = nearest(h.t, lastT + cam.timeOffset), j = h.joints[i], tr = h.tracker[i];
        const at = k => px(j[k * 3], j[k * 3 + 1], j[k * 3 + 2]);
        ctx.lineCap = 'round'; ctx.lineWidth = 2;
        h.parent.forEach((par, k) => {
          if (par < 0) return;
          const a = at(par), b = at(k);
          ctx.strokeStyle = fingerColor(h.names[k] || '');
          ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke();
        });
        ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5;
        h.names.forEach((n, k) => {
          if (!n.endsWith('_tip')) return;
          const p = at(k);
          ctx.beginPath(); ctx.arc(p[0], p[1], 3, 0, 7); ctx.stroke();
        });
        // 트래커 윗면 흰 점
        const d = cam.trackerDot, r = tr.rot, m = px(tr.pos[0] - d * r[2], tr.pos[1] - d * r[5], tr.pos[2] - d * r[8]);
        ctx.strokeStyle = '#ffe14d'; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.moveTo(m[0] - 6, m[1]); ctx.lineTo(m[0] + 6, m[1]); ctx.moveTo(m[0], m[1] - 6); ctx.lineTo(m[0], m[1] + 6); ctx.stroke();
      }
    };
    on.onchange = redraw;
    views.push({ draw: tt => { lastT = tt; redraw(); } });
    const ro = new ResizeObserver(redraw);
    ro.observe(cv);
    disposers.push(() => ro.disconnect());
  }

  // ---- video ----
  for (const v of s.videos) {
    const el = panel(v.topic, true);
    try {
      const { url, offset } = videoToMp4(v);
      disposers.push(() => URL.revokeObjectURL(url));
      const vid = document.createElement('video');
      Object.assign(vid, { src: url, muted: true, playsInline: true, preload: 'auto', className: 'media' });
      const box = document.createElement('div');
      box.className = 'mc-vid';
      box.append(vid);
      el.append(box);
      addOverlay(el, box, vid, v);
      const vt = () => Math.max(0, t - offset);
      views.push({
        clock: () => (vid.paused || vid.ended || vid.seeking ? null : vid.currentTime + offset),
        draw: (_, isPlaying) => { if (isPlaying && Math.abs(vid.currentTime - vt()) > 0.2) vid.currentTime = vt(); },
        play: (_, r) => { vid.playbackRate = r; vid.currentTime = vt(); vid.play().catch(() => {}); },
        pause: () => { vid.pause(); vid.currentTime = vt(); },
        seek: () => { vid.currentTime = vt(); },
      });
    } catch (e) {
      el.insertAdjacentHTML('beforeend', `<div class="msg err">${esc(e.message)}</div>`);
    }
  }

  // ---- image stream (CompressedImage) ----
  for (const im of s.images) {
    const el = panel(im.topic, true), img = document.createElement('img');
    img.className = 'media';
    el.append(img);
    const ts = im.frames.map(f => f.t);
    let cur = -1, url = null;
    views.push({ draw: tt => {
      const i = indexAt(ts, tt);
      if (i === cur) return;
      cur = i;
      if (url) URL.revokeObjectURL(url);
      url = URL.createObjectURL(new Blob([im.frames[i].data], { type: `image/${im.frames[i].format}` }));
      img.src = url;
    } });
    disposers.push(() => url && URL.revokeObjectURL(url));
  }

  // ---- 3D: rig 좌표의 손 + Vive 트래커 ----
  if (s.rig.hands.length) {
    const el = panel('3D · rig 좌표 (m) · 드래그 회전, 휠 확대, 더블클릭 카메라 시점', true);
    const cv = canvas(el);
    if (s.rig.problem) el.insertAdjacentHTML('beforeend', `<div class="msg err">${esc(s.rig.problem)}</div>`);
    // 움직인 범위 전체가 보이도록
    const lo = [Infinity, Infinity, 0], hi = [-Infinity, -Infinity, 0];
    for (const h of s.rig.hands) for (let f = 0; f < h.joints.length; f += 5) {
      const j = h.joints[f];
      for (let i = 0; i < j.length; i++) { const k = i % 3; if (j[i] < lo[k]) lo[k] = j[i]; if (j[i] > hi[k]) hi[k] = j[i]; }
    }
    const home3d = [0, 1, 2].map(k => (lo[k] + hi[k]) / 2);
    let center = home3d;
    const span = Math.max(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2], 0.2);
    const home = { yaw: -0.9, pitch: 0.6, dist: span * 1.5 };
    let { yaw, pitch, dist } = home, lastT = 0;
    // 카메라 위치를 알면 기본 시점을 천장 카메라와 똑같이 (렌즈 값까지 사용)
    const vid = s.videos.find(v => v.K && CAMERA_POSES[v.topic.match(/\/zed\/([^/]+)\//)?.[1]]);
    const cam = vid && CAMERA_POSES[vid.topic.match(/\/zed\/([^/]+)\//)?.[1]];
    const camBasis = cam && {
      right: cam.R.slice(0, 3), up: cam.R.slice(3, 6).map(v => -v), fwd: cam.R.slice(6, 9),
      eye: [0, 1, 2].map(k => -(cam.R[k] * cam.t[0] + cam.R[k + 3] * cam.t[1] + cam.R[k + 6] * cam.t[2])),
    };
    let camView = !!cam;
    // 카메라 시점에서 벗어날 때 같은 위치에서 궤도 회전이 시작되도록
    const leaveCam = () => {
      if (!camView) return;
      camView = false;
      const { eye, fwd } = camBasis;
      dist = 1.2;
      center = eye.map((v, k) => v + fwd[k] * dist);
      pitch = Math.asin(-fwd[2]);
      yaw = Math.atan2(-fwd[1], -fwd[0]);
    };
    const redraw = () => {
      const { ctx, w, hgt } = fit(cv);
      let eye, right, up, fwd, f, cx0 = w / 2, cy0 = hgt / 2;
      if (camView) {
        ({ eye, right, up, fwd } = camBasis);
        const sc = Math.min(w / vid.width, hgt / vid.height);
        f = vid.K[0] * sc;
        cx0 = (w - vid.width * sc) / 2 + vid.K[2] * sc;
        cy0 = (hgt - vid.height * sc) / 2 + vid.K[5] * sc;
      } else {
        const cy = Math.cos(yaw), sy = Math.sin(yaw), cp = Math.cos(pitch), sp = Math.sin(pitch);
        eye = [center[0] + dist * cp * cy, center[1] + dist * cp * sy, center[2] + dist * sp];
        right = [-sy, cy, 0]; up = [-sp * cy, -sp * sy, cp]; fwd = [-cp * cy, -cp * sy, -sp];
        f = Math.min(w, hgt) * 1.3;
      }
      const proj = p => {
        const d = [p[0] - eye[0], p[1] - eye[1], p[2] - eye[2]];
        const z = d[0] * fwd[0] + d[1] * fwd[1] + d[2] * fwd[2];
        if (z < 0.02) return null; // 카메라 뒤
        const x = d[0] * right[0] + d[1] * right[1] + d[2] * right[2], y = d[0] * up[0] + d[1] * up[1] + d[2] * up[2];
        return [cx0 + x * f / z, cy0 - y * f / z];
      };
      const line = (a, b, color, width = 1) => {
        const pa = proj(a), pb = proj(b);
        if (!pa || !pb) return;
        ctx.strokeStyle = color; ctx.lineWidth = width;
        ctx.beginPath(); ctx.moveTo(pa[0], pa[1]); ctx.lineTo(pb[0], pb[1]); ctx.stroke();
      };
      ctx.lineCap = 'round';
      ctx.font = '11px sans-serif'; ctx.textAlign = 'center';

      // 바닥 격자 (z = 0, 10 cm 간격)
      const g0 = [lo[0], lo[1]].map(v => Math.floor(Math.min(v, 0) * 10 - 1) / 10);
      const g1 = [hi[0], hi[1]].map(v => Math.ceil(Math.max(v, 0) * 10 + 1) / 10);
      for (let x = g0[0]; x <= g1[0] + 1e-6; x += 0.1) line([x, g0[1], 0], [x, g1[1], 0], css('--line'));
      for (let y = g0[1]; y <= g1[1] + 1e-6; y += 0.1) line([g0[0], y, 0], [g1[0], y, 0], css('--line'));

      // rig 원점 축
      [[[0.1, 0, 0], '#d0463f', 'X'], [[0, 0.1, 0], '#2fa36b', 'Y'], [[0, 0, 0.1], '#2f6fde', 'Z']].forEach(([v, c, label]) => {
        line([0, 0, 0], v, c, 2);
        const p = proj(v);
        if (p) { ctx.fillStyle = c; ctx.fillText(label, p[0], p[1] - 4); }
      });

      const lines = [];
      for (const h of s.rig.hands) {
        const i = indexAt(h.t, lastT), j = h.joints[i], tr = h.tracker[i];
        const at = k => [j[k * 3], j[k * 3 + 1], j[k * 3 + 2]];
        // 트래커 궤적: 전체는 옅게, 지나온 부분은 진하게
        for (let k = 4; k < h.tracker.length; k += 4) line(h.tracker[k - 4].pos, h.tracker[k].pos, k <= i ? PALETTE[0] : css('--line'), k <= i ? 1.5 : 1);
        // 트래커 본체 축 + 손목까지 연결
        const w0 = h.names.indexOf('wrist');
        ctx.setLineDash([3, 3]); line(tr.pos, at(w0), css('--muted')); ctx.setLineDash([]);
        [[tr.rot[0], tr.rot[3], tr.rot[6], '#d0463f'], [tr.rot[1], tr.rot[4], tr.rot[7], '#2fa36b'], [tr.rot[2], tr.rot[5], tr.rot[8], '#2f6fde']]
          .forEach(([x, y, z, c]) => line(tr.pos, [tr.pos[0] + x * 0.03, tr.pos[1] + y * 0.03, tr.pos[2] + z * 0.03], c, 2));
        // 손 뼈대
        h.parent.forEach((par, k) => { if (par >= 0) line(at(par), at(k), fingerColor(h.names[k] || ''), 3); });
        ctx.fillStyle = css('--text');
        for (let k = 0; k < h.names.length; k++) {
          const p = proj(at(k));
          if (p) { ctx.beginPath(); ctx.arc(p[0], p[1], 2.2, 0, 7); ctx.fill(); }
        }
        const fmt3 = v => v.map(x => x.toFixed(3)).join(', ');
        lines.push(`${h.side}  손목 [${fmt3(at(w0))}]  검지 끝 [${fmt3(at(h.names.indexOf('index_tip')))}]`);
      }
      ctx.fillStyle = css('--muted'); ctx.textAlign = 'left';
      lines.forEach((l, k) => ctx.fillText(l, 8, hgt - 8 - (lines.length - 1 - k) * 15));
    };
    drag(cv, (dx, dy) => { leaveCam(); yaw -= dx * 0.01; pitch = Math.max(-1.5, Math.min(1.5, pitch + dy * 0.01)); redraw(); });
    cv.addEventListener('wheel', e => { e.preventDefault(); leaveCam(); dist = Math.max(0.1, dist * Math.exp(e.deltaY * 0.001)); redraw(); }, { passive: false });
    cv.ondblclick = () => { camView = !!cam; ({ yaw, pitch, dist } = home); center = home3d; redraw(); };
    views.push({ draw: tt => { lastT = tt; redraw(); } });
    // 영상이 로드되면 줄 높이가 바뀌므로 크기 변화에 맞춰 다시 그림
    const ro = new ResizeObserver(redraw);
    ro.observe(cv);
    disposers.push(() => ro.disconnect());
  } else if (s.rig.problem) {
    panel('3D · rig 좌표', true).insertAdjacentHTML('beforeend', `<div class="msg err">3D로 합칠 수 없어요: ${esc(s.rig.problem)}</div>`);
  }

  // ---- hand skeleton ----
  // 3D로 합칠 수 없는 녹화에서만 대신 표시
  const has3d = s.rig.hands.length > 0;
  for (const h of has3d ? [] : s.hands) {
    const el = panel(`${h.topic} · 드래그로 회전`);
    const cv = canvas(el);
    let yaw = 0, pitch = 0;
    drag(cv, (dx, dy) => { yaw += dx * 0.01; pitch += dy * 0.01; redraw(); });
    let extent = 0.05;
    for (const p of h.pos.slice(0, 50)) for (const x of p) extent = Math.max(extent, Math.abs(x));
    let lastT = 0;
    const redraw = () => {
      const p = h.pos[indexAt(h.t, lastT)];
      const { ctx, w, hgt } = fit(cv);
      const sc = Math.min(w, hgt) * 0.45 / extent, cy = Math.cos(yaw), sy = Math.sin(yaw), cp = Math.cos(pitch), sp = Math.sin(pitch);
      // x(손가락 방향)를 화면 위로, 손가락 축 기준 yaw / 옆축 기준 pitch 회전
      const raw = Array.from({ length: p.length / 3 }, (_, i) => {
        const x = p[i * 3], y = p[i * 3 + 1], z = p[i * 3 + 2];
        const y1 = y * cy - z * sy, z1 = y * sy + z * cy;
        return [y1 * sc, -(x * cp + z1 * sp) * sc];
      });
      // 손 전체를 패널 가운데로
      const xs = raw.map(r => r[0]), ys = raw.map(r => r[1]);
      const ox = w / 2 - (Math.min(...xs) + Math.max(...xs)) / 2, oy = hgt / 2 - (Math.min(...ys) + Math.max(...ys)) / 2;
      const proj = i => [raw[i][0] + ox, raw[i][1] + oy];
      ctx.lineWidth = 3; ctx.lineCap = 'round';
      h.parent.forEach((par, i) => {
        if (par < 0) return;
        const [ax, ay] = proj(par), [bx, by] = proj(i);
        ctx.strokeStyle = fingerColor(h.joints[i] || '');
        ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.stroke();
      });
      ctx.fillStyle = css('--text');
      for (let i = 0; i < p.length / 3; i++) { const [x, y] = proj(i); ctx.beginPath(); ctx.arc(x, y, 2.5, 0, 7); ctx.fill(); }
    };
    views.push({ draw: tt => { lastT = tt; redraw(); } });
  }

  // ---- tactile heatmaps (layout attrs.points_mm 있는 Values) ----
  const tactile = s.series.filter(x => x.layout?.attrs?.points_mm);
  if (tactile.length) {
    const el = panel('촉각 (Paxini, 법선력 z)');
    const cv = canvas(el);
    const mods = tactile.map(x => {
      const pts = JSON.parse(x.layout.attrs.points_mm);
      const zi = pts.map((_, i) => x.names.indexOf(`p${i}_z`));
      let max = 1;
      for (const j of zi) if (j >= 0) for (const v of x.cols[j]) if (v > max) max = v;
      return { name: x.layout.attrs.module || x.topic.split('/').slice(-2, -1)[0], pts, zi, max, s: x };
    });
    views.push({ draw: tt => {
      const { ctx, w, hgt } = fit(cv);
      const cellW = w / mods.length;
      mods.forEach((m, k) => {
        const i = indexAt(m.s.t, tt);
        const xs = m.pts.map(p => p[0]), ys = m.pts.map(p => p[1]);
        const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
        const sc = Math.min((cellW - 24) / (x1 - x0 || 1), (hgt - 44) / (y1 - y0 || 1));
        const ox = k * cellW + cellW / 2, oy = 20 + (hgt - 44) / 2;
        let total = 0;
        m.pts.forEach((p, j) => {
          const v = m.zi[j] >= 0 ? m.s.cols[m.zi[j]][i] : 0;
          total += v || 0;
          ctx.fillStyle = heat(Math.min(1, (v || 0) / m.max));
          ctx.beginPath();
          ctx.arc(ox + (p[0] - (x0 + x1) / 2) * sc, oy - (p[1] - (y0 + y1) / 2) * sc, Math.max(2, sc * 0.75), 0, 7);
          ctx.fill();
        });
        ctx.fillStyle = css('--muted'); ctx.font = '11px sans-serif'; ctx.textAlign = 'center';
        ctx.fillText(m.name, ox, 12);
        ctx.fillText(`Σz ${total.toFixed(1)} N`, ox, hgt - 6);
      });
    } });
  }

  // ---- tracker trajectory (top view) ----
  for (const p of has3d ? [] : s.poses) {
    const el = panel(`${p.topic} · 위에서 본 궤적`);
    const cv = canvas(el);
    const [X, Y, Z] = p.cols;
    const [x0, x1, y0, y1] = [Math.min(...X), Math.max(...X), Math.min(...Y), Math.max(...Y)];
    views.push({ draw: tt => {
      const { ctx, w, hgt } = fit(cv);
      const span = Math.max(x1 - x0, y1 - y0, 0.05), sc = Math.min(w, hgt - 20) * 0.85 / span;
      const px = i => [w / 2 + (X[i] - (x0 + x1) / 2) * sc, (hgt - 20) / 2 - (Y[i] - (y0 + y1) / 2) * sc];
      const cur = indexAt(p.t, tt);
      ctx.strokeStyle = css('--line'); ctx.lineWidth = 1.5; ctx.beginPath();
      for (let i = 0; i < X.length; i += 2) { const [a, b] = px(i); i ? ctx.lineTo(a, b) : ctx.moveTo(a, b); }
      ctx.stroke();
      ctx.strokeStyle = PALETTE[0]; ctx.beginPath();
      for (let i = 0; i <= cur; i += 2) { const [a, b] = px(i); i ? ctx.lineTo(a, b) : ctx.moveTo(a, b); }
      ctx.stroke();
      const [cx, cy] = px(cur);
      ctx.fillStyle = PALETTE[1]; ctx.beginPath(); ctx.arc(cx, cy, 5, 0, 7); ctx.fill();
      ctx.fillStyle = css('--muted'); ctx.font = '11px sans-serif'; ctx.textAlign = 'center';
      ctx.fillText(`x ${X[cur].toFixed(3)}  y ${Y[cur].toFixed(3)}  z ${Z[cur].toFixed(3)} m`, w / 2, hgt - 6);
    } });
  }

  // ---- time series ----
  const chartsEl = q('.mc-charts');
  for (const sr of s.series) {
    const card = document.createElement('div');
    card.className = 'mc-chart';
    const unit = sr.layout?.unit && sr.layout.unit !== 'mixed' ? ` (${sr.layout.unit})` : '';
    card.innerHTML = `<div class="mc-chart-head"><span class="mc-title">${esc(sr.topic)}${esc(unit)}</span>
      <span class="mc-chips"></span>
      <select class="mc-add"><option value="">+ 채널 (${sr.names.length})</option>${sr.names.map((n, i) => `<option value="${i}">${esc(n)}</option>`).join('')}</select></div>
      <div class="mc-chart-wrap"><canvas></canvas><div class="mc-cursor"></div></div>`;
    chartsEl.append(card);
    const selected = sr.names.map((n, i) => i).filter(i => !/seq|^p\d+_/.test(sr.names[i])).slice(0, 3);
    const chart = new Chart(card.querySelector('canvas'), {
      type: 'line',
      data: { datasets: [] },
      options: {
        animation: false, parsing: false, normalized: true, maintainAspectRatio: false,
        interaction: { mode: 'nearest', axis: 'x', intersect: false },
        scales: {
          x: { type: 'linear', min: 0, max: s.duration, ticks: { color: css('--muted'), maxTicksLimit: 8, callback: v => `${Math.round(v * 10) / 10}s` }, grid: { color: css('--line') } },
          y: { ticks: { color: css('--muted'), maxTicksLimit: 5 }, grid: { color: css('--line') } },
        },
        plugins: { legend: { display: false }, decimation: { enabled: true, algorithm: 'min-max' } },
      },
    });
    const dataset = i => ({
      label: sr.names[i], idx: i,
      data: Array.from(sr.t, (x, k) => ({ x, y: sr.cols[i][k] })),
      borderColor: PALETTE[i % PALETTE.length], borderWidth: 1.2, pointRadius: 0,
    });
    const renderChips = () => {
      card.querySelector('.mc-chips').innerHTML = chart.data.datasets.map(d =>
        `<span class="chip" data-i="${d.idx}" style="color:${d.borderColor}">${esc(d.label)} ×</span>`).join('');
      card.querySelectorAll('.mc-chips .chip').forEach(c => c.onclick = () => {
        chart.data.datasets = chart.data.datasets.filter(d => d.idx !== +c.dataset.i);
        chart.update(); renderChips();
      });
    };
    card.querySelector('.mc-add').onchange = e => {
      const raw = e.target.value, i = +raw;
      e.target.value = '';
      if (raw === '') return;
      if (!chart.data.datasets.some(d => d.idx === i)) { chart.data.datasets.push(dataset(i)); chart.update(); renderChips(); }
    };
    chart.data.datasets = selected.map(dataset);
    chart.update();
    renderChips();
    const cursor = card.querySelector('.mc-cursor');
    card.querySelector('canvas').onclick = e => seekTo(chart.scales.x.getValueForPixel(e.offsetX));
    views.push({ draw: tt => { cursor.style.left = `${chart.scales.x.getPixelForValue(tt)}px`; } });
    disposers.push(() => chart.destroy());
  }

  setTime(0);
  return () => disposers.forEach(d => d());
}

// ---- canvas helpers ----
function canvas(parent) {
  const cv = document.createElement('canvas');
  cv.className = 'mc-canvas';
  parent.append(cv);
  return cv;
}

function fit(cv) {
  const dpr = devicePixelRatio || 1, w = cv.clientWidth, hgt = cv.clientHeight;
  if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(hgt * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(hgt * dpr); }
  const ctx = cv.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, hgt);
  return { ctx, w, hgt };
}

function drag(el, onMove) {
  el.onpointerdown = e => {
    let x = e.clientX, y = e.clientY;
    el.setPointerCapture(e.pointerId);
    el.onpointermove = m => { onMove(m.clientX - x, m.clientY - y); x = m.clientX; y = m.clientY; };
    el.onpointerup = () => { el.onpointermove = null; };
  };
}

// 0..1 → 옅은 회색 → 주황 → 빨강
function heat(v) {
  const stops = [[0, [200, 205, 212]], [0.3, [242, 190, 90]], [0.65, [232, 118, 58]], [1, [196, 40, 40]]];
  let k = 1;
  while (k < stops.length - 1 && v > stops[k][0]) k++;
  const [a, ca] = stops[k - 1], [b, cb] = stops[k], f = (v - a) / (b - a || 1);
  return `rgb(${ca.map((c, i) => Math.round(c + (cb[i] - c) * Math.max(0, Math.min(1, f)))).join(',')})`;
}
