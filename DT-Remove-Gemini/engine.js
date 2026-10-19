/*
 * GeminiWM — phát hiện & xoá logo ngôi sao (✦) của Gemini ở góc phải-dưới ảnh.
 *
 * Logo là hình sao 4 cánh màu trắng, phủ với độ mờ cố định (~30%):
 *     out = a * 255 + (1 - a) * orig
 * nên có thể khôi phục chính xác điểm ảnh gốc bằng phép đảo:
 *     orig = (out - 255 * a) / (1 - a)
 * Hình sao được mô tả giải tích (4 cung tròn lõm), nên dùng được ở mọi độ phân giải.
 *
 * Chạy được trong trang web, Worker, Service Worker (MV3) và Node (để test).
 */
(function (root) {
  'use strict';

  // Tỉ lệ bán kính cung / bán kính sao — đo từ ảnh mẫu của Gemini.
  const RHO = 1.347;
  // Tâm cung tròn nằm trên đường chéo, toạ độ chuẩn hoá theo bán kính sao.
  const ARC_C = (1 + Math.sqrt(2 * RHO * RHO - 1)) / 2;
  // Gemini đặt tâm logo cách mép phải và mép dưới bằng nhau, ≈ 4.62 lần bán kính sao.
  const OFFSET_RATIO = 4.62;
  // Độ mờ đo được trên ảnh mẫu.
  const DEFAULT_ALPHA = 0.3;

  const BAND_PX = 4;      // nửa bề rộng dải làm sạch quanh viền logo (px)
  const MAX_FIX = 25;     // lệch hơn mức này là đường biên thật, không kẹp
  const MAX_SMOOTH = 5;   // mức sửa tối đa của bước nội suy trơn (mức xám)
  const COARSE_R = 4.5;   // bán kính sao ở lưới thô khi dò tìm tổng quát
  const COARSE_K = 6;     // nửa kích thước cửa sổ mẫu ở lưới thô (13x13)

  // Khoảng cách có dấu (đơn vị = bán kính sao) tới biên ngôi sao; > 0 là bên trong.
  function sdStar(x, y) {
    x = Math.abs(x);
    y = Math.abs(y);
    const dx = x - ARC_C, dy = y - ARC_C;
    const dc = Math.sqrt(dx * dx + dy * dy) - RHO;
    return Math.min(dc, 1 - x, 1 - y);
  }

  // Kích thước vùng góc phải-dưới cần quét.
  function cornerSize(W, H) {
    return Math.min(W, H, Math.max(160, Math.round(0.22 * Math.max(W, H))));
  }

  function luminance(region) {
    const { data, width, height } = region;
    const L = new Float32Array(width * height);
    for (let i = 0, j = 0; i < L.length; i++, j += 4) {
      L[i] = 0.299 * data[j] + 0.587 * data[j + 1] + 0.114 * data[j + 2];
    }
    return L;
  }

  // Lấy mẫu song tuyến tại toạ độ liên tục (tâm điểm ảnh i nằm ở i + 0.5).
  function sample(L, S, x, y) {
    x -= 0.5;
    y -= 0.5;
    if (x < 0) x = 0; else if (x > S - 1.001) x = S - 1.001;
    if (y < 0) y = 0; else if (y > S - 1.001) y = S - 1.001;
    const x0 = x | 0, y0 = y | 0, fx = x - x0, fy = y - y0;
    const i = y0 * S + x0;
    return (L[i] * (1 - fx) + L[i + 1] * fx) * (1 - fy) + (L[i + S] * (1 - fx) + L[i + S + 1] * fx) * fy;
  }

  // Bảng tổng tích luỹ (summed-area table) kích thước (w+1) x (h+1).
  function integral(src, w, h, squared) {
    const S = new Float64Array((w + 1) * (h + 1));
    for (let y = 0; y < h; y++) {
      let row = 0;
      for (let x = 0; x < w; x++) {
        const v = src[y * w + x];
        row += squared ? v * v : v;
        S[(y + 1) * (w + 1) + x + 1] = S[y * (w + 1) + x + 1] + row;
      }
    }
    return S;
  }

  function boxSum(S, w, x0, y0, x1, y1) {
    const W1 = w + 1;
    return S[y1 * W1 + x1] - S[y0 * W1 + x1] - S[y1 * W1 + x0] + S[y0 * W1 + x0];
  }

  /*
   * Bản đồ độ phủ (0..1) của ngôi sao trong khung `box`: khử răng cưa theo điểm ảnh
   * rồi làm nhoè Gauss với độ lệch chuẩn s (ảnh đã bị co giãn / nén JPEG).
   */
  function coverageMap(box, p, out, tmp) {
    const { x0, y0, bw, bh } = box;
    for (let y = 0; y < bh; y++) {
      const ny = (y0 + y + 0.5 - p.cy) / p.r;
      for (let x = 0; x < bw; x++) {
        const v = 0.5 + sdStar((x0 + x + 0.5 - p.cx) / p.r, ny) * p.r;
        out[y * bw + x] = v <= 0 ? 0 : v >= 1 ? 1 : v;
      }
    }
    if (p.s < 0.05) return out;
    const k = Math.ceil(3 * p.s);
    const g = new Float32Array(2 * k + 1);
    let gs = 0;
    for (let i = -k; i <= k; i++) gs += g[i + k] = Math.exp(-0.5 * (i / p.s) ** 2);
    for (let i = 0; i < g.length; i++) g[i] /= gs;
    for (let y = 0; y < bh; y++) {
      for (let x = 0; x < bw; x++) {
        let acc = 0;
        for (let i = -k; i <= k; i++) {
          const xx = x + i < 0 ? 0 : x + i >= bw ? bw - 1 : x + i;
          acc += g[i + k] * out[y * bw + xx];
        }
        tmp[y * bw + x] = acc;
      }
    }
    for (let y = 0; y < bh; y++) {
      for (let x = 0; x < bw; x++) {
        let acc = 0;
        for (let i = -k; i <= k; i++) {
          const yy = y + i < 0 ? 0 : y + i >= bh ? bh - 1 : y + i;
          acc += g[i + k] * tmp[yy * bw + x];
        }
        out[y * bw + x] = acc;
      }
    }
    return out;
  }

  function makeBox(cx, cy, pad, W, H) {
    const x0 = Math.max(0, Math.floor(cx - pad));
    const y0 = Math.max(0, Math.floor(cy - pad));
    const x1 = Math.min(W, Math.ceil(cx + pad));
    const y1 = Math.min(H, Math.ceil(cy + pad));
    return { x0, y0, bw: Math.max(0, x1 - x0), bh: Math.max(0, y1 - y0) };
  }

  /*
   * Các điểm trên đường viền ngôi sao (toạ độ chuẩn hoá) kèm pháp tuyến hướng ra ngoài,
   * chia thành 8 nhóm (mỗi cung lõm 2 nửa). Bỏ 15% hai đầu cung (gần mũi nhọn).
   */
  const BOUNDARY = (function () {
    const pts = [];
    const t1 = Math.atan2(-ARC_C, 1 - ARC_C);   // mũi (1, 0)
    const t2 = Math.atan2(1 - ARC_C, -ARC_C);   // mũi (0, 1)
    const M = 24;
    for (let q = 0; q < 4; q++) {
      const sx = q & 1 ? -1 : 1, sy = q & 2 ? -1 : 1;
      for (let i = 0; i < M; i++) {
        const t = t1 + (t2 - t1) * (0.15 + 0.7 * (i + 0.5) / M);
        const c = Math.cos(t), s = Math.sin(t);
        pts.push({
          x: sx * (ARC_C + RHO * c),
          y: sy * (ARC_C + RHO * s),
          nx: -sx * c,
          ny: -sy * s,
          g: q * 2 + (i < M / 2 ? 0 : 1),
        });
      }
    }
    return pts;
  })();

  /*
   * Độ chênh sáng trong/ngoài dọc đường viền ở khoảng cách d (px). Với logo thật,
   * mỗi nhóm cho a_g = (trong - ngoài) / (255 - ngoài) ≈ độ mờ của logo.
   */
  function edgeStats(L, S, cx, cy, r, d, robust) {
    const sin = new Float64Array(8), sout = new Float64Array(8), cnt = new Float64Array(8);
    const pts = robust ? [] : null;
    for (const p of BOUNDARY) {
      const bx = cx + p.x * r, by = cy + p.y * r;
      const lin = sample(L, S, bx - p.nx * d, by - p.ny * d);
      const lout = sample(L, S, bx + p.nx * d, by + p.ny * d);
      sin[p.g] += lin;
      sout[p.g] += lout;
      cnt[p.g]++;
      if (pts && 255 - lout >= 10) pts.push((lin - lout) / (255 - lout));
    }
    let valid = 0, consistent = 0, score = 0;
    const as = [];
    for (let g = 0; g < 8; g++) {
      const lin = sin[g] / cnt[g], lout = sout[g] / cnt[g];
      const room = 255 - lout;
      if (room < 10) continue; // nền gần trắng: logo gần như vô hình
      const a = (lin - lout) / room;
      valid++;
      if (a > 0.1) consistent++;
      score += Math.max(-0.5, Math.min(1.2, a / DEFAULT_ALPHA));
      as.push(a);
    }
    as.sort((u, v) => u - v);
    const trimmed = as.length > 4 ? as.slice(1, -1) : as;
    const A = trimmed.length ? trimmed.reduce((u, v) => u + v, 0) / trimmed.length : 0;
    const res = { valid, consistent, score, A };
    if (pts) {
      // Thống kê theo từng điểm viền: bền khi nền có đường biên mạnh cắt qua logo
      // (vài đoạn viền bị nhiễu nhưng trung vị vẫn đúng).
      pts.sort((u, v) => u - v);
      res.nPts = pts.length;
      res.Amed = pts.length ? pts[pts.length >> 1] : 0;
      res.frac = pts.length ? pts.filter((v) => v > 0.1).length / pts.length : 0;
    }
    return res;
  }

  /*
   * Bước 1 — dò theo vị trí chuẩn của Gemini: tâm cách mép phải = mép dưới
   * ≈ OFFSET_RATIO × bán kính. Duyệt bán kính và độ lệch nhỏ quanh vị trí đó.
   */
  function priorSearch(L, S, W, H) {
    const maxDim = Math.max(W, H);
    const rMin = Math.max(4, 0.004 * maxDim);
    const rMax = Math.min(0.04 * maxDim, S / (OFFSET_RATIO + 1.2));
    const hits = [];
    for (let r = rMin; r <= rMax; r *= 1.02) {
      const c0 = S - OFFSET_RATIO * r;
      const step = Math.max(0.4, 0.06 * r);
      const d = edgeDelta(r);
      let best = null;
      for (let j = -4; j <= 4; j++) {
        for (let i = -4; i <= 4; i++) {
          const cx = c0 + i * step, cy = c0 + j * step;
          const e = edgeStats(L, S, cx, cy, r, d);
          if (!best || e.score > best.score) best = Object.assign(e, { cx, cy, r });
        }
      }
      if (best) hits.push(best);
    }
    hits.sort((a, b) => b.score - a.score);
    const out = [];
    for (const h of hits) {
      if (out.length === 3) break;
      if (out.every((o) => Math.abs(o.r - h.r) > 0.08 * o.r || Math.hypot(o.cx - h.cx, o.cy - h.cy) > 0.3 * o.r)) {
        out.push(h);
      }
    }
    return out;
  }

  // Căn chỉnh chính xác tâm & bán kính bằng độ chênh sáng sát đường viền.
  function alignToEdges(L, S, h) {
    const cost = (p) => -edgeStats(L, S, p.cx, p.cy, p.r, 0.9).score;
    const { p } = descend(
      cost,
      { cx: h.cx, cy: h.cy, r: h.r },
      { cx: 0.04 * h.r, cy: 0.04 * h.r, r: 0.03 * h.r },
      { cx: 0.05, cy: 0.05, r: 0.03 },
      { r: [3, 1e9] }
    );
    return Object.assign(p, edgeStats(L, S, p.cx, p.cy, p.r, edgeDelta(p.r), true));
  }

  // Viền ngôi sao có khớp với logo thật không: hoặc gần như mọi đoạn viền đều khớp,
  // hoặc (nền nhiều đường biên) đa số điểm viền khớp và trung vị độ mờ hợp lý.
  function edgesLookLikeLogo(a) {
    if (a.valid >= 4 && a.consistent >= a.valid - 1 && a.A >= 0.12 && a.A <= 0.6) return true;
    return a.nPts >= 40 && a.frac >= 0.6 && a.Amed >= 0.15 && a.Amed <= 0.5;
  }

  // Khoảng cách (px) từ đường viền tới điểm lấy mẫu trong/ngoài: vượt qua vùng mép nhoè
  // nhưng vẫn nằm trong thân ngôi sao.
  function edgeDelta(r) {
    return Math.max(1.5, Math.min(0.15 * r, 1.5 + 0.05 * r));
  }

  // Mẫu sao đã trừ trung bình, dùng cho tương quan chuẩn hoá (NCC) ở lưới thô.
  const TEMPLATE = (function () {
    const n = 2 * COARSE_K + 1;
    const t = new Float32Array(n * n);
    coverageMap({ x0: 0, y0: 0, bw: n, bh: n }, { cx: n / 2, cy: n / 2, r: COARSE_R, s: 0 }, t, null);
    let mean = 0;
    for (let i = 0; i < t.length; i++) mean += t[i];
    mean /= t.length;
    let norm = 0;
    for (let i = 0; i < t.length; i++) {
      t[i] -= mean;
      norm += t[i] * t[i];
    }
    return { n, t, norm: Math.sqrt(norm) };
  })();

  /*
   * Dò tổng quát (dự phòng, khi logo không ở vị trí chuẩn): với mỗi kích thước,
   * thu nhỏ vùng góc sao cho ngôi sao có bán kính COARSE_R rồi tìm NCC cao nhất.
   */
  function coarseSearch(L, S, W, H) {
    const maxDim = Math.max(W, H);
    // Logo thật luôn có bán kính ≳ 0.6% cạnh dài; sao nhỏ hơn dễ nhầm với chấm sáng.
    const rMin = Math.max(8, 0.005 * maxDim);
    const rMax = Math.max(rMin * 1.5, Math.min(0.035 * maxDim, S / 3));
    const satL = integral(L, S, S, false);
    const { n, t, norm } = TEMPLATE;
    const cands = [];

    for (let r = rMin; r <= rMax; r *= 1.06) {
      const g = Math.max(1, r / COARSE_R);
      const N = Math.floor(S / g);
      if (N < n + 2) continue;
      const C = new Float32Array(N * N);
      const edges = new Int32Array(N + 1);
      for (let i = 0; i <= N; i++) edges[i] = Math.min(S, Math.round(i * g));
      for (let y = 0; y < N; y++) {
        for (let x = 0; x < N; x++) {
          const area = (edges[x + 1] - edges[x]) * (edges[y + 1] - edges[y]);
          C[y * N + x] = boxSum(satL, S, edges[x], edges[y], edges[x + 1], edges[y + 1]) / area;
        }
      }
      const s1 = integral(C, N, N, false);
      const s2 = integral(C, N, N, true);
      const cnt = n * n;
      let best = -1, bx = 0, by = 0;
      for (let y = 0; y + n <= N; y++) {
        for (let x = 0; x + n <= N; x++) {
          const sum = boxSum(s1, N, x, y, x + n, y + n);
          const sq = boxSum(s2, N, x, y, x + n, y + n);
          const v = sq - (sum * sum) / cnt;
          if (v < 1) continue; // vùng phẳng tuyệt đối
          let cross = 0;
          for (let ty = 0, k = 0; ty < n; ty++) {
            const row = (y + ty) * N + x;
            for (let tx = 0; tx < n; tx++, k++) cross += t[k] * C[row + tx];
          }
          const ncc = cross / (norm * Math.sqrt(v));
          if (ncc > best) {
            best = ncc;
            bx = x;
            by = y;
          }
        }
      }
      if (best > 0) cands.push({ score: best, cx: (bx + n / 2) * g, cy: (by + n / 2) * g, r, g });
    }

    cands.sort((a, b) => b.score - a.score);
    const picked = [];
    for (const c of cands) {
      if (picked.every((p) => Math.hypot(p.cx - c.cx, p.cy - c.cy) > Math.max(p.r, c.r))) {
        picked.push(c);
        if (picked.length === 3) break;
      }
    }
    return picked;
  }

  // Tìm cực tiểu theo từng toạ độ, bước giảm dần.
  function descend(cost, p, step, minStep, limits) {
    const keys = Object.keys(step);
    step = Object.assign({}, step);
    let best = cost(p);
    for (let iter = 0; iter < 300; iter++) {
      let improved = false;
      for (const k of keys) {
        for (const sgn of [1, -1]) {
          const q = Object.assign({}, p);
          q[k] += sgn * step[k];
          const lim = limits[k];
          if (lim && (q[k] < lim[0] || q[k] > lim[1])) continue;
          const c = cost(q);
          if (c < best) {
            best = c;
            p = q;
            improved = true;
          }
        }
      }
      if (!improved) {
        let done = true;
        for (const k of keys) {
          step[k] /= 2;
          if (step[k] >= minStep[k]) done = false;
        }
        if (done) break;
      }
    }
    return { p, cost: best };
  }

  // Tổng biến thiên (TV, chuẩn L1) của ảnh khôi phục — bền với nền có hoa văn.
  function makeTVCost(L, S, box) {
    const { x0, y0, bw, bh } = box;
    const cov = new Float32Array(bw * bh);
    const tmp = new Float32Array(bw * bh);
    const P = new Float32Array(bw * bh);
    return function (p) {
      coverageMap(box, p, cov, tmp);
      for (let y = 0; y < bh; y++) {
        for (let x = 0; x < bw; x++) {
          const a = p.A * cov[y * bw + x];
          P[y * bw + x] = (L[(y0 + y) * S + x0 + x] - 255 * a) / (1 - a);
        }
      }
      let tv = 0;
      for (let y = 0; y < bh; y++) {
        for (let x = 0; x < bw; x++) {
          const v = P[y * bw + x];
          if (x + 1 < bw) tv += Math.abs(P[y * bw + x + 1] - v);
          if (y + 1 < bh) tv += Math.abs(P[(y + 1) * bw + x] - v);
        }
      }
      return tv / (bw * bh);
    };
  }

  /*
   * Ảnh khôi phục trong khung sát logo phải gần một mặt cong bậc hai (nền trơn):
   * bình phương tối thiểu, không thiên lệch — chính xác nhất khi nền mịn.
   */
  function makeSmoothCost(L, S, box) {
    const { x0, y0, bw, bh } = box;
    const n = bw * bh;
    const cov = new Float32Array(n);
    const tmp = new Float32Array(n);
    // Cơ sở đa thức bậc 2 đã trực chuẩn hoá (Gram–Schmidt) trên khung.
    const basis = [];
    const cx = bw / 2, cy = bh / 2, sc = Math.max(bw, bh) / 2;
    const raw = [() => 1, (x) => x, (x, y) => y, (x) => x * x, (x, y) => x * y, (x, y) => y * y];
    for (const f of raw) {
      const v = new Float64Array(n);
      for (let y = 0; y < bh; y++)
        for (let x = 0; x < bw; x++) v[y * bw + x] = f((x + 0.5 - cx) / sc, (y + 0.5 - cy) / sc);
      for (const b of basis) {
        let d = 0;
        for (let i = 0; i < n; i++) d += v[i] * b[i];
        for (let i = 0; i < n; i++) v[i] -= d * b[i];
      }
      let nn = 0;
      for (let i = 0; i < n; i++) nn += v[i] * v[i];
      nn = Math.sqrt(nn);
      if (nn < 1e-9) continue;
      for (let i = 0; i < n; i++) v[i] /= nn;
      basis.push(v);
    }
    const P = new Float64Array(n);
    return function (p) {
      coverageMap(box, p, cov, tmp);
      let ss = 0;
      for (let y = 0; y < bh; y++) {
        for (let x = 0; x < bw; x++) {
          const a = p.A * cov[y * bw + x];
          const v = (L[(y0 + y) * S + x0 + x] - 255 * a) / (1 - a);
          P[y * bw + x] = v;
          ss += v * v;
        }
      }
      for (const b of basis) {
        let d = 0;
        for (let i = 0; i < n; i++) d += P[i] * b[i];
        ss -= d * d;
      }
      return ss / n;
    };
  }

  const LIMITS = { A: [0.03, 0.85], s: [0, 2.5], r: [3, 1e9] };

  /*
   * Bước 2 — tinh chỉnh ở độ phân giải gốc từ hình học đã biết gần đúng.
   * Nền mịn: bình phương tối thiểu trên tất cả tham số. Nền hoa văn: giữ hình học,
   * lấy độ mờ ước lượng từ đường viền và chỉ chỉnh độ nhoè biên.
   */
  function polish(L, S, p0, edgeA, meta) {
    const tvBox = makeBox(p0.cx, p0.cy, p0.r * 1.3 + 4, S, S);
    const tvCost = makeTVCost(L, S, tvBox);
    const smBox = makeBox(p0.cx, p0.cy, p0.r * 1.15 + 4.5, S, S);
    const smCost = makeSmoothCost(L, S, smBox);

    const start = { cx: p0.cx, cy: p0.cy, r: p0.r, A: p0.A, s: p0.s };
    const before = smCost(Object.assign({}, start, { A: 0 }));
    const res = descend(
      smCost,
      start,
      { cx: 0.25, cy: 0.25, r: start.r * 0.02, A: 0.02, s: 0.2 },
      { cx: 0.01, cy: 0.01, r: 0.01, A: 0.001, s: 0.02 },
      LIMITS
    );
    const sred = before > 0 ? 1 - res.cost / before : 0;

    let p;
    if (sred >= 0.7 && tvCost(res.p) <= tvCost(start) * 1.03) {
      p = res.p;
    } else {
      // Nền hoa văn / nền sáng: ước lượng độ mờ từ viền bị nhiễu (đo được 0,26–0,35 cho cùng một
      // logo), trong khi logo Gemini luôn có độ mờ ~0,30 — dùng giá trị chuẩn nếu ước lượng gần đó.
      const A = Math.abs(edgeA - DEFAULT_ALPHA) <= 0.08 ? DEFAULT_ALPHA
        : edgeA >= 0.18 && edgeA <= 0.45 ? edgeA : DEFAULT_ALPHA;
      p = descend(tvCost, Object.assign({}, start, { A }), { s: 0.3 }, { s: 0.03 }, LIMITS).p;
    }
    const base = tvCost(Object.assign({}, p, { A: 0 }));
    return Object.assign(p, meta, {
      reduction: base > 0 ? 1 - tvCost(p) / base : 0,
      smoothReduction: sred,
    });
  }

  /*
   * Tinh chỉnh ứng viên từ dò tổng quát: kích thước ở lưới thô chỉ gần đúng, nên dò lại
   * kích thước + vị trí quanh đó bằng độ chênh sáng dọc đường viền, căn chỉnh, rồi polish.
   */
  function refineGeneric(L, S, cand) {
    const meta = { score: cand.score, reduction: 0, smoothReduction: 0 };
    let best = null;
    for (let k = 0.75; k <= 1.45; k *= 1.04) {
      const r = cand.r * k;
      const d = edgeDelta(r);
      for (let j = -2; j <= 2; j++) {
        for (let i = -2; i <= 2; i++) {
          const cx = cand.cx + i * cand.g * 0.5, cy = cand.cy + j * cand.g * 0.5;
          const e = edgeStats(L, S, cx, cy, r, d);
          if (!best || e.score > best.score) best = Object.assign(e, { cx, cy, r });
        }
      }
    }
    const a = alignToEdges(L, S, best);
    meta.consistent = a.consistent;
    meta.valid = a.valid;
    if (a.valid < 6 || a.consistent < a.valid - 1 || a.A < 0.12 || a.A > 0.6) {
      return Object.assign({ cx: a.cx, cy: a.cy, r: a.r, A: a.A, s: 0 }, meta);
    }
    return polish(L, S, { cx: a.cx, cy: a.cy, r: a.r, A: a.A, s: 0.5 }, a.A, meta);
  }

  function insideRegion(p, S) {
    return p.cx + p.r <= S && p.cy + p.r <= S && p.cx - p.r >= 0 && p.cy - p.r >= 0;
  }

  /*
   * Tìm logo trong vùng góc (ImageData-like {data,width,height}) có góc phải-dưới
   * trùng với góc phải-dưới của ảnh gốc kích thước W x H.
   */
  function detect(region, W, H, debug) {
    const S = region.width;
    if (region.height !== S || S < 48) return { found: false };
    const L = luminance(region);
    const log = (x) => debug && debug.push(x);

    // Đường chính: vị trí chuẩn của Gemini.
    for (const h of priorSearch(L, S, W, H)) {
      if (h.valid < 4 || h.consistent < 4) continue;
      const a = alignToEdges(L, S, h);
      log(Object.assign({ stage: 'prior' }, a));
      if (!edgesLookLikeLogo(a)) continue;
      const fit = polish(L, S, { cx: a.cx, cy: a.cy, r: a.r, A: a.Amed, s: 0.5 }, a.Amed, {
        prior: true, score: a.score / a.valid, consistent: a.consistent, valid: a.valid,
      });
      // Logo trắng trên nền trắng (váy cưới, voan): xoá xong ảnh mịn hơn rất ít nên các tiêu chí
      // "mịn hơn" không đạt — khi đó dựa vào việc gần như mọi điểm viền đều khớp đúng hình logo.
      const strongEdges = a.valid >= 6 && a.consistent >= a.valid - 1 && a.frac >= 0.85 &&
        a.Amed >= 0.2 && a.Amed <= 0.42;
      // Logo thật có mép sắc (s ≤ ~0,9 kể cả ảnh JPG/thu nhỏ) và bán kính ≈ 1,0–1,3% cạnh dài ảnh;
      // vệt sáng tình cờ trên nền thường nhoè hơn hoặc nhỏ hơn nhiều.
      const plausible = fit.s <= 1.2 && fit.r >= Math.max(5, 0.006 * Math.max(W, H));
      fit.found = fit.A >= 0.15 && fit.A <= 0.6 && plausible && insideRegion(fit, S) &&
        (fit.reduction >= 0.04 || fit.smoothReduction >= 0.3 || strongEdges);
      log(Object.assign({ stage: 'prior-fit' }, fit));
      if (fit.found) return fit;
    }

    // Dự phòng: dò tổng quát trên toàn vùng góc.
    let bestFit = { found: false };
    for (const cand of coarseSearch(L, S, W, H)) {
      const fit = refineGeneric(L, S, cand);
      // Ngoài vị trí chuẩn thì đòi hỏi chặt hơn: mép sắc và ảnh phải mịn hơn sau khi xoá.
      fit.found = fit.A >= 0.15 && fit.A <= 0.6 && fit.s <= 1.2 && insideRegion(fit, S) &&
        fit.r >= Math.max(7, 0.0045 * Math.max(W, H)) &&
        fit.score >= 0.45 && fit.valid >= 6 && fit.consistent >= fit.valid - 1 &&
        fit.reduction >= 0.04;
      log(Object.assign({ stage: 'generic', cand }, fit));
      if (fit.found && (!bestFit.found || fit.reduction > bestFit.reduction)) bestFit = fit;
    }
    return bestFit;
  }

  // Khôi phục điểm ảnh gốc trong vùng (thay đổi trực tiếp region.data).
  // lossy: ảnh nguồn nén mất dữ liệu (JPG/WebP) — làm sạch thêm nhiễu nén quanh viền logo.
  function removeFromRegion(region, p, lossy = true) {
    const { data, width: S, height: Hh } = region;
    const box = makeBox(p.cx, p.cy, p.r + 5 + 3 * p.s, S, Hh);
    const { bw, bh } = box;
    const cov = coverageMap(box, p, new Float32Array(bw * bh), new Float32Array(bw * bh));
    for (let y = 0; y < bh; y++) {
      for (let x = 0; x < bw; x++) {
        const a = p.A * cov[y * bw + x];
        if (a <= 0.001) continue;
        const k = 1 / (1 - a), sub = 255 * a;
        const i = ((box.y0 + y) * S + box.x0 + x) * 4;
        for (let c = 0; c < 3; c++) {
          const v = (data[i + c] - sub) * k;
          data[i + c] = v < 0 ? 0 : v > 255 ? 255 : v;
        }
      }
    }
    cleanEdgeBand(data, S, box, cov, p, lossy);
  }

  /*
   * Mép logo trong ảnh đã nén JPEG / co giãn có nhiễu không đảo ngược được (vệt "ringing"
   * hình ngôi sao còn sót). Xử lý dải quanh đường viền theo 2 bước:
   *  1. Kẹp các giá trị lệch bất thường so với trung vị các điểm lân cận NGOÀI dải.
   *  2. Nền mịn: thay dải bằng nội suy trơn (Laplace) từ các điểm sạch hai bên; nền càng
   *     nhiều hoa văn thì trộn càng ít, để không xoá vân thật của ảnh.
   */
  function cleanEdgeBand(data, S, box, cov, p, lossy) {
    const { x0, y0, bw, bh } = box;
    // Dải quanh đường viền: nhiễu nén JPEG ("ringing") lan ra vài px hai bên mép logo.
    // Ảnh PNG (không nén mất dữ liệu) gần như khôi phục chính xác: chỉ xử lý sát mép.
    const half = (lossy ? Math.min(BAND_PX, 0.35 * p.r) : 1) + 1.5 * p.s;
    const band = new Uint8Array(bw * bh);
    for (let y = 0; y < bh; y++) {
      const ny = (y0 + y + 0.5 - p.cy) / p.r;
      for (let x = 0; x < bw; x++) {
        const sd = sdStar((x0 + x + 0.5 - p.cx) / p.r, ny) * p.r;
        if (Math.abs(sd) <= half) band[y * bw + x] = 1;
      }
    }
    const fixes = [];
    const vals = [[], [], []];
    const weight = new Float32Array(bw * bh); // mức nội suy trơn (0..1) cho từng điểm của dải
    for (let y = 0; y < bh; y++) {
      for (let x = 0; x < bw; x++) {
        if (!band[y * bw + x]) continue;
        weight[y * bw + x] = 0.5;
        for (const v of vals) v.length = 0;
        for (let rad = 3; rad <= 7 && vals[0].length < 12; rad++) {
          for (const v of vals) v.length = 0;
          for (let dy = -rad; dy <= rad; dy++) {
            for (let dx = -rad; dx <= rad; dx++) {
              const xx = x + dx, yy = y + dy;
              if (xx < 0 || yy < 0 || xx >= bw || yy >= bh || band[yy * bw + xx]) continue;
              const i = ((y0 + yy) * S + x0 + xx) * 4;
              vals[0].push(data[i]);
              vals[1].push(data[i + 1]);
              vals[2].push(data[i + 2]);
            }
          }
        }
        if (vals[0].length < 12) continue;
        const i = ((y0 + y) * S + x0 + x) * 4;
        let rough = 0;
        for (let c = 0; c < 3; c++) {
          const v = vals[c].sort((a, b) => a - b);
          const med = v[v.length >> 1];
          const dev = v.map((u) => Math.abs(u - med)).sort((a, b) => a - b);
          const sigma = 1.4826 * dev[dev.length >> 1]; // độ nhám tự nhiên của nền quanh đó
          rough = Math.max(rough, sigma);
          const T = lossy ? Math.max(1.5, 2 * sigma) : Math.max(4, 2.5 * sigma);
          const cur = data[i + c];
          // Lệch quá xa thì đó là đường biên thật của ảnh (mép kệ, nếp vải), không phải nhiễu.
          if (Math.abs(cur - med) > MAX_FIX) continue;
          if (cur > med + T) fixes.push(i + c, med + T);
          else if (cur < med - T) fixes.push(i + c, med - T);
        }
        weight[y * bw + x] = Math.min(1, Math.max(0, (3.5 - rough) / 2.5));
      }
    }
    for (let k = 0; k < fixes.length; k += 2) data[fixes[k]] = fixes[k + 1];

    // Bước 2 (chỉ ảnh nén): nội suy trơn trên dải (Gauss–Seidel), biên là các điểm ngoài dải.
    if (!lossy) return;
    const idx = [];
    for (let k = 0; k < bw * bh; k++) if (band[k] && weight[k] > 0) idx.push(k);
    if (!idx.length) return;
    const fill = new Float32Array(bw * bh);
    for (let c = 0; c < 3; c++) {
      for (let y = 0; y < bh; y++) {
        for (let x = 0; x < bw; x++) fill[y * bw + x] = data[((y0 + y) * S + x0 + x) * 4 + c];
      }
      for (let it = 0; it < 80; it++) {
        for (const k of idx) {
          const x = k % bw, y = (k / bw) | 0;
          let sum = 0, n = 0;
          if (x > 0) { sum += fill[k - 1]; n++; }
          if (x + 1 < bw) { sum += fill[k + 1]; n++; }
          if (y > 0) { sum += fill[k - bw]; n++; }
          if (y + 1 < bh) { sum += fill[k + bw]; n++; }
          fill[k] = sum / n;
        }
      }
      for (const k of idx) {
        const i = ((y0 + ((k / bw) | 0)) * S + x0 + (k % bw)) * 4 + c;
        // Nhiễu nén chỉ vài mức xám: giới hạn mức sửa để nội suy không kéo màu qua đường biên.
        const delta = weight[k] * (fill[k] - data[i]);
        data[i] += delta > MAX_SMOOTH ? MAX_SMOOTH : delta < -MAX_SMOOTH ? -MAX_SMOOTH : delta;
      }
    }
  }

  function cropCorner(img, S) {
    const { width: W, height: H } = img;
    const region = { width: S, height: S, data: new Uint8ClampedArray(S * S * 4) };
    for (let y = 0; y < S; y++) {
      const src = ((H - S + y) * W + (W - S)) * 4;
      region.data.set(img.data.subarray(src, src + S * 4), y * S * 4);
    }
    return region;
  }

  // Xử lý toàn bộ ImageData của ảnh (dùng cho Node/test hoặc khi đã có đủ điểm ảnh).
  function processImageData(img, debug, opts) {
    const { width: W, height: H } = img;
    const S = cornerSize(W, H);
    const region = cropCorner(img, S);
    const res = detect(region, W, H, debug);
    if (res.found) {
      removeFromRegion(region, res, !(opts && opts.lossy === false));
      for (let y = 0; y < S; y++) {
        const dst = ((H - S + y) * W + (W - S)) * 4;
        img.data.set(region.data.subarray(y * S * 4, (y + 1) * S * 4), dst);
      }
    }
    return res;
  }

  /*
   * Chép thông tin mô tả "tạo bằng AI" (XMP, IPTC) từ ảnh gốc sang ảnh đã xử lý — dùng khi
   * người dùng muốn giữ nhãn AI. Không chép chữ ký C2PA (APP11 / caBX): chữ ký gắn với điểm ảnh
   * gốc nên không còn hợp lệ sau khi sửa; không chép EXIF để tránh xoay ảnh hai lần.
   */
  function carryMetadataBytes(src, out, type) {
    const join = (head, parts, tail) => {
      const res = new Uint8Array(head.length + parts.reduce((n, s) => n + s.length, 0) + tail.length);
      let p = 0;
      res.set(head, p); p += head.length;
      for (const s of parts) { res.set(s, p); p += s.length; }
      res.set(tail, p);
      return res;
    };
    if (type === 'image/jpeg') {
      const keep = [];
      for (let i = 2; i + 4 <= src.length && src[i] === 0xff;) {
        const m = src[i + 1];
        if (m === 0xda || m === 0xd9) break; // bắt đầu dữ liệu ảnh
        const len = (src[i + 2] << 8) | src[i + 3];
        const seg = src.subarray(i, i + 2 + len);
        const isXmp = m === 0xe1 && String.fromCharCode(...seg.subarray(4, 32)).startsWith('http://ns.adobe.com/xap/1.0/');
        if (isXmp || m === 0xed) keep.push(seg); // APP1 XMP, APP13 IPTC
        i += 2 + len;
      }
      if (!keep.length || out[0] !== 0xff || out[1] !== 0xd8) return out;
      const at = out[2] === 0xff && out[3] === 0xe0 ? 4 + ((out[4] << 8) | out[5]) : 2; // sau APP0 (JFIF)
      return join(out.subarray(0, at), keep, out.subarray(at));
    }
    if (type === 'image/png') {
      const keep = [];
      for (let i = 8; i + 12 <= src.length;) {
        const len = ((src[i] << 24) | (src[i + 1] << 16) | (src[i + 2] << 8) | src[i + 3]) >>> 0;
        const t = String.fromCharCode(src[i + 4], src[i + 5], src[i + 6], src[i + 7]);
        if (t === 'iTXt' || t === 'tEXt' || t === 'zTXt') keep.push(src.subarray(i, i + 12 + len));
        if (t === 'IEND') break;
        i += 12 + len;
      }
      if (!keep.length) return out;
      return join(out.subarray(0, 33), keep, out.subarray(33)); // ngay sau IHDR
    }
    return out;
  }

  function sniffType(b) {
    if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
    if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
    if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
        b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'image/webp';
    return '';
  }

  /*
   * Nhận Blob ảnh, trả về { blob, result }. Nếu không thấy logo thì trả lại đúng
   * Blob ban đầu (không mã hoá lại). Chỉ đọc/ghi vùng góc để nhanh với ảnh lớn.
   */
  async function processBlob(blob, opts) {
    const keepMeta = !!(opts && opts.keepMeta);
    const head = new Uint8Array(await blob.slice(0, 12).arrayBuffer());
    const type = sniffType(head);
    if (!type) return { blob, result: { found: false, reason: 'not-image' } };

    const bmp = await createImageBitmap(blob, {
      colorSpaceConversion: 'none',
      premultiplyAlpha: 'none',
    });
    const W = bmp.width, H = bmp.height;
    if (Math.min(W, H) < 128) {
      bmp.close();
      return { blob, result: { found: false, reason: 'too-small' } };
    }
    const canvas = new OffscreenCanvas(W, H);
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(bmp, 0, 0);
    bmp.close();

    const S = cornerSize(W, H);
    const region = ctx.getImageData(W - S, H - S, S, S);
    const result = detect(region, W, H);
    if (!result.found) return { blob, result };

    // opts.lossy: ép chế độ làm sạch nhiễu nén (vd. ảnh dán từ bộ nhớ tạm luôn là PNG
    // nhưng thường được giải mã từ ảnh JPG/WebP trên trang).
    const lossy = opts && typeof opts.lossy === 'boolean' ? opts.lossy : type !== 'image/png';
    removeFromRegion(region, result, lossy);
    ctx.putImageData(region, W - S, H - S);
    const out = await canvas.convertToBlob(
      type === 'image/png' ? { type } : { type, quality: 0.95 }
    );
    // Ảnh mới từ canvas không mang theo thông tin mô tả của ảnh gốc (kể cả nhãn "tạo bằng AI").
    if (!keepMeta) return { blob: out, result };
    const merged = carryMetadataBytes(
      new Uint8Array(await blob.arrayBuffer()), new Uint8Array(await out.arrayBuffer()), type);
    return { blob: new Blob([merged], { type }), result };
  }

  root.GeminiWM = {
    cornerSize,
    detect,
    removeFromRegion,
    processImageData,
    processBlob,
    carryMetadataBytes,
    sniffType,
  };
})(typeof globalThis !== 'undefined' ? globalThis : self);
