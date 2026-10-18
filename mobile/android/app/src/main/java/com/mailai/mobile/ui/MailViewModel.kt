package com.mailai.mobile.ui

import android.app.Application
import android.net.Uri
import androidx.compose.runtime.*
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.mailai.mobile.MailApplication
import com.mailai.mobile.data.*
import com.mailai.mobile.mail.*
import java.net.UnknownHostException
import javax.mail.AuthenticationFailedException
import javax.net.ssl.SSLException
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

class MailViewModel(app: Application) : AndroidViewModel(app) {
    val repo = (app as MailApplication).repository
    private val _feedback = MutableSharedFlow<Unit>(extraBufferCapacity = 1)
    val feedback = _feedback.asSharedFlow()
    var accounts by mutableStateOf<List<Account>>(emptyList())
        private set

    var account by mutableStateOf<Account?>(null)
        private set

    var page by mutableStateOf("inbox")
        private set

    var editingAccount by mutableStateOf<Account?>(null)
        private set

    var folder by mutableStateOf("INBOX")
        private set

    var folders by mutableStateOf(listOf("INBOX"))
        private set

    var mails by mutableStateOf<List<MailItem>>(emptyList())
        private set

    var drafts by mutableStateOf<List<Draft>>(emptyList())
        private set

    var selected by mutableStateOf<MailItem?>(null)
        private set

    var draft by mutableStateOf<Draft?>(null)
        private set

    var busy by mutableStateOf(false)
        private set

    var cancellable by mutableStateOf(true)
        private set

    var status by mutableStateOf("")
        private set

    var error by mutableStateOf(false)
        private set

    var saveStatus by mutableStateOf("")
        private set

    var ready by mutableStateOf(false)
        private set

    var availableFile by mutableStateOf<Pair<Account, Attachment>?>(null)
    var limit by mutableIntStateOf(50)
        private set

    var unreadOnly by mutableStateOf(false)
    var query by mutableStateOf("")
    private var op: Operation? = null
    private var job: Job? = null
    private var retry by mutableStateOf<(() -> Unit)?>(null)
    val canRetry
        get() = retry != null

    private val saves = Mutex()
    private var latestSave: Job? = null

    init {
        viewModelScope.launch {
            try {
                accounts = repo.initialize()
                account = accounts.firstOrNull()
                if (account == null) page = "add"
                else {
                    loadCache()
                    refresh()
                }
                ready = true
            } catch (t: Throwable) {
                status = "无法读取本地数据，请勿卸载应用。"
                error = true
                ready = true
            }
        }
    }

    fun resumeCache() {
        if (!ready || busy) return
        viewModelScope.launch {
            try {
                loadCache()
            } catch (_: Exception) {
                status = "本地邮件暂时无法读取，请稍后重试"
                error = true
            }
        }
    }

    fun openNotification(accountId: String?, settings: Boolean) {
        viewModelScope.launch {
            snapshotFlow { ready }.first { it }
            // A notification never interrupts SMTP or drops edits from an open composer.
            job?.join()
            latestSave?.join()
            if (page == "compose") {
                val a = account
                val d = draft
                if (a != null && d != null && d.state in setOf(SendState.DRAFT, SendState.FAILED)) {
                    try {
                        saves.withLock { withContext(Dispatchers.IO) { repo.store(a).save(d) } }
                    } catch (_: Exception) {
                        status = "草稿尚未保存，请先保留当前内容"
                        error = true
                        return@launch
                    }
                }
            }
            if (settings) go("settings")
            else accounts.find { it.id == accountId }?.let { choose(it) }
        }
    }

    private suspend fun loadCache() {
        val a = account ?: return
        val currentFolder = folder
        val result =
            withContext(Dispatchers.IO) {
                repo.store(a).messages(currentFolder) to repo.store(a).drafts()
            }
        if (account?.id == a.id && folder == currentFolder) {
            mails = result.first
            drafts = result.second
        }
    }

    private fun message(t: Throwable): String {
        var cause: Throwable? = t
        repeat(8) {
            when (cause) {
                is AuthenticationFailedException -> return "登录失败，请检查授权码及邮箱的 IMAP/SMTP 设置"
                is SSLException -> return "安全连接验证失败，请检查服务器地址与证书"
                is UnknownHostException -> return "无法连接服务器，请检查网络和服务器地址"
            }
            cause = cause?.cause
        }
        return when (t) {
            is IllegalArgumentException,
            is IllegalStateException -> t.message?.take(140) ?: "操作未完成，请检查填写内容"
            else -> "连接或保存失败，内容已保留，请检查网络后重试"
        }
    }

    private fun run(
        label: String,
        canCancel: Boolean = true,
        again: (() -> Unit)? = null,
        block: suspend (Operation, (String) -> Unit) -> Unit,
    ) {
        if (busy) return
        val token = Operation()
        op = token
        busy = true
        cancellable = canCancel
        status = label
        error = false
        retry = again
        job =
            viewModelScope.launch(start = CoroutineStart.UNDISPATCHED) {
                try {
                    block(token) { value ->
                        viewModelScope.launch {
                            if (op === token && !token.isCancelled) status = value
                        }
                    }
                } catch (e: CancellationException) {
                    if (op === token) status = "已取消，原有内容已保留"
                } catch (t: Throwable) {
                    if (op === token) {
                        status = if (token.isCancelled) "已取消，原有内容已保留" else message(t)
                        error = !token.isCancelled
                    }
                } finally {
                    // Cleanup AND the UI state transition must survive cancellation. Returning
                    // from an IO context to a cancelled Main context can otherwise skip reset.
                    withContext(NonCancellable) {
                        withContext(Dispatchers.IO) { token.release() }
                        if (op === token) {
                            if (token.isCancelled) {
                                status = "已取消，原有内容已保留"
                                error = false
                            }
                            busy = false
                            op = null
                        }
                    }
                }
            }
    }

    fun cancel() {
        if (!busy || !cancellable) return
        status = "正在取消，请稍候…"
        cancellable = false
        op?.cancel()
        job?.cancel()
    }

    fun retry() {
        retry?.invoke()
    }

    fun dismissStatus() {
        if (!busy) {
            status = ""
            error = false
        }
    }

    fun editAccount(a: Account) {
        if (busy) return
        editingAccount = a
        page = "add"
    }

    fun go(target: String) {
        if (!busy) dismissStatus()
        if (target == "add") editingAccount = null
        if (busy) {
            if (!cancellable) return
            cancel()
        }
        page = target
        if (target == "drafts")
            viewModelScope.launch {
                latestSave?.join()
                loadCache()
            }
    }

    fun choose(a: Account, box: String = "INBOX") {
        if (busy) return
        account = a
        folder = box
        limit = 50
        query = ""
        unreadOnly = false
        mails = emptyList()
        folders = listOf("INBOX")
        selected = null
        page = "inbox"
        viewModelScope.launch {
            loadCache()
            refresh()
        }
    }

    fun refresh(more: Boolean = false) {
        val a = account ?: return
        if (more) limit += 50
        val box = folder
        val count = limit
        run("正在同步邮件…", again = { refresh() }) { token, progress ->
            repo.sync(a, box, count, token)
            token.check()
            loadCache()
            progress("邮件已更新 · 已缓存 ${mails.size} 封")
            // Folder discovery failure must not discard a successful inbox refresh.
            try {
                folders = repo.folders(a, token)
            } catch (e: CancellationException) {
                throw e
            } catch (_: Exception) {
                folders = (folders + box).distinct()
            }
        }
    }

    fun add(a: Account, password: String) {
        run("正在验证邮箱…") { token, progress ->
            repo.add(a, password, token, progress)
            accounts = repo.initialize()
            account = a
            folder = "INBOX"
            mails = emptyList()
            page = "inbox"
            progress("邮箱已添加，正在收取邮件…")
            repo.sync(a, folder, limit, token)
            loadCache()
            status = "邮箱已添加，邮件已更新"
            _feedback.tryEmit(Unit)
        }
    }

    fun read(item: MailItem) {
        selected = item
        page = "reader"
        fetchBody()
    }

    fun fetchBody() {
        val a = account ?: return
        val item = selected ?: return
        run(if (item.body == null) "正在读取正文…" else "正在更新已读状态…", again = { fetchBody() }) {
            token,
            progress ->
            val loaded = repo.read(a, item, token)
            token.check()
            selected = loaded
            try {
                if (loaded.unread) {
                    repo.seen(a, loaded, token)
                    selected = loaded.copy(unread = false)
                }
                status = ""
            } catch (e: CancellationException) {
                throw e
            } catch (_: Exception) {
                progress("正文已保留，已读状态未同步；联网后可重试")
                error = true
            }
            loadCache()
        }
    }

    fun compose(reply: Boolean = false) {
        if (busy) return
        dismissStatus()
        val a = account ?: return
        val m = selected
        val d =
            if (reply && m != null)
                Draft(
                    to = m.replyTo,
                    subject =
                        if (m.subject.startsWith("Re:", true)) m.subject else "Re: ${m.subject}",
                    replyId = m.messageId,
                )
            else Draft()
        draft = d
        page = "compose"
        save(d, a)
    }

    fun openDraft(d: Draft) {
        dismissStatus()
        draft = d
        page = "compose"
        saveStatus =
            if (d.state == SendState.UNCERTAIN) "发送结果待确认，请先核查邮箱；本版不提供直接重发"
            else if (d.state == SendState.SENT) "服务器已接受 · 此设备的发送记录" else "草稿已保存在此设备"
    }

    fun update(d: Draft) {
        if (busy || d.state !in setOf(SendState.DRAFT, SendState.FAILED)) return
        draft = d.copy(state = SendState.DRAFT)
        account?.let { save(requireNotNull(draft), it) }
    }

    private fun save(d: Draft, a: Account) {
        saveStatus = "正在保存草稿…"
        latestSave =
            viewModelScope.launch {
                saves.withLock {
                    try {
                        withContext(Dispatchers.IO) { repo.store(a).save(d) }
                        if (draft?.id == d.id && draft == d) saveStatus = "草稿已保存在此设备"
                    } catch (_: Exception) {
                        if (draft?.id == d.id) saveStatus = "保存失败，请保留当前页面并重试"
                    }
                }
            }
    }

    fun retrySave() {
        val a = account ?: return
        val d = draft ?: return
        if (!busy && d.state in setOf(SendState.DRAFT, SendState.FAILED)) save(d, a)
    }

    fun saveAndLeave() {
        val a = account ?: return
        val d = draft ?: return
        run("正在保存草稿…", false, again = { saveAndLeave() }) { _, _ ->
            saves.withLock { withContext(Dispatchers.IO) { repo.store(a).save(d) } }
            saveStatus = "草稿已保存在此设备"
            loadCache()
            page = "inbox"
            status = "草稿已保存，可从邮箱 → 草稿继续编辑"
            _feedback.tryEmit(Unit)
        }
    }

    fun discard() {
        val a = account ?: return
        val d = draft ?: return
        run("正在移除草稿…", false) { _, _ ->
            latestSave?.join()
            saves.withLock { withContext(Dispatchers.IO) { repo.store(a).discard(d.id) } }
            draft = null
            page = "inbox"
            loadCache()
            status = "草稿已移除"
        }
    }

    fun attach(uri: Uri) {
        val a = account ?: return
        val d = draft ?: return
        run("正在复制附件到此设备…", again = { attach(uri) }) { token, _ ->
            val attachment = repo.import(a, uri, token)
            token.check()
            require(d.attachments.sumOf { it.size } + attachment.size <= MAX_ATTACHMENT_BYTES) {
                "附件合计不能超过 25 MB"
            }
            val next = d.copy(attachments = d.attachments + attachment)
            draft = next
            saves.withLock { withContext(Dispatchers.IO) { repo.store(a).save(next) } }
            saveStatus = "草稿和附件已保存在此设备"
            status = "附件已添加"
        }
    }

    fun download(file: Attachment) {
        val a = account ?: return
        val m = selected ?: return
        run("正在下载 ${file.name}…", again = { download(file) }) { token, progress ->
            var lastProgress = 0L
            val (next, cached) =
                repo.download(a, m, file, token) { bytes ->
                    val now = System.nanoTime()
                    if (now - lastProgress >= 100_000_000L) {
                        lastProgress = now
                        progress("正在下载 · ${bytes/1024} KB")
                    }
                }
            token.check()
            selected = next
            availableFile = a to cached
            status = "附件已下载，可打开或分享"
        }
    }

    fun send() {
        val a = account ?: return
        val d = draft ?: return
        try {
            MimeCodec.addresses(d.to)
            require(d.body.isNotBlank() || d.attachments.isNotEmpty()) { "请填写正文或添加附件" }
        } catch (t: Exception) {
            retry = null
            status = message(t)
            error = true
            return
        }
        run("正在保存并准备发送…", false) { token, progress ->
            latestSave?.join()
            val state = saves.withLock { repo.send(a, d, token, progress) }
            draft = withContext(Dispatchers.IO) { repo.store(a).draft(d.id) }
            loadCache()
            if (state == SendState.SENT) {
                page = "inbox"
                status = "邮件已发送 · 发送记录保存在此设备"
                _feedback.tryEmit(Unit)
            } else {
                saveStatus = "发送结果待确认，请先核查邮箱，避免重复发送"
                status = saveStatus
                error = true
            }
        }
    }

    override fun onCleared() {
        op?.cancel()
        super.onCleared()
    }
}
