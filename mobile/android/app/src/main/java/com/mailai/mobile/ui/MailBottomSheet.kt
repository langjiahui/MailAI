package com.mailai.mobile.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch

/** Shared compact, draggable chrome; Material handles nested scrolling and accessible actions. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun MailBottomSheet(
    title: String,
    onDismiss: () -> Unit,
    sheetState: SheetState = rememberModalBottomSheetState(),
    closeLabel: String = "完成",
    closeEnabled: Boolean = true,
    onClose: (() -> Unit)? = null,
    leading: (@Composable () -> Unit)? = null,
    content: @Composable ColumnScope.() -> Unit,
) {
    val scope = rememberCoroutineScope()
    var closing by remember { mutableStateOf(false) }
    val density = LocalDensity.current
    val safe = WindowInsets.safeDrawing
    val safeHeight =
        LocalConfiguration.current.screenHeightDp.dp -
            with(density) { (safe.getTop(this) + safe.getBottom(this)).toDp() }
    val bodyHeight = (safeHeight * .94f - 68.dp).coerceAtLeast(48.dp)
    val expandedBeforeResize = sheetState.targetValue == SheetValue.Expanded
    // Open at a readable height without disabling the partially expanded drag anchor.
    // Redirect Material's initial show animation before it settles; do this only on entry,
    // never when the user later pulls the sheet down to its compact position.
    LaunchedEffect(sheetState) {
        snapshotFlow { sheetState.targetValue }.first { it != SheetValue.Hidden }
        sheetState.expand()
    }
    ModalBottomSheet(
        modifier =
            Modifier.testTag("mail-sheet").onSizeChanged {
                // Material 1.3 resets either visible anchor to PartiallyExpanded on a size
                // change. Preserve an expanded reading panel when results/loaders resize it.
                // A user's drag only changes the offset, so it does not trigger this correction.
                if (expandedBeforeResize) scope.launch { sheetState.expand() }
            },
        onDismissRequest = onDismiss,
        sheetState = sheetState,
        containerColor = MaterialTheme.colorScheme.surface,
        contentColor = MaterialTheme.colorScheme.onSurface,
        shape = RoundedCornerShape(topStart = 24.dp, topEnd = 24.dp),
        // The sheet already stops below the status bar. Do not add a second top inset
        // inside its handle/header, especially when the panel is partially expanded.
        contentWindowInsets = {
            WindowInsets.safeDrawing.only(WindowInsetsSides.Bottom + WindowInsetsSides.Horizontal)
        },
        dragHandle = {
            Column(Modifier.fillMaxWidth().testTag("mail-sheet-header")) {
                Box(Modifier.fillMaxWidth().height(20.dp), contentAlignment = Alignment.Center) {
                    Box(
                        Modifier.width(32.dp)
                            .height(4.dp)
                            .background(MaterialTheme.colorScheme.outline, RoundedCornerShape(2.dp))
                            .testTag("mail-sheet-handle")
                    )
                }
                Row(
                    Modifier.fillMaxWidth()
                        .heightIn(min = 48.dp)
                        .padding(start = 20.dp, end = 8.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    leading?.invoke()
                    Text(
                        title,
                        Modifier.weight(1f),
                        fontSize = 18.sp,
                        fontWeight = FontWeight.SemiBold,
                    )
                    TextButton(
                        enabled = closeEnabled && !closing,
                        onClick = {
                            if (onClose != null) onClose()
                            else {
                                closing = true
                                scope.launch {
                                    try {
                                        sheetState.hide()
                                        if (!sheetState.isVisible) onDismiss()
                                    } finally {
                                        closing = false
                                    }
                                }
                            }
                        },
                    ) {
                        Text(closeLabel, fontSize = 14.sp)
                    }
                }
            }
        },
    ) {
        Column(Modifier.fillMaxWidth().heightIn(max = bodyHeight).clipToBounds(), content = content)
    }
}
