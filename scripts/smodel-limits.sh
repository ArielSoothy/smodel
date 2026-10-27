#!/bin/bash
# smodel-limits.sh — the account usage limits each AI CLI really reports, for the /smodel pane. No model calls.
# Prints one JSON object: {"claude": {...} | null, "codex": {...} | null, "agy": null}. Always exits 0.
#   claude: ~/.claude/rate-limit-state.json (kept fresh by an existing hook; epoch seconds).
#   codex:  the last token_count line with rate_limits.primary in the newest non-ephemeral session file
#           ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl (at most the 5 newest files are read).
#   agy:    the CLI reports no limits anywhere, so always null.
# A missing or unreadable source makes that provider null; nothing is estimated.
export PATH="${PATH:-/usr/bin:/bin}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
OUT=$(python3 -I - "${HOME:-}" <<'PY' 2>/dev/null
import glob, json, os, sys

home = sys.argv[1]
out = {"claude": None, "codex": None, "agy": None}

def num(v):
    return v if isinstance(v, (int, float)) and not isinstance(v, bool) else None

try:
    d = json.load(open(os.path.join(home, ".claude", "rate-limit-state.json")))
    fh = d.get("five_hour") or {}
    sd = d.get("seven_day") or {}
    c = {
        "five_hour_pct": num(fh.get("pct")),
        "five_hour_resets_at": num(fh.get("resets_at")),
        "seven_day_pct": num(sd.get("pct")),
        "seven_day_resets_at": num(sd.get("resets_at")),
        "updated_at": num(d.get("updated_at")),
    }
    if c["five_hour_pct"] is not None or c["seven_day_pct"] is not None:
        out["claude"] = c
except Exception:
    pass

def window(w):
    if not isinstance(w, dict):
        return None
    r = {"used_percent": num(w.get("used_percent")), "window_minutes": num(w.get("window_minutes")),
         "resets_at": num(w.get("resets_at"))}
    return r if r["used_percent"] is not None else None

def tail_lines(path, limit):
    """The file's complete lines, newest first, read from at most its last `limit` bytes."""
    size = os.path.getsize(path)
    with open(path, "rb") as f:
        start = max(0, size - limit)
        f.seek(start)
        data = f.read()
    lines = data.split(b"\n")
    if start > 0:
        lines = lines[1:]  # the first piece may be a cut line
    return reversed(lines), start > 0

def codex_from(path):
    for limit in (512 * 1024, 16 * 1024 * 1024):
        lines, cut = tail_lines(path, limit)
        for raw in lines:
            if b"token_count" not in raw or b"rate_limits" not in raw:
                continue
            try:
                ev = json.loads(raw)
            except Exception:
                continue
            p = ev.get("payload") if isinstance(ev, dict) else None
            if not isinstance(p, dict) or p.get("type") != "token_count":
                continue
            rl = p.get("rate_limits")
            primary = window(rl.get("primary")) if isinstance(rl, dict) else None
            if primary is None:
                continue
            info = p.get("info") if isinstance(p.get("info"), dict) else {}
            plan = rl.get("plan_type")
            return {
                **primary,
                "plan_type": plan if isinstance(plan, str) else None,
                "secondary": window(rl.get("secondary")),
                "model_context_window": num(info.get("model_context_window")),
                "as_of": ev.get("timestamp") if isinstance(ev.get("timestamp"), str) else None,
                "source": path,
            }
        if not cut:
            break
    return None

try:
    files = glob.glob(os.path.join(home, ".codex", "sessions", "*", "*", "*", "rollout-*.jsonl"))
    files.sort(key=lambda f: os.path.getmtime(f), reverse=True)
    for f in files[:5]:
        try:
            got = codex_from(f)
        except Exception:
            got = None
        if got:
            out["codex"] = got
            break
except Exception:
    pass

print(json.dumps(out))
PY
)
if [ -n "$OUT" ]; then printf '%s\n' "$OUT"; else echo '{"claude": null, "codex": null, "agy": null}'; fi
exit 0
