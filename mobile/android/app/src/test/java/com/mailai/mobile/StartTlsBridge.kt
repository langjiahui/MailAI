package com.mailai.mobile

import java.io.Closeable
import java.net.ServerSocket
import java.net.Socket
import java.security.KeyStore
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.atomic.AtomicInteger
import javax.net.ssl.*
import kotlin.concurrent.thread

/** Test-only STARTTLS frontend; GreenMail 1.x has no STARTTLS command support. */
class StartTlsBridge(private val upstreamPort: Int, private val imap: Boolean) : Closeable {
    private val server = ServerSocket(0, 10, java.net.InetAddress.getByName("127.0.0.1"))
    val port
        get() = server.localPort

    val upgrades = AtomicInteger()
    private val sockets = CopyOnWriteArrayList<Socket>()
    private val tls =
        SSLContext.getInstance("TLS").apply {
            val ks =
                KeyStore.getInstance("PKCS12").apply {
                    TransportTest.keys.inputStream().use { load(it, "test-only".toCharArray()) }
                }
            val km =
                KeyManagerFactory.getInstance(KeyManagerFactory.getDefaultAlgorithm()).apply {
                    init(ks, "test-only".toCharArray())
                }
            init(km.keyManagers, null, null)
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
                    runCatching { handle(client) }
                    runCatching { client.close() }
                }
            }
        }
    }

    private fun handle(client: Socket) {
        client.soTimeout = 10000
        val input = client.getInputStream().bufferedReader()
        val output = client.getOutputStream().bufferedWriter()
        fun say(line: String) {
            output.write(line + "\r\n")
            output.flush()
        }
        say(if (imap) "* OK [CAPABILITY IMAP4rev1 STARTTLS] localhost" else "220 localhost")
        while (true) {
            val line = input.readLine() ?: return
            val command = if (imap) line.substringAfter(' ') else line
            val tag = line.substringBefore(' ')
            when {
                command.startsWith("CAPABILITY", true) ->
                    say("* CAPABILITY IMAP4rev1 STARTTLS\r\n$tag OK capability")
                command.startsWith("EHLO", true) -> say("250-localhost\r\n250 STARTTLS")
                command.startsWith("STARTTLS", true) -> {
                    say(if (imap) "$tag OK begin TLS" else "220 begin TLS")
                    break
                }
                else -> error("Credentials or commands before required TLS")
            }
        }
        val secure =
            (tls.socketFactory.createSocket(client, "localhost", client.port, true) as SSLSocket)
                .apply {
                    useClientMode = false
                    startHandshake()
                }
        sockets += secure
        upgrades.incrementAndGet()
        Socket("127.0.0.1", upstreamPort).use { upstream ->
            sockets += upstream
            // Consume greeting byte-by-byte, leaving all subsequent protocol bytes for the bridge.
            while (upstream.getInputStream().read().let { it >= 0 && it != 10 }) {}
            val outgoing =
                thread(isDaemon = true) {
                    runCatching { secure.inputStream.copyTo(upstream.outputStream) }
                    runCatching { upstream.shutdownOutput() }
                }
            runCatching { upstream.inputStream.copyTo(secure.outputStream) }
            secure.close()
            outgoing.join(1000)
        }
    }

    override fun close() {
        server.close()
        sockets.forEach { runCatching { it.close() } }
    }
}
