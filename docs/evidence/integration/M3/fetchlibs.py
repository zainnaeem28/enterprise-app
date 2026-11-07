import lzma, re, subprocess, sys, os, urllib.request
base='https://deb.debian.org/debian/'
txt=lzma.open('/tmp/fe04-debs/Packages.xz','rt',encoding='utf8').read()
pk={}
prov={}
for blk in txt.split('\n\n'):
    d={}
    key=None
    for l in blk.split('\n'):
        if l[:1] in ' \t' and key: d[key]+=' '+l.strip(); continue
        if ':' in l:
            key,v=l.split(':',1); d[key]=v.strip()
    if 'Package' in d:
        pk[d['Package']]=d
        for p in d.get('Provides','').split(','):
            p=p.strip().split(' ')[0]
            if p: prov.setdefault(p,d['Package'])
def installed(n):
    return subprocess.run(['dpkg','-s',n],capture_output=True).returncode==0
want=sys.argv[1:]
seen=set(); order=[]
def visit(n):
    if n in seen: return
    seen.add(n)
    if n not in pk: n=prov.get(n,n)
    if n not in pk or installed(n): return
    for dep in pk[n].get('Depends','').split(','):
        alt=dep.strip().split('|')[0].strip().split(' ')[0].split(':')[0]
        if alt: visit(alt)
    order.append(n)
for w in want: visit(w)
os.makedirs('/tmp/fe04-libs',exist_ok=True)
for n in order:
    f='/tmp/fe04-debs/'+n+'.deb'
    if not os.path.exists(f): urllib.request.urlretrieve(base+pk[n]['Filename'],f)
    subprocess.run(['dpkg','-x',f,'/tmp/fe04-libs'],check=True)
print(len(order),'packages',order)
