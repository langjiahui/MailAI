package com.mailai.mobile.ui

import androidx.compose.animation.*
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.platform.LocalAccessibilityManager
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.*
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.delay

/** Overlay feedback never participates in page measurement or changes its scroll position. */
@Composable
internal fun OperationBubble(vm: MailViewModel, modifier: Modifier = Modifier) {
    var visible by remember { mutableStateOf(false) }
    var offline by remember { mutableStateOf(false) }
    var details by remember { mutableStateOf(false) }
    val accessibility = LocalAccessibilityManager.current
    LaunchedEffect(vm.status, vm.busy, vm.error) {
        visible = vm.status.isNotBlank()
        if (!vm.busy && visible) {
            delay(
                accessibility?.calculateRecommendedTimeoutMillis(
                    4000,
                    containsText = true,
                    containsControls = vm.canRetry,
                ) ?: 4000
            )
            visible = false
            if (!vm.error && !vm.status.startsWith("已取消")) vm.dismissStatus()
        }
    }
    LaunchedEffect(vm.online, vm.ready) {
        offline = vm.ready && !vm.online
        if (offline) {
            delay(4000)
            offline = false
        }
    }
    val inlineSearch =
        vm.page == "search" &&
            vm.matchingServerSearch() &&
            (vm.serverSearchLoading ||
                vm.status == vm.serverSearchFailure ||
                vm.status == "服务器搜索完成" ||
                (vm.status.startsWith("已取消") && vm.serverSearchFailure.startsWith("搜索已取消")))
    AnimatedVisibility(
        visible = (visible || offline) && !inlineSearch,
        modifier = modifier.widthIn(max = 560.dp),
        enter = fadeIn(tween(140)) + slideInVertically(tween(180)) { it / 4 },
        exit = fadeOut(tween(140)),
    ) {
        Box(
            Modifier.shadow(6.dp, RoundedCornerShape(20.dp))
                .clip(RoundedCornerShape(20.dp))
                .background(MaterialTheme.colorScheme.inverseSurface)
        ) {
            Row(
                Modifier.padding(start = 16.dp, end = 8.dp)
                    .heightIn(min = 48.dp)
                    .testTag("operation-bubble"),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Column(
                    Modifier.weight(1f, fill = false)
                        .then(
                            if (visible && (vm.error || vm.busy))
                                Modifier.clickable { details = true }
                            else Modifier
                        )
                        .padding(vertical = 12.dp)
                        .semantics { liveRegion = LiveRegionMode.Polite }
                ) {
                    Text(
                        if (visible) vm.status else "当前离线 · 邮件缓存与草稿仍可使用",
                        fontSize = 13.sp,
                        color = MaterialTheme.colorScheme.inverseOnSurface,
                        maxLines = 2,
                        overflow = TextOverflow.Ellipsis,
                    )
                    if (visible && vm.operationHint.isNotBlank())
                        Text(
                            vm.operationHint,
                            fontSize = 12.sp,
                            maxLines = 2,
                            color = MaterialTheme.colorScheme.inverseOnSurface,
                        )
                }
                if (visible && vm.busy && vm.cancellable)
                    TextButton(onClick = vm::cancel) {
                        Text("取消", color = MaterialTheme.colorScheme.inversePrimary)
                    }
                else if (
                    visible && !vm.busy && vm.canRetry && (vm.error || vm.status.startsWith("已取消"))
                )
                    TextButton(onClick = vm::retry) {
                        Text("重试", color = MaterialTheme.colorScheme.inversePrimary)
                    }
            }
        }
    }
    if (details)
        AlertDialog(
            onDismissRequest = { details = false },
            title = { Text(if (vm.error) "操作未完成" else "操作提示") },
            text = { Text(vm.status.ifBlank { "当前离线，已缓存邮件与草稿仍可使用。" }) },
            confirmButton = { TextButton(onClick = { details = false }) { Text("知道了") } },
        )
}
