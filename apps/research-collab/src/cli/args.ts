/**
 * Tiny argv parser for the `harness-research` CLI.
 *
 * Stays under 100 LOC on purpose — anything more elaborate (subcommands,
 * required-flag validation, type coercion) lives in dedicated modules so
 * this stays trivially testable.
 */

import { findBenchmarkQuery } from '../config/benchmark-queries.js';

export interface CliArgs {
  /** The research question. Either supplied positionally or via `--question`. */
  readonly question: string;
  /** When true, skip writing a markdown report next to the JSON. */
  readonly skipMarkdown: boolean;
  /** When true, skip persisting to disk entirely. */
  readonly noReport: boolean;
  /** Override default reports directory. */
  readonly reportsRoot?: string;
  /** Marks the run as originating from a benchmark slug. */
  readonly benchmarkSlug?: string;
  /** Pretty-print the markdown to stdout. */
  readonly print: boolean;
}

export class CliArgError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CliArgError';
  }
}

const HELP = `Usage: harness-research <question> [options]
       harness-research --benchmark <slug> [options]

Options:
  -q, --question <text>     research question (positional argument also works)
  -b, --benchmark <slug>    run a frozen benchmark query (see config/benchmark-queries.ts)
      --reports-root <dir>  override report output directory
      --no-report           skip persisting JSON / markdown
      --no-markdown         skip the sibling markdown file
      --print               write the synthesised markdown to stdout
  -h, --help                print this help text

Environment:
  ANTHROPIC_API_KEY         live mode credential (mock mode used when absent)
  RESEARCH_MOCK=1           force mock adapter even when ANTHROPIC_API_KEY is set
  RESEARCH_MODEL            override default model
  RESEARCH_BUDGET_USD       per-agent USD cap (default 2.0)
  RESEARCH_REPORTS_ROOT     default reports directory
  RESEARCH_SEARCH_PROVIDER  serpapi | brave | fixture (default: fixture in mock mode, serpapi otherwise when SERPAPI_API_KEY is set)
  SERPAPI_API_KEY           credential for the serpapi provider
  BRAVE_SEARCH_API_KEY      credential for the brave provider
`;

export function printHelp(write: (text: string) => void = (s) => process.stdout.write(s)): void {
  write(HELP);
}

export function parseArgs(argv: readonly string[]): CliArgs {
  let question: string | undefined;
  let benchmarkSlug: string | undefined;
  let reportsRoot: string | undefined;
  let noReport = false;
  let skipMarkdown = false;
  let print = false;
  const positional: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) continue;
    switch (arg) {
      case '-h':
      case '--help':
        printHelp();
        throw new CliArgError('__help__');
      case '-q':
      case '--question': {
        const next = argv[++i];
        if (next === undefined) throw new CliArgError(`Missing value for ${arg}`);
        question = next;
        break;
      }
      case '-b':
      case '--benchmark': {
        const next = argv[++i];
        if (next === undefined) throw new CliArgError(`Missing value for ${arg}`);
        benchmarkSlug = next;
        break;
      }
      case '--reports-root': {
        const next = argv[++i];
        if (next === undefined) throw new CliArgError(`Missing value for ${arg}`);
        reportsRoot = next;
        break;
      }
      case '--no-report':
        noReport = true;
        break;
      case '--no-markdown':
        skipMarkdown = true;
        break;
      case '--print':
        print = true;
        break;
      default:
        if (arg.startsWith('-')) throw new CliArgError(`Unknown flag: ${arg}`);
        positional.push(arg);
        break;
    }
  }

  if (benchmarkSlug !== undefined) {
    const entry = findBenchmarkQuery(benchmarkSlug);
    if (!entry) throw new CliArgError(`Unknown benchmark slug: ${benchmarkSlug}`);
    if (question === undefined && positional.length === 0) {
      question = entry.question;
    }
  }
  if (question === undefined) {
    if (positional.length === 0) {
      throw new CliArgError('A research question is required (positional or via --question / --benchmark).');
    }
    question = positional.join(' ');
  } else if (positional.length > 0) {
    // Positional + --question is ambiguous — accept --question as the source of truth.
    // Tests assert this explicitly so we don't silently lose user intent.
  }

  return {
    question,
    skipMarkdown,
    noReport,
    print,
    ...(reportsRoot !== undefined && { reportsRoot }),
    ...(benchmarkSlug !== undefined && { benchmarkSlug }),
  };
}
