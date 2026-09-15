"""Run the isolated mailbox fixture with a deterministic, offline image model."""
import runpy
from pathlib import Path
import uvicorn

serve = uvicorn.run


def offline_serve(*args, **kwargs):
    from app import assistant_vision
    assistant_vision.client.available = lambda: True
    assistant_vision.client.chat_completion_stream = lambda *a, **k: iter(['图片中的项目安排已整理。'])
    serve(*args, **kwargs)


uvicorn.run = offline_serve
runpy.run_path(str(Path(__file__).with_name('workspace_preview.py')), run_name='__main__')
