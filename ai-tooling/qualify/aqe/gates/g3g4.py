# G3: what one process stores, an independent `aqe mcp` process reads back, by exact key and by meaning.
# G4: two projects never see each other's markers, by exact key, meaning or glob. Adopted from the 10-21 lane.
import sys, os; sys.path.insert(0, os.environ["QGATES"])
from gatelib import *
import uuid
def env_for(n):
    proj = project(f'proj-g3-{n}')
    return proj, clean_env(W/f'home-g3-{n}', {'AQE_MEMORY_PATH': str(proj/'.agentic-qe'/'memory.db')})
markers = {'a': {'key': 'q-marker-a', 'value': {'note': 'synthetic marker: the heron counts lighthouse beacons along the quiet fjord', 'id': uuid.uuid4().hex}},
           'b': {'key': 'q-marker-b', 'value': {'note': 'synthetic marker: the copper kettle whistles beside the orchard gate at dawn', 'id': uuid.uuid4().hex}}}
queries = {'a': 'heron counting lighthouse beacons on a fjord', 'b': 'copper kettle whistling by the orchard gate'}
ev = {}
def session(n, label, cmd, calls):
    proj, env = env_for(n)
    m = MCP(cmd, env, proj, EVIDENCE/f'g3g4-{label}.stderr.log')
    ids = [m.call(c, a) for c, a in calls]; outs = [result_text(m.recv(i, 180)) for i in ids]
    ex = m.close(); ev[label] = {'exit': ex, 'outputs': [o[:1500] if o else o for o in outs]}
    return outs
MCPCMD = [str(STAGE/'bin'/'aqe-mcp')]; CLIMCP = [str(STAGE/'bin'/'aqe'), 'mcp']
for n in 'ab':
    session(n, f'{n}-store-mcp', MCPCMD, [('memory_store', {'key': markers[n]['key'], 'value': markers[n]['value'], 'namespace': 'qualify'})])
res = {}
for n in 'ab':
    other = 'b' if n == 'a' else 'a'
    outs = session(n, f'{n}-read-cli', CLIMCP, [
        ('memory_retrieve', {'key': markers[n]['key'], 'namespace': 'qualify'}),
        ('memory_query', {'pattern': queries[n], 'namespace': 'qualify', 'semantic': True, 'limit': 5}),
        ('memory_retrieve', {'key': markers[other]['key'], 'namespace': 'qualify'}),
        ('memory_query', {'pattern': queries[other], 'namespace': 'qualify', 'semantic': True, 'limit': 5}),
        ('memory_query', {'pattern': 'q-marker-*', 'namespace': 'qualify'}),
    ])
    own_id, other_id = markers[n]['value']['id'], markers[other]['value']['id']
    res[n] = {'exactOwnFound': own_id in (outs[0] or ''), 'semanticOwnFound': markers[n]['key'] in (outs[1] or ''),
              'exactOtherFound': other_id in (outs[2] or ''), 'semanticOtherKeyFound': markers[other]['key'] in (outs[3] or ''),
              'globOtherKeyFound': markers[other]['key'] in (outs[4] or ''), 'globOwnKeyFound': markers[n]['key'] in (outs[4] or '')}
json.dump({'sessions': ev}, open(EVIDENCE/'g3g4-sessions.json', 'w'), indent=1)
save('g3g4-results.json', {'results': res})
