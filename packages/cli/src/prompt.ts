import { stdin, stdout } from 'node:process';
import { createInterface } from 'node:readline/promises';

export async function prompt(question: string): Promise<string> {
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}

export async function promptHidden(question: string): Promise<string> {
  if (!stdin.isTTY) {
    return prompt(question);
  }
  stdout.write(question);
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding('utf8');

  return new Promise((resolve, reject) => {
    let buf = '';
    const onData = (data: string): void => {
      for (const ch of data) {
        if (ch === '\r' || ch === '\n') {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.removeListener('data', onData);
          stdout.write('\n');
          resolve(buf);
          return;
        }
        if (ch === '') {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.removeListener('data', onData);
          reject(new Error('cancelled'));
          return;
        }
        if (ch === '' || ch === '\b') {
          if (buf.length > 0) buf = buf.slice(0, -1);
          continue;
        }
        buf += ch;
      }
    };
    stdin.on('data', onData);
  });
}
