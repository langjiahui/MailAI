"""Official domestic release discovery, verified without GitHub connectivity."""
import json
import re
from urllib.parse import quote
from .update_transport import open_public
from .update_trust import verify

ATOM_REPOSITORY = 'langjiahui2011/MailAI'
ATOM_API = 'https://api.atomgit.com/api/v5/repos/' + ATOM_REPOSITORY
ATOM_RELEASES = 'https://atomgit.com/' + ATOM_REPOSITORY + '/releases'
GITHUB_RELEASES = 'https://github.com/langjiahui/MailAI/releases'
NAMES = {'windows-x64': 'MailAI-Windows-x64-Setup.exe', 'macos-arm64': 'MailAI-macOS-arm64.pkg',
         'linux-x64': 'MailAI-Linux-x64.AppImage'}


def attachment(tag: str, name: str) -> str:
    return f'{ATOM_API}/releases/{quote(tag, safe="")}/attach_files/{quote(name, safe="")}/download'


def read_json(url: str) -> dict:
    with open_public(url, headers={'Accept': 'application/json'}, timeout=6) as response:
        raw = response.read(1024 * 1024 + 1)
        declared = int(response.headers.get('Content-Length') or 0)
    if len(raw) > 1024 * 1024:
        raise ValueError('更新清单过大')
    if declared and len(raw) != declared:
        raise OSError('更新清单下载不完整')
    result = json.loads(raw.decode('utf-8'))
    if not isinstance(result, dict):
        raise ValueError('更新清单格式错误')
    return result


def discover() -> dict:
    release = read_json(ATOM_API + '/releases/latest?type=latest')
    tag = str(release.get('tag_name') or '')
    if not re.fullmatch(r'v\d+\.\d+\.\d+', tag) or release.get('prerelease'):
        raise ValueError('国内更新版本尚未正式发布')
    manifest = verify(read_json(attachment(tag, 'latest.signed.json')))
    if manifest.get('version') != tag[1:] or manifest.get('release_url') != GITHUB_RELEASES + '/tag/' + tag:
        raise ValueError('国内更新清单版本不一致')
    assets = manifest.get('assets')
    if not isinstance(assets, dict):
        raise ValueError('国内更新清单缺少安装包')
    result = {**manifest, 'assets': {}}
    for device, name in NAMES.items():
        item = assets.get(device)
        if not isinstance(item, dict) or item.get('url') != f'{GITHUB_RELEASES}/download/{tag}/{name}':
            raise ValueError('国内更新安装包地址无效')
        if type(item.get('size')) is not int or not 0 < item['size'] <= 500 * 1024 * 1024:
            raise ValueError('国内更新安装包大小无效')
        result['assets'][device] = {**item, 'mirror_url': attachment(tag, name)}
    return result


def valid_mirror(url: str, original: str) -> bool:
    match = re.fullmatch(re.escape(GITHUB_RELEASES) + r'/download/(v\d+\.\d+\.\d+)/([^/]+)', original)
    return bool(match and match[2] in NAMES.values() and url == attachment(match[1], match[2]))
