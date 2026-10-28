# dist_matches.py <unpacked tarball package/> <installed node_modules/agentic-qe/>
# Every file the packed tarball holds must be byte-identical in the install. Prints JSON; exits 1 on any difference.
import sys, json, hashlib, pathlib
a, b = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2])
h = lambda p: hashlib.sha256(p.read_bytes()).hexdigest()
files = [p.relative_to(a) for p in a.rglob('*') if p.is_file()]
diff = [str(f) for f in files if not (b / f).is_file() or h(a / f) != h(b / f)]
print(json.dumps({'files': len(files), 'differing': diff[:50], 'differingCount': len(diff)}, indent=1))
sys.exit(1 if diff else 0)
