# receipt: one receipt.json for the release from the workspace's evidence, with a PASS or FAIL per gate by the
# criteria below (the 10-21 lane's results, made explicit), plus the build facts. Written to the workspace and
# copied to [paths] state/qualify/aqe-<release>/ (the workspace is a cache and can go).
import sys, os; sys.path.insert(0, os.environ["QGATES"])
from gatelib import *
import datetime, shutil
def load(n):
    try: return json.load(open(EVIDENCE/n))
    except Exception: return None
def text(n):
    try: return (EVIDENCE/n).read_text().strip()
    except Exception: return None
fsha = lambda p: hashlib.sha256(pathlib.Path(p).read_bytes()).hexdigest() if pathlib.Path(p).exists() else None
ver, rel = os.environ['QVERSION'], os.environ['QRELEASE']
g = {k: load(f'{k}-results.json') for k in ('g1', 'g2', 'g3g4', 'g5', 'g6', 'g7', 'g8')}
def verdict(ok, detail): return {'result': 'PASS' if ok else ('FAIL' if ok is False else 'NOT RUN'), 'detail': detail}
gates = {}
r = g['g1']
gates['G1'] = verdict(r and all(r.get(k) == 0 for k in ('regression', 'regression-rerun')) and r['post-public-regression']['rc'] == 0
    and all(r[f'public-{x}'][s].get('containsActiveId') and not any(r[f'public-{x}'][s].get('archivedIdsPresent', [True])) for x in ('mcp', 'cli-mcp') for s in ('unscoped', 'scoped')) if r else None,
    'the 9-test regression passes twice and after the public MCP and CLI-MCP pattern calls, which return the active pattern and no archived one')
r = g['g2']
gates['G2'] = verdict(r and all(x['exit'] == 0 and x['attemptedFetches'] == 0 and x['found'] and x['dimension'] == 384 and x['remoteModelsAllowed'] is False for x in r)
    and len({json.dumps(x['identity'], sort_keys=True) for x in r}) == 1 if r else None,
    '4 independent processes (2 projects, store and read): 0 network fetches, 384-dim, pattern found, one embedding identity')
r = (g['g3g4'] or {}).get('results')
gates['G3'] = verdict(all(r[n]['exactOwnFound'] and r[n]['semanticOwnFound'] for n in 'ab') if r else None, 'an independent `aqe mcp` process reads its own marker by key and by meaning')
gates['G4'] = verdict(all(not (r[n]['exactOtherFound'] or r[n]['semanticOtherKeyFound'] or r[n]['globOtherKeyFound']) for n in 'ab') if r else None, "neither project sees the other's marker by key, meaning or glob")
r = g['g5']
ok5 = None
if r:
    resp = [x for s in r['steps'].values() for x in s['responses']]
    known = [x for x in resp if x['key'] == 'q-known-key' and x['tool'] == 'memory_retrieve']
    ok5 = all(x['success'] for x in resp) and all(x['found'] for x in resp if x['tool'] == 'memory_retrieve') \
        and all(x['valueCanonSha256'] == r['knownValueCanonSha256'] for x in known) and not r['decreases'] \
        and all(s['integrity'] == 'ok' for s in r['schemas'].values())
gates['G5'] = verdict(ok5, 'a synthetic store the current runtime wrote: the staged and current runtimes read and write it in turn, the known value unchanged, no table loses rows, quick_check ok' + (f"; schema {sorted({json.dumps(s['schema_version_rows']) for s in r['schemas'].values()})}" if r else ''))
r = g['g6']
gates['G6'] = verdict(r and r['disabled']['refusedWithPolicyError'] and r['disabled']['storeAck'] and r['disabled']['independentCliRead'] and not r['disabled']['cycles'].get('byStatus')
    and r['enabled']['storeAck'] and r['enabled']['independentCliRead'] if r else None,
    'guard on: dream refused by policy, a concurrent store kept and read back, no dream cycle; guard lifted: a store 8 s into a dream lands')
r = g['g7']
gates['G7'] = verdict(r and all(r[c]['rc'] == 0 and not r[c]['refused'] for c in ('guard-abs', 'pre-edit-abs', 'post-edit-abs', 'post-edit-rel', 'shim-post-edit'))
    and r['bundleRuns'] >= 4 and r['shimRuns'] >= 1 and r['memoryDbExists'] if r else None,
    'from a linked worktree, guard/pre-edit/post-edit through transport v2 and the shim: none refused, all bound to the worktree, its store created')
r = g['g8']
gates['G8'] = verdict(r and r['disabled']['disabledNotice'] and r['disabled']['retrieveOk'] and r['control-unset']['workerRelatedLineCount'] > r['disabled']['workerRelatedLineCount'] if r else None,
    'workers off: the disabled notice, a working store, and fewer worker lines over 45 s than the control with the variable unset')
q = W/'unpacked'
receipt = {
  'kind': 'aqe-qualify', 'release': rel, 'generatedAt': datetime.datetime.now().astimezone().isoformat(timespec='seconds'), 'promoted': False,
  'source': {'tag': f'v{ver}', 'commit': text('source-commit.txt')},
  'tarballs': {'officialSha256': fsha(W/'official'/f'agentic-qe-{ver}.tgz'), 'unpatchedRebuildSha256': fsha(W/'baseline-pack'/f'agentic-qe-{ver}.tgz'),
               'unpatchedRebuildByteIdenticalToOfficial': text('baseline-identical-to-official.txt') == 'true', 'patchedSha256': fsha(W/'patched-pack'/f'agentic-qe-{ver}.tgz')},
  'patches': text('patches-applied.txt'),
  'statementDiffVsOfficial': load('statement-diff-normalised.json'),
  'stage': {'path': str(STAGE), 'packageJsonSha256': fsha(STAGE/'package.json'), 'packageLockSha256': fsha(STAGE/'package-lock.json'),
            'lockAge': {k: v for k, v in (load('stage-lock-age.json') or {}).items() if k != 'ok'}, 'distMatchesPack': (load('stage-dist-matches-pack.json') or {}).get('differingCount') == 0},
  'smoke': {k: v for k, v in (load('smoke.json') or {}).items() if k != 'schemas'},
  'sandbox': 'HOME per run inside the workspace; env built from scratch (no inherited AQE_*/CLAUDE_*/XDG_*); HTTPS_PROXY/HTTP_PROXY=http://127.0.0.1:9; HF_HUB_OFFLINE=1; AQE_WORKERS_ENABLED=false unless a gate says otherwise; synthetic stores only',
  'gates': gates, 'allPass': all(v['result'] == 'PASS' for v in gates.values()),
}
json.dump(receipt, open(W/'receipt.json', 'w'), indent=1)
dest = pathlib.Path(os.environ.get('STEWARD_PATHS_STATE') or (pathlib.Path.home()/'.local'/'state'/'workstation-steward'))/'qualify'/f'aqe-{rel}'
dest.mkdir(parents=True, exist_ok=True); os.chmod(dest, 0o700)
shutil.copy(W/'receipt.json', dest/'receipt.json')
for n in os.listdir(EVIDENCE): shutil.copy(EVIDENCE/n, dest/n) if (EVIDENCE/n).is_file() else None
print(json.dumps({k: v['result'] for k, v in gates.items()}), 'allPass' if receipt['allPass'] else 'NOT all pass')
print('receipt', dest/'receipt.json')
