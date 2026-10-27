"""Offline integration checks for bundled scripts; no authenticated provider calls."""
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]

class ScriptsTest(unittest.TestCase):
    def test_neutral_header_and_bundled_extractor(self):
        script = (ROOT / 'scripts/smodel-turn.sh').read_text()
        header = next(line for line in script.splitlines() if line.startswith('HEADER='))
        self.assertEqual(header, 'HEADER="You are $MODEL, consulted from inside the user\'s Claude Code session in a side chat. Plain English, short, verdict first. Disagree with Claude when Claude is wrong. Numbers only with a source. You cannot change files; this is a consult."')
        self.assertIn('EXTRACT="$(dirname "$0")/smodel-transcript.py"', script)
        self.assertNotIn('nothing on disk is changed', script)

    def test_bundled_extractor_keeps_text_and_drops_tools(self):
        with tempfile.TemporaryDirectory(dir=ROOT / 'tests') as folder:
            transcript = Path(folder) / 'session.jsonl'
            transcript.write_text('\n'.join(json.dumps(row) for row in [
                {'type': 'user', 'message': {'content': 'Hello from user'}},
                {'type': 'assistant', 'message': {'content': [{'type': 'tool_use', 'name': 'Read'}, {'type': 'text', 'text': 'Hello back'}]}},
                {'type': 'user', 'message': {'content': [{'type': 'tool_result', 'content': 'secret tool data'}]}},
            ]))
            result = subprocess.run(['python3', '-I', str(ROOT / 'scripts/smodel-transcript.py'), str(transcript)], capture_output=True, text=True, check=True)
            self.assertEqual(result.stdout, '--- USER ---\nHello from user\n\n--- CLAUDE ---\nHello back\n')

    def test_registry_and_claude_path_turn(self):
        with tempfile.TemporaryDirectory(dir=ROOT / 'tests') as folder:
            base = Path(folder)
            binaries = base / 'bin'; binaries.mkdir()
            calls = base / 'calls.json'
            for name, body in {
                'agy': '#!/bin/sh\nprintf "gemini-example-high\\tGemini example\\n"\n',
                'codex': '#!/bin/sh\nexit 99\n',
                'claude': '#!/usr/bin/env python3\nimport json,os,sys\njson.dump({"argv":sys.argv[1:],"stdin":sys.stdin.read()},open(os.environ["CALLS"],"w"))\nprint(json.dumps({"result":"ok","session_id":"fork-example"}))\n',
            }.items():
                exe = binaries / name; exe.write_text(body); exe.chmod(0o755)
            env = {**os.environ, 'HOME': str(base), 'PATH': f'{binaries}:/usr/bin:/bin', 'CALLS': str(calls)}
            registry = base / '.claude/model-registry.json'; registry.parent.mkdir()
            subprocess.run(['/bin/bash', str(ROOT / 'scripts/model-registry.sh'), str(registry)], env=env, check=True, capture_output=True, text=True)
            data = json.loads(registry.read_text())
            self.assertEqual([p['id'] for p in data['providers']], ['claude', 'codex', 'agy'])
            self.assertEqual([m['id'] for m in data['providers'][1]['models']], ['gpt-6-luna', 'gpt-6.1-sol', 'gpt-6-astra'])
            self.assertEqual(data['count'], 8)
            self.assertEqual(data['providers'][1]['models'][-1]['effort'], 'high')
            message = base / 'message.txt'; message.write_text('hello')
            result = subprocess.run(['/bin/bash', str(ROOT / 'scripts/smodel-turn.sh'), 'claude', 'opus', str(base / 'session.jsonl'), str(base / 'chat'), str(message)], env=env, capture_output=True, text=True, check=True)
            self.assertEqual(result.stdout, 'ok\n')
            record = json.loads(calls.read_text())
            args = record['argv']
            self.assertIn('--tools', args)
            self.assertIn('--fork-session', args)
            self.assertIn('consulted from inside the user', record['stdin'])

    def test_failed_discovery_preserves_registry(self):
        with tempfile.TemporaryDirectory(dir=ROOT / 'tests') as folder:
            base = Path(folder); binaries = base / 'bin'; binaries.mkdir()
            agy = binaries / 'agy'; agy.write_text('#!/bin/sh\necho discovery-failed >&2\nexit 7\n'); agy.chmod(0o755)
            registry = base / 'registry.json'; registry.write_text('existing registry')
            env = {**os.environ, 'HOME': str(base), 'PATH': f'{binaries}:/usr/bin:/bin'}
            result = subprocess.run(['/bin/bash', str(ROOT / 'scripts/model-registry.sh'), str(registry)], env=env, capture_output=True, text=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertEqual(registry.read_text(), 'existing registry')
            self.assertEqual(list(base.glob('registry.json.tmp.*')), [])

    def test_long_history_uses_stdin_for_claude_codex_and_capped_prompt_for_agy(self):
        with tempfile.TemporaryDirectory(dir=ROOT / 'tests') as folder:
            base = Path(folder); binaries = base / 'bin'; binaries.mkdir()
            stub = """#!/usr/bin/env python3
import json, os, sys
from pathlib import Path
name = Path(sys.argv[0]).name
record = {"argv": sys.argv[1:], "stdin": sys.stdin.read()}
json.dump(record, open(os.environ["CALLS"], "w"))
if name == "codex":
    Path(sys.argv[sys.argv.index("-o") + 1]).write_text("ok")
    print(json.dumps({"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":1}}))
elif name == "claude":
    print(json.dumps({"result":"ok","session_id":"example-fork"}))
else:
    if "-p" not in sys.argv or not sys.argv[sys.argv.index("-p") + 1].strip():
        print(json.dumps({"status":"ERROR","error":"empty prompt"}))
        sys.exit(1)
    print(json.dumps({"status":"SUCCESS","response":"ok"}))
"""
            for cli in ('claude', 'codex', 'agy'):
                exe = binaries / cli; exe.write_text(stub); exe.chmod(0o755)
            payload = 'z' * (300 * 1024)
            transcript = base / 'original.jsonl'
            transcript.write_text(json.dumps({'type':'user','message':{'content':payload}}))
            message = base / 'message.txt'; message.write_text(payload)
            for provider in ('claude', 'codex', 'agy'):
                message.write_text('Reply OK.' if provider == 'agy' else payload)
                calls = base / f'{provider}.json'
                env = {**os.environ, 'HOME': str(base), 'PATH': f'{binaries}:/usr/bin:/bin', 'CALLS': str(calls)}
                state = base / f'{provider}-chat'
                result = subprocess.run(['/bin/bash', str(ROOT / 'scripts/smodel-turn.sh'), provider, 'example-model', str(transcript), str(state), str(message)], env=env, capture_output=True, text=True)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(result.stdout, 'ok\n')
                record = json.loads(calls.read_text())
                if provider == 'agy':
                    # agy ignores plain piped stdin in print mode, so the history rides inside -p, capped.
                    prompt = record['argv'][record['argv'].index('-p') + 1]
                    self.assertEqual(record['stdin'], '')
                    self.assertNotIn('--input-format', record['argv'])
                    self.assertIn('consulted from inside the user', prompt)
                    self.assertTrue(prompt.split('\n\n')[1].startswith('=== CONVERSATION BETWEEN THE USER AND CLAUDE'))
                    self.assertIn('[earlier history cut: the newest 60,000 characters follow]', prompt)
                    self.assertIn('--- USER ---\nReply OK.', prompt)
                    self.assertTrue(prompt.endswith('--- example-model (answer now) ---'))
                    self.assertLess(len(prompt), 61000)
                    self.assertTrue(all(len(arg) < 10000 for arg in record['argv'] if arg != prompt))
                    continue
                self.assertTrue(all(len(arg) < 10000 for arg in record['argv']))
                self.assertIn(payload, record['stdin'])
                if provider != 'claude':
                    self.assertIn('CONVERSATION BETWEEN THE USER AND CLAUDE', record['stdin'])
                    self.assertGreater(len(record['stdin']), 600 * 1024)
                    self.assertEqual(record['argv'][-1], '-')
                else:
                    # Resume, too, must send a large message without argv transport.
                    subprocess.run(['/bin/bash', str(ROOT / 'scripts/smodel-turn.sh'), provider, 'example-model', str(transcript), str(state), str(message)], env=env, capture_output=True, text=True, check=True)
                    record = json.loads(calls.read_text())
                    self.assertEqual(record['stdin'], payload + '\n')
                    self.assertNotIn('--fork-session', record['argv'])

    def test_missing_quota_files_return_null_without_stderr(self):
        with tempfile.TemporaryDirectory(dir=ROOT / 'tests') as folder:
            result = subprocess.run(['/bin/bash', str(ROOT / 'scripts/smodel-limits.sh')], env={**os.environ, 'HOME': folder}, capture_output=True, text=True, check=True)
            self.assertEqual(json.loads(result.stdout), {'claude': None, 'codex': None, 'agy': None})
            self.assertEqual(result.stderr, '')

if __name__ == '__main__':
    unittest.main()
