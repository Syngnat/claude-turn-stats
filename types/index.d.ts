/**
 * One turn's numbers, summed across the steps it took.
 *
 * A turn that calls tools runs the model more than once, and the band reports
 * on the turn rather than on the last request in it.
 *
 * `ttftMs` is the first step's wait from its request going out to the first
 * piece of the answer — the wait the person sat through; `null` until that
 * piece arrives. `tps` is the turn's output tokens over its whole stream time,
 * every step's stream summed and the first-token waits left out, so the wait is
 * not counted twice. `outputTokens` is what that rate was taken over, `steps`
 * how many model requests the turn made, `elapsedMs` how long the turn ran,
 * and `isLive` whether it is still running.
 *
 * Every field is optional on read: a value this mod wrote in an earlier version
 * is still in `$.state`, and a drawing hook that trusted it would throw.
 */
export type StepStats = {
  ttftMs?: number | null
  tps?: number | null
  outputTokens?: number | null
  /** The share of this turn's input tokens the prompt cache served, 0 to 100. */
  cacheHitPercent?: number | null
  steps?: number
  isLive?: boolean
  elapsedMs?: number
}

/**
 * What the session has come to, summed over the turns this mod measured.
 *
 * `ttftMs` and `tps` are averages: the first-token wait over every turn that
 * reported one, and the output tokens over the stream time they were generated
 * in — so a fast turn and a slow one weigh by what they actually produced.
 * `cacheHitPercent` is the share of input tokens the prompt cache served, and
 * `contextPercent` how full the context window stands.
 */
export type SessionTotals = {
  turns: number
  steps: number
  ttftMs: number | null
  tps: number | null
  outputTokens: number
  inputTokens: number
  cacheReadTokens: number
  cacheHitPercent: number | null
  contextPercent: number | null
}

declare module 'claude-code' {
  interface PluginState {
    /**
     * The turn that finished last, for the band above the prompt.
     *
     * Plain, not `Shaped`: every value this mod has written is readable by the
     * code that follows it. A tag here would decline the stored turn on every
     * reload and leave the band blank until the next one.
     */
    'turn-stats': {
      last: StepStats | null
      totals: SessionTotals | null
      /** Whether the session's totals are unfolded under the band. */
      isExpanded: boolean
    }
  }
}
