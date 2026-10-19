package com.mailai.mobile.ui

import android.animation.ValueAnimator
import android.os.PowerManager
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Image
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.mailai.mobile.R
import com.mailai.mobile.assistant.*

@Composable
internal fun XiaoyouButton(vm: MailViewModel) {
    IconButton(
        onClick = { vm.openAssistant() },
        enabled = !vm.busy,
        modifier = Modifier.size(48.dp).testTag("xiaoyou-open"),
    ) {
        Image(painterResource(R.drawable.ic_xiaoyou), "小邮", Modifier.size(30.dp))
    }
}

@Composable
private fun XiaoyouFace(a: AssistantController) {
    val context = LocalContext.current
    val motion =
        ValueAnimator.areAnimatorsEnabled() &&
            !context.getSystemService(PowerManager::class.java).isPowerSaveMode
    // A finite tilt on a real task transition, never a repeating breathing or thinking loop.
    val angle by
        animateFloatAsState(
            if (motion && a.generating) -4f else 0f,
            tween(if (motion) 160 else 0),
            label = "小邮状态回应",
        )
    val art =
        when {
            a.failed -> R.drawable.ic_xiaoyou
            a.generating -> R.drawable.ic_xiaoyou_thinking
            a.complete -> R.drawable.ic_xiaoyou_happy
            else -> R.drawable.ic_xiaoyou
        }
    Image(painterResource(art), null, Modifier.size(38.dp).graphicsLayer { rotationZ = angle })
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun AssistantSheet(vm: MailViewModel) {
    val a = vm.assistant
    if (!a.visible) return
    val source = a.source ?: return
    val maxHeight = (LocalConfiguration.current.screenHeightDp.dp - 32.dp).coerceAtLeast(200.dp)
    val focus = LocalFocusManager.current
    var addInstruction by rememberSaveable(source.sourceId) { mutableStateOf(false) }
    val choose = !a.generating && a.text.isBlank()
    fun start(task: AssistantTask) {
        focus.clearFocus()
        a.start(task)
    }
    ModalBottomSheet(
        onDismissRequest = { a.close() },
        sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
        containerColor = MaterialTheme.colorScheme.surface,
        dragHandle = null,
    ) {
        Column(
            Modifier.fillMaxWidth().heightIn(max = maxHeight).imePadding().testTag("xiaoyou-sheet")
        ) {
            Row(
                Modifier.fillMaxWidth().padding(start = 20.dp, top = 12.dp, end = 8.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                XiaoyouFace(a)
                Text(
                    "小邮",
                    Modifier.weight(1f).padding(start = 8.dp),
                    fontSize = 18.sp,
                    fontWeight = FontWeight.SemiBold,
                )
                TextButton(onClick = { a.close() }, enabled = !a.loading && !a.applying) {
                    Text("关闭")
                }
            }
            Column(
                Modifier.weight(1f, fill = false)
                    .verticalScroll(rememberScrollState())
                    .padding(horizontal = 24.dp)
                    .padding(top = 6.dp, bottom = 18.dp),
                verticalArrangement = Arrangement.spacedBy(14.dp),
            ) {
                run {
                    if (source.sourceId.isNotBlank()) {
                        Text(
                            source.title.ifBlank { "无主题" },
                            fontSize = 15.sp,
                            fontWeight = FontWeight.Medium,
                            maxLines = 2,
                            overflow = TextOverflow.Ellipsis,
                        )
                        Text(
                            "${if (source.draft != null) { if (source.start != 0 || source.end != source.text.length) "选中文字" else "当前草稿" } else "这封邮件"} · ${source.accountLabel}",
                            fontSize = 12.sp,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                    if (a.loading)
                        Text("正在读取此设备的小邮配置…", color = MaterialTheme.colorScheme.onSurfaceVariant)
                    else if (!a.configured) {
                        Text("看懂一封邮件，写好一份回复。", fontSize = 17.sp, fontWeight = FontWeight.Medium)
                        Text(
                            "接入你的模型服务后就能开始。只在你主动操作时处理当前文字。",
                            fontSize = 14.sp,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                        Button(
                            onClick = { vm.openAssistantSettings() },
                            modifier = Modifier.fillMaxWidth(),
                            shape = RoundedCornerShape(16.dp),
                        ) {
                            Text("前往设置")
                        }
                    } else if (source.sourceId.isNotBlank() && choose) {
                        if (source.draft != null) {
                            AssistantAction(
                                "润色文字",
                                "保留原意，让表达更顺畅",
                                source.selectedText.isNotBlank() && !a.busy,
                            ) {
                                start(AssistantTask.POLISH)
                            }
                        } else {
                            AssistantAction(
                                "提炼要点",
                                "先把重点和要做的事理清",
                                source.text.isNotBlank() && !a.busy,
                            ) {
                                start(AssistantTask.SUMMARY)
                            }
                            AssistantAction(
                                "起草回复",
                                "先拟一份，你来决定怎么发",
                                source.text.isNotBlank() && !a.busy,
                            ) {
                                start(AssistantTask.REPLY)
                            }
                        }
                        if (source.text.isBlank()) Text("正文还没读完，加载完成后再叫我。", fontSize = 14.sp)
                        else if (!addInstruction && a.instruction.isBlank())
                            TextButton(onClick = { addInstruction = true }) { Text("补充一句要求") }
                        else
                            TextField(
                                value = a.instruction,
                                onValueChange = a::changeInstruction,
                                placeholder = { Text("例如：简短一些，语气自然") },
                                minLines = 1,
                                maxLines = 3,
                                modifier = Modifier.fillMaxWidth().testTag("xiaoyou-instruction"),
                                enabled = !a.busy,
                                shape = RoundedCornerShape(16.dp),
                                colors = assistantFieldColors(),
                            )
                        Text(
                            "仅使用当前文字，不包含附件和其他邮件",
                            fontSize = 12.sp,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    } else if (source.sourceId.isBlank()) {
                        Text("从一封邮件开始", fontSize = 17.sp, fontWeight = FontWeight.Medium)
                        Text(
                            "打开邮件可以提炼和回复，写信时可以润色。",
                            fontSize = 14.sp,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                        TextButton(
                            onClick = {
                                a.close()
                                vm.go("search")
                            }
                        ) {
                            Text("去找邮件")
                        }
                    }
                    if (a.text.isNotBlank()) {
                        HorizontalDivider(
                            color = MaterialTheme.colorScheme.outlineVariant.copy(alpha = .5f)
                        )
                        Text(
                            when (a.task) {
                                AssistantTask.SUMMARY -> "邮件要点"
                                AssistantTask.REPLY -> "回复预览"
                                else -> "润色预览"
                            },
                            fontSize = 13.sp,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                        SelectionContainer {
                            Text(
                                a.text,
                                fontSize = 16.sp,
                                lineHeight = 27.sp,
                                modifier = Modifier.testTag("xiaoyou-result"),
                            )
                        }
                    }
                    if (a.message.isNotBlank())
                        Text(
                            a.message,
                            color =
                                if (a.failed) MaterialTheme.colorScheme.error
                                else MaterialTheme.colorScheme.onSurfaceVariant,
                            fontSize = 13.sp,
                            modifier = Modifier.testTag("xiaoyou-status"),
                        )
                    if (a.applying) Text("正在保存草稿…")
                }
            }
            Column(Modifier.fillMaxWidth().padding(horizontal = 24.dp).padding(bottom = 12.dp)) {
                if (a.generating)
                    OutlinedButton(
                        onClick = a::stop,
                        modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp),
                        shape = RoundedCornerShape(16.dp),
                    ) {
                        Text("停止生成")
                    }
                if (!a.complete && !a.busy && a.task != null)
                    TextButton(
                        onClick = { a.start(requireNotNull(a.task), true) },
                        modifier = Modifier.fillMaxWidth(),
                    ) {
                        Text(if (a.failed) "重试" else "重新生成")
                    }
                if (a.complete && !a.busy) {
                    Button(
                        onClick = {
                            if (a.task == AssistantTask.SUMMARY) start(AssistantTask.REPLY)
                            else vm.adoptAssistant()
                        },
                        enabled = !vm.busy && !a.failed,
                        shape = RoundedCornerShape(16.dp),
                        modifier = Modifier.fillMaxWidth().testTag("xiaoyou-adopt"),
                    ) {
                        Text(
                            when (a.task) {
                                AssistantTask.SUMMARY -> "起草回复"
                                AssistantTask.REPLY -> "用这份回复"
                                else -> "用这版文字"
                            }
                        )
                    }
                    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceEvenly) {
                        TextButton(onClick = { a.start(requireNotNull(a.task), true) }) {
                            Text("重新生成")
                        }
                        TextButton(
                            onClick = {
                                a.editRequest()
                                addInstruction = true
                            }
                        ) {
                            Text("调整要求")
                        }
                    }
                }
            }
        }
    }
}

@Composable
internal fun AssistantSettingsScreen(vm: MailViewModel) {
    val a = vm.assistant
    Column(Modifier.fillMaxSize()) {
        PageHeader("小邮与模型服务", vm::closeAssistantSettings)
        Column(
            Modifier.weight(1f)
                .verticalScroll(rememberScrollState())
                .imePadding()
                .padding(horizontal = 20.dp, vertical = 8.dp),
            verticalArrangement = Arrangement.spacedBy(14.dp),
        ) {
            AssistantSettingsForm(a)
            Spacer(Modifier.height(20.dp))
        }
    }
}

@Composable
private fun AssistantAction(title: String, detail: String, enabled: Boolean, click: () -> Unit) {
    Surface(
        onClick = click,
        enabled = enabled,
        color = MaterialTheme.colorScheme.surfaceContainerLow,
        shape = RoundedCornerShape(16.dp),
        modifier = Modifier.fillMaxWidth(),
    ) {
        Row(
            Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 15.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Column(Modifier.weight(1f)) {
                Text(
                    title,
                    fontSize = 16.sp,
                    fontWeight = FontWeight.Medium,
                    color = MaterialTheme.colorScheme.onSurface,
                )
                Text(
                    detail,
                    Modifier.padding(top = 4.dp),
                    fontSize = 12.sp,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            MailIcon(
                MailGlyph.Chevron,
                modifier = Modifier.size(18.dp),
                tint = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}

@Composable
private fun assistantFieldColors() =
    TextFieldDefaults.colors(
        focusedContainerColor = MaterialTheme.colorScheme.surfaceContainerLow,
        unfocusedContainerColor = MaterialTheme.colorScheme.surfaceContainerLow,
        disabledContainerColor = MaterialTheme.colorScheme.surfaceContainerLow,
        focusedIndicatorColor = androidx.compose.ui.graphics.Color.Transparent,
        unfocusedIndicatorColor = androidx.compose.ui.graphics.Color.Transparent,
        disabledIndicatorColor = androidx.compose.ui.graphics.Color.Transparent,
    )

@Composable
private fun AssistantSettingsForm(a: AssistantController) {
    var endpoint by remember(a.endpoint) { mutableStateOf(a.endpoint) }
    var model by remember(a.model) { mutableStateOf(a.model) }
    // Secrets deliberately never use rememberSaveable / saved instance state.
    var key by remember { mutableStateOf("") }
    var privateNetwork by remember(a.privateNetwork) { mutableStateOf(a.privateNetwork) }
    var consent by remember { mutableStateOf(false) }
    var removing by remember { mutableStateOf(false) }
    LaunchedEffect(a.loading) { if (!a.loading && !a.failed) key = "" }
    Text("接入模型服务", fontSize = 17.sp, fontWeight = FontWeight.Medium)
    Text(
        "使用你自己的兼容接口与 API Key。手机直接连接，服务可能按使用量计费。",
        fontSize = 13.sp,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
    )
    TextField(
        endpoint,
        { endpoint = it.take(2048) },
        label = { Text("HTTPS 对话接口地址") },
        placeholder = { Text("https://服务地址/v1/chat/completions") },
        modifier = Modifier.fillMaxWidth().testTag("xiaoyou-endpoint"),
        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri),
        enabled = !a.busy,
        shape = RoundedCornerShape(14.dp),
        colors = assistantFieldColors(),
    )
    TextField(
        model,
        { model = it.take(128) },
        label = { Text("模型名称") },
        modifier = Modifier.fillMaxWidth().testTag("xiaoyou-model"),
        singleLine = true,
        enabled = !a.busy,
        shape = RoundedCornerShape(14.dp),
        colors = assistantFieldColors(),
    )
    TextField(
        key,
        { key = it.take(8192) },
        label = { Text(if (a.configured) "API Key（留空保留原值）" else "API Key") },
        visualTransformation = PasswordVisualTransformation(),
        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password),
        singleLine = true,
        modifier = Modifier.fillMaxWidth().testTag("xiaoyou-key"),
        enabled = !a.busy,
        shape = RoundedCornerShape(14.dp),
        colors = assistantFieldColors(),
    )
    Row(verticalAlignment = Alignment.CenterVertically) {
        Checkbox(privateNetwork, { privateNetwork = it }, enabled = !a.busy)
        Text("这是我配置的企业内网模型服务", fontSize = 14.sp, modifier = Modifier.weight(1f))
    }
    if (privateNetwork)
        Text(
            "使用可见 VPN 或公司 Wi-Fi，继续校验证书。",
            fontSize = 12.sp,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    Row(verticalAlignment = Alignment.CenterVertically) {
        Checkbox(
            consent,
            { consent = it },
            enabled = !a.busy,
            modifier = Modifier.testTag("xiaoyou-consent"),
        )
        Text("允许将当前操作所需文字发送至这个服务", fontSize = 14.sp, modifier = Modifier.weight(1f))
    }
    if (a.message.isNotBlank())
        Text(
            a.message,
            fontSize = 13.sp,
            color =
                if (a.failed) MaterialTheme.colorScheme.error
                else MaterialTheme.colorScheme.onSurfaceVariant,
        )
    Button(
        onClick = { a.saveSettings(endpoint, model, key, privateNetwork, consent) },
        enabled = !a.busy,
        modifier = Modifier.fillMaxWidth().testTag("xiaoyou-save-settings"),
        shape = RoundedCornerShape(16.dp),
    ) {
        Text(if (a.loading) "正在保存…" else "保存配置")
    }
    if (a.configured)
        TextButton(
            onClick = { removing = true },
            enabled = !a.busy,
            modifier = Modifier.fillMaxWidth(),
        ) {
            Text("移除配置与候选结果", color = MaterialTheme.colorScheme.error)
        }
    if (removing)
        AlertDialog(
            onDismissRequest = { removing = false },
            title = { Text("移除此设备的小邮数据？") },
            text = { Text("移除模型配置与候选结果，邮件和草稿仍保留。") },
            confirmButton = {
                TextButton(
                    onClick = {
                        removing = false
                        a.clearSettings()
                    }
                ) {
                    Text("移除")
                }
            },
            dismissButton = { TextButton(onClick = { removing = false }) { Text("取消") } },
        )
}
