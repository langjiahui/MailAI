package com.mailai.mobile.ui

import android.app.Application
import android.net.Uri
import androidx.compose.runtime.*
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.SavedStateHandle
import androidx.lifecycle.viewModelScope
import com.mailai.mobile.MailApplication
import com.mailai.mobile.assistant.*
import com.mailai.mobile.data.*
import com.mailai.mobile.mail.*
import java.net.SocketTimeoutException
import java.net.UnknownHostException
import javax.mail.AuthenticationFailedException
import javax.net.ssl.SSLException
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

class MailViewModel(app: Application, private val savedState: SavedStateHandle) :
    AndroidViewModel(app) {
    private val connection = ConnectionMonitor(app)
    var online by mutableStateOf(connection.online.value)
        private set

    var operationHint by mutableStateOf("")
        private set

    val repo = (app as MailApplication).repository
    private val _feedback = MutableSharedFlow<Unit>(extraBufferCapacity = 1)
    val feedback = _feedback.asSharedFlow()
    var accounts by mutableStateOf<List<Account>>(emptyList())
        private set

    var account by mutableStateOf<Account?>(null)
        private set

    var backgroundRequested by mutableStateOf(false)

    fun consumeBackgroundRequest() {
        backgroundRequested = false
    }

    var updatesRequested by mutableStateOf(false)
        private set

    fun consumeUpdateRequest() {
        updatesRequested = false
    }

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

    var contacts by mutableStateOf<List<MailContact>>(emptyList())
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

    internal var filter by mutableStateOf(MailFilter.ALL)
    var stars by mutableStateOf<Set<String>>(emptySet())
        private set

    var readerOrigin = savedState.get<String>("readerOrigin") ?: "inbox"
        private set

    var unreadOnly by mutableStateOf(false)
    var query by mutableStateOf("")
    private var op: Operation? = null
    private var job: Job? = null
    private var retry by mutableStateOf<(() -> Unit)?>(null)
    val canRetry
        get() = retry != null

    private val saves = Mutex()
    private val assistantState = lazy { AssistantController(app, viewModelScope) }
    internal val assistant
        get() = assistantState.value

    private var assistantUndo by mutableStateOf<Pair<Draft, Draft>?>(null)
    internal val canUndoAssistant
        get() =
            assistantUndo?.let { (before, after) ->
                draft?.id == after.id &&
                    draft?.body == after.body &&
                    draft?.styles == after.styles &&
                    page == "compose" &&
                    draft?.state in setOf(SendState.DRAFT, SendState.FAILED)
            } ?: false

    private val notificationRoutes = Mutex()
    private var latestSave: Job? = null
    private var composerOrigin = savedState.get<String>("composerOrigin") ?: "inbox"

    private fun setComposerOrigin(value: String) {
        composerOrigin = value
        savedState["composerOrigin"] = value
    }

    private fun composerDestination() =
        if (composerOrigin == "reader" && selected == null) "inbox" else composerOrigin

    init {
        viewModelScope.launch { connection.online.collect { online = it } }
        viewModelScope.launch {
            val location = savedState.get<Array<String>>("location")
            try {
                accounts = repo.initialize()
                account =
                    accounts.find { it.id == location?.getOrNull(1) } ?: accounts.firstOrNull()
                if (account == null) page = "add"
                else {
                    folder = location?.getOrNull(2)?.takeIf { it.isNotBlank() } ?: "INBOX"
                    loadCache()
                    when (location?.firstOrNull()) {
                        "compose" -> {
                            val restored =
                                withContext(Dispatchers.IO) {
                                    repo
                                        .store(requireNotNull(account))
                                        .draft(location.getOrNull(3).orEmpty())
                                }
                            if (restored != null) {
                                draft = restored
                                if (composerOrigin == "reader")
                                    selected = mails.find { it.key == location.getOrNull(4) }
                                page = "compose"
                                saveStatus = draftStatus(restored)
                            }
                        }
                        "reader" -> {
                            selected = mails.find { it.key == location.getOrNull(4) }
                            if (selected != null) page = "reader"
                        }
                    }
                }
                ready = true
                // Restoring a composer must never reconnect SMTP or submit a saved draft.
                if (account != null && page == "inbox" && online) refresh()
                else if (
                    page == "reader" &&
                        (selected?.body == null || (selected?.contentVersion == 0 && online))
                )
                    fetchBody()
            } catch (t: Throwable) {
                status = "无法读取本地数据，请勿卸载应用。"
                error = true
                ready = true
            }
        }
    }

    /**
     * Save only navigation identifiers in Android's task state, never email text or credentials.
     */
    fun rememberLocation() {
        if (ready)
            savedState["location"] =
                arrayOf(
                    page,
                    account?.id.orEmpty(),
                    folder,
                    draft?.id.orEmpty(),
                    selected?.key.orEmpty(),
                )
    }

    fun onBackground() {
        rememberLocation()
        val a = account ?: return
        val d = draft ?: return
        if (page == "compose" && !busy && d.state in setOf(SendState.DRAFT, SendState.FAILED))
            save(d, a)
    }

    private var assistantSettingsOrigin = "settings"

    internal fun openAssistantSettings() {
        if (busy || page == "assistant-settings" || assistant.busy) return
        assistantSettingsOrigin = page
        assistant.navigation()
        assistant.prepareSettings()
        page = "assistant-settings"
    }

    internal fun closeAssistantSettings() {
        if (assistant.loading) return
        assistant.stop()
        page = assistantSettingsOrigin.takeIf { it != "assistant-settings" } ?: "settings"
    }

    internal fun assistantBackground() {
        if (assistantState.isInitialized()) assistant.background()
    }

    internal fun openAssistant(start: Int? = null, end: Int? = null) {
        if (busy) return
        val a = account
        if (a == null) {
            assistant.open(AssistantContext("", "此设备", "", "", ""))
            return
        }
        val d =
            draft?.takeIf {
                page == "compose" && it.state in setOf(SendState.DRAFT, SendState.FAILED)
            }
        val m = selected?.takeIf { page == "reader" }
        val text = d?.body ?: m?.body.orEmpty()
        assistant.open(
            AssistantContext(
                a.id,
                a.email,
                d?.id ?: m?.key.orEmpty(),
                d?.subject ?: m?.subject.orEmpty(),
                text,
                d,
                if (d != null) start?.coerceIn(0, text.length) ?: 0 else 0,
                if (d != null)
                    end?.coerceIn(start?.coerceIn(0, text.length) ?: 0, text.length) ?: text.length
                else text.length,
            )
        )
    }

    internal fun adoptAssistant() {
        if (busy || assistant.busy || !assistant.complete || assistant.text.isBlank()) return
        val source = assistant.source ?: return
        val a = account ?: return
        val result = assistant.text
        val task = assistant.task ?: return
        if (a.id != source.accountId) {
            assistant.adoptionFailed("邮箱已切换，请回到原邮箱重新打开小邮")
            return
        }
        val before = draft
        val next =
            try {
                when (task) {
                    AssistantTask.POLISH ->
                        AssistantDraftEdits.polish(requireNotNull(before), source, result)
                    AssistantTask.REPLY -> {
                        val m = requireNotNull(selected)
                        check(
                            page == "reader" &&
                                m.key == source.sourceId &&
                                AssistantContext(a.id, a.email, m.key, m.subject, m.body.orEmpty())
                                    .sourceVersion == source.sourceVersion
                        ) {
                            "原邮件已变化，请重新生成回复"
                        }
                        val signature =
                            ReadingPreferences(getApplication())
                                .signature(a.id)
                                .takeIf { it.isNotBlank() }
                                ?.let { "\n\n$it" }
                                .orEmpty()
                        Draft(
                            to = replyRecipients(m, a.email, false),
                            subject =
                                if (m.subject.startsWith("Re:", true)) m.subject
                                else "Re: ${m.subject}",
                            body = result + signature,
                            replyId = m.messageId,
                        )
                    }
                    else -> return
                }
            } catch (e: Exception) {
                assistant.adoptionFailed(e.message ?: "草稿已变化，请重新生成；当前内容保留")
                return
            }
        assistant.applying(true)
        run("正在保存小邮草稿…", false) { _, _ ->
            try {
                latestSave?.join()
                saves.withLock { withContext(Dispatchers.IO) { repo.store(a).save(next) } }
                if (task == AssistantTask.REPLY) setComposerOrigin("reader")
                assistantUndo =
                    if (task == AssistantTask.POLISH && before != null) before to next else null
                draft = next
                page = "compose"
                saveStatus = "草稿已保存在此设备"
                assistant.applied()
                try {
                    loadCache()
                } catch (_: Exception) {}
                status = if (task == AssistantTask.POLISH) "润色已保存，可在编辑工具条撤回" else "回复已保存为草稿，请核对后发送"
            } catch (e: Exception) {
                assistant.adoptionFailed("未能保存这份文字，请重试；原稿与候选结果保留")
                throw e
            }
        }
    }

    internal fun undoAssistant() {
        if (busy || !canUndoAssistant) return
        val a = account ?: return
        val (before, _) = assistantUndo ?: return
        val current = draft ?: return
        val restored = current.copy(body = before.body, styles = before.styles)
        run("正在恢复润色前正文…", false) { _, _ ->
            latestSave?.join()
            saves.withLock { withContext(Dispatchers.IO) { repo.store(a).save(restored) } }
            draft = restored
            assistantUndo = null
            saveStatus = "草稿已保存在此设备"
            status = "已恢复润色前正文"
        }
    }

    private fun draftStatus(d: Draft) =
        when (d.state) {
            SendState.UNCERTAIN,
            SendState.TRANSMITTING -> "发送结果待确认，请先核查邮箱；为避免重复发送，已锁定重发"
            SendState.SENT -> "服务器已接受 · 此设备的发送记录"
            SendState.CONNECTING -> "正在连接发件服务器，请勿重复发送"
            SendState.FAILED -> "未提交成功 · 草稿已保留，可编辑后重新发送"
            else -> "草稿已保存在此设备"
        }

    private fun requireOnline() {
        check(online) { "当前离线，已缓存邮件与草稿仍可使用；联网后重试" }
    }

    fun resumeCache() {
        if (!ready || busy) return
        viewModelScope.launch {
            try {
                latestSave?.join()
                loadCache()
                // Keep in-memory unsaved edits. Terminal send states come from the durable record.
                val a = account
                val current = draft
                if (page == "compose" && a != null && current != null) {
                    val persisted = withContext(Dispatchers.IO) { repo.store(a).draft(current.id) }
                    if (
                        draft == current &&
                            persisted?.state in setOf(SendState.SENT, SendState.UNCERTAIN)
                    ) {
                        draft = persisted
                        saveStatus = draftStatus(requireNotNull(persisted))
                    }
                }
            } catch (_: Exception) {
                status = "本地邮件暂时无法读取，请稍后重试"
                error = true
            }
        }
    }

    fun openNotification(
        accountId: String?,
        settings: Boolean,
        messageKey: String? = null,
        backgroundSettings: Boolean = false,
    ) {
        viewModelScope.launch {
            notificationRoutes.withLock {
                snapshotFlow { ready }.first { it }
                // A notification never interrupts SMTP or drops edits from an open composer.
                job?.join()
                latestSave?.join()
                if (page == "compose") {
                    val a = account
                    val d = draft
                    if (
                        a != null &&
                            d != null &&
                            d.state in setOf(SendState.DRAFT, SendState.FAILED)
                    ) {
                        try {
                            saves.withLock { withContext(Dispatchers.IO) { repo.store(a).save(d) } }
                        } catch (_: Exception) {
                            status = "草稿尚未保存，请先保留当前内容"
                            error = true
                            return@withLock
                        }
                    }
                }
                if (assistantState.isInitialized()) assistant.navigation()
                if (settings) {
                    if (backgroundSettings) backgroundRequested = true else updatesRequested = true
                    go("settings")
                } else {
                    val target = accounts.find { it.id == accountId }
                    if (target == null) {
                        status = "此通知对应的邮箱已不可用，请在邮箱列表中确认"
                        error = true
                        return@withLock
                    }
                    account = target
                    folder = "INBOX"
                    query = ""
                    filter = MailFilter.ALL
                    unreadOnly = false
                    selected = null
                    limit = 50
                    folders = listOf("INBOX")
                    page = "inbox"
                    dismissStatus()
                    try {
                        loadCache()
                        if (messageKey == null) {
                            refresh() // Compatibility with notifications posted by older versions.
                        } else {
                            val item = mails.find { it.key == messageKey }
                            if (item != null) read(item)
                            else {
                                status = "这封邮件已移出本地列表，可能已移动或删除；请刷新邮箱确认"
                                error = true
                                retry = { refresh() }
                            }
                        }
                    } catch (e: Exception) {
                        status = message(e)
                        error = true
                    }
                }
            }
        }
    }

    private suspend fun loadCache() {
        val a = account ?: return
        val currentFolder = folder
        val result =
            withContext(Dispatchers.IO) {
                val store = repo.store(a)
                val legacy = ReadingPreferences(getApplication())
                // One-time import of stars created by earlier development builds.
                store
                    .messages(currentFolder)
                    .filter { it.key in legacy.stars(a.id) }
                    .forEach {
                        store.setStarred(currentFolder, it.key, true)
                        legacy.star(a.id, it.key, false)
                    }
                Triple(
                    store.messages(currentFolder),
                    repo.store(a).drafts(),
                    repo.store(a).contacts() to repo.store(a).cachedFolders(),
                )
            }
        if (account?.id == a.id && folder == currentFolder) {
            mails = result.first
            drafts = result.second
            stars = mails.filter { it.starred }.map { it.key }.toSet()
            selected?.let { current ->
                mails
                    .find { it.key == current.key }
                    ?.let { cached -> selected = current.copy(starred = cached.starred) }
            }
            folders = (folders + result.third.second + currentFolder).distinct()
            contacts = result.third.first.filterNot { it.email.equals(a.email, true) }
        }
    }

    private fun message(t: Throwable): String {
        var cause: Throwable? = t
        repeat(8) {
            when (cause) {
                is MailSearchFailure -> return "服务器未完成检索，可换用邮箱地址或主题关键词后重试；本机结果仍可用"
                is MailLoginFailure -> return "${cause.stage}登录未通过（${cause.host}），请核对服务器、用户名及密码或授权码"
                is AuthenticationFailedException -> return "登录失败，请检查授权码及邮箱的 IMAP/SMTP 设置"
                is SSLException -> return "安全连接验证失败，请检查服务器地址与证书"
                is android.database.sqlite.SQLiteException -> return "本地存储不可用，请检查可用空间后重试"
                is SocketTimeoutException -> return "连接服务器超时，请检查当前网络是否允许邮箱端口后重试"
                is UnknownHostException ->
                    return if (online) "无法解析邮箱服务器，请检查 Wi-Fi、VPN 与服务器地址" else "网络已断开，联网后可重试"
            }
            cause = cause?.cause
        }
        return when (t) {
            is IllegalArgumentException,
            is IllegalStateException -> t.message?.take(140) ?: "操作未完成，请检查填写内容"
            else -> if (online) "操作未完成，请检查网络或稍后重试" else "网络已断开，已缓存内容仍可使用；联网后重试"
        }
    }

    private fun run(
        label: String,
        canCancel: Boolean = true,
        again: (() -> Unit)? = null,
        network: Boolean = false,
        failureMessage: (Throwable) -> String = ::message,
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
        operationHint = ""
        val slowHint =
            viewModelScope.launch {
                delay(8000)
                if (op === token && !token.isCancelled)
                    operationHint =
                        if (!canCancel && network) "仍在等待服务器，请勿重复发送；结果会保存在发送记录中"
                        else if (network) "连接较慢，仍在等待响应；可以取消后稍后重试" else "仍在处理中，请稍候"
            }
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
                        status = if (token.isCancelled) "已取消，原有内容已保留" else failureMessage(t)
                        error = !token.isCancelled
                    }
                } finally {
                    slowHint.cancel()
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
                            operationHint = ""
                            op = null
                        }
                    }
                }
            }
    }

    fun cancel() {
        if (!busy || !cancellable) return
        status = "正在取消，请稍候…"
        operationHint = ""
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
        if (assistantState.isInitialized()) assistant.navigation()
        editingAccount = a
        page = "add"
    }

    fun go(target: String) {
        if (target == page) return
        if (!busy) dismissStatus()
        if (target == "add") editingAccount = null
        if (busy) {
            if (!cancellable) return
            cancel()
        }
        if (assistantState.isInitialized()) assistant.navigation()
        page = target
        if (target == "drafts")
            viewModelScope.launch {
                latestSave?.join()
                loadCache()
            }
    }

    fun choose(a: Account, box: String = "INBOX") {
        if (busy) return
        if (assistantState.isInitialized()) assistant.navigation()
        if (a.id == account?.id && box == folder) {
            filter = MailFilter.ALL
            unreadOnly = false
            query = ""
            go("inbox")
            if (online) refresh()
            return
        }
        account = a
        folder = box
        limit = 50
        query = ""
        unreadOnly = false
        mails = emptyList()
        folders = listOf("INBOX")
        selected = null
        filter = MailFilter.ALL
        page = "inbox"
        // Mark the account transition busy before reading its cache. A fast tap must not
        // start composing against an account whose delayed refresh is about to take over.
        refresh(localFirst = true)
    }

    fun refresh(more: Boolean = false, localFirst: Boolean = false) {
        if (busy) return
        val a = account ?: return
        if (more) limit += 50
        val box = folder
        val count = limit
        run("正在同步邮件…", again = { refresh(localFirst = localFirst) }, network = true) {
            token,
            progress ->
            if (localFirst) loadCache()
            token.check()
            requireOnline()
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
        run("正在验证邮箱…", network = true) { token, progress ->
            requireOnline()
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

    var starPending by mutableStateOf<Set<String>>(emptySet())
        private set

    fun toggleStar(item: MailItem) {
        val a = account ?: return
        if (busy || item.key in starPending) return
        val value = item.key !in stars
        starPending = starPending + item.key
        viewModelScope.launch {
            try {
                withContext(Dispatchers.IO) {
                    val store = repo.store(a)
                    if (store.messages(item.folder).none { it.key == item.key }) store.put(item)
                    store.setStarred(item.folder, item.key, value)
                }
                if (account?.id == a.id) {
                    stars = if (value) stars + item.key else stars - item.key
                    serverSearchResults =
                        serverSearchResults.map {
                            if (it.key == item.key) it.copy(starred = value) else it
                        }
                    mails = mails.map { if (it.key == item.key) it.copy(starred = value) else it }
                    if (selected?.key == item.key) selected = selected?.copy(starred = value)
                    _feedback.tryEmit(Unit)
                }
            } catch (_: Exception) {
                showMessage("星标未保存，请重试", true)
            } finally {
                starPending = starPending - item.key
            }
        }
    }

    var serverSearchQuery by mutableStateOf("")
        private set

    var serverSearchResults by mutableStateOf<List<MailItem>>(emptyList())
        private set

    var serverSearchTotal by mutableIntStateOf(0)
        private set

    var serverSearchLoading by mutableStateOf(false)
        private set

    var serverSearchFailure by mutableStateOf("")
        private set

    private var serverSearchLimit = 50
    private var serverSearchAccount = ""
    private var serverSearchFolder = ""

    fun changeSearchQuery(value: String) {
        if (query == value) return
        query = value
        if (serverSearchLoading) cancel()
    }

    fun searchServer(more: Boolean = false) {
        if (busy) return
        val a = account ?: return
        val q = query.trim()
        if (q.isBlank()) return
        val box = folder
        val same =
            serverSearchQuery == q && serverSearchAccount == a.id && serverSearchFolder == box
        val count = if (more && same) (serverSearchLimit + 50).coerceAtMost(500) else 50
        serverSearchQuery = q
        serverSearchAccount = a.id
        serverSearchFolder = box
        serverSearchLimit = count
        serverSearchFailure = ""
        if (!same) {
            serverSearchResults = emptyList()
            serverSearchTotal = 0
        }
        run("正在搜索整个文件夹…", again = { searchServer(more) }, network = true) { token, _ ->
            serverSearchLoading = true
            try {
                requireOnline()
                val found = repo.search(a, box, q, count, token)
                token.check()
                if (account?.id == a.id && folder == box && query.trim() == q) {
                    val cached = mails.associateBy { it.key }
                    serverSearchResults =
                        found.messages.map { m ->
                            cached[m.key]?.takeIf { it.validity == m.validity } ?: m
                        }
                    serverSearchTotal = found.total
                    status = "服务器搜索完成"
                }
            } catch (e: CancellationException) {
                serverSearchFailure = "搜索已取消，可重试；已有结果保留"
                throw e
            } catch (e: Exception) {
                serverSearchFailure = message(e)
                throw e
            } finally {
                serverSearchLoading = false
            }
        }
    }

    fun matchingServerSearch(): Boolean =
        serverSearchQuery == query.trim() &&
            serverSearchAccount == account?.id &&
            serverSearchFolder == folder &&
            serverSearchQuery.isNotBlank()

    fun read(item: MailItem) {
        if (busy || (page == "reader" && selected?.key == item.key)) return
        if (assistantState.isInitialized()) assistant.navigation()
        readerOrigin = if (page == "search") "search" else "inbox"
        savedState["readerOrigin"] = readerOrigin
        selected = item
        page = "reader"
        fetchBody()
    }

    fun fetchBody(force: Boolean = false) {
        val a = account ?: return
        val item = selected ?: return
        // Cached, already-read mail needs no network operation or transient loading banner.
        if (
            !force && item.body != null && ((!item.unread && item.contentVersion >= 1) || !online)
        ) {
            dismissStatus()
            return
        }
        run(
            if (item.body == null || force || item.contentVersion == 0) "正在读取原邮件…" else "正在更新已读状态…",
            again = { fetchBody(force) },
            network = true,
        ) { token, progress ->
            if (item.body == null || force || item.contentVersion == 0) requireOnline()
            val loaded = repo.read(a, item, token, force)
            token.check()
            selected = loaded
            serverSearchResults =
                serverSearchResults.map { if (it.key == loaded.key) loaded else it }
            try {
                if (loaded.unread && online) {
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

    fun showMessage(value: String, failed: Boolean = false) {
        if (busy) return
        status = value
        error = failed
        retry = null
    }

    fun saveContact(contact: MailContact) {
        val a = account ?: return
        run("正在保存联系人…", false) { _, _ ->
            val address = contact.address()
            require(MimeCodec.addresses(address).size == 1) { "请填写一个有效邮箱地址" }
            withContext(Dispatchers.IO) { repo.store(a).rememberContacts(address) }
            loadCache()
            status = "联系人已保存"
        }
    }

    fun addRecipients(selected: List<MailContact>, field: String = "to"): Boolean {
        val d = draft ?: return false
        try {
            val next =
                when (field) {
                    "cc" -> d.copy(cc = MailAddresses.add(d.cc, selected))
                    "bcc" -> d.copy(bcc = MailAddresses.add(d.bcc, selected))
                    else -> d.copy(to = MailAddresses.add(d.to, selected))
                }
            require(
                (MailAddresses.parse(next.to) +
                        MailAddresses.parse(next.cc) +
                        MailAddresses.parse(next.bcc))
                    .distinctBy { it.email.lowercase() }
                    .size <= 50
            ) {
                "收件人、抄送和密送合计最多 50 人"
            }
            update(next)
            return true
        } catch (e: IllegalArgumentException) {
            status = e.message.orEmpty()
            error = true
            return false
        }
    }

    internal fun openFilter(value: MailFilter) {
        filter = value
        unreadOnly = value == MailFilter.UNREAD
        query = ""
        go("inbox")
    }

    fun compose(reply: Boolean = false, replyAll: Boolean = false, forward: Boolean = false) {
        if (busy || page == "compose") return
        dismissStatus()
        val a = account ?: return
        val m = selected
        if (
            forward &&
                m != null &&
                m.attachments.any { it.local.isBlank() || !repo.file(a, it.local).isFile }
        ) {
            showMessage("请先下载原邮件的全部附件，再转发，避免遗漏附件", true)
            return
        }
        if (
            forward &&
                m != null &&
                m.attachments.sumOf { it.size.coerceAtLeast(0) } > MAX_ATTACHMENT_BYTES
        ) {
            showMessage("原邮件附件超过 25 MB，请新建邮件并选择要发送的附件", true)
            return
        }
        val signature =
            ReadingPreferences(getApplication())
                .signature(a.id)
                .takeIf { it.isNotBlank() }
                ?.let { "\n\n$it" }
                .orEmpty()
        val d =
            try {
                if (forward && m != null)
                    Draft(
                        subject =
                            if (m.subject.startsWith("Fwd:", true)) m.subject
                            else "Fwd: ${m.subject}",
                        body = signature + quotedForward(m),
                        attachments = m.attachments.map { it.copy(contentId = "") },
                    )
                else if (reply && m != null)
                    Draft(
                        to = replyRecipients(m, a.email, replyAll),
                        body = signature,
                        subject =
                            if (m.subject.startsWith("Re:", true)) m.subject
                            else "Re: ${m.subject}",
                        replyId = m.messageId,
                    )
                else Draft(body = signature)
            } catch (e: IllegalArgumentException) {
                showMessage(e.message.orEmpty(), true)
                return
            }
        setComposerOrigin(
            if ((reply || forward) && page == "reader") "reader"
            else if (page == "contacts") "contacts" else "inbox"
        )
        draft = d
        page = "compose"
        save(d, a)
    }

    fun openDraft(d: Draft) {
        if (busy) return
        setComposerOrigin("drafts")
        dismissStatus()
        draft = d
        page = "compose"
        saveStatus = draftStatus(d)
    }

    fun update(d: Draft) {
        if (
            busy ||
                draft?.id != d.id ||
                draft?.state !in setOf(SendState.DRAFT, SendState.FAILED) ||
                d.state !in setOf(SendState.DRAFT, SendState.FAILED)
        )
            return
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
                        if (draft?.id == d.id && draft == d) {
                            saveStatus = "草稿已保存在此设备"
                            if (!busy && status.startsWith("草稿保存失败")) dismissStatus()
                        }
                    } catch (_: Exception) {
                        if (draft?.id == d.id && draft == d) {
                            saveStatus = "保存失败，请保留当前页面并重试"
                            if (!busy) {
                                status = "草稿保存失败，当前内容仍在编辑器中，请重试保存"
                                error = true
                                retry = ::retrySave
                            }
                        }
                    }
                }
            }
    }

    fun retrySave() {
        val a = account ?: return
        val d = draft ?: return
        if (d.state !in setOf(SendState.DRAFT, SendState.FAILED)) return
        run("正在保存草稿…", false, again = ::retrySave) { _, _ ->
            latestSave?.join()
            saves.withLock { withContext(Dispatchers.IO) { repo.store(a).save(d) } }
            saveStatus = "草稿已保存在此设备"
            status = saveStatus
        }
    }

    fun saveAndLeave() {
        val a = account ?: return
        val d = draft ?: return
        run("正在保存草稿…", false, again = { saveAndLeave() }) { _, _ ->
            latestSave?.join()
            saves.withLock { withContext(Dispatchers.IO) { repo.store(a).save(d) } }
            saveStatus = "草稿已保存在此设备"
            loadCache()
            page = composerDestination()
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
            page = composerDestination()
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
        run("正在下载 ${file.name}…", again = { download(file) }, network = true) { token, progress ->
            if (file.local.isBlank() || !repo.file(a, file.local).isFile) requireOnline()
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
        if (busy || draft?.state !in setOf(SendState.DRAFT, SendState.FAILED)) return
        val a = account ?: return
        val d = draft ?: return
        try {
            MimeCodec.recipients(d)
            require(d.body.isNotBlank() || d.attachments.isNotEmpty()) { "请填写正文或添加附件" }
        } catch (t: Exception) {
            retry = null
            status = message(t)
            error = true
            return
        }
        var attempted = false
        run(
            "正在保存并准备发送…",
            false,
            network = true,
            failureMessage = { cause ->
                when (draft?.state) {
                    SendState.UNCERTAIN,
                    SendState.TRANSMITTING -> draftStatus(requireNotNull(draft))
                    SendState.SENT -> "服务器已接受邮件，本地列表暂未刷新；请勿重复发送"
                    else -> "未提交成功 · ${message(cause)}；请核对草稿后重新发送"
                }
            },
        ) { token, progress ->
            latestSave?.join()
            try {
                saves.withLock { withContext(Dispatchers.IO) { repo.store(a).save(d) } }
                requireOnline()
                attempted = true
                saves.withLock { repo.send(a, d, token, progress) }
            } finally {
                // Even a dropped connection/cancelled UI must reflect the durable SMTP state.
                withContext(NonCancellable) {
                    try {
                        val persisted = withContext(Dispatchers.IO) { repo.store(a).draft(d.id) }
                        if (persisted != null) {
                            draft = persisted
                            saveStatus = draftStatus(persisted)
                        } else if (attempted) {
                            draft = d.copy(state = SendState.UNCERTAIN)
                            saveStatus = "暂时无法核对发送记录，请先检查邮箱，避免重复发送"
                        }
                    } catch (t: Exception) {
                        if (attempted) {
                            draft = d.copy(state = SendState.UNCERTAIN)
                            saveStatus = "暂时无法核对发送记录，请先检查邮箱，避免重复发送"
                        }
                        throw t
                    }
                }
            }
            loadCache()
            if (draft?.state == SendState.SENT) {
                page = "inbox"
                status = "邮件已发送 · 发送记录保存在此设备"
                _feedback.tryEmit(Unit)
            } else {
                status = saveStatus
                error = true
            }
        }
    }

    override fun onCleared() {
        if (assistantState.isInitialized()) assistant.dispose()
        connection.close()
        op?.cancel()
        super.onCleared()
    }
}
