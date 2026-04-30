# AjouLLM CLI

Mindlogic Gateway 모델을 터미널에서 사용하는 Node.js CLI입니다. 일반 채팅, fullscreen TUI, 프로젝트 컨텍스트 검색, 계획 생성, 간단한 에이전트식 파일 수정을 지원합니다.

## 요구 사항

- Node.js 18.17 이상
- Mindlogic Gateway API key

## 설치

```powershell
npm.cmd install
```

전역 명령으로 쓰려면:

```powershell
npm.cmd link
ajoullm
```

전역 링크 없이 Windows에서 바로 실행하려면 `.\ajoullm.cmd`를 사용합니다.

## 빠른 시작

```powershell
.\ajoullm.cmd config init
$env:AJOULLM_API_KEY="YOUR_API_KEY"
.\ajoullm.cmd config set model gpt-5-nano
.\ajoullm.cmd
```

API key를 프로젝트 설정 파일에 저장할 수도 있습니다.

```powershell
.\ajoullm.cmd config set apiKey YOUR_API_KEY
```

공용 PC나 장기 사용 환경에서는 `.ajoullmrc.json`에 저장하기보다 `AJOULLM_API_KEY` 환경 변수를 권장합니다.

## 기본 사용법

```powershell
.\ajoullm.cmd
.\ajoullm.cmd "hello"
.\ajoullm.cmd chat "hello"
Get-Content .\notes.txt | .\ajoullm.cmd
node .\bin\ajoullm.js "hello"
```

프롬프트 없이 실행하면 TUI가 열립니다. 프롬프트를 인자로 넘기거나 stdin으로 전달하면 한 번만 응답하고 종료합니다.

채팅 옵션:

```powershell
.\ajoullm.cmd chat --model gpt-5-mini "요약해줘"
.\ajoullm.cmd chat --system "한국어로 짧게 답해" "hello"
.\ajoullm.cmd chat --stream "streaming response"
.\ajoullm.cmd chat --no-stream "non-streaming response"
.\ajoullm.cmd chat --temperature 0.3 --top-p 1 --max-tokens 4096 "질문"
```

모든 주요 모델 응답 요청은 답변 전에 내부검토 단계를 거칩니다. 내부검토는 항상 `gpt-5.4-nano` 모델로 실행되며, 코드 작업은 파일/프로젝트 근거를 우선 확인하고 일반 질문은 불확실한 사실을 점검한 뒤 선택한 모델이 최종 답변만 출력합니다. 이 구조는 요청당 API 호출이 1회 이상 추가되므로 응답 시간과 사용량이 늘어날 수 있습니다.

## TUI

```powershell
.\ajoullm.cmd
.\ajoullm.cmd interactive
```

주요 키:

- `Enter`: 현재 입력 제출
- `Ctrl+N` 또는 `Shift+Enter`: 줄바꿈 입력
- `Up` / `Down`: 이전 입력 탐색
- `PageUp` / `PageDown`: 로그 스크롤
- `Tab`: slash command 또는 `@file` 자동완성
- `Esc`: 입력 지우기, 실행 중에는 중단
- `Ctrl+C`: 종료

TUI 명령:

```text
/help
/mode chat|context|plan|edit|agent
/apikey <key>
/model <name>
/system <text>
/stream on|off
/init
/compact
/undo
/export [file]
/credits
/models
/status
/clear
/exit
```

모드:

- `chat`: 일반 대화 모드
- `context`: 작업 설명과 관련 있는 파일 목록 출력
- `plan`: 관련 파일을 바탕으로 변경 계획 생성
- `edit`: 모델이 full-file edit JSON을 반환하고 CLI가 파일에 적용
- `agent`: 모델 tool calling으로 파일 읽기/쓰기/검색/명령 실행을 수행하며, 쓰기와 명령 실행 전 권한 확인

`@path/to/file` 형식으로 입력하면 해당 파일 내용을 프롬프트에 첨부합니다. `/init`은 프로젝트를 스캔해서 `ajoullm.md` 지침 파일을 생성합니다. TUI는 최근 세션을 `.ajoullm/tui-session.json`에 저장하며 7일 이내 세션을 복원합니다.

## 설정

```powershell
.\ajoullm.cmd config init
.\ajoullm.cmd config show
.\ajoullm.cmd config path
.\ajoullm.cmd config set apiKey YOUR_API_KEY
.\ajoullm.cmd config set model gpt-5-nano
.\ajoullm.cmd config set baseUrl https://factchat-cloud.mindlogic.ai/v1/gateway
.\ajoullm.cmd config set systemPrompt "Answer in Korean."
.\ajoullm.cmd config set temperature 0.3
.\ajoullm.cmd config set topP 1
.\ajoullm.cmd config set maxTokens 2048
.\ajoullm.cmd config set stream false
.\ajoullm.cmd config unset systemPrompt
.\ajoullm.cmd config reset
```

지원하는 설정 키:

- `apiKey`
- `model`
- `baseUrl`
- `systemPrompt`
- `temperature`
- `topP`
- `maxTokens`
- `stream`

설정 우선순위:

1. 환경 변수
2. 현재 디렉터리의 `.ajoullmrc.json`
3. 코드의 기본값

환경 변수:

- `AJOULLM_API_KEY`
- `AJOULLM_MODEL`
- `AJOULLM_BASE_URL`
- `AJOULLM_SYSTEM_PROMPT`
- `AJOULLM_TEMPERATURE`
- `AJOULLM_TOP_P`
- `AJOULLM_MAX_TOKENS`
- `AJOULLM_STREAM`
- `AJOULLM_REVIEW_FALLBACK`
- `AJOULLM_REQUEST_TIMEOUT_MS`

`AJOULLM_REVIEW_FALLBACK=true`로 설정하면 내부검토 모델 호출이 실패해도 보수적인 최종 답변 생성을 계속 시도합니다. 기본값은 실패 중단입니다.
`AJOULLM_REQUEST_TIMEOUT_MS`는 API 요청 타임아웃을 밀리초 단위로 설정합니다. 기본값은 `120000`입니다.

TUI에서는 `/status`와 오른쪽 상태 패널에서 최종 응답 모델, 내부검토 모델, 내부검토 실패 폴백 여부를 확인할 수 있습니다.

## 프로젝트 컨텍스트

```powershell
.\ajoullm.cmd code scan
.\ajoullm.cmd code context "fix login redirect bug"
.\ajoullm.cmd code plan "fix login redirect bug"
.\ajoullm.cmd code cache show
.\ajoullm.cmd code cache clear
```

- `code scan`: 텍스트 파일을 인덱싱하고 `.ajoullm/project-context.json` 생성
- `code context`: 작업 설명과 관련 있는 파일을 점수순으로 출력
- `code plan`: API key가 있으면 모델 기반 계획, 없으면 오프라인 계획 출력
- `code cache show`: 현재 인덱스 JSON 출력
- `code cache clear`: 프로젝트 컨텍스트 캐시 삭제

## 에이전트 명령

```powershell
.\ajoullm.cmd agent --plan "fix login redirect bug"
.\ajoullm.cmd agent --apply "fix login redirect bug"
.\ajoullm.cmd agent --apply --dry-run "refactor config loading"
.\ajoullm.cmd agent --apply --verify "npm.cmd test" "fix failing tests"
.\ajoullm.cmd agent --resume
```

- `--plan`: 관련 파일을 찾고 변경 계획을 생성한 뒤 `.ajoullm/agent-session.json`에 저장
- `--apply`: 모델이 반환한 full-file edit JSON을 실제 파일에 씀
- `--dry-run`: 쓸 파일 목록만 출력하고 파일은 변경하지 않음
- `--verify <command>`: 변경 후 검증 명령 실행
- `--resume`: 마지막 agent session 요약 출력

제약 사항:

- CLI `agent --apply`는 모델이 반환한 전체 파일 내용을 그대로 씁니다.
- 자동 수정 재시도는 TUI `edit` 모드에만 있습니다.
- `--apply`에는 API key가 필요합니다.

## 모델과 크레딧

```powershell
.\ajoullm.cmd models
.\ajoullm.cmd credits
```

- `models`: Gateway `/models/` 응답에서 모델 ID를 출력
- `credits`: 크레딧 API 응답 JSON 출력

## 생성/사용 파일

- `.ajoullmrc.json`: 프로젝트 로컬 설정
- `.ajoullm/project-context.json`: 프로젝트 컨텍스트 인덱스
- `.ajoullm/agent-session.json`: 마지막 CLI agent session
- `.ajoullm/tui-session.json`: 마지막 TUI 대화/입력 기록
- `ajoullm.md`: `/init`이 생성하는 프로젝트 지침 파일

## API 기본값

- 기본 base URL: `https://factchat-cloud.mindlogic.ai/v1/gateway`
- 기본 모델: `gpt-5-nano`
- 기본 temperature: `0.3`
- 기본 request timeout: `120000ms`
- 채팅 엔드포인트: `POST /chat/completions/`
- 모델 목록 엔드포인트: `GET /models/`

## 검증

```powershell
npm.cmd run check
```

`check`는 JavaScript 문법 검사와 TUI 줄바꿈 smoke test를 실행합니다.
