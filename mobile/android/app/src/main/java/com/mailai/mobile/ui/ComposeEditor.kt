package com.mailai.mobile.ui

import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.ScrollState
import androidx.compose.foundation.background
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.relocation.BringIntoViewRequester
import androidx.compose.foundation.relocation.bringIntoViewRequester
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.mailai.mobile.R
import com.mailai.mobile.data.SendState

/** Keeps sending and attachment import on the existing guarded, persistent draft path. */
@Composable
internal fun ComposeEditor(vm: MailViewModel, back: () -> Unit, send: () -> Unit) {
    var lastDraft by remember { mutableStateOf(vm.draft) }
    val draft = vm.draft ?: lastDraft ?: return
    SideEffect { if (vm.draft != null) lastDraft = vm.draft }
    val scroll = rememberSaveable(draft.id, saver = ScrollState.Saver) { ScrollState(0) }
    val subjectFocus = remember { FocusRequester() }
    val bodyFocus = remember { FocusRequester() }
    val bodyPosition = remember { BringIntoViewRequester() }
    var bodyFocused by remember { mutableStateOf(false) }
    var showCopies by
        rememberSaveable(draft.id) {
            mutableStateOf(draft.cc.isNotBlank() || draft.bcc.isNotBlank())
        }
    val editable = !vm.busy && draft.state in setOf(SendState.DRAFT, SendState.FAILED)
    val picker =
        rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { uri ->
            if (uri != null) vm.attach(uri)
        }
    val colors = MaterialTheme.colorScheme
    val compact =
        LocalConfiguration.current.screenWidthDp < 360 || LocalDensity.current.fontScale > 1.3f
    val paper = if (isSystemInDarkTheme()) Color(0xFF171E25) else Color.White
    val wash = if (isSystemInDarkTheme()) Color(0xFF1C2731) else Color(0xFFF3F8FC)
    Column(Modifier.fillMaxSize().background(Brush.verticalGradient(listOf(wash, paper)))) {
        Row(
            Modifier.fillMaxWidth().padding(start = 4.dp, end = 16.dp, top = 4.dp, bottom = 4.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            IconButton(
                onClick = back,
                enabled = !vm.busy,
                modifier = Modifier.testTag("compose-back"),
            ) {
                ComposeIcon(R.drawable.ic_compose_back, "返回")
            }
            Text(
                "写信",
                Modifier.weight(1f).testTag("compose-title"),
                fontSize = 20.sp,
                fontWeight = FontWeight.SemiBold,
                maxLines = 1,
            )
            if (!compact)
                IconButton(onClick = { picker.launch(arrayOf("*/*")) }, enabled = editable) {
                    ComposeIcon(R.drawable.ic_compose_attach, "添加附件")
                }
            Button(
                onClick = send,
                enabled = editable,
                shape = RoundedCornerShape(50),
                contentPadding = PaddingValues(horizontal = 16.dp, vertical = 10.dp),
                modifier = Modifier.heightIn(min = 48.dp).testTag("compose-send"),
            ) {
                ComposeIcon(R.drawable.ic_compose_send, null, Modifier.size(19.dp))
                Spacer(Modifier.width(7.dp))
                Text("发送", fontSize = 14.sp, lineHeight = 20.sp, maxLines = 1, softWrap = false)
            }
        }
        BoxWithConstraints(Modifier.weight(1f)) {
            // The editor has its own text scroll; the page can still reveal all header fields on
            // IME.
            val editorHeight =
                (maxHeight * .56f).coerceIn(
                    minOf(112.dp, (maxHeight - 56.dp).coerceAtLeast(64.dp)),
                    640.dp,
                )
            LaunchedEffect(draft.body, editorHeight, bodyFocused) {
                if (bodyFocused) {
                    withFrameNanos {}
                    bodyPosition.bringIntoView()
                }
            }
            Column(
                Modifier.fillMaxSize().verticalScroll(scroll).padding(horizontal = 16.dp),
                verticalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                Text(
                    "发件人  ${vm.account?.email.orEmpty()}",
                    Modifier.fillMaxWidth().padding(top = 4.dp),
                    fontSize = 12.sp,
                    color = colors.onSurfaceVariant,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
                RecipientEditor(vm, draft, editable) { subjectFocus.requestFocus() }
                TextButton(
                    onClick = { showCopies = !showCopies },
                    modifier = Modifier.heightIn(min = 44.dp),
                ) {
                    Text(
                        if (showCopies) "收起抄送 / 密送"
                        else if (draft.cc.isNotBlank() || draft.bcc.isNotBlank()) "抄送 / 密送 · 已填写"
                        else "抄送 / 密送",
                        fontSize = 12.sp,
                    )
                }
                androidx.compose.animation.AnimatedVisibility(showCopies) {
                    Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                        RecipientEditor(vm, draft, editable, "cc") { subjectFocus.requestFocus() }
                        RecipientEditor(vm, draft, editable, "bcc") { subjectFocus.requestFocus() }
                    }
                }
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text("主题", Modifier.width(composerLabelWidth()), fontSize = 15.sp)
                    TextField(
                        value = draft.subject,
                        onValueChange = { vm.update(draft.copy(subject = it)) },
                        placeholder = { Text("请输入邮件主题", fontSize = 15.sp) },
                        readOnly = !editable,
                        singleLine = true,
                        keyboardOptions = KeyboardOptions(imeAction = ImeAction.Next),
                        keyboardActions = KeyboardActions(onNext = { bodyFocus.requestFocus() }),
                        modifier =
                            Modifier.weight(1f)
                                .focusRequester(subjectFocus)
                                .testTag("compose-subject")
                                .semantics { contentDescription = "主题" },
                        colors = composePaperColors(),
                        textStyle = LocalTextStyle.current.copy(fontSize = 16.sp),
                    )
                }
                if (draft.attachments.isNotEmpty()) {
                    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                        draft.attachments.forEach { attachment ->
                            Surface(
                                shape = RoundedCornerShape(12.dp),
                                color = colors.surfaceVariant,
                            ) {
                                Row(
                                    Modifier.fillMaxWidth().padding(start = 12.dp),
                                    verticalAlignment = Alignment.CenterVertically,
                                ) {
                                    FileLabel(attachment.name, attachment.size, Modifier.weight(1f))
                                    TextButton(
                                        onClick = {
                                            vm.update(
                                                draft.copy(
                                                    attachments = draft.attachments - attachment
                                                )
                                            )
                                        },
                                        enabled = editable,
                                    ) {
                                        Text("移除", fontSize = 12.sp)
                                    }
                                }
                            }
                        }
                    }
                }
                Surface(
                    shape = RoundedCornerShape(18.dp),
                    color = paper,
                    modifier = Modifier.bringIntoViewRequester(bodyPosition),
                ) {
                    RichComposeBody(
                        draft,
                        editable,
                        editorHeight,
                        bodyFocus,
                        { bodyFocused = it },
                        vm::update,
                    ) {
                        vm.showMessage(it)
                    }
                }
                Spacer(Modifier.height(2.dp))
            }
        }
        // Persistent save failures remain actionable; success stays quiet and compact.
        val saveFailed = vm.saveStatus.contains("失败") || draft.state == SendState.UNCERTAIN
        Row(
            Modifier.fillMaxWidth().padding(start = 20.dp, end = 12.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(
                vm.saveStatus,
                Modifier.weight(1f).padding(vertical = 6.dp).semantics {
                    liveRegion = LiveRegionMode.Polite
                },
                fontSize = 11.sp,
                lineHeight = 15.sp,
                color = if (saveFailed) colors.error else colors.onSurfaceVariant,
                maxLines = if (saveFailed) 3 else 1,
                overflow = TextOverflow.Ellipsis,
            )
            if (vm.saveStatus.startsWith("保存失败")) {
                TextButton(onClick = vm::retrySave, enabled = !vm.busy) { Text("重试保存") }
            }
        }
        Row(
            Modifier.fillMaxWidth().background(paper).padding(horizontal = 12.dp, vertical = 2.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            TextButton(
                onClick = { picker.launch(arrayOf("image/*")) },
                enabled = editable,
                modifier =
                    (if (compact) Modifier.weight(1f) else Modifier)
                        .heightIn(min = 48.dp)
                        .testTag("compose-photo"),
            ) {
                ComposeIcon(R.drawable.ic_compose_photo, null, Modifier.size(21.dp))
                Spacer(Modifier.width(7.dp))
                Text("图片", fontSize = 13.sp, lineHeight = 18.sp, maxLines = 1, softWrap = false)
            }
            TextButton(
                onClick = { picker.launch(arrayOf("*/*")) },
                enabled = editable,
                modifier =
                    (if (compact) Modifier.weight(1f) else Modifier)
                        .heightIn(min = 48.dp)
                        .testTag("compose-attachment")
                        .semantics { contentDescription = "附件，合计 25 MB 内" },
            ) {
                ComposeIcon(R.drawable.ic_compose_attach, null, Modifier.size(21.dp))
                Spacer(Modifier.width(7.dp))
                Text("附件", fontSize = 13.sp, lineHeight = 18.sp, maxLines = 1, softWrap = false)
            }
            if (!compact)
                Text(
                    "合计 25 MB 内",
                    Modifier.weight(1f).padding(end = 4.dp),
                    fontSize = 11.sp,
                    color = colors.onSurfaceVariant,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    textAlign = TextAlign.End,
                )
        }
    }
}

@Composable
internal fun ComposeIcon(
    resource: Int,
    description: String?,
    modifier: Modifier = Modifier.size(24.dp),
) {
    Icon(painterResource(resource), contentDescription = description, modifier = modifier)
}

@Composable
private fun composePaperColors() =
    TextFieldDefaults.colors(
        focusedContainerColor = Color.Transparent,
        unfocusedContainerColor = Color.Transparent,
        disabledContainerColor = Color.Transparent,
        focusedIndicatorColor = Color.Transparent,
        unfocusedIndicatorColor = Color.Transparent,
        disabledIndicatorColor = Color.Transparent,
    )

/** Soft fills separate editable areas without drawing a grid around the content. */
@Composable
internal fun composerFieldColor() =
    if (isSystemInDarkTheme()) Color(0xFF222E37) else Color(0xFFF0F5F8)

@Composable internal fun composerLabelWidth() = maxOf(56f, 48f * LocalDensity.current.fontScale).dp
