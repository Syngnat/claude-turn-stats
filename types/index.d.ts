/**
 * One turn's numbers, summed across the steps it took.
 *
 * A turn that calls tools runs the model more than once, and the band reports
 * on the turn rather than on the last request in it.
 *
 * `ttftMs` is the first step's wait from its request going out to the first
 * piece of the answer — the wait the person sat through; `null` until that
 * piece arrives.
 *
 * Two rates are kept, because they answer different questions:
 *
 * - `tps` is how fast the model wrote: output tokens over the time pieces were
 *   arriving, measured in the stream. On a local model this reaches hundreds.
 * - `settledTps` is how fast the turn got its work done: output tokens over the
 *   time between one response settling and the next, read from the transcript.
 *   It is what the session actually delivered per second, waits included.
 *
 * They differ by the network and framework overhead around the model, so both
 * are shown rather than one standing in for the other.
 *
 * `outputTokens` is what both rates were taken over, `steps` how many model
 * requests the turn made, `elapsedMs` how long the turn ran, and `isLive`
 * whether it is still running.
 *
 * Every field is optional on read: a value this mod wrote in an earlier version
 * is still in `$.state`, and a drawing hook that trusted it would throw.
 */
export type StepStats = {
  ttftMs?: number | null
  /** Output rate while the model was writing, from the stream. */
  tps?: number | null
  /** Output rate over the whole turn's settling time, from the transcript. */
  settledTps?: number | null
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
  /** Mean of the turns' model rates, weighted by what each produced. */
  tps: number | null
  /** The same mean over the turns' end-to-end rates, read from the transcript. */
  settledTps?: number | null
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
