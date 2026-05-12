package com.viyas.finance

import android.content.Context
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL

object SmsForwarder {

    private const val ENDPOINT = "https://parsesms-2esp6326ba-el.a.run.app"

    /** POST sms to the cloud function. Returns short status string for logging. */
    fun post(ctx: Context, sms: String): String {
        val prefs = Prefs(ctx)
        val user = prefs.user
        val apiKey = prefs.apiKey
        if (user.isBlank() || apiKey.isBlank()) return "skipped: missing creds"

        val body = JSONObject().apply {
            put("user", user)
            put("sms", sms)
        }.toString()

        return try {
            val conn = (URL(ENDPOINT).openConnection() as HttpURLConnection).apply {
                requestMethod = "POST"
                connectTimeout = 8000
                readTimeout = 12000
                doOutput = true
                setRequestProperty("Content-Type", "application/json")
                setRequestProperty("x-api-key", apiKey)
            }
            conn.outputStream.use { it.write(body.toByteArray(Charsets.UTF_8)) }
            val code = conn.responseCode
            val stream = if (code in 200..299) conn.inputStream else conn.errorStream
            val resp = stream?.bufferedReader()?.use { it.readText() } ?: ""
            conn.disconnect()
            "$code: ${resp.take(200)}"
        } catch (e: Exception) {
            "error: ${e.message}"
        }
    }
}
