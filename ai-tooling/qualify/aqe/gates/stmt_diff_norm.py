# Statement multiset diff after canonicalising minifier-chosen identifiers (<=3 chars) and esbuild chunk hashes.
import sys, json, re, collections
r=json.load(open(sys.argv[1])); ID=re.compile(r'(?<![\w$.])[A-Za-z_$][\w$]{0,2}(?![\w$])')
KEEP={'if','for','let','var','new','try','do','in','of','as','get','set','!0','!1'}
def norm(s): return ID.sub(lambda m: m.group(0) if m.group(0) in KEEP else '§', s)
out={}
for g,v in r['groups'].items():
    a=collections.Counter(norm(x) for x in v['removed']); b=collections.Counter(norm(x) for x in v['added'])
    out[g]={'removedAfterRename':sorted((a-b).elements()),'addedAfterRename':sorted((b-a).elements())}
print(json.dumps(out,indent=1))
