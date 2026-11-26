// A stand-in for the `claude` CLI that plays one plausible team run.
//
// It answers each turn from what the prompt and `--json-schema` ask for and
// speaks Claude Code's stream-json, so the real orchestrator drives it like the
// real thing. Used by scripts/test-orchestrator-workflow.mjs (instant) and by
// `npm run demo:replay` (paced, so the studio can be watched).
//
//   STUB_STATE     directory for per-run counters and the prompt log (required)
//   STUB_DELAY_MS  how long each turn "thinks" before answering (default 0)

const fs = require('fs');
const path = require('path');

const argv = process.argv.slice(2);
const arg = (flag) => {
  const i = argv.indexOf(flag);
  return i === -1 ? '' : argv[i + 1];
};
const prompt = arg('-p');
const schemaText = arg('--json-schema');
const schema = schemaText ? JSON.parse(schemaText) : null;
const props = schema && schema.properties ? Object.keys(schema.properties) : [];
const statuses = (schema && schema.properties.status && schema.properties.status.enum) || [];
const stateDir = process.env.STUB_STATE;
const delay = Math.max(0, Number(process.env.STUB_DELAY_MS || 0));

const bump = (key) => {
  const file = path.join(stateDir, key);
  const n = (fs.existsSync(file) ? Number(fs.readFileSync(file, 'utf8')) : 0) + 1;
  fs.writeFileSync(file, String(n));
  return n;
};
const wait = (ms) => {
  if (ms > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};
const out = (event) => process.stdout.write(JSON.stringify(event) + '\n');
const say = (text) => out({ type: 'assistant', message: { content: [{ type: 'text', text }] } });

fs.appendFileSync(path.join(stateDir, 'prompts.log'), JSON.stringify({ prompt, props }) + '\n');

const session = 'stub-' + (arg('--resume') || Math.random().toString(36).slice(2, 10));
out({ type: 'system', subtype: 'init', session_id: session });

let text = 'Done.';
let structured;

const PLAN_SECTIONS = [
  ['Goal', 'A single-page kanban board: columns, cards, drag and drop. Plain HTML and JS, no build step.'],
  ['Files', '- `index.html` — layout and the three columns\n- `board.js` — state, rendering, drag and drop\n- `styles.css` — the board'],
  ['Behaviour', '- Cards can be added to any column\n- Dragging a card onto a column moves it, including onto an empty column\n- Each column shows its card count'],
  ['Tests', 'Open `index.html`. Add a card, drag it to every column, reload and check it stayed put.'],
];

if (statuses.includes('ready')) {
  say('Splitting the plan into tickets.');
  wait(delay);
  structured = {
    status: 'ready',
    tickets: [
      { title: 'Board columns and cards', assignee: 'coder', type: 'story', priority: 'p1', acceptance: ['Three columns render', 'A card can be added'] },
      { title: 'Drag cards between columns', assignee: 'coder', type: 'story', acceptance: ['Drop moves the card', 'Works on an empty column'] },
      { title: 'Write the test plan', assignee: 'tester', type: 'task', acceptance: ['Covers every behaviour in the plan'] },
    ],
  };
} else if (statuses.includes('asked')) {
  wait(delay / 2);
  structured = { status: 'asked', questions: ['How do I start it?', 'Anything you are unsure about?'] };
} else if (statuses.includes('answered')) {
  wait(delay / 2);
  structured = {
    status: 'answered',
    answers: [
      { question: 'How do I start it?', answer: 'Open index.html — no build step.' },
      { question: 'Anything you are unsure about?', answer: 'Dragging onto an empty column.' },
    ],
  };
} else if (statuses.includes('passed')) {
  say('Opening index.html and working through the test plan.');
  wait(delay);
  structured = bump('test') === 1
    ? { status: 'failed', failures: ['Dropping a card on an empty column does nothing.'] }
    : { status: 'passed' };
} else if (statuses.includes('issues') && schema.properties.issues.items.type === 'object') {
  say('Checking every place user text reaches the page.');
  wait(delay);
  structured = { status: 'issues', issues: [{ severity: 'high', finding: 'Card titles are rendered with innerHTML.' }] };
} else if (statuses.includes('issues')) {
  say('Reading the code against the plan.');
  wait(delay);
  structured = bump('review') === 1
    ? { status: 'issues', issues: ['The card count badge is never updated.'] }
    : { status: 'approved' };
} else if (statuses.includes('approved')) {
  say('Reading the plan for gaps.');
  wait(delay);
  structured = { status: 'approved' };
} else {
  const write = /Write the full build plan to (.+?plan\.md) now/.exec(prompt);
  if (write) {
    // Outline first, then one section at a time — what the whiteboard shows.
    const outline = ['# Kanban board', '', ...PLAN_SECTIONS.flatMap(([title]) => [`## ${title}`, '_to do_', ''])].join('\n');
    say('Sketching the outline on the board first.');
    fs.writeFileSync(write[1], outline);
    let plan = outline;
    for (const [title, body] of PLAN_SECTIONS) {
      wait(Math.max(1200, delay / 2));
      plan = plan.replace(`## ${title}\n_to do_`, `## ${title}\n${body}`);
      fs.writeFileSync(write[1], plan);
      say(`Filled in ${title.toLowerCase()}.`);
    }
    text = 'Draft written';
  } else if (/research/i.test(prompt)) {
    say('Reading the brief and checking what a kanban board needs.');
    wait(delay);
    text = 'Research complete';
  } else if (/DH-\d+ — /.test(prompt)) {
    const ticket = /(DH-\d+) — (.+)/.exec(prompt);
    say(`Working on ${ticket[1]}: ${ticket[2]}.`);
    wait(delay);
    text = `Built ${ticket[1]}.`;
  } else {
    wait(delay / 2);
  }
}

out({
  type: 'result',
  subtype: 'success',
  result: structured ? JSON.stringify(structured) : text,
  structured_output: structured,
  session_id: session,
  usage: { input_tokens: 1200, output_tokens: 300 },
});
