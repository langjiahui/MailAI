package com.mailai.mobile

import java.io.Closeable
import java.net.InetAddress
import java.net.Socket
import java.security.KeyStore
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import javax.net.ssl.KeyManagerFactory
import javax.net.ssl.SSLContext
import kotlin.concurrent.thread

class FaultSmtpServer(
    private val rejectFirstConnection: Boolean = false,
    holdAcknowledgement: Boolean = false,
) : Closeable {
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

    val connections = AtomicInteger()
    val deliveries = AtomicInteger()
    val received = CountDownLatch(1)
    val acknowledge = CountDownLatch(if (holdAcknowledgement) 1 else 0)

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
                val connection = connections.incrementAndGet()
                thread(isDaemon = true) {
                    runCatching {
                        client.use { socket ->
                            socket.soTimeout = 10000
                            val input = socket.getInputStream().bufferedReader()
                            val out = socket.getOutputStream().bufferedWriter()
                            fun reply(s: String) {
                                out.write(s + "\r\n")
                                out.flush()
                            }
                            reply("220 localhost test")
                            while (true) {
                                val line = input.readLine() ?: break
                                if (rejectFirstConnection && connection == 1) break
                                when {
                                    line.startsWith("EHLO") ->
                                        reply(
                                            "250-localhost\r\n250-AUTH PLAIN LOGIN\r\n250 SIZE 40000000"
                                        )
                                    line.startsWith("AUTH") -> reply("235 authenticated")
                                    line.startsWith("MAIL") || line.startsWith("RCPT") ->
                                        reply("250 accepted")
                                    line == "DATA" -> {
                                        reply("354 send data")
                                        while (input.readLine()?.let { it != "." } == true) {}
                                        deliveries.incrementAndGet()
                                        received.countDown()
                                        check(acknowledge.await(10, TimeUnit.SECONDS))
                                        reply("250 queued")
                                    }
                                    line == "QUIT" -> {
                                        reply("221 bye")
                                        break
                                    }
                                    else -> reply("250 ok")
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    override fun close() {
        acknowledge.countDown()
        server.close()
        sockets.forEach { runCatching { it.close() } }
    }
}
