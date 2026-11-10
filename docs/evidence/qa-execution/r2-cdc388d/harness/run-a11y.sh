#!/usr/bin/env bash
cd /paperclip/instances/default/projects/36187ce6-342f-40d7-801c-5215c9d394f7/6b326782-6478-4db3-938d-47b97d5fbc83/enterprise-app/.paperclip/worktrees/HEAAA-640-acceptance-correction-rerun-qa-execution-on-the-corrected-integrated-revision || exit 9
export QA_LIBS_ROOT=/tmp/qa-ci-tools/root; . tests/e2e/harness/browsers-env.sh
export LD_LIBRARY_PATH=$LD_LIBRARY_PATH:/tmp/libs/usr/lib/x86_64-linux-gnu:/tmp/libs/usr/lib
E=/tmp/qa640/ev
rm -rf $E/a11y-cf $E/a11y-wk; rm -f $E/a11y.done
export QA_REPORT_DIR=$E/a11y-cf QA_BROWSERS=chromium,firefox
NODE_PATH=$PWD/apps/staff/node_modules pnpm --filter @ehr/staff exec playwright test -c ../../tests/e2e/a11y/playwright.config.ts --workers=1 --reporter=dot,json,junit > $E/a11y-cf.run.txt 2>&1; echo cf=$? > $E/a11y.cf.rc
export LD_LIBRARY_PATH=$LD_LIBRARY_PATH:/tmp/qa640/wk/usr/lib/x86_64-linux-gnu:/tmp/qa640/wk/usr/lib __EGL_VENDOR_LIBRARY_DIRS=/tmp/qa640/glvnd LIBGL_DRIVERS_PATH=/tmp/qa640/wk/usr/lib/x86_64-linux-gnu/dri
export QA_REPORT_DIR=$E/a11y-wk QA_BROWSERS=webkit
NODE_PATH=$PWD/apps/staff/node_modules pnpm --filter @ehr/staff exec playwright test -c ../../tests/e2e/a11y/playwright.config.ts --workers=1 --reporter=dot,json,junit > $E/a11y-wk.run.txt 2>&1; echo wk=$? > $E/a11y.wk.rc
touch $E/a11y.done
