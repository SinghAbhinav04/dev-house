import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DockerRunner } from '../pipeline/runner.ts';

const cleanProject = process.argv.includes('--clean');
const projectDirArgIndex = process.argv.indexOf('--project-dir');
const pipelineDirArgIndex = process.argv.indexOf('--pipeline-dir');
const roleFileArgIndex = process.argv.indexOf('--role-file');
const timeoutMs = Number(process.env.PROBE_TIMEOUT_MS || '15000');

const explicitProjectDir = projectDirArgIndex >= 0 ? process.argv[projectDirArgIndex + 1] : '';
const explicitPipelineDir = pipelineDirArgIndex >= 0 ? process.argv[pipelineDirArgIndex + 1] : '';
const explicitRoleFile = roleFileArgIndex >= 0 ? process.argv[roleFileArgIndex + 1] : '';

const projectDir = explicitProjectDir || (cleanProject
  ? mkdtempSync(join(tmpdir(), 'docker-runner-clean-'))
  : process.cwd());

const runner = new DockerRunner();
const child = runner.spawn({
  prompt: 'Reply with exactly OK and nothing else.',
  projectDir,
  pipelineDir: explicitPipelineDir || (cleanProject ? undefined : join(process.cwd(), 'pipeline')),
  model: 'claude-sonnet-4-6',
  ...(explicitRoleFile ? { roleFile: explicitRoleFile } : { systemPrompt: 'You are a test assistant.' }),
  pipelineAgent: 'C',
  securityMode: 'fast',
});

let stdoutText = '';
let stderrText = '';

child.stdout.on('data', (chunk) => {
  stdoutText += chunk.toString('utf8');
});

child.stderr.on('data', (chunk) => {
  stderrText += chunk.toString('utf8');
});

const timeout = setTimeout(() => {
  console.log('STDOUT_START');
  console.log(stdoutText);
  console.log('STDOUT_END');
  console.log('STDERR_START');
  console.log(stderrText);
  console.log('STDERR_END');
  child.kill('SIGTERM');
}, timeoutMs);

child.on('close', (code) => {
  clearTimeout(timeout);
  console.log(`EXIT:${code}`);
  console.log('STDOUT_START');
  console.log(stdoutText);
  console.log('STDOUT_END');
  console.log('STDERR_START');
  console.log(stderrText);
  console.log('STDERR_END');
});
