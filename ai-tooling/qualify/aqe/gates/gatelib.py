# Shared helpers for the AQE gates (run through run.sh, which sets QW, QSTAGE, QCURRENT, QNODEBIN, QGATES, QFIX).
# Adopted from the 2026-10-21 lane (continuation-29-aqe/scripts/gatelib.py); paths now come from the environment.
# Every process gets an env built from scratch: a sandbox HOME, an unreachable proxy (127.0.0.1:9, where nothing
# listens, so any network attempt fails at once), HF_HUB_OFFLINE=1, workers off unless a gate says otherwise, and
# no XDG variables. counts() opens only the gates' own synthetic sandbox stores, read-only.
import json, subprocess, os, time, select, pathlib, sqlite3, hashlib, sys, threading, atexit
W = pathlib.Path(os.environ['QW'])
STAGE = pathlib.Path(os.environ['QSTAGE'])
CURRENT = pathlib.Path(os.environ['QCURRENT'])
NODEBIN = os.environ['QNODEBIN']
FIX = pathlib.Path(os.environ['QFIX'])
EVIDENCE = W/'evidence'
def clean_env(home, extra=None, workers='false'):
    home = pathlib.Path(home); home.mkdir(parents=True, exist_ok=True)
    tmp = W/'tmp'/home.name; tmp.mkdir(parents=True, exist_ok=True)
    e = {'PATH': NODEBIN+':/usr/bin:/bin:/usr/sbin:/sbin', 'HOME': str(home), 'TMPDIR': str(tmp)+'/',
         'LANG': 'en_US.UTF-8', 'HTTPS_PROXY': 'http://127.0.0.1:9', 'HTTP_PROXY': 'http://127.0.0.1:9',
         'https_proxy': 'http://127.0.0.1:9', 'http_proxy': 'http://127.0.0.1:9', 'HF_HUB_OFFLINE': '1',
         'NO_COLOR': '1', 'QSTAGE': str(STAGE)}
    if workers is not None: e['AQE_WORKERS_ENABLED'] = workers
    if extra: e.update({k: v for k, v in extra.items() if v is not None})
    assert not any(k.startswith('XDG_') for k in e)
    return e
class MCP:
    def __init__(self, cmd, env, cwd, stderr_path):
        self.err = open(stderr_path, 'w')
        self.p = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=self.err, env=env, cwd=str(cwd), text=True)
        self.buf = {}; self.events = []
        self.send({"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"steward-qualify","version":"1"}}})
        self.init = self.recv(1, 120)
        self.send({"jsonrpc":"2.0","method":"notifications/initialized"})
        self.nid = 10
    def send(self, m):
        self.p.stdin.write(json.dumps(m)+"\n"); self.p.stdin.flush()
    def call(self, name, args):
        i = self.nid; self.nid += 1
        self.send({"jsonrpc":"2.0","id":i,"method":"tools/call","params":{"name":name,"arguments":args}})
        return i
    def list_tools(self):
        i = self.nid; self.nid += 1
        self.send({"jsonrpc":"2.0","id":i,"method":"tools/list","params":{}}); return self.recv(i)
    def recv(self, id_, t=120):
        end = time.time()+t
        while time.time() < end:
            if id_ in self.buf: return self.buf.pop(id_)
            r,_,_ = select.select([self.p.stdout],[],[],0.5)
            if r:
                l = self.p.stdout.readline()
                if not l: return None
                try: m = json.loads(l)
                except Exception: continue
                self.events.append({'t': time.time(), 'id': m.get('id'), 'method': m.get('method')})
                if 'id' in m and m['id'] is not None: self.buf[m['id']] = m
        return None
    def close(self, wait=30):
        t0 = time.time()
        try: self.p.stdin.close()
        except Exception: pass
        try: rc = self.p.wait(wait)
        except subprocess.TimeoutExpired:
            self.p.kill(); rc = 'killed'
        self.err.close(); return {'rc': rc, 'exitSeconds': round(time.time()-t0, 2)}
def result_text(m):
    if not m: return None
    r = m.get('result') or {}
    if 'content' in r:
        return ''.join(c.get('text','') for c in r['content'] if isinstance(c, dict))
    return json.dumps(m.get('error'))
def counts(db):
    assert str(db).startswith(str(W)), 'counts() reads only the workspace\'s synthetic stores'
    c = sqlite3.connect(f'file:{db}?mode=ro', uri=True)
    try:
        tabs = [r[0] for r in c.execute("select name from sqlite_master where type='table' and name not like 'sqlite_%' order by name")]
        out = {}
        for t in tabs:
            try: out[t] = c.execute(f'select count(*) from "{t}"').fetchone()[0]
            except Exception as ex: out[t] = f'err:{type(ex).__name__}'
        return out
    finally: c.close()
def sha(s): return hashlib.sha256(s.encode() if isinstance(s,str) else s).hexdigest()
def project(name):
    p = W/name; (p/'.agentic-qe').mkdir(parents=True, exist_ok=True); return p
def save(name, obj):
    _end(); json.dump(obj, open(EVIDENCE/name, 'w'), indent=1); print(json.dumps(obj, indent=1)[:4000])
# Progress (AGENTS.md, "Long commands show progress"): a gate can run a minute with nothing to show until its JSON.
# mark(label) starts a step, on stderr only, so stdout and the evidence files stay as they were. On a terminal the
# step's line redraws every second with its time, then ends with a check mark and the time it took; elsewhere (a pipe,
# a log) each step prints one line with the time since the gate started. NO_PROGRESS=1 turns it off.
_GATE = pathlib.Path(sys.argv[0]).stem
_T0 = time.time()
_OFF = os.environ.get('NO_PROGRESS') == '1'
_TTY = sys.stderr.isatty() and not _OFF
_now = {'label': None, 'start': 0.0}
_lock = threading.Lock()
def _live():
    return f"\r\x1b[2K   … {_GATE}: {_now['label']} {int(time.time() - _now['start'])}s"
def _close():
    if _now['label'] and _TTY:
        sys.stderr.write(f"\r\x1b[2K   \x1b[1;32m✓\x1b[0m {_GATE}: {_now['label']} ({int(time.time() - _now['start'])}s)\n"); sys.stderr.flush()
    _now['label'] = None
def _end():
    with _lock: _close()
def _tick():
    while True:
        time.sleep(1)
        with _lock:
            if _now['label']: sys.stderr.write(_live()); sys.stderr.flush()
def mark(label):
    if _OFF: return
    with _lock:
        _close()
        _now['label'], _now['start'] = label, time.time()
        s = int(time.time() - _T0)
        sys.stderr.write(_live() if _TTY else f'   … {_GATE}: {label} [{s // 60}:{s % 60:02d}]\n'); sys.stderr.flush()
if _TTY: threading.Thread(target=_tick, daemon=True).start()
atexit.register(_end)
