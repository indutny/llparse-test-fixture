import * as assert from 'assert';
import { Buffer } from 'buffer';
import { spawn } from 'child_process';

export type FixtureExpected = string | RegExp | ReadonlyArray<string | RegExp>;

interface IRange {
  readonly from: number;
  readonly to: number;
}

export class FixtureResult {
  constructor(private readonly executable: string,
              private readonly maxParallel: number) {
  }

  public async check(input: string, expected: FixtureExpected): Promise<void> {
    const ranges: IRange[] = [];
    const maxParallel = this.maxParallel;

    const rawLength = Buffer.byteLength(input);
    const len = Math.ceil(rawLength / maxParallel);
    for (let i = 1; i <= rawLength; i += len) {
      ranges.push({
        from: i,
        to: Math.min(i + len, rawLength + 1),
      });
    }

    const results: ReadonlyArray<string>[] =
      await Promise.all(ranges.map((range) => this.spawn(range, input)));

    let all: string[] = [];
    results.forEach(result => all = all.concat(result));

    all.forEach((output, index) => {
      this.checkScan(index + 1, output, expected);
    });
  }

  private async spawn(range: IRange, input: string)
    : Promise<ReadonlyArray<string> > {
    const proc = spawn(this.executable, [
      `${range.from}:${range.to}`,
      input,
    ], {
      stdio: [ null, 'pipe', 'inherit' ]
    });

    let stdout = '';
    proc.stdout.on('data', chunk => stdout += chunk);

    const { code, signal } = await (new Promise((resolve) => {
      proc.once('exit', (code, signal) => resolve({ code, signal }));
    }) as Promise<{ code: number, signal: string }>);

    await new Promise((resolve) => proc.stdout.once('end', () => resolve()));

    if (signal) {
      throw new Error(`Test killed with signal: "${signal}"`);
    }

    if (code !== 0) {
      throw new Error(`Test exited with code: "${code}"`);
    }

    const out = stdout.split(/===== SCAN \d+ START =====\n/g).slice(1);
    return out.map((part) => this.normalizeSpans(part));
  }

  private checkScan(scan: number, actual: string, expected: FixtureExpected)
    :void {
    if (typeof expected === 'string') {
      assert.strictEqual(actual, expected, `Scan value: ${scan}`);
      return;
    }

    if (expected instanceof RegExp) {
      expected.lastIndex = 0;
      assert.ok(expected.test(actual),
        `Scan value: ${scan} \n` +
        `  got     : ${JSON.stringify(actual)}\n` +
        `  against : ${expected}`);
      return;
    }

    assert(
      Array.isArray(expected) &&
        expected.every((line) => {
          return typeof line === 'string' || line instanceof RegExp;
        }),
      '`expected` must be a string, RegExp, or Array[String|RegExp]');

    const lines = actual.split('\n');
    while (lines.length && lines[lines.length - 1]) {
      lines.pop();
    }

    // If they differ - we are going to fail
    while (lines.length < expected.length) {
      lines.push('');
    }

    // Just make it fail, there shouldn't be extra lines
    let expectedArr = (expected as ReadonlyArray<string | RegExp>).slice();
    while (expectedArr.length < lines.length) {
      expectedArr.push(/$^/);
    }

    lines.forEach((line, lineNum) => {
      const expectedLine = expectedArr[lineNum];

      if (typeof expectedLine === 'string') {
        assert.strictEqual(line, expectedLine,
          `Scan value: ${scan} at line: ${lineNum + 1}\n` +
          `  output  : ${lines.join('\n')}`);
        return;
      }

      expectedLine.lastIndex = 0;
      assert.ok(expectedLine.test(line),
        `Scan value: ${scan} at line: ${lineNum + 1}\n` +
        `  got     : ${JSON.stringify(line)}\n` +
        `  against : ${expectedLine}\n` +
        `  output  : ${lines.join('\n')}`);
    });
  }

  private normalizeSpans(source: string): string {
    const lines = source.split(/\n/g);

    type NormalizeItem = { type: 'raw', value: string } |
      { type: 'span', off: number, len: number, span: string, value: string };
    const parse = (line: string): NormalizeItem => {
      const match = line.match(
        /^off=(\d+)\s+len=(\d+)\s+span\[([^\]]+)\]="(.*)"$/);
      if (!match) {
        return { type: 'raw', value: line };
      }

      return {
        type: 'span',
        off: parseInt(match[1], 10),
        len: parseInt(match[2], 10),
        span: match[3],
        value: match[4]
      };
    };

    const parsed = lines.filter(l => l).map(parse);
    const lastMap = new Map();
    const res: NormalizeItem[] = [];

    parsed.forEach((obj) => {
      if (obj.type === 'raw') {
        res.push(obj);
        return;
      }

      if (lastMap.has(obj.span)) {
        const last = lastMap.get(obj.span);
        if (last.off + last.len === obj.off) {
          last.len += obj.len;
          last.value += obj.value;

          // Move it to the end
          res.splice(res.indexOf(last), 1);
          res.push(last);
          return;
        }
      }
      res.push(obj);
      lastMap.set(obj.span, obj);
    });

    const stringify = (obj: NormalizeItem): string => {
      if (obj.type === 'raw') {
        return obj.value;
      }

      return `off=${obj.off} len=${obj.len} span[${obj.span}]="${obj.value}"`;
    };
    return res.map(stringify).join('\n') + '\n';
  }
}