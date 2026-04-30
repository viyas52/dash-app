const { onRequest } = require("firebase-functions/v2/https");
const { initializeApp } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");

initializeApp();
const db = getFirestore();

// ── Simple API key (change this to something unique) ──
const API_KEY = "myfinance_viyas_2026";

// ── ICICI SMS Regex Patterns ──
const DEBIT_RX = /ICICI Bank Acct XX\d+ debited for Rs\.? ([\d,]+\.?\d*) on (\d{2}-\w{3}-\d{2}); (.+?) credited\. UPI:(\d+)/;
const CREDIT_RX = /ICICI Bank Account XX\d+ credited:Rs\. ([\d,]+\.\d{2}) on (\d{2}-\w{3}-\d{2})\. Info (.+?)\. Available Balance is Rs\. ([\d,]+\.\d{2})/;

const MONTHS = { Jan:"01", Feb:"02", Mar:"03", Apr:"04", May:"05", Jun:"06",
                 Jul:"07", Aug:"08", Sep:"09", Oct:"10", Nov:"11", Dec:"12" };

// ── Built-in regex rules — fallback for recurring items the user hasn't tagged yet ──
// User-defined rules in `personal_rules` take precedence over these.
const BUILTIN_RULES = [
  { type: "credit", match: /BA CON|BANK\s*OF\s*AMERICA/i, category: "Salary", category_type: "income" },
];

function normalizeKey(s) {
  return (s || "").trim().toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

function parseDate(raw) {
  const [day, mon, yr] = raw.split("-");
  return `20${yr}-${MONTHS[mon]}-${day}`;
}

function parseSms(sms) {
  // Try debit first
  const dm = sms.match(DEBIT_RX);
  if (dm) {
    const upi_ref = dm[4];
    return {
      raw_sms: sms,
      amount: parseFloat(dm[1].replace(/,/g, "")),
      date: parseDate(dm[2]),
      type: "debit",
      category: null,
      category_type: null,
      recipient: dm[3],
      upi_ref,
      note: dm[3],
      source: "",
      balance_after: null,
      created_at: new Date().toISOString(),
      dedup_key: "d_" + upi_ref,
    };
  }

  // Try credit
  const cm = sms.match(CREDIT_RX);
  if (cm) {
    const amount = parseFloat(cm[1].replace(/,/g, ""));
    const date = parseDate(cm[2]);
    const balance = parseFloat(cm[4].replace(/,/g, ""));
    return {
      raw_sms: sms,
      amount,
      date,
      type: "credit",
      category: null,
      category_type: null,
      recipient: "",
      upi_ref: "",
      note: cm[3],
      source: cm[3],
      balance_after: balance,
      created_at: new Date().toISOString(),
      dedup_key: "c_" + date + "_" + amount + "_" + balance,
    };
  }

  return null;
}

// ── HTTPS Cloud Function ──
exports.parseSms = onRequest({ cors: true, region: "asia-south1" }, async (req, res) => {
  // Only POST
  if (req.method !== "POST") {
    return res.status(405).json({ error: "POST only" });
  }

  // API key check
  const key = req.headers["x-api-key"] || req.query.key;
  if (key !== API_KEY) {
    return res.status(401).json({ error: "Invalid API key" });
  }

  // Get SMS text
  const sms = req.body.sms || req.body.message || "";
  if (!sms) {
    return res.status(400).json({ error: "No SMS text provided" });
  }

  // Parse
  const parsed = parseSms(sms);
  if (!parsed) {
    return res.status(200).json({ status: "skipped", reason: "SMS format not recognized" });
  }

  // Auto-categorize: user rules first (debits), then built-in regex fallback.
  let autoTagged = false;
  if (parsed.type === "debit") {
    const key = normalizeKey(parsed.recipient);
    if (key) {
      const ruleSnap = await db.collection("personal_rules").doc(key).get();
      if (ruleSnap.exists) {
        const rule = ruleSnap.data();
        parsed.category = rule.category;
        parsed.category_type = rule.category_type;
        autoTagged = true;
      }
    }
  }
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

  // Dedupe by deterministic doc ID — .create() fails atomically if it already exists.
  try {
    const docRef = db.collection("personal_transactions").doc(parsed.dedup_key);
    await docRef.create(parsed);
    return res.status(200).json({
      status: "saved",
      id: docRef.id,
      type: parsed.type,
      amount: parsed.amount,
      date: parsed.date,
      recipient: parsed.recipient || parsed.source,
    });
  } catch (err) {
    if (err.code === 6 || /already exists/i.test(err.message || "")) {
      return res.status(200).json({
        status: "duplicate",
        id: parsed.dedup_key,
        type: parsed.type,
        amount: parsed.amount,
        date: parsed.date,
      });
    }
    console.error("Firestore write failed:", err);
    return res.status(500).json({ error: "Firestore write failed" });
  }
});
