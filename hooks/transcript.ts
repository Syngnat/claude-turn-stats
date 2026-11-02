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
import json, sys

path = sys.argv[1]
seen = set()
input_tokens = 0
output_tokens = 0
cache_read = 0
cache_creation = 0
responses = 0

with open(path, "r", encoding="utf-8", errors="replace") as f:
    for line in f:
        line = line.strip()
        if not line:
            continue
        try:
            row = json.loads(line)
        except Exception:
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
        input_tokens += int(usage.get("input_tokens") or 0)
        output_tokens += int(usage.get("output_tokens") or 0)
        cache_read += int(usage.get("cache_read_input_tokens") or 0)
        cache_creation += int(usage.get("cache_creation_input_tokens") or 0)

print(json.dumps({
    "responses": responses,
    "input": input_tokens + cache_read + cache_creation,
    "output": output_tokens,
    "cacheRead": cache_read,
}))
`

/** What the child printed, before it is turned into the pane's figures. */
export type TranscriptSum = {
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
  measuredTurns: number,
  measuredSteps: number,
  averages: { ttftMs: number | null; tps: number | null },
  contextPercent: number | null,
): SessionTotals {
  return {
    turns: measuredTurns,
    steps: measuredSteps,
    ttftMs: averages.ttftMs,
    tps: averages.tps,
    outputTokens: sum.output,
    inputTokens: sum.input,
    cacheReadTokens: sum.cacheRead,
    cacheHitPercent: sum.input > 0 ? Math.round((sum.cacheRead / sum.input) * 100) : null,
    contextPercent,
  }
}
