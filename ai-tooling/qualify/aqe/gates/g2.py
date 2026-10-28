# G2: the offline embedding model runs with 0 network fetches (fetch is replaced to count and refuse; the proxy is
# unreachable), stores and reads a synthetic pattern in two projects with independent processes, and reports one
# embedding identity. Adopted from the 10-21 lane's g2.py.
import sys, os; sys.path.insert(0, os.environ["QGATES"])
from gatelib import *
import subprocess
res = []
for proj_name, mode in [('a', 'store'), ('a', 'read'), ('b', 'store'), ('b', 'read')]:
    proj = project(f'proj-g2-{proj_name}')
    env = clean_env(W/f'home-g2-{proj_name}', {'AQE_MEMORY_PATH': str(proj/'.agentic-qe'/'memory.db')})
    p = subprocess.run(['node', '--import', str(STAGE/'runtime'/'offline-model.mjs'), str(FIX/'g2'/'embedding.mjs'), mode], cwd=proj, env=env, capture_output=True, text=True, timeout=300)
    open(EVIDENCE/f'g2-{proj_name}-{mode}.log', 'w').write(p.stdout+'\n---stderr---\n'+p.stderr)
    f = proj/f'transformers-{mode}-result.json'
    r = json.load(open(f)) if f.exists() else {}
    res.append({'project': proj_name, 'mode': mode, 'exit': p.returncode, 'attemptedFetches': r.get('attemptedFetches'), 'identity': r.get('identity'), 'found': r.get('expectedPatternFound'), 'patternId': r.get('patternId'), 'dimension': r.get('dimension'), 'remoteModelsAllowed': r.get('remoteModelsAllowed'), 'transformersResolvedFromAqe': r.get('transformersResolvedFromAqe')})
save('g2-results.json', res)
