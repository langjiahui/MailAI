package com.mailai.mobile.assistant

import android.content.Context
import com.mailai.mobile.mail.MailNetworks
import com.mailai.mobile.mail.NetworkPolicy
import com.mailai.mobile.mail.Operation
import com.mailai.mobile.mail.PinnedSocketFactory
import java.io.IOException
import java.net.InetAddress
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import okhttp3.*
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
        val url = config.url()
        val builder =
            (testClient ?: OkHttpClient())
                .newBuilder()
                .followRedirects(false)
                .followSslRedirects(false)
                .retryOnConnectionFailure(false)
                .connectTimeout(15, TimeUnit.SECONDS)
                .readTimeout(30, TimeUnit.SECONDS)
                .callTimeout(90, TimeUnit.SECONDS)
                .connectionPool(ConnectionPool(0, 1, TimeUnit.SECONDS))
        val pin = Operation()
        if (testClient == null) {
            if (config.privateNetwork) {
                val route = MailNetworks(requireNotNull(context)).route()
                val address = route.resolve(url.host)
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
                            require(
                                addresses.isNotEmpty() && addresses.all(NetworkPolicy::isPublic)
                            ) {
                                "模型地址解析到内网，请核对地址或明确启用企业内网服务"
                            }
                            return addresses.toList()
                        }
                    }
                )
        }
        val client = builder.build()
        val body =
            JSONObject()
                .put("model", config.model)
                .put("messages", messages)
                .put("stream", true)
                .put("max_tokens", 1600)
                .toString()
        val request =
            Request.Builder()
                .url(url)
                .header("Authorization", "Bearer ${config.key}")
                .header("Accept", "text/event-stream, application/json")
                .post(body.toRequestBody("application/json; charset=utf-8".toMediaType()))
                .build()
        operation.check()
        val call = client.newCall(request)
        operation.bind(call)
        try {
            call.execute().use { response ->
                operation.check()
                if (!response.isSuccessful)
                    throw AssistantFailure(
                        when (response.code) {
                            401,
                            403 -> "模型服务未接受 API Key，请检查配置与权限"
                            429 -> "模型服务暂时限流或额度不足，请稍后重试"
                            in 300..399 -> "模型接口发生跳转，请填写最终 HTTPS 接口地址"
                            in 500..599 -> "模型服务暂时不可用，原邮件和草稿未改动"
                            else -> "模型服务未接受请求，请检查接口地址、模型名称与服务额度"
                        }
                    )
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
                    val text = choice.optJSONObject("message")?.optString("content").orEmpty()
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
            if (delta?.has("tool_calls") == true) throw AssistantFailure("此任务只支持文字结果，请检查模型配置")
            val content = delta?.opt("content")
            if (content is String) text.append(content)
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
            total += line.length + 1
            if (total > 256000) throw AssistantFailure("服务响应过大，已停止接收")
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
