# smoke: the staged CLI reports the version, and the MCP server starts and lists its memory, dream and learning tools.
import sys, os; sys.path.insert(0, os.environ["QGATES"])
from gatelib import *
import subprocess
proj = project('proj-smoke'); env = clean_env(W/'home-smoke', {'AQE_MEMORY_PATH': str(proj/'.agentic-qe'/'memory.db')})
v = subprocess.run([str(STAGE/'bin'/'aqe'), '--version'], env=env, cwd=proj, capture_output=True, text=True, timeout=120)
m = MCP([str(STAGE/'bin'/'aqe-mcp')], env, proj, EVIDENCE/'smoke-mcp.stderr.log')
tl = m.list_tools(); names = [t['name'] for t in (tl or {}).get('result', {}).get('tools', [])]
schemas = {t['name']: t.get('inputSchema') for t in (tl or {}).get('result', {}).get('tools', []) if t['name'] in ('memory_store', 'memory_retrieve', 'memory_query', 'qe/learning/dream')}
ex = m.close()
save('smoke.json', {'versionRc': v.returncode, 'version': v.stdout.strip()[-80:], 'mcpInit': bool(m.init), 'toolCount': len(names),
  'memoryDreamLearningTools': [n for n in names if 'memory' in n or 'dream' in n or 'learning' in n], 'schemas': schemas, 'exit': ex})
