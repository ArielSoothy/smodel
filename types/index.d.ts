export type SmodelModel = {
  id: string
  label: string
  effort: string
  readonly?: boolean
}
export type SmodelProvider = {
  id: string
  name: string
  cli?: string
  open?: string
  models: SmodelModel[]
}
export type SmodelRegistry = {
  updated: string
  count?: number
  providers: SmodelProvider[]
}
/**
 * The numbers one CLI reported for one turn, as smodel-turn.sh writes them to `last-stats.json`.
 * A number the CLI did not report is null, never 0.
 */
export type SmodelTurnStats = {
  provider: string
  model: string
  /** When the script wrote the stats, epoch ms. */
  at_ms: number | null
  input_tokens: number | null
  /** Claude: cache-read tokens, on top of input_tokens. Codex: the cached part OF input_tokens. agy: cache_read_tokens. */
  cached_tokens: number | null
  cache_write_tokens: number | null
  output_tokens: number | null
  thinking_tokens: number | null
  /** Tokens sent: Claude input + cache read + cache write; Codex and agy input_tokens. */
  context_tokens: number | null
  /** Claude only, from the CLI's modelUsage. */
  context_window: number | null
  /** Claude only: a list-price equivalent the CLI computes, not a bill on the subscription. */
  cost_usd: number | null
  cost_basis: string | null
  duration_ms: number | null
  /** "wall" when the script timed the call itself (Codex reports no duration). */
  duration_source?: string | null
  num_turns: number | null
}
/** One rate-limit window as a CLI reported it. */
export type SmodelLimitWindow = {
  used_percent: number | null
  window_minutes: number | null
  /** Epoch seconds. */
  resets_at: number | null
}
/** What smodel-limits.sh prints: each provider's account limits from a real file, or null. */
export type SmodelLimits = {
  /** From ~/.claude/rate-limit-state.json; all times epoch seconds. */
  claude: {
    five_hour_pct: number | null
    five_hour_resets_at: number | null
    seven_day_pct: number | null
    seven_day_resets_at: number | null
    updated_at: number | null
  } | null
  /** From the newest Codex session file's last token_count line. */
  codex: (SmodelLimitWindow & {
    plan_type: string | null
    secondary: SmodelLimitWindow | null
    model_context_window: number | null
    /** That line's ISO timestamp. */
    as_of: string | null
    /** The session file it came from. */
    source: string | null
  }) | null
  /** agy reports no limits anywhere. */
  agy: null
}
/** Sums of reported numbers over a chat's turns; each sum stays null until a turn reported that number. */
export type SmodelTotals = {
  /** Turns whose stats were read. */
  turns: number
  /** Sum of the tokens sent (context_tokens; input_tokens where that is missing). */
  input: number | null
  output: number | null
  costUsd: number | null
}
/** One side chat with one model, kept per `<provider>/<model>` for the session. */
export type SmodelChat = {
  provider: string
  model: string
  effort: string
  /** `you: …` and `<model>: …` entries, oldest first. */
  lines: string[]
  /** What is typed in the message field and not yet sent. */
  draft: string
  busy: boolean
  /** Whole seconds the running turn has taken. */
  elapsed: number
  /** The last turn's error (the script's stderr), or null. */
  error: string | null
  /** The last turn's stats; null when the CLI reported none. Missing on chats stored by 0.1.0. */
  last?: SmodelTurnStats | null
  /** Missing on chats stored by 0.1.0. */
  totals?: SmodelTotals
}
export type SmodelView = { kind: 'picker' } | { kind: 'chat'; key: string }

declare module 'claude-code' {
  interface PluginState {
    smodel: {
      /** The parsed ~/.claude/model-registry.json, or null when missing or unreadable. */
      registry: SmodelRegistry | null
      unavailable: string[]
      refreshing: boolean
      registryError: string
      /** Which view the pane shows. */
      view: SmodelView
      /** Every chat of this session, by `<provider>/<model>`. */
      chats: Record<string, SmodelChat>
      /** The transcript path the engine reported on its classic hook events. */
      transcript: string | null
      /** The last output of smodel-limits.sh, or null before it ran. */
      limits: SmodelLimits | null
      /** The main chat's model as /model shows it, or null before the pane first read it. */
      main: string | null
    }
  }
}
