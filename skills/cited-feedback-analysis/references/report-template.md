# Report template

Adapt section names to the user's questions; keep the evidence rules.

```markdown
# <Dataset name>: what users are saying

## Scope
- Source: <file>, <N> records (<skipped> empty skipped), text field `<field>`
- Read: <all N records | records a-b of N>; focus: <user questions or default>
- Method: themes read by the model; counts from regex search over all records unless marked "about"

## Summary
- 3-5 bullets, each a finding with its count and one or two citations [ID]

## Findings

### 1. <Theme stated as a claim, e.g. "Refunds take weeks and get no reply">
- How common: <N> records match `<pattern>`; <about M> of the records read discuss it
- Evidence:
  - "<verbatim quote>" [ID]
  - "<verbatim quote>" [ID]
- Counter-examples or nuance: "<quote>" [ID] (or "none found by searching `<pattern>`")
- Interpretation: <what this suggests, clearly marked as interpretation>

### 2. ...

## Requests and suggestions
| Request | Records | Example |
|---|---|---|
| <request> | <N> (`<pattern>`) | "<quote>" [ID] |

## Disagreements and minority views
- <view> (<N> records): "<quote>" [ID] vs "<quote>" [ID]

## Limits
- Coverage, keyword-count caveats, sample bias (who leaves feedback), anything not checked

## Verification
- `evidence.mjs verify`: ok, <citations> citations, <cited_unique> records cited, <quotes_checked> quotes checked
```

## Good and bad evidence lines

- Good: `- "Took 3 weeks to get my refund and support never answered" [T-1042]`
- Good: `- "退款三周…没人回复" [line_88] (translation: refund took three weeks… nobody replied)`
- Bad: `- Users hate the refund process [T-1042]` as a quote of many users (one record cannot prove "users")
- Bad: `- "Refunds are slow and support is bad" [T-1042, T-2210]` when no single record contains that sentence
