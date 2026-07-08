// engine-jail — minimal OS-level syscall sandbox for untrusted, statically
// linked chess-engine binaries.
//
// A submitted compiled engine is a pure stdin/stdout move generator: it reads a
// FEN line on fd 0, writes a UCI move on fd 1, and exits. It has no legitimate
// need to open files, touch the network, or spawn processes. Native code can
// evade source-level static analysis (inline asm, obfuscated syscall numbers)
// and the network-namespace backstop only blocks the network, so we add a
// seccomp-bpf allowlist as the real OS-level boundary for native engines.
//
// Why seccomp and not unshare/bwrap: installing a seccomp filter on yourself
// only needs PR_SET_NO_NEW_PRIVS — no root and no user namespaces. The arbiter
// containers run without unprivileged user-namespace support (CLONE_NEWUSER
// fails), so namespace-based jails are unavailable there; seccomp is not.
//
// Usage:  engine-jail /path/to/engine [args...]
// The filter is installed, then the engine is exec'd. seccomp filters persist
// across execve, so the engine runs under the allowlist. Build:
//   cc -O2 -o engine-jail engine-jail.c -lseccomp
#include <seccomp.h>
#include <sys/prctl.h>
#include <unistd.h>
#include <stdio.h>
#include <errno.h>
#include <stddef.h>

int main(int argc, char **argv) {
  if (argc < 2) {
    fprintf(stderr, "engine-jail: usage: engine-jail <program> [args...]\n");
    return 127;
  }

  // Default action: kill the whole process on any syscall not explicitly
  // handled below. Fail closed — an engine that reaches for something we did
  // not anticipate dies rather than being allowed through.
  scmp_filter_ctx ctx = seccomp_init(SCMP_ACT_KILL_PROCESS);
  if (!ctx) {
    fprintf(stderr, "engine-jail: seccomp_init failed\n");
    return 126;
  }

  // Compute, memory, stdio-on-existing-fds, signals, time and RNG — everything
  // a self-contained single-threaded compute binary needs. execve is allowed so
  // this launcher can hand off to the engine (defanged below); the engine
  // inherits the same filter.
  const int allowed[] = {
    SCMP_SYS(read),   SCMP_SYS(write),  SCMP_SYS(readv),  SCMP_SYS(writev),
    SCMP_SYS(close),  SCMP_SYS(lseek),  SCMP_SYS(fstat),  SCMP_SYS(newfstatat),
    SCMP_SYS(fcntl),  SCMP_SYS(ioctl),  SCMP_SYS(poll),   SCMP_SYS(ppoll),
    SCMP_SYS(mmap),   SCMP_SYS(munmap), SCMP_SYS(mremap), SCMP_SYS(mprotect),
    SCMP_SYS(brk),    SCMP_SYS(madvise),
    SCMP_SYS(rt_sigaction), SCMP_SYS(rt_sigprocmask), SCMP_SYS(rt_sigreturn),
    SCMP_SYS(sigaltstack),  SCMP_SYS(futex),          SCMP_SYS(sched_yield),
    SCMP_SYS(nanosleep),    SCMP_SYS(clock_nanosleep),
    SCMP_SYS(clock_gettime),SCMP_SYS(clock_getres),   SCMP_SYS(gettimeofday),
    SCMP_SYS(time),         SCMP_SYS(getrandom),      SCMP_SYS(sysinfo),
    SCMP_SYS(arch_prctl),   SCMP_SYS(set_tid_address),SCMP_SYS(set_robust_list),
    SCMP_SYS(rseq),         SCMP_SYS(prlimit64),      SCMP_SYS(getpid),
    SCMP_SYS(gettid),       SCMP_SYS(uname),          SCMP_SYS(getcwd),
    SCMP_SYS(readlink),     SCMP_SYS(readlinkat),
    SCMP_SYS(exit),         SCMP_SYS(exit_group),     SCMP_SYS(restart_syscall),
    SCMP_SYS(execve),
  };
  for (size_t i = 0; i < sizeof(allowed) / sizeof(allowed[0]); i++) {
    if (seccomp_rule_add(ctx, SCMP_ACT_ALLOW, allowed[i], 0) < 0) {
      fprintf(stderr, "engine-jail: seccomp_rule_add(allow) failed\n");
      return 126;
    }
  }

  // Filesystem-opening and network syscalls fail with EPERM rather than killing
  // the process, so a static libc that probes them during startup degrades
  // gracefully while still being denied all file and network access. Combined
  // with a static binary (no dynamic-loader opens) and no writable filesystem,
  // the allowed execve above has nothing openable/loadable to abuse.
  const int denied[] = {
    SCMP_SYS(open),   SCMP_SYS(openat), SCMP_SYS(openat2), SCMP_SYS(creat),
    SCMP_SYS(stat),   SCMP_SYS(statx),  SCMP_SYS(access),  SCMP_SYS(faccessat),
    SCMP_SYS(faccessat2),
    SCMP_SYS(socket), SCMP_SYS(socketpair), SCMP_SYS(connect), SCMP_SYS(bind),
    SCMP_SYS(listen), SCMP_SYS(accept),     SCMP_SYS(sendto),  SCMP_SYS(recvfrom),
    SCMP_SYS(sendmsg),SCMP_SYS(recvmsg),
    SCMP_SYS(chdir),  SCMP_SYS(chmod),      SCMP_SYS(unlink),  SCMP_SYS(unlinkat),
    SCMP_SYS(mkdir),  SCMP_SYS(rename),
  };
  for (size_t i = 0; i < sizeof(denied) / sizeof(denied[0]); i++) {
    if (seccomp_rule_add(ctx, SCMP_ACT_ERRNO(EPERM), denied[i], 0) < 0) {
      fprintf(stderr, "engine-jail: seccomp_rule_add(deny) failed\n");
      return 126;
    }
  }
  // Note: fork/vfork/clone/clone3, ptrace, process_vm_*, execveat, and prctl
  // (other than the NO_NEW_PRIVS we set before loading) are intentionally NOT
  // listed, so the default KILL_PROCESS action blocks process creation,
  // tracing, and privilege changes.

  // Required so an unprivileged process may install a seccomp filter, and so no
  // subsequent (allowed) execve of a setuid binary could regain privileges.
  if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) < 0) {
    perror("engine-jail: prctl(NO_NEW_PRIVS)");
    return 126;
  }
  if (seccomp_load(ctx) < 0) {
    fprintf(stderr, "engine-jail: seccomp_load failed\n");
    return 126;
  }
  seccomp_release(ctx);

  execv(argv[1], &argv[1]);
  // Only reached if execve fails (e.g. binary missing/not executable).
  perror("engine-jail: execv");
  return 127;
}
