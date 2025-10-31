# VendHub Product Normalization Assessment

## Overview

This assessment delivers two artifacts:

- `design/normalization-system.md` — a technical design describing end-to-end ingestion, normalization, matching, data modeling, and operator UX.
- `prototype/` — a Node.js/TypeScript proof-of-concept CLI that ingests two CSV exports and produces product match candidates with confidence scores.

The prototype demonstrates how deterministic feature engineering and weighted similarity scoring can automate the majority of product matches while routing low-confidence cases for human review.

## Repository Layout

```
assessment/
├── README.md
├── data/
│   ├── 365_sample.csv
│   └── haha_sample.csv
├── design/
│   └── normalization-system.md
└── prototype/
    ├── package.json
    ├── tsconfig.json
    └── src/
        ├── index.ts
        └── matcher.ts
```

## Prerequisites

- Node.js 18+
- npm 9+

Install dependencies once before running the CLI:

```
cd assessment/prototype
npm install
```

## Running the Matching Prototype

The CLI reads two CSV files (defaults provided) and prints matches, confidence scores, and unmatched products.

```
cd assessment/prototype
npm start -- --output table
```

Key flags:

- `--sourceA <path>` — path to the 365 Retail System CSV (defaults to `../data/365_sample.csv`).
- `--sourceB <path>` — path to the HAHA Vending CSV (defaults to `../data/haha_sample.csv`).
- `--output <json|table>` — choose between JSON output (default) and a human-readable table.
- `--auto <number>` — override the auto-accept confidence threshold (default `0.82`).
- `--review <number>` — override the manual-review floor (default `0.6`).
- `DEBUG_MATCHES=1 DEBUG_MATCH_IDS=<id1,id2>` — optional env vars to trace feature scores for specific source product IDs.

Example JSON invocation:

```
npm start -- --output json
```

## Matching Approach

1. **Normalization & Feature Extraction**
   - Standardize casing, punctuation, and measurement units.
   - Tokenize names with synonym handling (e.g., `coke` → `coca cola`).
   - Detect brands via synonym dictionary and substring lookup.
   - Parse package sizes, diet keywords, categories, and numeric price.
   - Identify likely UPCs (12–14 digit numeric codes) for exact-match detection.

2. **Candidate Scoring**
   - Name similarity uses both token Jaccard and character bigram Dice coefficient.
   - Brand, size, category, and price similarities contribute weighted scores.
   - UPC matches override with high confidence; mismatched UPCs are ignored when identifiers are non-UPC (e.g., `PRD001`).
   - Diet flag mismatches introduce a small penalty.
   - Weights renormalize when certain attributes are unavailable (e.g., missing size) to avoid unfairly low scores.

3. **Confidence Classification**
   - `confidence ≥ 0.82` → automatic match.
   - `0.6 ≤ confidence < 0.82` → manual review queue with feature breakdown for explainability.
   - `< 0.6` → remains unmatched (potential new canonical product).

4. **Outputs**
   - `matches` include summarized product metadata, final confidence, decision (`auto` / `review`), and feature-level scores.
   - Unmatched lists identify remaining products to surface in the operator workflow.

## Handling Edge Cases

- **UPC Heuristics**: Only treat identifiers that resemble UPC/EAN codes as true UPCs; system-specific IDs (e.g., `PRD001`) are ignored in scoring.
- **Incomplete Attributes**: Confidence weights normalize across available signals, allowing strong matches even when size or category data is missing.
- **Synonyms & Variants**: Brand dictionary and token canonicalization capture abbreviations (`Coke`, `RedBull`, etc.). The design doc proposes extending this via operator-maintained synonym tables.
- **New Products**: Items with no confident partner remain in the unmatched list; pipeline would trigger canonical product creation once volume thresholds are met.

## Assumptions & Open Questions

- CSV schemas follow the provided samples; additional columns are ignored but preserved in raw metadata for extensibility.
- Product identifiers from HAHA (`product_no`) are not UPCs; confirmation from stakeholders would allow stronger exact matches.
- Size parsing currently covers fluid ounces, ml, grams; more unit variants (e.g., packs) would need additional rules.
- Confidence thresholds (`0.82` / `0.6`) are heuristic starting points; production deployment should calibrate using labeled historical decisions.
- Operator experience and analytics requirements in the design doc assume Supabase Row Level Security; confirm multi-tenant access constraints.

## Next Steps (Beyond Prototype)

- Incorporate pgvector or embedding-based similarity to capture richer semantic matches once labeled data accrues.
- Persist confirmed matches and overrides to continuously retrain weights / synonym tables.
- Build the Next.js App Router UI described in the design doc, including review queues, catalog management, and analytics.
- Expand ingestion adapters for additional vending systems and automate sync scheduling.

## Contact

Questions or feedback: josh@modern-amenities.com
