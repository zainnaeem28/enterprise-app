"""Fetch Debian .deb files and unpack them into a user directory (no root, no apt).

Usage: fetchlibs.py PACKAGE [PACKAGE ...]
Env:   FETCHLIBS_DEBS  download dir          (default /tmp/fe04-debs)
       FETCHLIBS_LIBS  extraction target     (default /tmp/fe04-libs)
       FETCHLIBS_SUITE Debian suite          (default trixie)
       FETCHLIBS_BASE  mirror base URL       (default https://deb.debian.org/debian/)

Integrity: Packages.xz is downloaded and checked against the SHA256 listed in the
suite's Release file; every .deb is checked against the SHA256 in Packages.
Both files come over HTTPS from the mirror. The Release GPG signature (InRelease)
is NOT checked here (no gpgv on the runner); see BROWSER-RUNNER-AND-0704.md.
Writes <debs>/MANIFEST.txt with name, version, sha256 of every unpacked package.
"""
import hashlib, lzma, os, subprocess, sys, urllib.request

base = os.environ.get('FETCHLIBS_BASE', 'https://deb.debian.org/debian/')
suite = os.environ.get('FETCHLIBS_SUITE', 'trixie')
debs = os.environ.get('FETCHLIBS_DEBS', '/tmp/fe04-debs')
libs = os.environ.get('FETCHLIBS_LIBS', '/tmp/fe04-libs')
os.makedirs(debs, exist_ok=True)


def sha256(path):
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for chunk in iter(lambda: f.read(1 << 20), b''):
            h.update(chunk)
    return h.hexdigest()


def fetch(url, dest):
    urllib.request.urlretrieve(url, dest)


# 1. Release (over HTTPS) -> expected SHA256 of Packages.xz
rel = os.path.join(debs, 'Release')
fetch(f'{base}dists/{suite}/Release', rel)
want_idx = None
in_sha = False
for line in open(rel, encoding='utf8'):
    if line.startswith('SHA256:'):
        in_sha = True
        continue
    if in_sha and not line.startswith(' '):
        in_sha = False
    if in_sha:
        h, _size, name = line.split()
        if name == 'main/binary-amd64/Packages.xz':
            want_idx = h
if not want_idx:
    sys.exit('Release has no SHA256 for main/binary-amd64/Packages.xz')
idx = os.path.join(debs, 'Packages.xz')
if not os.path.exists(idx) or sha256(idx) != want_idx:
    fetch(f'{base}dists/{suite}/main/binary-amd64/Packages.xz', idx)
if sha256(idx) != want_idx:
    sys.exit('Packages.xz SHA256 does not match Release')
print('Packages.xz sha256', want_idx)

txt = lzma.open(idx, 'rt', encoding='utf8').read()
pk = {}
prov = {}
for blk in txt.split('\n\n'):
    d = {}
    key = None
    for l in blk.split('\n'):
        if l[:1] in ' \t' and key:
            d[key] += ' ' + l.strip()
            continue
        if ':' in l:
            key, v = l.split(':', 1)
            d[key] = v.strip()
    if 'Package' in d:
        pk[d['Package']] = d
        for p in d.get('Provides', '').split(','):
            p = p.strip().split(' ')[0]
            if p:
                prov.setdefault(p, d['Package'])


def installed(n):
    return subprocess.run(['dpkg', '-s', n], capture_output=True).returncode == 0


seen = set()
order = []


def visit(n):
    if n in seen:
        return
    seen.add(n)
    if n not in pk:
        n = prov.get(n, n)
    if n not in pk or installed(n):
        return
    for dep in pk[n].get('Depends', '').split(','):
        alt = dep.strip().split('|')[0].strip().split(' ')[0].split(':')[0]
        if alt:
            visit(alt)
    if n not in order:
        order.append(n)


for w in sys.argv[1:]:
    visit(w)
os.makedirs(libs, exist_ok=True)
manifest = []
for n in order:
    f = os.path.join(debs, n + '.deb')
    expect = pk[n]['SHA256']
    if not os.path.exists(f) or sha256(f) != expect:
        fetch(base + pk[n]['Filename'], f)
    if sha256(f) != expect:
        sys.exit(f'{n}: SHA256 mismatch against Packages ({sha256(f)} != {expect})')
    subprocess.run(['dpkg', '-x', f, libs], check=True)
    manifest.append(f'{n} {pk[n]["Version"]} {expect}')
with open(os.path.join(debs, 'MANIFEST.txt'), 'w') as m:
    m.write('\n'.join(manifest) + '\n')
print(len(order), 'packages verified and unpacked; manifest', os.path.join(debs, 'MANIFEST.txt'))
