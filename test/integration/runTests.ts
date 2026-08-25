/**
 * Downloads (or reuses) a VS Code build and runs the integration suite inside a
 * real extension host against a throwaway workspace folder.
 */
import { runTests } from '@vscode/test-electron';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

async function main(): Promise<void> {
  // out/test/integration -> out/test -> out -> project root
  const extensionDevelopmentPath = path.resolve(__dirname, '../../..');
  const extensionTestsPath = path.resolve(__dirname, './index');

  // The extension host's console output is not reliably forwarded on every
  // platform, so the suite also writes a summary file we can read afterwards.
  const summaryPath = path.join(
    extensionDevelopmentPath,
    '.vscode-test',
    'integration-summary.json'
  );
  fs.mkdirSync(path.dirname(summaryPath), { recursive: true });
  fs.rmSync(summaryPath, { force: true });

  // Keep the profile outside the folder being opened: a user-data directory
  // inside the workspace has been observed to make the launch hand off to
  // another instance and exit immediately without running anything.
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'reqrunner-ws-'));
  const workspacePath = path.join(sandbox, 'workspace');
  const userDataDir = path.join(sandbox, 'user-data');
  fs.mkdirSync(workspacePath, { recursive: true });

  const samplesPath = path.join(extensionDevelopmentPath, 'samples');
  for (const entry of fs.readdirSync(samplesPath)) {
    fs.copyFileSync(path.join(samplesPath, entry), path.join(workspacePath, entry));
  }

  try {
    await runTests({
      extensionDevelopmentPath,
      extensionTestsPath,
      launchArgs: [
        workspacePath,
        '--disable-extensions',
        '--disable-gpu',
        '--disable-workspace-trust',
        `--user-data-dir=${userDataDir}`
      ],
      extensionTestsEnv: {
        REQRUNNER_TEST_WORKSPACE: workspacePath,
        REQRUNNER_TEST_SUMMARY: summaryPath
      }
    });

    // A VS Code launch can exit 0 without ever reaching the suite (for example
    // when it hands the folder to another instance). Treat a missing summary as
    // a failure so that never looks like a pass.
    if (!fs.existsSync(summaryPath)) {
      throw new Error(
        'The integration suite did not run: no summary was written. ' +
          'Check that no other VS Code instance is using the test user-data directory.'
      );
    }
    const summary = JSON.parse(fs.readFileSync(summaryPath, 'utf8')) as {
      total: number;
      passed: number;
      failed: number;
      skippedChecks: string[];
    };
    process.stdout.write(
      `\nIntegration: ${summary.passed}/${summary.total} passed, ${summary.failed} failed\n`
    );
    for (const reason of summary.skippedChecks) {
      process.stdout.write(`  skipped: ${reason}\n`);
    }
    if (summary.failed > 0 || summary.passed !== summary.total) {
      throw new Error('Integration suite reported failures.');
    }
  } finally {
    try {
      fs.rmSync(sandbox, { recursive: true, force: true });
    } catch {
      // A locked user-data file on Windows must not fail the run.
    }
  }
}

main().catch((error) => {
  console.error('Integration tests failed to run.');
  console.error(error);
  process.exit(1);
});
