import * as THREE from 'three';
import type { SlotId } from '@/lib/team/types';

export interface ScreenTextureResult {
  texture: THREE.CanvasTexture;
  update: (timeSec: number, status?: string, speech?: string | null) => void;
  dispose: () => void;
}

/**
 * Procedural Dynamic Workstation Screen Factory.
 * Generates high-resolution, realistic developer desktop screens (IDE code editor,
 * terminal CLI, test runner, architecture diagram, security scanner, and lead OS).
 * Textures are assigned as diffuse + emissive maps so code glows realistically onto desks and devs.
 */

// Helper to draw window title bar
function drawTitleBar(ctx: CanvasRenderingContext2D, width: number, title: string, tabName?: string) {
  // Title bar background
  ctx.fillStyle = '#201a15';
  ctx.fillRect(0, 0, width, 24);

  // Window control dots (Mac/Linux style warm amber/red/green)
  ctx.fillStyle = '#cf6c5a'; // Red close
  ctx.beginPath();
  ctx.arc(14, 12, 4, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = '#d9a441'; // Amber minimize
  ctx.beginPath();
  ctx.arc(26, 12, 4, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = '#8fae60'; // Green maximize
  ctx.beginPath();
  ctx.arc(38, 12, 4, 0, Math.PI * 2);
  ctx.fill();

  // Active tab
  if (tabName) {
    ctx.fillStyle = '#17130f';
    ctx.fillRect(52, 3, 160, 21);
    ctx.fillStyle = '#d98b4d';
    ctx.font = '10px monospace';
    ctx.fillText(tabName, 62, 17);
  }

  // Window title text
  ctx.fillStyle = '#8a7a6b';
  ctx.font = '10px monospace';
  ctx.textAlign = 'right';
  ctx.fillText(title, width - 12, 16);
  ctx.textAlign = 'left';
}

export function createWorkstationScreen(slot: SlotId, screenIndex: 0 | 1): ScreenTextureResult {
  const width = 512;
  const height = 320;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d')!;

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;

  let lastStatus = '';
  let lastSpeech = '';
  let lastBlink = -1;

  const renderContent = (timeSec: number, status: string, speech?: string | null) => {
    const isWorking = status === 'working' || status === 'active';
    const showCursor = isWorking ? Math.floor(timeSec * 2.5) % 2 === 0 : true;

    // Dark charcoal IDE background
    ctx.fillStyle = '#14110e';
    ctx.fillRect(0, 0, width, height);

    if (slot === 'coder') {
      if (screenIndex === 0) {
        // --- CODER SCREEN 1: TypeScript IDE Code Editor ---
        drawTitleBar(ctx, width, 'VS Code • TypeScript', '📄 auth-pipeline.ts');

        // Line number gutter
        ctx.fillStyle = '#191511';
        ctx.fillRect(0, 24, 38, height - 44);

        ctx.fillStyle = '#6e5e50';
        ctx.font = '11px "JetBrains Mono", monospace';
        for (let i = 1; i <= 14; i++) {
          ctx.fillText(String(i), 12, 24 + i * 18);
        }

        // Active line highlight
        ctx.fillStyle = 'rgba(217, 139, 77, 0.12)';
        ctx.fillRect(38, 24 + 5 * 18 - 14, width - 38, 18);

        // Code Lines
        const codeLines = [
          { text: "import { AgentWorker } from '@/lib/agents';", color: '#8a7a6b' },
          { text: "import { dispatchToWorkspace } from './core';", color: '#8a7a6b' },
          { text: '', color: '#f4ece2' },
          { text: 'export async function runTask(task: Task) {', color: '#d98b4d' },
          { text: "  const worker = await getAgent('coder');", color: '#f4ece2' },
          { text: "  console.log('Compiling AST diff...');", color: '#8fae60' },
          { text: '  const result = await worker.execute({', color: '#7fa8a0' },
          { text: '    model: "claude-3-5-sonnet",', color: '#d9a441' },
          { text: '    temperature: 0.2,', color: '#d9a441' },
          { text: '  });', color: '#7fa8a0' },
          { text: '  return result.applyPatch();', color: '#d98b4d' },
          { text: '}', color: '#d98b4d' },
        ];

        codeLines.forEach((line, idx) => {
          ctx.fillStyle = line.color;
          ctx.font = '11px "JetBrains Mono", monospace';
          ctx.fillText(line.text, 46, 24 + (idx + 1) * 18);
        });

        // Blinking typing cursor on line 6
        if (showCursor) {
          ctx.fillStyle = '#d98b4d';
          ctx.fillRect(46 + ctx.measureText("  const result = await worker.execute({").width + 3, 24 + 7 * 18 - 11, 7, 13);
        }

        // Bottom IDE Status Bar
        ctx.fillStyle = '#221a14';
        ctx.fillRect(0, height - 20, width, 20);
        ctx.fillStyle = isWorking ? '#8fae60' : '#d98b4d';
        ctx.beginPath();
        ctx.arc(10, height - 10, 3.5, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = '#f4ece2';
        ctx.font = '9px monospace';
        ctx.fillText(isWorking ? 'WORKING: Compiling TypeScript' : 'IDLE: Ready for task', 20, height - 6);
        ctx.textAlign = 'right';
        ctx.fillText('Ln 7, Col 39 • UTF-8 • TypeScript 5.4', width - 10, height - 6);
        ctx.textAlign = 'left';
      } else {
        // --- CODER SCREEN 2: Terminal CLI & Git Logs ---
        drawTitleBar(ctx, width, 'bash - dev-house (zsh)');

        ctx.fillStyle = '#0f0c0a';
        ctx.fillRect(0, 24, width, height - 24);

        const logs = [
          { text: '$ git status', color: '#d98b4d' },
          { text: 'On branch main: 3 files modified', color: '#8a7a6b' },
          { text: '$ pnpm test --run', color: '#d98b4d' },
          { text: '✓ test/pipeline.test.ts (24ms)', color: '#8fae60' },
          { text: '✓ test/studio3d/lighting.test.ts (18ms)', color: '#8fae60' },
          { text: 'Test Suites: 2 passed, 2 total', color: '#8fae60' },
          { text: '$ next dev', color: '#d98b4d' },
          { text: '▲ Next.js 15.0 - Local: http://localhost:3000', color: '#f4ece2' },
          { text: '✓ Compiled in 82ms', color: '#8fae60' },
        ];

        if (speech) {
          logs.push({ text: `[Dev]: "${speech.slice(0, 38)}"`, color: '#d9a441' });
        }

        logs.forEach((l, idx) => {
          ctx.fillStyle = l.color;
          ctx.font = '10px monospace';
          ctx.fillText(l.text, 14, 42 + idx * 17);
        });

        // Terminal prompt
        const promptY = 42 + logs.length * 17;
        ctx.fillStyle = '#8fae60';
        ctx.fillText('> dev@hackeroom:~/studio$ ', 14, promptY);
        if (showCursor) {
          ctx.fillStyle = '#f4ece2';
          ctx.fillRect(14 + ctx.measureText('> dev@hackeroom:~/studio$ ').width + 2, promptY - 9, 6, 11);
        }
      }
    } else if (slot === 'tester') {
      if (screenIndex === 0) {
        // --- TESTER SCREEN 1: Vitest Test Suite Dashboard ---
        drawTitleBar(ctx, width, 'Vitest Dashboard • v2.1', '🧪 test-runner.ts');

        // Big summary stats header
        ctx.fillStyle = '#1c1611';
        ctx.fillRect(10, 32, width - 20, 48);

        ctx.fillStyle = '#8fae60';
        ctx.font = 'bold 16px monospace';
        ctx.fillText('✓ 42 PASS', 22, 58);
        ctx.fillStyle = '#8a7a6b';
        ctx.font = '11px monospace';
        ctx.fillText('0 FAIL • 42 Total', 120, 58);

        // Progress bar
        ctx.fillStyle = '#262019';
        ctx.fillRect(22, 66, width - 44, 6);
        ctx.fillStyle = '#8fae60';
        ctx.fillRect(22, 66, (width - 44) * (isWorking ? 0.85 : 1.0), 6);

        // Test items
        const tests = [
          '✓ e2e/room-lighting.spec.ts (112ms)',
          '✓ unit/collision-bounds.test.ts (14ms)',
          '✓ unit/ticket-branch.test.ts (22ms)',
          '✓ integration/coffee-speed-buff.test.ts (18ms)',
          '✓ integration/air-conditioner.test.ts (26ms)',
          '✓ perf/fps-stability-60fps.test.ts (8ms)',
        ];

        tests.forEach((t, idx) => {
          ctx.fillStyle = '#181410';
          ctx.fillRect(10, 90 + idx * 30, width - 20, 24);
          ctx.fillStyle = '#8fae60';
          ctx.font = '10px monospace';
          ctx.fillText(t, 22, 106 + idx * 30);
        });
      } else {
        // --- TESTER SCREEN 2: Realtime Latency & Telemetry Graph ---
        drawTitleBar(ctx, width, 'System Telemetry & Load');

        ctx.fillStyle = '#120f0d';
        ctx.fillRect(10, 34, width - 20, 120);

        // Sparkline graph
        ctx.strokeStyle = '#8fae60';
        ctx.lineWidth = 2;
        ctx.beginPath();
        for (let x = 0; x < width - 40; x += 15) {
          const y = 94 + Math.sin(x * 0.05 + timeSec * 3) * 22 + Math.cos(x * 0.1) * 8;
          if (x === 0) ctx.moveTo(20 + x, y);
          else ctx.lineTo(20 + x, y);
        }
        ctx.stroke();

        ctx.fillStyle = '#f4ece2';
        ctx.font = '11px monospace';
        ctx.fillText('API Request Latency: 18ms avg', 20, 52);
        ctx.fillStyle = '#8a7a6b';
        ctx.font = '9px monospace';
        ctx.fillText('Peak 34ms • P99 22ms • 0 Dropped Packets', 20, 68);

        // System resources
        ctx.fillStyle = '#1c1611';
        ctx.fillRect(10, 168, width - 20, 130);
        ctx.fillStyle = '#d98b4d';
        ctx.font = 'bold 11px monospace';
        ctx.fillText('Engine Performance:', 22, 192);

        const metrics = [
          'Framerate: 120 FPS (VSync Locked)',
          'Draw Calls: 48 • Triangles: 32.4K',
          'VRAM Usage: 142MB / 8192MB',
          'Garbage Collection: 0 pauses',
        ];

        metrics.forEach((m, idx) => {
          ctx.fillStyle = '#f4ece2';
          ctx.font = '10px monospace';
          ctx.fillText(m, 22, 214 + idx * 20);
        });
      }
    } else if (slot === 'supervisor') {
      if (screenIndex === 0) {
        // --- SUPERVISOR SCREEN 1: Squad Command Matrix ---
        drawTitleBar(ctx, width, 'Squad Command Matrix', '👑 supervisor-ops.ts');

        ctx.fillStyle = '#d98b4d';
        ctx.font = 'bold 12px monospace';
        ctx.fillText('ACTIVE TEAM SQUAD ROSTER', 18, 46);

        const agents = [
          { role: 'CODER', state: 'Active • Writing Pipeline', color: '#8fae60' },
          { role: 'TESTER', state: 'Active • Vitest Running', color: '#8fae60' },
          { role: 'PLANNER', state: 'Ready • Plan Approved', color: '#7fa8a0' },
          { role: 'REVIEWER', state: 'Reviewing PR #142', color: '#d9a441' },
          { role: 'AUDITOR', state: 'Security Verification', color: '#cf6c5a' },
        ];

        agents.forEach((ag, idx) => {
          ctx.fillStyle = '#1a1511';
          ctx.fillRect(14, 58 + idx * 42, width - 28, 36);

          ctx.fillStyle = ag.color;
          ctx.beginPath();
          ctx.arc(28, 76 + idx * 42, 4, 0, Math.PI * 2);
          ctx.fill();

          ctx.fillStyle = '#f4ece2';
          ctx.font = 'bold 11px monospace';
          ctx.fillText(ag.role, 40, 74 + idx * 42);

          ctx.fillStyle = '#8a7a6b';
          ctx.font = '10px monospace';
          ctx.fillText(ag.state, 40, 88 + idx * 42);
        });
      } else {
        // --- SUPERVISOR SCREEN 2: Pipeline Stage Flow ---
        drawTitleBar(ctx, width, 'Pipeline Execution DAG');

        const stages = ['PLAN', 'CODE', 'TEST', 'AUDIT', 'SHIP'];
        const currentStageIdx = 2; // Testing

        stages.forEach((st, idx) => {
          const boxX = 22 + idx * 95;
          const boxY = 60;
          const isCurrent = idx === currentStageIdx;

          ctx.fillStyle = isCurrent ? '#d98b4d' : idx < currentStageIdx ? '#8fae60' : '#262019';
          ctx.fillRect(boxX, boxY, 80, 42);

          ctx.fillStyle = isCurrent ? '#17130f' : '#f4ece2';
          ctx.font = 'bold 11px monospace';
          ctx.textAlign = 'center';
          ctx.fillText(st, boxX + 40, boxY + 24);
          ctx.textAlign = 'left';
        });

        // Event logs
        ctx.fillStyle = '#16120e';
        ctx.fillRect(14, 120, width - 28, 175);

        const evts = [
          '10:14:02  [Supervisor] Initiated dev squad loop',
          '10:16:34  [Planner] Generated studio specification',
          '10:18:22  [Coder] Generated 3D modules & room controls',
          '10:20:45  [Tester] Automated tests verified 100%',
          '10:22:10  [Supervisor] Ready for user deployment',
        ];

        evts.forEach((ev, idx) => {
          ctx.fillStyle = '#f4ece2';
          ctx.font = '10px monospace';
          ctx.fillText(ev, 24, 144 + idx * 24);
        });
      }
    } else if (slot === 'planner') {
      if (screenIndex === 0) {
        // --- PLANNER SCREEN 1: Architecture Specification Markdown ---
        drawTitleBar(ctx, width, 'ARCHITECTURE_PLAN.md', '📋 plan.md');

        const planLines = [
          { text: '# Dev House 3D Architecture Plan', color: '#d98b4d' },
          { text: '## 1. Single Active Floor Layout', color: '#7fa8a0' },
          { text: '  [x] Render room at y=0 plane (no clipping)', color: '#8fae60' },
          { text: '  [x] A branch and a review per ticket', color: '#8fae60' },
          { text: '## 2. Realistic Studio Lighting', color: '#7fa8a0' },
          { text: '  [x] High-lumen warm ceiling downlights', color: '#8fae60' },
          { text: '  [x] Studio ambient fill & key illumination', color: '#8fae60' },
          { text: '## 3. Interactive Room Environment', color: '#7fa8a0' },
          { text: '  [x] Light Switch (Studio vs Cozy Mode)', color: '#8fae60' },
          { text: '  [x] Wall AC Unit (70°F cooling stream)', color: '#8fae60' },
          { text: '  [x] Espresso Coffee Bar (+40% speed)', color: '#8fae60' },
          { text: '## 4. Realistic Dev Monitor Screens', color: '#7fa8a0' },
          { text: '  [x] Syntax highlighted code & terminals', color: '#8fae60' },
        ];

        planLines.forEach((l, idx) => {
          ctx.fillStyle = l.color;
          ctx.font = idx === 0 ? 'bold 12px monospace' : '10px monospace';
          ctx.fillText(l.text, 18, 48 + idx * 20);
        });
      } else {
        // --- PLANNER SCREEN 2: System Diagram ---
        drawTitleBar(ctx, width, 'System Architecture Flow');

        ctx.strokeStyle = '#d98b4d';
        ctx.lineWidth = 1.5;

        // Flowchart nodes
        const nodes = [
          { label: 'User Command', x: 40, y: 50, w: 120, h: 36 },
          { label: 'Supervisor', x: 200, y: 50, w: 120, h: 36 },
          { label: 'Coder Agent', x: 200, y: 130, w: 120, h: 36 },
          { label: 'Test Suite', x: 360, y: 130, w: 120, h: 36 },
          { label: '3D Studio UI', x: 360, y: 220, w: 120, h: 36 },
        ];

        nodes.forEach((n) => {
          ctx.fillStyle = '#201913';
          ctx.fillRect(n.x, n.y, n.w, n.h);
          ctx.strokeRect(n.x, n.y, n.w, n.h);
          ctx.fillStyle = '#f4ece2';
          ctx.font = 'bold 10px monospace';
          ctx.textAlign = 'center';
          ctx.fillText(n.label, n.x + n.w / 2, n.y + 22);
          ctx.textAlign = 'left';
        });

        // Connector lines
        ctx.beginPath();
        ctx.moveTo(160, 68);
        ctx.lineTo(200, 68);
        ctx.moveTo(260, 86);
        ctx.lineTo(260, 130);
        ctx.moveTo(320, 148);
        ctx.lineTo(360, 148);
        ctx.moveTo(420, 166);
        ctx.lineTo(420, 220);
        ctx.stroke();
      }
    } else if (slot === 'reviewer') {
      if (screenIndex === 0) {
        // --- REVIEWER SCREEN 1: GitHub PR Diff ---
        drawTitleBar(ctx, width, 'PR #142: feat(studio3d)', '🔍 pull-request.diff');

        ctx.fillStyle = '#f4ece2';
        ctx.font = 'bold 11px monospace';
        ctx.fillText('feat(studio3d): bright warm lights & code screens', 16, 46);

        const diffs = [
          { text: '@@ -140,6 +140,8 @@ buildStudioArchitecture', color: '#7fa8a0' },
          { text: '- const light = new THREE.PointLight("#fef08a", 0.45, 8.5);', color: '#cf6c5a' },
          { text: '+ const light = new THREE.PointLight("#fef08a", 3.2, 14, 1.2);', color: '#8fae60' },
          { text: '+ const studioKey = new THREE.DirectionalLight("#fff4e6", 1.6);', color: '#8fae60' },
          { text: '+ const hemiLight = new THREE.HemisphereLight("#fff5ea", 0.9);', color: '#8fae60' },
          { text: '@@ -210,4 +212,12 @@ workstationScreens', color: '#7fa8a0' },
          { text: '+ const codeScreen = createWorkstationScreen("coder", 0);', color: '#8fae60' },
          { text: '+ screenMesh.material.map = codeScreen.texture;', color: '#8fae60' },
        ];

        diffs.forEach((d, idx) => {
          ctx.fillStyle = d.color.startsWith('+') ? 'rgba(143, 174, 96, 0.12)' : d.color.startsWith('-') ? 'rgba(207, 108, 90, 0.12)' : 'transparent';
          ctx.fillRect(10, 56 + idx * 22, width - 20, 20);
          ctx.fillStyle = d.color;
          ctx.font = '10px monospace';
          ctx.fillText(d.text, 16, 70 + idx * 22);
        });

        // Review Approval Banner
        ctx.fillStyle = '#8fae60';
        ctx.fillRect(10, 260, width - 20, 36);
        ctx.fillStyle = '#17130f';
        ctx.font = 'bold 12px monospace';
        ctx.fillText('✓ APPROVED: LGTM! Code is clean & performant.', 24, 282);
      } else {
        // --- REVIEWER SCREEN 2: Static Analysis & Code Coverage ---
        drawTitleBar(ctx, width, 'Code Climate & Linter');

        ctx.fillStyle = '#181410';
        ctx.fillRect(12, 36, width - 24, 80);

        ctx.fillStyle = '#8fae60';
        ctx.font = 'bold 22px monospace';
        ctx.fillText('A+', 28, 76);
        ctx.fillStyle = '#f4ece2';
        ctx.font = 'bold 12px monospace';
        ctx.fillText('Code Quality Grade', 70, 64);
        ctx.fillStyle = '#8a7a6b';
        ctx.font = '10px monospace';
        ctx.fillText('0 Critical Issues • 0 Vulnerabilities • 98.4% Clean', 70, 82);

        ctx.fillStyle = '#d98b4d';
        ctx.font = 'bold 11px monospace';
        ctx.fillText('LINTER REPORT (ESLint + TypeScript):', 14, 146);

        const reports = [
          '✓ No unused variables detected',
          '✓ Strict null checks: 100% compliant',
          '✓ All React hooks dependency arrays verified',
          '✓ Bundle size budget: Within limits (gzip 142KB)',
        ];

        reports.forEach((r, idx) => {
          ctx.fillStyle = '#8fae60';
          ctx.font = '10px monospace';
          ctx.fillText(r, 14, 172 + idx * 24);
        });
      }
    } else if (slot === 'auditor') {
      if (screenIndex === 0) {
        // --- AUDITOR SCREEN 1: Security Vulnerability Scanner ---
        drawTitleBar(ctx, width, 'Security & Compliance Scanner', '🛡️ audit.log');

        ctx.fillStyle = '#cf6c5a';
        ctx.fillRect(12, 34, 150, 40);
        ctx.fillStyle = '#f4ece2';
        ctx.font = 'bold 11px monospace';
        ctx.fillText('0 CRITICAL CVEs', 24, 58);

        ctx.fillStyle = '#8fae60';
        ctx.fillRect(172, 34, 150, 40);
        ctx.fillStyle = '#17130f';
        ctx.font = 'bold 11px monospace';
        ctx.fillText('ALL GATES PASSED', 184, 58);

        const auditChecks = [
          { label: 'Sandbox Isolation Boundary', status: 'ENFORCED (SECURE)' },
          { label: 'Network Proxy & Firewall Rules', status: 'LOCALHOST ONLY' },
          { label: 'Memory Buffer Bounds Check', status: '0 OVERFLOWS' },
          { label: 'Credential & Key Vault', status: 'ENCRYPTED AT REST' },
          { label: 'Process Execution Limits', status: 'CPU & MEM CAPPED' },
        ];

        auditChecks.forEach((c, idx) => {
          ctx.fillStyle = '#1b1612';
          ctx.fillRect(12, 90 + idx * 38, width - 24, 32);

          ctx.fillStyle = '#f4ece2';
          ctx.font = '10px monospace';
          ctx.fillText(c.label, 22, 110 + idx * 38);

          ctx.fillStyle = '#8fae60';
          ctx.font = 'bold 10px monospace';
          ctx.textAlign = 'right';
          ctx.fillText(c.status, width - 24, 110 + idx * 38);
          ctx.textAlign = 'left';
        });
      } else {
        // --- AUDITOR SCREEN 2: Security Access Log Stream ---
        drawTitleBar(ctx, width, 'Security Audit Stream');

        ctx.fillStyle = '#100d0a';
        ctx.fillRect(10, 32, width - 20, height - 42);

        const logs = [
          '10:11:04 [SEC] Sandbox initialized in secure mode',
          '10:12:18 [AUTH] Local token verified for developer',
          '10:14:02 [SYS] Memory allocations checked: clean',
          '10:16:40 [NET] External egress blocked by policy',
          '10:19:12 [AUDIT] Code signature matches build hash',
          '10:22:00 [PASS] Full security verification certified',
        ];

        logs.forEach((l, idx) => {
          ctx.fillStyle = idx % 2 === 0 ? '#8fae60' : '#f4ece2';
          ctx.font = '10px monospace';
          ctx.fillText(l, 20, 56 + idx * 24);
        });
      }
    }

    texture.needsUpdate = true;
  };

  // Initial draw
  renderContent(0, 'idle');

  const update = (timeSec: number, status: string = 'idle', speech?: string | null) => {
    const isWorking = status === 'working' || status === 'active';
    const blink = isWorking ? Math.floor(timeSec * 2.5) % 2 : 0;
    const speechStr = speech || '';

    // Only re-render when status changes, speech changes, or blinking cursor ticks while working
    if (status !== lastStatus || speechStr !== lastSpeech || (isWorking && blink !== lastBlink)) {
      lastStatus = status;
      lastSpeech = speechStr;
      lastBlink = blink;
      renderContent(timeSec, status, speech);
    }
  };

  const dispose = () => {
    texture.dispose();
  };

  return { texture, update, dispose };
}

/**
 * Creates the Ultrawide Curved Monitor texture for Commander Desk ("My Computer").
 */
/** One column of the board as the commander screen shows it. */
export interface CommanderBoardColumn {
  label: string;
  count: number;
  /** The top few cards: id and title. */
  cards: { id: string; title: string; color: string }[];
}

export interface CommanderBoardScreen {
  texture: THREE.CanvasTexture;
  /** Redraw with the run's board; cheap to call only when the tickets change. */
  draw: (title: string, columns: CommanderBoardColumn[]) => void;
  dispose: () => void;
}

/**
 * The commander desk's ultrawide: a mini version of the ticket board, so you
 * can see work move from across the room. Drawn on change, not per frame.
 */
export function createCommanderBoardScreen(): CommanderBoardScreen {
  const width = 1024;
  const height = 340;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d')!;

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;

  const clip = (text: string, max: number) => {
    if (ctx.measureText(text).width <= max) return text;
    let t = text;
    while (t.length > 1 && ctx.measureText(`${t}…`).width > max) t = t.slice(0, -1);
    return `${t}…`;
  };

  const draw = (title: string, columns: CommanderBoardColumn[]) => {
    ctx.fillStyle = '#120f0d';
    ctx.fillRect(0, 0, width, height);
    ctx.fillStyle = '#1e1814';
    ctx.fillRect(0, 0, width, 30);
    ctx.fillStyle = '#d98b4d';
    ctx.font = 'bold 13px monospace';
    ctx.fillText('TEAM BOARD', 18, 20);
    ctx.fillStyle = '#c9b8a6';
    ctx.font = '12px monospace';
    ctx.fillText(clip(title || 'No run yet — write a brief on the whiteboard', width - 180), 130, 20);

    const total = columns.reduce((n, c) => n + c.count, 0);
    if (total === 0) {
      ctx.fillStyle = '#8a7a6b';
      ctx.font = 'italic 15px monospace';
      ctx.textAlign = 'center';
      ctx.fillText('No tickets yet', width / 2, height / 2 + 10);
      ctx.textAlign = 'left';
      texture.needsUpdate = true;
      return;
    }

    const gap = 8;
    const colW = (width - 16 * 2 - gap * (columns.length - 1)) / columns.length;
    columns.forEach((col, i) => {
      const x = 16 + i * (colW + gap);
      ctx.fillStyle = '#1a1612';
      ctx.fillRect(x, 40, colW, height - 52);
      ctx.fillStyle = '#c9b8a6';
      ctx.font = 'bold 11px monospace';
      ctx.fillText(clip(col.label.toUpperCase(), colW - 34), x + 8, 58);
      ctx.fillStyle = col.count ? '#f4ece2' : '#5c5046';
      ctx.textAlign = 'right';
      ctx.fillText(String(col.count), x + colW - 8, 58);
      ctx.textAlign = 'left';

      col.cards.slice(0, 4).forEach((card, k) => {
        const y = 70 + k * 62;
        ctx.fillStyle = '#241d17';
        ctx.fillRect(x + 6, y, colW - 12, 54);
        ctx.fillStyle = card.color;
        ctx.fillRect(x + 6, y, 3, 54);
        ctx.fillStyle = '#8a7a6b';
        ctx.font = 'bold 10px monospace';
        ctx.fillText(card.id, x + 15, y + 15);
        ctx.fillStyle = '#f4ece2';
        ctx.font = '11px monospace';
        const words = card.title.split(' ');
        let line = '';
        let row = 0;
        for (const word of words) {
          const next = line ? `${line} ${word}` : word;
          if (ctx.measureText(next).width > colW - 26 && line) {
            ctx.fillText(line, x + 15, y + 31 + row * 14);
            row += 1;
            line = word;
            if (row === 1) {
              ctx.fillText(clip(words.slice(words.indexOf(word)).join(' '), colW - 26), x + 15, y + 31 + row * 14);
              line = '';
              break;
            }
          } else {
            line = next;
          }
        }
        if (line) ctx.fillText(line, x + 15, y + 31 + row * 14);
      });
      if (col.count > 4) {
        ctx.fillStyle = '#8a7a6b';
        ctx.font = '10px monospace';
        ctx.fillText(`+${col.count - 4} more`, x + 8, height - 20);
      }
    });
    texture.needsUpdate = true;
  };

  draw('', []);

  return {
    texture,
    draw,
    dispose: () => texture.dispose(),
  };
}
