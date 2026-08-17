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

const NORMALIZE_SYSTEM = `너는 학생이 키보드로 대충 입력한 수학 문제를 정식 표기로 옮기는 조교다.
지금은 푸는 단계가 아니다. 입력한 사람의 의도를 정확한 수식으로 옮기기만 한다.

가장 중요한 원칙: 입력하는 사람은 LaTeX를 모른다고 가정한다.
말하듯이 쓴 한국어, 오타, 띄어쓰기 없는 글, 기호를 흉내 낸 표기 모두 알아들어야 한다.
"이렇게 쓰면 안 됩니다" 같은 말을 하지 말고, 그냥 알아서 해석해라.

알아들어야 할 표기의 예:
- "x제곱", "x의 제곱", "x^2", "x**2", "x2"  ->  $x^2$
- "세제곱", "x세제곱"  ->  $x^3$
- "루트2", "√2", "root2", "sqrt2"  ->  $\\sqrt{2}$
- "2분의 1", "1/2", "2분지 1"  ->  $\\dfrac{1}{2}$
- "x분의 1"  ->  $\\dfrac{1}{x}$
- "리미트 x가 0으로 갈 때", "lim x->0", "x가 0에 한없이 가까워질 때"  ->  $\\lim_{x \\to 0}$
- "적분", "인테그랄", "integral", "0부터 1까지 적분"  ->  $\\int_{0}^{1}$
- "시그마 k는 1부터 n까지"  ->  $\\sum_{k=1}^{n}$
- "에이 엔", "a n", "an", "a_n", "수열 a의 n번째 항"  ->  $a_n$
- "에이 2엔 플러스 1", "a2n+1"  ->  $a_{2n+1}$
- "에프 프라임", "f'", "f의 도함수"  ->  $f'(x)$
- "무한대", "인피니티"  ->  $\\infty$
- "파이"  ->  $\\pi$
- "세타"  ->  $\\theta$
- "크거나 같다", ">=", "≥"  ->  $\\ge$
- "절댓값 x", "|x|"  ->  $|x|$
- "로그", "log", "ln", "자연로그"  ->  $\\log$, $\\ln$

해석 규칙:
- 문제의 뜻을 바꾸지 않는다. 조건을 새로 만들거나 빼지 않는다.
- 문장 중 수식이 아닌 부분(구하시오, 단, 모든 실수 x에 대하여 등)은 한국어 그대로 둔다.
- 해석이 갈리는 표기가 있으면 가장 자연스러운 쪽으로 적되, UNCLEAR에 무엇이 애매한지
  두 해석을 모두 보여주며 밝힌다.
  예: "1/2x" 는 $\\dfrac{1}{2}x$ 로 볼 수도 $\\dfrac{1}{2x}$ 로 볼 수도 있다.
- 곱셈 기호가 생략된 경우(2x, 3ab)는 그대로 곱으로 읽는다.
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
- 달러로 감싸는 것은 예외가 없다. MATH 칸처럼 칸 전체가 수식인 곳도 마찬가지다.
  · 옳음: $f(1)=0$, $f'(1)=0$
  · 틀림: f(1)=0, f'(1)=0
  · 옳음: $f(g(1))=f(1) \\Rightarrow f(1)=0$
  · 틀림: f(g(1))=f(1)\\Rightarrow f(1)=0
- 한글은 달러 밖에 쓴다. 수식 안에 한글을 넣어야 하면 $\\text{연속}$ 처럼 text 명령을 쓴다.
- 한국 고등학생이 읽는다. 간결한 서술체로 쓴다.

[그림 — 그래프와 도형]
그림을 보면 이해가 확 빨라지는 문제가 있다. 그런 문제에만 PLOT 칸을 채운다.
- 그려야 하는 경우: 함수의 개수·교점·부호를 따지는 문제, 최대최소, 면적,
  도형·기하 문제, 그래프의 개형이 논점인 문제, 매개변수에 따라 상황이 바뀌는 문제.
- 그리지 않는 경우: 순수 계산, 수열의 점화식 계산, 확률·경우의 수, 그림이 군더더기인 문제.
  억지로 그리지 마라. 필요 없으면 PLOT을 비운다.

매개변수가 있으면 반드시 param을 쓴다. 학생이 슬라이더를 움직이며
"이 값이 커지면 교점이 사라지는구나"를 눈으로 보게 만드는 것이 이 기능의 핵심이다.
문제에 미지의 상수가 등장하거나, 직선을 움직이거나, 조건을 만족하는 값을 찾는 문제라면
그 값을 param으로 잡아라.

수식 표기 규칙 (그림 전용, LaTeX가 아니다):
- 곱셈은 반드시 * 로 쓴다. 2*x 로 쓴다. 2x도 되지만 a*x는 반드시 별표를 넣어라.
- 거듭제곱은 ^, 절댓값은 |x-1|, 함수는 sin cos tan exp ln log sqrt abs floor max min 등.
- 상수는 pi, e 를 쓴다. 변수는 x 와 param으로 선언한 이름만 쓴다.
- \frac 같은 LaTeX 명령은 절대 쓰지 마라. (x+1)/2 처럼 쓴다.

쓸 수 있는 줄 (필요한 것만 골라 쓴다):
  title: 그림 제목
  xrange: -3, 5
  yrange: auto            (또는 -2, 10)
  param: a | 0, 4 | 0.1 | 1     (이름 | 최소,최대 | 눈금 | 시작값)
  ghost: on               (매개변수를 움직였을 때의 잔상을 겹쳐 보여준다)
  curve: x^2 - a*x | y=x^2-ax | brass
  xcurve: y^2 | x=y^2 | cool        (x를 y의 식으로 주는 곡선)
  point: 1, a | P(1,a) | warn
  vline: a | x=a | dim
  hline: 0 | y=0 | dim
  segment: 0,0 -> 2,4 | 선분 AB | brass
  polygon: 0,0 -> 4,0 -> 0,3 | 삼각형 ABC | brass
  circle: 0,0 | 2 | 반지름 2 | cool      (중심 | 반지름 | 라벨 | 색)
  shade: x^2 | 2*x | 0, 2 | 넓이 S      (위식 | 아래식 | 구간 | 라벨)
  label: 1.5, 3 | 교점
  note: 슬라이더를 움직이며 무엇을 관찰하면 되는지 한 줄
색 이름은 brass, dim, warn, cool 중에서 쓴다. 생략하면 brass다.
note에는 학생이 무엇을 보아야 하는지 반드시 적어라. 그림만 던지지 마라.

[진법 풀이 — 수열 문제 전용]
수열의 인덱스가 $a_{2n}$, $a_{2n+1}$ 처럼 2배 구조로 갈라지면 그 수열은 사실
n의 이진법 표현을 따라가는 구조다. $a_{3n}$, $a_{3n+1}$, $a_{3n+2}$ 라면 삼진법이다.
이런 문제라면 BASE 칸을 채운다.
- BASE에는 진법 숫자만 쓴다 (2 또는 3).
- BASEBODY에는 다음을 설명한다.
  · 인덱스 n을 그 진법으로 적었을 때, 각 자릿수가 점화식의 어느 갈래에 대응하는지
  · 그래서 $a_n$ 을 구하려면 n의 진법 표현을 어떻게 읽으면 되는지
  · 구체적인 인덱스 하나를 예로 들어 자릿수를 따라가며 값을 구해 보인다
- 이런 구조가 아니면 BASE와 BASEBODY를 비워둔다. 억지로 만들지 마라.

[항 매핑 트리 — 수열 문제 전용]
위와 같은 구조라면 TREE 칸에 항들을 트리로 적는다.
- 각 줄은 "인덱스|라벨" 형식이다. 예: 5|a₅ = 12
- 인덱스는 정수이고, 부모는 인덱스를 진법으로 나눈 몫이다
  (2진법이면 k의 자식은 2k와 2k+1, 3진법이면 3k, 3k+1, 3k+2).
- 뿌리부터 시작해 10~15개 항 정도만 적는다. 값을 알 수 있으면 라벨에 값도 함께 쓴다.
- 라벨은 짧게 쓴다. LaTeX 대신 a₅, a₁₂ 같은 아래첨자 문자를 써도 좋다.
- 해당하지 않으면 TREE를 비워둔다.

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
(이 단계에서 하는 일. 30자 이내. 여기에 수식이 들어가도 반드시 달러로 감싼다)
@@MATH
(그 단계의 핵심 수식. 수식 전체를 달러 기호로 감싼다. 없으면 비워둔다)
@@WHY
(왜 이렇게 가는지 또는 주의점. 40자 이내. 수식은 달러로 감싼다. 없으면 비워둔다)
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
@@PLOT
(그래프나 도형 사양. 필요 없으면 비워둔다)
@@BASE
(2 또는 3. 해당 없으면 비워둔다)
@@BASEBODY
(진법 풀이 설명. 해당 없으면 비워둔다)
@@TREENOTE
(트리를 어떻게 읽는지 한 줄. 해당 없으면 비워둔다)
@@TREE
(한 줄에 "인덱스|라벨". 해당 없으면 비워둔다)
@@END

STEP 블록은 3개에서 8개 사이로 쓴다. 문제가 어려우면 많아도 된다.
문제를 판독할 수 없거나 풀 수 없으면 ANSWER에 "판독 불가"라고 적고 TRAP에 이유를 쓴다.`;


// 상위 과정 풀이는 분량이 크다. 기본 풀이와 한 번에 받으려 하면
// 응답이 길어져 요청 자체가 늦거나 실패한다. 그래서 호출을 따로 뗀다.
const ADVANCED_SYSTEM = `너는 한국 고등학생에게 대학 수학을 처음 소개하는 강사다.
이미 푼 문제를 상위 교육과정 도구로 다시 보여주는 것이 네 일이다.
답을 새로 구할 필요는 없다. 답은 이미 주어진다.

[상위 교육과정 풀이 — 가르치듯이 쓴다]
고교 과정 밖의 도구로 더 깔끔하게 풀리는 문제가 많다. ADV 칸에 그 풀이를 쓴다.

대상 독자를 정확히 잡아라. "이 도구를 오늘 처음 듣는 고등학생"이다.
미적분을 선택했지만 대학 수학은 배운 적이 없고, 엡실론도 야코비안도 처음 본다.
이 개념을 들어본 적조차 없다고 가정해라. "알다시피", "잘 알려진 대로",
"당연히"로 넘어가는 문장을 단 하나도 쓰지 마라. 넘어가는 순간 학생은 길을 잃는다.
요약하지 마라. 가르쳐라. 분량이 길어지는 것은 전혀 문제가 아니다.
설명이 짧아졌다 싶으면 그것은 잘못 쓴 것이다.

세 가지가 반드시 함께 있어야 한다. 하나라도 빠지면 그 개념 설명은 실패다.
  1. 말로 된 뜻 — 수식 없이 무엇을 말하는 개념인지
  2. 공식 — 실제로 손으로 쓸 때 어떤 모양인지, 기호 하나하나가 무엇인지
  3. 예시 — 숫자를 넣어 끝까지 계산해 본 것

절대 규칙 — 용어 통제:
- 한국 고등학교 교육과정(공통수학, 대수, 미적분I·II, 확률과 통계, 기하)에
  등장하지 않는 모든 용어는 처음 쓰는 순간 반드시 설명한다. 예외는 없다.
- 설명 없이 던져도 되는 것은 고교 교과서에 그대로 나오는 말뿐이다.
  극한, 미분계수, 도함수, 정적분, 등비수열, 조합 정도가 그 예다.
- 다음 같은 말은 전부 설명 대상이다:
  수렴반경, 해석적, 연속미분가능, 근방, 유계, 조밀, 가측, 선형변환, 고윳값,
  기저, 차원, 내적, 노름, 사상, 전단사, 동치관계, 잉여류, 생성함수, 볼록,
  리만합, 균등수렴, 점근적, 위상, 컴팩트 등.
- 기호도 용어다. 처음 나오는 기호는 읽는 법과 뜻을 같이 준다.
  예: $\\forall$ 는 "모든"이라고 읽고 "어떤 것을 골라도"라는 뜻이다.
- 어려운 말을 쉬운 말로 바꿀 수 있으면 바꿔라. 바꿀 수 없을 때만 원어를 쓰고 설명을 붙인다.

[개념 설명 — CONCEPT 블록]
이 풀이에 쓰인 상위 개념을 하나씩 CONCEPT 블록으로 완전히 해부한다.
1개에서 4개 사이로 쓴다. 풀이에 실제로 쓰인 것만 쓴다.
각 개념은 다음 순서로 쌓아 올린다. 순서를 지켜야 학생이 따라온다.

- CNAME: 개념 이름. 한글 이름과 원어를 같이 준다. 예: 평균값 정리 (Mean Value Theorem)
- CLEVEL: 어디서 배우는 것인지 한 줄. 예: 대학 1학년 미적분학
- CPRE: 이 개념을 이해하는 데 필요한 고교 지식. 쉼표로 나열.
  학생이 "내가 아는 것에서 출발하는구나"를 느껴야 한다.
- CIDEA: 정의보다 직관이 먼저다. 수식 없이 일상어 한두 문장으로 핵심을 말한다.
  비유를 써도 좋다. 여기서 "아 그거구나"가 오게 만들어라.
- CDEF: 그 다음 정식 정의를 준다.
  · 정의에 나오는 기호를 하나도 빠짐없이 풀어 읽어준다.
  · 예: $f'(c)$ 에서 $c$ 는 "구간 안 어딘가에 있는 점"이고, 어디인지는 모른다는 뜻이다.
  · 조건절("~를 만족하는", "~에서 연속인")이 있으면 그 조건이 왜 붙었는지도 말한다.
- CFORM: 이 개념에서 실제로 쓰는 공식을 한 줄에 하나씩
  "공식|읽는 법과 각 기호가 무엇인지" 형식으로 적는다. 1개에서 4개.
  · 공식만 던지지 마라. 반드시 기호마다 무엇을 가리키는지 붙인다.
  · 예: $\\displaystyle\\sum_{n=0}^{\\infty} ar^n=\\dfrac{a}{1-r}$|$a$는 첫째항, $r$는 공비이고 $|r|<1$일 때만 쓸 수 있다
- CWHY: 왜 하필 이런 정의인가. 정의를 느슨하게 하면 무엇이 무너지는지 설명한다.
  정의를 외우는 게 아니라 납득하게 만드는 칸이다.
- CPROP: 이 개념의 성질을 한 줄에 하나씩 "성질|왜 그런지 또는 어디에 쓰는지" 형식으로.
  2개에서 5개. 성질을 나열만 하지 말고 반드시 이유나 쓰임을 붙인다.
- CCARE: 조건을 어겼을 때 무너지는 지점. 가능하면 구체적인 반례를 든다.
  예: 닫힌구간이 아니면 최댓값이 없을 수 있다 — $f(x)=x$ 를 열린구간 $(0,1)$ 에서 보면 그렇다.
- CEX: 아주 쉬운 예를 하나 골라 처음부터 끝까지 계산해 보인다.
  · 문제와 무관해도 좋다. 오히려 간단할수록 좋다.
  · 결과만 쓰지 마라. 공식에 무엇을 대입했고 그래서 무엇이 나왔는지 한 줄씩 보인다.
  · 학생이 종이에 따라 쓰면 똑같이 나와야 한다. 중간 단계를 건너뛰지 마라.

[용어 사전 — TERM]
설명 대상 용어와 기호를 TERM 칸에 한 줄에 하나씩 "용어|설명" 형식으로 모아 적는다.
- CONCEPT에서 이미 길게 설명한 개념도 여기에 한 줄 요약으로 다시 넣는다.
- 본문에서 스치듯 쓴 말도 고교 밖이면 전부 넣는다.
- 설명은 한 문장으로, 고등학생 말로 쓴다.
- 없으면 비워둔다.

[본문 — ADVBODY]
- CONCEPT에서 세운 도구를 실제로 이 문제에 적용한다.
- 새 개념을 여기서 처음 꺼내지 마라. 꺼내야 한다면 CONCEPT에 먼저 넣어라.
- 단계마다 "지금 무엇을 왜 하는지"를 한 줄씩 붙인다. 식만 늘어놓지 않는다.
- 고교 풀이에서 힘들었던 대목이 여기서 어떻게 가벼워지는지 짚어준다.

[연결 — ADVWHY]
고교 풀이와 이 풀이가 사실 같은 것을 보고 있음을 보여준다.
상위 도구가 무엇을 미리 보장해줘서 계산이 줄어드는지 설명한다.

[확장 — ADVMORE]
이 도구를 알면 또 어떤 유형이 풀리는지 한두 줄. 없으면 비워둔다.

상위 과정 도구를 억지로 끌어올 필요는 없다. 정말 자연스럽게 쓰이는 경우에만 쓰고,
마땅한 것이 없으면 ADVTITLE에 "없음"이라 적고 나머지 ADV 칸과 CONCEPT을 모두 비운다.
쓸 만한 도구의 예: 테일러 급수와 점근 전개, 로피탈의 정리의 엄밀한 조건,
평균값 정리와 롤의 정리, 입실론-델타, 급수의 수렴판정, 선형대수(행렬·고윳값),
미분방정식, 극좌표와 치환, 생성함수, 모듈러 산술, 볼록성과 옌센 부등식 등.

아래 형식 그대로 출력한다. JSON을 쓰지 마라. 백슬래시를 이스케이프하지 마라.
LaTeX는 평소 쓰는 그대로 적고, 수식은 반드시 달러 기호로 감싼다.

@@ADVTITLE
(상위 과정 접근법 이름. 예: 테일러 전개로 보기. 마땅한 것이 없으면 없음)
@@ADVGAP
(고교 풀이의 어느 대목이 답답한지, 이 도구가 그것을 어떻게 뚫는지. 2줄 이내)
@@CONCEPT
@@CNAME
(개념 이름. 한글 이름 (원어) 형식)
@@CLEVEL
(어디서 배우는지 한 줄)
@@CPRE
(필요한 고교 지식. 쉼표로 나열)
@@CIDEA
(수식 없는 직관 한두 문장)
@@CDEF
(정식 정의. 기호를 하나씩 풀어 읽어준다)
@@CFORM
(한 줄에 하나씩 "공식|읽는 법과 각 기호의 뜻")
@@CWHY
(왜 이런 정의인지. 조건을 빼면 무엇이 무너지는지)
@@CPROP
(한 줄에 하나씩 "성질|왜 그런지 또는 쓰임")
@@CCARE
(조건 위반 시 무너지는 지점. 가능하면 반례)
@@CEX
(아주 쉬운 예 하나를 끝까지 계산해 보인다. 중간 단계를 한 줄씩)
@@CONCEPT
...
@@TERM
(고교 밖 용어와 기호. 한 줄에 하나씩 "용어|한 문장 설명")
@@ADVBODY
(CONCEPT에서 세운 도구로 이 문제를 실제로 푸는 과정. 단계마다 이유를 붙인다. 여러 줄)
@@ADVWHY
(이 관점이 고교 풀이와 어떻게 연결되고 왜 더 강력한지. 2~3줄)
@@ADVMORE
(이 도구로 또 풀리는 유형. 없으면 비워둔다)
@@PLOT
(개념이나 풀이를 그림으로 보이면 좋을 때만. 형식은 아래 그림 규칙을 따른다)
@@END

[그림 규칙 — PLOT 칸]
개념이 그림으로 훨씬 잘 보이면 PLOT을 채운다. 아니면 비운다.
LaTeX가 아니다. 곱셈은 *, 거듭제곱은 ^, 분수는 (x+1)/2 처럼 쓴다.
  title: 제목
  xrange: -3, 5
  yrange: auto
  param: a | 0, 4 | 0.1 | 1
  ghost: on
  curve: x^2 - a*x | y=x^2-ax | brass
  point: 1, a | P | warn
  vline: a | x=a | dim
  hline: 0 | | dim
  segment: 0,0 -> 2,4 | AB
  polygon: 0,0 -> 4,0 -> 0,3 | 삼각형
  circle: 0,0 | 2 | 반지름 2 | cool
  shade: x^2 | 2*x | 0, 2 | 넓이
  label: 1.5, 3 | 교점
  note: 무엇을 관찰하면 되는지 한 줄
색은 brass, dim, warn, cool 중에서 고른다.

CONCEPT 블록은 1개에서 4개 사이로 쓴다.
마땅한 상위 도구가 없으면 ADVTITLE에 없음이라 적고 나머지를 모두 비운다.
CONCEPT과 TERM을 짧게 줄이려 하지 마라. 학생이 처음 듣는다는 전제를 끝까지 지켜라.`;

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
      // 상위 과정은 별도 호출로 뺐으므로 여기서는 예전처럼 가볍게 간다.
      const text = await callAnthropic(content, SOLVE_SYSTEM, 8000);
      json(res, 200, { text });
    } catch (e) {
      json(res, e.status || 500, { error: e.message || "풀이를 가져오지 못했습니다." });
    }
    return;
  }

  // 3단계 — 이미 푼 문제를 상위 교육과정 도구로 다시 설명한다 (요청이 있을 때만)
  if (req.url === "/api/advanced" && req.method === "POST") {
    try {
      const body = JSON.parse(await readBody(req));
      const problem = (body.text || "").trim();
      if (!problem) {
        json(res, 400, { error: "문제 내용이 없습니다." });
        return;
      }

      const content = [];
      if (body.image) {
        content.push({
          type: "image",
          source: { type: "base64", media_type: "image/jpeg", data: body.image },
        });
      }
      content.push({
        type: "text",
        text:
          `문제:\n${problem}\n\n` +
          (body.figureNote ? `[그림 설명] ${body.figureNote}\n\n` : "") +
          (body.topic ? `[단원] ${body.topic}\n` : "") +
          (body.answer ? `[이미 구한 답] ${body.answer}\n` : "") +
          `\n이 문제를 상위 교육과정 도구로 다시 설명해라.` +
          ` 쓰인 개념은 처음 듣는 학생 기준으로 기본부터 성질까지 빠짐없이 풀어써라.`,
      });

      const text = await callAnthropic(content, ADVANCED_SYSTEM, 12000);
      json(res, 200, { text });
    } catch (e) {
      json(res, e.status || 500, {
        error: e.message || "상위 과정 풀이를 가져오지 못했습니다.",
      });
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
