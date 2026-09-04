import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

test("packaged instructions survive publication without accepting stale links or unchecked installs", () => {
  const probe = spawnSync("python3", ["-c", String.raw`
import json
from pathlib import Path
from scripts.package_docs import package_document_failures
from scripts.public_surface_gate import install_reference_failures, release_asset_url
version = json.loads(Path('package.json').read_text())['version']
readme = Path('README.md').read_text()
guide = Path('docs/INSTALL_WITHOUT_NPM_ACCOUNT.md').read_text()
assert package_document_failures(version, readme, guide) == []
# Immutable instructions stay valid before and after publication.
assert package_document_failures('99.0.0', readme.replace(version, '99.0.0'), guide.replace(version, '99.0.0')) == []
mutations = [
    (readme.replace('&&', ';'), guide),
    (readme.replace('@sulmusic/agent-vigil@' + version, '@sulmusic/agent-vigil@latest'), guide),
    (readme.replace('releases/download/v' + version, 'releases/download/v0.1.0'), guide),
    (readme.replace('docs/INSTALL_WITHOUT_NPM_ACCOUNT.md', 'docs/obsolete.md'), guide),
    (readme + '\nInstall the published v' + version + ' package:', guide),
    (readme, guide + '\nThis is a source release candidate.'),
    (readme, guide.replace('&&', ';')),
    (readme, guide.replace('.tgz.sha256 &&', '.tgz.sha256;')),
    (readme, guide.replace('sulmusic-agent-vigil-' + version, 'sulmusic-agent-vigil-0.1.0')),
    (readme, guide.replace('https://github.com/sulmusic2-star/agent-vigil/blob/main/docs/public-install-state.json', '#')),
    (readme, guide + '\nnpm view @sulmusic/agent-vigil version'),
]
for index, (bad_readme, bad_guide) in enumerate(mutations):
    assert package_document_failures(version, bad_readme, bad_guide), index
# Live pages must still reject unpublished candidate install instructions.
live = release_asset_url('0.23.1') + '\n' + release_asset_url('0.23.2')
assert install_reference_failures('website', live, '0.23.1', '0.23.2', '0.21.1')
assert install_reference_failures('website', live + '\n@sulmusic/agent-vigil@0.23.2', '0.23.1', '0.23.2', '0.21.1')
`], { cwd: process.cwd(), encoding: "utf8" });
  assert.equal(probe.status, 0, `${probe.stdout}\n${probe.stderr}`);
});

test("the checksum sequence never installs after a download or verification fails", () => {
  const probe = spawnSync("python3", ["-c", String.raw`
from pathlib import Path
import re, subprocess
guide = Path('docs/INSTALL_WITHOUT_NPM_ACCOUNT.md').read_text()
block = re.search(r'\x60\x60\x60bash\n(.*?)\n\x60\x60\x60', guide, re.S).group(1)
for stage in [1, 2, 3, 0]:
    prelude = '''i=0
curl() { i=$((i+1)); [ "$i" != "$FAIL_STAGE" ]; }
shasum() { [ "$FAIL_STAGE" != 3 ]; }
npx() { printf INSTALL_REACHED; }
'''
    result = subprocess.run(['sh', '-c', f'FAIL_STAGE={stage}\n' + prelude + block], capture_output=True, text=True)
    assert ('INSTALL_REACHED' in result.stdout) == (stage == 0), (stage, result)
    assert (result.returncode == 0) == (stage == 0), (stage, result)
`], { cwd: process.cwd(), encoding: "utf8" });
  assert.equal(probe.status, 0, `${probe.stdout}\n${probe.stderr}`);
});

test("package smoke rejects stale documentation inside a tarball before trying installation", () => {
  const probe = spawnSync("python3", ["-c", String.raw`
import io, json, tarfile, tempfile
from pathlib import Path
from scripts.package_install_smoke import anonymous_package_install
manifest = json.loads(Path('package.json').read_text())
version = manifest['version']
with tempfile.TemporaryDirectory() as temporary:
    lab = Path(temporary)
    tarball = lab / 'stale-docs.tgz'
    with tarfile.open(tarball, 'w:gz') as archive:
        for name in ['package.json', 'README.md', 'docs/INSTALL_WITHOUT_NPM_ACCOUNT.md']:
            text = Path(name).read_text()
            if name == 'README.md':
                text = text.replace('@sulmusic/agent-vigil@' + version, '@sulmusic/agent-vigil@0.1.0')
            payload = text.encode()
            entry = tarfile.TarInfo('package/' + name)
            entry.size = len(payload)
            archive.addfile(entry, io.BytesIO(payload))
    try:
        anonymous_package_install(tarball, lab, 'a' * 40)
        raise AssertionError('stale packed documentation was accepted')
    except RuntimeError as error:
        assert 'packed instructions failed' in str(error), error
    assert not (lab / 'anonymous-repo').exists(), 'installation started before document validation'
`], { cwd: process.cwd(), encoding: "utf8" });
  assert.equal(probe.status, 0, `${probe.stdout}\n${probe.stderr}`);
});
