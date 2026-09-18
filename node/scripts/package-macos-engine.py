#!/usr/bin/env python3
"""Package an already-built native ACE-Step engine with relocatable dependencies."""
import ctypes
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tarfile
import tempfile

build, output, arch, backend, release_url = sys.argv[1:]
build, output = Path(build), Path(output)
output.mkdir(parents=True, exist_ok=True)
with tempfile.TemporaryDirectory() as temporary:
    package = Path(temporary) / 'engine'
    package.mkdir()
    # Materialize versioned aliases so relocation and signing cover every name.
    for source in build.rglob('*.dylib'):
        shutil.copy2(source.resolve(), package / source.name)
    assert (package / 'libcantor_engine.dylib').exists()
    for library in package.glob('*.dylib'):
        subprocess.run(['install_name_tool', '-id', '@rpath/' + library.name, str(library)], check=True)
        dependencies = subprocess.check_output(['otool', '-L', str(library)], text=True)
        for line in dependencies.splitlines()[1:]:
            dependency = line.strip().split(' (', 1)[0]
            name = Path(dependency).name
            if (package / name).exists():
                subprocess.run(['install_name_tool', '-change', dependency, '@loader_path/' + name, str(library)], check=True)
            elif not dependency.startswith(('/usr/lib/', '/System/Library/')):
                raise RuntimeError(f'Unbundled dependency: {library.name}: {dependency}')
        subprocess.run(['codesign', '--force', '--sign', '-', str(library)], check=True)
    # Smoke-load relocated artifacts, not the build tree.
    for name in ['libggml-base.dylib', 'libggml.dylib']:
        ctypes.CDLL(str(package / name), mode=ctypes.RTLD_GLOBAL)
    runtime = ctypes.CDLL(str(package / 'libggml.dylib'), mode=ctypes.RTLD_GLOBAL)
    runtime.ggml_backend_load_all_from_path.argtypes = [ctypes.c_char_p]
    runtime.ggml_backend_load_all_from_path(str(package).encode())
    runtime.ggml_backend_dev_count.restype = ctypes.c_size_t
    assert runtime.ggml_backend_dev_count() > 0, 'No compute backend was packaged'
    engine = ctypes.CDLL(str(package / 'libcantor_engine.dylib'))
    assert engine.cantor_engine_abi_version() == 1
    engine.cantor_engine_model.restype = ctypes.c_char_p
    assert engine.cantor_engine_model() == b'acestep'
    assert engine.cantor_engine_stages() == 30
    asset = f'acestep-engine-{backend}-{arch}-apple-darwin.tar.gz'
    path = output / asset
    with tarfile.open(path, 'w:gz', dereference=True) as archive:
        archive.add(package, arcname='engine')
    digest = hashlib.sha256(path.read_bytes()).hexdigest()
    (output / (asset + '.sha256')).write_text(f'{digest}  {asset}\n')
    (output / (asset + '.json')).write_text(json.dumps({
        'backend': backend, 'arch': f'{arch}-apple-darwin', 'os': 'macos',
        'url': f'{release_url}/{asset}', 'sha256': digest, 'bytes': path.stat().st_size,
    }, indent=2) + '\n')
