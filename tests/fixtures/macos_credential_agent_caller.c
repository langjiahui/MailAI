/* Signed caller integration fixture. Refuses all production-keychain use and
 * outputs only OS status and secret length, never a credential value. */
#include <stdio.h>
#include <stdlib.h>
#include <unistd.h>
#include <string.h>
#include <sys/wait.h>
#ifndef BUILD_VARIANT
#define BUILD_VARIANT "1"
#endif
int main(int argc,char **argv) {
    const char *fixture=getenv("_MAILAI_TEST_AGENT_KEYCHAIN");
    if(argc!=3 || !fixture || !strstr(fixture,"mailai-agent-integration-") || (strcmp(argv[2],"read")&&strcmp(argv[2],"add")))return 2;
    int input[2],output[2];if(pipe(input)||pipe(output))return 3;
    pid_t child=fork();if(child<0)return 4;
    if(!child){dup2(input[0],0);dup2(output[1],1);close(input[0]);close(input[1]);close(output[0]);close(output[1]);execl(argv[1],argv[1],NULL);_exit(5);}
    close(input[0]);close(output[1]);FILE *write=fdopen(input[1],"w"),*read=fdopen(output[0],"r");
    fprintf(write,"%s\n0\n%s\n",argv[2],!strcmp(argv[2],"add")?"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=":"");fclose(write);
    char status[32]={0},value[128]={0};fgets(status,sizeof(status),read);fgets(value,sizeof(value),read);fclose(read);
    int code=0;waitpid(child,&code,0);int parsed=atoi(status);size_t length=strcspn(value,"\r\n");
    printf("build=%s status=%d length=%zu\n",BUILD_VARIANT,parsed,length);memset(value,0,sizeof(value));
    return parsed==0 && WIFEXITED(code) && WEXITSTATUS(code)==0?0:1;
}
