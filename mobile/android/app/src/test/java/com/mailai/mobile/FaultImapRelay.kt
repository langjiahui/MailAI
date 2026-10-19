package com.mailai.mobile

import java.io.Closeable
import java.net.InetAddress
import java.net.Socket
import java.security.KeyStore
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.atomic.AtomicInteger
import javax.net.ssl.KeyManagerFactory
import javax.net.ssl.SSLContext
import kotlin.concurrent.thread

/** Test-only TLS frontend to a local IMAP fixture, with deterministic mid-response failure. */
class FaultImapRelay(private val upstream: Int, private val rejectSearch: Boolean = false) :
    Closeable {
    private val sockets = CopyOnWriteArrayList<Socket>()
    private val ssl =
        SSLContext.getInstance("TLS").apply {
            val keys =
                KeyStore.getInstance("PKCS12").apply {
                    TransportTest.keys.inputStream().use { load(it, "test-only".toCharArray()) }
                }
            val manager =
                KeyManagerFactory.getInstance(KeyManagerFactory.getDefaultAlgorithm()).apply {
                    init(keys, "test-only".toCharArray())
                }
            init(manager.keyManagers, null, null)
        }
    private val server =
        ssl.serverSocketFactory.createServerSocket(0, 10, InetAddress.getByName("127.0.0.1"))
    val port
        get() = server.localPort

    @Volatile private var command: String? = null
    @Volatile private var bytesToDeliver = 0
    val interruptions = AtomicInteger()
    val fetches = AtomicInteger()

    fun interruptResponseTo(fragment: String, afterBytes: Int = 64) {
        bytesToDeliver = afterBytes
        command = fragment
    }

    init {
        thread(isDaemon = true) {
            while (!server.isClosed) {
                val client =
                    try {
                        server.accept()
                    } catch (_: Exception) {
                        break
                    }
                sockets += client
                thread(isDaemon = true) {
                    runCatching {
                        client.soTimeout = 10000
                        val backend = Socket("127.0.0.1", upstream).also { sockets += it }
                        backend.soTimeout = 10000
                        val remaining = AtomicInteger(-1)
                        thread(isDaemon = true) {
                            try {
                                val data = ByteArray(128)
                                val input = backend.getInputStream()
                                val output = client.getOutputStream()
                                while (true) {
                                    val size = input.read(data)
                                    if (size < 0) break
                                    val limit = remaining.get()
                                    val delivered = if (limit >= 0) minOf(size, limit) else size
                                    output.write(data, 0, delivered)
                                    output.flush()
                                    if (limit >= 0 && remaining.addAndGet(-delivered) <= 0) {
                                        interruptions.incrementAndGet()
                                        break
                                    }
                                    // Small delay exercises fragmented TLS/plain IMAP responses.
                                    Thread.sleep(2)
                                }
                            } finally {
                                runCatching { client.close() }
                                runCatching { backend.close() }
                            }
                        }
                        try {
                            val input = client.getInputStream().bufferedReader()
                            val output = backend.getOutputStream()
                            while (true) {
                                val line = input.readLine() ?: break
                                if (line.contains(" FETCH ", true)) fetches.incrementAndGet()
                                if (rejectSearch && line.contains(" SEARCH ", true)) {
                                    client.getOutputStream().apply {
                                        write(
                                            (line.substringBefore(' ') +
                                                    " NO SEARCH is unavailable\r\n")
                                                .toByteArray()
                                        )
                                        flush()
                                    }
                                    continue
                                }
                                val match = command
                                if (match != null && line.contains(match, true)) {
                                    command = null
                                    remaining.set(bytesToDeliver)
                                }
                                output.write((line + "\r\n").toByteArray())
                                output.flush()
                            }
                        } finally {
                            client.close()
                            backend.close()
                        }
                    }
                }
            }
        }
    }

    override fun close() {
        server.close()
        sockets.forEach { runCatching { it.close() } }
    }
}
