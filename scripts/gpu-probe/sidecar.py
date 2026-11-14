#!/usr/bin/env python3
"""Probe sidecar: runs beside one strict plain leg, over the live guest's SSH.

usage: sidecar.py VARIANT SSH_PORT OUT QEMU_PIDFILE
Applies the variant's session environment before greetd starts the compositor,
then samples the guest's DRM state and QEMU's threads until the leg ends.
Diagnostics only; never part of a qualification.
"""
import os
import subprocess
import sys
import time

variant, port, out, pidfile = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
ENVS = {
    'legacy': 'SMITHAY_USE_LEGACY=1',
    'egldbg': 'EGL_LOG_LEVEL=debug LIBGL_DEBUG=verbose MESA_DEBUG=1',
    'swgl': 'LIBGL_ALWAYS_SOFTWARE=1 GALLIUM_DRIVER=llvmpipe MESA_LOADER_DRIVER_OVERRIDE=kms_swrast',
    'legacyegl': 'SMITHAY_USE_LEGACY=1 EGL_LOG_LEVEL=debug LIBGL_DEBUG=verbose MESA_DEBUG=1',
}
log = open(os.path.join(out, 'sidecar.log'), 'a', buffering=1)


def say(msg):
    log.write(f'[{time.strftime("%H:%M:%S")}] {msg}\n')


def ssh(cmd, timeout=40):
    try:
        r = subprocess.run(
            ['sshpass', '-p', 'live', 'ssh', '-o', 'StrictHostKeyChecking=no', '-o', 'UserKnownHostsFile=/dev/null',
             '-o', 'ConnectTimeout=5', '-p', port, 'liveuser@127.0.0.1', cmd],
            capture_output=True, text=True, timeout=timeout)
        return r.returncode, r.stdout + r.stderr
    except subprocess.TimeoutExpired:
        return 124, 'ssh timeout'


def sample_host():
    try:
        pid = open(pidfile).read().strip()
        rows = subprocess.run(['ps', '-L', '-o', 'tid,stat,pcpu,wchan:24,comm', '-p', pid],
                              capture_output=True, text=True).stdout
        fds = len(os.listdir(f'/proc/{pid}/fd'))
        say(f'host qemu pid={pid} fds={fds}\n{rows}')
    except Exception as exc:
        say(f'host sample failed: {exc}')


start = time.monotonic()
stop = os.path.join(out, 'strict-plain-install-duration.txt')
up = False
while time.monotonic() - start < 700:
    if ssh('true', 10)[0] == 0:
        up = True
        break
    time.sleep(1)
say(f'ssh up={up} after {time.monotonic() - start:.0f}s variant={variant}')
if not up:
    sys.exit(0)

envs = ENVS.get(variant, '')
if envs:
    rc, o = ssh("sudo sed -i 's#dbus-run-session#env %s dbus-run-session#g' /etc/greetd/config.toml; "
                "grep -n command /etc/greetd/config.toml; pgrep -a xfwl4 || echo no-xfwl4-yet" % envs)
    say(f'apply env {envs!r}: rc={rc}\n{o}')
    if 'no-xfwl4-yet' not in o:
        say('RACE LOST: xfwl4 already running, restarting greetd')
        say(ssh('sudo systemctl restart greetd; sleep 3; pgrep -a xfwl4')[1])

if variant == 'trace':
    say(ssh('sudo sh -c "echo 0x14 > /sys/module/drm/parameters/debug; cat /sys/module/drm/parameters/debug"')[1])

rc, o = ssh(
    'uname -r; rpm -qa 2>/dev/null | grep -iE "mesa|virgl|libEGL|libgbm|xfwl4|greetd|^systemd-[0-9]|libdrm" | sort; '
    'ls -l /dev/dri; ls /usr/lib64/dri 2>&1 | head -20; '
    'sudo sh -c "for f in /sys/kernel/debug/dri/*/name; do echo $f; cat $f; done" 2>&1; '
    'sudo -n true && echo SUDO_OK')
say(f'guest identity rc={rc}\n{o}')

n = 0
while time.monotonic() - start < 2600 and not os.path.exists(stop):
    n += 1
    time.sleep(40)
    sample_host()
    rc, o = ssh(
        'echo "-- env"; sudo tr "\\0" "\\n" < /proc/$(pgrep -x xfwl4 | head -1)/environ 2>/dev/null | grep -E "SMITHAY|EGL|LIBGL|MESA|GALLIUM" ; '
        'echo "-- tasks"; ps -eLo pid,tid,stat,wchan:32,comm | grep -E " D | xfwl4|tuna-install" | head -30; '
        'echo "-- state"; sudo sh -c "for f in /sys/kernel/debug/dri/*/state; do echo == $f; head -70 $f; done" 2>&1; '
        'echo "-- dmesg"; sudo dmesg | grep -iE "vblank|flip_done|fence|drm" | tail -12 | cut -c1-200; '
        'echo "-- compositor"; sudo journalctl -t tunaos-live-session --no-pager -n 6 -o cat | cut -c1-220', 60)
    say(f'guest sample {n} rc={rc}\n{o}')
    if n % 3 == 0 and variant in ('egldbg', 'legacyegl'):
        say('-- egl journal\n' + ssh('sudo journalctl -t tunaos-live-session --no-pager -o cat | grep -iE "egl|mesa|gbm|dri|libGL|swrast|virgl" | head -40 | cut -c1-240', 40)[1])
say('sidecar done')
