import { runRemoveCommand } from './gwrRemoveCommand.js';

export async function main(argv, io) {
  if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h') {
    io.stdout.write('Usage: gwr remove <input> [--output <file> | --out-dir <dir>] [--overwrite] [--json] [--video-page <url-or-file>] [--video-timeout-ms <ms>] [--video-bitrate-mbps <Mbps>]\n');
    return 0;
  }

  const [command, ...rest] = argv;

  if (command !== 'remove') {
    io.stderr.write(`Unknown command: ${command}\n`);
    return 2;
  }

  return runRemoveCommand(rest, io);
}
