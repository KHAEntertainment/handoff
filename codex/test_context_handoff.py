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

    def rollout(self, tokens, where=None, before=(), window=200000):
        where = where or os.path.join(self.home, '.codex', 'sessions', '2026', '10', '22')
        os.makedirs(where, exist_ok=True)
        path = os.path.join(where, f'rollout-2026-10-22T00-00-00-{SID}.jsonl')
        info = {'last_token_usage': {'total_tokens': tokens}, 'model_context_window': window}
        with open(path, 'w') as f:
            for record in [*before, {'type': 'event_msg', 'payload': {'type': 'token_count', 'info': info}}]:
                f.write(json.dumps(record, separators=(',', ':')) + '\n')
        return path

    @staticmethod
    def message(text, role='user'):
        return {'type': 'response_item', 'payload': {'type': 'message', 'role': role, 'content': [{'type': 'input_text', 'text': text}]}}

    @classmethod
    def reasoning(cls, *sizes):
        return [{'type': 'response_item', 'payload': {'type': 'reasoning', 'summary': [], 'encrypted_content': 'g' * size}} for size in sizes]

    @classmethod
    def turn(cls, prompt, *reasoning_bytes):
        """A turn as Codex writes it to the rollout: its start, injected context, the prompt, then the reasoning."""
        return [{'type': 'event_msg', 'payload': {'type': 'task_started', 'turn_id': prompt}},
                cls.message('# AGENTS.md instructions\n\n<INSTRUCTIONS>...</INSTRUCTIONS>'),
                cls.message(prompt), *cls.reasoning(*reasoning_bytes)]

    def session_01a16a09(self, in_earlier_turns=True):
        """Session 01a16a09 at 15:57:55 on 2026-10-23, one request before Codex auto-compacted it.

        The API billed 477,489 tokens, 82% of the 580,000 limit, so the hook never asked. Codex's own
        count was 583,096: it also takes in the reasoning of the 14 earlier turns, 635,508 bytes.
        """
        with open(os.path.join(self.home, '.codex', 'config.toml'), 'w') as f:
            f.write('model_auto_compact_token_limit = 580000\n')
        sizes = [2508, 54948, 8156, 35512, 18280, 53960, 76500, 168432, 31628, 38404, 46696, 4344, 34700, 61440]
        before = ([record for n, size in enumerate(sizes) for record in self.turn(f't{n}', size)] + self.turn('now')
                  if in_earlier_turns else self.turn('now', *sizes))
        return self.rollout(477489, before=before, window=828400)

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

    def test_without_tomllib_accepts_underscored_integers(self):
        with open(os.path.join(self.home, '.codex', 'config.toml'), 'w') as f:
            f.write('model_auto_compact_token_limit = 100_000\n')
        out = self.run_hook('post-tool', no_tomllib=True, transcript_path=self.rollout(95000))
        self.assertIn('95%', out['hookSpecificOutput']['additionalContext'])

    def test_without_tomllib_ignores_the_key_in_other_tables(self):
        # 95000 would be 190% of the 50000 in [profiles.unused], but 53% of the 90% window that applies.
        with open(os.path.join(self.home, '.codex', 'config.toml'), 'w') as f:
            f.write('model = "gpt-6"\n\n[profiles.unused]\nmodel_auto_compact_token_limit = 50000\n')
        self.assertIsNone(self.run_hook('post-tool', no_tomllib=True, transcript_path=self.rollout(95000)))

    def test_without_tomllib_and_no_config_the_window_is_the_limit(self):
        os.remove(os.path.join(self.home, '.codex', 'config.toml'))
        self.assertIsNone(self.run_hook('post-tool', no_tomllib=True, transcript_path=self.rollout(95000)))
        out = self.run_hook('post-tool', no_tomllib=True, transcript_path=self.rollout(175000))
        self.assertIn('97%', out['hookSpecificOutput']['additionalContext'])

    def test_earlier_turns_reasoning_counts_toward_the_limit(self):
        # 477,489 + 635,508 / 4 = 636,366: 110% of 580,000.
        out = self.run_hook('post-tool', transcript_path=self.session_01a16a09())
        self.assertIn('110% of', out['hookSpecificOutput']['additionalContext'])
        self.assertIn('636,366 of 580,000', out['hookSpecificOutput']['additionalContext'])

    def test_current_turns_reasoning_is_not_added_again(self):
        # Same session, but if all 635,508 bytes were this turn's, the 477,489 billed already holds them.
        self.assertIsNone(self.run_hook('post-tool', transcript_path=self.session_01a16a09(in_earlier_turns=False)))
        self.assertEqual(self.state()['phase'], 'armed')

    def test_steering_within_a_task_moves_the_boundary(self):
        # A message sent while a task runs starts no new task, but Codex counts the reasoning before it:
        # 80,000 + 400,000 / 4 = 180,000.
        before = self.turn('task A', 400000) + [self.message('steer: use the other file')]
        out = self.run_hook('post-tool', transcript_path=self.rollout(80000, before=before))
        self.assertIn('180%', out['hookSpecificOutput']['additionalContext'])

    def test_tagged_instructions_are_boundaries(self):
        # Real instructions can start with a tag: a Traycer resume prompt, or steering wrapped in XML.
        for text in ('<task>use the other file</task>',
                     '# AGENTS.md instructions are out of date, fix them first',
                     '<previous_session_context>\nnotes\n</previous_session_context>\n<current_user_query>go</current_user_query>'):
            with self.subTest(text=text[:20]):
                self.tearDown(); self.setUp()
                before = self.turn('task A', 400000) + [self.message(text)]
                out = self.run_hook('post-tool', transcript_path=self.rollout(80000, before=before))
                self.assertIn('180%', out['hookSpecificOutput']['additionalContext'])

    def test_inter_agent_instruction_is_a_boundary(self):
        sent = json.dumps({'author': '/root', 'recipient': '/root/worker', 'other_recipients': [], 'content': 'steer', 'trigger_turn': False})
        before = self.turn('task A', 400000) + [self.message(sent, role='assistant')]
        out = self.run_hook('post-tool', transcript_path=self.rollout(80000, before=before))
        self.assertIn('180%', out['hookSpecificOutput']['additionalContext'])

    def test_injected_context_and_plain_assistant_text_are_not_boundaries(self):
        # Context Codex injects after the prompt leaves the prompt's own reasoning billed: 50,000 is 50%.
        before = self.turn('task A', 400000) + [self.message('<ENVIRONMENT_CONTEXT>\n</environment_context>'),
                                                self.message('# AGENTS.md instructions\n\n<INSTRUCTIONS>\n</INSTRUCTIONS>'),
                                                self.message('Checking the other file next.', role='assistant'),
                                                self.message('{"risk_level": "low"}', role='assistant')]
        self.assertIsNone(self.run_hook('post-tool', transcript_path=self.rollout(50000, before=before)))

    def test_reasoning_before_a_compaction_is_not_added(self):
        compacted = {'type': 'compacted', 'payload': {'message': '', 'replacement_history': [{'type': 'message', 'role': 'user', 'content': []}]}}
        before = self.turn('t0', 400000) + self.turn('t1', 400000) + [compacted] + self.turn('t2', 4000) + self.turn('t3')
        self.assertIsNone(self.run_hook('post-tool', transcript_path=self.rollout(50000, before=before)))
        # 50,000 + 4,000 / 4 = 51,000: only t2, which came after the compaction, counts.
        self.assertIn('96%', self.run_hook('post-tool', transcript_path=self.rollout(95000, before=before))['hookSpecificOutput']['additionalContext'])

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
