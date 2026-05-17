package com.viyas.finance

import android.content.Context

class Prefs(ctx: Context) {
    private val sp = ctx.getSharedPreferences("finance_companion", Context.MODE_PRIVATE)

    var user: String
        get() = sp.getString("user", "") ?: ""
        set(v) { sp.edit().putString("user", v).apply() }

    var apiKey: String
        get() = sp.getString("api_key", "") ?: ""
        set(v) { sp.edit().putString("api_key", v).apply() }

    // Cloud-function endpoint. Configurable so a Firebase project move never
    // needs an APK rebuild — set via the credential deep link or manually.
    var endpoint: String
        get() = sp.getString("endpoint", "") ?: ""
        set(v) { sp.edit().putString("endpoint", v).apply() }
}
