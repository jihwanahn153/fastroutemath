/* 그래프를 그리려면 "x^2 - a*x" 같은 문자열을 실제로 계산해야 한다.
   eval은 쓰지 않는다. 모델이 만든 문자열을 그대로 실행시킬 수는 없다.
   그래서 작은 파서를 직접 둔다. 지원 범위를 좁게 잡아 예측 가능하게 유지한다. */

const FUNCS = {
  sin: Math.sin,
  cos: Math.cos,
  tan: Math.tan,
  asin: Math.asin,
  acos: Math.acos,
  atan: Math.atan,
  sinh: Math.sinh,
  cosh: Math.cosh,
  tanh: Math.tanh,
  exp: Math.exp,
  ln: Math.log,
  log: Math.log,
  log10: Math.log10,
  log2: Math.log2,
  sqrt: Math.sqrt,
  cbrt: Math.cbrt,
  abs: Math.abs,
  sign: Math.sign,
  floor: Math.floor,
  ceil: Math.ceil,
  round: Math.round,
  cot: (v) => 1 / Math.tan(v),
  sec: (v) => 1 / Math.cos(v),
  csc: (v) => 1 / Math.sin(v),
};

const FUNCS2 = {
  min: Math.min,
  max: Math.max,
  pow: Math.pow,
  atan2: Math.atan2,
  mod: (a, b) => ((a % b) + b) % b,
};

const CONSTS = { pi: Math.PI, tau: Math.PI * 2, e: Math.E };

function tokenize(src) {
  const s = String(src || "");
  const out = [];
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (/\s/.test(c)) {
      i += 1;
      continue;
    }
    if (/[0-9.]/.test(c)) {
      let j = i;
      while (j < s.length && /[0-9.]/.test(s[j])) j += 1;
      out.push({ t: "num", v: Number(s.slice(i, j)) });
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      let j = i;
      while (j < s.length && /[A-Za-z_0-9]/.test(s[j])) j += 1;
      out.push({ t: "name", v: s.slice(i, j) });
      i = j;
      continue;
    }
    if ("+-*/^(),|".includes(c)) {
      out.push({ t: c });
      i += 1;
      continue;
    }
    // 모르는 문자는 조용히 버린다. 수식 하나 때문에 그림 전체가 사라지면 안 된다.
    i += 1;
  }
  return out;
}

/* 반환값은 (vars) => number 형태의 함수다.
   파싱에 실패하면 null을 준다. 호출하는 쪽에서 그 요소만 건너뛴다. */
export function compile(src) {
  const toks = tokenize(src);
  if (!toks.length) return null;
  let p = 0;
  const peek = () => toks[p];
  const eat = (t) => {
    if (toks[p] && toks[p].t === t) {
      p += 1;
      return true;
    }
    return false;
  };

  let failed = false;
  let barDepth = 0; // |x-5| 안에서는 닫는 막대를 곱셈으로 오해하면 안 된다
  const fail = () => {
    failed = true;
    return () => NaN;
  };

  // 곱셈 기호가 생략된 자리를 찾는다: 2x, 3(x+1), )(  등
  const implicitMul = () => {
    const tk = peek();
    if (!tk) return false;
    if (tk.t === "|") return barDepth === 0;
    return tk.t === "num" || tk.t === "name" || tk.t === "(";
  };

  function parseExpr() {
    let left = parseTerm();
    for (;;) {
      if (eat("+")) {
        const r = parseTerm();
        const l = left;
        left = (v) => l(v) + r(v);
      } else if (eat("-")) {
        const r = parseTerm();
        const l = left;
        left = (v) => l(v) - r(v);
      } else break;
    }
    return left;
  }

  function parseTerm() {
    let left = parseUnary();
    for (;;) {
      if (eat("*")) {
        const r = parseUnary();
        const l = left;
        left = (v) => l(v) * r(v);
      } else if (eat("/")) {
        const r = parseUnary();
        const l = left;
        left = (v) => l(v) / r(v);
      } else if (implicitMul()) {
        const before = p;
        const r = parseUnary();
        if (p === before) break;
        const l = left;
        left = (v) => l(v) * r(v);
      } else break;
    }
    return left;
  }

  function parseUnary() {
    if (eat("-")) {
      const r = parseUnary();
      return (v) => -r(v);
    }
    if (eat("+")) return parseUnary();
    return parsePower();
  }

  function parsePower() {
    const base = parseAtom();
    if (eat("^")) {
      const ex = parseUnary(); // 지수는 오른쪽 결합
      return (v) => Math.pow(base(v), ex(v));
    }
    return base;
  }

  function parseAtom() {
    const tk = peek();
    if (!tk) return fail();

    if (tk.t === "num") {
      p += 1;
      const n = tk.v;
      return () => n;
    }

    if (tk.t === "|") {
      p += 1;
      barDepth += 1;
      const inner = parseExpr();
      barDepth -= 1;
      if (!eat("|")) return fail();
      return (v) => Math.abs(inner(v));
    }

    if (tk.t === "(") {
      p += 1;
      const inner = parseExpr();
      if (!eat(")")) return fail();
      return inner;
    }

    if (tk.t === "name") {
      p += 1;
      const name = tk.v;
      const lower = name.toLowerCase();

      if (peek() && peek().t === "(") {
        p += 1;
        const args = [parseExpr()];
        while (eat(",")) args.push(parseExpr());
        if (!eat(")")) return fail();
        if (FUNCS[lower] && args.length === 1) {
          const f = FUNCS[lower];
          const a = args[0];
          return (v) => f(a(v));
        }
        if (FUNCS2[lower]) {
          const f = FUNCS2[lower];
          return (v) => f(...args.map((a) => a(v)));
        }
        // f(x) 처럼 정의되지 않은 함수는 변수 취급하고 곱으로 본다
        const a = args[0];
        return (v) => (name in v ? v[name] * a(v) : NaN);
      }

      if (lower in CONSTS) {
        const c = CONSTS[lower];
        return () => c;
      }
      return (v) => (name in v ? v[name] : NaN);
    }

    return fail();
  }

  const fn = parseExpr();
  if (failed || p < toks.length) {
    // 남은 토큰이 있으면 이해하지 못한 수식이다
    if (failed) return null;
  }
  return (vars) => {
    const r = fn(vars || {});
    return typeof r === "number" ? r : NaN;
  };
}

// "0, 3" 이나 "-1.5,2" 같은 좌표쌍을 함수 두 개로 돌려준다
export function compilePoint(src) {
  const parts = String(src || "").split(",");
  if (parts.length < 2) return null;
  const x = compile(parts[0]);
  const y = compile(parts.slice(1).join(","));
  if (!x || !y) return null;
  return { x, y };
}
