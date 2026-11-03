/**
 * One turn's numbers, summed across the steps it took.
 *
 * A turn that calls tools runs the model more than once, and the band reports
 * on the turn rather than on the last request in it.
 *
 * `ttftMs` is the first step's wait from its request going out to the first
 * piece of the answer — the wait the person sat through; `null` until that
 * piece arrives.
 * `tps` is how fast the model wrote: output tokens over the time pieces were
 * arriving. It is only reported once the turn ends — timing the pieces as they
 * arrive measures a buffering gateway, not the model.
 *
 * `outputTokens` is what the rate was taken over, `steps` how many model
 * requests the turn made, `elapsedMs` how long the turn ran, and `isLive`
 * whether it is still running.
 *
 * Every field is optional on read: a value this mod wrote in an earlier version
 * is still in `$.state`, and a drawing hook that trusted it would throw.
 */
export type StepStats = {
  ttftMs?: number | null
  /** Output rate while the model was writing; reported once the turn ends. */
  tps?: number | null
  /*
   * The window `tps` was taken over: tokens and the time they took, both from
   * the steps that finished. They travel with the rate so a session mean never
   * has to reconstruct the duration from `outputTokens / tps` — that division
   * mixes the API's turn total with a rate measured over the step sums.
   */
  streamMs?: number | null
  settledTokens?: number | null
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
  /** The transcript's turn count — shown, and not what the means divide by. */
  turns: number
  steps: number
  /** Mean wait over the turns this mod measured; see `waitedTurns`. */
  ttftMs: number | null
  /** Mean model rate over the turns this mod measured; see `streamMs`. */
  tps: number | null

  /*
   * The numbers the two means are taken over, kept as sums rather than as a
   * running mean. `turns` and `steps` above are the transcript's own counts and
   * cover the whole session; a mean cannot be divided by them, and deriving a
   * duration from `outputTokens / tps` mixed the file's totals with this mod's
   * rates — when `tps` was null the duration collapsed to zero and the next
   * average read as 6600 tok/s.
   */
  waitedTurns?: number
  waitedMs?: number
  ratedTurns?: number
  streamMs?: number
  ratedTokens?: number
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
