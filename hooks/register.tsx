import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { SessionTotals, StepStats } from '../types'
import { parseTranscriptSum, totalsFrom, transcriptArgv, transcriptPathOf } from './transcript'

// No shape tag: every field added so far left the others' meaning alone, so a
// value written by an earlier version still reads. Adding one now would decline
// every value already stored and leave the band blank after a reload — the
// wrong trade. Add a tag when a field's *meaning* changes, not its count.
const last = atom({ plugin: 'turn-stats', key: 'last' } as const, null as StepStats | null)
const totals = atom({ plugin: 'turn-stats', key: 'totals' } as const, null as SessionTotals | null)
// Whether the session's totals are unfolded under the band. In `$.state` rather
// than a module variable: a reload must not silently fold them away.
const isExpanded = atom({ plugin: 'turn-stats', key: 'isExpanded' } as const, false)

/**
 * The turn being measured right now. A module variable, not `$.state`: it is
 * this mod's bookkeeping while a turn runs, never something a reload should
 * inherit. A reload happens between turns, so nothing of value is lost — the
 * finished numbers live in `last`.
 *
 * The numbers are the turn's, not one step's: a turn that calls a tool runs the
 * model more than once, and what the person waited for is the whole of it. So
 * each step's stream time and output tokens are summed across the turn, and the
 * rate is one division at the end. `firstWaitMs` is the first step's wait for
 * its first token, which is the wait the person actually sat through.
 */
type Live = {
  turnId: string
  stepStartedAt: number | null
  stepFirstAt: number | null
  firstWaitMs: number | null
  streamMs: number
  outputTokens: number
  inputTokens: number
  cacheReadTokens: number
  steps: number
  startedAt: number
  isDone: boolean
}

let live: Live | null = null

function msText(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`
}

function tokText(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`
  return tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}k` : `${tokens}`
}

/**
 * A cache-hit share: no decimals when it lands on a whole percent, otherwise up
 * to two. `87%` is the whole figure and reads as one; `87.00%` says the same
 * thing with trailing zeros that measure nothing. A share with real fraction
 * keeps it — `98.81%`, never rounded up to a flat 99%.
 */
/** Where the last turn's figures are kept between sessions, with whose they are. */
const STORE_KEY = 'turn-stats.lastTurn'

/**
 * The last turn's figures as `$.store` holds them: the session they were
 * measured in, and the value itself. A store entry that names another session
 * is not this conversation's, and one written by an older version may hold any
 * shape at all — both read as nothing here.
 */
type StoredTurn = { sessionId: string; turn: StepStats }

function readStoredTurn(raw: unknown, sessionId: string | null): StepStats | null {
  if (sessionId === null || raw === null || typeof raw !== 'object') return null

  const held = raw as Partial<StoredTurn>
  if (held.sessionId !== sessionId) return null

  return normalizeTurn(held.turn)
}

function percentText(percent: number): string {
  const rounded = Math.round(percent * 100) / 100

  // `String` gives the shortest form that reads back the same number, so 87
  // stays `87`, 99.9 is `99.9`, and 98.81 is `98.81` — no zero is padded in.
  return `${String(rounded)}%`
}

function blankTurn(turnId: string, startedAt: number): Live {
  return {
    turnId,
    stepStartedAt: null,
    stepFirstAt: null,
    firstWaitMs: null,
    streamMs: 0,
    outputTokens: 0,
    inputTokens: 0,
    cacheReadTokens: 0,
    steps: 0,
    startedAt,
    isDone: false,
  }
}

/**
 * Adds one response's input tokens to the turn's running figures, for the turn's
 * own cache hit. Input is all three kinds together — uncached, cache-written and
 * cache-read — because that is what the cache-read share is a share *of*.
 */
function addUsage(turn: Live, usage: {
  input_tokens?: number | null
  cache_creation_input_tokens?: number | null
  cache_read_input_tokens?: number | null
}): void {
  turn.inputTokens +=
    (usage.input_tokens ?? 0) +
    (usage.cache_creation_input_tokens ?? 0) +
    (usage.cache_read_input_tokens ?? 0)
  turn.cacheReadTokens += usage.cache_read_input_tokens ?? 0
}

/** Closes the step in flight: its stream time joins the turn's running total. */
function closeStepOf(turn: Live | null, now: number): void {
  if (turn === null || turn.stepStartedAt === null) return

  if (turn.stepFirstAt !== null) {
    turn.streamMs += now - turn.stepFirstAt
  }
  turn.stepStartedAt = null
  turn.stepFirstAt = null
}

/**
 * What the turn has come to as of `now`. The rate is the turn's output tokens
 * over the turn's whole stream time, both summed across its steps, with the
 * first step's first-token wait left out — that wait is reported on its own.
 *
 * The turn is passed in, never read from the variable: the caller has awaited
 * a clock read by then, and the turn may have ended while it waited.
 */
function measureOf(turn: Live, now: number): StepStats {
  const streamMs = turn.streamMs + (turn.stepFirstAt !== null ? now - turn.stepFirstAt : 0)
  const tps = turn.outputTokens > 0 && streamMs > 0 ? turn.outputTokens / (streamMs / 1000) : null

  return {
    ttftMs: turn.firstWaitMs === null ? null : Math.round(turn.firstWaitMs),
    tps: tps === null ? null : Math.round(tps * 10) / 10,
    outputTokens: turn.outputTokens > 0 ? turn.outputTokens : null,
    // Kept to two decimals rather than a whole percent: a session that hits the
    // cache 99.6% of the time should not read as a flat 100%.
    cacheHitPercent:
      turn.inputTokens > 0
        ? Math.round((turn.cacheReadTokens / turn.inputTokens) * 10000) / 100
        : null,
    steps: turn.steps,
    elapsedMs: Math.round(now - turn.startedAt),
    isLive: !turn.isDone,
  }
}

const finite = (field: unknown): number | null =>
  typeof field === 'number' && Number.isFinite(field) ? field : null

/**
 * A value read from `$.state`, made safe to draw. Whatever this mod wrote in an
 * earlier version is still in there — a figure under a `shape` tag this version
 * no longer names, or a record missing a field added since. A drawing hook that
 * trusted the stored shape would throw and leave the band blank, so every read
 * goes through here: a shape wrapper is unwrapped, a value that is not one of
 * ours at all becomes `null` and the band stays the engine's.
 */
function normalizeTurn(raw: unknown): StepStats | null {
  if (raw === null || raw === undefined || typeof raw !== 'object') return null

  const wrapped = raw as { shape?: unknown; value?: unknown }
  if (typeof wrapped.shape === 'string' && 'value' in wrapped) {
    return normalizeTurn(wrapped.value)
  }

  const value = raw as Record<string, unknown>
  if (typeof value.isLive !== 'boolean') return null

  return {
    ttftMs: finite(value.ttftMs),
    tps: finite(value.tps),
    outputTokens: finite(value.outputTokens),
    cacheHitPercent: finite(value.cacheHitPercent),
    steps: finite(value.steps) ?? undefined,
    isLive: value.isLive,
    elapsedMs: finite(value.elapsedMs) ?? 0,
  }
}

function normalizeTotals(raw: unknown): SessionTotals | null {
  if (raw === null || raw === undefined || typeof raw !== 'object') return null

  const wrapped = raw as { shape?: unknown; value?: unknown }
  if (typeof wrapped.shape === 'string' && 'value' in wrapped) {
    return normalizeTotals(wrapped.value)
  }

  const value = raw as Record<string, unknown>
  const turns = finite(value.turns)
  if (turns === null) return null

  return {
    turns,
    steps: finite(value.steps) ?? 0,
    ttftMs: finite(value.ttftMs),
    tps: finite(value.tps),
    outputTokens: finite(value.outputTokens) ?? 0,
    inputTokens: finite(value.inputTokens) ?? 0,
    cacheReadTokens: finite(value.cacheReadTokens) ?? 0,
    cacheHitPercent: finite(value.cacheHitPercent),
    contextPercent: finite(value.contextPercent),
  }
}

/**
 * Adds the turn that just ended to the session's running figures, and reads the
 * context window from the engine's own count.
 *
 * The rate is a weighted mean over the session's stream time, not the mean of
 * its turns' rates: a turn that produced 800 tokens in 4s and one that produced
 * 20 in 1s average to 164 tok/s, not to 205. The first-token wait is a plain
 * mean, because each turn is one wait the person sat through.
 */
function addToTotals(
  previous: SessionTotals | null,
  turn: StepStats,
  contextPercent: number | null,
): SessionTotals {
  const base: SessionTotals = previous ?? {
    turns: 0,
    steps: 0,
    ttftMs: null,
    tps: null,
    outputTokens: 0,
    inputTokens: 0,
    cacheReadTokens: 0,
    cacheHitPercent: null,
    contextPercent: null,
  }

  const turnTps = turn.tps ?? null
  const turnOutput = turn.outputTokens ?? 0
  const turnStreamMs = turnTps !== null && turnTps > 0 ? (turnOutput / turnTps) * 1000 : 0

  const outputTokens = base.outputTokens + turnOutput
  const inputTokens = base.inputTokens + (live?.inputTokens ?? 0)
  const cacheReadTokens = base.cacheReadTokens + (live?.cacheReadTokens ?? 0)
  const previousStreamMs = base.tps !== null && base.outputTokens > 0 ? (base.outputTokens / base.tps) * 1000 : 0

  // A turn with no first-token figure (aborted before any token) does not pull
  // the average down; it simply is not one of the waits.
  const waited = turn.ttftMs ?? null
  const previousWaits = base.ttftMs === null ? 0 : Math.round(base.ttftMs * base.turns)

  return {
    turns: base.turns + 1,
    steps: base.steps + (turn.steps ?? 0),
    ttftMs:
      waited === null
        ? base.ttftMs
        : Math.round((previousWaits + waited) / (base.turns + 1)),
    tps:
      outputTokens > 0 && previousStreamMs + turnStreamMs > 0
        ? Math.round((outputTokens / ((previousStreamMs + turnStreamMs) / 1000)) * 10) / 10
        : null,
    outputTokens,
    inputTokens,
    cacheReadTokens,
    cacheHitPercent:
      inputTokens > 0 ? Math.round((cacheReadTokens / inputTokens) * 10000) / 100 : null,
    contextPercent: contextPercent ?? base.contextPercent,
  }
}

export const register: Register = on => {
  /**
   * The transcript's absolute path, built once per session from the session's
   * own cwd and id: the whole history is one file, so the totals come from
   * there rather than from this mod's running sum.
   *
   * `classic.Stop` would carry the path exactly, but it is not hooked here: a
   * `classic.*` hook is a settings hook event, and the built-in security mod
   * runs first and sends those past every installed plugin's.
   */
  let transcriptPath: string | null = null

  /**
   * This session's id, kept so a figure stored by `$.store` can be told from
   * one another session left there.
   *
   * `$.state` dies with the session, and the last turn's figures with it. The
   * band remembering them across a restart is worth the extra step, but only
   * for the same transcript: a session that resumed this one goes on with the
   * same id, while `/clear` and a new conversation get a new one, and a figure
   * measured elsewhere must not be drawn as this conversation's.
   */
  let sessionId: string | null = null

  on('session.start', async ($, e, next) => {
    // `$.session.id()` is the transcript file's name; `e.cwd` names its folder.
    const home = (await $.env.get('HOME')) ?? ''
    const id = await $.session.id()
    sessionId = id
    transcriptPath = transcriptPathOf(home, e.cwd, id)

    await $.command.register({
      name: 'turn-stats',
      description: 'Show or hide the session totals in the band',
    })

    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    if (e.agentId !== undefined) {
      // A subagent's turn is not what the band reports on.
      return next(e)
    }

    live = blankTurn(e.turnId, await $.clock.now())

    return next(e)
  })

  // One model request of the turn: its wait and its tokens join the turn's.
  on('turn.step', async function* ($, e, next) {
    if (e.agentId !== undefined) {
      // A subagent's step is not what the band reports on.
      return yield* next(e)
    }

    if (live === null || live.turnId !== e.turnId) {
      // The start was missed (a reload between the two): measure from here.
      live = blankTurn(e.turnId, await $.clock.now())
    }

    // The step before this one ended without its stop chunk reaching us.
    const stepNow = await $.clock.now()
    if (live === null) return yield* next(e)
    closeStepOf(live, stepNow)
    live.stepStartedAt = stepNow
    live.steps += 1

    // A redraw a second, so the wait and the rate move while the turn runs.
    const tick = $.clock.every(1000, () => $.ui.invalidate('ui.render'))

    // This step's own output tokens, so the result's count is not added twice.
    let counted = 0

    try {
      const stream = next(e)
      for await (const chunk of stream) {
        if (live !== null && live.stepFirstAt === null && chunk.kind !== 'engine' && chunk.kind !== 'stop') {
          // Text, thinking, a tool call or its arguments: the model has answered.
          const firstNow = await $.clock.now()
          if (live !== null && live.stepFirstAt === null && live.stepStartedAt !== null) {
            live.stepFirstAt = firstNow
            live.firstWaitMs ??= firstNow - live.stepStartedAt
          }
        }
        if (live !== null && chunk.kind === 'stop' && chunk.usage !== null) {
          // The turn's own size and its own cache share, for the band while it
          // runs. The session's totals come from the transcript instead, so
          // nothing is summed here that would count the same tokens twice.
          counted = chunk.usage.output_tokens ?? 0
          live.outputTokens += counted
          addUsage(live, chunk.usage)
        }
        yield chunk
      }

      const result = await stream.result

      if (live !== null) {
        // A step whose stop chunk never reached the loop above still knows its
        // size from the result; add it only if the stop did not already.
        const usage = result?.usage
        if (counted === 0 && usage != null) {
          live.outputTokens += usage.output_tokens ?? 0
          addUsage(live, usage)
        }
        closeStepOf(live, await $.clock.now())
      }

      return result
    } finally {
      tick.cancel()
      if (live !== null) closeStepOf(live, await $.clock.now())
    }
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId !== undefined || live === null || live.turnId !== e.turnId) {
      return next(e)
    }

    const turn = live
    const now = await $.clock.now()
    closeStepOf(turn, now)
    turn.isDone = true

    // What the API reported for the whole turn is the authority on its size;
    // the summed stream's own count stands when it is absent.
    const reported = e.usage?.output_tokens
    if (reported !== undefined && reported > 0) {
      turn.outputTokens = reported
    }

    const done = { ...measureOf(turn, now), isLive: false }

    // The session's figures come from the transcript, so they cover the whole
    // session rather than only the turns this mod happened to see. The averages
    // are this mod's own: the file records tokens, not how long the person
    // waited, so the waits and the rates are the ones measured here.
    const held = await read($, totals)
    const usage = await $.session.usage()
    const sum =
      transcriptPath === null
        ? null
        : await $.process.run(transcriptArgv(transcriptPath)).then(
            ({ exitCode, stdout }) => parseTranscriptSum(exitCode, stdout),
            () => null,
          )
    const averaged = addToTotals(normalizeTotals(held), done, usage.context.percent ?? null)
    const nextTotals =
      sum === null
        ? averaged
        : totalsFrom(
            sum,
            averaged.turns,
            averaged.steps,
            { ttftMs: averaged.ttftMs, tps: averaged.tps },
            usage.context.percent ?? null,
          )

    // Only clear it if it is still this turn: a step that arrived while the
    // clock was read may have started the next one.
    if (live === turn) live = null
    await update($, last, () => done)
    await update($, totals, () => nextTotals)

    // `$.state` ends with the session, so the same figure goes to `$.store`
    // with the session it belongs to: a restart of this conversation finds it,
    // another conversation's does not.
    if (sessionId !== null) {
      const stored: StoredTurn = { sessionId, turn: done }
      await $.store.set(STORE_KEY, stored)
    }

    return next(e)
  })

  // The same switch the band's button flips, for the prompt's own typing.
  on('command.run', { command: 'turn-stats' }, async $ => {
    const open = await read($, isExpanded)
    await update($, isExpanded, () => !open)

    return { text: open ? 'Turn stats folded.' : 'Turn stats unfolded.' }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)

    // The turn in flight, else the one that finished last. Both are read before
    // any clock call, so neither can be cleared out from under the drawing.
    //
    // `null` here is not a reason to draw nothing: a session that just started
    // has no turn yet, and the way into the session totals must still be there —
    // those come from the transcript and are there from the first response on.
    const turn = live
    let view = turn !== null ? measureOf(turn, await $.clock.now()) : normalizeTurn(await read($, last))

    // A restart empties `$.state` while the conversation goes on. The last turn
    // was also left in `$.store`, under this session's id, so the band can show
    // it again instead of starting blank — and a figure another conversation
    // left there is not this one's, so the id is checked before it is drawn.
    if (view === null && sessionId !== null) {
      view = readStoredTurn(await $.store.get(STORE_KEY), sessionId)
    }

    const { Box, Button, Text } = $.ui.resolve(e)
    const parts: string[] = []

    // Each number says what it measures, so the row reads as a sentence rather
    // than three bare figures. The labels are the whole point: `2.2s / 247.2 /
    // 304` alone does not say which is the wait, the speed and the size.
    if (view !== null) {
      if (view.ttftMs === null || view.ttftMs === undefined) {
        // No token yet: the time so far *is* the wait, still running, so it is
        // said in one breath rather than as a placeholder plus a stray timer.
        if (view.isLive === true) {
          parts.push(`首 token 等待中 ${msText(view.elapsedMs ?? 0)}`)
        }
      } else {
        parts.push(`首 token 等待 ${msText(view.ttftMs)}`)
        if (view.isLive === true) {
          parts.push(`已耗时 ${msText(view.elapsedMs ?? 0)}`)
        } else if (view.tps !== null && view.tps !== undefined && view.outputTokens != null) {
          parts.push(`本轮生成速度 ${view.tps.toFixed(1)} tok/s`)
          parts.push(`本轮共 ${tokText(view.outputTokens)} tok`)
          if (view.cacheHitPercent !== null && view.cacheHitPercent !== undefined) {
            parts.push(`本轮缓存命中 ${percentText(view.cacheHitPercent)}`)
          }
          // Left out rather than drawn as `undefined` when the value predates it.
          if (view.steps !== undefined && view.steps > 0) {
            parts.push(`${view.steps} 步`)
          }
        }
      }
    }

    // Nothing measured and nothing to say about this turn — but the session's
    // own totals may still be there, so the row is drawn with the button alone.
    if (parts.length === 0) {
      parts.push('尚未测量到本轮数据')
    }

    const isOpen = await read($, isExpanded)

    // Unfolded, the session's own arithmetic: the averages this mod measured,
    // over the whole transcript's tokens. Read here, on the way in, so they are
    // as the file stands now; nothing is stored — a drawing hook may not write.
    let details: Array<[string, string]> = []
    if (isOpen) {
      const held = normalizeTotals(await read($, totals))
      const usage = await $.session.usage()
      const sum =
        transcriptPath === null
          ? null
          : await $.process.run(transcriptArgv(transcriptPath)).then(
              ({ exitCode, stdout }) => parseTranscriptSum(exitCode, stdout),
              () => null,
            )
      const all =
        sum === null
          ? held
          : totalsFrom(
              sum,
              held?.turns ?? 0,
              held?.steps ?? 0,
              { ttftMs: held?.ttftMs ?? null, tps: held?.tps ?? null },
              usage.context.percent ?? null,
            )

      // Nothing measured and nothing in the file: there is no total to draw,
      // and eight rows of dashes would say less than one line does.
      if (all === null || (all.turns === 0 && all.outputTokens === 0 && all.inputTokens === 0)) {
        details = [['会话统计', '还没有可统计的数据']]
      } else {
        details = [
          ['轮次 / 步数', `${all.turns} 轮 ${all.steps} 步`],
          ['首 token 平均', all.ttftMs === null ? '—' : msText(all.ttftMs)],
          ['平均输出速度', all.tps === null ? '—' : `${all.tps.toFixed(1)} tok/s`],
          // The two parts first, then what they add up to: input is what every
          // request was answered over (cached and uncached alike), output is
          // what the model wrote, and the total is the session's whole traffic.
          ['输出 token', tokText(all.outputTokens)],
          ['输入 token', tokText(all.inputTokens)],
          ['总 token', tokText(all.outputTokens + all.inputTokens)],
          ['缓存读取', tokText(all.cacheReadTokens)],
          // The band above shows the turn's own hit; this one is the session's,
          // measured over every input token the whole transcript was answered
          // over — a token-weighted mean, so a long turn counts for more.
          ['平均缓存命中', all.cacheHitPercent === null ? '—' : percentText(all.cacheHitPercent)],
          ['上下文占用', usage.context.percent === undefined ? '—' : `${usage.context.percent}%`],
        ]
      }
    }

    return (
      <Box flexDirection="column">
        {/* The turn's line keeps the full width, so the toggle sits at its end
            rather than crowding the figures. */}
        <Box gap={1}>
          <Text color="claude">⚡</Text>
          <Box flexGrow={1}>
            <Text color="subtle">{parts.join(' · ')}</Text>
          </Box>
          <Button
            key="details"
            label={isOpen ? '收起统计' : '会话统计'}
            plain
            dimColor
            onPress={() => update($, isExpanded, open => !open)}
          />
        </Box>
        {/* Unfolded, the totals hang under the line behind a quote bar, inset
            from it: one block, not eight loose rows. */}
        {isOpen && (
          <Box
            flexDirection="column"
            marginTop={1}
            paddingLeft={2}
            borderStyle="quote"
            borderColor="subtle"
          >
            {details.map(([label, value]) => (
              <Box key={label} gap={2}>
                {/* One width for every label, so the values line up whatever
                    the label's own length — CJK glyphs take two cells each. */}
                <Box width={14}>
                  <Text dimColor>{label}</Text>
                </Box>
                <Text>{value}</Text>
              </Box>
            ))}
          </Box>
        )}
      </Box>
    )
  })
}
