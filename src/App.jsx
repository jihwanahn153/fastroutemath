import React, { useState, useRef, useEffect, useCallback } from "react";

// Anthropic 비전은 긴 변 1568px를 넘으면 서버에서 다시 줄인다.
// 그 경계에 맞춰 보내야 글자가 가장 또렷하게 전달된다.
const MAX_DIM = 1568;
const JPEG_QUALITY = 0.92;
const LEDGER_KEY = "fastest-route:ledger";
const LEDGER_LIMIT = 20;

// 서버는 JSON이 아니라 @@블록 형식으로 답한다.
// LaTeX의 백슬래시가 JSON 이스케이프와 충돌해 수식이 깨지는 문제를 피하기 위함이다.
// (\\lim 은 파싱 실패, \\to 는 탭 문자로 변질된다)
function parseBlocks(raw) {
  const lines = String(raw || "").split(/\r?\n/);
  const out = { steps: [] };
  let key = null;
  let buf = [];
  let step = null;

  const flush = () => {
    if (!key) return;
    const value = buf.join("\n").trim();
    if (key === "DO" || key === "MATH" || key === "WHY") {
      if (step) step[key.toLowerCase()] = value;
    } else {
      out[key.toLowerCase()] = value;
    }
    buf = [];
  };

  for (const line of lines) {
    const m = line.match(/^\s*@@([A-Z]+)\s*$/);
    if (m) {
      flush();
      const k = m[1];
      if (k === "STEP") {
        step = { do: "", math: "", why: "" };
        out.steps.push(step);
        key = null;
      } else if (k === "END") {
        key = null;
        break;
      } else {
        key = k;
      }
      continue;
    }
    if (key) buf.push(line);
  }
  flush();

  out.steps = out.steps.filter((st) => st.do || st.math);
  return out;
}

/* ---------- 이미지 처리 ---------- */

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("이미지를 열지 못했습니다. 다른 사진으로 시도해주세요."));
    img.src = src;
  });
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = (e) => resolve(e.target.result);
    r.onerror = () => reject(new Error("파일을 읽지 못했습니다."));
    r.readAsDataURL(file);
  });
}

// 종이 사진은 그림자 탓에 대비가 낮은 경우가 많다.
// 밝기 분포의 양 끝 2%를 잘라내고 펴주면 인쇄 글자가 또렷해진다.
function stretchContrast(ctx, w, h) {
  const imageData = ctx.getImageData(0, 0, w, h);
  const d = imageData.data;
  const hist = new Uint32Array(256);
  for (let i = 0; i < d.length; i += 4) {
    hist[(d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114) | 0]++;
  }
  // 글자는 전체 픽셀의 몇 퍼센트뿐이라 어두운 쪽은 아주 조금만 잘라야 한다.
  // 양쪽을 똑같이 2%씩 자르면 흰 종이에 글자가 적은 사진에서 글자가 통째로 날아간다.
  const total = w * h;
  const darkCut = total * 0.003;
  const brightCut = total * 0.02;
  let acc = 0;
  let lo = 0;
  let hi = 255;
  for (let i = 0; i < 256; i++) {
    acc += hist[i];
    if (acc > darkCut) {
      lo = i;
      break;
    }
  }
  acc = 0;
  for (let i = 255; i >= 0; i--) {
    acc += hist[i];
    if (acc > brightCut) {
      hi = i;
      break;
    }
  }
  lo = Math.min(lo, 100); // 어두운 기준점이 너무 밝게 잡히면 글자가 뭉개진다
  if (hi <= lo + 8) return; // 분포가 이상하면 손대지 않는다
  const scale = Math.min(255 / (hi - lo), 3); // 과보정으로 종이가 날아가지 않게 제한
  const lut = new Uint8ClampedArray(256);
  for (let i = 0; i < 256; i++) lut[i] = (i - lo) * scale;
  for (let i = 0; i < d.length; i += 4) {
    d[i] = lut[d[i]];
    d[i + 1] = lut[d[i + 1]];
    d[i + 2] = lut[d[i + 2]];
  }
  ctx.putImageData(imageData, 0, 0);
}

// 원본 dataUrl + (선택) 자연좌표 크롭 → 전송용 base64
async function prepareImage(dataUrl, crop) {
  const img = await loadImage(dataUrl);
  const sx = crop ? crop.x : 0;
  const sy = crop ? crop.y : 0;
  const sw = crop ? crop.w : img.naturalWidth;
  const sh = crop ? crop.h : img.naturalHeight;

  let w = sw;
  let h = sh;
  if (w > MAX_DIM || h > MAX_DIM) {
    if (w > h) {
      h = Math.round((h * MAX_DIM) / w);
      w = MAX_DIM;
    } else {
      w = Math.round((w * MAX_DIM) / h);
      h = MAX_DIM;
    }
  }
  // 작은 이미지는 키워서 글자를 크게 전달한다.
  // 해상도가 늘어난다고 정보가 생기진 않지만, 글자가 커지면 비전 모델이 훨씬 잘 읽는다.
  const longEdge = Math.max(w, h);
  if (longEdge < MAX_DIM) {
    const up = Math.min(MAX_DIM / longEdge, 2);
    w = Math.round(w * up);
    h = Math.round(h * up);
  }

  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const ctx = c.getContext("2d", { willReadFrequently: true });
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(img, sx, sy, sw, sh, 0, 0, w, h);
  try {
    stretchContrast(ctx, w, h);
  } catch (e) {
    /* 보정에 실패해도 원본으로 진행 */
  }
  return c.toDataURL("image/jpeg", JPEG_QUALITY).split(",")[1];
}

/* ---------- 항 매핑 트리 ---------- */

// 인덱스가 2배(또는 3배) 구조로 갈라지는 수열은 트리로 보면 구조가 한눈에 보인다.
// 진법 b에서 인덱스 k의 부모는 항상 floor(k / b) 이다.
//   2진법: k의 자식은 2k, 2k+1
//   3진법: k의 자식은 3k, 3k+1, 3k+2
function buildTree(raw, base) {
  const nodes = new Map();
  for (const line of String(raw || "").split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    const bar = t.indexOf("|");
    const idxText = bar === -1 ? t : t.slice(0, bar);
    const idx = parseInt(String(idxText).replace(/[^0-9]/g, ""), 10);
    if (!Number.isFinite(idx) || idx < 1) continue;
    const label = bar === -1 ? `a${idx}` : t.slice(bar + 1).trim() || `a${idx}`;
    nodes.set(idx, { index: idx, label, children: [] });
  }
  if (nodes.size === 0) return null;

  // 부모 연결. 부모가 목록에 없으면 그 노드가 뿌리가 된다.
  const roots = [];
  for (const idx of [...nodes.keys()].sort((a, b) => a - b)) {
    const parentIdx = Math.floor(idx / base);
    const node = nodes.get(idx);
    if (parentIdx >= 1 && parentIdx !== idx && nodes.has(parentIdx)) {
      node.parent = parentIdx;
      nodes.get(parentIdx).children.push(idx);
    } else {
      node.parent = null;
      roots.push(idx);
    }
  }
  for (const n of nodes.values()) n.children.sort((a, b) => a - b);

  // 깊이 계산
  let maxDepth = 0;
  const setDepth = (idx, d) => {
    if (d > 24) return;
    const n = nodes.get(idx);
    n.depth = d;
    maxDepth = Math.max(maxDepth, d);
    for (const c of n.children) setDepth(c, d + 1);
  };
  roots.forEach((r) => setDepth(r, 0));

  // 가로 위치: 잎은 순서대로 한 칸씩, 부모는 자식들의 가운데
  let slot = 0;
  const place = (idx) => {
    const n = nodes.get(idx);
    if (n.children.length === 0) {
      n.slot = slot;
      slot += 1;
      return;
    }
    n.children.forEach(place);
    const first = nodes.get(n.children[0]).slot;
    const last = nodes.get(n.children[n.children.length - 1]).slot;
    n.slot = (first + last) / 2;
  };
  roots.forEach((r) => {
    place(r);
    slot += 1; // 뿌리가 여러 개면 사이를 띄운다
  });

  return { nodes, roots, maxDepth, slots: Math.max(slot, 1) };
}

function TermTree({ raw, base, note }) {
  const tree = buildTree(raw, base);
  if (!tree) return null;

  const stepX = 96;
  const rowH = 82;
  const nodeW = 82;
  const nodeH = 30;
  const padX = 24;
  const width = Math.max(tree.slots * stepX + padX * 2, 320);
  const height = (tree.maxDepth + 1) * rowH + 24;

  const xOf = (n) => padX + nodeW / 2 + n.slot * stepX;
  const yOf = (n) => 28 + n.depth * rowH;
  const all = [...tree.nodes.values()];

  return (
    <div className="treewrap">
      {note && <Tex className="tree-note">{note}</Tex>}
      <div className="tree-scroll">
        <svg width={width} height={height} role="img" aria-label="수열 항 매핑 트리">
          {all.map((n) =>
            n.children.map((c) => {
              const child = tree.nodes.get(c);
              return (
                <line
                  key={`e${n.index}-${c}`}
                  x1={xOf(n)}
                  y1={yOf(n) + nodeH / 2}
                  x2={xOf(child)}
                  y2={yOf(child) - nodeH / 2}
                  className="tree-edge"
                />
              );
            })
          )}
          {all.map((n) => (
            <g key={`n${n.index}`}>
              <rect
                x={xOf(n) - nodeW / 2}
                y={yOf(n) - nodeH / 2}
                width={nodeW}
                height={nodeH}
                className={n.parent === null ? "tree-node tree-node-root" : "tree-node"}
              />
              <text x={xOf(n)} y={yOf(n) + 4} className="tree-label" textAnchor="middle">
                {n.label}
              </text>
            </g>
          ))}
        </svg>
      </div>
      <p className="tree-legend">
        {base === 3
          ? "인덱스 k의 자식은 3k, 3k+1, 3k+2 입니다."
          : "인덱스 k의 자식은 2k(왼쪽), 2k+1(오른쪽) 입니다."}{" "}
        한 칸 내려갈 때마다 인덱스가 {base}배씩 커집니다.
      </p>
    </div>
  );
}

/* ---------- 수식 입력 도우미 ---------- */

// 라벨, 넣을 LaTeX, 커서를 되돌릴 칸 수
const EXAMPLES = [
  "x세제곱 빼기 3x 더하기 1 의 극댓값과 극솟값의 합",
  "리미트 x가 0으로 갈 때 sin3x 분의 x",
  "a2n+1 = an + 2, a1 = 1 일 때 a13 은?",
  "루트2 더하기 루트3 의 제곱",
];

const SYMBOLS = [
  ["분수", "\\dfrac{}{}", 3],
  ["지수", "^{}", 1],
  ["첨자", "_{}", 1],
  ["루트", "\\sqrt{}", 1],
  ["극한", "\\lim_{x \\to 0}", 0],
  ["적분", "\\int_{}^{}", 4],
  ["시그마", "\\sum_{k=1}^{n}", 0],
  ["도함수", "f'(x)", 0],
  ["∞", "\\infty", 0],
  ["π", "\\pi", 0],
  ["θ", "\\theta", 0],
  ["≥", "\\ge", 0],
  ["≤", "\\le", 0],
  ["≠", "\\neq", 0],
];

/* ---------- 기록 ---------- */

function readLedger() {
  try {
    return JSON.parse(localStorage.getItem(LEDGER_KEY) || "[]");
  } catch (e) {
    return [];
  }
}
function writeLedger(list) {
  try {
    localStorage.setItem(LEDGER_KEY, JSON.stringify(list.slice(0, LEDGER_LIMIT)));
  } catch (e) {
    /* 저장 공간이 없으면 넘어간다 */
  }
}

/* ---------- 수식 렌더 ---------- */

function Tex({ children, className }) {
  const ref = useRef(null);
  useEffect(() => {
    if (ref.current && window.renderMathInElement) {
      try {
        window.renderMathInElement(ref.current, {
          delimiters: [
            { left: "$$", right: "$$", display: true },
            { left: "$", right: "$", display: false },
            { left: "\\(", right: "\\)", display: false },
            { left: "\\[", right: "\\]", display: true },
          ],
          throwOnError: false,
        });
      } catch (e) {
        /* 수식이 깨져도 원문은 남는다 */
      }
    }
  }, [children]);
  return (
    <div ref={ref} className={className}>
      {children}
    </div>
  );
}

/* ---------- 영역 자르기 ---------- */

function CropStage({ dataUrl, crop, onChange }) {
  const wrapRef = useRef(null);
  const imgRef = useRef(null);
  const startRef = useRef(null); // 드래그 중 여부는 ref로 본다 (stale state 방지)
  const [sel, setSel] = useState(null); // 드래그 중인 사각형 (자연좌표)
  const [imgBox, setImgBox] = useState(null); // 래퍼 기준 실제 이미지 영역

  // object-fit: contain 때문에 요소 박스와 실제 그려진 이미지 영역이 다르다.
  // 좌표를 정확히 맞추려면 그려진 영역을 직접 계산해야 한다.
  const measure = useCallback(() => {
    const img = imgRef.current;
    const wrap = wrapRef.current;
    if (!img || !wrap || !img.naturalWidth) return;
    const er = img.getBoundingClientRect();
    const wr = wrap.getBoundingClientRect();
    const nAR = img.naturalWidth / img.naturalHeight;
    const eAR = er.width / er.height;
    let w;
    let h;
    if (nAR > eAR) {
      w = er.width;
      h = er.width / nAR;
    } else {
      h = er.height;
      w = er.height * nAR;
    }
    setImgBox({
      left: er.left - wr.left + (er.width - w) / 2,
      top: er.top - wr.top + (er.height - h) / 2,
      width: w,
      height: h,
    });
  }, []);

  useEffect(() => {
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [measure, dataUrl]);

  const toNatural = useCallback((clientX, clientY) => {
    const img = imgRef.current;
    const wrap = wrapRef.current;
    if (!img || !wrap || !imgBox) return { x: 0, y: 0 };
    const wr = wrap.getBoundingClientRect();
    const px = Math.min(Math.max(clientX - wr.left - imgBox.left, 0), imgBox.width);
    const py = Math.min(Math.max(clientY - wr.top - imgBox.top, 0), imgBox.height);
    return {
      x: (px / imgBox.width) * img.naturalWidth,
      y: (py / imgBox.height) * img.naturalHeight,
    };
  }, [imgBox]);

  // 드래그는 window에서 받는다. 포인터가 이미지 밖으로 나가도 놓치지 않는다.
  useEffect(() => {
    const onMove = (e) => {
      if (!startRef.current) return;
      e.preventDefault();
      const p = toNatural(e.clientX, e.clientY);
      const s = startRef.current;
      setSel({ x0: s.x, y0: s.y, x1: p.x, y1: p.y });
    };
    const onUp = () => {
      if (!startRef.current) return;
      startRef.current = null;
      setSel((cur) => {
        if (cur) {
          const x = Math.min(cur.x0, cur.x1);
          const y = Math.min(cur.y0, cur.y1);
          const w = Math.abs(cur.x1 - cur.x0);
          const h = Math.abs(cur.y1 - cur.y0);
          if (w > 40 && h > 30) onChange({ x, y, w, h });
        }
        return null;
      });
    };
    window.addEventListener("pointermove", onMove, { passive: false });
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
  }, [toNatural, onChange]);

  const start = (e) => {
    e.preventDefault();
    const p = toNatural(e.clientX, e.clientY);
    startRef.current = p;
    setSel({ x0: p.x, y0: p.y, x1: p.x, y1: p.y });
  };

  const active = sel
    ? {
        x: Math.min(sel.x0, sel.x1),
        y: Math.min(sel.y0, sel.y1),
        w: Math.abs(sel.x1 - sel.x0),
        h: Math.abs(sel.y1 - sel.y0),
      }
    : crop;

  const img = imgRef.current;
  const box =
    active && img && img.naturalWidth
      ? {
          left: `${(active.x / img.naturalWidth) * 100}%`,
          top: `${(active.y / img.naturalHeight) * 100}%`,
          width: `${(active.w / img.naturalWidth) * 100}%`,
          height: `${(active.h / img.naturalHeight) * 100}%`,
        }
      : null;

  return (
    <div className="cropwrap" ref={wrapRef}>
      <img ref={imgRef} src={dataUrl} alt="올린 문제" draggable={false} onLoad={measure} />
      <div
        className="croplayer"
        onPointerDown={start}
        style={imgBox ? { left: imgBox.left, top: imgBox.top, width: imgBox.width, height: imgBox.height } : undefined}
      >
        {box && <div className="cropbox" style={box} />}
      </div>
      {!crop && !sel && <div className="crophint">문제 하나만 드래그해서 지정하면 더 정확합니다</div>}
    </div>
  );
}

/* ---------- 본체 ---------- */

export default function App() {
  const [tab, setTab] = useState("type");
  const [text, setText] = useState("");
  const [srcImage, setSrcImage] = useState(null);
  const [crop, setCrop] = useState(null);
  const [sentImage, setSentImage] = useState(null);

  const [stage, setStage] = useState("input"); // input | confirm | result
  const [busy, setBusy] = useState(null); // null | read | solve
  const [error, setError] = useState("");

  const [reading, setReading] = useState(null);
  const [confirmed, setConfirmed] = useState("");

  const [solution, setSolution] = useState(null);
  const [ledger, setLedger] = useState([]);
  const [showLedger, setShowLedger] = useState(false);
  const [withAdvanced, setWithAdvanced] = useState(true);
  const fileRef = useRef(null);
  const textRef = useRef(null);

  useEffect(() => {
    setLedger(readLedger());
  }, []);

  // 팔레트 버튼: 커서 자리에 LaTeX를 넣고, 채워야 할 칸 안으로 커서를 옮긴다
  const insertSymbol = (snippet, back) => {
    const el = textRef.current;
    if (!el) return;
    const start = el.selectionStart ?? text.length;
    const endPos = el.selectionEnd ?? text.length;
    const before = text.slice(0, start);
    const after = text.slice(endPos);
    // 이미 $ 안이 아니면 감싸준다
    const dollars = (before.match(/\$/g) || []).length;
    const inMath = dollars % 2 === 1;
    const piece = inMath ? snippet : `$${snippet}$`;
    const next = before + piece + after;
    setText(next);
    const caret = before.length + piece.length - back - (inMath ? 0 : 1);
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(caret, caret);
    });
  };

  const hasTex = /\$[^$]+\$/.test(text);

  const acceptImage = useCallback(async (file) => {
    if (!file || !file.type.startsWith("image/")) return;
    setError("");
    try {
      const dataUrl = await fileToDataUrl(file);
      setSrcImage(dataUrl);
      setCrop(null);
      setTab("photo");
      setStage("input");
    } catch (e) {
      setError(e.message);
    }
  }, []);

  useEffect(() => {
    const onPaste = (e) => {
      const item = Array.from(e.clipboardData?.items || []).find((i) => i.type.startsWith("image/"));
      if (!item) return;
      const f = item.getAsFile();
      if (!f) return;
      e.preventDefault();
      acceptImage(f);
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, [acceptImage]);

  const clearImage = () => {
    setSrcImage(null);
    setCrop(null);
    setSentImage(null);
    setReading(null);
    if (fileRef.current) fileRef.current.value = "";
  };

  // 사진이든 직접 입력이든 같은 확인 단계를 거친다.
  // 손으로 친 수식도 해석이 갈릴 수 있어서, 풀기 전에 한 번 눈으로 맞춰보는 편이 정확하다.
  const readProblem = async () => {
    if (busy) return;
    const usingPhoto = tab === "photo";
    if (usingPhoto && !srcImage) return;
    if (!usingPhoto && !text.trim()) return;

    setBusy("read");
    setError("");
    try {
      let b64 = null;
      if (usingPhoto) {
        b64 = await prepareImage(srcImage, crop);
        setSentImage(b64);
      } else {
        setSentImage(null);
      }
      const res = await fetch("/api/read", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ image: b64, text: text.trim() || undefined }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `문제를 읽지 못했습니다 (${res.status})`);
      const parsed = parseBlocks(data.text);
      if (!parsed.transcription) {
        throw new Error(
          usingPhoto
            ? "문제를 알아보지 못했습니다. 문제 영역만 잘라서 다시 올려보세요."
            : "문제를 이해하지 못했습니다. 조금 더 풀어서 써주세요."
        );
      }
      setReading(parsed);
      setConfirmed(parsed.transcription);
      setStage("confirm");
    } catch (e) {
      setError(e.message || "문제를 읽지 못했습니다.");
    } finally {
      setBusy(null);
    }
  };

  const solve = async (problemText, image, figureNote) => {
    if (busy) return;
    setBusy("solve");
    setError("");
    try {
      const res = await fetch("/api/solve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text: problemText,
          image: image || null,
          figureNote: figureNote || "",
          advanced: withAdvanced,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `풀이를 가져오지 못했습니다 (${res.status})`);
      const parsed = parseBlocks(data.text);
      if (!parsed.answer) {
        throw new Error("풀이를 해석하지 못했습니다. 문제를 조금 더 또렷하게 올려주세요.");
      }
      delete parsed.scratch; // 계산 과정은 저장하지도 보여주지도 않는다
      setSolution(parsed);
      setStage("result");
      const entry = { id: String(Date.now()), at: new Date().toISOString(), ...parsed };
      const next = [entry, ...ledger].slice(0, LEDGER_LIMIT);
      setLedger(next);
      writeLedger(next);
    } catch (e) {
      setError(e.message || "풀이를 가져오지 못했습니다.");
    } finally {
      setBusy(null);
    }
  };

  const submitFromInput = () => readProblem();

  const reset = () => {
    setStage("input");
    setSolution(null);
    setText("");
    setConfirmed("");
    clearImage();
    setError("");
    setShowLedger(false);
  };

  const canSubmit = tab === "type" ? text.trim().length > 0 : Boolean(srcImage);
  const oculusState = busy ? "working" : stage === "result" ? "lit" : "";
  const oculusText =
    busy === "read"
      ? "READING"
      : busy === "solve"
      ? "SOLVING"
      : stage === "confirm"
      ? "CHECK"
      : stage === "result"
      ? `${solution?.seconds || "—"}s`
      : "READY";

  return (
    <div className="shell">
      <div className="colonnade left" aria-hidden="true" />
      <div className="colonnade right" aria-hidden="true" />

      <header className="lintel">
        <div className="lintel-inner">
          <h1 className="wordmark">
            최단 풀이
            <span className="wordmark-en">FASTEST ROUTE</span>
          </h1>
          <button
            className="lintel-link"
            onClick={() => {
              setShowLedger((s) => !s);
              if (!showLedger) setStage("input");
            }}
          >
            {showLedger ? "닫기" : `기록 ${ledger.length}`}
          </button>
        </div>
      </header>

      <main className="hall">
        <div className={`oculus ${oculusState}`} aria-hidden="true">
          <div className="oculus-ring r1" />
          <div className="oculus-ring r2" />
          <div className="oculus-ring r3" />
          <div className="oculus-ring r4" />
          <div className="oculus-core">{oculusText}</div>
        </div>

        {showLedger ? (
          <section>
            <div className="meta-rule">지난 풀이</div>
            <div className="ledger">
              {ledger.length === 0 ? (
                <p className="ledger-empty">아직 푼 문제가 없습니다. 첫 문제를 올려보세요.</p>
              ) : (
                ledger.map((row) => (
                  <button
                    key={row.id}
                    className="ledger-row"
                    onClick={() => {
                      setSolution(row);
                      setStage("result");
                      setShowLedger(false);
                    }}
                  >
                    <span className="ledger-time">
                      {new Date(row.at).toLocaleDateString("ko-KR", { month: "2-digit", day: "2-digit" })}
                    </span>
                    <span className="ledger-problem">{row.problem}</span>
                    <span className="ledger-secs">{row.seconds ? `${row.seconds}s` : ""}</span>
                  </button>
                ))
              )}
            </div>
          </section>
        ) : stage === "result" && solution ? (
          <section className="result">
            <div className="meta-rule">{solution.topic || "풀이"}</div>
            <Tex className="insight">{solution.insight}</Tex>
            <p className="problem-line">{solution.problem}</p>

            <div className="flight">
              {(solution.steps || []).map((s, i) => (
                <div
                  className="tread"
                  key={i}
                  style={{ marginLeft: `min(${i * 10}px, 5vw)`, animationDelay: `${0.12 + i * 0.07}s` }}
                >
                  <div className="tread-num">{i + 1}</div>
                  <p className="tread-do">{s.do}</p>
                  {s.math ? <Tex className="tread-math">{s.math}</Tex> : null}
                  {s.why ? <p className="tread-why">{s.why}</p> : null}
                </div>
              ))}
            </div>

            <div className="landing">
              <div className="landing-label">ANSWER</div>
              <Tex className="landing-answer">{solution.answer}</Tex>
            </div>

            {solution.confidence === "low" || solution.confidence === "medium" ? (
              <div className="flag flag-answer">
                {solution.confidence === "low"
                  ? "이 답은 확신도가 낮습니다. 조건을 다시 확인하고 직접 검산해보세요."
                  : "조건 해석이 갈릴 여지가 있는 문제입니다. 답을 한 번 검산해보세요."}
              </div>
            ) : null}

            {(solution.trap || solution.slower) && (
              <div className="aside-grid">
                {solution.trap && (
                  <div className="aside">
                    <div className="aside-label">자주 하는 실수</div>
                    <p className="aside-text">{solution.trap}</p>
                  </div>
                )}
                {solution.slower && (
                  <div className="aside">
                    <div className="aside-label">정석이 느린 이유</div>
                    <p className="aside-text">{solution.slower}</p>
                  </div>
                )}
              </div>
            )}

            {solution.advtitle && solution.advtitle !== "없음" && solution.advbody ? (
              <section className="extra">
                <div className="extra-head">
                  <span className="extra-tag">상위 교육과정</span>
                  <h3 className="extra-title">{solution.advtitle}</h3>
                </div>

                {solution.advneed && (
                  <div className="need-list">
                    {solution.advneed
                      .split(/\r?\n/)
                      .map((l) => l.trim())
                      .filter(Boolean)
                      .map((line, i) => {
                        const bar = line.indexOf("|");
                        const name = bar === -1 ? line : line.slice(0, bar).trim();
                        const desc = bar === -1 ? "" : line.slice(bar + 1).trim();
                        return (
                          <div className="need" key={i}>
                            <div className="need-name">{name}</div>
                            {desc && <Tex className="need-desc">{desc}</Tex>}
                          </div>
                        );
                      })}
                  </div>
                )}

                <Tex className="extra-body">{solution.advbody}</Tex>
                {solution.advwhy && (
                  <div className="extra-why">
                    <div className="aside-label">고교 풀이와의 연결</div>
                    <Tex className="extra-why-text">{solution.advwhy}</Tex>
                  </div>
                )}
              </section>
            ) : null}

            {solution.base && solution.basebody ? (
              <section className="extra">
                <div className="extra-head">
                  <span className="extra-tag">{solution.base}진법 풀이</span>
                  <h3 className="extra-title">
                    인덱스를 {solution.base}진법으로 읽기
                  </h3>
                </div>
                <Tex className="extra-body">{solution.basebody}</Tex>
              </section>
            ) : null}

            {solution.tree ? (
              <section className="extra">
                <div className="extra-head">
                  <span className="extra-tag">항 매핑</span>
                  <h3 className="extra-title">
                    {Number(solution.base) === 3 ? "삼진 트리" : "이진 트리"}로 본 항의 구조
                  </h3>
                </div>
                <TermTree
                  raw={solution.tree}
                  base={Number(solution.base) === 3 ? 3 : 2}
                  note={solution.treenote}
                />
              </section>
            ) : null}

            <button className="again" onClick={reset}>
              다음 문제 풀기
            </button>
          </section>
        ) : stage === "confirm" ? (
          <section className="result">
            <div className="meta-rule">읽은 내용 확인</div>
            <h2 className="confirm-head">이렇게 읽었습니다. 맞나요?</h2>
            <p className="confirm-sub">
              {sentImage
                ? "틀린 글자나 빠진 조건이 있으면 고쳐주세요. 여기서 한 번 잡아주면 풀이가 정확해집니다."
                : "입력하신 내용을 정식 표기로 정리했습니다. 뜻이 달라진 곳이 있으면 고쳐주세요."}
            </p>

            {(reading?.confidence === "low" || reading?.unclear) && (
              <div className="flag">
                {reading?.confidence === "low" && <b>사진이 흐려 판독이 불확실합니다. </b>}
                {reading?.unclear}
              </div>
            )}

            <div className={`confirm-grid ${sentImage ? "" : "no-shot"}`}>
              {(sentImage || srcImage) && (
                <div className="confirm-shot">
                  {/* 실제로 판독에 쓰인(자르기·보정을 거친) 그림을 보여준다 */}
                  <img src={sentImage ? `data:image/jpeg;base64,${sentImage}` : srcImage} alt="판독에 사용한 문제" />
                </div>
              )}
              <div>
                <textarea
                  className="field confirm-field"
                  value={confirmed}
                  onChange={(e) => setConfirmed(e.target.value)}
                  spellCheck={false}
                />
                {reading?.hasFigure && (
                  <p className="hint">그림이 있는 문제라 원본 사진도 함께 넘겨 그래프를 보고 풀도록 합니다.</p>
                )}
              </div>
            </div>

            <div className="preview-label">이렇게 읽힙니다</div>
            <Tex className="confirm-preview">{confirmed}</Tex>

            {error && <div className="notice">{error}</div>}

            <button
              className="solve-btn"
              disabled={!confirmed.trim() || busy}
              onClick={() => solve(confirmed.trim(), sentImage, reading?.figureNote)}
            >
              {busy === "solve" ? "가장 빠른 길을 찾는 중" : "이대로 풀기"}
            </button>
            <button className="again" onClick={reset} disabled={Boolean(busy)}>
              {sentImage ? "사진 다시 올리기" : "다시 입력하기"}
            </button>
          </section>
        ) : (
          <>
            <div className="hero">
              <h1>
                문제 하나에 <em>가장 짧은 길</em> 하나
              </h1>
              <p>직접 입력하거나 사진을 올리면, 실전에서 제일 빠른 경로로 풀어드립니다.</p>
            </div>

            <div className="panel">
              <div className="tabs" role="tablist">
                <button className="tab" role="tab" aria-selected={tab === "type"} onClick={() => setTab("type")}>
                  직접 입력
                </button>
                <button className="tab" role="tab" aria-selected={tab === "photo"} onClick={() => setTab("photo")}>
                  사진으로
                </button>
              </div>

              <div className="panel-body">
                {tab === "type" ? (
                  <>
                    <textarea
                      ref={textRef}
                      className="field"
                      value={text}
                      onChange={(e) => setText(e.target.value)}
                      placeholder={"말하듯이 편하게 쓰세요.\n\n예) x세제곱 빼기 3x 더하기 1 의 극댓값과 극솟값의 합\n예) 리미트 x가 0으로 갈 때 2분의 sin3x 분의 x\n예) a2n+1 = a n + 2 이고 a1 = 1 일 때 a13"}
                      onKeyDown={(e) => {
                        if ((e.metaKey || e.ctrlKey) && e.key === "Enter") submitFromInput();
                      }}
                    />
                    <div className="row-label">이렇게 써도 됩니다 — 눌러서 채워보세요</div>
                    <div className="palette">
                      {EXAMPLES.map((ex) => (
                        <button
                          key={ex}
                          type="button"
                          className="key key-example"
                          onClick={() => setText(ex)}
                        >
                          {ex}
                        </button>
                      ))}
                    </div>

                    <div className="row-label">수식 기호 넣기 (몰라도 됩니다)</div>
                    <div className="palette">
                      {SYMBOLS.map(([label, snippet, back]) => (
                        <button
                          key={label}
                          type="button"
                          className="key"
                          onMouseDown={(e) => e.preventDefault()}
                          onClick={() => insertSymbol(snippet, back)}
                          title={snippet}
                        >
                          {label}
                        </button>
                      ))}
                    </div>
                    {hasTex && (
                      <>
                        <div className="preview-label">이렇게 읽힙니다</div>
                        <Tex className="type-preview">{text}</Tex>
                      </>
                    )}
                    <p className="hint">
                      기호를 몰라도 됩니다. 한글로 풀어 써도 알아듣고, 다음 화면에서 제대로
                      읽었는지 보여드립니다. <code>Ctrl</code> + <code>Enter</code> 로 바로 시작합니다.
                    </p>
                  </>
                ) : (
                  <>
                    {srcImage ? (
                      <>
                        <CropStage dataUrl={srcImage} crop={crop} onChange={setCrop} />
                        <div className="croptools">
                          {crop ? (
                            <button className="chip" onClick={() => setCrop(null)}>
                              선택 해제
                            </button>
                          ) : (
                            <span className="chip chip-static">전체 사진 사용 중</span>
                          )}
                          <button className="chip" onClick={clearImage}>
                            다른 사진 올리기
                          </button>
                        </div>
                      </>
                    ) : (
                      <div
                        className="dropzone"
                        onClick={() => fileRef.current?.click()}
                        onDragOver={(e) => e.preventDefault()}
                        onDrop={(e) => {
                          e.preventDefault();
                          acceptImage(e.dataTransfer.files?.[0]);
                        }}
                      >
                        <div className="dropzone-mark">◍ ◍ ◍</div>
                        <p className="dropzone-text">문제 사진을 올려주세요</p>
                        <p className="dropzone-sub">클릭 · 끌어다 놓기 · 붙여넣기(Ctrl+V) 모두 됩니다</p>
                      </div>
                    )}
                    <input
                      ref={fileRef}
                      className="hidden-input"
                      type="file"
                      accept="image/*"
                      capture="environment"
                      onChange={(e) => acceptImage(e.target.files?.[0])}
                    />
                    <p className="hint">또렷하게 찍고, 문제 하나만 드래그로 지정하면 판독이 훨씬 정확해집니다.</p>
                  </>
                )}

                <label className="toggle">
                  <input
                    type="checkbox"
                    checked={withAdvanced}
                    onChange={(e) => setWithAdvanced(e.target.checked)}
                  />
                  <span>
                    상위 교육과정 풀이도 함께 보기
                    <em>대학 과정 도구로 푸는 방법을 고교 수준으로 풀어서 설명합니다</em>
                  </span>
                </label>

                {error && <div className="notice">{error}</div>}

                <button className="solve-btn" onClick={submitFromInput} disabled={!canSubmit || Boolean(busy)}>
                  {busy === "read"
                    ? "문제를 읽는 중"
                    : busy === "solve"
                    ? "가장 빠른 길을 찾는 중"
                    : "문제 확인하기"}
                </button>
              </div>
            </div>
          </>
        )}
      </main>

      <footer className="foot">풀이는 참고용입니다. 답이 이상하면 문제를 다시 또렷하게 올려보세요.</footer>
    </div>
  );
}
