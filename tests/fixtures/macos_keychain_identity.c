/* Isolated integration probe: only the explicit temporary keychain is used. */
#include <Security/Security.h>
#include <CoreFoundation/CoreFoundation.h>
#include <stdio.h>
#include <string.h>
#ifndef BUILD_VARIANT
#define BUILD_VARIANT "one"
#endif
int main(int argc, char **argv) {
    if (argc != 3) return 2;
    fprintf(stdout, "build=%s ", BUILD_VARIANT);
    SecKeychainSetUserInteractionAllowed(false);
    SecKeychainRef keychain = NULL;
    OSStatus status = SecKeychainOpen(argv[2], &keychain);
    if(status) { printf("status=%d\n", (int)status); return 3; }
    const void *searchValues[] = {keychain};
    CFArrayRef search = CFArrayCreate(NULL, searchValues, 1, &kCFTypeArrayCallBacks);
    CFMutableDictionaryRef query = CFDictionaryCreateMutable(NULL, 0,
        &kCFTypeDictionaryKeyCallBacks, &kCFTypeDictionaryValueCallBacks);
    CFDictionarySetValue(query, kSecClass, kSecClassGenericPassword);
    CFDictionarySetValue(query, kSecAttrService, CFSTR("MailAI.IsolatedUpgradeTest"));
    CFDictionarySetValue(query, kSecAttrAccount, CFSTR("synthetic-master"));
    CFDictionarySetValue(query, kSecUseAuthenticationUI, kSecUseAuthenticationUIFail);
    CFTypeRef result = NULL;
    if (!strcmp(argv[1],"create")) {
        CFDictionarySetValue(query, kSecUseKeychain, keychain);
        CFDataRef secret = CFDataCreate(NULL, (const UInt8 *)"synthetic-only", 14);
        CFDictionarySetValue(query, kSecValueData, secret);
        status = SecItemAdd(query, NULL);
        CFRelease(secret);
    } else {
        CFDictionarySetValue(query, kSecMatchSearchList, search);
        CFDictionarySetValue(query, kSecReturnData, kCFBooleanTrue);
        status = SecItemCopyMatching(query, &result);
        if (status == 0 && (!result || CFGetTypeID(result) != CFDataGetTypeID() ||
            CFDataGetLength(result) != 14 || memcmp(CFDataGetBytePtr(result), "synthetic-only", 14))) status = -1;
    }
    printf("status=%d\n", (int)status); /* Never print credential bytes. */
    if(result) CFRelease(result);
    CFRelease(query); CFRelease(search); CFRelease(keychain);
    return status == 0 ? 0 : 1;
}
