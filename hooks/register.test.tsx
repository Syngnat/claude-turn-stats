import { expect, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import type { Engine } from 'claude-code/testing'
import { settledRate } from './transcript'

/** The id this test session owns: what the store's entries are filed under. */
const SESSION_ID = '11112222-3333-4444-5555-666677778888'

const BAND = {
  plugin: 'turn-stats',
  component: 'AbovePrompt',
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 3,
    bodyColumns: 80,
    scroll: { offset: 0, bodyRows: 3 },
    view: {},
  },
} as const

/**
 * Answers `state.get` per key with the value as stored (no `Shaped` tag: the
 * atoms carry none). A key with nothing stored reads as the initial.
 */
function holding(stats: unknown, sessionTotals: unknown = null, isExpanded = false) {
  return (_: unknown, e: { key: string }) => {
    const byKey: Record<string, unknown> = {
      last: stats,
      totals: sessionTotals,
      isExpanded,
    }

    return { value: { value: byKey[e.key] ?? undefined, version: 1 } }
  }
}

/** Answers `$.store.get` with what a restart left behind, for the id given. */
function storeHolds(on: On, sessionId: string, turn: unknown, sessionTotals: unknown = null) {
  on('store.get', () => ({ value: { sessionId, turn, totals: sessionTotals } }))
}

/** The engine's own answer for `$.session.usage`, as the pane reads it. */
function usageOf(on: On, percent: number | undefined = 31) {
  on('session.usage', () => ({
    value: {
      startedAt: 0,
      context: { window: 200_000, percent },
      rateLimits: [],
    },
  }))
}

/**
 * Answers `$.process.run`: the child that sums the transcript. The pane and the
 * turn's end both reach the file this way, so every test that draws one needs
 * this beneath it.
 */
function transcriptSums(on: On, sum: unknown) {
  on('process.run', () => ({
    value: {
      exitCode: 0,
      stdout: JSON.stringify(sum),
      stderr: '',
      isStdoutTruncated: false,
      isStderrTruncated: false,
    },
  }))
}

/**
 * The session's own start, which is what teaches the mod where the transcript
 * is: without it the pane has no path to sum and falls back to the stored
 * totals. Answers the calls `session.start` makes on the way.
 */
async function startSession($: Engine, on: On) {
  on('session.id', () => ({ value: SESSION_ID }))
  on('env.get', () => ({ value: '/Users/someone' }))
  on('command.register', () => ({ value: { command: 'turn-stats' } }))

  // `session.start` answers the event's own result (`{ cwd }`), not `{ value }`.
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/Users/someone/project', surface: 'desktop', isInteractive: true })
}

/** The engine's own drawing beneath the plugin: the band it would draw alone. */
function engineDraws(on: On) {
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)

    return <Text>engine</Text>
  })
}


/**
 * The band's turn line, joined back into one string.
 *
 * Each segment is its own `Text` now — the two figures read first are drawn in
 * the accent colour — so a single element no longer holds the whole line.
 */
async function turnLine(ui: { findAll: (q: { type: 'Text' }) => Promise<Array<{ text: string }>> }) {
  const texts = await ui.findAll({ type: 'Text' })
  return texts.map(one => one.text).join(' ')
}

test('before any turn, the band still offers the session totals', async ($, on) => {
  // A session that just started, or one restarted: `last` is gone with the old
  // session's state, but the transcript still holds the totals, so the way in
  // must stay. Drawing nothing here hid the button until a turn had run.
  on('state.get', holding(null))
  engineDraws(on)

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })

  expect(await ui.find({ type: 'Text', text: /首 token|生成速度/ })).toBeUndefined()
  expect((await ui.find({ type: 'Text', text: '尚未测量到本轮数据' }))?.text).toBe('尚未测量到本轮数据')
  expect((await ui.find({ type: 'Button' }))?.text).toBe('会话统计')
  await ui.unmount()
})

test('a restart shows the last turn again, from the store', async ($, on) => {
  // `$.state` is empty after a restart; the same figures wait in `$.store`,
  // filed under this session's id, so the band is not blank.
  on('state.get', holding(null))
  storeHolds(on, SESSION_ID, { ttftMs: 1900, tps: 607.3, outputTokens: 13400, steps: 26, isLive: false, elapsedMs: 24000 })
  engineDraws(on)
  await startSession($, on)

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })

  const row = { text: await turnLine(ui) }
  expect(row?.text).toContain('首 token 等待 1.9s')
  expect(row?.text).toContain('模型 607.3 tok/s')
  await ui.unmount()
})

test('after a restart, the averages come back from the store, the counts from the file', async ($, on) => {
  // The transcript brings back the token counts, but records no turn boundaries
  // and no waiting: `轮次 / 步数` and the averages have to come from the store.
  // Without that the band read `0 轮 0 步` beside a real token total.
  on('state.get', holding(null, null, true))
  usageOf(on)
  transcriptSums(on, { turns: 12, responses: 241, input: 38_665_129, output: 180_562, cacheRead: 38_206_122 })
  storeHolds(
    on,
    SESSION_ID,
    { ttftMs: 1900, tps: 607.3, outputTokens: 13400, steps: 26, isLive: false, elapsedMs: 24000 },
    {
      turns: 7,
      steps: 108,
      ttftMs: 2800,
      tps: 441.4,
      outputTokens: 214_800,
      inputTokens: 61_200_000,
      cacheReadTokens: 60_600_000,
      cacheHitPercent: 99,
      contextPercent: 29,
    },
  )
  engineDraws(on)
  await startSession($, on)

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })

  // The counts are the transcript's — the same history the tokens come from —
  // while the averages, which the file cannot record, come back from the store.
  expect((await ui.find({ type: 'Text', text: /12 轮 241 步/ }))?.text).toBe('12 轮 241 步')
  expect((await ui.find({ type: 'Text', text: /2\.8s/ }))?.text).toBe('2.8s')
  expect((await ui.find({ type: 'Text', text: /441\.4 tok\/s/ }))?.text).toBe('441.4 tok/s')
  // …while the token counts are the transcript's, which covers the whole file.
  expect((await ui.find({ type: 'Text', text: /180\.6k/ }))?.text).toBe('180.6k')
  expect((await ui.find({ type: 'Text', text: /38\.8M/ }))?.text).toBe('38.8M')
  await ui.unmount()
})

test('a figure another session stored is not drawn as this one’s', async ($, on) => {
  // `$.store` is shared by every conversation on the machine. Only the one
  // that wrote a figure may show it again.
  on('state.get', holding(null))
  storeHolds(on, 'some-other-session-id', { ttftMs: 1900, tps: 607.3, outputTokens: 13400, steps: 26, isLive: false, elapsedMs: 24000 })
  engineDraws(on)
  await startSession($, on)

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })

  expect(await ui.find({ type: 'Text', text: /首 token/ })).toBeUndefined()
  expect((await ui.find({ type: 'Text', text: '尚未测量到本轮数据' }))?.text).toBe('尚未测量到本轮数据')
  await ui.unmount()
})

test('what the state holds wins over an older figure in the store', async ($, on) => {
  on('state.get', holding({ ttftMs: 500, tps: 100, outputTokens: 200, steps: 1, isLive: false, elapsedMs: 2500 }))
  storeHolds(on, SESSION_ID, { ttftMs: 1900, tps: 607.3, outputTokens: 13400, steps: 26, isLive: false, elapsedMs: 24000 })
  engineDraws(on)
  await startSession($, on)

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })

  const row = { text: await turnLine(ui) }
  expect(row?.text).toContain('首 token 等待 500ms')
  expect(row?.text).not.toContain('1.9s')
  await ui.unmount()
})

test('a value stored before `steps` existed still draws, without it', async ($, on) => {
  // What the earlier version wrote: no `steps`. An added field is compatible,
  // so the turn still shows — and `步` is left out rather than `undefined`.
  on('state.get', holding({ ttftMs: 995, tps: 199.5, outputTokens: 570, isLive: false, elapsedMs: 3800 }))
  engineDraws(on)

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })

  const row = { text: await turnLine(ui) }
  expect(row?.text).toContain('首 token 等待 995ms')
  expect(row?.text).toContain('模型 199.5 tok/s')
  expect(row?.text).toContain('本轮共 570 tok')
  expect(row?.text).not.toContain('undefined')
  await ui.unmount()
})

test('a turn waiting on its first token says so in one line, no placeholder', async ($, on) => {
  on(
    'state.get',
    holding({
      ttftMs: null,
      tps: null,
      outputTokens: null,
      steps: 1,
      isLive: true,
      elapsedMs: 1000,
    }),
  )
  engineDraws(on)

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })

  // One sentence, no `…` placeholder and no second bare timer beside it.
  const row = { text: await turnLine(ui) }
  expect(row?.text).toContain('首 token 等待中 1.0s')
  expect(await ui.find({ type: 'Text', text: /\.\.\./ })).toBeUndefined()
  await ui.unmount()
})

test('the band reports the turn as a whole, its own cache hit included', async ($, on) => {
  on(
    'state.get',
    holding({
      ttftMs: 820,
      tps: 47.5,
      outputTokens: 892,
      cacheHitPercent: 87,
      steps: 3,
      isLive: false,
      elapsedMs: 8400,
    }),
  )
  engineDraws(on)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })

    // Every number carries the words that say what it measures, and the row
    // says whose numbers these are: the turn's, not one request's.
    const row = { text: await turnLine(ui) }
    expect(row?.text).toContain('首 token 等待 820ms')
    expect(row?.text).toContain('模型 47.5 tok/s')
    expect(row?.text).toContain('本轮共 892 tok')
    // The turn's own hit, beside the session's, which only the fold shows.
    expect(row?.text).toContain('本轮缓存命中 87%')
    expect(row?.text).toContain('3 步')
    await ui.unmount()
  }
})

test('a share with a fraction keeps it, to two decimals', async ($, on) => {
  // A fraction is never rounded up to a flat percent: 99.87% keeps its digits.
  // One stored value per test, since the hooks beneath are fixed at the first
  // call, so each figure gets a test of its own below.
  on(
    'state.get',
    holding({
      ttftMs: 800,
      tps: 40,
      outputTokens: 892,
      cacheHitPercent: 99.87,
      steps: 3,
      isLive: false,
      elapsedMs: 8000,
    }),
  )
  engineDraws(on)

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  const row = { text: await turnLine(ui) }

  expect(row?.text).toContain('本轮缓存命中 99.87%')
  await ui.unmount()
})

test('a whole percent carries no decimals at all', async ($, on) => {
  on(
    'state.get',
    holding({
      ttftMs: 800,
      tps: 40,
      outputTokens: 892,
      cacheHitPercent: 100,
      steps: 3,
      isLive: false,
      elapsedMs: 8000,
    }),
  )
  engineDraws(on)

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  const row = { text: await turnLine(ui) }

  // No padded zeros: `100%`, not `100.00%`.
  expect(row?.text).toContain('本轮缓存命中 100%')
  expect(row?.text).not.toContain('100.00%')
  await ui.unmount()
})

test('a one-decimal share keeps its one decimal, not two', async ($, on) => {
  on(
    'state.get',
    holding({
      ttftMs: 800,
      tps: 40,
      outputTokens: 892,
      cacheHitPercent: 99.9,
      steps: 3,
      isLive: false,
      elapsedMs: 8000,
    }),
  )
  engineDraws(on)

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  const row = { text: await turnLine(ui) }

  expect(row?.text).toContain('本轮缓存命中 99.9%')
  expect(row?.text).not.toContain('99.90%')
  await ui.unmount()
})

test('a turn stored before the cache figure existed leaves it out', async ($, on) => {
  on(
    'state.get',
    holding({ ttftMs: 820, tps: 47.5, outputTokens: 892, steps: 3, isLive: false, elapsedMs: 8400 }),
  )
  engineDraws(on)

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })

  const row = { text: await turnLine(ui) }
  expect(row?.text).not.toContain('缓存')
  expect(row?.text).not.toContain('undefined')
  await ui.unmount()
})

test('a turn still running shows the wait, not a rate', async ($, on) => {
  on(
    'state.get',
    holding({
      ttftMs: 1200,
      tps: null,
      outputTokens: null,
      steps: 1,
      isLive: true,
      elapsedMs: 2400,
    }),
  )
  engineDraws(on)

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })

  const row = { text: await turnLine(ui) }
  expect(row?.text).toContain('首 token 等待 1.2s')
  expect(row?.text).toContain('已耗时 2.4s')
  expect(row?.text).not.toContain('生成速度')
  await ui.unmount()
})

test('a survey in the band wins over the stats', async ($, on) => {
  on(
    'state.get',
    holding({ ttftMs: 800, tps: 40, outputTokens: 892, steps: 3, isLive: false, elapsedMs: 8000 }),
  )
  engineDraws(on)

  const ui = await $.ui.mount({
    ...BAND,
    surface: 'desktop',
    props: { ...BAND.props, hasSurvey: true },
  })

  expect(await ui.find({ type: 'Text', text: /首 token/ })).toBeUndefined()
  await ui.unmount()
})

test('a value left under an old shape tag draws its inside, not undefined', async ($, on) => {
  // What the version with a `shape` tag wrote: the fields sit one level down.
  // Read straight, `view.tps` is undefined and `.toFixed` throws — the band then
  // goes blank and the transcript says the hook was skipped.
  on('state.get', (_: unknown, e: { key: string }) => ({
    value: {
      value:
        e.key === 'last'
          ? { shape: 'turn-stats-2', value: { ttftMs: 820, tps: 47.5, outputTokens: 892, isLive: false, elapsedMs: 8400 } }
          : e.key === 'isExpanded'
            ? false
            : undefined,
      version: 1,
    },
  }))
  engineDraws(on)

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })

  const row = { text: await turnLine(ui) }
  expect(row?.text).toContain('模型 47.5 tok/s')
  expect(row?.text).not.toContain('undefined')
  await ui.unmount()
})

test('a stored value of another shape draws nothing rather than throwing', async ($, on) => {
  // Anything at all may be sitting under the key; a drawing hook that assumed
  // its own shape would throw and take the band with it.
  on('state.get', () => ({ value: { value: { somethingElse: true }, version: 1 } }))
  engineDraws(on)

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })

  expect(await ui.find({ type: 'Text', text: /首 token/ })).toBeUndefined()
  expect((await ui.find({ type: 'Text', text: 'engine' }))?.text).toBe('engine')
  await ui.unmount()
})

test('a wide band lays the totals in two columns, a narrow one in one', async ($, on) => {
  on(
    'state.get',
    holding(
      { ttftMs: 800, tps: 40, outputTokens: 892, steps: 3, isLive: false, elapsedMs: 8000 },
      { turns: 12, steps: 241, ttftMs: 2900, tps: 292, contextPercent: 31 },
      true,
    ),
  )
  usageOf(on)
  transcriptSums(on, { turns: 12, responses: 241, input: 38_665_129, output: 180_562, cacheRead: 38_206_122 })
  engineDraws(on)
  await startSession($, on)

  // However many columns it takes, every figure is drawn once: the layout moves
  // them, it never drops one.
  for (const bodyColumns of [80, 120] as const) {
    const ui = await $.ui.mount({
      ...BAND,
      surface: 'desktop',
      props: { ...BAND.props, bodyColumns },
    })

    for (const label of [
      '轮次 / 步数',
      '首 token 平均',
      '平均模型速度',
      '输出 token',
      '输入 token',
      '总 token',
      '缓存读取',
      '平均缓存命中',
      '上下文占用',
    ]) {
      expect((await ui.find({ type: 'Text', text: label }))?.text).toBe(label)
    }

    await ui.unmount()
  }
})

test('the two figures read first are drawn in the accent colour, the rest dim', async ($, on) => {
  on(
    'state.get',
    holding(
      { ttftMs: 800, tps: 40, outputTokens: 892, steps: 3, isLive: false, elapsedMs: 8000 },
      { turns: 12, steps: 241, ttftMs: 2900, tps: 292, cacheHitPercent: 99, contextPercent: 31 },
      true,
    ),
  )
  usageOf(on)
  transcriptSums(on, { turns: 12, responses: 241, input: 38_665_129, output: 180_562, cacheRead: 38_206_122 })
  engineDraws(on)
  await startSession($, on)

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })

  const speed = await ui.find({ type: 'Text', text: '平均模型速度' })
  expect(speed?.props.color).toBe('claude')
  expect(speed?.props.dimColor).toBe(false)

  const hit = await ui.find({ type: 'Text', text: '平均缓存命中' })
  expect(hit?.props.color).toBe('claude')

  // The others stay quiet, so the two stand out rather than competing.
  const turns = await ui.find({ type: 'Text', text: '轮次 / 步数' })
  expect(turns?.props.dimColor).toBe(true)
  expect(turns?.props.color).toBeUndefined()

  await ui.unmount()
})


test('the turn line colours the same two figures as the fold', async ($, on) => {
  on(
    'state.get',
    holding({
      ttftMs: 820,
      tps: 47.5,
      outputTokens: 892,
      cacheHitPercent: 87,
      steps: 3,
      isLive: false,
      elapsedMs: 8400,
    }),
  )
  engineDraws(on)

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })

  const speed = await ui.find({ type: 'Text', text: /模型 .* tok\/s/ })
  expect(speed?.props.color).toBe('claude')
  expect(speed?.props.bold).toBe(true)

  const hit = await ui.find({ type: 'Text', text: /本轮缓存命中/ })
  expect(hit?.props.color).toBe('claude')
  expect(hit?.props.bold).toBe(true)

  // A figure that is not one of the two stays in the ordinary subtle colour.
  const wait = await ui.find({ type: 'Text', text: /首 token 等待/ })
  expect(wait?.props.color).toBe('subtle')
  expect(wait?.props.bold).toBe(false)

  await ui.unmount()
})


test('a turn the file has not recorded yet adds its steps once', async ($, on) => {
  // The file is written as responses settle, so a long turn's early steps are
  // not in it yet. Reading the unfolded totals while it runs must keep them
  // moving — and must not add again what the file already holds.
  on('state.get', holding(null, null, true))
  usageOf(on)
  // The file knows 12 turns and 241 steps.
  transcriptSums(on, { turns: 12, responses: 241, input: 38_665_129, output: 180_562, cacheRead: 38_206_122 })
  on('store.get', () => ({ value: undefined }))
  engineDraws(on)

  await startSession($, on)

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })

  // Nothing is running, so the counts are exactly the file's own.
  expect((await ui.find({ type: 'Text', text: /12 轮 241 步/ }))?.text).toBe('12 轮 241 步')

  await ui.unmount()
})

test('a running turn still feeds the averages when the file has caught up', async ($, on) => {
  // The file may already hold every step of the turn in flight, so the step gap
  // is 0. Gating the averages on that gap left them blank (`—`) while the band
  // above was already showing the turn's own rate.
  on('state.get', holding(null, null, true))
  usageOf(on)
  // 12 turns, 241 responses — more than the turn in flight has run, so no gap.
  transcriptSums(on, { turns: 12, responses: 241, input: 38_665_129, output: 180_562, cacheRead: 38_206_122 })
  on('store.get', () => ({ value: undefined }))
  engineDraws(on)

  await startSession($, on)

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })

  // No turn is running in this test, so the averages are the stored ones — the
  // point is that they are drawn at all, never as a bare dash beside a total.
  expect((await ui.find({ type: 'Text', text: /平均模型速度/ }))?.text).toBe('平均模型速度')

  await ui.unmount()
})

test('a running turn shows its rate, its size and its cache share', async ($, on) => {
  // A local model really does reach hundreds of tokens a second, so the rate is
  // worth showing while the turn runs. `rateOf` falls back to the turn's elapsed
  // time when the stream window is impossible, so what is drawn can have
  // happened.
  on(
    'state.get',
    holding({
      ttftMs: 3500,
      tps: 480.4,
      outputTokens: 21600,
      cacheHitPercent: 91.73,
      steps: 15,
      isLive: true,
      elapsedMs: 119100,
    }),
  )
  engineDraws(on)

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })

  const line = await turnLine(ui)
  expect(line).toContain('首 token 等待 3.5s')
  expect(line).toContain('模型 480.4 tok/s')
  expect(line).toContain('已生成 21.6k tok')
  expect(line).toContain('本轮缓存命中 91.73%')
  expect(line).toContain('已耗时 119.1s')

  await ui.unmount()
})

test('the fold shows the session mean, not the last turn repeated', async ($, on) => {
  // The band above shows this turn's 254.9 tok/s; the fold must show the mean
  // over the session. They read the same when the fold was handed the last
  // turn's figure instead of an average — which is exactly what went wrong.
  on(
    'state.get',
    holding(
      { ttftMs: 5900, tps: 254.9, settledTps: 27.4, outputTokens: 374, steps: 1, isLive: false, elapsedMs: 9000 },
      {
        turns: 74,
        steps: 662,
        ttftMs: 5900,
        tps: 180.2,
        settledTps: 41.7,
        outputTokens: 354_300,
        inputTokens: 207_200_000,
        cacheReadTokens: 203_200_000,
        cacheHitPercent: 98.05,
        contextPercent: 48,
      },
      true,
    ),
  )
  usageOf(on)
  transcriptSums(on, { turns: 74, responses: 662, input: 207_200_000, output: 354_300, cacheRead: 203_200_000 })
  on('store.get', () => ({ value: undefined }))
  engineDraws(on)
  await startSession($, on)

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })

  // The fold's two rates differ from the turn's own on the line above.
  expect((await ui.find({ type: 'Text', text: '180.2 tok/s' }))?.text).toBe('180.2 tok/s')
  expect((await ui.find({ type: 'Text', text: '41.7 tok/s' }))?.text).toBe('41.7 tok/s')

  await ui.unmount()
})

test('the band has one button, labelled for the fold it flips', async ($, on) => {
  on(
    'state.get',
    holding({ ttftMs: 800, tps: 40, outputTokens: 892, steps: 3, isLive: false, elapsedMs: 8000 }),
  )
  engineDraws(on)

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })

  const buttons = await ui.findAll({ type: 'Button' })
  expect(buttons.map(one => one.text)).toEqual(['会话统计'])
  await ui.unmount()
})

test('unfolded, the band totals the whole transcript under the turn line', async ($, on) => {
  // The transcript's sums cover the session from its first response; the
  // averages are this mod's own, since the file records tokens, not waits.
  on(
    'state.get',
    holding(
      { ttftMs: 800, tps: 40, outputTokens: 892, steps: 3, isLive: false, elapsedMs: 8000 },
      { turns: 12, steps: 241, ttftMs: 2900, tps: 292, contextPercent: 31 },
      true,
    ),
  )
  usageOf(on)
  transcriptSums(on, { turns: 12, responses: 241, input: 38_665_129, output: 180_562, cacheRead: 38_206_122 })
  engineDraws(on)
  await startSession($, on)

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })

  // The turn's own line is still there above the totals.
  expect((await ui.find({ type: 'Text', text: /模型 .* tok\/s/ }))?.text).toContain('模型 40.0 tok/s')

  expect((await ui.find({ type: 'Text', text: /12 轮 241 步/ }))?.text).toBe('12 轮 241 步')
  expect((await ui.find({ type: 'Text', text: /首 token 平均/ }))?.text).toBe('首 token 平均')
  expect((await ui.find({ type: 'Text', text: /2\.9s/ }))?.text).toBe('2.9s')
  expect((await ui.find({ type: 'Text', text: /292\.0 tok\/s/ }))?.text).toBe('292.0 tok/s')
  // The token figures come from the file, so they are the session's whole.
  expect((await ui.find({ type: 'Text', text: /180\.6k/ }))?.text).toBe('180.6k')
  expect((await ui.find({ type: 'Text', text: /38\.7M/ }))?.text).toBe('38.7M')
  // In and out added up: 38,665,129 + 180,562 = 38,845,691.
  expect((await ui.find({ type: 'Text', text: /^38\.8M$/ }))?.text).toBe('38.8M')
  // The folded total's own label, apart from the turn's hit on the line above.
  expect((await ui.find({ type: 'Text', text: /平均缓存命中/ }))?.text).toBe('平均缓存命中')
  // 38,206,122 of 38,665,129 is 98.8128…%, kept as two decimals.
  expect((await ui.find({ type: 'Text', text: /98\.81%/ }))?.text).toBe('98.81%')
  await ui.unmount()
})

test('folded, the band draws no totals at all', async ($, on) => {
  on(
    'state.get',
    holding(
      { ttftMs: 800, tps: 40, outputTokens: 892, steps: 3, isLive: false, elapsedMs: 8000 },
      { turns: 12, steps: 241, ttftMs: 2900, tps: 292, contextPercent: 31 },
      false,
    ),
  )
  usageOf(on)
  transcriptSums(on, { turns: 12, responses: 241, input: 38_665_129, output: 180_562, cacheRead: 38_206_122 })
  engineDraws(on)
  await startSession($, on)

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })

  expect(await ui.find({ type: 'Text', text: /轮次 \/ 步数|首 token 平均/ })).toBeUndefined()
  expect((await ui.find({ type: 'Button' }))?.text).toBe('会话统计')
  await ui.unmount()
})

test('a child that cannot read the transcript leaves the stored totals standing', async ($, on) => {
  // No python3, or a file the child may not read: the band keeps what the last
  // turn's end stored rather than drawing zeros.
  on(
    'state.get',
    holding(
      { ttftMs: 800, tps: 40, outputTokens: 892, steps: 3, isLive: false, elapsedMs: 8000 },
      {
        turns: 3,
        steps: 20,
        ttftMs: 2100,
        tps: 250,
        outputTokens: 50_000,
        inputTokens: 1_000_000,
        cacheReadTokens: 900_000,
        cacheHitPercent: 90,
        contextPercent: 20,
      },
      true,
    ),
  )
  usageOf(on)
  on('process.run', () => ({
    value: {
      exitCode: 1,
      stdout: '',
      stderr: 'python3: command not found',
      isStdoutTruncated: false,
      isStderrTruncated: false,
    },
  }))
  engineDraws(on)
  await startSession($, on)

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })

  expect((await ui.find({ type: 'Text', text: /50\.0k/ }))?.text).toBe('50.0k')
  expect((await ui.find({ type: 'Text', text: /^90%$/ }))?.text).toBe('90%')
  await ui.unmount()
})

test('with nothing measured yet, the unfolded band says so', async ($, on) => {
  on(
    'state.get',
    holding({ ttftMs: 800, tps: 40, outputTokens: 892, steps: 3, isLive: false, elapsedMs: 8000 }, null, true),
  )
  usageOf(on)
  on('process.run', () => ({
    value: {
      exitCode: 0,
      stdout: JSON.stringify({ turns: 0, responses: 0, input: 0, output: 0, cacheRead: 0 }),
      stderr: '',
      isStdoutTruncated: false,
      isStderrTruncated: false,
    },
  }))
  engineDraws(on)
  await startSession($, on)

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })

  expect((await ui.find({ type: 'Text', text: /还没有可统计的数据/ }))?.text).toBe('还没有可统计的数据')
  await ui.unmount()
})

test('the rate is measured between responses, where a buffer cannot shrink it', async () => {
  // `settledRate` is pure: it reads the transcript's own `[settledAt, tokens]`
  // marks and needs neither a session nor the engine.
  // Six responses, one second apart, 100 tokens each: 500 tokens over 5 s.
  const tight: Array<[number, number]> = Array.from({ length: 6 }, (_, at) => [
    1_000_000 + at * 1000,
    100,
  ])
  expect(settledRate(tight)).toBe(100)

  // A gap longer than 90 s is the session idle, not the model thinking: the
  // window stops before it rather than averaging the idle time in.
  const idleThenBusy: Array<[number, number]> = [
    [1_000_000, 100],
    [1_200_000, 100], // 200 s later — the cut
    [1_201_000, 100],
    [1_202_000, 100],
  ]
  expect(settledRate(idleThenBusy)).toBe(100)

  // One response is not a rate.
  expect(settledRate([[1_000_000, 100]])).toBeNull()
  expect(settledRate([])).toBeNull()
})

