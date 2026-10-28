# G7: hooks from a linked Git worktree reach the staged runtime and bind the worktree as the project. The release's
# own .claude/hooks/aqe-hook.cjs runs guard, pre-edit and post-edit (absolute and relative --file) through the hook
# transport v2 (AQE_HOOK_BUNDLE, the repo's ai-tooling/transports/aqe-hook-bundle.cjs, placed in a workspace runtime
# whose current/ is the stage), and once through a node_modules/.bin/agentic-qe shim as the older projects used.
# None may be refused, and the store must land in the worktree. Adapted from the 10-21 lane's g7.py (shim only).
import sys, os; sys.path.insert(0, os.environ["QGATES"])
from gatelib import *
import subprocess, re, shutil
G = W/'g7'; repo, wt, rt = G/'repo', G/'wt', G/'runtime'
if not wt.exists():
    (repo/'.claude'/'hooks').mkdir(parents=True); (repo/'src').mkdir()
    shutil.copy(STAGE/'node_modules'/'agentic-qe'/'.claude'/'hooks'/'aqe-hook.cjs', repo/'.claude'/'hooks'/'aqe-hook.cjs')
    (repo/'src'/'math.ts').write_text('export const add = (a, b) => a + b;\n')
    genv = {'PATH': '/usr/bin:/bin', 'HOME': str(G), 'GIT_CONFIG_GLOBAL': '/dev/null', 'GIT_CONFIG_NOSYSTEM': '1'}
    for a in (['init', '-q', '-b', 'main'], ['add', '.'], ['-c', 'user.email=q@example.com', '-c', 'user.name=q', 'commit', '-q', '-m', 'fixture'], ['worktree', 'add', '-q', str(wt), '-b', 'wt']):
        subprocess.run(['git', '-C', str(repo)] + a, check=True, env=genv)
    (wt/'.agentic-qe').mkdir()
    (rt/'transports'/'v2').mkdir(parents=True); (rt/'current').symlink_to(STAGE)
    shutil.copy(pathlib.Path(os.environ['QGATES']).parents[2]/'transports'/'aqe-hook-bundle.cjs', rt/'transports'/'v2'/'aqe-hook-bundle.cjs')
    (wt/'node_modules'/'.bin').mkdir(parents=True)
    shim = wt/'node_modules'/'.bin'/'agentic-qe'
    shim.write_text('#!/bin/sh\n# the older per-project hook shim: binds the project from its own location, runs the staged runtime\n'
      'ROOT="$(cd "$(dirname "$0")/../.." && pwd -P)"\nexport AQE_PROJECT_ROOT="$ROOT" AQE_MEMORY_PATH="$ROOT/.agentic-qe/memory.db" AQE_SESSION_CACHE=off\n'
      '[ -n "$AQE_HOOK_SHIM_TRACE" ] && printf "%s shim project=%s args=%s\\n" "$(date +%H:%M:%S)" "$ROOT" "$*" >> "$AQE_HOOK_SHIM_TRACE"\n'
      f'exec {STAGE}/bin/aqe "$@"\n')
    shim.chmod(0o755)
trace = EVIDENCE/'g7-trace.log'
if trace.exists(): trace.unlink()
env = clean_env(W/'home-g7', {'CLAUDE_PROJECT_DIR': str(wt), 'AQE_HOOK_SHIM_TRACE': str(trace), 'AQE_HOOK_BUNDLE': str(rt/'transports'/'v2'/'aqe-hook-bundle.cjs')})
f_abs = str(wt/'src'/'math.ts')
cases = [('guard-abs', ['guard', '--file', f_abs, '--json']), ('pre-edit-abs', ['pre-edit', '--file', f_abs, '--json']),
         ('post-edit-abs', ['post-edit', '--file', f_abs, '--success', '--json']), ('post-edit-rel', ['post-edit', '--file', 'src/math.ts', '--success', '--json']),
         ('shim-post-edit', None)]
res = {}
for label, args in cases:
    if args is None:
        e = {k: v for k, v in env.items() if k != 'AQE_HOOK_BUNDLE'}
        cmd = [str(wt/'node_modules'/'.bin'/'agentic-qe'), 'hooks', 'post-edit', '--file', f_abs, '--success', '--json']
    else:
        e, cmd = env, ['node', str(wt/'.claude'/'hooks'/'aqe-hook.cjs')] + args
    p = subprocess.run(cmd, cwd=wt, env=e, capture_output=True, text=True, timeout=180, stdin=subprocess.DEVNULL)
    open(EVIDENCE/f'g7-{label}.log', 'w').write(p.stdout + '\n---stderr---\n' + p.stderr)
    blob = p.stdout + p.stderr
    res[label] = {'rc': p.returncode, 'refused': bool(re.search(r'(?i)outside the project|PathTraversal|not inside|refus', blob)), 'stdoutHead': p.stdout.strip()[:300]}
t = open(trace).read() if trace.exists() else ''
res['trace'] = t.replace(str(W), '<W>')
res['bundleRuns'] = t.count('bundle-v2 project='+str(wt)); res['shimRuns'] = t.count('shim project='+str(wt.resolve()))
res['memoryDbExists'] = (wt/'.agentic-qe'/'memory.db').exists()
save('g7-results.json', res)
