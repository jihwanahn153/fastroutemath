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

const SOLVE_SYSTEM = `너는 한국 수능·내신 수학 문제를 "가장 빠른 경로"로 푸는 전문 강사다.

원칙:
- 정석 풀이가 아니라 실전에서 시간을 가장 아끼는 경로를 제시한다.
- 대칭성, 특수값 대입, 그래프 개형, 선택지 소거, 치환, 극한의 차수 비교처럼
  계산량을 줄이는 관찰을 우선한다.
- 단계는 실제로 손으로 쓰는 순서대로, 군더더기 없이 쓴다.
- 수식은 반드시 LaTeX로 쓰고 달러 기호로 감싼다. 예: $x^2+1$
- 한국 고등학생이 읽는다. 존댓말 대신 간결한 서술체로 쓴다.

반드시 아래 JSON 객체 하나만 출력한다. 코드펜스, 설명, 인사말을 절대 붙이지 않는다.
{
  "problem": "문제를 한 줄로 정리 (60자 이내)",
  "topic": "단원명 (예: 미적분 - 접선의 방정식)",
  "insight": "이 문제를 빠르게 푸는 핵심 관찰 한 줄 (50자 이내)",
  "steps": [
    { "do": "이 단계에서 하는 일 (25자 이내)",
      "math": "그 단계의 핵심 수식 ($ 로 감싼 LaTeX, 없으면 빈 문자열)",
      "why": "왜 이게 빠른지 또는 주의점 (35자 이내, 없으면 빈 문자열)" }
  ],
  "answer": "최종 답 ($ 로 감싼 LaTeX)",
  "seconds": 실전에서 걸릴 예상 초 (정수),
  "trap": "이 문제에서 자주 하는 실수 한 줄 (40자 이내)",
  "slower": "정석 풀이로 갔을 때 왜 느린지 한 줄 (40자 이내)"
}
steps는 3~6개로 제한한다. 문제가 불분명하면 problem에 무엇이 불분명한지 적고
steps는 빈 배열, answer는 "판독 불가"로 둔다.`;

async function callAnthropic(content) {
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
      max_tokens: 3000,
      system: SOLVE_SYSTEM,
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

  if (req.url === "/api/solve" && req.method === "POST") {
    try {
      const body = JSON.parse(await readBody(req));
      const content = [];
      if (body.image) {
        content.push({
          type: "image",
          source: { type: "base64", media_type: "image/jpeg", data: body.image },
        });
      }
      const note = (body.text || "").trim();
      content.push({
        type: "text",
        text: body.image
          ? `사진 속 수학 문제를 가장 빠른 경로로 풀어라.${note ? `\n추가 요청: ${note}` : ""}`
          : `다음 수학 문제를 가장 빠른 경로로 풀어라.\n\n${note}`,
      });
      if (!body.image && !note) {
        json(res, 400, { error: "문제를 입력하거나 사진을 올려주세요." });
        return;
      }
      const text = await callAnthropic(content);
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
