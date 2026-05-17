package com.viyas.finance

import android.content.Context
import android.content.Intent
import android.os.Bundle
import android.provider.Settings
import android.text.TextUtils
import androidx.appcompat.app.AppCompatActivity
import com.viyas.finance.databinding.ActivityMainBinding
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONArray
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

class MainActivity : AppCompatActivity() {

    private lateinit var b: ActivityMainBinding

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        b = ActivityMainBinding.inflate(layoutInflater)
        setContentView(b.root)

        val prefs = Prefs(this)
        b.editUser.setText(prefs.user)
        b.editApikey.setText(prefs.apiKey)
        b.editEndpoint.setText(prefs.endpoint)

        b.btnSave.setOnClickListener {
            prefs.user = b.editUser.text.toString().trim()
            prefs.apiKey = b.editApikey.text.toString().trim()
            prefs.endpoint = b.editEndpoint.text.toString().trim()
            toast("Saved")
        }

        b.btnOpenSettings.setOnClickListener {
            startActivity(Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS))
        }

        b.btnTest.setOnClickListener {
            // Real HDFC debit UPI format. Creates a ₹1 "COMPANION_TEST" txn in Firestore.
            // Date is dynamic so the test txn always lands on today.
            val today = java.text.SimpleDateFormat("dd/MM/yy", java.util.Locale.US).format(java.util.Date())
            val testSms = "Sent Rs.1.00\nFrom HDFC Bank A/C *1234\n" +
                "To COMPANION_TEST\nOn $today\nRef 888888888888"
            CoroutineScope(Dispatchers.Main).launch {
                toast("Sending test...")
                val result = withContext(Dispatchers.IO) {
                    SmsForwarder.post(this@MainActivity, testSms)
                }
                toast("Response: ${result.status}")
                result.txn?.let { UncatNotifier.maybeShow(this@MainActivity, it) }
                refreshLogs()
            }
        }

        b.btnRefreshLogs.setOnClickListener { refreshLogs() }
        b.btnClearLogs.setOnClickListener {
            getSharedPreferences(SmsNotificationListener.LOG_PREFS, Context.MODE_PRIVATE)
                .edit().remove(SmsNotificationListener.LOG_KEY).apply()
            refreshLogs()
            toast("Logs cleared")
        }
    }

    override fun onResume() {
        super.onResume()
        b.textListenerStatus.text = if (isListenerEnabled())
            "Status: enabled ✓" else "Status: NOT enabled — tap below to grant access."
        refreshLogs()
    }

    private fun isListenerEnabled(): Boolean {
        val flat = Settings.Secure.getString(contentResolver, "enabled_notification_listeners") ?: return false
        if (TextUtils.isEmpty(flat)) return false
        return flat.split(":").any { it.contains(packageName) }
    }

    private fun refreshLogs() {
        val prefs = getSharedPreferences(SmsNotificationListener.LOG_PREFS, Context.MODE_PRIVATE)
        val raw = prefs.getString(SmsNotificationListener.LOG_KEY, "[]") ?: "[]"
        val arr = try { JSONArray(raw) } catch (e: Exception) { JSONArray() }
        if (arr.length() == 0) {
            b.textLog.text = "No events yet.\n\nIf you just made a transaction:\n" +
                "1. Make sure notification access is enabled above\n" +
                "2. Wait for the bank SMS / app notification\n" +
                "3. Tap 'Refresh logs'"
            return
        }
        val fmt = SimpleDateFormat("HH:mm:ss", Locale.US)
        val sb = StringBuilder()
        for (i in 0 until arr.length()) {
            val ev = arr.optJSONObject(i) ?: continue
            val ts = ev.optLong("ts")
            val pkg = ev.optString("pkg")
            val body = ev.optString("body")
            val status = ev.optString("status")
            val emoji = when {
                status.startsWith("forwarded: 200: {\"status\":\"saved\"") -> "✅"
                status.startsWith("forwarded: 200: {\"status\":\"duplicate\"") -> "🔁"
                status.startsWith("forwarded: 200: {\"status\":\"skipped\"") -> "⚠️"
                status.startsWith("forwarded") -> "📤"
                status.startsWith("filtered") -> "🔇"
                status.startsWith("dropped") -> "🔁"
                status.startsWith("error") -> "❌"
                else -> "ℹ️"
            }
            sb.append("$emoji [${fmt.format(Date(ts))}] $pkg\n")
            sb.append("   $status\n")
            if (body.isNotEmpty()) sb.append("   \"${body.take(120)}${if (body.length > 120) "…" else ""}\"\n")
            sb.append("\n")
        }
        b.textLog.text = sb.toString()
    }

    private fun toast(msg: String) {
        android.widget.Toast.makeText(this, msg, android.widget.Toast.LENGTH_SHORT).show()
    }
}
