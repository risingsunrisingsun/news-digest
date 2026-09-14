#!/usr/bin/env bash
# 지정한 상태 파일만 커밋하고 push 한다. 변경이 없으면 조용히 끝난다.
#   사용법: push-state.sh <라벨> <파일...>
#
# 파일 목록을 호출자가 좁게 지정하는 게 핵심이다. 같은 저장소에 Actions 두
# 워크플로와 Claude 루틴이 각각 커밋하는데, 각자 자기가 만든 파일만 담으면
# 충돌 자체가 거의 생기지 않는다:
#   collect  → archive.json
#   poll     → state.json, pending.json
#   루틴     → archive.json, pending.json
#
# 그래도 겹치면 non-fast-forward 로 거절된다. 이건 정상 상황이라 실패로
# 취급하지 않고 rebase 후 다시 민다.
set -euo pipefail

label="${1:?커밋 라벨이 필요합니다}"
shift
[ "$#" -gt 0 ] || { echo "커밋할 파일을 하나 이상 지정하세요." >&2; exit 1; }

git config user.name  "github-actions[bot]"
git config user.email "41898282+github-actions[bot]@users.noreply.github.com"

# pending.json 은 게시 직후 삭제되므로 없을 수 있다. -A 로 삭제도 스테이징한다.
for f in "$@"; do git add -A -- "$f"; done

if git diff --cached --quiet; then
  echo "변경 없음 — 커밋하지 않습니다."
  exit 0
fi

git commit -m "${label}: $(date -u +%Y-%m-%dT%H:%MZ)"

for attempt in 1 2 3 4 5; do
  if git push; then
    echo "push 성공 (시도 ${attempt}회)"
    exit 0
  fi
  echo "push 거절됨 — rebase 후 재시도 (${attempt}/5)"
  # 상태 파일은 기계가 생성한 JSON 이라 줄 단위 3-way merge 가 의미 없다.
  # 충돌하면 이번 실행이 방금 계산한 값을 채택한다 (rebase 에서는 theirs 가
  # 재적용 중인 내 커밋을 가리킨다). 담는 파일이 좁아 남의 것을 덮지 않는다.
  git pull --rebase --strategy-option=theirs origin "${GITHUB_REF_NAME}"
  sleep $(( attempt * 3 ))
done

echo "5회 시도 후에도 push 하지 못했습니다." >&2
exit 1
