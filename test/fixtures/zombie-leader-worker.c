#define _DEFAULT_SOURCE

#include <fcntl.h>
#include <pthread.h>
#include <signal.h>
#include <stdlib.h>
#include <unistd.h>

static void *write_heartbeat(void *argument) {
  const char *path = argument;
  const int descriptor = open(path, O_CREAT | O_WRONLY | O_APPEND, 0600);
  if (descriptor < 0) _exit(2);

  for (;;) {
    if (write(descriptor, "x", 1) != 1) _exit(3);
    usleep(10 * 1000);
  }
}

int main(int argc, char **argv) {
  if (argc != 2) return 64;
  if (signal(SIGTERM, SIG_IGN) == SIG_ERR) return 65;

  pthread_t worker;
  if (pthread_create(&worker, NULL, write_heartbeat, argv[1]) != 0) return 66;

  pthread_exit(NULL);
}
