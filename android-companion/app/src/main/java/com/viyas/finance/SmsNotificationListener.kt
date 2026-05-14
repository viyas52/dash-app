package com.viyas.finance

import android.app.Notification
import android.content.Context
import android.service.notification.NotificationListenerService
import android.service.notification.StatusBarNotification
import android.util.Log
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import org.json.JSONArray
import org.json.JSONObject

/**
 * Listens to notifications from messaging apps and bank apps,
 * filters for transactional content, and forwards to the cloud function.
 * Also records every event (forwarded, filtered, dedup-dropped, error) to
 * a SharedPreferences log so MainActivity can show diagnostics.
 */
class SmsNotificationListener : NotificationListenerService() {

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val recentHashes = ArrayDeque<Int>()
    private val maxRecent = 60

    // Packages we care about. Messaging apps + major Indian bank apps.
    // UPI apps (GPay/PhonePe/Paytm/BHIM) are intentionally excluded — their
    // notifications lack parseable transaction details and just add diagnostic
    // noise. Bank SMS via the messaging app is the source of truth.
    private val watchedPackages = setOf(
        // SMS apps
        "com.google.android.apps.messaging",
        "com.samsung.android.messaging",
        "com.android.messaging",
        "com.android.mms",
        // Bank apps (sometimes mirror SMS via push; useful backup)
        "com.snapwork.hdfc", "com.csam.icici.bank.imobile",
        "com.sbi.lotusintouch", "com.sbi.SBIFreedomPlus",
        "com.axis.mobile", "com.msf.kbank.mobile",
        "com.fss.indus", "com.idbibank.go", "com.YesBank",
        "com.idfcfirstbank.optimus", "com.snapwork.IDBI"
    )

    // Body keywords that bank/UPI transaction SMS contain
    private val txnRegex = Regex(
        """(?i)(debited|credited|debit|credit|spent|received|deducted|withdrawn|paid|sent|txn|transaction|a/c|acct|rs\.?\s*\d|inr\s*\d|₹\s*\d|upi)"""
    )

    // Bank sender-ID patterns (Indian DLT-registered headers). A real bank SMS
    // title looks like "AD-HDFCBK", "VM-ICICIB", "BP-SBIINB", etc.
    private val bankSenderRegex = Regex(
        """(?i)\b(HDFCB?K?|ICICI[BT]?|SBIINB|SBI(IND)?|SBIBN?K?|AXISB?K?|KOTAK(BK)?|KMBL|IDFCFB|IDBI(BK)?|YESBNK|YES\s?BANK|FEDBNK|FEDERAL|CANBNK|CANARA|PNBSMS|PNB|BOBSMS|BOIIND|IOBIND|UCOBNK|CUBIN?B?|INDBNK|INDIAN\s?BANK|RBL|BOMBNK|UNBNK|CITIN?B?|HSBC|SCBIND|GPAY|PHONEPE|PAYTM|BHIM)\b"""
    )

    override fun onNotificationPosted(sbn: StatusBarNotification) {
        try {
            val pkg = sbn.packageName ?: return
            // Strict: only consider notifications from our watched messaging
            // and bank-app packages. Everything else (WhatsApp, Insta, Gmail,
            // etc.) is dropped here — never read further, never logged.
            if (pkg !in watchedPackages) return

            val extras = sbn.notification.extras ?: return
            val title = extras.getCharSequence(Notification.EXTRA_TITLE)?.toString().orEmpty()
            val text = extras.getCharSequence(Notification.EXTRA_TEXT)?.toString().orEmpty()
            val bigText = extras.getCharSequence(Notification.EXTRA_BIG_TEXT)?.toString().orEmpty()
            val body = listOf(bigText, text).firstOrNull { it.isNotBlank() } ?: return

            // Strict bank-SMS filter: the notification must look like a bank
            // SMS (sender-ID pattern in the title) AND have transaction
            // keywords in the body. This blocks OTPs, promos, personal SMS,
            // and any non-banking notification from being touched at all.
            val titleLooksBank = bankSenderRegex.containsMatchIn(title)
            val bodyLooksTxn = txnRegex.containsMatchIn(body)
            if (!titleLooksBank || !bodyLooksTxn) return  // not a bank txn SMS

            val composed = if (title.isNotBlank()) "$title: $body" else body

            // De-dupe (notification updates fire repeatedly). Don't log dupes
            // — keeps the diagnostics view clean.
            val h = composed.hashCode()
            synchronized(recentHashes) {
                if (h in recentHashes) return
                recentHashes.addFirst(h)
                while (recentHashes.size > maxRecent) recentHashes.removeLast()
            }

            scope.launch {
                val result = SmsForwarder.post(applicationContext, composed)
                Log.i(TAG, "forwarded [$pkg] -> ${result.status}")
                recordEvent(pkg, composed, "forwarded: ${result.status}")
                // If the cloud function saved an uncategorized txn, ping the user.
                result.txn?.let { UncatNotifier.maybeShow(applicationContext, it) }
            }
        } catch (e: Exception) {
            Log.e(TAG, "onNotificationPosted error", e)
            // Only error events are logged outside the happy path. No content
            // from non-bank SMS ever enters the diagnostics store.
            recordEvent(sbn.packageName ?: "unknown", "", "error: ${e.message}")
        }
    }

    private fun recordEvent(pkg: String, body: String, status: String) {
        try {
            val prefs = getSharedPreferences(LOG_PREFS, Context.MODE_PRIVATE)
            val raw = prefs.getString(LOG_KEY, "[]") ?: "[]"
            val arr = try { JSONArray(raw) } catch (e: Exception) { JSONArray() }
            val event = JSONObject().apply {
                put("ts", System.currentTimeMillis())
                put("pkg", pkg)
                put("body", body.take(220))
                put("status", status)
            }
            val newArr = JSONArray()
            newArr.put(event)
            for (i in 0 until arr.length()) {
                if (newArr.length() >= 40) break
                newArr.put(arr.get(i))
            }
            prefs.edit().putString(LOG_KEY, newArr.toString()).apply()
        } catch (e: Exception) {
            Log.e(TAG, "recordEvent failed", e)
        }
    }

    override fun onListenerConnected() {
        Log.i(TAG, "listener connected")
        recordEvent("__system__", "", "listener connected")
    }

    override fun onListenerDisconnected() {
        Log.i(TAG, "listener disconnected")
        recordEvent("__system__", "", "listener disconnected")
    }

    companion object {
        private const val TAG = "FinanceListener"
        const val LOG_PREFS = "finance_logs"
        const val LOG_KEY = "events"
    }
}
