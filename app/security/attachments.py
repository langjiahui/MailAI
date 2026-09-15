"""附件静态分析：哈希、真实类型、宏/脚本特征。"""
import hashlib
import io
import zipfile


def _ext(name: str) -> str:
    if not name or "." not in name:
        return ""
    return "." + name.rsplit(".", 1)[-1].lower()


def _sha256(payload: bytes) -> str:
    return hashlib.sha256(payload or b"").hexdigest()


def _magic_type(payload: bytes) -> str:
    """基于 magic byte 识别真实文件类型（不依赖 python-magic）。"""
    if not payload:
        return "empty"
    head = payload[:8]
    if head[:2] == b"MZ":
        return "PE executable (Windows)"
    if head[:4] == b"\x7fELF":
        return "ELF executable (Linux)"
    if head[:4] == b"\xcf\xed\xed\xce":
        return "Microsoft Installer (MSI)"
    if head[:4] == b"PK\x03\x04":
        # 可能是 zip/Office/OpenXML/JAR
        if b"word/_rels/document.xml.rels" in payload[:4096]:
            return "Office Open XML (docx/xlsx/pptx)"
        if b"META-INF/MANIFEST.MF" in payload[:4096]:
            return "Java Archive (JAR)"
        return "ZIP archive"
    if head[:4] == b"Rar!":
        return "RAR archive"
    if head[:6] == b"\xd0\xcf\x11\xe0\xa1\xb1":
        return "OLE document (doc/xls/ppt)"
    if head[:4] == b"%PDF":
        return "PDF document"
    if head[:4] == b"\x89PNG":
        return "PNG image"
    if head[:2] == b"\xff\xd8":
        return "JPEG image"
    return "unknown"


def _has_macro(payload: bytes, ext: str, declared_type: str) -> bool:
    """简单宏检测：OLE 文档或 OOXML 中是否含 vba 相关结构。"""
    low = (declared_type or "").lower()
    if ext in (".docm", ".xlsm", ".pptm"):
        return True
    if "wordprocessingml" in low or "spreadsheetml" in low or "presentationml" in low:
        # OOXML：检查 zip 内是否有 vbaProject.bin
        try:
            with zipfile.ZipFile(io.BytesIO(payload)) as z:
                return any("vba" in n.lower() for n in z.namelist())
        except Exception:
            return False
    if ext in (".doc", ".xls", ".ppt") or _magic_type(payload) == "OLE document (doc/xls/ppt)":
        # OLE：简单字节搜索（非精确但够用）
        return b"vba" in payload.lower() or b"_vba_project" in payload.lower()
    return False


def _list_archive_contents(payload: bytes, max_items: int = 20) -> list:
    """列出 zip/rar 压缩包内文件扩展名。"""
    items = []
    try:
        with zipfile.ZipFile(io.BytesIO(payload)) as z:
            for name in z.namelist()[:max_items]:
                ext = _ext(name)
                if ext:
                    items.append(ext)
    except Exception:
        pass
    return items


_DANGEROUS_EXECUTABLE = {".exe", ".scr", ".bat", ".cmd", ".ps1", ".vbs", ".vbe", ".js", ".jse",
                         ".wsf", ".jar", ".lnk", ".iso", ".img", ".msi", ".dll", ".com", ".pif",
                         ".ace", ".apk", ".docm", ".xlsm", ".pptm"}


def analyze_attachment(name: str, content_type: str, payload: bytes) -> dict:
    """返回附件深度分析结果：{sha256, real_type, has_macro, archive_contents, findings}。"""
    ext = _ext(name)
    real_type = _magic_type(payload)
    has_macro = _has_macro(payload, ext, content_type)
    findings = []

    if ext in _DANGEROUS_EXECUTABLE:
        findings.append({
            "code": "ATT_DANGER_EXT",
            "detail": f"高风险可执行/宏附件: {name}",
            "weight": 30,
        })

    if has_macro:
        findings.append({
            "code": "ATT_MACRO",
            "detail": f"附件包含宏（可能携带恶意脚本）: {name}",
            "weight": 35,
        })

    declared = (content_type or "").lower()
    # 声明类型与真实类型不一致
    if declared and real_type != "unknown":
        if "zip" not in declared and "octet-stream" not in declared:
            if ("pdf" in declared and "PDF" not in real_type) or \
               ("image" in declared and "image" not in real_type) or \
               ("word" in declared or "excel" in declared) and "Office" not in real_type and "OLE" not in real_type:
                findings.append({
                    "code": "ATT_TYPE_MISMATCH",
                    "detail": f"声明类型 {declared} 与真实类型 {real_type} 不一致: {name}",
                    "weight": 25,
                })

    archive_exts = _list_archive_contents(payload)
    if archive_exts and any(e in _DANGEROUS_EXECUTABLE for e in archive_exts):
        findings.append({
            "code": "ATT_ARCHIVE_EXE",
            "detail": f"压缩包内含可执行/宏文件: {name}",
            "weight": 30,
        })

    return {
        "name": name,
        "sha256": _sha256(payload),
        "declared_type": content_type,
        "real_type": real_type,
        "has_macro": has_macro,
        "archive_contents": archive_exts,
        "findings": findings,
    }


def analyze_all_attachments(email: dict) -> list:
    """分析邮件全部附件，返回分析结果列表。"""
    from ..parser import extract_attachment

    results = []
    for idx, att in enumerate(email.get("attachments") or []):
        payload = None
        try:
            full = extract_attachment(email.get("raw_path"), idx)
            payload = full.get("payload") if full else None
        except Exception:
            payload = None
        results.append(analyze_attachment(
            att.get("name", "未命名"),
            att.get("content_type", ""),
            payload or b"",
        ))
    return results
