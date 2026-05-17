const { onRequest } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const { initializeApp } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");
const { getAuth } = require("firebase-admin/auth");
const crypto = require("crypto");
const Anthropic = require("@anthropic-ai/sdk");

// Reused Anthropic key (shared with the Household Expense Tracker app).
// Set with: firebase functions:secrets:set ANTHROPIC_API_KEY
const ANTHROPIC_API_KEY = defineSecret("ANTHROPIC_API_KEY");

initializeApp();
const db = getFirestore();
const adminAuth = getAuth();

// ── Date helpers ──
const MONTHS = {
  Jan:"01", Feb:"02", Mar:"03", Apr:"04", May:"05", Jun:"06",
  Jul:"07", Aug:"08", Sep:"09", Oct:"10", Nov:"11", Dec:"12",
  JAN:"01", FEB:"02", MAR:"03", APR:"04", MAY:"05", JUN:"06",
  JUL:"07", AUG:"08", SEP:"09", OCT:"10", NOV:"11", DEC:"12",
};

function parseDateAlpha(raw) {
  const [day, mon, yr] = raw.split("-");
  return `20${yr}-${MONTHS[mon] || "01"}-${day.padStart(2, "0")}`;
}
function parseDateAlphaLong(raw) {
  const [day, mon, yr] = raw.split("-");
  return `${yr}-${MONTHS[mon]}-${day.padStart(2, "0")}`;
}
function parseDateNum(raw) {
  const [day, mon, yr] = raw.split("-");
  return `20${yr}-${mon}-${day}`;
}
function parseDateSlash(raw) {
  const [day, mon, yr] = raw.split("/");
  return `20${yr}-${mon}-${day.padStart(2,"0")}`;
}
function parseDateNumLong(raw) {
  const [day, mon, yr] = raw.split("-");
  return `${yr}-${mon}-${day}`;
}
function todayDate() {
  return new Date().toISOString().split("T")[0];
}

// ── Recipient cleanup for noisy NACH-style strings ──
function cleanRecipient(raw) {
  if (!raw) return raw;
  const cubMatch = raw.match(/BD-([^/]+)/);
  if (cubMatch) return cubMatch[1].trim();
  return raw;
}

// ── Strip UPI ID domain: "baalambigai@okicici" → "baalambigai" ──
function cleanUpiId(raw) {
  if (!raw) return raw;
  const at = raw.indexOf("@");
  if (at > 0) return raw.substring(0, at).trim();
  return raw.trim();
}

// ── Account number → bank id (dynamic, per-user) ──
function acctToBankDynamic(acct, acctBankMap) {
  if (!acct || !acctBankMap) return null;
  for (const [last4, bank] of Object.entries(acctBankMap)) {
    if (acct.endsWith(last4) || last4.endsWith(acct)) return bank;
  }
  return null;
}

// ── SMS Pattern Table ──
// acctToBank is passed as a param now (per-user)
function buildPatterns(acctToBank) {
  return [
    // ── ICICI debit (UPI) ── (forgiving whitespace + optional period after "credited")
    {
      name: "icici_debit_upi",
      rx: /ICICI Bank Acct XX(\d+)\s+debited\s+for\s+Rs\.?\s*([\d,]+\.?\d*)\s+on\s+(\d{1,2}-\w{3}-\d{2})[;,]\s*(.+?)\s+credited\.?\s+UPI:?\s*(\d+)/i,
      parse: (m, sms) => ({
        raw_sms: sms, bank: "icici", account: m[1],
        amount: parseFloat(m[2].replace(/,/g, "")),
        date: parseDateAlpha(m[3]),
        type: "debit", category: null, category_type: null,
        recipient: m[4].trim(), note: m[4].trim(), upi_ref: m[5],
        source: "", source_account: "", balance_after: null,
        created_at: new Date().toISOString(),
        dedup_key: "icici_d_" + m[5],
      }),
    },
    // ── ICICI credit (NEFT-style) ──
    {
      name: "icici_credit_neft",
      rx: /ICICI Bank Account XX(\d+) credited:Rs\. ([\d,]+\.\d{2}) on (\d{2}-\w{3}-\d{2})\. Info (.+?)\. Available Balance is Rs\. ([\d,]+\.\d{2})/,
      parse: (m, sms) => {
        const amt = parseFloat(m[2].replace(/,/g, ""));
        const dt = parseDateAlpha(m[3]);
        const bal = parseFloat(m[5].replace(/,/g, ""));
        return {
          raw_sms: sms, bank: "icici", account: m[1],
          amount: amt, date: dt,
          type: "credit", category: null, category_type: null,
          recipient: "", source: m[4], source_account: "",
          note: m[4], upi_ref: "", balance_after: bal,
          created_at: new Date().toISOString(),
          dedup_key: "icici_cn_" + dt + "_" + amt + "_" + bal,
        };
      },
    },
    // ── ICICI credit (UPI) ──
    {
      name: "icici_credit_upi",
      rx: /Dear Customer, Acct XX(\d+) is credited with Rs\.?\s*([\d,]+\.?\d*) on (\d{2}-\w{3}-\d{2}) from (.+?)\. UPI:(\d+)/i,
      parse: (m, sms) => ({
        raw_sms: sms, bank: "icici", account: m[1],
        amount: parseFloat(m[2].replace(/,/g, "")),
        date: parseDateAlpha(m[3]),
        type: "credit", category: null, category_type: null,
        recipient: "", source: cleanUpiId(m[4].trim()), source_account: "",
        note: cleanUpiId(m[4].trim()), upi_ref: m[5], balance_after: null,
        created_at: new Date().toISOString(),
        dedup_key: "icici_cu_" + m[5],
      }),
    },
    // ── HDFC credit ──
    {
      name: "hdfc_credit",
      rx: /Credit Alert[\s\S]*?Rs\.?\s*([\d,]+\.?\d*) credited to HDFC Bank A\/c XX(\d+) on (\d{2}-\d{2}-\d{2}) from (?:VPA )?(.+?) \(UPI (?:Ref )?(\d+)\)/i,
      parse: (m, sms) => ({
        raw_sms: sms, bank: "hdfc", account: m[2],
        amount: parseFloat(m[1].replace(/,/g, "")),
        date: parseDateNum(m[3]),
        type: "credit", category: null, category_type: null,
        recipient: "", source: cleanUpiId(m[4].trim()), source_account: "",
        note: cleanUpiId(m[4].trim()), upi_ref: m[5], balance_after: null,
        created_at: new Date().toISOString(),
        dedup_key: "hdfc_c_" + m[5],
      }),
    },
    // ── HDFC debit (PAYMENT ALERT — NACH/UMRN) ──
    {
      name: "hdfc_debit_nach",
      rx: /PAYMENT ALERT[\s\S]*?INR\s*([\d,]+\.?\d*) deducted from HDFC Bank A\/C No\.?\s*(\d+) towards (.+?) UMRN:\s*([A-Z0-9]+)/i,
      parse: (m, sms) => {
        const dt = todayDate();
        const amt = parseFloat(m[1].replace(/,/g, ""));
        const umrn = m[4];
        return {
          raw_sms: sms, bank: "hdfc", account: m[2],
          amount: amt, date: dt,
          type: "debit", category: null, category_type: null,
          recipient: m[3].trim(), source: "", source_account: "",
          note: m[3].trim(), upi_ref: "", umrn, balance_after: null,
          created_at: new Date().toISOString(),
          dedup_key: "hdfc_d_" + umrn + "_" + dt + "_" + amt,
        };
      },
    },
    // ── CUB credit ──
    {
      name: "cub_credit",
      rx: /Your a\/c no\. X+(\d+) is credited for Rs\.?\s*([\d,]+\.?\d*) on (\d{2}-\d{2}-\d{4}) and debited from a\/c no\. X+(\d+) \(UPI Ref no (\d+)\)\s*-CUB/i,
      parse: (m, sms) => {
        const sourceAcct = m[4];
        return {
          raw_sms: sms, bank: "cub", account: m[1],
          amount: parseFloat(m[2].replace(/,/g, "")),
          date: parseDateNumLong(m[3]),
          type: "credit", category: null, category_type: null,
          recipient: "", source: "From XX" + sourceAcct.slice(-4),
          source_account: sourceAcct,
          bank_from: acctToBank(sourceAcct) || null,
          note: "From XX" + sourceAcct.slice(-4),
          upi_ref: m[5], balance_after: null,
          created_at: new Date().toISOString(),
          dedup_key: "cub_c_" + m[5],
        };
      },
    },
    // ── CUB debit (NACH/auto-debit) ──
    {
      name: "cub_debit",
      rx: /Savings No X+(\d+) debited with INR\s*([\d,]+\.?\d*) towards (.+?) on (\d{2}-\w{3}-\d{4})/i,
      parse: (m, sms) => {
        const recipientRaw = m[3].trim();
        const cleaned = cleanRecipient(recipientRaw);
        const dt = parseDateAlphaLong(m[4]);
        const amt = parseFloat(m[2].replace(/,/g, ""));
        const achMatch = recipientRaw.match(/ACH_DR::(\d+)/);
        const ciubMatch = recipientRaw.match(/CIUB(\d+)/);
        const refTag = achMatch ? achMatch[1]
                     : ciubMatch ? ciubMatch[1]
                     : (dt + "_" + amt + "_" + cleaned.slice(0, 20).replace(/\W/g, ""));
        return {
          raw_sms: sms, bank: "cub", account: m[1],
          amount: amt, date: dt,
          type: "debit", category: null, category_type: null,
          recipient: cleaned, source: "", source_account: "",
          note: cleaned, upi_ref: "", balance_after: null,
          created_at: new Date().toISOString(),
          dedup_key: "cub_d_" + refTag,
        };
      },
    },
    // ── CUB debit (UPI — to another account) ──
    {
      name: "cub_debit_upi",
      rx: /Your a\/c no\. X+(\d+) is debited for Rs\.?\s*([\d,]+\.?\d*) on (\d{2}-\d{2}-\d{4}) and credited to a\/c no\. X+(\d+) \(UPI Ref no (\d+)\)/i,
      parse: (m, sms) => {
        const destAcct = m[4];
        return {
          raw_sms: sms, bank: "cub", account: m[1],
          amount: parseFloat(m[2].replace(/,/g, "")),
          date: parseDateNumLong(m[3]),
          type: "debit", category: null, category_type: null,
          recipient: "To XX" + destAcct.slice(-4),
          source: "", source_account: destAcct,
          bank_to: acctToBank(destAcct) || null,
          note: "To XX" + destAcct.slice(-4),
          upi_ref: m[5], balance_after: null,
          created_at: new Date().toISOString(),
          dedup_key: "cub_du_" + m[5],
        };
      },
    },
    // ── HDFC debit (UPI — multiline) ──
    {
      name: "hdfc_debit_upi",
      rx: /Sent Rs\.?\s*([\d,]+\.?\d*)[\s\S]*?From HDFC Bank A\/C \*(\d+)[\s\S]*?To (.+?)\s*On (\d{2}\/\d{2}\/\d{2})\s*Ref (\d+)/i,
      parse: (m, sms) => ({
        raw_sms: sms, bank: "hdfc", account: m[2],
        amount: parseFloat(m[1].replace(/,/g, "")),
        date: parseDateSlash(m[4]),
        type: "debit", category: null, category_type: null,
        recipient: m[3].trim(), source: "", source_account: "",
        note: m[3].trim(), upi_ref: m[5], balance_after: null,
        created_at: new Date().toISOString(),
        dedup_key: "hdfc_du_" + m[5],
      }),
    },
    // ── HDFC debit (IMPS — to an account number, not UPI) ──
    // Example:
    //   IMPS INR 3,000.00
    //   sent from HDFC Bank A/c XX6829 on 13-05-26
    //   To A/c xxxxxxxxxx9367
    //   Ref-613326278727
    {
      name: "hdfc_debit_imps",
      rx: /IMPS\s*INR\s*([\d,]+\.?\d*)[\s\S]*?from\s*HDFC\s*Bank\s*A\/c\s*XX(\d+)\s*on\s*(\d{2}-\d{2}-\d{2})[\s\S]*?To\s*A\/c\s*[xX]+(\d+)[\s\S]*?Ref-?(\d+)/i,
      parse: (m, sms) => {
        const destAcct = m[4];
        return {
          raw_sms: sms, bank: "hdfc", account: m[2],
          amount: parseFloat(m[1].replace(/,/g, "")),
          date: parseDateNum(m[3]),
          type: "debit", category: null, category_type: null,
          recipient: "To XX" + destAcct.slice(-4),
          source: "", source_account: destAcct,
          bank_to: acctToBank(destAcct) || null,
          note: "IMPS to XX" + destAcct.slice(-4),
          upi_ref: m[5], balance_after: null,
          created_at: new Date().toISOString(),
          dedup_key: "hdfc_di_" + m[5],
        };
      },
    },
    // ── Bank of Baroda debit (UPI) ──
    {
      name: "bob_debit_upi",
      rx: /Rs\.?\s*([\d,]+\.?\d*)\s*Dr\.?\s*from\s*A\/C\s*[Xx]+(\d+)\s*and\s*Cr\.?\s*to\s*(.+?)\.?\s*Ref:?\s*(\d+)\.?\s*AvlBal:?\s*Rs\.?\s*([\d,]+\.?\d*)\s*\(\s*(\d{4}):(\d{2}):(\d{2})/i,
      parse: (m, sms) => ({
        raw_sms: sms, bank: "bob", account: m[2],
        amount: parseFloat(m[1].replace(/,/g, "")),
        date: `${m[6]}-${m[7]}-${m[8]}`,
        type: "debit", category: null, category_type: null,
        recipient: cleanUpiId(m[3].trim()), note: cleanUpiId(m[3].trim()),
        upi_ref: m[4], source: "", source_account: "",
        balance_after: parseFloat(m[5].replace(/,/g, "")),
        created_at: new Date().toISOString(),
        dedup_key: "bob_d_" + m[4],
      }),
    },
    // ── Bank of Baroda credit (UPI) ──
    {
      name: "bob_credit_upi",
      rx: /Dear BOB UPI User:[\s\S]*?credited with INR\s*([\d,]+\.?\d*)\s*on\s*(\d{4}-\d{2}-\d{2})[\s\S]*?UPI Ref No\s*(\d+);\s*AvlBal:?\s*Rs\.?\s*([\d,]+\.?\d*)/i,
      parse: (m, sms) => ({
        raw_sms: sms, bank: "bob", account: "",
        amount: parseFloat(m[1].replace(/,/g, "")),
        date: m[2],
        type: "credit", category: null, category_type: null,
        recipient: "", source: "", source_account: "",
        note: "UPI Credit", upi_ref: m[3],
        balance_after: parseFloat(m[4].replace(/,/g, "")),
        created_at: new Date().toISOString(),
        dedup_key: "bob_c_" + m[3],
      }),
    },
  ];
}

function parseSms(sms, acctToBank) {
  const patterns = buildPatterns(acctToBank);
  for (const p of patterns) {
    const m = sms.match(p.rx);
    if (m) return p.parse(m, sms);
  }
  return null;
}

// ── Self-transfer detection (dynamic, per-user) ──
function matchesSelfAccount(num, selfAccounts) {
  if (!num || !selfAccounts) return false;
  return selfAccounts.some(a => num.endsWith(a) || a.endsWith(num));
}
function isSelfTransfer(parsed, selfNamesRx, selfAccounts) {
  if (selfNamesRx) {
    if (parsed.recipient && selfNamesRx.test(parsed.recipient)) return true;
    if (parsed.source && selfNamesRx.test(parsed.source)) return true;
  }
  if (parsed.source_account && matchesSelfAccount(parsed.source_account, selfAccounts)) return true;
  return false;
}

// ── SIP / investment auto-tag patterns ──
const SIP_PATTERNS = [
  { match: /SBI\s*FUNDS|SBI\s*MUTUAL|SBI\s*MF/i, category: "Mutual Fund" },
  { match: /TATA\s*MF|TATA\s*MUTUAL|TATA\s*ASSET/i, category: "Mutual Fund" },
  { match: /HDFC\s*AMC|HDFC\s*MUTUAL/i, category: "Mutual Fund" },
  { match: /ICICI\s*PRU|ICICI\s*MUTUAL/i, category: "Mutual Fund" },
  { match: /AXIS\s*MF|AXIS\s*MUTUAL/i, category: "Mutual Fund" },
  { match: /KOTAK\s*MF|KOTAK\s*MUTUAL/i, category: "Mutual Fund" },
  { match: /MIRAE\s*ASSET|NIPPON\s*INDIA\s*MF|UTI\s*MF/i, category: "Mutual Fund" },
  { match: /MUTUAL\s*FUND|FUNDS\s*MANAGEMENT|AMC\s*LIMITED/i, category: "Mutual Fund" },
  { match: /\bPPF\b|PUBLIC\s*PROVIDENT/i, category: "PPF" },
  { match: /NACH_DR|ACH_DR|ECS_DR|UMRN/i, category: "Mutual Fund" },
];
function detectSip(parsed) {
  if (parsed.type !== "debit") return null;
  const text = (parsed.recipient || "") + " " + (parsed.note || "") + " " + (parsed.umrn || "");
  for (const p of SIP_PATTERNS) {
    if (p.match.test(text)) return { category: p.category, category_type: "investment" };
  }
  return null;
}

// ── Built-in regex rules ──
const BUILTIN_RULES = [
  { type: "credit", match: /BA CON|BANK\s*OF\s*AMERICA/i, category: "Salary", category_type: "income" },
];

function normalizeKey(s) {
  return (s || "").trim().toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

// ── Load per-user config from Firestore ──
async function loadUserConfig(userId) {
  const [acctSnap, selfSnap, profileSnap] = await Promise.all([
    db.doc(`users/${userId}/config/accounts`).get(),
    db.doc(`users/${userId}/config/self_transfer`).get(),
    db.doc(`users/${userId}/config/profile`).get(),
  ]);

  const acctData = acctSnap.exists ? acctSnap.data() : {};
  const selfData = selfSnap.exists ? selfSnap.data() : {};
  const profileData = profileSnap.exists ? profileSnap.data() : {};

  const acctBankMap = acctData.acct_bank || {};
  const linkedAccounts = acctData.linked_accounts || [];
  const selfNamesRx = selfData.names_regex ? new RegExp(selfData.names_regex, "i") : null;
  const selfAccounts = selfData.accounts || [];
  const apiKey = profileData.api_key || null;
  // LLM parser learning is on unless the user explicitly turned it off.
  const llmEnabled = profileData.llm_parser_enabled !== false;

  return { acctBankMap, linkedAccounts, selfNamesRx, selfAccounts, apiKey, llmEnabled };
}

// ── Coarse per-user rate limit (best-effort abuse cap). ──
// Stopgap until Firebase App Check + Play Integrity is wired up. Trailing
// 60s window, max 60 ingest calls/min per user. Fails open if the limiter
// itself errors, so a limiter glitch never blocks legitimate ingestion.
async function checkRateLimit(userId) {
  const rlRef = db.doc(`users/${userId}/config/_rl`);
  const now = Date.now();
  const WINDOW_MS = 60000;
  const MAX = 60;
  try {
    return await db.runTransaction(async (tx) => {
      const snap = await tx.get(rlRef);
      const data = snap.exists ? snap.data() : {};
      let windowStart = data.windowStart || 0;
      let count = data.count || 0;
      if (now - windowStart >= WINDOW_MS) {
        windowStart = now;
        count = 0;
      }
      count += 1;
      tx.set(rlRef, { windowStart, count }, { merge: true });
      return count <= MAX;
    });
  } catch (_) {
    return true;
  }
}

// ════════════════════════════════════════════════════════════════════════
//  HYBRID PARSER — learn a bank's SMS format ONCE with Claude (Haiku 4.5),
//  save a validated regex template per-user, then parse locally forever.
//  The LLM is a one-time teacher, never a runtime parser. Steady state for
//  a user with no new formats ≈ zero API calls.
// ════════════════════════════════════════════════════════════════════════

// Allowed date_format tokens the model may emit; the normalizer below maps
// a captured date substring → ISO YYYY-MM-DD for all future matches.
const LEARN_SYSTEM_PROMPT = `You extract one bank transaction from a single Indian bank SMS, and induce a REUSABLE regular expression that will parse every future SMS of this exact format.

Return ONLY JSON matching the provided schema. No prose.

STEP 1 — Is this a real transaction SMS (money actually debited or credited from the user's account)?
- YES for: UPI/IMPS/NEFT/RTGS debits & credits, card spends, ACH/NACH/SI auto-debits, ATM withdrawals, salary credits.
- NO for: OTPs, promotional/offer messages, "available balance is" with no debit/credit event, payment requests/reminders, failed/declined txn, EMI due reminders, statement notices. If NO → {"is_transaction": false, "transaction": null, "template": null}.

STEP 2 — Extract the transaction:
- amount: the transaction amount as a number (no commas/₹/Rs).
- type: "debit" if money left the user's account, "credit" if money came in.
- date: the transaction date as ISO "YYYY-MM-DD". 2-digit years are 20YY. If the SMS has no date, null.
- account_last4: last 4 digits of the USER's own account/card if present, else null.
- counterparty: the other party — payee/merchant/VPA for a debit, sender/source for a credit. Keep it as written (e.g. "swiggy@okicici", "AMAZON", "BANK OF AMERICA"). null if none.
- upi_ref / reference / transaction number if present, else null.
- balance_after: available balance after the txn as a number, else null.
- bank: short lowercase id of the user's bank from the sender/text (e.g. "icici","hdfc","sbi","axis","kotak","bob"). Best guess; "other" if unclear.

STEP 3 — Induce a template regex that matches THIS sms and every future sms of the same format:
- JavaScript regex (will run case-insensitively). Escape all literal punctuation. Use [\\\\d,]+ for money, [\\\\s\\\\S] (not .) to cross newlines, \\\\d for digits, \\\\S+ for tokens. Anchor with surrounding literal words from the template so it can't match unrelated SMS.
- Put each variable field in its own ( ) capture group. Report 1-based group indices in "groups" (the index into a JS String.match array). Use null for any field this format does not contain.
- Keep it LINEAR — no nested or adjacent unbounded quantifiers (no (a+)+, .*.*, (.*)* ), no backreferences. Prefer specific character classes over .* .
- date_format: one of "DD-MM-YY","DD-MM-YYYY","DD/MM/YY","DD/MM/YYYY","DD.MM.YY","DD.MM.YYYY","DD-MON-YY","DD-MON-YYYY","YYYY-MM-DD","YYYYMMDD" describing the captured date group, or null if no date group. MON = 3-letter month name.
- type: "debit" or "credit" (fixed for this template).

EXAMPLE A
SMS: "Dear Customer, Rs.450.00 debited from A/c XX9012 on 14-05-26 to swiggy@okhdfcbank UPI Ref 451237812345. Avl Bal Rs.12,300.50 -ABC Bank"
{"is_transaction":true,"transaction":{"amount":450,"type":"debit","date":"2026-05-14","account_last4":"9012","counterparty":"swiggy@okhdfcbank","upi_ref":"451237812345","balance_after":12300.50,"bank":"other"},"template":{"regex":"Rs\\\\.?\\\\s*([\\\\d,]+\\\\.?\\\\d*) debited from A/c XX(\\\\d+) on (\\\\d{2}-\\\\d{2}-\\\\d{2}) to (\\\\S+) UPI Ref (\\\\d+)\\\\. Avl Bal Rs\\\\.?\\\\s*([\\\\d,]+\\\\.?\\\\d*)","groups":{"amount":1,"account_last4":2,"date":3,"counterparty":4,"upi_ref":5,"balance_after":6},"date_format":"DD-MM-YY","type":"debit","bank":"other"}}

EXAMPLE B
SMS: "Your A/c XX4471 is credited INR 51,000.00 on 01-May-26 by NEFT from BANK OF AMERICA. Ref N123456789. -XYZ"
{"is_transaction":true,"transaction":{"amount":51000,"type":"credit","date":"2026-05-01","account_last4":"4471","counterparty":"BANK OF AMERICA","upi_ref":"N123456789","balance_after":null,"bank":"other"},"template":{"regex":"A/c XX(\\\\d+) is credited INR ([\\\\d,]+\\\\.?\\\\d*) on (\\\\d{1,2}-[A-Za-z]{3}-\\\\d{2}) by NEFT from ([\\\\s\\\\S]+?)\\\\. Ref (\\\\w+)","groups":{"amount":2,"account_last4":1,"date":3,"counterparty":4,"upi_ref":5,"balance_after":null},"date_format":"DD-MON-YY","type":"credit","bank":"other"}}`;

const EXTRACTION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    is_transaction: { type: "boolean" },
    transaction: {
      type: ["object", "null"],
      additionalProperties: false,
      properties: {
        amount: { type: "number" },
        type: { type: "string", enum: ["debit", "credit"] },
        date: { type: ["string", "null"] },
        account_last4: { type: ["string", "null"] },
        counterparty: { type: ["string", "null"] },
        upi_ref: { type: ["string", "null"] },
        balance_after: { type: ["number", "null"] },
        bank: { type: ["string", "null"] },
      },
      required: ["amount", "type", "date", "account_last4", "counterparty", "upi_ref", "balance_after", "bank"],
    },
    template: {
      type: ["object", "null"],
      additionalProperties: false,
      properties: {
        regex: { type: "string" },
        groups: {
          type: "object",
          additionalProperties: false,
          properties: {
            amount: { type: ["integer", "null"] },
            account_last4: { type: ["integer", "null"] },
            date: { type: ["integer", "null"] },
            counterparty: { type: ["integer", "null"] },
            upi_ref: { type: ["integer", "null"] },
            balance_after: { type: ["integer", "null"] },
          },
          required: ["amount", "account_last4", "date", "counterparty", "upi_ref", "balance_after"],
        },
        date_format: { type: ["string", "null"] },
        type: { type: "string", enum: ["debit", "credit"] },
        bank: { type: ["string", "null"] },
      },
      required: ["regex", "groups", "date_format", "type", "bank"],
    },
  },
  required: ["is_transaction", "transaction", "template"],
};

// Captured date substring + format token → ISO YYYY-MM-DD. Falls back to
// today's date if it can't parse (never throws — keeps ingestion flowing).
function normalizeLearnedDate(raw, fmt) {
  if (!raw) return todayDate();
  const s = String(raw).trim();
  try {
    if (fmt === "YYYY-MM-DD") {
      const m = s.match(/(\d{4})\D(\d{1,2})\D(\d{1,2})/);
      if (m) return `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
    }
    if (fmt === "YYYYMMDD") {
      const m = s.match(/(\d{4})(\d{2})(\d{2})/);
      if (m) return `${m[1]}-${m[2]}-${m[3]}`;
    }
    // Day-first: DD<sep>MM<sep>YY(YY) or DD<sep>MON<sep>YY(YY)
    const m = s.match(/(\d{1,2})\W+([A-Za-z]{3}|\d{1,2})\W+(\d{2,4})/);
    if (m) {
      const day = m[1].padStart(2, "0");
      let mon;
      if (/^[A-Za-z]{3}$/.test(m[2])) {
        const key = m[2][0].toUpperCase() + m[2].slice(1).toLowerCase();
        mon = MONTHS[key] || MONTHS[m[2].toUpperCase()];
      } else {
        mon = m[2].padStart(2, "0");
      }
      let yr = m[3];
      if (yr.length === 2) yr = "20" + yr;
      if (mon && +mon >= 1 && +mon <= 12 && +day >= 1 && +day <= 31) {
        return `${yr}-${mon}-${day}`;
      }
    }
  } catch (_) { /* fall through */ }
  return todayDate();
}

// Reject model-generated regexes that could ReDoS the function. SMS is
// already length-capped (≤2048) upstream; this blocks pathological patterns.
function isSafeRegex(p) {
  if (typeof p !== "string") return false;
  if (p.length < 8 || p.length > 600) return false;
  if (/(\*\*|\+\+|\*\+|\+\*)/.test(p)) return false;            // adjacent unbounded quantifiers
  if (/\([^()]*[+*][^()]*\)\s*[+*]/.test(p)) return false;       // quantified group w/ inner quantifier: (a+)+
  if (/\{\d+,\}\s*[+*]/.test(p)) return false;                   // {n,} followed by + / *
  if (/\\\d/.test(p) || /\(\?R\)|\(\?\d/.test(p)) return false;  // backreferences / recursion
  return true;
}

// Build the standard parsed-txn object (same shape the regex patterns emit)
// from an extracted transaction — shared by the template path and the LLM
// path so everything downstream (self-transfer, rules, dedupe) is identical.
function buildParsedFromExtraction(ext, sms, via) {
  const amount = Number(ext.amount);
  const type = ext.type === "credit" ? "credit" : "debit";
  const counterparty = cleanUpiId((ext.counterparty || "").toString().trim());
  const upiRef = (ext.upi_ref || "").toString().trim();
  const acct = (ext.account_last4 || "").toString().replace(/\D/g, "");
  const date = ext.date || todayDate();
  const dedup = upiRef
    ? "lt_" + upiRef
    : "lt_" + crypto.createHash("sha1")
        .update([type, date, amount, counterparty, acct].join("|"))
        .digest("hex").substring(0, 20);
  return {
    raw_sms: sms,
    bank: (ext.bank || "other").toString().toLowerCase().replace(/[^a-z0-9]/g, "").substring(0, 16) || "other",
    account: acct,
    amount,
    date,
    type,
    category: null, category_type: null,
    recipient: type === "debit" ? counterparty : "",
    source: type === "credit" ? counterparty : "",
    source_account: "",
    note: counterparty || (type === "credit" ? "Credit" : "Debit"),
    upi_ref: upiRef,
    balance_after: (ext.balance_after === null || ext.balance_after === undefined || ext.balance_after === "")
      ? null : Number(ext.balance_after),
    created_at: new Date().toISOString(),
    dedup_key: dedup,
    parsed_via: via,
  };
}

// Try this user's previously-learned templates. Pure regex, no API call.
function matchLearnedTemplates(sms, templateDocs) {
  for (const t of templateDocs) {
    const d = t.data || {};
    if (!d.regex || !isSafeRegex(d.regex)) continue;
    let re, m;
    try { re = new RegExp(d.regex, "i"); } catch (_) { continue; }
    try { m = sms.match(re); } catch (_) { continue; }
    if (!m) continue;
    const g = d.groups || {};
    const gv = (i) => (i && m[i] != null ? String(m[i]).trim() : null);
    const amtRaw = gv(g.amount);
    if (!amtRaw) continue;
    const amount = parseFloat(amtRaw.replace(/,/g, ""));
    if (!isFinite(amount) || amount <= 0) continue;
    const balRaw = gv(g.balance_after);
    const ext = {
      amount,
      type: d.type === "credit" ? "credit" : "debit",
      date: g.date ? normalizeLearnedDate(gv(g.date), d.date_format) : todayDate(),
      account_last4: gv(g.account_last4),
      counterparty: gv(g.counterparty),
      upi_ref: gv(g.upi_ref),
      balance_after: balRaw ? parseFloat(balRaw.replace(/,/g, "")) : null,
      bank: d.bank || "other",
    };
    return { parsed: buildParsedFromExtraction(ext, sms, "template"), templateId: t.id };
  }
  return null;
}

// Gate before persisting an induced template: it must compile, match the
// teaching SMS, and re-extract the SAME amount the model reported. This
// proves the regex targets the right field rather than just "matching".
function validateLearnedTemplate(tpl, sms, txn) {
  if (!tpl || !tpl.regex || !isSafeRegex(tpl.regex)) return false;
  const g = tpl.groups || {};
  if (!g.amount) return false;
  let re, m;
  try { re = new RegExp(tpl.regex, "i"); } catch (_) { return false; }
  try { m = sms.match(re); } catch (_) { return false; }
  if (!m || m[g.amount] == null) return false;
  const capAmt = parseFloat(String(m[g.amount]).replace(/,/g, ""));
  if (!isFinite(capAmt)) return false;
  if (Math.abs(capAmt - Number(txn.amount)) > 0.01) return false;
  if (g.date && m[g.date] == null) return false;
  return true;
}

// One-time teacher call. Returns {transaction, template} on success,
// {notTransaction:true} for non-txn SMS, or null on any error (→ skip).
async function learnViaLLM(sms, apiKey) {
  if (!apiKey) return null;
  const client = new Anthropic({ apiKey });
  let resp;
  try {
    resp = await client.messages.create({
      model: "claude-haiku-4-5",
      max_tokens: 1024,
      system: [{ type: "text", text: LEARN_SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: "Bank SMS:\n```\n" + sms + "\n```" }],
      output_config: { format: { type: "json_schema", schema: EXTRACTION_SCHEMA } },
    });
  } catch (err) {
    console.error("LLM learn call failed:", (err && err.message) || err);
    return null;
  }
  if (resp.stop_reason === "refusal") return { notTransaction: true };
  let txt = "";
  for (const b of (resp.content || [])) if (b.type === "text") txt += b.text;
  let data;
  try {
    data = JSON.parse(txt);
  } catch (_) {
    const mm = txt.match(/\{[\s\S]*\}/);
    if (!mm) return null;
    try { data = JSON.parse(mm[0]); } catch (_) { return null; }
  }
  if (!data || data.is_transaction !== true || !data.transaction) {
    return { notTransaction: true };
  }
  return { transaction: data.transaction, template: data.template || null };
}

// ── HTTPS Cloud Function ──
exports.parseSms = onRequest({ cors: ["https://viyas52.github.io"], region: "asia-south1", secrets: [ANTHROPIC_API_KEY] }, async (req, res) => {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  // ── User ID (required for multi-user routing) ──
  const userId = req.body.user || req.body.userId || req.query.user;
  if (!userId || typeof userId !== "string") {
    return res.status(400).json({ error: "Missing user" });
  }
  const effectiveUser = userId;

  // ── Load per-user config ──
  let userConfig;
  try {
    userConfig = await loadUserConfig(effectiveUser);
  } catch (err) {
    console.error("Failed to load user config:", err);
    return res.status(500).json({ error: "Failed to load user config" });
  }

  // ── API key validation (header only — never via query string) ──
  if (!userConfig.apiKey) return res.status(401).json({ error: "User not provisioned" });
  const key = req.headers["x-api-key"];
  if (key !== userConfig.apiKey) return res.status(401).json({ error: "Invalid API key" });

  // ── Coarse per-user rate limit ──
  if (!(await checkRateLimit(effectiveUser))) {
    return res.status(429).json({ error: "Rate limit exceeded" });
  }

  const sms = req.body.sms || req.body.message || "";
  if (!sms || typeof sms !== "string") return res.status(400).json({ error: "No SMS text provided" });
  if (sms.length > 2048) return res.status(413).json({ error: "SMS too large" });

  // ── Parse SMS with per-user account mapping ──
  const acctToBank = (acct) => acctToBankDynamic(acct, userConfig.acctBankMap);
  let parsed = parseSms(sms, acctToBank);

  // ── Hybrid fallback: built-in regex missed ──
  // 1) try this user's previously-learned templates (pure regex, no API)
  // 2) on a template miss, ask Claude ONCE to extract + induce a reusable
  //    regex template, validate it, and persist it — so we never call the
  //    API again for this format. Steady state ≈ zero API calls.
  if (!parsed) {
    let templateDocs = [];
    try {
      const tSnap = await db.collection(`users/${effectiveUser}/parser_templates`).get();
      templateDocs = tSnap.docs.map((d) => ({ id: d.id, data: d.data() }));
    } catch (_) { /* no templates yet */ }

    const tMatch = matchLearnedTemplates(sms, templateDocs);
    if (tMatch) {
      parsed = tMatch.parsed;
      const prev = templateDocs.find((t) => t.id === tMatch.templateId);
      db.doc(`users/${effectiveUser}/parser_templates/${tMatch.templateId}`)
        .set({ hit_count: ((prev && prev.data && prev.data.hit_count) || 0) + 1,
               last_used: new Date().toISOString() }, { merge: true })
        .catch(() => {});
    } else if (userConfig.llmEnabled) {
      const learned = await learnViaLLM(sms, ANTHROPIC_API_KEY.value());
      if (learned && learned.transaction) {
        const txn = learned.transaction;
        const amt = Number(txn.amount);
        if (isFinite(amt) && amt > 0 && (txn.type === "debit" || txn.type === "credit")) {
          parsed = buildParsedFromExtraction(txn, sms, "llm");
          // Persist the induced template only if it provably re-extracts the
          // same amount. If not, this txn is still saved (money captured) and
          // we simply re-learn next time — rare and self-correcting.
          if (learned.template && validateLearnedTemplate(learned.template, sms, txn)) {
            const tpl = learned.template;
            const tplId = crypto.createHash("sha1")
              .update((tpl.bank || "other") + "|" + tpl.regex)
              .digest("hex").substring(0, 24);
            db.doc(`users/${effectiveUser}/parser_templates/${tplId}`).set({
              regex: tpl.regex,
              groups: tpl.groups || {},
              date_format: tpl.date_format || null,
              type: tpl.type === "credit" ? "credit" : "debit",
              bank: (tpl.bank || "other").toString().toLowerCase().substring(0, 24),
              sample_sms: sms.substring(0, 400),
              created_at: new Date().toISOString(),
              source: "llm",
              hit_count: 0,
            }, { merge: true }).catch((e) => console.error("template save failed:", (e && e.message) || e));
          }
        }
      }
    }
  }

  if (!parsed) {
    // Not a recognised txn (LLM off, said "not a transaction", or errored).
    // Privacy: don't persist the SMS — log a short prefix only.
    console.warn("SMS not recognized:", sms.substring(0, 120));
    return res.status(200).json({ status: "skipped", reason: "SMS format not recognized" });
  }

  // ── Filter by linked accounts ──
  // If the user has added any Linked Accounts in Settings, only process SMS
  // that match one of those accounts. This way a user can opt in to tracking
  // just specific accounts (e.g. only HDFC, ignore the other banks they get
  // SMS from). If no accounts are linked yet, accept all parsed SMS.
  if (userConfig.linkedAccounts && userConfig.linkedAccounts.length > 0 && parsed.account) {
    const parsedDigits = String(parsed.account).replace(/\D/g, "");
    const parsedTail = parsedDigits.slice(-4);
    const matches = userConfig.linkedAccounts.some(la => {
      if (!la || !la.last4) return false;
      const linkedTail = String(la.last4).replace(/\D/g, "").slice(-4);
      if (!linkedTail || !parsedTail) return false;
      return parsedTail === linkedTail
          || parsedTail.endsWith(linkedTail)
          || linkedTail.endsWith(parsedTail);
    });
    if (!matches) {
      // Save the rejected SMS as a one-tap-link suggestion so the PWA can
      // pop a banner: "ICICI ••489 detected — Tap to link". Deduped by
      // bank+last4 so multiple SMS for the same unlinked account merge.
      try {
        const sugHash = crypto.createHash("sha1")
          .update((parsed.bank || "?") + ":" + parsedTail)
          .digest("hex").substring(0, 16);
        await db.collection(`users/${effectiveUser}/suggested_accounts`).doc(sugHash).set({
          bank: parsed.bank || "?",
          last4: parsedTail,
          first_seen: new Date().toISOString(),
          sample_amount: parsed.amount || 0,
          sample_recipient: parsed.recipient || parsed.source || "",
        }, { merge: true });
      } catch (_) { /* non-critical */ }
      return res.status(200).json({
        status: "skipped",
        reason: "account_not_linked",
        account: "XX" + parsedTail,
      });
    }
  }

  // ── Auto-categorize pipeline ──
  // 1. Self-transfer (highest priority — structural)
  if (isSelfTransfer(parsed, userConfig.selfNamesRx, userConfig.selfAccounts)) {
    parsed.category = "Self Transfer";
    parsed.category_type = "transfer";
    {
      const from = parsed.type === "debit" ? (parsed.bank || "").toUpperCase() : (parsed.bank_from || "").toUpperCase();
      const to   = parsed.type === "debit" ? (parsed.bank_to || "").toUpperCase() : (parsed.bank || "").toUpperCase();
      parsed.note = (from || "?") + " → " + (to || "?");
    }
    parsed.recipient = "";
    parsed.source    = "";
  } else {
    // 2. User-defined rules (per-user subcollection)
    let autoTagged = false;
    if (parsed.type === "debit") {
      const k = normalizeKey(parsed.recipient);
      if (k) {
        const ruleSnap = await db.collection(`users/${effectiveUser}/rules`).doc(k).get();
        if (ruleSnap.exists) {
          const rule = ruleSnap.data();
          // Apply the rule regardless of legacy `contact` flag — the "Person"
          // feature was removed because contact-tagged txns vanished from the UI.
          parsed.category = rule.category;
          parsed.category_type = rule.category_type;
          autoTagged = true;
        }
      }
    }
    // 3. SIP / auto-debit detection
    if (!autoTagged) {
      const sip = detectSip(parsed);
      if (sip) {
        parsed.category = sip.category;
        parsed.category_type = sip.category_type;
        autoTagged = true;
      }
    }
    // 4. Built-in regex fallback
    if (!autoTagged) {
      const text = parsed.type === "credit" ? parsed.source : parsed.recipient;
      for (const rule of BUILTIN_RULES) {
        if (rule.type === parsed.type && rule.match.test(text || "")) {
          parsed.category = rule.category;
          parsed.category_type = rule.category_type;
          break;
        }
      }
    }
  }

  // ── Dedupe + write to per-user subcollection ──
  try {
    const txnCol = `users/${effectiveUser}/transactions`;
    const docRef = db.collection(txnCol).doc(parsed.dedup_key);
    await docRef.create(parsed);

    // ── Auto-create paired leg for self-transfers ──
    // When we see a debit self-transfer with a known destination bank,
    // create the credit leg automatically (the destination bank may not send an SMS)
    let pairedId = null;
    if (parsed.category_type === "transfer" && parsed.category === "Self Transfer") {
      const destBank = parsed.type === "debit" ? parsed.bank_to : null;
      const srcBank  = parsed.type === "credit" ? parsed.bank_from : null;
      const otherBank = destBank || srcBank;

      if (otherBank) {
        const pairedType = parsed.type === "debit" ? "credit" : "debit";

        // Skip the auto-pair if the destination bank's own SMS already arrived
        // and created the real leg (same upi_ref, opposite type).
        let realLegExists = false;
        if (parsed.upi_ref) {
          try {
            const existing = await db.collection(txnCol)
              .where("upi_ref", "==", parsed.upi_ref)
              .where("type", "==", pairedType)
              .limit(1).get();
            realLegExists = !existing.empty;
          } catch (_) { /* index missing — fall through to dedup_key collision */ }
        }
        if (realLegExists) {
          // Real leg present; don't double-count.
          return res.status(200).json({
            status: "saved", id: docRef.id, user: effectiveUser,
            bank: parsed.bank, type: parsed.type,
            amount: parsed.amount, date: parsed.date,
            category: parsed.category, category_type: parsed.category_type,
            recipient: parsed.recipient || parsed.source,
          });
        }
        const pairedKey  = parsed.dedup_key + "_paired";
        const paired = {
          raw_sms: "", bank: otherBank, account: "",
          amount: parsed.amount, date: parsed.date,
          type: pairedType, category: "Self Transfer", category_type: "transfer",
          recipient: "", source: "",
          source_account: "", balance_after: null,
          note: pairedType === "credit"
            ? (parsed.bank || "?").toUpperCase() + " → " + (otherBank || "?").toUpperCase()
            : (otherBank || "?").toUpperCase() + " → " + (parsed.bank || "?").toUpperCase(),
          upi_ref: parsed.upi_ref || "",
          created_at: parsed.created_at,
          dedup_key: pairedKey,
          auto_paired: true, // flag so we know this was auto-generated
        };
        try {
          const pairedRef = db.collection(txnCol).doc(pairedKey);
          await pairedRef.create(paired);
          pairedId = pairedRef.id;
        } catch (pairErr) {
          // Duplicate is fine — the other bank's SMS may have already created it
          if (pairErr.code !== 6 && !/already exists/i.test(pairErr.message || "")) {
            console.error("Failed to create paired leg:", pairErr);
          }
        }
      }
    }

    return res.status(200).json({
      status: "saved", id: docRef.id, user: effectiveUser,
      bank: parsed.bank, type: parsed.type,
      amount: parsed.amount, date: parsed.date,
      category: parsed.category, category_type: parsed.category_type,
      recipient: parsed.recipient || parsed.source,
      paired: pairedId || undefined,
    });
  } catch (err) {
    if (err.code === 6 || /already exists/i.test(err.message || "")) {
      return res.status(200).json({
        status: "duplicate", id: parsed.dedup_key,
        bank: parsed.bank, type: parsed.type,
        amount: parsed.amount, date: parsed.date,
      });
    }
    console.error("Firestore write failed:", err);
    return res.status(500).json({ error: "Firestore write failed" });
  }
});

// ── Admin usage stats (owner-only). ──
// Auth: Firebase ID token in `Authorization: Bearer <token>`; the token's uid
// must equal OWNER_UID (set in functions/.env — gitignored — at cutover).
// No query-string secrets; CORS limited to the PWA origin.
exports.adminStats = onRequest({ cors: ["https://viyas52.github.io"], region: "asia-south1" }, async (req, res) => {
  const OWNER_UID = process.env.OWNER_UID || "";
  if (!OWNER_UID) return res.status(503).json({ error: "Not configured" });

  const authz = req.headers.authorization || "";
  const m = authz.match(/^Bearer (.+)$/i);
  if (!m) return res.status(401).json({ error: "Missing token" });
  let decoded;
  try {
    decoded = await adminAuth.verifyIdToken(m[1]);
  } catch (_) {
    return res.status(401).json({ error: "Invalid token" });
  }
  if (decoded.uid !== OWNER_UID) return res.status(403).json({ error: "Forbidden" });

  try {
    const unameSnap = await db.collection("usernames").get();
    const authSnap = await db.collection("auth_users").get();
    const usernames = unameSnap.docs.map(d => d.id);
    const rows = [];
    for (const u of usernames) {
      const [txnAgg, ruleAgg, prof, acct] = await Promise.all([
        db.collection(`users/${u}/transactions`).count().get().catch(() => null),
        db.collection(`users/${u}/rules`).count().get().catch(() => null),
        db.doc(`users/${u}/config/profile`).get().catch(() => null),
        db.doc(`users/${u}/config/accounts`).get().catch(() => null),
      ]);
      const txns = txnAgg ? txnAgg.data().count : 0;
      const rules = ruleAgg ? ruleAgg.data().count : 0;
      const pf = prof && prof.exists ? prof.data() : {};
      const linked = acct && acct.exists ? (acct.data().linked_accounts || []) : [];
      let lastTxn = "-";
      if (txns > 0) {
        const recent = await db.collection(`users/${u}/transactions`).orderBy("created_at", "desc").limit(1).get().catch(() => null);
        if (recent && !recent.empty) lastTxn = String(recent.docs[0].data().created_at || "").substring(0, 10);
      }
      rows.push({
        username: u, name: pf.name || "-", email: pf.email || "-",
        txns, rules, banks: linked.length,
        created: String(pf.created_at || "").substring(0, 10) || "-",
        lastTxn,
      });
    }
    rows.sort((a, b) => b.txns - a.txns);
    res.json({
      usernames: usernames.length,
      authUsers: authSnap.size,
      activeUsers: rows.filter(r => r.txns > 0).length,
      totalTxns: rows.reduce((s, r) => s + r.txns, 0),
      users: rows,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
