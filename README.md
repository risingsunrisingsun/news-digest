# 고등교육 뉴스 주간 다이제스트

국내 고등교육 전문지 RSS 를 수집해 Claude 로 요약하고, **본인 검토를 거쳐** 텔레그램
채널에 주 1회 게시한다. 초안이 나오면 텔레그램으로 알림이 오고, 검토·수정은
**Claude 앱에서 루틴 세션과 대화로** 한다. 세션에서 "게시" 라고 하기 전까지 채널에는
아무것도 올라가지 않는다.

## 구성

| 파일 | 역할 |
| --- | --- |
| `config.json` | 피드 목록, 키워드, 기간, 기사 수, 모델 |
| `digest.ts` | 수집 · 요약 · 알림 DM · 게시 (+ 로컬 폴백용 DM 명령 처리) |
| `run.ps1` | 로컬 폴백용 Task Scheduler 래퍼 (bun/claude 경로 해결 + 로깅) |
| `.github/workflows/collect.yml` | 3시간마다 RSS 수집 |
| `.github/workflows/review.yml` | `pending.json` push 시 즉시 실행 — 알림 DM 또는 승인분 게시 |
| `.github/push-state.sh` | 상태 파일 커밋 + push 재시도 (세 실행 주체가 공용) |
| `.env` | 봇 토큰, 채널 ID, 관리자 ID — **로컬 전용.** 커밋 금지. 클라우드에서는 GitHub Secrets 가 대신한다 |
| `archive.json` | 수집한 기사 누적 보관 (기본 30일) |
| `pending.json` | 승인 대기 중인 이번 주 초안 — 게시하면 삭제된다 |
| `state.json` | 게시 완료 링크, 마지막 처리한 텔레그램 update ID |

## 동작 흐름

2026-09-14 부터 **클라우드에서 돈다.** 노트북 전원과 무관하게 실행된다.

```
[3시간마다]        GitHub Actions  --collect            RSS → archive.json → commit
[월 07:07 KST]     Claude 루틴     --candidates         후보 추출
                                   (에이전트가 직접 요약)
                                   --summaries          → pending.json (dmSent:false) → push
                                   초안 전체를 세션에 출력
[push 직후]        GitHub Actions  --sync (review.yml)  알림 DM: 제목 목록 + 세션 링크
[아무 때나]        Claude 앱       루틴 세션에서 대화   "3번 의견: …", "5번 빼", "2번 요약 짧게"
                                                        → 세션이 pending.json 고쳐 push
                                   "게시"               → approved:true 로 push
[push 직후]        GitHub Actions  --sync (review.yml)  approved 를 보고 채널 게시, pending.json 삭제
```

### 왜 텔레그램 DM 명령을 걷어냈나 (2026-10-12)

예전에는 `poll.yml` 이 월요일 창에서 30분마다 `getUpdates` 로 DM 명령을 가져갔다.
그런데 **GitHub 의 예약(cron) 실행은 붐비면 그냥 건너뛴다.** 실측해 보니 창 하나에
예정된 48회 중 4~6회만 돌았고 실행 사이 공백이 7~9시간이었다. 10-12 에는 08:26 에
보낸 검토 DM 에 대한 `게시` 가 11:07 에야 처리됐다. 봇이 느린 게 아니라 봇을 깨울
실행이 없었던 것이다.

push 이벤트로 도는 워크플로는 건너뛰지 않는다. 그래서 폴링을 없애고, 루틴 세션이
`pending.json` 을 push 하는 순간 `review.yml` 이 돌게 바꿨다. 수정은 대화라 즉시,
게시는 push 후 1분 안팎이다. 덤으로 요약문 자체도 자연어로 고칠 수 있다.

> **수집도 같은 문제를 겪는다.** `collect.yml` 의 3시간 cron 은 실제로 7~9시간
> 간격으로 돈다 (하루 8회 중 약 3회). 베리타스알파 누락이 크다. 아직 미해결.

세 상태 파일(`archive.json`, `state.json`, `pending.json`)이 **저장소에 커밋된다.**
클라우드 에이전트는 매 실행마다 빈 샌드박스에 clone 만 해서 시작하므로, 이 파일들이
저장소에 없으면 수집분도 게시 이력도 실행 간에 이어지지 않는다.

### 왜 요약만 Claude 루틴인가

봇 토큰이 **GitHub Secrets 한 곳에만** 있게 하려는 것이다. Claude 루틴(과 그 세션에서
이어지는 검토 대화)은 텔레그램을 전혀 건드리지 않고 `pending.json` 만 고쳐 push 한다.
알림 DM·채널 게시는 전부 Actions 가 한다.

인계는 `pending.json` 의 두 플래그가 맡는다.

| 플래그 | 쓰는 쪽 | `--sync` 가 하는 일 |
| --- | --- | --- |
| `dmSent: false` | 루틴 (`--summaries`) | 알림 DM 발송 후 `true` 로 바꿈 |
| `approved: true` | 세션 (사용자가 "게시" 라고 했을 때만) | 채널 게시, `state.json` 기록, `pending.json` 삭제 |

둘 다 아니면 수정 중이라 아무것도 안 한다. 루틴 프롬프트에 "사용자가 세션에서
직접 말하기 전에는 `approved` 를 쓰지 마라" 를 못박아 뒀다. 로컬 실행(`run.ps1`)은
자기가 DM 을 보내므로 `dmSent: true` 로 쓴다.

`review.yml` 이 커밋하는 push 는 `GITHUB_TOKEN` 으로 나가서 자기 자신을 다시 부르지
않는다. `collect` 와 concurrency 그룹을 나눈 이유는 워크플로 파일 주석 참고.

### 로컬 실행은 폴백으로 남겨 두고 꺼 놨다

Task Scheduler 작업 3개는 지우지 않고 **비활성화**만 했다. 같은 주에 로컬과
클라우드가 같이 돌면 둘 다 `getUpdates` 를 호출해 명령을 서로 뺏어가고
`state.json` 이 갈라지기 때문이다.

클라우드가 멈췄을 때 되살리려면:

```powershell
Enable-ScheduledTask -TaskName 'HigherEd-News-Draft'   # 필요한 것만
.\run.ps1          # 또는 그냥 수동 실행
.\run.ps1 -Poll
```

되살리기 전에 **저장소에서 최신 상태를 먼저 받아야 한다** (`git pull`). 안 그러면
클라우드가 쌓은 `archive.json`·`state.json` 을 묵은 로컬본으로 덮어쓴다.
로컬 경로는 `claude -p` 를 호출하므로 CLI 인증도 살아 있어야 한다.

로컬 Task Scheduler 작업의 설계 메모는 아래 "자동 실행 등록" 에 남겨 뒀다.
로컬 폴백은 예전 텔레그램 DM 검토 방식 그대로다 (Claude 앱 검토 경로는 클라우드 전용).
되살리는 동안 클라우드 루틴은 꺼 둬야 초안이 두 갈래로 갈라지지 않는다.

> **2026-09-14 에 겪은 사고.** 세 작업 모두 `DisallowStartIfOnBatteries` 가 켜져
> 있었다(PowerShell 기본값). 배터리로 돌아가는 동안 스케줄러가 실행을 거부하는데
> (`0x800710E0`), Collect·Draft 는 `-StartWhenAvailable` 로 나중에 따라잡지만
> Poll 은 의도적으로 그걸 꺼 둬서 **거부된 실행분이 그냥 버려졌다.** 그 결과 9월 1일
> 이후 폴링이 한 번도 돌지 않아, DM 으로 보낸 `게시` 에 봇이 아무 반응을 하지
> 않았다. 아래 등록 스크립트는 이 조건을 꺼 둔 상태다. 클라우드로 옮긴 직접적인
> 계기이기도 하다.


### 클라우드 샌드박스에서는 RSS 가 막힌다

Claude 루틴 환경에서 `--candidates` 를 돌리면 **3개 매체 모두 `HTTP 403`** 이 난다.
국내 언론사가 Anthropic 클라우드의 egress IP 를 차단하고 있다. 같은 시각 GitHub
Actions 러너에서는 정상적으로 50건씩 받아왔다 (2026-09-14 확인).

그래서 수집은 Actions 전담이고, 루틴은 저장소에 이미 있는 `archive.json` 만 쓴다.
`collect()` 가 피드 실패를 경고로만 처리하고 넘어가므로 루틴은 그대로 동작한다.
루틴 프롬프트에도 "403 은 정상이니 고치려 하지 마라" 를 못박아 뒀다 — 안 적어 두면
다음 실행이 이걸 버그로 보고 User-Agent 변조나 프록시를 시도한다.

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

## 검토하는 법 (Claude 앱)

1. 월요일 아침 텔레그램 알림의 **「Claude 앱에서 검토하기」** 링크를 연다.
   링크가 없으면 Claude 앱 → Code → 「⚡ 고등교육 뉴스 주간 초안」 최신 세션.
2. 세션 마지막 메시지에 초안 전체가 있다. 말로 지시한다.

| 예 | 결과 |
| --- | --- |
| `3번 의견: 이 정책은 현장과 괴리가 있다` | 채널에서 3번 요약 아래 `💬` 로 나감 |
| `5번 빼` / `5번 복구` | 제외 / 되살림 |
| `2번 요약 더 짧게`, `1번 제목 …로` | 요약·제목 수정 |
| `4번을 맨 앞으로` | 순서 변경 |
| `목록` | 현재 상태 다시 보기 |
| `게시` | 채널에 올림 (1분 안팎, 세션이 완료 여부를 확인해 알려 준다) |
| `취소` | 이번 주 초안 폐기 |

봇에 답장해도 아무 일도 일어나지 않는다. 승인하지 않은 채 다음 주가 되면 초안은 새
초안으로 교체되고, 게시되지 않은 기사는 `lookbackDays` 안에 있는 한 다음 후보에 다시 오른다.

## 검토 DM 명령 (로컬 폴백 전용)

로컬 `run.ps1` 경로를 되살렸을 때만 쓴다. 초안 DM 을 받은 뒤 봇에게 답장으로 보낸다.

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

`/schedule` 로 만든다 (「고등교육 뉴스 주간 초안」). 요약과 검토 대화를 담당하며
텔레그램은 건드리지 않는다. `cron: 7 22 * * 0` (= 월 07:07 KST — 정각은 몇 분씩 늦게
뜬다는 문서 안내에 따라 비켜 잡았다), 저장소를 source 로 연결한다. 프롬프트는
A(자동 실행)와 B(검토 대화) 두 절로 되어 있다.

## 클라우드가 멈췄는지 보는 법

| 증상 | 볼 곳 |
| --- | --- |
| 기사가 안 쌓인다 | 저장소 Actions 탭 → collect 워크플로 |
| 월요일에 초안이 안 나온다 | claude.ai/code/routines → 해당 루틴의 실행 기록 |
| 초안은 나왔는데 알림 DM 이 없다 / "게시" 했는데 안 올라간다 | Actions 탭 → review 워크플로 |
| 셋 다 멀쩡한데 조용하다 | `pending.json` 이 저장소에 있는지, `dmSent`·`approved` 가 뭔지 확인 |

> GitHub 은 **60일간 커밋이 없는 저장소의 예약 워크플로를 자동으로 끈다.** 여기는
> 3시간마다 커밋이 생기므로 해당되지 않지만, 수집을 멈춰 두면 걸릴 수 있다.
>
> 예약 실행은 러너가 붐비면 늦게 뜨거나 **아예 건너뛴다** (위 "왜 텔레그램 DM 명령을
> 걷어냈나" 참고). 사람이 기다리는 단계는 예약 실행에 맡기지 않는다.

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
