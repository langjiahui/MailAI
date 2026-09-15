"""服务端文件夹入口应是默认关闭、可持久开启的界面偏好。"""
from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent


def test_server_folder_visibility_preference():
    html = (ROOT / "app/web/static/index.html").read_text(encoding="utf-8")
    source = (ROOT / "app/web/static/app.js").read_text(encoding="utf-8")

    assert 'id="server-folder-group" class="nav-group server-folder-group hidden"' in html
    assert 'id="show-server-folders" type="checkbox" role="switch"' in html
    assert 'data-system-panel="preferences"' in html
    assert "localStorage.getItem(SERVER_FOLDER_VISIBILITY_KEY) === 'true'" in source
    assert "classList.toggle('hidden', !visible)" in source
    assert "localStorage.setItem(SERVER_FOLDER_VISIBILITY_KEY, String(visible))" in source


if __name__ == '__main__':
    test_server_folder_visibility_preference()
    print('Server folder opt-in visibility passed')
