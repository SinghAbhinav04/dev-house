#!/usr/bin/env node

/**
 * Roster management from the terminal.
 *
 * The /team page is the primary way to manage members, but the roster is just
 * a JSON file plus some markdown, so it is worth being able to drive it without
 * the UI — for scripting, for setting up a machine, and for the case where you
 * have no members yet and therefore nothing to run.
 *
 *   npm run team -- list
 *   npm run team -- add reacty --name Reacty --title Frontend --slot coder --model sonnet --permission acceptEdits
 *   npm run team -- role reacty ./my-role.md
 *   npm run team -- skill reacty ui-docs ./ui-guidelines.md --desc "House style for buttons and spacing"
 *   npm run team -- set reacty --model haiku --effort max
 *   npm run team -- slot tester off
 *   npm run team -- team-model sonnet
 *   npm run team -- starter
 *   npm run team -- remove reacty --files
 */

import { readFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';

const {
  createMember,
  hackeroomHome,
  getMember,
  listMemberSkills,
  listRoleTemplates,
  readRoster,
  removeMember,
  removeMemberSkill,
  seedRoleTemplates,
  updateMember,
  writeMemberRole,
  writeMemberSkill,
  writeRoster,
} = await import('../src/lib/team/roster.ts');
const { buildRunPlan, describeRunPlan } = await import('../src/lib/team/slots.ts');
const { SLOT_IDS, SLOT_LABELS } = await import('../src/lib/team/types.ts');

const argv = process.argv.slice(2);
const command = argv[0];

/** Parse `--key value` and `--flag` into an object. */
function parseFlags(args) {
  const flags = {};
  const positional = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith('--')) {
      positional.push(arg);
      continue;
    }
    const key = arg.slice(2);
    const next = args[i + 1];
    if (next === undefined || next.startsWith('--')) {
      flags[key] = true;
    } else {
      flags[key] = next;
      i++;
    }
  }

  return { flags, positional };
}

function die(message) {
  console.error(`\x1b[31m${message}\x1b[0m`);
  process.exit(1);
}

function printRoster() {
  const roster = readRoster();

  if (roster.members.length === 0) {
    console.log('\nNo members yet. There is no built-in squad — create your team:\n');
    console.log('  npm run team -- starter        seed one member per slot from the role templates');
    console.log('  npm run team -- add <id> --slot coder --model sonnet\n');
    return;
  }

  console.log(`\nTeam model: ${roster.teamModel}   (${hackeroomHome()})\n`);

  const pad = (s, n) => String(s).padEnd(n);
  console.log(
    `  ${pad('ID', 14)}${pad('NAME', 14)}${pad('SLOT', 12)}${pad('MODEL', 10)}${pad('PERMISSION', 14)}${pad('EFFORT', 8)}SKILLS`
  );
  console.log(`  ${'─'.repeat(80)}`);

  for (const member of roster.members) {
    const skills = listMemberSkills(member.id);
    const slotOff = member.slot && !roster.workflow.slots[member.slot].enabled ? ' (off)' : '';
    console.log(
      `  ${pad(member.id, 14)}${pad(member.name, 14)}${pad((member.slot ?? '—') + slotOff, 12)}` +
        `${pad(member.model || `↳${roster.teamModel}`, 10)}${pad(member.permissionMode, 14)}${pad(member.effort, 8)}` +
        `${skills.length > 0 ? skills.join(', ') : '—'}${member.enabled ? '' : '   [disabled]'}`
    );
  }

  const plan = buildRunPlan(roster);
  console.log(`\n  Run plan: ${describeRunPlan(plan)}`);

  const phases = Object.entries(plan.phases)
    .filter(([, on]) => on)
    .map(([name]) => name);
  console.log(`  Phases:   ${phases.length > 0 ? phases.join(' → ') : 'none'}`);

  for (const error of plan.errors) console.log(`  \x1b[31m✗ ${error}\x1b[0m`);
  for (const note of plan.notes) console.log(`  \x1b[33m• ${note}\x1b[0m`);
  console.log('');
}

/** Capability overrides accepted by `add` and `set`. */
function capabilitiesFromFlags(flags) {
  const caps = {};
  if (flags.write) caps.write = flags.write;
  if (flags.bash) caps.bash = flags.bash;
  if (flags.web !== undefined) caps.web = flags.web === true || flags.web === 'true';
  if (flags.network) caps.network = flags.network;
  if (flags.isolated !== undefined) caps.preferIsolated = flags.isolated === true || flags.isolated === 'true';
  return Object.keys(caps).length > 0 ? caps : undefined;
}

const { flags, positional } = parseFlags(argv.slice(1));

switch (command) {
  case 'list':
  case undefined: {
    printRoster();
    break;
  }

  case 'add': {
    const id = positional[0];
    if (!id) die('Usage: npm run team -- add <id> [--name N] [--title T] [--slot coder] [--model sonnet]');

    const roleFlag = flags.role ? readFileSync(resolve(String(flags.role)), 'utf8') : undefined;

    const { member } = createMember(readRoster(), {
      id,
      name: flags.name ? String(flags.name) : undefined,
      title: flags.title ? String(flags.title) : undefined,
      slot: flags.slot ? String(flags.slot) : null,
      model: flags.model ? String(flags.model) : undefined,
      permissionMode: flags.permission ? String(flags.permission) : undefined,
      effort: flags.effort ? String(flags.effort) : undefined,
      capabilities: capabilitiesFromFlags(flags),
      role: roleFlag,
      tokenBudget: flags.budget ? Number(flags.budget) : undefined,
    });

    console.log(`Added ${member.name} (${member.id})${member.slot ? ` as ${SLOT_LABELS[member.slot]}` : ''}.`);
    printRoster();
    break;
  }

  case 'set': {
    const id = positional[0];
    if (!id) die('Usage: npm run team -- set <id> [--model haiku] [--permission plan] [--effort max] [--slot tester]');

    const patch = {};
    if (flags.name) patch.name = String(flags.name);
    if (flags.title) patch.title = String(flags.title);
    if (flags.model) patch.model = flags.model === 'team' ? '' : String(flags.model);
    if (flags.permission) patch.permissionMode = String(flags.permission);
    if (flags.effort) patch.effort = String(flags.effort);
    if (flags.slot) patch.slot = flags.slot === 'none' ? null : String(flags.slot);
    if (flags.budget) patch.tokenBudget = Number(flags.budget);
    if (flags.enable) patch.enabled = true;
    if (flags.disable) patch.enabled = false;

    const caps = capabilitiesFromFlags(flags);
    if (caps) {
      const existing = getMember(readRoster(), id);
      if (!existing) die(`No member with id "${id}".`);
      patch.capabilities = { ...existing.capabilities, ...caps };
    }

    if (Object.keys(patch).length === 0) die('Nothing to change. Pass at least one flag.');

    updateMember(readRoster(), id, patch);
    console.log(`Updated ${id}.`);
    printRoster();
    break;
  }

  case 'role': {
    const [id, file] = positional;
    if (!id || !file) die('Usage: npm run team -- role <id> <path-to-markdown>');
    if (!getMember(readRoster(), id)) die(`No member with id "${id}".`);

    writeMemberRole(id, readFileSync(resolve(file), 'utf8'));
    console.log(`Role for ${id} set from ${basename(file)}.`);
    break;
  }

  case 'skill': {
    const [id, name, file] = positional;
    if (!id || !name || !file) {
      die('Usage: npm run team -- skill <id> <skill-name> <path-to-markdown> [--desc "one line"]');
    }
    if (!getMember(readRoster(), id)) die(`No member with id "${id}".`);

    const slug = writeMemberSkill(id, {
      name,
      description: flags.desc ? String(flags.desc) : `Reference material for ${name}.`,
      body: readFileSync(resolve(file), 'utf8'),
    });

    console.log(`Attached skill "${slug}" to ${id}.`);
    console.log('Only its name and description sit in context until the model invokes it.');
    break;
  }

  case 'unskill': {
    const [id, name] = positional;
    if (!id || !name) die('Usage: npm run team -- unskill <id> <skill-name>');
    removeMemberSkill(id, name);
    console.log(`Removed skill "${name}" from ${id}.`);
    break;
  }

  case 'slot': {
    const [slotId, onOff] = positional;
    if (!SLOT_IDS.includes(slotId) || !['on', 'off'].includes(onOff)) {
      die(`Usage: npm run team -- slot <${SLOT_IDS.join('|')}> <on|off>`);
    }

    const roster = readRoster();
    writeRoster({
      ...roster,
      workflow: {
        ...roster.workflow,
        slots: { ...roster.workflow.slots, [slotId]: { ...roster.workflow.slots[slotId], enabled: onOff === 'on' } },
      },
    });

    console.log(`${SLOT_LABELS[slotId]} slot is now ${onOff}.`);
    printRoster();
    break;
  }

  case 'team-model': {
    const model = positional[0];
    if (!model) die('Usage: npm run team -- team-model <haiku|sonnet|opus|fable|model-id>');

    const roster = readRoster();
    writeRoster({ ...roster, teamModel: model });
    console.log(`Team model set to ${model}. Members without their own model now use it.`);
    printRoster();
    break;
  }

  case 'goal': {
    const goal = positional[0];
    if (!['full-build', 'plan-only'].includes(goal)) die('Usage: npm run team -- goal <full-build|plan-only>');

    const roster = readRoster();
    writeRoster({ ...roster, workflow: { ...roster.workflow, runGoal: goal } });
    console.log(`Run goal set to ${goal}.`);
    break;
  }

  case 'remove': {
    const id = positional[0];
    if (!id) die('Usage: npm run team -- remove <id> [--files]');

    removeMember(readRoster(), id, { deleteFiles: flags.files === true });
    console.log(`Removed ${id}${flags.files ? ' and deleted its role and skills' : ''}.`);
    printRoster();
    break;
  }

  case 'starter': {
    // Not a built-in squad — just one member per slot, seeded from the bundled
    // role templates, as a starting point the user is expected to rename and
    // rewrite.
    seedRoleTemplates();

    const templates = Object.fromEntries(listRoleTemplates().map((t) => [t.name, t.path]));
    const seed = [
      { id: 'planner', name: 'Planner', title: 'Planning', slot: 'planner', template: 'planner' },
      { id: 'reviewer', name: 'Reviewer', title: 'Plan review', slot: 'reviewer', template: 'plan-reviewer' },
      { id: 'coder', name: 'Coder', title: 'Implementation', slot: 'coder', template: 'coder' },
      { id: 'tester', name: 'Tester', title: 'Testing', slot: 'tester', template: 'tester' },
      { id: 'auditor', name: 'Auditor', title: 'Security', slot: 'auditor', template: 'security-auditor' },
      { id: 'supervisor', name: 'Supervisor', title: 'Operations', slot: 'supervisor', template: 'supervisor' },
    ];

    let roster = readRoster();
    let added = 0;

    for (const entry of seed) {
      if (getMember(roster, entry.id)) continue;
      const templatePath = templates[entry.template];
      ({ roster } = createMember(roster, {
        id: entry.id,
        name: entry.name,
        title: entry.title,
        slot: entry.slot,
        role: templatePath ? readFileSync(templatePath, 'utf8') : undefined,
      }));
      added++;
    }

    console.log(added > 0 ? `Seeded ${added} member(s).` : 'Nothing to seed — those ids already exist.');
    console.log('Rename them, rewrite their roles, change their models — none of it is special.');
    printRoster();
    break;
  }

  case 'where': {
    console.log(hackeroomHome());
    break;
  }

  default:
    die(`Unknown command "${command}". Try: list, add, set, role, skill, unskill, slot, team-model, goal, remove, starter, where`);
}
