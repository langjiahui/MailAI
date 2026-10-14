/* A versioned, immutable Keychain reader. It serves only the signed MailAI
 * parent (or the sealed one-time migration client), never arbitrary callers.
 * Request/response credentials travel through inherited pipes, never argv. */
#include <Security/Security.h>
#include <CoreFoundation/CoreFoundation.h>
#include <unistd.h>
#include <stdio.h>
#include <string.h>
#include <stdlib.h>

#define CERT "a04567b09e3230ba773b70e6b1343244b387186b"
static int parent_allowed(void) {
    if (getuid()!=geteuid() || getppid()<=1) return 0;
    pid_t pid=getppid(); CFNumberRef number=CFNumberCreate(NULL,kCFNumberIntType,&pid);
    const void *keys[]={kSecGuestAttributePid};const void *values[]={number};
    CFDictionaryRef attributes=CFDictionaryCreate(NULL,keys,values,1,&kCFTypeDictionaryKeyCallBacks,&kCFTypeDictionaryValueCallBacks);
    SecCodeRef parent=NULL; SecRequirementRef requirement=NULL;
    OSStatus status=SecCodeCopyGuestWithAttributes(NULL,attributes,kSecCSDefaultFlags,&parent);
    if(!status) status=SecRequirementCreateWithString(CFSTR("(identifier \"com.langjiahui.mailai\" or identifier \"com.langjiahui.mailai.credential-migration.v1\") and certificate leaf = H\"" CERT "\""),kSecCSDefaultFlags,&requirement);
    if(!status) status=SecCodeCheckValidity(parent,kSecCSStrictValidate,requirement);
    if(requirement)CFRelease(requirement);if(parent)CFRelease(parent);CFRelease(attributes);CFRelease(number);
    return status==0;
}

int main(void) {
    /* Fail before parsing any operation or touching Keychain. */
    if(!parent_allowed()){printf("-25293\n\n");return 9;}
    char action[16],policy[8],secret[64];
    if(!fgets(action,sizeof(action),stdin)||!fgets(policy,sizeof(policy),stdin)||!fgets(secret,sizeof(secret),stdin))return 2;
    action[strcspn(action,"\r\n")]=0;policy[strcspn(policy,"\r\n")]=0;secret[strcspn(secret,"\r\n")]=0;
    int interactive=!strcmp(policy,"1");
    if((strcmp(policy,"0")&&strcmp(policy,"1"))||(strcmp(action,"read")&&strcmp(action,"add")))return 2;
    if(!strcmp(action,"add")) {
        if(strlen(secret)!=44 || secret[43]!='=')return 2;
        for(int i=0;i<43;i++)if(!strchr("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_",secret[i]))return 2;
    }
    OSStatus status=SecKeychainSetUserInteractionAllowed(interactive);
    CFMutableDictionaryRef query=CFDictionaryCreateMutable(NULL,0,&kCFTypeDictionaryKeyCallBacks,&kCFTypeDictionaryValueCallBacks);
    CFDictionarySetValue(query,kSecClass,kSecClassGenericPassword);
    CFDictionarySetValue(query,kSecAttrService,CFSTR("MailAI"));
    CFDictionarySetValue(query,kSecAttrAccount,CFSTR("credential-agent-key:v1"));
    CFDictionarySetValue(query,kSecUseAuthenticationUI,interactive?kSecUseAuthenticationUIAllow:kSecUseAuthenticationUIFail);
    /* Explicit isolated test keychain. Production never sets this variable. */
    SecKeychainRef fixture=NULL;CFArrayRef search=NULL;
    const char *fixturePath=getenv("_MAILAI_TEST_AGENT_KEYCHAIN");
    if(!status && fixturePath && *fixturePath) {
        /* Signed test callers can never access the production service, even
         * if someone supplies a path alias for the login keychain. */
        CFDictionarySetValue(query,kSecAttrService,CFSTR("MailAI.IsolatedAgentUpgradeTest"));
        CFDictionarySetValue(query,kSecAttrAccount,CFSTR("synthetic-agent-master"));
        status=SecKeychainOpen(fixturePath,&fixture);
        if(!status) {
            if(!strcmp(action,"add"))CFDictionarySetValue(query,kSecUseKeychain,fixture);
            else { const void *v[]={fixture};search=CFArrayCreate(NULL,v,1,&kCFTypeArrayCallBacks);CFDictionarySetValue(query,kSecMatchSearchList,search); }
        }
    }
    CFTypeRef result=NULL;CFDataRef data=NULL;
    if(!status && !strcmp(action,"add")) {
        CFDictionarySetValue(query,kSecAttrLabel,CFSTR("MailAI 本机凭据"));
        data=CFDataCreate(NULL,(const UInt8*)secret,44);CFDictionarySetValue(query,kSecValueData,data);
        status=SecItemAdd(query,NULL);
    } else if(!status) {
        CFDictionarySetValue(query,kSecMatchLimit,kSecMatchLimitOne);CFDictionarySetValue(query,kSecReturnData,kCFBooleanTrue);
        status=SecItemCopyMatching(query,&result);
        if(!status && (!result||CFGetTypeID(result)!=CFDataGetTypeID()||CFDataGetLength(result)!=44))status=-1;
    }
    printf("%d\n",(int)status);
    if(!status && result)fwrite(CFDataGetBytePtr(result),1,44,stdout);
    printf("\n");
    memset(secret,0,sizeof(secret));if(result)CFRelease(result);if(data)CFRelease(data);if(search)CFRelease(search);if(fixture)CFRelease(fixture);CFRelease(query);
    return 0;
}
