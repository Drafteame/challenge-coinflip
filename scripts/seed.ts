import { candidateSeed } from '../src/prng.ts';

function main(): void {
  const argv = process.argv.slice(2);
  let name: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--candidate') {
      i += 1;
      name = argv[i];
    }
  }
  if (name === undefined || name === '') {
    console.error('usage: npm run seed -- --candidate <name>');
    process.exit(1);
  }
  console.log(candidateSeed(name, new Date()));
}

main();