# Personal Finance Tracker — Project Context

**Owner:** Veda Viyas P (Viyas)
**Created:** 2026-04-29
**Status:** Live and in active use
**Firebase project:** `my-finance-e7937` (see `.firebaserc`)
**Last updated:** 2026-07-07

---

## The Idea

A personal finance tracker that auto-captures UPI transactions from bank SMSes instead of manual entry. Built to replace Viyas's current workflow of manually copying transactions from GPay history into the Money Manager app.

### Core Flow
1. Bank SMS arrives after a UPI transaction
2. Android companion app reads it via BroadcastReceiver → forwards to Firebase Cloud Function
3. Cloud Function parses SMS with regex → stores transaction in Firestore
4. PWA dashboard shows transaction, user one-tap categorizes it

---

## Key Decisions Made

| Decision | Choice | Reasoning |
|----------|--------|-----------|
| Scope | Personal tool first, product later | Build for self, validate, then consider scaling |
| Primary bank | ICICI (account XX472) | Primary salary account |
| Additional banks | HDFC, CUB | SIP/investment accounts |
| SMS format | Regex-parseable, consistent | No AI needed for parsing |
| SMS capture | Android companion APK (BroadcastReceiver) | Bypasses Truecaller + notification redaction |
| Frontend | Vanilla JS PWA | Hosted on GitHub Pages |
| Backend | Firebase Firestore + Cloud Functions | Same project as Home Expense Tracker |
| Auth | Firebase Auth (email + password) | Single user; no Google sign-in in companion app |
| App name | My Finance | Unified branding |

---

## SMS Formats

### ICICI Credit (salary, refunds)
```
ICICI Bank Account XX472 credited:Rs. 51,764.00 on 28-Apr-26. Info NEFT-HDFCH00958770854-BA CON. Available Balance is Rs. 1,28,055.18.
```

### ICICI Debit (UPI)
```
ICICI Bank Acct XX472 debited for Rs 260.00 on 26-Apr-26; MR KATHIRAVAN R credited. UPI:648210939989. Call 18002662 for dispute. SMS BLOCK 472 to 9215676766.
```

### HDFC Debit (UPI)
```
JX-HDFCBK-C: Rs.500.00 debited from A/c XX0003 on 14/05/26. Info: UPI-...
```

### HDFC Credit (Money Received — multiline)
```
JX-HDFCBK-C: Money Received!
Rs.1.00 credited to your A/c XX0003
On 14/05/26
From PRANAV
UPI Ref: 650065174116
```

---

## Categories

### Spending Categories
| Category | Emoji | Examples |
|----------|-------|---------|
| Food | 🍔 | Swiggy, Zomato, restaurants, Wow China |
| Bill | 📱 | Phone recharge, electricity, subscriptions |
| Transport | 🚗 | Fuel, Ola/Uber, metro |
| Health | 🏥 | Pharmacy, doctor visits |
| Apparel | 👕 | Clothing, shoes |
| Hair Cut | 💇 | Salon, grooming |
| Culture | 🎬 | Movies, entertainment, books |
| Household | 🏠 | Home supplies |
| Gaming | 🎮 | Games, in-app purchases |
| Gift | 🎁 | Gifts to friends/family |
| Miscellaneous | 📦 | Uncategorized |

### Investment Categories
| Category | Emoji | Examples |
|----------|-------|---------|
| Mutual Fund | 📈 | SIP, lump sum MF purchases |
| PPF | 🏛️ | Public Provident Fund |
| SIP Transfer | 🔄 | Self transfers to HDFC, CUB for SIP |
| Fixed Deposit | 🏦 | FD, RD |
| Stocks | 📊 | Direct equity |

### Income Categories
| Category | Emoji | Examples |
|----------|-------|---------|
| Salary | 💰 | Bank of America monthly (~₹51k typical) |
| Refund | ↩️ | Returns, cashbacks |
| Other Income | 💵 | Freelance, interest, etc. |

---

## Monthly Financial Profile (Viyas)

- **Typical salary:** ~₹51,764/month from Bank of America (NEFT credit)
- **Investments:** SIP transfers (₹2k + ₹5k), Mutual Fund (₹7k), PPF (₹7.5k) = ~₹21.5k/month
- **Actual spending:** ~₹15-22k/month across food, bills, transport, etc.
- **Net savings pattern:** Investments are ~40% of income, spending ~35-45%

---

## Architecture (Current — Live)

```
[Bank SMS]
    ↓
[My Finance Android APK — BroadcastReceiver]
    ↓  (notification listener, bypasses Truecaller)
[Firebase Cloud Function — parseSms]
    ↓  (regex parser per bank format)
[Firestore: users/{uid}/transactions]
    ↓
[PWA Dashboard — categorize + visualize]
```

**Components:**
1. **Android companion APK** — `android-companion/` in repo. BroadcastReceiver reads bank SMS notifications (bypasses Truecaller redaction). Forwards via HTTP POST to Cloud Function. User grants notification access once via Settings → Companion App.
2. **Firebase Cloud Function** — `functions/` in repo. Regex-parses raw SMS per bank. Stores structured transaction in Firestore. `parseSms` runs in region `asia-south1` with `minInstances: 1` (kept warm to avoid cold-start latency).
3. **PWA frontend** — `index.html` (single-file app). Hosted on GitHub Pages.

### Hybrid SMS Parser (built-in regex → learned templates → LLM)
The Cloud Function parses SMS in three tiers, in order:
1. **Built-in regex patterns** (`buildPatterns()` in `functions/index.js`) — hand-written per known bank format (ICICI, HDFC, CUB).
2. **Per-user learned templates** (`users/{uid}/parser_templates`) — pure regex, no API call. Matched by `matchLearnedTemplates()`.
3. **LLM fallback** (`learnViaLLM()`) — on a total miss, asks **Claude Haiku 4.5** (`claude-haiku-4-5`) ONCE to extract the transaction AND induce a reusable regex template. Template is validated (`validateLearnedTemplate()` — must re-extract the same amount) then persisted, so the same format never hits the API again. Steady state ≈ zero API calls. Uses `output_config: { format: { type: "json_schema", schema: EXTRACTION_SCHEMA } }`. Gated per-user by `userConfig.llmEnabled`.

### Linked-accounts & dismissed-accounts filtering
- If a user has linked accounts, only SMS matching those accounts (by last4, or by bank name when the SMS has no account number) are saved.
- Unmatched accounts surface a "Tap to link" suggestion (`users/{uid}/suggested_accounts`), UNLESS the user previously dismissed that bank+last4 (`users/{uid}/config/dismissed_accounts`).

---

## Firebase Schema

### Collection: `users/{uid}/transactions`
```json
{
  "id": "auto",
  "raw_sms": "ICICI Bank Acct XX472 debited for Rs 260.00...",
  "amount": 260.00,
  "date": "2026-04-26",
  "type": "debit",
  "bank": "icici",
  "category": "Food",
  "category_type": "spending",
  "recipient": "MR KATHIRAVAN R",
  "upi_ref": "648210939989",
  "note": "",
  "reimburses_id": null,
  "created_at": "2026-04-26T14:30:00Z"
}
```

### Collection: `users/{uid}/config/accounts`
```json
{
  "linked_accounts": [
    { "id": "icici", "name": "ICICI Bank", "last4": "472", "color": "#F97316" }
  ]
}
```

---

## Features Completed

### PWA Dashboard
- [x] 4 metric cards: Income, Spent, Invested, Net Saved
- [x] Monthly navigator (◄ Month ►)
- [x] Budget progress bar
- [x] Spending breakdown chart
- [x] Investment split chart
- [x] Uncategorized transaction queue (newest first) with one-tap categorize
- [x] Recent transactions list grouped by date
- [x] FAB (+) to add transactions manually
- [x] Analytics view (heatmap, charts, trends)
- [x] Reimbursements — netted out of spending totals and charts
- [x] Self-transfers excluded from all totals
- [x] Auto-categorization rules (learn from user choices)
- [x] Multiple bank accounts support (ICICI, HDFC, CUB)
- [x] Hybrid SMS parser with LLM fallback (Claude Haiku 4.5 learns unknown formats)
- [x] Dismissed-account blocklist (denied banks stop being tracked)

### Auth
- [x] Email + password login / signup
- [x] Forgot password (sends reset email)
- [x] Change password in Settings

### Android Companion App
- [x] BroadcastReceiver — reads bank SMS notifications, bypasses Truecaller
- [x] Real app logo (budget-donut + wallet)
- [x] No URL bar (TWA wrapper)
- [x] Auto-sync credentials via deep link
- [x] "Update available" banner (in-app) with steps to re-enable notification access
- [x] SMS forwarding diagnostics in Settings

### PWA (browser users)
- [x] "Get the Android app" banner for Android browser users
- [x] Download confirmation modal: shows signed-in email, inline password reset before APK download

### Settings
- [x] Linked Accounts (add/remove banks)
- [x] Companion App (diagnostics, re-enable forwarding, update APK)
- [x] Missed SMS log (privacy)
- [x] Help page (FAQs)
- [x] About / version info
- [x] Dark mode

### SMS Forwarding Banner (companion app)
- [x] Only shows when ≥1 linked account exists
- [x] Re-evaluates after accounts load from Firestore
- [x] Tapping opens step-by-step setup modal (not a blind deep link)
- [x] Dismissed state persists; doesn't re-nag after setup complete

---

## Tech Stack

| Layer | Tech | Notes |
|-------|------|-------|
| SMS Capture | Android APK (BroadcastReceiver) | `android-companion/` |
| Backend | Firebase Cloud Functions | `functions/` |
| Database | Firebase Firestore | Per-user collections |
| Auth | Firebase Auth | Email + password |
| Frontend | Vanilla JS PWA | Single `index.html` |
| Hosting | GitHub Pages | Auto-deploy via push to main |
| LLM parser | Claude Haiku 4.5 (`claude-haiku-4-5`) | Learns unknown bank SMS formats, `@anthropic-ai/sdk` ^0.96 in `functions/` |
| Charts | Chart.js | Pie, line, heatmap |
| Service Worker | `sw.js` | Offline support, current: `finance-v21.2` |

---

## CI/CD (GitHub Actions)

| Workflow | Trigger | What it does |
|----------|---------|--------------|
| `build-android.yml` | push to main (android-companion/**), **PR closed+merged** (bot-merge fallback), or manual dispatch | Builds debug APK, signs with committed `debug.keystore`, publishes to `android-latest` GitHub release |
| `deploy-functions.yml` | push to main (functions/**) or manual dispatch | `firebase deploy --only functions`, auth via `FIREBASE_TOKEN` secret |

**IMPORTANT gotcha:** PRs merged via the GitHub API / Claude Code bot token do NOT fire `push`-event workflows (GitHub anti-recursion). That's why `build-android.yml` also has a `pull_request: closed` trigger. The GitHub MCP integration also lacks `actions:write`, so workflows can't be dispatched from a Claude session — the user must click "Run workflow" in the Actions tab, or merge via the web UI.

**Signing:** every APK build uses the committed `android-companion/app/debug.keystore`, so new builds install over old ones without "App not installed" (no signature mismatch).

### ⚠️ One-time setup still pending (user action required)
1. **`FIREBASE_TOKEN` secret** — run `firebase login:ci`, copy token, add as repo secret (Settings → Secrets → Actions → `FIREBASE_TOKEN`). Until this exists, `deploy-functions.yml` runs will fail with an auth error. After it's set, every functions/ change auto-deploys.
2. **First APK rebuild** — Actions → "Build Android APK" → Run workflow (to ship the IMPORTANCE_HIGH notification + companionUser param changes). After that, future Kotlin changes auto-build on merge.

---

## Roadmap — Remaining / Future

- [ ] Auto-categorization improvements (merchant name → category ML/rules)
- [ ] Export to CSV / PDF monthly report
- [ ] Widgets / push notifications for new transactions
- [ ] iOS support (currently Android-only for SMS capture)

---

## Session Log

### 2026-07-07 session (branch `claude/new-session-khsdfy`)
All merged to main unless noted. **PWA changes are live immediately (GitHub Pages); Cloud Function changes need a deploy; Kotlin changes need an APK rebuild.**

Merged:
- **PR #5** — dismissed-account-still-tracked fix (removed the `&& parsed.account` bypass; falls back to bank-name match when SMS has no account number); cold-start fix (`minInstances: 1` on `parseSms`); Firestore reconnect on foreground after 30s; UncatNotifier `IMPORTANCE_HIGH` heads-up notifications; multi-user credential sync (`companionUser` URL param + PWA mismatch detection); uncategorized sort order; SMS-forwarding banner guard.
- **PR #6** — LLM template learning fix: prompt now uses `[\d,]+\.?\d*` for money (was `[\d,]+`, which dropped decimals and failed validation); `validateLearnedTemplate` tolerance raised from 0.01 to `max(1.0, 0.1%)`; added diagnostic `console.warn`/`log` throughout the learn path (visible in Cloud Function logs).
- **PR #7** — CI: new `deploy-functions.yml` (auto-deploy) + fixed `build-android.yml` to also trigger on merged PRs.
- **PR #1 (closed, superseded)** — HDFC "Money Received" parser; reworked into PR #8. Its second commit (bidirectional last4 match) was already in main from the PR #5 rewrite.

Open / pending:
- **PR #8** — HDFC UPI credit parser (`hdfc_credit_upi`) for the multiline "Money Received" format. Draft, ready to merge.
- **User TODO** (see CI/CD section): add `FIREBASE_TOKEN` secret + merge PR #8 (auto-deploys all backend fixes), and trigger one Android APK rebuild.

**Why the backend fixes weren't live at session end:** no Firebase credentials exist in the Claude Code sandbox (no CLI/token/service account), so the functions can't be deployed from a session — hence the `deploy-functions.yml` CI + `FIREBASE_TOKEN` approach.

---

## Related Projects
- **Home Expense Tracker** — `D:\Projects\Claude Projects\Household Expense Tracker\` (for Amma, DO NOT TOUCH)
- Separate Firebase project. Same GitHub account: `viyas52`. Shares the same `ANTHROPIC_API_KEY` secret for the LLM parser.
