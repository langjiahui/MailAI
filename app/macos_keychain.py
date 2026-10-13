"""Read macOS credentials with an explicit OS authorization policy.

Background/status queries must fail quietly when an item needs authorization.
Use Security.framework directly: killing the `security` CLI on a short timeout
can interrupt an authorization dialog before the user finishes responding.
"""
import ctypes as C
from contextlib import contextmanager
from ctypes.util import find_library
from functools import lru_cache
import logging
import threading

NOT_FOUND = -25300
DUPLICATE = -25299
AUTH_REQUIRED = {-25308, -25293, -128}
_interaction_lock = threading.RLock()
log = logging.getLogger(__name__)


@lru_cache(maxsize=1)
def _libraries():
    security = C.CDLL(find_library('Security'))
    cf = C.CDLL(find_library('CoreFoundation'))
    cf.CFStringCreateWithCString.argtypes = [C.c_void_p, C.c_char_p, C.c_uint32]
    cf.CFStringCreateWithCString.restype = C.c_void_p
    cf.CFDictionaryCreate.argtypes = [C.c_void_p, C.POINTER(C.c_void_p), C.POINTER(C.c_void_p),
                                    C.c_long, C.c_void_p, C.c_void_p]
    cf.CFDictionaryCreate.restype = C.c_void_p
    cf.CFRelease.argtypes = [C.c_void_p]
    cf.CFRelease.restype = None
    cf.CFDataGetLength.argtypes = [C.c_void_p]
    cf.CFDataGetLength.restype = C.c_long
    cf.CFDataGetBytePtr.argtypes = [C.c_void_p]
    cf.CFDataGetBytePtr.restype = C.c_void_p
    cf.CFDataCreate.argtypes = [C.c_void_p, C.c_void_p, C.c_long]
    cf.CFDataCreate.restype = C.c_void_p
    security.SecItemCopyMatching.argtypes = [C.c_void_p, C.POINTER(C.c_void_p)]
    security.SecItemCopyMatching.restype = C.c_int32
    security.SecKeychainGetUserInteractionAllowed.argtypes = [C.POINTER(C.c_uint8)]
    security.SecKeychainGetUserInteractionAllowed.restype = C.c_int32
    security.SecKeychainSetUserInteractionAllowed.argtypes = [C.c_uint8]
    security.SecKeychainSetUserInteractionAllowed.restype = C.c_int32
    security.SecItemAdd.argtypes = [C.c_void_p, C.c_void_p]
    security.SecItemAdd.restype = C.c_int32
    security.SecItemDelete.argtypes = [C.c_void_p]
    security.SecItemDelete.restype = C.c_int32
    return security, cf


@contextmanager
def interaction_policy(allowed: bool):
    """Guard legacy file-based keychains as well as modern SecItem queries.

    SecItem's authentication UI flag is ignored by the file-based shim on some
    macOS versions (FB16959400). The legacy setting is process-wide, so serialize
    access and restore the previous setting even when a query fails.
    """
    with _interaction_lock:
        security, _ = _libraries()
        previous = C.c_uint8()
        status = security.SecKeychainGetUserInteractionAllowed(C.byref(previous))
        if status:
            yield status
            return
        status = security.SecKeychainSetUserInteractionAllowed(bool(allowed))
        if status:
            yield status
            return
        try:
            yield 0
        finally:
            status = security.SecKeychainSetUserInteractionAllowed(previous.value)
            if status:
                log.warning('Could not restore keychain interaction policy (status=%d)', status)


def read(service: str, account: str, *, interactive: bool = False) -> tuple[int, str]:
    with interaction_policy(interactive) as status:
        if status:
            return status, ''  # Never risk an interactive fallback.
        return _read(service, account, interactive=interactive)


def _read(service: str, account: str, *, interactive: bool) -> tuple[int, str]:
    security, cf = _libraries()
    def symbol(name):
        return C.c_void_p.in_dll(security, name).value
    owned = []
    query = None
    result = C.c_void_p()
    try:
        for value in (service, account):
            ptr = cf.CFStringCreateWithCString(None, value.encode('utf-8'), 0x08000100)
            if not ptr:
                raise MemoryError('Could not build a keychain query')
            owned.append(ptr)
        keys = (C.c_void_p * 6)(*[symbol(name) for name in (
            'kSecClass', 'kSecAttrService', 'kSecAttrAccount', 'kSecMatchLimit',
            'kSecReturnData', 'kSecUseAuthenticationUI')])
        values = (C.c_void_p * 6)(symbol('kSecClassGenericPassword'), owned[0], owned[1],
                                  symbol('kSecMatchLimitOne'), C.c_void_p.in_dll(cf, 'kCFBooleanTrue').value,
                                  symbol('kSecUseAuthenticationUIAllow' if interactive else 'kSecUseAuthenticationUIFail'))
        query = cf.CFDictionaryCreate(None, keys, values, 6,
            C.addressof(C.c_char.in_dll(cf, 'kCFTypeDictionaryKeyCallBacks')),
            C.addressof(C.c_char.in_dll(cf, 'kCFTypeDictionaryValueCallBacks')))
        if not query:
            raise MemoryError('Could not build a keychain query')
        status = security.SecItemCopyMatching(query, C.byref(result))
        if status or not result.value:
            return status, ''
        return 0, C.string_at(cf.CFDataGetBytePtr(result), cf.CFDataGetLength(result)).decode('utf-8')
    finally:
        if result.value:
            cf.CFRelease(result)
        if query:
            cf.CFRelease(query)
        for ptr in owned:
            cf.CFRelease(ptr)


@contextmanager
def _item_query(service, account, secret=None):
    security, cf = _libraries()
    owned = []
    query = None
    try:
        for value in (service, account):
            owned.append(cf.CFStringCreateWithCString(None,value.encode('utf-8'),0x08000100))
        names=['kSecClass','kSecAttrService','kSecAttrAccount']
        values=[C.c_void_p.in_dll(security,'kSecClassGenericPassword').value,*owned]
        if secret is not None:
            data=secret.encode('utf-8')
            owned.append(cf.CFDataCreate(None,C.c_char_p(data),len(data)))
            names.append('kSecValueData');values.append(owned[-1])
        if not all(owned):
            raise MemoryError('Could not build a keychain item')
        count=len(names)
        query=cf.CFDictionaryCreate(None,
            (C.c_void_p*count)(*[C.c_void_p.in_dll(security,name).value for name in names]),
            (C.c_void_p*count)(*values),count,
            C.addressof(C.c_char.in_dll(cf,'kCFTypeDictionaryKeyCallBacks')),
            C.addressof(C.c_char.in_dll(cf,'kCFTypeDictionaryValueCallBacks')))
        if not query:
            raise MemoryError('Could not build a keychain item')
        yield query
    finally:
        if query:
            cf.CFRelease(query)
        for ptr in owned:
            if ptr:
                cf.CFRelease(ptr)


def add_new(service: str, account: str, secret: str, *, interactive: bool = False) -> int:
    """Create a master key without ever replacing an existing one."""
    with interaction_policy(interactive) as status:
        if status:
            return status
        security,_=_libraries()
        with _item_query(service,account,secret) as query:
            return security.SecItemAdd(query,None)


def delete(service: str, account: str, *, interactive: bool = False) -> int:
    with interaction_policy(interactive) as status:
        if status:
            return status
        security,_=_libraries()
        with _item_query(service,account) as query:
            return security.SecItemDelete(query)
