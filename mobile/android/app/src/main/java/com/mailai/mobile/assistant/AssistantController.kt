package com.mailai.mobile.assistant

import android.content.Context
import androidx.compose.runtime.*
import java.net.SocketTimeoutException
import java.net.UnknownHostException
import java.util.concurrent.atomic.AtomicReference
import javax.net.ssl.SSLException
import kotlinx.coroutines.*
import org.json.JSONArray
import org.json.JSONObject

/** All asynchronous work is finite and user initiated. No idle ticker or background job. */
internal class AssistantController(
    context: Context,
    private val scope: CoroutineScope,
    private val settings: AssistantSettings = AssistantSettings(context),
    private val cache: AssistantCache = AssistantCache(context),
    private val transport: AssistantTransport = AssistantClient(context.applicationContext),
) {
    var visible by mutableStateOf(false)
        private set

    var source by mutableStateOf<AssistantContext?>(null)
        private set

    var task by mutableStateOf<AssistantTask?>(null)
        private set

    var instruction by mutableStateOf("")
        private set

    var text by mutableStateOf("")
        private set

    var complete by mutableStateOf(false)
        private set

    var generating by mutableStateOf(false)
        private set

    var stopping by mutableStateOf(false)
        private set

    var loading by mutableStateOf(false)
        private set

    var applying by mutableStateOf(false)
        private set

    var message by mutableStateOf("")
        private set

    var failed by mutableStateOf(false)
        private set

    var endpoint by mutableStateOf("")
        private set

    var model by mutableStateOf("")
        private set

    var privateNetwork by mutableStateOf(false)
        private set

    var configured by mutableStateOf(false)
        private set

    var provider by mutableStateOf("")
        private set

    private var config: AssistantConfig? = null
    private var loaded = false
    private var job: Job? = null
    private var generationJob: Job? = null
    private var operation: AssistantCall? = null
    private var probeOperation: AssistantCall? = null
    private var probeJob: Job? = null
    var testing by mutableStateOf(false)
        private set

    var verificationMessage by mutableStateOf("")
        private set

    var verificationFailed by mutableStateOf(false)
        private set

    private var revision = 0L
    val busy
        get() = loading || generating || applying || testing

    fun open(value: AssistantContext) {
        if (applying) return
        if (source != value) {
            stop()
            revision++
            generating = false
            stopping = false
            operation = null
            source = value
            task = null
            instruction = ""
            text = ""
            complete = false
            message = ""
            failed = false
        }
        visible = true
        loadSettings()
    }

    private fun loadSettings() {
        if (loaded || loading) return
        loading = true
        job =
            scope.launch {
                try {
                    config = withContext(Dispatchers.IO) { settings.read() }
                    publishSettings()
                    loaded = true
                } catch (_: Exception) {
                    message = "小邮配置暂时无法读取，请重新配置；邮件仍可正常使用"
                    failed = true
                } finally {
                    loading = false
                }
            }
    }

    private fun publishSettings() {
        endpoint = config?.endpoint.orEmpty()
        provider =
            config?.provider?.takeIf { it.isNotBlank() }
                ?: AssistantProviders.detect(endpoint)?.id.orEmpty()
        model = config?.model.orEmpty()
        privateNetwork = config?.privateNetwork ?: false
        configured = config != null
    }

    fun prepareSettings() {
        if (busy) return
        message = ""
        failed = false
        loadSettings()
    }

    fun settingsEdited() {
        if (busy) return
        message = ""
        failed = false
        verificationMessage = ""
        verificationFailed = false
    }

    private fun settingsValue(
        endpoint: String,
        model: String,
        key: String,
        privateNetwork: Boolean,
        consent: Boolean,
        provider: String = "",
    ): AssistantConfig? {
        if (!consent) {
            message = "请确认当前操作所需文字将发送至你配置的模型服务"
            failed = true
            return null
        }
        // Never transfer the old key to a newly entered endpoint implicitly.
        val normalized =
            try {
                AssistantProviders.completionEndpoint(endpoint, privateNetwork)
            } catch (e: IllegalArgumentException) {
                message = e.message.orEmpty()
                failed = true
                return null
            }
        val value =
            AssistantConfig(
                normalized,
                model.trim(),
                key.trim().ifBlank {
                    if (normalized == config?.endpoint) config?.key.orEmpty() else ""
                },
                privateNetwork,
                provider,
            )
        try {
            value.validate()
        } catch (e: IllegalArgumentException) {
            message = e.message.orEmpty()
            failed = true
            return null
        }
        return value
    }

    fun saveSettings(
        endpoint: String,
        model: String,
        key: String,
        privateNetwork: Boolean,
        consent: Boolean,
        provider: String = "",
    ) {
        if (busy) return
        val value = settingsValue(endpoint, model, key, privateNetwork, consent, provider) ?: return
        verificationMessage = ""
        verificationFailed = false
        loading = true
        job =
            scope.launch {
                try {
                    withContext(Dispatchers.IO) { settings.save(value) }
                    config = value
                    loaded = true
                    publishSettings()
                    text = ""
                    complete = false
                    task = null
                    message = "配置已保存在此设备；使用功能时才联网"
                    failed = false
                } catch (_: Exception) {
                    message = "配置未保存，请重试；原有设置保留"
                    failed = true
                } finally {
                    loading = false
                }
            }
    }

    fun testSettings(
        endpoint: String,
        model: String,
        key: String,
        privateNetwork: Boolean,
        consent: Boolean,
        provider: String = "",
    ) {
        if (busy) return
        val value = settingsValue(endpoint, model, key, privateNetwork, consent, provider)
        if (value == null) {
            verificationMessage = message
            verificationFailed = true
            message = ""
            failed = false
            return
        }
        message = ""
        failed = false
        testing = true
        verificationMessage = "正在测试连接，可随时取消…"
        verificationFailed = false
        val operation = AssistantCall()
        probeOperation = operation
        probeJob =
            scope.launch {
                try {
                    generationJob?.join()
                    val answer =
                        withContext(Dispatchers.IO) {
                            transport.generate(
                                value,
                                JSONArray()
                                    .put(
                                        JSONObject().put("role", "user").put("content", "请只回复 OK。")
                                    ),
                                operation,
                            ) {}
                        }
                    operation.check()
                    check(answer.isNotBlank())
                    verificationMessage = "连接成功，模型已返回文字；尚未保存更改"
                } catch (_: CancellationException) {
                    verificationMessage = "测试已取消，原配置保留"
                } catch (e: Exception) {
                    verificationMessage = failure(e)
                    verificationFailed = true
                } finally {
                    withContext(NonCancellable) {
                        testing = false
                        probeOperation = null
                    }
                }
            }
    }

    fun clearSettings() {
        if (busy) return
        loading = true
        job =
            scope.launch {
                try {
                    generationJob?.join()
                    withContext(Dispatchers.IO) { settings.clear() }
                    config = null
                    publishSettings()
                    text = ""
                    complete = false
                    task = null
                    withContext(Dispatchers.IO) { cache.clear() }
                    message = "已移除此设备的小邮配置与候选结果"
                    failed = false
                } catch (_: Exception) {
                    message = "未能清理小邮数据，请重试"
                    failed = true
                } finally {
                    loading = false
                }
            }
    }

    fun changeInstruction(value: String) {
        if (busy) return
        instruction = value.take(500)
        text = ""
        complete = false
        message = ""
        failed = false
    }

    fun editRequest() {
        if (busy) return
        text = ""
        complete = false
        task = null
        message = ""
        failed = false
    }

    fun start(value: AssistantTask, fresh: Boolean = false) {
        if (busy) return
        val c =
            config
                ?: run {
                    message = "请先在账号与设置中配置模型服务"
                    failed = true
                    return
                }
        val source = source ?: return
        val messages =
            try {
                AssistantPrompts.messages(source, value, instruction)
            } catch (e: IllegalArgumentException) {
                message = e.message.orEmpty()
                failed = true
                return
            }
        val key = source.cacheKey(c, value, instruction)
        val previous = generationJob
        val epoch = ++revision
        val latest = AtomicReference("")
        val call = AssistantCall()
        operation = call
        task = value
        text = ""
        complete = false
        latest.set("")
        generating = true
        stopping = false
        message = "正在${value.label}…"
        failed = false
        job =
            scope.launch {
                val slow = launch {
                    delay(8000)
                    if (epoch == revision && generating) message = "服务响应较慢，可以停止后稍后重试"
                }
                var saved = false
                var finished = false
                try {
                    // A cancelled previous request must finish cleanup before a new one starts.
                    // This also prevents its late cache write from replacing the next result.
                    previous?.join()
                    val prior = withContext(Dispatchers.IO) { cache.get(key) }
                    if (!fresh && prior?.complete == true) {
                        text = prior.text
                        complete = true
                        message = "上次的结果 · 保存在此设备"
                        saved = true
                        return@launch
                    }
                    if (!fresh && prior != null) {
                        text = prior.text
                        message = "上次结果未完成，正在重新生成…"
                    }
                    var checkpoint = System.nanoTime()
                    val answer =
                        withContext(Dispatchers.IO) {
                            transport.generate(c, messages, call) { chunk ->
                                call.check()
                                latest.set(chunk)
                                scope.launch { if (epoch == revision) text = chunk }
                                if (System.nanoTime() - checkpoint >= 2_000_000_000) {
                                    cache.put(source.accountId, AssistantResult(key, chunk, false))
                                    checkpoint = System.nanoTime()
                                }
                            }
                        }
                    call.check()
                    withContext(Dispatchers.IO) {
                        cache.put(source.accountId, AssistantResult(key, answer, true))
                    }
                    saved = true
                    finished = true
                    if (epoch == revision) {
                        text = answer
                        complete = true
                        message =
                            when (value) {
                                AssistantTask.SUMMARY -> "要点整理好了"
                                AssistantTask.REPLY -> "回复拟好了"
                                AssistantTask.POLISH -> "文字润色好了"
                            } + " · 请核对后使用"
                    }
                } catch (e: CancellationException) {
                    if (epoch == revision) {
                        message = "已停止，已有文字保留；原稿未改动"
                        failed = false
                    }
                } catch (e: Exception) {
                    if (epoch == revision) {
                        message = failure(e)
                        failed = true
                    }
                } finally {
                    slow.cancel()
                    call.cancel()
                    // Reset UI and persist partial output even when the parent job was cancelled.
                    // Returning from IO into a cancelled Main context otherwise skips this
                    // transition.
                    withContext(NonCancellable) {
                        var persistenceFailed = false
                        if (!saved && latest.get().isNotBlank())
                            withContext(Dispatchers.IO) {
                                try {
                                    cache.put(
                                        source.accountId,
                                        AssistantResult(key, latest.get(), false),
                                    )
                                } catch (_: Exception) {
                                    persistenceFailed = true
                                }
                            }
                        if (epoch == revision) {
                            if (!complete && latest.get().isNotBlank()) text = latest.get()
                            generating = false
                            stopping = false
                            operation = null
                            if (persistenceFailed) {
                                message = "候选未能保存到此设备，请先复制保留；原稿未改动"
                                failed = true
                            } else if (!finished && !complete && text.isNotEmpty())
                                message += "（已有文字未完成）"
                        }
                    }
                }
            }
        generationJob = job
    }

    fun stop() {
        if (testing) {
            verificationMessage = "正在取消测试…"
            probeOperation?.cancel()
            probeJob?.cancel()
        }
        if (generating) {
            stopping = true
            message = "正在停止，已有文字会保留…"
        }
        operation?.cancel()
        if (generating) job?.cancel()
    }

    fun close() {
        if (applying || loading) return
        stop()
        visible = false
    }

    fun navigation() {
        if (applying) return
        stop()
        visible = false
    }

    fun background() {
        stop()
    }

    fun applying(value: Boolean) {
        applying = value
    }

    fun applied() {
        applying = false
        visible = false
    }

    fun adoptionFailed(value: String) {
        applying = false
        message = value
        failed = true
    }

    fun dispose() {
        probeOperation?.cancel()
        probeJob?.cancel()
        operation?.cancel()
        job?.cancel()
        job?.invokeOnCompletion { cache.close() } ?: cache.close()
    }

    private fun failure(e: Exception): String =
        when (e) {
            is AssistantFailure,
            is IllegalArgumentException -> e.message.orEmpty()
            is SSLException -> "模型服务安全验证失败，请检查地址与证书；原稿未改动"
            is UnknownHostException -> "无法解析模型服务，请检查网络或企业内网设置"
            is SocketTimeoutException -> "模型服务响应超时，可重试；原稿未改动"
            else -> "小邮未完成本次操作，原稿未改动；请检查网络后重试"
        }
}
