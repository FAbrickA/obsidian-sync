"""Allowlisted runtime and freshly generated synthetic vault; never read a lab vault."""
import hashlib
import json
import uuid
from pathlib import Path
from zipfile import ZipFile, ZIP_DEFLATED

root = Path(__file__).resolve().parent.parent
dist = root / "dist"
manifest = json.loads((dist / "manifest.json").read_text(encoding="utf-8"))
hashes = json.loads((dist / "SHA256SUMS.json").read_text(encoding="utf-8"))
expected = {"main.js", "manifest.json", "styles.css", "LICENSE", "THIRD_PARTY_NOTICES.txt", "PROVENANCE.md"}
if set(hashes) != expected:
    raise ValueError("Unexpected release file inventory")
for name, digest in hashes.items():
    if hashlib.sha256((dist / name).read_bytes()).hexdigest() != digest:
        raise ValueError("Artifact changed after verification: " + name)
archive = dist / f"{manifest['id']}-{manifest['version']}.zip"
with ZipFile(archive, "w", ZIP_DEFLATED) as output:
    for name in sorted(expected | {"SHA256SUMS.json"}):
        output.write(dist / name, name)
with ZipFile(archive) as check:
    assert set(check.namelist()) == expected | {"SHA256SUMS.json"}
    assert check.testzip() is None
print(archive.relative_to(root).as_posix())

# Generate from constants and the verified artifact inventory, never from .lab/.
plugin = ".obsidian/plugins/" + manifest["id"] + "/"
synthetic = {
    ".webdav-sync-lab.json": json.dumps({"schema": 1, "purpose": "webdav-sync-lab", "nonce": str(uuid.uuid4())}),
    "Welcome.md": "# WebDAV Sync test vault\n\nSynthetic notes only. Configure a separate test WebDAV folder.\n",
    ".obsidian/community-plugins.json": json.dumps([manifest["id"]]),
    ".obsidian/core-plugins.json": json.dumps(["bookmarks"]),
    ".obsidian/app.json": "{}",
    plugin + "data.json": json.dumps({"autoSync": False, "syncOnStartup": False, "rememberPassword": False, "password": ""}),
}
lab_archive = dist / "webdav-sync-lab-vault.zip"
with ZipFile(lab_archive, "w", ZIP_DEFLATED) as output:
    for name in sorted(expected | {"SHA256SUMS.json"}):
        output.write(dist / name, plugin + name)
    for name, value in synthetic.items():
        output.writestr(name, value)
with ZipFile(lab_archive) as check:
    assert set(check.namelist()) == {plugin + name for name in expected | {"SHA256SUMS.json"}} | set(synthetic)
    assert check.testzip() is None
    for name, digest in hashes.items():
        assert hashlib.sha256(check.read(plugin + name)).hexdigest() == digest
print(lab_archive.relative_to(root).as_posix())
