import fs from "fs";
import path from "path";
import { parse } from "csv-parse/sync";
import {
  matchProducts,
  normalize365Record,
  normalizeHahaRecord,
  MatchOptions,
  MatchResult,
} from "./matcher";

interface CLIOptions {
  sourceA: string;
  sourceB: string;
  auto?: number;
  review?: number;
  output?: "json" | "table";
}

function parseArgs(argv: string[]): CLIOptions {
  const options: Partial<CLIOptions> = {};
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];

    if (arg.startsWith("--sourceA=")) {
      options.sourceA = arg.split("=")[1];
      continue;
    }
    if (arg === "--sourceA" && next) {
      options.sourceA = next;
      i += 1;
      continue;
    }
    if (arg.startsWith("--sourceB=")) {
      options.sourceB = arg.split("=")[1];
      continue;
    }
    if (arg === "--sourceB" && next) {
      options.sourceB = next;
      i += 1;
      continue;
    }
    if (arg.startsWith("--auto=")) {
      options.auto = Number(arg.split("=")[1]);
      continue;
    }
    if (arg === "--auto" && next) {
      options.auto = Number(next);
      i += 1;
      continue;
    }
    if (arg.startsWith("--review=")) {
      options.review = Number(arg.split("=")[1]);
      continue;
    }
    if (arg === "--review" && next) {
      options.review = Number(next);
      i += 1;
      continue;
    }
    if (arg.startsWith("--output=")) {
      options.output = arg.split("=")[1] as CLIOptions["output"];
      continue;
    }
    if (arg === "--output" && next) {
      options.output = next as CLIOptions["output"];
      i += 1;
    }
  }

  const cwd = process.cwd();
  const projectRoot = path.resolve(__dirname, "..", "..");
  const defaultSourceA = path.resolve(projectRoot, "data/365_sample.csv");
  const defaultSourceB = path.resolve(projectRoot, "data/haha_sample.csv");

  return {
    sourceA: options.sourceA ? path.resolve(cwd, options.sourceA) : defaultSourceA,
    sourceB: options.sourceB ? path.resolve(cwd, options.sourceB) : defaultSourceB,
    auto: options.auto,
    review: options.review,
    output: options.output ?? "json",
  };
}

function readCsv(filePath: string): Record<string, string>[] {
  const csv = fs.readFileSync(filePath, "utf8");
  return parse(csv, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
  });
}

function main() {
  const cliOptions = parseArgs(process.argv);
  const matchOptions: Partial<MatchOptions> = {};
  if (typeof cliOptions.auto === "number" && !Number.isNaN(cliOptions.auto)) {
    matchOptions.autoAcceptThreshold = cliOptions.auto;
  }
  if (typeof cliOptions.review === "number" && !Number.isNaN(cliOptions.review)) {
    matchOptions.reviewThreshold = cliOptions.review;
  }

  const sourceARecords = readCsv(cliOptions.sourceA);
  const sourceBRecords = readCsv(cliOptions.sourceB);

  const normalizedA = sourceARecords.map(normalize365Record);
  const normalizedB = sourceBRecords.map(normalizeHahaRecord);

  const result = matchProducts(normalizedA, normalizedB, matchOptions);

  if (cliOptions.output === "table") {
    renderTable(result);
  } else {
    process.stdout.write(JSON.stringify(result, null, 2));
  }
}

function renderTable(result: MatchResult) {
  console.log("Matched Products:\n");
  for (const match of result.matches) {
    console.log(
      `${match.productA.name} ↔ ${match.productB.name} | confidence=${match.confidence} (${match.decision})`
    );
    console.log(`  brand: ${match.productA.brand ?? "-"} ↔ ${match.productB.brand ?? "-"}`);
    console.log(
      `  size: ${match.productA.sizeLabel ?? match.productA.sizeOz ?? "-"} ↔ ${match.productB.sizeLabel ?? match.productB.sizeOz ?? "-"}`
    );
    console.log(`  features: ${JSON.stringify(match.featureScores)}`);
    console.log("");
  }

  if (result.unmatchedA.length) {
    console.log("Unmatched Source A:\n");
    for (const product of result.unmatchedA) {
      console.log(`  - ${product.name} (${product.sourceId})`);
    }
    console.log("");
  }

  if (result.unmatchedB.length) {
    console.log("Unmatched Source B:\n");
    for (const product of result.unmatchedB) {
      console.log(`  - ${product.name} (${product.sourceId})`);
    }
  }
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error("Failed to run matcher:", error);
    process.exitCode = 1;
  }
}
