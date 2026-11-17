#!/usr/bin/env bash
# Put one screenshot into Linear (report.md, "Screenshots"). Linear's prepare_file_upload answers
# with a signed URL that expires 60 seconds later, so this does the whole PUT in one command: pass
# the tool's answer, exactly as it came, on stdin, in your very next command.
#
#   .agents/skills/box-main-run/upload-screenshot.sh <png> <<'JSON'
#   <prepare_file_upload's answer>
#   JSON
#
# It sends every header the answer names, verbatim, and prints the answer's `markdown` (the image to
# put in the comment) on success. Exit 1 when the upload is refused, with the HTTP status.
set -euo pipefail

file=${1:?usage: upload-screenshot.sh <png> < prepare_file_upload answer}
[[ -f $file ]] || { echo "upload-screenshot.sh: no file $file" >&2; exit 2; }
answer=$(cat)
url=$(jq -r '.uploadRequest.url' <<<"$answer")
[[ $url == https://* ]] || { echo "upload-screenshot.sh: stdin is not prepare_file_upload's answer" >&2; exit 2; }
headers=()
while IFS= read -r header; do headers+=(-H "$header"); done < <(jq -r '.uploadRequest.headers | to_entries[] | "\(.key): \(.value)"' <<<"$answer")
status=$(curl -sS -o /dev/null -w '%{http_code}' -X PUT --data-binary "@$file" "${headers[@]}" "$url")
if [[ $status != 2* ]]; then
  echo "upload-screenshot.sh: the upload answered $status (a URL older than 60 s answers 400 or 403)" >&2
  exit 1
fi
jq -r '.markdown' <<<"$answer"
