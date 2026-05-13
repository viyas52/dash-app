package com.viyas.finance

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

class MainActivity : AppCompatActivity() {

    private lateinit var b: ActivityMainBinding

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        b = ActivityMainBinding.inflate(layoutInflater)
        setContentView(b.root)

        val prefs = Prefs(this)
        b.editUser.setText(prefs.user)
        b.editApikey.setText(prefs.apiKey)

        b.btnSave.setOnClickListener {
            prefs.user = b.editUser.text.toString().trim()
            prefs.apiKey = b.editApikey.text.toString().trim()
            log("Saved.")
        }

        b.btnOpenSettings.setOnClickListener {
            startActivity(Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS))
        }

        b.btnTest.setOnClickListener {
            // Real HDFC debit UPI format. Creates a ₹1 "COMPANION_TEST" txn in Firestore.
            // Safe to run repeatedly — deduped by UPI ref. Delete the test txn from PWA after.
            val testSms = "Sent Rs.1.00\nFrom HDFC Bank A/C *1234\n" +
                "To COMPANION_TEST\nOn 13/05/26\nRef 888888888888"
            CoroutineScope(Dispatchers.Main).launch {
                log("Sending test...")
                val res = withContext(Dispatchers.IO) {
                    SmsForwarder.post(this@MainActivity, testSms)
                }
                log("Response: $res")
            }
        }
    }

    override fun onResume() {
        super.onResume()
        b.textListenerStatus.text = if (isListenerEnabled())
            "Status: enabled ✓" else "Status: NOT enabled — tap below to grant access."
    }

    private fun isListenerEnabled(): Boolean {
        val flat = Settings.Secure.getString(contentResolver, "enabled_notification_listeners") ?: return false
        if (TextUtils.isEmpty(flat)) return false
        return flat.split(":").any { it.contains(packageName) }
    }

    private fun log(msg: String) {
        b.textLog.text = (msg + "\n" + b.textLog.text).take(2000)
    }
}
