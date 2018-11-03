import { Buffer } from 'buffer';
import { spawnSync } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { FixtureResult, IFixtureResultOptions } from './result';

export { FixtureResult, IFixtureResultOptions };

const CLANG = process.env.CLANG || 'clang';
const CFLAGS = process.env.CFLAGS || '';

const NATIVE_DIR = path.join(__dirname, '..', 'src', 'native');
const FIXTURE = path.join(NATIVE_DIR, 'fixture.c');

export interface IFixtureOptions {
  readonly buildDir: string;
  readonly clang?: string;
  readonly extra?: ReadonlyArray<string>;
  readonly maxParallel?: number;
}

export interface IFixtureBuildOptions {
  readonly extra?: ReadonlyArray<string>;
}

export interface IFixtureArtifacts {
  readonly bitcode?: Buffer;
  readonly c?: string;
  readonly header: string;
  readonly llvm?: string;
}

interface IFixtureInternalOptions {
  readonly buildDir: string;
  readonly clang: string;
  readonly extra: ReadonlyArray<string> | undefined;
  readonly maxParallel: number;
}

// Just a random value, really
export const ERROR_PAUSE = 0x7fa73caa;

export class Fixture {
  private readonly options: IFixtureInternalOptions;

  constructor(options: IFixtureOptions) {
    this.options = {
      buildDir: options.buildDir,
      clang: options.clang === undefined ? CLANG : options.clang,
      extra: options.extra,
      maxParallel: options.maxParallel === undefined ?
        os.cpus().length : options.maxParallel,
    };

    try {
      fs.mkdirSync(this.options.buildDir);
    } catch (e) {
      // no-op
    }
  }

  public build(artifacts: IFixtureArtifacts, name: string,
               options: IFixtureBuildOptions = {}): FixtureResult {
    const BUILD_DIR = this.options.buildDir;

    const hash = crypto.createHash('sha256');

    const llvm = path.join(BUILD_DIR, name + '.ll');
    const bitcode = path.join(BUILD_DIR, name + '.bc');
    const c = path.join(BUILD_DIR, name + '.c');
    const header = path.join(BUILD_DIR, name + '.h');

    hash.update('header');
    hash.update(artifacts.header);
    fs.writeFileSync(header, artifacts.header);

    const commonArgs = [
      '-g3', '-Os', '-fvisibility=hidden',
      '-I', NATIVE_DIR,
      '-include', header,
      FIXTURE,
    ];

    // This is rather lame, but should work
    if (CFLAGS) {
      for (const flag of CFLAGS.split(/\s+/g)) {
        commonArgs.push(flag);
      }
    }

    const args = {
      bitcode: [] as string[],
      c: [ '-I', BUILD_DIR ],
    };
    if (artifacts.llvm !== undefined) {
      hash.update('llvm');
      hash.update(artifacts.llvm);
      fs.writeFileSync(llvm, artifacts.llvm);
      args.bitcode.push(llvm);
    } else if (artifacts.bitcode !== undefined) {
      hash.update('bitcode');
      hash.update(artifacts.bitcode);
      fs.writeFileSync(bitcode, artifacts.bitcode);
      args.bitcode.push(bitcode);
    }

    if (artifacts.c !== undefined) {
      hash.update('c');
      hash.update(artifacts.c);
      fs.writeFileSync(c, artifacts.c);
      args.c.push(c);
    }

    if (this.options.extra) {
      for (const extra of this.options.extra) {
        commonArgs.push(extra);
      }
    }
    if (options.extra) {
      for (const extra of options.extra) {
        commonArgs.push(extra);
      }
    }
    hash.update(commonArgs.join(' '));
    const digest = hash.digest('hex');

    const out = path.join(BUILD_DIR, name + '.' + digest);
    const link = path.join(BUILD_DIR, name);

    const executables: string[] = [];

    if (!fs.existsSync(out)) {
      // Compile binary, no cached version available
      this.clang(commonArgs.concat(args.bitcode, '-o', out));
    }
    try {
      fs.unlinkSync(link);
    } catch (e) {
      // no-op
    }
    fs.linkSync(out, link);
    executables.push(link);

    if (artifacts.c !== undefined) {
      const cOut = path.join(BUILD_DIR, name + '-c.' + digest);
      const cLink = path.join(BUILD_DIR, name + '-c');
      if (!fs.existsSync(cOut)) {
        this.clang(commonArgs.concat(args.c, '-o', cOut));
      }
      try {
        fs.unlinkSync(cLink);
      } catch (e) {
        // no-op
      }
      fs.linkSync(cOut, cLink);
      executables.push(cLink);
    }

    return new FixtureResult(executables, this.options.maxParallel);
  }

  private clang(args: ReadonlyArray<string>): void {
    const ret = spawnSync(CLANG, args);
    if (ret.status !== 0) {
      if (ret.stdout) {
        process.stderr.write(ret.stdout);
      }
      if (ret.stderr) {
        process.stderr.write(ret.stderr);
      }
      if (ret.error) {
        throw ret.error;
      }

      const escapedArgs = args.map((arg) => JSON.stringify(arg));
      throw new Error('clang exit code: ' + (ret.status || ret.signal) +
          `\narguments: ${escapedArgs.join(' ')}`);
    }
  }
}
