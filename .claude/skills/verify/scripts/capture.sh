#!/bin/sh
# The verify skill's CLI evidence: run one command, keep what it was, what it printed and how it
# ended.
#
#   .claude/skills/verify/scripts/capture.sh <dir> <name> -- <command...>
#
# Writes <dir>/<name>.cmd (the argv, shell-quoted), .stdout, .stderr and .exit, prints the exit
# code, and exits with it. Commands run through `mend run` print the command's terminal on stdout
# (CRLF, its stderr folded in) and Mend's own lines on stderr; both are kept as they came, except
# that every value in the run's secret registry ($MEND_VERIFY_PRIVATE, secrets.mjs) and every
# credential shape redact.mjs knows is replaced, in all three files. The raw output only ever exists
# in a private temporary directory, removed before this exits.
#
# Redaction keeps evidence clean; it does not unprint a terminal. A command run through `mend run`
# is recorded by the outer server as it ran: never send one that prints a credential (`mend pair`,
# a minted token, a provider login) that way.
set -u
if [ $# -lt 4 ] || [ "$3" != "--" ]; then
  echo "usage: capture.sh <dir> <name> -- <command...>" >&2
  exit 2
fi
dir=$1
name=$2
shift 3
here=$(cd "$(dirname "$0")" && pwd)
mkdir -p "$dir"
raw=$(mktemp -d)
chmod 700 "$raw"
trap 'rm -rf "$raw"' EXIT
# The command as argv, each word shell-quoted, so the record says exactly what ran.
# Streamed, not substituted: a word's trailing newlines are kept.
for word in "$@"; do
  printf "'"
  printf '%s' "$word" | sed "s/'/'\\\\''/g"
  printf "' "
done > "$raw/cmd"
echo >> "$raw/cmd"
"$@" > "$raw/stdout" 2> "$raw/stderr"
code=$?
for part in cmd stdout stderr; do
  node "$here/redact.mjs" ${MEND_VERIFY_PRIVATE:+--secrets "$MEND_VERIFY_PRIVATE"} < "$raw/$part" > "$dir/$name.$part" || {
    echo "capture.sh: redacting $part failed; nothing of it kept" >&2
    : > "$dir/$name.$part"
  }
done
printf '%s\n' "$code" > "$dir/$name.exit"
echo "$name · exit $code"
exit "$code"
