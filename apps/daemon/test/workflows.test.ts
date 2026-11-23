import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('locateWorkflow', () => {
  it('finds a moved workflow by file name, and leaves existing or unknown paths alone', async () => {
    const home = mkdtempSync(join(tmpdir(), 'orstra-wf-'));
    mkdirSync(join(home, 'workflows'));
    writeFileSync(join(home, 'workflows', 'ask-first.yaml'), 'name: Ask first\n');
    process.env.ORSTRA_HOME = home;
    const { locateWorkflow } = await import('../src/workflows.ts');
    expect(locateWorkflow('/old/repo/workflows/ask-first.yaml')).toBe(join(home, 'workflows', 'ask-first.yaml'));
    expect(locateWorkflow(join(home, 'workflows', 'ask-first.yaml'))).toBe(join(home, 'workflows', 'ask-first.yaml'));
    expect(locateWorkflow('/old/repo/workflows/gone.yaml')).toBe('/old/repo/workflows/gone.yaml');
  });
});

describe('ensureDirs seeding', () => {
  it('copies the repo defaults only when the workflow folder does not exist yet', async () => {
    const { readdirSync, rmSync } = await import('node:fs');
    const home = mkdtempSync(join(tmpdir(), 'orstra-seed-'));
    process.env.ORSTRA_HOME = home;
    delete process.env.ORSTRA_WORKFLOWS;
    const { vi } = await import('vitest');
    vi.resetModules();
    const { ensureDirs, WORKFLOWS_DIR } = await import('../src/paths.ts');
    ensureDirs();
    expect(readdirSync(WORKFLOWS_DIR)).toContain('simple.yaml');
    rmSync(join(WORKFLOWS_DIR, 'simple.yaml'));
    ensureDirs();
    expect(readdirSync(WORKFLOWS_DIR)).not.toContain('simple.yaml');
  });
});
