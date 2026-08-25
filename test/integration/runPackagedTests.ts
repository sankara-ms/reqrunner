/**
 * Verifies the built .vsix, not the source tree.
 *
 * 1. Installs the VSIX with the real VS Code CLI into a clean profile and
 *    confirms the extension id is registered.
 * 2. Runs the integration suite against the folder VS Code extracted from that
 *    VSIX, so the code under test is the packaged, minified bundle together with
 *    the packaged manifest, grammar and media files.
 */
import { downloadAndUnzipVSCode, resolveCliArgsFromVSCodeExecutablePath, runTests } from '@vscode/test-electron';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const EXTENSION_ID = 'sankara-ms.reqrunner';

function findVsix(projectRoot: string): string {
  const manifest = JSON.parse(
    fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8')
  ) as { name: string; version: string };
  const expected = path.join(projectRoot, `${manifest.name}-${manifest.version}.vsix`);
  if (!fs.existsSync(expected)) {
    throw new Error(`${expected} not found. Run "npm run package" first.`);
  }
  return expected;
}

async function main(): Promise<void> {
  // out/test/integration -> out/test -> out -> project root
  const projectRoot = path.resolve(__dirname, '../../..');
  const extensionTestsPath = path.resolve(__dirname, './index');
  const vsixPath = findVsix(projectRoot);

  const summaryPath = path.join(projectRoot, '.vscode-test', 'packaged-summary.json');
  fs.mkdirSync(path.dirname(summaryPath), { recursive: true });
  fs.rmSync(summaryPath, { force: true });

  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'reqrunner-vsix-'));
  const workspacePath = path.join(sandbox, 'workspace');
  const installDir = path.join(sandbox, 'installed-extensions');
  const runExtensionsDir = path.join(sandbox, 'run-extensions');
  // The install step and the test run need separate profiles: sharing one makes
  // the second launch hand the folder to the first instance and exit instantly,
  // which looks like a pass but runs nothing.
  const installUserDataDir = path.join(sandbox, 'user-data-install');
  const runUserDataDir = path.join(sandbox, 'user-data-run');
  fs.mkdirSync(workspacePath, { recursive: true });
  fs.mkdirSync(runExtensionsDir, { recursive: true });

  const samplesPath = path.join(projectRoot, 'samples');
  for (const entry of fs.readdirSync(samplesPath)) {
    fs.copyFileSync(path.join(samplesPath, entry), path.join(workspacePath, entry));
  }

  const vscodeExecutablePath = await downloadAndUnzipVSCode();
  const [cli, ...cliArgs] = resolveCliArgsFromVSCodeExecutablePath(vscodeExecutablePath);
  const cliOptions = { encoding: 'utf8' as const, shell: process.platform === 'win32' };

  console.log(`Installing ${path.basename(vsixPath)} with the VS Code CLI…`);
  const install = spawnSync(
    cli,
    [
      ...cliArgs,
      '--extensions-dir',
      installDir,
      '--user-data-dir',
      installUserDataDir,
      '--install-extension',
      vsixPath,
      '--force'
    ],
    cliOptions
  );
  console.log((install.stdout ?? '').trim());
  if (install.status !== 0) {
    console.error(install.stderr);
    throw new Error(`Installing the VSIX failed with code ${install.status}`);
  }

  const listed = spawnSync(
    cli,
    [
      ...cliArgs,
      '--extensions-dir',
      installDir,
      '--user-data-dir',
      installUserDataDir,
      '--list-extensions',
      '--show-versions'
    ],
    cliOptions
  );
  const installed = (listed.stdout ?? '').trim();
  console.log(`Installed extensions: ${installed || '(none)'}`);
  if (!new RegExp(`^${EXTENSION_ID.replace('.', '\\.')}@`, 'm').test(installed)) {
    throw new Error(`${EXTENSION_ID} is not present in the test profile.`);
  }

  // VS Code unpacked the VSIX here; this folder is the artifact under test.
  const unpacked = fs
    .readdirSync(installDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith(EXTENSION_ID))
    .map((entry) => path.join(installDir, entry.name));
  if (unpacked.length !== 1) {
    throw new Error(
      `Expected exactly one unpacked ${EXTENSION_ID} folder, found ${unpacked.length}.`
    );
  }
  const packagedExtensionPath = unpacked[0];

  // Sanity-check that we are testing the packaged bundle, not the source tree.
  const bundlePath = path.join(packagedExtensionPath, 'dist', 'extension.js');
  if (!fs.existsSync(bundlePath)) {
    throw new Error(`The packaged extension has no dist/extension.js at ${bundlePath}`);
  }
  if (fs.existsSync(path.join(packagedExtensionPath, 'src'))) {
    throw new Error('The VSIX should not ship the src/ folder.');
  }
  console.log(
    `Testing packaged bundle: ${bundlePath} (${fs.statSync(bundlePath).size} bytes)`
  );

  try {
    await runTests({
      vscodeExecutablePath,
      extensionDevelopmentPath: packagedExtensionPath,
      extensionTestsPath,
      launchArgs: [
        workspacePath,
        // A separate, empty extensions dir keeps the installed copy from
        // clashing with the same id loaded from the development path.
        '--extensions-dir',
        runExtensionsDir,
        '--user-data-dir',
        runUserDataDir,
        // Matches the source-tree run: only the extension under test is loaded.
        '--disable-extensions',
        '--disable-gpu',
        '--disable-workspace-trust'
      ],
      extensionTestsEnv: { REQRUNNER_TEST_SUMMARY: summaryPath }
    });

    if (!fs.existsSync(summaryPath)) {
      throw new Error('The packaged-extension suite did not run: no summary was written.');
    }
    const summary = JSON.parse(fs.readFileSync(summaryPath, 'utf8')) as {
      total: number;
      passed: number;
      failed: number;
      skippedChecks: string[];
    };
    process.stdout.write(
      `\nPackaged VSIX: ${summary.passed}/${summary.total} passed, ${summary.failed} failed\n`
    );
    for (const reason of summary.skippedChecks) {
      process.stdout.write(`  skipped: ${reason}\n`);
    }
    if (summary.failed > 0 || summary.passed !== summary.total) {
      throw new Error('The packaged extension failed its integration suite.');
    }
  } finally {
    try {
      fs.rmSync(sandbox, { recursive: true, force: true });
    } catch {
      // Locked files on Windows must not fail the run.
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
