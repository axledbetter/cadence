/**
 * CLI tests for the protocol surface.
 *
 *   - `cadence --protocol`               (runProtocolPrint)
 *   - `cadence protocol changelog`       (runProtocolChangelog)
 *   - `cadence protocol changelog --since=X.Y.Z`
 *   - `cadence profile upgrade <path>`   (runProfileUpgrade, dry-run)
 *
 * We invoke the functions directly (faster, easier to assert against)
 * rather than spawning the CLI process — the CLI dispatcher is a thin
 * wrapper over these.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { runProtocolPrint, runProtocolChangelog } from '../../src/cli/protocol.ts';
import { runProfileUpgrade } from '../../src/cli/profile-upgrade.ts';
import { PROTOCOL_VERSION } from '../../src/core/protocol/version.ts';

// Capture stdout/stderr to assert without dumping to test output.
function captureStdio<T>(fn: () => T): { result: T; stdout: string; stderr: string } {
  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (process.stdout as any).write = (chunk: any, ...args: any[]) => {
    stdoutChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
    return true;
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (process.stderr as any).write = (chunk: any, ...args: any[]) => {
    stderrChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
    return true;
  };
  try {
    const result = fn();
    return {
      result,
      stdout: Buffer.concat(stdoutChunks).toString('utf8'),
      stderr: Buffer.concat(stderrChunks).toString('utf8'),
    };
  } finally {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
  }
}

describe('cadence --protocol', () => {
  it('prints the protocol version line + every component', () => {
    const { result, stdout } = captureStdio(() => runProtocolPrint());
    assert.equal(result, 0);
    assert.match(stdout, new RegExp(`cadence-protocol ${PROTOCOL_VERSION.replace(/\./g, '\\.')}`));
    // Verify every shipped component shows up.
    assert.match(stdout, /profile \(profile\): 1\.0\.0/);
    assert.match(stdout, /skillFrontmatter \(skill-frontmatter\): 1\.0\.0/);
    assert.match(stdout, /state \(state\): 1\.0\.0/);
    assert.match(stdout, /phaseOutput \(phase-output\): 1\.0\.0/);
  });
});

describe('cadence protocol changelog', () => {
  it('prints the file unfiltered when --since is absent', () => {
    const { result, stdout } = captureStdio(() => runProtocolChangelog());
    assert.equal(result, 0);
    assert.match(stdout, /# Cadence Protocol Changelog/);
    assert.match(stdout, /## 1\.0\.0/);
  });

  it('filters out older entries when --since is supplied', () => {
    const { result, stdout } = captureStdio(() => runProtocolChangelog({ since: '2.0.0' }));
    // 2.0.0 doesn't exist; nothing newer than 2.0.0; header still shown.
    assert.equal(result, 0);
    assert.match(stdout, /# Cadence Protocol Changelog/);
    // 1.0.0 section should not appear when filtering for >= 2.0.0.
    assert.doesNotMatch(stdout, /## 1\.0\.0/);
  });

  it('returns 1 on invalid --since', () => {
    const { result } = captureStdio(() => runProtocolChangelog({ since: 'not-a-version' }));
    assert.equal(result, 1);
  });

  it('keeps the 1.0.0 entry when --since=1.0.0', () => {
    const { result, stdout } = captureStdio(() => runProtocolChangelog({ since: '1.0.0' }));
    assert.equal(result, 0);
    assert.match(stdout, /## 1\.0\.0/);
  });
});

describe('cadence profile upgrade — dry-run', () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cadence-profile-upgrade-'));
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('reports already-canonical when input matches current shape', () => {
    const file = path.join(tmpDir, 'profile.yaml');
    fs.writeFileSync(
      file,
      'protocol_version: "1.0.0"\nprofile: solo\ndescription: a minimal test\ncodex_passes:\n  low: 1\n  medium: 2\n  high: 3\nauto_merge: true\nrequire_risk_frontmatter: false\npause_at_steps: []\naudit_log_path: null\ncodex_explanations: false\npr_template_path: null\ncontributor_policy: null\n',
    );
    const { result, stdout } = captureStdio(() =>
      runProfileUpgrade({ filePath: file, write: false }),
    );
    assert.equal(result.exitCode, 0);
    // Either "already canonical" (no diff) OR a small reformat diff. Both OK.
    assert.ok(stdout.length > 0);
  });

  it('handles an old profile (no protocol_version field) by treating as 1.0.0', () => {
    const file = path.join(tmpDir, 'profile.yaml');
    fs.writeFileSync(
      file,
      'profile: solo\ndescription: legacy profile\ncodex_passes:\n  low: 1\n  medium: 2\n  high: 3\n',
    );
    const { result, stdout } = captureStdio(() =>
      runProfileUpgrade({ filePath: file, write: false }),
    );
    assert.equal(result.exitCode, 0);
    assert.equal(result.declaredVersion, '1.0.0');
    // Dry-run, so file should be unchanged on disk.
    const after = fs.readFileSync(file, 'utf8');
    assert.equal(after, 'profile: solo\ndescription: legacy profile\ncodex_passes:\n  low: 1\n  medium: 2\n  high: 3\n');
    // Output should mention 1.0.0 -> 1.0.0 or similar.
    assert.match(stdout, /protocol_version|1\.0\.0/);
  });

  it('returns exit 1 when file does not exist', () => {
    const { result } = captureStdio(() =>
      runProfileUpgrade({ filePath: path.join(tmpDir, 'missing.yaml'), write: false }),
    );
    assert.equal(result.exitCode, 1);
  });

  it('returns exit 1 on invalid YAML', () => {
    const file = path.join(tmpDir, 'broken.yaml');
    fs.writeFileSync(file, '\tprofile: solo\n  : not yaml\n');
    const { result } = captureStdio(() =>
      runProfileUpgrade({ filePath: file, write: false }),
    );
    assert.equal(result.exitCode, 1);
  });
});
