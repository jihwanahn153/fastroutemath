// 최단 풀이 — 서버
//
// 하는 일은 두 가지입니다.
//   1) public/ 의 정적 파일을 서빙한다.
//   2) /api/solve 로 들어온 문제를 Anthropic API에 대신 물어본다.
//      (API 키는 이 서버 안에만 있고 브라우저로 나가지 않습니다)

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const PUBLIC_DIR = path.join(ROOT, "public");

// .env 로더 (dotenv 없이 동작)
function loadDotEnv() {
  const envPath = path.join(ROOT, ".env");
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const i = t.indexOf("=");
    if (i === -1) continue;
    const k = t.slice(0, i).trim();
    let v = t.slice(i + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    if (process.env[k] === undefined) process.env[k] = v;
  }
}
loadDotEnv();

const PORT = process.env.PORT || 3000;
const MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-4-6";

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".ttf": "font/ttf",
};

// LaTeX는 백슬래시가 많아 JSON 문자열로 주고받으면 깨진다.
// (\\lim -> 파싱 실패, \\to -> 탭 문자로 변질)
// 그래서 이스케이프가 필요 없는 블록 구분자 형식을 쓴다.

const READ_SYSTEM = `너는 한국 수능·내신 수학 시험지를 판독하는 전문가다.
지금은 문제를 "푸는" 단계가 아니다. 오직 정확히 옮겨 적는 것만 한다.

판독 규칙:
- 사진에 여러 문제가 보이면 가장 중앙에 크게 잡힌 문제 하나만 옮긴다.
- 화면 캡처처럼 이미 깨끗하게 조판된 수식 이미지도 똑같이 그대로 옮긴다.
- 수식은 LaTeX로 옮기고 달러 기호로 감싼다.
- 한국 시험지 관례를 그대로 살린다.
  · 선택지는 ① ② ③ ④ ⑤ 기호를 유지한다
  · 조건 상자는 (가) (나) (다) 로 표기하고 상자 안 내용을 빠짐없이 옮긴다
  · 배점 [3점] [4점] 이 보이면 함께 적는다
  · "단, ~이다" 같은 단서 조항을 절대 빠뜨리지 않는다
- 첨자와 지수를 특히 조심한다. $a_n$ 과 $a^n$, $f'(x)$ 와 $f(x)$ 를 혼동하지 않는다.
- 극한의 방향(좌극한 $h \\to 0-$ 인지 우극한 $h \\to 0+$ 인지), 부등호의 등호 포함 여부,
  구간이 열린 구간인지 닫힌 구간인지를 정확히 구분한다.
- 분수, 적분 구간, 시그마의 위아래 범위를 빠뜨리지 않는다.
- 학생이 연필로 쓴 풀이 흔적은 문제가 아니다. 인쇄된 문제만 옮긴다.
- 흐려서 확신이 없으면 추측해 채우지 말고 UNCLEAR에 적는다.

아래 형식 그대로 출력한다. JSON을 쓰지 마라. 백슬래시를 이스케이프하지 마라.
LaTeX는 평소 쓰는 그대로 적으면 된다.

@@TRANSCRIPTION
(문제 전문. 발문·조건 상자·선택지·단서를 모두 포함해 원문 그대로. 줄바꿈 자유)
@@FIGURE
(그림·그래프·도형이 있으면 yes, 없으면 no)
@@FIGURENOTE
(그림이 있으면 무엇이 어떻게 그려져 있는지 구체적으로. 없으면 비워둔다)
@@CONFIDENCE
(high 또는 medium 또는 low)
@@UNCLEAR
(판독이 애매한 부분. 없으면 비워둔다)
@@END`;

const NORMALIZE_SYSTEM = `너는 학생이 키보드로 입력한 수학 문제를 정식 표기로 다듬는 조교다.
지금은 푸는 단계가 아니다. 학생이 의도한 바를 정확한 수식으로 옮기기만 한다.

규칙:
- 학생의 대충 쓴 표기를 표준 LaTeX로 바꾼다.
  예: x^2 -> $x^2$,  lim x->0 -> $\\lim_{x \\to 0}$,  integral -> $\\int$,  root3 -> $\\sqrt{3}$
- 이미 LaTeX로 쓴 부분은 그대로 살린다.
- 문제의 뜻을 바꾸지 않는다. 조건을 추가하거나 빼지 않는다.
- 해석이 갈리는 표기가 있으면 가장 자연스러운 쪽으로 적되 UNCLEAR에 무엇이 애매한지 밝힌다.
  예: 1/2x 는 $\\dfrac{1}{2}x$ 로 볼지 $\\dfrac{1}{2x}$ 로 볼지 애매하다.
- 문제로 보기 어려운 입력이면 UNCLEAR에 그렇게 적는다.

아래 형식 그대로 출력한다. JSON을 쓰지 마라. 백슬래시를 이스케이프하지 마라.

@@TRANSCRIPTION
(정리된 문제 전문)
@@FIGURE
no
@@FIGURENOTE

@@CONFIDENCE
(high 또는 medium 또는 low)
@@UNCLEAR
(해석이 애매한 부분. 없으면 비워둔다)
@@END`;

const SOLVE_SYSTEM = `너는 한국 수능·내신 수학 문제를 푸는 전문 강사다.

가장 중요한 원칙 — 순서를 지켜라.
1) 답이 맞는 것이 최우선이다.
2) 그 다음으로, 실전에서 시간을 아끼는 경로를 고른다.
빠른 풀이를 보여주려다 틀린 답을 내는 것은 최악이다. 어려운 문제라면 단계가 늘어나도 좋다.

먼저 SCRATCH 칸에서 충분히 계산하라. 이 칸은 학생에게 보이지 않으므로
길게 써도 되고, 시행착오를 적어도 되고, 여러 접근을 비교해도 된다.
SCRATCH에서 반드시 다음을 수행한다.
- 문제의 모든 조건을 하나씩 식으로 옮겼는지 확인한다. 특히 조건 상자 (가)(나)와
  "단, ~이다" 단서를 빠뜨리지 않았는지 점검한다.
- 답을 구한 뒤 검산한다. 원식에 대입해 보거나, 특수값을 넣어 보거나,
  차수·부호·정의역을 확인하거나, 선택지가 있으면 대조한다.
- 검산에서 어긋나면 다시 계산한다. 어긋난 채로 답을 쓰지 마라.

그 다음 학생에게 보여줄 풀이를 쓴다.
- 단계는 실제로 손으로 쓰는 순서대로, 군더더기 없이 쓴다.
- 계산량을 줄이는 관찰(대칭성, 특수값 대입, 그래프 개형, 치환, 차수 비교, 선택지 소거)이
  있으면 그것을 앞세운다. 없으면 정공법으로 간다.
- 수식은 LaTeX로 쓰고 달러 기호로 감싼다.
- 한국 고등학생이 읽는다. 간결한 서술체로 쓴다.

아래 형식 그대로 출력한다. JSON을 쓰지 마라. 백슬래시를 이스케이프하지 마라.
LaTeX는 평소 쓰는 그대로 적으면 된다.

@@SCRATCH
(자유롭게 계산하고 검산한다. 학생에게 보이지 않는다)
@@PROBLEM
(문제를 한 줄로 정리. 60자 이내)
@@TOPIC
(단원명. 예: 미적분 - 접선의 방정식)
@@INSIGHT
(이 문제를 푸는 핵심 관찰 한 줄. 60자 이내)
@@STEP
@@DO
(이 단계에서 하는 일. 30자 이내)
@@MATH
(그 단계의 핵심 수식. 없으면 비워둔다)
@@WHY
(왜 이렇게 가는지 또는 주의점. 40자 이내. 없으면 비워둔다)
@@STEP
@@DO
...
@@ANSWER
(최종 답. LaTeX)
@@CONFIDENCE
(검산까지 마쳐 확신하면 high, 조건 해석이 갈릴 여지가 있으면 medium, 자신 없으면 low)
@@SECONDS
(실전에서 걸릴 예상 초. 숫자만)
@@TRAP
(이 문제에서 자주 하는 실수 한 줄. 50자 이내)
@@SLOWER
(더 느린 정석 경로가 있다면 왜 느린지 한 줄. 없으면 비워둔다)
@@END

STEP 블록은 3개에서 8개 사이로 쓴다. 문제가 어려우면 많아도 된다.
문제를 판독할 수 없거나 풀 수 없으면 ANSWER에 "판독 불가"라고 적고 UNCLEAR 대신
TRAP에 이유를 쓴다.`;

async function callAnthropic(content, system, maxTokens) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    const e = new Error(
      "서버에 ANTHROPIC_API_KEY가 없습니다. Render 대시보드의 Environment에 키를 추가한 뒤 다시 배포하세요."
    );
    e.status = 500;
    throw e;
  }
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: maxTokens || 8000,
      system: system || SOLVE_SYSTEM,
      messages: [{ role: "user", content }],
    }),
  });
  const data = await r.json();
  if (!r.ok) {
    const e = new Error(data?.error?.message || `Anthropic API 오류 (${r.status})`);
    e.status = r.status;
    throw e;
  }
  return (data.content || [])
    .map((b) => (b.type === "text" ? b.text : ""))
    .filter(Boolean)
    .join("\n");
}

function readBody(req, limit = 20 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) {
        reject(Object.assign(new Error("이미지가 너무 큽니다. 더 작게 찍어 올려주세요."), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function json(res, status, obj) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(obj));
}

function serveStatic(req, res) {
  let urlPath = decodeURIComponent(req.url.split("?")[0]);
  if (urlPath === "/") urlPath = "/index.html";
  const filePath = path.join(PUBLIC_DIR, path.normalize(urlPath).replace(/^(\.\.[/\\])+/, ""));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }
  if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
    const ext = path.extname(filePath);
    const headers = { "content-type": MIME[ext] || "application/octet-stream" };
    if (urlPath.startsWith("/vendor/") || urlPath.startsWith("/dist/")) {
      headers["cache-control"] = "public, max-age=604800";
    }
    res.writeHead(200, headers);
    fs.createReadStream(filePath).pipe(res);
    return;
  }
  const index = path.join(PUBLIC_DIR, "index.html");
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  fs.createReadStream(index).pipe(res);
}

const server = http.createServer(async (req, res) => {
  if (req.url === "/api/health") {
    json(res, 200, { ok: true, hasApiKey: Boolean(process.env.ANTHROPIC_API_KEY), model: MODEL });
    return;
  }

  // 1단계 — 사진을 옮겨 적거나(read), 입력한 텍스트를 정식 표기로 다듬는다(normalize).
  // 어느 쪽이든 학생이 확인할 "문제 원문"을 만드는 단계이고, 풀지는 않는다.
  if (req.url === "/api/read" && req.method === "POST") {
    try {
      const body = JSON.parse(await readBody(req));
      const typed = (body.text || "").trim();
      if (!body.image && !typed) {
        json(res, 400, { error: "문제를 입력하거나 사진을 올려주세요." });
        return;
      }

      const content = [];
      let system;
      if (body.image) {
        system = READ_SYSTEM;
        content.push({
          type: "image",
          source: { type: "base64", media_type: "image/jpeg", data: body.image },
        });
        content.push({
          type: "text",
          text:
            "이 사진에 인쇄된 수학 문제를 규칙에 따라 정확히 옮겨 적어라. 절대 풀지 마라." +
            (typed ? `\n학생 메모: ${typed}` : ""),
        });
      } else {
        system = NORMALIZE_SYSTEM;
        content.push({
          type: "text",
          text: `학생이 입력한 문제다. 정식 표기로 다듬기만 하고 풀지 마라.\n\n${typed}`,
        });
      }

      const text = await callAnthropic(content, system, 2000);
      json(res, 200, { text });
    } catch (e) {
      json(res, e.status || 500, { error: e.message || "문제를 읽지 못했습니다." });
    }
    return;
  }

  // 2단계 — 확정된 문제를 가장 빠른 경로로 푼다
  if (req.url === "/api/solve" && req.method === "POST") {
    try {
      const body = JSON.parse(await readBody(req));
      const problem = (body.text || "").trim();
      if (!problem && !body.image) {
        json(res, 400, { error: "문제를 입력하거나 사진을 올려주세요." });
        return;
      }

      const content = [];
      // 그림·그래프가 있는 문제는 원본 사진을 함께 넘겨야 정확하다
      if (body.image) {
        content.push({
          type: "image",
          source: { type: "base64", media_type: "image/jpeg", data: body.image },
        });
      }

      let instruction;
      if (problem && body.image) {
        instruction =
          `다음은 사진 속 문제를 학생이 확인한 최종 문제다. 문자와 수식은 이 텍스트를 정본으로 삼고,` +
          ` 그림·그래프·도형이 필요하면 사진을 참고해라.\n\n${problem}` +
          (body.figureNote ? `\n\n[그림 설명] ${body.figureNote}` : "") +
          `\n\n이 문제를 가장 빠른 경로로 풀어라.`;
      } else if (problem) {
        instruction = `다음 수학 문제를 가장 빠른 경로로 풀어라.\n\n${problem}`;
      } else {
        instruction = "사진 속 수학 문제를 가장 빠른 경로로 풀어라.";
      }
      content.push({ type: "text", text: instruction });

      // 검산까지 하려면 넉넉한 토큰이 필요하다. SCRATCH는 화면에 보이지 않는다.
      const text = await callAnthropic(content, SOLVE_SYSTEM, 8000);
      json(res, 200, { text });
    } catch (e) {
      json(res, e.status || 500, { error: e.message || "풀이를 가져오지 못했습니다." });
    }
    return;
  }

  serveStatic(req, res);
});

server.listen(PORT, () => {
  console.log(`최단 풀이 서버 실행 → http://localhost:${PORT}`);
  if (!process.env.ANTHROPIC_API_KEY) {
    console.warn("⚠️  ANTHROPIC_API_KEY 미설정 — 풀이 요청이 실패합니다.");
  }
});
