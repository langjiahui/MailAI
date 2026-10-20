package com.mailai.mobile.assistant

import android.content.Context
import com.mailai.mobile.BuildConfig
import com.mailai.mobile.mail.MailNetworks
import com.mailai.mobile.mail.Operation
import com.mailai.mobile.mail.PinnedSocketFactory
import java.io.IOException
import java.net.InetAddress
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import okhttp3.*
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody.Companion.toRequestBody
import okio.BufferedSource
import org.json.JSONArray
import org.json.JSONObject

internal class AssistantFailure(message: String) : IOException(message)

internal class AssistantCall {
    private val cancelled = AtomicBoolean(false)
    @Volatile private var call: Call? = null

    fun bind(value: Call) {
        call = value
        if (cancelled.get()) value.cancel()
    }

    fun cancel() {
        cancelled.set(true)
        call?.cancel()
    }

    fun check() {
        if (cancelled.get()) throw java.util.concurrent.CancellationException("已停止")
    }
}

internal fun interface AssistantTransport {
    fun generate(
        config: AssistantConfig,
        messages: JSONArray,
        operation: AssistantCall,
        progress: (String) -> Unit,
    ): String
}

/** No polling, redirects, automatic retries, preconnection, or background workers. */
internal class AssistantClient(
    private val context: Context?,
    private val testClient: OkHttpClient? = null,
) : AssistantTransport {
    override fun generate(
        config: AssistantConfig,
        messages: JSONArray,
        operation: AssistantCall,
        progress: (String) -> Unit,
    ): String {
        config.validate()
        val url =
            AssistantProviders.completionEndpoint(config.endpoint, config.privateNetwork)
                .toHttpUrl()
        val builder =
            (testClient ?: OkHttpClient())
                .newBuilder()
                .followRedirects(false)
                .followSslRedirects(false)
                .retryOnConnectionFailure(false)
                .connectTimeout(15, TimeUnit.SECONDS)
                .readTimeout(
                    if (AssistantProviders.detect(config.endpoint)?.id == "kimi_code") 90 else 30,
                    TimeUnit.SECONDS,
                )
                .callTimeout(90, TimeUnit.SECONDS)
                .connectionPool(ConnectionPool(0, 1, TimeUnit.SECONDS))
        val pin = Operation()
        if (testClient == null) {
            if (config.privateNetwork) {
                val route = MailNetworks(requireNotNull(context)).route()
                val address = route.resolve(url.host)
                config.validateAddress(address)
                builder.dns(
                    object : Dns {
                        override fun lookup(hostname: String): List<InetAddress> {
                            require(hostname == url.host)
                            return listOf(address)
                        }
                    }
                )
                builder.socketFactory(PinnedSocketFactory(address, pin, route.bind))
            } else
                builder.dns(
                    object : Dns {
                        override fun lookup(hostname: String): List<InetAddress> {
                            require(hostname == url.host)
                            val addresses = InetAddress.getAllByName(hostname)
                            require(addresses.isNotEmpty()) { "模型地址没有可用的解析结果" }
                            addresses.forEach(config::validateAddress)
                            return addresses.toList()
                        }
                    }
                )
        }
        val client = builder.build()
        val body = AssistantProviders.request(config, messages).toString()
        val request =
            Request.Builder()
                .url(url)
                .header("Authorization", "Bearer ${config.key}")
                .header("Accept", "text/event-stream")
                .header("User-Agent", "MailAI-Android/${BuildConfig.VERSION_NAME}")
                .post(body.toRequestBody("application/json; charset=utf-8".toMediaType()))
                .build()
        operation.check()
        val call = client.newCall(request)
        operation.bind(call)
        try {
            call.execute().use { response ->
                operation.check()
                if (!response.isSuccessful) {
                    val detail = response.peekBody(4096).string()
                    operation.check()
                    throw AssistantFailure(
                        AssistantServiceErrors.message(config, response.code, detail)
                    )
                }
                val source = response.body?.source() ?: throw AssistantFailure("服务没有返回内容")
                return if (
                    response.header("Content-Type").orEmpty().contains("text/event-stream", true)
                )
                    AssistantStream.read(source, operation, progress)
                else {
                    val raw = source.readUtf8LineStrictOrAll(256000)
                    val choice = JSONObject(raw).optJSONArray("choices")?.optJSONObject(0)
                    if (choice?.optString("finish_reason") != "stop")
                        throw AssistantFailure("结果未完整返回，请重试；原稿未改动")
                    val text =
                        AssistantContent.text(choice.optJSONObject("message")?.opt("content"))
                    if (text.isBlank() || text.length > 32000)
                        throw AssistantFailure("服务未返回可用文字，请重试")
                    progress(text)
                    text
                }
            }
        } finally {
            call.cancel()
            pin.release()
            client.connectionPool.evictAll()
            // An owned client has no idle executor or periodic keepalive left after use.
            if (testClient == null) client.dispatcher.executorService.shutdown()
        }
    }
}

private fun BufferedSource.readUtf8LineStrictOrAll(limit: Long): String {
    val buffer = okio.Buffer()
    var total = 0L
    while (true) {
        val n = read(buffer, minOf(8192, limit + 1 - total))
        if (n < 0) break
        total += n
        if (total > limit) throw AssistantFailure("服务响应过大，已停止接收")
    }
    return buffer.readUtf8()
}

internal object AssistantStream {
    // Reasoning-heavy gateways repeat SSE metadata per token, even for a short final answer.
    private const val MAX_STREAM_BYTES = 4L * 1024 * 1024

    fun read(source: BufferedSource, operation: AssistantCall, progress: (String) -> Unit): String {
        val text = StringBuilder()
        val event = StringBuilder()
        var total = 0L
        var last = 0L
        var stopped = false
        var done = false
        fun consume() {
            if (event.isEmpty()) return
            val data = event.toString().trim()
            event.clear()
            if (data == "[DONE]") {
                done = true
                return
            }
            val j = JSONObject(data)
            if (j.has("error")) throw AssistantFailure("模型服务中断了生成，已有文字已保留")
            val choice = j.optJSONArray("choices")?.optJSONObject(0) ?: return
            val delta = choice.optJSONObject("delta")
            val toolCalls = delta?.opt("tool_calls")
            if (
                toolCalls != null &&
                    toolCalls != JSONObject.NULL &&
                    (toolCalls !is JSONArray || toolCalls.length() > 0)
            )
                throw AssistantFailure("此任务只支持文字结果，请检查模型配置")
            val content = delta?.opt("content") ?: choice.optJSONObject("message")?.opt("content")
            text.append(AssistantContent.text(content))
            if (text.length > 32000) throw AssistantFailure("结果较长，已停止；请缩小处理范围")
            when (choice.optString("finish_reason")) {
                "stop" -> stopped = true
                "length" -> throw AssistantFailure("结果达到输出上限，未作为完整结果；请缩小范围后重试")
                "content_filter",
                "tool_calls" -> throw AssistantFailure("模型服务未完成文字结果，请调整要求后重试")
            }
            val now = System.nanoTime()
            if (text.isNotEmpty() && now - last >= 100_000_000) {
                progress(text.toString())
                last = now
            }
        }
        while (!done) {
            operation.check()
            if (source.exhausted()) {
                consume()
                break
            }
            val line = source.readUtf8LineStrict(16384)
            total += line.toByteArray(Charsets.UTF_8).size + 1
            if (total > MAX_STREAM_BYTES) throw AssistantFailure("服务响应过大，已停止接收")
            if (line.isEmpty()) consume()
            else if (line.startsWith("data:")) {
                if (event.isNotEmpty()) event.append('\n')
                event.append(line.substring(5).trimStart())
                if (event.length > 32000) throw AssistantFailure("服务响应异常，已停止接收")
            }
        }
        operation.check()
        if ((!stopped && !done) || text.isBlank()) throw AssistantFailure("连接中断，结果尚未完成；已有文字已保留")
        progress(text.toString())
        return text.toString()
    }
}

/** Match Web content_text: typed reasoning blocks are metadata, never visible result text. */
internal object AssistantContent {
    fun text(value: Any?): String =
        when (value) {
            is String -> value
            is JSONArray ->
                buildString {
                    for (i in 0 until value.length()) {
                        val block = value.optJSONObject(i) ?: continue
                        if (block.optString("type", "text") in setOf("text", "output_text"))
                            append(
                                block.opt("text") as? String
                                    ?: block.opt("content") as? String
                                    ?: ""
                            )
                    }
                }
            else -> ""
        }
}
