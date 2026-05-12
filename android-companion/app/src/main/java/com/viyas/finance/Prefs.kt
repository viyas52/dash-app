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
}
