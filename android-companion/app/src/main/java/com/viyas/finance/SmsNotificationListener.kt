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

    // Messaging-app packages (default SMS apps across OEMs). Anything from
    // these is *considered* — final forward decision is made by the body-keyword
    // + OTP check below. We don't require the notification title to be a DLT
    // sender ID, because many OEMs (Samsung, MIUI, ColorOS) put "Messages" or
    // a conversation name in EXTRA_TITLE and bury the sender ID in subText.
    private val messagingPackages = setOf(
        "com.google.android.apps.messaging",
        "com.samsung.android.messaging",
        "com.android.messaging",
        "com.android.mms",
        "com.miui.smsextra",         // some MIUI variants
        "com.coloros.mms",           // Oppo / Realme / ColorOS
        "com.oneplus.mms",           // OnePlus (older OxygenOS)
        "com.oppo.mms",
        "com.vivo.smsobserver",      // Vivo
        "com.asus.message",          // Asus
        "com.huawei.message",        // Huawei
        "com.truecaller",            // when user sets Truecaller as default SMS
        "com.jio.join"               // JioCall/JioMessages
    )

    // Bank-app packages — sometimes mirror SMS via push; useful backup.
    // UPI apps (GPay/PhonePe/Paytm/BHIM) are intentionally excluded — their
    // notifications lack parseable transaction details and just add noise.
    private val bankAppPackages = setOf(
        "com.snapwork.hdfc", "com.csam.icici.bank.imobile",
        "com.sbi.lotusintouch", "com.sbi.SBIFreedomPlus",
        "com.axis.mobile", "com.msf.kbank.mobile",
        "com.fss.indus", "com.idbibank.go", "com.YesBank",
        "com.idfcfirstbank.optimus", "com.snapwork.IDBI",
        "com.bankofbaroda.mconnect", "com.cub.cubpaymobile",
        "com.fss.pnbpsp", "com.canarabank.mobility"
    )

    private val watchedPackages = messagingPackages + bankAppPackages

    // Body keywords that bank/UPI transaction SMS contain. This is the PRIMARY
    // gate — if the body has no transactional words and no rupee amount, it's
    // not a txn SMS regardless of who sent it.
    private val txnRegex = Regex(
        """(?i)(debited|credited|debit|credit|spent|received|deducted|withdrawn|paid|sent|txn|transaction|a/c\s*\w|acct|rs\.?\s*\d|inr\s*\d|₹\s*\d|upi)"""
    )

    // OTP / 2FA / promo guard — bodies matching this are dropped even if they
    // contain transaction-looking words ("will be debited if you share this OTP").
    private val otpRegex = Regex(
        """(?i)(\botp\b|one[\s-]?time\s?password|verification\s?code|do\s?not\s?share|secure\s?code|auth\s?code|login\s?code|use\s?\d{4,8}\s?(as|to)|is\s?your\s?(otp|code|verification))"""
    )

    // Bank sender-ID patterns (Indian DLT-registered headers). NOTE: this is
    // no longer a hard gate — it's used only to tag the diagnostic log so we
    // can see at-a-glance whether the title looked like a bank header. Real
    // forwarding is decided by package + body keywords + OTP guard.
    private val bankSenderRegex = Regex(
        """(?i)\b(HDFCB?K?|ICICI[BT]?|SBIINB|SBI(IND)?|SBIBN?K?|AXISB?K?|KOTAK(BK)?|KMBL|IDFCFB|IDFCBK|IDBI(BK)?|YESBNK|YES\s?BANK|FEDBNK|FEDERAL|CANBNK|CANARA|PNBSMS|PNB|BOBSMS|BOBTXN|BARODA|BOIIND|IOBIND|UCOBNK|CUBIN?B?|CUBBNK|CUBANK|INDBNK|INDIAN\s?BANK|RBL|RBLBNK|BOMBNK|UNBNK|UNIONB|CITIN?B?|HSBC|SCBIND|CENTBK|KVBLTD|KARBNK|KARNTK|SIBLBK|DCBBNK|AUBANK|AUSFBL|BANDHN|EQUITS|ESAFBK|UJJVNB|JIOPMT|AIRPYM|FINOPB|INDPST|GPAY|PHONEPE|PAYTM|BHIM)\b"""
    )

    override fun onNotificationPosted(sbn: StatusBarNotification) {
        try {
            val pkg = sbn.packageName ?: return
            // Wrong package = not from a messaging or bank app we care about.
            // These are still dropped silently (no log) because logging every
            // WhatsApp/Insta/Gmail notification would flood the diagnostics.
            if (pkg !in watchedPackages) return

            val extras = sbn.notification.extras ?: return
            val title = extras.getCharSequence(Notification.EXTRA_TITLE)?.toString().orEmpty()
            val text = extras.getCharSequence(Notification.EXTRA_TEXT)?.toString().orEmpty()
            val bigText = extras.getCharSequence(Notification.EXTRA_BIG_TEXT)?.toString().orEmpty()
            // Many OEMs hide the DLT sender ID in subText; pull it for the log.
            val subText = extras.getCharSequence(Notification.EXTRA_SUB_TEXT)?.toString().orEmpty()
            val body = listOf(bigText, text).firstOrNull { it.isNotBlank() }
            if (body.isNullOrBlank()) {
                // No body content (e.g. grouped notification summary). Log so
                // we can see this happened — previously silent.
                recordEvent(pkg, "", "filtered: empty_body")
                return
            }

            // Primary gate: body must contain transaction keywords. We DO NOT
            // require the title to be a DLT bank sender — many OEMs (Samsung,
            // MIUI, ColorOS) put "Messages" / a conversation name in the title
            // and the sender ID only in subText. Body keywords + OTP guard is
            // a more reliable signal across phones.
            val bodyLooksTxn = txnRegex.containsMatchIn(body)
            val looksLikeOtp = otpRegex.containsMatchIn(body)
            // Title hint: used only for the diagnostic log, not for gating.
            val titleHint =
                if (bankSenderRegex.containsMatchIn(title) ||
                    bankSenderRegex.containsMatchIn(subText)) "bank-header" else "no-bank-header"

            if (!bodyLooksTxn) {
                // Personal SMS, app updates, etc. Log briefly so we can see it.
                recordEvent(pkg, body, "filtered: no_txn_keywords ($titleHint)")
                return
            }
            if (looksLikeOtp) {
                // "Use 123456 as OTP — do not share"-style messages, even when
                // they mention "debited/credited" inside the warning text.
                recordEvent(pkg, body, "filtered: looks_like_otp ($titleHint)")
                return
            }

            // Prefer subText (sender ID on many OEMs) over title for context.
            val header = listOf(title, subText).firstOrNull {
                it.isNotBlank() && bankSenderRegex.containsMatchIn(it)
            } ?: title
            val composed = if (header.isNotBlank()) "$header: $body" else body

            // De-dupe: shared with SmsBroadcastReceiver so the same SMS
            // caught by both paths is only forwarded once.
            if (!SmsDedup.tryAcquire(composed)) return

            scope.launch {
                val result = SmsForwarder.post(applicationContext, composed)
                Log.i(TAG, "forwarded [$pkg] -> ${result.status}")
                recordEvent(pkg, composed, "forwarded: ${result.status} ($titleHint)")
                // If the cloud function saved an uncategorized txn, ping the user.
                result.txn?.let { UncatNotifier.maybeShow(applicationContext, it) }
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
