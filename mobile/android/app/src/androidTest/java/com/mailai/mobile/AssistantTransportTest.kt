package com.mailai.mobile

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.mailai.mobile.assistant.*
import java.net.InetAddress
import java.net.InetSocketAddress
import java.security.KeyStore
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import javax.net.ssl.*
import okhttp3.Dns
import okhttp3.OkHttpClient
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith

/** Native HTTP and HTTPS/SSE with synthetic data, never a real model service. */
@RunWith(AndroidJUnit4::class)
class AssistantTransportTest {
    private fun fixture(): Pair<SSLContext, X509TrustManager> {
        val keys =
            KeyStore.getInstance("PKCS12").apply {
                InstrumentationRegistry.getInstrumentation()
                    .context
                    .assets
                    .open("intranet-test-only.p12")
                    .use { load(it, "test-only".toCharArray()) }
            }
        val km =
            KeyManagerFactory.getInstance(KeyManagerFactory.getDefaultAlgorithm()).apply {
                init(keys, "test-only".toCharArray())
            }
        val tm =
            TrustManagerFactory.getInstance(TrustManagerFactory.getDefaultAlgorithm()).apply {
                init(keys)
            }
        val ssl =
            SSLContext.getInstance("TLS").apply { init(km.keyManagers, tm.trustManagers, null) }
        return ssl to tm.trustManagers.filterIsInstance<X509TrustManager>().single()
    }

    private fun serve(
        response: String,
        verify: (String, String) -> Unit,
        awaitClientClose: Boolean = false,
        secure: Boolean = true,
        execute: (AssistantClient, AssistantConfig, AssistantCall) -> Unit,
    ) {
        val (ssl, trust) = fixture()
        val server =
            if (secure) ssl.serverSocketFactory.createServerSocket() else java.net.ServerSocket()
        server.bind(InetSocketAddress(InetAddress.getByName("127.0.0.1"), 0))
        server.soTimeout = 10000
        val executor = Executors.newSingleThreadExecutor()
        val client =
            OkHttpClient.Builder()
                .sslSocketFactory(ssl.socketFactory, trust)
                .dns(
                    object : Dns {
                        override fun lookup(hostname: String) =
                            listOf(InetAddress.getByName("127.0.0.1"))
                    }
                )
                .build()
        val done =
            executor.submit {
                server.accept().use { socket ->
                    socket.soTimeout = 10000
                    val input = socket.inputStream.buffered()
                    val bytes = java.io.ByteArrayOutputStream()
                    while (true) {
                        val b = input.read()
                        check(b >= 0)
                        bytes.write(b)
                        check(bytes.size() < 16000)
                        if (bytes.toString("UTF-8").endsWith("\r\n\r\n")) break
                    }
                    val headers = bytes.toString("UTF-8")
                    val length =
                        Regex("Content-Length: (\\d+)", RegexOption.IGNORE_CASE)
                            .find(headers)!!
                            .groupValues[1]
                            .toInt()
                    val body = ByteArray(length)
                    var read = 0
                    while (read < length) {
                        val n = input.read(body, read, length - read)
                        check(n > 0)
                        read += n
                    }
                    verify(headers, body.toString(Charsets.UTF_8))
                    socket.outputStream.write(response.toByteArray())
                    socket.outputStream.flush()
                    if (awaitClientClose) {
                        try {
                            assertEquals(-1, input.read())
                        } catch (e: java.io.IOException) {
                            if (e is java.net.SocketTimeoutException) throw e
                        }
                    }
                }
            }
        try {
            execute(
                AssistantClient(null, client),
                AssistantConfig(
                    "${if (secure) "https" else "http"}://localhost:${server.localPort}/v1/chat/completions",
                    "fixture-model",
                    "synthetic-test-key",
                    privateNetwork = !secure,
                ),
                AssistantCall(),
            )
            done.get(10, TimeUnit.SECONDS)
        } finally {
            server.close()
            executor.shutdownNow()
            client.dispatcher.executorService.shutdown()
            client.connectionPool.evictAll()
        }
    }

    @Test
    fun nativeHttpUsesTheInstalledAppPolicyForBothCorporateModelIds() {
        for (model in listOf("Qwen2.5-72B", "Kimi-K2.6")) {
            val json =
                "{\"choices\":[{\"message\":{\"content\":\"OK\"},\"finish_reason\":\"stop\"}]}"
            val response =
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: ${json.toByteArray().size}\r\nConnection: close\r\n\r\n$json"
            serve(
                response,
                { headers, body ->
                    assertTrue(headers.startsWith("POST /v1/chat/completions HTTP/1.1"))
                    assertTrue(headers.contains("Authorization: Bearer synthetic-test-key"))
                    assertEquals(model, JSONObject(body).getString("model"))
                    assertFalse(JSONObject(body).has("thinking"))
                },
                secure = false,
            ) { client, config, call ->
                assertEquals(
                    "OK",
                    client.generate(
                        config.copy(model = model),
                        org.json
                            .JSONArray()
                            .put(JSONObject().put("role", "user").put("content", "只回复 OK")),
                        call,
                    ) {},
                )
            }
        }
    }

    @Test
    fun nativeHttpsStreamsRealChineseTextAndKeepsCredentialOutOfThePayload() {
        val sse =
            "data: {\"choices\":[{\"delta\":{\"content\":\"周五确认。\"},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n"
        val response =
            "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\n$sse"
        serve(
            response,
            { headers, body ->
                assertTrue(headers.contains("Authorization: Bearer synthetic-test-key"))
                assertFalse(body.contains("synthetic-test-key"))
                assertTrue(JSONObject(body).getBoolean("stream"))
                assertTrue(body.contains("合成邮件正文"))
            },
        ) { client, config, call ->
            val source =
                AssistantContext("test-account", "fixture@example.test", "mail", "测试", "合成邮件正文")
            val updates = mutableListOf<String>()
            assertEquals(
                "周五确认。",
                client.generate(
                    config,
                    AssistantPrompts.messages(source, AssistantTask.SUMMARY, ""),
                    call,
                    updates::add,
                ),
            )
            assertEquals("周五确认。", updates.last())
        }
    }

    @Test
    fun nativeRedirectDoesNotFollowToAnotherHostWithTheKey() {
        val response =
            "HTTP/1.1 302 Found\r\nLocation: https://must-not-contact.example.test/collect\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
        serve(response, { _, _ -> }) { client, config, call ->
            val source =
                AssistantContext("test-account", "fixture@example.test", "mail", "测试", "合成邮件正文")
            val failure =
                assertThrows(AssistantFailure::class.java) {
                    client.generate(
                        config,
                        AssistantPrompts.messages(source, AssistantTask.SUMMARY, ""),
                        call,
                    ) {}
                }
            assertTrue(failure.message!!.contains("跳转"))
        }
    }

    @Test
    fun cancellationClosesTheNativeConnectionWithoutWaitingForMoreTokens() {
        val response =
            "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\ndata: {\"choices\":[{\"delta\":{\"content\":\"已收到一部分\"}}]}\n\n"
        serve(response, { _, _ -> }, true) { client, config, call ->
            val source =
                AssistantContext("test-account", "fixture@example.test", "mail", "测试", "合成邮件正文")
            val start = System.nanoTime()
            assertThrows(java.util.concurrent.CancellationException::class.java) {
                client.generate(
                    config,
                    AssistantPrompts.messages(source, AssistantTask.SUMMARY, ""),
                    call,
                ) {
                    call.cancel()
                }
            }
            assertTrue(
                "Cancel must not wait for the 30s read timeout",
                System.nanoTime() - start < 5_000_000_000,
            )
        }
    }
}
