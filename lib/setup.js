// The rest of `steward init` (D48), one question at a time: the AI tooling and projects add-ons (and where the projects
// live), then the Claude Code skills (everywhere, one project, or not now) and whether they include PR consolidation.
// Each answer changes one value in the new steward.toml (lib/write.js tomlSet: comments and layout stay). bin/steward.js
// asks in a terminal; tests pass scripted answers.
const fs = require('fs');
const W = require('./write.js');

const yes = a => /^y(es)?$/i.test(String(a || '').trim());

// walkSetup(file, ask, say) — asks through ask(question) → answer, writes the answers into file (a steward.toml), and
// returns { set: ['table.key = value', …], install: null | { project } } for the receipt and the skills install
async function walkSetup(file, ask, say = console.log) {
  const set = [];
  const put = (table, key, v) => {
    fs.writeFileSync(file, W.tomlSet(fs.readFileSync(file, 'utf8'), table, key, v));
    set.push(`${table}.${key} = ${JSON.stringify(v)}`);
  };
  say('\nA few questions finish the setup. Each answer changes one line in steward.toml, which you can edit later.');
  if (yes(await ask('Turn on the AI tooling add-on (Ruflo, AgentDB, AQE, Brain, RuVector: drift, repin, guards)? [y/N] '))) put('profiles', 'ai_tooling', true);
  if (yes(await ask('Turn on the projects add-on (discovery, the registry and onboarding of your projects)? [y/N] '))) {
    put('profiles', 'projects', true);
    const now = ((fs.readFileSync(file, 'utf8').match(/^\s*roots\s*=\s*\[(.*)\]/m) || [])[1] || '').replace(/"/g, '');
    const roots = String(await ask(`Where do your projects live? Folders, separated by commas [${now || 'the default'}]: `) || '')
      .split(',').map(r => r.trim()).filter(Boolean);
    if (roots.length) put('projects', 'roots', roots);
  }
  say("\nInstall the steward's Claude Code skills (/steward:supply-chain and the rest)?\n  1) everywhere: every Claude Code session you start, in any folder (turned on in ~/.claude/settings.json)\n  2) one project: only sessions started in a folder you name (turned on in its .claude/settings.local.json)\n  3) not now");
  const a = String(await ask('Choose 1, 2 or 3 [3]: ') || '').trim();
  const project = a === '2' ? String(await ask('Project folder (its path): ') || '').trim() : '';
  const install = a === '1' || (a === '2' && project !== '') ? { project: project || null } : null;
  if (install && yes(await ask("Also include PR consolidation (folds a repo's Dependabot and Renovate PRs into one verified PR)? [y/N] "))) put('skills', 'pr_consolidation', true);
  return { set, install };
}

module.exports = { walkSetup };
