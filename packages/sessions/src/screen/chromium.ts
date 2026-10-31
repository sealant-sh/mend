/**
 * The browser wrapper (ADR 0020, "One browser profile per screen"): the image's own Chromium with
 * the screen's own profile, so a second `chromium <url>` opens a tab in the same browser. It keeps
 * Chromium's sandbox where the workspace lets it start and runs with `--no-sandbox` otherwise, and
 * `browser-sandbox` in the screen's directory records which for the screen's status (D12). Without
 * the screen's cookie in `XAUTHORITY`, for a headless run or a caller's own profile, it is Chromium
 * unchanged.
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
[ -d "$screen" ] || exec "$real" "$@"
mark=$screen/browser-sandbox
if ! [ -s "$mark" ]; then
  probe=$(mktemp -d "$screen/probe.XXXXXX")
  starts() { timeout 30 "$real" --headless "$@" --user-data-dir="$probe" --dump-dom about:blank >/dev/null 2>&1; }
  said=on
  if ! starts && starts --no-sandbox; then said=off; fi
  rm -rf "$probe"
  echo "$said" >"$mark.$$" && mv "$mark.$$" "$mark"
fi
[ "$(cat "$mark")" = off ] && set -- --no-sandbox "$@"
for arg in "$@"; do
  case $arg in --headless* | --user-data-dir*) exec "$real" "$@" ;; esac
done
exec "$real" --user-data-dir="$screen/chromium" --no-first-run --no-default-browser-check --start-maximized "$@"
`;
