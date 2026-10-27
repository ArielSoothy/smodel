import { expect, mock, test } from 'claude-code/testing'
import type { ConfigRow, On } from 'claude-code'
import type { SmodelChat, SmodelLimits, SmodelTurnStats } from '../types'
import { addTotals, EMPTY_TOTALS, limitsLine, modelRowChoice, parseLimits, parseTurnStats, statsLines } from './register'

const REGISTRY = {
  updated: '2026-10-27T10:46+02:00',
  count: 5,
  providers: [
    { id: 'claude', name: 'Claude (Anthropic)', models: [{ id: 'opus', label: 'Claude Opus 5.5', effort: 'high' }] },
    { id: 'codex', name: 'Codex (OpenAI)', models: [
      { id: 'gpt-6-astra', label: 'gpt-6-astra (read-only consult)', effort: 'high', readonly: true },
      { id: 'gpt-6-luna', label: 'gpt-6-luna', effort: 'xhigh' },
    ] },
    { id: 'agy', name: 'Gemini (agy)', models: [{ id: 'gemini-4-argon-high', label: 'gemini-4-argon-high', effort: 'as named' }] },
    { id: 'grok', name: 'Grok (xAI)', models: [{ id: 'grok-4.6', label: 'grok-4.6', effort: 'n/a' }] },
  ],
}
const PANE = {
  component: 'Pane', requestId: 'smodel',
  props: { title: 'Side chat: pick a model', isFocused: true, bodyColumns: 80, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
} as const
const COMMAND = { command: 'smodel', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } } as const
const NOW = Date.UTC(2026, 9, 27, 9)
const CWD = '/tmp/example-project'
const TRANSCRIPT = '/test-home/.claude/projects/-tmp-example-project/sess-1.jsonl'
const STATE = '/test-home/.claude/smodel-chats/sess-1/codex-gpt-6-luna'

type Reply = { exitCode: number; stdout: string; stderr: string }

// Stats objects as smodel-turn.sh writes them, normalized from the REAL CLI outputs captured 2026-10-27:
// claude -p --output-format json (haiku), codex exec --json (turn.completed.usage), agy --output-format json.
const CLAUDE_STATS = {
  provider: 'claude', model: 'haiku', at_ms: 1793094206107,
  input_tokens: 782, cached_tokens: 0, cache_write_tokens: 0, output_tokens: 199, thinking_tokens: 190,
  context_tokens: 782, context_window: 200000, cost_usd: 0.004131,
  cost_basis: 'list-price equivalent from the Claude CLI; not a bill on the subscription',
  duration_ms: 2365, num_turns: 1,
}
const CODEX_STATS = {
  provider: 'codex', model: 'gpt-6-luna', at_ms: 1793094206130,
  input_tokens: 21020, cached_tokens: 7168, cache_write_tokens: 0, output_tokens: 5, thinking_tokens: 0,
  context_tokens: 21020, context_window: null, cost_usd: null, cost_basis: null,
  duration_ms: 3200, num_turns: null, duration_source: 'wall',
}
const AGY_STATS = {
  provider: 'agy', model: 'gemini-3.8-flash-low', at_ms: 1793094206152,
  input_tokens: 7748, cached_tokens: 0, cache_write_tokens: null, output_tokens: 1, thinking_tokens: 0,
  context_tokens: 7748, context_window: null, cost_usd: null, cost_basis: null,
  duration_ms: 2540.598, num_turns: 1,
}
// smodel-limits.sh's output for the real ~/.claude/rate-limit-state.json and Codex token_count samples.
const LIMITS = {
  claude: { five_hour_pct: 67, five_hour_resets_at: 1793094600, seven_day_pct: 29, seven_day_resets_at: 1793199600, updated_at: 1793093778 },
  codex: {
    used_percent: 28.0, window_minutes: 10080, resets_at: 1793599898, plan_type: 'prolite', secondary: null,
    model_context_window: 258400, as_of: '2026-10-27T09:32:01.152Z',
    source: '/test-home/.codex/sessions/2026/10/27/rollout-2026-10-27T11-31-50-01a17cb3.jsonl',
  },
  agy: null,
}
const LIMITS_OUTPUT = JSON.stringify(LIMITS)
/** Local HH:MM, as the pane prints times. */
const hhmm = (ms: number): string => {
  const d = new Date(ms)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}
const chatWith = (fields: Partial<SmodelChat>): SmodelChat => ({
  provider: 'codex', model: 'gpt-6-luna', effort: 'xhigh', lines: [], draft: '', busy: false, elapsed: 0, error: null, ...fields,
})

// The /config rows as $.config.list() returned them on 2.1.311 (2026-10-27, read by a probe plugin), trimmed to two.
const THEME_ROW: ConfigRow = {
  key: 'theme', label: 'Theme', kind: 'choice', value: 'dark',
  options: ['auto', 'dark', 'light', 'light-daltonized', 'dark-daltonized', 'light-ansi', 'dark-ansi'],
  provider: { plugin: 'engine', tier: 'core' }, isLocked: false,
}
const MODEL_ROW: ConfigRow = {
  key: 'model', label: 'Model', kind: 'choice', value: 'fable',
  options: ['default', 'sonnet', 'opus', 'haiku', 'fable', 'best', 'sonnet[1m]', 'opus[1m]', 'fable[1m]', 'opusplan'],
  provider: { plugin: 'engine', tier: 'core' }, isLocked: false,
}
const CONFIG_ROWS: ConfigRow[] = [THEME_ROW, MODEL_ROW]

/** Every host effect is captured beneath the plugin; smodel-turn.sh and smodel-limits.sh never run. */
const world = (
  on: On,
  opts: {
    registry?: string | null; installed?: string[]; refreshed?: string; refreshReply?: Reply; reply?: Reply; missingHome?: boolean
    stats?: string[]; limits?: Reply
    /** What $.session.model() answers, in turn; the last one repeats. */
    mainModels?: string[]
    rows?: ConfigRow[]
    setDeny?: string
  } = {},
) => {
  const toasts: string[] = [], sets: { key: string; value: unknown }[] = [], immediate: (true | undefined)[] = []
  const mainModels = [...(opts.mainModels ?? ['claude-fable-5-1'])]
  on('session.model', () => ({ value: mainModels.length > 1 ? (mainModels.shift() as string) : (mainModels[0] as string) }))
  on('config.list', () => ({ value: opts.rows ?? CONFIG_ROWS }))
  on('config.set', (_, e) => {
    sets.push({ key: e.key, value: e.value })
    return opts.setDeny !== undefined ? { deny: opts.setDeny } : { value: e.value }
  })
  on('ui.toast', (_, e) => { toasts.push(e.text); return { value: undefined } })
  const reads: string[] = [], writes: { path: string; text: string }[] = [], opened: unknown[] = [], closed: string[] = []
  const runs: { argv: readonly string[]; timeoutMs?: number }[] = [], registered: string[] = []
  const limitRuns: { argv: readonly string[]; timeoutMs?: number }[] = [], statReads: string[] = []
  let registryText = opts.registry
  const refreshRuns: (readonly string[])[] = []
  const stats = [...(opts.stats ?? [])]
  let hold: Promise<void> | null = null
  const clock = mock.clock(on, { now: NOW })
  mock.env(on, opts.missingHome ? {} : { HOME: '/test-home' })
  on('fs.read', (_, e) => {
    if (e.path.endsWith('/last-stats.json')) {
      statReads.push(e.path)
      const next = stats.shift()
      if (next === undefined) throw new Error('ENOENT: no such file')
      return { value: next }
    }
    reads.push(e.path)
    if (registryText === null) throw new Error('ENOENT: no such file')
    return { value: registryText ?? JSON.stringify(REGISTRY) }
  })
  on('fs.write', (_, e) => { writes.push({ path: e.path, text: e.text }); return { value: undefined } })
  on('fs.exists', (_, e) => ({ value: e.path === TRANSCRIPT }))
  on('session.id', () => ({ value: 'sess-1' }))
  on('session.cwd', () => ({ value: CWD }))
  on('session.root', () => ({ value: CWD }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('classic.UserPromptSubmit', () => ({}))
  on('command.register', (_, e) => { registered.push(e.name); immediate.push(e.immediate); return { value: { command: e.name } } })
  on('ui.open', (_, e) => { opened.push(e); return { value: { isPlaced: true } } })
  on('ui.close', (_, e) => { closed.push(e.id); return { value: undefined } })
  on('process.run', async (_, e) => {
    if (e.argv[1]?.endsWith('/scripts/model-registry.sh')) {
      refreshRuns.push(e.argv)
      const r = opts.refreshReply ?? { exitCode: 0, stdout: 'registry written', stderr: '' }
      if (r.exitCode === 0) registryText = opts.refreshed ?? JSON.stringify(REGISTRY)
      return { value: { ...r, isStdoutTruncated: false, isStderrTruncated: false } }
    }
    if (e.argv[1] === '-c') {
      return { value: { exitCode: 0, stdout: (opts.installed ?? ['claude', 'codex', 'agy']).join('\n'), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    }
    if (e.argv[1]?.endsWith('/scripts/smodel-limits.sh')) {
      limitRuns.push({ argv: e.argv, timeoutMs: e.init?.timeoutMs })
      const r = opts.limits ?? { exitCode: 0, stdout: `${LIMITS_OUTPUT}\n`, stderr: '' }
      return { value: { ...r, isStdoutTruncated: false, isStderrTruncated: false } }
    }
    runs.push({ argv: e.argv, timeoutMs: e.init?.timeoutMs })
    if (hold) await hold
    const r = opts.reply ?? { exitCode: 0, stdout: 'Luna says: ship it.\nSecond line.\n', stderr: '' }
    return { value: { ...r, isStdoutTruncated: false, isStderrTruncated: false } }
  })
  return { reads, writes, opened, closed, runs, registered, clock, limitRuns, statReads, refreshRuns, toasts, sets, immediate, set hold(p: Promise<void> | null) { hold = p } }
}

test('/smodel reads the registry and opens the picker; grok is not listed', async ($, on) => {
  const w = world(on)
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
  expect(w.registered).toEqual(['smodel'])
  expect(w.immediate).toEqual([true])
  const answer = await $.command.run(COMMAND)
  expect(answer.text).toBe('smodel: pick a model in the pane')
  expect(w.reads).toEqual(['/test-home/.claude/model-registry.json'])
  expect(w.opened).toEqual([{ id: 'smodel', title: 'Side chat: pick a model', focus: true, closeOnEscape: true }])
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'smodel', surface, ...PANE })
    expect(await ui.find({ type: 'Text', text: /^4 models · registry updated 2026-10-27T10:46\+02:00/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'Gemini (agy)' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'Grok (xAI)' })).toBeUndefined()
    expect(await ui.find({ key: 'grok/grok-4.6' })).toBeUndefined()
    // 4 model buttons, one "→ main" beside the Claude model, Close.
    expect(await ui.findAll({ type: 'Button' })).toHaveLength(6)
    expect(await ui.find({ key: 'main:claude/opus' })).toMatchObject({ text: '→ main' })
    expect(await ui.find({ key: 'main:codex/gpt-6-luna' })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: 'main chat: claude-fable-5-1' })).toBeDefined()
    expect(await ui.find({ key: 'codex/gpt-6-astra' })).toMatchObject({ text: 'gpt-6-astra (read-only consult) · high · read-only' })
    expect(await ui.find({ key: 'claude/opus' })).toMatchObject({ text: 'Claude Opus 5.5 · high' })
    await ui.unmount()
  }
})

test('pressing a model switches to the chat view; Back returns and keeps the chat', async ($, on) => {
  const w = world(on)
  await $.command.run(COMMAND)
  const ui = await $.ui.mount({ plugin: 'smodel', surface: 'terminal', ...PANE })
  await ui.press({ key: 'codex/gpt-6-luna' })
  expect(await ui.find({ type: 'Text', text: 'codex/gpt-6-luna · xhigh' })).toBeDefined()
  expect(await ui.find({ key: 'message' })).toBeDefined()
  expect(await ui.find({ key: 'back' })).toBeDefined()
  expect(await ui.find({ key: 'close' })).toBeDefined()
  await ui.input({ key: 'message', text: 'hello' })
  await ui.press({ key: 'back' })
  expect(await ui.find({ key: 'codex/gpt-6-luna' })).toBeDefined()
  await ui.press({ key: 'codex/gpt-6-luna' })
  expect(await ui.find({ type: 'Text', text: 'you: hello' })).toBeDefined()
  const phone = await $.ui.mount({ plugin: 'smodel', surface: 'mobile', ...PANE })
  expect(await phone.find({ type: 'Text', text: 'codex/gpt-6-luna · xhigh' })).toBeDefined()
  expect(await phone.find({ type: 'Text', text: 'Typing is not available on this surface.' })).toBeDefined()
  await phone.unmount()
  await ui.press({ key: 'close' })
  expect(w.closed).toEqual(['smodel'])
  await ui.unmount()
})

test('a submitted message is written to a file, run through smodel-turn.sh, and its answer appended', async ($, on) => {
  const w = world(on)
  await $.command.run(COMMAND)
  const ui = await $.ui.mount({ plugin: 'smodel', surface: 'terminal', ...PANE })
  await ui.press({ key: 'codex/gpt-6-luna' })
  await ui.input({ key: 'message', text: '  should we ship?  ' })
  const messageFile = `${STATE}/msg-${NOW}.txt`
  expect(w.writes).toEqual([{ path: messageFile, text: 'should we ship?' }])
  expect(w.runs).toEqual([{
    argv: ['/bin/bash', expect.stringMatching(/^\/.+\/scripts\/smodel-turn\.sh$/), 'codex', 'gpt-6-luna', TRANSCRIPT, STATE, messageFile],
    timeoutMs: 600000,
  }])
  expect(await ui.find({ type: 'Text', text: 'you: should we ship?' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'gpt-6-luna: Luna says: ship it.' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '  Second line.' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^thinking…|^failed/ })).toBeUndefined()
  await ui.unmount()
})

test('while a turn runs the status counts seconds and a second submit is ignored', async ($, on) => {
  const w = world(on)
  let release: () => void = () => {}
  w.hold = new Promise<void>(resolve => { release = resolve })
  await $.command.run(COMMAND)
  const ui = await $.ui.mount({ plugin: 'smodel', surface: 'terminal', ...PANE })
  await ui.press({ key: 'claude/opus' })
  const sent = ui.input({ key: 'message', text: 'first' })
  await w.clock.advance(3000)
  expect(await ui.find({ type: 'Text', text: 'thinking… 3s' })).toBeDefined()
  const second = ui.input({ key: 'message', text: 'second' })
  await w.clock.advance(1000)
  expect(await ui.find({ type: 'Text', text: 'thinking… 4s' })).toBeDefined()
  expect(w.runs).toHaveLength(1)
  release()
  await sent
  await second
  expect(w.runs).toHaveLength(1)
  expect(await ui.find({ type: 'Text', text: 'you: second' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: 'opus: Luna says: ship it.' })).toBeDefined()
  expect(w.runs[0]?.argv.slice(2, 4)).toEqual(['claude', 'opus'])
  await ui.unmount()
})

test('a failing turn shows the script stderr as the status line', async ($, on) => {
  world(on, { reply: { exitCode: 1, stdout: '', stderr: 'smodel-turn: no answer from agy/gemini-4-argon-high. quota\n' } })
  await $.command.run(COMMAND)
  const ui = await $.ui.mount({ plugin: 'smodel', surface: 'terminal', ...PANE })
  await ui.press({ key: 'agy/gemini-4-argon-high' })
  await ui.input({ key: 'message', text: 'hi' })
  expect(await ui.find({ type: 'Text', text: 'smodel-turn: no answer from agy/gemini-4-argon-high. quota' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'you: hi' })).toBeDefined()
  await ui.unmount()
})

test('the transcript path the engine reports on a classic hook wins over the computed one', async ($, on) => {
  const w = world(on)
  await $.classic.UserPromptSubmit({ prompt: 'hi', transcript_path: '/engine/said/this.jsonl' })
  await $.command.run(COMMAND)
  const ui = await $.ui.mount({ plugin: 'smodel', surface: 'terminal', ...PANE })
  await ui.press({ key: 'claude/opus' })
  await ui.input({ key: 'message', text: 'go' })
  expect(w.runs[0]?.argv[4]).toBe('/engine/said/this.jsonl')
  await ui.unmount()
})

test('a missing registry offers the bundled refresh and reloads models', async ($, on) => {
  const w = world(on, { registry: null })
  await $.command.run(COMMAND)
  const ui = await $.ui.mount({ plugin: 'smodel', surface: 'terminal', ...PANE })
  expect(await ui.find({ key: 'refresh-models' })).toMatchObject({ text: 'Refresh models' })
  expect(await ui.find({ key: 'codex/gpt-6-luna' })).toBeUndefined()
  await ui.press({ key: 'refresh-models' })
  expect(w.refreshRuns).toEqual([['/bin/bash', expect.stringMatching(/\/scripts\/model-registry\.sh$/)]])
  expect(await ui.find({ key: 'codex/gpt-6-luna' })).toBeDefined()
  expect(w.runs).toEqual([])
  await ui.unmount()
})


test('missing HOME shows a clear pane error without starting a provider', async ($, on) => {
  const w = world(on, { missingHome: true })
  await $.command.run(COMMAND)
  const ui = await $.ui.mount({ plugin: 'smodel', surface: 'terminal', ...PANE })
  expect(await ui.find({ type: 'Text', text: 'HOME is not set. Set HOME to your home directory and reopen /smodel.' })).toBeDefined()
  expect(await ui.findAll({ type: 'Button' })).toHaveLength(1)
  expect(w.runs).toEqual([])
  await ui.unmount()
})

test('parseTurnStats keeps the reported numbers and refuses anything that is not stats', async () => {
  for (const sample of [CLAUDE_STATS, CODEX_STATS, AGY_STATS]) {
    const parsed = parseTurnStats(JSON.stringify(sample))
    expect(parsed).toEqual({ duration_source: null, ...sample })
  }
  expect(parseTurnStats('not json')).toBeNull()
  expect(parseTurnStats('[]')).toBeNull()
  expect(parseTurnStats('{"model":"haiku"}')).toBeNull()
  expect(parseTurnStats('')).toBeNull()
  // A field that is not a real number becomes null, never 0.
  const odd = parseTurnStats(JSON.stringify({ ...CODEX_STATS, output_tokens: '5', cost_usd: true, input_tokens: undefined }))
  expect(odd?.output_tokens).toBeNull()
  expect(odd?.cost_usd).toBeNull()
  expect(odd?.input_tokens).toBeNull()
})

test('parseLimits reads the helper output; {} is all null and garbage is null', async () => {
  expect(parseLimits(LIMITS_OUTPUT)).toEqual(LIMITS)
  expect(parseLimits('{}')).toEqual({ claude: null, codex: null, agy: null })
  expect(parseLimits('{"claude": null, "codex": null, "agy": null}')).toEqual({ claude: null, codex: null, agy: null })
  expect(parseLimits('garbage')).toBeNull()
  expect(parseLimits('[1,2]')).toBeNull()
  // No percentage anywhere means no data, not 0%.
  expect(parseLimits('{"claude": {"updated_at": 1793093778}, "codex": {"window_minutes": 300}}')).toEqual({ claude: null, codex: null, agy: null })
  const both = parseLimits(JSON.stringify({ ...LIMITS, codex: { ...LIMITS.codex, secondary: { used_percent: 4, window_minutes: 300, resets_at: 1 } } }))
  expect(both?.codex?.secondary).toEqual({ used_percent: 4, window_minutes: 300, resets_at: 1 })
})

test('addTotals sums only reported numbers; cost stays null until a cost is reported', async () => {
  const codex = parseTurnStats(JSON.stringify(CODEX_STATS)) as SmodelTurnStats
  const claude = parseTurnStats(JSON.stringify(CLAUDE_STATS)) as SmodelTurnStats
  const once = addTotals(EMPTY_TOTALS, codex)
  expect(once).toEqual({ turns: 1, input: 21020, output: 5, costUsd: null })
  const twice = addTotals(once, codex)
  expect(twice).toEqual({ turns: 2, input: 42040, output: 10, costUsd: null })
  expect(addTotals(undefined, claude)).toEqual({ turns: 1, input: 782, output: 199, costUsd: 0.004131 })
  const noNumbers = { ...codex, input_tokens: null, context_tokens: null, output_tokens: null }
  expect(addTotals(EMPTY_TOTALS, noNumbers)).toEqual({ turns: 1, input: null, output: null, costUsd: null })
  expect(addTotals(twice, noNumbers)).toEqual({ turns: 3, input: 42040, output: 10, costUsd: null })
})

test('statsLines formats reported numbers and draws nothing for a missing one', async () => {
  const codex = parseTurnStats(JSON.stringify(CODEX_STATS)) as SmodelTurnStats
  expect(statsLines(chatWith({ last: codex, totals: addTotals(EMPTY_TOTALS, codex) }))).toEqual([
    'last turn: in 21,020 (7,168 cached) · out 5 · thinking 0 · 3.2s (timed by smodel)',
    'context sent: 21,020 tokens',
    'this chat: 1 turn · in 21,020 · out 5',
  ])
  const claude = parseTurnStats(JSON.stringify(CLAUDE_STATS)) as SmodelTurnStats
  expect(statsLines(chatWith({ provider: 'claude', model: 'haiku', last: claude, totals: addTotals(addTotals(undefined, claude), claude) }))).toEqual([
    'last turn: in 782 · cache read 0 · cache write 0 · out 199 · thinking 190 · 2.4s',
    'context sent: 782 tokens of 200,000 (0%)',
    'cost: $0.0041 list-price equivalent · not a bill (subscription)',
    'this chat: 2 turns · in 1,564 · out 398 · $0.0083 list',
  ])
  const agy = parseTurnStats(JSON.stringify(AGY_STATS)) as SmodelTurnStats
  expect(statsLines(chatWith({ provider: 'agy', model: 'gemini-3.8-flash-low', last: agy }))).toEqual([
    'last turn: in 7,748 · cache read 0 · out 1 · thinking 0 · 2.5s',
    'context sent: 7,748 tokens',
  ])
  const bare = { ...codex, input_tokens: null, cached_tokens: null, cache_write_tokens: null, output_tokens: null, thinking_tokens: null, context_tokens: null, duration_ms: null }
  expect(statsLines(chatWith({ last: bare }))).toEqual([])
  // A chat stored by 0.1.0 has neither field.
  expect(statsLines(chatWith({}))).toEqual([])
  expect(statsLines(chatWith({ last: null, totals: EMPTY_TOTALS }))).toEqual([])
})

test('limitsLine maps windows, says when data is missing, and marks data older than a day stale', async () => {
  const claudeAt = hhmm(LIMITS.claude.updated_at * 1000)
  const codexAt = hhmm(Date.parse(LIMITS.codex.as_of))
  expect(limitsLine(LIMITS, 'all', NOW)).toBe(
    `Claude 5h 67% · week 29% (updated ${claudeAt}) · Codex week 28% (as of ${codexAt}, last Codex session) · agy: no limit data from the CLI`,
  )
  expect(limitsLine(LIMITS, 'codex', NOW)).toBe(`Codex week 28% (as of ${codexAt}, last Codex session)`)
  expect(limitsLine(LIMITS, 'claude', NOW)).toBe(`Claude 5h 67% · week 29% (updated ${claudeAt})`)
  expect(limitsLine(LIMITS, 'agy', NOW)).toBe('agy: no limit data from the CLI')
  const later = NOW + 2 * 24 * 60 * 60 * 1000
  expect(limitsLine(LIMITS, 'all', later)).toBe(
    `Claude 5h 67% · week 29% (updated ${claudeAt}, stale) · Codex week 28% (as of ${codexAt}, stale, last Codex session) · agy: no limit data from the CLI`,
  )
  const windows = (primary: number | null, secondary: SmodelLimits['codex'] extends infer C ? (C extends { secondary: infer S } ? S : never) : never) =>
    limitsLine({ claude: null, codex: { ...LIMITS.codex, window_minutes: primary, secondary }, agy: null }, 'codex', NOW)
  expect(windows(300, null)).toBe(`Codex 5h 28% (as of ${codexAt}, last Codex session)`)
  expect(windows(60, null)).toBe(`Codex 60 min 28% (as of ${codexAt}, last Codex session)`)
  expect(windows(null, null)).toBe(`Codex 28% (as of ${codexAt}, last Codex session)`)
  expect(windows(10080, { used_percent: 12.5, window_minutes: 300, resets_at: 1 })).toBe(`Codex week 28% · 5h 12.5% (as of ${codexAt}, last Codex session)`)
  expect(limitsLine(null, 'all', NOW)).toBe('Claude: no limit data · Codex: no limit data · agy: no limit data from the CLI')
  expect(limitsLine({ claude: null, codex: null, agy: null }, 'claude', NOW)).toBe('Claude: no limit data')
})

test('/smodel refreshes the limits and the picker draws the limits line', async ($, on) => {
  const w = world(on)
  await $.command.run(COMMAND)
  expect(w.limitRuns).toEqual([{ argv: ['/bin/bash', expect.stringMatching(/^\/.+\/scripts\/smodel-limits\.sh$/)], timeoutMs: 10000 }])
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'smodel', surface, ...PANE })
    expect(await ui.find({ type: 'Text', text: limitsLine(LIMITS, 'all', NOW) })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^Claude 5h 67% · week 29%/ })).toBeDefined()
    await ui.unmount()
  }
})

test('a failed limits run leaves the picker saying there is no data, never a number', async ($, on) => {
  world(on, { limits: { exitCode: 1, stdout: '', stderr: 'boom' } })
  await $.command.run(COMMAND)
  const ui = await $.ui.mount({ plugin: 'smodel', surface: 'terminal', ...PANE })
  expect(await ui.find({ type: 'Text', text: 'Claude: no limit data · Codex: no limit data · agy: no limit data from the CLI' })).toBeDefined()
  await ui.unmount()
})

test('after a turn the chat reads last-stats.json, adds it up, and refreshes the limits', async ($, on) => {
  const w = world(on, { stats: [JSON.stringify(CODEX_STATS), JSON.stringify({ ...CODEX_STATS, input_tokens: 22000, context_tokens: 22000, output_tokens: 7 })] })
  await $.command.run(COMMAND)
  const ui = await $.ui.mount({ plugin: 'smodel', surface: 'terminal', ...PANE })
  await ui.press({ key: 'codex/gpt-6-luna' })
  expect(await ui.find({ type: 'Text', text: /^last turn:/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: limitsLine(LIMITS, 'codex', NOW) })).toBeDefined()
  await ui.input({ key: 'message', text: 'first' })
  expect(w.statReads).toEqual([`${STATE}/last-stats.json`])
  expect(w.limitRuns).toHaveLength(2)
  expect(await ui.find({ type: 'Text', text: 'gpt-6-luna: Luna says: ship it.' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'last turn: in 21,020 (7,168 cached) · out 5 · thinking 0 · 3.2s (timed by smodel)' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'context sent: 21,020 tokens' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'this chat: 1 turn · in 21,020 · out 5' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^cost:/ })).toBeUndefined()
  await ui.input({ key: 'message', text: 'second' })
  expect(await ui.find({ type: 'Text', text: 'last turn: in 22,000 (7,168 cached) · out 7 · thinking 0 · 3.2s (timed by smodel)' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'this chat: 2 turns · in 43,020 · out 12' })).toBeDefined()
  await ui.unmount()
})

test('a turn without a stats file keeps the answer and shows no stale numbers', async ($, on) => {
  world(on, { stats: [JSON.stringify(CODEX_STATS)] })
  await $.command.run(COMMAND)
  const ui = await $.ui.mount({ plugin: 'smodel', surface: 'terminal', ...PANE })
  await ui.press({ key: 'codex/gpt-6-luna' })
  await ui.input({ key: 'message', text: 'one' })
  expect(await ui.find({ type: 'Text', text: /^last turn: in 21,020/ })).toBeDefined()
  await ui.input({ key: 'message', text: 'two' })
  expect(await ui.findAll({ type: 'Text', text: 'gpt-6-luna: Luna says: ship it.' })).toHaveLength(2)
  expect(await ui.find({ type: 'Text', text: /^last turn:/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: 'this chat: 1 turn · in 21,020 · out 5' })).toBeDefined()
  await ui.unmount()
})

test('stats from another chat are not shown in this one', async ($, on) => {
  world(on, { stats: [JSON.stringify({ ...CLAUDE_STATS, provider: 'claude', model: 'opus' })] })
  await $.command.run(COMMAND)
  const ui = await $.ui.mount({ plugin: 'smodel', surface: 'terminal', ...PANE })
  await ui.press({ key: 'codex/gpt-6-luna' })
  await ui.input({ key: 'message', text: 'hi' })
  expect(await ui.find({ type: 'Text', text: /^last turn:|^this chat:/ })).toBeUndefined()
  await ui.unmount()
})

test('a chat stored by 0.1.0 (no stats fields) still draws', async ($, on) => {
  world(on)
  const old = { provider: 'codex', model: 'gpt-6-luna', effort: 'xhigh', lines: ['you: hi', 'gpt-6-luna: hello'], draft: '', busy: false, elapsed: 0, error: null }
  on('state.get', (_, e, next) =>
    e.key === 'chats'
      ? { value: { value: { 'codex/gpt-6-luna': old }, version: 1 } }
      : e.key === 'view'
        ? { value: { value: { kind: 'chat', key: 'codex/gpt-6-luna' }, version: 1 } }
        : next(e),
  )
  const ui = await $.ui.mount({ plugin: 'smodel', surface: 'terminal', ...PANE })
  expect(await ui.find({ type: 'Text', text: 'codex/gpt-6-luna · xhigh' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'gpt-6-luna: hello' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^last turn:|^this chat:/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: 'Claude: no limit data' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: 'Codex: no limit data' })).toBeDefined()
  await ui.unmount()
})


test('a stale registry offers refresh without hiding existing models', async ($, on) => {
  world(on, { registry: JSON.stringify({ ...REGISTRY, updated: '2020-01-01T00:00:00Z' }) })
  await $.command.run(COMMAND)
  const ui = await $.ui.mount({ plugin: 'smodel', surface: 'terminal', ...PANE })
  expect(await ui.find({ key: 'refresh-models' })).toBeDefined()
  expect(await ui.find({ key: 'codex/gpt-6-luna' })).toBeDefined()
  await ui.unmount()
})

test('an unavailable CLI hides its models and names the missing provider', async ($, on) => {
  world(on, { installed: ['claude', 'agy'] })
  await $.command.run(COMMAND)
  const ui = await $.ui.mount({ plugin: 'smodel', surface: 'terminal', ...PANE })
  expect(await ui.find({ key: 'codex/gpt-6-luna' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: 'codex not installed' })).toBeDefined()
  expect(await ui.find({ key: 'claude/opus' })).toBeDefined()
  await ui.unmount()
})

test('failed registry refresh shows an error and keeps existing models', async ($, on) => {
  world(on, { registry: JSON.stringify({ ...REGISTRY, updated: 'unknown' }), refreshReply: { exitCode: 1, stdout: '', stderr: 'cannot write registry' } })
  await $.command.run(COMMAND)
  const ui = await $.ui.mount({ plugin: 'smodel', surface: 'terminal', ...PANE })
  await ui.press({ key: 'refresh-models' })
  expect(await ui.find({ type: 'Text', text: /cannot write registry/ })).toBeDefined()
  expect(await ui.find({ key: 'codex/gpt-6-luna' })).toBeDefined()
  await ui.unmount()
})

test('showLimits false skips quota-file helpers on open and after a turn', { options: { showLimits: false } }, async ($, on) => {
  const w = world(on)
  await $.command.run(COMMAND)
  const ui = await $.ui.mount({ plugin: 'smodel', surface: 'terminal', ...PANE })
  expect(await ui.find({ key: 'limits' })).toBeUndefined()
  await ui.press({ key: 'codex/gpt-6-luna' })
  await ui.input({ key: 'message', text: 'hello' })
  expect(w.limitRuns).toHaveLength(0)
  expect(await ui.find({ type: 'Text', text: /last Codex session/ })).toBeUndefined()
  await ui.unmount()
})

test('a new chat discloses the first conversation transfer above the input', async ($, on) => {
  world(on)
  await $.command.run(COMMAND)
  const ui = await $.ui.mount({ plugin: 'smodel', surface: 'terminal', ...PANE })
  await ui.press({ key: 'codex/gpt-6-luna' })
  expect(await ui.find({ type: 'Text', text: 'First message sends the conversation text to codex.' })).toBeDefined()
  await ui.unmount()
})

test('a traversal model ID is passed intact to the CLI but stored inside this session', async ($, on) => {
  const model = 'x/../../../../outside'
  const w = world(on, { registry: JSON.stringify({ ...REGISTRY, providers: [{ id: 'codex', name: 'Codex', models: [{ id: model, label: model, effort: 'high' }] }] }) })
  await $.command.run(COMMAND)
  const ui = await $.ui.mount({ plugin: 'smodel', surface: 'terminal', ...PANE })
  await ui.press({ key: `codex/${model}` })
  await ui.input({ key: 'message', text: 'hello' })
  expect(w.runs[0]?.argv[3]).toBe(model)
  expect(w.runs[0]?.argv[5]).toBe('/test-home/.claude/smodel-chats/sess-1/codex-x_.._.._.._.._outside')
  expect(w.writes[0]?.path).toBe('/test-home/.claude/smodel-chats/sess-1/codex-x_.._.._.._.._outside/msg-1793091600000.txt')
  await ui.unmount()
})

test('missing quota sources show unavailable data without a pane error', async ($, on) => {
  world(on, { limits: { exitCode: 0, stdout: '{"claude":null,"codex":null,"agy":null}\n', stderr: '' } })
  await $.command.run(COMMAND)
  const ui = await $.ui.mount({ plugin: 'smodel', surface: 'terminal', ...PANE })
  expect(await ui.find({ type: 'Text', text: 'Claude: no limit data · Codex: no limit data · agy: no limit data from the CLI' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /failed|error/i })).toBeUndefined()
  await ui.unmount()
})

test('modelRowChoice finds the Model row and maps a registry id to its option', async () => {
  for (const id of ['fable', 'opus', 'sonnet', 'haiku']) expect(modelRowChoice(CONFIG_ROWS, id)).toEqual({ key: 'model', value: id })
  // An exact option wins over one that only contains the id.
  expect(modelRowChoice([{ ...MODEL_ROW, options: ['sonnet[1m]', 'sonnet'] }], 'sonnet')).toEqual({ key: 'model', value: 'sonnet' })
  expect(modelRowChoice([{ ...MODEL_ROW, options: ['default', 'opus[1m]'] }], 'opus')).toEqual({ key: 'model', value: 'opus[1m]' })
  expect(modelRowChoice(CONFIG_ROWS, 'OPUS')).toEqual({ key: 'model', value: 'opus' })
  // Found by label when the key differs.
  expect(modelRowChoice([THEME_ROW, { ...MODEL_ROW, key: 'mainModel', label: ' model ' }], 'haiku')).toEqual({ key: 'mainModel', value: 'haiku' })
  expect(modelRowChoice([THEME_ROW], 'opus')).toEqual({ error: 'no Model row in /config' })
  expect(modelRowChoice([], 'opus')).toEqual({ error: 'no Model row in /config' })
  expect(modelRowChoice(CONFIG_ROWS, 'gpt-6-luna')).toEqual({ error: 'the /config Model row has no option for gpt-6-luna' })
  expect(modelRowChoice([{ ...MODEL_ROW, options: undefined }], 'opus')).toEqual({ error: 'the /config Model row has no option for opus' })
  const { options: _unused, ...textRow } = MODEL_ROW
  expect(modelRowChoice([{ ...textRow, kind: 'text' }], 'claude-opus-5-5')).toEqual({ key: 'model', value: 'claude-opus-5-5' })
  expect(modelRowChoice([{ ...textRow, kind: 'boolean', value: true }], 'opus')).toEqual({ error: 'the /config Model row takes a boolean, not a model name' })
})

test('"→ main" sets the Model row, toasts what the engine answered, and refreshes the header', async ($, on) => {
  const w = world(on, { mainModels: ['claude-fable-5-1', 'claude-opus-5-5'] })
  await $.command.run(COMMAND)
  const ui = await $.ui.mount({ plugin: 'smodel', surface: 'terminal', ...PANE })
  expect(await ui.find({ type: 'Text', text: 'main chat: claude-fable-5-1' })).toBeDefined()
  await ui.press({ key: 'main:claude/opus' })
  expect(w.sets).toEqual([{ key: 'model', value: 'opus' }])
  expect(w.toasts).toEqual(['main chat now on opus'])
  expect(await ui.find({ type: 'Text', text: 'main chat: claude-opus-5-5' })).toBeDefined()
  expect(w.runs).toEqual([])
  await ui.unmount()
})

test('a refused switch toasts the deny reason verbatim and keeps the header', async ($, on) => {
  const w = world(on, { setDeny: 'managed settings own the model', mainModels: ['claude-fable-5-1', 'claude-opus-5-5'] })
  await $.command.run(COMMAND)
  const ui = await $.ui.mount({ plugin: 'smodel', surface: 'terminal', ...PANE })
  await ui.press({ key: 'main:claude/opus' })
  expect(w.toasts).toEqual(['managed settings own the model'])
  expect(await ui.find({ type: 'Text', text: 'main chat: claude-fable-5-1' })).toBeDefined()
  await ui.unmount()
})

test('without a Model row nothing is set and the toast says so', async ($, on) => {
  const w = world(on, { rows: [THEME_ROW] })
  await $.command.run(COMMAND)
  const ui = await $.ui.mount({ plugin: 'smodel', surface: 'terminal', ...PANE })
  await ui.press({ key: 'main:claude/opus' })
  expect(w.sets).toEqual([])
  expect(w.toasts).toEqual(['no Model row in /config'])
  await ui.unmount()
})

test('a Claude chat offers "Use for main chat"; Codex and agy chats say they are side chats only', async ($, on) => {
  const w = world(on)
  await $.command.run(COMMAND)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'smodel', surface, ...PANE })
    await ui.press({ key: 'claude/opus' })
    expect(await ui.find({ key: 'use-main' })).toMatchObject({ text: 'Use for main chat' })
    expect(await ui.find({ type: 'Text', text: 'side chat only: the main chat runs Claude models' })).toBeUndefined()
    await ui.press({ key: 'back' })
    await ui.press({ key: 'codex/gpt-6-luna' })
    expect(await ui.find({ key: 'use-main' })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: 'side chat only: the main chat runs Claude models' })).toBeDefined()
    await ui.press({ key: 'back' })
    await ui.press({ key: 'agy/gemini-4-argon-high' })
    expect(await ui.find({ type: 'Text', text: 'side chat only: the main chat runs Claude models' })).toBeDefined()
    await ui.press({ key: 'back' })
    await ui.unmount()
  }
  const ui = await $.ui.mount({ plugin: 'smodel', surface: 'terminal', ...PANE })
  await ui.press({ key: 'claude/opus' })
  await ui.press({ key: 'use-main' })
  expect(w.sets).toEqual([{ key: 'model', value: 'opus' }])
  expect(w.toasts).toEqual(['main chat now on opus'])
  await ui.unmount()
})
