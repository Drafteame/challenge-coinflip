import { parseArgs, loadFixture } from './config.ts';
import { startServer } from './server.ts';

function main(): void {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error('error: ' + (err instanceof Error ? err.message : String(err)));
    process.exit(1);
  }
  let fixture;
  try {
    fixture = args.fixture !== undefined ? loadFixture(args.fixture) : loadFixture('fixtures/default.json');
  } catch (err) {
    console.error('error: ' + (err instanceof Error ? err.message : String(err)));
    process.exit(1);
  }
  const seed = args.seed ?? fixture.seed;
  const rawPort = process.env['PORT'] ?? '8080';
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    console.error('error: invalid PORT ' + rawPort);
    process.exit(1);
  }
  startServer({ fixture, seed, faults: args.faults, port }).then((srv) => {
    console.log('coin-flip mock server listening');
    console.log('  url:     ' + srv.url());
    console.log('  seed:    ' + seed);
    console.log('  faults:  ' + (args.faults ? 'on' : 'off'));
  }).catch((err) => {
    console.error('error: failed to start server: ' + (err instanceof Error ? err.message : String(err)));
    process.exit(1);
  });
}

main();
