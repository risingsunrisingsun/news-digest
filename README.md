# 고등교육 뉴스 주간 다이제스트

국내 고등교육 전문지 RSS 를 수집해 Claude 로 요약하고, **본인 검토를 거쳐** 텔레그램
채널에 주 1회 게시한다. 초안은 DM 으로 오고, 기사별로 의견을 달 수 있으며,
승인하기 전까지 채널에는 아무것도 올라가지 않는다.

## 구성

| 파일 | 역할 |
| --- | --- |
| `config.json` | 피드 목록, 키워드, 기간, 기사 수, 모델 |
| `digest.ts` | 수집 · 요약 · 검토 DM · 명령 처리 · 게시 |
| `run.ps1` | 로컬 폴백용 Task Scheduler 래퍼 (bun/claude 경로 해결 + 로깅) |
| `.github/workflows/collect.yml` | 3시간마다 RSS 수집 |
| `.github/workflows/poll.yml` | 월요일 창 30분 간격, 검토 DM · 명령 처리 |
| `.github/push-state.sh` | 상태 파일 커밋 + push 재시도 (세 실행 주체가 공용) |
| `.env` | 봇 토큰, 채널 ID, 관리자 ID — **로컬 전용.** 커밋 금지. 클라우드에서는 GitHub Secrets 가 대신한다 |
| `archive.json` | 수집한 기사 누적 보관 (기본 30일) |
| `pending.json` | 승인 대기 중인 이번 주 초안 — 게시하면 삭제된다 |
| `state.json` | 게시 완료 링크, 마지막 처리한 텔레그램 update ID |

## 동작 흐름

2026-09-14 부터 **클라우드에서 돈다.** 노트북 전원과 무관하게 실행된다.

```
[3시간마다]        GitHub Actions  --collect            RSS → archive.json → commit
[월 07:00 KST]     Claude 루틴     --candidates         수집 + 후보 133건 추출
                                   (에이전트가 직접 요약)
                                   --summaries          → pending.json (dmSent:false) → push
[월 08:00 KST~]    GitHub Actions  --poll               dmSent:false 를 보고 검토 DM 발송
[~화 08:00 KST]                    30분 간격             DM 명령 수신 → 의견 / 제외 / 게시
                                                        └─ "게시" 를 받았을 때만 채널에 올라간다
```

세 상태 파일(`archive.json`, `state.json`, `pending.json`)이 **저장소에 커밋된다.**
클라우드 에이전트는 매 실행마다 빈 샌드박스에 clone 만 해서 시작하므로, 이 파일들이
저장소에 없으면 수집분도 게시 이력도 실행 간에 이어지지 않는다.

### 왜 요약만 Claude 루틴인가

봇 토큰이 **GitHub Secrets 한 곳에만** 있게 하려는 것이다. Claude 루틴은 텔레그램을
전혀 건드리지 않고 `pending.json` 만 만들어 push 한다. 검토 DM·명령 수신·채널 게시는
전부 Actions 가 한다. 대신 검토 DM 이 초안 생성 직후가 아니라 **다음 폴링 때(최대 30분 뒤)**
도착한다.

`dmSent` 플래그가 이 인계를 담당한다. 로컬 실행(`run.ps1`)은 자기가 DM 을 보내므로
`dmSent: true` 로 쓰고, 클라우드 경로는 `false` 로 써서 폴링에게 넘긴다.

`flushPendingUpdates()` 는 **검토 DM 을 보내기 직전**에 돈다. 초안을 만드는 시점이
아니라 DM 시점에 큐를 비워야, 지난주에 보낸 `게시` 가 이번 주 초안에 적용되어
검토 없이 발행되는 사고를 막는다.

### 로컬 실행도 그대로 남아 있다

`run.ps1` 과 Task Scheduler 작업 3개는 지우지 않았다. 클라우드가 멈췄을 때
`.\run.ps1` 한 줄로 초안을 만들고 `.\run.ps1 -Poll` 로 승인할 수 있다. 이 경로는
`claude -p` 를 호출하므로 CLI 인증이 살아 있어야 한다.

> 같은 주에 로컬과 클라우드를 **동시에 돌리지 말 것.** 둘 다 `getUpdates` 를 호출해
> 명령을 서로 뺏어가고, `state.json` 이 갈라진다.

로컬 Task Scheduler 작업의 설계 메모는 아래 "자동 실행 등록" 에 남겨 뒀다.
폴링 창을 24시간으로 잡은 이유(저녁이나 다음 날 아침에 검토하는 경우가 많다),
`pending.json` 이 없으면 `run.ps1` 이 bun 을 띄우기 전에 끝내는 이유는 클라우드
쪽에도 그대로 옮겼다 — `poll.yml` 의 cron 두 줄과 `gate` 스텝이 각각에 대응한다.

> **2026-09-14 에 겪은 사고.** 세 작업 모두 `DisallowStartIfOnBatteries` 가 켜져
> 있었다(PowerShell 기본값). 배터리로 돌아가는 동안 스케줄러가 실행을 거부하는데
> (`0x800710E0`), Collect·Draft 는 `-StartWhenAvailable` 로 나중에 따라잡지만
> Poll 은 의도적으로 그걸 꺼 둬서 **거부된 실행분이 그냥 버려졌다.** 그 결과 9월 1일
> 이후 폴링이 한 번도 돌지 않아, DM 으로 보낸 `게시` 에 봇이 아무 반응을 하지
> 않았다. 아래 등록 스크립트는 이 조건을 꺼 둔 상태다. 클라우드로 옮긴 직접적인
> 계기이기도 하다.

### 왜 수집과 게시를 분리하는가

각 피드는 **최근 50건만** 노출한다. 실측한 커버 기간:

| 매체 | 50건이 커버하는 기간 |
| --- | --- |
| 교수신문 | 약 4일 |
| 한국대학신문 | 약 1일 |
| 베리타스알파 | **약 2.4시간** |

주 1회만 긁으면 한 주치 기사의 대부분이 이미 피드에서 밀려나 있다. 그래서
수집은 자주(HTTP 요청만, LLM 호출 없음) 돌려 `archive.json` 에 쌓고,
게시는 주 1회 아카이브를 대상으로 수행한다.

덧붙여, 이 피드들은 **매번 같은 50건을 주지 않는다.** 한 번의 수집에서 교수신문 33건,
베리타스알파 50건이 새로 들어온 사례가 있다. 위 표의 "커버 기간" 은 한 스냅샷 기준이고
실제로는 자주 긁을수록 더 많은 기사를 확보한다. 수집 주기를 늘리면 그만큼 놓친다.

> 클라우드로 옮기면서 수집 주기를 **3시간**으로 되돌렸다 (`collect.yml`). 로컬
> Task Scheduler 시절에는 하루 2회였고, PC 가 꺼져 있으면 그마저도 건너뛰었다.
> 베리타스알파(커버 약 2.4시간)는 3시간 주기로도 일부 놓치지만, 하루 2회보다는
> 훨씬 낫다. 더 촘촘히 하려면 `collect.yml` 의 cron 을 `*/30 * * * *` 로 바꾼다 —
> 대신 `archive.json` 커밋이 하루 48건 쌓인다.

## 검토 DM 명령

초안 DM 을 받은 뒤 봇에게 답장으로 보낸다.

| 입력 | 동작 |
| --- | --- |
| `3 이 정책은 현장과 괴리가 있다` | 3번 기사에 내 의견 추가 (`3.` `3:` 도 가능, 여러 줄 가능) |
| `삭제 5` | 5번 기사를 초안에서 제외 |
| `복구 5` | 제외한 5번을 되살림 |
| `목록` | 현재 초안 상태 다시 보기 |
| `게시` | 채널에 올린다 |
| `취소` | 이번 주 초안 폐기 |

의견을 단 기사는 채널에서 요약문 아래에 `💬` 로 함께 나간다.

`TELEGRAM_ADMIN_ID` 와 일치하는 발신자의 메시지만 명령으로 처리한다. 다른 사람이
봇에게 `게시` 라고 보내도 무시된다.

승인하지 않은 채 다음 주가 되면 초안은 새 초안으로 교체된다. 게시되지 않은 기사는
`state.json` 에 기록되지 않으므로 `lookbackDays` 안에 있는 한 다음 후보에 다시 오른다.

## 로컬 설정

**1. 봇을 채널 관리자로 추가**

단순 초대로는 게시할 수 없다. 채널 설정 → 관리자 → 봇 추가 → **메시지 게시** 권한 부여.

**2. `.env` 작성** (로컬 전용 — 클라우드는 GitHub Secrets 를 쓴다)

```powershell
copy .env.example .env
```

`TELEGRAM_BOT_TOKEN` 과 `TELEGRAM_CHANNEL_ID` 를 채운다. 공개 채널이면 `@채널이름`,
비공개 채널이면 `-100...` 숫자 ID (@RawDataBot 을 채널에 잠깐 초대하면 확인 가능).

**3. 관리자 ID 확인**

봇에게 아무 DM 이나 보낸 뒤:

```powershell
.\run.ps1 -WhoAmI
```

출력된 숫자를 `.env` 의 `TELEGRAM_ADMIN_ID` 에 넣는다.

**4. 연결 확인**

```powershell
.\run.ps1 -Check
```

봇·채널 정보가 출력되고 확인용 DM 이 도착하면 정상. `chat not found` 가 나오면
채널 ID 가 틀렸거나 봇이 관리자가 아니다.

**5. 발송 없이 내용만 확인**

```powershell
.\run.ps1 -DryRun
```

수집·요약까지 수행하고 검토 DM 과 채널 게시본을 콘솔에만 출력한다. DM 도 가지 않고
`pending.json` 도 만들지 않으므로 몇 번이든 반복해도 안전하다.

**6. 실제 초안 발송**

```powershell
.\run.ps1          # 초안 생성 + 검토 DM
.\run.ps1 -Poll    # DM 에 답장한 뒤 실행하면 명령이 처리된다
```

## 클라우드 설정

로컬 설정(위 `.env`)과 **별개로** 한 번만 해 두면 된다.

**1. GitHub Secrets 3개**

저장소 → Settings → Secrets and variables → Actions → New repository secret.
`.env` 와 같은 값을 그대로 넣는다.

| 이름 | 값 |
| --- | --- |
| `TELEGRAM_BOT_TOKEN` | BotFather 토큰 |
| `TELEGRAM_CHANNEL_ID` | `@daehaknews` |
| `TELEGRAM_ADMIN_ID` | 본인 숫자 ID |

저장소가 공개여도 Secrets 는 노출되지 않는다. 다만 **fork 에서 온 PR 의 워크플로에는
Secrets 가 주입되지 않으므로**, 외부 기여가 이 봇으로 게시할 수는 없다.

**2. Actions 쓰기 권한**

Settings → Actions → General → Workflow permissions →
**Read and write permissions**. 이게 없으면 `push-state.sh` 가 403 으로 실패한다.

**3. Claude 루틴**

`/schedule` 로 만든다. 주 1회 요약만 담당하며 텔레그램은 건드리지 않는다.
`cron: 0 22 * * 0` (= 월 07:00 KST), 저장소를 source 로 연결한다.

## 클라우드가 멈췄는지 보는 법

| 증상 | 볼 곳 |
| --- | --- |
| 기사가 안 쌓인다 | 저장소 Actions 탭 → collect 워크플로 |
| 월요일에 초안 DM 이 안 온다 | claude.ai/code/routines → 해당 루틴의 실행 기록 |
| 초안은 왔는데 명령에 반응이 없다 | Actions 탭 → poll 워크플로 |
| 셋 다 멀쩡한데 조용하다 | `pending.json` 이 저장소에 있는지, `dmSent` 가 뭔지 확인 |

> GitHub 은 **60일간 커밋이 없는 저장소의 예약 워크플로를 자동으로 끈다.** 여기는
> 3시간마다 커밋이 생기므로 해당되지 않지만, 수집을 멈춰 두면 걸릴 수 있다.
>
> 예약 실행은 러너가 붐비면 **5~20분 늦게** 뜨는 일이 흔하다. 07:00 초안, 08:00 첫
> 폴링이라는 시각은 정확한 약속이 아니라 대략의 목표로 보는 게 맞다.

## 창이 뜨는 게 거슬릴 때

작업은 `-WindowStyle Hidden` 으로 등록돼 있어 콘솔이 잠깐 깜빡인다. 완전히 없애려면
작업 주체를 S4U(로그온 여부와 무관하게 실행)로 바꿔야 하는데, 이건 **관리자 권한이
필요**하다. 관리자 PowerShell 에서:

```powershell
$p = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType S4U -RunLevel Limited
'HigherEd-News-Collect','HigherEd-News-Draft','HigherEd-News-Poll' | ForEach-Object {
  Set-ScheduledTask -TaskName $_ -Principal $p
}
```

> `wscript.exe` 로 VBS 래퍼를 띄워 숨기는 방법은 이 환경에서 동작하지 않았다.
> 직접 실행하면 되지만 Task Scheduler 경유로는 아무것도 실행되지 않는다
> (스크립트 호스트가 차단된 것으로 보인다). 시도하지 말 것.

## 자동 실행 등록 (작업 3개)

```powershell
$dir = 'C:\Users\hufs\rasun\news-digest'
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable `
  -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -ExecutionTimeLimit (New-TimeSpan -Hours 1) -MultipleInstances IgnoreNew
function New-DigestAction([string]$extra) {
  New-ScheduledTaskAction -Execute 'powershell.exe' `
    -Argument ("-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$dir\run.ps1`" $extra").Trim()
}

# 수집 — 매일 06:00, 18:00.
Register-ScheduledTask -TaskName 'HigherEd-News-Collect' -Settings $settings -Force `
  -Action (New-DigestAction '-Collect') `
  -Trigger @((New-ScheduledTaskTrigger -Daily -At 6:00AM),
             (New-ScheduledTaskTrigger -Daily -At 6:00PM)) `
  -Description '고등교육 뉴스 RSS 수집'

# 초안 — 매주 월요일 08:00. 검토 DM 이 온다.
Register-ScheduledTask -TaskName 'HigherEd-News-Draft' -Settings $settings -Force `
  -Action (New-DigestAction '') `
  -Trigger (New-ScheduledTaskTrigger -Weekly -DaysOfWeek Monday -At 8:00AM) `
  -Description '고등교육 뉴스 주간 초안 생성 및 검토 DM'

# 명령 수신 — 월요일 08:00 부터 24시간 동안 30분 간격.
# 주간 트리거에는 -RepetitionInterval 을 직접 못 주므로 Repetition 을 옮겨 붙인다.
# 이 작업만 -StartWhenAvailable 을 뺀다 (위 "동작 흐름" 의 설명 참고).
$pollSettings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -ExecutionTimeLimit (New-TimeSpan -Hours 1) -MultipleInstances IgnoreNew
$pollTrigger = New-ScheduledTaskTrigger -Weekly -DaysOfWeek Monday -At 8:00AM
$pollTrigger.Repetition = (New-ScheduledTaskTrigger -Once -At (Get-Date).Date `
  -RepetitionInterval (New-TimeSpan -Minutes 30) -RepetitionDuration (New-TimeSpan -Hours 24)).Repetition
Register-ScheduledTask -TaskName 'HigherEd-News-Poll' -Settings $pollSettings -Force `
  -Action (New-DigestAction '-Poll') -Trigger $pollTrigger `
  -Description '고등교육 뉴스 검토 DM 명령 처리'
```

수집 주기를 3시간마다로 되돌리려면 Collect 의 트리거를 이렇게 바꾼다:

```powershell
$t = New-ScheduledTaskTrigger -Once -At (Get-Date).Date `
       -RepetitionInterval (New-TimeSpan -Hours 3) -RepetitionDuration (New-TimeSpan -Days 3650)
Set-ScheduledTask -TaskName 'HigherEd-News-Collect' -Trigger $t
```

`-StartWhenAvailable` 은 지정 시각에 PC 가 꺼져 있었다면 켜진 뒤 실행한다 (Poll 은 예외 —
위 참고). PC 가 오래 꺼져 있으면 그 사이 기사는 놓친다 — 항상 켜두지 않는 환경이면 수집
주기를 더 짧게 잡거나 상시 구동되는 서버로 옮기는 편이 낫다. 텔레그램은 수신 메시지를
24시간만 보관하므로, DM 명령을 보낸 뒤 하루 넘게 PC 가 꺼져 있으면 그 명령은 유실된다.

관리:

```powershell
Get-ScheduledTask -TaskName 'HigherEd-News-*'                # 상태 확인
Start-ScheduledTask -TaskName 'HigherEd-News-Draft'          # 즉시 초안 생성
Get-ScheduledTask -TaskName 'HigherEd-News-*' | Unregister-ScheduledTask   # 전체 삭제
```

작업 정의 백업본은 `task-backup/` 에 있다 (`Register-ScheduledTask -Xml` 로 복원).

실행 기록은 모드별로 나뉜다: `run-collect.log`, `run-draft.log`, `run-poll.log`.

## 조정

- **결과가 너무 적다** → `config.json` 의 `keywords` 를 넓히거나 `lookbackDays` 를 늘린다
- **기사 수를 바꾸고 싶다** → `maxArticlesInDigest` (현재 15)
- **관련 없는 기사가 섞인다** → `digest.ts` 의 `buildInstruction()` 선별 기준을 조인다
- **요약 품질을 높이고 싶다** → `config.json` 의 `model` 을 `opus` 로 (느리고 비싸다)
- **매체를 추가하고 싶다** → `feeds` 에 추가. 대부분의 국내 언론 CMS 가
  `/rss/allArticle.xml` 규약을 쓰므로 먼저 브라우저로 열어 200 이 뜨는지 확인한다
- **같은 기사가 또 올라온다** → `state.json` 이 지워졌는지 확인

## 주의

- `.env` 에 봇 토큰이 평문으로 있다. 토큰을 가진 사람은 누구나 채널에 게시할 수 있다.
- 요약은 RSS 의 제목·요약문만 근거로 하며 원문 전체를 읽지 않는다. 검토 DM 에서
  링크를 열어 확인한 뒤 게시하는 것을 전제로 만들었다.
- 봇은 `getUpdates` 로 메시지를 받는다. 같은 봇 토큰으로 webhook 을 설정하거나 다른
  프로그램이 동시에 `getUpdates` 를 호출하면 명령을 서로 뺏어간다.
- 실패하면 관리자 DM 으로 `⚠️ ... 실패` 알림이 간다 (`notifyFailure()`). 같은 오류
  메시지는 6시간에 한 번만 보낸다 — Poll 이 30분마다 도는 동안 네트워크가 죽어 있으면
  DM 이 수십 통 쌓이기 때문이다. 마지막 알림은 `state.json` 의 `lastError`,
  `lastErrorAt` 에 남는다.
- `claude` CLI 인증이 만료되면 요약 단계가 `exit 1` 로 죽는다 (2026-08-19, 08-31 사례).
  실패 사유는 stderr 가 아니라 **stdout** 으로 나오므로 `digest.ts` 는 둘 다 로그에 남긴다.
