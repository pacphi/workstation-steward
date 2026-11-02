#!/usr/bin/env node
// timeout.js <seconds> <command> [args…] — run a command, stopping it with SIGALRM once it has run that long (parity 0.3,
// in place of `perl -e 'alarm shift; exec @ARGV'`, which minimal Linux installs can't run). Its output and exit code
// pass through; a command stopped by its limit exits 142 (128 + SIGALRM), as it did under perl; one that can't start, 127.
const { spawn } = require('child_process');
const { constants } = require('os');

const [secs, cmd, ...args] = process.argv.slice(2);
if (!cmd || !(Number(secs) > 0)) { console.error('usage: timeout.js <seconds> <command> [args…]'); process.exit(2); }
const p = spawn(cmd, args, { stdio: 'inherit' });
const timer = setTimeout(() => p.kill('SIGALRM'), Number(secs) * 1000);
p.on('error', () => { clearTimeout(timer); process.exit(127); });
p.on('exit', (code, signal) => { clearTimeout(timer); process.exit(code !== null ? code : 128 + (constants.signals[signal] || 1)); });
