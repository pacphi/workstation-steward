# G5: rollback works across the switch. A store the current runtime wrote is opened by the staged one (a schema
# migration happens here when the release changes the schema), which reads the known key and writes; then the
# current runtime reads both, writes, an independent current process reads, and the staged one reads again. No
# table loses rows, and the store stays intact. The 10-21 lane ran this on a backup copy of a real project store;
# this version builds a synthetic store with the current runtime, so no real store is opened (the schema is the
# same, v14, from 3.15.10 to 3.15.12).
import sys, os; sys.path.insert(0, os.environ["QGATES"])
from gatelib import *
import time
proj = project('proj-g5'); db = proj/'.agentic-qe'/'memory.db'
env = clean_env(W/'home-g5', {'AQE_MEMORY_PATH': str(db)})
canon = lambda o: hashlib.sha256(json.dumps(o, sort_keys=True, separators=(',', ':')).encode()).hexdigest()
ns, k, known_value = 'qe-kernel', 'q-known-key', {'note': 'synthetic known value written by the current runtime', 'n': 42, 'list': [1, 2, 3]}
def schema(dbp):
    c = sqlite3.connect(f'file:{dbp}?mode=ro', uri=True)
    try:
        sv = [r[0] for r in c.execute('select version from schema_version order by version')] if c.execute("select 1 from sqlite_master where name='schema_version'").fetchone() else None
        return {'user_version': c.execute('pragma user_version').fetchone()[0], 'schema_version_rows': sv, 'integrity': c.execute('pragma quick_check').fetchone()[0]}
    finally: c.close()
def value_sha(text):
    try:
        d = json.loads(text); data = d.get('data', {})
        return data.get('found'), canon(data.get('value')) if 'value' in data else None
    except Exception: return None, None
steps = {}; snapshots = {}; schemas = {}
def step(name, cmd, calls):
    m = MCP(cmd, env, proj, EVIDENCE/f'g5-{name}.stderr.log'); t0 = time.time()
    outs = [result_text(m.recv(m.call(n, a), 180)) for n, a in calls]
    ex = m.close(); steps[name] = {'exit': ex, 'sessionSeconds': round(time.time()-t0, 2), 'responses': []}
    for (n, a), o in zip(calls, outs):
        found, vsha = value_sha(o or '')
        steps[name]['responses'].append({'tool': n, 'key': a.get('key'), 'success': '"success": true' in (o or ''), 'found': found, 'valueCanonSha256': vsha, 'errorHead': None if '"success": true' in (o or '') else (o or '')[:300]})
    snapshots[name] = counts(db); schemas[name] = schema(db)
STAGED = [str(STAGE/'bin'/'aqe-mcp')]; CUR = [str(CURRENT/'bin'/'aqe-mcp')]
if not db.exists():
    step('0-current-seed', CUR, [('memory_store', {'key': k, 'value': known_value, 'namespace': ns})] + [('memory_store', {'key': f'q-filler-{i}', 'value': {'i': i}, 'namespace': 'qualify'}) for i in range(20)])
step('1-staged-open', STAGED, [('memory_retrieve', {'key': k, 'namespace': ns}), ('memory_store', {'key': 'g5-staged-marker', 'value': {'by': 'staged'}, 'namespace': 'qualify'}), ('memory_retrieve', {'key': 'g5-staged-marker', 'namespace': 'qualify'})])
step('2-current-open', CUR, [('memory_retrieve', {'key': k, 'namespace': ns}), ('memory_retrieve', {'key': 'g5-staged-marker', 'namespace': 'qualify'}), ('memory_store', {'key': 'g5-current-marker', 'value': {'by': 'current'}, 'namespace': 'qualify'})])
step('3-current-independent-read', CUR, [('memory_retrieve', {'key': 'g5-current-marker', 'namespace': 'qualify'}), ('memory_retrieve', {'key': k, 'namespace': ns})])
step('4-staged-reread', STAGED, [('memory_retrieve', {'key': 'g5-current-marker', 'namespace': 'qualify'}), ('memory_retrieve', {'key': k, 'namespace': ns})])
names = list(snapshots); decreases = {}
for a, b in zip(names, names[1:]):
    for t in set(snapshots[a]) | set(snapshots[b]):
        x, y = snapshots[a].get(t), snapshots[b].get(t)
        if isinstance(x, int) and (y is None or (isinstance(y, int) and y < x)): decreases.setdefault(f'{a}->{b}', {})[t] = (x, y)
save('g5-results.json', {'synthetic': True, 'knownValueCanonSha256': canon(known_value), 'steps': steps, 'schemas': schemas, 'decreases': decreases})
