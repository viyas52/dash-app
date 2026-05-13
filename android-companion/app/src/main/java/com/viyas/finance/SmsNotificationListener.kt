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

    // Packages we care about. Messaging apps + major Indian bank/UPI apps.
    private val watchedPackages = setOf(
        // SMS apps
        "com.google.android.apps.messaging",
        "com.samsung.android.messaging",
        "com.android.messaging",
        "com.android.mms",
        // Banks
        "com.snapwork.hdfc", "com.csam.icici.bank.imobile",
        "com.sbi.lotusintouch", "com.sbi.SBIFreedomPlus",
        "com.axis.mobile", "com.msf.kbank.mobile",
        "com.fss.indus", "com.idbibank.go", "com.YesBank",
        "com.idfcfirstbank.optimus", "com.snapwork.IDBI",
        // UPI
        "com.google.android.apps.nbu.paisa.user", // GPay
        "com.phonepe.app", "net.one97.paytm",
        "in.org.npci.upiapp", "com.bhim.app"
    )

    // Quick filter: only forward if the text looks like a bank txn.
    private val txnRegex = Regex(
        """(?i)(debited|credited|debit|credit|spent|received|deducted|withdrawn|paid|sent|txn|transaction|a/c|acct|rs\.?\s*\d|inr\s*\d|₹\s*\d|upi)"""
    )

    override fun onNotificationPosted(sbn: StatusBarNotification) {
        try {
            val pkg = sbn.packageName ?: return
            val isWatched = pkg in watchedPackages

            val extras = sbn.notification.extras ?: return
            val title = extras.getCharSequence(Notification.EXTRA_TITLE)?.toString().orEmpty()
            val text = extras.getCharSequence(Notification.EXTRA_TEXT)?.toString().orEmpty()
            val bigText = extras.getCharSequence(Notification.EXTRA_BIG_TEXT)?.toString().orEmpty()
            val body = listOf(bigText, text).firstOrNull { it.isNotBlank() } ?: return

            val composed = if (title.isNotBlank()) "$title: $body" else body
            val hasTxnKeyword = txnRegex.containsMatchIn(composed)

            // Skip silently if not watched AND no txn keyword (random notification noise)
            if (!isWatched && !hasTxnKeyword) return

            if (!hasTxnKeyword) {
                recordEvent(pkg, composed, "filtered: no txn keyword")
                return
            }

            // De-dupe (notification updates fire repeatedly)
            val h = composed.hashCode()
            synchronized(recentHashes) {
                if (h in recentHashes) {
                    recordEvent(pkg, composed, "dropped: duplicate")
                    return
                }
                recentHashes.addFirst(h)
                while (recentHashes.size > maxRecent) recentHashes.removeLast()
            }

            scope.launch {
                val res = SmsForwarder.post(applicationContext, composed)
                Log.i(TAG, "forwarded [$pkg] -> $res")
                recordEvent(pkg, composed, "forwarded: $res")
            }
        } catch (e: Exception) {
            Log.e(TAG, "onNotificationPosted error", e)
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
