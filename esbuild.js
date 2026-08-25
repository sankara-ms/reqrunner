// Bundles the extension entry point into dist/extension.js.
// The `vscode` module is provided by the host at runtime, so it is external.
const esbuild = require('esbuild');

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

/** Reports esbuild problems in a format the VS Code problem matcher understands. */
const problemReporterPlugin = {
  name: 'problem-reporter',
  setup(build) {
    build.onStart(() => {
      console.log('[reqrunner] build started');
    });
    build.onEnd((result) => {
      for (const error of result.errors) {
        const loc = error.location;
        console.error(
          `✘ [ERROR] ${error.text}` +
            (loc ? `\n    ${loc.file}:${loc.line}:${loc.column}:` : '')
        );
      }
      console.log(
        `[reqrunner] build finished with ${result.errors.length} error(s), ` +
          `${result.warnings.length} warning(s)`
      );
    });
  }
};

async function main() {
  const context = await esbuild.context({
    entryPoints: ['src/extension.ts'],
    bundle: true,
    format: 'cjs',
    minify: production,
    sourcemap: !production,
    sourcesContent: false,
    platform: 'node',
    target: 'node18',
    outfile: 'dist/extension.js',
    external: ['vscode'],
    logLevel: 'silent',
    plugins: [problemReporterPlugin]
  });

  if (watch) {
    await context.watch();
  } else {
    await context.rebuild();
    await context.dispose();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
