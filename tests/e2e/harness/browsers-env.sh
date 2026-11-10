# Source this file (". browsers-env.sh") to run Playwright chromium, firefox and webkit as uid 1000 without root.
# Needs: browsers in /tmp/pw-browsers (PLAYWRIGHT_BROWSERS_PATH=/tmp/pw-browsers pnpm exec playwright install chromium firefox webkit)
# and Debian libs unpacked to $QA_LIBS_ROOT (see docs/evidence/integration/M3/BROWSER-RUNNER-AND-0704.md; WebKit also needs
# libgles2, libx264-164, libegl-mesa0, libgallium and their dependencies). Verified 2026-11-10: chromium 156.0.8078.4,
# firefox 157.0, webkit 27.2 (Playwright 1.64.1), each launched and rendered a page.
QA_LIBS_ROOT=${QA_LIBS_ROOT:-/tmp/qa06-libs/root}
export PLAYWRIGHT_BROWSERS_PATH=${PLAYWRIGHT_BROWSERS_PATH:-/tmp/pw-browsers}
export LD_LIBRARY_PATH=$QA_LIBS_ROOT/usr/lib/x86_64-linux-gnu
# Playwright's host check does not see LD_LIBRARY_PATH and falsely reports libGLESv2/libx264 missing.
export PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS=1
# Firefox: user namespaces are denied (EPERM), so its sandbox is off (test host only).
export MOZ_DISABLE_CONTENT_SANDBOX=1 MOZ_DISABLE_GMP_SANDBOX=1 MOZ_DISABLE_RDD_SANDBOX=1 MOZ_DISABLE_SOCKET_PROCESS_SANDBOX=1
# WebKit: software EGL (no GPU/display) and no bubblewrap sandbox.
export LIBGL_DRIVERS_PATH=$QA_LIBS_ROOT/usr/lib/x86_64-linux-gnu/dri LIBGL_ALWAYS_SOFTWARE=1 EGL_PLATFORM=surfaceless
export __EGL_VENDOR_LIBRARY_DIRS=$QA_LIBS_ROOT/usr/share/glvnd/egl_vendor.d
export WEBKIT_DISABLE_COMPOSITING_MODE=1 WEBKIT_DISABLE_DMABUF_RENDERER=1 WEBKIT_DISABLE_SANDBOX_THIS_IS_DANGEROUS=1
[ -n "$FONTCONFIG_FILE" ] || { [ -f /tmp/chromelibs/fonts.conf ] && export FONTCONFIG_FILE=/tmp/chromelibs/fonts.conf; }
