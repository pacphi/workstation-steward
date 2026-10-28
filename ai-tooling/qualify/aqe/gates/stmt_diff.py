import sys, re, pathlib, collections, json, difflib, hashlib
off = pathlib.Path(sys.argv[1]); pat = pathlib.Path(sys.argv[2])
HASH = re.compile(r'\b([A-Za-z0-9_.-]+?)-[A-Z0-9]{8}\.js')
def stmts(text):
    text = HASH.sub(lambda m: m.group(1)+'-HASH.js', text)
    out=[]
    for line in text.splitlines():
        for s in re.split(r'[;{}]', line):
            s=s.strip()
            if s: out.append(s)
    return out
def files(root):
    return {str(p.relative_to(root)):p for p in root.rglob('*') if p.is_file()}
fo, fp = files(off), files(pat)
same=[k for k in fo if k in fp and fo[k].read_bytes()==fp[k].read_bytes()]
report={'identicalFiles':len(same),'officialFiles':len(fo),'patchedFiles':len(fp)}
# groups: tsc per-file outputs (paired by path), cli bundle+chunks (pooled), mcp bundle
diffpaths=sorted(set(fo)|set(fp)); diffpaths=[k for k in diffpaths if k not in same]
groups=collections.defaultdict(lambda:([],[]))
for k in diffpaths:
    g = 'dist/cli (bundle+chunks pooled)' if k.startswith('dist/cli/') else k
    if k in fo: groups[g][0].extend(stmts(fo[k].read_text(errors='replace')))
    if k in fp: groups[g][1].extend(stmts(fp[k].read_text(errors='replace')))
report['groups']={}
for g,(a,b) in groups.items():
    ca, cb = collections.Counter(a), collections.Counter(b)
    removed=list((ca-cb).elements()); added=list((cb-ca).elements())
    report['groups'][g]={'officialStatements':len(a),'patchedStatements':len(b),'removed':[r[:240] for r in removed],'added':[r[:240] for r in added]}
print(json.dumps(report,indent=1))
