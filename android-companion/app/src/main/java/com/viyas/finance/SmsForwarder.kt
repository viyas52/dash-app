package com.viyas.finance

import android.content.Context
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL

object SmsForwarder {

    private const val ENDPOINT = "https://parsesms-2esp6326ba-el.a.run.app"

    data class Result(
        /** Short status string for the log/UI (e.g. "200: {...}", "error: timeout"). */
        val status: String,
        /** Parsed response body, null if not parseable or non-2xx. */
        val txn: JSONObject?
    )

    /** POST sms to the cloud function and parse the response. */
    fun post(ctx: Context, sms: String): Result {
        val prefs = Prefs(ctx)
        val user = prefs.user
        val apiKey = prefs.apiKey
        if (user.isBlank() || apiKey.isBlank()) return Result("skipped: missing creds", null)

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
            val parsed = if (code in 200..299) {
                try { JSONObject(resp) } catch (e: Exception) { null }
            } else null
            Result("$code: ${resp.take(200)}", parsed)
        } catch (e: Exception) {
            Result("error: ${e.message}", null)
        }
    }
}
