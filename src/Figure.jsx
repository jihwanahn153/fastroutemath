import React, { useState, useMemo, useEffect, useRef } from "react";
import { compile, compilePoint } from "./mathexpr.js";

/* 모델이 내놓는 @@FIGURE 사양을 SVG로 그린다.
   사양은 "키: 값" 줄들이고, 값 안은 | 로 나눈다.
   JSON을 쓰지 않는 이유는 서버 프롬프트와 같다 — 백슬래시가 깨진다. */

const COLORS = {
  brass: "#e8c88d",
  dim: "#a89d88",
  warn: "#e0a35c",
  cool: "#8fb8c9",
  soft: "#7d6038",
};

const pickColor = (name) => COLORS[String(name || "").trim()] || COLORS.brass;

function num(v, fallback) {
  const n = Number(String(v).trim());
  return Number.isFinite(n) ? n : fallback;
}

export function parseFigure(raw) {
  const text = String(raw || "").trim();
  if (!text) return null;

  const fig = {
    title: "",
    note: "",
    xrange: [-5, 5],
    yrange: null, // null이면 곡선을 보고 자동으로 정한다
    params: [],
    items: [],
    ghost: false,
    equalAspect: false,
  };

  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    const colon = t.indexOf(":");
    if (colon === -1) continue;
    const key = t.slice(0, colon).trim().toLowerCase();
    const rest = t.slice(colon + 1).trim();
    const bars = rest.split("|").map((x) => x.trim());

    if (key === "title") fig.title = rest;
    else if (key === "note") fig.note = rest;
    else if (key === "ghost") fig.ghost = /on|true|yes/i.test(rest);
    else if (key === "aspect") fig.equalAspect = /equal|1:1/i.test(rest);
    else if (key === "xrange") {
      const [a, b] = rest.split(",");
      fig.xrange = [num(a, -5), num(b, 5)];
    } else if (key === "yrange") {
      if (/auto/i.test(rest)) fig.yrange = null;
      else {
        const [a, b] = rest.split(",");
        fig.yrange = [num(a, -5), num(b, 5)];
      }
    } else if (key === "param") {
      // param: a | 0, 4 | 0.1 | 1
      const name = (bars[0] || "a").replace(/[^A-Za-z_]/g, "") || "a";
      const [lo, hi] = (bars[1] || "0, 1").split(",");
      const min = num(lo, 0);
      const max = num(hi, 1);
      const step = num(bars[2], (max - min) / 40 || 0.1);
      fig.params.push({
        name,
        min,
        max,
        step: step > 0 ? step : 0.1,
        start: num(bars[3], (min + max) / 2),
      });
    } else if (key === "curve") {
      const fn = compile(bars[0]);
      if (fn) fig.items.push({ kind: "curve", fn, label: bars[1] || "", color: pickColor(bars[2]) });
    } else if (key === "xcurve") {
      // y를 독립변수로 삼는 곡선 (x = g(y))
      const fn = compile(bars[0]);
      if (fn) fig.items.push({ kind: "xcurve", fn, label: bars[1] || "", color: pickColor(bars[2]) });
    } else if (key === "point") {
      const pt = compilePoint(bars[0]);
      if (pt) fig.items.push({ kind: "point", pt, label: bars[1] || "", color: pickColor(bars[2]) });
    } else if (key === "vline") {
      const fn = compile(bars[0]);
      if (fn) fig.items.push({ kind: "vline", fn, label: bars[1] || "", color: pickColor(bars[2]) });
    } else if (key === "hline") {
      const fn = compile(bars[0]);
      if (fn) fig.items.push({ kind: "hline", fn, label: bars[1] || "", color: pickColor(bars[2]) });
    } else if (key === "segment") {
      const [aRaw, bRaw] = (bars[0] || "").split("->");
      const a = compilePoint(aRaw);
      const b = compilePoint(bRaw);
      if (a && b) fig.items.push({ kind: "segment", a, b, label: bars[1] || "", color: pickColor(bars[2]) });
    } else if (key === "polygon") {
      const pts = (bars[0] || "").split("->").map(compilePoint).filter(Boolean);
      if (pts.length >= 3) fig.items.push({ kind: "polygon", pts, label: bars[1] || "", color: pickColor(bars[2]) });
    } else if (key === "circle") {
      const c = compilePoint(bars[0]);
      const r = compile(bars[1]);
      if (c && r) fig.items.push({ kind: "circle", c, r, label: bars[2] || "", color: pickColor(bars[3]) });
    } else if (key === "shade") {
      // shade: 위쪽식 | 아래쪽식 | 0, 2 | 라벨
      const top = compile(bars[0]);
      const bottom = compile(bars[1] || "0");
      const [lo, hi] = (bars[2] || "").split(",");
      if (top && bottom) {
        fig.items.push({
          kind: "shade",
          top,
          bottom,
          from: compile(lo || "") || null,
          to: compile(hi || "") || null,
          label: bars[3] || "",
        });
      }
    } else if (key === "label") {
      const pt = compilePoint(bars[0]);
      if (pt) fig.items.push({ kind: "label", pt, label: bars[1] || "", color: pickColor(bars[2]) });
    }
  }

  if (!fig.items.length) return null;
  return fig;
}

/* 곡선을 표본으로 뜬다. 점근선이나 정의되지 않는 구간에서
   선이 화면을 가로질러 이어지면 완전히 잘못된 그림이 되므로 끊어준다. */
function sampleCurve(fn, vars, x0, x1, y0, y1, steps = 480) {
  const paths = [];
  let cur = [];
  const dx = (x1 - x0) / steps;
  let prevY = null;
  const span = y1 - y0;

  for (let i = 0; i <= steps; i += 1) {
    const x = x0 + dx * i;
    let y;
    try {
      y = fn({ ...vars, x });
    } catch (e) {
      y = NaN;
    }
    const ok = Number.isFinite(y);
    // 한 칸에 화면 높이만큼 뛰면 점근선을 넘은 것으로 본다
    const jumped = prevY !== null && Math.abs(y - prevY) > span * 1.2;
    if (!ok || jumped) {
      if (cur.length > 1) paths.push(cur);
      cur = [];
      prevY = ok ? y : null;
      if (!ok) continue;
    }
    cur.push([x, y]);
    prevY = y;
  }
  if (cur.length > 1) paths.push(cur);
  return paths;
}

function niceStep(span) {
  const rough = span / 8;
  const mag = Math.pow(10, Math.floor(Math.log10(rough)));
  const r = rough / mag;
  const mult = r >= 5 ? 5 : r >= 2 ? 2 : 1;
  return mult * mag;
}

const fmt = (v) => {
  if (Math.abs(v) < 1e-9) return "0";
  const r = Math.round(v * 1000) / 1000;
  return String(r);
};

export default function Figure({ spec }) {
  const fig = useMemo(() => parseFigure(spec), [spec]);
  const [vals, setVals] = useState(() => {
    const v = {};
    if (fig) for (const pm of fig.params) v[pm.name] = pm.start;
    return v;
  });
  const [playing, setPlaying] = useState(false);
  const rafRef = useRef(0);
  const dirRef = useRef(1);

  // 사양이 바뀌면 (새 문제) 매개변수를 초기값으로 되돌린다
  useEffect(() => {
    if (!fig) return;
    const v = {};
    for (const pm of fig.params) v[pm.name] = pm.start;
    setVals(v);
    setPlaying(false);
  }, [fig]);

  // 재생 — 매개변수를 왕복시켜 그래프가 어떻게 움직이는지 보여준다
  useEffect(() => {
    if (!playing || !fig || !fig.params.length) return undefined;
    const pm = fig.params[0];
    let last = performance.now();
    const tick = (now) => {
      const dt = Math.min(now - last, 60);
      last = now;
      setVals((prev) => {
        const cur = prev[pm.name] ?? pm.start;
        const speed = (pm.max - pm.min) / 3200; // 왕복 한 번에 약 6.4초
        let next = cur + dirRef.current * speed * dt;
        if (next >= pm.max) {
          next = pm.max;
          dirRef.current = -1;
        } else if (next <= pm.min) {
          next = pm.min;
          dirRef.current = 1;
        }
        return { ...prev, [pm.name]: next };
      });
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafRef.current);
  }, [playing, fig]);

  if (!fig) return null;

  const W = 660;
  const H = 380;
  const pad = { l: 46, r: 18, t: fig.title ? 30 : 16, b: 34 };
  const [x0, x1] = fig.xrange;

  // y범위가 지정되지 않으면 실제로 그려질 값에서 뽑는다
  let y0;
  let y1;
  if (fig.yrange) {
    [y0, y1] = fig.yrange;
  } else {
    let lo = Infinity;
    let hi = -Infinity;
    for (const it of fig.items) {
      if (it.kind !== "curve") continue;
      for (let i = 0; i <= 120; i += 1) {
        const x = x0 + ((x1 - x0) * i) / 120;
        const y = it.fn({ ...vals, x });
        if (Number.isFinite(y)) {
          lo = Math.min(lo, y);
          hi = Math.max(hi, y);
        }
      }
    }
    for (const it of fig.items) {
      if (it.kind === "point" || it.kind === "label") {
        const y = it.pt.y(vals);
        if (Number.isFinite(y)) {
          lo = Math.min(lo, y);
          hi = Math.max(hi, y);
        }
      }
    }
    if (!Number.isFinite(lo) || !Number.isFinite(hi) || lo === hi) {
      lo = -5;
      hi = 5;
    }
    const m = (hi - lo) * 0.15 || 1;
    y0 = lo - m;
    y1 = hi + m;
  }

  const iw = W - pad.l - pad.r;
  const ih = H - pad.t - pad.b;
  const sx = (x) => pad.l + ((x - x0) / (x1 - x0)) * iw;
  const sy = (y) => pad.t + ih - ((y - y0) / (y1 - y0)) * ih;

  const toPath = (pts) =>
    pts.map((pt, i) => `${i === 0 ? "M" : "L"}${sx(pt[0]).toFixed(2)},${sy(pt[1]).toFixed(2)}`).join(" ");

  const xStep = niceStep(x1 - x0);
  const yStep = niceStep(y1 - y0);
  const xTicks = [];
  for (let v = Math.ceil(x0 / xStep) * xStep; v <= x1 + 1e-9; v += xStep) xTicks.push(v);
  const yTicks = [];
  for (let v = Math.ceil(y0 / yStep) * yStep; v <= y1 + 1e-9; v += yStep) yTicks.push(v);

  // 잔상 — 매개변수를 여러 값으로 놓은 곡선을 흐리게 겹쳐 움직임을 한눈에 보인다
  const ghostSets = [];
  if (fig.ghost && fig.params.length) {
    const pm = fig.params[0];
    for (let k = 0; k <= 4; k += 1) {
      const gv = { ...vals, [pm.name]: pm.min + ((pm.max - pm.min) * k) / 4 };
      for (const it of fig.items) {
        if (it.kind !== "curve") continue;
        for (const seg of sampleCurve(it.fn, gv, x0, x1, y0, y1, 200)) ghostSets.push(seg);
      }
    }
  }

  const activeParam = fig.params[0];

  return (
    <div className="figure">
      {fig.title && <div className="figure-title">{fig.title}</div>}

      <div className="figure-canvas">
        <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label={fig.title || "그래프"}>
          {/* 격자 */}
          {xTicks.map((v) => (
            <line key={`gx${v}`} x1={sx(v)} y1={pad.t} x2={sx(v)} y2={pad.t + ih} className="fig-grid" />
          ))}
          {yTicks.map((v) => (
            <line key={`gy${v}`} x1={pad.l} y1={sy(v)} x2={pad.l + iw} y2={sy(v)} className="fig-grid" />
          ))}

          {/* 색칠 영역은 곡선보다 아래에 깔린다 */}
          {fig.items.map((it, i) => {
            if (it.kind !== "shade") return null;
            const a = it.from ? it.from(vals) : x0;
            const b = it.to ? it.to(vals) : x1;
            const lo = Math.max(Math.min(a, b), x0);
            const hi = Math.min(Math.max(a, b), x1);
            if (!(hi > lo)) return null;
            const up = [];
            const down = [];
            for (let k = 0; k <= 90; k += 1) {
              const x = lo + ((hi - lo) * k) / 90;
              const yt = it.top({ ...vals, x });
              const yb = it.bottom({ ...vals, x });
              if (Number.isFinite(yt) && Number.isFinite(yb)) {
                up.push([x, yt]);
                down.push([x, yb]);
              }
            }
            if (up.length < 2) return null;
            const d = `${toPath(up)} L${sx(down[down.length - 1][0])},${sy(
              down[down.length - 1][1]
            )} ${toPath(down.slice().reverse()).slice(1)} Z`;
            return <path key={`sh${i}`} d={d} className="fig-shade" />;
          })}

          {/* 잔상 */}
          {ghostSets.map((seg, i) => (
            <path key={`gh${i}`} d={toPath(seg)} className="fig-ghost" />
          ))}

          {/* 축 */}
          {y0 <= 0 && y1 >= 0 && (
            <line x1={pad.l} y1={sy(0)} x2={pad.l + iw} y2={sy(0)} className="fig-axis" />
          )}
          {x0 <= 0 && x1 >= 0 && (
            <line x1={sx(0)} y1={pad.t} x2={sx(0)} y2={pad.t + ih} className="fig-axis" />
          )}

          {/* 축 눈금 */}
          {xTicks.map((v) => (
            <text key={`tx${v}`} x={sx(v)} y={pad.t + ih + 15} className="fig-tick" textAnchor="middle">
              {fmt(v)}
            </text>
          ))}
          {yTicks.map((v) => (
            <text key={`ty${v}`} x={pad.l - 7} y={sy(v) + 3.5} className="fig-tick" textAnchor="end">
              {fmt(v)}
            </text>
          ))}

          {/* 도형과 곡선 */}
          {fig.items.map((it, i) => {
            if (it.kind === "curve") {
              return sampleCurve(it.fn, vals, x0, x1, y0, y1).map((seg, j) => (
                <path key={`c${i}-${j}`} d={toPath(seg)} className="fig-curve" style={{ stroke: it.color }} />
              ));
            }
            if (it.kind === "xcurve") {
              const pts = [];
              for (let k = 0; k <= 300; k += 1) {
                const y = y0 + ((y1 - y0) * k) / 300;
                const x = it.fn({ ...vals, y });
                if (Number.isFinite(x)) pts.push([x, y]);
              }
              return pts.length > 1 ? (
                <path key={`xc${i}`} d={toPath(pts)} className="fig-curve" style={{ stroke: it.color }} />
              ) : null;
            }
            if (it.kind === "vline") {
              const v = it.fn(vals);
              if (!Number.isFinite(v)) return null;
              return (
                <g key={`v${i}`}>
                  <line x1={sx(v)} y1={pad.t} x2={sx(v)} y2={pad.t + ih} className="fig-helper" style={{ stroke: it.color }} />
                  {it.label && (
                    <text x={sx(v) + 5} y={pad.t + 12} className="fig-label" style={{ fill: it.color }}>
                      {it.label}
                    </text>
                  )}
                </g>
              );
            }
            if (it.kind === "hline") {
              const v = it.fn(vals);
              if (!Number.isFinite(v)) return null;
              return (
                <g key={`h${i}`}>
                  <line x1={pad.l} y1={sy(v)} x2={pad.l + iw} y2={sy(v)} className="fig-helper" style={{ stroke: it.color }} />
                  {it.label && (
                    <text x={pad.l + iw - 4} y={sy(v) - 6} className="fig-label" textAnchor="end" style={{ fill: it.color }}>
                      {it.label}
                    </text>
                  )}
                </g>
              );
            }
            if (it.kind === "segment") {
              const ax = it.a.x(vals);
              const ay = it.a.y(vals);
              const bx = it.b.x(vals);
              const by = it.b.y(vals);
              if (![ax, ay, bx, by].every(Number.isFinite)) return null;
              return (
                <line key={`s${i}`} x1={sx(ax)} y1={sy(ay)} x2={sx(bx)} y2={sy(by)} className="fig-curve" style={{ stroke: it.color }} />
              );
            }
            if (it.kind === "polygon") {
              const pts = it.pts.map((pt) => [pt.x(vals), pt.y(vals)]);
              if (!pts.every((pt) => pt.every(Number.isFinite))) return null;
              return (
                <polygon
                  key={`pg${i}`}
                  points={pts.map((pt) => `${sx(pt[0])},${sy(pt[1])}`).join(" ")}
                  className="fig-poly"
                  style={{ stroke: it.color }}
                />
              );
            }
            if (it.kind === "circle") {
              const cx = it.c.x(vals);
              const cy = it.c.y(vals);
              const r = it.r(vals);
              if (![cx, cy, r].every(Number.isFinite) || r <= 0) return null;
              // x·y 축 배율이 다를 수 있으므로 타원으로 그린다
              const rx = Math.abs(sx(cx + r) - sx(cx));
              const ry = Math.abs(sy(cy + r) - sy(cy));
              return <ellipse key={`ci${i}`} cx={sx(cx)} cy={sy(cy)} rx={rx} ry={ry} className="fig-poly" style={{ stroke: it.color }} />;
            }
            return null;
          })}

          {/* 점과 글자는 맨 위에 */}
          {fig.items.map((it, i) => {
            if (it.kind === "point") {
              const px = it.pt.x(vals);
              const py = it.pt.y(vals);
              if (![px, py].every(Number.isFinite)) return null;
              return (
                <g key={`p${i}`}>
                  <circle cx={sx(px)} cy={sy(py)} r="4" className="fig-dot" style={{ fill: it.color }} />
                  {it.label && (
                    <text x={sx(px) + 8} y={sy(py) - 8} className="fig-label" style={{ fill: it.color }}>
                      {it.label}
                    </text>
                  )}
                </g>
              );
            }
            if (it.kind === "label") {
              const px = it.pt.x(vals);
              const py = it.pt.y(vals);
              if (![px, py].every(Number.isFinite)) return null;
              return (
                <text key={`l${i}`} x={sx(px)} y={sy(py)} className="fig-label" style={{ fill: it.color }}>
                  {it.label}
                </text>
              );
            }
            return null;
          })}

          {fig.title && (
            <text x={pad.l} y={18} className="fig-heading">
              {fig.title}
            </text>
          )}
        </svg>
      </div>

      {/* 곡선 이름표 */}
      {fig.items.some((it) => it.label && (it.kind === "curve" || it.kind === "xcurve")) && (
        <div className="figure-legend">
          {fig.items
            .filter((it) => it.label && (it.kind === "curve" || it.kind === "xcurve"))
            .map((it, i) => (
              <span className="legend-item" key={i}>
                <span className="legend-swatch" style={{ background: it.color }} />
                {it.label}
              </span>
            ))}
        </div>
      )}

      {/* 매개변수 조작 */}
      {activeParam && (
        <div className="figure-controls">
          <button
            type="button"
            className={`fig-play ${playing ? "is-on" : ""}`}
            onClick={() => setPlaying((v) => !v)}
          >
            {playing ? "정지" : "움직이기"}
          </button>
          {fig.params.map((pm) => (
            <label className="fig-slider" key={pm.name}>
              <span className="fig-slider-name">
                {pm.name} = {fmt(vals[pm.name] ?? pm.start)}
              </span>
              <input
                type="range"
                min={pm.min}
                max={pm.max}
                step={pm.step}
                value={vals[pm.name] ?? pm.start}
                onChange={(e) => {
                  setPlaying(false);
                  setVals((prev) => ({ ...prev, [pm.name]: Number(e.target.value) }));
                }}
              />
              <span className="fig-slider-range">
                {fmt(pm.min)} ~ {fmt(pm.max)}
              </span>
            </label>
          ))}
        </div>
      )}

      {fig.note && <p className="figure-note">{fig.note}</p>}
    </div>
  );
}
