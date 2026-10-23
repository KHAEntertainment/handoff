"""Tests for context_handoff.py. Each one runs the hook script on stdin under a throwaway HOME.

  python3 -m unittest codex/test_context_handoff.py
"""
import json, os, subprocess, sys, tempfile, unittest

SCRIPT = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'context_handoff.py')
SID = '01a00000-0000-7000-8000-000000000001'


class Hook(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.home = self.tmp.name
        os.makedirs(os.path.join(self.home, '.codex'))
        with open(os.path.join(self.home, '.codex', 'config.toml'), 'w') as f:
            f.write('model_auto_compact_token_limit = 100000\n')

    def tearDown(self):
        self.tmp.cleanup()

    def run_hook(self, mode, env=None, no_tomllib=False, **data):
        env = {**{k: v for k, v in os.environ.items() if not k.startswith('TRAYCER_') and k != 'CODEX_HOME'}, **(env or {})}
        env['HOME'] = self.home
        # Python before 3.11 has no tomllib: a None entry in sys.modules makes `import tomllib` fail the same way.
        cmd = ([sys.executable, '-I', '-c', 'import runpy, sys; sys.modules["tomllib"] = None; sys.argv = sys.argv[1:]; runpy.run_path(sys.argv[0], run_name="hook")', SCRIPT, mode]
               if no_tomllib else [sys.executable, '-I', SCRIPT, mode])
        done = subprocess.run(cmd, input=json.dumps({'session_id': SID, **data}),
                              capture_output=True, text=True, env=env, timeout=10)
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertEqual(done.stderr, '')
        return json.loads(done.stdout) if done.stdout.strip() else None

    def state(self):
        with open(os.path.join(self.home, '.codex', 'context-handoff', f'{SID}.json')) as f:
            return json.load(f)

    def handoff(self):
        return os.path.join(self.home, '.claude', 'handoffs', f'codex-{SID}.md')

    def write_handoff(self):
        with open(self.handoff(), 'w') as f:
            f.write('# Handoff\n' + 'state and next steps\n' * 20)

    def rollout(self, tokens, where=None):
        where = where or os.path.join(self.home, '.codex', 'sessions', '2026', '10', '22')
        os.makedirs(where, exist_ok=True)
        path = os.path.join(where, f'rollout-2026-10-22T00-00-00-{SID}.jsonl')
        info = {'last_token_usage': {'total_tokens': tokens}, 'model_context_window': 200000}
        with open(path, 'w') as f:
            f.write(json.dumps({'type': 'event_msg', 'payload': {'type': 'token_count', 'info': info}}) + '\n')
        return path

    # PreCompact

    def test_manual_compact_without_handoff_is_held(self):
        out = self.run_hook('pre-compact', trigger='manual')
        self.assertIs(out['continue'], False)
        self.assertIn('postponed', out['stopReason'])
        st = self.state()
        self.assertEqual((st['phase'], st['held']), ('nudged', True))
        self.assertEqual(st['handoff'], self.handoff())

    def test_second_manual_compact_goes_through(self):
        self.run_hook('pre-compact', trigger='manual')
        self.assertIsNone(self.run_hook('pre-compact', trigger='manual'))

    def test_manual_compact_with_handoff_goes_through(self):
        self.run_hook('pre-compact', trigger='manual')
        self.write_handoff()
        self.run_hook('session-start', source='compact')  # a compaction clears the hold
        self.assertIsNone(self.run_hook('pre-compact', trigger='manual'))

    def test_auto_compact_is_never_held(self):
        self.assertIsNone(self.run_hook('pre-compact', trigger='auto'))

    def test_subagent_compact_is_never_held(self):
        self.assertIsNone(self.run_hook('pre-compact', trigger='manual', agent_id='a1'))

    # UserPromptSubmit

    def test_prompt_after_hold_asks_once(self):
        self.run_hook('pre-compact', trigger='manual')
        out = self.run_hook('prompt', prompt='go')
        context = out['hookSpecificOutput']['additionalContext']
        self.assertIn(self.handoff(), context)
        self.assertIn('run /compact again', context)
        self.assertIsNone(self.run_hook('prompt', prompt='go'))

    def test_prompt_without_hold_says_nothing(self):
        self.assertIsNone(self.run_hook('prompt', prompt='go'))

    def test_written_after_hold_tells_agent_to_hand_back(self):
        self.run_hook('pre-compact', trigger='manual')
        self.run_hook('prompt', prompt='go')
        self.write_handoff()
        out = self.run_hook('post-tool')
        self.assertIn('run /compact again', out['hookSpecificOutput']['additionalContext'])
        self.assertEqual(self.state()['phase'], 'ready')

    def test_stop_after_hold_hands_back_instead_of_resuming(self):
        self.run_hook('pre-compact', trigger='manual')
        self.run_hook('prompt', prompt='write the handoff')
        out = self.run_hook('stop')
        self.assertEqual(out['decision'], 'block')
        self.assertIn('run /compact again', out['reason'])
        self.assertNotIn('finish what you were doing', out['reason'])

    def test_stop_after_threshold_nudge_resumes_the_task(self):
        self.run_hook('post-tool', transcript_path=self.rollout(95000))
        self.assertIn('finish what you were doing', self.run_hook('stop')['reason'])

    def test_compaction_clears_hold(self):
        self.run_hook('pre-compact', trigger='manual')
        self.write_handoff()
        out = self.run_hook('session-start', source='compact')
        self.assertIn(self.handoff(), out['hookSpecificOutput']['additionalContext'])
        st = self.state()
        self.assertEqual((st['phase'], st['held'], st['asked']), ('cooling', False, False))

    # PostToolUse threshold

    def test_threshold_nudge_from_transcript_path(self):
        out = self.run_hook('post-tool', transcript_path=self.rollout(95000))
        self.assertIn('95%', out['hookSpecificOutput']['additionalContext'])
        self.assertEqual(self.state()['phase'], 'nudged')

    def test_threshold_nudge_finds_rollout_when_transcript_path_is_null(self):
        self.rollout(95000)
        out = self.run_hook('post-tool', transcript_path=None)
        self.assertIn('95%', out['hookSpecificOutput']['additionalContext'])

    def test_null_transcript_uses_codex_home(self):
        custom = os.path.join(self.home, 'custom-codex')
        os.makedirs(custom)
        with open(os.path.join(custom, 'config.toml'), 'w') as f:
            f.write('model_auto_compact_token_limit = 100000\n')
        os.remove(os.path.join(self.home, '.codex', 'config.toml'))
        self.rollout(95000, where=os.path.join(custom, 'sessions', '2026', '10', '22'))
        out = self.run_hook('post-tool', transcript_path=None, env={'CODEX_HOME': custom})
        self.assertIn('95%', out['hookSpecificOutput']['additionalContext'])

    def test_threshold_without_tomllib_reads_limit_with_regex(self):
        # 95000 is 95% of the 100000 limit in config.toml, but only 53% of the 90% window fallback.
        with open(os.path.join(self.home, '.codex', 'config.toml'), 'w') as f:
            f.write('model = "gpt-6"\n  model_auto_compact_token_limit = 100000  # tokens\n[profiles.x]\n')
        out = self.run_hook('post-tool', no_tomllib=True, transcript_path=self.rollout(95000))
        self.assertIn('95%', out['hookSpecificOutput']['additionalContext'])

    def test_without_tomllib_and_no_config_the_window_is_the_limit(self):
        os.remove(os.path.join(self.home, '.codex', 'config.toml'))
        self.assertIsNone(self.run_hook('post-tool', no_tomllib=True, transcript_path=self.rollout(95000)))
        out = self.run_hook('post-tool', no_tomllib=True, transcript_path=self.rollout(175000))
        self.assertIn('97%', out['hookSpecificOutput']['additionalContext'])

    def test_below_threshold_stays_armed(self):
        self.assertIsNone(self.run_hook('post-tool', transcript_path=self.rollout(50000)))
        self.assertEqual(self.state()['phase'], 'armed')

    def test_old_state_file_without_hold_fields_still_loads(self):
        os.makedirs(os.path.join(self.home, '.codex', 'context-handoff'))
        with open(os.path.join(self.home, '.codex', 'context-handoff', f'{SID}.json'), 'w') as f:
            json.dump({'phase': 'armed', 'handoff': '', 'nudged_at': 0, 'steps': 0, 'since_ready': 0, 'chased': False}, f)
        self.assertIsNone(self.run_hook('prompt', prompt='go'))
        self.assertIs(self.run_hook('pre-compact', trigger='manual')['continue'], False)


if __name__ == '__main__':
    unittest.main()
