"""Native exit waits for the editor; no GUI or user mailbox needed."""
import sys
import threading
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app.draft_lifecycle import request_safe_exit


def main():
    for accepted in (True, False):
        ready = threading.Event()
        class Window:
            calls = 0
            def evaluate_js(self, script, callback):
                assert 'mailaiPrepareExit' in script
                self.calls += 1
                self.callback = callback
                ready.set()
        class Runtime:
            quitting = False
            window = Window()
            shown = False
            def show_window(self): self.shown = True
        runtime = Runtime()
        finished = []
        request_safe_exit(runtime, lambda: finished.append(True))
        assert ready.wait(2)
        request_safe_exit(runtime, lambda: finished.append(True))
        assert runtime.window.calls == 1
        assert not finished
        runtime.window.callback(accepted)
        assert finished == ([True] if accepted else [])
        assert runtime.shown is (not accepted)
        runtime.window.callback(True)
        assert len(finished) == int(accepted), 'A late callback must not exit twice'
    print('PASS native exit waits for save, rejects failure and deduplicates callbacks')


if __name__ == '__main__': main()
