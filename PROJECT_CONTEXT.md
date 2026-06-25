# Personal Finance Tracker — Project Context

**Owner:** Veda Viyas P (Viyas)
**Created:** 2026-04-29
**Status:** Live and in active use

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
2. **Firebase Cloud Function** — `functions/` in repo. Regex-parses raw SMS per bank. Stores structured transaction in Firestore.
3. **PWA frontend** — `index.html` (single-file app). Hosted on GitHub Pages.

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
| Charts | Chart.js | Pie, line, heatmap |
| Service Worker | `sw.js` | Offline support, current: `finance-v20.8` |

---

## Roadmap — Remaining / Future

- [ ] HDFC UPI credit parser (PR #1 open — "Money Received" multiline format)
- [ ] Auto-categorization improvements (merchant name → category ML/rules)
- [ ] Export to CSV / PDF monthly report
- [ ] Widgets / push notifications for new transactions
- [ ] iOS support (currently Android-only for SMS capture)

---

## Related Projects
- **Home Expense Tracker** — `D:\Projects\Claude Projects\Household Expense Tracker\` (for Amma, DO NOT TOUCH)
- Uses same Firebase project: `home-expense-tracker-8a5c9`
- Same GitHub account: `viyas52`
