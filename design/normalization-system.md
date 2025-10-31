# VendHub Product Normalization System Design

## 1. High-Level Architecture

```
┌─────────────────┐
│ CSV Upload UI   │
│ / API Polling   │
└────────┬────────┘
         │
         ▼
┌─────────────────────────────────────────────────────────────┐
│  Source Adapters (365, HAHA, etc.)                          │
└────────┬────────────────────────────────────────────────────┘
         │
         ▼
┌─────────────────────────────────────────────────────────────┐
│  Raw Staging Tables (stg_transactions, stg_products)        │
└────────┬────────────────────────────────────────────────────┘
         │
         ▼
┌─────────────────────────────────────────────────────────────┐
│  Feature Normalizer                                          │
│  • Text cleaning  • Brand extraction  • Size parsing         │
│  • Tokenization   • Category mapping  • Diet detection       │
└────────┬────────────────────────────────────────────────────┘
         │
         ▼
┌─────────────────────────────────────────────────────────────┐
│  Matching Engine                                             │
│  • Blocking (UPC, brand, size)                               │
│  • Similarity scoring (name, brand, size, category, price)   │
│  • Confidence calculation                                    │
└────────┬──────────────────────────┬─────────────────────────┘
         │                          │
    ≥0.82│                  0.6-0.82│                    <0.6
         │                          │                       │
         ▼                          ▼                       ▼
   ┌──────────┐           ┌───────────────┐        ┌──────────────┐
   │ Auto     │           │ Review Queue  │        │  Unmatched   │
   │ Accept   │           │ (Operator)    │        │  Products    │
   └────┬─────┘           └───────┬───────┘        └──────┬───────┘
        │                         │                       │
        └─────────────┬───────────┘                       │
                      ▼                                   │
            ┌──────────────────┐                          │
            │ Match Store      │                          │
            │ (canonical links)│◄─────────────────────────┘
            └────────┬─────────┘
                     │
                     ▼
         ┌──────────────────────────────┐
         │ Analytics Materializations    │
         │ (unified sales by product)    │
         └──────────────────────────────┘
```

### Core Components

1. **Source Ingestion Layer**

   - CSV upload UI / scheduled integrations per vendor system.
   - Source-specific parsers normalize column names into a common staging schema (`stg_transactions`, `stg_products`).

2. **Feature Normalizer**

   - Deterministic text cleaning (case folding, punctuation stripping, unit normalization), tokenization, brand extraction, size parsing.
   - Produces structured attributes (brand, size_oz_ml, product_type, is_diet) stored in `normalized_products`.

3. **Matching Engine**

   - Runs as a Supabase Edge Function or Vercel Job triggered on new normalized products.
   - Computes candidate pairs using blocking (e.g., shared brand tokens) then scoring via weighted similarity metrics.

4. **Match Store & Decision Service**

   - Supabase tables capture canonical products, source product aliases, match decisions, and audit history.
   - Confidence thresholds route matches automatically vs. queue for review.

5. **Operator Review Experience**

   - Next.js dashboard surfaces pending matches, allows confirm/override, bulk operations, and search.
   - Decisions feed back into match store and retrain heuristic weights over time (optional).

6. **Analytics Layer**
   - Materialized views or Supabase Functions aggregate transactions by canonical product for reporting APIs.

## 2. Technology Stack

- **Backend**: Next.js 14 App Router API routes + Supabase Edge Functions
- **Database**: PostgreSQL (via Supabase) with `tsvector` for full-text search, optional `pgvector` for embeddings
- **Storage**: Supabase Storage for CSV uploads
- **Hosting**: Vercel (Next.js frontend + serverless functions)
- **Background Jobs**: Vercel Cron or Supabase pg_cron for scheduled ingestion
- **Client Libraries**: TypeScript, csv-parse, string similarity utilities

## 3. Data Flow Lifecycle

1. **Ingestion**: Operators upload CSVs (or background integrators poll APIs). Files stored in Supabase Storage, metadata recorded in `ingestion_jobs`.
2. **Parsing & Staging**: Background job reads file, maps fields into `stg_transactions` & `stg_products` with source metadata (operator, machine, timestamp).
3. **Normalization**: For each `stg_product`, run normalization function producing `normalized_products` rows with cleaned name & structured attributes.
4. **Candidate Generation**: Matching engine selects unseen normalized products and finds plausible canonical matches using blocking strategies (brand + size buckets, fuzzy name similarity, UPC if available).
5. **Scoring & Decision**:
   - Calculate composite confidence score (0–1) based on weighted features.
   - If score ≥ `AUTO_ACCEPT_THRESHOLD` (e.g., 0.82) → auto-link to canonical product.
   - If between thresholds → create `match_review_tasks` for operator validation.
   - If < `REJECT_THRESHOLD` → mark as unmatched; optionally seed new canonical product.
6. **Operator Review**: Operators resolve tasks. Confirmations create `match_decisions` entries and update canonical mapping; rejections create exclusions.
7. **Analytics Update**: Once linked, transactions join canonical products for unified reporting materialized view consumed by dashboards.

## 4. Matching & Normalization Strategy

### 4.1 Feature Extraction

- **Primary name tokens**: lowercase, remove punctuation, expand abbreviations ("oz"→"ounce").
- **Brand detection**: dictionary of known brands + heuristics (first token) backed by operator-specific overrides.
- **Size parsing**: regex for volume/weight units, convert to standardized metrics (fluid ounces / grams).
- **Diet/Zero/Sugar-Free flags**: detect keywords.
- **Category hints**: leverage `CATEGORY` columns where available.
- **UPC / Scan Codes**: highest-confidence exact match when both sides present.

### 4.2 Candidate Blocking

- UPC/jan codes exact match when available.
- Otherwise, filter to rows sharing at least one of: same brand, same normalized size (±5%), or high Jaccard token similarity (>0.4).
- Maintain per-operator alias table to seed manual rules (e.g., "Coke" ↔ "Coca-Cola").

### 4.3 Scoring Model

Composite confidence score = weighted sum of feature similarities:

| Feature                   | Metric                             | Weight |
| ------------------------- | ---------------------------------- | ------ |
| UPC                       | binary exact match                 | 0.45   |
| Name tokens               | cosine similarity on TF-IDF vector | 0.25   |
| Brand match               | binary / partial (0/0.6/1)         | 0.10   |
| Size difference           | 1 - normalized delta               | 0.10   |
| Category alignment        | categorical similarity             | 0.05   |
| Keyword flags (diet/zero) | penalty if mismatch                | -0.05  |

- Apply calibration sigmoid to ensure 0–1 distribution using historical confirmed matches.
- Maintain `match_rules` table for deterministic overrides (force match or block).

**Example Match Calculation:**

```
Source A (365):     "Coca Cola 20oz Can"
Source B (HAHA):    "Coke 20 oz"

Normalization:
  A: tokens=[coca, cola, 20oz]  brand=coca cola  size=20oz  isDiet=false
  B: tokens=[coca, cola, 20oz]  brand=coca cola  size=20oz  isDiet=false

Feature Scores:
  • UPC:      0.0   (different scan codes, not comparable)
  • Name:     0.67  (token Jaccard: 3/3 = 1.0; bigram Dice: lower due to "can")
  • Brand:    1.0   (both canonicalize to "coca cola")
  • Size:     1.0   (20oz = 20oz, exact match)
  • Category: 0.2   (365: Sodas, HAHA: missing → partial credit)
  • Price:    0.98  ($2.50 vs $2.49, <1% difference)
  • Diet:     0.0   (both non-diet, no penalty)

Weighted Confidence:
  (0.0×0.25 + 0.67×0.25 + 1.0×0.2 + 1.0×0.2 + 0.2×0.05 + 0.98×0.05) / 1.0
  = 0.88 → AUTO-MATCH ✓
```

```
Source A (365):     "Dasani Water 16.9oz"
Source B (HAHA):    "Aquafina Bottled Water 16oz"

Normalization:
  A: tokens=[dasani, water, 16.9oz]  brand=dasani  size=16.9oz
  B: tokens=[aquafina, water, 16oz]  brand=aquafina  size=16oz

Feature Scores:
  • Name:     0.33  (1 shared token "water" / 3 total unique)
  • Brand:    0.0   (dasani ≠ aquafina)
  • Size:     0.96  (16.9 vs 16, ~5% difference)
  • Category: 0.2   (both water-related)
  • Price:    0.99  ($1.50 vs $1.49)

Weighted Confidence: ~0.42 → UNMATCHED (different brands, low name similarity)
```

### 4.4 Confidence Thresholding

- `≥0.82`: auto-match; still logged for audit.
- `0.6 – 0.82`: queue for operator review; highlight contributing factors and allow one-click confirm/edit.
- `<0.6`: treat as unmatched; create new canonical product candidate.

### 4.5 Learning & Feedback

- Store features for every decision to support future model tuning (e.g., logistic regression on confirmed data).
- Capture operator overrides to update synonym dictionaries.

## 5. Data Model (Supabase / PostgreSQL)

### Core Tables

- `operators(id, name, settings)`
- `data_sources(id, operator_id, type, credentials, last_sync_at)`
- `ingestion_jobs(id, data_source_id, file_url, status, stats_json, created_at)`
- `stg_products(id, ingestion_job_id, source_product_id, raw_json, hash, created_at)`
- `normalized_products(id, stg_product_id, operator_id, brand, normalized_name, size_value, size_unit, category, tokens tsvector, features jsonb, created_at)`
- `canonical_products(id, operator_id, display_name, brand, size_value, size_unit, category, status, created_at)`
- `product_matches(id, canonical_product_id, normalized_product_id, confidence, status enum(auto|pending|rejected|manual), decided_by, decided_at)`
- `match_review_tasks(id, product_match_id, assigned_to, due_at, resolution, notes)`
- `match_rules(id, operator_id, rule_type enum(force_match|block|synonym), pattern jsonb, active)`
- `transactions(id, canonical_product_id nullable, normalized_product_id, stg_transaction_id, quantity, price, sold_at, created_at)`

### Supporting Materializations

- `canonical_product_sales` view summarizing `transactions` by canonical product, machine, date.
- Search index (`GIN` on `normalized_products.tokens`) for fast candidate lookups.
- Optional `pgvector` extension storing embedding of normalized names for advanced similarity.

## 6. Operator Experience

### Key Flows

- **Match Review Inbox**: Paginated list of pending matches with confidence, key attributes, and history. Operators accept, reject, or merge into new canonical product.
- **Canonical Catalog Management**: Browse canonical products, view linked source aliases, edit metadata (category/brand overrides).
- **Activity Feed**: Audit log of automated and manual match decisions.
- **Analytics Dashboards**: Use canonical products to show revenue, velocity, top sellers across sources.

### UX Considerations

- Provide explanation of confidence score (e.g., "Name 0.92, Size 0.98, Brand mismatch").
- Bulk actions for obvious matches (same UPC) to minimize clicks.
- Inline creation of new canonical product during review when unmatched item detected.
- Alerts when unmatched items accumulate above threshold to prompt operator attention.

## 7. Edge Cases & Handling

- **Brand synonyms / private labels**: maintain operator-specific synonym dictionary; allow manual overrides to propagate.
- **Multi-pack vs. single pack**: consider quantity heuristics (tokens "12pk", "multi"); penalize size mismatch >20%.
- **Seasonal / limited edition**: fallback to manual review; allow linking to existing canonical product with variant tags.
- **Typos / noisy data**: fuzzy matching tolerance, but require secondary attribute (size or price) to agree before auto matching.
- **Shared UPC across variants**: operator confirm required; store multiplicity to prevent automatic merges.
- **New product introduction**: create canonical product automatically when unmatched count surpasses frequency threshold.
- **Pricing discrepancies**: price similarity not used as primary feature but flagged for review if deviates from canonical median.
