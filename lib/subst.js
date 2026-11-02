#!/usr/bin/env node
// subst.js <file> <pattern> <replacement> — replace every match of a JavaScript regular expression, line by line (the
// m flag), in place (parity 0.3, in place of `perl -pi -e s/…/…/`, which minimal Linux installs can't run). $1 … in the
// replacement are the groups. The file is written where it is, so a symlink stays a link and the mode stays as it was;
// a file with no match is left untouched.
const fs = require('fs');

const [file, pattern, replacement] = process.argv.slice(2);
if (!file || pattern === undefined || replacement === undefined) { console.error('usage: subst.js <file> <pattern> <replacement>'); process.exit(2); }
const text = fs.readFileSync(file, 'utf8');
const out = text.replace(new RegExp(pattern, 'gm'), replacement);
if (out !== text) fs.writeFileSync(file, out);
