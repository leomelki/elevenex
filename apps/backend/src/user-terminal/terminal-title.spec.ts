import { commandTerminalTitle } from './terminal-title.js';

it.each([
  ['pnpm run dev --token PRIVATE', 'pnpm'],
  [' /usr/local/bin/python3 -m http.server', 'python3'],
  ['C:\\tools\\node.exe app.js', 'node.exe'],
  ['echo one | cat', 'echo'],
  ['ENV=value command', null],
  ['$(dynamic) argument', null],
  ['(grouped command)', null],
  ['"/path with spaces/tool"', null],
  ['🙂tool', null],
  ['', null],
  [null, null],
])('derives only a conservative display name from %s', (command, expected) => {
  expect(commandTerminalTitle(command)).toBe(expected);
});
