import path from "path";

export interface NormalizedProduct {
  source: "365" | "haha";
  sourceId: string;
  rawName: string;
  normalizedName: string;
  tokens: string[];
  brand?: string;
  sizeOz?: number;
  sizeLabel?: string;
  price?: number;
  category?: string;
  isDiet: boolean;
  scancode?: string;
  features: Record<string, unknown>;
  raw: Record<string, string>;
}

export interface FeatureScores {
  upc: number;
  name: number;
  brand: number;
  size: number;
  category: number;
  price: number;
  dietPenalty: number;
}

export interface MatchRecord {
  productA: ProductSummary;
  productB: ProductSummary;
  confidence: number;
  decision: "auto" | "review";
  featureScores: FeatureScores;
}

export interface MatchResult {
  matches: MatchRecord[];
  unmatchedA: ProductSummary[];
  unmatchedB: ProductSummary[];
}

export interface MatchOptions {
  autoAcceptThreshold: number;
  reviewThreshold: number;
}

export interface ProductSummary {
  source: NormalizedProduct["source"];
  sourceId: string;
  name: string;
  brand?: string;
  sizeOz?: number;
  sizeLabel?: string;
  price?: number;
  category?: string;
  scancode?: string;
  extra?: Record<string, unknown>;
}

const BRAND_SYNONYMS: Record<string, string> = {
  "coke": "coca cola",
  "coca-cola": "coca cola",
  "coca": "coca cola",
  "coca cola": "coca cola",
  "diet coke": "diet coca cola",
  "coca-cola diet": "diet coca cola",
  "diet coca cola": "diet coca cola",
  "coca cola diet": "diet coca cola",
  "pepsi cola": "pepsi",
  "pepsi-cola": "pepsi",
  "redbull": "red bull",
  "redbull energy": "red bull",
  "redbull energy drink": "red bull",
  "red bull": "red bull",
  "snickers": "snickers",
  "lays": "lays",
  "doritos": "doritos",
  "aquafina": "aquafina",
  "dasani": "dasani",
};

const STOP_WORDS = new Set([
  "the",
  "and",
  "with",
  "regular",
  "classic",
  "bottle",
  "can",
  "drink",
  "bar",
  "chips",
  "original",
]);

const DIET_KEYWORDS = ["diet", "zero", "sugar-free", "sugarfree", "lite"];

const UNIT_TOKENS = new Set(["oz", "ounce", "ounces", "ml", "g", "lb", "lbs"]);

const DEFAULT_OPTIONS: MatchOptions = {
  autoAcceptThreshold: 0.82,
  reviewThreshold: 0.6,
};

export function normalize365Record(row: Record<string, string>): NormalizedProduct {
  const rawName = row["PRDNAME"]?.trim() ?? "";
  const normalized = normalizeName(rawName);
  const tokens = tokenize(normalized);
  const brand = canonicalizeBrand(extractBrand(rawName));
  const size = parseSize(rawName);
  const category = row["CATEGORY2"]?.trim() || row["CATEGORY1"]?.trim() || undefined;
  const price = parseNumber(row["PRICE"] ?? row["TOTALPRICE"]);
  const isDiet = detectDiet(rawName);
  const scancode = row["SCANCODE"]?.trim() || undefined;

  return {
    source: "365",
    sourceId: row["SCANCODE"]?.trim() || row["PRDNAME"] || path.basename(row["DEVICE"] ?? ""),
    rawName,
    normalizedName: normalized,
    tokens,
    brand,
    sizeOz: size?.sizeOz,
    sizeLabel: size?.label,
    price,
    category,
    isDiet,
    scancode,
    features: {
      sizeMatchText: size?.match ?? null,
    },
    raw: row,
  };
}

export function normalizeHahaRecord(row: Record<string, string>): NormalizedProduct {
  const rawName = row["product_name"]?.trim() ?? "";
  const normalized = normalizeName(rawName);
  const tokens = tokenize(normalized);
  const brand = canonicalizeBrand(extractBrand(rawName));
  const size = parseSize(rawName);
  const category = undefined;
  const price = parseNumber(row["price_unit"] ?? row["product_actual_payment_amount"]);
  const isDiet = detectDiet(rawName);
  const scancode = row["product_no"]?.trim() || undefined;

  return {
    source: "haha",
    sourceId: row["product_no"]?.trim() || row["id"] || rawName,
    rawName,
    normalizedName: normalized,
    tokens,
    brand,
    sizeOz: size?.sizeOz,
    sizeLabel: size?.label,
    price,
    category,
    isDiet,
    scancode,
    features: {
      sizeMatchText: size?.match ?? null,
    },
    raw: row,
  };
}

export function matchProducts(
  productsA: NormalizedProduct[],
  productsB: NormalizedProduct[],
  options: Partial<MatchOptions> = {}
): MatchResult {
  const resolvedOptions = { ...DEFAULT_OPTIONS, ...options };
  if (resolvedOptions.reviewThreshold > resolvedOptions.autoAcceptThreshold) {
    throw new Error("reviewThreshold must be <= autoAcceptThreshold");
  }

  const matches: MatchRecord[] = [];
  const unmatchedA: ProductSummary[] = [];
  const matchedBIds = new Set<string>();
  const debugEnabled = process.env.DEBUG_MATCHES === "1";
  const debugSet = debugEnabled
    ? new Set(
        (process.env.DEBUG_MATCH_IDS ?? "")
          .split(",")
          .map((value) => value.trim())
          .filter(Boolean)
      )
    : null;

  for (const productA of productsA) {
    let bestMatch: { product: NormalizedProduct; confidence: number; scores: FeatureScores } | null = null;

    for (const productB of productsB) {
      const scores = computeFeatureScores(productA, productB);
      const confidence = computeConfidence(scores, productA, productB);
      if (confidence < resolvedOptions.reviewThreshold * 0.65) {
        // Fast skip for obviously low scores.
        continue;
      }

      if (debugEnabled && debugSet?.has(productA.sourceId)) {
        // eslint-disable-next-line no-console
        console.log("DEBUG", productA.rawName, "↔", productB.rawName, scores, confidence);
      }

      if (!bestMatch || confidence > bestMatch.confidence) {
        bestMatch = { product: productB, confidence, scores };
      }
    }

    if (!bestMatch || bestMatch.confidence < resolvedOptions.reviewThreshold) {
      unmatchedA.push(summarizeProduct(productA));
      continue;
    }

    const decision: "auto" | "review" =
      bestMatch.confidence >= resolvedOptions.autoAcceptThreshold ? "auto" : "review";

    matches.push({
      productA: summarizeProduct(productA),
      productB: summarizeProduct(bestMatch.product),
      confidence: round(bestMatch.confidence),
      decision,
      featureScores: mapScores(bestMatch.scores),
    });

    matchedBIds.add(bestMatch.product.sourceId);
  }

  const unmatchedB = productsB
    .filter((product) => !matchedBIds.has(product.sourceId))
    .map((product) => summarizeProduct(product));

  return { matches, unmatchedA, unmatchedB };
}

function computeFeatureScores(a: NormalizedProduct, b: NormalizedProduct): FeatureScores {
  const upc = scoreUPC(a, b);
  const name = scoreNameSimilarity(a, b);
  const brand = scoreBrand(a.brand, b.brand);
  const size = scoreSize(a.sizeOz, b.sizeOz);
  const category = scoreCategory(a.category, b.category);
  const price = scoreNumericSimilarity(a.price, b.price, 0.25);
  const dietPenalty = scoreDietPenalty(a.isDiet, b.isDiet);

  return { upc, name, brand, size, category, price, dietPenalty };
}

function computeConfidence(
  scores: FeatureScores,
  productA: NormalizedProduct,
  productB: NormalizedProduct
): number {
  const components = [
    {
      score: scores.upc,
      weight: 0.25,
      available: isLikelyUPC(productA.scancode) && isLikelyUPC(productB.scancode),
    },
    { score: scores.name, weight: 0.25, available: true },
    { score: scores.brand, weight: 0.2, available: Boolean(productA.brand && productB.brand) },
    { score: scores.size, weight: 0.2, available: Boolean(productA.sizeOz && productB.sizeOz) },
    { score: scores.category, weight: 0.05, available: Boolean(productA.category && productB.category) },
    { score: scores.price, weight: 0.05, available: typeof productA.price === "number" && typeof productB.price === "number" },
  ];

  const weightSum = components.reduce((sum, component) => (component.available ? sum + component.weight : sum), 0);
  if (weightSum === 0) {
    return 0;
  }

  const weightedScore = components.reduce((sum, component) => {
    if (!component.available) {
      return sum;
    }
    return sum + component.score * component.weight;
  }, 0);

  const normalizedScore = weightedScore / weightSum;
  const penalty = scores.dietPenalty * 0.05;
  return clamp(normalizedScore - penalty, 0, 1);
}

function scoreUPC(a: NormalizedProduct, b: NormalizedProduct): number {
  if (!a.scancode || !b.scancode) {
    return 0;
  }
  return a.scancode === b.scancode ? 1 : 0;
}

function scoreNameSimilarity(a: NormalizedProduct, b: NormalizedProduct): number {
  const tokenScore = scoreNameTokens(a.tokens, b.tokens);
  const bigramScore = scoreCharacterBigram(a.normalizedName, b.normalizedName);
  return Math.max(tokenScore, bigramScore);
}

function scoreNameTokens(tokensA: string[], tokensB: string[]): number {
  if (!tokensA.length || !tokensB.length) return 0;
  const setA = new Set(tokensA);
  const setB = new Set(tokensB);
  const intersectionSize = tokensA.filter((token) => setB.has(token)).length;
  const unionSize = new Set([...tokensA, ...tokensB]).size;
  if (unionSize === 0) return 0;
  return intersectionSize / unionSize;
}

function scoreCharacterBigram(a: string, b: string): number {
  const gramsA = buildBigrams(a);
  const gramsB = buildBigrams(b);
  if (!gramsA.length || !gramsB.length) return 0;

  const countsA = countOccurrences(gramsA);
  const countsB = countOccurrences(gramsB);

  let intersection = 0;
  for (const [gram, countA] of countsA.entries()) {
    const countB = countsB.get(gram);
    if (countB) {
      intersection += Math.min(countA, countB);
    }
  }

  return (2 * intersection) / (gramsA.length + gramsB.length);
}

function scoreBrand(brandA?: string, brandB?: string): number {
  if (!brandA && !brandB) return 0;
  if (!brandA || !brandB) return 0.2;
  if (brandA === brandB) return 1;
  const canonicalA = canonicalizeBrand(brandA);
  const canonicalB = canonicalizeBrand(brandB);
  if (canonicalA === canonicalB) return 0.7;
  return 0;
}

function scoreSize(sizeA?: number, sizeB?: number): number {
  if (!sizeA || !sizeB) return 0;
  const diff = Math.abs(sizeA - sizeB);
  const max = Math.max(sizeA, sizeB);
  const normalizedDiff = diff / max;
  const score = Math.max(0, 1 - normalizedDiff * 1.5);
  return clamp(score, 0, 1);
}

function scoreCategory(categoryA?: string, categoryB?: string): number {
  if (!categoryA && !categoryB) return 0;
  if (!categoryA || !categoryB) return 0.2;
  const normalizedA = canonicalizeCategory(categoryA);
  const normalizedB = canonicalizeCategory(categoryB);
  if (normalizedA === normalizedB) return 1;
  if (normalizedA && normalizedB && normalizedA.split(" ")[0] === normalizedB.split(" ")[0]) {
    return 0.6;
  }
  return 0;
}

function scoreNumericSimilarity(a?: number, b?: number, tolerance = 0.2): number {
  if (a === undefined || b === undefined) return 0;
  if (a === 0 && b === 0) return 1;
  if (a === 0 || b === 0) return 0;
  const diff = Math.abs(a - b);
  const avg = (a + b) / 2;
  if (avg === 0) return 0;
  const ratio = diff / avg;
  if (ratio <= tolerance) {
    return 1 - ratio / tolerance;
  }
  return 0;
}

function scoreDietPenalty(aIsDiet: boolean, bIsDiet: boolean): number {
  return aIsDiet === bIsDiet ? 0 : 1;
}

function summarizeProduct(product: NormalizedProduct): ProductSummary {
  return {
    source: product.source,
    sourceId: product.sourceId,
    name: product.rawName,
    brand: product.brand,
    sizeOz: product.sizeOz,
    sizeLabel: product.sizeLabel,
    price: product.price,
    category: product.category,
    scancode: product.scancode,
    extra: product.features,
  };
}

function mapScores(scores: FeatureScores): FeatureScores {
  return {
    upc: round(scores.upc),
    name: round(scores.name),
    brand: round(scores.brand),
    size: round(scores.size),
    category: round(scores.category),
    price: round(scores.price),
    dietPenalty: round(scores.dietPenalty),
  };
}

function normalizeName(value: string): string {
  const lower = value.toLowerCase();
  const replaced = lower
    .replace(/fl\.?\s*oz/g, "oz")
    .replace(/ounces?/g, "oz")
    .replace(/oz\./g, "oz")
    .replace(/-/g, " ")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return replaced;
}

function tokenize(value: string): string[] {
  if (!value) return [];
  const rawTokens = value
    .split(" ")
    .map((token) => token.trim())
    .filter((token) => Boolean(token));

  const merged: string[] = [];
  for (let i = 0; i < rawTokens.length; i += 1) {
    const token = rawTokens[i];
    const next = rawTokens[i + 1];
    if (/^\d+(?:\.\d+)?$/.test(token) && next && UNIT_TOKENS.has(next)) {
      merged.push(`${token}${next}`);
      i += 1;
      continue;
    }
    merged.push(token);
  }

  return merged
    .filter((token) => token && !STOP_WORDS.has(token))
    .map((token) => canonicalizeToken(token));
}

function canonicalizeToken(token: string): string {
  if (BRAND_SYNONYMS[token]) {
    return BRAND_SYNONYMS[token];
  }
  return token;
}

function canonicalizeBrand(brand?: string): string | undefined {
  if (!brand) return undefined;
  const lower = brand.toLowerCase().trim();
  if (BRAND_SYNONYMS[lower]) {
    return BRAND_SYNONYMS[lower];
  }
  return lower;
}

function extractBrand(rawName: string): string | undefined {
  const normalized = rawName.toLowerCase();
  const synonymKeys = Object.keys(BRAND_SYNONYMS).sort((a, b) => b.length - a.length);
  for (const key of synonymKeys) {
    if (normalized.includes(key)) {
      return BRAND_SYNONYMS[key];
    }
  }

  const tokens = normalized.split(/[\s,]+/).filter(Boolean);
  if (!tokens.length) return undefined;

  for (const token of tokens) {
    const canonical = canonicalizeBrand(token);
    if (canonical) {
      return canonical;
    }
  }
  return tokens[0];
}

function parseSize(rawName: string): { sizeOz?: number; label?: string; match?: string } | undefined {
  const sizeRegex = /(\d+(?:\.\d+)?)\s*(fl\s*oz|oz|ounce|oz\.|ml|g)/i;
  const match = rawName.match(sizeRegex);
  if (!match) return undefined;
  const value = parseFloat(match[1]);
  const unit = match[2].toLowerCase();
  let sizeOz: number | undefined;
  if (unit.includes("ml")) {
    sizeOz = value * 0.033814;
  } else if (unit.includes("g")) {
    // Heuristic: approximate grams to ounces using 28.3495 g per oz.
    sizeOz = value / 28.3495;
  } else {
    sizeOz = value;
  }
  return {
    sizeOz,
    label: `${value}${unit.replace(/\s+/g, "")}`,
    match: match[0],
  };
}

function canonicalizeCategory(value?: string): string | undefined {
  if (!value) return undefined;
  const normalized = value.toLowerCase();
  if (normalized.includes("soda") || normalized.includes("cola")) return "beverage soda";
  if (normalized.includes("water")) return "beverage water";
  if (normalized.includes("energy")) return "beverage energy";
  if (normalized.includes("chips")) return "snack chips";
  if (normalized.includes("candy") || normalized.includes("chocolate")) return "snack candy";
  return normalized;
}

function detectDiet(rawName: string): boolean {
  const lower = rawName.toLowerCase();
  return DIET_KEYWORDS.some((keyword) => lower.includes(keyword));
}

function parseNumber(value?: string): number | undefined {
  if (!value) return undefined;
  const sanitized = value.replace(/[^0-9.\-]/g, "");
  const parsed = Number.parseFloat(sanitized);
  return Number.isNaN(parsed) ? undefined : parsed;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function round(value: number, decimals = 2): number {
  const factor = Math.pow(10, decimals);
  return Math.round(value * factor) / factor;
}

function buildBigrams(value: string): string[] {
  const sanitized = value.replace(/\s+/g, " ").trim();
  if (sanitized.length < 2) return [];
  const grams: string[] = [];
  for (let i = 0; i < sanitized.length - 1; i += 1) {
    grams.push(sanitized.slice(i, i + 2));
  }
  return grams;
}

function countOccurrences(values: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const value of values) {
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return counts;
}

function isLikelyUPC(value?: string): boolean {
  if (!value) return false;
  return /^\d{8,14}$/.test(value);
}
