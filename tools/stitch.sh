#!/usr/bin/env bash
# Stitch rendered 15s segments into one deliverable film.
#
#   tools/stitch.sh out.mp4 <url-or-file> <url-or-file> ...            hard cuts
#   tools/stitch.sh -x 0.35 out.mp4 <url-or-file> <url-or-file> ...    crossfades
#
# Hard cut is the default: segments are prompted as one continuous take, and a
# straight cut reads as a camera cut, which is what real creator videos do.
# -x adds a short crossfade (video + audio) to mask the seam when continuity
# between segments came out imperfect. 0.3 to 0.5 seconds looks natural.
set -euo pipefail

XFADE=0
if [ "${1:-}" = "-x" ]; then XFADE="$2"; shift 2; fi

OUT="$1"; shift
[ $# -ge 2 ] || { echo "need at least 2 segments" >&2; exit 1; }

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

FILES=()
i=0
for SRC in "$@"; do
  i=$((i+1))
  F="$WORK/seg$i.mp4"
  case "$SRC" in
    http*) curl -sSf -o "$F" "$SRC" ;;
    *)     cp "$SRC" "$F" ;;
  esac
  FILES+=("$F")
done

if [ "$XFADE" = "0" ]; then
  LIST="$WORK/list.txt"
  for F in "${FILES[@]}"; do printf "file '%s'\n" "$F" >> "$LIST"; done
  if ! ffmpeg -hide_banner -loglevel error -f concat -safe 0 -i "$LIST" -c copy -y "$OUT"; then
    echo "stream copy failed, re-encoding" >&2
    ffmpeg -hide_banner -loglevel error -f concat -safe 0 -i "$LIST" \
      -c:v libx264 -preset fast -crf 18 -c:a aac -b:a 192k -movflags +faststart -y "$OUT"
  fi
else
  # segment duration: ffprobe when present, else parsed from ffmpeg -i
  seconds() {
    if command -v ffprobe >/dev/null 2>&1; then
      ffprobe -v error -show_entries format=duration -of csv=p=0 "$1"
    else
      { ffmpeg -i "$1" 2>&1 || true; } | python3 -c '
import re, sys
m = re.search(r"Duration: (\d+):(\d+):(\d+\.\d+)", sys.stdin.read())
h, mnt, s = m.groups()
print(int(h) * 3600 + int(mnt) * 60 + float(s))'
    fi
  }
  # chained xfade/acrossfade graph; offsets accumulate real segment durations
  INPUTS=(); DUR=()
  for F in "${FILES[@]}"; do
    INPUTS+=(-i "$F")
    DUR+=("$(seconds "$F")")
  done
  N=${#FILES[@]}
  # normalize every input first: xfade refuses mismatched timebases/formats
  FC=""
  for ((k=0; k<N; k++)); do
    FC+="[$k:v]settb=AVTB,fps=30,format=yuv420p[nv$k];"
    FC+="[$k:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo[na$k];"
  done
  VPREV="[nv0]"; APREV="[na0]"; OFFSET=0
  for ((k=1; k<N; k++)); do
    OFFSET=$(python3 -c "print(round($OFFSET + ${DUR[$((k-1))]} - $XFADE, 3))")
    VOUT="[v$k]"; AOUT="[a$k]"
    FC+="${VPREV}[nv$k]xfade=transition=fade:duration=$XFADE:offset=$OFFSET$VOUT;"
    FC+="${APREV}[na$k]acrossfade=d=$XFADE$AOUT;"
    VPREV="$VOUT"; APREV="$AOUT"
  done
  ffmpeg -hide_banner -loglevel error "${INPUTS[@]}" \
    -filter_complex "${FC%;}" -map "$VPREV" -map "$APREV" \
    -c:v libx264 -preset fast -crf 18 -c:a aac -b:a 192k -movflags +faststart -y "$OUT"
fi
echo "stitched ${#FILES[@]} segments -> $OUT"
