# G1: the packaged learning code keeps the #1055 behaviour: on a seeded synthetic store, only the active pattern is
# found and counted (the 9-test regression, run twice), the public MCP and CLI-MCP pattern tools agree, and the
# regression still passes after them. Adopted from the 10-21 lane's g1.py and g1_public.py.
import sys, os; sys.path.insert(0, os.environ["QGATES"])
from gatelib import *
import subprocess, re, shutil
proj = project('proj-g1')
for f in ('seed-fixture.mjs', 'regression.test.mjs'): shutil.copy(FIX/'g1'/f, proj/f)
env = clean_env(W/'home-g1', {'AQE_MEMORY_PATH': str(proj/'.agentic-qe'/'memory.db'), 'AQE_PROJECT_ROOT': str(proj)})
res = {}
for label, args in [('seed', ['node', 'seed-fixture.mjs']), ('regression', ['node', '--test', 'regression.test.mjs']), ('regression-rerun', ['node', '--test', 'regression.test.mjs'])]:
    if label == 'seed' and (proj/'fixture.json').exists(): res['seed'] = 'already seeded'; continue
    mark(f'{label}: {" ".join(args)}')
    with open(EVIDENCE/f'g1-{label}.log', 'w') as log:
        p = subprocess.run(args, cwd=proj, env=env, stdout=log, stderr=subprocess.STDOUT, timeout=180)
    res[label] = p.returncode
    if label == 'seed' and p.returncode: save('g1-results.json', res); sys.exit(1)
fx = json.load(open(proj/'fixture.json'))
env = clean_env(W/'home-g1', {'AQE_MEMORY_PATH': str(proj/'.agentic-qe'/'memory.db')})
def summ(t):
    try: d = json.loads(t)
    except Exception: return {'raw': (t or '')[:300]}
    s = json.dumps(d)
    return {'containsActiveId': fx['activePatternId'] in s, 'archivedIdsPresent': [i in s for i in fx['archivedPatternIds']], 'snippet': s[:400]}
for label, cmd in [('mcp', [str(STAGE/'bin'/'aqe-mcp')]), ('cli-mcp', [str(STAGE/'bin'/'aqe'), 'mcp'])]:
    mark(f'public patterns through {label}')
    m = MCP(cmd, env, proj, EVIDENCE/f'g1-public-{label}.stderr.log')
    a = m.recv(m.call('qe/learning/optimize', {'action': 'patterns'})); b = m.recv(m.call('qe/learning/optimize', {'action': 'patterns', 'domain': 'code-intelligence'}))
    ex = m.close()
    res[f'public-{label}'] = {'exit': ex, 'unscoped': summ(result_text(a)), 'scoped': summ(result_text(b))}
mark('regression after the public tools')
p = subprocess.run(['node', '--test', 'regression.test.mjs'], cwd=proj, env=env, capture_output=True, text=True, timeout=180)
open(EVIDENCE/'g1-post-public-regression.log', 'w').write(p.stdout+p.stderr)
res['post-public-regression'] = {'rc': p.returncode, 'counts': re.findall(r'ℹ (?:pass|fail) \d+', p.stdout)}
for l in ('regression', 'regression-rerun'): res[f'{l}-counts'] = re.findall(r'ℹ (?:pass|fail) \d+', open(EVIDENCE/f'g1-{l}.log').read())
save('g1-results.json', res)
