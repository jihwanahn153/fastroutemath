# 최단 풀이 (Fastest Route)

수학 문제를 **직접 입력하거나 사진으로 올리면**, 실전에서 가장 빠른 풀이 경로를
단계별로 보여주는 웹앱입니다. 정석 풀이가 아니라 "시험장에서 시간을 아끼는 길"을
찾아주는 것이 목적입니다.

- 문제 입력: 텍스트 · 사진 업로드 · 드래그앤드롭 · 클립보드 붙여넣기(Ctrl+V) · 모바일 카메라
- 결과: 핵심 관찰 한 줄 → 단계별 풀이(수식은 KaTeX 렌더) → 최종 답 → 자주 하는 실수 / 정석이 느린 이유
- 최근 푼 문제 20개는 브라우저에 자동 저장됩니다 (`localStorage`, 서버에는 남지 않음)

## 디자인

업로드해주신 호텔 로비 사진에서 가져왔습니다.

| 사진의 요소 | 화면에서의 역할 |
|---|---|
| 브론즈 플루티드 기둥열 | 좌우 고정 콜로네이드 (세로 홈·주두 표현) |
| 천장 타원형 오큘러스 | 시그니처 요소. 대기 시 `READY`, 풀이 중 링이 순차 점등, 완료 시 예상 소요 초 표시 |
| 중앙 대계단 | 풀이 단계. 한 단씩 안쪽으로 들여쓰며 아래로 내려감 |
| 조명 받는 트래버틴 계단참 | 최종 답이 놓이는 밝은 석재 단(landing) |
| 스카이라이트 채광 + 어두운 월넛 | 어두운 바탕에 따뜻한 빛이 고이는 배경 처리 |

팔레트: `#1a1410` 월넛 · `#7d6038` 브론즈 · `#c9a063` 브라스 · `#e8dfcc` 트래버틴 · `#f6e8c8` 조명

---

## 1. Render에 배포하기

이 저장소에는 `render.yaml`이 포함되어 있어 설정을 자동으로 읽어갑니다.

### 방법 A — Blueprint로 한 번에 (권장)

1. 이 폴더를 GitHub 저장소에 올립니다.
2. [dashboard.render.com](https://dashboard.render.com) → **New → Blueprint**
3. 저장소를 선택하면 `render.yaml`을 읽어 설정이 자동으로 채워집니다.
4. `ANTHROPIC_API_KEY` 값을 입력하라는 항목이 뜹니다. 발급받은 키를 넣습니다.
   (`sync: false`로 지정되어 있어 저장소에 키가 남지 않습니다)
5. **Apply** → 몇 분 뒤 `https://fastest-route-math.onrender.com` 형태의 주소가 생깁니다.

### 방법 B — 웹 서비스로 직접 생성

1. **New → Web Service** → 저장소 선택
2. 아래대로 입력합니다.
   - Runtime: `Node`
   - Build Command: `npm install && npm run build`
   - Start Command: `npm start`
   - Health Check Path: `/api/health`
3. **Environment** 탭에서 환경변수를 추가합니다.
   - `ANTHROPIC_API_KEY` = 발급받은 키
   - `ANTHROPIC_MODEL` = `claude-sonnet-4-6` (선택)
4. **Create Web Service**

> **Render 사용 시 알아둘 점**
> - 포트는 Render가 `PORT` 환경변수로 자동 주입하며, 서버가 이를 그대로 사용합니다.
>   직접 설정할 필요가 없습니다.
> - 무료 플랜은 15분간 요청이 없으면 잠들고, 다음 첫 요청이 깨우는 데 30초쯤 걸립니다.
>   학생들이 바로 쓰게 하려면 유료 플랜(Starter)을 쓰거나 외부에서 주기적으로
>   `/api/health`를 호출해 깨워두세요.
> - 사진 한 장 기준 응답까지 10~25초 정도 걸립니다. 무료 플랜에서도 타임아웃 문제는 없습니다.

---

## 2. 로컬에서 실행하기

```bash
npm install

cp .env.example .env
# .env 를 열어 ANTHROPIC_API_KEY 를 채웁니다

npm run build
npm start
```

`http://localhost:3000` 접속. 프론트를 고치면서 자동 재빌드하려면 `npm run dev`.

---

## 3. 폴더 구조

```
├── render.yaml          Render Blueprint 설정
├── server/index.js      정적 파일 서빙 + /api/solve (Anthropic API 프록시)
├── src/
│   ├── main.jsx         React 진입점
│   ├── App.jsx          입력 → 풀이 → 기록 화면 전체
│   └── styles.css       디자인 토큰과 전체 스타일
├── public/
│   ├── index.html
│   ├── vendor/katex/    수식 렌더링 (로컬 번들, CDN 불필요)
│   └── dist/            빌드 산출물 (npm run build 로 생성)
├── build.mjs            esbuild 빌드 스크립트
└── .env.example
```

API 키는 `server/index.js` 안에서만 쓰이고 브라우저로 내려가지 않습니다.

---

## 4. 손보고 싶을 때

- **풀이 스타일을 바꾸려면** `server/index.js`의 `SOLVE_SYSTEM` 프롬프트를 고칩니다.
  JSON 스키마는 그대로 두어야 화면이 깨지지 않습니다.
- **색을 바꾸려면** `src/styles.css` 맨 위 `:root`의 변수만 바꾸면 전체 톤이 따라옵니다.
- **사진 해상도/용량**은 `src/App.jsx`의 `MAX_DIM`(기본 1600px)으로 조절합니다.
  키우면 인식률이 오르지만 응답이 느려지고 비용이 늘어납니다.
- **기록 보관 개수**는 같은 파일의 `LEDGER_LIMIT`(기본 20개)입니다.

---

## 5. 운영 시 참고

- 이 앱은 로그인이 없어서 주소를 아는 사람은 누구나 쓸 수 있고, 호출량만큼 API 비용이
  나갑니다. 학원이나 반 단위로 공개하실 거라면 간단한 비밀번호나 호출 횟수 제한을
  붙이시는 걸 권합니다.
- 답이 항상 맞다고 보장할 수 없습니다. 화면 하단에도 안내가 있지만, 학생에게 배포할 때
  "채점 기준이 아니라 접근법 참고용"이라고 함께 알려주세요.
