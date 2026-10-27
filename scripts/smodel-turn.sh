#!/bin/bash
# smodel-turn.sh — one chat turn with any model from any provider, for the /smodel pane (chat INSIDE Claude Code).
# Usage: smodel-turn.sh <provider> <model> <session.jsonl> <state-dir> <message-file>
#   provider: claude | codex | agy        model: id from ~/.claude/model-registry.json
#   session.jsonl: this Claude session's transcript (sent to the model on the FIRST turn only, as context)
#   state-dir: a folder for this chat (created if missing): history.md, claude-session (forked id), last.log,
#              last-stats.json + stats.jsonl (the numbers the CLI reported for the turn; see below),
#              last-result.json (claude/agy raw JSON), last-events.jsonl (codex --json events)
#   message-file: a file holding the user's message (avoids shell quoting)
# Prints the model's answer on stdout. Exit 1 with the error on stderr if the provider call fails.
# Claude tools are disabled; Codex uses a read-only sandbox. agy is instructed to consult only, without an enforced read-only guarantee.
#
# Stats (2026-10-27): after a good turn, last-stats.json holds ONLY numbers the CLI reported (a field it did not
# report is null, never 0). The one computed field is context_tokens (a sum of reported counts), and codex's
# duration_ms, which the CLI does not report: the script times the call ("duration_source": "wall").
# Stats are best-effort: a parse failure never loses the answer (it is noted in last.log, no stats file is written).
set -u
export PATH="${PATH:-/usr/bin:/bin}:$HOME/.local/bin:/opt/homebrew/bin:/opt/homebrew/lib/node_modules/@openai/codex/bin:/usr/local/bin:/usr/bin:/bin"
PROVIDER="${1:?provider}"; MODEL="${2:?model}"; TRANSCRIPT="${3:?session.jsonl}"; STATE="${4:?state-dir}"; MSGFILE="${5:?message-file}"
mkdir -p "$STATE"
HIST="$STATE/history.md"; LOG="$STATE/last.log"; OUT="$STATE/last-answer.md"
STATS="$STATE/last-stats.json"; STATSLOG="$STATE/stats.jsonl"; RAWJSON="$STATE/last-result.json"; EVENTS="$STATE/last-events.jsonl"
EXTRACT="$(dirname "$0")/smodel-transcript.py"
REG="$HOME/.claude/model-registry.json"
MSG="$(cat "$MSGFILE")"
EFFORT="$(python3 -I -c "
import json,sys
r=json.load(open(sys.argv[1]))
for p in r['providers']:
    if p['id']==sys.argv[2]:
        for m in p['models']:
            if m['id']==sys.argv[3]: print(m.get('effort','high')); sys.exit(0)
print('high')" "$REG" "$PROVIDER" "$MODEL" 2>/dev/null || echo high)"
: > "$LOG"
# A turn whose stats cannot be read must never show the previous turn's numbers.
rm -f "$STATS"
WALL_MS=""

now_ms() { python3 -I -c 'import time; print(int(time.time()*1000))'; }

# Normalizes one CLI's raw output into the stats object. argv: provider model source-file wall-ms
NORM_PY='
import json, sys, time
prov, model, src, wall = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
def num(v):
    return v if isinstance(v, (int, float)) and not isinstance(v, bool) else None
def total(*vs):
    return sum(vs) if all(v is not None for v in vs) else None
keys = ["input_tokens","cached_tokens","cache_write_tokens","output_tokens","thinking_tokens","context_tokens",
        "context_window","cost_usd","cost_basis","duration_ms","num_turns"]
o = {"provider": prov, "model": model, "at_ms": int(time.time()*1000)}
o.update({k: None for k in keys})
if prov == "claude":
    d = json.load(open(src))
    u = d.get("usage") or {}
    o["input_tokens"] = num(u.get("input_tokens"))
    o["cached_tokens"] = num(u.get("cache_read_input_tokens"))
    o["cache_write_tokens"] = num(u.get("cache_creation_input_tokens"))
    o["output_tokens"] = num(u.get("output_tokens"))
    o["thinking_tokens"] = num((u.get("output_tokens_details") or {}).get("thinking_tokens"))
    o["context_tokens"] = total(o["input_tokens"], o["cached_tokens"], o["cache_write_tokens"])
    mu = d.get("modelUsage") or {}
    if isinstance(mu, dict) and len(mu) == 1:
        w = num((list(mu.values())[0] or {}).get("contextWindow"))
        o["context_window"] = w if w else None
    o["cost_usd"] = num(d.get("total_cost_usd"))
    if o["cost_usd"] is not None:
        o["cost_basis"] = "list-price equivalent from the Claude CLI; not a bill on the subscription"
    o["duration_ms"] = num(d.get("duration_ms"))
    o["num_turns"] = num(d.get("num_turns"))
elif prov == "codex":
    usage = None
    for line in open(src):
        try:
            ev = json.loads(line)
        except Exception:
            continue
        if isinstance(ev, dict) and ev.get("type") == "turn.completed" and isinstance(ev.get("usage"), dict):
            usage = ev["usage"]
    if usage is None:
        raise SystemExit("no turn.completed usage in the codex events")
    o["input_tokens"] = num(usage.get("input_tokens"))
    o["cached_tokens"] = num(usage.get("cached_input_tokens"))
    o["cache_write_tokens"] = num(usage.get("cache_write_input_tokens"))
    o["output_tokens"] = num(usage.get("output_tokens"))
    o["thinking_tokens"] = num(usage.get("reasoning_output_tokens"))
    o["context_tokens"] = o["input_tokens"]
    if wall.isdigit():
        o["duration_ms"] = int(wall)
        o["duration_source"] = "wall"
elif prov == "agy":
    d = json.load(open(src))
    u = d.get("usage") or {}
    o["input_tokens"] = num(u.get("input_tokens"))
    o["cached_tokens"] = num(u.get("cache_read_tokens"))
    o["output_tokens"] = num(u.get("output_tokens"))
    o["thinking_tokens"] = num(u.get("thinking_tokens"))
    o["context_tokens"] = o["input_tokens"]
    s = num(d.get("duration_seconds"))
    o["duration_ms"] = round(s * 1000, 3) if s is not None else None
    o["num_turns"] = num(d.get("num_turns"))
else:
    raise SystemExit("unknown provider " + prov)
print(json.dumps(o))
'

# Best-effort: writes last-stats.json and appends stats.jsonl; any failure is only a note in last.log.
write_stats() {
  local src="$1" js
  js=$(python3 -I -c "$NORM_PY" "$PROVIDER" "$MODEL" "$src" "$WALL_MS" 2>>"$LOG") || js=""
  if [ -z "$js" ]; then echo "smodel-turn: stats skipped (could not parse $src)" >>"$LOG"; return 0; fi
  if printf '%s\n' "$js" > "$STATS.tmp" && mv "$STATS.tmp" "$STATS"; then
    printf '%s\n' "$js" >> "$STATSLOG" || echo "smodel-turn: could not append $STATSLOG" >>"$LOG"
  else
    echo "smodel-turn: stats skipped (could not write $STATS)" >>"$LOG"; rm -f "$STATS.tmp"
  fi
  return 0
}

HEADER="You are $MODEL, consulted from inside the user's Claude Code session in a side chat. Plain English, short, verdict first. Disagree with Claude when Claude is wrong. Numbers only with a source. You cannot change files; this is a consult."

STATS_SRC=""
case "$PROVIDER" in
  claude)
    CLAUDE_BIN=$(command -v claude || true)
    if [ -z "$CLAUDE_BIN" ] && [ -x /opt/homebrew/bin/claude ]; then CLAUDE_BIN=/opt/homebrew/bin/claude; fi
    if [ -z "$CLAUDE_BIN" ]; then echo "smodel-turn: claude not installed; install and authenticate the Claude CLI." >&2; exit 1; fi
    SIDFILE="$STATE/claude-session"
    LEAN=(--tools "" --strict-mcp-config --setting-sources "" --disable-slash-commands --output-format json)
    if [ -s "$SIDFILE" ]; then
      RES=$(printf '%s\n' "$MSG" | "$CLAUDE_BIN" -p --resume "$(cat "$SIDFILE")" --model "$MODEL" --effort "$EFFORT" "${LEAN[@]}" 2>>"$LOG")
    else
      ORIG="$(basename "$TRANSCRIPT" .jsonl)"
      RES=$(printf '%s\n\n%s\n' "$HEADER" "$MSG" | "$CLAUDE_BIN" -p --resume "$ORIG" --fork-session --model "$MODEL" --effort "$EFFORT" "${LEAN[@]}" 2>>"$LOG")
    fi
    ANSWER=$(printf '%s' "$RES" | python3 -I -c "
import json,sys
try:
    d=json.loads(sys.stdin.read()); print(d.get('result','')); sid=d.get('session_id')
    open(sys.argv[1],'w').write(sid or '') if sid else None
except Exception as e: print('', end='')" "$SIDFILE")
    printf '%s' "$RES" > "$RAWJSON" && STATS_SRC="$RAWJSON"
    ;;
  codex|agy)
    if [ ! -s "$HIST" ]; then
      { echo "=== CONVERSATION BETWEEN THE USER AND CLAUDE (context; tool output removed) ==="; python3 -I "$EXTRACT" "$TRANSCRIPT" 60000; echo; echo "=== SIDE CHAT ==="; } > "$HIST"
    fi
    printf '\n--- USER ---\n%s\n' "$MSG" >> "$HIST"
    PROMPT="$HEADER

$(cat "$HIST")

--- $MODEL (answer now) ---"
    if [ "$PROVIDER" = codex ]; then
      [ "$EFFORT" = "as named" ] && EFFORT=high
      # A stale answer file must never be shown as this turn's answer.
      rm -f "$OUT"
      T0=$(now_ms)
      printf '%s\n' "$PROMPT" | codex exec --json --skip-git-repo-check --ephemeral -s read-only --color never -m "$MODEL" -c model_reasoning_effort="$EFFORT" -o "$OUT" - >"$EVENTS" 2>>"$LOG"
      T1=$(now_ms)
      case "$T0$T1" in *[!0-9]*|"") WALL_MS="" ;; *) WALL_MS=$((T1 - T0)) ;; esac
      ANSWER=$(cat "$OUT" 2>/dev/null)
      if [ -z "$ANSWER" ]; then
        # -o did not get written: take the last agent_message from the --json events.
        ANSWER=$(python3 -I -c "
import json,sys
text=''
for line in open(sys.argv[1]):
    try: ev=json.loads(line)
    except Exception: continue
    it=ev.get('item') if isinstance(ev,dict) else None
    if ev.get('type')=='item.completed' and isinstance(it,dict) and it.get('type')=='agent_message' and isinstance(it.get('text'),str):
        text=it['text']
print(text)" "$EVENTS" 2>>"$LOG")
        [ -n "$ANSWER" ] && echo "smodel-turn: codex -o file empty; answer taken from the --json events" >>"$LOG"
      fi
      if [ -z "$ANSWER" ]; then
        # Errors now arrive as events on stdout; put them where the failure message reads them.
        python3 -I -c "
import json,sys
for line in open(sys.argv[1]):
    try: ev=json.loads(line)
    except Exception: print(line.strip()); continue
    if isinstance(ev,dict) and ev.get('type') in ('error','turn.failed'):
        e=ev.get('error') if isinstance(ev.get('error'),dict) else {}
        print(ev.get('message') or e.get('message') or json.dumps(ev))" "$EVENTS" >>"$LOG" 2>/dev/null
      fi
      STATS_SRC="$EVENTS"
    else
      EF=(); case "$MODEL" in *-low|*-medium|*-high) ;; *) EF=(--effort xhigh) ;; esac
      # agy ignores plain piped stdin in print mode (its token counts showed the history never arrived, 2026-10-27),
      # so the history goes inside -p, as before the stdin change. Past 60,000 characters it keeps the heading line
      # and the newest 60,000 characters, which keeps the argument far below the system's argument-size limit.
      AGYHIST=$(python3 -I -c "
import sys
h=open(sys.argv[1]).read()
if len(h)>60000:
    first,_,rest=h.partition('\n')
    h=first+'\n[earlier history cut: the newest 60,000 characters follow]\n'+rest[-60000:]
sys.stdout.write(h)" "$HIST" 2>>"$LOG")
      AGYRAW=$(agy --model "$MODEL" ${EF[@]+"${EF[@]}"} -p "$HEADER

$AGYHIST

--- $MODEL (answer now) ---" --output-format json 2>>"$LOG" </dev/null)
      printf '%s' "$AGYRAW" > "$RAWJSON"
      # exit 0: answer printed; 3: status not SUCCESS (error text printed); 4: not JSON.
      ANSWER=$(python3 -I -c "
import json,sys
raw=open(sys.argv[1]).read()
try: d=json.loads(raw)
except Exception: sys.exit(4)
if not isinstance(d,dict): sys.exit(4)
if d.get('status')!='SUCCESS':
    err=d.get('error') or d.get('message') or d.get('response') or ''
    if not isinstance(err,str): err=json.dumps(err)
    print('agy status ' + str(d.get('status')) + ': ' + (err or json.dumps(d)))
    sys.exit(3)
r=d.get('response')
print((r if isinstance(r,str) else '').rstrip())" "$RAWJSON" 2>>"$LOG")
      AGYRC=$?
      if [ "$AGYRC" = 3 ]; then
        echo "smodel-turn: no answer from $PROVIDER/$MODEL. $(printf '%s' "$ANSWER" | tr '\n' ' ')" >&2; exit 1
      elif [ "$AGYRC" = 4 ]; then
        # Not JSON: keep the old behaviour (raw stdout is the answer), no stats.
        ANSWER="$AGYRAW"
        echo "smodel-turn: agy output was not JSON; raw output used as the answer, stats skipped" >>"$LOG"
      else
        STATS_SRC="$RAWJSON"
      fi
    fi
    [ -n "$ANSWER" ] && printf '\n--- %s ---\n%s\n' "$MODEL" "$ANSWER" >> "$HIST"
    ;;
  *) echo "smodel-turn: unknown provider $PROVIDER" >&2; exit 2 ;;
esac

if [ -z "$ANSWER" ]; then
  echo "smodel-turn: no answer from $PROVIDER/$MODEL. $(tail -3 "$LOG" | tr '\n' ' ')" >&2; exit 1
fi
[ -n "$STATS_SRC" ] && write_stats "$STATS_SRC"
printf '%s\n' "$ANSWER"
