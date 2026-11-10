---
name: cited-feedback-analysis
description: Analyze user feedback such as reviews, survey answers, support tickets, interview notes, app-store reviews, social media comments or danmaku from a local TXT, Markdown, CSV, TSV, JSON or JSONL file, and write a themed report where every claim cites verbatim quotes with record IDs that a bundled script verifies against the source. Use when the user asks what users or customers are saying, wants pain points, feature requests, sentiment or themes from feedback data, or needs research findings backed by traceable evidence. Works offline with the host agent's own model; no API key or extra install.
license: MIT
compatibility: Needs Node.js 18+ to run scripts/evidence.mjs and permission to run shell commands and read local files. No network access or API key.
metadata:
  author: sansan-mei
  homepage: https://github.com/sansan-mei/ugc-lens
---

# Cited feedback analysis

Turn a feedback file into findings a reader can audit: every claim points to real records, every quote is verbatim, and counts say how they were obtained. The model reads and interprets; the script indexes, counts and verifies.

`scripts/evidence.mjs` lives next to this file. Run it with `node <this skill directory>/scripts/evidence.mjs`. Write working files (records, drafts) to a scratch or output directory the user agrees to, not into their source data folder.

## 1. Index the source

```bash
node scripts/evidence.mjs index feedback.csv --out feedback.records.jsonl
```

- Formats: `.txt` / `.log` (one record per non-empty line), `.md` (one per paragraph), `.csv` / `.tsv` (header row required), `.json` (an array, or an object holding exactly one array; pick one with `--items video_comments` when there are several), `.jsonl` / `.ndjson`.
- IDs: an existing id column such as `id`, `ticket_id`, `review_id` or `rpid` is used when present; otherwise `line_N` is the source line where the record starts, and `item_N` the position in a JSON array. Pass `--id-field` or `--text-field` (dot paths like `content.message` work) when auto-detection picks the wrong field or fails; the error lists available fields.
- Nested reply threads (arrays of objects with the same text field, such as `replyList`) become separate records with `meta.parent_id`; `flattened_replies` in the summary counts them. When reading a reply, check its parent before deciding what it agrees or disagrees with.
- The command prints a JSON summary. Tell the user the record count, skipped empty records and which text field was used before analyzing. If the summary picked a field you did not expect, stop and fix it.
- Do not open the whole source file in context. Read the generated JSONL instead.

## 2. Read with explicit coverage

- If `total_chars` fits comfortably in your context (roughly under 150k characters), read every record.
- Otherwise read the JSONL in consecutive batches and keep notes per batch (candidate themes with record IDs). Never stop after the first batch and present the result as the whole dataset. If you cannot read everything, say exactly which records were read, for example "records 1-800 of 2,431", and treat findings as covering that portion only.
- Respect the user's focus questions; otherwise look for main themes, recurring problems, requests and suggestions, praise, and disagreements.

## 3. Count with code, not impressions

For each candidate theme, build one or more regex patterns and run:

```bash
node scripts/evidence.mjs search feedback.records.jsonl "refund|money back|chargeback" --limit 15
```

- `matched` is a real count of records matching the pattern. Report it as "N records mention X (pattern: ...)", never as a share of all users or the market.
- Keyword counts miss paraphrases and include false hits. Read the returned matches; if many are irrelevant, refine the pattern. When a number is your own estimate from reading, label it "about" and say it is an estimate.
- Use search to look for counter-examples before stating a strong conclusion, and report them alongside the finding.
- Short or one-word answers ("ok", "none") still count as records; mention how many were uninformative if it affects the denominators.

## 4. Write the report

Follow [the report template](references/report-template.md). Citation rules the verifier enforces:

- Cite records as `[ID]`, or `[ID1, ID2]` for several. Do not use square brackets for anything else in the report except normal Markdown links.
- A direct quote is written as `"exact text" [ID]` with the quote immediately before its citation. Copy the text verbatim; you may drop a middle part with `…`. Never fix typos, paraphrase inside quotes or merge two records into one quote.
- If the source language differs from the report language, keep the original quote and put the translation after the citation: `"原文" [line_12] (translation: ...)`.
- Separate what users said from your interpretation. Minority views are labeled as minority with their count. Do not infer demographics, intent or causes that the text does not state.
- Do not reproduce personal data (emails, phone numbers, full names of private people) unless the user needs it; quote around it with `…`.

## 5. Verify, then deliver

```bash
node scripts/evidence.mjs verify feedback.records.jsonl report.md
```

- Exit code 0 and `"ok": true` means every cited ID exists and every quote appears in its cited record. Fix every entry in `unknown_ids` and `quote_mismatches`, then re-run until it passes. Never deliver a report that fails verification without telling the user which items failed.
- Passing verification proves traceability, not interpretation quality. In the final message give: the report path, records analyzed out of total, the verification result (`citations`, `cited_unique`, `quotes_checked`), and the main limits (sampling, keyword-count caveats, unread records).

## When to use ugc-lens instead

This skill fits files up to a few thousand short records analyzed in one session. Suggest the `ugc-lens` package (`npm install -g ugc-lens`, then its own `ugc-lens` skill or MCP server) when the user has tens of thousands of records, nested comment and reply threads, danmaku timelines and subtitles, Chinese social media exports, or needs per-record sentiment and topic classification, repeatable runs or directory watching. It needs its own model API key, configured by the user with `ugc-lens init`.
