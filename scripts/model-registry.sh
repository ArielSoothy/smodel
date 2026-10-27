#!/bin/bash
# Build the shared local registry; optional first argument selects a different output file.
set -euo pipefail
export PATH="${PATH:-/usr/bin:/bin}:$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin"
OUT="${1:-$HOME/.claude/model-registry.json}"
mkdir -p "$(dirname "$OUT")"
TMP=$(mktemp "$OUT.tmp.XXXXXX")
trap 'rm -f "$TMP"' EXIT
CLAUDE=0; CODEX=0; AGY=0; AGY_MODELS=""
if command -v claude >/dev/null 2>&1; then CLAUDE=1; fi
if command -v codex >/dev/null 2>&1; then CODEX=1; fi
if command -v agy >/dev/null 2>&1; then
  AGY=1
  AGY_MODELS=$(agy models | awk -F'\t' '/^[a-zA-Z0-9._-]+\t/ {printf "%s\t%s\n", $1, $2}')
fi
python3 -I - "$TMP" "$CLAUDE" "$CODEX" "$AGY" "$AGY_MODELS" <<'PY'
import datetime, json, sys
out, claude, codex, agy, agy_models = sys.argv[1:]
reg = {"updated": datetime.datetime.now().astimezone().isoformat(timespec="minutes"), "providers": []}
if claude == "1":
    reg["providers"].append({"id": "claude", "name": "Claude (Anthropic)", "cli": "claude",
        "open": "claude --resume <session> --fork-session --model <model> --effort <effort>",
        "models": [{"id": m, "label": label, "effort": effort} for m, label, effort in [
            ("fable", "Claude Fable 5.1", "xhigh"), ("opus", "Claude Opus 5.5", "xhigh"),
            ("sonnet", "Claude Sonnet 5.5", "xhigh"), ("haiku", "Claude Haiku 5.5", "high")]]})
if codex == "1":
    # Codex has no models command. Edit this list when the available model IDs change.
    models = [{"id": m, "label": m, "effort": "xhigh"} for m in ("gpt-6-luna", "gpt-6.1-sol")]
    models.append({"id": "gpt-6-astra", "label": "gpt-6-astra (read-only consult)", "effort": "high", "readonly": True})
    reg["providers"].append({"id": "codex", "name": "Codex (OpenAI)", "cli": "codex",
        "open": 'codex -m <model> -c model_reasoning_effort=<effort> -s read-only "<conversation>"', "models": models})
if agy == "1":
    models = []
    for line in agy_models.splitlines():
        if "\t" not in line:
            continue
        model, label = line.split("\t", 1)
        models.append({"id": model, "label": label.strip(), "effort": "as named" if model.endswith(("-low", "-medium", "-high")) else "xhigh"})
    reg["providers"].append({"id": "agy", "name": "Gemini and others via agy (Google)", "cli": "agy",
        "open": 'agy --model <model> --prompt-interactive "<conversation>"', "models": models})
reg["count"] = sum(len(provider["models"]) for provider in reg["providers"])
with open(out, "w") as f:
    json.dump(reg, f, indent=1)
print("models:", reg["count"], "|", " | ".join(f'{p["id"]}: {len(p["models"])}' for p in reg["providers"]))
PY
mv -f "$TMP" "$OUT"
printf 'registry written: %s\n' "$OUT"
