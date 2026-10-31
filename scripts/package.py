"""Build and inspect deterministic, secret-free release archives using the standard library."""

from pathlib import Path
import hashlib
import io
import json
import os
import re
import tarfile
import gzip
import zipfile

ROOT = Path(__file__).resolve().parent.parent
VERSION = json.loads((ROOT / "package.json").read_text(encoding="utf-8"))["version"]
if not re.fullmatch(r"\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?", VERSION):
    raise SystemExit("Invalid package version")
OUT = ROOT / "release"
OUT.mkdir(exist_ok=True)
PLUGIN = ROOT / "plugins" / "minimax-coderelay"
manifest = json.loads((PLUGIN / ".minimax-plugin" / "plugin.json").read_text(encoding="utf-8"))
if manifest.get("version") != VERSION:
    raise SystemExit("Plugin and gateway versions differ")
if not (ROOT / "dist/src/cli.js").is_file():
    raise SystemExit("Run npm run build first")


def files(paths):
    selected = []
    for path in paths:
        source = ROOT / path
        if not source.exists():
            raise SystemExit(f"Required release input missing: {path}")
        if source.is_symlink():
            raise SystemExit("Release inputs cannot be symbolic links")
        candidates = source.rglob("*") if source.is_dir() else [source]
        for item in candidates:
            if item.is_symlink():
                raise SystemExit("Release inputs cannot be symbolic links")
            if item.is_file():
                selected.append(item)
    return sorted(set(selected))


gateway_files = files(["package.json", "package-lock.json", "dist/src", "src", "LICENSE", "README.md", "docs", "deploy"])
gateway_name = f"coderelay-gateway-{VERSION}"
gateway_archive = OUT / f"{gateway_name}.tar.gz"
with gateway_archive.open("wb") as raw:
    with gzip.GzipFile(filename="", fileobj=raw, mode="wb", mtime=0) as compressed:
        with tarfile.open(fileobj=compressed, mode="w") as archive:
            for file in gateway_files:
                relative = file.relative_to(ROOT).as_posix()
                body = file.read_bytes()
                info = tarfile.TarInfo(f"{gateway_name}/{relative}")
                info.size = len(body)
                info.mtime = 0
                info.mode = 0o755 if relative == "dist/src/cli.js" else 0o644
                archive.addfile(info, io.BytesIO(body))

plugin_archive = OUT / f"coderelay-minimax-{VERSION}.zip"
with zipfile.ZipFile(plugin_archive, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
    for file in files(["plugins/minimax-coderelay"]):
        relative = file.relative_to(PLUGIN)
        if relative.parts[0] == "test":
            continue
        info = zipfile.ZipInfo(f"minimax-coderelay/{relative.as_posix()}", date_time=(2026, 1, 1, 0, 0, 0))
        info.compress_type = zipfile.ZIP_DEFLATED
        info.external_attr = 0o100644 << 16
        archive.writestr(info, file.read_bytes())

# Inspect the exact archives that will be uploaded, including hidden manifests.
with zipfile.ZipFile(plugin_archive) as archive:
    assert archive.testzip() is None
    assert "minimax-coderelay/.minimax-plugin/plugin.json" in archive.namelist()
    for name in archive.namelist():
        assert not name.startswith("/") and ".." not in Path(name).parts
        assert not any(part in {"node_modules", ".coderelay", ".git"} for part in Path(name).parts)
with tarfile.open(gateway_archive, "r:gz") as archive:
    assert f"{gateway_name}/dist/src/cli.js" in archive.getnames()
    for entry in archive.getmembers():
        assert entry.isfile() and not entry.name.startswith("/") and ".." not in Path(entry.name).parts

checksums = []
for file in [gateway_archive, plugin_archive]:
    digest = hashlib.sha256(file.read_bytes()).hexdigest()
    checksums.append(f"{digest}  {file.name}")
    print(f"Packaged {file.name}: {file.stat().st_size} bytes")
(OUT / "SHA256SUMS").write_text("\n".join(checksums) + "\n", encoding="utf-8")
print("Verified archive layout, entries, and checksums.")
