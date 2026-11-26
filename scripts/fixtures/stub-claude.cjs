// A stand-in for the `claude` CLI that plays one plausible team run.
//
// It answers each turn from what the prompt and `--json-schema` ask for and
// speaks Claude Code's stream-json, so the real orchestrator drives it like the
// real thing. Used by scripts/test-orchestrator-workflow.mjs (instant) and by
// `npm run demo:replay` (paced, so the studio can be watched).
//
//   STUB_STATE     directory for per-run counters and the prompt log (required)
//   STUB_DELAY_MS  how long each turn "thinks" before answering (default 0)

/* eslint-disable @typescript-eslint/no-require-imports -- a CommonJS stand-in for a CLI binary */
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

// The roster the orchestrator put in the prompt, as "- slot: Name, title, model — duty".
const teamLines = prompt
  .split('\n')
  .map((line) => /^- (\w+): (.+?) — (.+)$/.exec(line))
  .filter(Boolean)
  .map(([, slot, who]) => ({ slot, name: who.split(',')[0].trim() }))
  .filter((t) => !/^nobody/i.test(t.name));
const nameFor = (slot, fallback) => (teamLines.find((t) => t.slot === slot) || { name: fallback }).name;
const TEAM_TABLE = [
  '| Who | Tasks | Estimate | Priority |',
  '|---|---|---|---|',
  `| ${nameFor('coder', 'Coder')} (coder) | DH-2 Board columns and cards; DH-3 Drag cards between columns | 25m, 20m | P1, P2 |`,
  `| ${nameFor('tester', 'Tester')} (tester) | Test plan; asks the coder how to run it, then tests every ticket | 10m | P2 |`,
  ...(teamLines.some((t) => t.slot === 'reviewer') ? [`| ${nameFor('reviewer', 'Reviewer')} (reviewer) | Reviews the plan before any code is written | — | — |`] : []),
  ...(teamLines.some((t) => t.slot === 'auditor') ? [`| ${nameFor('auditor', 'Auditor')} (auditor) | Checks card text is never rendered as HTML | — | — |`] : []),
].join('\n');

const PLAN_SECTIONS = [
  ['Goal', 'A single-page kanban board: columns, cards, drag and drop. Plain HTML and JS, no build step.'],
  ['Team and tasks', TEAM_TABLE],
  ['Files', '- `index.html` — layout and the three columns\n- `board.js` — state, rendering, drag and drop\n- `styles.css` — the board'],
  ['Behaviour', '- Cards can be added to any column\n- Dragging a card onto a column moves it, including onto an empty column\n- Each column shows its card count'],
  ['Tests', 'Open `index.html`. Add a card, drag it to every column, reload and check it stayed put.'],
];

const FULL_SPRINT = [
  {
    title: 'Edit and delete a card',
    description: 'Double-click a card to rename it; a small **×** removes it. Both save straight away.',
    assignee: 'coder', type: 'story', priority: 'p2', estimateMinutes: 15, tags: ['ui'],
    acceptance: ['Rename sticks after reload', 'Delete asks nothing and is undoable with Ctrl+Z'],
  },
  {
    title: 'WIP limit on Doing',
    description: 'At most **3** cards in *Doing*; a fourth drop is refused with a short shake.',
    assignee: 'coder', type: 'story', priority: 'p3', estimateMinutes: 15, tags: ['rules'],
    acceptance: ['A fourth card cannot enter Doing', 'The column header shows 3/3'],
  },
  {
    title: 'Keyboard: add a card with N',
    description: 'Pressing `N` focuses the *Add card* box from anywhere on the page.',
    assignee: 'coder', type: 'task', priority: 'p3', estimateMinutes: 10, tags: ['a11y', 'keyboard'],
    acceptance: ['N focuses the input', 'N inside the input types an n'],
  },
  {
    title: 'Dark mode',
    description: 'Follows the system setting, with the board colours as CSS variables.',
    assignee: 'coder', type: 'story', priority: 'p3', estimateMinutes: 15, tags: ['ui', 'theme'],
    acceptance: ['Matches prefers-color-scheme', 'Contrast AA on cards'],
  },
  {
    title: 'Accessibility pass',
    description: 'Labels on every control, visible focus, and drag and drop that also works from the keyboard.',
    assignee: 'tester', type: 'task', priority: 'p2', estimateMinutes: 15, tags: ['qa', 'a11y'],
    acceptance: ['Every control has a label', 'A card can be moved without a mouse'],
  },
];

if (statuses.includes('ready')) {
  say('Splitting the plan into tickets.');
  wait(delay);
  structured = {
    status: 'ready',
    tickets: [
      {
        title: 'Board columns and cards',
        description: 'Build `index.html`, `styles.css` and `board.js`: three columns (**To Do**, **Doing**, **Done**), an *Add card* box, cards saved to `localStorage`.',
        assignee: 'coder', type: 'story', priority: 'p1', estimateMinutes: 25, tags: ['ui', 'storage'],
        acceptance: ['Three columns render', 'A card can be added', 'Cards survive a reload'],
      },
      {
        title: 'Drag cards between columns',
        description: 'HTML5 drag and drop in `board.js`. Dropping anywhere on a column moves the card there, **including an empty column**.',
        assignee: 'coder', type: 'story', priority: 'p2', estimateMinutes: 20, tags: ['ui', 'drag-drop'],
        acceptance: ['Drop moves the card', 'Works on an empty column'],
      },
      {
        title: 'Write the test plan',
        description: 'A short checklist in `TESTPLAN.md` covering every behaviour in the plan.',
        assignee: 'tester', type: 'task', priority: 'p2', estimateMinutes: 10, tags: ['qa'],
        acceptance: ['Covers every behaviour in the plan'],
      },
      // STUB_BACKLOG=full (the demo): a realistic sprint, so the board has
      // cards in every column while the run plays out.
      ...(process.env.STUB_BACKLOG === 'full' ? FULL_SPRINT : []),
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
    writeCode(ticket[2]);
    text = `Built ${ticket[1]}.`;
  } else if (/The tester found (issues|test failures)/.test(prompt)) {
    say('Fixing what the tester found.');
    wait(delay / 2);
    writeCode(/test failures/.test(prompt) ? 'qa fix' : 'review fix');
    text = 'Fixed.';
  } else {
    wait(delay / 2);
  }
}

/**
 * What the stub coder "builds": a real little kanban, one change per ticket,
 * so every branch has a diff to review. Only inside a run folder.
 */
function writeCode(what) {
  const dir = process.cwd();
  if (!fs.existsSync(path.join(dir, 'pipeline-events.json'))) return;
  const file = (name, body) => fs.writeFileSync(path.join(dir, name), body);
  const read = (name) => (fs.existsSync(path.join(dir, name)) ? fs.readFileSync(path.join(dir, name), 'utf8').replace(/\r\n/g, '\n') : '');
  if (/columns and cards/i.test(what)) {
    file('index.html', [
      '<!doctype html>',
      '<html lang="en">',
      '<head>',
      '  <meta charset="utf-8" />',
      '  <title>Kanban</title>',
      '  <link rel="stylesheet" href="styles.css" />',
      '</head>',
      '<body>',
      '  <form id="add"><input name="title" placeholder="New card" required /><button>Add</button></form>',
      '  <main class="board">',
      '    <section class="column" data-col="todo"><h2>To Do <span class="count">0</span></h2><ul></ul></section>',
      '    <section class="column" data-col="doing"><h2>Doing <span class="count">0</span></h2><ul></ul></section>',
      '    <section class="column" data-col="done"><h2>Done <span class="count">0</span></h2><ul></ul></section>',
      '  </main>',
      '  <script src="board.js"></script>',
      '</body>',
      '</html>',
      '',
    ].join('\n'));
    file('styles.css', [
      'body { font-family: system-ui, sans-serif; margin: 2rem; background: #f6f3ef; }',
      '.board { display: grid; grid-template-columns: repeat(3, 1fr); gap: 1rem; }',
      '.column { background: #fff; border-radius: 8px; padding: 0.75rem; min-height: 12rem; }',
      '.column ul { list-style: none; margin: 0; padding: 0; }',
      '.card { background: #fdf6e3; border-radius: 6px; padding: 0.5rem; margin: 0.4rem 0; }',
      '',
    ].join('\n'));
    file('board.js', [
      "const KEY = 'kanban-cards';",
      "let cards = JSON.parse(localStorage.getItem(KEY) || '[]');",
      '',
      'function save() {',
      '  localStorage.setItem(KEY, JSON.stringify(cards));',
      '}',
      '',
      'function render() {',
      "  for (const column of document.querySelectorAll('.column')) {",
      "    const list = column.querySelector('ul');",
      "    list.textContent = '';",
      '    for (const card of cards.filter((c) => c.col === column.dataset.col)) {',
      "      const li = document.createElement('li');",
      "      li.className = 'card';",
      '      li.textContent = card.title;',
      '      li.dataset.id = card.id;',
      '      list.append(li);',
      '    }',
      '  }',
      '}',
      '',
      "document.getElementById('add').addEventListener('submit', (e) => {",
      '  e.preventDefault();',
      '  const title = e.target.title.value.trim();',
      '  if (!title) return;',
      "  cards.push({ id: crypto.randomUUID(), title, col: 'todo' });",
      '  e.target.reset();',
      '  save();',
      '  render();',
      '});',
      '',
      'render();',
      '',
    ].join('\n'));
  } else if (/drag/i.test(what)) {
    file('board.js', read('board.js').replace(
      "      li.dataset.id = card.id;\n",
      "      li.dataset.id = card.id;\n      li.draggable = true;\n      li.addEventListener('dragstart', (e) => e.dataTransfer.setData('text/plain', card.id));\n",
    ).replace('});\n\nrender();\n', [
      '});',
      '',
      "for (const list of document.querySelectorAll('.column ul')) {",
      "  list.addEventListener('dragover', (e) => e.preventDefault());",
      "  list.addEventListener('drop', (e) => {",
      '    e.preventDefault();',
      "    const card = cards.find((c) => c.id === e.dataTransfer.getData('text/plain'));",
      "    if (card) card.col = list.closest('.column').dataset.col;",
      '    save();',
      '    render();',
      '  });',
      '}',
      '',
      'render();',
      '',
    ].join('\n')));
  } else if (what === 'review fix') {
    file('board.js', read('board.js').replace(
      '      list.append(li);\n    }\n',
      "      list.append(li);\n    }\n    column.querySelector('.count').textContent = String(list.children.length);\n",
    ));
  } else if (what === 'qa fix') {
    // Drop on the whole column, not just its list: an empty list has no height.
    file('board.js', read('board.js')
      .replace("for (const list of document.querySelectorAll('.column ul')) {", "for (const column of document.querySelectorAll('.column')) {")
      .replace("  list.addEventListener('dragover', (e) => e.preventDefault());", "  column.addEventListener('dragover', (e) => e.preventDefault());")
      .replace("  list.addEventListener('drop', (e) => {", "  column.addEventListener('drop', (e) => {")
      .replace("    if (card) card.col = list.closest('.column').dataset.col;", '    if (card) card.col = column.dataset.col;'));
  } else {
    // Any other ticket: a small module of its own, wired into the page.
    const slug = what.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    fs.mkdirSync(path.join(dir, 'features'), { recursive: true });
    file(`features/${slug}.js`, [
      `// ${what}`,
      `export function install(board) {`,
      `  board.dataset.${slug.replace(/-([a-z0-9])/g, (_, c) => c.toUpperCase())} = 'on';`,
      `}`,
      '',
    ].join('\n'));
    const html = read('index.html');
    if (html && !html.includes(`features/${slug}.js`)) {
      file('index.html', html.replace('  <script src="board.js"></script>', `  <script type="module" src="features/${slug}.js"></script>\n  <script src="board.js"></script>`));
    }
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
