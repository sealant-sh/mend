/**
 * The browser wrapper (ADR 0020, "One browser profile per screen"), staged beside the helper and
 * first on the PATH of a session with a display. It runs the image's own Chromium on the session's
 * screen with the screen's own profile, so a second `chromium <url>` opens a tab in the same
 * browser, and the profile goes with the screen's directory at its next start. Without the
 * screen's cookie in `XAUTHORITY`, or for a headless run or a profile of the caller's own, it is
 * Chromium unchanged.
 */
export const CHROMIUM_WRAPPER_SCRIPT = `#!/bin/sh
real=
old_ifs=$IFS
IFS=:
for dir in $PATH; do
  for name in chromium chromium-browser; do
    if [ -x "$dir/$name" ] && ! [ "$dir/$name" -ef "$0" ]; then real=$dir/$name; break 2; fi
  done
done
IFS=$old_ifs
[ -n "$real" ] || { echo "chromium: no Chromium on this image's PATH" >&2; exit 127; }
case \${XAUTHORITY-} in
  */mend-screen-*/auth) screen=\${XAUTHORITY%/auth} ;;
  *) exec "$real" "$@" ;;
esac
for arg in "$@"; do
  case $arg in --headless* | --user-data-dir*) exec "$real" "$@" ;; esac
done
exec "$real" --user-data-dir="$screen/chromium" --no-first-run --no-default-browser-check "$@"
`;
