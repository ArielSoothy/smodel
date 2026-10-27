import { atom, read, update } from 'claude-code'
import type { ConfigRow, EngineInterface, Register } from 'claude-code'
import type {
  SmodelChat,
  SmodelLimits,
  SmodelLimitWindow,
  SmodelModel,
  SmodelProvider,
  SmodelRegistry,
  SmodelTotals,
  SmodelTurnStats,
  SmodelView,
} from '../types'

const PANE = 'smodel'
const DESCRIPTION = "Side chat with a Claude, Codex (OpenAI) or Gemini (agy) model, preloaded with this conversation's text; the transcript is sent to the provider you pick."
/** Providers the pane lists; the registry keeps the others (grok) unlisted. */
export const LISTED = ['claude', 'codex', 'agy'] as const
/** $.process.run's ceiling ("ten minutes at most"); an xhigh turn can take five. */
const TURN_TIMEOUT_MS = 600_000
/** smodel-limits.sh reads two local files and makes no model call; it finishes well under a second. */
const LIMITS_TIMEOUT_MS = 10_000
const CHAT_ROWS = 30

const registry = atom({ plugin: 'smodel', key: 'registry' } as const, null)
const view = atom({ plugin: 'smodel', key: 'view' } as const, { kind: 'picker' } as SmodelView)
const chats = atom({ plugin: 'smodel', key: 'chats' } as const, {} as Record<string, SmodelChat>)
const transcript = atom({ plugin: 'smodel', key: 'transcript' } as const, null)
const unavailable = atom({ plugin: 'smodel', key: 'unavailable' } as const, [] as string[])
const refreshing = atom({ plugin: 'smodel', key: 'refreshing' } as const, false)
const registryError = atom({ plugin: 'smodel', key: 'registryError' } as const, '')
const limits = atom({ plugin: 'smodel', key: 'limits' } as const, null)
/** The main chat's model as /model shows it ($.session.model()), read when the pane opens and after a switch. */
const mainModel = atom({ plugin: 'smodel', key: 'main' } as const, null)

/** Turns this module instance is running; a chat marked busy but absent here was cut off by a reload. */
const inFlight = new Set<string>()

const HOME_ERROR = 'HOME is not set. Set HOME to your home directory and reopen /smodel.'
const home = async ($: EngineInterface): Promise<string> => {
  const value = await $.env.get('HOME')
  if (!value) throw new Error(HOME_ERROR)
  return value
}

/** Keeps the listed providers' well-formed models; null when the file is not a registry. */
export const parseRegistry = (text: string): SmodelRegistry | null => {
  try {
    const raw = JSON.parse(text) as Partial<SmodelRegistry>
    if (!raw || !Array.isArray(raw.providers)) return null
    const providers: SmodelProvider[] = raw.providers
      .filter(p => p && typeof p.id === 'string' && Array.isArray(p.models))
      .filter(p => (LISTED as readonly string[]).includes(p.id))
      .map(p => ({
        ...p,
        name: typeof p.name === 'string' ? p.name : p.id,
        models: p.models.filter(
          (m): m is SmodelModel => !!m && typeof m.id === 'string' && typeof m.label === 'string',
        ),
      }))
    return {
      updated: typeof raw.updated === 'string' ? raw.updated : 'unknown',
      count: providers.reduce((n, p) => n + p.models.length, 0),
      providers,
    }
  } catch {
    return null
  }
}

export const buttonLabel = (m: SmodelModel): string =>
  `${m.label} · ${m.effort}${m.readonly ? ' · read-only' : ''}`

/** Claude Code names a project folder by the directory with every non-alphanumeric character as "-". */
export const projectFolder = (dir: string): string => dir.replace(/[^A-Za-z0-9]/g, '-')

/** Resolve Unix path components before enforcing a directory boundary. */
const resolvePath = (path: string): string => {
  if (!path.startsWith('/')) throw new Error('HOME must be an absolute path')
  const parts: string[] = []
  for (const part of path.split('/')) {
    if (part === '..') parts.pop()
    else if (part !== '' && part !== '.') parts.push(part)
  }
  return `/${parts.join('/')}`
}

/** Keep ordinary IDs compatible with saved chats; registry IDs cannot introduce separators. */
export const chatDirectory = (homeDir: string, sessionId: string, provider: string, model: string): string => {
  const segment = (id: string): string => {
    const safe = id.replace(/[^A-Za-z0-9._-]/g, '_')
    if (safe === '' || safe === '.' || safe === '..') throw new Error('Invalid chat directory ID')
    return safe
  }
  const base = resolvePath(`${homeDir}/.claude/smodel-chats`)
  const session = resolvePath(`${base}/${segment(sessionId)}`)
  const path = resolvePath(`${session}/${segment(provider)}-${segment(model)}`)
  if (!session.startsWith(`${base}/`) || !path.startsWith(`${session}/`)) throw new Error('Chat path escapes saved chats folder')
  return path
}

export const registryIsStale = (value: SmodelRegistry, now: number): boolean => {
  const updated = Date.parse(value.updated)
  return !Number.isFinite(updated) || now - updated > DAY_MS
}

/** The chat's text as display lines, newest last: `who: first line`, then the rest indented. */
export const chatLines = (entries: readonly string[]): string[] =>
  entries.flatMap(entry => entry.split('\n').map((line, i) => (i === 0 ? line : `  ${line}`)))

// ---- Stats: only numbers a CLI reported. A missing number is null and draws nothing, never 0. ----

const NUMBER_KEYS = [
  'at_ms', 'input_tokens', 'cached_tokens', 'cache_write_tokens', 'output_tokens', 'thinking_tokens',
  'context_tokens', 'context_window', 'cost_usd', 'duration_ms', 'num_turns',
] as const
const DAY_MS = 24 * 60 * 60 * 1000

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const numOrNull = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)
const strOrNull = (v: unknown): string | null => (typeof v === 'string' ? v : null)
const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

export const EMPTY_TOTALS: SmodelTotals = { turns: 0, input: null, output: null, costUsd: null }

/** smodel-turn.sh's last-stats.json, every number kept only when it is a real number; null when not stats. */
export const parseTurnStats = (text: string): SmodelTurnStats | null => {
  const raw = parseJson(text)
  if (!isRecord(raw) || typeof raw.provider !== 'string' || typeof raw.model !== 'string') return null
  const stats = { provider: raw.provider, model: raw.model } as SmodelTurnStats
  for (const k of NUMBER_KEYS) stats[k] = numOrNull(raw[k])
  stats.cost_basis = strOrNull(raw.cost_basis)
  stats.duration_source = strOrNull(raw.duration_source)
  return stats
}

const parseWindow = (v: unknown): SmodelLimitWindow | null => {
  if (!isRecord(v)) return null
  const w = { used_percent: numOrNull(v.used_percent), window_minutes: numOrNull(v.window_minutes), resets_at: numOrNull(v.resets_at) }
  return w.used_percent === null ? null : w
}

/** smodel-limits.sh's output; null when it is not a JSON object. */
export const parseLimits = (text: string): SmodelLimits | null => {
  const raw = parseJson(text)
  if (!isRecord(raw)) return null
  let claude: SmodelLimits['claude'] = null
  if (isRecord(raw.claude)) {
    const c = raw.claude
    const value = {
      five_hour_pct: numOrNull(c.five_hour_pct),
      five_hour_resets_at: numOrNull(c.five_hour_resets_at),
      seven_day_pct: numOrNull(c.seven_day_pct),
      seven_day_resets_at: numOrNull(c.seven_day_resets_at),
      updated_at: numOrNull(c.updated_at),
    }
    if (value.five_hour_pct !== null || value.seven_day_pct !== null) claude = value
  }
  let codex: SmodelLimits['codex'] = null
  const primary = isRecord(raw.codex) ? parseWindow(raw.codex) : null
  if (isRecord(raw.codex) && primary) {
    const c = raw.codex
    codex = {
      ...primary,
      plan_type: strOrNull(c.plan_type),
      secondary: parseWindow(c.secondary),
      model_context_window: numOrNull(c.model_context_window),
      as_of: strOrNull(c.as_of),
      source: strOrNull(c.source),
    }
  }
  return { claude, codex, agy: null }
}

const plus = (sum: number | null, n: number | null): number | null => (n === null ? sum : (sum ?? 0) + n)

/** Adds one turn's reported numbers; a number the turn did not report leaves its sum as it was. */
export const addTotals = (totals: SmodelTotals | undefined, stats: SmodelTurnStats): SmodelTotals => {
  const t = totals ?? EMPTY_TOTALS
  return {
    turns: t.turns + 1,
    input: plus(t.input, stats.context_tokens ?? stats.input_tokens),
    output: plus(t.output, stats.output_tokens),
    costUsd: plus(t.costUsd, stats.cost_usd),
  }
}

/** 21020 → "21,020". */
export const fmtInt = (n: number): string => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
const fmtUsd = (n: number): string => (n >= 1 ? n.toFixed(2) : n === 0 ? '0' : n.toPrecision(2))
const fmtPct = (n: number): string => `${Math.round(n * 10) / 10}%`
const fmtClock = (ms: number): string => {
  const d = new Date(ms)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}
const windowName = (minutes: number | null): string =>
  minutes === null ? '' : minutes === 300 ? '5h' : minutes === 10080 ? 'week' : `${fmtInt(minutes)} min`

/** The chat's stats block: one line per group whose numbers the CLI reported; empty before any stats. */
export const statsLines = (chat: SmodelChat): string[] => {
  const out: string[] = []
  const s = chat.last ?? null
  if (s) {
    const turn: string[] = []
    if (s.input_tokens !== null) {
      // Codex's cached count is part of its input; Claude's and agy's cache counts are reported beside it.
      if (s.provider === 'codex') turn.push(`in ${fmtInt(s.input_tokens)}${s.cached_tokens !== null ? ` (${fmtInt(s.cached_tokens)} cached)` : ''}`)
      else turn.push(`in ${fmtInt(s.input_tokens)}`)
    }
    if (s.provider !== 'codex') {
      if (s.cached_tokens !== null) turn.push(`cache read ${fmtInt(s.cached_tokens)}`)
      if (s.cache_write_tokens !== null) turn.push(`cache write ${fmtInt(s.cache_write_tokens)}`)
    }
    if (s.output_tokens !== null) turn.push(`out ${fmtInt(s.output_tokens)}`)
    if (s.thinking_tokens !== null) turn.push(`thinking ${fmtInt(s.thinking_tokens)}`)
    if (s.duration_ms !== null) turn.push(`${(s.duration_ms / 1000).toFixed(1)}s${s.duration_source === 'wall' ? ' (timed by smodel)' : ''}`)
    if (turn.length > 0) out.push(`last turn: ${turn.join(' · ')}`)
    if (s.context_tokens !== null) {
      const of = s.context_window !== null && s.context_window > 0
        ? ` of ${fmtInt(s.context_window)} (${Math.round((s.context_tokens / s.context_window) * 100)}%)`
        : ''
      out.push(`context sent: ${fmtInt(s.context_tokens)} tokens${of}`)
    }
    if (s.cost_usd !== null) out.push(`cost: $${fmtUsd(s.cost_usd)} list-price equivalent · not a bill (subscription)`)
  }
  const t = chat.totals ?? EMPTY_TOTALS
  if (t.turns > 0) {
    const parts = [`${t.turns} ${t.turns === 1 ? 'turn' : 'turns'}`]
    if (t.input !== null) parts.push(`in ${fmtInt(t.input)}`)
    if (t.output !== null) parts.push(`out ${fmtInt(t.output)}`)
    if (t.costUsd !== null) parts.push(`$${fmtUsd(t.costUsd)} list`)
    out.push(`this chat: ${parts.join(' · ')}`)
  }
  return out
}

const stale = (atMs: number, nowMs: number): string => (nowMs - atMs > DAY_MS ? ', stale' : '')

const claudeLimits = (c: SmodelLimits['claude'], nowMs: number): string => {
  if (!c) return 'Claude: no limit data'
  const parts: string[] = []
  if (c.five_hour_pct !== null) parts.push(`5h ${fmtPct(c.five_hour_pct)}`)
  if (c.seven_day_pct !== null) parts.push(`week ${fmtPct(c.seven_day_pct)}`)
  const when = c.updated_at !== null ? ` (updated ${fmtClock(c.updated_at * 1000)}${stale(c.updated_at * 1000, nowMs)})` : ''
  return `Claude ${parts.join(' · ')}${when}`
}

const codexLimits = (c: SmodelLimits['codex'], nowMs: number): string => {
  if (!c || c.used_percent === null) return 'Codex: no limit data'
  const win = (minutes: number | null, pct: number): string => {
    const name = windowName(minutes)
    return `${name ? `${name} ` : ''}${fmtPct(pct)}`
  }
  const parts = [win(c.window_minutes, c.used_percent)]
  if (c.secondary && c.secondary.used_percent !== null) parts.push(win(c.secondary.window_minutes, c.secondary.used_percent))
  const at = c.as_of !== null ? Date.parse(c.as_of) : NaN
  const when = Number.isFinite(at) ? ` (as of ${fmtClock(at)}${stale(at, nowMs)}, last Codex session)` : ' (last Codex session)'
  return `Codex ${parts.join(' · ')}${when}`
}

/** The account-limit line for one provider, or for all three ('all'); a provider without data says so. */
export const limitsLine = (limits: SmodelLimits | null, provider: string, nowMs: number): string => {
  const one = (p: string): string =>
    p === 'claude'
      ? claudeLimits(limits?.claude ?? null, nowMs)
      : p === 'codex'
        ? codexLimits(limits?.codex ?? null, nowMs)
        : p === 'agy'
          ? 'agy: no limit data from the CLI'
          : `${p}: no limit data`
  return provider === 'all' ? LISTED.map(one).join(' · ') : one(provider)
}

// ---- Main-chat model: the /config Model row, changed as the person would in the menu. ----

/** What to send to the /config Model row for a registry model id, or why it cannot be sent. */
export type ModelRowChoice = { key: string; value: string } | { error: string }

/**
 * Finds the /config Model row (key `model`, else a row labelled "Model") and the value that selects `modelId`:
 * for a `choice` row the option equal to the id, else the first option containing it; for a `text` row the id.
 * Verified 2026-10-27 on 2.1.311: key `model`, kind `choice`, options default, sonnet, opus, haiku, fable, best,
 * sonnet[1m], opus[1m], fable[1m], opusplan.
 */
export const modelRowChoice = (rows: readonly ConfigRow[], modelId: string): ModelRowChoice => {
  const row = rows.find(r => r.key === 'model') ?? rows.find(r => /^model$/i.test(r.label.trim()))
  if (!row) return { error: 'no Model row in /config' }
  const id = modelId.toLowerCase()
  if (row.kind === 'choice') {
    const options = row.options ?? []
    const pick = options.find(o => o.toLowerCase() === id) ?? options.find(o => o.toLowerCase().includes(id))
    return pick === undefined ? { error: `the /config Model row has no option for ${modelId}` } : { key: row.key, value: pick }
  }
  if (row.kind === 'text') return { key: row.key, value: modelId }
  return { error: `the /config Model row takes a ${row.kind}, not a model name` }
}

/** The engine's own transcript path when a classic hook reported it, else the project-folder path that exists. */
const transcriptPath = async ($: EngineInterface): Promise<string> => {
  const reported = await read($, transcript)
  if (reported) return reported
  const id = await $.session.id()
  const base = `${await home($)}/.claude/projects`
  const dirs = [await $.session.root(), await $.session.cwd()]
  for (const dir of dirs) {
    const path = `${base}/${projectFolder(dir)}/${id}.jsonl`
    if (await $.fs.exists(path)) return path
  }
  return `${base}/${projectFolder(dirs[0] ?? '')}/${id}.jsonl`
}

const isBusy = (chat: SmodelChat | undefined, key: string): boolean => !!chat?.busy && inFlight.has(key)

const patchChat = ($: EngineInterface, key: string, fn: (chat: SmodelChat) => SmodelChat) =>
  update($, chats, all => {
    const chat = all[key]
    return chat ? { ...all, [key]: fn(chat) } : all
  })

/** The turn's stats file, or null when it is missing or unreadable (stats are best-effort). */
const readTurnStats = async ($: EngineInterface, path: string): Promise<SmodelTurnStats | null> => {
  try {
    const text = await $.fs.read(path)
    return typeof text === 'string' ? parseTurnStats(text) : null
  } catch {
    return null
  }
}

/** Runs smodel-limits.sh and stores its answer; a failed run keeps the last answer, whose own times say how old it is. */
const refreshLimits = async ($: EngineInterface, enabled: boolean) => {
  if (!enabled) return
  try {
    const ran = await $.process.run(['/bin/bash', `${$.plugin.root}/scripts/smodel-limits.sh`], { timeoutMs: LIMITS_TIMEOUT_MS })
    const value = ran.exitCode === 0 ? parseLimits(ran.stdout) : null
    if (value) await update($, limits, () => value)
  } catch {
    // Limits are a side line; the pane works without them.
  }
}

/** One turn: write the message to a file, run smodel-turn.sh, append the answer or show the error. */
const runTurn = async ($: EngineInterface, key: string, message: string, showLimits: boolean) => {
  const all = await read($, chats)
  const chat = all[key]
  if (!chat || isBusy(chat, key)) return
  inFlight.add(key)
  await patchChat($, key, c => ({ ...c, busy: true, elapsed: 0, error: null, draft: '', lines: [...c.lines, `you: ${message}`] }))
  const startedAt = await $.clock.now()
  const tick = $.clock.every(1000, () => {
    void (async () => {
      const seconds = Math.round(((await $.clock.now()) - startedAt) / 1000)
      await patchChat($, key, c => (c.busy ? { ...c, elapsed: seconds } : c))
    })()
  })
  try {
    const sessionId = await $.session.id()
    const stateDir = chatDirectory(await home($), sessionId, chat.provider, chat.model)
    const messageFile = `${stateDir}/msg-${startedAt}.txt`
    await $.fs.write(messageFile, message)
    const path = await transcriptPath($)
    const ran = await $.process.run(
      ['/bin/bash', `${$.plugin.root}/scripts/smodel-turn.sh`, chat.provider, chat.model, path, stateDir, messageFile],
      { timeoutMs: TURN_TIMEOUT_MS },
    )
    const answer = ran.stdout.replace(/\s+$/, '')
    if (ran.exitCode === 0 && answer !== '') {
      await patchChat($, key, c => ({ ...c, lines: [...c.lines, `${c.model}: ${answer}`] }))
      // The script removes last-stats.json before each turn, so a file here is this turn's.
      const stats = await readTurnStats($, `${stateDir}/last-stats.json`)
      const own = stats && stats.provider === chat.provider && stats.model === chat.model ? stats : null
      await patchChat($, key, c => ({ ...c, last: own, totals: own ? addTotals(c.totals, own) : (c.totals ?? EMPTY_TOTALS) }))
      await refreshLimits($, showLimits)
    } else {
      const why = (ran.stderr.trim() || ran.stdout.trim() || `no answer (exit ${ran.exitCode})`).replace(/\s+/g, ' ')
      await patchChat($, key, c => ({ ...c, error: why }))
    }
  } catch (error) {
    const why = `failed: ${error instanceof Error ? error.message : String(error)}`
    await patchChat($, key, c => ({ ...c, error: why }))
  } finally {
    tick.cancel()
    inFlight.delete(key)
    await patchChat($, key, c => ({ ...c, busy: false }))
  }
}

const openChat = async ($: EngineInterface, provider: SmodelProvider, model: SmodelModel) => {
  const key = `${provider.id}/${model.id}`
  await update($, chats, all =>
    all[key]
      ? all
      : {
          ...all,
          [key]: {
            provider: provider.id, model: model.id, effort: model.effort, lines: [], draft: '', busy: false, elapsed: 0, error: null,
            last: null, totals: EMPTY_TOTALS,
          },
        },
  )
  await update($, view, () => ({ kind: 'chat', key }) as SmodelView)
}

const loadRegistry = async ($: EngineInterface): Promise<SmodelRegistry | null> => {
  let value: SmodelRegistry | null = null
  try {
    const text = await $.fs.read(`${await home($)}/.claude/model-registry.json`)
    value = typeof text === 'string' ? parseRegistry(text) : null
  } catch {
    value = null
  }
  if (await $.env.get('HOME')) {
    const ran = await $.process.run(['/bin/bash', '-c',
      'export PATH="${PATH:-/usr/bin:/bin}:$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin"; for cli in claude codex agy; do if command -v "$cli" >/dev/null 2>&1; then printf "%s\\n" "$cli"; fi; done',
    ], { timeoutMs: LIMITS_TIMEOUT_MS })
    if (ran.exitCode !== 0) throw new Error('Could not check provider CLIs')
    const installed = ran.stdout.trim().split(/\s+/)
    await update($, unavailable, () => LISTED.filter(id => !installed.includes(id)))
    if (value) {
      const providers = value.providers.filter(p => installed.includes(p.id))
      value = { ...value, providers, count: providers.reduce((n, p) => n + p.models.length, 0) }
    }
  }
  await update($, registry, () => value)
  return value
}

/** Refresh explicitly: never overwrite the shared registry just by opening the pane. */
const refreshRegistry = async ($: EngineInterface) => {
  if (await read($, refreshing)) return
  await update($, refreshing, () => true)
  await update($, registryError, () => '')
  try {
    const ran = await $.process.run(['/bin/bash', `${$.plugin.root}/scripts/model-registry.sh`], { timeoutMs: 30_000 })
    if (ran.exitCode !== 0) throw new Error(ran.stderr.trim() || ran.stdout.trim() || `exit ${ran.exitCode}`)
    const value = await loadRegistry($)
    if (!value) throw new Error('Refresh did not produce a valid registry')
  } catch (error) {
    await update($, registryError, () => `Refresh failed: ${error instanceof Error ? error.message : String(error)}`)
  } finally {
    await update($, refreshing, () => false)
  }
}

const refreshMain = async ($: EngineInterface) => {
  try {
    const model = await $.session.model()
    await update($, mainModel, () => model)
  } catch {
    // The header line is a convenience; the pane works without it.
  }
}

/** Switches the main chat's model through its /config row; the toast says what the engine answered, never a guess. */
const useForMain = async ($: EngineInterface, modelId: string) => {
  try {
    const choice = modelRowChoice(await $.config.list(), modelId)
    if ('error' in choice) {
      $.ui.toast(choice.error)
      return
    }
    const result = await $.config.set({ key: choice.key, value: choice.value })
    if (result.deny !== undefined) {
      $.ui.toast(result.deny)
      return
    }
    $.ui.toast(`main chat now on ${String(result.value)}`)
    await refreshMain($)
  } catch (error) {
    $.ui.toast(`main chat not switched: ${error instanceof Error ? error.message : String(error)}`)
  }
}

const rememberTranscript = async ($: EngineInterface, path: unknown) => {
  if (typeof path === 'string' && path !== '') await update($, transcript, () => path)
}

export const register: Register = (on, options) => {
  const showLimits = options.showLimits !== false
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    // immediate: /smodel typed while a turn runs opens the pane at once. Its command.run only reads the registry,
    // checks which CLIs exist, opens the pane and reads limits and the main model: nothing assumes an idle turn.
    await $.command.register({ name: 'smodel', description: DESCRIPTION, immediate: true })
    return started
  })

  // The classic hook input carries the engine's own transcript path; pass straight through.
  on('classic.SessionStart', async ($, e, next) => {
    await rememberTranscript($, e.transcript_path)
    return next(e)
  }).catch(($, e, next) => next(e))
  on('classic.UserPromptSubmit', async ($, e, next) => {
    if (e.agent_id === undefined) await rememberTranscript($, e.transcript_path)
    return next(e)
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'smodel' }, async $ => {
    await update($, registryError, () => '')
    try { await loadRegistry($) } catch (error) {
      await update($, registryError, () => `Models unavailable: ${error instanceof Error ? error.message : String(error)}`)
    }
    await update($, view, () => ({ kind: 'picker' }) as SmodelView)
    await $.ui.open({ id: PANE, title: 'Side chat: pick a model', focus: true, closeOnEscape: true })
    await refreshLimits($, showLimits)
    await refreshMain($)
    return { text: 'smodel: pick a model in the pane' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const elements = $.ui.resolve(e)
    const { Box, Text, Button } = elements
    // The mobile app draws no Input; there the chat is read-only.
    const Input = e.surface !== 'mobile' && 'Input' in elements ? elements.Input : undefined
    const current = await read($, registry)
    const shown = await read($, view)
    const all = await read($, chats)
    const usage = await read($, limits)
    const now = await $.clock.now()
    const main = await read($, mainModel)
    const close = <Button key="close" label="Close" dimColor onPress={() => void $.ui.close({ id: PANE })} />

    if (!(await $.env.get('HOME'))) {
      return (
        <Box flexDirection="column">
          <Text color="yellow">{HOME_ERROR}</Text>
          {close}
        </Box>
      )
    }

    const chat = shown.kind === 'chat' ? all[shown.key] : undefined
    if (shown.kind === 'chat' && chat) {
      const key = shown.key
      const busy = isBusy(chat, key)
      const stats = [...statsLines(chat), ...(showLimits ? [limitsLine(usage, chat.provider, now)] : [])]
      const isClaude = chat.provider === 'claude'
      const rows = Math.max(5, Math.min(CHAT_ROWS, e.props.scroll.bodyRows - 6 - stats.length - (isClaude ? 0 : 1)))
      const lines = chatLines(chat.lines).slice(-rows)
      const cutOff = chat.busy && !busy
      const status = busy
        ? `thinking… ${chat.elapsed}s`
        : cutOff
          ? 'the last turn was cut off by a reload; send it again'
          : chat.error
      return (
        <Box flexDirection="column">
          <Text bold wrap="truncate-end">
            {chat.provider}/{chat.model} · {chat.effort}
          </Text>
          {stats.map((line, i) => (
            <Text key={`s:${i}`} dimColor wrap="wrap">
              {line}
            </Text>
          ))}
          {lines.length === 0 && <Text dimColor>No messages yet. Type below and press Enter.</Text>}
          {lines.map((line, i) => (
            <Text key={`l:${i}`} color={line.startsWith('you: ') ? 'cyan' : undefined} wrap="wrap">
              {line}
            </Text>
          ))}
          {status && (
            <Text key="status" dimColor={busy} color={busy ? undefined : 'yellow'} wrap="wrap">
              {status}
            </Text>
          )}
          {chat.lines.length === 0 && <Text dimColor wrap="wrap">{`First message sends the conversation text to ${chat.provider}.`}</Text>}
          {Input ? (
            <Input
              key="message"
              label="> "
              placeholder={busy ? 'wait for the answer…' : 'message'}
              submitLabel="send"
              value={chat.draft}
              autoFocus
              onInput={(value: string) => void patchChat($, key, c => ({ ...c, draft: value }))}
              onSubmit={(value: string) => {
                const text = value.trim()
                if (text === '' || isBusy(chat, key)) return
                void runTurn($, key, text, showLimits)
              }}
            />
          ) : (
            <Text dimColor>Typing is not available on this surface.</Text>
          )}
          {!isClaude && <Text dimColor>side chat only: the main chat runs Claude models</Text>}
          <Box flexDirection="row" columnGap={2}>
            <Button key="back" label="Back to models" onPress={() => void update($, view, () => ({ kind: 'picker' }) as SmodelView)} />
            {isClaude && <Button key="use-main" label="Use for main chat" onPress={() => void useForMain($, chat.model)} />}
            {close}
          </Box>
        </Box>
      )
    }

    const missing = await read($, unavailable)
    const error = await read($, registryError)
    const isRefreshing = await read($, refreshing)
    const refresh = <Button key="refresh-models" label={isRefreshing ? 'Refreshing models…' : 'Refresh models'} onPress={() => void refreshRegistry($)} />
    const diagnostics = missing.map(id => <Text key={`missing:${id}`} dimColor>{`${id} not installed`}</Text>)

    if (current === null) {
      return (
        <Box flexDirection="column">
          <Text color="yellow">No model registry. Refresh models to create it.</Text>
          {diagnostics}
          {error && <Text color="yellow" wrap="wrap">{error}</Text>}
          {refresh}
          {close}
        </Box>
      )
    }

    return (
      <Box flexDirection="column">
        <Text dimColor wrap="truncate-end">
          {current.count} models · registry updated {current.updated}
        </Text>
        {main && <Text key="main" dimColor wrap="truncate-end">{`main chat: ${main}`}</Text>}
        {showLimits && <Text key="limits" dimColor wrap="wrap">
          {limitsLine(usage, 'all', now)}
        </Text>}
        {diagnostics}
        {error && <Text color="yellow" wrap="wrap">{error}</Text>}
        {registryIsStale(current, now) && <Text dimColor>Model registry is stale. Refresh models to update it.</Text>}
        {registryIsStale(current, now) && refresh}
        {current.providers.map(provider => (
          <Box key={`p:${provider.id}`} flexDirection="column">
            <Text bold>{provider.name}</Text>
            <Box flexDirection="row" flexWrap="wrap" columnGap={2}>
              {provider.models.map(model =>
                provider.id === 'claude' ? (
                  <Box key={`row:${provider.id}/${model.id}`} flexDirection="row" columnGap={1}>
                    <Button key={`${provider.id}/${model.id}`} label={buttonLabel(model)} onPress={() => void openChat($, provider, model)} />
                    <Button key={`main:${provider.id}/${model.id}`} label="→ main" dimColor onPress={() => void useForMain($, model.id)} />
                  </Box>
                ) : (
                  <Button
                    key={`${provider.id}/${model.id}`}
                    label={buttonLabel(model)}
                    onPress={() => void openChat($, provider, model)}
                  />
                ),
              )}
            </Box>
          </Box>
        ))}
        {close}
      </Box>
    )
  })
}
