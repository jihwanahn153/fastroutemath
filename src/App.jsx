import React, { useState, useRef, useEffect, useCallback } from "react";

// Anthropic 비전은 긴 변 1568px를 넘으면 서버에서 다시 줄인다.
// 그 경계에 맞춰 보내야 글자가 가장 또렷하게 전달된다.
const MAX_DIM = 1568;
const JPEG_QUALITY = 0.92;
const LEDGER_KEY = "fastest-route:ledger";
const LEDGER_LIMIT = 20;

function stripFence(t) {
  return (t || "")
    .trim()
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/```\s*$/i, "")
    .trim();
}

function parseJSONish(text) {
  const cleaned = stripFence(text);
  try {
    return JSON.parse(cleaned);
  } catch (e) {
    const m = cleaned.match(/\{[\s\S]*\}/);
    if (m) {
      try {
        return JSON.parse(m[0]);
      } catch (e2) {
        return null;
      }
    }
    return null;
  }
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
  const cut = w * h * 0.02;
  let acc = 0;
  let lo = 0;
  let hi = 255;
  for (let i = 0; i < 256; i++) {
    acc += hist[i];
    if (acc > cut) {
      lo = i;
      break;
    }
  }
  acc = 0;
  for (let i = 255; i >= 0; i--) {
    acc += hist[i];
    if (acc > cut) {
      hi = i;
      break;
    }
  }
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
  // 잘라낸 조각이 작으면 키워서 글자를 크게 전달한다
  if (w < 900 && h < 900) {
    const up = Math.min(900 / Math.max(w, h), 2);
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
  const fileRef = useRef(null);

  useEffect(() => {
    setLedger(readLedger());
  }, []);

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

  const readPhoto = async () => {
    if (!srcImage || busy) return;
    setBusy("read");
    setError("");
    try {
      const b64 = await prepareImage(srcImage, crop);
      setSentImage(b64);
      const res = await fetch("/api/read", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ image: b64, hint: text.trim() || undefined }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `사진을 읽지 못했습니다 (${res.status})`);
      const parsed = parseJSONish(data.text);
      if (!parsed || !parsed.transcription) {
        throw new Error("문제를 알아보지 못했습니다. 문제 영역만 잘라서 다시 올려보세요.");
      }
      setReading(parsed);
      setConfirmed(parsed.transcription);
      setStage("confirm");
    } catch (e) {
      setError(e.message || "사진을 읽지 못했습니다.");
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
        body: JSON.stringify({ text: problemText, image: image || null, figureNote: figureNote || "" }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `풀이를 가져오지 못했습니다 (${res.status})`);
      const parsed = parseJSONish(data.text);
      if (!parsed || !parsed.answer) {
        throw new Error("풀이를 해석하지 못했습니다. 문제를 조금 더 또렷하게 올려주세요.");
      }
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

  const submitFromInput = () => {
    if (tab === "type") {
      if (!text.trim()) return;
      solve(text.trim(), null, "");
    } else {
      readPhoto();
    }
  };

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

            <button className="again" onClick={reset}>
              다음 문제 풀기
            </button>
          </section>
        ) : stage === "confirm" ? (
          <section className="result">
            <div className="meta-rule">읽은 내용 확인</div>
            <h2 className="confirm-head">이렇게 읽었습니다. 맞나요?</h2>
            <p className="confirm-sub">
              틀린 글자나 빠진 조건이 있으면 고쳐주세요. 여기서 한 번 잡아주면 풀이가 정확해집니다.
            </p>

            {(reading?.confidence === "low" || reading?.unclear) && (
              <div className="flag">
                {reading?.confidence === "low" && <b>사진이 흐려 판독이 불확실합니다. </b>}
                {reading?.unclear}
              </div>
            )}

            <div className="confirm-grid">
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
              사진 다시 올리기
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
                      className="field"
                      value={text}
                      onChange={(e) => setText(e.target.value)}
                      placeholder={"예) 함수 f(x)=x^3-3x^2+4 의 극댓값과 극솟값의 합을 구하시오.\n\n수식은 편한 대로 쓰면 됩니다. x^2, √3, ∫, lim 모두 알아봅니다."}
                      onKeyDown={(e) => {
                        if ((e.metaKey || e.ctrlKey) && e.key === "Enter") submitFromInput();
                      }}
                    />
                    <p className="hint">
                      <code>Ctrl</code> + <code>Enter</code> 로 바로 풀이를 시작합니다.
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

                {error && <div className="notice">{error}</div>}

                <button className="solve-btn" onClick={submitFromInput} disabled={!canSubmit || Boolean(busy)}>
                  {busy === "read"
                    ? "문제를 읽는 중"
                    : busy === "solve"
                    ? "가장 빠른 길을 찾는 중"
                    : tab === "photo"
                    ? "문제 읽기"
                    : "풀이 찾기"}
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
