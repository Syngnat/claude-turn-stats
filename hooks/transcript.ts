/**
 * The session's own transcript, totalled.
 *
 * The engine keeps no running sum of what a session has cost — `$.session.usage`
 * reports the context window and the plan's rate windows, not the tokens — so
 * the only place the whole history lives is the transcript file the engine
 * writes, one JSON row per message. `$.fs.read` cannot reach it: it caps a read
 * at 4 MiB and a long session passes that, so the summing happens in a child
 * that streams the file instead.
 *
 * **What the child is for.** It is `python3`, a program the person's machine
 * already has on the developer's macOS and virtually every Linux; it is handed
 * the path and reads it line by line, never all at once.
 *
 * **Why the dedup.** The engine writes a message more than once as it updates
 * it (a streamed row re-stored, a sidechain replayed); the same API response can
 * therefore appear as several rows. `message.id` is the API's own id for the
 * response, so counting a row only the first time its `message.id` is seen
 * counts each response once.
 */
import type { SessionTotals } from '../types'

/**
 * The child's program, as an argument vector. It prints one JSON object: the
 * sums over every unique assistant response in the file, or `null` when the
 * file holds none yet.
 */
const PROGRAM = String.raw`
import datetime, json, sys

path = sys.argv[1]
seen = set()
input_tokens = 0
output_tokens = 0
cache_read = 0
cache_creation = 0
responses = 0
turns = 0
# (timestamp in ms, output tokens) per unique response, in file order.
marks = []

with open(path, "r", encoding="utf-8", errors="replace") as f:
    for line in f:
        line = line.strip()
        if not line:
            continue
        try:
            row = json.loads(line)
        except Exception:
            continue
        if row.get("type") == "user":
            # A human turn: a user row with no tool_result block. The engine also
            # writes user rows that carry tool results, and rows it raises itself
            # (isMeta) — neither is something the person typed, so neither counts.
            message = row.get("message")
            if not isinstance(message, dict):
                continue
            content = message.get("content")
            blocks = content if isinstance(content, list) else []
            is_tool_result = any(
                isinstance(block, dict) and block.get("type") == "tool_result"
                for block in blocks
            )
            if is_tool_result or row.get("isMeta"):
                continue
            turns += 1
            continue

        if row.get("type") != "assistant":
            continue
        message = row.get("message")
        if not isinstance(message, dict):
            continue
        usage = message.get("usage")
        if not isinstance(usage, dict):
            continue
        uid = message.get("id") or row.get("uuid")
        if uid is not None:
            if uid in seen:
                continue
            seen.add(uid)
        responses += 1

        # When the response settled, in milliseconds. The engine stamps every
        # row; a row without one cannot be placed in time and is left out of the
        # rate, which is the only place the timestamp is used.
        when = row.get("timestamp")
        if isinstance(when, str) and when:
            try:
                parsed = datetime.datetime.fromisoformat(when.replace("Z", "+00:00"))
                marks.append([int(parsed.timestamp() * 1000), int(usage.get("output_tokens") or 0)])
            except Exception:
                pass

        input_tokens += int(usage.get("input_tokens") or 0)
        output_tokens += int(usage.get("output_tokens") or 0)
        cache_read += int(usage.get("cache_read_input_tokens") or 0)
        cache_creation += int(usage.get("cache_creation_input_tokens") or 0)

print(json.dumps({
    "marks": marks,
    "turns": turns,
    "responses": responses,
    "input": input_tokens + cache_read + cache_creation,
    "output": output_tokens,
    "cacheRead": cache_read,
}))
`

/** What the child printed, before it is turned into the pane's figures. */
export type TranscriptSum = {
  /** `[settledAtMs, outputTokens]` per response, in file order. */
  marks: Array<[number, number]>
  turns: number
  responses: number
  input: number
  output: number
  cacheRead: number
}

function parseSum(stdout: string): TranscriptSum | null {
  let raw: unknown
  try {
    raw = JSON.parse(stdout.trim())
  } catch {
    return null
  }

  if (raw === null || typeof raw !== 'object') return null

  const value = raw as Record<string, unknown>
  const number = (field: unknown): number =>
    typeof field === 'number' && Number.isFinite(field) ? field : 0

  return {
    marks: Array.isArray(value.marks)
      ? (value.marks as unknown[])
          .filter((one): one is [number, number] => Array.isArray(one) && one.length === 2)
          .map(([at, tokens]) => [Number(at), Number(tokens)] as [number, number])
      : [],
    turns: number(value.turns),
    responses: number(value.responses),
    input: number(value.input),
    output: number(value.output),
    cacheRead: number(value.cacheRead),
  }
}

/**
 * The transcript's absolute path, built the way the engine builds it.
 *
 * `classic.Stop` carries it as `transcript_path`, exact. The mods events do not,
 * so there it is derived: `$.session.id()` is the file's name, under
 * `~/.claude/projects/<project>/`, and the engine names that folder after the
 * cwd with every character outside `[A-Za-z0-9-]` turned into `-`.
 */
export function transcriptPathOf(home: string, cwd: string, id: string): string {
  const project = cwd.replace(/[^A-Za-z0-9-]/g, '-')

  return `${home}/.claude/projects/${project}/${id}.jsonl`
}

/**
 * The arguments that run the child which sums the transcript at `path`.
 *
 * The call itself happens at the hook (`$.process.run(transcriptArgv(path))`):
 * `$` is only ever spelled `$.noun.event(...)` at the call site, never bound or
 * passed, so this file hands out the arguments and nothing more.
 *
 * @param path the transcript file, absolute
 */
export function transcriptArgv(path: string): readonly string[] {
  return ['python3', '-c', PROGRAM, path]
}

/**
 * The child's stdout, read as the sums it printed; `null` when a child failed
 * (`exitCode` not 0) or printed nothing usable — the caller then keeps what it
 * already had rather than drawing a zero.
 *
 * @param exitCode the child's exit code
 * @param stdout what it printed
 */
export function parseTranscriptSum(exitCode: number, stdout: string): TranscriptSum | null {
  if (exitCode !== 0) return null

  return parseSum(stdout)
}

/**
 * The transcript's sums as the pane draws them.
 *
 * The transcript counts responses, not turns, and one turn makes several of
 * them; `turns` and `steps` are the ones this mod measured itself, since the
 * file does not say where one turn ended and the next began.
 */
export function totalsFrom(
  sum: TranscriptSum,
  averages: { ttftMs: number | null; tps: number | null },
  contextPercent: number | null,
  measuredSteps: number | null = null,
): SessionTotals {
  return {
    // The transcript's own count, so the turns and the tokens beside them cover
    // the same history. The mod's running count only knows the turns it happened
    // to see, and pairing that with the file's token total read as `1 轮 500M`.
    turns: sum.turns,
    // Steps are not in the file: one model call per response, which is what a
    // step is, so the responses are the steps the session ran.
    steps: measuredSteps ?? sum.responses,
    ttftMs: averages.ttftMs,
    tps: averages.tps,
    outputTokens: sum.output,
    inputTokens: sum.input,
    cacheReadTokens: sum.cacheRead,
    cacheHitPercent: sum.input > 0 ? Math.round((sum.cacheRead / sum.input) * 10000) / 100 : null,
    contextPercent,
  }
}

/**
 * The output rate of the session's last stretch of work, measured from the
 * transcript itself.
 *
 * This is the only honest way to get the figure through a buffering gateway:
 * the pieces of one response can arrive in a burst, so the time between them
 * says nothing, but the time between one response settling and the next one
 * settling cannot be compressed by a buffer — the engine writes each row when
 * the API finished answering.
 *
 * The window is the last few responses that ran back to back. A gap much longer
 * than the rest is the person reading, a tool running, or the session sitting
 * idle, and counting that would report a rate nobody sustained — so the window
 * stops before it.
 *
 * @param marks `[settledAtMs, outputTokens]` in file order
 * @returns the rate in tokens a second, or `null` when there is too little to go on
 */
export function settledRate(marks: Array<[number, number]>): number | null {
  if (marks.length < 2) return null

  // Back from the end while the gaps stay short. 90 s is the cut: past that the
  // session was not answering, it was doing something else.
  const MAX_GAP_MS = 90_000
  const WINDOW = 12
  let start = marks.length - 1

  while (start > 0 && marks.length - start < WINDOW) {
    const gap = marks[start]![0] - marks[start - 1]![0]
    if (gap <= 0 || gap > MAX_GAP_MS) break
    start -= 1
  }

  const first = marks[start]!
  const last = marks[marks.length - 1]!
  const spanMs = last[0] - first[0]
  if (spanMs <= 0) return null

  // Tokens produced in the window, the first response's excluded: its own time
  // is before the span begins.
  let tokens = 0
  for (let at = start + 1; at < marks.length; at += 1) tokens += marks[at]![1]
  if (tokens <= 0) return null

  return Math.round((tokens / (spanMs / 1000)) * 10) / 10
}
