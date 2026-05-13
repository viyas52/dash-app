package com.viyas.finance

import android.app.Activity
import android.content.Intent
import android.os.Bundle
import android.provider.Settings
import android.widget.Toast

/**
 * Receives financecompanion:// deep links from the PWA.
 *
 *   financecompanion://save?user=viyas&key=myfinance_viyas_2026
 *     -> save credentials to SharedPreferences
 *
 *   financecompanion://enable_notifications
 *     -> open Android's notification listener settings
 *
 *   financecompanion://settings
 *     -> open the manual settings screen (fallback)
 *
 * No UI, finishes immediately, so TWA keeps focus.
 */
class CredentialReceiverActivity : Activity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        handleIntent(intent)
        finish()
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        handleIntent(intent)
        finish()
    }

    private fun handleIntent(intent: Intent?) {
        val uri = intent?.data ?: return
        when (uri.host) {
            "save" -> {
                val user = uri.getQueryParameter("user").orEmpty()
                val key = uri.getQueryParameter("key").orEmpty()
                if (user.isNotBlank() && key.isNotBlank()) {
                    Prefs(this).apply {
                        this.user = user
                        this.apiKey = key
                    }
                    Toast.makeText(this, "Companion connected as $user ✓", Toast.LENGTH_SHORT).show()
                } else {
                    Toast.makeText(this, "Sync failed — missing data", Toast.LENGTH_SHORT).show()
                }
            }
            "enable_notifications" -> {
                startActivity(
                    Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS)
                        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                )
            }
            "settings" -> {
                startActivity(
                    Intent(this, MainActivity::class.java)
                        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                )
            }
            else -> Toast.makeText(this, "Unknown action: ${uri.host}", Toast.LENGTH_SHORT).show()
        }
    }
}
