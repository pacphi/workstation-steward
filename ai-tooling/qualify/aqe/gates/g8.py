# G8: with AQE_WORKERS_ENABLED=false the MCP server starts no background workers over 45 s (and still serves a
# store and retrieve); the control run with it unset shows the workers starting, which proves the check can see
# them. Adopted from the 10-21 lane's g8.py.
import sys, os; sys.path.insert(0, os.environ["QGATES"])
from gatelib import *
import time, re, threading
out = {}
def run(label, workers):
    proj = project(f'proj-g8-{label}')
    env = clean_env(W/f'home-g8-{label}', {'AQE_MEMORY_PATH': str(proj/'.agentic-qe'/'memory.db')}, workers=workers)
    errp = EVIDENCE/f'g8-{label}.stderr.log'
    m = MCP([str(STAGE/'bin'/'aqe-mcp')], env, proj, errp)
    m.recv(m.call('memory_store', {'key': 'g8-probe', 'value': {'v': 1}, 'namespace': 'qualify'}))
    time.sleep(45)
    st = m.recv(m.call('memory_retrieve', {'key': 'g8-probe', 'namespace': 'qualify'}))
    ex = m.close()
    log = open(errp).read()
    lines = [l[:200] for l in log.splitlines() if re.search(r'(?i)worker|daemon|learning-consolidation|test-health|flaky|compliance|prun', l)]
    out[label] = {'workersEnv': workers, 'exit': ex, 'retrieveOk': '"found": true' in (result_text(st) or ''), 'disabledNotice': bool(re.search(r'Background workers disabled', log)),
                  'workerRelatedLines': lines[:40], 'workerRelatedLineCount': len(lines)}
t1 = threading.Thread(target=run, args=('disabled', 'false')); t2 = threading.Thread(target=run, args=('control-unset', None))
t1.start(); t2.start(); t1.join(); t2.join()
save('g8-results.json', out)
