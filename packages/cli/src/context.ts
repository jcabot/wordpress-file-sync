import { dirname, resolve } from 'node:path';

export interface GlobalOpts {
  verbose?: boolean;
  quiet?: boolean;
  config?: string;
}

export function resolveRootDir(opts: GlobalOpts): string {
  if (opts.config) {
    return dirname(dirname(resolve(opts.config)));
  }
  return process.cwd();
}
