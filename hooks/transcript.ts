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
 * **Why the dedup, and which row survives.** The engine writes a response more
 * than once as it settles, one row per content block. The rows of one API
 * response share `message.id`, but they do not share its usage: the first row
 * (the thinking block) carries a placeholder count — `output_tokens: 0`, with
 * the prompt not yet split from the cache — and the later rows carry what the
 * API actually billed. Keeping the first row therefore undercounted output by
 * 14% and overcounted prompt-side input by 6% across a real history, and
 * reported a 79% cache hit where the true figure was 98%. Keeping the row with
 * the most output (a tie keeps the later one) makes the sum agree with the API
 * whichever order a given engine version writes the blocks in.
 */
import type { SessionTotals } from '../types'

/**
 * The child's program, as an argument vector. It prints one JSON object: the
 * sums over every unique assistant response in the file, or `null` when the
 * file holds none yet.
 */
const PROGRAM = String.raw`
import json, sys

path = sys.argv[1]

# One bucket per unique API response; each row of it replaces the bucket when
# it carries at least as much output, so the complete usage row is the one kept.
responses = {}
turns = 0

# What the engine raises itself rather than the person typing it: slash-command
# plumbing, background-task notices, and the two markers it injects when a
# session resumes or an interrupt lands. None of these is a turn.
SYNTHETIC_PREFIXES = (
    "<local-command-",
    "<command-name>",
    "<command-message>",
    "<task-notification>",
    "This session is being continued from a previous conversation",
)
SYNTHETIC_EXACT = ("[Request interrupted by user]",)


def text_of(content):
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return " ".join(
            block.get("text", "")
            for block in content
            if isinstance(block, dict) and block.get("type") == "text"
        )
    return ""


def is_human_turn(row):
    message = row.get("message")
    if not isinstance(message, dict):
        return False
    content = message.get("content")
    blocks = content if isinstance(content, list) else []
    # A user row that carries a tool result is the engine handing a tool's
    # output back to the model, not the person speaking.
    if any(isinstance(block, dict) and block.get("type") == "tool_result" for block in blocks):
        return False
    if row.get("isMeta"):
        return False
    text = text_of(content).lstrip()
    if text in SYNTHETIC_EXACT or text.startswith(SYNTHETIC_PREFIXES):
        return False
    # The engine's own word for it: origin.kind is 'human' exactly when the
    # person sent the prompt. Where a transcript predates that field, the shape
    # of the row is the fallback: text or an image, nothing the engine raised.
    origin = row.get("origin")
    if isinstance(origin, dict):
        return origin.get("kind") == "human"
    # Legacy rows carry no origin at all. The engine's own placeholder for an
    # image it attached reads like a text prompt, so it is named out here.
    if text.startswith("[Image:"):
        return False
    if isinstance(content, str):
        return True
    return any(isinstance(block, dict) and block.get("type") in ("text", "image") for block in blocks)


with open(path, "r", encoding="utf-8", errors="replace") as f:
    for line in f:
        # Most rows are tool results, attachments, request records and title
        # updates. A cheap substring test rejects them before the parse; a row
        # that names neither event cannot be one this sum reads.
        if '"assistant"' not in line and '"user"' not in line:
            continue
        try:
            row = json.loads(line)
        except Exception:
            continue
        kind = row.get("type")
        if kind == "user":
            if is_human_turn(row):
                turns += 1
            continue
        if kind != "assistant":
            continue
        message = row.get("message")
        if not isinstance(message, dict):
            continue
        usage = message.get("usage")
        if not isinstance(usage, dict):
            continue
        uid = message.get("id") or row.get("uuid")
        bucket = responses.get(uid)
        if bucket is None:
            bucket = [0, 0, 0, 0, -1]
            responses[uid] = bucket
        # A response's rows do not share one usage: the placeholder row (the
        # thinking block) reports 0 output and an unsplit prompt, while the row
        # the API billed in full has the output. Keep the row with the most
        # output, and let a tie keep the later one, so the whole bucket always
        # comes from one single row.
        out = int(usage.get("output_tokens") or 0)
        if out >= bucket[4]:
            bucket[0] = int(usage.get("input_tokens") or 0)
            bucket[1] = out
            bucket[2] = int(usage.get("cache_read_input_tokens") or 0)
            bucket[3] = int(usage.get("cache_creation_input_tokens") or 0)
            bucket[4] = out

input_tokens = sum(bucket[0] for bucket in responses.values())
output_tokens = sum(bucket[1] for bucket in responses.values())
cache_read = sum(bucket[2] for bucket in responses.values())
cache_creation = sum(bucket[3] for bucket in responses.values())

print(json.dumps({
    "turns": turns,
    "responses": len(responses),
    "input": input_tokens + cache_read + cache_creation,
    "output": output_tokens,
    "cacheRead": cache_read,
}))
`

/** What the child printed, before it is turned into the pane's figures. */
export type TranscriptSum = {
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

  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null

  const value = raw as Record<string, unknown>
  const number = (field: unknown): number =>
    typeof field === 'number' && Number.isFinite(field) ? field : 0

  // The two counts are the shape's own proof: a JSON object without them is not
  // this child's answer (another program's stdout, a truncated print), and
  // reading it as zeroes would draw an empty session beside real figures.
  if (typeof value.turns !== 'number' || typeof value.responses !== 'number') return null

  return {
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
  averages: {
    ttftMs: number | null
    tps: number | null
    waitedTurns?: number
    waitedMs?: number
    ratedTurns?: number
    streamMs?: number
    ratedTokens?: number
  },
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
    // The model's rate is the one this mod measured while the turns ran; the
    // file cannot recover it (it holds when each response settled, not how long
    // the model took to write it), so it covers the turns since install.
    tps: averages.tps,
    // The sums the means are taken over travel with them: the transcript's totals
    // below are the whole session's and must not be divided by a mean taken over
    // a handful of turns.
    waitedTurns: averages.waitedTurns,
    waitedMs: averages.waitedMs,
    ratedTurns: averages.ratedTurns,
    streamMs: averages.streamMs,
    ratedTokens: averages.ratedTokens,
    outputTokens: sum.output,
    inputTokens: sum.input,
    cacheReadTokens: sum.cacheRead,
    // The file's own share, over every turn it holds — the ones from before this
    // mod was installed included. That is what the label promises: this
    // conversation's cache hit, not the mod's since it loaded.
    cacheHitPercent: sum.input > 0 ? Math.round((sum.cacheRead / sum.input) * 10000) / 100 : null,
    contextPercent,
  }
}

/**
 * The rate over two sums of tokens and time, added together.
 *
 * A session's mean and the turn in flight are merged by adding what they were
 * measured over — never by averaging two averages, and never by dividing one
 * total by the other's rate. That division is what turned 369 tok/s into 6600:
 * the totals came from the whole transcript and the rate from a handful of the
 * mod's own turns.
 *
 * @param baseTokens tokens behind the session's mean so far, `null` when unknown
 * @param baseMs stream time behind it, `null` when unknown
 * @param extraTokens tokens of the turn in flight
 * @param extraMs stream time of the turn in flight
 */
export function combineRate(
  baseTokens: number | null,
  baseMs: number | null,
  extraTokens: number,
  extraMs: number,
): number | null {
  if (baseTokens === null || baseMs === null) return null

  const tokens = baseTokens + extraTokens
  const ms = baseMs + extraMs
  if (tokens <= 0 || ms <= 0) return null

  return Math.round((tokens / (ms / 1000)) * 10) / 10
}

/**
 * The mean first-token wait over two sums of waits and how many turns they cover.
 * Same rule as `combineRate`: add the sums, divide once.
 */
export function combineWait(
  baseMs: number | null,
  baseTurns: number | null,
  extraMs: number,
): number | null {
  if (baseMs === null || baseTurns === null) return null

  return Math.round((baseMs + extraMs) / (baseTurns + 1))
}
