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

function parseDate(raw) {
  const [day, mon, yr] = raw.split("-");
  return `20${yr}-${MONTHS[mon]}-${day}`;
}

function parseSms(sms) {
  // Try debit first
  const dm = sms.match(DEBIT_RX);
  if (dm) {
    return {
      raw_sms: sms,
      amount: parseFloat(dm[1].replace(/,/g, "")),
      date: parseDate(dm[2]),
      type: "debit",
      category: null,
      category_type: null,
      recipient: dm[3],
      upi_ref: dm[4],
      note: dm[3],
      source: "",
      balance_after: null,
      created_at: new Date().toISOString(),
    };
  }

  // Try credit
  const cm = sms.match(CREDIT_RX);
  if (cm) {
    return {
      raw_sms: sms,
      amount: parseFloat(cm[1].replace(/,/g, "")),
      date: parseDate(cm[2]),
      type: "credit",
      category: null,
      category_type: null,
      recipient: "",
      upi_ref: "",
      note: cm[3],
      source: cm[3],
      balance_after: parseFloat(cm[4].replace(/,/g, "")),
      created_at: new Date().toISOString(),
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

  // Write to Firestore
  try {
    const docRef = await db.collection("personal_transactions").add(parsed);
    return res.status(200).json({
      status: "saved",
      id: docRef.id,
      type: parsed.type,
      amount: parsed.amount,
      date: parsed.date,
      recipient: parsed.recipient || parsed.source,
    });
  } catch (err) {
    console.error("Firestore write failed:", err);
    return res.status(500).json({ error: "Firestore write failed" });
  }
});
