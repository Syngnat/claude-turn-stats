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
  /**
   * When the last piece of the answer arrived. The stream time runs to here,
   * not to "now": a model that pauses — thinking, or waiting on a tool — would
   * otherwise add idle seconds to the denominator and drag the rate to zero
   * while nothing was being generated.
   */
  lastChunkAt: number | null
  firstWaitMs: number | null
  /** Stream time of the steps that have finished. */
  streamMs: number
  /**
   * Output tokens produced during `streamMs` — only the finished steps. The step
   * in flight's tokens are counted as they settle, but its time is not yet a
   * closed window, so pairing the two would report a rate over a window that has
   * not ended. Kept apart so the rate is always tokens over the time they took.
   */
  settledTokens: number
  /** Every token of the turn so far, finished steps and the one in flight. */
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
 * What `$.store` keeps between sessions: the last turn's figures and the
 * session's own running totals, both filed under the session they were measured
 * in.
 *
 * Both are here because both die with `$.state`. The transcript brings back the
 * token counts on its own, but it records no turn boundaries and no waiting, so
 * `轮次 / 步数` and the averages have nowhere else to come from — without this
 * a restarted band read `0 轮 0 步` beside a real token total.
 *
 * A store entry that names another session is not this conversation's, and one
 * written by an older version may hold any shape at all — both read as nothing.
 */
type StoredSession = { sessionId: string; turn: StepStats | null; totals: SessionTotals | null }

function readStoredSession(raw: unknown, sessionId: string | null): StoredSession | null {
  if (sessionId === null || raw === null || typeof raw !== 'object') return null

  const held = raw as Partial<StoredSession>
  if (held.sessionId !== sessionId) return null

  return {
    sessionId,
    turn: normalizeTurn(held.turn),
    totals: normalizeTotals(held.totals),
  }
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
    lastChunkAt: null,
    firstWaitMs: null,
    streamMs: 0,
    settledTokens: 0,
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
function closeStepOf(turn: Live | null, now: number, stepTokens = 0): void {
  if (turn === null || turn.stepStartedAt === null) return

  // To the last chunk, never to `now`: the gap after the last piece is the
  // model idle, not time spent generating, and counting it lowered the rate.
  const end = turn.lastChunkAt ?? turn.stepFirstAt
  if (turn.stepFirstAt !== null && end !== null) {
    turn.streamMs += Math.max(0, end - turn.stepFirstAt)
    // The tokens of this step and the time they took go together, so a rate can
    // be taken over the closed steps alone while the next one runs.
    turn.settledTokens += stepTokens
  }
  turn.stepStartedAt = null
  turn.stepFirstAt = null
  turn.lastChunkAt = null
}

/**
 * What the turn has come to as of `now`. The rate is the turn's output tokens
 * over the turn's whole stream time, both summed across its steps, with the
 * first step's first-token wait left out — that wait is reported on its own.
 *
 * The turn is passed in, never read from the variable: the caller has awaited
 * a clock read by then, and the turn may have ended while it waited.
 */

/**
 * The fastest output a model is likely to sustain. A local Ollama host really
 * does reach 280–500 tok/s, so the ceiling sits well above that rather than at
 * what a hosted API averages.
 *
 * A reading above it is not a fast model: it is the window being wrong. A
 * gateway that buffers a response delivers every piece in one burst, so the
 * first and last arrive milliseconds apart while the tokens took seconds to
 * make — 420 tokens seen over 17 ms reads as 24,700 tok/s, which no model does.
 */
const IMPLAUSIBLE_TPS = 1500

/**
 * The turn's output rate, measured over the time pieces were arriving.
 *
 * That window is the honest one for a stream that arrives as it is produced, and
 * it freezes instead of sliding while the model pauses. It is also blind to a
 * buffered stream, where every piece lands at once: the window collapses to a
 * few milliseconds and the rate runs to tens of thousands. Rather than clamp the
 * figure — which would report a number that never happened — the window is
 * swapped for the turn's own elapsed time, which the buffer cannot shrink, and
 * the rate is taken over that. The result is the end-to-end rate: what the
 * session actually got out per second of the turn.
 */
function rateOf(turn: Live): number | null {
  // Over the steps that have finished, and only those: their tokens and the
  // time they took are both closed figures. The step in flight has tokens but
  // no finished window, and pairing the two would report a rate over a window
  // that is still growing — the error that made the figure slide or explode.
  if (turn.settledTokens <= 0 || turn.streamMs <= 0) return null

  const rate = turn.settledTokens / (turn.streamMs / 1000)

  // Above what any model sustains: the pieces arrived in a burst, so the window
  // is not a measure of generation. Report nothing rather than a number that
  // means something else — a silent swap of the measurement is worse than a
  // blank, because the figure looks ordinary and is not the same thing.
  return rate <= IMPLAUSIBLE_TPS ? rate : null
}

function measureOf(turn: Live, now: number): StepStats {
  // Only closed steps feed the rate: their tokens and their time are both
  // final. The step in flight has tokens but no finished window.
  const tps = rateOf(turn)

  return {
    ttftMs: turn.firstWaitMs === null ? null : Math.round(turn.firstWaitMs),
    // The model's own rate, from the stream window.
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
    waitedTurns: finite(value.waitedTurns) ?? undefined,
    waitedMs: finite(value.waitedMs) ?? undefined,
    ratedTurns: finite(value.ratedTurns) ?? undefined,
    streamMs: finite(value.streamMs) ?? undefined,
    ratedTokens: finite(value.ratedTokens) ?? undefined,
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

  // The means are taken over their own sums. `previous.turns` is the transcript's
  // count of the whole session and says nothing about how many turns this mod sat
  // through, so dividing by it (or deriving a duration from `outputTokens / tps`,
  // which mixed the file's totals with this mod's rates) gave a figure in the
  // thousands once a turn arrived with no rate to average in.
  const waitedTurns = base.waitedTurns ?? 0
  const waitedMs = base.waitedMs ?? 0
  const ratedTurns = base.ratedTurns ?? 0
  const streamMs = base.streamMs ?? 0
  const ratedTokens = base.ratedTokens ?? 0

  const turnTps = turn.tps ?? null
  const turnOutput = turn.outputTokens ?? 0
  const turnStreamMs = turnTps !== null && turnTps > 0 ? (turnOutput / turnTps) * 1000 : 0
  const waited = turn.ttftMs ?? null

  // A turn with no first-token figure (aborted before any token) does not pull
  // the average down; it simply is not one of the waits. Same for a turn with no
  // rate: it adds nothing to either sum.
  const nextWaitedTurns = waited === null ? waitedTurns : waitedTurns + 1
  const nextWaitedMs = waited === null ? waitedMs : waitedMs + waited
  const nextRatedTurns = turnStreamMs > 0 ? ratedTurns + 1 : ratedTurns
  const nextStreamMs = streamMs + turnStreamMs
  const nextRatedTokens = ratedTokens + (turnStreamMs > 0 ? turnOutput : 0)

  const inputTokens = base.inputTokens + (live?.inputTokens ?? 0)
  const cacheReadTokens = base.cacheReadTokens + (live?.cacheReadTokens ?? 0)

  return {
    turns: base.turns + 1,
    steps: base.steps + (turn.steps ?? 0),
    ttftMs: nextWaitedTurns === 0 ? null : Math.round(nextWaitedMs / nextWaitedTurns),
    tps:
      nextStreamMs > 0 && nextRatedTokens > 0
        ? Math.round((nextRatedTokens / (nextStreamMs / 1000)) * 10) / 10
        : null,
    waitedTurns: nextWaitedTurns,
    waitedMs: nextWaitedMs,
    ratedTurns: nextRatedTurns,
    streamMs: nextStreamMs,
    ratedTokens: nextRatedTokens,
    outputTokens: base.outputTokens + turnOutput,
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
        if (live !== null && chunk.kind !== 'engine' && chunk.kind !== 'stop') {
          // A piece of the answer: the stream clock runs to each one, so a pause
          // between two of them is not counted as time spent generating.
          const now = await $.clock.now()
          if (live !== null) {
            live.lastChunkAt = now
            if (live.stepFirstAt === null && live.stepStartedAt !== null) {
              live.stepFirstAt = now
              live.firstWaitMs ??= now - live.stepStartedAt
            }
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
          counted = usage.output_tokens ?? 0
          live.outputTokens += counted
          addUsage(live, usage)
        }
        // The step's own tokens go with its own time, so the rate covers only
        // windows that have closed.
        closeStepOf(live, await $.clock.now(), counted)
      }

      return result
    } finally {
      tick.cancel()
      // Already closed above when the stream ran to its end; this covers a throw.
      if (live !== null) closeStepOf(live, await $.clock.now(), counted)
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

    // The end-to-end rate is measured from the transcript below; it lands on the
    // same record so the line above the prompt can show both rates, not one.
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
            {
              ttftMs: averaged.ttftMs,
              tps: averaged.tps,
              waitedTurns: averaged.waitedTurns,
              waitedMs: averaged.waitedMs,
              ratedTurns: averaged.ratedTurns,
              streamMs: averaged.streamMs,
              ratedTokens: averaged.ratedTokens,
            },
            usage.context.percent ?? null,
            null,
          )

    // Only clear it if it is still this turn: a step that arrived while the
    // clock was read may have started the next one.
    if (live === turn) live = null
    await update($, last, () => done)
    await update($, totals, () => nextTotals)

    // `$.state` ends with the session, so what it holds goes to `$.store` too,
    // with the session it belongs to: a restart of this conversation finds it,
    // another conversation's does not.
    if (sessionId !== null) {
      const stored: StoredSession = { sessionId, turn: done, totals: nextTotals }
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

    // A restart empties `$.state` while the conversation goes on. What it held
    // was also left in `$.store`, under this session's id, so the band and the
    // unfolded totals can come back instead of starting blank — and a figure
    // another conversation left there is not this one's, so the id is checked.
    let restored: StoredSession | null = null
    if (view === null && sessionId !== null) {
      restored = readStoredSession(await $.store.get(STORE_KEY), sessionId)
      view = restored?.turn ?? null
    }

    const { Box, Button, Text } = $.ui.resolve(e)

    // Each part says what it measures, so the row reads as a sentence rather
    // than three bare figures. One part per segment, each knowing whether it is
    // one of the two read first — those draw in the accent colour here as well
    // as in the fold, so the same figure looks the same in both places.
    type Part = { text: string; isKey: boolean }
    const parts: Part[] = []
    const add = (text: string, isKey = false) => parts.push({ text, isKey })

    if (view !== null) {
      if (view.ttftMs === null || view.ttftMs === undefined) {
        // No token yet: the time so far *is* the wait, still running, so it is
        // said in one breath rather than as a placeholder plus a stray timer.
        if (view.isLive === true) {
          add(`首 token 等待中 ${msText(view.elapsedMs ?? 0)}`)
        }
      } else {
        add(`首 token 等待 ${msText(view.ttftMs)}`)
        // From the steps that have finished: their tokens and their time are both
        // closed figures, so the rate does not slide while the next step runs and
        // does not change what it measures partway. It appears as soon as one
        // step is done — during a long turn that is the first useful reading.
        if (view.tps !== null && view.tps !== undefined) {
          add(`模型 ${view.tps.toFixed(1)} tok/s`, true)
        }
        // The size and the cache share are only final once the turn is: while it
        // runs they are a running tally, so they are named as one.
        if (view.outputTokens != null) {
          add(view.isLive === true ? `已生成 ${tokText(view.outputTokens)} tok` : `本轮共 ${tokText(view.outputTokens)} tok`)
        }
        // The cache share is a running figure too: it moves as each response
        // comes back, and it is one of the two worth watching mid-turn.
        if (view.cacheHitPercent !== null && view.cacheHitPercent !== undefined) {
          add(`本轮缓存命中 ${percentText(view.cacheHitPercent)}`, true)
        }
        if (view.isLive === true) {
          add(`已耗时 ${msText(view.elapsedMs ?? 0)}`)
        }
        // Left out rather than drawn as `undefined` when the value predates it.
        if (view.steps !== undefined && view.steps > 0) {
          add(`${view.steps} 步`)
        }
      }
    }

    // Nothing measured and nothing to say about this turn — but the session's
    // own totals may still be there, so the row is drawn with the button alone.
    if (parts.length === 0) {
      add('尚未测量到本轮数据')
    }

    const isOpen = await read($, isExpanded)

    // Unfolded, the session's own arithmetic: the averages this mod measured,
    // over the whole transcript's tokens. Read here, on the way in, so they are
    // as the file stands now; nothing is stored — a drawing hook may not write.
    // Each row carries whether it is one of the two figures the person reads
    // first: those labels are drawn in the accent colour, the rest dim.
    let details: Array<[string, string, boolean]> = []
    if (isOpen) {
      // `$.state` first, then what the store kept from before a restart: the
      // transcript alone cannot say how many turns ran or how long they waited.
      const held = normalizeTotals(await read($, totals)) ?? restored?.totals ?? null
      const usage = await $.session.usage()
      const sum =
        transcriptPath === null
          ? null
          : await $.process.run(transcriptArgv(transcriptPath)).then(
              ({ exitCode, stdout }) => parseTranscriptSum(exitCode, stdout),
              () => null,
            )
      // The rate is the transcript's own, not the stream's: a buffering gateway
      // makes the pieces arrive in a burst, and no window inside one response
      // can say how fast the tokens were produced. The gaps between responses
      // are real, so the rate comes from there.
      const all =
        sum === null
          ? held
          : totalsFrom(
              sum,
              {
                ttftMs: held?.ttftMs ?? null,
                tps: held?.tps ?? null,
                waitedTurns: held?.waitedTurns,
                waitedMs: held?.waitedMs,
                ratedTurns: held?.ratedTurns,
                streamMs: held?.streamMs,
                ratedTokens: held?.ratedTokens,
              },
              usage.context.percent ?? null,
              // The turn in flight has run steps the file may not hold yet.
              (held?.steps ?? 0) + (live?.steps ?? 0) > sum.responses
                ? (held?.steps ?? 0) + (live?.steps ?? 0)
                : null,
            )
      // While a turn runs, the file lags it: a response's row is written as the
      // response settles, so what the turn has done so far is only in `live`.
      // Without this the totals sat still for the whole of a long turn.
      //
      // Only the part the file does not hold yet is added. The file is read a
      // moment ago, and its last rows may already include some of this turn's
      // responses; adding `live` whole would count those twice. Steps the file
      // has are compared with the steps counted here, and the difference is what
      // is still missing.
      const allMeasured = all
      const running = live !== null && !live.isDone
      const runningTps = running && live !== null ? measureOf(live, await $.clock.now()).tps : null
      const liveWait = live?.firstWaitMs ?? null
      const liveOut = live?.outputTokens ?? 0

      // The session's rate is a weighted mean over stream time; the turn in
      // flight joins it the same way, not as a plain replacement.
      const sessionStreamMs =
        allMeasured?.tps != null && allMeasured.tps > 0
          ? (allMeasured.outputTokens / allMeasured.tps) * 1000
          : 0
      const liveStreamMs = runningTps != null && runningTps > 0 ? (liveOut / runningTps) * 1000 : 0
      const mergedTps =
        sessionStreamMs + liveStreamMs > 0
          ? Math.round(
              ((allMeasured!.outputTokens + liveOut) / ((sessionStreamMs + liveStreamMs) / 1000)) * 10,
            ) / 10
          : allMeasured?.tps ?? null
      const waitedBefore =
        allMeasured?.ttftMs != null ? Math.round(allMeasured.ttftMs * allMeasured.turns) : 0
      const mergedWait =
        liveWait != null && allMeasured !== null
          ? Math.round((waitedBefore + liveWait) / (allMeasured.turns + 1))
          : allMeasured?.ttftMs ?? null

      // The band above may be showing a wait this mod did not measure itself:
      // it falls back to the stored turn, and `live` is still null when a reload
      // lands mid-turn. The fold reads the same figure from the same place, so
      // the two never disagree — a rate on the line and a dash underneath.
      const fallbackWait = restored?.turn?.ttftMs ?? null
      const fallbackTps = restored?.turn?.tps ?? null

      const heldSteps = allMeasured?.steps ?? 0
      const liveSteps = live?.steps ?? 0
      const missingSteps = Math.max(0, liveSteps - heldSteps)

      // The counts and the averages are handled apart, because only the counts
      // can be double-counted by the file. The file may hold every step of the
      // turn in flight, so `missingSteps` is often 0 — and gating the averages
      // on it left them blank for a turn the file had caught up with, while the
      // band above already showed its rate.
      // `all` wins when it already has averages; the fallbacks only fill a gap,
      // so a session whose file is complete still reads its own numbers.
      const shown =
        allMeasured === null
          ? allMeasured
          : {
              ...allMeasured,
              // A turn the file has not seen at all is still one turn; one it
              // has seen is already counted there.
              turns: running ? allMeasured.turns + (heldSteps === 0 ? 1 : 0) : allMeasured.turns,
              steps: running ? allMeasured.steps + missingSteps : allMeasured.steps,
              // The averages take the turn in flight in, so they move while it
              // runs instead of waiting for it to end. Both are merged the way
              // the session's own are: the wait by turn count, the rate by the
              // stream time each was measured over. Failing that, the last turn
              // this mod measured — the same figure the band above is showing.
              ttftMs: running ? (mergedWait ?? allMeasured.ttftMs) : (allMeasured.ttftMs ?? fallbackWait),
              // The transcript's measured rate wins whenever there is one: the
              // stream has no window that a buffering gateway cannot shrink.
              tps: allMeasured.tps ?? (running ? mergedTps : fallbackTps),
            }

      // Nothing measured and nothing in the file: there is no total to draw,
      // and eight rows of dashes would say less than one line does.
      if (shown === null || (shown.turns === 0 && shown.outputTokens === 0 && shown.inputTokens === 0)) {
        details = [['会话统计', '还没有可统计的数据', false]]
      } else {
        details = [
          // What was measured, in the order it was measured: how much ran, how
          // long the first token took, how fast the rest came.
          ['轮次 / 步数', `${shown.turns} 轮 ${shown.steps} 步`, false],
          ['首 token 平均', shown.ttftMs === null ? '—' : msText(shown.ttftMs), false],
          // The model's rate and the turn's, the same pair the line above shows.
          // The model's own rate cannot be recovered from the file: it records
          // when each response settled, not how long the model took to write it.
          // What survives is the turn's average across the turns this mod saw —
          // the turns before it was installed are only in the token counts.
          ['平均模型速度', shown.tps == null ? '—' : `${shown.tps.toFixed(1)} tok/s`, true],
          // Then the four figures that are all one thing — the session's tokens:
          // what went in, how much of that the cache served, what came out, and
          // what the whole traffic adds up to. Grouped, because read apart they
          // look like four unrelated numbers.
          ['输入 token', tokText(shown.inputTokens), false],
          ['缓存读取', tokText(shown.cacheReadTokens), false],
          ['输出 token', tokText(shown.outputTokens), false],
          ['总 token', tokText(shown.outputTokens + shown.inputTokens), false],
          // The band above shows the turn's own hit; this one is the session's,
          // measured over every input token the whole transcript was answered
          // over — a token-weighted mean, so a long turn counts for more.
          ['平均缓存命中', shown.cacheHitPercent === null ? '—' : percentText(shown.cacheHitPercent), true],
          ['上下文占用', usage.context.percent === undefined ? '—' : `${usage.context.percent}%`, false],
        ]
      }
    }

    // One column when the band is narrow, two when it can hold them: a 14-cell
    // label column, a value column, and four cells between. Below that width
    // the second column would wrap, which reads worse than a longer list.
    const COLUMN_CELLS = 14 + 10 + 4 + 4
    const columns: Array<Array<[string, string, boolean]>> = []
    if (details.length > 0) {
      if (e.props.bodyColumns >= COLUMN_CELLS * 2 && details.length > 4) {
        // Split by what each column is about, not at the halfway mark: the
        // turn's pacing and the two whole-session figures on the left, every
        // token count on the right. Splitting by count cut the token group in
        // two and left one column taller than the other.
        // `平均缓存命中` rides with them: it is a share of those tokens, and it
        // keeps the two columns within one row of each other.
        const tokenLabels = new Set([
          '输入 token',
          '缓存读取',
          '输出 token',
          '总 token',
          '平均缓存命中',
        ])
        const left = details.filter(([label]) => !tokenLabels.has(label))
        const right = details.filter(([label]) => tokenLabels.has(label))
        columns.push(left, right)
      } else {
        columns.push(details)
      }
    }

    return (
      <Box flexDirection="column">
        {/* The turn's line keeps the full width, so the toggle sits at its end
            rather than crowding the figures. */}
        <Box gap={1}>
          <Text color="claude">⚡</Text>
          <Box flexGrow={1}>
            {parts.map((part, at) => (
              <Text key={`part-${at}`} color={part.isKey ? 'claude' : 'subtle'} bold={part.isKey}>
                {at === 0 ? part.text : ` · ${part.text}`}
              </Text>
            ))}
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
            from it: one block, not eight loose rows. Wide enough for two, they
            take two — a single column of eight leaves half the band empty. */}
        {isOpen && (
          <Box
            marginTop={1}
            paddingLeft={2}
            borderStyle="quote"
            borderColor="subtle"
          >
            {columns.map((column, at) => (
              <Box key={`column-${at}`} flexDirection="column" marginRight={4}>
                {column.map(([label, value, isKey]) => (
                  <Box key={label} gap={2}>
                    {/* One width for every label, so the values line up whatever
                        the label's own length — CJK glyphs take two cells each. */}
                    <Box width={14}>
                      <Text color={isKey ? 'claude' : undefined} dimColor={!isKey}>
                        {label}
                      </Text>
                    </Box>
                    <Text bold={isKey}>{value}</Text>
                  </Box>
                ))}
              </Box>
            ))}
          </Box>
        )}
      </Box>
    )
  })
}
