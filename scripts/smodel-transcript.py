#!/usr/bin/env python3 -I
"""Extract the readable conversation (user + assistant text only, no tool calls/results)
from a Claude Code session transcript (.jsonl) in order, as plain text.
Usage: smodel-transcript.py <session.jsonl> [max_words]
Keeps the LAST max_words words if the transcript is longer (default 60000) and says so."""
import json, sys

path = sys.argv[1]
max_words = int(sys.argv[2]) if len(sys.argv) > 2 else 60000
msgs = []
for line in open(path, encoding="utf-8", errors="ignore"):
    try:
        d = json.loads(line)
    except json.JSONDecodeError:
        continue
    role = d.get("type")
    if role not in ("user", "assistant"):
        continue
    c = (d.get("message") or {}).get("content")
    if isinstance(c, str):
        txt = c
    elif isinstance(c, list):
        txt = "\n".join(b.get("text", "") for b in c if isinstance(b, dict) and b.get("type") == "text")
    else:
        continue
    txt = txt.strip()
    if not txt or txt.startswith("<local-command") or txt.startswith("<command-name>"):
        continue
    # Drop harness noise that is not the person's words.
    if role == "user" and ("[SYSTEM NOTIFICATION" in txt or txt.startswith("<system-reminder>")
                           or txt.startswith("<task-notification>") or txt.startswith("Base directory for this skill")
                           or txt.startswith("<local-command") or "\nARGUMENTS:" in txt):
        continue
    if role == "assistant":
        # Drop the clickable-button line, it is UI not content.
        txt = "\n".join(l for l in txt.splitlines() if not l.startswith("<next-buttons>")).strip()
        if not txt:
            continue
    msgs.append(("USER" if role == "user" else "CLAUDE", txt))

total = sum(len(t.split()) for _, t in msgs)
out = []
if total > max_words:
    kept, acc = [], 0
    for r, t in reversed(msgs):
        acc += len(t.split())
        kept.append((r, t))
        if acc >= max_words:
            break
    msgs = list(reversed(kept))
    out.append(f"[Transcript was {total} words; only the last {acc} words are included.]\n")
for r, t in msgs:
    out.append(f"--- {r} ---\n{t}\n")
sys.stdout.write("\n".join(out))
