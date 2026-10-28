# G6: the dream guard. With the shared runtime's preload (AQE_DREAM_EXECUTION=disabled), a dream call is refused
# with a policy error, a concurrent store in the same session is kept, and no dream cycle is recorded. With the
# guard lifted (a workspace copy of the preload minus that one line), a 30 s dream runs and a store sent 8 s in still
# lands. Both read back from an independent process. Adopted from the 10-21 lane's g6.py.
import sys, os; sys.path.insert(0, os.environ["QGATES"])
from gatelib import *
import time, subprocess
E = W/'g6-dream-enabled-runtime'
if not E.exists():
    (E/'runtime').mkdir(parents=True)
    src = (STAGE/'runtime'/'offline-model.mjs').read_text().splitlines(keepends=True)
    kept = [l for l in src if 'AQE_DREAM_EXECUTION' not in l]
    assert len(src) - len(kept) == 1, 'expected exactly one AQE_DREAM_EXECUTION line in the preload'
    (E/'runtime'/'offline-model.mjs').write_text(''.join(kept))
    for d in ('models', 'node_modules'): (E/d).symlink_to(STAGE/d)
def proj_env(label):
    proj = project(f'proj-g6-{label}')
    return proj, clean_env(W/f'home-g6-{label}', {'AQE_MEMORY_PATH': str(proj/'.agentic-qe'/'memory.db')})
db = lambda label: W/f'proj-g6-{label}'/'.agentic-qe'/'memory.db'
def cycles(path):
    c = sqlite3.connect(f'file:{path}?mode=ro', uri=True)
    try:
        if not c.execute("select 1 from sqlite_master where name='dream_cycles'").fetchone(): return {'table': False}
        return {'table': True, 'byStatus': dict(c.execute('select status, count(*) from dream_cycles group by status').fetchall())}
    finally: c.close()
def kv_has(path, key):
    c = sqlite3.connect(f'file:{path}?mode=ro', uri=True); hits = {}
    try:
        for (t,) in c.execute("select name from sqlite_master where type='table'"):
            if 'key' in [r[1] for r in c.execute(f'pragma table_info("{t}")')]:
                n = c.execute(f'select count(*) from "{t}" where key=?', (key,)).fetchone()[0]
                if n: hits[t] = n
        return hits
    finally: c.close()
def independent_read(label, key):
    proj, env = proj_env(label)
    m = MCP([str(STAGE/'bin'/'aqe'), 'mcp'], env, proj, EVIDENCE/f'g6-{label}-independent-read.stderr.log')
    r = result_text(m.recv(m.call('memory_retrieve', {'key': key, 'namespace': 'qualify'}))); m.close()
    return '"found": true' in (r or '')
delta = lambda b, a: {k: a.get(k, 0)-b.get(k, 0) for k in set(b) | set(a) if a.get(k, 0) != b.get(k, 0)}
out = {}
for label in ('disabled', 'enabled'):
    proj, env = proj_env(label)
    if not db(label).exists():
        p = subprocess.run(['node', '--import', str(STAGE/'runtime'/'offline-model.mjs'), str(FIX/'g6'/'seed.mjs')], cwd=proj, env=env, capture_output=True, text=True, timeout=300)
        open(EVIDENCE/f'g6-{label}-seed.log', 'w').write(p.stdout+'\n---\n'+p.stderr); assert p.returncode == 0, p.stderr[-800:]
# A: guard on, the staged wrapper
proj, env = proj_env('disabled'); before = counts(db('disabled'))
m = MCP([str(STAGE/'bin'/'aqe-mcp')], env, proj, EVIDENCE/'g6-disabled.stderr.log')
t0 = time.time(); d_id = m.call('qe/learning/dream', {'action': 'dream', 'durationMs': 30000, 'minPatterns': 5})
s_id = m.call('memory_store', {'key': 'g6-disabled-concurrent', 'value': {'v': 'kept?'}, 'namespace': 'qualify'})
d = result_text(m.recv(d_id)); t_d = time.time()-t0; s = result_text(m.recv(s_id))
alive = result_text(m.recv(m.call('memory_retrieve', {'key': 'g6-disabled-concurrent', 'namespace': 'qualify'})))
st = result_text(m.recv(m.call('qe/learning/dream', {'action': 'status'})))
ex = m.close(); after = counts(db('disabled'))
out['disabled'] = {'dreamResponse': (d or '')[:600], 'dreamResponseSeconds': round(t_d, 2), 'refusedWithPolicyError': 'disabled by operator policy' in (d or ''),
  'storeAck': '"stored": true' in (s or ''), 'sameSessionRetrieve': '"found": true' in (alive or ''), 'statusAfter': (st or '')[:400], 'exit': ex,
  'cycles': cycles(db('disabled')), 'kvTables': kv_has(db('disabled'), 'g6-disabled-concurrent'), 'independentCliRead': independent_read('disabled', 'g6-disabled-concurrent'),
  'countDeltas': delta(before, after)}
# B: guard lifted, a 30 s dream, a store at +8 s, then stdin closes
proj, env = proj_env('enabled'); before = counts(db('enabled'))
m = MCP(['node', '--import', str(E/'runtime'/'offline-model.mjs'), str(STAGE/'node_modules'/'agentic-qe'/'dist'/'mcp'/'bundle.js')], env, proj, EVIDENCE/'g6-enabled.stderr.log')
t0 = time.time(); d_id = m.call('qe/learning/dream', {'action': 'dream', 'durationMs': 30000, 'minPatterns': 5})
time.sleep(7.0); mid = cycles(db('enabled')); t_mid = time.time()-t0
time.sleep(max(0, 8.0-(time.time()-t0)))
t_store = time.time()-t0; s_id = m.call('memory_store', {'key': 'g6-enabled-at-8s', 'value': {'v': 'must survive'}, 'namespace': 'qualify'})
s = result_text(m.recv(s_id, 60)); t_ack = time.time()-t0
early = m.buf.get(d_id)
ex = m.close(60); t_exit = time.time()-t0
out['enabled'] = {'cyclesAtSampleSeconds': round(t_mid, 2), 'cyclesDuringDream': mid, 'storeSentSeconds': round(t_store, 2), 'storeAckSeconds': round(t_ack, 2), 'storeAck': '"stored": true' in (s or ''),
  'dreamFinishedBeforeClose': early is not None, 'exit': ex, 'exitAfterStartSeconds': round(t_exit, 2),
  'cyclesAfter': cycles(db('enabled')), 'kvTables': kv_has(db('enabled'), 'g6-enabled-at-8s'), 'independentCliRead': independent_read('enabled', 'g6-enabled-at-8s'),
  'countDeltas': delta(before, counts(db('enabled')))}
save('g6-results.json', out)
