"""Run the packed README's install against a loopback registry serving the real tarball.

This tests prepublication packages, not public registry availability.
"""
from __future__ import annotations

import base64
import hashlib
import json
import os
from pathlib import Path
import shlex
import subprocess
import tarfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from threading import Thread
from urllib.parse import unquote

try:
    from .package_docs import install_command, package_document_failures
except ImportError:
    from package_docs import install_command, package_document_failures


def anonymous_environment() -> dict[str, str]:
    env = {key: value for key, value in os.environ.items()
           if not key.lower().startswith('npm_') and key not in {
               'NPM_TOKEN', 'NODE_AUTH_TOKEN', 'NODE_OPTIONS', 'GITHUB_TOKEN', 'GH_TOKEN'}
           and key.lower() not in {'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy'}}
    # A loopback registry must never depend on an inherited corporate proxy.
    env.update({'NO_PROXY': '127.0.0.1,localhost', 'no_proxy': '127.0.0.1,localhost'})
    return env


def anonymous_package_install(tarball: Path, lab: Path, action_sha: str) -> dict[str, object]:
    with tarfile.open(tarball, 'r:gz') as archive:
        def read(name: str) -> str:
            member = archive.getmember('package/' + name)
            if not member.isfile() or member.size > 1024 * 1024:
                raise RuntimeError(f'packed {name} must be a bounded regular file')
            stream = archive.extractfile(member)
            assert stream is not None
            return stream.read().decode('utf-8')
        manifest = json.loads(read('package.json'))
        readme = read('README.md')
        guide = read('docs/INSTALL_WITHOUT_NPM_ACCOUNT.md')
    version = manifest['version']
    failures = package_document_failures(version, readme, guide)
    if failures:
        raise RuntimeError('packed instructions failed: ' + '; '.join(failures))
    if manifest['name'] != '@sulmusic/agent-vigil' or manifest.get('dependencies'):
        raise RuntimeError('anonymous registry fixture expects the canonical dependency-free package')
    body = tarball.read_bytes()
    integrity = 'sha512-' + base64.b64encode(hashlib.sha512(body).digest()).decode()
    requests: list[tuple[str, bool]] = []

    class Registry(BaseHTTPRequestHandler):
        def do_GET(self) -> None:
            path = unquote(self.path).lower()
            requests.append((path, self.headers.get('Authorization') is not None))
            if path == '/package.tgz':
                data, content_type = body, 'application/octet-stream'
            elif path == '/@sulmusic/agent-vigil':
                data = json.dumps({
                    'name': manifest['name'], 'dist-tags': {'latest': version},
                    'versions': {version: {**manifest, 'dist': {
                        'tarball': f'http://127.0.0.1:{self.server.server_port}/package.tgz',
                        'integrity': integrity,
                    }}},
                }).encode()
                content_type = 'application/json'
            else:
                self.send_error(404)
                return
            self.send_response(200)
            self.send_header('Content-Type', content_type)
            self.send_header('Content-Length', str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def log_message(self, *_: object) -> None:
            pass

    home, consumer = lab / 'anonymous-home', lab / 'anonymous-repo'
    home.mkdir()
    consumer.mkdir()
    userconfig, globalconfig = home / '.npmrc', home / 'global-npmrc'
    userconfig.write_text('')
    globalconfig.write_text('')
    env = anonymous_environment()
    server = ThreadingHTTPServer(('127.0.0.1', 0), Registry)
    thread = Thread(target=server.serve_forever, daemon=True)
    thread.start()
    env.update({
        'HOME': str(home), 'npm_config_userconfig': str(userconfig),
        'npm_config_globalconfig': str(globalconfig), 'npm_config_cache': str(lab / 'anonymous-cache'),
        'npm_config_registry': f'http://127.0.0.1:{server.server_port}/',
        'npm_config_ignore_scripts': 'true', 'npm_config_audit': 'false',
        'npm_config_fund': 'false', 'npm_config_update_notifier': 'false',
    })

    def run(args: list[str]) -> str:
        result = subprocess.run(args, cwd=consumer, env=env, capture_output=True, text=True, timeout=120)
        if result.returncode:
            raise RuntimeError(f'anonymous install failed ({result.returncode}): {result.stdout}\n{result.stderr}')
        return result.stdout

    try:
        run(['git', 'init', '-q'])
        run(['git', 'config', 'user.name', 'Anonymous Package Trial'])
        run(['git', 'config', 'user.email', 'trial@agent-vigil.invalid'])
        (consumer / 'README.md').write_text('Disposable first-install repository.\n')
        run(['git', 'add', 'README.md'])
        run(['git', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'fixture'])
        observed = run(['npm', 'view', f'@sulmusic/agent-vigil@{version}', 'version']).strip()
        if observed != version:
            raise RuntimeError('anonymous registry returned a different version')
        # The validator checked this exact command in the packed README.
        output = run(shlex.split(install_command(version)) + ['--action-sha', action_sha])
        if 'PASS' not in output or 'FAIL' not in output:
            raise RuntimeError('anonymous protect did not demonstrate both rehearsal outcomes')
        workflow = (consumer / '.github/workflows/agent-vigil.yml').read_text()
        if f'sulmusic2-star/agent-vigil@{action_sha}' not in workflow:
            raise RuntimeError('anonymous protect wrote an incorrect Action pin')
        if any(auth for _, auth in requests):
            raise RuntimeError('anonymous install sent registry authentication')
        if not any(path == '/package.tgz' for path, _ in requests):
            raise RuntimeError('anonymous npx did not download the actual packed tarball')
        return {'version': version, 'registry': 'loopback fixture, not public publication',
                'packedDocs': 'PASS', 'protect': 'PASS', 'authenticatedRequests': 0,
                'tarballSha256': hashlib.sha256(body).hexdigest()}
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)
