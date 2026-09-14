#!/usr/bin/env bun
/**
 * 고등교육 뉴스 주간 다이제스트 → 검토 DM → 텔레그램 채널 게시
 *
 * 피드가 노출하는 최근 50건이 커버하는 기간이 매체별로 0.1~4일에 불과하다
 * (베리타스알파는 약 2.4시간). 주 1회만 수집하면 대부분을 놓치므로
 * 수집(자주)과 게시(주 1회)를 분리한다.
 *
 * 게시는 항상 본인 승인을 거친다. 초안을 DM 으로 보내고, DM 으로 의견을 받아
 * 기사 밑에 붙인 뒤, "게시" 라고 답해야만 채널에 올라간다.
 *
 *   bun digest.ts --collect    피드 수집 → archive.json 누적 (LLM 호출 없음)
 *   bun digest.ts --draft      수집 + 요약 → 초안 저장 + 검토 DM 발송
 *   bun digest.ts --poll       DM 명령 처리 (의견 입력 / 삭제 / 게시 / 취소)
 *   bun digest.ts --dry-run    초안 생성까지 하되 DM 을 보내지 않고 콘솔 출력
 *   bun digest.ts --check      토큰 / 채널 / 관리자 ID 확인
 *   bun digest.ts --whoami     봇에게 온 DM 의 발신자 ID 출력 (ADMIN_ID 찾기용)
 */
import { existsSync } from 'node:fs'
import { readFile, writeFile, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(fileURLToPath(import.meta.url))
const CONFIG_PATH = join(ROOT, 'config.json')
const ARCHIVE_PATH = join(ROOT, 'archive.json')
const STATE_PATH = join(ROOT, 'state.json')
const PENDING_PATH = join(ROOT, 'pending.json')
const ENV_PATH = join(ROOT, '.env')

const has = (f: string) => process.argv.includes(f)
/** 플래그가 없으면 null, 있는데 경로가 빠졌으면 '' 를 준다. 검증은 main 에서
 *  해야 실패가 main().catch → notifyFailure 를 타고 나머지와 같은 길로 흐른다. */
const argValue = (f: string): string | null => {
  const i = process.argv.indexOf(f)
  if (i === -1) return null
  const v = process.argv[i + 1]
  return v && !v.startsWith('--') ? v : ''
}
const COLLECT_ONLY = has('--collect')
const DRAFT = has('--draft')
const POLL = has('--poll')
const CHECK = has('--check')
const WHOAMI = has('--whoami')
const DRY_RUN = has('--dry-run')
// 클라우드 분업용 두 모드. 둘 다 텔레그램 토큰이 필요 없다 — 비밀값은 GitHub
// Secrets 한 곳에만 두고, 텔레그램 통신은 전부 Actions(--poll) 가 맡는다.
//   --candidates <파일>  수집·필터까지만 하고 후보와 지시문을 파일로 떨군다
//   --summaries  <파일>  에이전트가 만든 요약으로 pending.json 만 쓴다 (DM 은 poll 이)
const CANDIDATES_OUT = argValue('--candidates')
const SUMMARIES_IN = argValue('--summaries')

const TELEGRAM_LIMIT = 4096
const NO_ITEMS = 'NO_ITEMS'

type Feed = { name: string; url: string }
type Config = {
  feeds: Feed[]
  lookbackDays: number
  archiveRetentionDays: number
  maxItemsToModel: number
  maxArticlesInDigest: number
  keywords: string[]
  model: string
}
/** 보관용은 날짜를 ISO 문자열로 둔다. Date 로 쓰는 건 메모리 안에서만. */
type Item = { source: string; title: string; link: string; desc: string; date: string }

type Article = {
  title: string
  summary: string
  link: string
  source: string
  opinion: string | null
  dropped: boolean
}
type Pending = {
  createdAt: string
  from: string
  to: string
  articles: Article[]
  candidateLinks: string[]
  // 아래 둘은 클라우드 분업 경로에서만 쓴다. 초안을 만든 쪽(Claude 루틴)은 토큰이
  // 없어 DM 을 못 보내므로, 다음 --poll 이 이 표시를 보고 대신 보낸다.
  // 로컬 실행(draft())은 자기가 DM 을 보내므로 dmSent: true 로 쓴다.
  dmSent?: boolean
  staleReplaced?: boolean
}
type State = {
  postedLinks: string[]
  lastPost: string | null
  lastUpdateId: number
  // 마지막으로 관리자에게 알린 실패. 같은 오류로 DM 이 쌓이는 걸 막는 데만 쓴다.
  lastError?: string
  lastErrorAt?: string
}

function log(msg: string): void {
  console.log(`[${new Date().toISOString()}] ${msg}`)
}

async function readJson<T>(path: string, fallback: T): Promise<T> {
  if (!existsSync(path)) return fallback
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T
  } catch {
    log(`경고: ${path} 를 읽을 수 없어 기본값으로 시작합니다.`)
    return fallback
  }
}

const writeJson = (path: string, data: unknown) => writeFile(path, JSON.stringify(data, null, 2), 'utf8')

const EMPTY_STATE: State = { postedLinks: [], lastPost: null, lastUpdateId: 0 }

/**
 * state.json 은 항상 이 함수로 갱신한다.
 * poll() 이 루프 시작 전에 읽어둔 state 를 루프 끝에 통째로 쓰면, 그 사이
 * publish() 가 기록한 postedLinks 를 덮어써서 게시 이력이 사라진다.
 * 쓰기 직전에 다시 읽어 병합해야 한다.
 */
async function mutateState(fn: (s: State) => void): Promise<void> {
  const s = await readJson<State>(STATE_PATH, { ...EMPTY_STATE })
  fn(s)
  await writeJson(STATE_PATH, s)
}

// ── 환경변수 ────────────────────────────────────────────────────────────────
// Task Scheduler 는 cwd 를 보장하지 않으므로 스크립트 위치 기준으로 읽는다.
// 셸에 이미 설정된 값이 우선한다.
async function loadEnv(): Promise<void> {
  if (!existsSync(ENV_PATH)) return
  for (const line of (await readFile(ENV_PATH, 'utf8')).split(/\r?\n/)) {
    if (line.trimStart().startsWith('#')) continue
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/)
    if (!m) continue
    let v = m[2].trim()
    const quoted = v.length >= 2 && ((v[0] === '"' && v.endsWith('"')) || (v[0] === "'" && v.endsWith("'")))
    if (quoted) v = v.slice(1, -1)
    if (!process.env[m[1]]) process.env[m[1]] = v
  }
}

function requireEnv(name: string): string {
  const v = process.env[name]
  if (!v) throw new Error(`${name} 이(가) 설정되지 않았습니다. news-digest/.env 를 확인하세요.`)
  return v
}

// ── RSS 파싱 ────────────────────────────────────────────────────────────────
function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
}

function stripTags(s: string): string {
  return decodeEntities(s.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim()
}

function pick(block: string, tag: string): string {
  const m = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`))
  if (!m) return ''
  return m[1].replace(/<!\[CDATA\[|\]\]>/g, '').trim()
}

// 이 피드들은 "2026-07-21 16:14:50" 을 쓴다. RFC822 도 함께 받아준다.
function parseDate(s: string): Date {
  if (!s) return new Date(0)
  const local = new Date(s.trim().replace(' ', 'T'))
  if (!Number.isNaN(local.getTime())) return local
  const rfc = new Date(s)
  return Number.isNaN(rfc.getTime()) ? new Date(0) : rfc
}

async function fetchFeed(feed: Feed): Promise<Item[]> {
  const res = await fetch(feed.url, {
    signal: AbortSignal.timeout(25_000),
    headers: { 'user-agent': 'Mozilla/5.0 (news-digest RSS reader)' },
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const xml = await res.text()

  return [...xml.matchAll(/<item[\s>][\s\S]*?<\/item>/g)]
    .map(m => {
      const b = m[0]
      return {
        source: feed.name,
        title: stripTags(pick(b, 'title')),
        link: decodeEntities(pick(b, 'link')),
        desc: stripTags(pick(b, 'description')).slice(0, 400),
        date: parseDate(pick(b, 'pubDate')).toISOString(),
      }
    })
    .filter(it => it.link && it.title)
}

// ── 아카이브 ────────────────────────────────────────────────────────────────
// 피드는 최근 50건만 노출하므로 자주 긁어서 여기에 쌓아둔다.
async function collect(cfg: Config): Promise<void> {
  const archive = await readJson<{ items: Item[] }>(ARCHIVE_PATH, { items: [] })
  const known = new Set(archive.items.map(it => it.link))

  const results = await Promise.allSettled(cfg.feeds.map(fetchFeed))
  let added = 0
  results.forEach((r, i) => {
    if (r.status !== 'fulfilled') {
      log(`경고: ${cfg.feeds[i].name} 수집 실패 — ${r.reason}`)
      return
    }
    const fresh = r.value.filter(it => !known.has(it.link))
    fresh.forEach(it => known.add(it.link))
    archive.items.push(...fresh)
    added += fresh.length
    log(`${cfg.feeds[i].name}: ${r.value.length}건 조회, 신규 ${fresh.length}건`)
  })

  const cutoff = Date.now() - cfg.archiveRetentionDays * 86_400_000
  const before = archive.items.length
  archive.items = archive.items
    .filter(it => new Date(it.date).getTime() >= cutoff)
    .sort((a, b) => b.date.localeCompare(a.date))

  await writeJson(ARCHIVE_PATH, archive)
  log(`아카이브: 신규 ${added}건 추가, 오래된 ${before - archive.items.length}건 정리, 현재 ${archive.items.length}건 보관`)
}

// ── 요약 ────────────────────────────────────────────────────────────────────
function buildInstruction(cfg: Config): string {
  return `당신은 한국 고등교육 분야 뉴스 큐레이터입니다.
stdin 으로 지난 한 주간 국내 고등교육 전문지에서 수집한 기사 목록이 주어집니다.

다음 주제에 해당하는 기사만 선별하세요:
- 고등교육 정책, 대학 정책, 교육부 정책
- 대학입시, 입학전형
- 외국인 유학생 입학·유치·정책
- 한국 대학 관련 주요 동향
- 대학 순위, 대학 평가

선별 기준:
- 단순 행사·수상·인사·협약·홍보성 기사는 제외
- 개별 대학의 단순 소식보다 제도 변화, 정책, 통계, 쟁점이 되는 이슈를 우선
- 대학·입시와 직접 관련이 없으면 제외 (초중등 교육, 일반 사회 이슈 등)
- 최대 ${cfg.maxArticlesInDigest}건, 중요도 순으로 정렬

출력은 다른 설명 없이 JSON 배열 하나만 내보내세요. 코드펜스도 쓰지 마세요.

[
  {
    "title": "기사 제목 (원문 제목을 다듬어도 됨)",
    "summary": "핵심 내용 2~3문장 요약",
    "link": "목록에 주어진 URL 그대로",
    "source": "출처 매체명"
  }
]

규칙:
- summary 는 주어진 제목과 요약문에 있는 사실만 사용하세요. 원문에 없는 내용을 추측하지 마세요.
- title 과 summary 안에 HTML 태그나 마크다운을 넣지 마세요. 순수 텍스트만.
- 조건에 맞는 기사가 하나도 없으면 다른 말 없이 ${NO_ITEMS} 만 출력하세요.`
}

/** 모델이 코드펜스나 잡담을 붙여도 배열만 건져낸다. */
function extractJsonArray(raw: string): unknown {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/)
  const body = fenced ? fenced[1] : raw
  const start = body.indexOf('[')
  const end = body.lastIndexOf(']')
  if (start === -1 || end === -1 || end < start) throw new Error(`모델 응답에서 JSON 배열을 찾지 못했습니다: ${raw.slice(0, 300)}`)
  return JSON.parse(body.slice(start, end + 1))
}

async function summarize(cfg: Config, items: Item[]): Promise<Article[]> {
  const payload = items
    .map((it, i) => `[${i + 1}] ${it.title}\n출처: ${it.source} | ${it.date.slice(0, 10)}\nURL: ${it.link}\n요약: ${it.desc}`)
    .join('\n\n')

  const proc = Bun.spawn(
    ['claude', '-p', buildInstruction(cfg), '--model', cfg.model, '--allowed-tools', ''],
    { stdin: new TextEncoder().encode(payload), stdout: 'pipe', stderr: 'pipe' },
  )
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  // claude CLI 는 인증 만료 같은 실패 사유를 stderr 가 아니라 stdout 으로 내보낸다.
  // stderr 만 남기면 로그에 "exit 1: " 만 찍혀 원인을 알 수 없다. 둘 다 남긴다.
  if (code !== 0) {
    const detail = [err.trim(), out.trim()].filter(Boolean).join(' | ') || '(stdout·stderr 모두 비어 있음)'
    throw new Error(`claude -p 실패 (exit ${code}): ${detail.slice(0, 500)}`)
  }

  const raw = out.trim()
  if (raw.includes(NO_ITEMS)) return []

  return normalizeArticles(cfg, extractJsonArray(raw))
}

/**
 * 요약 결과를 Article[] 로 정리한다. `claude -p` 가 만든 것이든 클라우드
 * 에이전트가 만든 것이든 같은 검증을 통과해야 한다.
 */
function normalizeArticles(cfg: Config, parsed: unknown): Article[] {
  if (!Array.isArray(parsed)) throw new Error('요약 결과가 배열이 아닙니다.')

  return parsed
    .filter((a: any) => a && a.title && a.link)
    .slice(0, cfg.maxArticlesInDigest)
    .map((a: any) => ({
      title: String(a.title),
      summary: String(a.summary ?? ''),
      link: String(a.link),
      source: String(a.source ?? ''),
      opinion: null,
      dropped: false,
    }))
}

// ── 텔레그램 ────────────────────────────────────────────────────────────────
/** 텔레그램 HTML 파서는 &, <, > 를 이스케이프해야 한다. */
function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function chunk(text: string, limit = TELEGRAM_LIMIT): string[] {
  if (text.length <= limit) return [text]
  const chunks: string[] = []
  let cur = ''
  for (const line of text.split('\n')) {
    if (cur.length + line.length + 1 > limit) {
      if (cur) chunks.push(cur.trimEnd())
      cur = ''
      // 한 줄이 통째로 한도를 넘으면 강제로 자른다.
      if (line.length > limit) {
        for (let i = 0; i < line.length; i += limit) chunks.push(line.slice(i, i + limit))
        continue
      }
    }
    cur += line + '\n'
  }
  if (cur.trim()) chunks.push(cur.trimEnd())
  return chunks
}

async function telegram(token: string, method: string, body: unknown): Promise<any> {
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  })
  const json = await res.json()
  if (!json.ok) throw new Error(`Telegram ${method} 실패: ${json.error_code} ${json.description}`)
  return json.result
}

async function send(token: string, chatId: string, text: string): Promise<void> {
  const parts = chunk(text)
  for (const [i, part] of parts.entries()) {
    await telegram(token, 'sendMessage', {
      chat_id: chatId,
      text: part,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    })
    if (i < parts.length - 1) await Bun.sleep(1000) // 레이트리밋 여유
  }
  log(`전송 완료: ${chatId} (${parts.length}개 메시지, ${text.length}자)`)
}

// ── 렌더링 ──────────────────────────────────────────────────────────────────
const fmtDate = (iso: string) => {
  const d = new Date(iso)
  return `${d.getFullYear()}.${String(d.getMonth() + 1).padStart(2, '0')}.${String(d.getDate()).padStart(2, '0')}`
}

/** 채널에 실제로 올라갈 형태. */
function renderForChannel(p: Pending): string {
  const live = p.articles.filter(a => !a.dropped)
  const out = [`<b>🎓 고등교육 주간 브리핑</b>`, `<i>${fmtDate(p.from)} ~ ${fmtDate(p.to)}</i>`, '']

  live.forEach((a, i) => {
    out.push(`<b>${i + 1}. ${esc(a.title)}</b>`)
    out.push(esc(a.summary))
    if (a.opinion) out.push(`<i>💬 ${esc(a.opinion)}</i>`)
    out.push(`<a href="${esc(a.link)}">기사 보기</a>${a.source ? ` · ${esc(a.source)}` : ''}`)
    out.push('')
  })
  return out.join('\n').trimEnd()
}

/** 검토용 DM. 번호와 현재 의견 상태를 함께 보여준다. */
function renderForReview(p: Pending): string {
  const out = [
    `<b>📝 주간 브리핑 초안 검토</b>`,
    `<i>${fmtDate(p.from)} ~ ${fmtDate(p.to)} · ${p.articles.filter(a => !a.dropped).length}건</i>`,
    '',
  ]

  p.articles.forEach((a, i) => {
    const n = i + 1
    if (a.dropped) {
      out.push(`<b>${n}.</b> <s>${esc(a.title)}</s> (제외됨)`)
      out.push('')
      return
    }
    out.push(`<b>${n}. ${esc(a.title)}</b>`)
    out.push(esc(a.summary))
    if (a.opinion) out.push(`<i>💬 ${esc(a.opinion)}</i>`)
    out.push(`<a href="${esc(a.link)}">기사 보기</a>${a.source ? ` · ${esc(a.source)}` : ''}`)
    out.push('')
  })

  out.push('━━━━━━━━━━━━━━')
  out.push('<b>명령</b>')
  out.push('<code>3 이 정책은 현장과 괴리가 있다</code> — 3번에 의견 추가')
  out.push('<code>삭제 5</code> — 5번 제외')
  out.push('<code>복구 5</code> — 5번 되살리기')
  out.push('<code>목록</code> — 현재 상태 다시 보기')
  out.push('<code>게시</code> — 채널에 올리기')
  out.push('<code>취소</code> — 이번 주 초안 폐기')
  out.push('')
  out.push('<i>승인하기 전까지 채널에는 올라가지 않습니다.</i>')
  return out.join('\n')
}

// ── 초안 생성 ───────────────────────────────────────────────────────────────
type Candidates = { from: Date; to: Date; items: Item[] }

/**
 * 아카이브에서 이번 회차 후보를 고른다. 기간·기게시·키워드 순으로 거른다.
 * 로컬 경로(draft)와 클라우드 경로(--candidates, --summaries)가 같은 결과를
 * 봐야 하므로 한 곳에 둔다. 같은 실행 안에서는 아카이브가 안 바뀌므로
 * 두 번 불러도 같은 집합이 나온다.
 */
async function selectCandidates(cfg: Config): Promise<Candidates> {
  const archive = await readJson<{ items: Item[] }>(ARCHIVE_PATH, { items: [] })
  const state = await readJson<State>(STATE_PATH, { ...EMPTY_STATE })

  const to = new Date()
  const from = new Date(to.getTime() - cfg.lookbackDays * 86_400_000)
  const posted = new Set(state.postedLinks)
  const kw = cfg.keywords.map(k => k.toLowerCase())

  const items = archive.items
    .filter(it => new Date(it.date) >= from)
    .filter(it => !posted.has(it.link))
    .filter(it => {
      if (kw.length === 0) return true
      const hay = `${it.title} ${it.desc}`.toLowerCase()
      return kw.some(k => hay.includes(k))
    })
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, cfg.maxItemsToModel)

  log(`아카이브 ${archive.items.length}건 → 기간·중복·키워드 필터 후 ${items.length}건`)
  return { from, to, items }
}

async function draft(cfg: Config, token: string, adminId: string): Promise<void> {
  await collect(cfg)

  const { from, to, items: candidates } = await selectCandidates(cfg)
  if (candidates.length === 0) {
    log('요약할 신규 기사가 없습니다. 초안을 만들지 않습니다.')
    return
  }

  log(`요약 생성 중 (model=${cfg.model}, 최대 ${cfg.maxArticlesInDigest}건)...`)
  const articles = await summarize(cfg, candidates)
  if (articles.length === 0) {
    log('주제에 해당하는 기사가 없다고 판단했습니다. 초안을 만들지 않습니다.')
    return
  }

  // 지난 초안이 승인되지 않은 채 남아 있으면 새 초안으로 교체한다.
  // 승인되지 않은 기사는 postedLinks 에 없으므로 다음 후보에 자연히 다시 오른다.
  const stale = await readJson<Pending | null>(PENDING_PATH, null)

  const pending: Pending = {
    createdAt: new Date().toISOString(),
    from: from.toISOString(),
    to: to.toISOString(),
    articles,
    candidateLinks: candidates.map(it => it.link),
    dmSent: true, // 바로 아래에서 직접 보낸다
  }

  if (DRY_RUN) {
    console.log('\n───────── DRY RUN: 검토 DM (발송하지 않음) ─────────\n')
    console.log(renderForReview(pending))
    console.log('\n───────── DRY RUN: 채널 게시본 ─────────\n')
    console.log(renderForChannel(pending))
    return
  }

  await flushPendingUpdates(token)
  await writeJson(PENDING_PATH, pending)
  if (stale) {
    await send(token, adminId, `<i>지난주 초안이 승인되지 않아 폐기하고 새 초안으로 교체했습니다.</i>`)
  }
  await send(token, adminId, renderForReview(pending))
  log(`초안 ${articles.length}건 생성, 검토 DM 발송 완료. 승인 대기 중.`)
}

// ── 클라우드 분업 ───────────────────────────────────────────────────────────
// Claude 루틴은 요약만 하고, 텔레그램은 건드리지 않는다. 그래서 봇 토큰이
// GitHub Secrets 밖으로 나가지 않는다. 흐름:
//   1) 루틴: --candidates  → 수집 + 후보/지시문 파일로 출력
//   2) 루틴: 에이전트가 직접 읽고 요약해서 summaries.json 작성
//   3) 루틴: --summaries   → pending.json (dmSent:false) 작성 후 push
//   4) Actions --poll      → dmSent:false 를 보고 검토 DM 발송

/** 1단계. 수집·필터 결과와 요약 지시문을 한 파일에 담아 에이전트에게 넘긴다. */
async function writeCandidates(cfg: Config, outPath: string): Promise<void> {
  await collect(cfg)
  const { from, to, items } = await selectCandidates(cfg)

  await writeJson(outPath, {
    from: from.toISOString(),
    to: to.toISOString(),
    maxArticles: cfg.maxArticlesInDigest,
    noItemsToken: NO_ITEMS,
    instruction: buildInstruction(cfg),
    items: items.map((it, i) => ({ n: i + 1, ...it })),
  })
  log(`후보 ${items.length}건과 지시문을 ${outPath} 에 기록했습니다.`)
}

/** 3단계. 에이전트가 만든 요약 배열로 pending.json 만 쓴다. DM 은 보내지 않는다. */
async function draftFromSummaries(cfg: Config, inPath: string): Promise<void> {
  const raw = (await readFile(inPath, 'utf8')).trim()
  const articles = normalizeArticles(cfg, raw.includes(NO_ITEMS) ? [] : extractJsonArray(raw))
  if (articles.length === 0) {
    log('주제에 해당하는 기사가 없습니다. 초안을 만들지 않습니다.')
    return
  }

  const { from, to, items } = await selectCandidates(cfg)
  // 지난 초안이 승인되지 않은 채 남아 있으면 새 초안으로 교체한다.
  const stale = await readJson<Pending | null>(PENDING_PATH, null)

  await writeJson(PENDING_PATH, {
    createdAt: new Date().toISOString(),
    from: from.toISOString(),
    to: to.toISOString(),
    articles,
    candidateLinks: items.map(it => it.link),
    dmSent: false,
    staleReplaced: Boolean(stale),
  } satisfies Pending)
  log(`초안 ${articles.length}건 생성. 검토 DM 은 다음 폴링이 보냅니다.`)
}

// ── 게시 ────────────────────────────────────────────────────────────────────
async function publish(token: string, channelId: string, adminId: string): Promise<void> {
  const pending = await readJson<Pending | null>(PENDING_PATH, null)
  if (!pending) {
    await send(token, adminId, '게시할 초안이 없습니다.')
    return
  }
  const live = pending.articles.filter(a => !a.dropped)
  if (live.length === 0) {
    await send(token, adminId, '남아 있는 기사가 없습니다. 모두 제외하셨습니다.')
    return
  }

  await send(token, channelId, renderForChannel(pending))

  // 게시에 성공한 뒤에만 기록한다. 실패하면 초안이 남아 재시도할 수 있다.
  await mutateState(s => {
    s.postedLinks = [...s.postedLinks, ...pending.candidateLinks].slice(-5000)
    s.lastPost = new Date().toISOString()
  })
  await rm(PENDING_PATH, { force: true })

  const withOpinion = live.filter(a => a.opinion).length
  await send(token, adminId, `✅ 채널에 게시했습니다. ${live.length}건 (의견 ${withOpinion}건 포함).`)
  log(`게시 완료: ${live.length}건`)
}

// ── DM 명령 처리 ────────────────────────────────────────────────────────────
async function handleCommand(
  token: string,
  channelId: string,
  adminId: string,
  text: string,
): Promise<void> {
  const t = text.trim()
  const pending = await readJson<Pending | null>(PENDING_PATH, null)

  const needPending = async (): Promise<Pending | null> => {
    if (!pending) {
      await send(token, adminId, '대기 중인 초안이 없습니다.')
      return null
    }
    return pending
  }

  if (/^(게시|발행|publish|ok)$/i.test(t)) {
    await publish(token, channelId, adminId)
    return
  }

  if (/^(취소|폐기|cancel)$/i.test(t)) {
    if (!(await needPending())) return
    await rm(PENDING_PATH, { force: true })
    await send(token, adminId, '초안을 폐기했습니다. 해당 기사들은 다음 주 후보에 다시 오릅니다.')
    return
  }

  if (/^(목록|list|상태)$/i.test(t)) {
    const p = await needPending()
    if (p) await send(token, adminId, renderForReview(p))
    return
  }

  const drop = t.match(/^(삭제|제외|drop)\s+(\d+)$/i)
  const undrop = t.match(/^(복구|되살리기|undrop)\s+(\d+)$/i)
  if (drop || undrop) {
    const p = await needPending()
    if (!p) return
    const n = Number((drop ?? undrop)![2])
    if (n < 1 || n > p.articles.length) {
      await send(token, adminId, `${n}번 기사가 없습니다. 1~${p.articles.length} 사이로 입력하세요.`)
      return
    }
    p.articles[n - 1].dropped = !!drop
    await writeJson(PENDING_PATH, p)
    await send(token, adminId, `${n}번을 ${drop ? '제외' : '복구'}했습니다. (남은 기사 ${p.articles.filter(a => !a.dropped).length}건)`)
    return
  }

  // "3 의견 내용" — 번호 + 공백 + 본문
  const opinion = t.match(/^(\d+)[\s.:]+([\s\S]+)$/)
  if (opinion) {
    const p = await needPending()
    if (!p) return
    const n = Number(opinion[1])
    if (n < 1 || n > p.articles.length) {
      await send(token, adminId, `${n}번 기사가 없습니다. 1~${p.articles.length} 사이로 입력하세요.`)
      return
    }
    p.articles[n - 1].opinion = opinion[2].trim()
    await writeJson(PENDING_PATH, p)
    await send(token, adminId, `${n}번에 의견을 추가했습니다.\n<i>💬 ${esc(opinion[2].trim())}</i>\n\n계속 입력하시거나 <code>게시</code> 로 올리세요.`)
    return
  }

  await send(
    token,
    adminId,
    [
      '<b>사용법</b>',
      '<code>3 이 정책은 현장과 괴리가 있다</code> — 3번에 의견 추가',
      '<code>삭제 5</code> / <code>복구 5</code>',
      '<code>목록</code> · <code>게시</code> · <code>취소</code>',
    ].join('\n'),
  )
}

/**
 * 초안을 보내기 직전에 밀린 수신 메시지를 소비해 버린다.
 * Poll 은 초안이 있을 때만 도는데, 텔레그램은 미수신 메시지를 24시간 보관한다.
 * 이걸 비우지 않으면 지난주에 보낸 "게시" 가 이번주 초안에 적용돼
 * 검토 없이 발행되는 사고가 난다.
 */
async function flushPendingUpdates(token: string): Promise<void> {
  const updates = await telegram(token, 'getUpdates', { timeout: 0, allowed_updates: ['message'] })
  if (updates.length === 0) return
  const maxId = Math.max(...updates.map((u: any) => u.update_id))
  await mutateState(s => {
    s.lastUpdateId = Math.max(s.lastUpdateId, maxId)
  })
  log(`초안 발송 전, 밀려 있던 메시지 ${updates.length}건을 건너뜁니다 (묵은 명령 오작동 방지).`)
}

async function poll(token: string, channelId: string, adminId: string): Promise<void> {
  // 클라우드 경로로 만들어진 초안은 아직 DM 이 안 나갔다. 명령을 처리하기 전에
  // 먼저 보낸다. flush 를 DM 직전에 두는 건 의도적이다 — 지난주에 보낸 '게시' 가
  // 이번 주 초안에 적용되어 검토 없이 발행되는 걸 막는다. 이번 실행은 여기서
  // 끝낸다. 방금 큐를 비웠으므로 처리할 명령이 남아 있지 않다.
  const fresh = await readJson<Pending | null>(PENDING_PATH, null)
  if (fresh && fresh.dmSent === false) {
    await flushPendingUpdates(token)
    if (fresh.staleReplaced) {
      await send(token, adminId, `<i>지난주 초안이 승인되지 않아 폐기하고 새 초안으로 교체했습니다.</i>`)
    }
    await send(token, adminId, renderForReview(fresh))
    fresh.dmSent = true
    await writeJson(PENDING_PATH, fresh)
    log(`검토 DM 발송 완료 (${fresh.articles.length}건). 승인 대기 중.`)
    return
  }

  const state = await readJson<State>(STATE_PATH, { ...EMPTY_STATE })

  const updates = await telegram(token, 'getUpdates', {
    offset: state.lastUpdateId + 1,
    timeout: 0,
    allowed_updates: ['message'],
  })
  if (updates.length === 0) {
    log('새 메시지 없음.')
    return
  }

  let maxUpdateId = state.lastUpdateId
  for (const u of updates) {
    maxUpdateId = Math.max(maxUpdateId, u.update_id)
    const msg = u.message
    if (!msg?.text) continue
    // 관리자 본인의 DM 만 명령으로 처리한다.
    if (String(msg.from?.id) !== adminId) {
      log(`무시: 허용되지 않은 발신자 ${msg.from?.id} (${msg.from?.username ?? '?'})`)
      continue
    }
    log(`명령 수신: ${msg.text.slice(0, 60)}`)
    try {
      await handleCommand(token, channelId, adminId, msg.text)
    } catch (e) {
      const m = e instanceof Error ? e.message : String(e)
      log(`명령 처리 실패: ${m}`)
      await send(token, adminId, `⚠️ 처리 실패: ${esc(m)}`).catch(() => {})
    }
  }

  // 처리한 update 는 실패 여부와 무관하게 소비한다. 같은 명령이 무한 재실행되면 곤란하다.
  // handleCommand 안에서 publish() 가 state 를 갱신했을 수 있으므로 병합해서 쓴다.
  await mutateState(s => {
    s.lastUpdateId = Math.max(s.lastUpdateId, maxUpdateId)
  })
}

// ── 메인 ────────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  await loadEnv()
  const cfg: Config = JSON.parse(await readFile(CONFIG_PATH, 'utf8'))

  if (WHOAMI) {
    const token = requireEnv('TELEGRAM_BOT_TOKEN')
    const updates = await telegram(token, 'getUpdates', { timeout: 0, allowed_updates: ['message'] })
    if (updates.length === 0) {
      log('받은 메시지가 없습니다. 봇에게 DM 을 먼저 보낸 뒤 다시 실행하세요.')
      return
    }
    for (const u of updates) {
      const f = u.message?.from
      if (f) log(`발신자 ID: ${f.id}  (${f.first_name ?? ''} ${f.username ? '@' + f.username : ''})`)
    }
    log('이 ID 를 .env 의 TELEGRAM_ADMIN_ID 에 넣으세요.')
    return
  }

  if (CHECK) {
    const token = requireEnv('TELEGRAM_BOT_TOKEN')
    const channelId = requireEnv('TELEGRAM_CHANNEL_ID')
    const adminId = requireEnv('TELEGRAM_ADMIN_ID')
    const me = await telegram(token, 'getMe', {})
    log(`봇 확인: @${me.username} (${me.first_name})`)
    const chat = await telegram(token, 'getChat', { chat_id: channelId })
    log(`채널 확인: ${chat.title ?? chat.username} (type=${chat.type}, id=${chat.id})`)
    if (chat.type !== 'channel') log(`경고: 채팅 타입이 'channel' 이 아닙니다 — 의도한 대상이 맞는지 확인하세요.`)
    await send(token, adminId, '✅ 연결 확인 완료. 이 DM 이 보이면 검토 알림을 받을 수 있습니다.')
    log('관리자 DM 발송 성공. 설정이 모두 정상입니다.')
    return
  }

  if (COLLECT_ONLY) {
    await collect(cfg)
    return
  }

  // 토큰을 요구하기 전에 분기한다. 이 두 모드는 클라우드에서 토큰 없이 돈다.
  if (CANDIDATES_OUT !== null) {
    if (!CANDIDATES_OUT) throw new Error('--candidates 뒤에 출력 파일 경로가 필요합니다.')
    await writeCandidates(cfg, CANDIDATES_OUT)
    return
  }
  if (SUMMARIES_IN !== null) {
    if (!SUMMARIES_IN) throw new Error('--summaries 뒤에 입력 파일 경로가 필요합니다.')
    await draftFromSummaries(cfg, SUMMARIES_IN)
    return
  }

  const token = DRY_RUN ? (process.env.TELEGRAM_BOT_TOKEN ?? '') : requireEnv('TELEGRAM_BOT_TOKEN')
  const channelId = DRY_RUN ? (process.env.TELEGRAM_CHANNEL_ID ?? '') : requireEnv('TELEGRAM_CHANNEL_ID')
  const adminId = DRY_RUN ? (process.env.TELEGRAM_ADMIN_ID ?? '') : requireEnv('TELEGRAM_ADMIN_ID')

  if (POLL) {
    await poll(token, channelId, adminId)
    return
  }
  // 기본 동작은 초안 생성 + 검토 DM. 게시는 승인 후 --poll 이 수행한다.
  await draft(cfg, token, adminId)
}

/**
 * 이 스크립트는 무인 실행이라, 실패하면 로그에만 남고 아무도 모른다.
 * 실제로 2026-08-19 와 08-31 의 초안 생성 실패를 몇 주 동안 알아채지 못했다.
 * 관리자에게 한 줄이라도 보낸다.
 *
 * Poll 은 초안이 대기 중일 때 30분마다 도는데, 네트워크가 계속 죽어 있으면
 * DM 이 수십 통 쌓인다. 그래서 같은 오류 메시지는 6시간 동안 한 번만 보낸다.
 */
async function notifyFailure(message: string): Promise<void> {
  if (DRY_RUN) return
  try {
    await loadEnv()
    const token = process.env.TELEGRAM_BOT_TOKEN
    const adminId = process.env.TELEGRAM_ADMIN_ID
    if (!token || !adminId) return

    const state = await readJson<State>(STATE_PATH, { ...EMPTY_STATE })
    const repeat =
      state.lastError === message &&
      state.lastErrorAt !== undefined &&
      Date.now() - Date.parse(state.lastErrorAt) < 6 * 3_600_000
    if (repeat) return

    const mode = COLLECT_ONLY ? '수집' : POLL ? '명령 처리' : CHECK ? '연결 확인'
      : CANDIDATES_OUT ? '후보 추출' : SUMMARIES_IN ? '초안 작성' : '초안 생성'
    await send(token, adminId, `⚠️ <b>${mode} 실패</b>\n<code>${esc(message.slice(0, 500))}</code>`)
    await mutateState(s => {
      s.lastError = message
      s.lastErrorAt = new Date().toISOString()
    })
  } catch {
    // 알림이 실패해도 원래 오류를 덮지 않는다. 로그에는 이미 남아 있다.
  }
}

main().catch(async e => {
  const message = e instanceof Error ? e.message : String(e)
  console.error(`[오류] ${message}`)
  await notifyFailure(message)
  process.exit(1)
})
