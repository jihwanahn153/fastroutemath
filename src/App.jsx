import React, { useState, useRef, useEffect, useCallback } from "react";

const MAX_DIM = 1600;
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

function parseSolution(text) {
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

function resizeToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const img = new Image();
      img.onload = () => {
        let { width, height } = img;
        if (width > MAX_DIM || height > MAX_DIM) {
          if (width > height) {
            height = Math.round((height * MAX_DIM) / width);
            width = MAX_DIM;
          } else {
            width = Math.round((width * MAX_DIM) / height);
            height = MAX_DIM;
          }
        }
        const c = document.createElement("canvas");
        c.width = width;
        c.height = height;
        const ctx = c.getContext("2d");
        ctx.fillStyle = "#fff";
        ctx.fillRect(0, 0, width, height);
        ctx.drawImage(img, 0, 0, width, height);
        resolve(c.toDataURL("image/jpeg", 0.8).split(",")[1]);
      };
      img.onerror = () => reject(new Error("이미지를 읽지 못했습니다. 다른 사진으로 시도해주세요."));
      img.src = e.target.result;
    };
    reader.onerror = () => reject(new Error("파일을 읽지 못했습니다."));
    reader.readAsDataURL(file);
  });
}

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
    /* 저장 공간이 없으면 조용히 넘어간다 */
  }
}

// KaTeX로 수식 렌더 (public/vendor에서 전역으로 로드됨)
function Math({ children, className }) {
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
        /* 수식이 깨져도 원문은 그대로 보인다 */
      }
    }
  }, [children]);
  return (
    <div ref={ref} className={className}>
      {children}
    </div>
  );
}

export default function App() {
  const [tab, setTab] = useState("type"); // type | photo
  const [text, setText] = useState("");
  const [imageB64, setImageB64] = useState(null);
  const [imagePreview, setImagePreview] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [solution, setSolution] = useState(null);
  const [ledger, setLedger] = useState([]);
  const [showLedger, setShowLedger] = useState(false);
  const fileRef = useRef(null);

  useEffect(() => {
    setLedger(readLedger());
  }, []);

  // 클립보드에서 문제 이미지 바로 붙여넣기
  useEffect(() => {
    const onPaste = async (e) => {
      const item = Array.from(e.clipboardData?.items || []).find((i) => i.type.startsWith("image/"));
      if (!item) return;
      const file = item.getAsFile();
      if (!file) return;
      e.preventDefault();
      await acceptImage(file);
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, []);

  const acceptImage = useCallback(async (file) => {
    if (!file || !file.type.startsWith("image/")) return;
    setError("");
    try {
      const b64 = await resizeToBase64(file);
      setImageB64(b64);
      setImagePreview(`data:image/jpeg;base64,${b64}`);
      setTab("photo");
    } catch (e) {
      setError(e.message);
    }
  }, []);

  const clearImage = () => {
    setImageB64(null);
    setImagePreview(null);
    if (fileRef.current) fileRef.current.value = "";
  };

  const canSolve = tab === "type" ? text.trim().length > 0 : Boolean(imageB64);

  const solve = async () => {
    if (!canSolve || busy) return;
    setBusy(true);
    setError("");
    setSolution(null);
    setShowLedger(false);
    try {
      const res = await fetch("/api/solve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text: tab === "type" ? text : text,
          image: tab === "photo" ? imageB64 : null,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `풀이를 가져오지 못했습니다 (${res.status})`);
      const parsed = parseSolution(data.text);
      if (!parsed || !parsed.answer) {
        throw new Error("풀이를 해석하지 못했습니다. 문제를 조금 더 또렷하게 올려주세요.");
      }
      setSolution(parsed);
      const entry = {
        id: String(Date.now()),
        at: new Date().toISOString(),
        ...parsed,
      };
      const next = [entry, ...ledger].slice(0, LEDGER_LIMIT);
      setLedger(next);
      writeLedger(next);
    } catch (e) {
      setError(e.message || "풀이를 가져오지 못했습니다.");
    } finally {
      setBusy(false);
    }
  };

  const reset = () => {
    setSolution(null);
    setText("");
    clearImage();
    setError("");
    setShowLedger(false);
  };

  const oculusState = busy ? "working" : solution ? "lit" : "";

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
              setSolution(null);
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
          <div className="oculus-core">
            {busy ? "SOLVING" : solution ? `${solution.seconds || "—"}s` : "READY"}
          </div>
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
        ) : solution ? (
          <section className="result">
            <div className="meta-rule">{solution.topic || "풀이"}</div>
            <Math className="insight">{solution.insight}</Math>
            <p className="problem-line">{solution.problem}</p>

            <div className="flight">
              {(solution.steps || []).map((s, i) => (
                <div
                  className="tread"
                  key={i}
                  style={{
                    marginLeft: `min(${i * 10}px, 5vw)`,
                    animationDelay: `${0.12 + i * 0.07}s`,
                  }}
                >
                  <div className="tread-num">{i + 1}</div>
                  <p className="tread-do">{s.do}</p>
                  {s.math ? <Math className="tread-math">{s.math}</Math> : null}
                  {s.why ? <p className="tread-why">{s.why}</p> : null}
                </div>
              ))}
            </div>

            <div className="landing">
              <div className="landing-label">ANSWER</div>
              <Math className="landing-answer">{solution.answer}</Math>
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
                <button
                  className="tab"
                  role="tab"
                  aria-selected={tab === "type"}
                  onClick={() => setTab("type")}
                >
                  직접 입력
                </button>
                <button
                  className="tab"
                  role="tab"
                  aria-selected={tab === "photo"}
                  onClick={() => setTab("photo")}
                >
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
                        if ((e.metaKey || e.ctrlKey) && e.key === "Enter") solve();
                      }}
                    />
                    <p className="hint">
                      <code>Ctrl</code> + <code>Enter</code> 로 바로 풀이를 시작합니다.
                    </p>
                  </>
                ) : (
                  <>
                    {imagePreview ? (
                      <div className="preview">
                        <img src={imagePreview} alt="올린 문제" />
                        <button className="preview-clear" onClick={clearImage}>
                          다시 올리기
                        </button>
                      </div>
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
                    <p className="hint">문제 번호와 조건 상자까지 함께 나오게 찍으면 더 정확합니다.</p>
                  </>
                )}

                {error && <div className="notice">{error}</div>}

                <button className="solve-btn" onClick={solve} disabled={!canSolve || busy}>
                  {busy ? "가장 빠른 길을 찾는 중" : "풀이 찾기"}
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
